#!/usr/bin/env node
/**
 * P1 阶段实例（250 新实例，NocoBase 2.2.22）只读联调与证据采集。
 *
 * ⚠️ 目标实例在这里**显式固定为 P1 实例**（`http://172.16.88.250:13080`），
 * 不跟随产品默认后端（产品默认已切到 `http://172.16.88.250:13000`）：
 * 本脚本读取 `.secrets/crewloom-p1-fixtures.json` 的 P1 夹具账号，那些账号只存在于 13080。
 * 需要时用 `CREWLOOM_LIVE_BACKEND_ORIGIN` 覆盖。
 *
 * 与旧版的区别（P1 修复轮）：
 *  - **不再写入任何内容**：不写 .secrets、不创建/更新/删除业务数据、不改角色或权限；
 *  - 所有请求经 `scripts/lib/transport-policy.mjs`，并强制 `policyMode: 'strict'`：
 *    目的地固定、只允许已知只读 GET 与正常 auth:signIn / auth:signOut，
 *    未授权动作与有外部副作用的动作在发出前拦截；
 *  - 证据只记录 method / path / 动作 / 状态 / 角色名（不记录口令、令牌或响应正文）。
 *
 * 用法：pnpm run verify:backend   （可选 CREWLOOM_REPORT_OUT=<path> 指定证据文件）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertNoBlockedRequests,
  getRequestCounts,
  getRequestLog,
  guardedFetch,
  POLICY,
} from './lib/transport-policy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const FIXTURE_PATH = resolve(repoRoot, '.secrets/crewloom-p1-fixtures.json');
const DEFAULT_OUT = resolve(repoRoot, 'docs/acceptance/p1-repair/evidence/backend-readonly.json');
const OUT = process.env.CREWLOOM_REPORT_OUT ?? DEFAULT_OUT;
/** P1 夹具账号所在实例（不跟随产品默认后端）。 */
const LIVE_ORIGIN = process.env.CREWLOOM_LIVE_BACKEND_ORIGIN ?? 'http://172.16.88.250:13080';

/** 只读探测清单：全部是允许清单内的动作。 */
const READS = [
  '/api/auth:check',
  '/api/roles:check',
  '/api/aiEmployees:listByUser?pageSize=1',
  '/api/userWorkflowTaskStats:listMine',
  '/api/userWorkflowTasks:listMine?pageSize=50',
  '/api/aiConversations:list?pageSize=1',
  '/api/dataSources:list',
  '/api/workflows:list?pageSize=1',
  '/api/llmServices:list?pageSize=1',
  '/api/aiEmployees:list?pageSize=1',
  '/api/roles:list?pageSize=1',
  '/api/users:list?pageSize=1',
];

function loadFixtures() {
  if (!existsSync(FIXTURE_PATH)) return null;
  const parsed = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
  // 只保留本脚本需要的字段，绝不把口令写进证据。
  const users = {};
  for (const [key, value] of Object.entries(parsed.users ?? {})) {
    users[key] = { id: value.id, email: value.email, password: value.password };
  }
  return { users };
}

async function request(path, { method = 'GET', token, role, body } = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Authenticator': 'basic' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (role) headers['X-Role'] = role;
  const response = await guardedFetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    baseOrigin: LIVE_ORIGIN,
    allowedOrigins: [LIVE_ORIGIN],
    policyMode: 'strict',
  });
  const text = await response.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* 保留文本 */
  }
  return { status: response.status, body: parsed };
}

function summarizeAuthCheck(body) {
  const user = body?.data ?? {};
  const roles = Array.isArray(user.roles) ? user.roles : [];
  return {
    userId: user.id ?? null,
    roleCount: roles.length,
    roles: roles.map((role) => ({ name: role.name, title: role.title ?? null })),
  };
}

function summarizeAccess(body) {
  const access = body?.data ?? {};
  return {
    role: access.role ?? null,
    roleMode: access.roleMode ?? null,
    allowAll: access.allowAll ?? null,
    snippetCount: Array.isArray(access.snippets) ? access.snippets.length : null,
    effectiveRoles: Array.isArray(access.roles) ? access.roles : null,
  };
}

function summarizeStatsMeta(body) {
  const meta = body?.meta ?? {};
  return {
    dataIsArray: Array.isArray(body?.data),
    rowCount: Array.isArray(body?.data) ? body.data.length : null,
    metaKeys: Object.keys(meta),
    pageSize: meta.pageSize ?? null,
    hasNext: meta.hasNext ?? null,
    hasCount: Object.prototype.hasOwnProperty.call(meta, 'count'),
  };
}

async function main() {
  const fixtures = loadFixtures();
  if (!fixtures) {
    console.error(`缺少夹具文件：${FIXTURE_PATH}`);
    process.exitCode = 2;
    return;
  }

  const evidence = {
    startedAt: new Date().toISOString(),
    backendOrigin: LIVE_ORIGIN,
    note: '只读联调；所有请求经传输层允许清单；不写入任何后端数据或凭据文件。',
    accounts: {},
    signOutRevocation: null,
    requestLog: [],
    counts: null,
  };

  for (const [key, user] of Object.entries(fixtures.users)) {
    const signIn = await request('/api/auth:signIn', {
      method: 'POST',
      body: { email: user.email, password: user.password },
    });
    if (signIn.status !== 200) {
      evidence.accounts[key] = { signInStatus: signIn.status, error: 'sign-in failed' };
      continue;
    }
    const token = signIn.body?.data?.token;
    const entry = { userId: user.id, signInStatus: signIn.status, reads: {} };

    for (const path of READS) {
      const result = await request(path, { token });
      const record = { status: result.status };
      if (path === '/api/auth:check' && result.status === 200) Object.assign(record, summarizeAuthCheck(result.body));
      if (path === '/api/roles:check' && result.status === 200) Object.assign(record, summarizeAccess(result.body));
      if (path.startsWith('/api/userWorkflowTaskStats') && result.status === 200) {
        Object.assign(record, summarizeStatsMeta(result.body));
      }
      entry.reads[path] = record;
    }

    // 角色上下文：用受限角色读取角色上下文，验证 roles:check.roles 是"当前生效"集合。
    const asLimited = await request('/api/roles:check', { token, role: 'crewloom_p1_limited' });
    entry.limitedContext = {
      status: asLimited.status,
      ...(asLimited.status === 200 ? summarizeAccess(asLimited.body) : {}),
    };
    // 不属于自己的角色 → 角色失效错误码（不清会话）。
    const unowned = await request('/api/roles:check', { token, role: 'root' });
    entry.unownedRole = {
      status: unowned.status,
      codes: Array.isArray(unowned.body?.errors) ? unowned.body.errors.map((e) => e.code ?? null) : [],
    };
    // 角色失效后同一令牌仍可读（会话未被清除）。
    entry.afterRoleError = { authCheckStatus: (await request('/api/auth:check', { token })).status };

    evidence.accounts[key] = entry;
  }

  // 正常退出后的令牌撤销：用独立登录，避免影响上面的读取。
  const revokeUser = fixtures.users.crewloom_p1_admin;
  if (revokeUser) {
    const signIn = await request('/api/auth:signIn', {
      method: 'POST',
      body: { email: revokeUser.email, password: revokeUser.password },
    });
    const token = signIn.body?.data?.token;
    const before = await request('/api/auth:check', { token });
    const out = await request('/api/auth:signOut', { method: 'POST', token, body: {} });
    const after = await request('/api/auth:check', { token });
    evidence.signOutRevocation = {
      signInStatus: signIn.status,
      beforeStatus: before.status,
      signOutStatus: out.status,
      afterStatus: after.status,
    };
  }

  evidence.finishedAt = new Date().toISOString();
  evidence.requestLog = getRequestLog();
  evidence.counts = getRequestCounts();
  assertNoBlockedRequests();

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`);

  console.log(`后端版本固定目标：${LIVE_ORIGIN}`);
  console.log(`只读请求 ${evidence.counts.allowed} 条，拦截 ${evidence.counts.blocked} 条`);
  for (const [key, entry] of Object.entries(evidence.accounts)) {
    const auth = entry.reads['/api/auth:check'];
    console.log(
      `${key}: 登录 ${entry.signInStatus}；auth:check 角色 ${auth?.roleCount ?? 'n/a'}（${(auth?.roles ?? [])
        .map((r) => r.title ?? r.name)
        .join('、')}）`,
    );
  }
  if (evidence.signOutRevocation) {
    console.log(
      `退出撤销验证：登录 ${evidence.signOutRevocation.signInStatus} → 退出后 auth:check ${evidence.signOutRevocation.afterStatus}`,
    );
  }
  console.log(`证据已写入：${OUT}`);
}

await main();
