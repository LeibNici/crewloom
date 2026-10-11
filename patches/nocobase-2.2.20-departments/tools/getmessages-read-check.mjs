#!/usr/bin/env node
/**
 * 2.2.20 `aiConversations:getMessages` 的 mark-read 分支核对（**source-controlled，无真实 13000 请求**）。
 *
 * 目标（便宜但必要）：确认 2.2.20 里 `updateRead` 三种输入（缺参 / 'false' / 'true'）在
 * **真实原函数**下的行为 —— 是否调用 `aiConversationsRepo.update({values:{read:true}})`，以及调用次数。
 *
 * 被测真实产物：
 *  - `@nocobase/plugin-ai@2.2.20` `dist/server/resource/aiConversations.js`（action 层：
 *    `const updateRead = originalUpdateRead === "true" || originalUpdateRead === true;`）
 *  - `@nocobase/plugin-ai@2.2.20` `dist/server/ai-employees/ai-conversations.js`（manager 层：
 *    `if (updateRead) { await this.aiConversationsRepo.update({ values: { read: true }, filter: { sessionId } }); }`）
 *
 * 边界：`@nocobase/database` 用最小替身（Op/UniqueConstraintError 符号）、fake repo 只做端口；
 * **mark-read 的判断与调用**来自真实函数，不是复制逻辑。不连 13000/13080、不读真实会话内容。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const patchRoot = resolve(here, '..');
const aiTarball = process.env.NB_AI_2_2_20_TARBALL ?? resolve(patchRoot, '../nocobase-2.2.20/.cache/plugin-ai-2.2.20.tgz');
const lab = join(patchRoot, '.work/gmlab');
const modules = join(lab, 'node_modules');
const OUT = process.env.CL_GETMESSAGES_OUT ?? join(patchRoot, 'getmessages-read-check.json');
const depsRoot = '/Users/chenming/IdeaProjects/crewloom/frontend/node_modules/.pnpm';
const frontendRoot = '/Users/chenming/IdeaProjects/crewloom/frontend';

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}
function resolvePkg(name) {
  const hoisted = join(depsRoot, 'node_modules', name);
  if (existsSync(hoisted)) return hoisted;
  const flat = name.replace('/', '+');
  for (const entry of readdirSync(depsRoot)) {
    if (!entry.startsWith(`${flat}@`)) continue;
    const candidate = join(depsRoot, entry, 'node_modules', name);
    if (existsSync(candidate)) return candidate;
  }
  const direct = join(frontendRoot, 'node_modules', name);
  return existsSync(direct) ? direct : null;
}

const report = { generatedAt: new Date().toISOString(), source: {}, branches: [], ok: false };

rmSync(lab, { recursive: true, force: true });
mkdirSync(join(modules, '@nocobase/database'), { recursive: true });
const extract = join(lab, 'extract');
mkdirSync(extract, { recursive: true });
execFileSync('tar', ['-xzf', aiTarball, '-C', extract]);
cpSync(join(extract, 'package/dist'), join(lab, 'ai/dist'), { recursive: true });
writeFileSync(join(modules, '@nocobase/database', 'package.json'), '{"name":"@nocobase/database","version":"2.2.20-stub","main":"index.js"}\n');
writeFileSync(join(modules, '@nocobase/database', 'index.js'), 'module.exports = { Op: { ne: Symbol("ne"), in: Symbol("in"), notIn: Symbol("notIn") }, UniqueConstraintError: class UniqueConstraintError extends Error {} };\n');
// pin 的 @nocobase/utils@2.2.20（含其自身依赖农场）；缺失则退回本机已装版本
const pinnedUtils = resolve(patchRoot, '../nocobase-2.2.20/.cache/utils-2.2.20/package');
if (existsSync(join(pinnedUtils, 'package.json'))) {
  mkdirSync(join(modules, '@nocobase'), { recursive: true });
  symlinkSync(pinnedUtils, join(modules, '@nocobase/utils'));
} else {
  const real = resolvePkg('@nocobase/utils');
  if (real) { mkdirSync(join(modules, '@nocobase'), { recursive: true }); symlinkSync(real, join(modules, '@nocobase/utils')); }
}
for (const spec of ['lodash', 'dayjs', 'axios', 'zod', 'langchain']) {
  const real = resolvePkg(spec);
  if (real && !existsSync(join(modules, spec))) symlinkSync(real, join(modules, spec));
}

const requireFromLab = createRequire(join(lab, 'entry.cjs'));
const actionFile = join(lab, 'ai/dist/server/resource/aiConversations.js');
const managerFile = join(lab, 'ai/dist/server/ai-employees/ai-conversations.js');
report.source = {
  actionFile: 'node_modules/@nocobase/plugin-ai/dist/server/resource/aiConversations.js',
  actionSha256: sha256(readFileSync(actionFile)),
  managerFile: 'node_modules/@nocobase/plugin-ai/dist/server/ai-employees/ai-conversations.js',
  managerSha256: sha256(readFileSync(managerFile)),
  actionBranchSource: (readFileSync(actionFile, 'utf8').match(/const updateRead = [^;]+;/) ?? [null])[0],
  managerBranchSource: (readFileSync(managerFile, 'utf8').match(/if \(updateRead\) \{[\s\S]{0,140}?\}\)/) ?? [null])[0],
};

const { AIConversationsManager } = requireFromLab(managerFile);
const conversation = { sessionId: 'lab-session', userId: 1, options: {} };
const makePlugin = (counter) => {
  const repo = (name) => {
    if (name === 'aiConversations') {
      return {
        findOne: async () => conversation,
        find: async () => [conversation],
        count: async () => 1,
        update: async () => {
          counter.updates += 1;
          return [1];
        },
      };
    }
    if (name === 'aiConversations.messages') {
      return { find: async () => ({ rows: [], count: 0 }), count: async () => 0 };
    }
    return { find: async () => [], findOne: async () => null, count: async () => 0, update: async () => [0] };
  };
  return { db: { getRepository: repo }, app: {} };
};

const runBranch = async (label, updateReadParam) => {
  const counter = { updates: 0 };
  const plugin = makePlugin(counter);
  const manager = new AIConversationsManager(plugin);
  // action 层的分支表达式（与上面 actionBranchSource 完全一致）用来把 params 映射成传给 manager 的值；
  // 这里不改写被测 manager：直接按 action 层真实语义传入 updateRead。
  const updateRead = updateReadParam === 'true' || updateReadParam === true;
  const args = { userId: 1, sessionId: 'lab-session', cursor: undefined, paginate: false, updateRead };
  let thrown = null;
  try {
    await manager.getMessages(args);
  } catch (error) {
    thrown = String(error.message).slice(0, 120);
  }
  report.branches.push({ label, updateReadParam: updateReadParam === undefined ? '<missing>' : updateReadParam, computedUpdateRead: updateRead, repoUpdateCount: counter.updates, thrown });
  return counter.updates;
};

// manager 可能在构造时就把 repo 固定下来；若构造未设置，显式注入同一个 spy repo（端口注入，不改逻辑）
const c0 = { updates: 0 };
const mgr0 = new AIConversationsManager(makePlugin(c0));
if (!mgr0.aiConversationsRepo) {
  const patch = (counter) => {
    const m = new AIConversationsManager(makePlugin(counter));
    m.aiConversationsRepo = makePlugin(counter).db.getRepository('aiConversations');
    return m;
  };
  const run = async (label, param) => {
    const counter = { updates: 0 };
    const m = patch(counter);
    const updateRead = param === 'true' || param === true;
    let thrown = null;
    try { await m.getMessages({ userId: 1, sessionId: 'lab-session', paginate: false, updateRead }); } catch (e) { thrown = String(e.message).slice(0, 120); }
    report.branches.push({ label, updateReadParam: param === undefined ? '<missing>' : param, computedUpdateRead: updateRead, repoUpdateCount: counter.updates, thrown });
  };
  report.branches.length = 0;
  await run('缺参（missing）', undefined);
  await run("显式 'false'", 'false');
  await run("显式 'true'", 'true');
} else {
  await runBranch('缺参（missing）', undefined);
  await runBranch("显式 'false'", 'false');
  await runBranch("显式 'true'", 'true');
}

const byLabel = Object.fromEntries(report.branches.map((b) => [b.label, b]));
report.actual = {
  missingRepoUpdateCount: byLabel['缺参（missing）']?.repoUpdateCount ?? null,
  falseRepoUpdateCount: byLabel["显式 'false'"]?.repoUpdateCount ?? null,
  trueRepoUpdateCount: byLabel["显式 'true'"]?.repoUpdateCount ?? null,
};
report.ok =
  report.actual.missingRepoUpdateCount === 0 &&
  report.actual.falseRepoUpdateCount === 0 &&
  report.actual.trueRepoUpdateCount === 1;
writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
for (const branch of report.branches) console.log(`${branch.label}: computedUpdateRead=${branch.computedUpdateRead} repoUpdateCount=${branch.repoUpdateCount}${branch.thrown ? ` THREW ${branch.thrown}` : ''}`);
console.log(`action sha256=${report.source.actionSha256.slice(0, 12)}… manager sha256=${report.source.managerSha256.slice(0, 12)}…`);
console.log(`ok=${report.ok}`);
process.exitCode = report.ok ? 0 : 1;
