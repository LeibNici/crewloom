#!/usr/bin/env node
/**
 * 13000 真实实例（NocoBase 2.2.20）**只读**冒烟核对。
 *
 * 用途：本阶段三组并行实施时的公共真实联调入口。默认目标就是产品默认后端
 * `http://172.16.88.250:13000`（可用 `CREWLOOM_BACKEND_ORIGIN` 覆盖）。
 *
 * 硬边界（在脚本内实现，不靠文字约定）：
 *  - 目的地固定为上面这个来源；所有业务路径必须在 `/api` 下；
 *  - 强制 `policyMode: 'strict'`：只允许允许清单内的只读 GET 与正常 auth:signIn / auth:signOut；
 *    有外部副作用的动作（模型发现/推理、MCP 调用、工作流自测、上传…）一律在发出前拦截；
 *  - 不调用模型、不外呼第三方、不写任何业务数据；空体/非法写探针一律不发；
 *  - 凭据只在**进程内存**里从 `.secrets/full-pages-13000-20261011.json`（0600）读取：
 *    不进 argv、不进环境变量、不写日志、不写证据、不打屏。
 *
 * 用法：
 *   pnpm run verify:13000                 # 只读冒烟 + 写证据
 *   CREWLOOM_REPORT_OUT=<path> pnpm run verify:13000
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertNoBlockedRequests,
  BACKEND_ORIGIN,
  getRequestCounts,
  getRequestLog,
  guardedFetch,
} from './lib/transport-policy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const SECRET_PATH =
  process.env.CREWLOOM_13000_SECRETS ?? resolve(repoRoot, '.secrets/full-pages-13000-20261011.json');
const DEFAULT_OUT = resolve(
  repoRoot,
  'docs/acceptance/full-pages-13000/evidence/readonly-smoke-13000.json',
);
const OUT = process.env.CREWLOOM_REPORT_OUT ?? DEFAULT_OUT;

/** 只读探测清单：全部在允许清单内，且不产生外部副作用。 */
const READS = [
  '/api/app:getInfo',
  '/api/authenticators:publicList',
  '/api/systemSettings:get',
  '/api/auth:check',
  '/api/roles:check',
  '/api/aiEmployees:listByUser?pageSize=1',
  '/api/aiEmployees:list?pageSize=1',
  '/api/aiConversations:list?pageSize=1',
  '/api/aiTools:list?pageSize=1',
  '/api/aiMcpClients:list?pageSize=1',
  '/api/userWorkflowTaskStats:listMine',
  '/api/userWorkflowTasks:listMine?pageSize=1',
  '/api/workflowManualTasks:listMine?pageSize=1',
  '/api/workflowCcTasks:listMine?pageSize=1',
  '/api/aiWorkflowTasks:list?pageSize=1',
  '/api/workflows:list?pageSize=1',
  '/api/executions:list?pageSize=1',
  '/api/flow_nodes:list?pageSize=1',
  '/api/jobs:list?pageSize=1',
  '/api/dataSources:list',
  '/api/collections:list?pageSize=1',
  '/api/llmServices:list?pageSize=1',
  '/api/aiSettings:get',
  '/api/users:list?pageSize=1',
  '/api/roles:list?pageSize=1',
  '/api/departments:list?pageSize=1',
];

let ORIGIN = BACKEND_ORIGIN;
let authenticator = 'basic';

async function request(path, { method = 'GET', token, role, body } = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Authenticator': authenticator };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (role) headers['X-Role'] = role;
  const response = await guardedFetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    baseOrigin: ORIGIN,
    allowedOrigins: [ORIGIN],
    policyMode: 'strict',
  });
  const text = await response.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* 保留文本片段 */
  }
  return { status: response.status, body: parsed };
}

function listMeta(body) {
  const meta = body?.meta ?? {};
  return {
    rows: Array.isArray(body?.data) ? body.data.length : null,
    count: typeof meta.count === 'number' ? meta.count : null,
    metaKeys: Object.keys(meta),
  };
}

function classify(status, body) {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'no-permission';
  if (status === 404) return 'not-found-or-not-enabled';
  if (status >= 500) return 'server-error';
  if (status === 200) {
    if (Array.isArray(body?.data)) return body.data.length === 0 ? 'ok-empty' : 'ok-has-data';
    return 'ok';
  }
  return 'other';
}

function maskServices(body) {
  if (!Array.isArray(body?.data)) return null;
  return body.data.map((service) => ({
    name: service?.name ?? null,
    title: service?.title ?? null,
    provider: service?.provider ?? null,
    enabled: service?.enabled ?? null,
    // options 一律不输出值，只输出键名
    optionsKeys: service?.options && typeof service.options === 'object' ? Object.keys(service.options) : null,
    enabledModelsType: Array.isArray(service?.enabledModels) ? 'array' : typeof service?.enabledModels,
  }));
}

async function main() {
  const evidence = {
    generatedAt: new Date().toISOString(),
    target: ORIGIN,
    policyMode: 'strict',
    note: '只读冒烟；仅正常登录/退出 POST；不调用模型发现/推理；不输出凭据、选项值或业务记录正文。',
    version: null,
    signIn: null,
    reads: {},
    identity: null,
    signOut: null,
    counts: null,
  };

  if (!existsSync(SECRET_PATH)) {
    console.error(`缺少凭据文件：${SECRET_PATH}`);
    process.exitCode = 2;
    return;
  }
  const secrets = JSON.parse(readFileSync(SECRET_PATH, 'utf8'));
  const raw = String(secrets.apiBaseURL).replace(/\/+$/, '');
  ORIGIN = raw.endsWith('/api') ? raw.slice(0, -'/api'.length) : raw;

  const publicList = await request('/api/authenticators:publicList');
  if (Array.isArray(publicList.body?.data) && publicList.body.data[0]?.name) {
    authenticator = publicList.body.data[0].name;
  }

  const info = await request('/api/app:getInfo');
  evidence.version = { status: info.status, version: info.body?.data?.version ?? null, lang: info.body?.data?.lang ?? null };

  const signIn = await request('/api/auth:signIn', {
    method: 'POST',
    body: { email: secrets.email, password: secrets.password },
  });
  evidence.signIn = { status: signIn.status, outcome: classify(signIn.status, signIn.body) };
  if (signIn.status !== 200) {
    finish(evidence, 1);
    return;
  }
  const token = signIn.body?.data?.token;

  for (const path of READS) {
    const result = await request(path, { token });
    const detail = { status: result.status, outcome: classify(result.status, result.body), ...listMeta(result.body) };
    if (path === '/api/llmServices:list?pageSize=1') detail.services = maskServices(result.body);
    if (path === '/api/aiSettings:get') {
      const data = result.body?.data ?? {};
      detail.settingKeys = Object.keys(data);
      detail.defaultsConfigured =
        (data.defaultLLMService ?? null) !== null && (data.defaultModel ?? null) !== null;
    }
    evidence.reads[path] = detail;
  }

  const authCheck = await request('/api/auth:check', { token });
  evidence.identity = {
    status: authCheck.status,
    userId: authCheck.body?.data?.id ?? null,
    roleCount: Array.isArray(authCheck.body?.data?.roles) ? authCheck.body.data.roles.length : null,
  };

  const signOut = await request('/api/auth:signOut', { method: 'POST', token, body: {} });
  const after = await request('/api/auth:check', { token });
  evidence.signOut = { status: signOut.status, afterStatus: after.status };

  finish(evidence, 0);
}

function finish(evidence, exitCode) {
  evidence.finishedAt = new Date().toISOString();
  evidence.requestLog = getRequestLog();
  evidence.counts = getRequestCounts();
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`);
  assertNoBlockedRequests();
  console.log(
    `13000 只读冒烟：版本 ${evidence.version?.version ?? '未知'}，请求 ${evidence.counts.allowed} 条放行 / ${evidence.counts.blocked} 条拦截；证据：${OUT}`,
  );
  process.exitCode = exitCode;
}

await main();
