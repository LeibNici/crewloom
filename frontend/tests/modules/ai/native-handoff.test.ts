// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { useSessionStore } from '../../../src/auth/store';
import {
  __resetHandoffForTests,
  getLastHandoffState,
  handoffPreparedItemsToChatBox,
} from '../../../src/modules/ai/context/native';
import { CODE_WORKSPACE_UID } from '../../../src/modules/ai/context/payload';
import { __resetForTests, requestChatHandoff, upsertSelection } from '../../../src/modules/ai/context/store';
import type { CodeSelection } from '../../../src/modules/ai/context/types';

/**
 * 上下文交接的**幂等性**（"后续消息不重复带 workContext"）。
 *
 * 宿主在「上下文工作区 ↔ 会话页」之间来回切换时会被卸载再挂载；如果每次挂载都重新注入
 * 同一份选择，第二条及以后的消息就会重复携带 `workContext`。这里断言：
 *  - 同一份选择第二次交接不再注入；
 *  - 选择集合真的变化后允许再次交接。
 */

const SELECTION: CodeSelection = {
  kind: 'code',
  uid: CODE_WORKSPACE_UID,
  title: '代码工作区',
  scene: 'crewloom-code-workspace',
  language: 'typescript',
  code: 'const total = 1;',
  data: null,
};

function fakeRuntime() {
  const calls: Array<{ sessionId: unknown; items: unknown }> = [];
  const runtime = {
    chatConversationModel: { currentConversation: 'sess-1' },
    chatMessageModel: {
      addSessionContextItems: (sessionId: unknown, items: unknown) => {
        calls.push({ sessionId, items });
      },
    },
  };
  return { runtime, calls };
}

beforeEach(() => {
  useSessionStore.setState({ activeRole: 'role_admin', user: { id: 13 } as never });
  __resetForTests();
  __resetHandoffForTests();
});

describe('上下文交接幂等（后续消息不重复）', () => {
  it('同一份选择在宿主重新挂载时只注入一次', () => {
    upsertSelection(SELECTION);
    const { runtime, calls } = fakeRuntime();

    expect(handoffPreparedItemsToChatBox(runtime)).toBe(1);
    expect(handoffPreparedItemsToChatBox(runtime)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(getLastHandoffState().handedOff).toBe(0);
  });

  it('选择集合变化后允许再次交接', () => {
    upsertSelection(SELECTION);
    const { runtime, calls } = fakeRuntime();
    expect(handoffPreparedItemsToChatBox(runtime)).toBe(1);

    upsertSelection({
      kind: 'datasource',
      uid: 'controlled-context-1',
      title: '受控数据范围',
      datasource: 'main',
      collectionName: 'aiContextDatasources',
      fields: ['title'],
      filter: null,
      sort: null,
      limit: 5,
    });

    expect(handoffPreparedItemsToChatBox(runtime)).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it('显式交接（force）可以重新注入同一份选择', () => {
    upsertSelection(SELECTION);
    const { runtime, calls } = fakeRuntime();
    expect(handoffPreparedItemsToChatBox(runtime)).toBe(1);
    expect(handoffPreparedItemsToChatBox(runtime, { force: true })).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it('用户显式重新保存同一份选择：下一次交接重新注入（同一 runtime，不必新开标签）', () => {
    upsertSelection(SELECTION);
    const { runtime, calls } = fakeRuntime();
    expect(handoffPreparedItemsToChatBox(runtime)).toBe(1);
    // 宿主在路由间来回挂载：同一份选择不重复注入（后续消息不带 workContext）。
    expect(handoffPreparedItemsToChatBox(runtime)).toBe(0);
    // 用户再次点「保存为会话内容」→ 显式交接请求，即使签名未变也要重新注入。
    requestChatHandoff();
    expect(handoffPreparedItemsToChatBox(runtime)).toBe(1);
    expect(calls).toHaveLength(2);
    // 请求是一次性的：再挂载不再注入。
    expect(handoffPreparedItemsToChatBox(runtime)).toBe(0);
    expect(calls).toHaveLength(2);
  });

  it('工具执行（apply_code_change）只改内容、不请求交接：同一会话不再注入上下文', () => {
    upsertSelection(SELECTION);
    const { runtime, calls } = fakeRuntime();
    expect(handoffPreparedItemsToChatBox(runtime)).toBe(1);
    // 模拟工具执行写回同一 uid 的新内容（走 upsertSelection，不调用 requestChatHandoff）。
    upsertSelection({ ...SELECTION, code: 'const total = 2;' });
    expect(handoffPreparedItemsToChatBox(runtime)).toBe(0);
    expect(calls).toHaveLength(1);
  });
});
