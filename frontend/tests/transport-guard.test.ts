import axios, { type AxiosResponse } from 'axios';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearTransportLog,
  decideRequest,
  getTransportLog,
  installTransportGuard,
  parseAction,
  TRANSPORT_POLICY,
} from '../src/api/transportGuard';

/**
 * 传输层允许清单单测：目的地、方法与动作都在请求发出前判定；
 * 被拒绝的请求不会进入 adapter（即不会产生网络请求），并被记录。
 */

const BROWSER_ORIGIN = 'http://127.0.0.1:5273';

function config(overrides: Record<string, unknown> = {}) {
  return {
    baseURL: '/api',
    url: 'auth:check',
    method: 'get',
    headers: {},
    ...overrides,
  } as never;
}

const options = { baseURL: '/api', originBase: BROWSER_ORIGIN };

beforeEach(() => {
  clearTransportLog();
});

afterEach(() => {
  clearTransportLog();
});

describe('动作解析', () => {
  it('从路径解析 resource:action', () => {
    expect(parseAction('/api/auth:check')).toEqual({ resource: 'auth', action: 'check' });
    expect(parseAction('/api/users/2/roles:list')).toEqual({ resource: 'roles', action: 'list' });
    expect(parseAction('/api/userWorkflowTaskStats:listMine')).toEqual({
      resource: 'userWorkflowTaskStats',
      action: 'listMine',
    });
    expect(parseAction('/api/mock/rotate-token')).toBeNull();
  });
});

describe('允许清单判定', () => {
  it('允许清单内的只读 GET 通过', () => {
    expect(decideRequest(config(), options).decision).toBe('allowed');
    expect(decideRequest(config({ url: 'roles:check' }), options).decision).toBe('allowed');
    expect(decideRequest(config({ url: 'authenticators:publicList' }), options).decision).toBe('allowed');
  });

  it('正常登录与退出（POST）通过', () => {
    expect(
      decideRequest(config({ url: 'auth:signIn', method: 'post' }), options).decision,
    ).toBe('allowed');
    expect(
      decideRequest(config({ url: 'auth:signOut', method: 'post' }), options).decision,
    ).toBe('allowed');
  });

  it('只读动作被写成 POST 时拒绝', () => {
    const decision = decideRequest(config({ url: 'auth:check', method: 'post' }), options);
    expect(decision.decision).toBe('blocked');
    expect(decision.reason).toBe('read-action-must-be-get');
  });

  it('登录/退出被写成 GET 时拒绝', () => {
    const decision = decideRequest(config({ url: 'auth:signIn', method: 'get' }), options);
    expect(decision.decision).toBe('blocked');
    expect(decision.reason).toBe('write-action-must-be-post');
  });

  it('业务写入动作（create/update/destroy/setDefaultRole/setSystemRoleMode）一律拒绝', () => {
    for (const action of [
      { url: 'users:create', method: 'post' },
      { url: 'users:update', method: 'post' },
      { url: 'users:destroy', method: 'post' },
      { url: 'users:setDefaultRole', method: 'post' },
      { url: 'roles:setSystemRoleMode', method: 'post' },
      { url: 'collections:setup', method: 'post' },
      { url: 'plugins:enable', method: 'post' },
    ]) {
      const decision = decideRequest(config(action), options);
      expect(decision.decision, action.url).toBe('blocked');
      expect(decision.reason).toBe('action-not-allowlisted');
    }
  });

  it('写动作即使伪装成 GET 也不放行', () => {
    const decision = decideRequest(config({ url: 'users:create', method: 'get' }), options);
    expect(decision.decision).toBe('blocked');
    expect(decision.reason).toBe('action-not-allowlisted');
  });

  it('浏览器侧只允许与页面同源的地址；直连其它来源被拒绝', () => {
    const absolute = decideRequest(
      config({ baseURL: '', url: `${TRANSPORT_POLICY.backendOrigin}/api/auth:check` }),
      options,
    );
    expect(absolute.decision).toBe('blocked');
    expect(absolute.reason).toBe('destination-not-allowed');

    const other = decideRequest(
      config({ baseURL: '', url: 'http://127.0.0.1:13000/api/auth:check' }),
      options,
    );
    expect(other.decision).toBe('blocked');
  });
});

describe('安装到 axios 实例后的真实拦截', () => {
  it('被拒绝的请求不会到达 adapter，并写入拦截记录', async () => {
    const instance = axios.create({ baseURL: '/api' });
    let adapterCalls = 0;
    instance.defaults.adapter = async (requestConfig): Promise<AxiosResponse> => {
      adapterCalls += 1;
      return {
        data: { data: {} },
        status: 200,
        statusText: '200',
        headers: {},
        config: requestConfig,
      } as AxiosResponse;
    };
    installTransportGuard(instance, options);

    await expect(
      instance.request({ url: 'users:create', method: 'post', data: { nickname: 'x' } }),
    ).rejects.toMatchObject({ code: 'TRANSPORT_BLOCKED' });
    expect(adapterCalls).toBe(0);

    const entries = getTransportLog();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      method: 'post',
      path: '/api/users:create',
      action: 'users:create',
      decision: 'blocked',
      status: null,
    });
    // 不记录凭据或响应正文。
    expect(JSON.stringify(entries[0])).not.toMatch(/nickname|Bearer/);
  });

  it('允许的请求进入 adapter，并按响应头标记真实/受控', async () => {
    const instance = axios.create({ baseURL: '/api' });
    const headers: Record<string, string>[] = [];
    let mockResponse = false;
    instance.defaults.adapter = async (requestConfig): Promise<AxiosResponse> => {
      headers.push({ ...(requestConfig.headers as unknown as Record<string, string>) });
      return {
        data: { data: {} },
        status: 200,
        statusText: '200',
        headers: mockResponse ? { 'x-crewloom-mock': '1' } : {},
        config: requestConfig,
      } as AxiosResponse;
    };
    installTransportGuard(instance, options);

    await instance.request({ url: 'auth:check', method: 'get', headers: { Authorization: 'Bearer secret' } });
    mockResponse = true;
    await instance.request({ url: 'roles:check', method: 'get' });

    const entries = getTransportLog();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ decision: 'allowed', status: 200, mode: 'real' });
    expect(entries[1]).toMatchObject({ decision: 'allowed', status: 200, mode: 'mock' });
    // 记录里没有令牌。
    expect(JSON.stringify(entries)).not.toContain('secret');
  });
});
