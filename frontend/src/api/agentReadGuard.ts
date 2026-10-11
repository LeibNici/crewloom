/**
 * Agent 历史读取守卫（浏览器 / SDK 通道）。
 *
 * 背景（固定 2.2.22 原生源码 `client-v2/ai-employees/chatbox/hooks/useChatMessageActions.ts:200-220`）：
 * 原生 ChatBox 读会话历史时调用 `api.resource('aiConversations').getMessages({...})`，
 * 而 SDK 对非 `get`/`list` 动作默认用 **POST**（`@nocobase/sdk` `APIClient.resource`），
 * 并且会带上 `updateRead: shouldUpdateRead`——聊天面板处于打开状态时它是 **true**。
 * 服务端只有收到 `true`/`'true'` 才会把会话标记为已读（写副作用，
 * `plugin-ai/server/resource/aiConversations.ts` 的 `updateRead` 判定）。
 *
 * 因此自动验证（strict）与受控验证（本机 controlled 后端）期间，本守卫在**请求发出前**
 * 把这条请求改写为"只读 GET + 显式 updateRead=false"：
 *  - 与产品自身历史读取（`resources.ts` 的 `readAction`，本来就是 GET + false）语义一致；
 *  - 真实后端上不会产生任何"标记已读"的写入；
 *  - 正常 **product** 模式下不改写：真实用户打开会话时的"标记已读"是产品本来的行为。
 *
 * 守卫必须**先于**传输策略拦截器执行，所以安装顺序是
 * `installTransportGuard(...)` → `installAgentReadGuard(...)`（axios 请求拦截器后注册者先运行）。
 * 计数挂在 `getAgentReadGuardState()` 上，供浏览器验收脚本回读。
 */
import type { AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import { parseApiAction } from './policy';
import { currentMode } from './transportGuard';

export interface AgentReadGuardState {
  enabled: boolean;
  /** 被改写为只读 GET + updateRead=false 的 getMessages 请求次数。 */
  getMessagesRewrites: number;
}

interface AgentReadGuardConfig {
  /** 本机受控 AI 后端是否已挂载（`CREWLOOM_CONTROLLED_AI=1`）。 */
  controlled: boolean;
}

let enabled = false;
let rewrites = 0;

export function getAgentReadGuardState(): AgentReadGuardState {
  return { enabled, getMessagesRewrites: rewrites };
}

/** 供测试重置计数（业务代码不使用）。 */
export function resetAgentReadGuard(): void {
  rewrites = 0;
}

export function guardAgentHistoryRead(
  config: InternalAxiosRequestConfig,
  options: AgentReadGuardConfig,
): InternalAxiosRequestConfig {
  if (!(currentMode() === 'strict' || options.controlled)) {
    return config;
  }
  const action = parseApiAction(String(config.url ?? ''));
  if (action?.key !== 'aiConversations:getMessages') {
    return config;
  }

  const params = { ...((config.params as Record<string, unknown> | undefined) ?? {}) };
  const rawUpdateRead = params.updateRead;
  const alreadyReadOnly =
    rawUpdateRead === false || rawUpdateRead === 'false' || rawUpdateRead === '0' || rawUpdateRead === undefined;
  // 与 `resources.ts` 的 `readAction` 保持**同一字面量形式**（字符串 `'false'`）：
  // 服务端只在收到 `true`/`'true'` 时写已读，字符串形式同时让"显式传参"在日志/测试中可见，
  // 避免同一条 getMessages 在不同调用点出现 boolean/string 两种表示。
  params.updateRead = 'false';

  config.method = 'get';
  // GET 不能带请求体（SDK 默认 POST 时会把 values 放进 data）。
  (config as unknown as { data?: unknown }).data = undefined;
  config.params = params;
  if (!alreadyReadOnly) {
    rewrites += 1;
  }
  return config;
}

export function installAgentReadGuard(axiosInstance: AxiosInstance, options: AgentReadGuardConfig): void {
  enabled = currentMode() === 'strict' || options.controlled;
  axiosInstance.interceptors.request.use((config) => guardAgentHistoryRead(config, options));
}
