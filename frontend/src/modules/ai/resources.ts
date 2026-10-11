import { api } from '../../api/client';
import { CrewloomError, toUserMessage } from '../../api/errors';
import { readAction } from './read-action';
import type { ApiListMeta, ListParams } from '../../api/types';
import type { ResourceState } from '../../api/hooks';
import type {
  AiContextDatasourceRow,
  AiConversationRow,
  AiEmployeeRow,
  AiMcpClientRow,
  AiMessageRow,
  AiSkillRow,
  AiToolRow,
  McpTestResult,
  McpToolEntry,
} from './types';

/**
 * AI 模块的资源访问封装（组 A 独占）。
 *
 * 全部走 `src/api/client.ts` 的既有请求管线（认证 / 角色 / 续期 / 异步世代 / 传输策略），
 * **不新建第二条请求通道**，也不自己拼 URL 或手工加身份头。
 *
 * 方法选择由 `client.ts` 的 `isReadAction` 与 SDK 决定：
 *  - `list` / `get` / `listByUser` / `getMessages` / `preview` → GET；
 *  - `create` / `update` / `destroy` / `abort` / `sendMessages` … → POST。
 */

export interface Paged<T> {
  rows: T[];
  meta: ApiListMeta;
}

/**
 * 把请求错误归一到公共六态（与 `src/api/hooks.ts` 的 `classify` 同一口径）。
 *
 * 这里只做分类，不重新实现取数：页面用 React Query 调本文件的资源封装，
 * 由本函数保证"无权限 / 未登录或角色失效 / 空数据 / 读取失败"不会混成一句话。
 */
export function resourceStateOf(error: unknown, isEmpty: boolean): ResourceState {
  if (!error) return isEmpty ? 'empty' : 'ready';
  if (error instanceof CrewloomError) {
    if (error.kind === 'forbidden') return 'denied';
    if (error.kind === 'unauthenticated' || error.kind === 'role-invalid') return 'unauthorized';
  }
  return 'error';
}

/** 面向用户的中文提示；无错误时为 null。 */
export function resourceMessageOf(error: unknown): string | null {
  return error ? toUserMessage(error) : null;
}

function paged<T>(result: { data: unknown; meta?: ApiListMeta }): Paged<T> {
  return {
    rows: Array.isArray(result.data) ? (result.data as T[]) : [],
    meta: (result.meta ?? {}) as ApiListMeta,
  };
}

/* ------------------------------- AI-01 / AI-02 员工 ------------------------------- */

/** 「可使用」员工：`aiEmployees:listByUser`，只返回 enabled=true 且当前角色被授权的员工。 */
export async function listUsableEmployees(params?: ListParams): Promise<Paged<AiEmployeeRow>> {
  return paged<AiEmployeeRow>(await api.resourceAction<AiEmployeeRow[]>('aiEmployees', 'listByUser', { params }));
}

/** 「可管理」员工：`aiEmployees:list`，需要员工管理权限；包含已停用的员工。 */
export async function listEmployees(params?: ListParams): Promise<Paged<AiEmployeeRow>> {
  return paged<AiEmployeeRow>(await api.resourceAction<AiEmployeeRow[]>('aiEmployees', 'list', { params }));
}

export async function getEmployee(username: string): Promise<AiEmployeeRow | null> {
  const result = await api.resourceAction<AiEmployeeRow>('aiEmployees', 'get', {
    params: { filterByTk: username },
  });
  return (result.data ?? null) as AiEmployeeRow | null;
}

export async function createEmployee(values: Record<string, unknown>): Promise<AiEmployeeRow | null> {
  const result = await api.resourceAction<AiEmployeeRow>('aiEmployees', 'create', { values });
  return (result.data ?? null) as AiEmployeeRow | null;
}

export async function updateEmployee(
  username: string,
  values: Record<string, unknown>,
): Promise<AiEmployeeRow | null> {
  const result = await api.resourceAction<AiEmployeeRow>('aiEmployees', 'update', {
    values,
    params: { filterByTk: username },
  });
  return (result.data ?? null) as AiEmployeeRow | null;
}

/* ------------------------------- AI-02 / AI-05 工具与技能 ------------------------------- */

export async function listTools(params?: ListParams): Promise<Paged<AiToolRow>> {
  return paged<AiToolRow>(await api.resourceAction<AiToolRow[]>('aiTools', 'list', { params }));
}

export async function listSkills(params?: ListParams): Promise<Paged<AiSkillRow>> {
  return paged<AiSkillRow>(await api.resourceAction<AiSkillRow[]>('aiSkills', 'list', { params }));
}

/* ------------------------------- AI-03 会话 ------------------------------- */

/**
 * 会话列表。
 *
 * **不要传 `fields`**：13000 实测 `aiConversations:list?fields=id` 返回 400
 * `Invalid SQL column or table reference`（报告 02 §8 的 C2/D2）；会话也没有 `id` 字段，
 * 标识一律用 `sessionId`。
 */
export async function listConversations(params?: ListParams): Promise<Paged<AiConversationRow>> {
  const { fields: _ignored, ...safe } = params ?? {};
  return paged<AiConversationRow>(
    await api.resourceAction<AiConversationRow[]>('aiConversations', 'list', { params: safe }),
  );
}

export async function getConversation(sessionId: string): Promise<AiConversationRow | null> {
  const result = await api.resourceAction<AiConversationRow>('aiConversations', 'get', {
    params: { filter: { sessionId } },
  });
  return (result.data ?? null) as AiConversationRow | null;
}

export async function createConversation(values: Record<string, unknown>): Promise<AiConversationRow | null> {
  const result = await api.resourceAction<AiConversationRow>('aiConversations', 'create', { values });
  return (result.data ?? null) as AiConversationRow | null;
}

export interface ConversationHistory {
  rows: AiMessageRow[];
  /** 是否还有更早的历史（原生分页每页 10 条，`paginate=false` 时最多 200 条、无分页信息）。 */
  hasMore: boolean;
  cursor: string | null;
}

/**
 * 读取会话消息。
 *
 * 与原生客户端一致：`paginate=false` 一次取最多 200 条，服务端按 `-messageId` 倒序返回，
 * 本函数**翻转为正序**后交给界面，避免界面按倒序渲染。
 *
 * **`updateRead` 一律显式传递**（默认 `'false'`）：服务端只有收到 `'true'`/`true` 才会把会话
 * 标记为已读（`server/resource/aiConversations.ts:284`：`updateRead = originalUpdateRead === 'true'
 * || originalUpdateRead === true`）。不依赖"缺省即不写"的默认值——不同版本的默认值一旦不同，
 * 自动只读验证就会产生真实写副作用。产品侧目前没有任何"标记已读"入口，因此默认永远是 `false`。
 */
export async function loadConversationMessages(
  sessionId: string,
  options: { paginate?: boolean; cursor?: string; updateRead?: boolean } = {},
): Promise<ConversationHistory> {
  const paginate = options.paginate === true;
  const result = await readAction<AiMessageRow[] | { rows?: AiMessageRow[]; hasMore?: boolean; cursor?: string | null }>(
    'aiConversations',
    'getMessages',
    {
      sessionId,
      paginate: paginate ? 'true' : 'false',
      updateRead: options.updateRead === true ? 'true' : 'false',
      ...(options.cursor ? { cursor: options.cursor } : {}),
    },
  );
  // 2.2.20 的服务端 manager 返回 `{ rows, hasMore, cursor }`；原生 v2 客户端按 `data` 是消息数组读取。
  // 两种形态都在这里归一化：只认 `rows` 时，一旦服务端返回数组形态，非空历史会被当成空。
  const payload = result.data;
  const rowContainer = payload as { rows?: AiMessageRow[]; hasMore?: boolean; cursor?: string | null } | undefined;
  const rawRows = Array.isArray(payload)
    ? (payload as AiMessageRow[])
    : Array.isArray(rowContainer?.rows)
      ? (rowContainer?.rows as AiMessageRow[])
      : [];
  const rows = [...rawRows].reverse();
  const metaCursor = result.meta?.cursor;
  return {
    rows,
    hasMore: rowContainer?.hasMore === true || result.meta?.hasMore === true,
    cursor: rowContainer?.cursor ?? (typeof metaCursor === 'string' ? metaCursor : null),
  };
}

/** 中止正在生成的回复（用户主动动作；严格验证模式会拦截）。 */
export async function abortConversation(sessionId: string): Promise<void> {
  await api.resourceAction('aiConversations', 'abort', { values: { sessionId } });
}

/* ------------------------------- AI-04 上下文数据源 ------------------------------- */

export async function listContextDatasources(params?: ListParams): Promise<Paged<AiContextDatasourceRow>> {
  return paged<AiContextDatasourceRow>(
    await api.resourceAction<AiContextDatasourceRow[]>('aiContextDatasources', 'list', { params }),
  );
}

export async function getContextDatasource(id: string): Promise<AiContextDatasourceRow | null> {
  const result = await api.resourceAction<AiContextDatasourceRow>('aiContextDatasources', 'get', {
    params: { filterByTk: id },
  });
  return (result.data ?? null) as AiContextDatasourceRow | null;
}

export async function createContextDatasource(values: Record<string, unknown>) {
  const result = await api.resourceAction<AiContextDatasourceRow>('aiContextDatasources', 'create', { values });
  return (result.data ?? null) as AiContextDatasourceRow | null;
}

export async function updateContextDatasource(id: string, values: Record<string, unknown>) {
  const result = await api.resourceAction<AiContextDatasourceRow>('aiContextDatasources', 'update', {
    values,
    params: { filterByTk: id },
  });
  return (result.data ?? null) as AiContextDatasourceRow | null;
}

export async function destroyContextDatasource(id: string): Promise<void> {
  await api.resourceAction('aiContextDatasources', 'destroy', { params: { filterByTk: id } });
}

export interface ContextPreviewCell {
  name: string;
  type: string;
  value: unknown;
}

export interface ContextPreviewResult {
  rows: ContextPreviewCell[][];
  total: number;
  options: Record<string, unknown> | null;
}

/**
 * 受权限约束的上下文预览（`aiContextDatasources:preview`）。
 *
 * **必须是 POST + `values`**：服务端该动作读的是 `ctx.action.params.values`
 * （`server/resource/aiContextDatasources.ts:17-23` → `ctx.action.params.values`），
 * 而 resourcer 对 `/api/<resource>:<action>` 只在请求体里填 `values`
 * （`core/resourcer/src/resourcer.ts:404-406`：GET 时 `values = {}`）。历史上的 GET 调用
 * 在服务端会拿到空 options → 静默返回空预览，看起来"没有记录"，实际是方法错了。
 *
 * `values.filter` 必须是**存储形态**的结构化筛选（`{logic, items}`）：
 * 服务端先 `transformFilter(options.filter)`（`server/manager/ai-context-datasource-manager.ts:99-101`）。
 *
 * 返回值形状来自固定 2.2.20 服务端的 `AIContextDatasourceManager.innerQuery()`：
 * `{ options, total, records: 单元格行 {name,type,value}[][] }`；`total` 是筛选命中的**总条数**
 * （不是本次返回的条数）。本机 13000 只读核对（`POST aiContextDatasources:preview`）实测同样是
 * `{options,total,records}`，且 `records[0]` 是 `{name,type,value}` 数组。
 *
 * 历史坑：43/44 曾把这里改成只读 `rows`/`count`，那只是**本机合成夹具的假外壳**
 * （`main-browser-chat-server.mjs` 当时返回记录对象数组）；真实 2.2.20 没有 `rows`/`count`，
 * 于是真实目标上预览会读成 0 行。这里按真实契约读取，不做第二种形状的兜底分支。
 */
export async function previewContextDatasource(values: Record<string, unknown>): Promise<ContextPreviewResult> {
  const result = await api.resourceAction<Record<string, unknown>>('aiContextDatasources', 'preview', { values });
  const data = (result.data ?? {}) as Record<string, unknown>;
  return {
    rows: Array.isArray(data.records) ? (data.records as ContextPreviewCell[][]) : [],
    total: typeof data.total === 'number' ? data.total : 0,
    options:
      data.options && typeof data.options === 'object' && !Array.isArray(data.options)
        ? (data.options as Record<string, unknown>)
        : null,
  };
}

/* ------------------------------- AI-05 MCP ------------------------------- */

export async function listMcpClients(params?: ListParams): Promise<Paged<AiMcpClientRow>> {
  return paged<AiMcpClientRow>(await api.resourceAction<AiMcpClientRow[]>('aiMcpClients', 'list', { params }));
}

export async function getMcpClient(name: string): Promise<AiMcpClientRow | null> {
  const result = await api.resourceAction<AiMcpClientRow>('aiMcpClients', 'get', {
    params: { filterByTk: name },
  });
  return (result.data ?? null) as AiMcpClientRow | null;
}

export async function createMcpClient(values: Record<string, unknown>) {
  const result = await api.resourceAction<AiMcpClientRow>('aiMcpClients', 'create', { values });
  return (result.data ?? null) as AiMcpClientRow | null;
}

export async function updateMcpClient(name: string, values: Record<string, unknown>) {
  const result = await api.resourceAction<AiMcpClientRow>('aiMcpClients', 'update', {
    values,
    params: { filterByTk: name },
  });
  return (result.data ?? null) as AiMcpClientRow | null;
}

export async function destroyMcpClient(name: string): Promise<void> {
  await api.resourceAction('aiMcpClients', 'destroy', { params: { filterByTk: name } });
}

/** 连接测试：会外呼外部 MCP 服务，只允许真实用户主动触发；严格验证模式一律拦截。 */
export async function testMcpConnection(values: Record<string, unknown>): Promise<McpTestResult> {
  const result = await api.resourceAction<McpTestResult>('aiMcpClients', 'testConnection', { values });
  return (result.data ?? {}) as McpTestResult;
}

/** 列出共享 + 按用户 MCP 工具；同样会外呼。 */
export async function listMcpTools(): Promise<Record<string, McpToolEntry[]>> {
  const result = await api.resourceAction<Record<string, McpToolEntry[]>>('aiMcpClients', 'listTools');
  return (result.data ?? {}) as Record<string, McpToolEntry[]>;
}

export async function rebuildMcpClient(): Promise<void> {
  await api.resourceAction('aiMcpClients', 'rebuildClient');
}

export async function updateMcpToolPermission(toolName: string, permission: 'ASK' | 'ALLOW'): Promise<void> {
  await api.resourceAction('aiMcpClients', 'updateToolPermission', { values: { toolName, permission } });
}

/* ------------------------------- AI-03 模型选择（按员工允许集过滤） ------------------------------- */

export interface AllowedModelEntry {
  llmService: string;
  model: string;
}

/**
 * 从员工记录的 `modelSettings` 解析"专用模型允许集"。
 *
 * 与原生 `aiEmployeesManager.resolveModel` 同一份字段语义（报告十页契约 D2）：
 *  - `enabled !== true` → 没有员工级限制，由全局回退决定；
 *  - `models[]` 优先，`models` 为空时回退到单个 `llmService` + `model`；
 *  - 允许集为空 → 原生在发送时抛 `AI employee model not configured`，界面必须提前提示，
 *    而不是让用户提交后才失败。
 */
export function resolveAllowedModels(employee: Pick<AiEmployeeRow, 'modelSettings'> | null | undefined): {
  enforced: boolean;
  models: AllowedModelEntry[];
  preferred: AllowedModelEntry | null;
} {
  const settings = employee?.modelSettings ?? undefined;
  const enforced = settings?.enabled === true;
  const fromList = Array.isArray(settings?.models)
    ? settings!.models!.filter(
        (item): item is AllowedModelEntry =>
          !!item && typeof item.llmService === 'string' && item.llmService.length > 0 &&
          typeof item.model === 'string' && item.model.length > 0,
      )
    : [];
  const models =
    fromList.length > 0
      ? fromList
      : typeof settings?.llmService === 'string' &&
          settings.llmService.length > 0 &&
          typeof settings?.model === 'string' &&
          settings.model.length > 0
        ? [{ llmService: settings.llmService, model: settings.model }]
        : [];
  return { enforced, models, preferred: models[0] ?? null };
}
