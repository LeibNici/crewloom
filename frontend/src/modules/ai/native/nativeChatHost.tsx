import { Component, useEffect, useMemo, useState, type ErrorInfo, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { FlowEngineProvider } from '@nocobase/flow-engine';
import { ChatBoxLayout } from '@nocobase/plugin-ai/client-v2';
import { EmptyState, PageCard } from '../../../components/Card';
import { getLastHandoffState, handoffPreparedItemsToChatBox } from '../context/native';
import styles from '../group-a.module.css';
import './native-chat.css';
import { getNativeAIBridge } from './bridge';
import { ensureNativeRuntime, peekNativeRuntime, type NativeRuntimeHandle } from './runtime';

/**
 * AI-03 的**默认会话界面**：NocoBase 固定 2.2.22 的上游 ChatBox（固定源码 vendor）。
 *
 * 用户看到的就是这一套聊天界面（输入框、消息、发送/停止、附件、工具确认都由上游组件负责），
 * 不需要在"自研视图 / 原生组件"之间做选择；页面上也不出现任何组件、来源或实现术语。
 *
 * 宿主责任（只做上游要求的最小装配，不重写聊天逻辑）：
 *  1. 复用**共享原生运行上下文**（`./runtime`：真实 `Application` + 真实 `FrontendToolRegistry`，
 *     与 TD-03 任务页是同一个实例）；本组件只负责 React 渲染；
 *  2. 把用户在产品页选好的上下文交给会话输入区（`handoffPreparedItemsToChatBox`），不代替用户发送；
 *  3. 选中第一个可用员工并打开会话区。
 *
 * 失败处理：装配或渲染失败时，用户只看到自然中文说明与"重试"；技术诊断只进 `console`，
 * 不进界面，也**不会**静默换成自研实现冒充成功。
 */

/** 上游 `load()` 之后从 flow-engine 上下文取 AI 配置仓库（员工清单由它提供）。 */
interface AiConfigRepositoryLike {
  aiEmployees?: Array<{ username?: string }>;
  getAIEmployees?: () => Promise<Array<{ username?: string }>>;
}

interface FlowContextLike {
  aiConfigRepository?: AiConfigRepositoryLike;
}

class ChatBoundary extends Component<{ children: ReactNode; onError: () => void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, _info: ErrorInfo) {
    // 技术细节只留 console（真机排查用），不进界面。
    console.error('[crewloom] 会话界面渲染失败', error);
    this.props.onError();
  }

  render() {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

/**
 * 原生宿主挂载期间给 `<html>` 打标记：`native-chat.css` 只在存在该标记时抵消上游注入的
 * `html { padding-left: 450px }` / `body { transform: translateX(-450px) }` 让位样式，
 * 离开会话页即恢复，不影响产品其它页面。
 */
function useNativeChatLayoutMarker(active: boolean): void {
  useEffect(() => {
    if (!active || typeof document === 'undefined') return undefined;
    const root = document.documentElement;
    root.classList.add('crewloom-native-chat');
    return () => root.classList.remove('crewloom-native-chat');
  }, [active]);
}

/** 只读诊断入口（浏览器核对脚本用）：不暴露 execute/decide 等会改状态的调用。 */
type NativeAIDiagnostics = { describe: () => unknown; version: number };

/**
 * 原生工具调用状态（只读）：核对脚本据此比较"卡片拿到的 messageId"与
 * "原生 chatToolCallModel 里登记的 messageId"是否一致——两步确认是否可达就取决于它。
 */
function readToolCallState(): unknown {
  const runtime = peekNativeRuntime()?.runtime as unknown as {
    chatConversationModel?: { currentConversation?: string };
    chatToolCallModel?: {
      sessions?: Record<string, unknown>;
      getSessionState?: (sessionId?: string) => { toolCalls?: Record<string, unknown> } | undefined;
    };
  };
  const sessionId = runtime?.chatConversationModel?.currentConversation;
  const state = runtime?.chatToolCallModel?.getSessionState?.(sessionId);
  return {
    sessionId: sessionId ?? null,
    sessionKeys: Object.keys(runtime?.chatToolCallModel?.sessions ?? {}),
    toolCalls: state?.toolCalls ?? null,
  };
}

/** 会话消息的结构摘要（角色 / 类型 / 文本长度），不含任何正文，供核对脚本定位渲染问题。 */
function readMessageShape(): unknown {
  const runtime = peekNativeRuntime()?.runtime as unknown as {
    chatConversationModel?: { currentConversation?: string };
    chatMessageModel?: {
      getSessionState?: (sessionId?: string) => { messages?: Array<{ role?: string; content?: Record<string, unknown> }> };
    };
  };
  const sessionId = runtime?.chatConversationModel?.currentConversation;
  const state = runtime?.chatMessageModel?.getSessionState?.(sessionId);
  return {
    sessionId: sessionId ?? null,
    messages: (state?.messages ?? []).map((message) => ({
      role: message.role ?? null,
      type: message.content?.type ?? null,
      from: message.content?.from ?? null,
      textLength: String(message.content?.content ?? '').length,
      toolCalls: Array.isArray(message.content?.tool_calls) ? message.content.tool_calls.length : 0,
    })),
  };
}

function exposeDiagnostics(): void {
  if (typeof window === 'undefined') return;
  (window as unknown as Record<string, unknown>).__CREWLOOM_NATIVE_AI__ = {
    describe: () => ({
      ...getNativeAIBridge().describe(),
      handoff: getLastHandoffState(),
      toolCallState: readToolCallState(),
      messageShape: readMessageShape(),
    }),
    version: 1,
  } satisfies NativeAIDiagnostics;
}

export function NativeChatBoxHost() {
  const [phase, setPhase] = useState<'preparing' | 'ready' | 'failed'>('preparing');
  const [attempt, setAttempt] = useState(0);
  const [handle, setHandle] = useState<NativeRuntimeHandle | null>(() => peekNativeRuntime());
  useNativeChatLayoutMarker(phase === 'ready');

  useEffect(() => {
    let cancelled = false;
    setPhase('preparing');
    void (async () => {
      try {
        // 共享装配（真实 Application + 真实注册表）：任务页可能已经先装配过，这里直接复用同一实例。
        const runtimeHandle = await ensureNativeRuntime();
        if (cancelled) return;
        if (!runtimeHandle) {
          setPhase('failed');
          return;
        }
        // AI-04：把用户在上下文工作区选好的内容交给会话输入区（不代替用户发送）。
        handoffPreparedItemsToChatBox(runtimeHandle.runtime);
        setHandle(runtimeHandle);
        exposeDiagnostics();
        const context = (runtimeHandle.app as unknown as { flowEngine?: { context?: FlowContextLike } }).flowEngine
          ?.context;
        const repository = context?.aiConfigRepository;
        const employees = (await repository?.getAIEmployees?.()) ?? repository?.aiEmployees ?? [];
        if (cancelled) return;
        runtimeHandle.runtime.chatBoxModel.setCurrentEmployee((employees[0] ?? null) as never);
        runtimeHandle.runtime.chatBoxModel.setOpen(true);
        console.info('[crewloom] 原生会话已就绪', {
          toolCardRegistered: runtimeHandle.toolCardRegistered,
          toolCatalogPatched: runtimeHandle.toolCatalogPatched,
          datasourceRegistered: runtimeHandle.datasourceRegistered,
        });
        setPhase('ready');
      } catch (error) {
        console.error('[crewloom] 会话界面装配失败', error);
        if (!cancelled) setPhase('failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const engine = useMemo(() => handle?.app.flowEngine ?? null, [handle]);

  if (!handle || !engine || phase === 'failed') {
    return (
      <PageCard title="会话暂时无法打开" description="这不是账号或权限问题。">
        <EmptyState
          tone="warn"
          title="会话暂时无法打开"
          description="聊天界面没有准备好，稍后重试即可；如果一直打不开，请联系管理员。"
          actions={
            <button
              type="button"
              className={styles.button}
              onClick={() => {
                setPhase('preparing');
                setAttempt((value) => value + 1);
              }}
            >
              重试
            </button>
          }
        />
      </PageCard>
    );
  }

  return (
    <div className={styles.nativeChatFrame} data-testid="native-chatbox-frame">
      {phase === 'preparing' ? (
        <p className={styles.listItemHint}>正在准备聊天界面，请稍候…</p>
      ) : (
        <ChatBoundary onError={() => setPhase('failed')}>
          <FlowEngineProvider engine={engine}>
            {/* 上游聊天布局内部用了 react-router 的 `useLocation`；原生由 Application 的
                memory router 提供，这里不渲染管理壳但要补同一层 Router。 */}
            <MemoryRouter initialEntries={['/']}>
              <ChatBoxLayout />
            </MemoryRouter>
          </FlowEngineProvider>
        </ChatBoundary>
      )}
    </div>
  );
}
