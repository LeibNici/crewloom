/**
 * 原生入口的**类型边界回归**（由 `tsconfig.app.json` 的 `include` 纳入 `pnpm run typecheck`）。
 *
 * 为什么要有这个文件：运行期这两个入口由 `vite.config.ts` 的别名指向
 * `vendor/nocobase-2.2.22/**` 的固定源码；如果 TypeScript 也跟着跟进那份源码，
 * `tsc -b` 会去检查上游 290 个文件（严格模式 + 不同 tsconfig 语义），几乎必然报一片错。
 *
 * 实测结论（本文件就是这条结论的守卫）：`@nocobase/plugin-workflow/client-v2` 与
 * `@nocobase/plugin-ai/client-v2` 的**类型**来自已发布包根目录的 `client-v2.d.ts`，
 * 不会跟进 vendor 源码；两个包都是本工程的直接依赖（`2.2.22`）。
 * 一旦有人加了会破坏这一点的 `paths` 映射，或依赖被移除，`pnpm run typecheck` 会在这里失败。
 *
 * 注意：这里只做**类型**引用，不产生任何运行期 import（构建产物不受影响）。
 */
import type WorkflowPluginV2 from '@nocobase/plugin-workflow/client-v2';
import type { PluginWorkflowClientV2 } from '@nocobase/plugin-workflow/client-v2';
import type * as AiClientV2 from '@nocobase/plugin-ai/client-v2';

export type NativeWorkflowEntryType = typeof WorkflowPluginV2;
export type NativeWorkflowPluginType = typeof PluginWorkflowClientV2;
export type NativeAiClientEntryType = typeof AiClientV2;
