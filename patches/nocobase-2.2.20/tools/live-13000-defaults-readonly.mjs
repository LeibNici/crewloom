#!/usr/bin/env node
/**
 * 目标 2.2.20 实例（`http://172.16.88.250:13000/api`）**精准必要只读**核对：
 * 全局默认模型候选相关的最小事实。
 *
 * 硬边界（在脚本内实现，不靠文字约定）：
 *  - 目的地固定为 172.16.88.250:13000；所有路径必须在 `/api` 下；
 *  - **本地显式允许清单**：只放行下面 `READS` 里的 GET，以及正常 `auth:signIn` / `auth:signOut` 两个 POST；
 *    其余一律在发出前拦截；
 *  - **不以"是 GET"当无写保证**：查询串里出现 `updateRead` 且值不是 `false` 时直接拦截
 *    （`aiConversations:getMessages` 带 `updateRead=true` 会在服务端把会话标记为已读）；
 *  - 不调用模型发现/推理、不写任何业务/配置/用户/角色/模型/流程数据、不发空体或非法写探针；
 *  - 凭据只在**进程内存**里从 `.secrets/full-pages-13000-20261011.json`（0600）读取：
 *    不进 argv、不进环境变量、不写日志、不写证据、不打屏；`llmServices` 的 `options` 只输出键名不输出值。
 *
 * 用法：
 *   node tools/live-13000-defaults-readonly.mjs                 # 写证据到 .work/ 与 defaults-candidate-evidence/
 *   CREWLOOM_DEFAULTS_EVIDENCE_OUT=<path> node tools/...
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const patchRoot = resolve(here, '..');
const projectRoot = resolve(patchRoot, '../../../..');

const ALLOWED_ORIGIN = 'http://172.16.88.250:13000';
const SECRET_CANDIDATES = [
  process.env.CREWLOOM_13000_SECRETS,
  resolve(projectRoot, '.secrets/full-pages-13000-20261011.json'),
  resolve(patchRoot, '../../.secrets/full-pages-13000-20261011.json'),
].filter(Boolean);

const DEFAULT_OUT = resolve(
  patchRoot,
  '../../docs/acceptance/full-pages-13000/defaults-candidate-evidence/live-13000-defaults.json',
);

/** 精准必要只读清单（逐字符命中；`updateRead=false` 的历史消息单独按参数校验）。 */
const READS = [
  { id: 'version', path: '/api/app:getInfo' },
  { id: 'authenticators', path: '/api/authenticators:publicList' },
  { id: 'identity', path: '/api/auth:check' },
  { id: 'aiSettings', path: '/api/aiSettings:get' },
  { id: 'llmServices', path: '/api/llmServices:list?pageSize=50' },
  { id: 'aiEmployees', path: '/api/aiEmployees:list?pageSize=50' },
  { id: 'conversations', path: '/api/aiConversations:list?pageSize=5&sort=-updatedAt' },
];

const ALLOWED_GET_ACTIONS = new Set([
  'app:getInfo',
  'authenticators:publicList',
  'auth:check',
  'aiSettings:get',
  'llmServices:list',
  'aiEmployees:list',
  'aiConversations:list',
  'aiConversations:getMessages',
]);

const WRITE_ACTIONS = new Set(['auth:signIn', 'auth:signOut']);
const blocked = [];
const requestLog = [];

function actionOf(pathname) {
  const segs = pathname.split('/').filter(Boolean);
  const last = segs[segs.length - 1] ?? '';
  const colon = last.lastIndexOf(':');
  return colon > 0 ? { resource: last.slice(0, colon), action: last.slice(colon + 1) } : null;
}

/** 请求发出前的本地守卫：目的地 + /api + 允许清单 + GET 无写参数。 */
function guard(pathOrUrl, { method = 'GET' } = {}) {
  const url = new URL(pathOrUrl, ALLOWED_ORIGIN);
  const upper = method.toUpperCase();
  const record = (reason) => {
    blocked.push({ path: url.pathname, method: upper, reason });
    throw new Error(`transport-blocked: ${upper} ${url.pathname} (${reason})`);
  };
  if (url.origin !== ALLOWED_ORIGIN) record('destination-not-allowed');
  if (!url.pathname.startsWith('/api')) record('path-not-api');
  const parsed = actionOf(url.pathname);
  const key = parsed ? `${parsed.resource}:${parsed.action}` : null;
  if (upper === 'GET') {
    // 不以"是 GET"当无写保证：只读参数必须显式为 false，缺省也不允许出现 true。
    const updateRead = url.searchParams.get('updateRead');
    if (updateRead !== null && updateRead !== 'false') record('get-with-write-param:updateRead');
    if (!key || !ALLOWED_GET_ACTIONS.has(key)) record(`action-not-allowlisted:${key}`);
    const isStatic = READS.some((item) => item.path === `${url.pathname}${url.search}`);
    if (!isStatic && key !== 'aiConversations:getMessages') record('path-not-allowlisted');
    if (key === 'aiConversations:getMessages') {
      if (url.searchParams.get('paginate') !== 'false') record('getMessages-paginate-must-be-false');
      if (url.searchParams.get('updateRead') !== 'false') record('getMessages-updateRead-must-be-false');
      if (!url.searchParams.get('sessionId')) record('getMessages-sessionId-required');
    }
  } else if (upper === 'POST') {
    if (!key || !WRITE_ACTIONS.has(key)) record(`post-not-allowed:${key}`);
  } else {
    record('method-not-allowed');
  }
  return { url, key };
}

async function request(fullPath, { method = 'GET', token, authenticator, body } = {}) {
  const { url } = guard(fullPath, { method });
  const headers = { 'Content-Type': 'application/json', 'X-Authenticator': authenticator };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { _nonJson: text.slice(0, 120) };
  }
  requestLog.push({ id: fullPath, method, status: response.status });
  return { status: response.status, body: parsed };
}

function listMeta(body) {
  return {
    rows: Array.isArray(body?.data) ? body.data.length : null,
    count: typeof body?.meta?.count === 'number' ? body.meta.count : null,
  };
}

/** 服务列表脱敏：绝对不输出 `options` 的值。 */
function maskServices(body) {
  if (!Array.isArray(body?.data)) return null;
  return body.data.map((service) => {
    const entry = {
      name: service?.name ?? null,
      title: service?.title ?? null,
      provider: service?.provider ?? null,
      enabled: service?.enabled ?? null,
      sort: service?.sort ?? null,
      optionsKeys: service?.options && typeof service.options === 'object' ? Object.keys(service.options) : null,
    };
    const raw = service?.enabledModels;
    if (raw && !Array.isArray(raw) && typeof raw === 'object' && raw.mode) {
      entry.enabledModels = { mode: raw.mode, count: Array.isArray(raw.models) ? raw.models.length : null };
    } else if (Array.isArray(raw)) {
      entry.enabledModels = { arrayLength: raw.length, values: raw.slice(0, 20).map((item) => (typeof item === 'string' ? item : item?.value ?? null)) };
    } else {
      entry.enabledModels = null;
    }
    return entry;
  });
}

function maskEmployees(body) {
  if (!Array.isArray(body?.data)) return null;
  return body.data.map((employee) => {
    const settings = employee?.modelSettings;
    return {
      username: employee?.username ?? null,
      hasModelSettings: settings !== undefined && settings !== null,
      modelSettingsEnabled: settings?.enabled ?? null,
      allowedModelCount: Array.isArray(settings?.models) ? settings.models.length : 0,
      hasFlatSelection: Boolean(settings?.llmService && settings?.model),
    };
  });
}

function maskSettings(body) {
  const data = body?.data;
  if (!data || typeof data !== 'object') return null;
  const entries = {};
  for (const [key, value] of Object.entries(data)) {
    entries[key] =
      key.toLowerCase().includes('key') || key.toLowerCase().includes('secret') || key.toLowerCase().includes('token')
        ? '<masked>'
        : value;
  }
  return entries;
}

/** 历史消息响应形状（避免误读成 `{rows}`）。 */
function historyShape(body) {
  const data = body?.data;
  if (Array.isArray(data)) {
    const first = data[0];
    return {
      dataType: 'array',
      length: data.length,
      elementTypes: data.map((item) => (Array.isArray(item) ? 'array' : typeof item)),
      firstElementKeys:
        first && typeof first === 'object' && !Array.isArray(first) ? Object.keys(first).slice(0, 20) : null,
      firstElementRowCount: first && Array.isArray(first.rows) ? first.rows.length : null,
    };
  }
  if (data && typeof data === 'object') {
    return {
      dataType: 'object',
      keys: Object.keys(data).slice(0, 20),
      rowCount: Array.isArray(data.rows) ? data.rows.length : null,
      hasMore: data.hasMore ?? null,
    };
  }
  return { dataType: typeof data };
}

/**
 * 守卫自检（**不发请求**）：证明"是 GET"不等于"无写"。
 * 返回每条用例是否被拦截，并在结束时把 `blocked` 恢复到自检前长度。
 */
function guardSelfTest() {
  const before = blocked.length;
  const cases = [
    { name: 'getMessages updateRead=true 应被拦截', expectBlocked: true, run: () => guard('/api/aiConversations:getMessages?sessionId=x&paginate=false&updateRead=true') },
    { name: 'getMessages 缺少 updateRead=false 应被拦截', expectBlocked: true, run: () => guard('/api/aiConversations:getMessages?sessionId=x&paginate=false') },
    { name: 'getMessages updateRead=false 应放行', expectBlocked: false, run: () => guard('/api/aiConversations:getMessages?sessionId=x&paginate=false&updateRead=false') },
    { name: 'POST users:create 应被拦截', expectBlocked: true, run: () => guard('/api/users:create', { method: 'POST' }) },
    { name: 'GET collections:list（本 runner 未允许）应被拦截', expectBlocked: true, run: () => guard('/api/collections:list') },
    { name: '错误目的地应被拦截', expectBlocked: true, run: () => guard('http://127.0.0.1:13000/api/app:getInfo') },
  ];
  const results = cases.map((item) => {
    try {
      item.run();
      return { name: item.name, blocked: false, ok: item.expectBlocked === false };
    } catch (error) {
      return { name: item.name, blocked: true, reason: String(error.message), ok: item.expectBlocked === true };
    }
  });
  blocked.length = before;
  return { ok: results.every((item) => item.ok), results };
}

async function main() {
  const evidence = {
    generatedAt: new Date().toISOString(),
    target: ALLOWED_ORIGIN,
    note: '精准必要只读；本地显式允许清单；GET 带写参数（updateRead≠false）在发出前拦截；不输出凭据与 options 值。',
    secretPathUsed: null,
    signIn: null,
    signOut: null,
    reads: {},
    conversations: null,
    guardSelfTest: null,
    blocked,
    requests: requestLog,
  };

  const secretPath = SECRET_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!secretPath) {
    console.error(`缺少凭据文件（候选：${SECRET_CANDIDATES.join(', ')}）`);
    process.exitCode = 2;
    return;
  }
  evidence.secretPathUsed = secretPath.replace(projectRoot, '<projectRoot>');
  // 先做守卫自检（纯本地，不发请求），证明"是 GET"不等于"无写"。
  evidence.guardSelfTest = guardSelfTest();
  const secrets = JSON.parse(readFileSync(secretPath, 'utf8'));
  const declared = String(secrets.apiBaseURL).replace(/\/+$/, '').replace(/\/api$/, '');
  if (declared !== ALLOWED_ORIGIN) {
    console.error(`凭据声明的目标 ${declared} 与允许目标 ${ALLOWED_ORIGIN} 不一致；中止。`);
    process.exitCode = 2;
    return;
  }

  let authenticator = 'basic';
  const publicList = await request('/api/authenticators:publicList');
  if (Array.isArray(publicList.body?.data) && publicList.body.data[0]?.name) {
    authenticator = publicList.body.data[0].name;
  }

  const info = await request('/api/app:getInfo');
  evidence.reads.version = { status: info.status, version: info.body?.data?.version ?? null };

  const signIn = await request('/api/auth:signIn', {
    method: 'POST',
    authenticator,
    body: { email: secrets.email, password: secrets.password },
  });
  evidence.signIn = { status: signIn.status };
  if (signIn.status !== 200) {
    finish(evidence);
    process.exitCode = 1;
    return;
  }
  const token = signIn.body?.data?.token;

  for (const item of READS) {
    if (item.id === 'version') continue;
    const result = await request(item.path, { token, authenticator });
    const entry = { status: result.status, ...listMeta(result.body) };
    if (item.id === 'aiSettings') {
      entry.settings = maskSettings(result.body);
      entry.defaultLLMService = result.body?.data?.defaultLLMService ?? null;
      entry.defaultModel = result.body?.data?.defaultModel ?? null;
      entry.defaultConfigured = Boolean(result.body?.data?.defaultLLMService && result.body?.data?.defaultModel);
    }
    if (item.id === 'llmServices') entry.services = maskServices(result.body);
    if (item.id === 'aiEmployees') entry.employees = maskEmployees(result.body);
    if (item.id === 'conversations') {
      const rows = Array.isArray(result.body?.data) ? result.body.data : [];
      evidence.conversations = rows.slice(0, 5).map((row) => ({
        sessionId: row?.sessionId ?? null,
        hasTitle: Boolean(row?.title),
        updatedAt: row?.updatedAt ?? null,
      }));
      entry.sessionIds = evidence.conversations.map((row) => row.sessionId);
    }
    evidence.reads[item.id] = entry;
  }

  // 历史消息：明确 `updateRead=false`；存在会话才发。
  const sessionId = evidence.reads.conversations?.sessionIds?.find(Boolean);
  if (sessionId) {
    const history = await request(
      `/api/aiConversations:getMessages?sessionId=${encodeURIComponent(sessionId)}&paginate=false&updateRead=false`,
      { token, authenticator },
    );
    evidence.reads.getMessages = {
      status: history.status,
      updateRead: 'false',
      ...historyShape(history.body),
    };
  } else {
    evidence.reads.getMessages = { status: null, skipped: 'no-conversation' };
  }

  const signOut = await request('/api/auth:signOut', { method: 'POST', token, authenticator });
  evidence.signOut = { status: signOut.status };

  finish(evidence);
  process.exitCode = blocked.length === 0 && evidence.guardSelfTest?.ok ? 0 : 1;
}

function finish(evidence) {
  const out = process.env.CREWLOOM_DEFAULTS_EVIDENCE_OUT ?? DEFAULT_OUT;
  evidence.requests = requestLog;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`target=${ALLOWED_ORIGIN}`);
  console.log(`signIn=${evidence.signIn?.status} version=${evidence.reads.version?.version} blocked=${blocked.length}`);
  console.log(`aiSettings.defaultConfigured=${evidence.reads.aiSettings?.defaultConfigured}`);
  console.log(`llmServices=${evidence.reads.llmServices?.count} aiEmployees=${evidence.reads.aiEmployees?.count}`);
  console.log(`getMessages=${JSON.stringify(evidence.reads.getMessages)}`);
  console.log(`evidence=${out}`);
}

await main();
