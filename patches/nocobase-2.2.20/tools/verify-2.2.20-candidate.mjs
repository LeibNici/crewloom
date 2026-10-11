#!/usr/bin/env node
/**
 * NocoBase **2.2.20** 全局默认模型最小候选：生成补丁 + 隔离受控核对。
 *
 * 与 P2（2.2.22）那份验证的关系：
 *  - P2 的补丁打在 2.2.22 的 **TS 源码**上（`experiments/p2-isolated-validation/backend/patches/`）；
 *  - 本脚本打在 2.2.20 **已发布产物** `@nocobase/plugin-ai@2.2.20` 的 `dist/*.js` 上，
 *    因为发布包不含 `src/`（已核对 tarball 清单）。这是"同一处消费点、两种分发形态"的差别，
 *    不是版本差异结论。
 *
 * 三个消费点（2.2.20 实测，与 2.2.22 基线逐处对应）：
 *  A. `dist/server/manager/ai-manager.js` 的 `resolveModel()` —— 不读 `aiSettings` 默认，
 *     直接取第一个有启用模型服务的首模型；
 *  B. `dist/server/workflow/nodes/llm/index.js` 的 `run()` —— 未指定 `llmService` 时不落默认，
 *     直接 `invalid llm service`（通用 LLM 节点旁路）；
 *  C. `dist/ai/tools/sub-agents/dispatch-sub-agent-task.js` —— 把员工 `modelSettings`
 *     **整个配置对象**当显式选择传给 `resolveModel`。
 *
 * 本脚本**只读**上游 tarball，只写自己的工作目录（`patches/nocobase-2.2.20/`）。
 * 不安装后端、不连后端、不调用任何模型、不 SSH、不写 13000。
 *
 * 用法：`node patches/nocobase-2.2.20/tools/verify-2.2.20-candidate.mjs`
 * 退出码 0 = 原始文件哈希一致 + 三个锚点各命中一次 + 补丁可生成 + 受控运行核对全部通过。
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const patchRoot = resolve(here, '..');
const workDir = resolve(patchRoot, '.work');

/**
 * 受控运行需要一组**本机已装好**的依赖（lodash / zod / axios / dayjs / @langchain/core /
 * 完整 @nocobase/utils）。候选本身只读 tarball，不下载依赖；这里按候选顺序解析一个
 * 存在的 `node_modules/.pnpm`：
 *  1. `NB_DEPS_ROOT`（显式覆盖）；
 *  2. 本工作树 `frontend/`（若已按锁安装）；
 *  3. 项目根 `frontend/`（只读复用，锁文件同源）。
 * 解析到的实际版本会写进 `candidate-check.json` 的 `deps` 段，便于复核 pin。
 */
const depsRootCandidates = [
  process.env.NB_DEPS_ROOT,
  resolve(patchRoot, '../../frontend'),
  resolve(patchRoot, '../../../../frontend'),
].filter(Boolean);
const frontendRoot =
  depsRootCandidates.find((root) => existsSync(join(root, 'node_modules/.pnpm'))) ??
  depsRootCandidates[0];

/**
 * 目标版本（2.2.20）的 `@nocobase/utils` 固定副本。上一轮用的是产品前端里的 2.2.22，
 * 这里显式 pin 到 **2.2.20**（`dist` 里 `Registry` 等被 tool-manager 使用）；副本从
 * `.cache/utils-2.2.20.tgz` 解出到 `.deps/`（两者都 `.gitignore`）。缺失且无缓存时回退到
 * 本机已装的同族版本，并在证据里记录实际解析结果。
 */
const utilsTarball = process.env.NB_UTILS_2_2_20_TARBALL ?? resolve(patchRoot, '.cache/utils-2.2.20.tgz');
// 解到 `.cache/` 下（根 `.gitignore` 已忽略 `/patches/nocobase-2.2.20/.cache/`），避免新增忽略规则。
const pinnedUtilsRoot = resolve(patchRoot, '.cache/utils-2.2.20');
const pinnedUtilsDir = process.env.NB_UTILS_2_2_20_DIR ?? join(pinnedUtilsRoot, 'package');
const UTILS_TARBALL_SHA256 = 'e4ee5cf4706b08d778a149beaa7e8e0d0c3fec80b7884cff1cbeb1c6d7ca48d5';
const UTILS_TARBALL_URL = 'https://registry.npmjs.org/@nocobase/utils/-/utils-2.2.20.tgz';

/**
 * 需要时把 pin 的 2.2.20 utils 从本地缓存解出来（不联网、不装包）。
 *
 * 该包有十几个三方依赖。为避免联网/装包，这里扫描它自身的 bare require，逐个用
 * `resolvePnpmPackage` 从**本机已装**依赖里解析后软链到 `.cache/utils-2.2.20/node_modules/`
 * （解析到的真实版本写进证据）。缺失的包名照样记录，不假装成功。任何一步失败都回退到
 * 本机已装的版本，不改变候选行为。
 */
function ensurePinnedUtils() {
  if (existsSync(join(pinnedUtilsDir, 'package.json'))) return { ok: true, source: 'cached' };
  if (!existsSync(utilsTarball)) return { ok: false, source: 'missing-tarball' };
  const hash = sha256(readFileSync(utilsTarball));
  if (hash !== UTILS_TARBALL_SHA256) return { ok: false, source: 'hash-mismatch', hash };
  const installed = resolvePnpmPackage('@nocobase/utils');
  if (!installed) return { ok: false, source: 'missing-installed-utils' };
  mkdirSync(pinnedUtilsRoot, { recursive: true });
  run('tar', ['-xzf', utilsTarball, '-C', pinnedUtilsRoot]);
  const farmDest = join(pinnedUtilsRoot, 'node_modules');
  mkdirSync(farmDest, { recursive: true });
  const resolved = {};
  const missing = [];
  for (const spec of collectBareRequires([pinnedUtilsDir])) {
    const packageName = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    if (existsSync(join(farmDest, packageName))) continue;
    const target = resolvePnpmPackage(packageName);
    if (!target) {
      missing.push(packageName);
      continue;
    }
    mkdirSync(dirname(join(farmDest, packageName)), { recursive: true });
    symlinkSync(target, join(farmDest, packageName));
    try {
      resolved[packageName] = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).version ?? null;
    } catch {
      resolved[packageName] = null;
    }
  }
  return { ok: true, source: 'extracted', hash, installedUtils: installed, resolved, missing };
}

const tarball = process.env.NB_AI_2_2_20_TARBALL ?? resolve(patchRoot, '.cache/plugin-ai-2.2.20.tgz');

const TARBALL_SHA256 = '3fb3be5d60c1c8d92dd36917b85449752c74552f983177a64deb613d3a44d16a';
const TARBALL_URL =
  'https://registry.npmjs.org/@nocobase/plugin-ai/-/plugin-ai-2.2.20.tgz';

const FILES = {
  manager: 'package/dist/server/manager/ai-manager.js',
  llmNode: 'package/dist/server/workflow/nodes/llm/index.js',
  subAgent: 'package/dist/ai/tools/sub-agents/dispatch-sub-agent-task.js',
};

/**
 * 锚点：每段必须**恰好命中一次**（命中 0 次或多次即失败并中止），
 * 避免上游产物变化后被"看起来成功"的替换骗过。
 */
const ANCHORS = [
  {
    id: 'A-default-consumption',
    file: FILES.manager,
    find: `  async resolveModel(model) {
    var _a;
    if ((model == null ? void 0 : model.llmService) && (model == null ? void 0 : model.model)) {
      return model;
    }
    const services = await this.listAllEnabledModels();`,
    replace: `  async resolveModel(model) {
    var _a;
    if ((model == null ? void 0 : model.llmService) && (model == null ? void 0 : model.model)) {
      return model;
    }
    const defaultModel = await this.resolveDefaultModel();
    if (defaultModel) {
      return defaultModel;
    }
    const services = await this.listAllEnabledModels();`,
  },
  {
    id: 'A-default-resolver',
    file: FILES.manager,
    find: `  toEnabledLLMService(service) {
    var _a, _b, _c;`,
    replace: `  async resolveDefaultModel() {
    const settings = await this.plugin.db.getRepository("aiSettings").findOne();
    const rawService = (settings == null ? void 0 : settings.get) ? settings.get("defaultLLMService") : settings == null ? void 0 : settings.defaultLLMService;
    const rawModel = (settings == null ? void 0 : settings.get) ? settings.get("defaultModel") : settings == null ? void 0 : settings.defaultModel;
    const isSet = (value) => value != null && String(value).trim() !== "";
    const serviceSet = isSet(rawService);
    const modelSet = isSet(rawModel);
    if (!serviceSet && !modelSet) {
      return null;
    }
    if (!serviceSet || !modelSet) {
      throw new Error("Default LLM service and default model must both be configured: the configured default is incomplete");
    }
    const llmService = String(rawService);
    const model = String(rawModel);
    const services = await this.plugin.db.getRepository("llmServices").find({ sort: "sort" });
    const service = services.find((item) => ((item.get == null ? void 0 : item.get("name")) || item.name) === llmService);
    if (!service) {
      throw new Error('Default LLM service "' + llmService + '" is not available: service not found');
    }
    if (((service.get == null ? void 0 : service.get("enabled")) ?? service.enabled) === false) {
      throw new Error('Default LLM service "' + llmService + '" is not available: service is disabled');
    }
    const enabledModels = this.getEnabledModels(service);
    if (!enabledModels.length) {
      throw new Error('Default LLM service "' + llmService + '" is not available: service has no enabled models');
    }
    if (!enabledModels.some((item) => item.value === model)) {
      throw new Error('Default LLM model "' + model + '" is not available: model is not enabled on service "' + llmService + '"');
    }
    return { llmService, model };
  }
  toEnabledLLMService(service) {
    var _a, _b, _c;`,
  },
  {
    id: 'B-llm-node-default',
    file: FILES.llmNode,
    find: `    let provider;
    try {
      provider = await this.getLLMProvider(llmService, modelOptions, {
        sessionId: \`workflow-\${processor.execution.id}-\${node.id}\`
      });`,
    replace: `    let provider;
    try {
      let resolvedLLMService = llmService;
      if (!resolvedLLMService) {
        const plugin = this.workflow.app.pm.get("ai");
        const defaultModel = await plugin.aiManager.resolveModel();
        resolvedLLMService = defaultModel.llmService;
        if (!modelOptions.model) {
          modelOptions.model = defaultModel.model;
        }
      }
      provider = await this.getLLMProvider(resolvedLLMService, modelOptions, {
        sessionId: \`workflow-\${processor.execution.id}-\${node.id}\`
      });`,
  },
  {
    id: 'C-sub-agent-explicit-only',
    file: FILES.subAgent,
    find: `      model: ((_h = (_g = (_f = ctx.action) == null ? void 0 : _f.params) == null ? void 0 : _g.values) == null ? void 0 : _h.model) ?? employee.get("modelSettings"),`,
    replace: `      model: ((_h = (_g = (_f = ctx.action) == null ? void 0 : _f.params) == null ? void 0 : _g.values) == null ? void 0 : _h.model) ?? extractExplicitModelRef(employee.get("modelSettings")),`,
  },
  {
    id: 'C-sub-agent-helper',
    file: FILES.subAgent,
    find: `var dispatch_sub_agent_task_exports = {};`,
    replace: `function extractExplicitModelRef(modelSettings) {
  if (!modelSettings || typeof modelSettings !== "object") {
    return null;
  }
  if (modelSettings.enabled !== true) {
    return null;
  }
  const models = Array.isArray(modelSettings.models) ? modelSettings.models : [];
  const first = models.find((item) => (item == null ? void 0 : item.llmService) && (item == null ? void 0 : item.model));
  if (first) {
    return { llmService: first.llmService, model: first.model };
  }
  if (modelSettings.llmService && modelSettings.model) {
    return { llmService: modelSettings.llmService, model: modelSettings.model };
  }
  return null;
}
var dispatch_sub_agent_task_exports = {};`,
  },
];

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', ...options });
}

function extractPristine() {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  const pristine = join(workDir, 'pristine');
  mkdirSync(pristine, { recursive: true });
  run('tar', ['-xzf', tarball, '-C', pristine]);
  cpSync(pristine, join(workDir, 'patched'), { recursive: true });
  return { pristine, patched: join(workDir, 'patched') };
}

function applyAnchors(patchedRoot) {
  const results = [];
  for (const anchor of ANCHORS) {
    const file = join(patchedRoot, anchor.file);
    const text = readFileSync(file, 'utf8');
    const hits = text.split(anchor.find).length - 1;
    if (hits !== 1) {
      results.push({ id: anchor.id, hits, applied: false });
      continue;
    }
    writeFileSync(file, text.replace(anchor.find, anchor.replace));
    results.push({ id: anchor.id, hits, applied: true });
  }
  return results;
}

function makePatch(pristineRoot, patchedRoot) {
  const rels = [...new Set(ANCHORS.map((anchor) => anchor.file))];
  let combined = '';
  for (const rel of rels) {
    try {
      combined += run('diff', ['-u', `a/${rel}`, `b/${rel}`], {
        cwd: workDir,
        env: { ...process.env },
      }).replace(new RegExp(pristineRoot, 'g'), 'x');
    } catch (error) {
      if (error.status !== 1) throw error;
    }
  }
  // diff 以 workDir 为 cwd，输出里的路径已是 package/...，这里统一成 a/ b/ 形式。
  return combined;
}

/** 生成可 `patch -p1 -d node_modules/@nocobase/plugin-ai` 应用的 unified diff。 */
function diffFor(rel, pristineRoot, patchedRoot) {
  const inner = rel.replace(/^package\//, '');
  const args = [
    '-u',
    '--label',
    `a/${inner}`,
    '--label',
    `b/${inner}`,
    join(pristineRoot, rel),
    join(patchedRoot, rel),
  ];
  try {
    return run('diff', args);
  } catch (error) {
    if (error.status === 1) return error.stdout;
    throw error;
  }
}



/** 扫描一组目录下所有 .js 的 bare require 说明符。 */
function collectBareRequires(dirs) {
  const specs = new Set();
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      const text = readFileSync(full, 'utf8');
      for (const match of text.matchAll(/require\("([^"]+)"\)/g)) {
        const spec = match[1];
        if (!spec.startsWith('.') && !spec.startsWith('node:')) specs.add(spec);
      }
    }
  };
  for (const dir of dirs) walk(dir);
  return Array.from(specs);
}

/** 从产品 node_modules/.pnpm 里解析一个已安装包的真实目录（本机可逆、不下载）。 */
function resolvePnpmPackage(name) {
  const base = join(frontendRoot, 'node_modules/.pnpm');
  const hoisted = join(base, 'node_modules', name);
  if (existsSync(hoisted)) return hoisted;
  const flat = name.replace('/', '+');
  if (!existsSync(base)) return null;
  const entries = readdirSync(base).filter((entry) => entry.startsWith(`${flat}@`));
  for (const entry of entries) {
    const candidate = join(base, entry, 'node_modules', name);
    if (existsSync(candidate)) return candidate;
  }
  const direct = join(frontendRoot, 'node_modules', name);
  return existsSync(direct) ? direct : null;
}

/**
 * 受控运行核对：把**原始**与**补丁后**的 2.2.20 发布产物都加载进本机 Node，
 * 用假 plugin / 假 processor / 假 ctx 驱动，逐条对比行为差异。
 *
 * 边界（重要）：只连本机已装好的 `lodash` / `zod` / 完整 `@nocobase/utils`；
 * 框架基类 `@nocobase/plugin-workflow`（`Instruction` / `JOB_STATUS`）与
 * `@nocobase/ai`（`defineTools`）用**最小替身**提供 —— 因为真实包在 Node 里需要整个
 * NocoBase 服务端依赖图，而这里要验证的是**本插件里的那三段逻辑**。
 * 不联网、不装后端、不调模型、不 SSH。
 */
function prepareStubs(pristineRoot, patchedRoot) {
  const stubRoot = join(workDir, 'stubs');
  const stubModules = join(stubRoot, 'node_modules');
  rmSync(stubRoot, { recursive: true, force: true });
  mkdirSync(join(stubModules, '@nocobase'), { recursive: true });

  // 只连本机**已装好**的包；`.pnpm` 里的真实目录按需解析，不下载、不联网。
  // 做法：扫描被测三个模块所在目录里的 **bare require**，逐个从产品 node_modules 解析后软链过来，
  // 避免手写清单漏项（axios / dayjs / lodash / zod / @langchain/core … 都是实测需要的）。
  const scannedDirs = [
    join(patchedRoot, 'package/dist/server/manager'),
    join(patchedRoot, 'package/dist/server/workflow/nodes/llm'),
    join(patchedRoot, 'package/dist/ai/tools/sub-agents'),
    // 真实下游链（C 处）会加载 ai-employees/* 与 ai/tools/**、common/**，一并扫描其 bare require
    join(patchedRoot, 'package/dist/server/ai-employees'),
    join(patchedRoot, 'package/dist/ai/tools'),
    join(patchedRoot, 'package/dist/common'),
  ];
  const stubbedByUs = new Set(['@nocobase/utils', '@nocobase/plugin-workflow', '@nocobase/ai', '@nocobase/database']);
  const missing = [];
  for (const spec of collectBareRequires(scannedDirs)) {
    const packageName = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    if (stubbedByUs.has(packageName) || packageName.startsWith('node:')) continue;
    if (existsSync(join(stubModules, packageName))) continue;
    const target = resolvePnpmPackage(packageName);
    if (!target) {
      missing.push(packageName);
      continue;
    }
    mkdirSync(dirname(join(stubModules, packageName)), { recursive: true });
    symlinkSync(target, join(stubModules, packageName));
  }
  // @nocobase/utils 必须解析到**完整**包（不是产品顶层的轻量适配包）：tool-manager 需要 Registry。
  // 优先用 pin 到 2.2.20 的固定副本；缺失才回退本机同族版本。
  const utilsTarget = existsSync(join(pinnedUtilsDir, 'package.json'))
    ? pinnedUtilsDir
    : resolvePnpmPackage('@nocobase/utils');
  if (!utilsTarget) return { ok: false, reason: '缺少本机依赖：@nocobase/utils' };
  mkdirSync(join(stubModules, '@nocobase'), { recursive: true });
  rmSync(join(stubModules, '@nocobase/utils'), { recursive: true, force: true });
  symlinkSync(utilsTarget, join(stubModules, '@nocobase/utils'));

  // 框架最小替身（不是被测逻辑）。
  const pluginWorkflowStub = join(stubModules, '@nocobase/plugin-workflow');
  mkdirSync(pluginWorkflowStub, { recursive: true });
  writeFileSync(
    join(pluginWorkflowStub, 'package.json'),
    `${JSON.stringify({ name: '@nocobase/plugin-workflow', version: '2.2.20-fake', main: 'index.js' }, null, 2)}\n`,
  );
  writeFileSync(
    join(pluginWorkflowStub, 'index.js'),
    [
      '// 最小替身：只提供被测文件用到的基类与枚举，不实现任何工作流语义。',
      'class Instruction { constructor(options = {}) { Object.assign(this, options); } }',
      'const JOB_STATUS = { PENDING: 0, RESOLVED: 1, FAILED: -1, ERROR: -2 };',
      'function isWorkflowTimeoutError() { return false; }',
      'module.exports = { Instruction, JOB_STATUS, isWorkflowTimeoutError };',
      '',
    ].join('\n'),
  );
  const aiStub = join(stubModules, '@nocobase/ai');
  mkdirSync(aiStub, { recursive: true });
  writeFileSync(
    join(aiStub, 'package.json'),
    `${JSON.stringify({ name: '@nocobase/ai', version: '2.2.20-fake', main: 'index.js' }, null, 2)}\n`,
  );
  writeFileSync(
    join(aiStub, 'index.js'),
    [
      '// 框架替身：只提供被测链路 require 到的符号（不是被测逻辑）。',
      'function defineTools(definition) { return definition; }',
      'function listSystemTools() { return []; }',
      'const SYSTEM_TOOLS = [];',
      'module.exports = { defineTools, listSystemTools, SYSTEM_TOOLS };',
      '',
    ].join('\n'),
  );
  const databaseStub = join(stubModules, '@nocobase/database');
  mkdirSync(databaseStub, { recursive: true });
  writeFileSync(
    join(databaseStub, 'package.json'),
    `${JSON.stringify({ name: '@nocobase/database', version: '2.2.20-fake', main: 'index.js' }, null, 2)}\n`,
  );
  writeFileSync(
    join(databaseStub, 'index.js'),
    [
      '// 框架替身：Op / UniqueConstraintError 等符号（Op 与 sequelize 的语义一致）。',
      'class UniqueConstraintError extends Error {}',
      'const Op = { ne: Symbol("ne"), in: Symbol("in"), notIn: Symbol("notIn"), eq: Symbol("eq") };',
      'module.exports = { Op, UniqueConstraintError };',
      '',
    ].join('\n'),
  );

  cpSync(join(pristineRoot, 'package'), join(stubRoot, 'pristine'), { recursive: true });
  cpSync(join(patchedRoot, 'package'), join(stubRoot, 'patched'), { recursive: true });
  // 记录实际软链进来的依赖版本（pin 复核用）。
  const resolvedDeps = {};
  for (const entry of readdirSync(stubModules, { withFileTypes: true })) {
    const names = entry.name.startsWith('@')
      ? readdirSync(join(stubModules, entry.name)).map((sub) => `${entry.name}/${sub}`)
      : [entry.name];
    for (const name of names) {
      const pkgJson = join(stubModules, name, 'package.json');
      if (!existsSync(pkgJson)) continue;
      try {
        resolvedDeps[name] = JSON.parse(readFileSync(pkgJson, 'utf8')).version ?? null;
      } catch {
        resolvedDeps[name] = null;
      }
    }
  }
  return {
    ok: true,
    stubRoot,
    utilsTarget,
    resolvedDeps,
    requireFromStub: createRequire(join(stubRoot, 'entry.cjs')),
  };
}

/** A 处：`AIManager.resolveModel` 的 7 条规则（补丁后代码）。 */
async function checkManager(stubs) {
  const { AIManager } = stubs.requireFromStub('./patched/dist/server/manager/ai-manager.js');

  const makeService = (name, enabled, models) => ({
    get: (key) => ({ name, enabled, provider: 'openai', enabledModels: models })[key],
    name,
    enabled,
    provider: 'openai',
    enabledModels: models,
  });

  const cases = [];
  const runCase = async (id, { settings, services, explicit }) => {
    const plugin = {
      db: {
        getRepository(name) {
          if (name === 'aiSettings') return { findOne: async () => settings };
          return { find: async () => services, findOne: async () => services[0] };
        },
      },
    };
    const manager = new AIManager(plugin);
    manager.registerLLMProvider('openai', {
      title: 'OpenAI',
      provider: class Provider {
        isToolConflict() {
          return false;
        }
      },
    });
    try {
      cases.push({ id, outcome: 'resolved', result: await manager.resolveModel(explicit) });
    } catch (error) {
      cases.push({ id, outcome: 'threw', message: String(error.message) });
    }
  };

  const settings = (raw) => ({ get: (key) => raw[key], ...raw });

  await runCase('D1 默认已配置 → 用默认（不再取首模型）', {
    settings: settings({ defaultLLMService: 'svc-b', defaultModel: 'm-b1' }),
    services: [makeService('svc-a', true, ['m-a1']), makeService('svc-b', true, ['m-b1'])],
  });
  await runCase('D2 默认未配置 → 保留旧回退（第一个有启用模型的服务首模型）', {
    settings: settings({ defaultLLMService: null, defaultModel: null }),
    services: [makeService('svc-a', true, ['m-a1']), makeService('svc-b', true, ['m-b1'])],
  });
  await runCase('D3 默认只配一半 → 明确失败', {
    settings: settings({ defaultLLMService: 'svc-b', defaultModel: '' }),
    services: [makeService('svc-b', true, ['m-b1'])],
  });
  await runCase('D4 默认服务不存在 → 明确失败', {
    settings: settings({ defaultLLMService: 'svc-x', defaultModel: 'm-x' }),
    services: [makeService('svc-b', true, ['m-b1'])],
  });
  await runCase('D5 默认服务已禁用 → 明确失败', {
    settings: settings({ defaultLLMService: 'svc-b', defaultModel: 'm-b1' }),
    services: [makeService('svc-b', false, ['m-b1'])],
  });
  await runCase('D6 默认模型不在启用列表 → 明确失败', {
    settings: settings({ defaultLLMService: 'svc-b', defaultModel: 'm-nope' }),
    services: [makeService('svc-b', true, ['m-b1'])],
  });
  await runCase('D7 合法显式仍优先（不受默认影响）', {
    settings: settings({ defaultLLMService: 'svc-b', defaultModel: 'm-b1' }),
    services: [makeService('svc-a', true, ['m-a1']), makeService('svc-b', true, ['m-b1'])],
    explicit: { llmService: 'svc-a', model: 'm-a1' },
  });
  await runCase('D8 默认服务没有任何启用模型 → 明确失败', {
    settings: settings({ defaultLLMService: 'svc-b', defaultModel: 'm-b1' }),
    services: [
      {
        // 对象形态 + 空 models：`getEnabledModels` 会返回空数组（数组形态为空时会落到推荐模型，
        // 因此用对象形态来真实触达"没有启用模型"这一分支）。
        get: (key) => ({ name: 'svc-b', enabled: true, provider: 'openai', enabledModels: { mode: 'custom', models: [] } })[key],
        name: 'svc-b',
        enabled: true,
        provider: 'openai',
        enabledModels: { mode: 'custom', models: [] },
      },
    ],
  });

  const expected = {
    'D1 默认已配置 → 用默认（不再取首模型）': { outcome: 'resolved', result: { llmService: 'svc-b', model: 'm-b1' } },
    'D2 默认未配置 → 保留旧回退（第一个有启用模型的服务首模型）': { outcome: 'resolved', result: { llmService: 'svc-a', model: 'm-a1' } },
    'D3 默认只配一半 → 明确失败': { outcome: 'threw' },
    'D4 默认服务不存在 → 明确失败': { outcome: 'threw' },
    'D5 默认服务已禁用 → 明确失败': { outcome: 'threw' },
    'D6 默认模型不在启用列表 → 明确失败': { outcome: 'threw' },
    'D7 合法显式仍优先（不受默认影响）': { outcome: 'resolved', result: { llmService: 'svc-a', model: 'm-a1' } },
    'D8 默认服务没有任何启用模型 → 明确失败': { outcome: 'threw' },
  };

  return cases.map((item) => {
    const want = expected[item.id];
    let ok = item.outcome === want.outcome;
    if (ok && want.result) ok = JSON.stringify(item.result) === JSON.stringify(want.result);
    return { ...item, expected: want, ok };
  });
}

/** B 处：通用 LLM 节点的默认回退（原始 vs 补丁后逐条对比）。 */
async function checkLlmNode(stubs) {
  const runOne = async (copy, config) => {
    const { LLMInstruction } = stubs.requireFromStub(`./${copy}/dist/server/workflow/nodes/llm/index.js`);
    let resolveModelCalls = 0;
    const aiPlugin = {
      aiManager: {
        resolveModel: async () => {
          resolveModelCalls += 1;
          return { llmService: 'svc-b', model: 'm-b1' };
        },
      },
    };
    const workflow = {
      app: { pm: { get: (name) => (name === 'ai' ? aiPlugin : undefined) } },
      resume() {},
    };
    const instance = new LLMInstruction({ workflow });
    let captured = null;
    instance.getLLMProvider = async (llmService, modelOptions, requestContext) => {
      captured = { llmService, model: modelOptions.model, requestContext };
      throw new Error('SENTINEL-STOP');
    };
    const processor = {
      getParsedValue: () => config,
      execution: { id: 7 },
      saveJob: () => ({ id: 1 }),
      createBackgroundAbortHandle: () => ({ signal: undefined, throwIfAborted() {} }),
      logger: { error() {} },
      findPendingJob: async () => null,
    };
    const result = await instance.run({ id: 1, key: 'k', config }, { id: null }, processor);
    return { captured, resolveModelCalls, status: result?.status, result: result?.result };
  };

  const cases = [];
  const scenarios = [
    {
      id: 'E1 节点未指定服务 → 落全局默认（补丁前不发请求）',
      config: { messages: [], llmService: undefined },
      expectPatched: { llmService: 'svc-b', model: 'm-b1', resolveModelCalls: 1 },
      expectPristine: { llmService: undefined, model: undefined, resolveModelCalls: 0 },
    },
    {
      id: 'E2 节点显式服务 + 显式模型 → 完全不动',
      config: { messages: [], llmService: 'svc-x', model: 'm-x' },
      expectPatched: { llmService: 'svc-x', model: 'm-x', resolveModelCalls: 0 },
      expectPristine: { llmService: 'svc-x', model: 'm-x', resolveModelCalls: 0 },
    },
    {
      id: 'E3 节点显式服务、未显式模型 → 补丁也不补默认模型（不越权改用户配置）',
      config: { messages: [], llmService: 'svc-x' },
      expectPatched: { llmService: 'svc-x', model: undefined, resolveModelCalls: 0 },
      expectPristine: { llmService: 'svc-x', model: undefined, resolveModelCalls: 0 },
    },
  ];

  for (const scenario of scenarios) {
    const patchedRun = await runOne('patched', scenario.config);
    const pristineRun = await runOne('pristine', scenario.config);
    const asObserved = (run) => ({
      llmService: run.captured?.llmService,
      model: run.captured?.model,
      resolveModelCalls: run.resolveModelCalls,
    });
    const patchedObserved = asObserved(patchedRun);
    const pristineObserved = asObserved(pristineRun);
    cases.push({
      id: scenario.id,
      patched: patchedObserved,
      pristine: pristineObserved,
      ok:
        JSON.stringify(patchedObserved) === JSON.stringify(scenario.expectPatched) &&
        JSON.stringify(pristineObserved) === JSON.stringify(scenario.expectPristine),
      expectedPatched: scenario.expectPatched,
      expectedPristine: scenario.expectPristine,
    });
  }
  return cases;
}

/** C 处：子任务传参归一（原始 vs 补丁后逐条对比）。 */
async function checkSubAgent(stubs) {
  const runOne = async (copy, { modelSettings, explicitModel }) => {
    const tool = stubs.requireFromStub(`./${copy}/dist/ai/tools/sub-agents/dispatch-sub-agent-task.js`).default;
    const employee = { get: (key) => (key === 'modelSettings' ? modelSettings : key === 'username' ? 'emp-1' : undefined) };
    const plugin = {
      aiConversationsManager: {
        resolveSubAgentConversation: async () => null,
        create: async () => ({ sessionId: 'sub-1' }),
      },
      subAgentsDispatcher: { run: async (args) => { captured = args; return 'ok'; } },
      builtInManager: { setupBuiltInInfo() {} },
    };
    let captured = null;
    const ctx = {
      app: { pm: { get: () => plugin } },
      auth: { user: { id: 1 } },
      state: { currentRoles: ['root'] },
      action: { params: { values: { sessionId: 'sess-1', ...(explicitModel ? { model: explicitModel } : {}) } } },
      db: {
        getRepository(name) {
          if (name === 'aiEmployees') return { findOne: async () => employee, find: async () => [employee] };
          if (name === 'aiConversations') return { findOne: async () => ({ options: {} }) };
          return { findOne: async () => null, find: async () => [] };
        },
      },
    };
    await tool.invoke(ctx, { username: 'emp-1', question: 'q' }, { toolCallId: 'tc-1', writer: null });
    return captured?.model;
  };

  const scenarios = [
    {
      id: 'F1 专用配置已关闭但留有扁平字段 → 传 null（补丁前把整份配置当显式）',
      modelSettings: { enabled: false, llmService: 'svc-c', model: 'm-c1' },
      expectPatched: null,
      expectPristine: { enabled: false, llmService: 'svc-c', model: 'm-c1' },
    },
    {
      id: 'F2 专用配置开启且带 models 列表 → 取第一个合法对',
      modelSettings: { enabled: true, models: [{ llmService: 'svc-a', model: 'm-a1' }] },
      expectPatched: { llmService: 'svc-a', model: 'm-a1' },
      expectPristine: { enabled: true, models: [{ llmService: 'svc-a', model: 'm-a1' }] },
    },
    {
      id: 'F3 专用配置开启且带扁平合法对 → 作为显式传出',
      modelSettings: { enabled: true, llmService: 'svc-b', model: 'm-b1' },
      expectPatched: { llmService: 'svc-b', model: 'm-b1' },
      expectPristine: { enabled: true, llmService: 'svc-b', model: 'm-b1' },
    },
    {
      id: 'F4 专用配置开启但没有可用对 → 传 null',
      modelSettings: { enabled: true },
      expectPatched: null,
      expectPristine: { enabled: true },
    },
    {
      id: 'F5 上游显式 model 仍最优先 → 覆盖专用配置',
      modelSettings: { enabled: true, llmService: 'svc-b', model: 'm-b1' },
      explicitModel: { llmService: 'svc-x', model: 'm-x' },
      expectPatched: { llmService: 'svc-x', model: 'm-x' },
      expectPristine: { llmService: 'svc-x', model: 'm-x' },
    },
  ];

  const cases = [];
  for (const scenario of scenarios) {
    const patched = await runOne('patched', scenario);
    const pristine = await runOne('pristine', scenario);
    cases.push({
      id: scenario.id,
      patched,
      pristine,
      ok:
        JSON.stringify(patched) === JSON.stringify(scenario.expectPatched) &&
        JSON.stringify(pristine) === JSON.stringify(scenario.expectPristine),
      expectedPatched: scenario.expectPatched,
      expectedPristine: scenario.expectPristine,
    });
  }
  return cases;
}

/**
 * 假 `llmServices` 记录：同时支持 `model.get(key)` 与直属性读取（2.2.20 两种形态都有）；
 * `options` 用来给每个服务打可区分的标记，证明**尾链**用的就是解析出来的那个服务。
 */
function fakeLlmService(name, enabled, modelIds, tag = name) {
  // 注意：原始记录里 `enabledModels` 是**字符串数组**（`getEnabledModels` 才会转成 {label,value}）。
  const enabledModels = (modelIds ?? []).slice();
  return {
    get: (key) => ({ name, enabled, provider: 'openai', enabledModels, options: { tag } })[key],
    name,
    enabled,
    provider: 'openai',
    options: { tag },
    enabledModels,
  };
}

function fakeSettings(raw) {
  return raw === null || raw === undefined ? null : { get: (key) => raw[key], ...raw };
}

function fakeDb({ settings, services }) {
  return {
    getRepository(name) {
      if (name === 'aiSettings') return { findOne: async () => settings };
      if (name === 'llmServices') {
        return {
          find: async () => services,
          findOne: async ({ filter } = {}) => services.find((item) => item.name === filter?.name) ?? null,
        };
      }
      return { findOne: async () => null, find: async () => [] };
    },
  };
}

/**
 * G 处：2.2.20 **原生** `AIEmployeesManager.resolveModel(employee, model)`。
 *
 * 这里**不补丁**员工管理器（已批准：不改员工允许集/首选规则）。用意是核对：
 *  - 员工专用配置开启时的允许集 / 首选 / 显式优先逐条保持；
 *  - 员工专用配置关闭时，其回退走到公共 `aiManager.resolveModel()` ——
 *    于是公共默认（A 处补丁）在员工链路上**自动生效**，而"关闭但遗留扁平字段"不会被员工层当显式；
 *  - 5 种默认失效在员工回退路径上同样明确失败，不静默切换。
 * 原始 / 补丁后各跑一遍，差异只在回退分支。
 */
async function checkEmployees(stubs) {
  const scenarios = [
    {
      id: 'G1 员工专用配置关闭 + 遗留扁平字段 → 回退公共解析（关闭的遗留字段不当显式）',
      modelSettings: { enabled: false, llmService: 'svc-c', model: 'm-c1' },
      settings: { defaultLLMService: 'svc-b', defaultModel: 'm-b1' },
      services: [fakeLlmService('svc-a', true, ['m-a1']), fakeLlmService('svc-b', true, ['m-b1'])],
      expectPatched: { outcome: 'resolved', result: { llmService: 'svc-b', model: 'm-b1' } },
      expectPristine: { outcome: 'resolved', result: { llmService: 'svc-a', model: 'm-a1' } },
    },
    {
      id: 'G2 员工专用配置开启 + 显式在允许集内 → 显式优先（默认失效也不影响）',
      modelSettings: { enabled: true, models: [{ llmService: 'svc-b', model: 'm-b1' }] },
      explicit: { llmService: 'svc-b', model: 'm-b1' },
      settings: { defaultLLMService: 'svc-z', defaultModel: 'm-z' },
      services: [fakeLlmService('svc-b', true, ['m-b1'])],
      expectPatched: { outcome: 'resolved', result: { llmService: 'svc-b', model: 'm-b1' } },
      expectPristine: { outcome: 'resolved', result: { llmService: 'svc-b', model: 'm-b1' } },
    },
    {
      id: 'G3 员工专用配置开启 + 显式不在允许集 → 用首选，不越权、不落默认',
      modelSettings: { enabled: true, models: [{ llmService: 'svc-b', model: 'm-b1' }] },
      explicit: { llmService: 'svc-x', model: 'm-x' },
      settings: { defaultLLMService: 'svc-z', defaultModel: 'm-z' },
      services: [fakeLlmService('svc-b', true, ['m-b1'])],
      expectPatched: { outcome: 'resolved', result: { llmService: 'svc-b', model: 'm-b1' } },
      expectPristine: { outcome: 'resolved', result: { llmService: 'svc-b', model: 'm-b1' } },
    },
    {
      id: 'G4 员工专用配置开启 + 多允许模型 → 取第一个（首选规则保持）',
      modelSettings: { enabled: true, models: [{ llmService: 'svc-b', model: 'm-b1' }, { llmService: 'svc-a', model: 'm-a1' }] },
      settings: null,
      services: [fakeLlmService('svc-a', true, ['m-a1']), fakeLlmService('svc-b', true, ['m-b1'])],
      expectPatched: { outcome: 'resolved', result: { llmService: 'svc-b', model: 'm-b1' } },
      expectPristine: { outcome: 'resolved', result: { llmService: 'svc-b', model: 'm-b1' } },
    },
    {
      id: 'G5 员工专用配置开启但无可用对 → 明确失败（不被公共默认吞掉）',
      modelSettings: { enabled: true, models: [] },
      settings: { defaultLLMService: 'svc-b', defaultModel: 'm-b1' },
      services: [fakeLlmService('svc-b', true, ['m-b1'])],
      expectPatched: { outcome: 'threw', messageIncludes: 'AI employee model not configured' },
      expectPristine: { outcome: 'threw', messageIncludes: 'AI employee model not configured' },
    },
    {
      id: 'G6 员工专用配置开启 + 扁平合法对 → 作为允许集第一个',
      modelSettings: { enabled: true, llmService: 'svc-b', model: 'm-b1' },
      settings: { defaultLLMService: 'svc-a', defaultModel: 'm-a1' },
      services: [fakeLlmService('svc-a', true, ['m-a1']), fakeLlmService('svc-b', true, ['m-b1'])],
      expectPatched: { outcome: 'resolved', result: { llmService: 'svc-b', model: 'm-b1' } },
      expectPristine: { outcome: 'resolved', result: { llmService: 'svc-b', model: 'm-b1' } },
    },
    {
      id: 'G7 员工专用配置关闭 + 调用方合法显式 → 显式优先于全局默认',
      modelSettings: { enabled: false, llmService: 'svc-c', model: 'm-c1' },
      explicit: { llmService: 'svc-a', model: 'm-a1' },
      settings: { defaultLLMService: 'svc-b', defaultModel: 'm-b1' },
      services: [fakeLlmService('svc-a', true, ['m-a1']), fakeLlmService('svc-b', true, ['m-b1'])],
      expectPatched: { outcome: 'resolved', result: { llmService: 'svc-a', model: 'm-a1' } },
      expectPristine: { outcome: 'resolved', result: { llmService: 'svc-a', model: 'm-a1' } },
    },
    {
      id: 'G8 员工专用配置关闭 + 默认服务已禁用 → 员工回退同样明确失败',
      modelSettings: { enabled: false },
      settings: { defaultLLMService: 'svc-b', defaultModel: 'm-b1' },
      services: [fakeLlmService('svc-a', true, ['m-a1']), fakeLlmService('svc-b', false, ['m-b1'])],
      expectPatched: { outcome: 'threw', messageIncludes: 'service is disabled' },
      expectPristine: { outcome: 'resolved', result: { llmService: 'svc-a', model: 'm-a1' } },
    },
  ];

  const runOne = async (copy, scenario) => {
    const { AIManager } = stubs.requireFromStub(`./${copy}/dist/server/manager/ai-manager.js`);
    const { AIEmployeesManager } = stubs.requireFromStub(
      `./${copy}/dist/server/ai-employees/ai-employees-manager.js`,
    );
    const plugin = { app: {}, db: fakeDb({ settings: fakeSettings(scenario.settings), services: scenario.services }) };
    plugin.aiManager = new AIManager(plugin);
    plugin.aiManager.registerLLMProvider('openai', {
      title: 'OpenAI',
      provider: class Provider {
        isToolConflict() {
          return false;
        }
      },
    });
    const manager = new AIEmployeesManager(plugin);
    const employee = {
      username: 'emp-1',
      get: (key) => (key === 'modelSettings' ? scenario.modelSettings : undefined),
      modelSettings: scenario.modelSettings,
    };
    try {
      return { outcome: 'resolved', result: await manager.resolveModel(employee, scenario.explicit) };
    } catch (error) {
      return { outcome: 'threw', message: String(error.message) };
    }
  };

  const cases = [];
  for (const scenario of scenarios) {
    const patched = await runOne('patched', scenario);
    const pristine = await runOne('pristine', scenario);
    const matches = (observed, expected) =>
      observed.outcome === expected.outcome &&
      (expected.outcome === 'threw'
        ? String(observed.message ?? '').includes(expected.messageIncludes)
        : JSON.stringify(observed.result) === JSON.stringify(expected.result));
    cases.push({
      id: scenario.id,
      patched,
      pristine,
      ok: matches(patched, scenario.expectPatched) && matches(pristine, scenario.expectPristine),
      expectedPatched: scenario.expectPatched,
      expectedPristine: scenario.expectPristine,
    });
  }
  return cases;
}

/**
 * H 处：**尾链** —— 从 `resolveModel()` 的解析结果一路到真正创建 provider 的出站边界。
 *
 * 2.2.20 真实代码：`AIManager.getLLMService({ llmService, model })` 会按 `llmService`
 * 从 `llmServices` 取记录、查 provider、`new Provider({ serviceOptions, modelOptions })`。
 * 这里用真实 `AIManager`（原始 / 补丁后）+ 假 provider，断言 provider 收到的
 * `modelOptions` / `serviceOptions` 就是解析结果对应的那个服务 —— 证明默认值的**来源**。
 */
async function checkTailChain(stubs) {
  const runOne = async (copy, scenario) => {
    const { AIManager } = stubs.requireFromStub(`./${copy}/dist/server/manager/ai-manager.js`);
    const instantiations = [];
    class CapturingProvider {
      constructor(options) {
        instantiations.push(options);
      }
      isToolConflict() {
        return false;
      }
    }
    const plugin = {
      app: {},
      db: fakeDb({ settings: fakeSettings(scenario.settings), services: scenario.services }),
    };
    const manager = new AIManager(plugin);
    manager.registerLLMProvider('openai', { title: 'OpenAI', provider: CapturingProvider });
    let resolved;
    try {
      resolved = await manager.resolveModel();
    } catch (error) {
      return { resolved: null, threw: String(error.message), outbound: null };
    }
    const { provider, model, service } = await manager.getLLMService(resolved);
    // `toEnabledLLMService` 也会 `new Provider({ app })`（只为取 isToolConflict），
    // 出站边界只认带 `modelOptions` 的那次实例化。
    const outboundInstantiations = instantiations.filter((options) => options?.modelOptions);
    const first = outboundInstantiations[0];
    return {
      resolved,
      outbound: {
        providerCreated: outboundInstantiations.length,
        modelOptions: first?.modelOptions ?? null,
        serviceOptionsTag: first?.serviceOptions?.tag ?? null,
        returnedModel: model ?? null,
        returnedService: service?.name ?? null,
        providerIsInstance: provider instanceof CapturingProvider,
      },
    };
  };

  const scenario = (overrides) => ({
    services: [
      fakeLlmService('svc-a', true, ['m-a1'], 'tag-a'),
      fakeLlmService('svc-b', true, ['m-b1'], 'tag-b'),
      fakeLlmService('svc-c', true, ['m-c1'], 'tag-c'),
    ],
    ...overrides,
  });
  const scenarios = [
    {
      id: 'H1 默认已配置 → 出站 provider 收到的就是默认服务（不是第一个服务）',
      scenario: scenario({ settings: { defaultLLMService: 'svc-b', defaultModel: 'm-b1' } }),
      expectPatched: {
        resolved: { llmService: 'svc-b', model: 'm-b1' },
        outbound: {
          providerCreated: 1,
          modelOptions: { llmService: 'svc-b', model: 'm-b1' },
          serviceOptionsTag: 'tag-b',
          returnedModel: 'm-b1',
          returnedService: 'svc-b',
          providerIsInstance: true,
        },
      },
      expectPristine: {
        resolved: { llmService: 'svc-a', model: 'm-a1' },
        outbound: {
          providerCreated: 1,
          modelOptions: { llmService: 'svc-a', model: 'm-a1' },
          serviceOptionsTag: 'tag-a',
          returnedModel: 'm-a1',
          returnedService: 'svc-a',
          providerIsInstance: true,
        },
      },
    },
    {
      id: 'H2 默认未配置 → 出站仍是旧回退的第一个服务',
      scenario: scenario({ settings: null }),
      expectPatched: {
        resolved: { llmService: 'svc-a', model: 'm-a1' },
        outbound: {
          providerCreated: 1,
          modelOptions: { llmService: 'svc-a', model: 'm-a1' },
          serviceOptionsTag: 'tag-a',
          returnedModel: 'm-a1',
          returnedService: 'svc-a',
          providerIsInstance: true,
        },
      },
      expectPristine: {
        resolved: { llmService: 'svc-a', model: 'm-a1' },
        outbound: {
          providerCreated: 1,
          modelOptions: { llmService: 'svc-a', model: 'm-a1' },
          serviceOptionsTag: 'tag-a',
          returnedModel: 'm-a1',
          returnedService: 'svc-a',
          providerIsInstance: true,
        },
      },
    },
    {
      id: 'H3 默认服务已禁用 → 补丁后解析即失败，出站 provider 根本不会被创建（旧版会静默用首个服务）',
      scenario: scenario({ settings: { defaultLLMService: 'svc-b', defaultModel: 'm-b1' } }),
      mutate: (svc) => svc.map((item) => (item.name === 'svc-b' ? fakeLlmService('svc-b', false, ['m-b1'], 'tag-b') : item)),
      expectPatched: { resolved: null, threw: 'service is disabled', outbound: null },
      expectPristine: {
        resolved: { llmService: 'svc-a', model: 'm-a1' },
        outbound: {
          providerCreated: 1,
          modelOptions: { llmService: 'svc-a', model: 'm-a1' },
          serviceOptionsTag: 'tag-a',
          returnedModel: 'm-a1',
          returnedService: 'svc-a',
          providerIsInstance: true,
        },
      },
    },
  ];

  const cases = [];
  for (const item of scenarios) {
    const prepared = item.mutate ? { ...item.scenario, services: item.mutate(item.scenario.services) } : item.scenario;
    const patched = await runOne('patched', prepared);
    const pristine = await runOne('pristine', prepared);
    const matches = (observed, expected) => {
      if (expected.resolved === null) return observed.resolved === null && String(observed.threw ?? '').includes(expected.threw);
      return (
        JSON.stringify(observed.resolved) === JSON.stringify(expected.resolved) &&
        JSON.stringify(observed.outbound) === JSON.stringify(expected.outbound)
      );
    };
    cases.push({
      id: item.id,
      patched,
      pristine,
      ok: matches(patched, item.expectPatched) && matches(pristine, item.expectPristine),
      expectedPatched: item.expectPatched,
      expectedPristine: item.expectPristine,
    });
  }
  return cases;
}

/**
 * I 处：**生命周期 / 设置更新边界**（真实 `AIManager`，可变设置与读取计数）。
 *
 * 已批准规则：更改默认只影响之后**新开始**的调用，不中途改变正在执行的任务。
 * 这里用真实方法验证：每次调用都重新读设置；已解析的结果是一个不再变化的快照，
 * 后续设置更新不会改写它；设置改成失效时新调用明确失败，而已持有结果的调用仍可用。
 */
async function checkLifecycle(stubs) {
  const { AIManager } = stubs.requireFromStub('./patched/dist/server/manager/ai-manager.js');
  const services = [
    fakeLlmService('svc-a', true, ['m-a1'], 'tag-a'),
    fakeLlmService('svc-b', true, ['m-b1'], 'tag-b'),
    fakeLlmService('svc-c', true, ['m-c1'], 'tag-c'),
  ];
  let raw = { defaultLLMService: 'svc-b', defaultModel: 'm-b1' };
  let settingsReads = 0;
  const plugin = {
    app: {},
    db: {
      getRepository(name) {
        if (name === 'aiSettings') {
          return {
            findOne: async () => {
              settingsReads += 1;
              return fakeSettings(raw);
            },
          };
        }
        if (name === 'llmServices') {
          return {
            find: async () => services,
            findOne: async ({ filter } = {}) => services.find((item) => item.name === filter?.name) ?? null,
          };
        }
        return { findOne: async () => null, find: async () => [] };
      },
    },
  };
  const manager = new AIManager(plugin);
  manager.registerLLMProvider('openai', {
    title: 'OpenAI',
    provider: class Provider {
      isToolConflict() {
        return false;
      }
    },
  });
  const cases = [];
  const push = (id, observed, expected) =>
    cases.push({ id, observed, expected, ok: JSON.stringify(observed) === JSON.stringify(expected) });

  // I1：已开始的调用持有快照；设置更新只影响下一次调用；每次调用都重新读设置。
  const inflight = await manager.resolveModel();
  raw = { defaultLLMService: 'svc-c', defaultModel: 'm-c1' };
  const nextCall = await manager.resolveModel();
  const inflightBound = await manager.getLLMService(inflight);
  push(
    'I1 设置更新只影响新调用：已解析快照不变，新调用用新默认，每次调用都重新读设置',
    { inflight, nextCall, inflightStillBoundTo: inflightBound.service?.name ?? null, settingsReads },
    { inflight: { llmService: 'svc-b', model: 'm-b1' }, nextCall: { llmService: 'svc-c', model: 'm-c1' }, inflightStillBoundTo: 'svc-b', settingsReads: 2 },
  );

  // I2：设置改成失效 → 新调用明确失败；已持有结果的调用仍按其结果出站。
  raw = { defaultLLMService: 'svc-x', defaultModel: 'm-x' };
  let failed = null;
  try {
    await manager.resolveModel();
  } catch (error) {
    failed = String(error.message);
  }
  const stillBound = await manager.getLLMService(nextCall);
  push(
    'I2 设置改成失效：新调用明确失败且不静默切换；已开始的调用仍按已解析结果出站',
    { newCallThrew: failed, inflightStillBoundTo: stillBound.service?.name ?? null },
    { newCallThrew: 'Default LLM service "svc-x" is not available: service not found', inflightStillBoundTo: 'svc-c' },
  );

  // I3：清空默认 → 新调用恢复"旧第一个服务"回退（不是报错，也不残留旧默认）。
  raw = { defaultLLMService: null, defaultModel: null };
  const afterClear = await manager.resolveModel();
  push(
    'I3 清空默认：新调用恢复旧回退（第一个有启用模型的服务首模型）',
    { afterClear },
    { afterClear: { llmService: 'svc-a', model: 'm-a1' } },
  );

  return cases;
}

/**
 * J 处：`pm.get("ai")` 的**加载顺序 / 已安装但停用**边界。
 *
 * 事实（源码证据，非推断）：
 *  - `dist/server/workflow/nodes/llm/index.js` 在 `plugin-ai` 自己的包内；
 *  - `plugin-ai/dist/server/plugin.js` 的 `load()` 里才 `workflow.registerInstruction("llm", LLMInstruction)`。
 * 因此"补丁新增的 `pm.get("ai")` 取不到 ai 插件"要求：ai 插件没加载，但它自己注册的 llm 节点仍在跑
 * —— 2.2.20 不支持这种生命周期状态（原 `getLLMProvider` 本身就无条件 `pm.get("ai")`）。
 * 本组据此**不新增防御**（避免广泛防御）；这里把该分支的实际行为如实记录下来。
 */
async function checkPluginBoundary(stubs) {
  const runOne = async (copy) => {
    const { LLMInstruction } = stubs.requireFromStub(`./${copy}/dist/server/workflow/nodes/llm/index.js`);
    const workflow = {
      app: { pm: { get: () => undefined } },
      db: { getRepository: () => ({ findOne: async () => null, find: async () => [] }) },
      resume() {},
    };
    const instance = new LLMInstruction({ workflow });
    const processor = {
      getParsedValue: () => ({ messages: [], llmService: undefined }),
      execution: { id: 7 },
      saveJob: () => ({ id: 1 }),
      createBackgroundAbortHandle: () => ({ signal: undefined, throwIfAborted() {} }),
      logger: { error() {} },
      findPendingJob: async () => null,
    };
    try {
      const outcome = await instance.run({ id: 1, key: 'k', config: { messages: [] } }, { id: null }, processor);
      // run() 内部 catch 住了 provider 解析异常并转成 JOB_STATUS.ERROR + e.message。
      return { threw: false, status: outcome?.status ?? null, result: outcome?.result ?? null };
    } catch (error) {
      return { threw: true, name: error.name, message: String(error.message) };
    }
  };
  const patched = await runOne('patched');
  const pristine = await runOne('pristine');
  return [
    {
      id: 'J1 ai 插件缺失（pm.get("ai") 为 undefined）：补丁分支得到 TypeError 文案，未做防御；原版得到 invalid llm service',
      patched,
      pristine,
      ok:
        String(patched.result ?? '').includes('aiManager') &&
        String(pristine.result ?? '') === 'invalid llm service',
      note: '该状态在 2.2.20 不可达：llm instruction 由 plugin-ai 自身 load() 注册（见 sourceEvidence.llmRegistration）；不因此新增广泛防御。',
    },
  ];
}


/**
 * K 处：**B 的真实下游链** —— 不替换 `getLLMProvider`，让真实的
 * `LLMInstruction.getLLMProvider()` 自己读 `llmServices` 仓库、查**真实 AIManager 的 provider 注册表**，
 * 并在 provider 构造函数处捕获入参。这样证明的是"节点 → 真实 AIManager 注册表 → provider 边界"，
 * 而不是自写捕获替身。
 */
async function checkLlmNodeRealChain(stubs) {
  const services = [
    fakeLlmService('svc-a', true, ['m-a1'], 'tag-a'),
    fakeLlmService('svc-b', true, ['m-b1'], 'tag-b'),
    fakeLlmService('svc-c', true, ['m-c1'], 'tag-c'),
  ];
  const runOne = async (copy, { config, settings }) => {
    const { LLMInstruction } = stubs.requireFromStub(`./${copy}/dist/server/workflow/nodes/llm/index.js`);
    const { AIManager } = stubs.requireFromStub(`./${copy}/dist/server/manager/ai-manager.js`);
    const instantiations = [];
    class CapturingProvider {
      constructor(options) {
        if (options?.modelOptions) instantiations.push(options);
      }
      isToolConflict() {
        return false;
      }
      invoke() {
        return new Promise(() => {}); // 停在出站边界：不真正外呼
      }
    }
    const plugin = { app: {}, db: fakeDb({ settings: fakeSettings(settings), services }) };
    plugin.aiManager = new AIManager(plugin);
    plugin.aiManager.registerLLMProvider('openai', { title: 'OpenAI', provider: CapturingProvider });
    const workflow = {
      app: { pm: { get: (name) => (name === 'ai' ? plugin : undefined) } },
      db: fakeDb({ settings: fakeSettings(settings), services }),
      resume() {},
    };
    const instance = new LLMInstruction({ workflow });
    const processor = {
      getParsedValue: () => config,
      execution: { id: 7 },
      saveJob: () => ({ id: 1 }),
      createBackgroundAbortHandle: () => ({ signal: undefined, throwIfAborted() {} }),
      logger: { error() {}, trace() {} },
      findPendingJob: async () => null,
      exit: () => ({ status: 'pending-at-outbound-boundary' }),
    };
    const result = await instance.run({ id: 1, key: 'k', config }, { id: null }, processor);
    return {
      status: result?.status ?? null,
      errorResult: typeof result?.result === 'string' ? result.result : null,
      providerCreated: instantiations.length,
      modelOptions: instantiations[0]?.modelOptions ?? null,
      serviceTag: instantiations[0]?.serviceOptions?.tag ?? null,
    };
  };
  const scenarios = [
    {
      id: 'K1 节点未指定服务 → 真实 getLLMProvider 用默认服务建 provider（原始版拿不到服务）',
      config: { messages: [], llmService: undefined },
      settings: { defaultLLMService: 'svc-b', defaultModel: 'm-b1' },
      expectPatched: { providerCreated: 1, modelOptions: { model: 'm-b1' }, serviceTag: 'tag-b' },
      expectPristine: { providerCreated: 0, errorResult: 'invalid llm service' },
    },
    {
      id: 'K2 节点显式服务+模型 → 真实 getLLMProvider 按显式建 provider（两版一致）',
      config: { messages: [], llmService: 'svc-c', model: 'm-c1' },
      settings: { defaultLLMService: 'svc-b', defaultModel: 'm-b1' },
      expectPatched: { providerCreated: 1, modelOptions: { model: 'm-c1' }, serviceTag: 'tag-c' },
      expectPristine: { providerCreated: 1, modelOptions: { model: 'm-c1' }, serviceTag: 'tag-c' },
    },
  ];
  const cases = [];
  for (const scenario of scenarios) {
    const patched = await runOne('patched', scenario);
    const pristine = await runOne('pristine', scenario);
    const matches = (observed, expected) =>
      Object.entries(expected).every(([key, value]) => JSON.stringify(observed[key]) === JSON.stringify(value));
    cases.push({ id: scenario.id, patched, pristine, expectedPatched: scenario.expectPatched, expectedPristine: scenario.expectPristine, ok: matches(patched, scenario.expectPatched) && matches(pristine, scenario.expectPristine) });
  }
  return cases;
}

/**
 * L 处：**C 的真实下游链** —— 真实 `tool.invoke` → 真实 `SubAgentsDispatcher.run`（不替换）→
 * 真实 `AIEmployeesManager.resolveModel` → 真实 `AIManager.resolveModel` → 真实 `AIEmployee` →
 * 真实 `buildChatContext` → 真实 `AIManager.getLLMService` → provider 边界。
 *
 * 在 provider 构造函数处停止（`invoke()` 返回永挂起的 Promise）；边界之后的 `initSession` 需要更多
 * 框架件（`plugin.toolsManager` 等），所以会抛错 —— 那是**边界之后**的框架装载缺口，如实记录。
 */
async function checkSubAgentRealChain(stubs) {
  const services = [
    fakeLlmService('svc-a', true, ['m-a1'], 'tag-a'),
    fakeLlmService('svc-b', true, ['m-b1'], 'tag-b'),
    fakeLlmService('svc-c', true, ['m-c1'], 'tag-c'),
  ];
  const runOne = async (copy, { settings, employeeModelSettings, explicitModel }) => {
    const { AIManager } = stubs.requireFromStub(`./${copy}/dist/server/manager/ai-manager.js`);
    const { AIEmployeesManager } = stubs.requireFromStub(`./${copy}/dist/server/ai-employees/ai-employees-manager.js`);
    const { SubAgentsDispatcher } = stubs.requireFromStub(`./${copy}/dist/server/ai-employees/sub-agents/dispatcher.js`);
    const tool = stubs.requireFromStub(`./${copy}/dist/ai/tools/sub-agents/dispatch-sub-agent-task.js`).default;
    const instantiations = [];
    class CapturingProvider {
      constructor(options) {
        if (options?.modelOptions) instantiations.push(options);
      }
      isToolConflict() {
        return false;
      }
      resolveTools(tools) {
        return tools;
      }
      createModel() {
        throw new Error('SENTINEL-AFTER-PROVIDER');
      }
      invoke() {
        return new Promise(() => {});
      }
      async stream() {
        return { stream: null };
      }
    }
    const employee = {
      username: 'emp-1',
      modelSettings: employeeModelSettings,
      chatSettings: {},
      get(key) {
        return { username: 'emp-1', modelSettings: employeeModelSettings, chatSettings: {}, toJSON: () => ({ username: 'emp-1' }) }[key];
      },
      toJSON() {
        return { username: 'emp-1' };
      },
    };
    const db = {
      getRepository(name) {
        if (name === 'aiSettings') return { findOne: async () => fakeSettings(settings) };
        if (name === 'llmServices') return { find: async () => services, findOne: async ({ filter } = {}) => services.find((s) => s.name === filter?.name) ?? null };
        if (name === 'aiEmployees') return { findOne: async () => employee, find: async () => [employee] };
        if (name === 'aiConversations') return { findOne: async () => ({ options: {}, update: async () => {} }), update: async () => [0] };
        switch (name) {
          case 'aiMessages':
          case 'aiToolMessages':
          case 'aiFiles':
            return { find: async () => [], findOne: async () => null, findAll: async () => [], count: async () => 0, update: async () => [0], create: async () => ({}) };
          default:
            return { find: async () => [], findOne: async () => null, findAll: async () => [], count: async () => 0, update: async () => [0], create: async () => ({}) };
        }
      },
      sequelize: { transaction: async (fn) => fn(null) },
    };
    const plugin = { app: { db }, db, logger: { warn() {}, error() {}, info() {} } };
    plugin.aiManager = new AIManager(plugin);
    plugin.aiManager.registerLLMProvider('openai', { title: 'OpenAI', provider: CapturingProvider });
    plugin.aiEmployeesManager = new AIEmployeesManager(plugin);
    plugin.llmStreamCachedManager = { getCached: () => ({ append: async () => {}, clear: async () => {} }) };
    plugin.builtInManager = { setupBuiltInInfo() {} };
    plugin.features = { isFeaturesEnabled: () => false };
    plugin.aiConversationsManager = {
      resolveSubAgentConversation: async () => null,
      create: async () => ({ sessionId: 'sub-1' }),
      getUserDecisions: async () => null,
    };
    plugin.subAgentsDispatcher = new SubAgentsDispatcher(plugin);

    const ctx = {
      app: { db, pm: { get: (name) => (name === 'ai' ? plugin : undefined) } },
      db,
      log: { error() {}, warn() {}, info() {} },
      logger: { error() {}, warn() {}, info() {} },
      auth: { user: { id: 1 } },
      state: { currentRoles: ['root'] },
      action: { params: { values: { sessionId: 'sess-1', ...(explicitModel ? { model: explicitModel } : {}) } } },
      t: (key) => key,
      throw(status, message) {
        throw new Error(`${status}:${message}`);
      },
    };
    let thrown = null;
    try {
      await tool.invoke(ctx, { username: 'emp-1', question: 'q' }, { toolCallId: 'tc-1', writer: null });
    } catch (error) {
      thrown = String(error.message).slice(0, 120);
    }
    return {
      providerCreated: instantiations.length,
      modelOptions: instantiations[0]?.modelOptions ?? null,
      serviceTag: instantiations[0]?.serviceOptions?.tag ?? null,
      postBoundaryError: thrown,
    };
  };

  const scenarios = [
    {
      id: 'L1 员工专用配置关闭+遗留扁平字段、无显式 → 真实 dispatcher/EmployeeManager 回退公共默认（原始版用遗留字段）',
      settings: { defaultLLMService: 'svc-b', defaultModel: 'm-b1' },
      employeeModelSettings: { enabled: false, llmService: 'svc-c', model: 'm-c1' },
      expectPatched: { providerCreated: 1, serviceTag: 'tag-b', modelOptions: { llmService: 'svc-b', model: 'm-b1' } },
      expectPristine: { providerCreated: 1, serviceTag: 'tag-c', modelOptions: { llmService: 'svc-c', model: 'm-c1' } },
    },
    {
      id: 'L2 调用方合法普通显式 {llmService,model}（员工配置关闭、遗留扁平字段）→ 真实链一路到 provider 且显式生效',
      settings: { defaultLLMService: 'svc-b', defaultModel: 'm-b1' },
      employeeModelSettings: { enabled: false, llmService: 'svc-c', model: 'm-c1' },
      explicitModel: { llmService: 'svc-a', model: 'm-a1' },
      expectPatched: { providerCreated: 1, serviceTag: 'tag-a', modelOptions: { llmService: 'svc-a', model: 'm-a1' } },
      expectPristine: { providerCreated: 1, serviceTag: 'tag-a', modelOptions: { llmService: 'svc-a', model: 'm-a1' } },
    },
    {
      id: 'L3 实际失败场景：默认服务已禁用且员工配置关闭 → 候选明确失败、provider 不创建；原始版静默用遗留字段',
      settings: { defaultLLMService: 'svc-b', defaultModel: 'm-b1' },
      disabledService: true,
      employeeModelSettings: { enabled: false, llmService: 'svc-c', model: 'm-c1' },
      expectPatched: { providerCreated: 0 },
      expectPristine: { providerCreated: 1, serviceTag: 'tag-c' },
    },
  ];

  const cases = [];
  for (const scenario of scenarios) {
    const prepared = { ...scenario };
    if (scenario.disabledService) {
      // 让 svc-b 变成禁用（真实 resolveDefaultModel 会明确失败）
      const original = services.findIndex((s) => s.name === 'svc-b');
      services[original] = fakeLlmService('svc-b', false, ['m-b1'], 'tag-b');
    }
    const patched = await runOne('patched', prepared);
    const pristine = await runOne('pristine', prepared);
    if (scenario.disabledService) services[services.findIndex((s) => s.name === 'svc-b')] = fakeLlmService('svc-b', true, ['m-b1'], 'tag-b');
    const matches = (observed, expected) => Object.entries(expected).every(([key, value]) => JSON.stringify(observed[key]) === JSON.stringify(value));
    cases.push({ id: scenario.id, patched, pristine, expectedPatched: scenario.expectPatched, expectedPristine: scenario.expectPristine, ok: matches(patched, scenario.expectPatched) && matches(pristine, scenario.expectPristine) });
  }
  return cases;
}

/**
 * M 处：`aiSettings` 的**真实 get/update/publicGet**（2.2.20 发布产物）+ 保存后交给真实 `AIManager` 选型。
 * 证明 `defaultLLMService` / `defaultModel` 是**原生已存在的持久字段载体**，不是我们自加的约定。
 */
async function checkAiSettingsPersistence(stubs) {
  const { aiSettings } = stubs.requireFromStub('./patched/dist/server/resource/aiSettings.js');
  const cases = [];
  const makeStore = (initial = { options: { storage: 'local' } }) => {
    const state = { options: { ...initial.options }, defaultLLMService: initial.defaultLLMService, defaultModel: initial.defaultModel };
    const model = {
      get(key) {
        return state[key];
      },
      // 真实模型同时支持 `settings.options` 直属性读取（publicGet 就是这么读的）
      get options() {
        return state.options;
      },
      get defaultLLMService() {
        return state.defaultLLMService;
      },
      get defaultModel() {
        return state.defaultModel;
      },
      async update(data) {
        if (data.options !== undefined) state.options = data.options;
        if (data.defaultLLMService !== undefined) state.defaultLLMService = data.defaultLLMService;
        if (data.defaultModel !== undefined) state.defaultModel = data.defaultModel;
      },
      toJSON() {
        return { ...state };
      },
    };
    return { state, model };
  };
  const runAction = async (action, store, values) => {
    const ctx = {
      db: { getRepository: (name) => (name === 'aiSettings' ? { findOne: async () => store.model } : { findOne: async () => null }) },
      action: { params: { values } },
      body: null,
    };
    await aiSettings.actions[action](ctx, async () => {});
    return ctx.body;
  };
  const pushCase = (id, observed, expected) => cases.push({ id, observed, expected, ok: JSON.stringify(observed) === JSON.stringify(expected) });

  // M1：保存两个默认键 → get 读回；options.storage 保留
  {
    const store = makeStore();
    await runAction('update', store, { defaultLLMService: 'svc-b', defaultModel: 'm-b1' });
    const read = await runAction('get', store, {});
    pushCase('M1 真实 update 保存 defaultLLMService/defaultModel → 真实 get 读回，options.storage 保留', { read, stored: store.state }, { read: { storage: 'local', defaultLLMService: 'svc-b', defaultModel: 'm-b1' }, stored: { options: { storage: 'local' }, defaultLLMService: 'svc-b', defaultModel: 'm-b1' } });
  }
  // M2：只保存 defaultModel → defaultLLMService 不被清掉
  {
    const store = makeStore({ options: { storage: 'local' }, defaultLLMService: 'svc-b', defaultModel: 'm-b1' });
    await runAction('update', store, { defaultModel: 'm-b2' });
    const read = await runAction('get', store, {});
    pushCase('M2 只保存 defaultModel → defaultLLMService 保持不变（部分更新）', read, { storage: 'local', defaultLLMService: 'svc-b', defaultModel: 'm-b2' });
  }
  // M3：额外选项合并进 options，不覆盖默认键
  {
    const store = makeStore({ options: { storage: 'local' }, defaultLLMService: 'svc-b', defaultModel: 'm-b1' });
    await runAction('update', store, { storage: 's3', extraFlag: true });
    const read = await runAction('get', store, {});
    pushCase('M3 额外键合并进 options（storage 更新、默认键不动）', read, { storage: 's3', extraFlag: true, defaultLLMService: 'svc-b', defaultModel: 'm-b1' });
  }
  // M4：显式清空（null）→ 持久为 null，真实 resolveModel 回退旧首个服务
  {
    const store = makeStore({ options: { storage: 'local' }, defaultLLMService: 'svc-b', defaultModel: 'm-b1' });
    await runAction('update', store, { defaultLLMService: null, defaultModel: null });
    const read = await runAction('get', store, {});
    const { AIManager } = stubs.requireFromStub('./patched/dist/server/manager/ai-manager.js');
    const plugin = { app: {}, db: fakeDb({ settings: store.model, services: [fakeLlmService('svc-a', true, ['m-a1'], 'tag-a'), fakeLlmService('svc-b', true, ['m-b1'], 'tag-b')] }) };
    const manager = new AIManager(plugin);
    manager.registerLLMProvider('openai', { title: 'OpenAI', provider: class Provider { isToolConflict() { return false; } } });
    const resolved = await manager.resolveModel();
    pushCase('M4 保存后清空（null）→ 真实 resolveModel 回退旧首个服务（保存→读取→选型贯通）', { read, resolved }, { read: { storage: 'local', defaultLLMService: null, defaultModel: null }, resolved: { llmService: 'svc-a', model: 'm-a1' } });
  }
  // M5：保存合法默认 → 真实 resolveModel 用该默认
  {
    const store = makeStore();
    await runAction('update', store, { defaultLLMService: 'svc-b', defaultModel: 'm-b1' });
    const { AIManager } = stubs.requireFromStub('./patched/dist/server/manager/ai-manager.js');
    const plugin = { app: {}, db: fakeDb({ settings: store.model, services: [fakeLlmService('svc-a', true, ['m-a1'], 'tag-a'), fakeLlmService('svc-b', true, ['m-b1'], 'tag-b')] }) };
    const manager = new AIManager(plugin);
    manager.registerLLMProvider('openai', { title: 'OpenAI', provider: class Provider { isToolConflict() { return false; } } });
    pushCase('M5 真实保存合法默认 → 真实 resolveModel 选用保存的默认', await manager.resolveModel(), { llmService: 'svc-b', model: 'm-b1' });
  }
  // M6：publicGet 只回 storage，不泄漏默认键
  {
    const store = makeStore({ options: { storage: 'local' }, defaultLLMService: 'svc-b', defaultModel: 'm-b1' });
    const body = await runAction('publicGet', store, {});
    pushCase('M6 publicGet 只返回 storage（不泄漏默认服务/模型）', body, { storage: 'local' });
  }
  return cases;
}

async function runtimeCheck(pristineRoot, patchedRoot) {
  const pinned = ensurePinnedUtils();
  const stubs = prepareStubs(pristineRoot, patchedRoot);
  if (!stubs.ok) return stubs;
  const manager = await checkManager(stubs);
  const llmNode = await checkLlmNode(stubs);
  const subAgent = await checkSubAgent(stubs);
  const employees = await checkEmployees(stubs);
  const tailChain = await checkTailChain(stubs);
  const lifecycle = await checkLifecycle(stubs);
  const pluginBoundary = await checkPluginBoundary(stubs);
  const llmNodeRealChain = await checkLlmNodeRealChain(stubs);
  const subAgentRealChain = await checkSubAgentRealChain(stubs);
  const aiSettingsPersistence = await checkAiSettingsPersistence(stubs);
  const groups = { manager, llmNode, subAgent, employees, tailChain, lifecycle, pluginBoundary, llmNodeRealChain, subAgentRealChain, aiSettingsPersistence };
  return {
    ok: Object.values(groups).every((items) => items.every((item) => item.ok)),
    ...groups,
    deps: {
      depsRoot: frontendRoot,
      utils: String(
        JSON.parse(readFileSync(join(stubs.utilsTarget, 'package.json'), 'utf8')).version ?? '',
      ),
      utilsPath: stubs.utilsTarget,
      utilsTarball: utilsTarball,
      utilsTarballUrl: UTILS_TARBALL_URL,
      utilsTarballSha256: UTILS_TARBALL_SHA256,
      utilsProvision: pinned,
      resolved: stubs.resolvedDeps,
    },
    cases: Object.values(groups).flat(),
  };
}

/**
 * 静态**来源**证据：通用 LLM 节点属于自己的插件。
 * `@nocobase/plugin-ai` 的 `load()` 里才 `workflow.registerInstruction("llm", LLMInstruction)`，
 * 而 `LLMInstruction` 就在本包 `dist/server/workflow/nodes/llm/` 内。这解释 J1 的边界为何不可达，
 * 也是"不为 `pm.get('ai')` 加广泛防御"的依据。
 */
function registrationEvidence(pristineRoot) {
  const pluginJs = readFileSync(join(pristineRoot, 'package/dist/server/plugin.js'), 'utf8');
  const lines = pluginJs.split('\n');
  const hits = [];
  lines.forEach((line, index) => {
    if (line.includes('registerInstruction("llm"')) hits.push({ line: index + 1, text: line.trim() });
  });
  const loadLine = lines.findIndex((line) => /async load\(\)/.test(line)) + 1;
  const installLine = lines.findIndex((line) => /async install\(\)/.test(line)) + 1;
  const llmFile = 'package/dist/server/workflow/nodes/llm/index.js';
  return {
    package: '@nocobase/plugin-ai@2.2.20',
    llmFile,
    llmFileSha256: sha256(readFileSync(join(pristineRoot, llmFile))),
    pluginFile: 'package/dist/server/plugin.js',
    pluginFileSha256: sha256(readFileSync(join(pristineRoot, 'package/dist/server/plugin.js'))),
    registerInstructionHits: hits,
    loadStartsAtLine: loadLine,
    installStartsAtLine: installLine,
    registeredInsideLoad: hits.length === 1 && loadLine > 0 && hits[0].line > loadLine && (installLine === 0 || hits[0].line < installLine),
  };
}

async function main() {
  const summary = { generatedAt: new Date().toISOString(), tarball, tarballUrl: TARBALL_URL, steps: {} };

  if (!existsSync(tarball)) {
    console.error(`缺少 2.2.20 发布包缓存：${tarball}\n请从 ${TARBALL_URL} 下载并放到该路径。`);
    process.exitCode = 2;
    return;
  }
  const tarballHash = sha256(readFileSync(tarball));
  summary.tarballSha256 = tarballHash;
  summary.tarballSha256Matches = tarballHash === TARBALL_SHA256;
  if (!summary.tarballSha256Matches) {
    console.error(`发布包哈希不一致：期望 ${TARBALL_SHA256}，实际 ${tarballHash}`);
    process.exitCode = 1;
    return;
  }

  const { pristine, patched } = extractPristine();
  const pristineHashes = {};
  for (const rel of Object.values(FILES)) {
    pristineHashes[rel] = sha256(readFileSync(join(pristine, rel)));
  }
  summary.steps.pristineSha256 = pristineHashes;

  const anchorResults = applyAnchors(patched);
  summary.steps.anchors = anchorResults;
  const anchorsOk = anchorResults.every((item) => item.applied);
  if (!anchorsOk) {
    console.error(`锚点未全部命中：${JSON.stringify(anchorResults)}`);
    process.exitCode = 1;
    return;
  }

  const patchText = [...new Set(ANCHORS.map((anchor) => anchor.file))]
    .map((rel) => diffFor(rel, pristine, patched))
    .join('');
  writeFileSync(join(patchRoot, 'default-model-2.2.20.patch'), patchText);
  summary.steps.patchBytes = patchText.length;

  summary.steps.sourceEvidence = { llmRegistration: registrationEvidence(pristine) };

  const runtime = await runtimeCheck(pristine, patched);
  summary.steps.runtime = runtime;

  // 安装 / 回退脚本要用的机器可读清单：原始哈希（防错）+ 补丁后哈希（复核）+ 补丁哈希。
  const patchedHashes = {};
  for (const rel of Object.values(FILES)) {
    patchedHashes[rel] = sha256(readFileSync(join(patched, rel)));
  }
  const manifest = {
    generatedAt: summary.generatedAt,
    package: '@nocobase/plugin-ai@2.2.20',
    tarballUrl: TARBALL_URL,
    tarballSha256: TARBALL_SHA256,
    patchFile: 'default-model-2.2.20.patch',
    patchSha256: sha256(Buffer.from(patchText, 'utf8')),
    patchBytes: patchText.length,
    files: Object.fromEntries(
      Object.entries(FILES).map(([key, rel]) => [
        rel,
        {
          key,
          pristineSha256: pristineHashes[rel],
          patchedSha256: patchedHashes[rel],
        },
      ]),
    ),
  };
  writeFileSync(join(patchRoot, 'patch-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  summary.steps.manifest = { file: 'patch-manifest.json', patchedSha256: patchedHashes };

  writeFileSync(join(patchRoot, 'candidate-check.json'), `${JSON.stringify(summary, null, 2)}\n`);

  console.log(`2.2.20 发布包哈希：${summary.tarballSha256Matches ? '一致' : '不一致'}`);
  for (const [rel, hash] of Object.entries(pristineHashes)) console.log(`  ${hash}  ${rel}`);
  console.log(`锚点：${anchorResults.map((item) => `${item.id}=${item.hits}`).join(' ')}`);
  console.log(`补丁：${patchText.length} 字节 → default-model-2.2.20.patch（sha256 ${manifest.patchSha256.slice(0, 12)}…）`);
  const reg = summary.steps.sourceEvidence.llmRegistration;
  console.log(
    `来源证据：llm instruction 在 ${reg.pluginFile} 第 ${reg.registerInstructionHits[0]?.line ?? '?'} 行注册，位于 load()（第 ${reg.loadStartsAtLine} 行）与 install()（第 ${reg.installStartsAtLine} 行）之间 = ${reg.registeredInsideLoad}`,
  );
  if (!runtime.ok && runtime.reason) {
    console.log(`受控运行核对未通过：${runtime.reason}`);
  } else {
    const groups = [
      ['A 处 AIManager.resolveModel（8 条规则，真实类）', runtime.manager],
      ['B 处 通用 LLM 节点（原始 vs 补丁，真实 Instruction.run）', runtime.llmNode],
      ['C 处 子任务传参（原始 vs 补丁，真实 tool.invoke）', runtime.subAgent],
      ['G 处 原生 AIEmployeesManager.resolveModel（员工允许集/首选/显式，原始 vs 补丁）', runtime.employees],
      ['H 处 尾链 resolveModel → getLLMService → provider（真实类，原始 vs 补丁）', runtime.tailChain],
      ['I 处 生命周期 / 设置更新边界（真实类，可变设置 + 读取计数）', runtime.lifecycle],
      ['J 处 pm.get("ai") 加载边界（只记录，不加防御）', runtime.pluginBoundary],
      ['K 处 B 的真实下游链：LLMInstruction.getLLMProvider + 真实 AIManager 注册表', runtime.llmNodeRealChain],
      ['L 处 C 的真实下游链：tool → dispatcher → EmployeeManager → AIEmployee → getLLMService', runtime.subAgentRealChain],
      ['M 处 aiSettings 真实 get/update/publicGet 持久化 + 保存后选型', runtime.aiSettingsPersistence],
    ];
    for (const [title, items] of groups) {
      console.log(`  ${title}`);
      for (const item of items ?? []) {
        console.log(`    ${item.ok ? 'PASS' : 'FAIL'}  ${item.id}`);
        if (item.outcome) {
          console.log(
            `          ${item.outcome}${item.result ? ` ${JSON.stringify(item.result)}` : ''}${item.message ? ` ${item.message}` : ''}`,
          );
        } else if (item.observed) {
          console.log(`          observed : ${JSON.stringify(item.observed)}`);
          console.log(`          expected : ${JSON.stringify(item.expected)}`);
        } else {
          console.log(`          patched  : ${JSON.stringify(item.patched)}`);
          console.log(`          pristine : ${JSON.stringify(item.pristine)}`);
        }
      }
    }
  }
  console.log(
    `依赖 pin：@nocobase/utils=${runtime.deps?.utils}（${runtime.deps?.utilsPath}）`,
  );
  process.exitCode = summary.tarballSha256Matches && anchorsOk && runtime.ok ? 0 : 1;
}

await main();
