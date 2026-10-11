import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';
import { nativeComponentAliases } from './vendor/nocobase-shims/native-aliases.mjs';
import { nocobaseUtilsResolver } from './vendor/nocobase-shims/native-utils-resolver.mjs';

/**
 * 测试配置。
 *
 * 与 `vite.config.ts` 共用**同一套原生解析规则**（`vendor/nocobase-shims/native-aliases.mjs`
 * 与 `native-utils-resolver.mjs`）：不这样做时，测试里 import
 * `@nocobase/plugin-ai/client-v2` 会落到发布产物，而那是实测在 Vite 7 + React 19 下
 * import 阶段就抛 `Cannot read properties of undefined (reading 'createContext')` 的入口。
 *
 * **真实联调隔离（默认不收集）**：下面这些用例会访问真实后端（13000/13080）或在模块顶层读取
 * `.secrets/**` 凭据；一旦被默认收集，即使用例内部 skip，IO 也已经发生。因此默认 `pnpm test`
 * 与默认 `pnpm exec vitest run`（含按目录筛选）**都不收集**它们，只有显式
 * `CREWLOOM_LIVE_TESTS=1`（即 `pnpm run test:live`）才纳入。用例本身、断言与覆盖范围不删减。
 *
 * 已知限制（集成轮实测，未解决）：jsdom 环境下加载原生组件会先经过 Node 的 ESM 解析，
 * `antd/es/form/context.js` 对 `rc-util/es/omit` 的**无扩展名导入**在 Node 侧无法解析
 * （`rc-util` 的 exports map 不放行该子路径）；`server.deps.inline`（数组与 true）、
 * `deps.optimizer.web` 三种写法都试过，仍报同一错误。因此原生组件的**交互**验证放在
 * 真实浏览器（Vite 解析器）里做，而不是 jsdom；本文件只保证解析规则与产品一致。
 */
/** 真实联调用例的文件形态（`tests/live-*`、`*-live-13000*`、`*live-read-13000*`）。 */
const LIVE_TEST_PATTERNS = [
  'tests/**/live-*.test.{ts,tsx}',
  'tests/**/*-live-13000*.test.{ts,tsx}',
  'tests/**/*live-read-13000*.test.{ts,tsx}',
];

/**
 * 是否纳入真实联调用例：**必须显式**设置 `CREWLOOM_LIVE_TESTS=1`。
 *
 * 不设时默认排除，避免"跑本机用例却隐式打了真实实例"（本任务实际发生过的缺陷）。
 */
const LIVE_TESTS_ENABLED = process.env.CREWLOOM_LIVE_TESTS === '1';

export default defineConfig({
  plugins: [
    react(),
    nocobaseUtilsResolver({
      lightShim: fileURLToPath(new URL('./vendor/nocobase-utils-client/client.js', import.meta.url)),
      nativeShim: fileURLToPath(new URL('./vendor/nocobase-shims/nocobase-utils-native.ts', import.meta.url)),
    }),
  ],
  resolve: {
    dedupe: ['react', 'react-dom', 'react-is'],
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      ...nativeComponentAliases({
        vendorShimsDir: fileURLToPath(new URL('./vendor/nocobase-shims', import.meta.url)),
        vendorSourceRoot: fileURLToPath(new URL('./vendor/nocobase-2.2.22', import.meta.url)),
      }),
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['tests/**/*.test.{ts,tsx}'],
    // 默认隔离真实联调：排除后它们不会被收集，模块顶层的凭据读取与网络请求也就不会发生。
    exclude: [...configDefaults.exclude, ...(LIVE_TESTS_ENABLED ? [] : LIVE_TEST_PATTERNS)],
    css: true,
    restoreMocks: true,
    // 真实后端联调在 250 实例上偶有秒级响应，默认 5s 会造成假失败。
    testTimeout: 20000,
    setupFiles: ['./tests/setup.ts'],
  },
});
