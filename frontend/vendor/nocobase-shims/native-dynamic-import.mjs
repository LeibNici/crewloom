/**
 * 固定源码里**无法静态分析的动态 import** 的宿主侧修正（**唯一来源**）。
 *
 * 事实（实测，dev 与 build 都会命中）：
 *  - `vendor/nocobase-2.2.22/packages/core/client-v2/src/nocobase-buildin-plugin/plugins/LocalePlugin.ts`
 *    用模板串做动态导入：`await import(\`dayjs/locale/${dayjsLang}\`)`；
 *  - Vite 无法为裸包名的动态模板导入生成解析结果：dev 直接把它原样发给浏览器
 *    （`TypeError: Failed to resolve module specifier 'dayjs/locale/zh-cn'`），
 *    build 产物里也保留同一个运行时 import，因此两条路径都装不上原生运行时；
 *  - 全仓库只有这一处（已扫描 `vendor/nocobase-2.2.22/**` 的 `import(\`` 用法）。
 *
 * 做法：只在该文件上把这一行改写成 `import.meta.glob` 的静态映射查询——**不改上游源码字节**，
 * 只在 Vite transform 阶段替换这一处表达式，行为等价（按 locale 名加载同一个文件）。
 *
 * @returns {import('vite').Plugin}
 */
export function nativeDynamicImportFix() {
  const NEEDLE = 'await import(`dayjs/locale/${dayjsLang}`)';
  const GLOB = "import.meta.glob('/node_modules/dayjs/locale/*.js')";
  return {
    name: 'crewloom-native-dynamic-import-fix',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0].replace(/\\/g, '/');
      if (!file.includes('/vendor/nocobase-2.2.22/') || !file.endsWith('/LocalePlugin.ts')) return null;
      if (!code.includes(NEEDLE)) return null;
      const replacement =
        `await Object.entries(${GLOB}).find(([key]) => key.endsWith(\`/\${dayjsLang}.js\`))?.[1]?.()`;
      return { code: code.replace(NEEDLE, replacement), map: null };
    },
  };
}
