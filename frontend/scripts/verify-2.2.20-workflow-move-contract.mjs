#!/usr/bin/env node
/**
 * 目标实例固定 **2.2.20** 的 `flow_nodes:move` 真实合同核对（58 同路径相邻交换）。
 *
 * 背景：58 轮本机只拿到固定的 `2.2.22` 源码（`plugin-workflow`），真实后端是 `2.2.20`，
 * 因此 58 §8 把"2.2.20 与 2.2.22 是否有差异"列为未决。本脚本消除这个不确定性：
 *
 *  1. 下载并解包**已发布的 2.2.20 包** `@nocobase/plugin-workflow@2.2.20`（只读公开产物，不连实例）；
 *  2. 逐文件比对 2.2.20 与 2.2.22 的发布 `dist/`，给出真实差异清单（而不是"本地没缓存"）；
 *  3. 用 `vm` 加载 **2.2.20 包内的原始 `dist/server/actions/nodes.js`**（只替换它的三个外部依赖），
 *     直接调用发布产物里的真实 `move()`，在合成图上演一遍三条落位分支 + 参数/权限/前后序重连，
 *     并专门验证 58 依赖的"同路径相邻交换（落点 C 的 branchIndex 接管）"与往返可逆。
 *
 * 不是复制一份实现自证，也不是关键词推断，也不连接任何真实实例或运行真实后端。
 *
 * 用法：
 *   # 1) 准备发布产物（不写仓库；默认 /tmp/faf-wf-2.2.20）
 *   mkdir -p /tmp/faf-wf-2.2.20 && cd /tmp/faf-wf-2.2.20
 *   curl -sSLO "https://registry.npmjs.org/@nocobase/plugin-workflow/-/plugin-workflow-2.2.20.tgz"
 *   tar xzf plugin-workflow-2.2.20.tgz --strip-components=1
 *
 *   # 2) 运行核对（退出码 0 = 全部通过）
 *   node scripts/verify-2.2.20-workflow-move-contract.mjs [2.2.20 解包目录] [2.2.22 解包目录]
 *
 * 默认的 2.2.22 目录指向本仓库既有的固定副本
 * `experiments/native-reuse/node_modules/@nocobase/plugin-workflow`。
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const worktreeRoot = resolve(here, '..', '..');
const realRequire = createRequire(import.meta.url);

const DEFAULT_220 = '/tmp/faf-wf-2.2.20';
const DEFAULT_222 = resolve(
  worktreeRoot,
  '..',
  '..',
  'experiments/native-reuse/node_modules/@nocobase/plugin-workflow',
);

const PKG_220_RAW = resolve(process.env.CREWLOOM_NB_WF_2_2_20_DIR ?? process.argv[2] ?? DEFAULT_220);
const PKG_222_RAW = resolve(process.env.CREWLOOM_NB_WF_2_2_22_DIR ?? process.argv[3] ?? DEFAULT_222);
const PKG_220 = existsSync(PKG_220_RAW) ? realpathSync(PKG_220_RAW) : PKG_220_RAW;
const PKG_222 = existsSync(PKG_222_RAW) ? realpathSync(PKG_222_RAW) : PKG_222_RAW;

const OUT_DIR = resolve(worktreeRoot, 'docs/acceptance/full-pages-13000/page-contracts-evidence');
const OUT_FILE = join(OUT_DIR, 'workflow-move-2.2.20-contract.json');

const NODES_REL = 'dist/server/actions/nodes.js';
const ACTIONS_INDEX_REL = 'dist/server/actions/index.js';

const results = [];
const evidence = { generatedAt: new Date().toISOString(), packages: {}, differences: {}, checks: [], sourceFiles: [], failed: 0 };
let failed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
async function check(name, fn) {
  try {
    const note = await fn();
    results.push({ name, ok: true, note: note ?? '' });
    evidence.checks.push({ name, ok: true, note: note ?? '' });
    console.log(`PASS  ${name}${note ? ` — ${note}` : ''}`);
  } catch (error) {
    failed += 1;
    const note = String(error?.stack ?? error?.message ?? error).split('\n').slice(0, 4).join(' | ');
    results.push({ name, ok: false, note });
    evidence.checks.push({ name, ok: false, note });
    console.log(`FAIL  ${name} — ${note}`);
  }
}

function readPkgFile(base, rel, label) {
  const abs = join(base, rel);
  assert(existsSync(abs) && statSync(abs).isFile(), `缺少发布产物文件（${label}）：${abs}`);
  return readFileSync(abs, 'utf8');
}
function sha256(base, rel, label) {
  return createHash('sha256').update(readPkgFile(base, rel, label), 'utf8').digest('hex');
}
function pkgVersion(base, label) {
  const pkg = JSON.parse(readPkgFile(base, 'package.json', `${label} package.json`));
  return pkg.version;
}

const anyProxy = () =>
  new Proxy(function harnessProxy() {}, {
    get: (_target, key) => {
      if (key === 'then' || key === Symbol.toPrimitive || key === 'default') return undefined;
      return anyProxy();
    },
    apply: () => anyProxy(),
    construct: () => anyProxy(),
  });

/**
 * 发布包原始源码加载器：包内相对路径走真实文件，外部依赖走 `stubs`（命中）或中性替身。
 *
 * `nodes.js` 只 require 三个外部依赖：`@nocobase/actions`（取 repository）、
 * `@nocobase/database`（`Op.ne`）、以及相对 `..`（插件入口，`move` 用不到）。
 */
function makeLoader(stubs) {
  const cache = new Map();
  const load = (file) => {
    const abs = resolve(file);
    if (cache.has(abs)) return cache.get(abs);
    if (abs.endsWith('.json')) {
      const value = JSON.parse(readFileSync(abs, 'utf8'));
      cache.set(abs, value);
      return value;
    }
    const source = readFileSync(abs, 'utf8');
    const mod = { exports: {} };
    cache.set(abs, mod.exports);
    const factory = vm.runInThisContext(
      `(function (exports, require, module, __filename, __dirname) {\n${source}\n})`,
      { filename: abs },
    );
    factory(mod.exports, makeRequire(abs), mod, abs, dirname(abs));
    cache.set(abs, mod.exports);
    return mod.exports;
  };
  const makeRequire = (fromFile) => {
    const req = (specifier) => {
      if (Object.prototype.hasOwnProperty.call(stubs, specifier)) {
        const value = stubs[specifier];
        return typeof value === 'function' && value.__lazy ? value() : value;
      }
      if (
        specifier.startsWith('node:') ||
        ['fs', 'path', 'os', 'module', 'crypto', 'util', 'events', 'stream'].includes(specifier)
      ) {
        return realRequire(specifier);
      }
      if (specifier.startsWith('.')) {
        const base = resolve(dirname(fromFile), specifier);
        for (const candidate of [base, `${base}.js`, `${base}.json`, join(base, 'index.js')]) {
          if (existsSync(candidate) && statSync(candidate).isFile()) return load(candidate);
        }
        throw new Error(`无法解析发布包内相对依赖 ${specifier}（来自 ${fromFile}）`);
      }
      return anyProxy();
    };
    req.resolve = (specifier) => createRequire(fromFile).resolve(specifier);
    return req;
  };
  return { load };
}

/* ------------------------------------------------------------------ *
 * 合成图与真实 move() 的隔离调用
 * ------------------------------------------------------------------ */

/**
 * 000005 形状的合成图：入口 → 条件节点 → 三条处理路径，每条两步。
 *
 *   root → cond ─┬─ l1(seq1) → l2
 *                ├─ m1(seq2) → m2
 *                └─ r1(seq3) → r2
 */
function wideGraph() {
  const nodes = [
    { id: 'root', upstreamId: null, downstreamId: 'cond', branchIndex: null, workflowId: 'wf1', versionStats: { executed: 0 } },
    { id: 'cond', upstreamId: 'root', downstreamId: null, branchIndex: null, workflowId: 'wf1', versionStats: { executed: 0 } },
    { id: 'l1', upstreamId: 'cond', downstreamId: 'l2', branchIndex: 1, workflowId: 'wf1', versionStats: { executed: 0 } },
    { id: 'l2', upstreamId: 'l1', downstreamId: null, branchIndex: null, workflowId: 'wf1', versionStats: { executed: 0 } },
    { id: 'm1', upstreamId: 'cond', downstreamId: 'm2', branchIndex: 2, workflowId: 'wf1', versionStats: { executed: 0 } },
    { id: 'm2', upstreamId: 'm1', downstreamId: null, branchIndex: null, workflowId: 'wf1', versionStats: { executed: 0 } },
    { id: 'r1', upstreamId: 'cond', downstreamId: 'r2', branchIndex: 3, workflowId: 'wf1', versionStats: { executed: 0 } },
    { id: 'r2', upstreamId: 'r1', downstreamId: null, branchIndex: null, workflowId: 'wf1', versionStats: { executed: 0 } },
  ];
  return graph(nodes);
}

/** 线性链 root → a → b → c（全部 branchIndex null）。 */
function linearGraph() {
  const nodes = [
    { id: 'root', upstreamId: null, downstreamId: 'a', branchIndex: null, workflowId: 'wf1', versionStats: { executed: 0 } },
    { id: 'a', upstreamId: 'root', downstreamId: 'b', branchIndex: null, workflowId: 'wf1', versionStats: { executed: 0 } },
    { id: 'b', upstreamId: 'a', downstreamId: 'c', branchIndex: null, workflowId: 'wf1', versionStats: { executed: 0 } },
    { id: 'c', upstreamId: 'b', downstreamId: null, branchIndex: null, workflowId: 'wf1', versionStats: { executed: 0 } },
  ];
  return graph(nodes);
}

/**
 * 把节点数组包成真实 `move()` 需要的 ctx/repository。
 *
 * 只实现 `move()` 实际调用的部分：`repository.findOne(filterByTk|filter)`、
 * `instance.get()`（带 upstream/downstream 关联）、`instance.update()`、
 * `db.sequelize.transaction()`、`db.getCollection('workflows').model.update()`。
 */
function graph(nodes) {
  const byId = (id) => nodes.find((node) => String(node.id) === String(id)) ?? null;
  const touchLog = [];

  const view = (node) => {
    if (!node) return null;
    return {
      id: node.id,
      upstreamId: node.upstreamId ?? null,
      downstreamId: node.downstreamId ?? null,
      branchIndex: node.branchIndex ?? null,
      workflowId: node.workflowId,
      versionStats: node.versionStats,
      // 真实 `findOne` 带 `appends: ['workflow.versionStats']`：move 读 `instance.workflow.versionStats.executed`。
      workflow: { id: node.workflowId, versionStats: node.versionStats },
      get: () => ({
        upstream: node.upstreamId == null ? null : view(byId(node.upstreamId)),
        downstream: node.downstreamId == null ? null : view(byId(node.downstreamId)),
      }),
      update: async (values) => {
        Object.assign(node, values);
      },
    };
  };

  const repository = {
    async findOne(options = {}) {
      if (options.filterByTk !== undefined) return view(byId(options.filterByTk));
      const filter = options.filter ?? {};
      return view(
        nodes.find((node) => {
          if (!Object.prototype.hasOwnProperty.call(filter, 'upstreamId')) return false;
          if ((node.upstreamId ?? null) !== (filter.upstreamId ?? null)) return false;
          if (Object.prototype.hasOwnProperty.call(filter, 'branchIndex') && (node.branchIndex ?? null) !== filter.branchIndex) {
            return false;
          }
          if (filter.id && Object.prototype.hasOwnProperty.call(filter.id, 'ne')) return String(node.id) !== String(filter.id.ne);
          return true;
        }) ?? null,
      );
    },
  };

  const context = {
    db: {
      sequelize: { transaction: async (task) => task({ id: 'tx' }) },
      getCollection: () => ({ model: { update: async (values) => touchLog.push(values) } }),
    },
    state: { currentUser: { id: 1 } },
    action: { params: { filterByTk: undefined, values: {} } },
    throw: (status, message) => {
      const error = new Error(message);
      error.status = status;
      throw error;
    },
  };

  return {
    nodes,
    byId,
    view,
    repository,
    context,
    touchLog,
    setNode(id, values) {
      Object.assign(byId(id), values);
    },
    branchHeads() {
      return Object.fromEntries(
        nodes
          .filter((node) => node.branchIndex != null)
          .map((node) => [String(node.branchIndex), node.id]),
      );
    },
    chainFrom(id) {
      const chain = [];
      let current = byId(id);
      const guard = new Set();
      while (current && !guard.has(current.id)) {
        guard.add(current.id);
        chain.push(current.id);
        current = current.downstreamId == null ? null : byId(current.downstreamId);
      }
      return chain;
    },
    snapshot() {
      return nodes.map((node) => ({ ...node }));
    },
  };
}

async function invokeMove(move, graphObj, instanceId, values) {
  graphObj.context.action.params = { filterByTk: instanceId, values: values ?? {} };
  graphObj.context.__repository = graphObj.repository;
  let nextCalled = 0;
  await move(graphObj.context, async () => {
    nextCalled += 1;
  });
  return { nextCalled, body: graphObj.context.body };
}

async function expectThrows(move, graphObj, instanceId, values, expectedStatus, expectedMessage) {
  graphObj.context.action.params = { filterByTk: instanceId, values: values ?? {} };
  graphObj.context.__repository = graphObj.repository;
  try {
    await move(graphObj.context, async () => undefined);
  } catch (error) {
    assert(error.status === expectedStatus, `期望 ${expectedStatus}，实际 ${error.status}（${error.message}）`);
    assert(
      String(error.message).includes(expectedMessage),
      `期望错误信息包含「${expectedMessage}」，实际「${error.message}」`,
    );
    return `${expectedStatus} ${error.message}`;
  }
  throw new Error(`期望抛出 ${expectedStatus} ${expectedMessage}，但没有抛错`);
}

/* ------------------------------------------------------------------ *
 * 开始
 * ------------------------------------------------------------------ */

console.log(`2.2.20 发布产物：${PKG_220}`);
console.log(`2.2.22 发布产物：${PKG_222}`);

let move = null;
const stubs = {
  '@nocobase/actions': { utils: { getRepositoryFromParams: (context) => context.__repository } },
  '@nocobase/database': { Op: { ne: Symbol('Op.ne') } },
  '..': {},
};

await check('2.2.20 发布产物就位且版本号确实是 2.2.20', () => {
  const version = pkgVersion(PKG_220, '2.2.20');
  assert(version === '2.2.20', `package.json 版本应为 2.2.20，实际 ${version}`);
  evidence.packages['2.2.20'] = { dir: PKG_220, version };
  return `version=${version}`;
});

await check('2.2.22 固定副本就位且版本号是 2.2.22', () => {
  const version = pkgVersion(PKG_222, '2.2.22');
  assert(version === '2.2.22', `package.json 版本应为 2.2.22，实际 ${version}`);
  evidence.packages['2.2.22'] = { dir: PKG_222, version };
  return `version=${version}`;
});

await check('2.2.20 的 dist/server/actions/nodes.js 与 2.2.22 **逐字节相同**（move 所在文件）', () => {
  const a = sha256(PKG_220, NODES_REL, '2.2.20 nodes.js');
  const b = sha256(PKG_222, NODES_REL, '2.2.22 nodes.js');
  evidence.sourceFiles.push(
    { version: '2.2.20', path: join(PKG_220, NODES_REL), sha256: a },
    { version: '2.2.22', path: join(PKG_222, NODES_REL), sha256: b },
  );
  assert(a === b, `两个版本的 nodes.js 不一致：2.2.20=${a} 2.2.22=${b}`);
  return `sha256=${a}`;
});

await check('动作注册表 dist/server/actions/index.js 同样逐字节相同（flow_nodes:move 的注册与权限面不变）', () => {
  const a = sha256(PKG_220, ACTIONS_INDEX_REL, '2.2.20 actions/index.js');
  const b = sha256(PKG_222, ACTIONS_INDEX_REL, '2.2.22 actions/index.js');
  evidence.sourceFiles.push(
    { version: '2.2.20', path: join(PKG_220, ACTIONS_INDEX_REL), sha256: a },
    { version: '2.2.22', path: join(PKG_222, ACTIONS_INDEX_REL), sha256: b },
  );
  assert(a === b, `actions/index.js 不一致：2.2.20=${a} 2.2.22=${b}`);
  return `sha256=${a}`;
});

await check('整棵 dist/ 的差异清单：只有版本标记与随包 vendored 依赖的 package.json', () => {
  const walk = (base, dir, acc) => {
    for (const entry of readdirSync(join(base, dir), { withFileTypes: true })) {
      const rel = join(dir, entry.name);
      if (entry.isDirectory()) walk(base, rel, acc);
      else if (entry.isFile()) acc.push(rel);
    }
    return acc;
  };
  const distA = walk(PKG_220, 'dist', []).sort();
  const distB = walk(PKG_222, 'dist', []).sort();
  const onlyA = distA.filter((rel) => !distB.includes(rel));
  const onlyB = distB.filter((rel) => !distA.includes(rel));
  const differing = [];
  for (const rel of distA) {
    if (!distB.includes(rel)) continue;
    const a = readFileSync(join(PKG_220, rel));
    const b = readFileSync(join(PKG_222, rel));
    if (!a.equals(b)) differing.push(rel.split('/').join('/'));
  }
  evidence.differences = { totalFilesA: distA.length, totalFilesB: distB.length, onlyIn220: onlyA, onlyIn222: onlyB, differing };
  const relevant = differing.filter(
    (rel) => !rel.startsWith('dist/node_modules/') && !rel.endsWith('externalVersion.js'),
  );
  assert(onlyA.length === 0 && onlyB.length === 0, `两棵树文件集合不同：onlyA=${onlyA} onlyB=${onlyB}`);
  assert(relevant.length === 0, `除版本标记/vendored 依赖外仍有差异：${relevant.join(', ')}`);
  return `${distA.length} 个文件；差异 ${differing.length} 个：${differing.join(', ')}`;
});

await check('从 2.2.20 发布产物加载的 move 是真实函数（不是替身）', () => {
  const loader = makeLoader(stubs);
  const mod = loader.load(join(PKG_220, NODES_REL));
  move = mod.move;
  assert(typeof move === 'function', 'move 不是函数');
  // 真实产物里 move 是 async function；源码字符串应包含三条落位分支的判据。
  const source = move.toString();
  assert(source.includes('Node does not need to be moved'), 'move 源码缺少"同位置 400"判据');
  assert(source.includes('branchIndex'), 'move 源码缺少 branchIndex');
  evidence.sourceFiles.push({ version: '2.2.20', path: 'move.toString() 长度', sha256: String(source.length) });
  return `move.length=${source.length} 字符`;
});

await check('落点 C：同路径第二步上移到本路首位 → 新节点接管该 branchIndex，原首位成为它的下游', async () => {
  const g = wideGraph();
  const before = g.snapshot();
  const result = await invokeMove(move, g, 'm2', { upstreamId: 'cond', branchIndex: 2 });

  assert(g.byId('m2').upstreamId === 'cond', `m2.upstreamId 应为 cond，实际 ${g.byId('m2').upstreamId}`);
  assert(g.byId('m2').branchIndex === 2, `m2.branchIndex 应为 2，实际 ${g.byId('m2').branchIndex}`);
  assert(g.byId('m2').downstreamId === 'm1', `m2.downstreamId 应为 m1，实际 ${g.byId('m2').downstreamId}`);
  assert(g.byId('m1').upstreamId === 'm2', `m1.upstreamId 应为 m2，实际 ${g.byId('m1').upstreamId}`);
  assert(g.byId('m1').branchIndex === null, `m1.branchIndex 应清空，实际 ${g.byId('m1').branchIndex}`);
  // 左右两路与条件节点完全没动。
  for (const id of ['root', 'cond', 'l1', 'l2', 'r1', 'r2']) {
    assert(JSON.stringify(g.byId(id)) === JSON.stringify(before.find((n) => n.id === id)), `${id} 不应被这次 move 修改`);
  }
  assert(JSON.stringify(g.branchHeads()) === JSON.stringify({ 1: 'l1', 2: 'm2', 3: 'r1' }), `分支头应变为 1→l1 2→m2 3→r1，实际 ${JSON.stringify(g.branchHeads())}`);
  assert(JSON.stringify(g.chainFrom('m2')) === JSON.stringify(['m2', 'm1']), `路径 2 应为 m2→m1，实际 ${JSON.stringify(g.chainFrom('m2'))}`);
  assert(result.nextCalled === 1, 'move 之后必须继续 next()');
  g.context.action.params = { filterByTk: 'm1', values: { upstreamId: 'cond', branchIndex: 2 } };
  await invokeMove(move, g, 'm1', { upstreamId: 'cond', branchIndex: 2 });
  assert(JSON.stringify(g.chainFrom('m1')) === JSON.stringify(['m1', 'm2']), `再下移一次应还原，实际 ${JSON.stringify(g.chainFrom('m1'))}`);
  assert(JSON.stringify(g.branchHeads()) === JSON.stringify({ 1: 'l1', 2: 'm1', 3: 'r1' }), '往返后分支头应还原');
  return `路2链=${g.chainFrom('m1').join('→')} idx=2 左右路未动（往返可逆）`;
});

await check('落点 B：branchIndex=null → 插在 targetUpstream 与它当前下游之间（前后序重连）', async () => {
  const g = wideGraph();
  await invokeMove(move, g, 'm2', { upstreamId: 'l1', branchIndex: null });
  assert(g.byId('l1').downstreamId === 'm2', `l1.downstreamId 应为 m2，实际 ${g.byId('l1').downstreamId}`);
  assert(g.byId('m2').upstreamId === 'l1' && g.byId('m2').branchIndex === null, 'm2 应挂在 l1 下且 branchIndex 为 null');
  assert(g.byId('m2').downstreamId === 'l2' && g.byId('l2').upstreamId === 'm2', '原下游 l2 应改接到 m2 之后');
  assert(g.byId('m1').downstreamId === null, `摘出后 m1.downstreamId 应为 null，实际 ${g.byId('m1').downstreamId}`);
  return `链=${g.chainFrom('l1').join('→')}`;
});

await check('落点 A：upstreamId=null → 插到流程最前，原头节点成为它的下游；且 branchIndex 被强制为 null', async () => {
  const g = wideGraph();
  await invokeMove(move, g, 'm2', { upstreamId: null, branchIndex: 5 });
  assert(g.byId('m2').upstreamId === null, 'm2 应成为入口');
  assert(g.byId('m2').branchIndex === null, 'upstreamId=null 时必须强制 branchIndex=null');
  assert(g.byId('m2').downstreamId === 'root' && g.byId('root').upstreamId === 'm2', '原头 root 应成为 m2 的下游');
  assert(g.byId('m1').downstreamId === null, '摘出后 m1.downstreamId 应为 null');
  return `链=${g.chainFrom('m2').join('→')}`;
});

await check('前后序重连：被移动节点的旧下游继承它的 branchIndex（分支头让位）', async () => {
  const g = wideGraph();
  // m1 是路径首位（branchIndex=2），把它挪到左路 l1 之后（branchIndex=null 落点 B）。
  await invokeMove(move, g, 'm1', { upstreamId: 'l1', branchIndex: null });
  assert(g.byId('m2').upstreamId === 'cond' && g.byId('m2').branchIndex === 2, `m2 应继承序号 2 成为分支头，实际 ${JSON.stringify({ u: g.byId('m2').upstreamId, b: g.byId('m2').branchIndex })}`);
  assert(g.byId('l1').downstreamId === 'm1' && g.byId('m1').branchIndex === null, 'm1 应插到 l1 之后并清空 branchIndex');
  assert(JSON.stringify(g.chainFrom('l1')) === JSON.stringify(['l1', 'm1', 'l2']), `左路应为 l1→m1→l2，实际 ${JSON.stringify(g.chainFrom('l1'))}`);
  return `路2新头=m2/2 左路=${g.chainFrom('l1').join('→')}`;
});

await check('参数：branchIndex 非数字 → 400 "branchIndex must be a number"', async () => {
  const g = wideGraph();
  return expectThrows(move, g, 'm2', { upstreamId: 'cond', branchIndex: 'abc' }, 400, 'branchIndex must be a number');
});

await check('参数：同上游同序号（不需要移动）→ 400 "Node does not need to be moved"（不空成功）', async () => {
  const g = wideGraph();
  return expectThrows(move, g, 'm1', { upstreamId: 'cond', branchIndex: 2 }, 400, 'Node does not need to be moved');
});

await check('权限/结构：upstreamId 指向自己 → 400 "Invalid upstream node"', async () => {
  const g = wideGraph();
  return expectThrows(move, g, 'm2', { upstreamId: 'm2', branchIndex: 1 }, 400, 'Invalid upstream node');
});

await check('权限：已执行版本（versionStats.executed>0）→ 400 "Nodes in executed workflow could not be moved"', async () => {
  const g = wideGraph();
  g.setNode('m2', { versionStats: { executed: 1 } });
  return expectThrows(move, g, 'm2', { upstreamId: 'cond', branchIndex: 2 }, 400, 'Nodes in executed workflow could not be moved');
});

await check('结构：目标上游不存在 → 404 "Upstream node not found"', async () => {
  const g = wideGraph();
  return expectThrows(move, g, 'm2', { upstreamId: 'ghost', branchIndex: null }, 404, 'Upstream node not found');
});

await check('结构：跨流程上游 → 400 "Upstream node is not in the same workflow"', async () => {
  const g = wideGraph();
  g.setNode('cond', { workflowId: 'wf2' });
  return expectThrows(move, g, 'm2', { upstreamId: 'cond', branchIndex: 2 }, 400, 'Upstream node is not in the same workflow');
});

await check('线性链落点 B：root→a→b→c 把 c 移到 a 之后 → root→a→c→b', async () => {
  const g = linearGraph();
  await invokeMove(move, g, 'c', { upstreamId: 'a', branchIndex: null });
  assert(JSON.stringify(g.chainFrom('root')) === JSON.stringify(['root', 'a', 'c', 'b']), `链应为 root→a→c→b，实际 ${JSON.stringify(g.chainFrom('root'))}`);
  assert(g.byId('c').branchIndex === null && g.byId('b').upstreamId === 'c', '线性落点 branchIndex 必须为 null，b 接在 c 之后');
  return `链=${g.chainFrom('root').join('→')}`;
});

/* ------------------------------------------------------------------ *
 * 产出证据
 * ------------------------------------------------------------------ */

evidence.failed = failed;
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
console.log(`\n证据：${relative(worktreeRoot, OUT_FILE)}`);
console.log(`结果：${results.length - failed}/${results.length} 通过，失败 ${failed}`);
process.exit(failed === 0 ? 0 : 1);
