/** 统一 API 地址解析。 */

export const DEFAULT_API_BASE = '/api';

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * API 基地址只来自非敏感构建变量 `VITE_API_BASE`（缺省 `/api`）。
 * 这里不读取、也不允许把 token 或凭据放进前端变量。
 */
export function resolveApiBase(raw: unknown = import.meta.env.VITE_API_BASE): string {
  if (typeof raw !== 'string') return DEFAULT_API_BASE;
  const value = trimTrailingSlashes(raw.trim());
  if (!value) return DEFAULT_API_BASE;
  return value;
}

/** 把资源动作拼成 `/api/<resource>:<action>`（get/list 用 GET，其余用 POST）。 */
export function resourceActionPath(base: string, resource: string, action: string): string {
  return `${base}/${resource}:${action}`;
}

/**
 * 判定动作是否使用 GET。
 *
 * 真实后端实测这些动作同时接受 GET 与 POST；只读动作统一用 GET，语义更准确
 * （SDK 源码只把 `get`/`list` 归为 GET，见 04-review-resolution.md §C1）。
 *
 * **统一口径（集成收口）**：除下面的基础名单外，把各模块动作分片
 * `src/api/actions/<module>.json` 里声明的 `readActions` 的**动作名**一并纳入。
 * 分片本来就是"该动作是只读"的权威声明（严格验证模式按同一份声明放行 GET），
 * 因此这里不再让各组各写一份 `readAction` 包装，也不需要新增公共 CRUD 框架：
 * 三组原本显式 GET 的调用仍走同一条 SDK 管线（client.ts → sdk.resource），行为一致。
 *
 * 有外部副作用的动作（`ai:listModels`、`ai:listProviderModels`、`ai:testFlight`、
 * `aiMcpClients:testConnection|listTools|rebuildClient`、`flow_nodes:test` …）
 * **不在** `readActions` 里，仍是 POST + 由真实用户主动触发，不会被这里放行。
 */
import { ACTION_FRAGMENTS } from './policy';

const BASE_READ_ACTIONS = [
  'get',
  'list',
  'check',
  'publicList',
  'listAccessible',
  'getAccessible',
  'listMine',
  'listByUser',
  // 只读的应用信息与存储信息：handler 只读内存/配置，没有副作用（见 07 公共页面报告 §PUB-04/§PUB-06）。
  'getInfo',
  'getBasicInfo',
];

function actionName(key: string): string {
  const colon = key.indexOf(':');
  return colon >= 0 ? key.slice(colon + 1) : key;
}

const DECLARED_READ_ACTIONS = ACTION_FRAGMENTS.flatMap((fragment) =>
  (fragment.readActions ?? []).map(actionName),
);

const READ_ACTIONS = new Set([...BASE_READ_ACTIONS, ...DECLARED_READ_ACTIONS]);

/** 供验收脚本核对"哪些动作名被当作只读"。 */
export function listReadActionNames(): string[] {
  return [...READ_ACTIONS].sort();
}

export function isReadAction(action: string): boolean {
  return READ_ACTIONS.has(action);
}
