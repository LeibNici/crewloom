import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AxiosRequestConfig } from 'axios';
import { api, getHttpClient, setAuthContext, setTransportMode } from '../../../src/api/client';
import { runConversationStream } from '../../../src/modules/ai/chat/sse';
import { loadConversationMessages } from '../../../src/modules/ai/resources';
import { applyStreamEvent, createAccumulator, finalizeStream } from '../../../src/modules/ai/chat/conversation';
import type { StreamEvent } from '../../../src/modules/ai/chat/sse';

/**
 * AI-03 的**受控真实流**集成：走产品同一条请求管线（SDK axios），
 * 由受控 adapter 返回一条**真实的 ReadableStream**（分多次 enqueue），
 * 证明：
 *  1. 发送/续流不是一次性 JSON —— 增量是分帧到达并被逐帧归约的；
 *  2. 请求确实走 `src/api/client.ts` 的 SDK 管线（带 Authorization / X-Role），没有第二条通道；
 *  3. 严格只读模式会拦下会触发模型的动作，且**不产生任何网络调用**。
 *
 * 全程无真实网络与模型调用。
 */

const encoder = new TextEncoder();
const captured: AxiosRequestConfig[] = [];

/**
 * 受控传输 adapter：不是"静态 JSON"，而是把分片喂进一条**真实 ReadableStream**，
 * 因此仍然走完整的流式读取路径（逐帧 decode → 逐帧归约）。
 */
function streamAdapter(chunks: string[], options: { failWith?: Error } = {}) {
  return async (config: AxiosRequestConfig) => {
    captured.push(config);
    let index = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(encoder.encode(chunks[index]));
          index += 1;
          return;
        }
        if (options.failWith) {
          controller.error(options.failWith);
          return;
        }
        controller.close();
      },
    });
    return {
      data: stream,
      status: 200,
      statusText: '200',
      headers: {},
      config,
    };
  };
}

function sseFrame(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ from: 'main-agent', sessionId: 's-1', ...payload })}\n\n`;
}

afterEach(() => {
  captured.length = 0;
  setTransportMode('product');
  setAuthContext({ token: null, role: null, authenticator: null });
  vi.restoreAllMocks();
});

describe('AI-03 会话流走公共请求管线（受控真实流）', () => {
  it('sendMessages：POST + text/event-stream + SDK 身份头，逐帧归约到完整终态', async () => {
    setTransportMode('product');
    setAuthContext({ token: 'controlled-token', role: 'member', authenticator: 'basic' });
    const adapter = streamAdapter([
      sseFrame({ type: 'stream_start' }),
      sseFrame({ type: 'content', body: '你' }),
      sseFrame({ type: 'content', body: '好' }),
      sseFrame({ type: 'stream_end' }),
    ]);

    let accumulator = createAccumulator([
      { key: 'local', role: 'assistant', text: '', reasoning: '', toolCalls: [], loading: true },
    ]);
    const result = await runConversationStream({
      action: 'aiConversations:sendMessages',
      data: { sessionId: 's-1', aiEmployee: 'assistant', messages: [{ role: 'user', content: 'hi' }] },
      signal: new AbortController().signal,
      sessionId: 's-1',
      transportAdapter: adapter,
      onEvent: (event: StreamEvent) => {
        accumulator = applyStreamEvent(accumulator, event, { employeeUsername: 'assistant', sessionId: 's-1' });
      },
    });

    expect(result.outcome).toBe('completed');
    expect(accumulator.messages[0].text).toBe('你好');
    expect(finalizeStream(accumulator, result).messages[0].loading).toBe(false);

    expect(captured).toHaveLength(1);
    const request = captured[0];
    expect(String(request.method).toLowerCase()).toBe('post');
    expect(request.url).toBe('aiConversations:sendMessages');
    expect(request.responseType).toBe('stream');
    const headers = (request.headers ?? {}) as Record<string, string>;
    expect(headers.Accept).toBe('text/event-stream');
    // SDK Auth 中间件注入身份头：证明走的是公共管线，没有绕开认证。
    expect(headers.Authorization).toBe('Bearer controlled-token');
    expect(headers['X-Role']).toBe('member');
    const body = typeof request.data === 'string' ? JSON.parse(request.data) : request.data;
    expect(body).toMatchObject({ sessionId: 's-1', aiEmployee: 'assistant' });
  });

  it('断线（adapter 报错）后仍然结算，且错误信息不包含内部细节', async () => {
    setTransportMode('product');
    const adapter = streamAdapter([sseFrame({ type: 'content', body: '半' })], { failWith: new Error('internal socket detail') });
    let accumulator = createAccumulator([
      { key: 'local', role: 'assistant', text: '', reasoning: '', toolCalls: [], loading: true },
    ]);
    const result = await runConversationStream({
      action: 'aiConversations:sendMessages',
      data: { sessionId: 's-1' },
      signal: new AbortController().signal,
      sessionId: 's-1',
      transportAdapter: adapter,
      onEvent: (event) => {
        accumulator = applyStreamEvent(accumulator, event, { employeeUsername: 'assistant', sessionId: 's-1' });
      },
    });
    expect(result.outcome).toBe('disconnected');
    expect(result.message ?? '').not.toContain('internal socket detail');
    expect(finalizeStream(accumulator, result).messages[0].loading).toBe(false);
  });

  it('严格只读模式：sendMessages 被传输层拦截，adapter 完全未被调用', async () => {
    setTransportMode('strict');
    const adapter = streamAdapter([sseFrame({ type: 'stream_end' })]);
    const result = await runConversationStream({
      action: 'aiConversations:sendMessages',
      data: { sessionId: 's-1' },
      signal: new AbortController().signal,
      sessionId: 's-1',
      transportAdapter: adapter,
      onEvent: () => undefined,
    });
    expect(result.outcome).toBe('rejected');
    expect(captured).toHaveLength(0);
  });

  it('严格只读模式：只读的 getMessages 仍然放行（自动验证可读真实数据）', async () => {
    setTransportMode('strict');
    const client = getHttpClient();
    client.defaults.adapter = async (config) => {
      captured.push(config);
      return {
        data: { data: { rows: [] } },
        status: 200,
        statusText: '200',
        headers: {},
        config,
      };
    };
    const history = await loadConversationMessages('s-1', { paginate: false });
    expect(history.rows).toEqual([]);
    expect(captured).toHaveLength(1);
    expect(String(captured[0].method).toLowerCase()).toBe('get');
    expect(captured[0].url).toBe('aiConversations:getMessages');
    expect(captured[0].params).toMatchObject({ sessionId: 's-1', paginate: 'false' });
    // 自动验证**显式** updateRead=false：不依赖"缺省即不写"的服务端默认值
    // （服务端只有收到 'true'/true 才标记已读，见 server/resource/aiConversations.ts:284）。
    expect((captured[0].params as Record<string, unknown>).updateRead).toBe('false');
  });

  it('getMessages：真实用户显式标记已读时才传 updateRead=true', async () => {
    setTransportMode('product');
    const client = getHttpClient();
    client.defaults.adapter = async (config) => {
      captured.push(config);
      return {
        data: { data: { rows: [] } },
        status: 200,
        statusText: '200',
        headers: {},
        config,
      };
    };
    await loadConversationMessages('s-2', { paginate: false, updateRead: true });
    expect(captured).toHaveLength(1);
    expect((captured[0].params as Record<string, unknown>).updateRead).toBe('true');
  });

  it('严格只读模式：会外呼的动作（listModels / testFlight / MCP 工具）一律拦截', async () => {
    setTransportMode('strict');
    const actions: Array<[string, string]> = [
      ['ai', 'listModels'],
      ['ai', 'listProviderModels'],
      ['ai', 'testFlight'],
      ['aiMcpClients', 'testConnection'],
      ['aiMcpClients', 'listTools'],
    ];
    for (const [resource, action] of actions) {
      await expect(api.resourceAction(resource, action, { values: {} })).rejects.toBeTruthy();
    }
    expect(captured).toHaveLength(0);
  });
});
