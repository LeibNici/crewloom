/**
 * 原生会话流的**收尾适配层**（宿主侧，不改 vendor 一个字节）。
 *
 * 背景（报告 33 / 45 的 Main 实测）：
 *  1. `[[drop]]`：外置 socket 真被切断后，客户端**永远停在“正在生成”**，没有断线说明；
 *  2. 手动停止：`abort` 200，但界面出现普通失败提示，且已收到的部分内容消失。
 *
 * 根因分两层，必须一起修：
 *  - **外层代理**：http-proxy 默认只中止 pipe，不结束浏览器侧响应，所以浏览器根本收不到
 *    “连接结束”（已在 `vite.config.ts` 的代理配置里把上游 `aborted`/`error` 显式转成客户端断开）。
 *  - **产品宿主**：上游固定源码 `useChatMessageActions` 对“读流途中异常结束”按普通错误处理
 *    （`error = true` → 把最后一条消息整条换成错误文案，并透出英文/通用兜底），
 *    对 `AbortError` 则直接 `clearAllPendingStreamUpdates()` 丢弃已收到的增量。
 *
 * 本层只做三件事：把**流本身的结束方式**规整成固定源码能正确结算的形状 ——
 *  - 正常：原样透传（不做任何改写）；
 *  - 主动停止（`signal.aborted` / `AbortError`）：**静默**正常结束，保留已收到的增量；
 *  - 意外断线（socket 断开、网络错误、代理中断）：补一条 `error` 帧（中文说明由 i18n 提供），
 *    让界面收敛为“连接中断，已保留已收到内容”，而不是通用失败。
 * 另外做一次**角色代次保护**：角色切换后，旧身份的迟到帧不再写入当前身份的消息状态，
 * 流正常结束，固定源码随后的 `loadMessages` 用新角色重读（见 `StreamIdentityGuard`）。
 *
 * 不改写任何一帧真实内容，不伪造业务结果；只在“原本没有终态”时补终态。
 */

import { getAuthContext } from '../../../api/client';

/** 需要收尾适配的原生会话动作（其余请求原样放行）。 */
const STREAM_ACTIONS = new Set([
  'aiConversations:sendMessages',
  'aiConversations:resendMessages',
  'aiConversations:resumeStream',
]);

/** 服务端已给出终态语义的帧类型：见到它们就不再补“断线说明”。 */
const TERMINAL_FRAME = /"type"\s*:\s*"(stream_end|error|chunks_cache_missing)"/;

/**
 * 意外断线时补的**错误帧名**（固定源码把 errorName 交给 i18n，见 `nativeChatI18n.ts`）。
 *
 * 用错误帧而不是补一段 content：原生 `loadMessages` 会用历史覆盖消息列表，
 * 但会**保留最后一条 role='error' 的消息**（`useChatMessageActions.ts:270-275`）。
 * 这样"连接中断说明"不会被随后的历史加载抹掉，而已落库的部分内容仍作为历史消息显示。
 */
export const DISCONNECT_ERROR_NAME = 'CREWLOOM_STREAM_DISCONNECTED';

/** 中文说明（与 `NATIVE_CHAT_ERROR_MESSAGES` 里同一 key 的文案保持一致）。 */
export const DISCONNECT_NOTICE =
  '连接中断了，上面是已经收到的内容。这条回复没有完整生成，请检查网络后重新发送。';

interface StreamingConfigLike {
  url?: unknown;
  responseType?: unknown;
  data?: unknown;
  signal?: unknown;
}

interface StreamResponseLike {
  data?: unknown;
}

function actionOf(config: StreamingConfigLike | undefined): string {
  const url = typeof config?.url === 'string' ? config.url : '';
  return url.split('?')[0].replace(/^\/api\//, '');
}

function sessionIdOf(config: StreamingConfigLike | undefined): string | null {
  const data = config?.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const raw = (data as { sessionId?: unknown; values?: unknown }).sessionId;
    if (typeof raw === 'string' && raw) return raw;
    const values = (data as { values?: unknown }).values;
    if (values && typeof values === 'object' && typeof (values as { sessionId?: unknown }).sessionId === 'string') {
      return String((values as { sessionId: string }).sessionId);
    }
  }
  return null;
}

function isAbort(error: unknown, config: StreamingConfigLike | undefined): boolean {
  const signal = config?.signal as { aborted?: boolean } | undefined;
  if (signal?.aborted) return true;
  const name = error && typeof error === 'object' ? (error as { name?: unknown }).name : undefined;
  return name === 'AbortError' || name === 'CanceledError';
}

const encoder = new TextEncoder();

/** 一条 `data: <json>\n\n` 帧（与固定源码/受控后端完全同形）。 */
function frame(payload: Record<string, unknown>): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * 角色代次保护：原生会话流在请求开始时记下生效角色；角色切换后，旧身份的迟到帧
 * **不再写入当前身份的消息状态**（流正常结束，固定源码随后的 `loadMessages` 用新角色重读，
 * 显示的是新身份被授权的内容）。只读角色，不改任何会话/权限状态。
 */
export interface StreamIdentityGuard {
  /** 请求开始时的生效角色。 */
  roleAtStart: string | null;
  /** 读取当前生效角色。 */
  currentRole: () => string | null;
}

/**
 * 包装上游 `ReadableStream`：透传全部原始字节，只在没有终态时补上终态。
 *
 * @param source 原生 `api.request` 返回的 `response.data`（`responseType: 'stream'`）。
 * @param options.sessionId 当前会话 id（补帧时需要，固定源码按它过滤）。
 * @param options.config 原始请求配置（读 `signal` 判断是不是用户主动停止）。
 * @param options.identity 角色代次保护（可选）：角色变化后不再转发旧身份的帧。
 */
export function recoverEventStream(
  source: ReadableStream<Uint8Array>,
  options: { sessionId?: string | null; config?: StreamingConfigLike; identity?: StreamIdentityGuard },
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  const sessionId = options.sessionId ?? null;
  const identityChanged = (): boolean =>
    Boolean(options.identity && options.identity.currentRole() !== options.identity.roleAtStart);
  let tail = '';
  let terminal = false;
  let finished = false;

  const closeWithTerminal = (controller: ReadableStreamDefaultController<Uint8Array>, notice: boolean) => {
    if (finished) return;
    finished = true;
    if (notice && sessionId) {
      // 只补一条 error 帧：固定源码据此显示中文说明，并在随后的历史加载中被保留。
      controller.enqueue(
        frame({ type: 'error', from: 'main-agent', sessionId, errorName: DISCONNECT_ERROR_NAME }),
      );
    }
    controller.close();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      // 角色已切换：旧身份的流立即收束（不报错、不补说明），让固定源码用新角色重新读历史。
      if (identityChanged()) {
        finished = true;
        controller.close();
        return;
      }
      try {
        const { done, value } = await reader.read();
        // 读回来之后才发生的角色切换：这一帧属于旧身份，不能写入当前身份状态。
        if (identityChanged()) {
          finished = true;
          controller.close();
          return;
        }
        if (done) {
          // 上游正常结束但没有终态帧：若是用户主动停止就静默，否则补中文断线说明。
          const aborted = isAbort(undefined, options.config);
          closeWithTerminal(controller, !terminal && !aborted);
          return;
        }
        if (value && value.byteLength > 0) {
          const text = decoder.decode(value, { stream: true });
          tail = `${tail}${text}`.slice(-8192);
          if (TERMINAL_FRAME.test(tail)) terminal = true;
          controller.enqueue(value);
        }
      } catch (error) {
        // 主动停止：固定源码的 AbortError 分支会丢弃增量，这里改成“正常结束”，保留已收到内容。
        if (isAbort(error, options.config)) {
          finished = true;
          controller.close();
          return;
        }
        closeWithTerminal(controller, !terminal);
      }
    },
    cancel(reason) {
      finished = true;
      return reader.cancel(reason);
    },
  });
}

/**
 * 给原生宿主的 `apiClient` 装上流收尾适配（只拦截三个会话流动作）。
 *
 * 用 Proxy 限定在**原生 `Application` 的 apiClient** 上，不动产品 SDK 本身：
 * `resource()` 等非流动作拿到绑回真实客户端的函数，行为完全不变。
 */
export interface RequestCapableClient {
  request: (config: never) => Promise<unknown>;
}

export function installNativeChatStreamRecovery<T extends object>(client: T): T {
  const target = client as unknown as Record<string, unknown>;
  const original = target.request as (config: never) => Promise<unknown>;
  if (typeof original !== 'function') return client;

  const guarded = async (config: never): Promise<unknown> => {
    const typed = config as unknown as StreamingConfigLike;
    const watched = STREAM_ACTIONS.has(actionOf(typed)) && typed.responseType === 'stream';
    // 角色在**请求发出时**的快照：角色切换后，旧身份流不再影响当前身份状态。
    const roleAtStart = watched ? getAuthContext().role : null;
    const response = (await original.call(target, config)) as StreamResponseLike | undefined;
    if (!watched) return response;
    const data = response?.data;
    if (!data || typeof (data as ReadableStream<Uint8Array>).getReader !== 'function') return response;
    return {
      ...response,
      data: recoverEventStream(data as ReadableStream<Uint8Array>, {
        sessionId: sessionIdOf(typed),
        config: typed,
        identity: { roleAtStart, currentRole: () => getAuthContext().role },
      }),
    };
  };

  return new Proxy(client, {
    get(object, property, receiver) {
      if (property === 'request') return guarded;
      const value = Reflect.get(object, property, receiver) as unknown;
      // 方法绑回真实客户端：`resource()` 内部仍走未被包装的 `request`（非流动作语义不变）。
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(object) : value;
    },
  }) as T;
}
