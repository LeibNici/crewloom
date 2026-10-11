// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { getHttpClient } from '../../../src/api/client';
import { useSessionStore } from '../../../src/auth/store';
import {
  clearNativeAIBridgeHost,
  getNativeAIBridge,
  registerNativeAIBridgeHost,
} from '../../../src/modules/ai/native/bridge';

/**
 * 原生桥的**会话世代隔离**（`roleEpochabort`）：调用期间切换用户/角色/会话世代时，
 * 晚到的结果必须标记 `current: false`，消费方据此丢弃；
 * 宿主未挂载时明确失败（`native-host-not-mounted`），**不伪造**成功。
 */
describe('原生桥的会话世代隔离', () => {
  beforeEach(() => {
    useSessionStore.setState({ activeRole: 'role_admin', user: { id: 13 } as never });
    clearNativeAIBridgeHost();
  });

  it('宿主未挂载时 mounted=false，且 prepareContext 明确失败而不是伪造', () => {
    const bridge = getNativeAIBridge();
    expect(bridge.describe().mounted).toBe(false);
    const prepared = bridge.prepareContext([]);
    expect(prepared.ok).toBe(false);
    expect(prepared.error).toBe('native-host-not-mounted');
  });

  it('调用期间角色变化时返回 current=false（晚到结果必须丢弃）', async () => {
    registerNativeAIBridgeHost({ app: {}, runtime: {} });
    const client = getHttpClient();
    client.defaults.adapter = async (config) => {
      // 请求在途时切换生效角色：完成时的世代与开始时不再一致。
      useSessionStore.setState({ activeRole: 'role_limited' });
      return {
        data: { data: { updated: 1, toolCalls: [] } },
        status: 200,
        statusText: '200',
        headers: {},
        config,
      } as never;
    };

    const result = await getNativeAIBridge().decideTool({
      sessionId: 'sess-1',
      messageId: 'msg-1',
      toolCallId: 'call-1',
      decision: 'approve',
    });

    expect(result.ok).toBe(true);
    expect(result.generation.role).toBe('role_admin');
    expect(result.current).toBe(false);
  });

  it('onGenerationChange 在角色变化时通知订阅者，取消订阅后不再通知', () => {
    const seen: Array<string | null> = [];
    const off = getNativeAIBridge().onGenerationChange((generation) => {
      seen.push(generation.role);
    });

    useSessionStore.setState({ activeRole: 'role_limited' });
    expect(seen.at(-1)).toBe('role_limited');

    off();
    useSessionStore.setState({ activeRole: 'role_admin' });
    expect(seen.at(-1)).toBe('role_limited');
  });
});
