/** Node 侧传输层策略的 TypeScript 声明（实现见 transport-policy.mjs）。 */

export type PolicyMode = 'product' | 'strict';

export interface TransportPolicyFile {
  version: number;
  description: string;
  apiPathPrefix: string;
  backendOrigin: string;
  modes: Record<PolicyMode, { summary: string; allowAnyApiAction: boolean }>;
  readActions: string[];
  writeActions: string[];
  strictDenyActions: string[];
  strictDenyActionPatterns: string[];
  productActions: string[];
  notes: string[];
}

export interface TransportLogEntry {
  at: string;
  method: string;
  path: string;
  action: string | null;
  decision: 'allowed' | 'blocked';
  reason?: string;
  status: number | null;
  mode: 'real' | 'mock';
  policyMode: PolicyMode;
}

export const POLICY_PATH: string;
export const ACTIONS_DIR: string;
export const POLICY: TransportPolicyFile;
/** 仓库声明的产品默认后端（本轮目标实例）。 */
export const PRODUCT_DEFAULT_ORIGIN: string;
/** 实际使用的后端（可用 CREWLOOM_BACKEND_ORIGIN 覆盖）。 */
export const BACKEND_ORIGIN: string;

export function isStrictDeniedAction(action: string | null): boolean;
export function getRequestLog(): TransportLogEntry[];
export function resetRequestLog(): void;
export function getRequestCounts(): {
  total: number;
  allowed: number;
  blocked: number;
  real: number;
  mocked: number;
};
export function parseAction(pathname: string): { resource: string; action: string; key: string } | null;
export function classifyRequest(input: {
  method: string;
  url: string;
  mode?: 'real' | 'mock';
  policyMode?: PolicyMode;
  allowedOrigins?: string[];
}): {
  decision: 'allowed' | 'blocked';
  reason?: string;
  path: string;
  method: string;
  action: string | null;
  mode: 'real' | 'mock';
  policyMode: PolicyMode;
};
export class TransportBlockedError extends Error {
  code: string;
  decision: unknown;
}
export function guardedFetch(
  pathOrUrl: string,
  options?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    mode?: 'real' | 'mock';
    policyMode?: PolicyMode;
    /** 目标来源覆盖（默认 BACKEND_ORIGIN）。 */
    baseOrigin?: string;
    allowedOrigins?: string[];
  },
): Promise<Response>;
export function assertNoBlockedRequests(): void;
