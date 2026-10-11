import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  getAuthContext,
  getHttpClient,
  onRoleInvalid,
  onSessionExpired,
  resetAuthContext,
  setApiBase,
} from '../src/api/client';
import { useSessionStore } from '../src/auth/store';
import type { AccessControlData, UserRoleSummary } from '../src/auth/types';

/**
 * 认证异步边界的受控行为回归（真实 store + 真实 SDK 请求层 + 受控 adapter）。
 *
 * 这里**不 mock** `src/auth/api` 与 `src/api/client`，只把 axios 的 adapter 换成受控实现，
 * 并用与 `App.tsx` 相同的方式接线 `onSessionExpired` / `onRoleInvalid` 广播。
 * 覆盖两条实际 P1 可达链：
 *  A. 退出请求延迟返回期间发生真正的会话失效并登录了另一个账号 → 旧退出不得清掉新账号；
 *  B. 角色 A 的旧请求晚到并返回原生角色错误 → 不得清掉/改回已切到的合法角色 B。
 */

vi.mock('../src/permissions/probes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/permissions/probes')>();
  return { ...actual, runAccessProbes: async () => ({ 'workbench.read': { status: 'allowed' as const } }) };
});

const ACCOUNTS: Record<string, { id: number; email: string; roles: UserRoleSummary[]; token: string }> = {
  'alice@test': {
    id: 11,
    email: 'alice@test',
    token: 'token-alice',
    roles: [{ name: 'role_alice', title: 'Alice 角色' }],
  },
  'bob@test': {
    id: 22,
    email: 'bob@test',
    token: 'token-bob',
    roles: [{ name: 'role_admin', title: '配置权限' }],
  },
  'multi@test': {
    id: 33,
    email: 'multi@test',
    token: 'token-multi',
    roles: [
      { name: 'role_admin', title: '配置权限' },
      { name: 'role_limited', title: '受限用户' },
    ],
  },
};

function accessFor(role: string): AccessControlData {
  return {
    role,
    roleMode: 'default',
    strategy: null,
    actions: {},
    resources: [],
    snippets: role === 'role_admin' ? ['pm', 'pm.*', 'ui.*'] : [],
    allowAll: false,
    allowConfigure: false,
    allowAnonymous: false,
    allowMenuItemIds: [],
    uiButtonSchemasBlacklist: [],
    availableActions: ['view'],
    actionAlias: { list: 'view' },
    roles: [role],
  };
}

interface Captured {
  method: string;
  url: string;
  role: string | null;
  authorization: string | null;
  authenticator: string | null;
}

let captured: Captured[] = [];
let gates: Map<string, (value: { status?: number; body: unknown }) => void>;
let forceRoleError: { url: string; code: string } | null = null;
let signOutStatus = 200;

function headerValue(headers: unknown, name: string): string | null {
  const record = (headers ?? {}) as Record<string, unknown>;
  const key = Object.keys(record).find((item) => item.toLowerCase() === name);
  const value = key ? record[key] : undefined;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function accountForToken(authorization: string | null): (typeof ACCOUNTS)[string] | null {
  if (!authorization) return null;
  const token = authorization.replace(/^Bearer\s+/i, '');
  return Object.values(ACCOUNTS).find((account) => account.token === token) ?? null;
}

function respond(url: string, headers: unknown, data: unknown): { status: number; body: unknown } {
  const authorization = headerValue(headers, 'authorization');


  if (forceRoleError && url.startsWith(forceRoleError.url)) {
    return { status: 401, body: { errors: [{ message: 'role error', code: forceRoleError.code }] } };
  }
  if (url.startsWith('auth:signIn')) {
    // axios 在 adapter 之前已把 data 序列化为 JSON 字符串
    const parsed = typeof data === 'string' ? (JSON.parse(data) as { email?: string }) : ((data ?? {}) as { email?: string });
    const account = ACCOUNTS[String(parsed.email)] ?? null;
    if (!account) return { status: 401, body: { errors: [{ message: 'bad credentials', code: 'INVALID_TOKEN' }] } };
    return { status: 200, body: { data: { token: account.token, user: { id: account.id, email: account.email } } } };
  }
  if (url.startsWith('auth:signOut')) {
    return { status: signOutStatus, body: { data: null } };
  }
  if (url.startsWith('auth:check')) {
    const account = accountForToken(authorization);
    if (!account) return { status: 401, body: { errors: [{ message: 'EMPTY_TOKEN', code: 'EMPTY_TOKEN' }] } };
    return { status: 200, body: { data: { id: account.id, email: account.email, roles: account.roles } } };
  }
  if (url.startsWith('roles:check')) {
    const account = accountForToken(authorization);
    // 未显式带 X-Role 时，服务端按"用户默认角色，否则第一个角色"解析
    const effectiveRole = headerValue(headers, 'x-role') ?? account?.roles[0]?.name ?? 'role_admin';
    const ownsRole = account?.roles.some((item) => item.name === effectiveRole) ?? false;
    if (!ownsRole) {
      return {
        status: 401,
        body: { errors: [{ message: 'The role does not belong to the user', code: 'ROLE_NOT_FOUND_FOR_USER' }] },
      };
    }
    return { status: 200, body: { data: accessFor(effectiveRole) } };
  }
  // 其余允许清单内的只读探测/查询
  return { status: 200, body: { data: [] } };
}

function installAdapter(): void {
  const client = getHttpClient();
  client.defaults.adapter = async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
    const method = String(config.method ?? 'get').toUpperCase();
    const url = String(config.url ?? '');
    captured.push({
      method,
      url,
      role: headerValue(config.headers, 'x-role'),
      authorization: headerValue(config.headers, 'authorization'),
      authenticator: headerValue(config.headers, 'x-authenticator'),
    });
    const key = `${method} ${url}`;
    const gate = gates.get(key);
    const reply = gate
      ? await new Promise<{ status?: number; body: unknown }>((resolve) => gates.set(key, resolve))
      : respond(url, config.headers, config.data);
    const status = reply.status ?? 200;
    const response: AxiosResponse = {
      data: reply.body,
      status,
      statusText: String(status),
      headers: {},
      config,
    };
    if (status >= 400) {
      throw new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', config, undefined, response);
    }
    return response;
  };
}

/** 让挂起的请求先跑到 adapter 并停在闸门上。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function lastRequest(urlPrefix: string): Captured | undefined {
  return [...captured].reverse().find((item) => item.url.startsWith(urlPrefix));
}

function resetStore() {
  useSessionStore.setState({
    status: 'idle',
    token: null,
    user: null,
    roles: [],
    access: null,
    activeRole: null,
    roleMode: 'default',
    accessState: 'unknown',
    probes: null,
    authenticators: [{ name: 'basic', authType: 'email' }],
    authenticatorState: 'ready',
    notice: null,
    error: null,
    bootDetail: null,
  });
}

let unwire: Array<() => void> = [];

beforeEach(() => {
  window.localStorage.clear();
  setApiBase('/api');
  resetAuthContext();
  resetStore();
  captured = [];
  gates = new Map();
  forceRoleError = null;
  signOutStatus = 200;
  installAdapter();
  // 与 App.tsx 相同的接线：广播 → store 状态机
  unwire = [
    onSessionExpired(() => useSessionStore.getState().handleSessionExpired()),
    onRoleInvalid(() => {
      void useSessionStore.getState().handleRoleInvalid();
    }),
  ];
});

afterEach(() => {
  for (const off of unwire) off();
  unwire = [];
  resetAuthContext();
  window.localStorage.clear();
});

describe('场景 A：旧退出响应晚于换号返回', () => {
  it('旧退出不得清掉新账号；最终 store / SDK 存储 / 下一请求身份都属于新账号', async () => {
    const store = () => useSessionStore.getState();

    // 账号 A 正常登录
    const okA = await store().signIn({ email: 'alice@test', password: 'x' });
    expect(okA).toBe(true);
    expect(getAuthContext().token).toBe('token-alice');

    // 发起正常退出，故意延迟其响应
    gates.set('POST auth:signOut', () => {});
    const signOutPromise = store().signOut();
    await flush();
    expect(captured.some((item) => item.url.startsWith('auth:signOut'))).toBe(true);

    // 另一条受保护请求触发真正的会话失效（经真实 401 广播 → handleSessionExpired）
    forceRoleError = { url: 'aiConversations:list', code: 'EXPIRED_SESSION' };
    await expect(api.resourceAction('aiConversations', 'list')).rejects.toMatchObject({
      kind: 'unauthenticated',
    });
    forceRoleError = null;
    expect(store().status).toBe('anonymous');
    expect(getAuthContext().token).toBeNull();

    // 登录账号 B
    const okB = await store().signIn({ email: 'bob@test', password: 'x' });
    expect(okB).toBe(true);
    expect(store().user?.email).toBe('bob@test');
    expect(getAuthContext().token).toBe('token-bob');

    // 释放 A 的旧退出响应
    gates.get('POST auth:signOut')?.({ status: signOutStatus, body: { data: null } });
    await signOutPromise;
    await flush();

    // 最终状态必须是 B
    expect(store().status).toBe('authenticated');
    expect(store().user?.email).toBe('bob@test');
    expect(getAuthContext().token).toBe('token-bob');
    expect(window.localStorage.getItem('crewloom.session.token')).toBe('token-bob');

    // 下一实际请求的身份头必须是 B 的
    await api.resourceAction('auth', 'check');
    const next = lastRequest('auth:check');
    expect(next?.authorization).toBe('Bearer token-bob');
    expect(next?.role === null || next?.role === 'role_admin').toBe(true);
    expect(next?.role).not.toBe('role_alice');
    expect(next?.authenticator).toBe('basic');
  });
});

describe('场景 B：旧角色上下文的 401 晚到', () => {
  it('不得清掉已切换到的合法角色 B，也不得改回服务端默认角色', async () => {
    const store = () => useSessionStore.getState();

    const ok = await store().signIn({ email: 'multi@test', password: 'x' });
    expect(ok).toBe(true);
    expect(await store().switchRole('role_admin')).toBe(true);
    expect(store().activeRole).toBe('role_admin');

    // 角色 A 上下文的旧请求挂起
    gates.set('GET aiEmployees:listByUser', () => {});
    const stale = api.resourceAction('aiEmployees', 'listByUser');
    await flush();

    // 切到合法角色 B
    expect(await store().switchRole('role_limited')).toBe(true);
    expect(store().activeRole).toBe('role_limited');
    expect(store().access?.role).toBe('role_limited');
    const rolesCheckCount = captured.filter((item) => item.url.startsWith('roles:check')).length;

    // 旧请求以原生角色错误返回
    forceRoleError = { url: 'aiEmployees:listByUser', code: 'ROLE_NOT_FOUND_FOR_USER' };
    gates.get('GET aiEmployees:listByUser')?.({ status: 401, body: { errors: [{ message: 'role', code: 'ROLE_NOT_FOUND_FOR_USER' }] } });
    await expect(stale).rejects.toMatchObject({ kind: 'role-invalid' });
    forceRoleError = null;
    await flush();

    // 角色 B 仍然是当前角色，权限上下文没有被改回默认角色
    expect(store().activeRole).toBe('role_limited');
    expect(store().access?.role).toBe('role_limited');
    expect(store().user?.email).toBe('multi@test');

    // 旧角色 401 不应触发一次"不带 X-Role 重读本人角色"的恢复
    const afterSwitchRolesChecks = captured.slice().filter((item) => item.url.startsWith('roles:check'));
    expect(afterSwitchRolesChecks.length).toBe(rolesCheckCount);

    // 下一实际请求仍带角色 B
    await api.resourceAction('dataSources', 'list');
    const next = lastRequest('dataSources:list');
    expect(next?.role).toBe('role_limited');
    expect(next?.authorization).toBe('Bearer token-multi');
  });

  it('当前角色真正的失效仍然要恢复（不能误阻断）', async () => {
    const store = () => useSessionStore.getState();
    const ok = await store().signIn({ email: 'multi@test', password: 'x' });
    expect(ok).toBe(true);
    expect(await store().switchRole('role_limited')).toBe(true);
    expect(store().activeRole).toBe('role_limited');

    // 当前角色上下文（X-Role=role_limited）的请求返回原生角色错误
    forceRoleError = { url: 'dataSources:list', code: 'ROLE_NOT_FOUND_FOR_USER' };
    await expect(api.resourceAction('dataSources', 'list')).rejects.toMatchObject({ kind: 'role-invalid' });
    forceRoleError = null;
    await flush();

    // 恢复：清掉本地角色选择，回到服务端生效角色（role_admin）
    expect(store().activeRole).toBeNull();
    expect(store().access?.role).toBe('role_admin');
    expect(getAuthContext().token).toBe('token-multi');
  });
});
