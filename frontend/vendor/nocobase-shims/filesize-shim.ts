/**
 * `filesize@9.0.11` 的具名导出适配（原生源码 vendor 用）。
 *
 * 事实（实测）：
 *  - 固定源码 `@nocobase/plugin-file-manager/src/client-v2/models/UploadActionModel.tsx:16`
 *    写的是 `import { filesize } from 'filesize'`；
 *  - `filesize@9.0.11`（由 `@nocobase/client@2.2.22` 声明的精确版本）的 ESM 产物
 *    `lib/filesize.esm.js` 只导出默认值：`export { filesize as default }`，
 *    CJS 产物 `lib/filesize.js` 也只有 `module.exports = filesize`（外加 `partial`）；
 *  - 因此 rollup 在生产构建时报
 *    `"filesize" is not exported by .../filesize/lib/filesize.esm.js`。
 *
 * 这里只补一个等价命名导出，不改变默认导出语义、不换版本。
 *
 * 缺陷修复（本地开发/生产构建必需，tasks 组交付 `@nocobase/client` 时复现）：
 * 这里**不能**写 `import ... from 'filesize'` —— `resolve.alias` 把裸名 `filesize`
 * 指向本文件，裸名导入会解析成"本文件导入自己"。dev 下 esbuild 容忍该自环
 * （命名导出实际是 undefined），生产 rollup 会把它编译成 `const s=e,e=e;export{s as a,e as f};`
 * 并在模块求值时抛 `ReferenceError: Cannot access 'e' before initialization`，
 * 使任何引用 `filesize` 的 chunk（含 `@nocobase/client`）整体不可用。
 * 改为相对路径直达真实包，绕开别名，语义完全一致。
 */
import filesizeDefault from '../../node_modules/filesize/lib/filesize.esm.js';

export const filesize = filesizeDefault;
export default filesizeDefault;
