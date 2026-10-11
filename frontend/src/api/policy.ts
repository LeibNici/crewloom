import accessFragment from './actions/access.json';
import aiFragment from './actions/ai.json';
import datasourceFragment from './actions/datasource.json';
import modelFragment from './actions/model.json';
import tasksFragment from './actions/tasks.json';
import workflowFragment from './actions/workflow.json';
import base from './transport-policy.json';

/**
 * 传输层策略（唯一来源）。
 *
 * 结构：
 *  - `transport-policy.json`：公共部分（固定后端、两种模式、基础允许清单、严格模式黑名单）；
 *  - `actions/<module>.json`：各模块自己的只读动作与产品动作，由对应负责组独占维护。
 *
 * 合并是**静态导入**：没有生成步骤、没有运行时扫描目录。一个模块要加只读动作，
 * 只改自己的分片文件即可，不需要和其它两组争同一个文件。
 */

export type TransportMode = 'product' | 'strict';

export interface ActionFragment {
  module: string;
  owner?: string;
  readActions?: string[];
  /** 只读但必须/可以由 POST 发出的动作（分片可声明，见 ai.json 的 preview）。 */
  readPostActions?: string[];
  productActions?: string[];
  notes?: string;
  [key: string]: unknown;
}

export interface TransportPolicy {
  version: number;
  description: string;
  apiPathPrefix: string;
  backendOrigin: string;
  modes: Record<TransportMode, { summary: string; allowAnyApiAction: boolean }>;
  readActions: string[];
  writeActions: string[];
  /** 只读但被原生 SDK 以 POST 发出的动作（严格模式按只读放行 GET/POST）。 */
  readPostActions: string[];
  /** 只在本机受控后端（`CREWLOOM_CONTROLLED_AI=1`）上放行的动作；请求由本机应答，不到真实后端。 */
  controlledActions: string[];
  /** 只在本机受控**工作流**后端（`CREWLOOM_CONTROLLED_WORKFLOW=1`）上放行的动作；见 JSON notes。 */
  controlledWorkflowActions: string[];
  strictDenyActions: string[];
  strictDenyActionPatterns: string[];
  /** 由各分片汇总的产品动作（仅登记；严格模式一律拦截）。 */
  productActions: string[];
  notes: string[];
}

export const ACTION_FRAGMENTS: ActionFragment[] = [
  aiFragment as ActionFragment,
  modelFragment as ActionFragment,
  datasourceFragment as ActionFragment,
  accessFragment as ActionFragment,
  workflowFragment as ActionFragment,
  tasksFragment as ActionFragment,
];

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

const fragmentReadActions = ACTION_FRAGMENTS.flatMap((fragment) => fragment.readActions ?? []);
const fragmentReadPostActions = ACTION_FRAGMENTS.flatMap((fragment) => fragment.readPostActions ?? []);
const fragmentProductActions = ACTION_FRAGMENTS.flatMap((fragment) => fragment.productActions ?? []);

export const TRANSPORT_POLICY: TransportPolicy = {
  ...(base as unknown as TransportPolicy),
  readActions: unique([...base.readActions, ...fragmentReadActions]),
  readPostActions: unique([...(base as unknown as TransportPolicy).readPostActions, ...fragmentReadPostActions]),
  productActions: unique(fragmentProductActions),
};

/** 产品模式的默认后端（本轮目标实例）。 */
export const PRODUCT_BACKEND_ORIGIN = base.backendOrigin;

/**
 * 解析运行模式。缺省是 `product`：产品与开发预览必须能保存真实用户的动作。
 * 自动真实验证显式传入 `strict`（`VITE_TRANSPORT_MODE=strict` /
 * `CREWLOOM_TRANSPORT_MODE=strict`），不会因为忘记设置而误放行外部调用。
 */
export function resolveTransportMode(raw: unknown): TransportMode {
  return raw === 'strict' ? 'strict' : 'product';
}

const denyPatterns = base.strictDenyActionPatterns.map((pattern) => new RegExp(pattern));

/** 严格模式下是否属于"看起来只读但会外呼/触发"的动作。 */
export function isStrictDeniedAction(action: string | null): boolean {
  if (!action) return false;
  if (base.strictDenyActions.includes(action)) return true;
  const name = action.includes(':') ? action.slice(action.indexOf(':') + 1) : action;
  return denyPatterns.some((pattern) => pattern.test(name));
}

/** 由 `/api/<resource>:<action>` 或 `/api/<parent>/<id>/<child>:<action>` 解析资源动作。 */
export function parseApiAction(pathname: string): { resource: string; action: string; key: string } | null {
  const withoutPrefix = pathname.startsWith(TRANSPORT_POLICY.apiPathPrefix)
    ? pathname.slice(TRANSPORT_POLICY.apiPathPrefix.length)
    : pathname;
  const segments = withoutPrefix.split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  if (!last) return null;
  const colon = last.lastIndexOf(':');
  if (colon <= 0) return null;
  const action = last.slice(colon + 1);
  const resource = last.slice(0, colon);
  if (!action || !resource) return null;
  return { resource, action, key: `${resource}:${action}` };
}

export type TransportDecision = 'allowed' | 'blocked';

export interface PolicyDecision {
  decision: TransportDecision;
  reason?: string;
  action: string | null;
  path: string;
}

/**
 * `aiContextDatasources:preview` 的 POST 查询体允许字段。
 *
 * 2.2.20 的真实实现（`server/resource/aiContextDatasources.ts`）把 `ctx.action.params.values`
 * 原样交给 `repository.find`，因此它只能读；这里的白名单进一步保证"发出去的 POST 只是一次查询"：
 * 没有 update/destroy 之类的动作字段，也没有任何路径能让它变成写入。
 */
const PREVIEW_QUERY_FIELDS = new Set([
  'datasource',
  'collectionName',
  'fields',
  'filter',
  'sort',
  'limit',
  'page',
  'pageSize',
  'appends',
  'except',
]);

export interface PreviewQueryBodyCheck {
  ok: boolean;
  reason?: string;
}

/**
 * 校验 `aiContextDatasources:preview` 的请求体确实是一个"查询体"。
 *
 * 通过条件（全部满足）：
 *  1. 请求体是对象（不是数组/字符串），且包含 `datasource` 与 `collectionName` 两个字符串；
 *  2. 所有键都在查询字段白名单里（出现 `update`/`destroy`/`values` 等一律拒绝）；
 *  3. `limit`/`page`/`pageSize` 若是数字则必须是有限正数（防止用极端值触发异常路径）。
 *
 * 这是 strict 模式下唯一放行的只读 POST：其它 POST 仍然默认拒绝。
 */
export function validatePreviewQueryBody(body: unknown): PreviewQueryBodyCheck {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'preview-body-not-object' };
  }
  const values = body as Record<string, unknown>;
  if (typeof values.datasource !== 'string' || values.datasource.length === 0) {
    return { ok: false, reason: 'preview-body-missing-datasource' };
  }
  if (typeof values.collectionName !== 'string' || values.collectionName.length === 0) {
    return { ok: false, reason: 'preview-body-missing-collection' };
  }
  for (const key of Object.keys(values)) {
    if (!PREVIEW_QUERY_FIELDS.has(key)) {
      return { ok: false, reason: `preview-body-unexpected-field:${key}` };
    }
  }
  for (const key of ['limit', 'page', 'pageSize'] as const) {
    const raw = values[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const numeric = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return { ok: false, reason: `preview-body-invalid-${key}` };
    }
  }
  return { ok: true };
}

/** 从查询串或请求体里读 `updateRead`（两种通道任一为真都算写）。 */
function readUpdateReadFlag(query: Record<string, unknown> | undefined, body: unknown): unknown {
  const fromQuery = query?.updateRead;
  if (fromQuery !== undefined && fromQuery !== null && fromQuery !== '') return fromQuery;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const fromBody = (body as Record<string, unknown>).updateRead;
    if (fromBody !== undefined && fromBody !== null && fromBody !== '') return fromBody;
  }
  return fromQuery;
}

export interface DecideInput {
  method: string;
  /** 绝对地址（已解析 origin 与 path，含查询串时会用于 updateRead 判定）。 */
  url: string;
  mode: TransportMode;
  /** 允许的目标来源；缺省不校验来源（服务端中间件场景）。 */
  allowedOrigins?: string[];
  /** 本机受控 AI 后端已挂载：只对 `controlledActions` 额外放行 POST（见 transport-policy.json 说明）。 */
  controlled?: boolean;
  /**
   * 本机受控**工作流**后端已挂载（浏览器侧）。只对 `controlledWorkflowActions` 额外放行 POST；
   * 服务端守卫刻意不传该开关，非受控 id 的写请求仍会被拦（见 transport-policy.json notes）。
   */
  controlledWorkflow?: boolean;
  /** 请求查询参数（用于 updateRead / 动作语义校验；不写入日志）。 */
  query?: Record<string, unknown>;
  /** 请求体（只用于只读语义校验；不写入日志）。 */
  body?: unknown;
}

/**
 * 纯策略判定（浏览器、Vite 中间件、Node 脚本共用）。
 *
 * - `product`：只固定目的地与 `/api` 前缀，动作交给后端认证与 ACL 最终判定 → 真实用户可保存。
 * - `strict`：默认拒绝；只放行已知只读 GET 与登录/退出 POST，并额外硬拦有外部副作用的动作。
 */
export function decideApiRequest(input: DecideInput): PolicyDecision {
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return { decision: 'blocked', reason: 'unresolvable-url', action: null, path: input.url };
  }
  const path = parsed.pathname;
  const parsedAction = parseApiAction(path);
  const key = parsedAction?.key ?? null;
  const method = input.method.toLowerCase();

  const origins = input.allowedOrigins ?? [];
  if (origins.length > 0 && !origins.includes(parsed.origin)) {
    return { decision: 'blocked', reason: 'destination-not-allowed', action: key, path };
  }
  if (!path.startsWith(TRANSPORT_POLICY.apiPathPrefix)) {
    return { decision: 'blocked', reason: 'path-not-api', action: key, path };
  }

  if (input.mode === 'product') {
    // 产品模式：目的地与前缀已确认，动作由后端判定。动作名可解析就记录下来便于审计。
    return { decision: 'allowed', action: key, path };
  }

  // 严格模式
  if (!key) {
    return { decision: 'blocked', reason: 'unparsable-action', action: null, path };
  }
  // 受控动作（本机中间件应答，不触达真实后端）必须排在"外部副作用"硬拦之前：
  // 它们的动作名本来就在 strictDenyActions 里，但请求根本不会离开本机。
  if (input.controlled && TRANSPORT_POLICY.controlledActions.includes(key) && method === 'post') {
    return { decision: 'allowed', reason: 'controlled-local-backend', action: key, path };
  }
  if (
    input.controlledWorkflow &&
    TRANSPORT_POLICY.controlledWorkflowActions.includes(key) &&
    method === 'post'
  ) {
    return { decision: 'allowed', reason: 'controlled-workflow-local-backend', action: key, path };
  }
  if (isStrictDeniedAction(key)) {
    return { decision: 'blocked', reason: 'strict-mode-external-side-effect', action: key, path };
  }
  if (key === 'aiConversations:getMessages') {
    // `updateRead=true` 会在服务端把会话标记为已读（写副作用）。严格模式只放行
    // updateRead 缺省 / 显式 false 的读取；这不是"换个名字的写"。
    // 查询串与请求体都检查，避免"参数放到 body 里绕过"。
    const updateRead = readUpdateReadFlag(input.query, input.body);
    if (updateRead !== undefined && updateRead !== null && updateRead !== '' && updateRead !== false) {
      const normalized = String(updateRead);
      if (normalized !== 'false' && normalized !== '0') {
        return { decision: 'blocked', reason: 'getMessages-updateRead-not-false', action: key, path };
      }
    }
  }
  if (TRANSPORT_POLICY.readPostActions.includes(key)) {
    if (method === 'get') {
      return { decision: 'allowed', action: key, path };
    }
    if (method !== 'post') {
      return { decision: 'blocked', reason: 'read-post-action-must-be-get-or-post', action: key, path };
    }
    // POST 只读动作必须通过查询体校验：动作语义确实是"查询"才放行。
    if (key === 'aiContextDatasources:preview') {
      const check = validatePreviewQueryBody(input.body);
      return check.ok
        ? { decision: 'allowed', reason: 'read-post-query-body', action: key, path }
        : { decision: 'blocked', reason: check.reason ?? 'preview-body-invalid', action: key, path };
    }
    return { decision: 'allowed', action: key, path };
  }
  if (TRANSPORT_POLICY.readActions.includes(key)) {
    return method === 'get'
      ? { decision: 'allowed', action: key, path }
      : { decision: 'blocked', reason: 'read-action-must-be-get', action: key, path };
  }
  if (TRANSPORT_POLICY.writeActions.includes(key)) {
    return method === 'post'
      ? { decision: 'allowed', action: key, path }
      : { decision: 'blocked', reason: 'write-action-must-be-post', action: key, path };
  }
  return { decision: 'blocked', reason: 'action-not-allowlisted', action: key, path };
}
