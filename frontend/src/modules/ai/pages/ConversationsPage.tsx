import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { api } from '../../../api/client';
import { CrewloomError } from '../../../api/errors';
import { PageCard, PageHeader, StatusPill } from '../../../components/Card';
// 原生宿主单独成块：只有用户切到「原生 ChatBox」时才加载上游运行时（首屏不付这份体积）。
const NativeChatBoxHost = lazy(async () => ({
  default: (await import('../native/nativeChatHost')).NativeChatBoxHost,
}));
import {
  createConversation,
  getContextDatasource,
  getConversation,
  listContextDatasources,
  listConversations,
  listUsableEmployees,
  resolveAllowedModels,
  resourceMessageOf,
  resourceStateOf,
} from '../resources';
import type { AiContextDatasourceRow, AiEmployeeRow } from '../types';
import { Checkbox, Field, ListPager, Notice, Select, StateBlock, formatTime } from '../ui';
import { useConversationSession } from '../chat/useConversation';
import type { ChatMessage } from '../chat/conversation';
import styles from '../group-a.module.css';

/**
 * AI-03 会话工作区。
 *
 * 与后端的真实契约（报告 01 §AI-03、十页契约附录 A）：
 *  - 列表用 `aiConversations:list`，列表项**没有 `id`**，标识一律是 `sessionId`，
 *    且**不能传 `fields`**（实测 400）；
 *  - 历史用 `aiConversations:getMessages?sessionId=`；
 *  - 发送 / 重发 / 续流 / 工具确认都是 `text/event-stream`，由 `chat/sse.ts` 边收边解析；
 *  - 会话内选择模型必须按员工的允许集过滤，否则会被后端静默回退（十页契约 D2）。
 *
 * 真实模型调用：本页只在**真实用户点击发送/重发/续流**时才会发起；自动验证使用严格模式，
 * 这些动作会被传输层拦截，因此验证过程不会产生模型费用。
 */

const PAGE_SIZE = 15;

export function ConversationsPage() {
  const { sessionId } = useParams<{ sessionId?: string }>();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState('');

  const conversations = useQuery({
    queryKey: ['ai', 'conversations', { page, keyword }],
    queryFn: () =>
      listConversations({
        page,
        pageSize: PAGE_SIZE,
        sort: ['-updatedAt'],
        ...(keyword.trim().length > 0 ? { filter: { title: { $includes: keyword.trim() } } } : {}),
      }),
  });

  const rows = conversations.data?.rows ?? [];
  const state = conversations.isLoading ? 'loading' : resourceStateOf(conversations.error, rows.length === 0);
  const current = useMemo(() => rows.find((row) => row.sessionId === sessionId) ?? null, [rows, sessionId]);

  return (
    <div className={styles.stack}>
      <PageHeader
        title="会话工作区"
        description="查看你的历史会话与消息，并继续与数字员工对话。发送、重发与继续接收都会实时从服务端读取。"
      />

      <Suspense
        fallback={
          <PageCard title="正在准备会话">
            <p className={styles.listItemHint}>正在准备聊天界面，请稍候…</p>
          </PageCard>
        }
      >
        <NativeChatBoxHost />
      </Suspense>

      <div className={styles.chatLayout} hidden>
        <PageCard title="我的会话" description="只显示属于当前账号的会话。">
          <div className={styles.toolbar}>
            <input
              className={styles.input}
              placeholder="按标题筛选"
              aria-label="按标题筛选会话"
              value={keyword}
              onChange={(event) => {
                setKeyword(event.target.value);
                setPage(1);
              }}
            />
            <button type="button" className={styles.button} onClick={() => void conversations.refetch()}>
              刷新
            </button>
          </div>

          <StateBlock
            state={state}
            message={resourceMessageOf(conversations.error)}
            onRetry={() => void conversations.refetch()}
            emptyTitle="还没有会话"
            emptyDescription="右侧选择一位员工即可开始新会话。"
            deniedDescription="你的角色没有查看会话的权限。"
          />

          {rows.length > 0 ? (
            <div className={styles.rowList}>
              {rows.map((row) => (
                <Link
                  key={row.sessionId}
                  to={`/ai/conversations/${encodeURIComponent(row.sessionId)}`}
                  className={
                    row.sessionId === sessionId ? `${styles.rowCard} ${styles.rowCardActive}` : styles.rowCard
                  }
                  style={{ textAlign: 'left', cursor: 'pointer', textDecoration: 'none' }}
                >
                  <span className={styles.rowMain}>
                    <span className={`${styles.rowTitle} ${styles.rowTitleOneLine}`} title={row.title || undefined}>
                      {row.title || '未命名会话'}
                    </span>
                    <span className={styles.rowHint}>
                      {row.aiEmployeeUsername || '未知员工'}　更新于 {formatTime(row.updatedAt)}
                    </span>
                    <span className={styles.chipRow}>
                      {row.llmActiveState && row.llmActiveState !== 'idle' ? (
                        <StatusPill tone="warn">服务端仍在生成</StatusPill>
                      ) : null}
                      {row.read === false ? <StatusPill tone="brand">有未读</StatusPill> : null}
                    </span>
                  </span>
                </Link>
              ))}
            </div>
          ) : null}

          <ListPager
            meta={(conversations.data?.meta ?? {}) as { count?: number; hasNext?: boolean }}
            page={page}
            pageSize={PAGE_SIZE}
            isFetching={conversations.isFetching}
            onChange={setPage}
          />

          <NewConversationForm
            onCreated={(created) => {
              void conversations.refetch();
              navigate(`/ai/conversations/${encodeURIComponent(created)}`);
            }}
          />
        </PageCard>

        <div className={styles.chatPanel}>
          {sessionId ? (
            <ConversationPanel sessionId={sessionId} fallbackEmployee={current?.aiEmployeeUsername ?? ''} />
          ) : (
            <PageCard title="选择一个会话">
              <StateBlock
                state="empty"
                emptyTitle="还没有打开任何会话"
                emptyDescription="从左侧选择历史会话，或在下方新建一个会话。"
              />
            </PageCard>
          )}
        </div>
      </div>
    </div>
  );
}

function NewConversationForm({ onCreated }: { onCreated: (sessionId: string) => void }) {
  const employees = useQuery({
    queryKey: ['ai', 'employees', 'listByUser', 'for-new-conversation'],
    queryFn: () => listUsableEmployees({ pageSize: 100, sort: ['-createdAt'] }),
    staleTime: 30_000,
  });
  const [employee, setEmployee] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options = (employees.data?.rows ?? []).map((row) => ({
    value: row.username,
    label: row.nickname ? `${row.nickname}（${row.username}）` : row.username,
  }));

  useEffect(() => {
    if (!employee && options.length > 0) setEmployee(options[0].value);
  }, [employee, options]);

  const create = async () => {
    if (!employee) {
      setError('请先选择一位员工。');
      return;
    }
    setPending(true);
    setError(null);
    try {
      const created = await createConversation({ aiEmployee: employee });
      const sessionId =
        created && typeof (created as Record<string, unknown>).sessionId === 'string'
          ? String((created as Record<string, unknown>).sessionId)
          : '';
      if (!sessionId) {
        setError('后端没有返回会话标识，请稍后在左侧列表中查找。');
        return;
      }
      onCreated(sessionId);
    } catch (caught) {
      setError(caught instanceof CrewloomError ? caught.userMessage : '新建会话失败，请稍后重试。');
    } finally {
      setPending(false);
    }
  };

  return (
    <div style={{ marginTop: 16 }}>
      <Field label="新建会话" hint="只列出当前角色可以使用的员工。">
        <Select
          value={employee}
          onChange={setEmployee}
          options={options}
          placeholder={options.length > 0 ? '请选择员工' : '没有可使用的员工'}
        />
      </Field>
      {employees.error ? <Notice tone="warn">{resourceMessageOf(employees.error)}</Notice> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <button
        type="button"
        className={`${styles.button} ${styles.buttonPrimary}`}
        disabled={pending || !employee}
        onClick={() => void create()}
      >
        {pending ? '正在创建…' : '开始新会话'}
      </button>
    </div>
  );
}

function ConversationPanel({ sessionId, fallbackEmployee }: { sessionId: string; fallbackEmployee: string }) {
  const conversation = useQuery({
    queryKey: ['ai', 'conversations', 'get', sessionId],
    queryFn: () => getConversation(sessionId),
  });

  const employeeUsername =
    conversation.data?.aiEmployeeUsername || fallbackEmployee || '';

  const employees = useQuery({
    queryKey: ['ai', 'employees', 'listByUser', 'for-conversation'],
    queryFn: () => listUsableEmployees({ pageSize: 100 }),
    staleTime: 30_000,
  });
  const employee = useMemo(
    () => (employees.data?.rows ?? []).find((row) => row.username === employeeUsername) ?? null,
    [employees.data, employeeUsername],
  );

  const session = useConversationSession({ sessionId, employeeUsername });

  const [draft, setDraft] = useState('');
  const [model, setModel] = useState('');
  const [webSearch, setWebSearch] = useState(false);
  const [selectedContext, setSelectedContext] = useState<string[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);

  const modelOptions = useModelOptions(employee);

  useEffect(() => {
    setDraft('');
    setSelectedContext([]);
    setActionError(null);
  }, [sessionId]);

  const send = async () => {
    if (draft.trim().length === 0) return;
    setActionError(null);
    const workContext = await buildWorkContext(selectedContext);
    const summary = await session.send({
      employeeUsername,
      text: draft,
      model: pickModel(model, modelOptions),
      webSearch,
      workContext,
    });
    if (summary && summary.outcome === 'rejected' && summary.message) {
      // 错误已经以错误气泡展示；这里不再重复。保留提示便于用户理解可重试。
      setActionError(summary.message);
    } else {
      setDraft('');
    }
  };

  const state = conversation.isLoading ? 'loading' : resourceStateOf(conversation.error, conversation.data === null);
  const active = conversation.data?.llmActiveState;
  const showResume =
    Boolean(sessionId) &&
    (session.resumeFailed || (typeof active === 'string' && active !== 'idle'));

  return (
    <>
      <PageCard
        title={conversation.data?.title || '会话'}
        description={
          employeeUsername
            ? `与 ${employee?.nickname || employeeUsername} 的对话；内容来自服务端，不会在本地伪造。`
            : '正在确认本次会话使用的员工。'
        }
        actions={
          <div className={styles.rowActions}>
            <button type="button" className={styles.button} onClick={() => void session.reload()}>
              刷新消息
            </button>
          </div>
        }
      >
        <StateBlock
          state={state}
          message={resourceMessageOf(conversation.error)}
          onRetry={() => void conversation.refetch()}
          deniedDescription="你没有查看这个会话的权限。"
        />

        {showResume ? (
          <Notice tone="warn">
            这个会话在服务端仍有未完成的生成（可能正在输出或已经中断）。
            {session.resumeFailed
              ? '服务端已没有可回放的增量缓存，接下来重发或继续接收会重新请求模型。'
              : '点击「继续接收」可以把后续内容接回来；如果缓存已失效，服务端会明确告知。'}
            <div className={styles.toolbar} style={{ marginTop: 8, marginBottom: 0 }}>
              <button
                type="button"
                className={styles.button}
                disabled={session.streaming}
                onClick={() => void session.resumeStream(employeeUsername)}
              >
                继续接收
              </button>
            </div>
          </Notice>
        ) : null}

        <MessageList
          messages={session.messages}
          historyState={session.historyState}
          historyMessage={session.historyMessage}
          streaming={session.streaming}
          employeeUsername={employeeUsername}
          onResend={(messageId) =>
            void session.resend({ employeeUsername, messageId, model: pickModel(model, modelOptions) })
          }
          onReload={() => void session.reload()}
          onDecide={(toolCallId, messageId, decision) =>
            void session.decideTool({
              employeeUsername,
              messageId,
              toolCallId,
              decision,
              model: pickModel(model, modelOptions),
            })
          }
        />

        {session.notice ? <Notice tone="info">{session.notice}</Notice> : null}
        {actionError ? <Notice tone="danger">{actionError}</Notice> : null}
        {session.webSearch && session.webSearch.length > 0 ? (
          <Notice>本次回复使用了联网搜索，共 {session.webSearch.length} 条结果来源。</Notice>
        ) : null}
      </PageCard>

      <PageCard title="发送消息">
        <ContextPicker
          selected={selectedContext}
          onChange={setSelectedContext}
          unavailableReason={employee ? undefined : '暂时无法确认这位员工可用的上下文数据源。'}
        />

        <Field label="消息内容">
          <textarea
            className={styles.textarea}
            rows={3}
            value={draft}
            disabled={session.streaming}
            placeholder="输入要发送给数字员工的内容"
            aria-label="消息内容"
            onChange={(event) => setDraft(event.target.value)}
          />
        </Field>

        <div className={styles.fieldRow}>
          <Field label="本次使用的模型" hint={modelOptions.hint}>
            <Select
              value={model}
              onChange={setModel}
              options={modelOptions.options}
              placeholder="由后端自动选择"
              disabled={session.streaming}
            />
          </Field>
          <Field label="联网搜索">
            <Checkbox
              label="允许本次回复使用联网搜索"
              checked={webSearch}
              disabled={session.streaming}
              onChange={setWebSearch}
            />
          </Field>
        </div>

        {modelOptions.warning ? <Notice tone="warn">{modelOptions.warning}</Notice> : null}

        <div className={styles.toolbar} style={{ marginBottom: 0 }}>
          <button
            type="button"
            className={`${styles.button} ${styles.buttonPrimary}`}
            disabled={session.streaming || draft.trim().length === 0 || !employeeUsername}
            onClick={() => void send()}
          >
            {session.streaming ? '正在生成…' : '发送'}
          </button>
          {session.streaming ? (
            <button type="button" className={`${styles.button} ${styles.buttonDanger}`} onClick={() => void session.abort()}>
              停止生成
            </button>
          ) : null}
          <span className={styles.rowHint}>
            发送会真实调用模型服务；已经发出的内容无法撤回。
          </span>
        </div>
      </PageCard>
    </>
  );
}

interface ModelOptions {
  options: Array<{ value: string; label: string }>;
  hint?: string;
  warning?: string;
  /** 员工允许集（enforced 时非空）。 */
  allowed: Array<{ llmService: string; model: string }>;
  enforced: boolean;
}

/** 依据员工允许集与后端服务列表计算可选项；被限制时只列允许集。 */
function useModelOptions(employee: AiEmployeeRow | null): ModelOptions {
  const allowed = resolveAllowedModels(employee);
  const services = useQuery({
    queryKey: ['ai', 'llm-services', 'for-conversation'],
    queryFn: async () => {
      const result = await api.resourceAction<Array<Record<string, unknown>>>('llmServices', 'list', {
        params: { pageSize: 100 },
      });
      return Array.isArray(result.data) ? result.data : [];
    },
    retry: false,
    staleTime: 60_000,
  });

  return useMemo(() => {
    if (allowed.enforced) {
      if (allowed.models.length === 0) {
        return {
          options: [],
          allowed: allowed.models,
          enforced: true,
          hint: '这位员工不允许使用任何模型',
          warning:
            '这位员工启用了专用模型限制，但允许集为空：现在发送会被后端拒绝。请先让管理员在员工配置里补上模型。',
        };
      }
      return {
        options: allowed.models.map((item) => ({
          value: `${item.llmService}::${item.model}`,
          label: `${item.model}（${item.llmService}）`,
        })),
        allowed: allowed.models,
        enforced: true,
        hint: '只能使用这位员工允许的模型',
      };
    }
    const options: Array<{ value: string; label: string }> = [];
    for (const row of services.data ?? []) {
      const service = String(row.name ?? '');
      const models = row.enabledModels;
      const list = Array.isArray(models)
        ? models
        : models && typeof models === 'object' && Array.isArray((models as { models?: unknown }).models)
          ? ((models as { models?: unknown[] }).models as unknown[])
          : [];
      for (const item of list) {
        const modelId =
          typeof item === 'string'
            ? item
            : item && typeof item === 'object' && typeof (item as { model?: unknown }).model === 'string'
              ? String((item as { model: string }).model)
              : '';
        if (service && modelId) options.push({ value: `${service}::${modelId}`, label: `${modelId}（${service}）` });
      }
    }
    return {
      options,
      allowed: [],
      enforced: false,
      hint: options.length > 0 ? '不选则由后端按全局规则决定' : '后端没有返回可用模型，将由后端按全局规则决定',
      warning: services.error
        ? `服务列表读取失败，暂时无法列出模型：${resourceMessageOf(services.error)} 不选模型仍可发送。`
        : undefined,
    };
  }, [allowed.enforced, allowed.models, services.data, services.error]);
}

function pickModel(
  value: string,
  options: ModelOptions,
): { llmService: string; model: string } | null {
  if (!value) {
    // 员工限制启用时必须带一个允许集内的模型，否则后端会静默回退到允许集第一个。
    return options.enforced && options.allowed.length > 0 ? options.allowed[0] : null;
  }
  const [llmService, model] = value.split('::');
  if (!llmService || !model) return null;
  return { llmService, model };
}

/** 把选中的上下文数据源组装成 `messages[0].workContext` 项（内容来自已保存记录）。 */
export async function buildWorkContext(ids: string[]): Promise<Array<Record<string, unknown>>> {
  if (ids.length === 0) return [];
  const items: Array<Record<string, unknown>> = [];
  for (const id of ids) {
    let record: AiContextDatasourceRow | null = null;
    try {
      record = await getContextDatasource(id);
    } catch {
      record = null;
    }
    if (!record) continue;
    items.push({
      type: 'datasource',
      uid: record.id,
      title: record.title,
      content: {
        datasource: record.datasource,
        collectionName: record.collectionName,
        fields: record.fields,
        filter: record.filter,
        sort: record.sort,
        limit: record.limit,
      },
    });
  }
  return items;
}

function ContextPicker({
  selected,
  onChange,
  unavailableReason,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
  unavailableReason?: string;
}) {
  const sources = useQuery({
    queryKey: ['ai', 'context-datasources', 'for-conversation'],
    queryFn: () => listContextDatasources({ pageSize: 100, sort: ['-createdAt'] }),
    retry: false,
  });
  const rows = sources.data?.rows ?? [];

  return (
    <Field
      label="本次携带的上下文"
      hint="上下文会随消息一起发送，服务端会按你当前的权限重新过滤；没有权限时返回空结果而不是报错。"
    >
      {rows.length === 0 ? (
        <span className={styles.rowHint}>
          {sources.error
            ? `上下文数据源读取失败：${resourceMessageOf(sources.error)}`
            : unavailableReason ?? '还没有保存过上下文数据源；可以到「任务与数据上下文」页新建。'}
        </span>
      ) : (
        <div className={styles.chipRow}>
          {rows.map((row) => {
            const active = selected.includes(row.id);
            return (
              <button
                key={row.id}
                type="button"
                className={active ? `${styles.chip} ${styles.chipActive}` : styles.chip}
                onClick={() => onChange(active ? selected.filter((id) => id !== row.id) : [...selected, row.id])}
              >
                {row.title}
              </button>
            );
          })}
        </div>
      )}
    </Field>
  );
}

function MessageList({
  messages,
  historyState,
  historyMessage,
  streaming,
  employeeUsername,
  onResend,
  onReload,
  onDecide,
}: {
  messages: ChatMessage[];
  historyState: ReturnType<typeof resourceStateOf>;
  historyMessage: string | null;
  streaming: boolean;
  employeeUsername: string;
  onResend: (messageId: string) => void;
  onReload: () => void;
  onDecide: (toolCallId: string, messageId: string, decision: 'approve' | 'edit' | 'reject') => void;
}) {
  const lastAssistantIndex = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role !== 'user' && messages[index].role !== 'error') return index;
    }
    return -1;
  }, [messages]);

  return (
    <>
      <StateBlock
        state={messages.length === 0 ? historyState : 'ready'}
        message={historyMessage}
        onRetry={onReload}
        emptyTitle="这次会话还没有消息"
        emptyDescription="在下方输入内容即可开始对话。"
      />
      <div className={styles.chatMessages}>
        {messages.map((message, index) => (
          <div
            key={message.key}
            className={
              message.isError
                ? `${styles.bubble} ${styles.bubbleError}`
                : message.role === 'user'
                  ? `${styles.bubble} ${styles.bubbleUser}`
                  : styles.bubble
            }
          >
            <div className={styles.bubbleMeta}>
              <span>{message.role === 'user' ? '我' : message.role || employeeUsername || '助手'}</span>
              {message.createdAt ? <span>{formatTime(message.createdAt)}</span> : null}
              {message.loading && streaming ? <span>正在生成…</span> : null}
              {!message.loading && index === lastAssistantIndex && !streaming && message.role !== 'user' ? (
                <button
                  type="button"
                  className={`${styles.button} ${styles.buttonSmall}`}
                  onClick={() => onResend(message.key)}
                >
                  重新生成
                </button>
              ) : null}
            </div>
            <span className={message.loading && streaming ? styles.streamingDot : undefined}>{message.text}</span>
            {message.reasoning ? <div className={styles.reasoning}>思考过程：{message.reasoning}</div> : null}
            {message.toolCalls.length > 0 ? (
              <div>
                {message.toolCalls.map((call) => (
                  <div key={call.id || call.name} className={styles.toolCard}>
                    <div className={styles.toolCardTitle}>
                      <span>{call.name}</span>
                      {call.invokeStatus ? <StatusPill tone="neutral">{toolStatusLabel(call.invokeStatus)}</StatusPill> : null}
                      {call.status ? (
                        <StatusPill tone={call.status === 'success' ? 'ok' : 'danger'}>
                          {call.status === 'success' ? '执行成功' : '执行失败'}
                        </StatusPill>
                      ) : null}
                    </div>
                    {call.args ? <div className={styles.mono}>{call.args}</div> : null}
                    {call.willInterrupt && call.invokeStatus === 'interrupted' ? (
                      <div className={styles.toolbar} style={{ marginTop: 8, marginBottom: 0 }}>
                        <button
                          type="button"
                          className={`${styles.button} ${styles.buttonSmall} ${styles.buttonPrimary}`}
                          onClick={() => onDecide(call.id, call.messageId ?? '', 'approve')}
                        >
                          允许执行
                        </button>
                        <button
                          type="button"
                          className={`${styles.button} ${styles.buttonSmall}`}
                          onClick={() => onDecide(call.id, call.messageId ?? '', 'reject')}
                        >
                          拒绝
                        </button>
                        <span className={styles.rowHint}>
                          需要修改参数时，请拒绝后在消息里说明你要的改动。
                        </span>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {messages.length > 0 ? (
        <p className={styles.rowHint}>
          以上内容来自后端保存的消息记录与实时增量；未展示的字段（如附件、工具原始输出）不会用占位内容代替。
        </p>
      ) : null}
      {messages.length > 0 && !streaming ? (
        <button type="button" className={styles.button} onClick={onReload}>
          从服务端重新读取消息
        </button>
      ) : null}
    </>
  );
}

function toolStatusLabel(status: string): string {
  switch (status) {
    case 'init':
      return '准备中';
    case 'interrupted':
      return '等待你确认';
    case 'waiting':
      return '等待其它工具';
    case 'pending':
      return '执行中';
    case 'done':
      return '已完成';
    case 'confirmed':
      return '已确认';
    default:
      return '进行中';
  }
}
