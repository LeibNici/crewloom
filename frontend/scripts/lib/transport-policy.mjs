#!/usr/bin/env node
/**
 * Node 侧传输层策略与执行点（与浏览器端同源：`src/api/transport-policy.json`
 * + `src/api/actions/*.json`）。
 *
 * 用途：所有真实联调脚本与联调测试都必须通过 `guardedFetch` 发请求，
 * 在**请求发出前**校验 目的地 + 模式 + 方法与动作；未通过的直接抛错并记录，
 * 不会产生任何网络流量。
 *
 * 模式：
 *  - `strict`（本模块缺省）：Agent 自动验证。只放行允许清单内的只读 GET 与登录/退出 POST，
 *    并硬拦有外部副作用的动作（模型发现/推理、MCP 调用、工作流自测…）。
 *    **不靠"是不是 GET"猜有没有副作用。**
 *  - `product`：正常用户使用。只固定目的地与 `/api` 前缀，动作交给后端认证与 ACL 判定。
 *    产品代码与预览走这一档；自动验证脚本必须显式用 `strict`。
 *
 * 记录只包含 method / path / status / 真实或受控 / 允许或拦截，不记录凭据、请求头或响应正文。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const POLICY_PATH = resolve(here, '../../src/api/transport-policy.json');
export const ACTIONS_DIR = resolve(here, '../../src/api/actions');

const base = JSON.parse(readFileSync(POLICY_PATH, 'utf8'));

/** 合并各模块动作分片（readActions 与 readPostActions；productActions 只登记、不参与严格放行）。 */
function loadFragments() {
  const fragments = [];
  for (const name of readdirSync(ACTIONS_DIR).sort()) {
    if (!name.endsWith('.json')) continue;
    fragments.push(JSON.parse(readFileSync(resolve(ACTIONS_DIR, name), 'utf8')));
  }
  return fragments;
}

const fragments = loadFragments();

export const POLICY = {
  ...base,
  readActions: [...new Set([...base.readActions, ...fragments.flatMap((f) => f.readActions ?? [])])],
  readPostActions: [
    ...new Set([...(base.readPostActions ?? []), ...fragments.flatMap((f) => f.readPostActions ?? [])]),
  ],
  productActions: [...new Set(fragments.flatMap((f) => f.productActions ?? []))],
};

/**
 * `aiContextDatasources:preview` 的 POST 查询体白名单（与 `src/api/policy.ts` 的同名集合一致）。
 * 该动作在 2.2.20 的真实契约是 POST + 查询体（服务端读 `ctx.action.params.values`），
 * 语义仍是受 ACL 约束的 `repository.find`；白名单保证"这一次 POST 只是查询"。
 */
export const PREVIEW_QUERY_FIELDS = new Set([
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

/** 校验 preview 的请求体是查询体；返回 { ok, reason }。 */
export function validatePreviewQueryBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'preview-body-not-object' };
  }
  if (typeof body.datasource !== 'string' || body.datasource.length === 0) {
    return { ok: false, reason: 'preview-body-missing-datasource' };
  }
  if (typeof body.collectionName !== 'string' || body.collectionName.length === 0) {
    return { ok: false, reason: 'preview-body-missing-collection' };
  }
  for (const key of Object.keys(body)) {
    if (!PREVIEW_QUERY_FIELDS.has(key)) {
      return { ok: false, reason: `preview-body-unexpected-field:${key}` };
    }
  }
  for (const key of ['limit', 'page', 'pageSize']) {
    const raw = body[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const numeric = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return { ok: false, reason: `preview-body-invalid-${key}` };
    }
  }
  return { ok: true };
}

/** 产品模式的默认后端（仓库里声明的目标实例）。 */
export const PRODUCT_DEFAULT_ORIGIN = base.backendOrigin;

/** 实际使用的后端；可用 CREWLOOM_BACKEND_ORIGIN 覆盖（仅限本轮目标实例）。 */
export const BACKEND_ORIGIN = process.env.CREWLOOM_BACKEND_ORIGIN ?? PRODUCT_DEFAULT_ORIGIN;

const denyPatterns = base.strictDenyActionPatterns.map((pattern) => new RegExp(pattern));

export function isStrictDeniedAction(action) {
  if (!action) return false;
  if (base.strictDenyActions.includes(action)) return true;
  const name = action.includes(':') ? action.slice(action.indexOf(':') + 1) : action;
  return denyPatterns.some((pattern) => pattern.test(name));
}

const log = [];

export function getRequestLog() {
  return log.slice();
}

export function resetRequestLog() {
  log.length = 0;
}

export function getRequestCounts() {
  const blocked = log.filter((entry) => entry.decision === 'blocked').length;
  return {
    total: log.length,
    allowed: log.length - blocked,
    blocked,
    real: log.filter((entry) => entry.mode === 'real').length,
    mocked: log.filter((entry) => entry.mode === 'mock').length,
  };
}

/** 由 `/api/<resource>:<action>` 或 `/api/<parent>/<id>/<child>:<action>` 解析资源动作。 */
export function parseAction(pathname) {
  const withoutPrefix = pathname.startsWith(POLICY.apiPathPrefix)
    ? pathname.slice(POLICY.apiPathPrefix.length)
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

export function classifyRequest({
  method,
  url,
  mode = 'real',
  policyMode = 'strict',
  allowedOrigins,
  body,
}) {
  const upperMethod = String(method ?? 'GET').toUpperCase();
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return {
      decision: 'blocked',
      reason: 'unresolvable-url',
      path: url,
      action: null,
      method: upperMethod,
      mode,
      policyMode,
    };
  }
  const entry = { path: parsed.pathname, method: upperMethod, mode, policyMode };
  const origins =
    Array.isArray(allowedOrigins) && allowedOrigins.length > 0 ? allowedOrigins : [BACKEND_ORIGIN];
  if (!origins.includes(parsed.origin)) {
    return { ...entry, decision: 'blocked', reason: 'destination-not-allowed', action: null };
  }
  if (!parsed.pathname.startsWith(POLICY.apiPathPrefix)) {
    return { ...entry, decision: 'blocked', reason: 'path-not-api', action: null };
  }
  const parsedAction = parseAction(parsed.pathname);

  if (policyMode === 'product') {
    // 产品模式：目的地与前缀已确认，动作由后端判定。
    return { ...entry, decision: 'allowed', action: parsedAction?.key ?? null };
  }

  if (!parsedAction) {
    return { ...entry, decision: 'blocked', reason: 'unparsable-action', action: null };
  }
  if (isStrictDeniedAction(parsedAction.key)) {
    return {
      ...entry,
      decision: 'blocked',
      reason: 'strict-mode-external-side-effect',
      action: parsedAction.key,
    };
  }
  if (parsedAction.key === 'aiConversations:getMessages') {
    // 只有显式 false / 缺省才算只读；true 会在服务端标记已读。
    const updateRead = parsed.searchParams.get('updateRead');
    if (updateRead !== null && updateRead !== '' && updateRead !== 'false' && updateRead !== '0') {
      return { ...entry, decision: 'blocked', reason: 'getMessages-updateRead-not-false', action: parsedAction.key };
    }
  }
  if (POLICY.readPostActions.includes(parsedAction.key)) {
    if (upperMethod === 'GET') {
      return { ...entry, decision: 'allowed', action: parsedAction.key };
    }
    if (upperMethod !== 'POST') {
      return { ...entry, decision: 'blocked', reason: 'read-post-action-must-be-get-or-post', action: parsedAction.key };
    }
    if (parsedAction.key === 'aiContextDatasources:preview') {
      const check = validatePreviewQueryBody(body);
      return check.ok
        ? { ...entry, decision: 'allowed', reason: 'read-post-query-body', action: parsedAction.key }
        : { ...entry, decision: 'blocked', reason: check.reason ?? 'preview-body-invalid', action: parsedAction.key };
    }
    return { ...entry, decision: 'allowed', action: parsedAction.key };
  }
  if (POLICY.readActions.includes(parsedAction.key)) {
    return upperMethod === 'GET'
      ? { ...entry, decision: 'allowed', action: parsedAction.key }
      : { ...entry, decision: 'blocked', reason: 'read-action-must-be-get', action: parsedAction.key };
  }
  if (POLICY.writeActions.includes(parsedAction.key)) {
    return upperMethod === 'POST'
      ? { ...entry, decision: 'allowed', action: parsedAction.key }
      : { ...entry, decision: 'blocked', reason: 'write-action-must-be-post', action: parsedAction.key };
  }
  return { ...entry, decision: 'blocked', reason: 'action-not-allowlisted', action: parsedAction.key };
}

export class TransportBlockedError extends Error {
  constructor(decision) {
    super(`transport-blocked: ${decision.method} ${decision.path} (${decision.reason})`);
    this.name = 'TransportBlockedError';
    this.code = 'TRANSPORT_BLOCKED';
    this.decision = decision;
  }
}

function record(entry) {
  log.push({ at: new Date().toISOString(), ...entry });
}

/** 策略只需要"这是不是一个查询体"；字符串按 JSON 解析，其它原样返回。 */
function parseBodyForPolicy(body) {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/**
 * 受控请求入口。`pathOrUrl` 可以是 `/api/...` 或完整地址。
 * 被拦截时抛 TransportBlockedError，不发出请求。
 */
export async function guardedFetch(pathOrUrl, options = {}) {
  const method = String(options.method ?? 'GET').toUpperCase();
  const origin = options.baseOrigin ?? BACKEND_ORIGIN;
  const url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : `${origin}${pathOrUrl}`;
  const decision = classifyRequest({
    method,
    url,
    mode: options.mode ?? 'real',
    policyMode: options.policyMode ?? 'strict',
    allowedOrigins:
      Array.isArray(options.allowedOrigins) && options.allowedOrigins.length > 0
        ? options.allowedOrigins
        : [origin],
    body: parseBodyForPolicy(options.body),
  });
  if (decision.decision === 'blocked') {
    record({ ...decision, status: null });
    throw new TransportBlockedError(decision);
  }
  const response = await fetch(url, {
    method,
    headers: options.headers,
    body: options.body,
  });
  record({ ...decision, status: response.status });
  return response;
}

/** 证据：调用方声明的动作与实际发出的请求是否一致（防止脚本悄悄扩大范围）。 */
export function assertNoBlockedRequests() {
  const blocked = log.filter((entry) => entry.decision === 'blocked');
  if (blocked.length > 0) {
    throw new Error(`存在被拦截的请求：${JSON.stringify(blocked)}`);
  }
}
