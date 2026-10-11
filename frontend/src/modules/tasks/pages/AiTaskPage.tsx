import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../../../api/client';
import { toUserMessage } from '../../../api/errors';
import { DefinitionRow, EmptyState, PageCard, PageHeader, StatusPill } from '../../../components/Card';
import { asRecord, formatDateTime, readBoolean, readId, readString, stringifyJson } from '../../workflow/format';
import { aiTaskStatusLabel, invokeStatusLabel, jobStatusLabel } from '../../workflow/labels';
import { useMutation } from '../../workflow/useMutation';
import {
  aiToolCallsOf,
  aiToolCallsOfMessages,
  fetchAiSessionMessages,
  fetchAiTaskBySession,
  frontendToolResultsOf,
  isAiToolCallDecided,
  mergeAiToolCalls,
  type AiToolCallView,
} from '../domain';
import {
  ensureSharedNativeRuntime,
  EXECUTE_FRONTEND_TOOL_NAME,
  LOAD_FRONTEND_TOOL_NAME,
  resolveNativeToolRegistry,
  runSelectedFrontendTools,
} from '../toolBridge';
import { describeContextTool } from '../../ai/context/tools';
import { useSessionStore } from '../../../auth/store';
import { sameUserId } from '../manualForm';
import styles from '../tasks.module.css';

/**
 * TD-03 AI 任务详情。
 *
 * 契约（十页闭环 §B2 + 2.2.22 服务端源码）：
 *  - 详情 `GET aiWorkflowTasks:getBySession?sessionId=` 返回 `readonly`（**不含**工具消息）；
 *  - 工具调用数据来自会话历史 `GET aiConversations:getMessages`（`updateRead=false`，本页绝不标已读），
 *    这正是原生 ChatBox 使用的同一条数据来源（`toolCalls[].invokeStatus/execution/willInterrupt`）；
 *  - **领取** `accept`：`pending_acceptance` → `pending_approval`（认领，不是批准）；
 *  - **终止** `reject`：需 `pending_approval` 且 `acceptedUserId=当前用户`，会恢复流程并标记拒绝；
 *  - **批准 / 要求修改 / 否决工具调用**走**两步会话协议**：
 *      ① `POST aiConversations:updateUserDecision { sessionId, messageId, toolCallId, userDecision }`
 *         （`approve` / `edit` 带 `editedAction` / `reject` 可带 `message`）；
 *      ② 等全部工具进入 `waiting` 后 `POST aiConversations:resumeToolCall` 恢复执行。
 *    第 ② 步会让 AI 员工重新调用模型，属真实外呼，**只由用户在当前页面主动点击触发**；
 *    其 `toolCallResults` 只承载**前端工具已有结果**（服务端读取形状 `{id, result}`，见 domain.ts）。
 */
export function AiTaskPage() {
  const [params] = useSearchParams();
  const sessionId = params.get('sessionId') ?? '';
  const [task, setTask] = useState<Record<string, unknown> | null>(null);
  const [messageCalls, setMessageCalls] = useState<AiToolCallView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [decisionDraft, setDecisionDraft] = useState<Record<string, { type: 'approve' | 'edit' | 'reject'; note: string }>>({});
  /**
   * 本页**已记录的工具决定**（toolCallId → userDecision）。
   *
   * 必须由页面自己保存：真实契约里 `aiConversations:getMessages`（`parseMessageRow`）**不回填**
   * `userDecision`，只回填 `invokeStatus/execution/willInterrupt/...`；决定只出现在
   * `updateUserDecision` 的返回 `{ updated, toolCalls }` 里（同一返回还带全部已决定的工具）。
   * 若这里不保留，重新拉历史后"哪条被拒绝"就丢了，继续执行会把**被拒绝的前端工具也执行一遍**。
   */
  const [recordedDecisions, setRecordedDecisions] = useState<Record<string, unknown>>({});
  const [confirmReject, setConfirmReject] = useState(false);
  const [confirmResume, setConfirmResume] = useState(false);
  const [bridgeState, setBridgeState] = useState<'unknown' | 'preparing' | 'ready' | 'unavailable'>('unknown');
  const mutation = useMutation();

  // 冷启动：用户可能**没有先打开过会话界面**就直接进 AI 任务页。这里按需装配共享原生运行上下文
  // （真实 Application + 真实 FrontendToolRegistry），使本页执行前端工具时用的是同一个实例。
  // 装配失败只影响"能否执行前端工具"，不影响详情读取与决定记录。
  useEffect(() => {
    let cancelled = false;
    if (resolveNativeToolRegistry()) {
      setBridgeState('ready');
      return undefined;
    }
    setBridgeState('preparing');
    void ensureSharedNativeRuntime().then((ready) => {
      if (!cancelled) setBridgeState(ready ? 'ready' : 'unavailable');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async () => {
    if (!sessionId) {
      setLoading(false);
      setLoadError('没有指定要查看的 AI 任务。');
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const detail = await fetchAiTaskBySession(sessionId);
      setTask(detail);
      if (!detail) {
        setLoadError('这个 AI 任务不存在，或不属于当前账号。');
        setMessageCalls([]);
        return;
      }
      // 工具调用来自会话历史（AI03 同一条数据来源）。读取失败不伪造工具列表，只保留详情里的形状。
      try {
        const rows = await fetchAiSessionMessages(sessionId);
        setMessageCalls(aiToolCallsOfMessages(rows));
      } catch (error) {
        console.error('[crewloom] 会话工具消息读取失败', error);
        setMessageCalls([]);
      }
    } catch (error) {
      setTask(null);
      setMessageCalls([]);
      setLoadError(toUserMessage(error));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    // 换会话（或从列表点进另一条任务）时清掉上一会话的决定，避免把别的会话的决定混进来。
    setRecordedDecisions({});
  }, [sessionId]);

  const toolCalls = useMemo(
    () =>
      mergeAiToolCalls(aiToolCallsOf(task), messageCalls).map((call) => {
        // 历史不回填 userDecision；本页记录过的决定按 toolCallId 合并回来。
        if (call.userDecision !== undefined && call.userDecision !== null) return call;
        const recorded = recordedDecisions[call.toolCallId];
        return recorded === undefined ? call : { ...call, userDecision: recorded };
      }),
    [task, messageCalls, recordedDecisions],
  );
  const readonly = readBoolean(task, 'readonly') === true;
  const status = readString(task, 'status');
  const acceptedUserId = readId(task, 'acceptedUserId');
  const jobStatus = asRecord(task)?.jobStatus;
  /**
   * 当前登录用户。
   *
   * 真实 2.2.20 契约（`aiWorkflowTasks.js` 的 `reject`）：终止要求 `status = pending_approval`
   * 且 `acceptedUserId = 当前用户`，否则返回 403 `AI_TASK_NOT_REJECTABLE`；
   * `getBySession` 也把同一条件表达为 `readonly`。这里两者都读：服务端的 `readonly` 是权威判定，
   * 当前用户已知时再按受理人核对一次，绝不把别人的任务显示成可终止。
   */
  const currentUserId = useSessionStore((state) => state.user?.id ?? null);

  const accept = async () => {
    setNotice(null);
    const result = await mutation.run(() =>
      api.resourceAction('aiWorkflowTasks', 'accept', { values: { sessionId } }),
    );
    if (result !== null) {
      // 服务端 accept 返回 `{ accepted, readUpdated, acceptedUserId }`：`accepted=false` 表示
      // 认领条件（acceptedUserId=null 且 pending_acceptance）不再成立，不能谎报"已领取"。
      const accepted = asRecord(result.data)?.accepted;
      if (accepted === false) {
        setNotice('这条任务已被其他人领取，或已不在待领取状态；界面已刷新为最新状态。');
      } else {
        setNotice('已领取该任务。领取只是认领，接下来你还需要审核具体工具调用。');
      }
      await load();
    }
  };

  const reject = async () => {
    setConfirmReject(false);
    setNotice(null);
    // 2.2.20 / 2.2.22 发布实现（`resource/aiWorkflowTasks.js` 的 `reject`）要求
    // `values: { id: <任务 id>, result: <终止结果> }`：缺 `id` 会 400 "id is required"，
    // 并把 `result` 原样写进 `job.result` 后恢复流程；原生客户端传的是本地化说明文本。
    const taskId = task ? readId(task, 'id') : null;
    if (!taskId) {
      setNotice('这条任务缺少可用的任务标识，暂时无法终止，请刷新后再试。');
      return;
    }
    const result = await mutation.run(() =>
      api.resourceAction('aiWorkflowTasks', 'reject', {
        values: { id: taskId, result: '用户终止了该 AI 任务' },
      }),
    );
    if (result !== null) {
      setNotice('已终止该任务，流程会按拒绝处理。');
      await load();
    }
  };

  const recordDecision = async (call: AiToolCallView, type: 'approve' | 'edit' | 'reject') => {
    setNotice(null);
    const draft = decisionDraft[call.toolCallId];
    const userDecision: Record<string, unknown> =
      type === 'approve'
        ? { type: 'approve' }
        : type === 'edit'
          ? { type: 'edit', editedAction: { name: call.name, args: parsedArgsOf(call) } }
          : { type: 'reject', message: draft?.note ?? '用户拒绝该工具调用' };
    const result = await mutation.run(() =>
      api.resourceAction('aiConversations', 'updateUserDecision', {
        values: {
          sessionId,
          messageId: call.messageId,
          toolCallId: call.toolCallId,
          userDecision,
        },
      }),
    );
    if (result !== null) {
      // 用服务端返回的 `{updated, toolCalls}` 判断"是否所有工具都已决定"（与原生 useChatMessageActions
      // 同一思路），而不是只看本地状态，避免界面与真实等待状态不一致。
      const data = asRecord(result.data);
      const updated = typeof data?.updated === 'number' ? data.updated : null;
      const returned = Array.isArray(data?.toolCalls) ? data?.toolCalls : [];
      // 服务端的 `updateUserDecision` 返回**本次会话全部工具**的最新状态（含 `userDecision`）；
      // 这是唯一能拿到"哪条被拒绝"的地方（`getMessages` 不回填 userDecision）。
      const decidedFromServer: Record<string, unknown> = {};
      for (const entry of returned) {
        const record = asRecord(entry);
        const callId = readId(record, 'id') ?? readString(record, 'toolCallId');
        if (callId && record?.userDecision !== undefined && record.userDecision !== null) {
          decidedFromServer[callId] = record.userDecision;
        }
      }
      if (Object.keys(decidedFromServer).length > 0) {
        setRecordedDecisions((current) => ({ ...current, ...decidedFromServer }));
      }
      const allDecided =
        returned.length > 0 &&
        returned.every((entry) => {
          const record = asRecord(entry);
          const decision = record?.userDecision;
          if (decision !== undefined && decision !== null) return true;
          // 与 getMessages 侧同一判定：服务端把已决定的工具置为 waiting。
          return readString(record, 'invokeStatus') === 'waiting';
        });
      if (updated === 0) {
        setNotice('这条工具确认已经处理过了，界面会刷新为最新状态。');
      } else if (allDecided) {
        setNotice('已记录你的决定。所有工具调用都已决定，可以点击"继续执行"让 AI 员工接着处理。');
      } else {
        setNotice('已记录你的决定。等所有工具调用都完成决定后，再点击"继续执行"让 AI 员工接着处理。');
      }
      await load();
    }
  };

  const resumeToolCall = async () => {
    setConfirmResume(false);
    setNotice(null);
    const messageId = toolCalls.map((call) => call.messageId).find((value) => value) ?? null;
    // 只恢复"已进入 waiting / 已有决定"的工具调用；没有这类记录时退回全部已知调用（不改变原生语义）。
    const resumable = toolCalls.filter((call) => isAiToolCallDecided(call));
    const targets = resumable.length > 0 ? resumable : toolCalls;
    // 先用**真实原生注册表**执行选定的前端工具（与原生 useToolCallActions 同一语义），
    // 再把结果按服务端 `{ id, result }` 形状回传；拿不到宿主时不伪造执行结果。
    let registry = resolveNativeToolRegistry();
    const frontendTargets = targets.filter(
      (call) => call.execution === 'frontend' && asRecord(call.userDecision)?.type !== 'reject',
    );
    // "需要现执行"的前端工具：既没有已存在的结果，也没被拒绝。已有结果的调用直接回传已有结果即可。
    const needsExecution = frontendTargets.filter((call) => call.content === undefined || call.content === null);
    // 安全闸：需要在页面执行、但**本页没有它的决定记录**（历史不回填 userDecision）。
    // 此时无法区分"批准"与"拒绝"，宁可停下也不能把可能是 rejected 的调用执行掉（原生 useToolCallActions
    // 用的是 updateUserDecision 返回里的决定，不会走到这种状态）。
    const undecided = needsExecution.filter(
      (call) => call.userDecision === undefined || call.userDecision === null,
    );
    if (undecided.length > 0) {
      setNotice(
        '这次会话里有前端工具已经在等待处理，但当前页面读不到它们的决定内容（历史不回填决定）。为避免误执行被拒绝的调用，已停止“继续执行”。请刷新这条任务后重新逐条确认这些工具调用。',
      );
      return;
    }
    if (needsExecution.length > 0) {
      // 需要在本页执行前端工具：确保共享原生运行上下文已装配，并按**当前**上下文选择
      // 刷新一次真实注册表（冷启动用户可能没先打开过会话页；也可能先开过、之后才准备上下文）。
      const ready = await ensureSharedNativeRuntime();
      if (ready) registry = resolveNativeToolRegistry();
    }
    if (!registry && needsExecution.length > 0) {
      // 没有真实注册表时**不**用空结果触发 resumeToolCall——那会让服务端以为前端工具已执行并真的外呼模型。
      // 明确停在"请稍后重试"，不做无桥 fallback 自动恢复。
      setNotice(
        '这次会话包含需要在当前页面执行的前端工具，但工作区工具环境暂时不可用。已在没有执行结果的情况下停止“继续执行”，请稍后重试。',
      );
      return;
    }
    const outcome = await runSelectedFrontendTools(
      targets.map((call) => ({
        toolCallId: call.toolCallId,
        name: call.name,
        args: call.args,
        execution: call.execution,
        userDecision: call.userDecision,
      })),
      registry,
    );
    // 已有的 content 作为兜底（例如会话里已经执行过的工具），执行结果优先；
    // 被拒绝的调用**不参与**结果集（原生同样只把已执行工具的结果回传）。
    const executedIds = new Set(outcome.toolCallResults.map((entry) => entry.id));
    const toolCallResults = [
      ...outcome.toolCallResults,
      ...frontendToolResultsOf(frontendTargets).filter((entry) => !executedIds.has(entry.id)),
    ];
    const result = await mutation.run(() =>
      api.resourceAction('aiConversations', 'resumeToolCall', {
        values: {
          sessionId,
          messageId,
          toolCallIds: outcome.toolCallIds.length > 0 ? outcome.toolCallIds : targets.map((call) => call.toolCallId),
          toolCallResults,
          webSearch: false,
        },
      }),
    );
    if (result !== null) {
      if (!registry && outcome.unresolved.length > 0) {
        setNotice(
          '已请求继续执行；本次回传的是这些工具已有的执行结果。',
        );
      } else if (outcome.failed > 0) {
        setNotice('已请求继续执行；其中有前端工具执行失败，失败原因已按服务端要求一并回传。');
      } else if (outcome.executed > 0) {
        setNotice('已在当前页面执行选定的前端工具，并把结果随"继续执行"一并回传。');
      } else {
        setNotice('已请求继续执行；AI 员工会按你的决定继续处理这条会话。');
      }
      await load();
    }
  };

  if (loading) {
    return (
      <PageCard title="AI 任务">
        <p className={styles.mutedText}>正在读取 AI 任务详情…</p>
      </PageCard>
    );
  }

  if (loadError || !task) {
    return (
      <div className={styles.stack} data-testid="ai-task-page" data-bridge-state={bridgeState}>
        <PageHeader title="AI 任务" description="领取、审核或终止 AI 员工任务。" />
        <EmptyState tone="warn" title="AI 任务暂时读不到" description={loadError ?? '没有找到这个 AI 任务。'} />
        <Link className={styles.secondaryButton} to="/tasks/pending">
          返回待办列表
        </Link>
      </div>
    );
  }

  const label = aiTaskStatusLabel(status);
  const jobLabel = jobStatusLabel(jobStatus);
  const canAccept = status === 'pending_acceptance';
  /** 任务已领取、但领取人不是当前用户：只能查看，决定与终止都不允许。 */
  const acceptedByOther =
    acceptedUserId !== null &&
    ((currentUserId !== null && !sameUserId(acceptedUserId, currentUserId)) ||
      // 服务端把"非受理人"表达为 readonly；当前用户 id 还没读到时也以它为准。
      (currentUserId === null && readonly));
  const canReject =
    status === 'pending_approval' &&
    acceptedUserId !== null &&
    readId(task, 'id') !== null &&
    !readonly &&
    !acceptedByOther;
  const pendingDecisions = toolCalls.filter((call) => call.invokeStatus === 'interrupted');
  // 前端工具（服务端 `execution: 'frontend'`）需要浏览器侧执行结果；没有结果就不回传、也不假装成功。
  const frontendToolsWithoutResult = toolCalls.filter(
    (call) => call.execution === 'frontend' && (call.content === undefined || call.content === null),
  );

  return (
    <div className={styles.stack} data-testid="ai-task-page" data-bridge-state={bridgeState}>
      <PageHeader
        title="AI 任务"
        description="AI 员工在执行过程中暂停，等待你确认它准备执行的工具调用。"
        meta={
          <div className={styles.tagRow}>
            <StatusPill tone={label.tone}>{label.label}</StatusPill>
            <StatusPill tone={jobLabel.tone}>节点：{jobLabel.label}</StatusPill>
            {readonly ? <StatusPill tone="neutral">当前只读</StatusPill> : null}
          </div>
        }
        actions={
          <Link className={styles.secondaryButton} to="/tasks/pending">
            返回待办列表
          </Link>
        }
      />

      <PageCard title="任务信息">
        <DefinitionRow term="会话标识">{sessionId}</DefinitionRow>
        <DefinitionRow term="任务状态">{label.label}</DefinitionRow>
        <DefinitionRow term="领取人">{acceptedUserId ?? '尚未领取'}</DefinitionRow>
        <DefinitionRow term="创建时间">{formatDateTime(readString(task, 'createdAt')) ?? '—'}</DefinitionRow>
        <DefinitionRow term="更新时间">{formatDateTime(readString(task, 'updatedAt')) ?? '—'}</DefinitionRow>
        {readString(task, 'title') ? <DefinitionRow term="任务标题">{readString(task, 'title')}</DefinitionRow> : null}
      </PageCard>

      <PageCard
        title="任务处理"
        description="领取只是把任务认领到自己名下；终止会让流程按拒绝结束。"
      >
        <div className={styles.formActions}>
          <button
            type="button"
            className={styles.primaryButton}
            disabled={!canAccept || mutation.isSubmitting}
            onClick={() => void accept()}
          >
            领取任务
          </button>
          <button
            type="button"
            className={styles.dangerButton}
            disabled={!canReject || mutation.isSubmitting}
            onClick={() => setConfirmReject(true)}
          >
            终止任务
          </button>
        </div>
        {!canAccept && status !== 'pending_acceptance' ? (
          <p className={styles.cellHint}>
            {status === 'pending_approval'
              ? acceptedByOther
                ? '这条任务已由其他人领取，你只能查看；需要处理请联系领取人。'
                : '任务已由你领取，接下来请在下面的工具调用中做出决定。'
              : '任务当前状态不允许领取。'}
          </p>
        ) : null}
        {!canReject ? (
          <p className={styles.cellHint}>
            {acceptedByOther
              ? '只有领取人本人才能终止这条任务。'
              : '只有已领取且处于"待审核"的任务才能终止。'}
          </p>
        ) : null}
      </PageCard>

      <PageCard
        title="工具调用决定"
        description="逐条批准、修改或否决。记录决定本身不会让 AI 继续，需要在最后点击「继续执行」。"
      >
        {toolCalls.length === 0 ? (
          <EmptyState
            title="没有待决策的工具调用"
            description="这条任务的详情里没有返回工具调用信息。若你确认 AI 正在等待，请让管理员核对任务状态后再试。"
          />
        ) : (
          <div className={styles.jobList}>
            {toolCalls.map((call) => {
              // getMessages 不回填 userDecision；已决定由 invokeStatus === 'waiting' 判定（见 domain.ts）。
              const decided = isAiToolCallDecided(call);
              const display = toolDisplayOf(call);
              return (
                <div key={call.toolCallId} className={styles.jobItem}>
                  <div className={styles.jobHeader}>
                    <span className={styles.jobTitle}>{display.title}</span>
                    <StatusPill tone={call.invokeStatus === 'interrupted' ? 'warn' : 'neutral'}>
                      {invokeStatusLabel(call.invokeStatus)}
                    </StatusPill>
                    {decided ? <StatusPill tone="ok">已有决定</StatusPill> : null}
                  </div>
                  {display.purpose ? <span className={styles.cellHint}>{display.purpose}</span> : null}
                  {display.identifier ? (
                    <span className={styles.cellHint}>
                      工具标识：<span className={styles.mono}>{display.identifier}</span>
                    </span>
                  ) : null}
                  <details className={styles.jsonDetails} open>
                    <summary>查看工具参数</summary>
                    <pre className={styles.jsonBlock}>{stringifyJson(parsedArgsOf(call)) || '（无参数）'}</pre>
                  </details>
                  {decided ? (
                    <details className={styles.jsonDetails}>
                      <summary>查看已记录的决定</summary>
                      <pre className={styles.jsonBlock}>{stringifyJson(call.userDecision)}</pre>
                    </details>
                  ) : (
                    <div className={styles.formActions}>
                      <button
                        type="button"
                        className={styles.primaryButton}
                        aria-label={`批准 ${display.title}`}
                        disabled={readonly || mutation.isSubmitting || call.invokeStatus !== 'interrupted'}
                        onClick={() => void recordDecision(call, 'approve')}
                      >
                        批准这次调用
                      </button>
                      <button
                        type="button"
                        className={styles.secondaryButton}
                        aria-label={`修改参数后批准 ${display.title}`}
                        disabled={readonly || mutation.isSubmitting || call.invokeStatus !== 'interrupted'}
                        onClick={() => void recordDecision(call, 'edit')}
                      >
                        修改参数后批准
                      </button>
                      <button
                        type="button"
                        className={styles.dangerButton}
                        aria-label={`否决 ${display.title}`}
                        disabled={readonly || mutation.isSubmitting || call.invokeStatus !== 'interrupted'}
                        onClick={() => void recordDecision(call, 'reject')}
                      >
                        否决这次调用
                      </button>
                    </div>
                  )}
                  {!decided && call.invokeStatus === 'interrupted' ? (
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>否决说明（可选）</span>
                      <input
                        className={styles.input}
                        value={decisionDraft[call.toolCallId]?.note ?? ''}
                        disabled={readonly || mutation.isSubmitting}
                        onChange={(event) =>
                          setDecisionDraft((current) => ({
                            ...current,
                            [call.toolCallId]: { type: 'reject', note: event.target.value },
                          }))
                        }
                      />
                    </label>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}

        <div className={styles.formActions}>
          <button
            type="button"
            className={styles.primaryButton}
            disabled={
              readonly ||
              mutation.isSubmitting ||
              toolCalls.length === 0 ||
              pendingDecisions.length > 0
            }
            onClick={() => setConfirmResume(true)}
          >
            继续执行
          </button>
        </div>
        <p className={styles.cellHint}>
          "继续执行"会让 AI 员工重新调用模型并按你的决定继续处理，只有在你确认后才应点击。
          {pendingDecisions.length > 0 ? ` 仍有 ${pendingDecisions.length} 条工具调用没有做出决定。` : ''}
        </p>
        {bridgeState === 'preparing' ? (
          <p className={styles.cellHint}>正在准备工作区工具环境，准备好后"继续执行"才能带上前端工具的真实执行结果。</p>
        ) : null}
        {bridgeState === 'unavailable' ? (
          <p className={styles.warnText}>
            工作区工具环境暂时没有准备好。详情与决定记录不受影响；涉及前端工具时"继续执行"会停下并提示，不会用空结果触发模型调用。
          </p>
        ) : null}
        {frontendToolsWithoutResult.length > 0 ? (
          <p className={styles.warnText}>
            这次会话里有 {frontendToolsWithoutResult.map((call) => toolDisplayOf(call).title).join('、')}
            需要在这里执行；点「继续执行」后会在当前页面执行，并按服务端要求只回传真实执行结果。
          </p>
        ) : null}
      </PageCard>

      {confirmReject ? (
        <PageCard title="确认终止任务" tone="muted">
          <p className={styles.bodyText}>终止后流程会按拒绝结束，AI 员工不会继续处理这条任务。</p>
          <div className={styles.formActions}>
            <button
              type="button"
              aria-label="确认终止任务"
              className={styles.dangerButton}
              disabled={mutation.isSubmitting}
              onClick={() => void reject()}
            >
              确认终止
            </button>
            <button type="button" className={styles.secondaryButton} onClick={() => setConfirmReject(false)}>
              取消
            </button>
          </div>
        </PageCard>
      ) : null}

      {confirmResume ? (
        <PageCard title="确认继续执行" tone="muted">
          <p className={styles.bodyText}>
            继续执行会触发一次真实的模型调用（可能产生费用），并让 AI 员工按你的决定操作。确认现在就继续吗？
          </p>
          <div className={styles.formActions}>
            <button
              type="button"
              className={styles.primaryButton}
              disabled={mutation.isSubmitting}
              onClick={() => void resumeToolCall()}
            >
              确认继续
            </button>
            <button type="button" className={styles.secondaryButton} onClick={() => setConfirmResume(false)}>
              取消
            </button>
          </div>
        </PageCard>
      ) : null}

      {notice ? <p className={styles.successText}>{notice}</p> : null}
      {mutation.message ? <p className={styles.errorText}>{mutation.message}</p> : null}
    </div>
  );
}

/** 工具参数可能是字符串形式的 JSON，展示与编辑前尽量解析成对象。 */
function parsedArgsOf(call: AiToolCallView): unknown {
  if (typeof call.args === 'string') {
    try {
      return JSON.parse(call.args);
    } catch {
      return call.args;
    }
  }
  return call.args ?? {};
}

/**
 * 工具卡的可读标题与实际用途。
 *
 * 契约：模型调用前端工具时，`toolCalls[].name` 是内置的 `executeFrontendTool` / `loadFrontendTool`，
 * **真正的动作**在 `args.toolId` 上（形如 `<uid>:apply_code_change`）。直接把内置工具名当标题
 * 会让普通用户看到内部实现名，因此这里用同一份工具定义（`describeContextTool`，原生确认卡片
 * 也在用）换成人能读懂的题名与用途；`toolId` 仍作为标识原样保留，便于核对。
 * 查不到定义时给出中性说明，并把原始工具名作为标识显示，不编造用途。
 */
function toolDisplayOf(call: AiToolCallView): { title: string; purpose: string | null; identifier: string | null } {
  const args = asRecord(parsedArgsOf(call));
  const toolId = typeof args?.toolId === 'string' && args.toolId ? args.toolId : null;
  if (toolId) {
    const described = describeContextTool(toolId);
    if (described) {
      return {
        title: described.title,
        purpose:
          described.permission === 'ASK'
            ? '这一步会修改你当前的工作内容；批准后才会执行。'
            : '这一步只读取你当前的工作内容，不会修改。',
        identifier: toolId,
      };
    }
    return { title: '界面操作', purpose: null, identifier: toolId };
  }
  if (call.name === EXECUTE_FRONTEND_TOOL_NAME || call.name === LOAD_FRONTEND_TOOL_NAME) {
    return { title: '界面操作', purpose: null, identifier: null };
  }
  return { title: call.name, purpose: null, identifier: null };
}
