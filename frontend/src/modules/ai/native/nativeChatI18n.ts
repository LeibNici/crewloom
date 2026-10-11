/**
 * 原生会话的中文失败文案适配（最薄一层，仅作用于本产品自己创建的原生 `Application` 实例）。
 *
 * 背景：原生 ChatBox 的失败文案来自两处固定源码，都是"把原始错误串当 i18n key 用"：
 *  - SSE 失败：`useChatMessageActions.ts:559-567, 658-668` 把 `data.errorName`（或异常 message）
 *    交给 `locale.ts` 的 `t()`；key 命中不了语言资源时 i18next 原样返回英文串
 *    （实测断线时用户看到 `network error`，见报告 09 §8.4）。
 *  - 文件上传：`chatbox/upload.ts:66-70` 抛 `AI file upload response did not contain attachment data.`
 *
 * 处理方式（不改 vendor 字节、不改产品全局 i18n）：
 *  1. 往本实例的 i18n 里补一组中文资源（覆盖网络中断、上传失败等已知 key）；
 *  2. 给本实例的 `parseMissingKeyHandler` 加一条兜底：命中"像错误"的 key 时给出中文说明与下一步，
 *     而不是把 `TypeError: ...` / `network error` / `AI_XXX_ERROR` 直接显示给用户。
 *
 * 产品页面的 i18n 不受影响：这里的 app 是 AI-03 宿主内部那个 headless `Application`。
 */

/**
 * 官方固定包的中文资源（`@nocobase/plugin-ai@2.2.22` 的 `dist/locale/zh-CN.json`）。
 *
 * 真实 2.2.20/2.2.22 客户端由各插件把自己发布包里的 locale 资源注册进 `Application` 的 i18n；
 * 宿主此前只补了错误文案，**没注册这批常规文案**，于是中文用户看到英文兜底
 * （Main 实测：Conversation list / New conversation / AI disclaimer 等）。
 * 这里直接复用同一个固定包的官方中文资源，不手写译文、不改 vendor 字节。
 */
import aiLocaleZhCN from '@nocobase/plugin-ai/dist/locale/zh-CN.json';
import { DISCONNECT_ERROR_NAME, DISCONNECT_NOTICE } from './streamRecovery';

export interface NativeChatI18nHost {
  i18n?: {
    language?: string;
    changeLanguage?: (language: string) => Promise<unknown>;
    options?: object;
    addResourceBundle?: (
      lng: string,
      ns: string,
      resources: Record<string, unknown>,
      deep?: boolean,
      overwrite?: boolean,
    ) => void;
  };
}

/** 已知失败 key 的中文说明（"发生了什么 + 下一步"）。 */
export const NATIVE_CHAT_ERROR_MESSAGES: Record<string, string> = {
  'network error': '网络连接中断了，刚才的内容可能没有发出去。请检查网络后重试。',
  'Network Error': '网络连接中断了，刚才的内容可能没有发出去。请检查网络后重试。',
  'Failed to fetch': '网络连接中断了，请检查网络后重试。',
  'Load failed': '网络连接中断了，请检查网络后重试。',
  'The operation was aborted.': '这次生成已经停止。',
  // 宿主侧流收尾适配补的错误帧名（见 ./streamRecovery）：真实断线时的中文说明。
  [DISCONNECT_ERROR_NAME]: DISCONNECT_NOTICE,
  'AI file upload failed.': '文件上传失败，请重试；如果一直失败，请联系管理员。',
  'AI file upload response did not contain attachment data.': '文件没有上传成功，请重试；如果一直失败，请联系管理员。',
  CONTROLLED_FAILURE: '这次回复没有生成成功，请重试。',
  AI_EMPLOYEE_NOT_FOUND: '没有找到对应的数字员工，请在会话顶部重新选择员工。',
  AI_MODEL_NOT_FOUND: '当前员工没有可用模型，请联系管理员配置后再试。',
};

const GENERIC_ERROR_MESSAGE = '操作没有完成，请重试；如果一直失败，请联系管理员。';

/**
 * 原生 ChatBox 里**官方 plugin-ai locale 缺失**的可见 key。
 *
 * 证据（固定 2.2.22 发布包实测）：
 *  - `@nocobase/plugin-ai/dist/locale/zh-CN.json`（595 键）与 `en-US.json` 都**没有**
 *    `Conversations` / `Workflow tasks`；i18next 命中不了就把英文 key 原样显示
 *    （Main 在 5333 实测会话列表仍是 Conversations / Workflow tasks）。
 *  - 其余缺失键（`Filter by status` / `Minimize` / `Drag & Drop files here` /
 *    `Are you sure you want to delete it?`）同样不在该资源里，也不在任何已安装官方 locale 里。
 *  - 有官方译文的键**按官方资源原样复用**：
 *    `Workflow tasks` = 固定包 `@nocobase/plugin-workflow/dist/locale/zh-CN.json` 的 `流程待办`；
 *    `Are you sure you want to delete it?` = 固定包 `@nocobase/plugin-notification-manager` 官方 zh-CN 的 `确定要删除吗？`。
 *    这两个值不手写、不改写；其余 4 个键没有官方来源，只能补最小中文。
 */
export const NATIVE_CHAT_UI_MESSAGES: Record<string, string> = {
  Conversations: '会话',
  'Workflow tasks': '流程待办',
  'Filter by status': '按状态筛选',
  Minimize: '最小化',
  'Drag & Drop files here': '把文件拖到这里',
  'Are you sure you want to delete it?': '确定要删除吗？',
};

const ERROR_LIKE = /error|failed|failure|timeout|timed out|abort|refused|unavailable|denied/i;
const CODE_LIKE = /^[A-Z][A-Z0-9_]{3,}$/;
const STACK_LIKE = /\bat\s+\S+\s+\(|TypeError|ReferenceError|SyntaxError|undefined is not|Cannot read prop/i;

/** 把一个可能来自 SSE/工具/上传的原始串翻成中文；不是错误串时返回 null（交回 i18next 默认行为）。 */
export function translateNativeChatError(raw: string): string | null {
  if (!raw) return null;
  const key = raw.trim();
  if (!key) return null;
  const known = NATIVE_CHAT_ERROR_MESSAGES[key] ?? NATIVE_CHAT_ERROR_MESSAGES[key.toLowerCase()];
  if (known) return known;
  if (STACK_LIKE.test(key) || CODE_LIKE.test(key) || ERROR_LIKE.test(key)) {
    return GENERIC_ERROR_MESSAGE;
  }
  return null;
}

export function installNativeChatI18n(app: NativeChatI18nHost): void {
  const i18n = app.i18n;
  if (!i18n) return;

  const languages = Array.from(new Set([i18n.language ?? 'zh-CN', 'zh-CN']));
  // 原生插件用 `ns: ['@nocobase/plugin-ai', 'ai', 'client']` 查 key（见 locale.ts）；
  // 逐个命名空间补上，避免因为命中顺序不同而漏翻。
  const namespaces = ['@nocobase/plugin-ai', 'ai', 'client'];
  for (const language of languages) {
    for (const ns of namespaces) {
      // 顺序有意义：先铺官方常规文案（New conversation / Conversation list / AI disclaimer…），
      // 再补官方资源缺失的可见 key（Conversations / Workflow tasks…），最后叠错误文案。
      i18n.addResourceBundle?.(language, ns, aiLocaleZhCN as Record<string, unknown>, true, true);
      i18n.addResourceBundle?.(language, ns, NATIVE_CHAT_UI_MESSAGES, true, true);
      i18n.addResourceBundle?.(language, ns, NATIVE_CHAT_ERROR_MESSAGES, true, true);
    }
  }
  // 让本实例直接以中文启动（真实 2.2.20 目标本身就是 zh-CN，语言由 app:getLang 决定）。
  void i18n.changeLanguage?.('zh-CN');

  const options = (i18n.options ?? {}) as Record<string, unknown>;
  const previous = options.parseMissingKeyHandler;
  options.parseMissingKeyHandler = (key: string, fallback?: string) => {
    const translated = translateNativeChatError(String(key ?? ''));
    if (translated) return translated;
    if (typeof previous === 'function') {
      return (previous as (k: string, f?: string) => string)(key, fallback);
    }
    return fallback ?? key;
  };
}
