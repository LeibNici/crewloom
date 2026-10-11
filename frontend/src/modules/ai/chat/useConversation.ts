import { useCallback, useEffect, useRef, useState } from 'react';
import type { ResourceState } from '../../../api/hooks';
import { CrewloomError, toUserMessage } from '../../../api/errors';
import { api } from '../../../api/client';
import { abortConversation, loadConversationMessages } from '../resources';
import {
  applyStreamEvent,
  createAccumulator,
  finalizeStream,
  messagesFromHistory,
  outcomeNotice,
  pendingToolCalls as collectPendingToolCalls,
} from './conversation';
import type { ChatMessage, ChatToolCall, StreamAccumulator } from './conversation';
import { runConversationStream, type ConversationStreamAction, type ReadEventStreamResult } from './sse';

/**
 * 会话工作区的状态机（组 A 独占）。
 *
 * 负责：历史读取 → 乐观追加 → SSE 增量 → 结算 → 中止 / 续流 / 工具确认。
 * 所有网络调用都走组 A 的 `resources.ts`（进而走公共请求管线），没有第二条通道。
 *
 * 已修复的 P2 现象（在 `sse.ts` / `conversation.ts` 的解析与归约层，不在页面里绕开）：
 *  1. 完整终态：结算无条件关闭 loading；
 *  2. 中止静默：本地 `AbortController` + 服务端 `abort`，界面不产生错误气泡；
 *  3. 缓存缺失：`chunks_cache_missing` 明确提示"服务端已没有这段增量"；
 *  4. 续流重放：`resumeStream` 复用同一条解析与结算路径；
 *  5. 断线：连接异常结束也结算，并给出"继续接收"的入口；
 *  6. 错会话：`sessionId` 不匹配的帧被解析层丢弃并计数，不进入当前会话。
 */

export type ConversationPhase = 'idle' | 'streaming' | 'completed' | 'aborted' | 'disconnected' | 'rejected';

export interface StreamRunSummary {
  outcome: ReadEventStreamResult['outcome'];
  foreignEvents: number;
  invalidFrames: number;
  message: string | null;
}

export interface SendMessageInput {
  employeeUsername: string;
  text: string;
  model?: { llmService: string; model: string } | null;
  webSearch?: boolean;
  /** 首条消息携带的上下文项（`messages[0].workContext`）。 */
  workContext?: unknown[];
}

export interface UseConversationSessionResult {
  messages: ChatMessage[];
  historyState: ResourceState;
  historyMessage: string | null;
  phase: ConversationPhase;
  streaming: boolean;
  notice: string | null;
  resumeFailed: boolean;
  webSearch: unknown[] | null;
  pendingToolCalls: ChatToolCall[];
  reload: () => Promise<void>;
  send: (input: SendMessageInput) => Promise<StreamRunSummary | null>;
  resend: (input: { employeeUsername: string; messageId: string; model?: SendMessageInput['model'] }) => Promise<StreamRunSummary | null>;
  resumeStream: (employeeUsername: string) => Promise<StreamRunSummary | null>;
  abort: () => Promise<void>;
  decideTool: (input: {
    employeeUsername: string;
    messageId: string;
    toolCallId: string;
    decision: 'approve' | 'edit' | 'reject';
    editedAction?: { name: string; args: unknown };
    model?: SendMessageInput['model'];
  }) => Promise<void>;
  clearNotice: () => void;
}

function summaryOf(result: ReadEventStreamResult): StreamRunSummary {
  return {
    outcome: result.outcome,
    foreignEvents: result.foreignEvents,
    invalidFrames: result.invalidFrames,
    message: result.message,
  };
}

function classifyHistoryError(error: unknown): { state: ResourceState; message: string | null } {
  if (error instanceof CrewloomError) {
    if (error.kind === 'forbidden') return { state: 'denied', message: null };
    if (error.kind === 'unauthenticated' || error.kind === 'role-invalid') {
      return { state: 'unauthorized', message: error.userMessage };
    }
  }
  return { state: 'error', message: toUserMessage(error) };
}

export function useConversationSession(options: {
  sessionId: string | null;
  employeeUsername: string;
}): UseConversationSessionResult {
  const { sessionId, employeeUsername } = options;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [historyState, setHistoryState] = useState<ResourceState>(sessionId ? 'loading' : 'empty');
  const [historyMessage, setHistoryMessage] = useState<string | null>(null);
  const [phase, setPhase] = useState<ConversationPhase>('idle');
  const [notice, setNotice] = useState<string | null>(null);
  const [resumeFailed, setResumeFailed] = useState(false);
  const [webSearch, setWebSearch] = useState<unknown[] | null>(null);
  const [pendingToolCalls, setPendingToolCalls] = useState<ChatToolCall[]>([]);

  const accumulatorRef = useRef<StreamAccumulator>(createAccumulator());
  const controllerRef = useRef<AbortController | null>(null);
  const runSeqRef = useRef(0);

  const commit = useCallback((accumulator: StreamAccumulator) => {
    accumulatorRef.current = accumulator;
    setMessages(accumulator.messages);
    setResumeFailed(accumulator.resumeFailed);
    setWebSearch(accumulator.webSearch);
    setPendingToolCalls(collectPendingToolCalls(accumulator.messages));
  }, []);

  const reload = useCallback(async () => {
    if (!sessionId) {
      commit(createAccumulator());
      setHistoryState('empty');
      setHistoryMessage(null);
      return;
    }
    setHistoryState('loading');
    setHistoryMessage(null);
    try {
      // `loadConversationMessages` 默认显式传 `updateRead=false`：只有 `'true'`/`true` 才会在
      // 服务端把会话标记为已读（写操作），自动只读验证不会产生写副作用。
      const history = await loadConversationMessages(sessionId, { paginate: false, updateRead: false });
      const normalized = messagesFromHistory(history.rows, employeeUsername);
      commit(createAccumulator(normalized));
      setHistoryState(normalized.length > 0 ? 'ready' : 'empty');
    } catch (error) {
      const classified = classifyHistoryError(error);
      setHistoryState(classified.state);
      setHistoryMessage(classified.message);
    }
  }, [sessionId, employeeUsername, commit]);

  useEffect(() => {
    runSeqRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    setPhase('idle');
    setNotice(null);
    void reload();
  }, [reload]);

  const runStream = useCallback(
    async (
      action: ConversationStreamAction,
      data: Record<string, unknown>,
      optimistic?: (current: ChatMessage[], employee: string) => ChatMessage[],
    ): Promise<StreamRunSummary> => {
      const seq = ++runSeqRef.current;
      const controller = new AbortController();
      controllerRef.current = controller;
      let accumulator = accumulatorRef.current;
      if (optimistic) accumulator = { ...accumulator, messages: optimistic(accumulator.messages, employeeUsername) };
      commit(accumulator);
      setPhase('streaming');
      setNotice(null);

      const result = await runConversationStream({
        action,
        data,
        signal: controller.signal,
        sessionId: sessionId ?? '',
        onEvent: (event) => {
          if (seq !== runSeqRef.current) return;
          commit(applyStreamEvent(accumulatorRef.current, event, { employeeUsername, sessionId: sessionId ?? '' }));
        },
      });

      if (seq === runSeqRef.current) {
        const finalized = finalizeStream(accumulatorRef.current, result);
        commit(finalized);
        setPhase(result.outcome === 'completed' ? 'completed' : (result.outcome as ConversationPhase));
        setNotice(outcomeNotice(result));
        controllerRef.current = null;
      }
      return summaryOf(result);
    },
    [sessionId, employeeUsername, commit],
  );

  const send = useCallback(
    async (input: SendMessageInput): Promise<StreamRunSummary | null> => {
      if (!sessionId) return null;
      const text = input.text.trim();
      if (text.length === 0) return null;
      const messages = [
        {
          role: 'user',
          content: { type: 'text', content: text },
          ...(input.workContext && input.workContext.length > 0 ? { workContext: input.workContext } : {}),
        },
      ];
      return runStream(
        'aiConversations:sendMessages',
        {
          aiEmployee: input.employeeUsername,
          sessionId,
          messages,
          model: input.model ?? undefined,
          webSearch: input.webSearch === true,
        },
        (current) => [
          ...current,
          {
            key: `local-user-${Date.now()}`,
            role: 'user',
            text,
            reasoning: '',
            toolCalls: [],
            workContext: input.workContext,
            loading: false,
          },
          {
            key: `local-assistant-${Date.now()}`,
            role: input.employeeUsername,
            text: '',
            reasoning: '',
            toolCalls: [],
            loading: true,
          },
        ],
      );
    },
    [sessionId, runStream],
  );

  const resend = useCallback(
    async (input: { employeeUsername: string; messageId: string; model?: SendMessageInput['model'] }) => {
      if (!sessionId) return null;
      return runStream(
        'aiConversations:resendMessages',
        {
          sessionId,
          messageId: input.messageId,
          model: input.model ?? undefined,
          webSearch: false,
        },
        (current) => {
          const index = current.findIndex((message) => message.key === input.messageId);
          const head = index >= 0 ? current.slice(0, index) : current;
          return [
            ...head,
            {
              key: `local-assistant-${Date.now()}`,
              role: input.employeeUsername,
              text: '',
              reasoning: '',
              toolCalls: [],
              loading: true,
            },
          ];
        },
      );
    },
    [sessionId, runStream],
  );

  const resumeStream = useCallback(
    async (employee: string) => {
      if (!sessionId) return null;
      return runStream('aiConversations:resumeStream', { sessionId }, (current) => [
        ...current,
        {
          key: `local-assistant-${Date.now()}`,
          role: employee,
          text: '',
          reasoning: '',
          toolCalls: [],
          loading: true,
        },
      ]);
    },
    [sessionId, runStream],
  );

  const abort = useCallback(async () => {
    if (!sessionId) return;
    runSeqRef.current += 1; // 丢弃在途响应，避免中止后旧帧回写
    controllerRef.current?.abort();
    controllerRef.current = null;
    const finalized = finalizeStream(accumulatorRef.current, { outcome: 'aborted', message: null });
    commit(finalized);
    setPhase('aborted');
    setNotice('已停止本次生成。');
    try {
      await abortConversation(sessionId);
    } catch (error) {
      // 服务端中止失败不影响本地已停止的事实；如实提示用户服务端状态可能仍在收尾。
      setNotice(
        `已在本机停止接收，但服务端可能仍在收尾：${error instanceof CrewloomError ? error.userMessage : '请稍后刷新查看最新内容。'}`,
      );
    }
  }, [sessionId, commit]);

  const decideTool = useCallback(
    async (input: {
      employeeUsername: string;
      messageId: string;
      toolCallId: string;
      decision: 'approve' | 'edit' | 'reject';
      editedAction?: { name: string; args: unknown };
      model?: SendMessageInput['model'];
    }) => {
      if (!sessionId) return;
      const userDecision =
        input.decision === 'edit'
          ? { type: 'edit' as const, editedAction: input.editedAction }
          : { type: input.decision };
      const result = await api.resourceAction<{ updated?: number; toolCalls?: Array<Record<string, unknown>> }>(
        'aiConversations',
        'updateUserDecision',
        { values: { sessionId, messageId: input.messageId, toolCallId: input.toolCallId, userDecision } },
      );
      const updated = Number(result.data?.updated ?? 0);
      if (updated === 0) {
        setNotice('这条工具确认已经处理过了，界面会刷新为最新状态。');
        await reload();
        return;
      }
      const toolCalls = Array.isArray(result.data?.toolCalls) ? result.data!.toolCalls! : [];
      const allWaiting = toolCalls.every((call) => {
        const decision = (call as { userDecision?: unknown }).userDecision;
        return decision !== undefined && decision !== null;
      });
      if (!allWaiting) {
        setNotice('已记录你的选择，还有其它工具等待确认。');
        await reload();
        return;
      }
      // 前端工具的执行依赖原生 flow-engine 上下文；本工作区不伪造执行结果，只提交后端工具的结果。
      await runStream('aiConversations:resumeToolCall', {
        sessionId,
        messageId: input.messageId,
        toolCallIds: toolCalls.map((call) => String((call as { id?: unknown }).id ?? '')).filter(Boolean),
        toolCallResults: [],
        model: input.model ?? undefined,
        webSearch: false,
      });
    },
    [sessionId, reload, runStream],
  );

  const clearNotice = useCallback(() => setNotice(null), []);

  return {
    messages,
    historyState,
    historyMessage,
    phase,
    streaming: phase === 'streaming',
    notice,
    resumeFailed,
    webSearch,
    pendingToolCalls,
    reload,
    send,
    resend,
    resumeStream,
    abort,
    decideTool,
    clearNotice,
  };
}
