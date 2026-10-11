import type { CrewloomError } from './errors';

/** 后端统一响应封套：{ data, meta }（证据：core/server/src/middlewares/data-wrapping.ts） */
export interface ApiEnvelope<T> {
  data: T;
  meta?: Record<string, unknown>;
}

export interface ApiListMeta extends Record<string, unknown> {
  count?: number;
  page?: number;
  pageSize?: number;
  totalPage?: number;
  hasNext?: boolean;
}

export interface ApiResult<T> {
  data: T;
  meta?: ApiListMeta;
}

/** 列表请求的查询参数；`filter` 会被序列化为 JSON 字符串（与 SDK 行为一致）。 */
export interface ListParams {
  filter?: Record<string, unknown> | string;
  page?: number;
  pageSize?: number;
  sort?: string | string[];
  fields?: string[];
  appends?: string[];
  filterByTk?: string | number;
  [key: string]: unknown;
}

export interface RequestOptions {
  /**
   * 覆盖数据源上下文，缺省 main。
   *
   * 注意：**没有** role 选项。当前生效角色由 SDK 的 `Auth`（X-Role + 角色 Cookie）统一注入，
   * 逐请求覆盖会被 SDK 中间件无条件覆盖，因此角色只通过 `setAuthContext`/`switchRole` 改变。
   */
  dataSource?: string;
  /** 透传额外的请求头（如 X-Authenticator）。 */
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /**
   * 401 是否广播"会话失效"。
   *
   * 缺省 true（正常业务请求的 401 就是会话/角色失效）。对"401 表示输入不正确"的动作
   * （例如 `auth:changePassword` 用旧密码校验本人）必须显式传 false，
   * 否则用户输错旧密码会被当成会话失效而登出。
   */
  broadcast?: boolean;
}

export type ApiFailure = CrewloomError;
