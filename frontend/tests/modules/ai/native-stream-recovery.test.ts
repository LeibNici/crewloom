import { describe, expect, it } from 'vitest';
import {
  DISCONNECT_ERROR_NAME,
  installNativeChatStreamRecovery,
  recoverEventStream,
} from '../../../src/modules/ai/native/streamRecovery';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const frameText = (payload: Record<string, unknown>) => `data: ${JSON.stringify(payload)}\n\n`;

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index]));
      index += 1;
    },
  });
}

/** 读到结束，返回完整文本；异常按 {error} 返回。 */
async function drain(stream: ReadableStream<Uint8Array>): Promise<{ text: string; error?: unknown }> {
  const reader = stream.getReader();
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { text };
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    return { text, error };
  }
}

function streamThenError(chunks: string[], error: unknown): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index += 1;
        return;
      }
      controller.error(error);
    },
  });
}

describe('原生会话流收尾适配（drop / abort）', () => {
  it('正常终态原样透传：有 stream_end 时不补任何说明帧', async () => {
    const input = [
      frameText({ type: 'stream_start', from: 'main-agent', sessionId: 's1' }),
      frameText({ type: 'content', from: 'main-agent', sessionId: 's1', body: '你好' }),
      frameText({ type: 'stream_end', from: 'main-agent', sessionId: 's1' }),
    ];
    const out = await drain(recoverEventStream(streamFromChunks(input), { sessionId: 's1', config: {} }));
    expect(out.error).toBeUndefined();
    expect(out.text).toBe(input.join(''));
    expect(out.text).not.toContain(DISCONNECT_ERROR_NAME);
  });

  it('断线（读流 done 但没有 stream_end）补中文说明帧与 stream_end', async () => {
    const input = [
      frameText({ type: 'stream_start', from: 'main-agent', sessionId: 's1' }),
      frameText({ type: 'content', from: 'main-agent', sessionId: 's1', body: '受控断线前的内容。' }),
    ];
    const out = await drain(recoverEventStream(streamFromChunks(input), { sessionId: 's1', config: {} }));
    expect(out.error).toBeUndefined();
    // 已收到的内容一个字节都不丢。
    expect(out.text.startsWith(input.join(''))).toBe(true);
    expect(out.text).toContain('受控断线前的内容。');
    expect(out.text).toContain(DISCONNECT_ERROR_NAME);
    expect(out.text).toContain('"type":"error"');
    // 说明帧带当前会话 id，固定源码才不会被"错会话"分支丢掉。
    expect(out.text).toContain('"sessionId":"s1"');
  });

  it('流中途抛非中止错误（如 terminated）时同样收敛，不把异常抛给上层', async () => {
    const source = streamThenError(
      [frameText({ type: 'content', from: 'main-agent', sessionId: 's1', body: '半段' })],
      Object.assign(new Error('terminated'), { name: 'TypeError' }),
    );
    const out = await drain(recoverEventStream(source, { sessionId: 's1', config: {} }));
    expect(out.error).toBeUndefined();
    expect(out.text).toContain('半段');
    expect(out.text).toContain(DISCONNECT_ERROR_NAME);
    expect(out.text).toContain('"type":"error"');
  });

  it('主动停止（signal.aborted 或 AbortError）静默正常结束：保留已收到内容、不报失败、不加说明帧', async () => {
    const controller = new AbortController();
    controller.abort();
    const source = streamThenError(
      [frameText({ type: 'content', from: 'main-agent', sessionId: 's1', body: '第 1 段' })],
      Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }),
    );
    const out = await drain(
      recoverEventStream(source, { sessionId: 's1', config: { signal: controller.signal } }),
    );
    expect(out.error).toBeUndefined();
    expect(out.text).toContain('第 1 段');
    expect(out.text).not.toContain(DISCONNECT_ERROR_NAME);
    expect(out.text).not.toContain('stream_end');
  });

  it('流内 error 帧属于终态：不再叠加断线说明', async () => {
    const input = [
      frameText({ type: 'stream_start', from: 'main-agent', sessionId: 's1' }),
      frameText({ type: 'error', from: 'main-agent', sessionId: 's1', errorName: 'CONTROLLED_FAILURE' }),
    ];
    const out = await drain(recoverEventStream(streamFromChunks(input), { sessionId: 's1', config: {} }));
    expect(out.text).toBe(input.join(''));
    expect(out.text).not.toContain(DISCONNECT_ERROR_NAME);
  });

  it('chunks_cache_missing 也是终态，不叠加断线说明', async () => {
    const input = [frameText({ type: 'chunks_cache_missing', from: 'main-agent', sessionId: 's1' })];
    const out = await drain(recoverEventStream(streamFromChunks(input), { sessionId: 's1', config: {} }));
    expect(out.text).toBe(input.join(''));
    expect(out.text).not.toContain(DISCONNECT_ERROR_NAME);
  });

  it('角色切换后旧身份的迟到帧不再转发：流正常结束，交给新角色重读', async () => {
    const chunks = [
      frameText({ type: 'content', from: 'main-agent', sessionId: 's1', body: '第 1 段' }),
      frameText({ type: 'content', from: 'main-agent', sessionId: 's1', body: '第 2 段' }),
      frameText({ type: 'content', from: 'main-agent', sessionId: 's1', body: '第 3 段' }),
    ];
    let role: string | null = 'synth-operator';
    const stream = recoverEventStream(streamFromChunks(chunks), {
      sessionId: 's1',
      config: {},
      identity: { roleAtStart: 'synth-operator', currentRole: () => role },
    });
    const reader = stream.getReader();
    // 消费者先收到旧身份的第 1 段……
    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain('第 1 段');
    // ……此时用户切换角色：后续帧属于旧身份，不得再写入当前身份状态。
    role = 'synth-reviewer';
    let rest = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += decoder.decode(value, { stream: true });
    }
    expect(rest).not.toContain('第 2 段');
    expect(rest).not.toContain('第 3 段');
    // 是正常结束，不是断线说明：新身份的历史由随后的 loadMessages 读取。
    expect(rest).not.toContain(DISCONNECT_ERROR_NAME);
  });

  it('角色不变时全部帧照常透传', async () => {
    const input = [
      frameText({ type: 'content', from: 'main-agent', sessionId: 's1', body: '第 1 段' }),
      frameText({ type: 'stream_end', from: 'main-agent', sessionId: 's1' }),
    ];
    const out = await drain(
      recoverEventStream(streamFromChunks(input), {
        sessionId: 's1',
        config: {},
        identity: { roleAtStart: 'synth-operator', currentRole: () => 'synth-operator' },
      }),
    );
    expect(out.text).toBe(input.join(''));
  });
});

describe('installNativeChatStreamRecovery 只在原生会话流动作上生效', () => {
  it('非流动作完全不受影响（同一个 request 返回值原样返回）', async () => {
    const client = {
      request: async (_config: never) => ({ data: { ok: true } }),
      resource: () => 'resource',
    };
    const guarded = installNativeChatStreamRecovery(client);
    const result = await guarded.request({ url: 'app:getInfo' } as never);
    expect(result).toEqual({ data: { ok: true } });
    // 方法仍绑回真实客户端，`resource()` 语义不变。
    expect(guarded.resource()).toBe('resource');
  });

  it('会话流动作返回的 ReadableStream 被换成收尾适配后的流', async () => {
    const chunks = [
      frameText({ type: 'stream_start', from: 'main-agent', sessionId: 's9' }),
      frameText({ type: 'content', from: 'main-agent', sessionId: 's9', body: '已收到' }),
    ];
    const client = {
      request: async (_config: unknown) => ({
        data: streamFromChunks(chunks),
        headers: {},
        config: {},
      }),
    };
    const guarded = installNativeChatStreamRecovery(client);
    const response = (await guarded.request({
      url: 'aiConversations:sendMessages',
      method: 'POST',
      responseType: 'stream',
      data: { sessionId: 's9' },
    } as never)) as { data: ReadableStream<Uint8Array> };
    const out = await drain(response.data);
    expect(out.text).toContain('已收到');
    expect(out.text).toContain(DISCONNECT_ERROR_NAME);
  });
});
