import { describe, expect, it } from 'vitest';
import { SseFrameParser, readEventStream } from '../../../src/modules/ai/chat/sse';
import type { StreamEvent } from '../../../src/modules/ai/chat/sse';
import {
  applyStreamEvent,
  createAccumulator,
  finalizeStream,
  messagesFromHistory,
  outcomeNotice,
  textOfContent,
} from '../../../src/modules/ai/chat/conversation';

/**
 * AI-03 的受控真实 SSE 解析层验证。
 *
 * 用**真实的 ReadableStream 分片**驱动解析器（不是一次性 JSON），覆盖 P2 隔离验证里
 * 失败的 6 个点：完整终态、中止、缓存缺失、续流重放、断线、错会话。
 * 不访问任何真实后端，不触发模型调用。
 */

const encoder = new TextEncoder();

function framesToStream(frames: Array<Record<string, unknown> | string>, options: { error?: Error; splitEvery?: number } = {}) {
  const text = frames.map((frame) => (typeof frame === 'string' ? frame : `data: ${JSON.stringify(frame)}\n\n`)).join('');
  const chunks: string[] = [];
  const size = options.splitEvery ?? 17;
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  let cursor = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (cursor < chunks.length) {
        controller.enqueue(encoder.encode(chunks[cursor]));
        cursor += 1;
        return;
      }
      if (options.error) {
        controller.error(options.error);
        return;
      }
      controller.close();
    },
  });
}

function frame(type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type, from: 'main-agent', sessionId: 'session-1', ...extra };
}

describe('AI-03 SSE 帧解析器', () => {
  it('能把被任意分片切开的帧完整还原（含 JSON 中间断裂）', () => {
    const parser = new SseFrameParser();
    const payload = `data: ${JSON.stringify(frame('content', { body: '你好，世界' }))}\n\n`;
    const events: StreamEvent[] = [];
    for (const char of payload) {
      events.push(...parser.push(char));
    }
    events.push(...parser.flush());
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('content');
    expect(events[0].body).toBe('你好，世界');
  });

  it('跳过非法 JSON 帧但不中断整条流', () => {
    const parser = new SseFrameParser();
    const events = parser.push('data: {not json}\n\ndata: {"type":"content","body":"ok"}\n\n');
    expect(parser.invalidFrames).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0].body).toBe('ok');
  });
});

describe('AI-03 流式读取（P2 六个失败场景）', () => {
  it('场景 1 完整终态：收到 stream_end 后结算 streaming，不残留 loading', async () => {
    const stream = framesToStream([
      frame('stream_start'),
      frame('content', { body: '你' }),
      frame('content', { body: '好' }),
      frame('stream_end'),
    ]);
    let accumulator = createAccumulator([
      { key: 'a', role: 'assistant', text: '', reasoning: '', toolCalls: [], loading: true },
    ]);
    const result = await readEventStream(stream, {
      sessionId: 'session-1',
      onEvent: (event) => {
        accumulator = applyStreamEvent(accumulator, event, { employeeUsername: 'assistant', sessionId: 'session-1' });
      },
    });
    expect(result.outcome).toBe('completed');
    expect(result.sawStreamEnd).toBe(true);
    expect(accumulator.sawEnd).toBe(true);
    expect(accumulator.messages[0].text).toBe('你好');
    const finalized = finalizeStream(accumulator, result);
    expect(finalized.messages.every((message) => message.loading === false)).toBe(true);
    expect(outcomeNotice(result)).toBeNull();
  });

  it('场景 2 用户中止：静默结束，不产生错误气泡与错误文案', async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(encoder.encode(`data: ${JSON.stringify(frame('content', { body: '部分' }))}\n\n`));
      },
      pull() {
        // 保持打开：模拟服务端还在生成，用户点了停止。
        return new Promise(() => undefined);
      },
    });
    let accumulator = createAccumulator([
      { key: 'a', role: 'assistant', text: '', reasoning: '', toolCalls: [], loading: true },
    ]);
    const pending = readEventStream(stream, {
      sessionId: 'session-1',
      signal: controller.signal,
      onEvent: (event) => {
        accumulator = applyStreamEvent(accumulator, event, { employeeUsername: 'assistant', sessionId: 'session-1' });
      },
    });
    controller.abort();
    const result = await pending;
    expect(result.outcome).toBe('aborted');
    expect(result.message).toBeNull();
    expect(outcomeNotice(result)).toBeNull();
    const finalized = finalizeStream(accumulator, result);
    expect(finalized.messages.some((message) => message.isError)).toBe(false);
    expect(finalized.messages[0].loading).toBe(false);
  });

  it('场景 3 缓存缺失：chunks_cache_missing 被单独标记，不空等', async () => {
    const stream = framesToStream([frame('chunks_cache_missing', { body: { llmActiveState: 'streaming' } })]);
    let accumulator = createAccumulator([]);
    const result = await readEventStream(stream, {
      sessionId: 'session-1',
      onEvent: (event) => {
        accumulator = applyStreamEvent(accumulator, event, { employeeUsername: 'assistant', sessionId: 'session-1' });
      },
    });
    expect(accumulator.resumeFailed).toBe(true);
    expect(result.outcome).toBe('disconnected'); // 服务端只发了这个提示就结束
    expect(result.message).toContain('继续接收');
  });

  it('场景 4 续流重放：resumeStream 的帧走同一条解析与结算路径', async () => {
    // 与场景 1 使用同一解析器与归约器；这里验证"重放过来 2 段增量 + 正常结束"。
    const stream = framesToStream([
      frame('stream_start'),
      frame('content', { body: '续' }),
      frame('content', { body: '传' }),
      frame('stream_end'),
    ]);
    let accumulator = createAccumulator([
      { key: 'a', role: 'assistant', text: '', reasoning: '', toolCalls: [], loading: true },
    ]);
    const result = await readEventStream(stream, {
      sessionId: 'session-1',
      onEvent: (event) => {
        accumulator = applyStreamEvent(accumulator, event, { employeeUsername: 'assistant', sessionId: 'session-1' });
      },
    });
    expect(result.outcome).toBe('completed');
    expect(accumulator.messages.map((message) => message.text).join('')).toBe('续传');
  });

  it('场景 5a 断线（连接报错）：结算并给出可继续接收的说明', async () => {
    const stream = framesToStream([frame('stream_start'), frame('content', { body: '半' })], {
      error: new Error('socket hang up'),
    });
    let accumulator = createAccumulator([
      { key: 'a', role: 'assistant', text: '', reasoning: '', toolCalls: [], loading: true },
    ]);
    const result = await readEventStream(stream, {
      sessionId: 'session-1',
      onEvent: (event) => {
        accumulator = applyStreamEvent(accumulator, event, { employeeUsername: 'assistant', sessionId: 'session-1' });
      },
    });
    expect(result.outcome).toBe('disconnected');
    expect(result.message).toContain('连接中断');
    const finalized = finalizeStream(accumulator, result);
    expect(finalized.messages[0].loading).toBe(false);
    expect(finalized.messages[0].text).toBe('半');
  });

  it('场景 5b 断线（服务端直接关闭且无 stream_end）：同样结算', async () => {
    const stream = framesToStream([frame('stream_start'), frame('content', { body: '半' })]);
    let accumulator = createAccumulator([
      { key: 'a', role: 'assistant', text: '', reasoning: '', toolCalls: [], loading: true },
    ]);
    const result = await readEventStream(stream, {
      sessionId: 'session-1',
      onEvent: (event) => {
        accumulator = applyStreamEvent(accumulator, event, { employeeUsername: 'assistant', sessionId: 'session-1' });
      },
    });
    expect(result.outcome).toBe('disconnected');
    expect(result.sawStreamEnd).toBe(false);
    expect(finalizeStream(accumulator, result).messages[0].loading).toBe(false);
  });

  it('场景 6 错会话：不属于当前会话的帧被丢弃并计数，不污染内容', async () => {
    const stream = framesToStream([
      frame('content', { body: '别的会话', sessionId: 'session-other' }),
      frame('content', { body: '我的会话' }),
      frame('stream_end'),
    ]);
    let accumulator = createAccumulator([
      { key: 'a', role: 'assistant', text: '', reasoning: '', toolCalls: [], loading: true },
    ]);
    const result = await readEventStream(stream, {
      sessionId: 'session-1',
      onEvent: (event) => {
        accumulator = applyStreamEvent(accumulator, event, { employeeUsername: 'assistant', sessionId: 'session-1' });
      },
    });
    expect(result.foreignEvents).toBe(1);
    expect(accumulator.messages[0].text).toBe('我的会话');
    expect(accumulator.messages[0].text).not.toContain('别的会话');
  });

  it('服务端 error 帧：判为失败并给出可读文案，不暴露内部 errorName', async () => {
    const stream = framesToStream([
      frame('content', { body: '' }),
      { type: 'error', body: 'LLM service not configured', errorName: 'Error' },
    ]);
    const result = await readEventStream(stream, { sessionId: 'session-1', onEvent: () => undefined });
    expect(result.outcome).toBe('rejected');
    expect(result.message).not.toContain('LLM service');
    expect(result.errorBody).toBe('LLM service not configured');
  });
});

describe('AI-03 事件归约', () => {
  it('content / reasoning / tool_call_status 归约到同一条消息', () => {
    let accumulator = createAccumulator([
      { key: '1', role: 'assistant', text: '', reasoning: '', toolCalls: [], loading: true },
    ]);
    const ctx = { employeeUsername: 'assistant', sessionId: 'session-1' };
    accumulator = applyStreamEvent(accumulator, frame('reasoning', { body: { content: '想', status: 'streaming' } }), ctx);
    accumulator = applyStreamEvent(accumulator, frame('content', { body: '答' }), ctx);
    accumulator = applyStreamEvent(
      accumulator,
      frame('tool_calls', { body: { toolCalls: [{ id: 't1', name: 'search', args: '{}' }] } }),
      ctx,
    );
    accumulator = applyStreamEvent(
      accumulator,
      frame('tool_call_status', {
        body: { toolCall: { id: 't1', messageId: 'm1', willInterrupt: true }, invokeStatus: 'interrupted' },
      }),
      ctx,
    );
    expect(accumulator.messages[0].text).toBe('答');
    expect(accumulator.messages[0].reasoning).toBe('想');
    expect(accumulator.messages[0].toolCalls[0]).toMatchObject({
      id: 't1',
      name: 'search',
      invokeStatus: 'interrupted',
      willInterrupt: true,
      messageId: 'm1',
    });
  });

  it('new_message 会追加一条新的助手消息（多轮/子代理）', () => {
    let accumulator = createAccumulator([
      { key: '1', role: 'assistant', text: '旧', reasoning: '', toolCalls: [], loading: false },
    ]);
    accumulator = applyStreamEvent(accumulator, frame('new_message'), {
      employeeUsername: 'assistant',
      sessionId: 'session-1',
    });
    expect(accumulator.messages).toHaveLength(2);
    expect(accumulator.messages[1].loading).toBe(true);
  });

  it('历史消息归一：tool 角色在服务端已过滤，文本从 content.content 提取', () => {
    const rows = [
      {
        messageId: 7,
        role: 'user',
        content: { type: 'text', content: '你好', messageId: 7 },
      },
      {
        messageId: 8,
        role: 'assistant',
        content: { type: 'text', content: '在的', reasoning: { content: '思考' }, tool_calls: [{ id: 'x', name: 'n', args: '{}' }] },
      },
    ];
    const messages = messagesFromHistory(rows, 'assistant');
    expect(messages.map((message) => message.text)).toEqual(['你好', '在的']);
    expect(messages[1].reasoning).toBe('思考');
    expect(messages[1].toolCalls).toHaveLength(1);
    expect(textOfContent({ content: [{ text: '分段' }, { text: '文本' }] })).toBe('分段文本');
  });
});
