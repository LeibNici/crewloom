/**
 * 原生 vendor 源码用的 `@nocobase/utils` 入口。
 *
 * 背景：产品顶层 `@nocobase/utils` 是 `link:` 的最小适配包（只给 SDK 用两个 cookie 函数），
 * 而 vendored 原生组件需要完整实现。这里通过 npm 别名依赖 `@nocobase/utils-native`
 * （= `npm:@nocobase/utils@2.2.22`）取完整包，由 `native-utils-resolver.mjs` 只对
 * `vendor/nocobase-2.2.22/**` 的引用生效。
 *
 * 三条硬约束（都是实测踩出来的）：
 *  1. **不要 import 完整包根入口**：根入口会 re-export `requireModule` / `server-request`（fs/dns/url）等
 *     Node-only 模块，rollup 会把它们并进共享 chunk，生产产物启动即
 *     `ReferenceError: module is not defined`（整页空白）。只取具体子模块。
 *  2. **用具名导出，不用 `export *`**：CJS 星号再导出会被 Vite 判定
 *     "Unable to interop … may lose module exports"，具名导出可避免丢符号。
 *  3. **按定义所在的 lib 子模块具名导入**，不要从 `client` 聚合桶导入：
 *     `lib/client.js` 对子模块是运行时再导出，Vite 的 CJS 具名导出探测认不出，
 *     构建期报 `does not provide an export named 'Registry'`（见 09 §3 第 3 条）。
 *
 * 下面的符号集 = 扫描 `vendor/nocobase-2.2.22/**` 全部 `@nocobase/utils(/client)` 导入得到的运行时集合
 * （`FilterGroupType` 是纯类型、`import * as nocobaseClientUtils` 是命名空间，二者不在其列）。
 * 出现新用法时在这里补一行。
 */
export { Registry } from '@nocobase/utils-native/lib/registry.js';
export { dayjs } from '@nocobase/utils-native/lib/dayjs.js';
export { isValidFilter } from '@nocobase/utils-native/lib/isValidFilter.js';
export { parse } from '@nocobase/utils-native/lib/json-templates.js';
export { uid } from '@nocobase/utils-native/lib/uid.js';
export {
  evaluateConditions,
  removeInvalidFilterItems,
  transformFilter,
} from '@nocobase/utils-native/lib/transformFilter.js';
export { generateFlowModelRdFromToken } from '@nocobase/utils-native/lib/flow-model-rd.js';
export { getDateTimeFormat, getPickerFormat } from '@nocobase/utils-native/lib/date.js';
export {
  getDayRangeByParams,
  getOffsetRangeByParams,
} from '@nocobase/utils-native/lib/dateRangeUtils.js';
export { isEmptyFilter } from '@nocobase/utils-native/lib/common.js';
export { isURL } from '@nocobase/utils-native/lib/url.js';
export { parseHTML } from '@nocobase/utils-native/lib/parseHTML.js';
export { parseLiquidContext } from '@nocobase/utils-native/lib/liquidjs.js';
export { sanitizeRichTextHtml } from '@nocobase/utils-native/lib/sanitize-rich-text-html.js';
export { toFixedByStep } from '@nocobase/utils-native/lib/number.js';
export { transformSQL } from '@nocobase/utils-native/lib/run-sql.js';
export { tval } from '@nocobase/utils-native/lib/i18n.js';
