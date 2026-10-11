#!/usr/bin/env node
/**
 * 目标实例固定 **2.2.20** 的 `mainDataSource` / `dataSources` 主库刷新与物理表契约核对（DS-03）。
 *
 * 做法：下载并解包**已发布的 2.2.20 包**，用 `vm` 加载包内**原始文件**（只对 `require` 的
 * 外部依赖注入受控替身），然后**直接调用发布产物里的真实处理函数/方法**，断言：
 *  - 动作层需要哪些输入、什么时候触发副作用（`refresh` 不接收 values；`syncFields` 读 `values.collections`）；
 *  - `refresh → plugin.loadCollections()` 实际落到基类 `Plugin.loadCollections`，把
 *    `<插件包>/server/collections`（发布布局下是 `dist/server/collections`）重新 import 进运行中的应用，
 *    **不扫描物理表、不重建字段、不改业务数据**；
 *  - `MainDataSource.readTables()` 的返回形状是 `[{ name }]`（不是字符串数组）；
 *  - `MainDataSource.loadTables()` 写出 `collections` 记录（`from: 'dbsync'`、`underscored: false`）；
 *  - `MainDataSource.syncFieldsFromDatabase()` 的必需输入与副作用（删多余字段 + 带 fields 关联更新集合）。
 *
 * 不是复制一份实现自证，也不是"关键词没找到"的推断，也不连接任何真实实例。
 *
 * 用法：
 *   # 1) 只准备发布产物（不写仓库；默认目录 /tmp/fpc-2.2.20）
 *   mkdir -p /tmp/fpc-2.2.20 && cd /tmp/fpc-2.2.20
 *   for p in plugin-data-source-main server plugin-data-source-manager data-source-manager utils; do
 *     curl -sSLO "https://registry.npmjs.org/@nocobase/$p/-/$p-2.2.20.tgz"
 *     mkdir -p "x-$p" && tar xzf "$p-2.2.20.tgz" -C "x-$p" --strip-components=1
 *   done
 *   # data-source-manager / utils 的解包目录名分别是 x-data-source-manager、x-utils
 *   mv x-data-source-manager x-dsm 2>/dev/null || true
 *
 *   # 2) 运行核对（退出码 0 = 全部通过）
 *   node scripts/verify-2.2.20-main-data-source-contract.mjs [解包目录，默认 /tmp/fpc-2.2.20]
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const worktreeRoot = resolve(here, '..', '..');
const PKGS_RAW = resolve(process.env.CREWLOOM_NB_2_2_20_DIR ?? process.argv[2] ?? '/tmp/fpc-2.2.20');
// macOS 上 /tmp 是指向 /private/tmp 的符号链接：统一成真实路径，避免和 Node require.resolve 的结果比较失败。
const PKGS = existsSync(PKGS_RAW) ? realpathSync(PKGS_RAW) : PKGS_RAW;
const OUT_DIR = resolve(worktreeRoot, 'docs/acceptance/full-pages-13000/page-contracts-evidence');
const realRequire = createRequire(import.meta.url);

const P = {
  main: join(PKGS, 'x-plugin-data-source-main'),
  server: join(PKGS, 'x-server'),
  manager: join(PKGS, 'x-plugin-data-source-manager'),
  dsm: join(PKGS, 'x-dsm'),
  utils: join(PKGS, 'x-utils'),
};

const results = [];
let failed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
async function check(name, fn) {
  try {
    const note = await fn();
    results.push({ name, ok: true, note: note ?? '' });
    console.log(`PASS  ${name}${note ? ` — ${note}` : ''}`);
  } catch (error) {
    failed += 1;
    const note = String(error?.stack ?? error?.message ?? error).split('\n').slice(0, 4).join(' | ');
    results.push({ name, ok: false, note });
    console.log(`FAIL  ${name} — ${note}`);
  }
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

/** 发布包原始源码加载器：包内相对路径走真实文件，外部依赖走 `stubs` 或中性替身。 */
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
      if (specifier.startsWith('node:') || ['fs', 'path', 'os', 'module', 'crypto', 'util', 'events', 'stream'].includes(specifier)) {
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

function pkgFile(base, relative) {
  const abs = join(base, relative);
  if (!existsSync(abs)) throw new Error(`缺少发布产物文件 ${abs}`);
  return readFileSync(abs, 'utf8');
}
function sha256(base, relative) {
  return createHash('sha256').update(pkgFile(base, relative)).digest('hex');
}

const SOURCE_FILES = [
  ['plugin-data-source-main', P.main, 'dist/server/resourcers/main-data-source.js'],
  ['plugin-data-source-main', P.main, 'dist/server/server.js'],
  ['server', P.server, 'lib/plugin.js'],
  ['server', P.server, 'lib/main-data-source.js'],
  ['plugin-data-source-manager', P.manager, 'dist/server/actions/data-sources.js'],
];

/* ------------------------------------------------------------------ *
 * C1/C2 动作层：输入与触发条件（真实发布产物里的 actions）
 * ------------------------------------------------------------------ */
async function actionLayer() {
  const loader = makeLoader({});
  const descriptor = loader.load(join(P.main, 'dist/server/resourcers/main-data-source.js')).default;
  const actions = descriptor?.actions;
  assert(actions && typeof actions.refresh === 'function' && typeof actions.syncFields === 'function', 'mainDataSource 动作不是函数');

  // C1 refresh：loaded 时调用 plugin.loadCollections()，之后总是 next()。
  const refreshCalls = [];
  let nextCount = 0;
  const loadedCtx = {
    app: {
      pm: { get: (name) => ({ name, loadCollections: async () => refreshCalls.push('loadCollections') }) },
      dataSourceManager: { get: () => ({ status: 'loaded' }) },
    },
    action: { params: { values: { collections: ['should-be-ignored'] } } },
  };
  await actions.refresh(loadedCtx, async () => {
    nextCount += 1;
  });
  assert(refreshCalls.length === 1, `refresh(loaded) 应调用一次 loadCollections，实际 ${refreshCalls.length}`);
  assert(nextCount === 1, 'refresh 必须继续 next()');
  assert(loadedCtx.body === undefined, 'refresh 自己不改 ctx.body');

  // main 未 loaded：不触发 loadCollections（真实守卫），但仍 next()。
  const skipped = [];
  const notLoadedCtx = {
    app: {
      pm: { get: () => ({ loadCollections: async () => skipped.push('x') }) },
      dataSourceManager: { get: () => ({ status: 'reloading' }) },
    },
    action: { params: {} },
  };
  await actions.refresh(notLoadedCtx, async () => {
    nextCount += 1;
  });
  assert(skipped.length === 0, 'main 未 loaded 时不应调用 loadCollections');

  // C2 syncFields：把 values.collections 原样传给 MainDataSource.syncFieldsFromDatabase。
  const syncArgs = [];
  const syncCtx = {
    app: { dataSourceManager: { get: () => ({ status: 'loaded', syncFieldsFromDatabase: async (...args) => syncArgs.push(args) }) } },
    action: { params: { values: { collections: ['customers'] } } },
  };
  await actions.syncFields(syncCtx, async () => undefined);
  assert(syncArgs.length === 1, 'syncFields 应调用一次 syncFieldsFromDatabase');
  assert(syncArgs[0][0] === syncCtx, 'syncFields 必须把 ctx 传给 syncFieldsFromDatabase');
  assert(JSON.stringify(syncArgs[0][1]) === JSON.stringify(['customers']), 'values.collections 必须原样传递');

  const emptyCtx = {
    app: { dataSourceManager: { get: () => ({ status: 'loaded', syncFieldsFromDatabase: async (...args) => syncArgs.push(args) }) } },
    action: { params: {} },
  };
  await actions.syncFields(emptyCtx, async () => undefined);
  assert(syncArgs[1][1] === undefined, '没有 values 时 collections 应为 undefined（同步全部）');

  return `refresh 不接收 values（guard: main.status==='loaded'）；syncFields 读取 values.collections`;
}

/* ------------------------------------------------------------------ *
 * C3 refresh 深层：基类 Plugin.loadCollections + getPluginBasePath
 * ------------------------------------------------------------------ */
async function loadCollectionsChain() {
  // 让真实 require.resolve 能解析到解包目录（Node 会解析符号链接到真实路径）。
  const linkDir = join(P.utils, 'node_modules', '@nocobase');
  const link = join(linkDir, 'plugin-data-source-main');
  mkdirSync(linkDir, { recursive: true });
  if (!existsSync(link)) symlinkSync(P.main, link, 'dir');

  const loader = makeLoader({});
  const requireResolve = loader.load(join(P.utils, 'lib/requireModule.js')).requireResolve;
  const fsExists = loader.load(join(P.utils, 'lib/fs-exists.js')).fsExists;
  const fsExtra = { __esModule: true, default: { realpath: async (p) => realpathSync(p) }, realpath: async (p) => realpathSync(p) };
  const utilsStub = { requireResolve, fsExists };

  const pluginLoader = makeLoader({
    '@nocobase/utils': utilsStub,
    '@nocobase/utils/plugin-symlink': {},
    '@nocobase/ai': {},
    'fs-extra': fsExtra,
    './plugin-manager': {},
    './clientStaticUtils': {},
    './constants': {},
    './deps': {},
    './findPackageNames': {},
  });
  const { Plugin } = pluginLoader.load(join(P.server, 'lib/plugin.js'));
  assert(typeof Plugin === 'function', '没有从 2.2.20 加载到基类 Plugin');

  const imported = [];
  const logged = [];
  const plugin = Object.create(Plugin.prototype);
  plugin.options = { name: 'data-source-main', packageName: '@nocobase/plugin-data-source-main', enabled: true };
  plugin.app = {
    context: { reqId: 'harness' },
    log: {
      trace: (...args) => logged.push(args),
      debug: () => undefined,
      error: () => undefined,
      info: () => undefined,
      child: () => ({ trace: (...args) => logged.push(args), debug: () => undefined, error: () => undefined }),
    },
    db: { import: async (options) => imported.push(options) },
  };

  const basePath = await plugin.getPluginBasePath();
  assert(basePath === join(P.main, 'dist'), `getPluginBasePath 期望 <pkg>/dist，实际 ${basePath}`);

  const wrongDir = join(P.main, 'server', 'collections');
  const realDir = join(P.main, 'dist', 'server', 'collections');
  assert(!existsSync(wrongDir), `发布布局不应存在 ${wrongDir}`);
  assert(existsSync(realDir), `发布布局应存在 ${realDir}`);

  await plugin.loadCollections();
  assert(imported.length === 1, `loadCollections 应调用一次 db.import，实际 ${imported.length}`);
  assert(imported[0].directory === realDir, `db.import.directory 期望 ${realDir}，实际 ${imported[0].directory}`);
  assert(
    imported[0].from === '@nocobase/plugin-data-source-main',
    `db.import.from 期望包名，实际 ${imported[0].from}`,
  );

  return `refresh → Plugin.loadCollections → db.import(${realDir})；不读物理表、不改字段/数据`;
}

/* ------------------------------------------------------------------ *
 * C4 MainDataSource：readTables / loadTables / syncFieldsFromDatabase
 * ------------------------------------------------------------------ */
async function mainDataSourceMethods() {
  const dsmLoader = makeLoader({});
  const dsm = dsmLoader.load(join(P.dsm, 'lib/sequelize-data-source.js'));
  const serverLoader = makeLoader({ '@nocobase/data-source-manager': dsm });
  const { MainDataSource } = serverLoader.load(join(P.server, 'lib/main-data-source.js'));
  assert(typeof MainDataSource === 'function', '没有从 2.2.20 加载到 MainDataSource');

  const makeInstance = (db, introspector) => {
    const inst = Object.create(MainDataSource.prototype);
    inst.collectionManager = { db };
    inst.introspector = introspector;
    return inst;
  };

  // C4a readTables：库里尚未映射为集合的表 → [{ name }]
  const readDb = {
    collections: new Map([
      ['customers', { model: { tableName: 'customers' } }],
      ['orders', { model: { tableName: 'orders' } }],
    ]),
  };
  const introspector = {
    getTableList: async () => ['customers', 'orders', 'qa_physical_ledger'],
    getCollection: async ({ tableInfo }) => ({
      name: tableInfo.tableName,
      tableName: tableInfo.tableName,
      fields: [{ name: 'id', type: 'bigInt' }, { name: 'memo', type: 'string' }],
    }),
  };
  const reader = makeInstance(readDb, introspector);
  const tables = await reader.readTables();
  assert(
    JSON.stringify(tables) === JSON.stringify([{ name: 'qa_physical_ledger' }]),
    `readTables 形状期望 [{name:'qa_physical_ledger'}]，实际 ${JSON.stringify(tables)}`,
  );

  // C4b loadTables：把未纳管的物理表写成 collections 记录（from: 'dbsync'）
  const created = [];
  const loadDb = {
    options: {},
    collections: new Map([['customers', { model: { tableName: 'customers' } }]]),
    getRepository: () => ({ create: async (options) => created.push(options) }),
  };
  const loaderInst = makeInstance(loadDb, introspector);
  loaderInst.status = 'loaded';
  await loaderInst.loadTables({ auth: { user: { id: 1 } } }, ['qa_physical_ledger', 'customers']);
  assert(created.length === 1, `loadTables 应写一次 collections，实际 ${created.length}`);
  const written = created[0].values;
  assert(Array.isArray(written) && written.length === 1, 'loadTables 只应写未纳管的表');
  assert(written[0].name === 'qa_physical_ledger', `写入集合名错误：${written[0].name}`);
  assert(written[0].from === 'dbsync', `from 期望 dbsync，实际 ${written[0].from}`);
  assert(written[0].underscored === false, 'underscored 期望 false');
  assert(loaderInst.status === 'loaded', 'loadTables 结束后 status 应回到 loaded');

  // C4c syncFieldsFromDatabase：删物理表里没有的字段记录 + 带 fields 关联更新集合
  const destroyed = [];
  const updated = [];
  const loadedRows = [
    {
      name: 'customers',
      options: {},
      toJSON: () => ({ name: 'customers' }),
      fields: [
        { name: 'id', toJSON: () => ({ name: 'id', key: 'f-id' }) },
        { name: 'legacy', toJSON: () => ({ name: 'legacy', key: 'f-legacy' }) },
      ],
    },
    // dbsync 来源的集合不参与反向同步（真实实现里被过滤掉）。
    { name: 'loaded_from_db', options: { from: 'dbsync' }, toJSON: () => ({ name: 'loaded_from_db' }), fields: [] },
  ];
  const findFilters = [];
  const syncDb = {
    options: { schema: 'public' },
    sequelize: { transaction: async (fn) => fn('tx-1') },
    collections: new Map([['customers', { model: { tableName: 'customers' } }]]),
    getCollection: (name) => ({
      model: { tableName: name },
      getTableNameWithSchema: () => name,
      getField: (fieldName) => ({ columnName: () => `col_${fieldName}` }),
    }),
    getRepository: (name) =>
      name === 'collections'
        ? {
            find: async (options) => {
              findFilters.push(options);
              return loadedRows;
            },
            update: async (options) => updated.push(options),
          }
        : { destroy: async (options) => destroyed.push(options) },
  };
  const syncInst = makeInstance(syncDb, introspector);
  const ctx = { auth: { user: { id: 1 } }, log: { error: () => undefined } };
  await syncInst.syncFieldsFromDatabase(ctx, undefined);
  assert(
    JSON.stringify(findFilters[0].filter) === JSON.stringify({ hidden: false }),
    `无参同步的过滤条件期望 {hidden:false}，实际 ${JSON.stringify(findFilters[0].filter)}`,
  );
  assert(destroyed.length === 1, `应删除 1 个物理表没有的字段，实际 ${destroyed.length}`);
  assert(destroyed[0].filterByTk === 'f-legacy', `删除字段 key 期望 f-legacy，实际 ${destroyed[0].filterByTk}`);
  assert(destroyed[0].context === ctx, '字段删除必须带上 ctx');
  assert(destroyed[0].transaction === 'tx-1', '字段删除必须在事务里');
  assert(updated.length === 1, `应更新 1 个集合，实际 ${updated.length}`);
  assert(updated[0].filterByTk === 'customers', `更新父标识期望 customers，实际 ${updated[0].filterByTk}`);
  assert(
    JSON.stringify(updated[0].updateAssociationValues) === JSON.stringify(['fields']),
    '集合更新必须带 updateAssociationValues:[fields]',
  );
  assert(updated[0].context === ctx && updated[0].transaction === 'tx-1', '集合更新必须带 ctx 与事务');

  await syncInst.syncFieldsFromDatabase(ctx, ['customers']);
  assert(
    JSON.stringify(findFilters[1].filter) === JSON.stringify({ hidden: false, name: ['customers'] }),
    `带集合名同步的过滤条件期望 {hidden:false,name:['customers']}，实际 ${JSON.stringify(findFilters[1].filter)}`,
  );

  return `readTables=[{name}]；loadTables 写 from:'dbsync'；syncFields 删多余字段并带 fields 关联更新`;
}

/* ------------------------------------------------------------------ *
 * C5 dataSources:readTables / loadTables 动作层
 * ------------------------------------------------------------------ */
async function dataSourcesActions() {
  const loader = makeLoader({ '../utils': { mapDataSourceWithCollection: () => ({}) } });
  const actions = loader.load(join(P.manager, 'dist/server/actions/data-sources.js')).default;
  assert(typeof actions['dataSources:readTables'] === 'function', '缺少 dataSources:readTables');

  const readRow = { name: 'qa_physical_ledger' };
  const ctx = {
    action: { params: { values: { dataSourceKey: 'main' } } },
    app: { dataSourceManager: { dataSources: new Map([['main', { readTables: async () => [readRow] }]]) } },
  };
  await actions['dataSources:readTables'](ctx, async () => undefined);
  assert(JSON.stringify(ctx.body) === JSON.stringify([readRow]), `readTables body 应为 [{name}]，实际 ${JSON.stringify(ctx.body)}`);

  const missing = {
    action: { params: { values: { dataSourceKey: 'not_registered' } } },
    app: { dataSourceManager: { dataSources: new Map() } },
  };
  let threw = false;
  try {
    await actions['dataSources:readTables'](missing, async () => undefined);
  } catch {
    threw = true;
  }
  assert(threw, '未注册的数据源应抛错，不能静默返回空');

  const loadCalls = [];
  const loadCtx = {
    action: { params: { values: { dataSourceKey: 'main', tables: ['qa_physical_ledger'] } } },
    app: {
      dataSourceManager: {
        dataSources: new Map([['main', { loadTables: async (...args) => loadCalls.push(args) }]]),
      },
    },
  };
  await actions['dataSources:loadTables'](loadCtx, async () => undefined);
  assert(loadCalls.length === 1, 'loadTables 应调用一次 dataSource.loadTables');
  assert(JSON.stringify(loadCalls[0][1]) === JSON.stringify(['qa_physical_ledger']), 'loadTables 的表名数组应原样传递');

  return `dataSources:readTables 需 values.dataSourceKey（未注册即报错）；loadTables 需 dataSourceKey + tables[]`;
}

async function main() {
  for (const [name, base, relative] of SOURCE_FILES) {
    if (!existsSync(join(base, relative))) {
      console.error(`缺少 2.2.20 发布产物：${name} ${join(base, relative)}`);
      console.error('请先按脚本头部注释下载并解包到 CREWLOOM_NB_2_2_20_DIR（默认 /tmp/fpc-2.2.20）。');
      process.exit(2);
    }
  }

  await check('动作层：refresh 无输入/有 loaded 守卫；syncFields 读 values.collections', actionLayer);
  await check('refresh 深层：基类 Plugin.loadCollections 的输入与副作用', loadCollectionsChain);
  await check('MainDataSource：readTables/loadTables/syncFieldsFromDatabase 的输入与副作用', mainDataSourceMethods);
  await check('dataSources:readTables/loadTables 动作层的输入与错误语义', dataSourcesActions);

  const evidence = {
    at: new Date().toISOString(),
    packagesDir: PKGS,
    version: '2.2.20',
    sourceFiles: SOURCE_FILES.map(([name, base, relative]) => ({
      package: name,
      file: relative,
      sha256: sha256(base, relative),
    })),
    checks: results,
    failed,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const outFile = join(OUT_DIR, 'main-data-source-2.2.20-contract.json');
  writeFileSync(outFile, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`\n证据：${outFile}`);
  console.log(failed === 0 ? '全部通过' : `有 ${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
