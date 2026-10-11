#!/usr/bin/env node
/**
 * NocoBase **2.2.20** 部门 / 认证候选：**真实本机 Application 认证 + 完整 HTTP 链**（backend 组独占路径）。
 *
 * 目标（对应 2026-10-11 本轮任务 1–4 项）：
 *  1. 用**标准 install 入口**（真实 `app.runAsCLI(['node','main','install'])`）产生正确的 `basic`
 *     authenticator，合成管理员/普通用户可 signIn，token 只在内存；
 *  2. 复现 13000 的**自定义** departments 形状 + 50 部门 / 1 组织合成旧数据，再走**真实 PluginManager
 *     enable/disable 生命周期**（`app.pm.enable/disable('departments')`，不是直接 collection manager），
 *     实测 DDL 差异、存量保护、tree 规则与 `onDelete`；
 *  3. 通过真实 Application → resourcer → ACL → 原生 departments 中间件 → ORM → PG 的 **HTTP** 链，
 *     跑 4 条关联资源 GET、members/roles 的 add/remove/set/readback、有效角色切换、普通用户越权拒绝、
 *     撤销后立即失效；断言包含**非空**与**拒绝**，不是四个 200 `[]`；
 *  4. 隔离合成库上的 `pg_dump` 备份 → 变更 → 恢复真正 roundtrip（含损坏备份的失败控制），
 *     以及 enable/disable/失败处理的原始退出码。
 *
 * 硬边界：只使用本机隔离临时 PostgreSQL + `.cache/npm` 里固定的 2.2.20 发布包闭包；
 * 不连 13000/13080、不读任何凭据、不 SSH、不安装/启用真实实例、不 push。
 *
 * 用法：
 *   node tools/app-http-chain.mjs                 # 跑完整链，结束后关掉 app/PG
 *   CL_KEEP_RUNNING=1 node tools/app-http-chain.mjs   # 跑完后保留 HTTP 预览（15441）与 PG
 * 退出码：0 = 全部断言通过；1 = 有断言失败或环境错误；3 = 预览模式（脚本保持服务中）
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  APP_PORT, MODULES, PG_HOST, PG_PORT, PG_USER, WORK, databaseConfig, log, pgStart, prepareClosure,
  psql, recreateDatabase, requireFromLab, writeEvidence,
} from './app-lab.mjs';

const DB = 'cl_final_backend_http';
const RESTORE_DB = 'cl_final_backend_restore';
const BAD_DB = 'cl_final_backend_bad_restore';
const ART = join(WORK, 'artifacts');
const PSQL = '/opt/homebrew/bin/psql';
const PG_DUMP = '/opt/homebrew/bin/pg_dump';
const PG_RESTORE = '/opt/homebrew/bin/pg_restore';

const results = [];
const rawLines = [];

function raw(line) {
  rawLines.push(line);
  console.log(line);
}

function check(id, phase, ok, observed, expected, note = '') {
  const item = { id, phase, ok: ok === true, observed, expected, note };
  results.push(item);
  raw(`  ${item.ok ? 'PASS' : 'FAIL'} [${phase}] ${id} :: ${JSON.stringify(observed)}${note ? ` (${note})` : ''}`);
  return item.ok;
}

/** 13000 真实只读元数据 → 自定义 organizations / departments 集合定义（字段名与类型照实）。 */
function customDefinitions() {
  return {
    organizations: {
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
    },
    departments: {
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
      shared: true,
      uiManageable: true,
      fields: [
        { name: 'id', type: 'snowflakeId', primaryKey: true, interface: 'snowflakeId' },
        { name: 'name', type: 'string', interface: 'input' },
        { name: 'dept_code', type: 'string', interface: 'input' },
        { name: 'organization_id', type: 'bigInt', interface: 'integer' },
        { name: 'parentId', type: 'bigInt', interface: 'integer', isForeignKey: true },
        { name: 'status', type: 'string', interface: 'select' },
        { name: 'notes', type: 'text', interface: 'textarea' },
        { name: 'parent', type: 'belongsTo', target: 'departments', foreignKey: 'parentId', treeParent: true, interface: 'm2o' },
        { name: 'children', type: 'hasMany', target: 'departments', foreignKey: 'parentId', treeChildren: true, interface: 'o2m' },
        { name: 'organization', type: 'belongsTo', target: 'organizations', foreignKey: 'organization_id', interface: 'm2o' },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// DB 观测
// ---------------------------------------------------------------------------
const TABLES_OF_INTEREST = ['departments', 'organizations', 'departments_users', 'departments_roles', 'users', 'roles'];

function columnsOf(db, table) {
  const out = psql(db, `select column_name || ':' || data_type from information_schema.columns where table_name='${table}' order by column_name`);
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

function tableExists(db, table) {
  return psql(db, `select count(*) from information_schema.tables where table_schema='public' and table_name='${table}'`).trim() === '1';
}

function deptChecksum(db) {
  if (!tableExists(db, 'departments')) return null;
  return psql(db, "select md5(coalesce(string_agg(id::text||name||dept_code||coalesce(parent_id::text,'-'),'|' order by id),'')) from departments").trim();
}

function orgChecksum(db) {
  if (!tableExists(db, 'organizations')) return null;
  return psql(db, "select md5(coalesce(string_agg(id::text||name||org_code,'|' order by id),'')) from organizations").trim();
}

function count(db, table) {
  return tableExists(db, table) ? Number(psql(db, `select count(*) from ${table}`).trim()) : null;
}

function dbSnapshot(db) {
  const tables = {};
  for (const table of TABLES_OF_INTEREST) {
    tables[table] = {
      exists: tableExists(db, table),
      columns: tableExists(db, table) ? columnsOf(db, table) : null,
      rows: count(db, table),
    };
  }
  return {
    database: db,
    tables,
    checksums: { departments: deptChecksum(db), organizations: orgChecksum(db) },
    structure: {
      rootCount: tableExists(db, 'departments') ? Number(psql(db, 'select count(*) from departments where parent_id is null').trim()) : null,
      withParent: tableExists(db, 'departments') ? Number(psql(db, 'select count(*) from departments where parent_id is not null').trim()) : null,
      departmentsUsersIsOwner: tableExists(db, 'departments_users') ? columnsOf(db, 'departments_users') : null,
    },
  };
}

function foreignKeys(db, table) {
  if (!tableExists(db, table)) return [];
  const out = psql(
    db,
    `select conname || '|' || confrelid::regclass::text || '|' || confdeltype::text from pg_constraint where conrelid='${table}'::regclass and contype='f' order by conname`,
  );
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** collection-manager 元数据指纹（db2cm 是否覆盖）。 */
function cmFingerprint(db) {
  const collections = psql(
    db,
    "select name || '|' || coalesce(title,'') || '|' || md5(options::text) from collections where name in ('departments','organizations') order by name",
  ).trim();
  const fields = psql(
    db,
    "select coalesce(collection_name,'-') || '|' || name || '|' || type from fields where collection_name in ('departments','organizations') order by collection_name, name",
  ).trim();
  return { collections, fields, fieldCount: fields ? fields.split('\n').length : 0 };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function createHttpClient(app) {
  const http = requireFromLab('node:http');
  let server = null;
  const calls = [];
  const start = async (port) => {
    server = http.createServer((req, res) => app.callback()(req, res));
    await new Promise((resolvePromise) => server.listen(port, '127.0.0.1', resolvePromise));
  };
  const close = async () => {
    if (server) await new Promise((resolvePromise) => server.close(resolvePromise));
  };
  const call = async (label, path, { method = 'GET', body, token, role, authenticator = 'basic' } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (authenticator) headers['X-Authenticator'] = authenticator;
    if (token) headers.Authorization = `Bearer ${token}`;
    if (role) headers['X-Role'] = role;
    const res = await fetch(`http://127.0.0.1:${APP_PORT}/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = { _nonJson: text.slice(0, 160) }; }
    // 只保留可审计的结构信息，绝不写入 token / 密码 / 业务名称明细
    const summary = {
      label,
      method,
      path: path.split('?')[0],
      status: res.status,
      dataType: Array.isArray(json?.data) ? 'array' : typeof json?.data,
      dataLength: Array.isArray(json?.data) ? json.data.length : undefined,
      count: json?.meta?.count,
      errorCode: json?.errors?.[0]?.code ?? json?.errors?.[0]?.message?.slice?.(0, 80),
    };
    calls.push(summary);
    globalThis.__CL_HTTP_CALLS = calls;
    return { status: res.status, json, summary };
  };
  return { start, close, call, calls };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
// 与真实应用一致：preset 用「短名 + packageName」形状（repository.init 复现的 applicationPlugins 形状）。
const APP_PLUGIN_PACKAGES = [
  'plugin-error-handler', 'plugin-auth', 'plugin-field-sort', 'plugin-field-sequence', 'plugin-field-formula',
  'plugin-data-source-manager', 'plugin-data-source-main', 'plugin-acl', 'plugin-users', 'plugin-user-data-sync',
  'plugin-ui-schema-storage',
  // NOTE: plugin-departments 故意不放进 preset —— 它在本实验里对应真实 13000 的「未安装未启用」状态，
  // 只以 applicationPlugins 记录 + pm.enable() 生命周期进入。
];
const APP_PLUGINS = APP_PLUGIN_PACKAGES.map((pkg) => [pkg.replace(/^plugin-/, ''), { packageName: `@nocobase/${pkg}` }]);

function pgDump(file, db) {
  execFileSync(PG_DUMP, ['-h', PG_HOST, '-p', String(PG_PORT), '-U', PG_USER, '-Fc', '-f', file, db]);
  return { file, size: statSync(file).size, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') };
}

function pgRestore(file, db) {
  psql('postgres', `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${db}' AND pid <> pg_backend_pid()`);
  psql('postgres', `DROP DATABASE IF EXISTS ${db}`);
  psql('postgres', `CREATE DATABASE ${db}`);
  execFileSync(PG_RESTORE, ['-h', PG_HOST, '-p', String(PG_PORT), '-U', PG_USER, '-d', db, '--no-owner', '--no-privileges', file], { stdio: 'ignore' });
}

async function main() {
  mkdirSync(ART, { recursive: true });
  const lab = join(WORK, 'applab');
  mkdirSync(lab, { recursive: true });
  process.chdir(lab);
  process.env.NODE_MODULES_PATH = MODULES;
  process.env.API_BASE_PATH = '/api';
  process.env.APP_PORT = String(APP_PORT);
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';

  const env = { pg: `127.0.0.1:${PG_PORT}`, http: `http://127.0.0.1:${APP_PORT}`, database: DB };
  raw(`# app-http-chain 2.2.20 本机受控链  ${new Date().toISOString()}`);
  raw(`# env ${JSON.stringify(env)}`);
  const prep = prepareClosure();
  raw(`# 闭包包数=${prep.packages.length} 缺失三方依赖=${prep.missingDeps.join(',') || 'none'}`);
  const pgStarted = pgStart();
  raw(`# 临时 PostgreSQL ${PG_HOST}:${PG_PORT}（本次启动=${pgStarted}）`);
  recreateDatabase(DB);
  psql('postgres', `DROP DATABASE IF EXISTS ${RESTORE_DB}`);
  psql('postgres', `DROP DATABASE IF EXISTS ${BAD_DB}`);

  const { Application } = requireFromLab('@nocobase/server');
  process.env.INIT_ROOT_EMAIL = 'lab-admin@example.invalid';
  process.env.INIT_ROOT_PASSWORD = 'lab-admin-pass-123';
  process.env.INIT_ROOT_NICKNAME = 'Lab Admin';
  process.env.INIT_ROOT_USERNAME = 'labadmin';
  const ADMIN = { email: 'lab-admin@example.invalid', password: 'lab-admin-pass-123' };
  const NORMAL = { email: 'lab-user@example.invalid', password: 'lab-user-pass-123', nickname: 'Lab User', username: 'labuser' };

  const app = new Application({
    name: 'main',
    skipSupervisor: true,
    database: databaseConfig(DB),
    plugins: APP_PLUGINS,
    resourcer: { prefix: '/api' },
    acl: {},
  });

  const http = createHttpClient(app);
  const plan = { installPlan: [], preview: null };
  let fatal = null;

  // === 阶段 0：标准 install（真实 CLI 入口），产生 basic authenticator ===
  raw('\n## 阶段 0：标准 install/bootstrap');
  await app.runAsCLI(['node', 'main', 'install'], { throwError: true });
  raw('  install 命令完成');
  await app.load();
  await app.start();
  await http.start(APP_PORT);
  raw(`  HTTP 监听 ${APP_PORT}`);
  plan.preview = { url: `http://127.0.0.1:${APP_PORT}/api`, port: APP_PORT, owner: 'final-native-backend/app-http-chain.mjs' };

  const authRows = psql(DB, 'select name || \'|\' || auth_type || \'|\' || enabled from authenticators order by name').trim();
  check('a1', 'auth', authRows === 'basic|Email/Password|true', { authenticators: authRows }, 'basic|Email/Password|true', '真实 install 播种的 authenticator');

  // === 阶段 1：认证 HTTP（合成管理员/普通用户 signIn） ===
  raw('\n## 阶段 1：认证 HTTP');
  const publicList = await http.call('authenticators:publicList', '/authenticators:publicList');
  check('a2', 'auth', publicList.status === 200 && publicList.json?.data?.[0]?.name === 'basic',
    { status: publicList.status, names: publicList.json?.data?.map?.((a) => a.name) }, '200 且含 basic');

  const badSignIn = await http.call('auth:signIn(错误口令)', '/auth:signIn', { method: 'POST', body: { email: ADMIN.email, password: 'definitely-wrong' } });
  check('a3', 'auth', badSignIn.status !== 200, { status: badSignIn.status }, '非 200（真实口令校验）');

  const adminSignIn = await http.call('auth:signIn(管理员)', '/auth:signIn', { method: 'POST', body: ADMIN });
  const adminToken = adminSignIn.json?.data?.token ?? null;
  const adminUserId = adminSignIn.json?.data?.user?.id ?? null;
  check('a4', 'auth', adminSignIn.status === 200 && Boolean(adminToken) && Boolean(adminUserId),
    { status: adminSignIn.status, tokenPresent: Boolean(adminToken), userId: adminUserId }, '200 且 token 在内存', 'token 不写入证据');

  const adminCheck = await http.call('auth:check(管理员)', '/auth:check', { token: adminToken });
  check('a5', 'auth', adminCheck.status === 200, { status: adminCheck.status, roles: adminCheck.json?.data?.roles?.map?.((r) => r.name) }, '200');

  const noToken = await http.call('users:list(无 token)', '/users:list?pageSize=1');
  check('a6', 'auth', noToken.status === 401 || noToken.status === 403, { status: noToken.status }, '401/403 拒绝');

  const createUser = await http.call('users:create(普通用户)', '/users:create', {
    method: 'POST', token: adminToken, body: { email: NORMAL.email, password: NORMAL.password, nickname: NORMAL.nickname, username: NORMAL.username },
  });
  const normalUserId = createUser.json?.data?.id;
  check('a7', 'auth', createUser.status === 200 && Boolean(normalUserId), { status: createUser.status, userId: normalUserId }, '200');

  const createRole = await http.call('roles:create(普通角色)', '/roles:create', {
    method: 'POST', token: adminToken, body: { name: 'cl_reviewer', title: 'CL Reviewer' },
  });
  check('a8', 'auth', createRole.status === 200, { status: createRole.status }, '200');

  const assignRole = await http.call('users/<id>/roles:add', `/users/${normalUserId}/roles:add`, {
    method: 'POST', token: adminToken, body: ['cl_reviewer'],
  });
  check('a9', 'auth', assignRole.status === 200, { status: assignRole.status }, '200');

  const normalSignIn = await http.call('auth:signIn(普通用户)', '/auth:signIn', { method: 'POST', body: NORMAL });
  const normalToken = normalSignIn.json?.data?.token ?? null;
  check('a10', 'auth', normalSignIn.status === 200 && Boolean(normalToken),
    { status: normalSignIn.status, tokenPresent: Boolean(normalToken), userId: normalSignIn.json?.data?.user?.id }, '200 且 token 在内存', 'token 不写入证据');

  const normalCheck = await http.call('auth:check(普通用户)', '/auth:check', { token: normalToken });
  check('a11', 'auth', normalCheck.status === 200 && (normalCheck.json?.data?.roles ?? []).some((r) => r.name === 'cl_reviewer'),
    { status: normalCheck.status, roles: normalCheck.json?.data?.roles?.map?.((r) => r.name) }, '200 且含 cl_reviewer');

  // === 阶段 2：自定义 schema + 50/1 合成旧数据（B1 前置） ===
  raw('\n## 阶段 2：自定义 departments 形状 + 50 部门/1 组织合成旧数据');
  const defs = customDefinitions();
  app.db.collection(defs.organizations);
  app.db.collection(defs.departments);
  await app.db.sync();
  await app.db.getRepository('collections').db2cmCollections(['departments', 'organizations']);
  const orgRepo = app.db.getRepository('organizations');
  const deptRepo = app.db.getRepository('departments');
  const org = await orgRepo.create({ values: { name: 'SYN-ORG', org_code: 'SYN-ORG-1', status: 'active' } });
  const roots = [];
  for (let i = 0; i < 28; i += 1) {
    roots.push(await deptRepo.create({ values: { name: `SYN-DEPT-${i}`, dept_code: `SYN-${i}`, organization_id: org.get('id'), status: 'active' } }));
  }
  for (let i = 0; i < 22; i += 1) {
    await deptRepo.create({
      values: { name: `SYN-CHILD-${i}`, dept_code: `SYN-C-${i}`, organization_id: org.get('id'), status: 'active', parentId: roots[i % roots.length].get('id') },
    });
  }
  raw(`  合成数据：organizations=${await orgRepo.count()} departments=${await deptRepo.count()} roots=${roots.length}`);
  const preSnapshot = dbSnapshot(DB);
  const preCm = cmFingerprint(DB);
  const preDump = pgDump(join(ART, 'pre-enable-13000-shape.dump'), DB);
  raw(`  pre-enable 备份：${JSON.stringify({ size: preDump.size, sha256: preDump.sha256.slice(0, 16) })}`);
  check('b1', 'b1-enable', preSnapshot.tables.departments.columns.every((c) => !['title:character varying', 'is_leaf:boolean', 'sort:bigint'].includes(c)) && !preSnapshot.tables.departments_users.exists,
    { deptColumns: preSnapshot.tables.departments.columns, throughExists: preSnapshot.tables.departments_users.exists, mainDeptColumn: preSnapshot.tables.users.columns.filter((c) => c.startsWith('main_department_id')) },
    'enable 前无插件新增列/表');

  // B1 前置：applicationPlugins 记录 enabled=false / installed=false（对应真实 13000 live 状态）
  await app.db.getRepository('applicationPlugins').updateOrCreate({
    values: { name: 'departments', packageName: '@nocobase/plugin-departments', version: '2.2.20', enabled: false, installed: false, builtIn: false },
    filterKeys: ['name'],
  });
  await app.reload();
  await app.start();
  const pmBefore = app.pm.get('departments');
  const recordBefore = psql(DB, "select enabled || '|' || installed from application_plugins where name='departments'").trim();
  check('b2', 'b1-enable', recordBefore === 'false|false' && !pmBefore,
    { record: recordBefore, pluginInstance: pmBefore ? 'present' : 'absent' }, 'false|false 且插件未加载', 'installed=false/enabled=false（对应真实 13000）');

  // === 阶段 3：真实 PluginManager enable 生命周期 ===
  raw('\n## 阶段 3：真实 PluginManager enable 生命周期');
  await app.pm.enable('departments');
  const pmAfter = app.pm.get('departments');
  check('b3', 'b1-enable', pmAfter?.enabled === true && pmAfter?.installed === true,
    { enabled: pmAfter?.enabled, installed: pmAfter?.installed, record: psql(DB, "select enabled || '|' || installed from application_plugins where name='departments'").trim() },
    'enabled=true installed=true');

  const postSnapshot = dbSnapshot(DB);
  const postCm = cmFingerprint(DB);
  const addedCols = postSnapshot.tables.departments.columns.filter((c) => !preSnapshot.tables.departments.columns.includes(c)).sort();
  check('b4', 'b1-enable', addedCols.length === 3 && ['is_leaf:boolean', 'sort:bigint', 'title:character varying'].every((c) => addedCols.includes(c)),
    { addedColumns: addedCols, sortType: postSnapshot.tables.departments.columns.find((c) => c.startsWith('sort:')) }, '新增 title/is_leaf/sort(BIGINT)', '真实 SortField 类型，不再用 INTEGER shim');
  check('b5', 'b1-enable', postSnapshot.tables.departments_users.exists && postSnapshot.tables.departments_roles.exists,
    { through: ['departments_users', 'departments_roles'].map((t) => postSnapshot.tables[t].exists), usersMainDept: postSnapshot.tables.users.columns.filter((c) => c.startsWith('main_department_id')) },
    '两张 through 表 + users.main_department_id');
  check('b6', 'b1-enable', postSnapshot.checksums.departments === preSnapshot.checksums.departments && postSnapshot.checksums.organizations === preSnapshot.checksums.organizations
    && postSnapshot.tables.departments.rows === 50 && postSnapshot.tables.organizations.rows === 1,
    { deptChecksumEqual: postSnapshot.checksums.departments === preSnapshot.checksums.departments, orgChecksumEqual: postSnapshot.checksums.organizations === preSnapshot.checksums.organizations, deptRows: postSnapshot.tables.departments.rows, orgRows: postSnapshot.tables.organizations.rows },
    '50/1 行与校验和不变');
  check('b7', 'b1-enable', postCm.collections === preCm.collections && postCm.fields === preCm.fields,
    { cmCollectionsEqual: postCm.collections === preCm.collections, cmFieldsEqual: postCm.fields === preCm.fields, fieldCount: postCm.fieldCount }, 'collection-manager 元数据不变（db2cm no-op）');

  const mergedParent = app.db.getCollection('departments')?.getField('parent')?.options ?? null;
  check('b8', 'b1-enable', mergedParent?.treeParent === true && mergedParent?.foreignKey === 'parentId',
    { parentSource: 'code+metadata merge', treeParent: mergedParent?.treeParent, foreignKey: mergedParent?.foreignKey, onDelete: mergedParent?.onDelete ?? null, fkConstraints: foreignKeys(DB, 'departments') },
    'parent 为 treeParent/parentId', 'metadata 合并后 onDelete 实际值单列，不臆断 CASCADE');

  // === 阶段 4：部门 HTTP 树规则（真实中间件） ===
  raw('\n## 阶段 4：部门 HTTP（tree 规则 / 拒绝路径）');
  const createDept = await http.call('departments:create', '/departments:create', {
    method: 'POST', token: adminToken, body: { name: 'HTTP-PARENT', dept_code: 'HTTP-1', status: 'active' },
  });
  const parentId = createDept.json?.data?.id;
  check('c1', 'dept-http', createDept.status === 200 && Boolean(parentId), { status: createDept.status, id: parentId }, '200 且返回 id');

  const duplicateRole = await http.call('roles:create(重复 name)', '/roles:create', { method: 'POST', token: adminToken, body: { name: 'cl_reviewer', title: 'dup' } });
  check('c2', 'dept-http', duplicateRole.status >= 400, { status: duplicateRole.status, errorCode: duplicateRole.summary.errorCode }, '4xx 拒绝（唯一约束/失败处理）');

  const createChild = await http.call('departments:create(子部门)', '/departments:create', {
    method: 'POST', token: adminToken, body: { name: 'HTTP-CHILD', dept_code: 'HTTP-1-1', status: 'active', parent: { id: String(parentId) } },
  });
  const childId = createChild.json?.data?.id;
  const parentLeaf = psql(DB, `select is_leaf from departments where id=${parentId}`).trim();
  const childLeaf = psql(DB, `select is_leaf from departments where id=${childId}`).trim();
  check('c3', 'dept-http', createChild.status === 200 && parentLeaf === 'f' && childLeaf === 't',
    { status: createChild.status, parentIsLeaf: parentLeaf, childIsLeaf: childLeaf }, '父 is_leaf=false / 子 true（真实 updateDepartmentIsLeaf）');

  const childrenList = await http.call('departments:list(children)', `/departments:list?filter=${encodeURIComponent(JSON.stringify({ parentId: String(parentId) }))}&pageSize=10`, { token: adminToken });
  check('c4', 'dept-http', childrenList.status === 200 && (childrenList.json?.data ?? []).length === 1,
    { status: childrenList.status, count: childrenList.json?.meta?.count ?? childrenList.json?.data?.length }, '父下 children 查询=1');

  const destroyWithChild = await http.call('departments:destroy(带子部门)', `/departments:destroy?filterByTk=${parentId}`, { method: 'POST', token: adminToken });
  check('c5', 'dept-http', destroyWithChild.status === 400,
    { status: destroyWithChild.status, errorCode: destroyWithChild.summary.errorCode }, '400 拒绝（The department has members/children…）');

  const destroyChild = await http.call('departments:destroy(子部门)', `/departments:destroy?filterByTk=${childId}`, { method: 'POST', token: adminToken });
  const parentLeafAfter = psql(DB, `select is_leaf from departments where id=${parentId}`).trim();
  check('c6', 'dept-http', destroyChild.status === 200 && parentLeafAfter === 't',
    { status: destroyChild.status, parentIsLeaf: parentLeafAfter }, '200 且父恢复 leaf');

  // 换父
  const moveParentA = await http.call('departments:create(换父-旧父)', '/departments:create', { method: 'POST', token: adminToken, body: { name: 'HTTP-A', dept_code: 'HTTP-A', status: 'active' } });
  const moveParentB = await http.call('departments:create(换父-新父)', '/departments:create', { method: 'POST', token: adminToken, body: { name: 'HTTP-B', dept_code: 'HTTP-B', status: 'active' } });
  const moveChild = await http.call('departments:create(换父-子)', '/departments:create', { method: 'POST', token: adminToken, body: { name: 'HTTP-C', dept_code: 'HTTP-C', status: 'active', parent: { id: String(moveParentA.json?.data?.id) } } });
  const moveResult = await http.call('departments:update(换父)', `/departments:update?filterByTk=${moveChild.json?.data?.id}`, { method: 'POST', token: adminToken, body: { parent: { id: String(moveParentB.json?.data?.id) } } });
  const oldParentLeaf = psql(DB, `select is_leaf from departments where id=${moveParentA.json?.data?.id}`).trim();
  const newParentLeaf = psql(DB, `select is_leaf from departments where id=${moveParentB.json?.data?.id}`).trim();
  check('c7', 'dept-http', moveResult.status === 200 && oldParentLeaf === 't' && newParentLeaf === 'f',
    { status: moveResult.status, oldParentIsLeaf: oldParentLeaf, newParentIsLeaf: newParentLeaf }, '旧父恢复 leaf / 新父非 leaf');

  // === 阶段 5：四条关联资源 HTTP（非空 + 拒绝） ===
  raw('\n## 阶段 5：四条关联资源 HTTP + members/roles add·remove·set + 有效角色/ACL');
  const rolesListAll = await http.call('roles:list', '/roles:list?pageSize=200', { token: adminToken });
  const deptRole = (rolesListAll.json?.data ?? []).find((r) => r.name === 'cl_reviewer');
  const targetDeptId = parentId;
  const deptRoleCreate = await http.call('roles:create(部门角色)', '/roles:create', { method: 'POST', token: adminToken, body: { name: 'cl_dept_role', title: 'CL Dept Role' } });
  check('d1', 'relations', deptRoleCreate.status === 200 && Boolean(deptRole), { roleCreateStatus: deptRoleCreate.status, rolesCount: rolesListAll.json?.meta?.count ?? rolesListAll.json?.data?.length, hasDeptRole: Boolean(deptRole) }, '200 且角色列表非空');

  const g1 = await http.call('departments/<id>/members:list(before)', `/departments/${targetDeptId}/members:list?pageSize=20`, { token: adminToken });
  const g2 = await http.call('departments/<id>/roles:list(before)', `/departments/${targetDeptId}/roles:list?pageSize=20`, { token: adminToken });
  const g3 = await http.call('roles/<role>/departments:list(before)', `/roles/cl_reviewer/departments:list?pageSize=20`, { token: adminToken });
  const g4 = await http.call('users/<id>/departments:list(before)', `/users/${normalUserId}/departments:list?pageSize=20`, { token: adminToken });
  check('d2', 'relations', [g1, g2, g3, g4].every((r) => r.status === 200),
    { statuses: [g1.status, g2.status, g3.status, g4.status] }, '4 条关联 GET 全 200（对比真实 13000 的 4×500）');

  const membersAdd = await http.call('departments/<id>/members:add', `/departments/${targetDeptId}/members:add`, { method: 'POST', token: adminToken, body: [normalUserId] });
  const g1After = await http.call('departments/<id>/members:list(after add)', `/departments/${targetDeptId}/members:list?pageSize=20`, { token: adminToken });
  const g4After = await http.call('users/<id>/departments:list(after add)', `/users/${normalUserId}/departments:list?pageSize=20`, { token: adminToken });
  const mainDeptAfterAdd = psql(DB, `select coalesce(main_department_id::text,'null') from users where id=${normalUserId}`).trim();
  check('d3', 'relations', membersAdd.status === 200 && (g1After.json?.data ?? []).some((u) => `${u.id}` === `${normalUserId}`) && (g4After.json?.data ?? []).length === 1 && mainDeptAfterAdd === `${targetDeptId}`,
    { addStatus: membersAdd.status, membersAfter: g1After.json?.meta?.count ?? g1After.json?.data?.length, userDepartments: g4After.json?.data?.length, mainDepartmentId: mainDeptAfterAdd },
    'members 非空 + 用户部门反查 1 条 + main_department_id 同步');

  const rolesAdd = await http.call('departments/<id>/roles:add', `/departments/${targetDeptId}/roles:add`, { method: 'POST', token: adminToken, body: ['cl_dept_role'] });
  const g2After = await http.call('departments/<id>/roles:list(after add)', `/departments/${targetDeptId}/roles:list?pageSize=20`, { token: adminToken });
  const g3After = await http.call('roles/cl_dept_role/departments:list(after add)', '/roles/cl_dept_role/departments:list?pageSize=20', { token: adminToken });
  check('d4', 'relations', rolesAdd.status === 200 && (g2After.json?.data ?? []).some((r) => r.name === 'cl_dept_role') && (g3After.json?.data ?? []).length === 1,
    { addStatus: rolesAdd.status, deptRoles: g2After.json?.data?.map?.((r) => r.name), roleDepartments: g3After.json?.data?.length }, '部门角色非空 + 角色反查非空');

  // 有效角色合并 / 切换
  const afterAddCheck = await http.call('auth:check(成员, 无 X-Role)', '/auth:check', { token: normalToken });
  const afterAddRoles = (afterAddCheck.json?.data?.roles ?? []).map((r) => r.name).sort();
  check('d5', 'relations', afterAddCheck.status === 200 && afterAddRoles.includes('cl_reviewer') && afterAddRoles.includes('cl_dept_role'),
    { status: afterAddCheck.status, roles: afterAddRoles }, '自身 ∪ 部门角色合并');

  const switchOwn = await http.call('X-Role=cl_reviewer', '/auth:check', { token: normalToken, role: 'cl_reviewer' });
  const switchDept = await http.call('X-Role=cl_dept_role', '/auth:check', { token: normalToken, role: 'cl_dept_role' });
  const switchInvalid = await http.call('X-Role=admin(未授予)', '/auth:check', { token: normalToken, role: 'admin' });
  check('d6', 'relations', switchOwn.status === 200 && switchDept.status === 200 && switchInvalid.status === 401,
    { ownRole: switchOwn.status, deptRole: switchDept.status, invalidRole: switchInvalid.status, invalidCode: switchInvalid.summary.errorCode }, '200/200/401');

  // 普通用户越权拒绝
  const normalUsersList = await http.call('users:list(普通用户)', '/users:list?pageSize=1', { token: normalToken });
  const normalDeptCreate = await http.call('departments:create(普通用户)', '/departments:create', { method: 'POST', token: normalToken, body: { name: 'NOPE', dept_code: 'NOPE' } });
  check('d7', 'relations', normalUsersList.status === 403 && normalDeptCreate.status === 403,
    { usersList: normalUsersList.status, deptCreate: normalDeptCreate.status }, '403/403 越权拒绝');

  // 部门角色变更的“live 查询”验证：成员仍在，只摘掉部门角色 → 立即 401；加回 → 立即 200
  const roleOff = await http.call('departments/<id>/roles:remove(live)', `/departments/${targetDeptId}/roles:remove`, { method: 'POST', token: adminToken, body: ['cl_dept_role'] });
  const liveRoleOff = await http.call('X-Role=cl_dept_role(role removed)', '/auth:check', { token: normalToken, role: 'cl_dept_role' });
  const roleOn = await http.call('departments/<id>/roles:add(live)', `/departments/${targetDeptId}/roles:add`, { method: 'POST', token: adminToken, body: ['cl_dept_role'] });
  const liveRoleOn = await http.call('X-Role=cl_dept_role(role re-added)', '/auth:check', { token: normalToken, role: 'cl_dept_role' });
  check('d7b', 'relations', roleOff.status === 200 && liveRoleOff.status === 401 && roleOn.status === 200 && liveRoleOn.status === 200,
    { roleRemoved: liveRoleOff.status, roleReAdded: liveRoleOn.status }, '部门角色变更立即生效（live 查询，非陈旧缓存）');

  // 撤销后立即失效
  const membersRemove = await http.call('departments/<id>/members:remove', `/departments/${targetDeptId}/members:remove`, { method: 'POST', token: adminToken, body: [normalUserId] });
  const afterRevokeRole = await http.call('X-Role=cl_dept_role(撤销后)', '/auth:check', { token: normalToken, role: 'cl_dept_role' });
  const mainDeptAfterRemove = psql(DB, `select coalesce(main_department_id::text,'null') from users where id=${normalUserId}`).trim();
  const g1Revoked = await http.call('departments/<id>/members:list(after remove)', `/departments/${targetDeptId}/members:list?pageSize=20`, { token: adminToken });
  check('d8', 'relations', membersRemove.status === 200 && afterRevokeRole.status === 401 && mainDeptAfterRemove === 'null' && (g1Revoked.json?.data ?? []).length === 0,
    { removeStatus: membersRemove.status, revokedRoleStatus: afterRevokeRole.status, mainDepartmentId: mainDeptAfterRemove, membersAfter: g1Revoked.json?.data?.length },
    '撤销后部门角色立即失效 + main_department_id 清空');

  // members:set / roles:set readback
  const membersSet = await http.call('departments/<id>/members:set', `/departments/${targetDeptId}/members:set`, { method: 'POST', token: adminToken, body: [adminUserId] });
  const g1Set = await http.call('departments/<id>/members:list(after set)', `/departments/${targetDeptId}/members:list?pageSize=20`, { token: adminToken });
  const rolesSet = await http.call('departments/<id>/roles:set', `/departments/${targetDeptId}/roles:set`, { method: 'POST', token: adminToken, body: ['cl_dept_role'] });
  const g2Set = await http.call('departments/<id>/roles:list(after set)', `/departments/${targetDeptId}/roles:list?pageSize=20`, { token: adminToken });
  check('d9', 'relations', membersSet.status === 200 && (g1Set.json?.data ?? []).some((u) => `${u.id}` === `${adminUserId}`) && rolesSet.status === 200 && (g2Set.json?.data ?? []).length === 1,
    { membersSet: membersSet.status, membersAfterSet: g1Set.json?.data?.map?.((u) => u.id), rolesSet: rolesSet.status, rolesAfterSet: g2Set.json?.data?.length }, 'set 后 readback 一致');

  // 部门角色删除后角色反查为空
  const rolesRemove = await http.call('departments/<id>/roles:remove', `/departments/${targetDeptId}/roles:remove`, { method: 'POST', token: adminToken, body: ['cl_dept_role'] });
  const g2Rm = await http.call('departments/<id>/roles:list(after remove)', `/departments/${targetDeptId}/roles:list?pageSize=20`, { token: adminToken });
  check('d10', 'relations', rolesRemove.status === 200 && (g2Rm.json?.data ?? []).length === 0,
    { removeStatus: rolesRemove.status, rolesAfterRemove: g2Rm.json?.data?.length }, 'remove 后为空');

  // === 阶段 6：备份/恢复 roundtrip + 失败控制 ===
  raw('\n## 阶段 6：pg_dump 备份/恢复 roundtrip + 失败处理');
  const postDump = pgDump(join(ART, 'post-enable.dump'), DB);
  raw(`  post-enable 备份：${JSON.stringify({ size: postDump.size, sha256: postDump.sha256.slice(0, 16) })}`);
  let restoreOk = false;
  let restoreErr = null;
  try {
    pgRestore(preDump.file, RESTORE_DB);
    restoreOk = true;
  } catch (error) {
    restoreErr = error.message.slice(0, 200);
  }
  const restored = dbSnapshot(RESTORE_DB);
  check('e1', 'backup', restoreOk && restored.tables.departments.columns.every((c) => !['title:character varying', 'is_leaf:boolean', 'sort:bigint'].includes(c))
    && !restored.tables.departments_users.exists && restored.tables.departments.rows === 50
    && restored.checksums.departments === preSnapshot.checksums.departments && restored.checksums.organizations === preSnapshot.checksums.organizations,
    { restored: restoreOk, addedColumnsAfterRestore: restored.tables.departments.columns.filter((c) => !preSnapshot.tables.departments.columns.includes(c)), throughTable: restored.tables.departments_users.exists, deptRows: restored.tables.departments.rows, checksumEqual: restored.checksums.departments === preSnapshot.checksums.departments, err: restoreErr },
    '恢复到安装前结构（无插件新增列/表，50 行校验和一致）');

  // 损坏备份必须失败
  const brokenDump = join(ART, 'broken.dump');
  const dumpBuf = readFileSync(preDump.file);
  writeFileSync(brokenDump, dumpBuf.subarray(0, Math.floor(dumpBuf.length * 0.5)));
  let brokenFailed = false;
  let brokenExit = 0;
  try {
    pgRestore(brokenDump, BAD_DB);
  } catch (error) {
    brokenFailed = true;
    brokenExit = error.status ?? 1;
  }
  check('e2', 'backup', brokenFailed, { restoreOfBrokenDumpFailed: brokenFailed, exitCode: brokenExit }, '非 0 退出（失败可检出）');

  // === 阶段 7：disable 生命周期 ===
  raw('\n## 阶段 7：真实 PluginManager disable 生命周期');
  const beforeDisableSnapshot = dbSnapshot(DB);
  await app.pm.disable('departments');
  const pmDisabled = app.pm.get('departments');
  const recordDisabled = psql(DB, "select enabled::text from application_plugins where name='departments'").trim();
  const afterDisableSnapshot = dbSnapshot(DB);
  const disabledList = await http.call('departments:list(disabled)', '/departments:list?pageSize=1', { token: adminToken });
  const disabledMembers = await http.call('departments/<id>/members:list(disabled)', `/departments/${targetDeptId}/members:list?pageSize=1`, { token: adminToken });
  const disabledRoles = await http.call('departments/<id>/roles:list(disabled)', `/departments/${targetDeptId}/roles:list?pageSize=1`, { token: adminToken });
  check('f1', 'b1-disable', recordDisabled === 'false' && (pmDisabled === undefined || pmDisabled.enabled === false),
    { pluginEnabled: pmDisabled?.enabled ?? null, record: recordDisabled, pluginInstanceAfterReload: pmDisabled ? 'present' : 'absent' }, 'record enabled=false；重启后记录 enabled=false 不加载实例');
  check('f2', 'b1-disable', afterDisableSnapshot.tables.departments.exists && afterDisableSnapshot.tables.departments.rows === beforeDisableSnapshot.tables.departments.rows
    && afterDisableSnapshot.tables.departments.columns.includes('title:character varying') && afterDisableSnapshot.tables.departments_users.exists
    && afterDisableSnapshot.checksums.departments === beforeDisableSnapshot.checksums.departments,
    { columnsRetained: afterDisableSnapshot.tables.departments.columns.includes('title:character varying'), throughRetained: afterDisableSnapshot.tables.departments_users.exists, rows: afterDisableSnapshot.tables.departments.rows, checksumEqual: afterDisableSnapshot.checksums.departments === beforeDisableSnapshot.checksums.departments },
    'disable 不删结构/数据（结构回退必须用 DB 备份）');
  check('f3', 'b1-disable', disabledMembers.status >= 400 && disabledRoles.status >= 400,
    { departmentsListStill: disabledList.status, membersList: disabledMembers.status, rolesList: disabledRoles.status, errorCode: disabledMembers.summary.errorCode },
    '插件关联资源在禁用后不再可用（自定义集合 metadata 仍在，故 departments:list 可继续 200）');

  const emptyDisable = await app.pm.disable('departments').then(() => 'no-throw').catch((e) => `threw:${e.name}`);
  check('f4', 'b1-disable', emptyDisable.startsWith('threw:'), { secondDisable: emptyDisable }, '重复 disable 抛出可检出错误（未加载实例），不静默声称成功');
  const unknownEnable = await app.pm.enable('plugin-does-not-exist-xyz').then(() => 'no-throw').catch((e) => `threw:${e.name}`);
  check('f5', 'b1-disable', unknownEnable.startsWith('threw:'), { unknownEnable }, '未知插件 enable 抛出可检出错误');

  plan.installPlan = {
    dumps: { pre: { file: preDump.file, size: preDump.size, sha256: preDump.sha256 }, post: { file: postDump.file, size: postDump.size, sha256: postDump.sha256 } },
    restoredInto: RESTORE_DB,
  };

  return { app, http, preSnapshot, postSnapshot, afterDisableSnapshot, preCm, postCm, plan };
}

// ---------------------------------------------------------------------------
let ctxRef = null;
try {
  ctxRef = await main();
  const failed = results.filter((r) => !r.ok);
  const summary = {
    generatedAt: new Date().toISOString(),
    mode: '本机受控：真实 2.2.20 Application + 真实隔离 PostgreSQL + 真实 HTTP',
    database: DB,
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    results,
    preview: ctxRef.plan.preview,
    installPlan: ctxRef.plan.installPlan,
  };
  const schemaDiff = {
    generatedAt: new Date().toISOString(),
    pre: ctxRef.preSnapshot,
    post: ctxRef.postSnapshot,
    afterDisable: ctxRef.afterDisableSnapshot,
    collectionManager: { pre: ctxRef.preCm, post: ctxRef.postCm },
  };
  writeEvidence('app-http-chain.json', summary);
  writeEvidence('schema-snapshots.json', schemaDiff);
  writeEvidence('http-calls.json', { generatedAt: new Date().toISOString(), calls: ctxRef.http.calls });
  raw(`\n# 断言：${summary.passed}/${summary.total} 通过，失败 ${summary.failed}`);
  raw(`# 证据：docs/acceptance/full-pages-13000/final-backend-http-evidence/`);
  if (process.env.CL_KEEP_RUNNING === '1') {
    // 预览模式：把 departments 重新启用，让预览服务呈现「已启用 + 合成数据」的可审阅状态。
    // 这一动作与 disable 断言分开记录，不改变上面的断言结果。
    await ctxRef.app.pm.enable('departments');
    const previewState = {
      pluginEnabled: ctxRef.app.pm.get('departments')?.enabled ?? null,
      departments: Number(psql(DB, 'select count(*) from departments').trim()),
      organizations: Number(psql(DB, 'select count(*) from organizations').trim()),
    };
    const ready = {
      generatedAt: new Date().toISOString(), pid: process.pid, http: ctxRef.plan.preview, database: DB,
      pg: `127.0.0.1:${PG_PORT}`, passed: summary.passed, total: summary.total,
      stop: 'node patches/nocobase-2.2.20-departments/tools/app-lab-stop.mjs',
      previewState,
    };
    writeEvidence('preview.json', ready);
    raw(`# 预览保持运行：PID=${process.pid} url=${ctxRef.plan.preview.url}（CL_KEEP_RUNNING=1）`);
    // 保持事件循环
    await new Promise(() => {});
  }
  await ctxRef.http.close();
  await ctxRef.app.db?.close?.();
  writeEvidence('app-http-chain.log', `${rawLines.join('\n')}\n`);
  process.exit(summary.failed === 0 ? 0 : 1);
} catch (error) {
  raw(`\n# FATAL ${error?.name}: ${error?.message}`);
  raw(String(error?.stack).split('\n').slice(0, 12).join('\n'));
  const failed = results.filter((r) => !r.ok);
  writeEvidence('app-http-chain.json', {
    generatedAt: new Date().toISOString(), fatal: `${error?.name}: ${error?.message}`, total: results.length,
    passed: results.length - failed.length, failed: failed.length || 1, results,
    httpCalls: globalThis.__CL_HTTP_CALLS ?? [],
  });
  writeEvidence('app-http-chain.log', `${rawLines.join('\n')}\n`);
  try { await ctxRef?.http?.close?.(); } catch { /* ignore */ }
  try { await ctxRef?.app?.db?.close?.(); } catch { /* ignore */ }
  process.exit(1);
}
