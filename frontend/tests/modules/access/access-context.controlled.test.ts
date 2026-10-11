import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  getAuthContext,
  getHttpClient,
  onRoleInvalid,
  onSessionExpired,
  resetAuthContext,
  setApiBase,
  setAuthContext,
  setTransportMode,
} from '../../../src/api/client';
import { installTransportGuard } from '../../../src/api/transportGuard';
import { updateUser } from '../../../src/modules/access/operations';
import { lastRequest, startControlledServer, type ControlledServer } from './controlled-server';

/**
 * 组 B 受控写验证（浏览器环境：真实请求头 + 身份上下文隔离）。
 *
 * 为什么单独一个文件：产品客户端的会话存储是 `CrewloomSessionStorage`（读写 `window.localStorage`），
 * 只有在浏览器环境里令牌与角色才实际生效；node 环境下存储是空操作，
 * 因此"Authorization 头"和"旧角色 401 不覆盖新角色"这两项必须在这里验证。
 *
 * 受控服务只绑定 127.0.0.1 随机端口；不为跨来源放宽产品装配，
 * 而是在测试里显式把该来源加入允许清单（`installTransportGuard` 的公开参数）。
 */
let server: ControlledServer;

beforeAll(async () => {
  server = await startControlledServer();
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  server.reset();
  window.localStorage.clear();
  setApiBase(server.baseURL);
  setTransportMode('product');
  // 产品装配只允许同源；受控服务是另一个来源，因此按测试需要显式声明允许来源。
  installTransportGuard(getHttpClient(), {
    baseURL: server.baseURL,
    originBase: '',
    allowedOrigins: [server.origin],
    mode: 'product',
  });
  setAuthContext({ token: 'controlled-token', role: 'r_test', authenticator: 'basic' });
});

afterEach(() => {
  resetAuthContext();
  setApiBase('/api');
  window.localStorage.clear();
});

describe('真实请求头', () => {
  it('写入请求携带 Bearer 与 X-Data-Source', async () => {
    server.respond(() => ({ body: { data: { id: 7 } } }));
    await updateUser(7, { nickname: '受控写入' });

    const request = lastRequest(server, 'users:update');
    expect(request?.hasAuthorization).toBe(true);
    expect(request?.dataSourceHeader).toBe('main');
  });
});

describe('身份上下文隔离', () => {
  it('切换身份后，旧角色上下文的 401 不广播角色/会话失效，也不清掉新身份', async () => {
    let release: (() => void) | undefined;
    server.respond(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ status: 401, body: { errors: [{ message: 'role', code: 'ROLE_NOT_FOUND_FOR_USER' }] } });
        }),
    );

    const roleCodes: string[] = [];
    const sessionKinds: string[] = [];
    const offRole = onRoleInvalid((error) => roleCodes.push(error.code ?? ''));
    const offSession = onSessionExpired((error) => sessionKinds.push(error.kind));

    setAuthContext({ token: 'token-a', role: 'r_old' });
    const pending = updateUser(7, { nickname: 'x' }).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 期间发生身份切换（新令牌 + 新角色上下文）。
    setAuthContext({ token: 'token-b', role: 'r_new' });
    release?.();
    await pending;

    offRole();
    offSession();

    expect(roleCodes).toEqual([]);
    expect(sessionKinds).toEqual([]);
    expect(getAuthContext().token).toBe('token-b');
    expect(getAuthContext().role).toBe('r_new');
  });

  it('当前角色的 403 只作为权限拒绝，不广播会话失效', async () => {
    server.respond(() => ({ status: 403, body: { errors: [{ message: 'No permissions' }] } }));
    const sessionKinds: string[] = [];
    const off = onSessionExpired((error) => sessionKinds.push(error.kind));
    await expect(updateUser(7, { nickname: 'x' })).rejects.toMatchObject({ kind: 'forbidden' });
    off();
    expect(sessionKinds).toEqual([]);
  });
});
