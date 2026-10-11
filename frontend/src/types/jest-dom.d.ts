/**
 * 让 TypeScript 认识 @testing-library/jest-dom 的断言扩展。
 * 只在测试 tsconfig 中通过 `src/types` 目录被引入。
 */
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

declare module '@vitest/expect' {
  interface Assertion<T = unknown> extends TestingLibraryMatchers<unknown, T> {}
  interface AsymmetricMatchersContaining extends TestingLibraryMatchers<unknown, unknown> {}
}
