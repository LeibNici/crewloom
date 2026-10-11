/**
 * `@nocobase/utils` 的解析规则（**唯一来源**，产品配置与核对脚本共用）。
 *
 * 背景（实测）：本工程有两个对 `@nocobase/utils` 需求完全不同的消费者，
 * 而包名只能有一个顶层解析结果：
 *
 *  1. `@nocobase/sdk` 的发布产物只用到 `getAuthCookieName` / `getAuthCookieValue`
 *     （`lib/auth-cookie.js` → `@nocobase/utils/client`）。
 *     完整包的 `lib/client.js` 会 re-export handlebars / ses / parse-filter 等一大堆依赖：
 *     实测产品构建从 249 个模块涨到 3818 个模块，并因 `rc-util` 的 `react-is` 解析失败而中断。
 *     因此从 P0 起由 `vendor/nocobase-utils-client` 这个最小适配包提供。
 *
 *  2. 固定源码的原生组件（`vendor/nocobase-2.2.22/**`）需要完整实现（`Registry` 等），
 *     最小适配包不够用（实测报 `"Registry" is not exported by vendor/nocobase-utils-client/client.js`）。
 *
 * 结论：按**引用方**分别解析——SDK → 最小适配包；原生 vendor 源码 → 完整包
 * （通过 `@nocobase/utils-native` = `npm:@nocobase/utils@2.2.22` 这个别名依赖，
 *  避免在配置里硬编码 pnpm 的 `.pnpm` 哈希路径）。其余引用方保持默认解析。
 *
 * @param {{ lightShim: string, nativeShim: string }} paths
 * @returns {import('vite').Plugin}
 */
export function nocobaseUtilsResolver({ lightShim, nativeShim }) {
  return {
    name: 'crewloom-nocobase-utils-resolver',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source !== '@nocobase/utils' && !source.startsWith('@nocobase/utils/')) return null;
      const from = (importer ?? '').replace(/\\/g, '/');
      // 原生 vendor 源码：完整实现。
      if (from.includes('/vendor/nocobase-2.2.22/')) return nativeShim;
      // SDK 发布产物：最小适配包。
      if (from.includes('/@nocobase+sdk@') || from.includes('/@nocobase/sdk/')) return lightShim;
      return null;
    },
  };
}
