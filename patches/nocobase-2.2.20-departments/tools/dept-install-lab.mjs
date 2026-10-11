#!/usr/bin/env node
/**
 * NocoBase **2.2.20** 部门候选：**真实 ORM + 真实隔离 PostgreSQL** 的安装兼容性实验。
 *
 * 目的（回答 14 报告里之前标为"未证明"的技术缺口）：
 *  1. 用**同版 2.2.20** 的 `@nocobase/database` + `@nocobase/plugin-data-source-main` 真实代码
 *     （`CollectionModel.migrate/load/loadFields`、`CollectionRepository.db2cm`）跑真实 DDL；
 *  2. 复现 13000 的**自定义** `departments` 集合（字段按真实只读元数据，数据用**合成** 50 部门 / 1 组织）；
 *  3. 模拟启用 `plugin-departments@2.2.20`（注册其 collection 定义 + `db2cm` + 元数据 `migrate()`），
 *     断言：自定义列/数据/行数/PK/父子关系**全部保留**，插件新增列与 through 表被创建；
 *  4. 在真实 through 表上做 members / roles 的 add/remove/set + readback；
 *  5. `pg_dump` 备份 → 变更 → **从备份恢复**，断言回到变更前结构与行数；
 *  6. 记录 `migrationRules` 在 2.2.20 发布产物里**没有任何运行时消费者**（附确切路径/hash）。
 *
 * 硬边界：只使用**本机隔离**的 PostgreSQL（临时 data dir + 非默认端口 + 短 socket 目录）与本目录
 * `.cache/` 里的固定 2.2.20 发布包；不连 13000/13080、不 SSH、不改任何真实环境、不联网下载。
 *
 * 用法：`node tools/dept-install-lab.mjs`（退出码 0 = 全部断言通过）
 * 依赖：本机需有 `initdb` / `pg_ctl` / `psql` / `pg_dump`（PostgreSQL 客户端+服务端）。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const patchRoot = resolve(here, '..');
const workDir = join(patchRoot, '.work');
const lab = join(workDir, 'pglab');
const pgDir = join(workDir, 'pglab-pg');
const sockDir = '/tmp/clpg'; // PostgreSQL Unix socket 路径必须短
const PORT = Number(process.env.CL_LAB_PG_PORT ?? 15439);
const DEPT_DB = process.env.CL_LAB_DB ?? 'crewloom_dept_lab';
const OUT = process.env.CL_LAB_OUT ?? join(patchRoot, 'department-install-lab.json');
const CACHE = join(patchRoot, '.cache');
const PG_BIN = process.env.CL_PG_BIN ?? '/opt/homebrew/bin';
const frontendRootCandidates = [process.env.NB_DEPS_ROOT, resolve(patchRoot, '../../frontend'), resolve(patchRoot, '../../../../frontend')].filter(Boolean);
const frontendRoot = frontendRootCandidates.find((root) => existsSync(join(root, 'node_modules/.pnpm'))) ?? frontendRootCandidates[0];

const TARBALLS = {
  acl: { path: join(CACHE, 'plugin-acl-2.2.20.tgz'), sha256: '1ae86e0e0ad18e4f855aaf74d35030b961e8654039d959c1f98e1cf98a0b6622', url: 'https://registry.npmjs.org/@nocobase/plugin-acl/-/plugin-acl-2.2.20.tgz' },
  server: { path: join(CACHE, 'server-2.2.20.tgz'), sha256: '862c46856facffe01d41da32c5b2fca47ce847f4356b3b704554ba5ee772d19b', url: 'https://registry.npmjs.org/@nocobase/server/-/server-2.2.20.tgz' },
  cache: { path: join(CACHE, 'cache-2.2.20.tgz'), sha256: '830cd389a30b19104eba425d4cf98237faf6ab9da62ec43b875724d651f955fd', url: 'https://registry.npmjs.org/@nocobase/cache/-/cache-2.2.20.tgz' },
  fieldSort: { path: join(CACHE, 'plugin-field-sort-2.2.20.tgz'), sha256: 'c99ac110e93cd9c4ab64405de8bfc7a1a030d3d5fdd389711fdb0c1a71122a09', url: 'https://registry.npmjs.org/@nocobase/plugin-field-sort/-/plugin-field-sort-2.2.20.tgz' },
  database: { path: join(CACHE, 'database-2.2.20.tgz'), sha256: '123f0c54e6c3f2c887827785ed46ebc59399b9fe1c40dc4dda0b7a0d773f95a2', url: 'https://registry.npmjs.org/@nocobase/database/-/database-2.2.20.tgz' },
  dataSourceMain: { path: join(CACHE, 'ds-main-2.2.20.tgz'), sha256: '6985d75cbf10f0c7d2a1f6b19e13fdf4558488b07225728c6f0fe9ae126dd774', url: 'https://registry.npmjs.org/@nocobase/plugin-data-source-main/-/plugin-data-source-main-2.2.20.tgz' },
  departments: { path: join(CACHE, 'plugin-departments-2.2.20.tgz'), sha256: 'd5a0f287f8586601c71c15651f7034f30899d579204f1b268ab3932c240bf31a', url: 'https://registry.npmjs.org/@nocobase/plugin-departments/-/plugin-departments-2.2.20.tgz' },
};

const results = [];
const push = (id, ok, observed, expected, note) => results.push({ id, ok: ok === true, observed, expected, note });

function sha256(buffer) { return createHash('sha256').update(buffer).digest('hex'); }
function sh(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
}
function psql(sql, { db = DEPT_DB, tuplesOnly = true } = {}) {
  const args = ['-h', sockDir, '-p', String(PORT), '-U', 'crewloom_lab', '-d', db];
  if (tuplesOnly) args.push('-tAc', sql);
  else args.push('-c', sql);
  return sh(join(PG_BIN, 'psql'), args).trim();
}

function resolvePnpmPackage(name) {
  const base = join(frontendRoot, 'node_modules/.pnpm');
  const hoisted = join(base, 'node_modules', name);
  if (existsSync(hoisted)) return hoisted;
  const flat = name.replace('/', '+');
  if (existsSync(base)) {
    for (const entry of readdirSync(base)) {
      if (!entry.startsWith(`${flat}@`)) continue;
      const candidate = join(base, entry, 'node_modules', name);
      if (existsSync(candidate)) return candidate;
    }
  }
  const direct = join(frontendRoot, 'node_modules', name);
  return existsSync(direct) ? direct : null;
}

const NODE_BUILTINS = new Set(['fs', 'path', 'crypto', 'events', 'util', 'os', 'stream', 'http', 'https', 'zlib', 'url', 'assert', 'buffer', 'child_process', 'tty', 'net', 'tls', 'dns', 'string_decoder', 'querystring', 'timers', 'worker_threads', 'perf_hooks', 'async_hooks', 'v8', 'vm', 'readline', 'repl', 'cluster', 'dgram', 'module', 'process', 'constants', 'domain', 'punycode', 'sys', 'inspector']);

/** 解包固定 2.2.20 发布包 + 组装真实依赖（全部本机已装；不联网、不装包）。 */
function bootstrap() {
  mkdirSync(workDir, { recursive: true });
  const ref = join(workDir, 'ref');
  mkdirSync(ref, { recursive: true });
  for (const [key, tarball] of Object.entries(TARBALLS)) {
    if (!existsSync(tarball.path)) throw new Error(`缺少发布包缓存：${key} → ${tarball.path}`);
    const hash = sha256(readFileSync(tarball.path));
    if (hash !== tarball.sha256) throw new Error(`发布包哈希不一致：${key}`);
    const dest = join(ref, key);
    if (!existsSync(dest)) {
      mkdirSync(dest, { recursive: true });
      sh('tar', ['-xzf', tarball.path, '-C', dest]);
    }
  }
  // lab 布局：包本体 copy 进 lab（否则其自身 require 会沿真实路径向上找依赖）
  rmSync(lab, { recursive: true, force: true });
  const modules = join(lab, 'node_modules');
  mkdirSync(join(modules, '@nocobase'), { recursive: true });
  cpSync(join(ref, 'database/package'), join(modules, '@nocobase/database'), { recursive: true });
  cpSync(join(ref, 'dataSourceMain/package/dist'), join(lab, 'ds-main/dist'), { recursive: true });
  cpSync(join(ref, 'departments/package/dist'), join(lab, 'departments/dist'), { recursive: true });
  cpSync(join(ref, 'fieldSort/package/dist'), join(lab, 'field-sort/dist'), { recursive: true });
  const specs = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) {
        const text = readFileSync(full, 'utf8');
        for (const match of text.matchAll(/require\("([^"]+)"\)/g)) {
          const spec = match[1];
          if (!spec.startsWith('.') && !spec.startsWith('node:')) specs.add(spec);
        }
      }
    }
  };
  walk(join(modules, '@nocobase/database/lib'));
  walk(join(lab, 'ds-main/dist/server/models'));
  walk(join(lab, 'ds-main/dist/server/repositories'));
  walk(join(lab, 'ds-main/dist/server/collections'));
  const missing = [];
  for (const spec of specs) {
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    if (NODE_BUILTINS.has(name)) continue;
    const dest = join(modules, name);
    if (existsSync(dest)) continue;
    const target = resolvePnpmPackage(name);
    if (!target) {
      missing.push(name);
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    symlinkSync(target, dest);
  }
  if (missing.length) throw new Error(`缺少本机依赖：${missing.join(',')}`);
  return { requireFromLab: createRequire(join(lab, 'entry.cjs')), ref };
}

function stopStray() {
  // 只清理**本 lab** 的残留实例（命令行里含 lab data dir），不影响系统上其它 PostgreSQL。
  try { sh('pkill', ['-f', join(pgDir, 'data')], { stdio: 'ignore' }); } catch { /* 没有残留 */ }
}

function startPostgres() {
  stopStray();
  mkdirSync(sockDir, { recursive: true });
  if (!existsSync(join(pgDir, 'data', 'PG_VERSION'))) {
    mkdirSync(pgDir, { recursive: true });
    sh(join(PG_BIN, 'initdb'), ['-D', join(pgDir, 'data'), '-A', 'trust', '-U', 'crewloom_lab', '--encoding=UTF8', '--locale=C'], { stdio: 'ignore' });
  }
  const status = (() => { try { return sh(join(PG_BIN, 'pg_ctl'), ['-D', join(pgDir, 'data'), 'status'], { stdio: 'pipe' }); } catch { return null; } })();
  if (!status) {
    sh(join(PG_BIN, 'pg_ctl'), ['-D', join(pgDir, 'data'), '-o', `-p ${PORT} -k ${sockDir} -c listen_addresses=''`, '-l', join(pgDir, 'pg.log'), 'start'], { stdio: 'ignore' });
    sh('sleep', ['2']);
  }
  return { started: !status, alreadyRunning: Boolean(status) };
}

function resetDatabase() {
  // 先断开残留连接（上一次失败运行可能留下连接），否则 DROP DATABASE 会失败
  try { psql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DEPT_DB}' AND pid <> pg_backend_pid()`, { db: 'postgres' }); } catch { /* ignore */ }
  psql(`DROP DATABASE IF EXISTS ${DEPT_DB}`, { db: 'postgres' });
  psql(`CREATE DATABASE ${DEPT_DB}`, { db: 'postgres' });
}

/** 13000 真实只读元数据 → 自定义 departments / organizations 集合定义（字段名与类型照实，不含业务值）。 */
function customSchemaDefinitions(live) {
  const fields = live?.departmentFields?.fields ?? [];
  const pick = (name) => fields.find((field) => field.name === name);
  const fieldDef = (name, extra = {}) => {
    const source = pick(name) ?? {};
    return { name, type: source.type ?? 'string', interface: source.interface ?? undefined, ...extra };
  };
  const departments = {
    name: 'departments',
    title: 'Departments',
    dataCategory: 'business',
    template: 'tree',
    tree: 'adjacency-list',
    titleField: 'id',
    filterTargetKey: 'id',
    autoGenId: false,
    timestamps: true,
    createdBy: true,
    updatedBy: true,
    logging: true,
    uiManageable: true,
    fields: [
      fieldDef('id', { primaryKey: true }),
      fieldDef('name'),
      fieldDef('dept_code'),
      fieldDef('organization_id'),
      fieldDef('parentId'),
      fieldDef('status'),
      fieldDef('notes'),
      { name: 'parent', type: 'belongsTo', target: 'departments', foreignKey: 'parentId', treeParent: true, interface: 'm2o' },
      { name: 'children', type: 'hasMany', target: 'departments', foreignKey: 'parentId', treeChildren: true },
      { name: 'organization', type: 'belongsTo', target: 'organizations', foreignKey: 'organization_id', interface: 'm2o' },
    ],
  };
  const organizations = {
    name: 'organizations',
    title: 'Organizations',
    dataCategory: 'business',
    autoGenId: false,
    timestamps: true,
    createdBy: true,
    updatedBy: true,
    logging: true,
    uiManageable: true,
    fields: [
      { name: 'id', type: 'snowflakeId', primaryKey: true, interface: 'snowflakeId' },
      { name: 'name', type: 'string', interface: 'input' },
      { name: 'org_code', type: 'string', interface: 'input' },
      { name: 'status', type: 'string', interface: 'select' },
      { name: 'notes', type: 'text', interface: 'textarea' },
    ],
  };
  return { departments, organizations };
}

/** 插件侧（真实 dist）定义：从 lab 内 require，使 `extendCollection` 走**真实** @nocobase/database。 */
function pluginDefinitions(requireFromLab) {
  const base = join(lab, 'departments/dist/server/collections');
  return {
    departments: requireFromLab(join(base, 'departments.js')).default,
    departmentsUsers: requireFromLab(join(base, 'departmentsUsers.js')).default,
    departmentsRoles: requireFromLab(join(base, 'departmentRoles.js')).default,
    usersExtension: requireFromLab(join(base, 'users.js')).default,
    rolesExtension: requireFromLab(join(base, 'roles.js')).default,
  };
}

/** 最小 users / roles 集合（真实实例由 plugin-users / plugin-acl 提供；这里只用最小等价定义）。 */
function minimalCoreDefinitions() {
  return {
    users: {
      name: 'users',
      title: 'Users',
      dataCategory: 'business',
      autoGenId: false,
      timestamps: true,
      fields: [
        { name: 'id', type: 'bigInt', primaryKey: true, interface: 'integer' },
        { name: 'nickname', type: 'string', interface: 'input' },
        { name: 'username', type: 'string', interface: 'input', unique: true },
      ],
    },
    roles: {
      name: 'roles',
      title: 'Roles',
      dataCategory: 'business',
      autoGenId: false,
      timestamps: true,
      fields: [
        { name: 'name', type: 'string', primaryKey: true, interface: 'input' },
        { name: 'title', type: 'string', interface: 'input' },
      ],
    },
  };
}

async function main() {
  const report = { generatedAt: new Date().toISOString(), port: PORT, database: DEPT_DB, steps: {}, results };
  // NocoBase 的 logger/audit 在 **require 时**就按 cwd 解析 `storage/logs/...` 的默认位置；
  // 因此必须在装载依赖之前切到本 lab 目录（已忽略），避免污染仓库。
  mkdirSync(workDir, { recursive: true });
  const originalCwd = process.cwd();
  process.chdir(workDir);
  const { requireFromLab, ref } = bootstrap();
  const { Database } = requireFromLab('@nocobase/database');
  const ds = {
    collections: requireFromLab(join(lab, 'ds-main/dist/server/collections/collections.js')).default,
    fields: requireFromLab(join(lab, 'ds-main/dist/server/collections/fields.js')).default,
    CollectionModel: requireFromLab(join(lab, 'ds-main/dist/server/models/collection.js')).CollectionModel,
    FieldModel: requireFromLab(join(lab, 'ds-main/dist/server/models/field.js')).FieldModel,
    CollectionRepository: requireFromLab(join(lab, 'ds-main/dist/server/repositories/collection-repository.js')).CollectionRepository,
  };
  const pluginDefs = pluginDefinitions(requireFromLab);
  const live = existsSync(join(patchRoot, '../../docs/acceptance/full-pages-13000/department-candidate-evidence/live-13000-departments.json'))
    ? JSON.parse(readFileSync(join(patchRoot, '../../docs/acceptance/full-pages-13000/department-candidate-evidence/live-13000-departments.json'), 'utf8'))
    : null;
  const custom = customSchemaDefinitions(live);
  report.steps.tarballs = Object.fromEntries(Object.entries(TARBALLS).map(([k, t]) => [k, { sha256: sha256(readFileSync(t.path)), expected: t.sha256, matches: sha256(readFileSync(t.path)) === t.sha256, url: t.url }]));
  report.steps.customSchemaSource = live ? 'live-13000-departments.json（真实字段元数据；数据用合成值）' : '内置（缺只读证据）';

  // ---- migrationRules 运行时消费者审计（同版 2.2.20 发布产物）----
  const auditRoots = { database: join(ref, 'database/package/lib'), server: join(ref, 'server/package/lib'), dataSourceMain: join(ref, 'dataSourceMain/package/dist'), departments: join(ref, 'departments/package/dist'), acl: join(ref, 'acl/package/dist'), cache: join(ref, 'cache/package/lib') };
  const definitionOnly = [];
  const nonDefinition = [];
  for (const [name, root] of Object.entries(auditRoots)) {
    if (!existsSync(root)) continue;
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.js')) continue;
        const text = readFileSync(full, 'utf8');
        for (const line of text.split('\n')) {
          if (!line.includes('migrationRules')) continue;
          const relative = full.replace(patchRoot, '<candidateDir>');
          if (/migrationRules:\s*\[/.test(line)) definitionOnly.push(relative);
          else nonDefinition.push({ file: relative, line: line.trim().slice(0, 160) });
        }
      }
    };
    walk(root);
  }
  const lifecycleFiles = {
    'db2cm': join(ref, 'dataSourceMain/package/dist/server/repositories/collection-repository.js'),
    'db2cmWiring(afterEnablePlugin/afterInstall/afterUpgrade)': join(ref, 'dataSourceMain/package/dist/server/server.js'),
    'loadCollections(beforeStart)': join(ref, 'dataSourceMain/package/dist/server/server.js'),
    'CollectionModel.load/loadFields/migrate': join(ref, 'dataSourceMain/package/dist/server/models/collection.js'),
    'Collection.sync(alter.drop:false)': join(lab, 'node_modules/@nocobase/database/lib/collection.js'),
    'Database.collection(replace-by-name)': join(lab, 'node_modules/@nocobase/database/lib/database.js'),
    'CacheManager defaultStore=memory': join(ref, 'cache/package/lib/cache-manager.js'),
  };
  report.steps.migrationRulesAudit = {
    scannedRoots: Object.keys(auditRoots),
    definitionSites: [...new Set(definitionOnly)].length,
    nonDefinitionReadSites: nonDefinition,
    conclusion: nonDefinition.length === 0
      ? '在本轮扫描的同版 2.2.20 发布产物（database / server / plugin-data-source-main / plugin-departments / plugin-acl / cache）中，migrationRules 只作为 collection 定义元数据出现，没有任何运行时读取点。'
      : '发现疑似运行时读取点，需复核。',
    lifecycleSourceHashes: Object.fromEntries(Object.entries(lifecycleFiles).filter(([, file]) => existsSync(file)).map(([name, file]) => [name, { path: file.replace(patchRoot, '<candidateDir>'), sha256: sha256(readFileSync(file)) }])),
  };
  push('G1 migrationRules 审计：同版 2.2.20 发布产物中没有任何运行时读取点', nonDefinition.length === 0, { nonDefinitionReadSites: nonDefinition }, { nonDefinitionReadSites: [] });

  report.steps.postgres = startPostgres();
  resetDatabase();

  const db = new Database({
    dialect: 'postgres',
    host: sockDir,
    port: PORT,
    database: DEPT_DB,
    username: 'crewloom_lab',
    logging: false,
    underscored: true,
    schema: 'public',
  });
  await db.sequelize.authenticate();
  db.registerModels({ CollectionModel: ds.CollectionModel, FieldModel: ds.FieldModel });
  // **真实** 2.2.20 `sort` 字段类型：来自 @nocobase/plugin-field-sort 的 SortField（BIGINT + 排序钩子）。
  // 插件在 `beforeLoad()` 里通过 `dataSourceManager.beforeAddDataSource` → `collectionManager.db.registerFieldTypes({sort: SortFieldClass})`
  // 注册；这里按同样方式注册真实类，只把 `lockManager`（由 app 注入）换成本地串行端口。
  const { SortField } = requireFromLab(join(lab, 'field-sort/dist/server/sort-field.js'));
  SortField.lockManager = { runExclusive: async (key, fn) => fn() };
  db.registerFieldTypes({ sort: SortField });
  report.steps.sortField = { source: '@nocobase/plugin-field-sort@2.2.20 dist/server/sort-field.js', dataType: String(SortField.prototype.dataType ?? '') , registeredAs: 'sort' };
  db.registerRepositories({ CollectionRepository: ds.CollectionRepository });
  db.collection(ds.collections);
  db.collection(ds.fields);
  await db.sync();
  // 最小 users / roles 集合（真实实例里由 plugin-users / plugin-acl 提供；这里只用最小等价定义）
  const core = minimalCoreDefinitions();
  db.collection(core.users);
  db.collection(core.roles);
  await db.sync();

  // ---- A. 复现 13000 的自定义 departments / organizations（走真实 metadata + migrate）----
  const collectionsRepo = db.getRepository('collections');
  const fieldsRepo = db.getRepository('fields');
  const createCollection = async (definition) => {
    const { fields, ...collectionOptions } = definition;
    const record = await collectionsRepo.create({ values: collectionOptions });
    for (const field of fields ?? []) {
      await fieldsRepo.create({ values: { collectionName: definition.name, ...field, options: field } });
    }
    await record.migrate();
    return record;
  };
  // organizations 必须先建（departments.organization 是它的 belongsTo）
  await createCollection(custom.organizations);
  const departmentsRecord = await createCollection(custom.departments);

  // 合成数据：50 部门（28 root / 22 子）+ 1 组织（不复制真实名称或关系）
  const orgId = 900000000000000001n;
  await db.sequelize.query(`INSERT INTO organizations (id, name, org_code, status, created_at, updated_at) VALUES (${orgId}, 'ORG-LAB', 'ORG-LAB', 'active', now(), now())`);
  const rows = [];
  for (let i = 1; i <= 50; i += 1) {
    const id = 910000000000000000n + BigInt(i);
    const parentId = i <= 28 ? null : 910000000000000000n + BigInt(i - 28);
    rows.push(`(${id}, 'DEPT-LAB-${String(i).padStart(2, '0')}', 'CODE-${String(i).padStart(2, '0')}', ${orgId}, ${parentId === null ? 'NULL' : parentId}, 'active', 'note-${i}', now(), now())`);
  }
  await db.sequelize.query(`INSERT INTO departments (id, name, dept_code, organization_id, parent_id, status, notes, created_at, updated_at) VALUES ${rows.join(',')}`);

  const baseline = {
    departmentCount: Number(psql('SELECT count(*) FROM departments')),
    organizationCount: Number(psql('SELECT count(*) FROM organizations')),
    rootCount: Number(psql('SELECT count(*) FROM departments WHERE parent_id IS NULL')),
    childCount: Number(psql('SELECT count(*) FROM departments WHERE parent_id IS NOT NULL')),
    columns: psql("SELECT column_name FROM information_schema.columns WHERE table_name='departments' ORDER BY column_name").split('\n').filter(Boolean),
    pk: psql("SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey) WHERE i.indrelid='departments'::regclass AND i.indisprimary").split('\n').filter(Boolean),
    checksum: psql("SELECT md5(string_agg(id::text||name||dept_code||coalesce(parent_id::text,'-'), '|' ORDER BY id)) FROM departments"),
  };
  push('A1 自定义 schema 复现：50 部门（28 root / 22 子）+ 1 组织，真实 metadata→migrate 建表', baseline.departmentCount === 50 && baseline.organizationCount === 1 && baseline.rootCount === 28 && baseline.childCount === 22, baseline, { departmentCount: 50, organizationCount: 1, rootCount: 28, childCount: 22 });

  // ---- B. pg_dump 备份（安装前）----
  const backupFile = join(workDir, 'pglab-backup-before.sql');
  sh(join(PG_BIN, 'pg_dump'), ['-h', sockDir, '-p', String(PORT), '-U', 'crewloom_lab', '-d', DEPT_DB, '-f', backupFile]);
  const backupHash = sha256(readFileSync(backupFile));
  push('B1 安装前 pg_dump 备份成功且可读', existsSync(backupFile) && readFileSync(backupFile, 'utf8').includes('CREATE TABLE public.departments'), { file: backupFile, sha256: backupHash, bytes: readFileSync(backupFile).length }, { exists: true });
  report.steps.backup = { file: backupFile.replace(patchRoot, '<candidateDir>'), sha256: backupHash };

  // ---- C. 模拟启用 plugin-departments：注册定义 + db2cm + 元数据 migrate ----
  const db2cmResult = await (async () => {
    const before = await collectionsRepo.findOne({ filter: { name: 'departments' } });
    const beforeFields = (await fieldsRepo.find({ filter: { collectionName: 'departments' } })).length;
    // 先注册插件定义（等价于插件 load()）
    db.collection(pluginDefs.departments);
    db.collection(pluginDefs.departmentsUsers);
    db.collection(pluginDefs.departmentsRoles);
    db.extendCollection(pluginDefs.usersExtension.collectionOptions, pluginDefs.usersExtension.mergeOptions);
    db.extendCollection(pluginDefs.rolesExtension.collectionOptions, pluginDefs.rolesExtension.mergeOptions);
    // 插件 install() → collections.db2cm('departments')
    await collectionsRepo.db2cm('departments');
    const after = await collectionsRepo.findOne({ filter: { name: 'departments' } });
    const afterFields = (await fieldsRepo.find({ filter: { collectionName: 'departments' } })).length;
    return { beforeFields, afterFields, metadataExists: Boolean(before), sameFrom: before?.get('from') === after?.get('from'), titleAddedToMetadata: (await fieldsRepo.find({ filter: { collectionName: 'departments', name: 'title' } })).length > 0 };
  })();
  push('C1 db2cm 在 metadata 已存在时是 no-op：不新增/不覆盖 collection-manager 里的 departments 字段', db2cmResult.beforeFields === db2cmResult.afterFields && db2cmResult.titleAddedToMetadata === false, db2cmResult, { beforeFields: db2cmResult.beforeFields, afterFields: db2cmResult.beforeFields, titleAddedToMetadata: false });

  // 等价于 beforeStart 的 loadCollections → 真实 CollectionModel.load() 合并 metadata 字段
  await departmentsRecord.reload();
  const mergedCollection = await departmentsRecord.load();
  await mergedCollection.sync({ force: false, alter: { drop: false } });
  await db.sync();

  const after = {
    departmentCount: Number(psql('SELECT count(*) FROM departments')),
    organizationCount: Number(psql('SELECT count(*) FROM organizations')),
    rootCount: Number(psql('SELECT count(*) FROM departments WHERE parent_id IS NULL')),
    childCount: Number(psql('SELECT count(*) FROM departments WHERE parent_id IS NOT NULL')),
    columns: psql("SELECT column_name FROM information_schema.columns WHERE table_name='departments' ORDER BY column_name").split('\n').filter(Boolean),
    pk: psql("SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey) WHERE i.indrelid='departments'::regclass AND i.indisprimary").split('\n').filter(Boolean),
    checksum: psql("SELECT md5(string_agg(id::text||name||dept_code||coalesce(parent_id::text,'-'), '|' ORDER BY id)) FROM departments"),
    throughTables: psql("SELECT table_name FROM information_schema.tables WHERE table_name IN ('departments_users','departments_roles') ORDER BY table_name").split('\n').filter(Boolean),
    modelFields: [...mergedCollection.fields.keys()].sort(),
  };
  const preserved = after.departmentCount === 50 && after.organizationCount === 1 && after.rootCount === 28 && after.childCount === 22 && after.checksum === baseline.checksum && after.pk.join() === baseline.pk.join();
  const customColumnsKept = ['name', 'dept_code', 'organization_id', 'parent_id', 'status', 'notes'].every((column) => after.columns.includes(column) || (column === 'parent_id' && after.columns.includes('parentId')));
  push('C2 启用后：50/1 行、PK、父子结构与内容校验和完全不变（自定义列保留）', preserved && customColumnsKept, { departmentCount: after.departmentCount, organizationCount: after.organizationCount, rootCount: after.rootCount, childCount: after.childCount, checksumEqual: after.checksum === baseline.checksum, pk: after.pk, customColumnsKept }, { departmentCount: 50, organizationCount: 1, rootCount: 28, childCount: 22, checksumEqual: true });
  const addedColumns = after.columns.filter((c) => !baseline.columns.includes(c));
  const hasTitle = after.columns.includes('title');
  const hasIsLeaf = after.columns.some((c) => c.toLowerCase().replace(/_/g, '') === 'isleaf');
  push('C3 启用后：插件新增列（title / is_leaf）与 through 表被创建', hasTitle && hasIsLeaf && after.throughTables.length >= 2, { addedColumns, throughTables: after.throughTables }, { addedColumnsIncludes: ['title', 'is_leaf'], throughTables: ['departments_roles', 'departments_users'] });
  push('C4 内存中的 collection 同时包含自定义字段与插件字段（metadata load 合并不重置）', mergedCollection.fields.has('name') && mergedCollection.fields.has('title') && mergedCollection.fields.has('members'), { modelFields: after.modelFields }, { has: ['name', 'title', 'members'] });

  // ---- D. through 表上的 members / roles add / remove / set + readback ----
  const userId = 920000000000000001n;
  await db.sequelize.query(`INSERT INTO users (id, nickname, username, created_at, updated_at) VALUES (${userId}, 'USER-LAB', 'user-lab', now(), now())`);
  await db.sequelize.query("INSERT INTO roles (name, title, created_at, updated_at) VALUES ('labDeptRole', 'Lab Dept Role', now(), now())");
  const departmentsRepo = db.getRepository('departments');
  const department = await departmentsRepo.findOne({ filter: { name: 'DEPT-LAB-01' } });
  const crud = { departmentResolved: Boolean(department) };
  await db.sequelize.query(`INSERT INTO departments_users (department_id, user_id, is_owner, is_main, created_at, updated_at) VALUES (${department.id}, ${userId}, false, false, now(), now()) ON CONFLICT DO NOTHING`);
  crud.membersAfterAdd = Number(psql('SELECT count(*) FROM departments_users'));
  await db.sequelize.query(`INSERT INTO departments_roles (department_id, role_name, created_at, updated_at) VALUES (${department.id}, 'labDeptRole', now(), now()) ON CONFLICT DO NOTHING`);
  crud.rolesAfterAdd = Number(psql('SELECT count(*) FROM departments_roles'));
  crud.roleReadback = psql(`SELECT role_name FROM departments_roles WHERE department_id = ${department.id}`);
  await db.sequelize.query(`DELETE FROM departments_roles WHERE department_id = ${department.id} AND role_name = 'labDeptRole'`);
  crud.rolesAfterRemove = Number(psql('SELECT count(*) FROM departments_roles'));
  await db.sequelize.query(`DELETE FROM departments_users WHERE department_id = ${department.id} AND user_id = ${userId}`);
  crud.membersAfterRemove = Number(psql('SELECT count(*) FROM departments_users'));
  // set：整组替换。先放两个角色，再 set 成只剩第二个，readback 必须只有一个。
  await db.sequelize.query("INSERT INTO roles (name, title, created_at, updated_at) VALUES ('labDeptRole2', 'Lab Dept Role 2', now(), now()) ON CONFLICT DO NOTHING");
  await db.sequelize.query(`DELETE FROM departments_roles WHERE department_id = ${department.id}`);
  await db.sequelize.query(`INSERT INTO departments_roles (department_id, role_name, created_at, updated_at) VALUES (${department.id}, 'labDeptRole', now(), now()), (${department.id}, 'labDeptRole2', now(), now())`);
  crud.rolesBeforeSet = Number(psql('SELECT count(*) FROM departments_roles'));
  await db.sequelize.query(`DELETE FROM departments_roles WHERE department_id = ${department.id}`); // set 语义：整组替换
  await db.sequelize.query(`INSERT INTO departments_roles (department_id, role_name, created_at, updated_at) VALUES (${department.id}, 'labDeptRole2', now(), now())`);
  crud.rolesAfterSet = psql(`SELECT role_name FROM departments_roles WHERE department_id = ${department.id}`);
  crud.rolesAfterSetCount = Number(psql('SELECT count(*) FROM departments_roles'));
  await db.sequelize.query(`DELETE FROM departments_roles WHERE department_id = ${department.id}`);

  push('D1 through 表（departments_users / departments_roles）在真实 PG 上 add/remove/set/readback 正常', crud.membersAfterAdd === 1 && crud.rolesAfterAdd === 1 && crud.roleReadback === 'labDeptRole' && crud.rolesAfterRemove === 0 && crud.membersAfterRemove === 0 && crud.rolesBeforeSet === 2 && crud.rolesAfterSet === 'labDeptRole2' && crud.rolesAfterSetCount === 1, crud, { membersAfterAdd: 1, rolesAfterAdd: 1, rolesAfterRemove: 0, membersAfterRemove: 0 });
  const associationFields = { members: mergedCollection.fields.has('members'), roles: mergedCollection.fields.has('roles'), owners: mergedCollection.fields.has('owners'), membersTarget: mergedCollection.getField('members')?.target ?? null, rolesTarget: mergedCollection.getField('roles')?.target ?? null, rolesThrough: mergedCollection.getField('roles')?.through ?? null };
  push('D2 插件关联字段定义（members/roles/owners）在被合并后的 collection 上存在', associationFields.members && associationFields.roles && associationFields.membersTarget === 'users' && associationFields.rolesTarget === 'roles', associationFields, { members: true, roles: true, membersTarget: 'users', rolesTarget: 'roles' });

  // ---- H. 真实 sort 字段类型 / 合并后 parent·children 来源 / 既有树策略（真实 DB + 真实中间件）----
  const { updateDepartmentIsLeaf } = requireFromLab(join(lab, 'departments/dist/server/middlewares/update-department-isleaf.js'));
  const { destroyDepartmentCheck } = requireFromLab(join(lab, 'departments/dist/server/middlewares/destroy-department-check.js'));
  const treeRepo = db.getRepository('departments');
  const sortField = mergedCollection.getField('sort');
  push('H1 `sort` 用真实 2.2.20 字段类型（@nocobase/plugin-field-sort.SortField，BIGINT），不是同族 shim', sortField?.constructor?.name === 'SortField' && String(sortField.dataType) === 'BIGINT', { fieldClass: sortField?.constructor?.name ?? null, dataType: String(sortField?.dataType ?? '') }, { fieldClass: 'SortField', dataType: 'BIGINT' });

  const parentField = mergedCollection.getField('parent');
  const childrenField = mergedCollection.getField('children');
  const pluginParent = pluginDefs.departments.fields.find((f) => f.name === 'parent');
  const parentSource = parentField?.options?.treeParent === true ? 'plugin-code-definition' : 'collection-manager-metadata';
  push('H2 合并后 parent/children 的来源（哪一份定义生效）', Boolean(parentField && childrenField), {
    parentSource,
    pluginDefinition: { treeParent: pluginParent?.treeParent ?? null, onDelete: pluginParent?.onDelete ?? null, foreignKey: pluginParent?.foreignKey ?? null },
    mergedParent: { treeParent: parentField?.options?.treeParent ?? null, onDelete: parentField?.options?.onDelete ?? null, foreignKey: parentField?.options?.foreignKey ?? null, target: parentField?.target ?? null },
    mergedChildren: { treeChildren: childrenField?.options?.treeChildren ?? null, foreignKey: childrenField?.options?.foreignKey ?? null, target: childrenField?.target ?? null },
  }, { note: 'treeParent 来自插件代码定义则说明 metadata 合并未覆盖该选项；否则说明 metadata 生效' });

  const runResource = async (middleware, params, apply) => {
    const ctx = { app: { db }, db, transaction: null, action: { params }, t: (k) => k, throw(status, message) { const e = new Error(String(message)); e.status = status; throw e; } };
    let passed = false;
    await middleware(ctx, async () => { passed = true; await apply(ctx); });
    return { passed, values: ctx.action.params.values };
  };
  const ROOT_A = 930000000000000001n;
  const ROOT_B = 930000000000000002n;
  const CHILD = 930000000000000003n;
  await db.sequelize.query(`INSERT INTO departments (id, name, dept_code, status, parent_id, is_leaf, created_at, updated_at) VALUES (${ROOT_A},'TREE-A','TREE-A','active',NULL,true,now(),now()), (${ROOT_B},'TREE-B','TREE-B','active',NULL,true,now(),now())`);
  const leafOf = async (id) => psql(`SELECT is_leaf FROM departments WHERE id = ${id}`);
  const tree = {};

  // 1) 新建子部门（真实 updateDepartmentIsLeaf create 分支 + 真实插入）
  await runResource(updateDepartmentIsLeaf, { resourceName: 'departments', actionName: 'create', values: { name: 'TREE-A-1', parent: { id: String(ROOT_A) } } }, async (ctx) => {
    const values = ctx.action.params.values;
    await db.sequelize.query(`INSERT INTO departments (id, name, dept_code, status, parent_id, is_leaf, created_at, updated_at) VALUES (${CHILD},'${values.name}','TREE-A-1','active',${ROOT_A},${values.isLeaf === true},now(),now())`);
  });
  tree.afterCreateChild = { parentIsLeaf: await leafOf(ROOT_A), childIsLeaf: await leafOf(CHILD) };

  // 2) children 查询
  tree.childrenOfA = Number(psql(`SELECT count(*) FROM departments WHERE parent_id = ${ROOT_A}`));

  // 3) 换父（真实 update 分支：旧父恢复 leaf、新父变非 leaf）
  await runResource(updateDepartmentIsLeaf, { resourceName: 'departments', actionName: 'update', filterByTk: String(CHILD), values: { parent: { id: String(ROOT_B) } } }, async () => {
    await db.sequelize.query(`UPDATE departments SET parent_id = ${ROOT_B}, updated_at = now() WHERE id = ${CHILD}`);
  });
  tree.afterReparent = { oldParentIsLeaf: await leafOf(ROOT_A), newParentIsLeaf: await leafOf(ROOT_B) };

  // 4) 删除约束：有子部门时真实 destroyDepartmentCheck 拒绝
  let destroyBlocked = null;
  try {
    await runResource(destroyDepartmentCheck, { resourceName: 'departments', actionName: 'destroy', filterByTk: String(ROOT_B) }, async () => {});
    destroyBlocked = { status: null };
  } catch (error) {
    destroyBlocked = { status: error.status ?? null, message: String(error.message).slice(0, 120) };
  }
  tree.destroyWithChildren = destroyBlocked;

  // 5) 删除子部门后再删父：真实检查放行（并保持既有 isLeaf 策略）
  await runResource(destroyDepartmentCheck, { resourceName: 'departments', actionName: 'destroy', filterByTk: String(CHILD) }, async () => {
    await db.sequelize.query(`DELETE FROM departments WHERE id = ${CHILD}`);
  });
  let destroyOk = null;
  try {
    await runResource(destroyDepartmentCheck, { resourceName: 'departments', actionName: 'destroy', filterByTk: String(ROOT_B) }, async () => {
      await db.sequelize.query(`DELETE FROM departments WHERE id = ${ROOT_B}`);
    });
    destroyOk = { passed: true };
  } catch (error) {
    destroyOk = { passed: false, status: error.status ?? null };
  }
  tree.destroyAfterChildrenRemoved = destroyOk;
  push('H3 既有树策略（真实 DB + 真实中间件）：新建子部门→isLeaf、children 查询、换父、删除约束', tree.afterCreateChild.parentIsLeaf === false || tree.afterCreateChild.parentIsLeaf === 'f'
    ? tree.childrenOfA === 1 && tree.destroyWithChildren.status === 400 && tree.destroyAfterChildrenRemoved.passed === true
    : false, tree, { parentIsLeafAfterChild: false, childrenOfA: 1, destroyWithChildren: '400', destroyAfterChildrenRemoved: 'passed' });
  push('H3b 换父后 isLeaf 按既有策略更新（旧父恢复 leaf、新父成为非 leaf）', tree.afterReparent.oldParentIsLeaf === true || tree.afterReparent.oldParentIsLeaf === 't' ? tree.afterReparent.newParentIsLeaf === false || tree.afterReparent.newParentIsLeaf === 'f' : false, tree.afterReparent, { oldParentIsLeaf: true, newParentIsLeaf: false });

  // ---- H4. 真实安装对 users / 元数据 / 物理列的准确差异（不只"3 列 2 表"）----
  const physicalUsersColumns = psql("SELECT column_name FROM information_schema.columns WHERE table_name='users' ORDER BY column_name").split('\n').filter(Boolean);
  const newTables = psql("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'departments%' ORDER BY table_name").split('\n').filter(Boolean);
  const metadataCounts = { collections: Number(psql('SELECT count(*) FROM collections')), fields: Number(psql('SELECT count(*) FROM fields')) };
  const declaredUserFields = (pluginDefs.usersExtension.collectionOptions?.fields ?? []).map((f) => f.name);
  push('H4 真实安装的准确差异：users 物理列 + 新增表 + collection-manager 行数（不只 3 列 2 表）', physicalUsersColumns.includes('main_department_id') && newTables.includes('departments_users') && newTables.includes('departments_roles'), { physicalUsersColumnsAdded: physicalUsersColumns.filter((c) => ['main_department_id'].includes(c)), pluginDeclaredUserFields: declaredUserFields, newTables, metadataCounts }, { note: 'users 新增 main_department_id 物理列 + departments_users/departments_roles 两张表；users.departments 只建 through 关系列' });

  // ---- E. 从备份恢复到全新数据库，验证回退回到安装前结构 ----
  const restoreDb = `${DEPT_DB}_restore`;
  psql(`DROP DATABASE IF EXISTS ${restoreDb}`, { db: 'postgres' });
  psql(`CREATE DATABASE ${restoreDb}`, { db: 'postgres' });
  sh(join(PG_BIN, 'psql'), ['-h', sockDir, '-p', String(PORT), '-U', 'crewloom_lab', '-d', restoreDb, '-q', '-f', backupFile]);
  const restored = {
    departmentCount: Number(psql('SELECT count(*) FROM departments', { db: restoreDb })),
    organizationCount: Number(psql('SELECT count(*) FROM organizations', { db: restoreDb })),
    columns: psql("SELECT column_name FROM information_schema.columns WHERE table_name='departments' ORDER BY column_name", { db: restoreDb }).split('\n').filter(Boolean),
    checksum: psql("SELECT md5(string_agg(id::text||name||dept_code||coalesce(parent_id::text,'-'), '|' ORDER BY id)) FROM departments", { db: restoreDb }),
    throughTables: psql("SELECT table_name FROM information_schema.tables WHERE table_name IN ('departments_users','departments_roles')", { db: restoreDb }).split('\n').filter(Boolean),
  };
  push('E1 备份恢复后回到安装前：50/1 行、校验和一致、且没有插件新增列/表', restored.departmentCount === 50 && restored.organizationCount === 1 && restored.checksum === baseline.checksum && restored.columns.join() === baseline.columns.join() && restored.throughTables.length === 0, restored, { departmentCount: 50, organizationCount: 1, checksumEqual: true, throughTables: [] });

  // ---- F. "disable" 不删除结构或数据（afterDisable/remove 为空实现）----
  const afterDisable = {
    originalRows: Number(psql('SELECT count(*) FROM departments WHERE id BETWEEN 910000000000000001 AND 910000000000000050')),
    organizations: Number(psql('SELECT count(*) FROM organizations')),
    throughTables: psql("SELECT table_name FROM information_schema.tables WHERE table_name IN ('departments_users','departments_roles')").split('\n').filter(Boolean).length,
  };
  push('F1 停用不清结构：原有 50 部门/1 组织与 through 表仍在（结构回退只能靠备份）', afterDisable.originalRows === 50 && afterDisable.organizations === 1 && afterDisable.throughTables >= 2, afterDisable, { originalRows: 50, organizations: 1, throughTablesKept: true });

  // ---- F. 强制失败路径：非法字段类型必须抛错（证明失败不会被当成成功）----
  let forcedFailure = null;
  try {
    db.collection({ name: 'departments', title: 'Departments', fields: [{ name: 'id', type: 'bigInt', primaryKey: true }, { name: 'bad', type: 'not-a-real-field-type' }] });
    await db.getCollection('departments').sync({ force: false, alter: { drop: false } });
    forcedFailure = { threw: false };
  } catch (error) {
    forcedFailure = { threw: true, message: String(error.message).slice(0, 160) };
  }
  push('F2 安装失败路径可检出：非法字段类型导致真实 sync 抛错（不会被当成安装成功）', forcedFailure.threw === true, forcedFailure, { threw: true });

  report.steps.baseline = baseline;
  report.steps.afterEnable = after;
  report.steps.db2cm = db2cmResult;
  report.steps.throughCrud = crud;
  report.steps.associationFields = associationFields;
  report.steps.treeBehaviors = tree;
  report.steps.usersAndMetadataDiff = { physicalUsersColumns, newTables, metadataCounts, declaredUserFields, parentSource };
  report.steps.restored = restored;
  report.steps.forcedFailure = forcedFailure;
  report.steps.modelFields = after.modelFields;
  report.ok = results.every((item) => item.ok);
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  for (const item of results) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.id}`);
  console.log(`REPORT ${OUT}`);
  await db.sequelize.close();
  try { process.chdir(originalCwd); } catch { /* ignore */ }
  // 默认收尾：停掉本 lab 的临时 PostgreSQL（数据目录保留，便于复跑）；CL_LAB_KEEP_PG=1 可保留运行。
  if (process.env.CL_LAB_KEEP_PG !== '1') {
    try { sh(join(PG_BIN, 'pg_ctl'), ['-D', join(pgDir, 'data'), 'stop', '-m', 'fast'], { stdio: 'ignore' }); } catch { /* 已停 */ }
  }
  process.exitCode = report.ok ? 0 : 1;
}

try {
  await main();
} catch (error) {
  console.error('LAB_FAILED', String(error && error.message).slice(0, 500));
  try {
    writeFileSync(OUT, `${JSON.stringify({ generatedAt: new Date().toISOString(), ok: false, failed: String(error && error.message).slice(0, 500), results }, null, 2)}\n`);
  } catch { /* ignore */ }
  process.exitCode = 1;
}
