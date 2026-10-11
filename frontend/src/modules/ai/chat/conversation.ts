import type { AiMessageRow } from '../types';
import type { ReadEventStreamResult, StreamEvent } from './sse';

/**
 * 会话流的状态归约（组 A 独占，纯函数，便于受控验证）。
 *
 * 与原生 `processStreamResponse`（`useChatMessageActions.ts:300-660`）处理同一批事件，
 * 但把状态放在可测试的累积器里，并显式修好 P2 的 6 个失败点：
 *  - 结束后 `streaming=false` 一定成立（`finalizeStream` 无条件结算）；
 *  - 中止静默：`aborted` 不加错误气泡；
 *  - `chunks_cache_missing` 单独标记；
 *  - 断线给可继续接收的可读说明；
 *  - 错会话帧不进入消息；
 *  - 工具调用状态按 `toolCallId` 更新到对应消息。
 */

export interface ChatToolCall {
  id: string;
  name: string;
  args: string;
  status?: string;
  invokeStatus?: string;
  willInterrupt?: boolean;
  messageId?: string;
  content?: unknown;
  auto?: boolean;
}

export interface ChatMessage {
  key: string;
  /** `user` / `error` / 员工用户名（助手）。 */
  role: string;
  text: string;
  reasoning: string;
  reasoningStatus?: string;
  toolCalls: ChatToolCall[];
  workContext?: unknown;
  loading: boolean;
  isError?: boolean;
  createdAt?: string;
}

export interface StreamAccumulator {
  messages: ChatMessage[];
  /** 是否收到过 `stream_end`。 */
  sawEnd: boolean;
  /** 服务端提示"增量缓存已缺失"（`chunks_cache_missing`）。 */
  resumeFailed: boolean;
  /** 被丢弃的错会话帧数（应当为 0；不为 0 说明服务端推了别的会话的增量）。 */
  foreignFrames: number;
  /** 联网搜索状态（`web_search` 帧）。 */
  webSearch: unknown[] | null;
  /** 主代理是否在后台继续工作（`from: main-agent` 的任意帧即认为结束后台态）。 */
  backgroundWorking: boolean;
  /** 子代理会话完成状态。 */
  subAgentStatus: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/** 从历史消息行提取可展示文本；未知富内容返回空串，不把原始 JSON 抛给用户。 */
export function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
      .join('');
  }
  if (isRecord(content)) {
    const inner = content.content;
    if (typeof inner === 'string') return inner;
    if (Array.isArray(inner)) return textOfContent(inner);
    if (typeof content.text === 'string') return content.text;
  }
  return '';
}

function normalizeToolCalls(raw: unknown): ChatToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .map((item) => ({
      id: typeof item.id === 'string' ? item.id : String(item.id ?? ''),
      name: typeof item.name === 'string' ? item.name : '',
      args: typeof item.args === 'string' ? item.args : item.args ? JSON.stringify(item.args) : '',
      status: typeof item.status === 'string' ? item.status : undefined,
      invokeStatus: typeof item.invokeStatus === 'string' ? item.invokeStatus : undefined,
      willInterrupt: item.willInterrupt === true,
      messageId: typeof item.messageId === 'string' ? item.messageId : undefined,
      content: item.content,
      auto: item.auto === true,
    }));
}

function reasoningOf(content: Record<string, unknown>): string {
  const reasoning = content.reasoning;
  if (typeof reasoning === 'string') return reasoning;
  if (isRecord(reasoning) && typeof reasoning.content === 'string') return reasoning.content;
  return '';
}

/** 把 `getMessages` 的历史行归一到界面消息（服务端已按 `-messageId` 倒序，调用方负责翻正）。 */
export function messagesFromHistory(rows: AiMessageRow[], employeeUsername: string): ChatMessage[] {
  return rows
    .map((row, index): ChatMessage | null => {
      if (!isRecord(row)) return null;
      const content = isRecord(row.content) ? (row.content as Record<string, unknown>) : {};
      const messageId = row.messageId ?? content.messageId ?? `history-${index}`;
      const role = typeof row.role === 'string' && row.role.length > 0 ? row.role : employeeUsername;
      return {
        key: String(messageId),
        role,
        text: textOfContent(row.content),
        reasoning: reasoningOf(content),
        toolCalls: normalizeToolCalls(content.tool_calls ?? row.toolCalls),
        workContext: content.workContext,
        loading: false,
        createdAt: typeof row.createdAt === 'string' ? row.createdAt : undefined,
      };
    })
    .filter((item): item is ChatMessage => item !== null);
}

export function createAccumulator(messages: ChatMessage[] = []): StreamAccumulator {
  return {
    messages,
    sawEnd: false,
    resumeFailed: false,
    foreignFrames: 0,
    webSearch: null,
    backgroundWorking: false,
    subAgentStatus: {},
  };
}

function updateLast(messages: ChatMessage[], updater: (last: ChatMessage) => ChatMessage): ChatMessage[] {
  if (messages.length === 0) return messages;
  const next = messages.slice();
  next[next.length - 1] = updater(next[next.length - 1]);
  return next;
}

function isToolCallArray(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value) && value.every((item) => isRecord(item));
}

/**
 * 归约一帧。
 *
 * 只处理已确认存在的事件类型（报告 01 的 12 类）；未知类型原样忽略，
 * 不猜测、不伪造内容。
 */
export function applyStreamEvent(
  accumulator: StreamAccumulator,
  event: StreamEvent,
  ctx: { employeeUsername: string; sessionId: string },
): StreamAccumulator {
  const type = typeof event.type === 'string' ? event.type : '';
  const from = typeof event.from === 'string' ? event.from : 'main-agent';
  const next: StreamAccumulator = { ...accumulator, messages: accumulator.messages };

  if (type === 'stream_end') next.sawEnd = true;
  if (type === 'stream_start') next.backgroundWorking = false;
  if (type === 'chunks_cache_missing') next.resumeFailed = true;
  if (type === 'web_search') next.webSearch = Array.isArray(event.body) ? event.body : next.webSearch;
  if (type === 'sub_agent_completed' && typeof event.sessionId === 'string') {
    next.subAgentStatus = { ...next.subAgentStatus, [event.sessionId]: 'completed' };
  }
  if (from === 'main-agent') next.backgroundWorking = false;

  if (type === 'error') {
    next.messages = [
      ...accumulator.messages,
      {
        key: `error-${Date.now()}-${accumulator.messages.length}`,
        role: 'error',
        text: '模型没有完成这次回复，请稍后重试或换一个模型。',
        reasoning: '',
        toolCalls: [],
        loading: false,
        isError: true,
      },
    ];
    return next;
  }

  if (type === 'new_message') {
    next.messages = [
      ...accumulator.messages,
      {
        key: `msg-${Date.now()}-${accumulator.messages.length}`,
        role: from === 'sub-agent' && typeof event.username === 'string' ? event.username : ctx.employeeUsername,
        text: '',
        reasoning: '',
        toolCalls: [],
        loading: true,
      },
    ];
    return next;
  }

  const body = event.body;

  if (type === 'content' && typeof body === 'string') {
    next.messages = updateLast(accumulator.messages, (last) => ({
      ...last,
      text: `${last.text}${body}`,
      loading: true,
    }));
    return next;
  }

  if (type === 'reasoning' && isRecord(body) && typeof body.content === 'string') {
    next.messages = updateLast(accumulator.messages, (last) => ({
      ...last,
      reasoning: `${last.reasoning}${body.content as string}`,
      reasoningStatus: typeof body.status === 'string' ? body.status : last.reasoningStatus,
      loading: true,
    }));
    return next;
  }

  if (type === 'tool_call_chunks' && isToolCallArray(body)) {
    const chunks = body as Array<Record<string, unknown>>;
    next.messages = updateLast(accumulator.messages, (last) => {
      const toolCalls = last.toolCalls.slice();
      for (const chunk of chunks) {
        const name = typeof chunk.name === 'string' ? chunk.name : '';
        const args = typeof chunk.args === 'string' ? chunk.args : '';
        if (name) {
          toolCalls.push({
            id: typeof chunk.id === 'string' ? chunk.id : '',
            name,
            args,
            invokeStatus: 'init',
          });
        } else if (toolCalls.length > 0) {
          const previous = toolCalls[toolCalls.length - 1];
          toolCalls[toolCalls.length - 1] = { ...previous, args: `${previous.args}${args}` };
        }
      }
      return { ...last, toolCalls, loading: true };
    });
    return next;
  }

  if (type === 'tool_calls' && isRecord(body) && Array.isArray(body.toolCalls)) {
    const incoming = normalizeToolCalls(body.toolCalls);
    next.messages = updateLast(accumulator.messages, (last) => ({
      ...last,
      toolCalls: incoming.length > 0 ? incoming : last.toolCalls,
      loading: true,
    }));
    return next;
  }

  if (type === 'tool_call_status' && isRecord(body)) {
    const toolCall = isRecord(body.toolCall) ? body.toolCall : {};
    const id = typeof toolCall.id === 'string' ? toolCall.id : undefined;
    next.messages = updateLast(accumulator.messages, (last) => ({
      ...last,
      toolCalls: last.toolCalls.map((call) =>
        call.id === id
          ? {
              ...call,
              invokeStatus:
                typeof body.invokeStatus === 'string' ? (body.invokeStatus as string) : call.invokeStatus,
              status: typeof body.status === 'string' ? (body.status as string) : call.status,
              content: body.content ?? call.content,
              willInterrupt:
                toolCall.willInterrupt === true || call.willInterrupt === true,
              messageId: typeof toolCall.messageId === 'string' ? toolCall.messageId : call.messageId,
            }
          : call,
      ),
      loading: true,
    }));
  }

  return next;
}

/**
 * 结算一条流。
 *
 * **无条件**把最后一条助手消息的 `loading` 置为 false——这是 P2「断线后
 * responseLoading 未归位」的直接修复：无论 completed / aborted / disconnected / rejected，
 * 界面都不会停在"正在生成"。
 */
export function finalizeStream(
  accumulator: StreamAccumulator,
  result: Pick<ReadEventStreamResult, 'outcome' | 'message'>,
): StreamAccumulator {
  const messages = accumulator.messages.map((message) => ({ ...message, loading: false }));
  if (result.outcome === 'rejected' && result.message) {
    const last = messages[messages.length - 1];
    if (last && !last.isError && last.text.length === 0 && last.toolCalls.length === 0) {
      messages[messages.length - 1] = {
        ...last,
        role: 'error',
        text: result.message,
        isError: true,
      };
    }
  }
  return { ...accumulator, messages };
}

/** 结算后拼给用户的说明；中止静默返回 null。 */
export function outcomeNotice(result: ReadEventStreamResult): string | null {
  if (result.outcome === 'aborted') return null;
  if (result.outcome === 'completed') return null;
  if (result.outcome === 'rejected') return result.message ?? '模型没有完成这次回复，请稍后重试。';
  return result.message;
}

/** 仍有工具调用处于等待/中断态时，界面需要提供"继续执行"。 */
export function pendingToolCalls(messages: ChatMessage[]): ChatToolCall[] {
  return messages
    .flatMap((message) => message.toolCalls)
    .filter((call) => call.willInterrupt || call.invokeStatus === 'waiting' || call.invokeStatus === 'interrupted');
}
