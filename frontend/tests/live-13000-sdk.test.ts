// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { APIClient } from '@nocobase/sdk';
import { describe, expect, it } from 'vitest';
import { installTransportGuard } from '../src/api/transportGuard';
import { PRODUCT_BACKEND_ORIGIN } from '../src/api/policy';

/**
 * **实际 SDK** 对 13000（NocoBase 2.2.20）的定向补验。
 *
 * 为什么单独一个文件：准备轮对 13000 的 170 次核对是**直接 REST（fetch + 手写头）**，
 * 不能据此声称"SDK 在 2.2.20 上全部通过"。这里用产品真正依赖的
 * `@nocobase/sdk@2.2.22` 的 `APIClient` 走一遍：
 *  1. 少量安全读取（登录 / 角色 / 会话列表 / 流程列表）；
 *  2. **受控 adapter** 下的写入序列化形状（不发真实写入）。
 *
 * 边界：严格传输模式；只允许只读 GET 与正常登录/退出；不写任何真实业务数据；
 * 凭据只在进程内存里从 `.secrets/full-pages-13000-20261011.json`（0600）读取，不打印。
 * 缺少凭据或后端不可达时整体跳过。
 */

/**
 * 凭据只在主工作区保存，分工作树不复制：先从本工作树找，找不到再回退到主工作区。
 * 两处都不存在时整体跳过（不猜路径、不用默认口令）。
 */
const SECRET_CANDIDATES = [
  resolve(process.cwd(), '../.secrets/full-pages-13000-20261011.json'),
  resolve(process.cwd(), '../../../.secrets/full-pages-13000-20261011.json'),
];

interface SecretFile {
  apiBaseURL: string;
  email: string;
  password: string;
}

let secrets: SecretFile | null = null;
for (const candidate of SECRET_CANDIDATES) {
  try {
    secrets = JSON.parse(readFileSync(candidate, 'utf8')) as SecretFile;
    break;
  } catch {
    secrets = null;
  }
}

const ORIGIN = (() => {
  if (!secrets) return PRODUCT_BACKEND_ORIGIN;
  const raw = String(secrets.apiBaseURL).replace(/\/+$/, '');
  return raw.endsWith('/api') ? raw.slice(0, -'/api'.length) : raw;
})();

/** 用与产品相同的装配方式建一个指向 13000 的 SDK 客户端（严格模式）。 */
function createClient(
  base: string,
  mode: 'strict' | 'product' = 'strict',
): { client: APIClient; blocked: () => number } {
  const client = new APIClient({ baseURL: base });
  const guard = installTransportGuard(client.axios, {
    baseURL: base,
    originBase: '',
    allowedOrigins: [ORIGIN],
    mode,
  });
  return { client, blocked: () => guard.counts().blocked };
}

async function reachable(): Promise<boolean> {
  try {
    const response = await fetch(`${ORIGIN}/api/authenticators:publicList`, {
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const enabled = secrets !== null && (await reachable());
const suite = enabled ? describe : describe.skip;

suite('实际 SDK（@nocobase/sdk）对 13000 的只读补验', () => {
  it('SDK 登录 → 读取身份/角色/会话/流程，并在退出后撤销令牌', async () => {
    const { client, blocked } = createClient(`${ORIGIN}/api`);

    const signIn = await client.request({
      url: 'auth:signIn',
      method: 'post',
      data: { email: secrets!.email, password: secrets!.password },
    });
    expect(signIn.status).toBe(200);
    const token = (signIn.data as { data?: { token?: string } })?.data?.token;
    expect(typeof token).toBe('string');
    client.auth.setToken(token as string);

    const authCheck = await client.request({ url: 'auth:check', method: 'get' });
    expect(authCheck.status).toBe(200);
    expect((authCheck.data as { data?: { id?: number } })?.data?.id).toBeTruthy();

    const conversations = await client.resource('aiConversations').list({ pageSize: 1 });
    expect(conversations.status).toBe(200);

    const workflows = await client.resource('workflows').list({ pageSize: 1 });
    expect(workflows.status).toBe(200);

    const signOut = await client.request({ url: 'auth:signOut', method: 'post', data: {} });
    expect(signOut.status).toBe(200);
    await expect(client.request({ url: 'auth:check', method: 'get' })).rejects.toMatchObject({
      response: { status: 401 },
    });

    // 全程没有任何请求被严格策略拦截。
    expect(blocked()).toBe(0);
  });

  it('SDK 写入序列化形状（受控 adapter，不发真实写入）', async () => {
    // 受控 adapter 不会产生真实网络流量，用产品模式验证序列化形状本身。
    const { client } = createClient(`${ORIGIN}/api`, 'product');
    const captured: Array<{ method?: string; url?: string; data?: unknown; params?: unknown }> = [];
    client.axios.defaults.adapter = async (config) => {
      captured.push({
        method: config.method,
        url: config.url,
        data: config.data,
        params: config.params,
      });
      return {
        data: { data: { id: 1 } },
        status: 200,
        statusText: '200',
        headers: {},
        config,
      };
    };

    // 关联资源动作 + filterByTk + values 是三个业务模块最常用的写入形态。
    await client
      .resource('workflows.flow_nodes', 42)
      ['update']({ filterByTk: 7, values: { title: '受控形状' } }, { method: 'post' } as never);

    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe('post');
    expect(captured[0].url).toBe('workflows/42/flow_nodes:update');
    expect(captured[0].params).toMatchObject({ filterByTk: 7 });
    // 实测形状（SDK 2.2.22，受控 adapter 实测）：`values` 不被包成 {values:{...}}，
    // 而是**展开为请求体本身**；filterByTk 走查询串。三组写实现必须按这个事实写。
    const body = captured[0].data;
    const parsed = typeof body === 'string' ? JSON.parse(body) : body;
    expect(parsed).toEqual({ title: '受控形状' });
  });
});
