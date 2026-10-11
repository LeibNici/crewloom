import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  assertNoBlockedRequests,
  getRequestCounts,
  getRequestLog,
  guardedFetch,
  POLICY,
} from '../scripts/lib/transport-policy.mjs';

/**
 * 真实后端联调测试：**P1 阶段实例**（250 新实例，NocoBase 2.2.22，`http://172.16.88.250:13080/api`）。
 *
 * 目标实例在这里**显式固定**，不跟随产品默认后端（产品默认已切到 13000）：
 * 本套件依赖 `.secrets/crewloom-p1-fixtures.json` 的 P1 夹具账号，那些账号只存在于 13080。
 * 需要时可用 `CREWLOOM_LIVE_BACKEND_ORIGIN` 覆盖。
 *
 * 与受控 mock 测试分开：这里打真实 HTTP，不做任何替身。
 *
 * 安全边界（不是文字约定）：
 *  - 所有请求都经 `guardedFetch`：目的地必须等于本套件固定的实例、路径必须在 /api 下、
 *    动作必须在合并后的允许清单内（只读 GET + 正常 auth:signIn / auth:signOut），
 *    并强制 `policyMode: 'strict'`，否则在发出前抛错；
 *  - 不创建/修改/删除任何业务数据、账号、角色、权限、配置或工作流；
 *  - 不在 `.secrets` 写任何内容，也不打印口令或令牌。
 *
 * 未提供夹具文件或后端不可达时整体跳过，不影响常规受控测试。
 */

const FIXTURE_PATH = resolve(process.cwd(), '../.secrets/crewloom-p1-fixtures.json');
/** P1 夹具账号所在实例；产品默认后端已改为 13000，本套件不跟随。 */
const LIVE_ORIGIN = process.env.CREWLOOM_LIVE_BACKEND_ORIGIN ?? 'http://172.16.88.250:13080';

interface FixtureUser {
  id: number;
  email: string;
  password: string;
}
interface FixtureFile {
  users: Record<string, FixtureUser>;
}

let fixtures: FixtureFile | null = null;
try {
  fixtures = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as FixtureFile;
} catch {
  fixtures = null;
}

let backendReachable = false;
try {
  const probe = await guardedFetch('/api/authenticators:publicList', {
    baseOrigin: LIVE_ORIGIN,
    allowedOrigins: [LIVE_ORIGIN],
    policyMode: 'strict',
  });
  backendReachable = probe.ok;
} catch {
  backendReachable = false;
}

const suite = fixtures && backendReachable ? describe : describe.skip;

interface CallResult {
  status: number;
  body: unknown;
  headers: Headers;
}

let authenticatorName = 'basic';

async function call(
  path: string,
  options: { method?: string; token?: string | null; role?: string | null; body?: unknown } = {},
): Promise<CallResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Authenticator': authenticatorName,
  };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.role) headers['X-Role'] = options.role;
  const response = await guardedFetch(path, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    baseOrigin: LIVE_ORIGIN,
    allowedOrigins: [LIVE_ORIGIN],
    policyMode: 'strict',
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* 保留文本，仅用于证据 */
  }
  return { status: response.status, body, headers: response.headers };
}

function data<T>(body: unknown): T {
  return (body as { data: T }).data;
}

function meta(body: unknown): Record<string, unknown> {
  return ((body as { meta?: Record<string, unknown> }).meta ?? {}) as Record<string, unknown>;
}

async function signIn(key: string): Promise<{ token: string; userId: number }> {
  const user = fixtures!.users[key];
  const result = await call('/api/auth:signIn', {
    method: 'POST',
    body: { email: user.email, password: user.password },
  });
  expect(result.status, `signIn ${key}`).toBe(200);
  const payload = data<{ token: string; user: { id: number } }>(result.body);
  return { token: payload.token, userId: payload.user.id };
}

suite('真实后端：本人角色候选的唯一来源是 auth:check.data.roles', () => {
  beforeAll(async () => {
    if (!fixtures) throw new Error('缺少夹具文件');
    const list = await call('/api/authenticators:publicList');
    expect(list.status).toBe(200);
    const entries = data<Array<{ name: string; authType?: string }>>(list.body);
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
    // 当前实例只有 Email/Password；只取它的 name，不扩展其它登录方式。
    authenticatorName = entries[0].name;
  });

  it('多角色账号：auth:check.data.roles 返回全部所属角色（含中文标题）', async () => {
    const { token } = await signIn('crewloom_p1_multi');
    const result = await call('/api/auth:check', { token });
    expect(result.status).toBe(200);
    const user = data<{ roles: Array<{ name: string; title?: string | null }> }>(result.body);
    expect(Array.isArray(user.roles)).toBe(true);
    expect(user.roles.map((role) => role.name).sort()).toEqual(['crewloom_p1_admin', 'crewloom_p1_limited']);
    for (const role of user.roles) {
      expect(typeof role.name).toBe('string');
      expect(typeof role.title).toBe('string');
      expect((role.title ?? '').length).toBeGreaterThan(0);
    }
  });

  it('多角色账号停留在受限角色时，auth:check.data.roles 仍是全部角色（不随生效角色收窄）', async () => {
    const { token } = await signIn('crewloom_p1_multi');
    const result = await call('/api/auth:check', { token, role: 'crewloom_p1_limited' });
    expect(result.status).toBe(200);
    const user = data<{ roles: Array<{ name: string }> }>(result.body);
    expect(user.roles.map((role) => role.name).sort()).toEqual(['crewloom_p1_admin', 'crewloom_p1_limited']);
  });

  it('受限单角色账号：auth:check.data.roles 带出可显示的中文角色名', async () => {
    const { token } = await signIn('crewloom_p1_limited');
    const result = await call('/api/auth:check', { token });
    expect(result.status).toBe(200);
    const user = data<{ roles: Array<{ name: string; title?: string | null }> }>(result.body);
    expect(user.roles).toHaveLength(1);
    expect(user.roles[0].name).toBe('crewloom_p1_limited');
    expect((user.roles[0].title ?? '').length).toBeGreaterThan(0);
  });

  it('auth:check 不返回令牌或密码字段', async () => {
    const { token } = await signIn('crewloom_p1_admin');
    const result = await call('/api/auth:check', { token });
    const user = data<Record<string, unknown>>(result.body);
    expect(user).not.toHaveProperty('password');
    expect(user).not.toHaveProperty('token');
    // 允许出现 passwordChangeTz 这类时间字段，但不得出现名为 password 的键。
    expect(JSON.stringify(user)).not.toContain('"password"');
  });
});

suite('真实后端：角色切换与角色失效语义', () => {
  it('roles:check.roles 是"当前生效"集合，不是全部所属角色', async () => {
    const { token } = await signIn('crewloom_p1_multi');
    const asLimited = await call('/api/roles:check', { token, role: 'crewloom_p1_limited' });
    expect(asLimited.status).toBe(200);
    const limitedView = data<{ role: string; roles: string[] }>(asLimited.body);
    expect(limitedView.role).toBe('crewloom_p1_limited');
    expect(limitedView.roles).toEqual(['crewloom_p1_limited']);
  });

  it('携带不属于自己的角色 → 401 ROLE_NOT_FOUND_FOR_USER，且会话仍然有效', async () => {
    const { token } = await signIn('crewloom_p1_admin');
    const denied = await call('/api/roles:check', { token, role: 'root' });
    expect(denied.status).toBe(401);
    expect(JSON.stringify(denied.body)).toContain('ROLE_NOT_FOUND_FOR_USER');

    // 角色失效不清会话：换回有效角色后同一令牌仍可读。
    const recover = await call('/api/auth:check', { token });
    expect(recover.status).toBe(200);
  });

  it('退出登录后同一令牌不能再访问受保护接口（真实撤销）', async () => {
    const { token } = await signIn('crewloom_p1_admin');
    expect((await call('/api/auth:check', { token })).status).toBe(200);
    const out = await call('/api/auth:signOut', { method: 'POST', token, body: {} });
    expect(out.status).toBe(200);
    expect((await call('/api/auth:check', { token })).status).toBe(401);
  });
});

suite('真实后端：只读权限边界与工作台契约', () => {
  it('受限角色对管理资源是 403（明确拒绝），不是未认证', async () => {
    const { token } = await signIn('crewloom_p1_limited');
    for (const path of ['/api/dataSources:list', '/api/workflows:list', '/api/llmServices:list']) {
      const result = await call(path, { token });
      expect(result.status, path).toBe(403);
    }
    expect((await call('/api/aiEmployees:list', { token })).status).toBe(403);
  });

  it('受限角色仍可读登录态自身的只读接口', async () => {
    const { token } = await signIn('crewloom_p1_limited');
    for (const path of [
      '/api/auth:check',
      '/api/roles:check',
      '/api/aiEmployees:listByUser?pageSize=1',
      '/api/userWorkflowTaskStats:listMine',
      '/api/userWorkflowTasks:listMine?pageSize=50',
      '/api/aiConversations:list?pageSize=1',
    ]) {
      const result = await call(path, { token });
      expect(result.status, path).toBe(200);
    }
  });

  it('userWorkflowTaskStats:listMine 的响应层级与分页字段符合原生 handler（无 count）', async () => {
    const { token } = await signIn('crewloom_p1_multi');
    const result = await call('/api/userWorkflowTaskStats:listMine', { token });
    expect(result.status).toBe(200);
    const rows = data<Array<{ workflowKey: string; stats: { pending: number; all: number } }>>(result.body);
    expect(Array.isArray(rows)).toBe(true);
    const m = meta(result.body);
    expect(m).toHaveProperty('page');
    expect(m).toHaveProperty('pageSize');
    expect(m).toHaveProperty('hasNext');
    expect(m).not.toHaveProperty('count');
    expect(m.pageSize).toBe(200);
    for (const row of rows) {
      expect(typeof row.workflowKey).toBe('string');
      expect(row.stats).toHaveProperty('pending');
      expect(row.stats).toHaveProperty('all');
    }
  });

  it('userWorkflowTasks:listMine 的行只有 id/userId/type/stats（没有 title/status）', async () => {
    const { token } = await signIn('crewloom_p1_multi');
    const result = await call('/api/userWorkflowTasks:listMine?pageSize=50', { token });
    expect(result.status).toBe(200);
    const rows = data<Array<Record<string, unknown>>>(result.body);
    expect(Array.isArray(rows)).toBe(true);
    for (const row of rows) {
      expect(row).toHaveProperty('type');
      expect(row).toHaveProperty('stats');
      expect(row).not.toHaveProperty('title');
      expect(row).not.toHaveProperty('status');
    }
  });

  it('authenticators:publicList 只暴露公开的登录方式元数据', async () => {
    const result = await call('/api/authenticators:publicList');
    expect(result.status).toBe(200);
    const entries = data<Array<Record<string, unknown>>>(result.body);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry).toHaveProperty('name');
      expect(entry).not.toHaveProperty('password');
    }
  });
});

suite('真实后端：请求边界证据', () => {
  it('本次全部真实请求都在允许清单内（无拦截、无写入动作）', () => {
    const counts = getRequestCounts();
    expect(counts.blocked).toBe(0);
    expect(counts.allowed).toBeGreaterThan(0);
    expect(() => assertNoBlockedRequests()).not.toThrow();
    // 产品默认目标已切到 13000；本套件显式固定 P1 实例，两者不得混同。
    expect(POLICY.backendOrigin).toBe('http://172.16.88.250:13000');
    expect(LIVE_ORIGIN).toBe('http://172.16.88.250:13080');
    const origins = new Set(getRequestLog().map((entry) => entry.policyMode));
    expect([...origins]).toEqual(['strict']);
  });
});
