/**
 * `native-aliases.mjs` 的类型声明（供 `vite.config.ts` 与核对脚本引用）。
 */
export declare function nativeComponentAliases(paths: {
  /** `frontend/vendor/nocobase-shims` 的绝对路径。 */
  vendorShimsDir: string;
  /** `frontend/vendor/nocobase-2.2.22` 的绝对路径。 */
  vendorSourceRoot: string;
}): Record<string, string>;
