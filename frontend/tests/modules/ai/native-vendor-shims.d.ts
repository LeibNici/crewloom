/**
 * 测试侧的最小模块声明（只作用于 `tsconfig.test.json` 的 program）。
 *
 * `@nocobase/utils/client` 的发布包只带 `client.js`（没有 `client.d.ts`）；产品侧由
 * `vendor/nocobase-shims/native-utils-resolver.mjs` 按引用方分流，从不经过 tsc 解析。
 * 这里按上游真实实现（`node_modules/@nocobase/utils/lib/registry.js`）声明 `Registry`：
 * 测试用它验证"重复注册会抛错、不能覆盖上游类型"这条真实语义，不改 vendor、不改公共 tsconfig、不加依赖。
 */
declare module '@nocobase/utils/client' {
  export class Registry<T = unknown> {
    constructor(options?: { override?: boolean });
    register(key: string, value: T): void;
    get(key: string): T | undefined;
    getKeys(): IterableIterator<string>;
    getValues(): IterableIterator<T>;
    getEntities(): IterableIterator<[string, T]>;
  }
}
