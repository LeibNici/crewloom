/**
 * 传输层执行点（浏览器）。
 *
 * 策略本身在 `src/api/policy.ts`（与 Vite 中间件、Node 验证脚本同源）；本文件只负责
 * 在 axios 上把策略变成**请求发出前**的拦截，并记录可审计的日志。
 *
 * 两种模式（见 policy.ts）：
 *  - `product`：正常用户使用。只固定目的地与 `/api` 前缀，动作由后端认证与 ACL 判定，
 *    真实用户可以保存；
 *  - `strict`：Agent 自动验证。默认拒绝，且硬拦模型发现/推理、MCP 调用、工作流自测等
 *    有外部副作用的动作——**不靠"是不是 GET"来猜有没有副作用**。
 *
 * 记录只包含 method / path / action / decision / status / mode，不记录凭据、请求头或响应正文。
 */
import type { AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import {
  decideApiRequest,
  parseApiAction,
  TRANSPORT_POLICY,
  type PolicyDecision,
  type TransportMode,
} from './policy';

export { TRANSPORT_POLICY, resolveTransportMode } from './policy';
export type { TransportPolicy, TransportMode } from './policy';

export type TransportDecision = 'allowed' | 'blocked';
export type TransportLogMode = 'real' | 'mock';

export interface TransportLogEntry {
  at: string;
  method: string;
  /** 只有路径与动作，不含查询串与请求体。 */
  path: string;
  action: string | null;
  decision: TransportDecision;
  reason?: string;
  /** 响应状态码；被拦截时为 null。 */
  status: number | null;
  mode: TransportLogMode;
}

const LOG_LIMIT = 500;
const log: TransportLogEntry[] = [];

export function getTransportLog(): TransportLogEntry[] {
  return log.slice();
}

export function clearTransportLog(): void {
  log.length = 0;
}

function record(entry: TransportLogEntry): void {
  log.push(entry);
  if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT);
  exposeToWindow();
}

/** 把日志与计数挂到 window，供浏览器验收脚本回读（不含任何凭据）。 */
function exposeToWindow(): void {
  if (typeof window === 'undefined') return;
  const target = window as unknown as Record<string, unknown>;
  const blocked = log.filter((item) => item.decision === 'blocked').length;
  target.__CREWLOOM_TRANSPORT__ = {
    policy: {
      version: TRANSPORT_POLICY.version,
      apiPathPrefix: TRANSPORT_POLICY.apiPathPrefix,
      backendOrigin: TRANSPORT_POLICY.backendOrigin,
      readActions: TRANSPORT_POLICY.readActions,
      writeActions: TRANSPORT_POLICY.writeActions,
    },
    mode: currentMode(),
    entries: log.slice(),
    counts: {
      total: log.length,
      allowed: log.length - blocked,
      blocked,
      real: log.filter((item) => item.mode === 'real').length,
      mock: log.filter((item) => item.mode === 'mock').length,
    },
  };
}

let activeMode: TransportMode = 'product';

/** 当前生效模式；由 `installTransportGuard` 在安装时确定。 */
export function currentMode(): TransportMode {
  return activeMode;
}

/** 由 `/<resource>:<action>` 或 `/api/<parent>/<id>/<child>:<action>` 解析资源动作。 */
export function parseAction(pathname: string): { resource: string; action: string } | null {
  const parsed = parseApiAction(pathname);
  return parsed ? { resource: parsed.resource, action: parsed.action } : null;
}

/** 合并 baseURL 与相对 url（与 axios combineURLs 行为一致）。 */
export function combineUrl(baseURL: string | undefined, url: string): string {
  if (!url) return baseURL ?? '';
  if (/^https?:\/\//i.test(url)) return url;
  if (!baseURL) return url;
  return `${baseURL.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
}

export interface RequestTarget {
  method: string;
  /** 解析后的绝对地址（浏览器用页面来源补全相对地址）。 */
  url: string;
}

export interface GuardOptions {
  /** 传给 axios 的 baseURL。 */
  baseURL: string;
  /** 浏览器：相对地址的基准来源（通常是 location.origin）。Node：''。 */
  originBase?: string;
  /** 允许的目标来源；缺省只允许同源相对地址。 */
  allowedOrigins?: string[];
  /** 运行模式；缺省 `strict`（安全默认；产品装配显式传 `product`）。 */
  mode?: TransportMode;
  /** 本机受控 AI 后端是否已挂载（`CREWLOOM_CONTROLLED_AI=1`）。 */
  controlled?: boolean;
  /** 本机受控工作流后端是否已挂载（`CREWLOOM_CONTROLLED_WORKFLOW=1`，仅浏览器侧）。 */
  controlledWorkflow?: boolean;
}

export type { PolicyDecision };

function resolveTarget(config: InternalAxiosRequestConfig, options: GuardOptions): RequestTarget {
  const method = (config.method ?? 'get').toLowerCase();
  const rawUrl = config.url ?? '';
  const combined = combineUrl(config.baseURL ?? options.baseURL, rawUrl);
  let absolute = combined;
  if (!/^https?:\/\//i.test(combined)) {
    const base = options.originBase ?? (typeof window !== 'undefined' ? window.location.origin : '');
    absolute = `${base}${combined.startsWith('/') ? '' : '/'}${combined}`;
  }
  return { method, url: absolute };
}

/** 把 axios 的 `params`（对象 / URLSearchParams）规范成普通对象，供策略做只读语义校验。 */
function normalizeQuery(params: unknown): Record<string, unknown> | undefined {
  if (!params) return undefined;
  if (typeof URLSearchParams !== 'undefined' && params instanceof URLSearchParams) {
    const result: Record<string, unknown> = {};
    params.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }
  if (typeof params === 'object' && !Array.isArray(params)) {
    return params as Record<string, unknown>;
  }
  return undefined;
}

/** 纯策略判定：不发送请求，只回答"这条请求是否可以通过"。 */
export function decideRequest(config: InternalAxiosRequestConfig, options: GuardOptions): PolicyDecision {
  const target = resolveTarget(config, options);
  const allowedOrigins =
    options.allowedOrigins && options.allowedOrigins.length > 0
      ? options.allowedOrigins
      : options.originBase
        ? [options.originBase]
        : [];
  return decideApiRequest({
    method: target.method,
    url: target.url,
    mode: options.mode ?? 'strict',
    allowedOrigins,
    controlled: options.controlled,
    controlledWorkflow: options.controlledWorkflow,
    // 只用于只读语义校验（getMessages 的 updateRead、preview 的查询体），不进入日志。
    query: normalizeQuery(config.params),
    body: config.data,
  });
}

export interface GuardHandle {
  getLog: () => TransportLogEntry[];
  counts: () => { total: number; allowed: number; blocked: number; real: number; mock: number };
}

/**
 * 在 axios 实例上安装策略拦截器。
 *
 * 被拦截的请求不会进入 adapter，因此不会产生任何网络流量；错误以
 * CrewloomError（kind='unexpected'）抛出，用户只看到通用中文提示。
 */
export function installTransportGuard(axiosInstance: AxiosInstance, options: GuardOptions): GuardHandle {
  activeMode = options.mode ?? 'strict';
  // 同一实例重复安装时先卸载上一组拦截器，避免拦截器叠加导致重复记录与重复判定。
  const marker = axiosInstance as unknown as {
    __crewloomGuard?: { request: number; response: number };
  };
  if (marker.__crewloomGuard) {
    axiosInstance.interceptors.request.eject(marker.__crewloomGuard.request);
    axiosInstance.interceptors.response.eject(marker.__crewloomGuard.response);
  }
  const requestId = axiosInstance.interceptors.request.use((config) => {
    const decision = decideRequest(config, options);
    const method = (config.method ?? 'get').toLowerCase();
    if (decision.decision === 'blocked') {
      record({
        at: new Date().toISOString(),
        method,
        path: decision.path,
        action: decision.action,
        decision: 'blocked',
        reason: decision.reason,
        status: null,
        mode: 'mock',
      });
      const error = new Error(`transport-blocked: ${method.toUpperCase()} ${decision.path}`);
      (error as unknown as { code: string }).code = 'TRANSPORT_BLOCKED';
      throw error;
    }
    return config;
  });

  const responseId = axiosInstance.interceptors.response.use(
    (response) => {
      const config = response.config as InternalAxiosRequestConfig;
      const decision = decideRequest(config, options);
      record({
        at: new Date().toISOString(),
        method: (config.method ?? 'get').toLowerCase(),
        path: decision.path,
        action: decision.action,
        decision: 'allowed',
        status: response.status,
        mode: readMode(response.headers as Record<string, unknown> | undefined),
      });
      return response;
    },
    (error) => {
      const config = (error?.config ?? {}) as InternalAxiosRequestConfig;
      if (config.url) {
        const decision = decideRequest(config, options);
        record({
          at: new Date().toISOString(),
          method: (config.method ?? 'get').toLowerCase(),
          path: decision.path,
          action: decision.action,
          decision: 'allowed',
          status: error?.response?.status ?? null,
          mode: readMode(error?.response?.headers as Record<string, unknown> | undefined),
        });
      }
      return Promise.reject(error);
    },
  );

  marker.__crewloomGuard = { request: requestId, response: responseId };

  return {
    getLog: getTransportLog,
    counts: () => {
      const blocked = log.filter((item) => item.decision === 'blocked').length;
      return {
        total: log.length,
        allowed: log.length - blocked,
        blocked,
        real: log.filter((item) => item.mode === 'real').length,
        mock: log.filter((item) => item.mode === 'mock').length,
      };
    },
  };
}

/** 受控 mock 响应通过 `x-crewloom-mock: 1` 标记，用于区分真实与受控结果。 */
function readMode(headers: Record<string, unknown> | undefined): TransportLogMode {
  if (!headers) return 'real';
  const key = Object.keys(headers).find((name) => name.toLowerCase() === 'x-crewloom-mock');
  return key && headers[key] ? 'mock' : 'real';
}
