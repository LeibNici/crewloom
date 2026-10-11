/**
 * `@nocobase/utils/client` 的最小适配（CommonJS）。
 *
 * 为什么存在：`@nocobase/sdk@2.2.22` 的**发布产物** `lib/auth-cookie.js` 里有
 * `require("@nocobase/utils/client")`，但 `@nocobase/sdk` 的 package.json 并未声明
 * 该依赖（monorepo 提升安装的历史产物）。真正的 `@nocobase/utils` 会连带
 * `flat` / handlebars / micromatch 等未声明依赖与 Node 取向代码，为本项目带来
 * 不必要的体积与 process 垫片。
 *
 * 本包只按原生实现（`packages/core/utils/src/auth-cookie-name.ts`）复制 SDK 真正
 * 使用的两个纯函数；Cookie 名与后端 `setCurrentRole` 读取的
 * `nb_role_<appName>`（默认 `main`）完全一致。通过 `link:` 依赖挂到
 * `node_modules/@nocobase/utils`，使 Node require 与浏览器构建都能解析。
 */

'use strict';

const cookieNamePrefixes = {
  authToken: 'nb_auth_token',
  authenticator: 'nb_authenticator',
  role: 'nb_role',
  csrfToken: 'nb_csrf_token',
};

function getAuthCookieName(type, appName) {
  return `${cookieNamePrefixes[type]}_${appName || 'main'}`;
}

function getAuthCookieValue(type, appName) {
  if (typeof document === 'undefined') return undefined;
  const name = `${getAuthCookieName(type, appName)}=`;
  return document.cookie
    .split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith(name))
    ?.slice(name.length);
}

module.exports = { getAuthCookieName, getAuthCookieValue };
