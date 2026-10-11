import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  api,
  getAuthContext,
  getHttpClient,
  getTransportCounts,
  getTransportMode,
  onNewToken,
  onRoleInvalid,
  onSessionExpired,
  resetAuthContext,
  setAuthContext,
  setApiBase,
  setTransportMode,
} from '../src/api/client';
import { CrewloomError } from '../src/api/errors';
import { signIn, signOut } from '../src/auth/api';
import { combineUrl } from '../src/api/transportGuard';
import { resolveApiBase, resourceActionPath } from '../src/api/url';

/**
 * 请求层定向测试：真实 axios/SDK 请求管线 + 受控 adapter。
 *
 * 验证：入口来自 `@nocobase/sdk` 的 `APIClient`；Bearer / X-Authenticator / X-Role /
 * X-Data-Source 头由 SDK Auth 注入；get/check/list 走 GET、登录退出走 POST；
 * values 进请求体、filter 进查询串、{data,meta} 解析；成功与错误响应的 x-new-token；
 * 401 的角色失效与会话失效分开；旧会话响应不污染新会话；传输层允许清单在发出前拦截。
 */

interface Captured {
  data?: unknown;
  params?: unknown;
  headers: Record<string, unknown>;
  method?: string;
  url?: string;
  baseURL?: string;
  fullUrl: string;
}

interface Reply {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

let captured: Captured[] = [];
let handler: (config: InternalAxiosRequestConfig) => Reply | Promise<Reply> = () => ({ body: { data: {} } });

function installAdapter(): void {
  const client = getHttpClient();
  client.defaults.adapter = async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
    const headers = { ...(config.headers as unknown as Record<string, unknown>) };
    captured.push({
      data: config.data,
      params: config.params,
      headers,
      method: config.method,
      url: config.url,
      baseURL: config.baseURL,
      fullUrl: combineUrl(config.baseURL, config.url ?? ''),
    });
    const reply = await handler(config);
    const status = reply.status ?? 200;
    const response: AxiosResponse = {
      data: reply.body,
      status,
      statusText: String(status),
      headers: reply.headers ?? {},
      config,
    };
    if (status >= 400) {
      throw new AxiosError(
        `Request failed with status code ${status}`,
        'ERR_BAD_REQUEST',
        config,
        undefined,
        response,
      );
    }
    return response;
  };
}

function replyWith(reply: Reply): void {
  handler = () => reply;
}

function failNetwork(message = 'Network Error'): void {
  handler = () => {
    throw new AxiosError(message, 'ERR_NETWORK');
  };
}

beforeEach(() => {
  window.localStorage.clear();
  setApiBase('/api');
  resetAuthContext();
  // 模拟应用已读取 authenticators:publicList 并确定了认证方式。
  setAuthContext({ authenticator: 'basic' });
  captured = [];
  handler = () => ({ body: { data: {} } });
  installAdapter();
});

afterEach(() => {
  resetAuthContext();
  window.localStorage.clear();
});

describe('地址、方法与会话存储', () => {
  it('基地址缺省为 /api，并去掉多余斜杠', () => {
    expect(resolveApiBase(undefined)).toBe('/api');
    expect(resolveApiBase('')).toBe('/api');
    expect(resolveApiBase('https://example.test/api/')).toBe('https://example.test/api');
  });

  it('资源动作路径为 <base>/<resource>:<action>（由 SDK 的 baseURL + 相对 url 组成）', () => {
    expect(resourceActionPath('/api', 'auth', 'signIn')).toBe('/api/auth:signIn');
  });

  it('get/check/list 用 GET，登录与退出用 POST', async () => {
    setAuthContext({ token: 'token-a', role: null });
    replyWith({ body: { data: { ok: true } } });

    await api.resourceAction('auth', 'check');
    await api.resourceAction('roles', 'check');
    await api.resourceAction('workflows', 'list');
    await api.resourceAction('auth', 'signIn', { values: { email: 'a@b.test', password: 'x' } });

    expect(captured[0].method).toBe('get');
    expect(captured[1].method).toBe('get');
    expect(captured[2].method).toBe('get');
    expect(captured[3].method).toBe('post');
    expect(captured[3].fullUrl).toBe('/api/auth:signIn');
    expect(captured[3].data).toBe(JSON.stringify({ email: 'a@b.test', password: 'x' }));
  });

  it('values 进请求体，filter 序列化为查询串，pageSize 等原样保留', async () => {
    setAuthContext({ token: 'token-a', role: null });
    replyWith({ body: { data: [] } });

    await api.resourceAction('workflows', 'list', {
      params: { filter: { name: 'x' }, page: 1, pageSize: 20, sort: ['-createdAt'] },
    });

    expect(captured[0].method).toBe('get');
    expect(captured[0].params).toEqual({
      page: 1,
      pageSize: 20,
      sort: ['-createdAt'],
      filter: JSON.stringify({ name: 'x' }),
    });
  });

  it('关联资源路径为 <base>/<parent>/<id>/<child>:<action>', async () => {
    setAuthContext({ token: 'token-a', role: null });
    replyWith({ body: { data: [] } });

    await api.associatedAction('users', 2, 'roles', 'list');

    expect(captured[0].fullUrl).toBe('/api/users/2/roles:list');
    expect(captured[0].method).toBe('get');
  });

  it('SDK 负责把 token/role 持久化到 crewloom.session.* 键', () => {
    setAuthContext({ token: 'persisted-token', role: 'crewloom_p1_limited' });
    expect(window.localStorage.getItem('crewloom.session.token')).toBe('persisted-token');
    expect(window.localStorage.getItem('crewloom.session.role')).toBe('crewloom_p1_limited');
    resetAuthContext();
    expect(window.localStorage.getItem('crewloom.session.token')).toBeNull();
    expect(window.localStorage.getItem('crewloom.session.role')).toBeNull();
  });
});

describe('请求头由 SDK Auth 注入', () => {
  it('携带 Bearer、X-Authenticator 与 X-Data-Source，未选择角色时不带 X-Role', async () => {
    setAuthContext({ token: 'token-b', role: null });
    replyWith({ body: { data: {} } });

    await api.resourceAction('auth', 'check');

    expect(captured[0].headers.Authorization).toBe('Bearer token-b');
    expect(captured[0].headers['X-Authenticator']).toBe('basic');
    expect(captured[0].headers['X-Data-Source']).toBe('main');
    expect(captured[0].headers['X-Role']).toBeUndefined();
  });

  it('显式选择角色后携带 X-Role', async () => {
    setAuthContext({ token: 'token-c', role: 'crewloom_p1_limited' });
    replyWith({ body: { data: {} } });

    await api.resourceAction('roles', 'check');

    expect(captured[0].headers['X-Role']).toBe('crewloom_p1_limited');
  });

  it('未登录时不携带 Authorization', async () => {
    resetAuthContext();
    replyWith({ body: { data: {} } });

    await api.resourceAction('authenticators', 'publicList');

    expect(captured[0].headers.Authorization).toBeUndefined();
  });

  it('setRole 后的下一请求实际带上 X-Role', async () => {
    setAuthContext({ token: 'token-role', role: null });
    api.sdk.auth.setRole('crewloom_p1_limited');
    replyWith({ body: { data: {} } });

    await api.resourceAction('roles', 'check');
    expect(captured[0].headers['X-Role']).toBe('crewloom_p1_limited');
  });

  it('登录走 SDK 请求管线：POST auth:signIn、裸 body、带 X-Authenticator，调用本身不写 SDK Auth 存储', async () => {
    replyWith({ body: { data: { token: 'pipeline-token', user: { id: 1, email: 'a@b.test' } } } });

    const result = await signIn({ email: 'a@b.test', password: 'secret' }, 'basic');

    expect(result.token).toBe('pipeline-token');
    expect(captured[0].method).toBe('post');
    expect(captured[0].fullUrl).toBe('/api/auth:signIn');
    expect(captured[0].data).toBe(JSON.stringify({ email: 'a@b.test', password: 'secret' }));
    expect(captured[0].headers['X-Authenticator']).toBe('basic');
    // 关键边界：登录请求本身不在 SDK Auth 层写存储；写入由 auth store 在操作 ID 校验之后完成。
    expect(getAuthContext().token).toBeNull();
    expect(window.localStorage.getItem('crewloom.session.token')).toBeNull();
  });

  it('退出走 SDK 请求管线：POST auth:signOut，调用本身不清 SDK Auth 存储', async () => {
    setAuthContext({ token: 'token-out', role: 'crewloom_p1_admin', authenticator: 'basic' });
    replyWith({ body: { data: null } });

    await signOut();

    expect(captured[0].method).toBe('post');
    expect(captured[0].fullUrl).toBe('/api/auth:signOut');
    // 清理由 auth store 在操作 ID 校验之后执行，避免旧退出响应清掉新会话。
    expect(getAuthContext().token).toBe('token-out');
    expect(getAuthContext().role).toBe('crewloom_p1_admin');
  });
});

describe('响应封套与续期', () => {
  it('解析 {data,meta}', async () => {
    setAuthContext({ token: 'token-d', role: null });
    replyWith({
      body: { data: [{ id: 1 }], meta: { count: 12, page: 1, pageSize: 20, totalPage: 1 } },
    });

    const result = await api.resourceAction<Array<{ id: number }>>('workflows', 'list');

    expect(result.data).toEqual([{ id: 1 }]);
    expect(result.meta?.count).toBe(12);
  });

  it('成功响应读取 x-new-token 并通过续期回调更新令牌', async () => {
    setAuthContext({ token: 'old-token', role: null });
    replyWith({ body: { data: { id: 1 } }, headers: { 'x-new-token': 'renewed-token' } });

    const seen: string[] = [];
    const unsubscribe = onNewToken((token) => seen.push(token));
    await api.resourceAction('auth', 'check');
    unsubscribe();

    expect(seen).toEqual(['renewed-token']);
    expect(api.sdk.auth.token).toBe('renewed-token');
  });

  it('错误响应（401 会话失效）也读取 x-new-token，再按会话失效清理', async () => {
    setAuthContext({ token: 'old-token', role: null });
    replyWith({
      status: 401,
      body: { errors: [{ message: 'EXPIRED_TOKEN', code: 'EXPIRED_TOKEN' }] },
      headers: { 'x-new-token': 'renewed-on-error' },
    });

    const seen: string[] = [];
    const unsubscribe = onNewToken((token) => seen.push(token));
    await expect(api.resourceAction('auth', 'check')).rejects.toMatchObject({ kind: 'unauthenticated' });
    unsubscribe();

    expect(seen).toEqual(['renewed-on-error']);
  });
});

describe('401 的角色失效与会话失效分开', () => {
  it('ROLE_NOT_FOUND_FOR_USER → role-invalid；保留令牌、不广播会话失效', async () => {
    setAuthContext({ token: 'keep-me', role: 'crewloom_p1_limited' });
    replyWith({
      status: 401,
      body: { errors: [{ message: 'The role does not belong to the user', code: 'ROLE_NOT_FOUND_FOR_USER' }] },
    });

    const sessionKinds: string[] = [];
    const roleCodes: string[] = [];
    const un1 = onSessionExpired((error) => sessionKinds.push(error.kind));
    const un2 = onRoleInvalid((error) => roleCodes.push(error.code ?? ''));
    await expect(api.resourceAction('roles', 'check')).rejects.toMatchObject({ kind: 'role-invalid' });
    un1();
    un2();

    expect(sessionKinds).toEqual([]);
    expect(roleCodes).toEqual(['ROLE_NOT_FOUND_FOR_USER']);
    expect(getAuthContext().token).toBe('keep-me');
  });

  it('ROLE_NOT_FOUND_ERR 同样按角色失效处理', async () => {
    setAuthContext({ token: 'keep-me', role: null });
    replyWith({
      status: 401,
      body: { errors: [{ message: 'The user role does not exist', code: 'ROLE_NOT_FOUND_ERR' }] },
    });
    await expect(api.resourceAction('roles', 'check')).rejects.toMatchObject({ kind: 'role-invalid' });
  });

  it('EXPIRED_SESSION → unauthenticated 并广播会话失效', async () => {
    setAuthContext({ token: 'token-f', role: null });
    replyWith({ status: 401, body: { errors: [{ message: 'EXPIRED_SESSION', code: 'EXPIRED_SESSION' }] } });

    const kinds: string[] = [];
    const unsubscribe = onSessionExpired((error) => kinds.push(error.kind));

    await expect(api.resourceAction('auth', 'check')).rejects.toBeInstanceOf(CrewloomError);
    unsubscribe();
    expect(kinds).toEqual(['unauthenticated']);
  });

  it('USER_HAS_NO_ROLES_ERR 按原生 AuthErrorCode 归为会话失效', async () => {
    setAuthContext({ token: 'token-g', role: null });
    replyWith({
      status: 401,
      body: { errors: [{ message: 'no roles', code: 'USER_HAS_NO_ROLES_ERR' }] },
    });
    await expect(api.resourceAction('auth', 'check')).rejects.toMatchObject({ kind: 'unauthenticated' });
  });
});

describe('旧会话响应不能污染新会话', () => {
  it('会话已变化后，旧响应携带的 x-new-token 被忽略', async () => {
    setAuthContext({ token: 'session-a', role: null });
    let release: ((value: Reply) => void) | undefined;
    handler = () =>
      new Promise<Reply>((resolve) => {
        release = resolve;
      });

    const seen: string[] = [];
    const unsubscribe = onNewToken((token) => seen.push(token));
    const pending = api.resourceAction('auth', 'check');
    await new Promise((resolve) => setTimeout(resolve, 0));

    setAuthContext({ token: null, role: null });

    release?.({ body: { data: {} }, headers: { 'x-new-token': 'stale-renewed-token' } });
    await pending;
    unsubscribe();

    expect(seen).toEqual([]);
    expect(getAuthContext().token).toBeNull();
  });

  it('会话已变化后，旧响应的 401 不再触发会话失效或角色失效回调', async () => {
    setAuthContext({ token: 'session-a', role: null });
    let release: ((value: Reply) => void) | undefined;
    handler = () =>
      new Promise<Reply>((resolve) => {
        release = resolve;
      });

    const kinds: string[] = [];
    const roleCodes: string[] = [];
    const un1 = onSessionExpired((error) => kinds.push(error.kind));
    const un2 = onRoleInvalid((error) => roleCodes.push(error.code ?? ''));
    const pending = api.resourceAction('auth', 'check');
    await new Promise((resolve) => setTimeout(resolve, 0));

    setAuthContext({ token: 'session-b', role: null });

    release?.({ status: 401, body: { errors: [{ message: 'EMPTY_TOKEN', code: 'EMPTY_TOKEN' }] } });
    await expect(pending).rejects.toMatchObject({ kind: 'unauthenticated' });
    un1();
    un2();

    expect(kinds).toEqual([]);
    expect(roleCodes).toEqual([]);
    expect(getAuthContext().token).toBe('session-b');
  });

  it('同一会话内（仅切换角色）仍会采纳 x-new-token 续期', async () => {
    setAuthContext({ token: 'session-c', role: null });
    replyWith({ body: { data: {} }, headers: { 'x-new-token': 'renewed-in-session' } });
    const seen: string[] = [];
    const unsubscribe = onNewToken((token) => seen.push(token));
    await api.resourceAction('auth', 'check');
    unsubscribe();
    expect(seen).toEqual(['renewed-in-session']);
  });
});

describe('错误分类', () => {
  it('403 抛出 forbidden，不触发会话或角色失效回调', async () => {
    setAuthContext({ token: 'token-e', role: null });
    replyWith({ status: 403, body: { errors: [{ message: 'No permissions' }] } });

    let expired = false;
    const unsubscribe = onSessionExpired(() => {
      expired = true;
    });

    await expect(api.resourceAction('dataSources', 'list')).rejects.toMatchObject({ kind: 'forbidden' });
    unsubscribe();
    expect(expired).toBe(false);
  });

  it('网络错误归类为 network', async () => {
    setAuthContext({ token: 'token-g', role: null });
    failNetwork();

    await expect(api.resourceAction('auth', 'check')).rejects.toMatchObject({ kind: 'network' });
  });

  it('5xx 归类为 backend-unavailable（未知，不等于拒绝）', async () => {
    setAuthContext({ token: 'token-h', role: null });
    replyWith({ status: 503, body: { errors: [{ message: 'unavailable' }] } });

    await expect(api.resourceAction('dataSources', 'list')).rejects.toMatchObject({
      kind: 'backend-unavailable',
    });
  });
});

describe('传输层允许清单在实际发出前生效（严格验证模式）', () => {
  // 应用缺省是 product（真实用户必须能保存）；自动验证才切到 strict。
  beforeEach(() => {
    setTransportMode('strict');
  });

  afterEach(() => {
    setTransportMode('product');
  });

  it('未列入清单的动作被拦截，且 adapter 完全没有收到请求', async () => {
    setAuthContext({ token: 'token-i', role: null });
    replyWith({ body: { data: {} } });

    await expect(api.resourceAction('users', 'create', { values: { nickname: 'x' } })).rejects.toMatchObject({
      kind: 'unexpected',
    });
    expect(captured).toHaveLength(0);
    const counts = getTransportCounts();
    expect(counts.blocked).toBeGreaterThan(0);
  });

  it('只读动作被写成 POST 时同样被拦截', async () => {
    setAuthContext({ token: 'token-j', role: null });
    replyWith({ body: { data: {} } });

    await expect(
      api.request({ url: '/auth:check', method: 'post' }),
    ).rejects.toMatchObject({ kind: 'unexpected' });
    expect(captured).toHaveLength(0);
  });

  it('允许清单内的只读 GET 正常发出并记录为真实请求', async () => {
    setAuthContext({ token: 'token-k', role: null });
    replyWith({ body: { data: {} } });

    await api.resourceAction('auth', 'check');

    expect(captured).toHaveLength(1);
    const counts = getTransportCounts();
    expect(counts.real).toBeGreaterThan(0);
  });

  it('外部副作用动作即使被写进清单也会在严格模式下硬拦', async () => {
    setAuthContext({ token: 'token-l', role: null });
    replyWith({ body: { data: {} } });

    await expect(api.request({ url: '/ai:listModels', method: 'get' })).rejects.toMatchObject({
      kind: 'unexpected',
    });
    await expect(
      api.request({ url: '/aiMcpClients:listTools', method: 'post' }),
    ).rejects.toMatchObject({ kind: 'unexpected' });
    expect(captured).toHaveLength(0);
    expect(getTransportMode()).toBe('strict');
  });
});

describe('产品模式：真实用户可以保存（自动验证之外的正常使用）', () => {
  it('产品动作可以走到 adapter，由后端认证与 ACL 最终判定', async () => {
    setTransportMode('product');
    setAuthContext({ token: 'token-m', role: null });
    replyWith({ body: { data: { id: 7 } } });
    const blockedBefore = getTransportCounts().blocked;

    const result = await api.resourceAction<{ id: number }>('users', 'create', {
      values: { nickname: '真实用户提交' },
    });

    expect(result.data).toEqual({ id: 7 });
    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe('post');
    // 传输日志是跨用例累计的，这里只断言本次没有新增拦截。
    expect(getTransportCounts().blocked).toBe(blockedBefore);
  });

  it('产品模式仍然拦截跨来源地址（固定后端目标不变）', async () => {
    setTransportMode('product');
    setAuthContext({ token: 'token-n', role: null });
    replyWith({ body: { data: {} } });

    await expect(
      api.request({ url: 'http://192.0.2.10/api/users:create', method: 'post' }),
    ).rejects.toMatchObject({ kind: 'unexpected' });
    expect(captured).toHaveLength(0);
  });
});
