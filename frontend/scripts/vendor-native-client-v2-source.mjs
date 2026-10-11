#!/usr/bin/env node
/**
 * 固定源码 vendor：把 NocoBase 2.2.22 里**真正被引用到**的原生客户端源码复制进本仓库。
 *
 * 为什么必须 vendor（实测结论，不是推断）：
 *  - `@nocobase/plugin-workflow/client-v2` 与 `@nocobase/plugin-ai/client-v2` 的**发布产物**
 *    在 Vite 7 + React 19 宿主里 import 阶段就抛
 *    `TypeError: Cannot read properties of undefined (reading 'createContext')`；
 *  - 发布包里**不含 `src/`**（已核对 tarball 文件清单，只有 `dist/`），因此只能从
 *    固定 commit 的源码树复制；
 *  - 归档实验用 Vite alias 直接指向 `/private/tmp/...` 的源码树，这不能作为交付
 *    （依赖 /tmp、且源码树里没有 node_modules）。复制到本仓库后，这些文件里的裸包 import
 *    会自然从 `frontend/node_modules` 解析；
 *  - `@nocobase/client-v2` / `@nocobase/flow-engine` 的发布 `lib/index.js`（CJS）把默认导入
 *    编译成 `react.default.createContext`，而 CJS 的 `require('react')` 没有 `default`；
 *    任一 CJS 引用方（例如 `@nocobase/plugin-acl/client-v2` 的 `module.exports = require(...)`）
 *    就会把这条 CJS 分支带进产物并在 import 阶段抛 createContext。四个 client-v2 入口
 *    全部改走固定源码后，产物理不再出现该 CJS 分支。
 *
 * 做法：从入口文件出发静态遍历相对 import，只复制闭包里的文件（去掉 `__tests__`），
 * 并写出 SOURCE.md（commit/路径/sha256 清单）与 LICENSE。
 *
 * 用法：
 *   node scripts/vendor-native-client-v2-source.mjs            # 默认源码树见下
 *   NB_SOURCE=<nocobase-2.2.22 仓库根> node scripts/vendor-native-client-v2-source.mjs
 *
 * 只读上游源码，只写 `frontend/vendor/nocobase-2.2.22/`。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NB_VERSION = '2.2.22';
export const NB_COMMIT = 'a4eac04d1b5b2a3bcfa9939e7c1af274b56845dd';
const DEFAULT_SOURCE = '/private/tmp/cl-research/nocobase-v2.2.22';

const here = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(here, '..');
const OUT_ROOT = resolve(frontendRoot, 'vendor/nocobase-2.2.22');
const SOURCE = process.env.NB_SOURCE ?? DEFAULT_SOURCE;

/**
 * 固定源码入口（相对仓库根）：两个核心包 + client-v2 插件入口。
 *
 * 前 7 个是 WF-02/AI-03 首批必需入口；后 19 个入口 = **目标 13000 当前 enabled 的
 * 18 个 `workflow-*` 节点/触发器插件 + `plugin-notification-manager`**。
 * `pm:list` 实测：`workflow-*` 共 21 个，20 个 enabled（含上面已收的核心 `plugin-workflow`
 * 与 `plugin-workflow-manual`）、1 个 disabled（`plugin-workflow-dynamic-calculation`，故不收录）。
 * 各插件注册的 instruction/trigger 类型见 SOURCE.md 与报告 20 §3.6。
 * `plugin-notification-manager` 不是工作流插件，但 cc / notification 的原生面板
 * 直接 import 它的 `client-v2`（UserSelect / MessageConfigForm），因此必须同闭包。
 */
export const ENTRIES = [
  'packages/core/client-v2/src/index.ts',
  'packages/core/flow-engine/src/index.ts',
  'packages/plugins/@nocobase/plugin-workflow/src/client-v2/index.tsx',
  'packages/plugins/@nocobase/plugin-ai/src/client-v2/index.tsx',
  'packages/plugins/@nocobase/plugin-acl/src/client-v2/index.ts',
  'packages/plugins/@nocobase/plugin-file-manager/src/client-v2/index.tsx',
  'packages/plugins/@nocobase/plugin-workflow-manual/src/client-v2/index.tsx',
  // 目标 13000 enabled 的其它工作流节点/触发器插件（含 4 个 script 节点所属的 javascript 插件）。
  'packages/plugins/@nocobase/plugin-workflow-javascript/src/client-v2/index.tsx',
  'packages/plugins/@nocobase/plugin-workflow-aggregate/src/client-v2/index.tsx',
  'packages/plugins/@nocobase/plugin-workflow-loop/src/client-v2/index.tsx',
  'packages/plugins/@nocobase/plugin-workflow-notification/src/client-v2/index.tsx',
  'packages/plugins/@nocobase/plugin-workflow-cc/src/client-v2/index.tsx',
  'packages/plugins/@nocobase/plugin-workflow-date-calculation/src/client-v2/index.tsx',
  'packages/plugins/@nocobase/plugin-workflow-delay/src/client-v2/index.tsx',
  'packages/plugins/@nocobase/plugin-workflow-json-query/src/client-v2/index.tsx',
  'packages/plugins/@nocobase/plugin-workflow-json-variable-mapping/src/client-v2/index.tsx',
  'packages/plugins/@nocobase/plugin-workflow-mailer/src/client-v2/index.tsx',
  'packages/plugins/@nocobase/plugin-workflow-parallel/src/client-v2/index.tsx',
  'packages/plugins/@nocobase/plugin-workflow-request/src/client-v2/index.tsx',
  'packages/plugins/@nocobase/plugin-workflow-request-interceptor/src/client-v2/index.tsx',
  'packages/plugins/@nocobase/plugin-workflow-response-message/src/client-v2/index.tsx',
  'packages/plugins/@nocobase/plugin-workflow-sql/src/client-v2/index.tsx',
  'packages/plugins/@nocobase/plugin-workflow-variable/src/client-v2/index.tsx',
  'packages/plugins/@nocobase/plugin-workflow-action-trigger/src/client-v2/index.tsx',
  'packages/plugins/@nocobase/plugin-workflow-custom-action-trigger/src/client-v2/index.tsx',
  'packages/plugins/@nocobase/plugin-notification-manager/src/client-v2/index.tsx',
];

/** 随源码保留的上游 LICENSE（相对仓库根）；与 ENTRIES 所属包一一对应。 */
export const LICENSE_SOURCES = [
  'packages/core/client-v2/LICENSE',
  'packages/core/flow-engine/LICENSE',
  'packages/plugins/@nocobase/plugin-workflow/LICENSE',
  'packages/plugins/@nocobase/plugin-ai/LICENSE',
  'packages/plugins/@nocobase/plugin-acl/LICENSE',
  'packages/plugins/@nocobase/plugin-file-manager/LICENSE',
  'packages/plugins/@nocobase/plugin-workflow-manual/LICENSE',
  'packages/plugins/@nocobase/plugin-workflow-javascript/LICENSE',
  'packages/plugins/@nocobase/plugin-workflow-aggregate/LICENSE',
  'packages/plugins/@nocobase/plugin-workflow-loop/LICENSE',
  'packages/plugins/@nocobase/plugin-workflow-notification/LICENSE',
  'packages/plugins/@nocobase/plugin-workflow-cc/LICENSE',
  'packages/plugins/@nocobase/plugin-workflow-date-calculation/LICENSE',
  'packages/plugins/@nocobase/plugin-workflow-delay/LICENSE',
  'packages/plugins/@nocobase/plugin-workflow-json-query/LICENSE',
  'packages/plugins/@nocobase/plugin-workflow-json-variable-mapping/LICENSE',
  'packages/plugins/@nocobase/plugin-workflow-mailer/LICENSE',
  'packages/plugins/@nocobase/plugin-workflow-parallel/LICENSE',
  'packages/plugins/@nocobase/plugin-workflow-request/LICENSE',
  'packages/plugins/@nocobase/plugin-workflow-request-interceptor/LICENSE',
  'packages/plugins/@nocobase/plugin-workflow-response-message/LICENSE',
  'packages/plugins/@nocobase/plugin-workflow-sql/LICENSE',
  'packages/plugins/@nocobase/plugin-workflow-variable/LICENSE',
  'packages/plugins/@nocobase/plugin-workflow-action-trigger/LICENSE',
  'packages/plugins/@nocobase/plugin-workflow-custom-action-trigger/LICENSE',
  'packages/plugins/@nocobase/plugin-notification-manager/LICENSE',
];

/**
 * 匹配静态 import/export 与动态 import。
 *
 * 必须包含**副作用导入**（`import './models/triggerWorkflows';`）——漏掉它会让闭包不完整
 * （实测：第一版正则漏了它，构建时才在 78 个模块处报 `Could not resolve ./models/triggerWorkflows`）。
 */
const IMPORT_PATTERN =
  /(?:^|[^\w$])(?:import|export)\s*(?:[^'"]*?from\s*)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
const EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.json', '.less', '.css', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function isLocalSource(spec) {
  return spec.startsWith('.');
}

/**
 * 扫描前先去掉注释：上游文件的文档注释里会出现 `() => import('./components/condition')`
 * 这类**说明性**片段，它们不是真实依赖（相对当前文件并不存在），否则会被误报为未解析。
 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function resolveLocal(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  for (const ext of EXTENSIONS) {
    const candidate = `${base}${ext}`;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function collectClosure(root) {
  const reached = new Set();
  const queue = ENTRIES.map((entry) => resolve(root, entry));
  const missing = [];
  while (queue.length > 0) {
    const file = queue.pop();
    if (!file || reached.has(file)) continue;
    if (file.includes('__tests__')) continue;
    if (!existsSync(file)) {
      missing.push(relative(root, file));
      continue;
    }
    reached.add(file);
    const text = stripComments(readFileSync(file, 'utf8'));
    for (const match of text.matchAll(IMPORT_PATTERN)) {
      const spec = match[1] ?? match[2];
      if (!spec || !isLocalSource(spec)) continue;
      if (spec.endsWith('.json') || spec.endsWith('.less') || spec.endsWith('.css')) {
        const asset = resolveLocal(dirname(file), spec);
        if (asset) reached.add(asset);
        continue;
      }
      const resolved = resolveLocal(file, spec);
      if (resolved) queue.push(resolved);
      else missing.push(`${relative(root, file)} -> ${spec}`);
    }
  }
  return { reached: Array.from(reached).sort(), missing };
}

function main() {
  if (!existsSync(resolve(SOURCE, ENTRIES[0]))) {
    console.error(`找不到 NocoBase ${NB_VERSION} 固定源码入口：${resolve(SOURCE, ENTRIES[0])}`);
    console.error(`请按 README 检出 NocoBase ${NB_VERSION} @ ${NB_COMMIT}，或用 NB_SOURCE=<仓库根> 指定。`);
    process.exitCode = 2;
    return;
  }
  const { reached, missing } = collectClosure(SOURCE);

  rmSync(OUT_ROOT, { recursive: true, force: true });
  const manifest = [];
  for (const file of reached) {
    const rel = relative(SOURCE, file).replace(/\\/g, '/');
    const target = resolve(OUT_ROOT, rel);
    mkdirSync(dirname(target), { recursive: true });
    const buffer = readFileSync(file);
    writeFileSync(target, buffer);
    manifest.push({ path: rel, bytes: buffer.length, sha256: sha256(file) });
  }
  const licenses = [];
  for (const rel of LICENSE_SOURCES) {
    const source = resolve(SOURCE, rel);
    if (!existsSync(source)) {
      missing.push(`LICENSE: ${rel}`);
      continue;
    }
    const target = resolve(OUT_ROOT, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(source));
    licenses.push(rel);
  }
  // 宿主侧编译选项（不是上游文件）：esbuild 的 tsconfck 会从被转换文件向上找最近的 tsconfig.json。
  // 放在 vendor 根可以只作用于这棵源码树，不影响产品 src/ 的 tsconfig.app.json。
  writeFileSync(
    resolve(OUT_ROOT, 'tsconfig.json'),
    `${JSON.stringify(
      {
        '//': [
          '宿主侧的编译选项（**不是**上游文件），只作用于 vendor/nocobase-2.2.22/ 这棵固定源码树。',
          '为什么需要：上游仓库根的 tsconfig.json 通过 extends 指向 tsconfig.paths.json，那份文件不在我们复制的子集里；',
          '而 esbuild 的 tsconfck 会从被转换文件向上查找最近的 tsconfig.json。放在这里可以：',
          ' (1) 给固定源码单独一套编译语义，不改变产品 src/ 的 tsconfig.app.json；',
          ' (2) 让 dev 侧 esbuild 正确处理 TS 旧式装饰器与自动 JSX 运行时。',
          'useDefineForClassFields=false 与上游运行语义一致（装饰器 + 类字段需要赋值语义）。',
          '注意：node scripts/vendor-native-client-v2-source.mjs 会重建本目录，本文件需要重新放回。',
        ],
        compilerOptions: {
          target: 'ES2022',
          jsx: 'react-jsx',
          useDefineForClassFields: false,
          experimentalDecorators: true,
          verbatimModuleSyntax: false,
          isolatedModules: true,
          skipLibCheck: true,
          noEmit: true,
          allowJs: true,
        },
      },
      null,
      2,
    )}\n`,
  );

  const license = resolve(SOURCE, 'packages/plugins/@nocobase/plugin-workflow/LICENSE');
  if (existsSync(license)) writeFileSync(resolve(OUT_ROOT, 'LICENSE'), readFileSync(license));

  const byTop = {};
  for (const item of manifest) {
    const key = item.path.split('/').slice(0, 5).join('/');
    byTop[key] = (byTop[key] ?? 0) + 1;
  }
  writeFileSync(
    resolve(OUT_ROOT, 'SOURCE.md'),
    [
      `# 原生客户端固定源码 vendor（NocoBase ${NB_VERSION}）`,
      '',
      `- 上游：https://github.com/nocobase/nocobase.git`,
      `- commit：\`${NB_COMMIT}\`（tag v${NB_VERSION}）`,
      `- 复制时间：${new Date().toISOString()}`,
      `- 来源树：\`${SOURCE}\`（只读；本目录是其子集的逐字节副本）`,
      `- 复制方式：\`node scripts/vendor-native-client-v2-source.mjs\`（静态遍历相对 import 闭包，已去掉 __tests__）`,
      '',
      '## 复制范围',
      '',
      '入口：',
      ...ENTRIES.map((entry) => `- \`${entry}\``),
      '',
      '顶层分布：',
      ...Object.entries(byTop).map(([key, count]) => `- \`${key}\`：${count} 个文件`),
      '',
      '## 许可',
      '',
      '各包上游文件头写明 "This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License."，',
      '本目录随附各包的上游 `LICENSE`：',
      ...licenses.map((item) => `- \`${item}\``),
      '',
      '## 接入方式',
      '',
      '`vite.config.ts` 已通过 `vendor/nocobase-shims/native-aliases.mjs` 把六个入口指向本目录：',
      '',
      '- `@nocobase/client-v2` → `.../core/client-v2/src/index.ts`',
      '- `@nocobase/flow-engine` → `.../core/flow-engine/src/index.ts`',
      '- `@nocobase/plugin-workflow/client-v2` → `.../plugin-workflow/src/client-v2/index.tsx`',
      '- `@nocobase/plugin-ai/client-v2` → `.../plugin-ai/src/client-v2/index.tsx`',
      '- `@nocobase/plugin-acl/client-v2` → `.../plugin-acl/src/client-v2/index.ts`',
      '- `@nocobase/plugin-file-manager/client-v2` → `.../plugin-file-manager/src/client-v2/index.tsx`',
      '',
      '`@nocobase/utils` 由 `vendor/nocobase-shims/native-utils-resolver.mjs` 按引用方分流：',
      'SDK → 最小适配包；本目录里的源码 → 完整包。',
      '',
      '本目录源码的**裸包 import** 由 `vendor/nocobase-shims/native-source-resolver.mjs` 解析：',
      '本目录在 pnpm 严格布局的 `node_modules` 之外，因此按「该文件所属上游包」的已安装依赖解析，',
      '版本与 lockfile 中 2.2.22 闭包完全一致。',
      '',
      '可编译性回归检查：`pnpm run check:native-entries`（含本目录的客户端核心与插件入口）。',
      '',
      '## 已知未覆盖',
      '',
      '- **编译通过 ≠ 交互可用**：画布/聊天框的真实渲染与交互仍需浏览器验证。',
      '- TypeScript：本目录不在 `tsconfig.app.json` 的 `include` 内；页面 import 这些入口时',
      '  使用发布包的 `.d.ts`（`tsc -b` 不检查上游源码）。',
      '',
      `共 ${manifest.length} 个文件。`,
      '',
      '## 文件清单（路径 / 字节 / sha256）',
      '',
      '```',
      ...manifest.map((item) => `${item.sha256}  ${item.bytes}  ${item.path}`),
      '```',
      '',
    ].join('\n'),
  );
  writeFileSync(resolve(OUT_ROOT, 'manifest.json'), `${JSON.stringify({ version: NB_VERSION, commit: NB_COMMIT, entries: ENTRIES, licenses, files: manifest, unresolved: missing }, null, 2)}\n`);

  console.log(`固定源码 vendor：${manifest.length} 个文件 → ${OUT_ROOT}`);
  if (missing.length > 0) {
    console.log(`未解析的相对引用 ${missing.length} 处：`);
    for (const item of missing.slice(0, 20)) console.log(`  ${item}`);
    process.exitCode = 1;
    return;
  }
  console.log('相对引用全部解析完成（无未解析项）。');
}

main();
