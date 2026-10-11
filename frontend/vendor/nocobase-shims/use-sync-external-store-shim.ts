/**
 * `use-sync-external-store/shim` 的 ESM 等价层（宿主适配，最小改动）。
 *
 * 背景（实测）：原生客户端闭包被排除出 Vite 预打包后，其依赖链上的
 * `mobx-react-lite` 会直接 import `use-sync-external-store/shim`（**CJS**），
 * 浏览器按 ESM 解析时拿不到具名导出：
 *   `does not provide an export named 'useSyncExternalStore'`。
 * `optimizeDeps.include`（含深路径写法）在该闭包上不生效。
 *
 * 该 shim 在 React 18+ 下的语义与上游 shim 一致：就是把 React 自带的
 * `useSyncExternalStore` 转发出去（上游 shim 在 production/development 分支里也是这么做的）。
 * 只转发，不改行为，不引入新依赖。
 */
export { useSyncExternalStore } from 'react';
