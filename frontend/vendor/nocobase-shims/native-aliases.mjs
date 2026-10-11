/**
 * 原生组件最小集成所需的解析替换（**唯一来源**）。
 *
 * 产品配置 `vite.config.ts` 与核对脚本 `scripts/check-native-entries.mjs` 都从这里取，
 * 避免两处各写一份别名后失配。
 *
 * 每一项都是实测出来的构建阻塞（不是预防性配置）：
 *
 *  1. `zxing-wasm/reader/zxing_reader.wasm`
 *     `@nocobase/client-v2@2.2.22` 的 ESM 产物对裸 `.wasm` 做动态 import（移动端扫码），
 *     Vite 7 直接报 `[vite:wasm-fallback] ... not supported currently`。
 *  2. `cytoscape/dist/cytoscape.umd.js`
 *     mermaid 深链到该路径，而 cytoscape 的 exports map 不放行，
 *     构建报 `No known conditions for "./dist/cytoscape.umd.js" specifier in "cytoscape"`。
 *  3+4. 全部固定源码入口（**客户端核心 + client-v2 插件**）
 *     发布产物在 Vite 7 + React 19 宿主里 import 阶段就抛
 *     `TypeError: Cannot read properties of undefined (reading 'createContext')`：
 *       - `@nocobase/plugin-workflow/client-v2`、`@nocobase/plugin-ai/client-v2`、
 *         `@nocobase/plugin-acl/client-v2`、`@nocobase/plugin-file-manager/client-v2`
 *         的发布入口只有 rspack 产物；
 *       - `@nocobase/client-v2`（含 `es/index.mjs` 与 `lib/index.js` 两份产物）自身
 *         由 rspack 打包：`lib/index.js`（CJS）把默认导入编译成 `react.default.createContext`，
 *         而 CJS 的 `require('react')` 没有 `default`。任一 CJS 引用方一旦把它带进产物，
 *         整个 chunk 在 import 阶段即抛 createContext（实测栈见 09 §7.5 / 11 / 20）。
 *     ⇒ 全部入口指向 `vendor/nocobase-2.2.22/` 里固定 commit 的源码副本
 *     （复制与清单见 `vendor/nocobase-2.2.22/SOURCE.md`，
 *      上游 commit `a4eac04d1b5b2a3bcfa9939e7c1af274b56845dd`）。
 *     当前入口集合 = 2 个核心包 + 目标 13000 enabled 的全部工作流节点/触发器插件
 *     + notification-manager 的 client-v2（cc/notification 面板直接依赖）。
 *
 * 注意：`@nocobase/flow-engine` 的发布产物是 esbuild 打出的 **CJS**（`lib/index.js`，无
 * `module`/`exports` 字段），本身不含 createContext 互操作问题，但它被 `optimizeDeps.exclude`
 * 排除时无法在浏览器执行。因此这里同样指向固定源码，让它以 ESM 参与构建。
 *
 * @param {object} paths
 * @param {string} paths.vendorShimsDir `frontend/vendor/nocobase-shims` 的绝对路径
 * @param {string} paths.vendorSourceRoot `frontend/vendor/nocobase-2.2.22` 的绝对路径
 * @returns {Record<string, string>} 可直接放进 Vite `resolve.alias` 的别名表
 */
export function nativeComponentAliases({ vendorShimsDir, vendorSourceRoot }) {
  return {
    'zxing-wasm/reader/zxing_reader.wasm': `${vendorShimsDir}/zxing-reader-wasm.ts`,
    'cytoscape/dist/cytoscape.umd.js': 'cytoscape',
    // filesize@9.0.11 的 ESM 产物只有默认导出，而固定源码用具名导入（见 filesize-shim.ts）。
    filesize: `${vendorShimsDir}/filesize-shim.ts`,
    // 更长的键放前面：字符串别名按前缀匹配，`@nocobase/client-v2/flow-compat` 必须先命中。
    '@nocobase/client-v2/flow-compat': `${vendorSourceRoot}/packages/core/client-v2/src/flow-compat/index.ts`,
    '@nocobase/client-v2': `${vendorSourceRoot}/packages/core/client-v2/src/index.ts`,
    '@nocobase/flow-engine': `${vendorSourceRoot}/packages/core/flow-engine/src/index.ts`,
    '@nocobase/plugin-workflow/client-v2': `${vendorSourceRoot}/packages/plugins/@nocobase/plugin-workflow/src/client-v2/index.tsx`,
    '@nocobase/plugin-ai/client-v2': `${vendorSourceRoot}/packages/plugins/@nocobase/plugin-ai/src/client-v2/index.tsx`,
    '@nocobase/plugin-acl/client-v2': `${vendorSourceRoot}/packages/plugins/@nocobase/plugin-acl/src/client-v2/index.ts`,
    '@nocobase/plugin-file-manager/client-v2': `${vendorSourceRoot}/packages/plugins/@nocobase/plugin-file-manager/src/client-v2/index.tsx`,
    '@nocobase/plugin-workflow-manual/client-v2': `${vendorSourceRoot}/packages/plugins/@nocobase/plugin-workflow-manual/src/client-v2/index.tsx`,
    // 目标 13000 当前 enabled 的其它工作流节点/触发器插件（同批固定源码）。
    // 它们与 `@nocobase/plugin-workflow/client-v2` 是不同包名，不存在前缀冲突。
    '@nocobase/plugin-workflow-javascript/client-v2': `${vendorSourceRoot}/packages/plugins/@nocobase/plugin-workflow-javascript/src/client-v2/index.tsx`,
    '@nocobase/plugin-workflow-aggregate/client-v2': `${vendorSourceRoot}/packages/plugins/@nocobase/plugin-workflow-aggregate/src/client-v2/index.tsx`,
    '@nocobase/plugin-workflow-loop/client-v2': `${vendorSourceRoot}/packages/plugins/@nocobase/plugin-workflow-loop/src/client-v2/index.tsx`,
    '@nocobase/plugin-workflow-notification/client-v2': `${vendorSourceRoot}/packages/plugins/@nocobase/plugin-workflow-notification/src/client-v2/index.tsx`,
    '@nocobase/plugin-workflow-cc/client-v2': `${vendorSourceRoot}/packages/plugins/@nocobase/plugin-workflow-cc/src/client-v2/index.tsx`,
    '@nocobase/plugin-workflow-date-calculation/client-v2': `${vendorSourceRoot}/packages/plugins/@nocobase/plugin-workflow-date-calculation/src/client-v2/index.tsx`,
    '@nocobase/plugin-workflow-delay/client-v2': `${vendorSourceRoot}/packages/plugins/@nocobase/plugin-workflow-delay/src/client-v2/index.tsx`,
    '@nocobase/plugin-workflow-json-query/client-v2': `${vendorSourceRoot}/packages/plugins/@nocobase/plugin-workflow-json-query/src/client-v2/index.tsx`,
    '@nocobase/plugin-workflow-json-variable-mapping/client-v2': `${vendorSourceRoot}/packages/plugins/@nocobase/plugin-workflow-json-variable-mapping/src/client-v2/index.tsx`,
    '@nocobase/plugin-workflow-mailer/client-v2': `${vendorSourceRoot}/packages/plugins/@nocobase/plugin-workflow-mailer/src/client-v2/index.tsx`,
    '@nocobase/plugin-workflow-parallel/client-v2': `${vendorSourceRoot}/packages/plugins/@nocobase/plugin-workflow-parallel/src/client-v2/index.tsx`,
    '@nocobase/plugin-workflow-request/client-v2': `${vendorSourceRoot}/packages/plugins/@nocobase/plugin-workflow-request/src/client-v2/index.tsx`,
    '@nocobase/plugin-workflow-request-interceptor/client-v2': `${vendorSourceRoot}/packages/plugins/@nocobase/plugin-workflow-request-interceptor/src/client-v2/index.tsx`,
    '@nocobase/plugin-workflow-response-message/client-v2': `${vendorSourceRoot}/packages/plugins/@nocobase/plugin-workflow-response-message/src/client-v2/index.tsx`,
    '@nocobase/plugin-workflow-sql/client-v2': `${vendorSourceRoot}/packages/plugins/@nocobase/plugin-workflow-sql/src/client-v2/index.tsx`,
    '@nocobase/plugin-workflow-variable/client-v2': `${vendorSourceRoot}/packages/plugins/@nocobase/plugin-workflow-variable/src/client-v2/index.tsx`,
    '@nocobase/plugin-workflow-action-trigger/client-v2': `${vendorSourceRoot}/packages/plugins/@nocobase/plugin-workflow-action-trigger/src/client-v2/index.tsx`,
    '@nocobase/plugin-workflow-custom-action-trigger/client-v2': `${vendorSourceRoot}/packages/plugins/@nocobase/plugin-workflow-custom-action-trigger/src/client-v2/index.tsx`,
    // 不是工作流插件，但 cc / notification 的原生面板直接 import 它的 client-v2。
    '@nocobase/plugin-notification-manager/client-v2': `${vendorSourceRoot}/packages/plugins/@nocobase/plugin-notification-manager/src/client-v2/index.tsx`,
  };
}
