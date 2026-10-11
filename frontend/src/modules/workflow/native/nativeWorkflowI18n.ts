/**
 * WF 原生画布 / 节点面板的中文来源（**复用固定版本官方 zh-CN 资源**，不手写译文、不改 vendor 字节）。
 *
 * 背景：真实 2.2.20 客户端由各插件把自己发布包里的 `dist/locale/<lang>.json` 注册进
 * `Application` 的 i18n（语言与资源来自 `app:getLang` 的 `{ lang, resources }`，见
 * `core/client-v2/src/nocobase-buildin-plugin/plugins/LocalePlugin.ts:24-52`）。
 * 本产品的 WF 宿主是**自己 new 出来的** headless `Application`（`nativeWorkflowCanvas.tsx`），
 * 它把插件源码从 `vendor/` 固定 commit 接入，但宿主此前只在 44 里给 **AI 会话**注册了官方资源，
 * 工作流这一侧没有注册：
 *
 *  - `LocalePlugin` 拿到 `apps:getLang` 的 `lang: 'zh-CN'` 会 `changeLanguage('zh-CN')`；
 *  - 但 `resources` 为空（本机合成后端按真实契约返回空；真实后端也只有它自己 enabled 的那批），
 *    于是 i18next 无 key 命中 → **原样返回英文 key**（Main 实测：`Test run` / `Submit` / `Cancel`、
 *    节点标题 `Calculation`、`Copy`、`Paste`…）。
 *
 * 修法：宿主就绪后，把**同一个固定版本 2.2.22 发布包**里的官方中文资源按各自**真实 namespace**
 * 注册进本实例的 i18n，再显式把语言初始化成 `zh-CN`：
 *
 *  - `client`：`@nocobase/client` 的 `lib/locale/zh-CN.json`（`Submit`→提交、`Cancel`→取消…，
 *    也是 flow-engine 的 `flowCtx.t(key)` 默认命名空间）；
 *  - `workflow`：`@nocobase/plugin-workflow` 的 `dist/locale/zh-CN.json`
 *    （节点题名 / `Copy` / `Paste` / `Test run` / `Workflow` 面包屑…）；
 *  - 每个节点/触发器插件自己的 namespace（逐个来自对应插件源码里的 `NAMESPACE` 常量，
 *    见下表注释），覆盖 known 27 类型的主要面板与字段文案；
 *  - `@nocobase/plugin-ai`（`ai-employee` / `llm` 节点的官方题名就走这个 ns）。
 *
 * 刻意不做的事：
 *  - **不手写/机器翻译**任何面板文案，全部来自官方固定版本资源；
 *  - 不修改 `vendor/**` 任何字节；
 *  - 不做“兜底把任意 key 原样塞成中文”的全局 handler（那会把英文原文伪装成已翻译）。
 *
 * 边界（如实）：`@nocobase/flow-engine` 自己的 `lib/locale/zh-CN.json` 没有注册。
 * 原因是 `vite.config.ts` 把 `@nocobase/flow-engine`（及 `/client-v2`）**前缀**指向 vendor 源码，
 * 子路径 `.../lib/locale/zh-CN.json` 会被改写成不存在的 vendor 路径；要修得动公共 alias 文件，
 * 超出本轮范围。它缺失的 67 个 key 都是 FlowModel 编辑器/模板区块的内部提示，
 * 不属于工作流节点面板；画布面板的通用按钮走 `client`，已在上面注册。
 */

import aiZhCN from '@nocobase/plugin-ai/dist/locale/zh-CN.json';
import clientZhCN from '@nocobase/client/lib/locale/zh-CN.json';
import aclZhCN from '@nocobase/plugin-acl/dist/locale/zh-CN.json';
import notificationManagerZhCN from '@nocobase/plugin-notification-manager/dist/locale/zh-CN.json';
import workflowZhCN from '@nocobase/plugin-workflow/dist/locale/zh-CN.json';
import workflowActionTriggerZhCN from '@nocobase/plugin-workflow-action-trigger/dist/locale/zh-CN.json';
import workflowAggregateZhCN from '@nocobase/plugin-workflow-aggregate/dist/locale/zh-CN.json';
import workflowCcZhCN from '@nocobase/plugin-workflow-cc/dist/locale/zh-CN.json';
import workflowCustomActionTriggerZhCN from '@nocobase/plugin-workflow-custom-action-trigger/dist/locale/zh-CN.json';
import workflowDateCalculationZhCN from '@nocobase/plugin-workflow-date-calculation/dist/locale/zh-CN.json';
import workflowDelayZhCN from '@nocobase/plugin-workflow-delay/dist/locale/zh-CN.json';
import workflowJavascriptZhCN from '@nocobase/plugin-workflow-javascript/dist/locale/zh-CN.json';
import workflowJsonQueryZhCN from '@nocobase/plugin-workflow-json-query/dist/locale/zh-CN.json';
import workflowJsonVariableMappingZhCN from '@nocobase/plugin-workflow-json-variable-mapping/dist/locale/zh-CN.json';
import workflowLoopZhCN from '@nocobase/plugin-workflow-loop/dist/locale/zh-CN.json';
import workflowMailerZhCN from '@nocobase/plugin-workflow-mailer/dist/locale/zh-CN.json';
import workflowManualZhCN from '@nocobase/plugin-workflow-manual/dist/locale/zh-CN.json';
import workflowNotificationZhCN from '@nocobase/plugin-workflow-notification/dist/locale/zh-CN.json';
import workflowParallelZhCN from '@nocobase/plugin-workflow-parallel/dist/locale/zh-CN.json';
import workflowRequestZhCN from '@nocobase/plugin-workflow-request/dist/locale/zh-CN.json';
import workflowRequestInterceptorZhCN from '@nocobase/plugin-workflow-request-interceptor/dist/locale/zh-CN.json';
import workflowResponseMessageZhCN from '@nocobase/plugin-workflow-response-message/dist/locale/zh-CN.json';
import workflowSqlZhCN from '@nocobase/plugin-workflow-sql/dist/locale/zh-CN.json';
import workflowVariableZhCN from '@nocobase/plugin-workflow-variable/dist/locale/zh-CN.json';

type Resources = Record<string, unknown>;

/**
 * 官方资源 → 该插件源码里声明的真实 namespace。
 *
 * namespace 逐个取自固定源码的 `export const NAMESPACE`（文件见每行注释），
 * 不是按包名猜的：例如 `plugin-workflow-sql` 用 `@nocobase/plugin-workflow-sql`，
 * 而 `plugin-workflow-delay` 用 `workflow-delay`。
 */
export const NATIVE_WORKFLOW_LOCALES: Array<{ namespaces: string[]; resources: Resources }> = [
  { namespaces: ['client'], resources: clientZhCN as Resources },
  { namespaces: ['workflow'], resources: workflowZhCN as Resources },
  // plugin-workflow-javascript/src/client-v2/locale.ts
  { namespaces: ['workflow-javascript'], resources: workflowJavascriptZhCN as Resources },
  // plugin-workflow-aggregate/src/client-v2/locale.ts
  { namespaces: ['workflow-aggregate'], resources: workflowAggregateZhCN as Resources },
  // plugin-workflow-loop/src/client-v2/locale.ts
  { namespaces: ['workflow-loop'], resources: workflowLoopZhCN as Resources },
  // plugin-workflow-notification/src/client-v2/locale.ts
  { namespaces: ['workflow-notification'], resources: workflowNotificationZhCN as Resources },
  // plugin-workflow-cc/src/common/constants.ts 与 client-v2/locale.ts（两处同值）
  { namespaces: ['@nocobase/plugin-workflow-cc'], resources: workflowCcZhCN as Resources },
  // plugin-workflow-date-calculation/src/client-v2/locale.ts
  { namespaces: ['workflow-date-calculation'], resources: workflowDateCalculationZhCN as Resources },
  // plugin-workflow-delay/src/client-v2/locale.ts
  { namespaces: ['workflow-delay'], resources: workflowDelayZhCN as Resources },
  // plugin-workflow-json-query/src/client-v2/locale.ts
  { namespaces: ['workflow-json-query'], resources: workflowJsonQueryZhCN as Resources },
  // plugin-workflow-json-variable-mapping/src/client-v2/locale.ts
  { namespaces: ['workflow-json-variable-mapping'], resources: workflowJsonVariableMappingZhCN as Resources },
  // plugin-workflow-mailer/src/client-v2/locale.ts
  { namespaces: ['workflow-mailer'], resources: workflowMailerZhCN as Resources },
  // plugin-workflow-parallel/src/client-v2/locale.ts
  { namespaces: ['workflow-parallel'], resources: workflowParallelZhCN as Resources },
  // plugin-workflow-request/src/client-v2/locale.ts
  { namespaces: ['workflow-request'], resources: workflowRequestZhCN as Resources },
  // plugin-workflow-request-interceptor/src/client-v2/locale.ts
  { namespaces: ['workflow-request-interceptor'], resources: workflowRequestInterceptorZhCN as Resources },
  // plugin-workflow-response-message/src/client-v2/locale.ts
  { namespaces: ['workflow-response-message'], resources: workflowResponseMessageZhCN as Resources },
  // plugin-workflow-sql/src/client-v2/constants.ts
  { namespaces: ['@nocobase/plugin-workflow-sql'], resources: workflowSqlZhCN as Resources },
  // plugin-workflow-variable/src/client-v2/locale.ts
  { namespaces: ['workflow-variable'], resources: workflowVariableZhCN as Resources },
  // plugin-workflow-action-trigger/src/client-v2/locale.ts
  { namespaces: ['workflow-action-trigger'], resources: workflowActionTriggerZhCN as Resources },
  // plugin-workflow-custom-action-trigger/src/common/constants.ts 与 client-v2/locale.ts（两处同值）
  {
    namespaces: ['@nocobase/plugin-workflow-custom-action-trigger'],
    resources: workflowCustomActionTriggerZhCN as Resources,
  },
  // plugin-workflow-manual：client-v2 用包名、common 用短名，两处都声明了，都注册
  {
    namespaces: ['@nocobase/plugin-workflow-manual', 'workflow-manual'],
    resources: workflowManualZhCN as Resources,
  },
  // plugin-notification-manager/src/client-v2/locale.ts（cc / notification 面板依赖它）
  { namespaces: ['notification-manager'], resources: notificationManagerZhCN as Resources },
  // plugin-acl/src/client-v2/locale.ts（画布里的权限提示）
  { namespaces: ['@nocobase/plugin-acl'], resources: aclZhCN as Resources },
  // plugin-ai：`ai-employee` / `llm` 节点的官方题名（`workflow/nodes/employee/index.tsx:23` 用
  // `tExpr('AI employee')`，tExpr 把 ns 固定成 [包名, 'ai', 'client']）
  { namespaces: ['@nocobase/plugin-ai', 'ai'], resources: aiZhCN as Resources },
];

/** 只依赖应用 i18n 实例的最小接口（便于单测注入假实例，不把原生闭包带进 jsdom）。 */
export interface NativeWorkflowI18nHost {
  i18n?: {
    language?: string;
    changeLanguage?: (language: string) => Promise<unknown>;
    addResourceBundle?: (
      lng: string,
      ns: string,
      resources: Record<string, unknown>,
      deep?: boolean,
      overwrite?: boolean,
    ) => void;
  };
}

/**
 * 把官方中文资源注册进本实例 i18n，并把语言初始化成中文。
 *
 * 必须在 `await app.load()` **之后**调用：`LocalePlugin.afterAdd` 会先按 `app:getLang` 注册一份
 * （真实后端可能给不同版本/不同子集），这里后写并 `overwrite`，保证面板文案来自固定版本官方资源。
 */
export function installNativeWorkflowI18n(app: NativeWorkflowI18nHost, language = 'zh-CN'): void {
  const i18n = app.i18n;
  if (!i18n?.addResourceBundle) return;
  for (const { namespaces, resources } of NATIVE_WORKFLOW_LOCALES) {
    for (const ns of namespaces) {
      i18n.addResourceBundle(language, ns, resources, true, true);
    }
  }
  void i18n.changeLanguage?.(language);
}
