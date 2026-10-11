import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getHttpClient, onRoleInvalid, onSessionExpired, resetAuthContext, setApiBase, setAuthContext } from '../src/api/client';
import { ACCESS_PROBES, runAccessProbes } from '../src/permissions/probes';

/**
 * 权限探测三分类测试（真实请求管线 + 受控 adapter）。
 *
 * 关键约束：403 是"明确拒绝"；401（认证/角色失效）、网络与 5xx 都是"无法确认"，
 * 探测必须返回 unknown（不放行、也不显示为无权限），且认证/角色失效事件照常广播。
 */

interface Reply {
  status?: number;
  body: unknown;
  network?: boolean;
}

let responder: (config: InternalAxiosRequestConfig) => Reply = () => ({ body: { data: {} } });

function installAdapter(): void {
  const client = getHttpClient();
  client.defaults.adapter = async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
    const reply = responder(config);
    if (reply.network) throw new AxiosError('Network Error', 'ERR_NETWORK', config);
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

function pathOf(config: InternalAxiosRequestConfig): string {
  return String(config.url ?? '').replace(/^\/+/, '');
}

beforeEach(() => {
  window.localStorage.clear();
  setApiBase('/api');
  resetAuthContext();
  setAuthContext({ token: 'probe-token', role: null });
  responder = () => ({ body: { data: {} } });
  installAdapter();
});

afterEach(() => {
  resetAuthContext();
  window.localStorage.clear();
});

describe('探测结果三分类', () => {
  it('200 → allowed；403 → denied；500/网络 → unknown', async () => {
    responder = (config) => {
      const path = pathOf(config);
      if (path.startsWith('workflows')) return { status: 403, body: { errors: [{ message: 'No permissions' }] } };
      if (path.startsWith('llmServices')) return { status: 500, body: { errors: [{ message: 'boom' }] } };
      if (path.startsWith('aiConversations')) return { network: true, body: {} };
      return { body: { data: {} } };
    };

    const results = await runAccessProbes();

    expect(results['workbench.read'].status).toBe('allowed');
    expect(results['workflow.read'].status).toBe('denied');
    expect(results['model.read'].status).toBe('unknown');
    expect(results['model.read'].reason).toBe('backend-unavailable');
    expect(results['ai.conversations'].status).toBe('unknown');
    expect(results['ai.conversations'].reason).toBe('network');
  });

  it('401 角色失效 → probe 为 unknown，并广播角色失效（不广播会话失效）', async () => {
    responder = (config) => {
      if (pathOf(config).startsWith('dataSources')) {
        return {
          status: 401,
          body: { errors: [{ message: 'role', code: 'ROLE_NOT_FOUND_FOR_USER' }] },
        };
      }
      return { body: { data: {} } };
    };

    const roleEvents: string[] = [];
    const sessionEvents: string[] = [];
    const un1 = onRoleInvalid((error) => roleEvents.push(error.code ?? ''));
    const un2 = onSessionExpired((error) => sessionEvents.push(error.kind));
    const results = await runAccessProbes();
    un1();
    un2();

    expect(results['datasource.read'].status).toBe('unknown');
    expect(results['datasource.read'].reason).toBe('role-invalid');
    expect(roleEvents).toEqual(['ROLE_NOT_FOUND_FOR_USER']);
    expect(sessionEvents).toEqual([]);
  });

  it('401 会话失效 → probe 为 unknown，并广播会话失效', async () => {
    responder = (config) => {
      if (pathOf(config).startsWith('aiEmployees:listByUser')) {
        return { status: 401, body: { errors: [{ message: 'EXPIRED_SESSION', code: 'EXPIRED_SESSION' }] } };
      }
      return { body: { data: {} } };
    };

    const sessionEvents: string[] = [];
    const un = onSessionExpired((error) => sessionEvents.push(error.kind));
    const results = await runAccessProbes();
    un();

    expect(results['ai.use'].status).toBe('unknown');
    expect(results['ai.use'].reason).toBe('unauthenticated');
    expect(sessionEvents).toEqual(['unauthenticated']);
  });

  it('每次探测都只发 GET，且路径为原生资源动作', async () => {
    const methods = new Set<string>();
    const paths: string[] = [];
    const client = getHttpClient();
    const original = client.defaults.adapter as (config: InternalAxiosRequestConfig) => Promise<AxiosResponse>;
    client.defaults.adapter = async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
      methods.add(String(config.method));
      paths.push(pathOf(config));
      return original(config);
    };

    await runAccessProbes();

    expect(Array.from(methods)).toEqual(['get']);
    expect(paths.map((path) => path.replace(/^\/+/, ''))).toEqual(
      ACCESS_PROBES.map((probe) => probe.path.replace(/^\/+/, '')),
    );
  });
});
