import { APIClient } from '@nocobase/sdk';
import type { AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import axios from 'axios';
import {
  CrewloomError,
  classifyHttpResponse,
  classifyNetworkError,
  extractServerCode,
  userFacingHttpMessage,
} from './errors';
import { isReadAction, resolveApiBase } from './url';
import { CrewloomSessionStorage, clearStoredSession } from '../auth/storage';
import { installTransportGuard, resolveTransportMode, type GuardHandle, type TransportMode } from './transportGuard';
import { installAgentReadGuard } from './agentReadGuard';
import type { ApiEnvelope, ApiResult, ListParams, RequestOptions } from './types';

/**
 * 请求层：HTTP、方法选择、参数与响应序列化全部交给 `@nocobase/sdk` 的 `APIClient`。
 *
 * 本文件只保留 SDK 不覆盖、由原生 `@nocobase/plugin-auth` 与 `@nocobase/client`
 * 承担的最小适配：
 *  - 成功与错误响应上的 `x-new-token` 续期（原生 plugin-auth interceptors.ts）；
 *  - 401 的角色失效（`ROLE_NOT_FOUND_ERR` / `ROLE_NOT_FOUND_FOR_USER`）与会话失效
 *    （`AuthErrorCode`）分开处理（原生 core/client APIClient.ts:139-149 + plugin-auth）；
 *  - 旧会话世代的响应不得污染新会话（本项目新增，原生未见显式实现）；
 *  - 传输层允许清单：只有已知只读 GET 与正常登录/退出能真正发出。
 *
 * 会话令牌、角色与认证方式由 SDK 通过 `CrewloomSessionStorage` 持久化到
 * `crewloom.session.*`，不再由本模块自行维护第二套存储。
 */

export interface AuthContext {
  token: string | null;
  role: string | null;
  /** X-Authenticator 值（来自 authenticators:publicList），未设置时不发送该头。 */
  authenticator?: string | null;
}

let apiBase = resolveApiBase();

/**
 * 传输策略模式。
 *
 * `product`（缺省）：真实用户使用，动作交给后端认证与 ACL 判定；
 * `strict`：Agent 自动验证，默认拒绝并硬拦有外部副作用的动作。
 *
 * 浏览器端策略**不是安全边界**（后端 ACL 才是），它用于产品可用性与验证期收紧。
 * `setTransportMode` 只供验证装配与测试切换，生产构建里是空操作，避免运行时被改成绕过状态。
 * 注意：本变量必须在 `installTransportGuard` 首次调用之前初始化。
 */
let transportMode: TransportMode = resolveTransportMode(import.meta.env.VITE_TRANSPORT_MODE);

function createSdk(base: string): APIClient {
  const client = new APIClient({
    baseURL: base,
    storageClass: CrewloomSessionStorage,
  });
  // 请求发出时记下"会话世代 + 该请求将使用的角色上下文"，供响应回来时判定副作用是否仍适用。
  // 该拦截器先于 SDK 的 Auth 中间件执行，读到的 role 就是 Auth 中间件即将写入 X-Role 的值。
  client.axios.interceptors.request.use((config) => {
    const stamped = config as unknown as {
      __crewloomEpoch?: number;
      __crewloomRole?: string | null;
    };
    stamped.__crewloomEpoch = sessionEpoch;
    stamped.__crewloomRole = normalize(client.auth.role);
    return config;
  });
  /**
   * 把 HTTP 错误消息换成**面向用户的中文**。
   *
   * 原生 client-v2 组件（工作流 `TestRunButton` / `NodeConfigDrawer`、表单抽屉等）直接读
   * axios 的 `error.message`，不走本项目的 `toCrewloomError`；实测权限/服务端错误会显示
   * `Request failed with status code 403` 这类原始英文。这里在响应层统一改写 `message`
   * （原始细节保留在 `__crewloomDetail`，只进日志/验收记录，不进界面）。
   */
  client.axios.interceptors.response.use(undefined, (error: unknown) => {
    if (axios.isAxiosError(error) && error.response) {
      const mapped = userFacingHttpMessage(error.response.status, error.response.data);
      if (mapped) {
        const carrier = error as unknown as { __crewloomDetail?: string; __crewloomCode?: string };
        carrier.__crewloomDetail = mapped.detail;
        carrier.__crewloomCode = mapped.code;
        error.message = mapped.userMessage;
      }
    }
    return Promise.reject(error);
  });
  return client;
}

let sdk = createSdk(apiBase);
let guard: GuardHandle = installClientGuards(sdk);

/**
 * 传输策略与 Agent 只读守卫的安装顺序是**语义要求**，不是风格：
 * axios 的请求拦截器后注册者先运行，因此 `installAgentReadGuard` 必须在
 * `installTransportGuard` 之后注册，才能在策略判定之前把原生 ChatBox 的
 * `getMessages`（POST + updateRead=true）改写成只读 GET + updateRead=false。
 */
function installClientGuards(client: APIClient): GuardHandle {
  const handle = installTransportGuard(client.axios, guardOptions());
  installAgentReadGuard(client.axios, { controlled: import.meta.env.VITE_CONTROLLED_AI === '1' });
  return handle;
}

function guardOptions() {
  return {
    baseURL: apiBase,
    originBase: typeof window !== 'undefined' ? window.location.origin : '',
    // 缺省 product：真实用户必须能保存。自动真实验证通过 VITE_TRANSPORT_MODE=strict 显式收紧。
    mode: transportMode,
    // 本机受控 AI 后端（CREWLOOM_CONTROLLED_AI=1）已挂载时，只放行 controlledActions。
    controlled: import.meta.env.VITE_CONTROLLED_AI === '1',
    // 本机受控工作流后端（CREWLOOM_CONTROLLED_WORKFLOW=1）已挂载时，只放行 controlledWorkflowActions；
    // 服务端守卫不传该开关，非受控 id 的写请求仍被 403 拦下。
    controlledWorkflow: import.meta.env.VITE_CONTROLLED_WORKFLOW === '1',
  };
}

export function getTransportMode(): TransportMode {
  return transportMode;
}

export function setTransportMode(mode: TransportMode): void {
  if (import.meta.env.PROD) return;
  if (mode === transportMode) return;
  transportMode = mode;
  guard = installClientGuards(sdk);
}

/**
 * 会话世代（session epoch）。
 *
 * 每次令牌身份发生变化（登录、退出、会话失效）都会自增。请求在发出时记录当时的世代，
 * 响应回来时若世代已变化，则**不**采纳该响应携带的副作用：
 *  - `x-new-token` 续期令牌不会覆盖新会话的令牌；
 *  - 401 不会把已经重新登录的新会话清掉；
 *  - 角色失效的恢复不会改写到新账号上。
 */
let sessionEpoch = 0;

export function getSessionEpoch(): number {
  return sessionEpoch;
}

type NewTokenListener = (token: string) => void;
type SessionExpiredListener = (error: CrewloomError) => void;
type RoleInvalidListener = (error: CrewloomError) => void;

const newTokenListeners = new Set<NewTokenListener>();
const sessionExpiredListeners = new Set<SessionExpiredListener>();
const roleInvalidListeners = new Set<RoleInvalidListener>();

function normalize(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** 当前身份以 SDK 内部状态为准（便于验证"下一请求实际携带的身份头"）。 */
export function getAuthContext(): AuthContext {
  return {
    token: normalize(sdk.auth.token),
    role: normalize(sdk.auth.role),
    authenticator: normalize(sdk.auth.authenticator),
  };
}

export function setAuthContext(next: Partial<AuthContext>): void {
  const before = getAuthContext();
  if ('token' in next) {
    const token = normalize(next.token);
    if (token !== before.token) sdk.auth.setToken(token as string);
  }
  if ('role' in next) {
    const role = normalize(next.role);
    if (role !== before.role) sdk.auth.setRole(role as string);
  }
  if ('authenticator' in next) {
    const authenticator = normalize(next.authenticator);
    if (authenticator !== before.authenticator) sdk.auth.setAuthenticator(authenticator as string);
  }
  const after = getAuthContext();
  // 令牌身份变化即进入新的会话世代；角色切换（令牌不变）不影响续期生效。
  if (after.token !== before.token) sessionEpoch += 1;
}

export function resetAuthContext(): void {
  sdk.auth.setToken(null as unknown as string);
  sdk.auth.setRole(null as unknown as string);
  sdk.auth.setAuthenticator(null as unknown as string);
  clearStoredSession();
}

export function setApiBase(base: string): void {
  const resolved = resolveApiBase(base);
  if (resolved === apiBase) return;
  apiBase = resolved;
  sdk = createSdk(apiBase);
  guard = installClientGuards(sdk);
}

export function getApiBase(): string {
  return apiBase;
}

/** 供测试与验收脚本在真实传输层注入 adapter/断言请求；业务代码不直接使用。 */
export function getHttpClient(): AxiosInstance {
  return sdk.axios;
}

export function getTransportCounts() {
  return guard.counts();
}

/** 响应头 `x-new-token`：服务端在校验通过后下发续期令牌（成功与错误响应都可能带）。 */
export function onNewToken(listener: NewTokenListener): () => void {
  newTokenListeners.add(listener);
  return () => newTokenListeners.delete(listener);
}

/** 真正的会话失效（AuthErrorCode）。 */
export function onSessionExpired(listener: SessionExpiredListener): () => void {
  sessionExpiredListeners.add(listener);
  return () => sessionExpiredListeners.delete(listener);
}

/** 角色失效（ROLE_NOT_FOUND_*）：保留会话，清角色后重新读本人角色与权限。 */
export function onRoleInvalid(listener: RoleInvalidListener): () => void {
  roleInvalidListeners.add(listener);
  return () => roleInvalidListeners.delete(listener);
}

function notifyNewToken(token: string): void {
  sdk.auth.setToken(token);
  for (const listener of newTokenListeners) {
    try {
      listener(token);
    } catch {
      /* 监听器异常不影响请求本身 */
    }
  }
}

function notifySessionExpired(error: CrewloomError): void {
  for (const listener of sessionExpiredListeners) {
    try {
      listener(error);
    } catch {
      /* 监听器异常不影响请求本身 */
    }
  }
}

function notifyRoleInvalid(error: CrewloomError): void {
  for (const listener of roleInvalidListeners) {
    try {
      listener(error);
    } catch {
      /* 监听器异常不影响请求本身 */
    }
  }
}

export function serializeFilter(filter: Record<string, unknown> | string | undefined): string | undefined {
  if (!filter) return undefined;
  return typeof filter === 'string' ? filter : JSON.stringify(filter);
}

function buildParams(params: ListParams | undefined): Record<string, unknown> | undefined {
  if (!params) return undefined;
  const { filter, ...rest } = params;
  const out: Record<string, unknown> = { ...rest };
  const serialized = serializeFilter(filter);
  if (serialized !== undefined) out.filter = serialized;
  return out;
}

/**
 * 附加头：数据源上下文（X-Data-Source）由本项目补上（SDK 只加 locale/role/authenticator/Bearer）。
 * X-Role / X-Authenticator / Authorization 一律由 SDK 的 Auth 中间件注入，避免出现两套身份来源。
 */
function buildHeaders(options: RequestOptions | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Data-Source': options?.dataSource ?? 'main',
  };
  if (options?.headers) Object.assign(headers, options.headers);
  return headers;
}

function unwrap<T>(body: ApiEnvelope<T> | undefined): ApiResult<T> {
  if (body && typeof body === 'object' && 'data' in body) {
    const envelope = body as ApiEnvelope<T>;
    return { data: envelope.data, meta: envelope.meta };
  }
  // 少数流式/文件响应不做封套；此处保持原样，不做猜测性包装。
  return { data: body as unknown as T };
}

function readNewToken(headers: Record<string, unknown> | undefined): string | undefined {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((name) => name.toLowerCase() === 'x-new-token');
  const value = key ? headers[key] : undefined;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** 会话/角色副作用是否仍属于当前会话世代。 */
function isSameEpoch(config: InternalAxiosRequestConfig | undefined, epochAtSend: number): boolean {
  const stamped = (config as unknown as { __crewloomEpoch?: number } | undefined)?.__crewloomEpoch;
  if (typeof stamped !== 'number') return epochAtSend === sessionEpoch;
  return stamped === sessionEpoch;
}

/**
 * 角色失效广播是否仍适用于**当前**角色上下文。
 *
 * 令牌不变时（同一账号切换角色）会话世代不会变，因此世代判定不足以拦住
 * "旧角色的 401 晚到"。这里比较请求发出时的角色上下文与当前角色：
 *  - 相同（含都为"未显式选择"）→ 属于当前角色，按原语义恢复；
 *  - 不同 → 该 401 来自已被替换的角色上下文，**只把错误抛给调用方，不广播角色失效**，
 *    以免清掉用户已经切到的合法角色、或把权限改回服务端默认角色。
 *
 * 只作用于角色失效这一条广播；`x-new-token` 续期与会话失效（401 AuthErrorCode）仍按会话世代处理，
 * 因此不会阻断同账号正常续期，也不会漏掉当前角色/会话的真正失效。
 */
function isSameRoleContext(config: InternalAxiosRequestConfig | undefined): boolean {
  const stamped = (config as unknown as { __crewloomRole?: string | null } | undefined)?.__crewloomRole;
  const current = normalize(sdk.auth.role);
  // 未打戳（理论上不会发生）时保守处理：只在当前没有显式角色时按旧行为广播。
  if (stamped === undefined) return current === null;
  return (stamped ?? null) === current;
}

function applyNewToken(headers: Record<string, unknown> | undefined, config: InternalAxiosRequestConfig | undefined, epochAtSend: number): void {
  const token = readNewToken(headers);
  if (!token) return;
  // 只有同一会话世代的响应才允许续期，避免旧会话的响应改写新会话令牌。
  if (!isSameEpoch(config, epochAtSend)) return;
  notifyNewToken(token);
}

async function dispatch<T>(
  config: Record<string, unknown>,
  epochAtSend: number,
  broadcast = true,
): Promise<ApiResult<T>> {
  try {
    const response = await sdk.request(config as never);
    applyNewToken(response.headers as Record<string, unknown>, response.config as InternalAxiosRequestConfig, epochAtSend);
    return unwrap<T>(response.data as ApiEnvelope<T>);
  } catch (error) {
    throw toCrewloomError(error, epochAtSend, { broadcast });
  }
}

/**
 * 把 axios/传输层错误映射为 CrewloomError，并按会话世代广播副作用。
 *
 * `broadcast: false` 用于登录/退出等"401 不代表会话失效"的场景（例如密码错误），
 * 只做错误分类，不触发全局会话清理。
 */
export function toCrewloomError(
  error: unknown,
  epochAtSend: number = sessionEpoch,
  options: { broadcast?: boolean } = {},
): CrewloomError {
  const broadcast = options.broadcast !== false;
  if (error instanceof CrewloomError) return error;
  if (axios.isAxiosError(error)) {
    const axiosError = error;
    const response = axiosError.response;
    const config = response?.config as InternalAxiosRequestConfig | undefined;
    if (response) {
      // 错误响应上的 x-new-token 也要读取（原生 plugin-auth errHandler 同样处理）。
      applyNewToken(response.headers as Record<string, unknown>, config, epochAtSend);
      const classified = classifyHttpResponse({
        status: response.status,
        data: response.data,
        headers: response.headers as Record<string, string>,
      });
      if (classified) {
        // 旧会话世代的 401 不能清掉已经建立的新会话，也不能改写新账号的角色。
        if (broadcast && isSameEpoch(config, epochAtSend)) {
          if (classified.kind === 'role-invalid') {
            // 只有仍属于当前角色上下文的角色错误才广播；旧角色的晚到 401 由调用方自行处理。
            if (isSameRoleContext(config)) notifyRoleInvalid(classified);
          } else if (classified.kind === 'unauthenticated') {
            notifySessionExpired(classified);
          }
        }
        return classified;
      }
    }
    // 没有响应即视为连接层问题（无法连接、超时、请求被中断）。
    const code = extractServerCode((axiosError.response?.data as unknown) ?? undefined);
    return classifyNetworkError(
      `${axiosError.code ?? 'REQUEST_FAILED'}${code ? ` / ${code}` : ''} ${axiosError.message}`,
    );
  }
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String((error as { code?: unknown }).code ?? 'REQUEST_FAILED');
    if (code === 'TRANSPORT_BLOCKED') {
      return new CrewloomError({
        kind: 'unexpected',
        userMessage: '操作未能完成，请重试；如持续出现，请联系管理员。',
        detail: error instanceof Error ? error.message : code,
      });
    }
    return classifyNetworkError(`${code} ${error instanceof Error ? error.message : ''}`.trim());
  }
  return new CrewloomError({
    kind: 'unexpected',
    userMessage: '操作未能完成，请重试；如持续出现，请联管理员。',
    detail: error instanceof Error ? error.message : String(error),
  });
}

/**
 * 资源动作。
 *
 * 方法由本层按只读语义显式指定为 GET（动作名可能是 SDK 默认 POST 的 `check`/
 * `listMine`/`listByUser` 等），其余动作由 SDK 走 POST；序列化与 body 包装由 SDK 负责。
 */
export async function resourceAction<T>(
  resource: string,
  action: string,
  payload?: { values?: unknown; params?: ListParams },
  options?: RequestOptions,
): Promise<ApiResult<T>> {
  const epochAtSend = sessionEpoch;
  const read = isReadAction(action);
  const params: Record<string, unknown> = { ...(buildParams(payload?.params) ?? {}) };
  if (!read) params.values = payload?.values ?? {};
  const response = await sdk
    .resource(resource, undefined, buildHeaders(options) as never)
    [action](params, {
      method: read ? 'get' : 'post',
      signal: options?.signal,
    } as never)
    .catch((error: unknown) => {
      throw toCrewloomError(error, epochAtSend, { broadcast: options?.broadcast });
    });
  applyNewToken(response.headers as Record<string, unknown>, response.config as InternalAxiosRequestConfig, epochAtSend);
  return unwrap<T>(response.data as ApiEnvelope<T>);
}

export async function resourceList<T>(resource: string, params?: ListParams, options?: RequestOptions) {
  return resourceAction<T[]>(resource, 'list', { params }, options);
}

export async function resourceGet<T>(
  resource: string,
  filterByTk: string | number,
  params?: ListParams,
  options?: RequestOptions,
) {
  return resourceAction<T>(resource, 'get', { params: { ...params, filterByTk } }, options);
}

/**
 * 关联资源动作：真实路径是 `/api/<parent>/<id>/<child>:<action>`
 * （SDK 的资源名写法为 `<parent>.<child>`，of 为父记录主键）。
 */
export async function associatedAction<T>(
  parent: string,
  parentId: string | number,
  child: string,
  action: string,
  payload?: { values?: unknown; params?: ListParams },
  options?: RequestOptions,
): Promise<ApiResult<T>> {
  const epochAtSend = sessionEpoch;
  const read = isReadAction(action);
  const params: Record<string, unknown> = { ...(buildParams(payload?.params) ?? {}) };
  if (!read) params.values = payload?.values ?? {};
  const response = await sdk
    .resource(`${parent}.${child}`, parentId, buildHeaders(options) as never)
    [action](params, {
      method: read ? 'get' : 'post',
      signal: options?.signal,
    } as never)
    .catch((error: unknown) => {
      throw toCrewloomError(error, epochAtSend);
    });
  applyNewToken(response.headers as Record<string, unknown>, response.config as InternalAxiosRequestConfig, epochAtSend);
  return unwrap<T>(response.data as ApiEnvelope<T>);
}

/**
 * 直接请求：交给 SDK 的 axios 实例发出（SDK 负责方法、序列化与 Auth 头）。
 *
 * `broadcast: false` 用于登录/退出这类"401 不代表当前会话失效"的调用，
 * 只做错误分类，不触发全局会话/角色副作用。
 */
export async function request<T>(
  config: Record<string, unknown>,
  options: { broadcast?: boolean } = {},
): Promise<ApiResult<T>> {
  return dispatch<T>(config, sessionEpoch, options.broadcast !== false);
}

export const api = {
  get apiBase() {
    return apiBase;
  },
  get sdk() {
    return sdk;
  },
  request,
  resourceAction,
  resourceList,
  resourceGet,
  associatedAction,
};

export { sdk };
