#!/usr/bin/env node
/**
 * 原生组件依赖的**可编译性**核对（公共负责人维护）。
 *
 * 两个构建，都用产品同一套 Vite 7 + React 19 + 同一份 shim/解析规则：
 *  1. `npm-entries`：import `@nocobase/client-v2` 的 `Application`/`NocoBaseBuildInPlugin`/`CollectionFilter`
 *     与 `@nocobase/flow-engine` 的 `FlowEngine`；
 *  2. `vendored-workflow`：import 固定源码 vendor 的工作流画布入口
 *     `vendor/nocobase-2.2.22/.../plugin-workflow/src/client-v2/index.tsx`
 *     （发布包入口在 Vite 7 + React 19 下 import 即失败，必须走源码，见 README 与 07 报告）。
 *
 * 为什么需要：只装包不代表能用。两处硬阻塞（裸 `.wasm` 动态 import、mermaid 的 cytoscape 深链）
 * 由 `vendor/nocobase-shims/` 的别名解决；`@nocobase/utils` 还要按引用方分流。本脚本是这条路径的回归检查。
 *
 * 不做什么：不渲染、不发请求、不连后端。**编译通过 ≠ 画布交互可用**（那需要浏览器交互验证）。
 *
 * 用法：`pnpm run check:native-entries`（退出码 0 = 两个入口都能在产品工具链里构建）
 */

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(here, '..');
const tmpDir = resolve(frontendRoot, '.native-entries-check');

const CONFIG_HEADER = `import { defineConfig } from 'vite';
import { nativeComponentAliases } from ${JSON.stringify(resolve(frontendRoot, 'vendor/nocobase-shims/native-aliases.mjs'))};
import { nocobaseUtilsResolver } from ${JSON.stringify(resolve(frontendRoot, 'vendor/nocobase-shims/native-utils-resolver.mjs'))};
import { nativeDynamicImportFix } from ${JSON.stringify(resolve(frontendRoot, 'vendor/nocobase-shims/native-dynamic-import.mjs'))};

const shims = ${JSON.stringify(resolve(frontendRoot, 'vendor/nocobase-shims'))};
const vendorSourceRoot = ${JSON.stringify(resolve(frontendRoot, 'vendor/nocobase-2.2.22'))};
`;

const COMMON_CONFIG = `
  configFile: false,
  plugins: [
    nativeDynamicImportFix(),
    nocobaseUtilsResolver({
      lightShim: ${JSON.stringify(resolve(frontendRoot, 'vendor/nocobase-utils-client/client.js'))},
      nativeShim: ${JSON.stringify(resolve(frontendRoot, 'vendor/nocobase-shims/nocobase-utils-native.ts'))},
    }),
  ],
  define: { 'process.env.NODE_ENV': JSON.stringify('production'), 'process.env.API_BASE_URL': 'undefined', global: 'globalThis' },
  esbuild: {
    jsx: 'automatic',
    tsconfigRaw: JSON.stringify({
      compilerOptions: { jsx: 'react-jsx', target: 'es2020', useDefineForClassFields: false, experimentalDecorators: true, verbatimModuleSyntax: false },
    }),
  },
`;

const CASES = [
  {
    name: 'npm-entries',
    entry: `import { Application, NocoBaseBuildInPlugin, CollectionFilter } from '@nocobase/client-v2';
import { FlowEngine } from '@nocobase/flow-engine';
export const nativeSurfaces = { Application, NocoBaseBuildInPlugin, CollectionFilter, FlowEngine };
`,
  },
  {
    name: 'vendored-workflow-canvas',
    entry: `import WorkflowPluginV2, { PluginWorkflowClientV2 } from '@nocobase/plugin-workflow/client-v2';
export const surface = { WorkflowPluginV2, PluginWorkflowClientV2 };
`,
  },
  {
    name: 'vendored-workflow-node-plugins',
    entry: `import JavaScript from '@nocobase/plugin-workflow-javascript/client-v2';
import Aggregate from '@nocobase/plugin-workflow-aggregate/client-v2';
import Loop from '@nocobase/plugin-workflow-loop/client-v2';
import Notification from '@nocobase/plugin-workflow-notification/client-v2';
import CC from '@nocobase/plugin-workflow-cc/client-v2';
import DateCalculation from '@nocobase/plugin-workflow-date-calculation/client-v2';
import Delay from '@nocobase/plugin-workflow-delay/client-v2';
import JsonQuery from '@nocobase/plugin-workflow-json-query/client-v2';
import JsonVariableMapping from '@nocobase/plugin-workflow-json-variable-mapping/client-v2';
import Mailer from '@nocobase/plugin-workflow-mailer/client-v2';
import Parallel from '@nocobase/plugin-workflow-parallel/client-v2';
import Request from '@nocobase/plugin-workflow-request/client-v2';
import RequestInterceptor from '@nocobase/plugin-workflow-request-interceptor/client-v2';
import ResponseMessage from '@nocobase/plugin-workflow-response-message/client-v2';
import Sql from '@nocobase/plugin-workflow-sql/client-v2';
import Variable from '@nocobase/plugin-workflow-variable/client-v2';
import ActionTrigger from '@nocobase/plugin-workflow-action-trigger/client-v2';
import CustomActionTrigger from '@nocobase/plugin-workflow-custom-action-trigger/client-v2';
import NotificationManager from '@nocobase/plugin-notification-manager/client-v2';
export const surface = { JavaScript, Aggregate, Loop, Notification, CC, DateCalculation, Delay, JsonQuery, JsonVariableMapping, Mailer, Parallel, Request, RequestInterceptor, ResponseMessage, Sql, Variable, ActionTrigger, CustomActionTrigger, NotificationManager };
`,
  },
  {
    name: 'vendored-ai-chat',
    entry: `import * as AiClientV2 from '@nocobase/plugin-ai/client-v2';
export const surface = AiClientV2;
`,
  },
];

function runCase(testCase) {
  const dir = resolve(tmpDir, testCase.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'entry.tsx'), testCase.entry);
  const config = `${CONFIG_HEADER}const here = ${JSON.stringify(dir)};
export default defineConfig({
  root: here,${COMMON_CONFIG}  resolve: {
    dedupe: ['react', 'react-dom', 'react-is'],
    alias: {
      ...nativeComponentAliases({ vendorShimsDir: shims, vendorSourceRoot }),
    },
  },
  build: { outDir: here + '/dist', emptyOutDir: true, rollupOptions: { input: here + '/entry.tsx' } },
});
`;
  writeFileSync(resolve(dir, 'vite.config.mjs'), config);

  return new Promise((resolvePromise) => {
    const child = spawn('pnpm', ['exec', 'vite', 'build', '--config', resolve(dir, 'vite.config.mjs')], {
      cwd: frontendRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      // 原生的 ai client-v2 闭包（echarts / xyflow / mermaid 等）很大：默认堆在 12873 个模块后
      // 会 SIGABRT（实测 OOM），因此显式抬高堆上限，保证核对可复现。
      env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=6144' },
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('close', (exitCode) => {
      const transformed = output.match(/(\d+) modules transformed/)?.[1] ?? '?';
      const built = output.includes('built in');
      const blockers = output
        .split('\n')
        .filter((line) => /wasm-fallback|No known conditions|is not exported|Could not resolve|Rollup failed/.test(line))
        .slice(0, 2);
      console.log(
        `${exitCode === 0 && built ? 'PASS' : 'FAIL'}  ${testCase.name}  exit=${exitCode} 模块=${transformed} built=${built}`,
      );
      for (const line of blockers) console.log(`      阻塞：${line.trim()}`);
      if (exitCode !== 0 || !built) {
        const tail = output.split('\n').filter(Boolean).slice(-12).join('\n');
        console.log(tail.replace(/^/gm, '      | '));
      }
      resolvePromise(exitCode === 0 && built);
    });
  });
}

async function main() {
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  const results = [];
  for (const testCase of CASES) {
    // eslint-disable-next-line no-await-in-loop -- 两个构建串行，避免同时吃满 CPU
    results.push(await runCase(testCase));
  }
  rmSync(tmpDir, { recursive: true, force: true });
  const failed = results.filter((ok) => !ok).length;
  console.log(`原生入口构建核对：${results.length - failed}/${results.length} 通过`);
  process.exitCode = failed === 0 ? 0 : 1;
}

await main();
