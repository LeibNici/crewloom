/**
 * `@nocobase/utils/client` 的最小适配（**ESM**）。
 *
 * 为什么存在：`@nocobase/sdk@2.2.22` 的**发布产物** `lib/auth-cookie.js` 里有
 * `require("@nocobase/utils/client")`，但 `@nocobase/sdk` 的 package.json 并未声明
 * 该依赖（monorepo 提升安装的历史产物）。真正的 `@nocobase/utils` 会连带
 * `flat` / handlebars / micromatch 等未声明依赖与 Node 取向代码。
 *
 * 为什么必须是 ESM：本文件会被打进**浏览器产物**（`vendor/nocobase-shims/native-utils-resolver.mjs`
 * 把 SDK 侧的 `@nocobase/utils` 指到这里）。此前的 CommonJS 写法在浏览器里执行
 * `module.exports = …` 直接抛 `ReferenceError: module is not defined`，
 * **整页空白**（实测生产 preview 启动即失败）。Node 侧需要 CJS 时用同目录 `client.cjs`
 * （package.json 的 `require` 条件指向它）。
 *
 * 只按原生实现（`packages/core/utils/src/auth-cookie-name.ts`）复制 SDK 真正使用的两个纯函数；
 * Cookie 名与后端 `setCurrentRole` 读取的 `nb_role_<appName>`（默认 `main`）一致。
 */

const cookieNamePrefixes = {
  authToken: 'nb_auth_token',
  authenticator: 'nb_authenticator',
  role: 'nb_role',
  csrfToken: 'nb_csrf_token',
};

export function getAuthCookieName(type, appName) {
  return `${cookieNamePrefixes[type]}_${appName || 'main'}`;
}

export function getAuthCookieValue(type, appName) {
  if (typeof document === 'undefined') return undefined;
  const name = `${getAuthCookieName(type, appName)}=`;
  return document.cookie
    .split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith(name))
    ?.slice(name.length);
}
