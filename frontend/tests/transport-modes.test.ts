import { describe, expect, it } from 'vitest';
import {
  ACTION_FRAGMENTS,
  decideApiRequest,
  isStrictDeniedAction,
  parseApiAction,
  PRODUCT_BACKEND_ORIGIN,
  TRANSPORT_POLICY,
  type TransportMode,
} from '../src/api/policy';

/**
 * 传输策略两档模式的判定测试（纯函数，不发任何请求）。
 *
 * 关键约束：
 *  - **strict**（Agent 自动验证）：默认拒绝，只放行允许清单内的只读 GET 与登录/退出 POST；
 *    有外部副作用的动作（模型发现/推理、MCP 调用、工作流自测…）必须硬拦，
 *    **不能靠"是不是 GET"来猜有没有副作用**；
 *  - **product**（正常用户使用）：只固定目的地与 /api 前缀，动作交给后端 ACL，
 *    否则真实用户会永远无法保存。
 */

const PRODUCT_ORIGIN = PRODUCT_BACKEND_ORIGIN;
const OTHER_ORIGIN = 'http://192.0.2.10';

function decide(method: string, path: string, mode: TransportMode, origin = PRODUCT_ORIGIN) {
  return decideApiRequest({
    method,
    url: `${origin}${path}`,
    mode,
    allowedOrigins: [PRODUCT_ORIGIN],
  });
}

describe('策略基础', () => {
  it('默认后端是 13000 目标实例', () => {
    expect(PRODUCT_BACKEND_ORIGIN).toBe('http://172.16.88.250:13000');
    expect(TRANSPORT_POLICY.backendOrigin).toBe(PRODUCT_BACKEND_ORIGIN);
  });

  it('动作名取自路径最后一段', () => {
    expect(parseApiAction('/api/flow_nodes:list')?.key).toBe('flow_nodes:list');
    expect(parseApiAction('/api/roles/member/resources:create')?.key).toBe('resources:create');
    expect(parseApiAction('/api/mock/rotate-token')).toBeNull();
  });

  it('模块分片被静态合并进允许清单', () => {
    expect(ACTION_FRAGMENTS.map((fragment) => fragment.module)).toEqual([
      'ai',
      'model',
      'datasource',
      'access',
      'workflow',
      'tasks',
    ]);
    for (const action of [
      'aiConversations:getMessages',
      'flow_nodes:list',
      'jobs:list',
      'workflowManualTasks:get',
      'desktopRoutes:list',
      'roles:get',
    ]) {
      expect(TRANSPORT_POLICY.readActions, action).toContain(action);
    }
  });

  it('分片里的产品动作不会被当成严格模式的只读白名单', () => {
    const productActions = TRANSPORT_POLICY.productActions;
    expect(productActions).toContain('workflowManualTasks:submit');
    for (const action of productActions) {
      if (action === 'auth:signIn' || action === 'auth:signOut') continue;
      expect(TRANSPORT_POLICY.writeActions, action).not.toContain(action);
    }
  });
});

describe('strict 模式（Agent 自动验证）', () => {
  it('允许清单内的只读 GET 通过', () => {
    expect(decide('GET', '/api/workflows:list?pageSize=1', 'strict').decision).toBe('allowed');
    expect(decide('GET', '/api/auth:check', 'strict').decision).toBe('allowed');
    expect(decide('GET', '/api/flow_nodes:list?filter=%7B%7D', 'strict').decision).toBe('allowed');
  });

  it('登录与退出 POST 通过，写成 GET 则拒绝', () => {
    expect(decide('POST', '/api/auth:signIn', 'strict').decision).toBe('allowed');
    expect(decide('POST', '/api/auth:signOut', 'strict').decision).toBe('allowed');
    expect(decide('GET', '/api/auth:signIn', 'strict').reason).toBe('write-action-must-be-post');
  });

  it('只读动作写成 POST 时拒绝', () => {
    const decision = decide('POST', '/api/auth:check', 'strict');
    expect(decision.decision).toBe('blocked');
    expect(decision.reason).toBe('read-action-must-be-get');
  });

  it('业务写入与配置动作一律拒绝', () => {
    for (const [method, path] of [
      ['POST', '/api/users:create'],
      ['POST', '/api/workflows:update'],
      ['POST', '/api/flow_nodes:destroy'],
      ['POST', '/api/collections:update'],
      ['POST', '/api/roles:setSystemRoleMode'],
      ['POST', '/api/workflowManualTasks:submit'],
      ['POST', '/api/aiWorkflowTasks:accept'],
      ['GET', '/api/users:create'],
    ] as const) {
      expect(decide(method, path, 'strict').decision, `${method} ${path}`).toBe('blocked');
    }
  });

  it('有外部副作用的动作即使写成 GET 也硬拦（不靠方法猜副作用）', () => {
    for (const path of [
      '/api/ai:listModels',
      '/api/ai:listProviderModels',
      '/api/ai:testFlight',
      '/api/aiMcpClients:listTools',
      '/api/aiMcpClients:testConnection',
      '/api/flow_nodes:test',
      '/api/aiConversations:sendMessages',
    ]) {
      const decision = decide('GET', path, 'strict');
      expect(decision.decision, path).toBe('blocked');
      expect(decision.reason, path).toBe('strict-mode-external-side-effect');
    }
    expect(isStrictDeniedAction('ai:listModels')).toBe(true);
    expect(isStrictDeniedAction('flow_nodes:test')).toBe(true);
    expect(isStrictDeniedAction('aiConversations:updateUserDecision')).toBe(true);
    expect(isStrictDeniedAction('workflows:list')).toBe(false);
  });

  it('ai:listAllEnabledModels 是纯配置读取：strict 放行 POST，同类写入仍被拦', () => {
    // 原生 AIConfigRepository 用 `apiClient.resource('ai').listAllEnabledModels()` 触发，
    // SDK 对非 get/list 的动作固定用 POST；固定 2.2.20 的服务端实现只读 llmServices 配置，
    // 当前 13000 实测 200 + { data: [{ llmService, enabledModels }] }（本机只读核对，不写报告）。
    const post = decide('POST', '/api/ai:listAllEnabledModels', 'strict');
    expect(post.decision).toBe('allowed');
    expect(post.reason).toBeUndefined();
    expect(TRANSPORT_POLICY.readPostActions).toContain('ai:listAllEnabledModels');
    expect(TRANSPORT_POLICY.readActions).not.toContain('ai:listAllEnabledModels');
    // 不放宽同一资源上的写动作，也不放宽"发现模型/试飞"这类会外呼的动作。
    expect(decide('POST', '/api/llmServices:update', 'strict').decision).toBe('blocked');
    expect(decide('POST', '/api/llmServices:create', 'strict').decision).toBe('blocked');
    expect(decide('POST', '/api/ai:listModels', 'strict').reason).toBe('strict-mode-external-side-effect');
    expect(decide('POST', '/api/ai:testFlight', 'strict').reason).toBe('strict-mode-external-side-effect');
    // 任意未登记 POST 仍然默认拒绝。
    expect(decide('POST', '/api/someUnknown:doWrite', 'strict').reason).toBe('action-not-allowlisted');
  });

  it('跨来源地址被拒绝', () => {
    const decision = decide('GET', '/api/auth:check', 'strict', OTHER_ORIGIN);
    expect(decision.decision).toBe('blocked');
    expect(decision.reason).toBe('destination-not-allowed');
  });

  it('非 /api 路径被拒绝', () => {
    const decision = decide('GET', '/health', 'strict');
    expect(decision.decision).toBe('blocked');
    expect(decision.reason).toBe('path-not-api');
  });
});

describe('product 模式（真实用户使用）', () => {
  it('产品动作可以发出，由后端 ACL 判定', () => {
    for (const [method, path] of [
      ['POST', '/api/users:create'],
      ['POST', '/api/workflowManualTasks:submit'],
      ['POST', '/api/aiConversations:sendMessages'],
      ['POST', '/api/ai:testFlight'],
      ['GET', '/api/aiContextDatasources:preview'],
    ] as const) {
      expect(decide(method, path, 'product').decision, `${method} ${path}`).toBe('allowed');
    }
  });

  it('仍然固定目的地：跨来源一律拒绝', () => {
    const decision = decide('POST', '/api/users:create', 'product', OTHER_ORIGIN);
    expect(decision.decision).toBe('blocked');
    expect(decision.reason).toBe('destination-not-allowed');
  });

  it('仍然限制在 /api 前缀，不做任意转发', () => {
    expect(decide('GET', '/internal', 'product').reason).toBe('path-not-api');
  });
});
