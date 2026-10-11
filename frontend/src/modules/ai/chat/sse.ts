import { api } from '../../../api/client';

/**
 * AI-03 的 SSE 读取层（组 A 独占）。
 *
 * 为什么单独一层：`aiConversations:sendMessages` 等动作返回 `text/event-stream`，
 * 必须**边收边解析**，不能用一次性 JSON 响应替代。原生 `ChatBox` 的做法是
 * `api.request({ responseType: 'stream', adapter: 'fetch', signal })` 后 `stream.getReader()`
 * （`client-v2/ai-employees/chatbox/hooks/useChatMessageActions.ts:300-660, 800-820`）。
 * 这里沿用同一形状，但把 P2 隔离验证暴露的 6 个失败点**在解析层修好**：
 *
 *  1. 完整终态：`stream_end` 缺失时也要结算（不能永远停在"正在生成"）；
 *  2. 用户中止：`AbortController` 触发后**静默**结束，不显示错误气泡；
 *  3. 缓存缺失（`chunks_cache_missing`）：明确标记"这段内容已不在服务端缓存"，不再空等；
 *  4. 重放/续流：`resumeStream` 走同一条解析与结算路径，不另写一套；
 *  5. 断线：`reader` 结束但没收到 `stream_end` → 判为"生成被中断"，结算并可继续接收；
 *  6. 错会话：帧里 `sessionId` 与当前会话不一致时**丢弃并计数**，不污染当前会话。
 *
 * 传输仍然走 `src/api/client.ts` 的既有管线（SDK axios：认证、角色、续期、传输策略），
 * **没有第二条请求通道**，也不手工拼 Authorization。
 */

/** 服务端 `data:` 帧的业务字段（源码 `server/resource/aiConversations.ts` 与 `utils.ts:sendSSEError`）。 */
export interface StreamEvent {
  type?: string;
  from?: string;
  sessionId?: string;
  username?: string;
  body?: unknown;
  errorName?: string;
  [key: string]: unknown;
}

/**
 * SSE 文本帧解析器。
 *
 * 服务端固定写 `data: <json>\n\n`；这里按 SSE 规范累积帧（连续 `data:` 行以 `\n` 连接），
 * 因此即使 JSON 或帧被 TCP 分片切在任意位置也能正确还原。
 * 无法解析 JSON 的帧**不会**让整条流失败：解析失败计数并跳过（与原生 `try/catch continue` 一致）。
 */
export class SseFrameParser {
  private buffer = '';
  private dataLines: string[] = [];
  /** 解析失败（非法 JSON）的帧数，仅用于诊断。 */
  invalidFrames = 0;

  /** 推送一段已解码文本，返回本次能完整解析出的事件。 */
  push(chunk: string): StreamEvent[] {
    this.buffer += chunk;
    const events: StreamEvent[] = [];
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const rawLine = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      this.consumeLine(rawLine.replace(/\r$/, ''), events);
      index = this.buffer.indexOf('\n');
    }
    return events;
  }

  /** 流结束时冲掉最后一行（服务端正常以 `\n\n` 结尾，这里是防御性处理）。 */
  flush(): StreamEvent[] {
    const events: StreamEvent[] = [];
    if (this.buffer.length > 0) {
      const rawLine = this.buffer.replace(/\r$/, '');
      this.buffer = '';
      this.consumeLine(rawLine, events);
    }
    this.emitPending(events);
    return events;
  }

  private consumeLine(line: string, events: StreamEvent[]): void {
    if (line === '') {
      // 空行 = 帧结束。
      this.emitPending(events);
      return;
    }
    if (line.startsWith(':')) return; // SSE 注释/心跳
    if (line.startsWith('data:')) {
      const payload = line.slice('data:'.length);
      this.dataLines.push(payload.startsWith(' ') ? payload.slice(1) : payload);
      return;
    }
    // 没有 `data:` 前缀的裸 JSON 行：服务端固定带前缀，但保底解析一次。
    if (line.trimStart().startsWith('{')) {
      this.parsePayload(line, events);
    }
  }

  private emitPending(events: StreamEvent[]): void {
    if (this.dataLines.length === 0) return;
    const payload = this.dataLines.join('\n');
    this.dataLines = [];
    this.parsePayload(payload, events);
  }

  private parsePayload(payload: string, events: StreamEvent[]): void {
    const text = payload.trim();
    if (text.length === 0) return;
    try {
      const parsed = JSON.parse(text) as StreamEvent;
      if (parsed && typeof parsed === 'object') events.push(parsed);
      else this.invalidFrames += 1;
    } catch {
      this.invalidFrames += 1;
    }
  }
}

export type StreamOutcome = 'completed' | 'aborted' | 'disconnected' | 'rejected';

export interface ReadEventStreamOptions {
  /** 当前会话 id：帧里 `sessionId` 不同即视为"错会话"。 */
  sessionId: string;
  signal?: AbortSignal;
  onEvent: (event: StreamEvent) => void;
  /** 收到不属于当前会话/员工的帧时回调（用于提示与计数），默认丢弃。 */
  onForeignEvent?: (event: StreamEvent) => void;
}

export interface ReadEventStreamResult {
  outcome: StreamOutcome;
  /** 服务端是否明确给出 `stream_end`。 */
  sawStreamEnd: boolean;
  /** 是否收到过 `{type:'error'}` 帧。 */
  sawError: boolean;
  errorName?: string;
  errorBody?: string;
  foreignEvents: number;
  invalidFrames: number;
  /** 用户可读的失败说明（成功/中止时为 null）。 */
  message: string | null;
  /** 技术细节：只用于日志与验收，不展示给用户。 */
  detail?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function bodyToString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/**
 * 消费一条 SSE 流并结算。**不依赖具体网络实现**，便于用受控 `ReadableStream` 验证
 * 中止 / 断线 / 错会话 / 缓存缺失等场景。
 */
export async function readEventStream(
  stream: ReadableStream<Uint8Array>,
  options: ReadEventStreamOptions,
): Promise<ReadEventStreamResult> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const parser = new SseFrameParser();
  let sawStreamEnd = false;
  let sawError = false;
  let errorName: string | undefined;
  let errorBody: string | undefined;
  let foreignEvents = 0;

  const handle = (event: StreamEvent) => {
    const type = typeof event.type === 'string' ? event.type : '';
    // 错会话保护：服务端可能把多个会话的增量推给同一连接（原生同款判断，见
    // useChatMessageActions.ts:600-604 的 `if (sessionId !== data.sessionId) continue`）。
    if (typeof event.sessionId === 'string' && event.sessionId.length > 0 && event.sessionId !== options.sessionId) {
      foreignEvents += 1;
      options.onForeignEvent?.(event);
      return;
    }
    options.onEvent(event);
    if (type === 'stream_end') sawStreamEnd = true;
    if (type === 'error') {
      sawError = true;
      errorName = typeof event.errorName === 'string' ? event.errorName : undefined;
      errorBody = bodyToString(event.body) ?? bodyToString(event.error);
    }
  };

  const onAbort = () => {
    // 主动中止：取消底层读取，让 read() 尽快返回，避免悬挂。
    void reader.cancel().catch(() => undefined);
  };
  options.signal?.addEventListener('abort', onAbort);

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        for (const event of parser.flush()) handle(event);
        break;
      }
      if (value) {
        // 已中止时不再处理新帧，但仍要把 reader 读完以释放连接。
        if (!options.signal?.aborted) {
          for (const event of parser.push(decoder.decode(value, { stream: true }))) handle(event);
        }
      }
    }
  } catch (error) {
    if (options.signal?.aborted) {
      return {
        outcome: 'aborted',
        sawStreamEnd,
        sawError,
        errorName,
        errorBody,
        foreignEvents,
        invalidFrames: parser.invalidFrames,
        message: null,
      };
    }
    return {
      outcome: 'disconnected',
      sawStreamEnd,
      sawError,
      errorName,
      errorBody,
      foreignEvents,
      invalidFrames: parser.invalidFrames,
      message: '与服务端的连接中断，本次生成可能不完整。可以点击「继续接收」获取后续内容。',
    };
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      /* 已释放 */
    }
  }

  if (options.signal?.aborted) {
    return {
      outcome: 'aborted',
      sawStreamEnd,
      sawError,
      errorName,
      errorBody,
      foreignEvents,
      invalidFrames: parser.invalidFrames,
      message: null,
    };
  }

  if (sawError) {
    return {
      outcome: 'rejected',
      sawStreamEnd,
      sawError,
      errorName,
      errorBody,
      foreignEvents,
      invalidFrames: parser.invalidFrames,
      message: '模型没有完成这次回复，请稍后重试或换一个模型。',
    };
  }

  if (!sawStreamEnd) {
    return {
      outcome: 'disconnected',
      sawStreamEnd,
      sawError,
      errorName,
      errorBody,
      foreignEvents,
      invalidFrames: parser.invalidFrames,
      message: '本次生成没有正常结束，内容可能不完整。可以点击「继续接收」获取后续内容。',
    };
  }

  return {
    outcome: 'completed',
    sawStreamEnd,
    sawError,
    errorName,
    errorBody,
    foreignEvents,
    invalidFrames: parser.invalidFrames,
    message: null,
  };
}

export type ConversationStreamAction =
  | 'aiConversations:sendMessages'
  | 'aiConversations:resendMessages'
  | 'aiConversations:resumeStream'
  | 'aiConversations:resumeToolCall';

export interface OpenStreamOptions {
  action: ConversationStreamAction;
  data: Record<string, unknown>;
  signal: AbortSignal;
  /**
   * **仅供验证装配**：覆盖传输实现。
   *
   * 生产环境必须用 axios 的 `fetch` adapter（只有它能把 SSE 变成增量 `ReadableStream`；
   * xhr adapter 无法流式读取）。但单测里无法注入 fetch adapter 的底层 `fetch`
   * （axios 在模块加载时就捕获了它），因此验证时通过这里传入受控 adapter——
   * 请求仍然经过 `api.request` 的完整管线（认证、角色、传输策略、续期）。
   */
  transportAdapter?: unknown;
}

/**
 * 打开会话流。
 *
 * 与原生相同：`api.request` + `responseType: 'stream'` + `adapter: 'fetch'` + `Accept: text/event-stream`。
 * 注意 `adapter: 'fetch'` 是浏览器流式读取的必要条件（xhr adapter 拿不到增量 `ReadableStream`）。
 */
export async function openConversationStream(
  options: OpenStreamOptions,
): Promise<ReadableStream<Uint8Array> | null> {
  const response = await api.request({
    url: options.action,
    method: 'post',
    headers: { Accept: 'text/event-stream' },
    data: options.data,
    responseType: 'stream',
    adapter: options.transportAdapter ?? 'fetch',
    signal: options.signal,
  });
  const stream = response.data as unknown;
  if (isRecord(stream) && typeof (stream as { getReader?: unknown }).getReader === 'function') {
    return stream as unknown as ReadableStream<Uint8Array>;
  }
  return null;
}

export interface RunConversationStreamOptions extends OpenStreamOptions {
  sessionId: string;
  onEvent: (event: StreamEvent) => void;
  onForeignEvent?: (event: StreamEvent) => void;
  /** 测试注入：替换 `openConversationStream`（默认走真实请求管线）。 */
  open?: (options: OpenStreamOptions) => Promise<ReadableStream<Uint8Array> | null>;
}

/** 打开并消费一条会话流，返回结算结果。 */
export async function runConversationStream(
  options: RunConversationStreamOptions,
): Promise<ReadEventStreamResult> {
  const { open = openConversationStream, ...streamOptions } = options;
  let stream: ReadableStream<Uint8Array> | null;
  try {
    stream = await open(streamOptions);
  } catch (error) {
    if (options.signal.aborted) {
      return {
        outcome: 'aborted',
        sawStreamEnd: false,
        sawError: false,
        foreignEvents: 0,
        invalidFrames: 0,
        message: null,
      };
    }
    return {
      outcome: 'rejected',
      sawStreamEnd: false,
      sawError: false,
      foreignEvents: 0,
      invalidFrames: 0,
      message: '这次请求没有成功，请稍后重试；如果一直失败，请让管理员检查 AI 服务配置。',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (!stream) {
    return {
      outcome: 'rejected',
      sawStreamEnd: false,
      sawError: false,
      foreignEvents: 0,
      invalidFrames: 0,
      message: '服务端没有返回可读取的流式内容，请稍后重试。',
    };
  }
  return readEventStream(stream, {
    sessionId: options.sessionId,
    signal: options.signal,
    onEvent: options.onEvent,
    onForeignEvent: options.onForeignEvent,
  });
}
