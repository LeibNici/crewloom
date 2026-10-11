import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../../../api/client';
import { CrewloomError, toUserMessage } from '../../../api/errors';
import { useSessionStore } from '../../../auth/store';
import { DefinitionRow, EmptyState, PageCard, PageHeader, StatusPill } from '../../../components/Card';
import {
  asRecord,
  formatDateTime,
  humanizeType,
  readBoolean,
  readId,
  readNumber,
  readString,
} from '../../workflow/format';
import { jobStatusLabel, manualModeLabel } from '../../workflow/labels';
import { useMutation } from '../../workflow/useMutation';
import { collectFormBlocks, payloadFor, sameUserId, type FormValues, type ManualFormBlock } from '../manualForm';
import {
  associationTargetOf,
  fetchAssociationOptions,
  fetchManualTask,
  manualAssigneeIdOf,
  manualAssigneeUserOf,
  manualFormsOf,
  manualSchemaOf,
} from '../domain';
import { ManualFormRenderer } from '../components/ManualFormRenderer';
import styles from '../tasks.module.css';

/**
 * TD-02 人工处理详情。
 *
 * 契约（十页闭环 §B1，已在 13000 上实测可读）：
 *  - 详情一次请求带回 `node` / `job` / `workflow` / `execution` 关联；
 *  - 渲染布局内联在 `node.config.schema`（Formily 结构），处理配置在 `node.config.forms[formKey]`；
 *  - 提交 `workflowManualTasks:submit?filterByTk=<任务 id>`，体为
 *    `{ result: { [formKey]: 表单值, _: actionKey } }`；
 *  - 处理资格：任务与作业为待处理且执行进行中，否则后端 400；并发锁冲突 409（界面按通用文案提示）。
 *
 * 渲染由 `ManualFormRenderer` 交给真实 Formily（见 components/manualSchemaHost.tsx）。
 */
export function ManualTaskPage() {
  const [params] = useSearchParams();
  const id = params.get('id') ?? '';
  const currentUser = useSessionStore((state) => state.user);
  const [task, setTask] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * 提交遇到 409（并发锁冲突）时置位。
   *
   * 关键行为：409 **不**自动重新读取详情 —— 那会用服务端初始值重建表单，把用户刚填的内容清空。
   * 页面保留用户输入，只给出一条说明 + 显式"刷新查看最新状态"按钮；用户点刷新后才重新读取，
   * 若这时任务已被处理，就走下面的只读回显分支。
   */
  const [conflict, setConflict] = useState(false);
  const mutation = useMutation();
  // 异步切换任务时，旧任务的响应不得覆盖新任务的界面（会话世代之外的同页并发保护）。
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    if (!id) {
      setLoading(false);
      setLoadError('没有指定要处理的任务。');
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const detail = await fetchManualTask(id);
      if (requestRef.current !== requestId) return;
      setTask(detail);
      if (!detail) setLoadError('这条待办不存在，可能已被处理或撤回。');
    } catch (error) {
      if (requestRef.current !== requestId) return;
      setTask(null);
      setLoadError(toUserMessage(error));
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 切换任务（同页只换 `?id=`）时不继承上一条待办的提示。
   *
   * 三条提示各有来源：`conflict`（409 卡片）、`notice`（提交成功）、`mutation.message`（通用错误文案）。
   * 它们都是"上一条待办"的结果，换任务后必须清掉，否则旧 409 的错误文案会挂在新任务页面底部。
   */
  useEffect(() => {
    setConflict(false);
    setNotice(null);
    mutation.reset();
    // `mutation.reset` 是稳定引用（useMutation 内部 useCallback([])），这里按 id 变化触发即可。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const schema = useMemo(() => manualSchemaOf(task), [task]);
  const forms = useMemo(() => manualFormsOf(task), [task]);
  const blocks = useMemo(() => collectFormBlocks(schema, forms), [schema, forms]);

  const node = asRecord(task?.node);
  const job = asRecord(task?.job);
  const execution = asRecord(task?.execution);
  const workflow = asRecord(task?.workflow);
  const result = asRecord(task?.result);

  const taskStatus = readNumber(task, 'status');
  const jobStatus = readNumber(job, 'status');
  const executionStatus = readNumber(execution, 'status');
  const processed = taskStatus !== 0 && taskStatus !== null;
  const jobFinished = jobStatus !== null && jobStatus !== 0;
  const executionStopped = executionStatus !== null && executionStatus !== 0;
  const processedState = processed || jobFinished || executionStopped;

  /**
   * 受理人来自真实数据：`workflowManualTasks.userId` / `appends=user`（见 domain.ts）。
   * 只有 `userId` 与当前用户一致时才允许填写/提交；身份未确认（未登录态）时不贸然断言"他人处理"。
   */
  const assigneeId = manualAssigneeIdOf(task);
  const assigneeUser = manualAssigneeUserOf(task);
  const assigneeName =
    readString(assigneeUser, 'nickname') ?? readString(assigneeUser, 'username') ?? readString(assigneeUser, 'name');
  const isAssignee =
    currentUser == null || assigneeId == null ? null : sameUserId(assigneeId, currentUser.id);
  const handledByOther = isAssignee === false;
  /** 表单只读：任务已处理，或这条待办由其他人处理（与原生 pattern 判定同一数据来源）。 */
  const readOnly = processedState || handledByOther;

  const assigneeText = assigneeName
    ? `${assigneeName}${assigneeId != null ? `（#${assigneeId}）` : ''}${isAssignee === true ? '·本人' : ''}`
    : assigneeId != null
      ? `#${assigneeId}（名称暂不可用）`
      : '未指定受理人';

  /** 统一提交入口：原生 `useSubmit` 与内置宿主都走这里（请求、409、提示、刷新一致）。 */
  const submitPayload = async (payload: Record<string, unknown>) => {
    setNotice(null);
    setConflict(false);
    // 不能用 mutation 的 state 判断冲突：它要等这次 run 结束才更新，闭包里读到的是旧值。
    let conflicted = false;
    const result = await mutation.run(async () => {
      try {
        return await api.resourceAction('workflowManualTasks', 'submit', {
          params: { filterByTk: id },
          values: payload,
        });
      } catch (error) {
        if (error instanceof CrewloomError && error.status === 409) conflicted = true;
        throw error;
      }
    });
    if (result !== null) {
      setNotice('已提交处理结果，接下来会按流程设置继续处理。');
      await load();
    } else if (conflicted) {
      // 保留用户已经填好的内容，只提示 + 提供显式刷新入口（不在这里 load，避免重建表单清空输入）。
      setNotice(null);
      setConflict(true);
    }
  };

  const submit = async (block: ManualFormBlock, actionKey: string, values: FormValues) => {
    await submitPayload(payloadFor(block, actionKey, values));
  };

  if (loading) {
    return (
      <PageCard title="人工处理">
        <p className={styles.mutedText}>正在读取待办详情…</p>
      </PageCard>
    );
  }

  if (loadError || !task) {
    return (
      <div className={styles.stack}>
        <PageHeader title="人工处理" description="填写处理表单并提交结果。" />
        <EmptyState tone="warn" title="待办详情暂时读不到" description={loadError ?? '没有找到这条待办。'} />
        <Link className={styles.secondaryButton} to="/tasks/pending">
          返回待办列表
        </Link>
      </div>
    );
  }

  const jobLabel = jobStatusLabel(jobStatus);
  const headerDescription = processedState
    ? '这条待办已经处理完成；下面的表单内容为只读回显。'
    : handledByOther
      ? '这条待办由其他人处理，你可以查看内容，但不能代为填写或提交。'
      : '按流程节点定义的布局填写内容，然后选择处理结果提交。提交后会保存处理结果，并按流程设置继续处理。';
  const statusLabel = processedState ? '已处理' : handledByOther ? '由其他人处理' : '待处理';

  return (
    <div className={styles.stack}>
      <PageHeader
        title={readString(node, 'title') ?? '人工处理'}
        description={headerDescription}
        meta={
          <div className={styles.tagRow}>
            <StatusPill tone={readOnly ? 'neutral' : 'warn'}>{statusLabel}</StatusPill>
            {node ? <StatusPill tone="neutral">{humanizeType(readString(node, 'type'))}</StatusPill> : null}
            <span className={styles.metaText}>节点状态：{jobLabel.label}</span>
          </div>
        }
        actions={
          <Link className={styles.secondaryButton} to="/tasks/pending">
            返回待办列表
          </Link>
        }
      />

      <PageCard title="关联信息">
        <DefinitionRow term="所属流程">{readString(workflow, 'title') ?? '流程已不存在'}</DefinitionRow>
        <DefinitionRow term="流程版本">
          {readId(workflow) ? `#${readId(workflow)}` : '—'}
          {readBoolean(workflow, 'current') === true ? '（当前生效版本）' : ''}
        </DefinitionRow>
        <DefinitionRow term="处理方式">
          {node ? manualModeLabel(asRecord(node.config)?.mode) : '—'}
        </DefinitionRow>
        <DefinitionRow term="受理人">{assigneeText}</DefinitionRow>
        <DefinitionRow term="执行">
          {readId(execution) ? `#${readId(execution)}` : '—'}
        </DefinitionRow>
        <DefinitionRow term="创建时间">{formatDateTime(readString(task, 'createdAt')) ?? '—'}</DefinitionRow>
        {execution && readId(execution) ? (
          <Link className={styles.linkButton} to={`/workflow/execution?id=${readId(execution)}`}>
            查看执行详情
          </Link>
        ) : null}
      </PageCard>

      {processedState ? (
        <PageCard tone="muted" title="这条待办已经处理过">
          <p className={styles.bodyText}>
            处理完成后表单只读，流程已经按当时的处理结果继续。下面展示当时提交的内容，仅供参考。
          </p>
        </PageCard>
      ) : handledByOther ? (
        <PageCard tone="muted" title="这条待办由其他人处理">
          <p className={styles.bodyText}>
            你可以查看这条待办的内容，但不能代为填写或提交。如果内容与你有关，请联系受理人或流程管理员。
          </p>
        </PageCard>
      ) : null}

      <ManualFormRenderer
        schema={schema}
        blocks={blocks}
        forms={forms}
        storedResult={result}
        record={task}
        job={job}
        execution={execution}
        currentUserId={currentUser?.id ?? null}
        readOnly={processedState}
        disabled={handledByOther}
        submitting={mutation.isSubmitting}
        onSubmitPayload={submitPayload}
        onSubmit={(block, actionKey, values) => void submit(block, actionKey, values)}
        loadAssociationOptions={async (_block, field) => {
          // 关联候选值与字段元数据同走产品 SDK / 身份角色世代管线（后端 ACL 仍是权威）。
          const target = associationTargetOf(field.raw);
          if (!target) return [];
          return fetchAssociationOptions(target);
        }}
      />

      {conflict ? (
        <PageCard tone="muted" title="提交没有成功：这条待办的状态可能已经变化">
          <p className={styles.warnText}>
            这条待办可能正在被其他人处理，或已经处理完成。你刚才填写的内容还保留在表单里，没有被清空。
          </p>
          <p className={styles.bodyText}>
            如果确实是别人处理的，点下面的按钮重新读取最新状态；一旦确认这条待办已被处理，这里会直接显示最终结果（只读）。
          </p>
          <div className={styles.formActions}>
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={mutation.isSubmitting}
              onClick={() => {
                // 用户显式要求重读：先把上一次 409 的错误文案当作陈旧信息清掉。
                // 否则刷新已经确认"已处理"后，页面底部还会残留旧 409
                //「该内容已被处理或正在被其他人处理，请刷新后查看最新状态」（Main 反馈）。
                setConflict(false);
                mutation.reset();
                void load();
              }}
            >
              刷新查看最新状态
            </button>
          </div>
        </PageCard>
      ) : null}

      {notice ? <p className={styles.successText}>{notice}</p> : null}
      {!conflict && mutation.message ? <p className={styles.errorText}>{mutation.message}</p> : null}
    </div>
  );
}
