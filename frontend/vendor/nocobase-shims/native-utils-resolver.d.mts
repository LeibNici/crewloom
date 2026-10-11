/**
 * `native-utils-resolver.mjs` 的类型声明（供 `vite.config.ts` 引用）。
 */
import type { Plugin } from 'vite';

export declare function nocobaseUtilsResolver(paths: {
  /** `@nocobase/sdk` 用的最小适配包入口绝对路径。 */
  lightShim: string;
  /** 原生 vendor 源码用的完整包转出入口绝对路径。 */
  nativeShim: string;
}): Plugin;
