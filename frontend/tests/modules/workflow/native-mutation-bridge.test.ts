import { describe, expect, it, vi } from 'vitest';
import {
  installNativeNodeMutationBridge,
  isNativeNodeMutation,
  resolveRequestAction,
  type ResponseInterceptorHost,
} from '../../../src/modules/workflow/native/nativeMutationBridge';

/**
 * 原生画布节点写成功 → 宿主刷新 的判别逻辑。
 *
 * 背景（Main 实测）：原生保存/新增/复制/移动/删除后，产品页「节点处理顺序」停在旧值，
 * 因为画布与产品页共用的 SDK 里没有任何联动。这里只断言"哪些请求算节点变更"，
 * 不涉及 React 渲染；真正的拦截器安装/卸载也一并覆盖。
 */

/** 最小的假 axios：记录 onFulfilled，可手动 emit。 */
function createFakeHost() {
  type FakeResponse = { config?: unknown };
  const handlers: Array<((response: FakeResponse) => FakeResponse) | null> = [];
  const host: ResponseInterceptorHost<FakeResponse> = {
    interceptors: {
      response: {
        use: (onFulfilled) => {
          handlers.push(onFulfilled);
          return handlers.length;
        },
        eject: (id) => {
          handlers[id - 1] = null;
        },
      },
    },
  };
  return {
    host,
    emit: (config: unknown) => handlers.filter(Boolean).forEach((handler) => handler!({ config })),
    activeCount: () => handlers.filter(Boolean).length,
  };
}

describe('原生节点变更判别', () => {
  it('从 axios 请求 URL 取出动作名（去 query 与 /api 前缀）', () => {
    expect(resolveRequestAction('flow_nodes:update?filterByTk=910257')).toBe('flow_nodes:update');
    expect(resolveRequestAction('/api/flow_nodes:duplicate?filterByTk=1')).toBe('flow_nodes:duplicate');
    expect(resolveRequestAction('/api/workflows/900000000000001/nodes:create')).toBe(
      'workflows/900000000000001/nodes:create',
    );
    expect(resolveRequestAction(undefined)).toBeNull();
  });

  it('只把成功的节点写请求认作变更（读请求与其它写请求不触发）', () => {
    for (const action of [
      'flow_nodes:update',
      'flow_nodes:move',
      'flow_nodes:duplicate',
      'flow_nodes:destroy',
      'flow_nodes:destroyBranch',
    ]) {
      expect(isNativeNodeMutation({ method: 'post', url: `${action}?filterByTk=1` })).toBe(true);
    }
    expect(isNativeNodeMutation({ method: 'post', url: 'workflows/172/nodes:create' })).toBe(true);
    // 读请求
    expect(isNativeNodeMutation({ method: 'get', url: 'flow_nodes:list?filter=%7B%7D' })).toBe(false);
    // 其它写请求（版本/流程级）不归节点联动管
    expect(isNativeNodeMutation({ method: 'post', url: 'workflows:update?filterByTk=1' })).toBe(false);
    expect(isNativeNodeMutation({ method: 'post', url: 'flow_nodes:test' })).toBe(false);
    expect(isNativeNodeMutation(undefined)).toBe(false);
  });

  it('安装后成功写请求各回调一次，卸载后不再回调', () => {
    const { host, emit, activeCount } = createFakeHost();
    const onChange = vi.fn();
    const uninstall = installNativeNodeMutationBridge(host, onChange);

    emit({ method: 'post', url: 'flow_nodes:update?filterByTk=910257' });
    expect(onChange).toHaveBeenCalledTimes(1);

    emit({ method: 'get', url: 'flow_nodes:list?filter=%7B%7D' });
    emit({ method: 'post', url: 'workflows:update?filterByTk=900000000000001' });
    expect(onChange).toHaveBeenCalledTimes(1);

    emit({ method: 'post', url: 'flow_nodes:duplicate?filterByTk=910288' });
    expect(onChange).toHaveBeenCalledTimes(2);

    uninstall();
    expect(activeCount()).toBe(0);
    emit({ method: 'post', url: 'flow_nodes:duplicate?filterByTk=910288' });
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
