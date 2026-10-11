import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSessionStore } from '../../../auth/store';
import { isResourceActionAllowed } from '../../../permissions/model';
import { PageCard, PageHeader, StatusPill } from '../../../components/Card';
import { CrewloomError } from '../../../api/errors';
import {
  createMcpClient,
  destroyMcpClient,
  listMcpClients,
  listMcpTools,
  rebuildMcpClient,
  resourceMessageOf,
  resourceStateOf,
  testMcpConnection,
  updateMcpClient,
  updateMcpToolPermission,
} from '../resources';
import type { AiMcpClientRow, McpTestResult, McpToolEntry } from '../types';
import { MCP_TRANSPORTS } from '../types';
import { Checkbox, Field, ListPager, Notice, Select, StateBlock, TextArea, TextInput, formatTime, orDash } from '../ui';
import styles from '../group-a.module.css';

/**
 * AI-05（二）MCP 连接。
 *
 * 契约已闭环（十页契约附录 A2），按**完整实现**：
 *  - `aiMcpClients:list` 返回 200、数据为 0 —— 这是**配置为空**，不是"功能未开通"；
 *    它是 `ai` 插件的原生能力，没有独立的 `mcp-client` 插件名不能证明功能不存在。
 *  - 身份是**配置模板渲染**：`{{ $env.X }}`、`{{ currentUser.* }}` / `{{ $user.* }}`、
 *    `{{ request.token }}`、`{{ request.headers.* }}`；`useUserContext` 决定按用户还是共享客户端，
 *    `stdio` 强制共享（无法按用户隔离）。
 *  - 连接测试 / 取工具 / 重建客户端都会**外呼外部服务**：只允许真实用户主动点击，
 *    自动验证（严格模式）一律拦截。
 *  - `{{ request.token }}` 会把当前用户的 NocoBase 令牌发给外部服务，这是需要明确知晓的设计点，
 *    界面在此给出提示，不隐藏。
 *
 * 配置里可能出现令牌类模板或真实密钥，因此默认对 `headers` / `env` 的敏感值做遮蔽，
 * 需要核对原文时由用户显式点击显示；不写日志、不进报告。
 */

const PAGE_SIZE = 20;

export function McpPage() {
  const access = useSessionStore((state) => state.access);
  const canWrite = isResourceActionAllowed(access, 'aiMcpClients', 'create');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const list = useQuery({
    queryKey: ['ai', 'mcp-clients', page],
    queryFn: () => listMcpClients({ page, pageSize: PAGE_SIZE, sort: ['-createdAt'] }),
  });

  const rows = list.data?.rows ?? [];
  const state = list.isLoading ? 'loading' : resourceStateOf(list.error, rows.length === 0);
  const record = useMemo(() => rows.find((row) => row.name === selected) ?? null, [rows, selected]);

  return (
    <div className={styles.stack}>
      <PageHeader
        title="MCP 连接"
        description="把外部 MCP 服务接给数字员工使用。这里的列表来自后端配置；列表为空只表示还没有配置，不代表能力不可用。"
      />

      <PageCard title="身份与生命周期说明" description="这些行为由后端实现，界面如实呈现，不隐藏风险。">
        <div className={styles.rowList}>
          <div className={styles.rowCard}>
            <div className={styles.rowMain}>
              <span className={styles.rowTitle}>身份模板</span>
              <span className={styles.rowHint}>
                写 URL 或请求头时可以用模板：{'{'}
                {'{ $env.变量名 }}'}、{'{'}
                {'{ currentUser.字段 }}'}、{'{'}
                {'{ request.token }}'}、{'{'}
                {'{ request.headers.头名 }}'}。
              </span>
            </div>
          </div>
          <div className={styles.rowCard}>
            <div className={styles.rowMain}>
              <span className={styles.rowTitle}>按用户还是共享</span>
              <span className={styles.rowHint}>
                打开「按用户使用」会给每个用户单独建立连接（缓存 5 分钟后自动关闭，持续使用也不会延长）；
                关闭时是进程内共享连接。使用 stdio 时后端强制共享，无法按用户隔离。
              </span>
            </div>
          </div>
          <div className={styles.rowCard}>
            <div className={styles.rowMain}>
              <span className={styles.rowTitle}>令牌转发的风险</span>
              <span className={styles.rowHint}>
                只有在配置里显式写了 {'{{ request.token }}'} 时，当前用户的登录令牌才会发给外部 MCP 服务；
                外部服务如何使用它由其自身决定，不受本系统权限约束。
              </span>
            </div>
          </div>
          <div className={styles.rowCard}>
            <div className={styles.rowMain}>
              <span className={styles.rowTitle}>连接测试与工具清单</span>
              <span className={styles.rowHint}>
                这两个操作会真实连接外部服务。它们只在你点击时执行；外部服务可能产生费用或副作用。
              </span>
            </div>
          </div>
        </div>
      </PageCard>

      {creating ? (
        <McpForm
          mode="create"
          canWrite={canWrite}
          onCancel={() => setCreating(false)}
          onSaved={(name) => {
            setCreating(false);
            setSelected(name);
            void list.refetch();
          }}
        />
      ) : null}

      <PageCard
        title="连接配置"
        description="留空不代表删除；编辑后保存会整体提交这条记录。"
        actions={
          <button
            type="button"
            className={`${styles.button} ${styles.buttonPrimary}`}
            disabled={!canWrite || creating}
            onClick={() => setCreating(true)}
          >
            新建连接
          </button>
        }
      >
        <StateBlock
          state={state}
          message={resourceMessageOf(list.error)}
          onRetry={() => void list.refetch()}
          emptyTitle="还没有配置任何 MCP 连接"
          emptyDescription="后端返回了 200 与空列表：这表示 MCP 能力可用、只是还没有配置。"
          deniedDescription="你的角色没有查看 MCP 连接配置的权限。"
        />
        {rows.length > 0 ? (
          <div className={styles.rowList}>
            {rows.map((row) => (
              <button
                key={row.name}
                type="button"
                className={row.name === selected ? `${styles.rowCard} ${styles.rowCardActive}` : styles.rowCard}
                style={{ textAlign: 'left', cursor: 'pointer' }}
                onClick={() => setSelected(row.name)}
              >
                <span className={styles.rowMain}>
                  <span className={styles.chipRow}>
                    <span className={styles.rowTitle}>{row.title || row.name}</span>
                    {row.enabled === false ? <StatusPill tone="warn">已停用</StatusPill> : <StatusPill tone="ok">已启用</StatusPill>}
                    <StatusPill tone="neutral">{transportLabel(row.transport)}</StatusPill>
                    {row.useUserContext ? <StatusPill tone="brand">按用户连接</StatusPill> : null}
                  </span>
                  <span className={styles.rowHint}>
                    {row.name}　{row.url ? maskUrl(row.url) : row.command ? `命令：${row.command}` : '未配置地址'}
                  </span>
                </span>
              </button>
            ))}
          </div>
        ) : null}
        <ListPager
          meta={(list.data?.meta ?? {}) as { count?: number; hasNext?: boolean }}
          page={page}
          pageSize={PAGE_SIZE}
          isFetching={list.isFetching}
          onChange={setPage}
        />
      </PageCard>

      {record ? (
        <McpDetail
          key={record.name}
          record={record}
          canWrite={canWrite}
          onChanged={() => void list.refetch()}
          onRemoved={() => {
            setSelected(null);
            void list.refetch();
          }}
        />
      ) : null}
    </div>
  );
}

function McpDetail({
  record,
  canWrite,
  onChanged,
  onRemoved,
}: {
  record: AiMcpClientRow;
  canWrite: boolean;
  onChanged: () => void;
  onRemoved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'info' | 'warn' | 'danger'; text: string } | null>(null);
  const [testResult, setTestResult] = useState<McpTestResult | null>(null);
  const [tools, setTools] = useState<Record<string, McpToolEntry[]> | null>(null);
  const [revealed, setRevealed] = useState(false);

  if (editing) {
    return (
      <McpForm
        mode="edit"
        record={record}
        canWrite={canWrite}
        onCancel={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          onChanged();
        }}
      />
    );
  }

  const remove = async () => {
    setBusy('remove');
    setNotice(null);
    try {
      await destroyMcpClient(record.name);
      onRemoved();
    } catch (caught) {
      setNotice({
        tone: 'danger',
        text: caught instanceof CrewloomError ? caught.userMessage : '删除失败，请稍后重试。',
      });
    } finally {
      setBusy(null);
    }
  };

  const optionsPayload = (): Record<string, unknown> => ({
    transport: record.transport ?? 'http',
    useUserContext: record.useUserContext === true,
    url: record.url ?? undefined,
    headers: record.headers ?? undefined,
    command: record.command ?? undefined,
    args: record.args ?? undefined,
    env: record.env ?? undefined,
    restart: record.restart ?? undefined,
  });

  const runTest = async () => {
    setBusy('test');
    setNotice(null);
    setTestResult(null);
    try {
      const result = await testMcpConnection(optionsPayload());
      setTestResult(result);
    } catch (caught) {
      setNotice({
        tone: 'warn',
        text: `连接测试没有完成：${caught instanceof CrewloomError ? caught.userMessage : '请稍后重试。'}`,
      });
    } finally {
      setBusy(null);
    }
  };

  const loadTools = async () => {
    setBusy('tools');
    setNotice(null);
    try {
      setTools(await listMcpTools());
    } catch (caught) {
      setNotice({
        tone: 'warn',
        text: `读取工具清单失败：${caught instanceof CrewloomError ? caught.userMessage : '请稍后重试。'}`,
      });
    } finally {
      setBusy(null);
    }
  };

  const rebuild = async () => {
    setBusy('rebuild');
    setNotice(null);
    try {
      await rebuildMcpClient();
      setNotice({ tone: 'info', text: '已通知服务端重建共享连接。' });
    } catch (caught) {
      setNotice({
        tone: 'warn',
        text: `重建失败：${caught instanceof CrewloomError ? caught.userMessage : '请稍后重试。'}`,
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageCard
        title={record.title || record.name}
        description={record.description || '没有填写说明。'}
        actions={
          <div className={styles.rowActions}>
            <button type="button" className={styles.button} disabled={!canWrite} onClick={() => setEditing(true)}>
              编辑
            </button>
            <button
              type="button"
              className={`${styles.button} ${styles.buttonDanger}`}
              disabled={!canWrite || busy !== null}
              onClick={() => void remove()}
            >
              删除
            </button>
          </div>
        }
      >
        <div className={styles.fieldRow}>
          <Field label="标识">
            <span className={styles.mono}>{record.name}</span>
          </Field>
          <Field label="传输方式">
            <span>{transportLabel(record.transport)}</span>
          </Field>
          <Field label="状态">
            <span>{record.enabled === false ? '已停用' : '已启用'}</span>
          </Field>
          <Field label="按用户连接">
            <span>{record.useUserContext ? '是（每用户一个连接，5 分钟绝对过期）' : '否（共享连接）'}</span>
          </Field>
          <Field label="地址">
            <span className={styles.mono}>{record.url ? maskUrl(record.url) : '—'}</span>
          </Field>
          <Field label="命令">
            <span className={styles.mono}>{record.command ? record.command : '—'}</span>
          </Field>
        </div>

        <Field
          label="请求头 / 环境变量"
          hint="包含令牌或密钥的字段默认遮蔽；需要核对原文时点右侧按钮（不要截图或复制到报告里）。"
        >
          <div className={styles.toolbar} style={{ marginBottom: 8 }}>
            <button type="button" className={styles.button} onClick={() => setRevealed(!revealed)}>
              {revealed ? '隐藏敏感值' : '显示原文'}
            </button>
          </div>
          <pre className={styles.bubble}>
            {JSON.stringify(
              {
                headers: redactMap(record.headers, revealed),
                env: redactMap(record.env, revealed),
                args: record.args ?? null,
              },
              null,
              2,
            )}
          </pre>
        </Field>

        <div className={styles.rowHint}>
          创建于 {formatTime(record.createdAt)}　更新于 {formatTime(record.updatedAt)}
        </div>

        {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
        {!canWrite ? <Notice tone="warn">你的角色没有修改 MCP 连接的权限。</Notice> : null}
      </PageCard>

      <PageCard
        title="连接测试与工具"
        description="下面每个操作都会真实连接外部 MCP 服务，只在你点击时执行。"
      >
        <div className={styles.toolbar}>
          <button type="button" className={styles.button} disabled={busy !== null} onClick={() => void runTest()}>
            {busy === 'test' ? '正在测试…' : '测试连接'}
          </button>
          <button type="button" className={styles.button} disabled={busy !== null} onClick={() => void loadTools()}>
            {busy === 'tools' ? '正在读取…' : '读取工具清单'}
          </button>
          <button type="button" className={styles.button} disabled={busy !== null} onClick={() => void rebuild()}>
            {busy === 'rebuild' ? '正在重建…' : '重建共享连接'}
          </button>
        </div>

        {testResult ? (
          <Notice tone={testResult.success ? 'info' : 'warn'}>
            {testResult.success
              ? `连接成功${typeof testResult.toolsCount === 'number' ? `，发现 ${testResult.toolsCount} 个工具` : ''}。`
              : `连接失败：${testResult.error || testResult.message || '外部服务没有返回原因。'}`}
          </Notice>
        ) : null}

        {tools ? <ToolPermissionList tools={tools} onChanged={() => void loadTools()} /> : null}
      </PageCard>
    </>
  );
}

function ToolPermissionList({
  tools,
  onChanged,
}: {
  tools: Record<string, McpToolEntry[]>;
  onChanged: () => void;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const servers = Object.keys(tools);

  const change = async (toolName: string, permission: 'ASK' | 'ALLOW') => {
    setBusy(toolName);
    setNotice(null);
    try {
      await updateMcpToolPermission(toolName, permission);
      onChanged();
    } catch (caught) {
      setNotice(caught instanceof CrewloomError ? caught.userMessage : '保存工具权限失败，请稍后重试。');
    } finally {
      setBusy(null);
    }
  };

  if (servers.length === 0) {
    return <Notice>外部服务没有返回任何工具。</Notice>;
  }

  return (
    <div style={{ marginTop: 12 }}>
      {notice ? <Notice tone="danger">{notice}</Notice> : null}
      {servers.map((server) => (
        <div key={server} style={{ marginBottom: 12 }}>
          <span className={styles.fieldLabel}>{server}</span>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>工具</th>
                  <th>说明</th>
                  <th>调用方式</th>
                </tr>
              </thead>
              <tbody>
                {(tools[server] ?? []).map((tool) => (
                  <tr key={`${server}:${tool.name}`}>
                    <td>
                      <span className={styles.mono}>{tool.title || tool.name}</span>
                    </td>
                    <td>{tool.description || '—'}</td>
                    <td>
                      <Select
                        value={tool.permission === 'ALLOW' ? 'ALLOW' : 'ASK'}
                        disabled={busy === tool.name}
                        inline
                        ariaLabel={`${tool.name} 的调用方式`}
                        onChange={(next) => void change(tool.name, next === 'ALLOW' ? 'ALLOW' : 'ASK')}
                        options={[
                          { value: 'ASK', label: '需要确认' },
                          { value: 'ALLOW', label: '允许自动执行' },
                        ]}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

interface McpFormState {
  name: string;
  title: string;
  description: string;
  enabled: boolean;
  transport: string;
  useUserContext: boolean;
  command: string;
  url: string;
  args: string;
  env: string;
  headers: string;
  restart: string;
}

function toFormState(record?: AiMcpClientRow): McpFormState {
  return {
    name: record?.name ?? '',
    title: record?.title ?? '',
    description: record?.description ?? '',
    enabled: record?.enabled !== false,
    transport: record?.transport ?? 'http',
    useUserContext: record?.useUserContext === true,
    command: record?.command ?? '',
    url: record?.url ?? '',
    args: record?.args ? JSON.stringify(record.args, null, 2) : '',
    env: record?.env ? JSON.stringify(record.env, null, 2) : '',
    headers: record?.headers ? JSON.stringify(record.headers, null, 2) : '',
    restart: record?.restart ? JSON.stringify(record.restart, null, 2) : '',
  };
}

function McpForm({
  mode,
  record,
  canWrite,
  onCancel,
  onSaved,
}: {
  mode: 'create' | 'edit';
  record?: AiMcpClientRow;
  canWrite: boolean;
  onCancel: () => void;
  onSaved: (name: string) => void;
}) {
  const [form, setForm] = useState<McpFormState>(() => toFormState(record));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isStdio = form.transport === 'stdio';
  const disabled = !canWrite || pending;

  const submit = async () => {
    if (form.name.trim().length === 0) {
      setError('请填写连接标识（name）。');
      return;
    }
    let args: unknown;
    let env: unknown;
    let headers: unknown;
    let restart: unknown;
    try {
      args = form.args.trim() ? JSON.parse(form.args) : [];
      env = form.env.trim() ? JSON.parse(form.env) : {};
      headers = form.headers.trim() ? JSON.parse(form.headers) : {};
      restart = form.restart.trim() ? JSON.parse(form.restart) : {};
    } catch {
      setError('参数 / 环境变量 / 请求头 / 重启设置需要是合法的 JSON。');
      return;
    }
    const values: Record<string, unknown> = {
      title: form.title.trim(),
      description: form.description.trim(),
      enabled: form.enabled,
      transport: form.transport,
      // stdio 由后端强制共享；这里同步成 false，避免误导。
      useUserContext: isStdio ? false : form.useUserContext,
      command: isStdio ? form.command.trim() : null,
      url: isStdio ? null : form.url.trim(),
      args,
      env,
      headers,
      restart,
    };
    if (mode === 'create') values.name = form.name.trim();

    setPending(true);
    setError(null);
    try {
      if (mode === 'create') {
        await createMcpClient(values);
        onSaved(form.name.trim());
      } else if (record) {
        await updateMcpClient(record.name, values);
        onSaved(record.name);
      }
    } catch (caught) {
      setError(caught instanceof CrewloomError ? caught.userMessage : '保存失败，请稍后重试。');
    } finally {
      setPending(false);
    }
  };

  return (
    <PageCard title={mode === 'create' ? '新建 MCP 连接' : `编辑 MCP 连接：${record?.name}`}>
      {!canWrite ? <Notice tone="warn">你的角色没有保存 MCP 连接的权限。</Notice> : null}
      <div className={styles.fieldRow}>
        <Field label="连接标识" required hint="唯一标识，创建后不可更改。">
          <TextInput
            value={form.name}
            disabled={disabled || mode === 'edit'}
            onChange={(next) => setForm((prev) => ({ ...prev, name: next }))}
          />
        </Field>
        <Field label="名称">
          <TextInput value={form.title} disabled={disabled} onChange={(next) => setForm((prev) => ({ ...prev, title: next }))} />
        </Field>
        <Field label="传输方式" hint="stdio 只能在服务器本机以子进程方式运行，且强制共享连接。">
          <Select
            value={form.transport}
            disabled={disabled}
            onChange={(next) =>
              setForm((prev) => ({
                ...prev,
                transport: next,
                useUserContext: next === 'stdio' ? false : prev.useUserContext,
              }))
            }
            options={MCP_TRANSPORTS.map((item) => ({ value: item, label: transportLabel(item) }))}
          />
        </Field>
        <Field label="状态">
          <Checkbox
            label="启用这个连接"
            checked={form.enabled}
            disabled={disabled}
            onChange={(next) => setForm((prev) => ({ ...prev, enabled: next }))}
          />
        </Field>
      </div>

      <Field label="说明">
        <TextArea value={form.description} rows={2} disabled={disabled} onChange={(next) => setForm((prev) => ({ ...prev, description: next }))} />
      </Field>

      {isStdio ? (
        <Field label="启动命令" hint="例如 npx；参数写在下面的 args 里。">
          <TextInput value={form.command} disabled={disabled} onChange={(next) => setForm((prev) => ({ ...prev, command: next }))} />
        </Field>
      ) : (
        <>
          <Field
            label="服务地址"
            hint={'支持模板：{{ $env.变量名 }}、{{ currentUser.字段 }}、{{ request.token }}、{{ request.headers.头名 }}'}
          >
            <TextInput value={form.url} disabled={disabled} onChange={(next) => setForm((prev) => ({ ...prev, url: next }))} />
          </Field>
          <Field
            label="请求头（JSON）"
            hint={'示例：{"Authorization":"Bearer {{ request.token }}"}。写了 request.token 就会把当前用户的令牌发给外部服务。'}
          >
            <TextArea value={form.headers} rows={3} disabled={disabled} onChange={(next) => setForm((prev) => ({ ...prev, headers: next }))} />
          </Field>
          <Field label="按用户使用">
            <Checkbox
              label="为每个用户建立独立连接（关闭时所有人共享一个连接）"
              checked={form.useUserContext}
              disabled={disabled || isStdio}
              onChange={(next) => setForm((prev) => ({ ...prev, useUserContext: next }))}
            />
          </Field>
        </>
      )}

      <div className={styles.fieldRow}>
        <Field label="启动参数（JSON 数组）">
          <TextArea value={form.args} rows={3} disabled={disabled} onChange={(next) => setForm((prev) => ({ ...prev, args: next }))} />
        </Field>
        <Field label="环境变量（JSON 对象）">
          <TextArea value={form.env} rows={3} disabled={disabled} onChange={(next) => setForm((prev) => ({ ...prev, env: next }))} />
        </Field>
      </div>

      <Field label="重启设置（JSON 对象）" hint="留空表示使用默认行为。">
        <TextArea value={form.restart} rows={2} disabled={disabled} onChange={(next) => setForm((prev) => ({ ...prev, restart: next }))} />
      </Field>

      {error ? <Notice tone="danger">{error}</Notice> : null}

      <div className={styles.toolbar} style={{ marginBottom: 0 }}>
        <button type="button" className={`${styles.button} ${styles.buttonPrimary}`} disabled={disabled} onClick={() => void submit()}>
          {pending ? '正在保存…' : '保存'}
        </button>
        <button type="button" className={styles.button} disabled={pending} onClick={onCancel}>
          取消
        </button>
        <span className={styles.rowHint}>保存不会自动连接外部服务。</span>
      </div>
    </PageCard>
  );
}

function transportLabel(transport: unknown): string {
  switch (transport) {
    case 'http':
      return 'HTTP';
    case 'sse':
      return 'SSE';
    case 'stdio':
      return '本机子进程（stdio）';
    default:
      return orDash(transport) as string;
  }
}

/** 遮蔽敏感值：只在用户显式点击后显示原文。 */
export function redactMap(value: unknown, revealed: boolean): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value ?? null;
  const entries = Object.entries(value as Record<string, unknown>);
  const output: Record<string, unknown> = {};
  for (const [key, item] of entries) {
    const sensitive = /token|key|secret|password|authorization|credential/i.test(key)
      || (typeof item === 'string' && /(bearer\s+[a-z0-9._-]{8,})/i.test(item));
    output[key] = sensitive && !revealed ? '（已隐藏）' : item;
  }
  return output;
}

/** URL 只保留主机与路径形状，去掉查询串（查询串里可能带令牌）。 */
export function maskUrl(url: string): string {
  const queryIndex = url.indexOf('?');
  if (queryIndex < 0) return url;
  return `${url.slice(0, queryIndex)}?（已隐藏查询参数）`;
}
