#!/usr/bin/env node
/**
 * 目标 2.2.20 实例（`http://172.16.88.250:13000/api`）**精准必要只读**核对：
 * 部门成员 / 部门角色 / 有效角色候选所需的**结构性事实**。
 *
 * 硬边界（在脚本内实现，不靠文字约定）：
 *  - 目的地固定 172.16.88.250:13000，路径必须在 `/api` 下；
 *  - **本地显式允许清单 + 路径形状校验**：只放行只读元数据/列表；其余在发出前拦截；
 *  - **不以"是 GET"当无写保证**：查询串出现 `updateRead≠false` 直接拦截；
 *  - 不写任何业务/配置/用户/角色/部门数据，不发空体或非法写探针，不调用模型，不 SSH；
 *  - 凭据只在内存里读 `.secrets/full-pages-13000-20261011.json`（0600），不打屏/不进 argv/env/证据；
 *  - 共享证据里**不写**部门/用户/角色的名字或关系明细，只写计数、字段元数据、状态码。
 *
 * 用法：node tools/live-13000-departments-readonly.mjs
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const patchRoot = resolve(here, '..');
const projectRoot = resolve(patchRoot, '../../../..');

const ALLOWED_ORIGIN = 'http://172.16.88.250:13000';
const SECRET_CANDIDATES = [
  process.env.CREWLOOM_13000_SECRETS,
  resolve(projectRoot, '.secrets/full-pages-13000-20261011.json'),
  resolve(patchRoot, '../../.secrets/full-pages-13000-20261011.json'),
].filter(Boolean);

const DEFAULT_OUT = resolve(
  patchRoot,
  '../../docs/acceptance/full-pages-13000/department-candidate-evidence/live-13000-departments.json',
);

/** 允许的 GET 动作（resource:action 形式）。 */
const ALLOWED_GET_ACTIONS = new Set([
  'app:getInfo',
  'authenticators:publicList',
  'auth:check',
  'pm:list',
  'collections:list',
  'collections:get',
  'fields:list',
  'departments:list',
  'departments:get',
  'organizations:list',
  'roles:list',
  'users:list',
  'members:list',
  'aiConversations:getMessages',
]);

/** 允许的路径形状（正则）。用于防止"动作名相同但父资源被换掉"。 */
const ALLOWED_GET_PATHS = [
  /^\/api\/(app:getInfo|authenticators:publicList|auth:check|pm:list)$/,
  /^\/api\/collections:list$/,
  /^\/api\/collections:get$/,
  /^\/api\/collections\/[^/]+\/fields:list$/,
  /^\/api\/departments:list$/,
  /^\/api\/departments:get$/,
  /^\/api\/departments\/[^/]+\/members:list$/,
  /^\/api\/departments\/[^/]+\/roles:list$/,
  /^\/api\/organizations:list$/,
  /^\/api\/roles:list$/,
  /^\/api\/roles\/[^/]+\/departments:list$/,
  /^\/api\/users:list$/,
  /^\/api\/users\/[^/]+\/departments:list$/,
  /^\/api\/aiConversations:getMessages$/,
];

const WRITE_ACTIONS = new Set(['auth:signIn', 'auth:signOut']);
const blocked = [];
const requestLog = [];

function actionOf(pathname) {
  const segs = pathname.split('/').filter(Boolean);
  const last = segs[segs.length - 1] ?? '';
  const colon = last.lastIndexOf(':');
  return colon > 0 ? { resource: last.slice(0, colon), action: last.slice(colon + 1) } : null;
}

function guard(pathOrUrl, { method = 'GET' } = {}) {
  const url = new URL(pathOrUrl, ALLOWED_ORIGIN);
  const upper = method.toUpperCase();
  const record = (reason) => {
    blocked.push({ path: url.pathname, method: upper, reason });
    throw new Error(`transport-blocked: ${upper} ${url.pathname} (${reason})`);
  };
  if (url.origin !== ALLOWED_ORIGIN) record('destination-not-allowed');
  if (!url.pathname.startsWith('/api')) record('path-not-api');
  const parsed = actionOf(url.pathname);
  const key = parsed ? `${parsed.resource}:${parsed.action}` : null;
  if (upper === 'GET') {
    const updateRead = url.searchParams.get('updateRead');
    if (updateRead !== null && updateRead !== 'false') record('get-with-write-param:updateRead');
    if (!key || !ALLOWED_GET_ACTIONS.has(key)) record(`action-not-allowlisted:${key}`);
    if (key === 'aiConversations:getMessages') {
      if (url.searchParams.get('paginate') !== 'false') record('getMessages-paginate-must-be-false');
      if (url.searchParams.get('updateRead') !== 'false') record('getMessages-updateRead-must-be-false');
      if (!url.searchParams.get('sessionId')) record('getMessages-sessionId-required');
    } else if (!ALLOWED_GET_PATHS.some((pattern) => pattern.test(url.pathname))) {
      record('path-shape-not-allowlisted');
    }
  } else if (upper === 'POST') {
    if (!key || !WRITE_ACTIONS.has(key)) record(`post-not-allowed:${key}`);
  } else {
    record('method-not-allowed');
  }
  return { url, key };
}

async function request(fullPath, { method = 'GET', token, authenticator, body } = {}) {
  const { url } = guard(fullPath, { method });
  const headers = { 'Content-Type': 'application/json', 'X-Authenticator': authenticator };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { _nonJson: text.slice(0, 120) };
  }
  requestLog.push({ path: url.pathname, query: url.search, method, status: response.status });
  return { status: response.status, body: parsed };
}

/** 结构性事实：不输出名字，只输出键、类型、计数、空值统计。 */
function describeRows(body) {
  const rows = Array.isArray(body?.data) ? body.data : null;
  if (!rows) return { rows: null };
  const keyCount = {};
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    for (const key of Object.keys(row)) keyCount[key] = (keyCount[key] ?? 0) + 1;
  }
  return {
    rows: rows.length,
    count: typeof body?.meta?.count === 'number' ? body.meta.count : null,
    keyPresence: keyCount,
  };
}

function departmentStructure(body) {
  const rows = Array.isArray(body?.data) ? body.data : [];
  const rootCount = rows.filter((row) => row?.parentId === null || row?.parentId === undefined).length;
  const withParent = rows.filter((row) => row?.parentId !== null && row?.parentId !== undefined).length;
  const statusCounts = {};
  for (const row of rows) {
    const status = String(row?.status ?? '<none>');
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
  }
  return {
    total: rows.length,
    rootCount,
    withParent,
    statusCounts,
    hasDeptCode: rows.every((row) => 'dept_code' in (row ?? {})),
    hasOrganizationId: rows.every((row) => 'organization_id' in (row ?? {})),
    hasPaperTitle: rows.some((row) => 'title' in (row ?? {})),
    hasPaperName: rows.some((row) => 'name' in (row ?? {})),
    idSamplesAreNumericStrings: rows.slice(0, 3).map((row) => typeof row?.id),
  };
}

function fieldMetadata(body) {
  const rows = Array.isArray(body?.data) ? body.data : [];
  return rows
    .map((field) => ({
      name: field?.name ?? null,
      type: field?.type ?? null,
      interface: field?.interface ?? null,
      primaryKey: field?.primaryKey === true || field?.primaryKey,
      allowNull: field?.allowNull ?? null,
      defaultValue: field?.defaultValue ?? null,
      target: field?.target ?? null,
      through: field?.through ?? null,
      foreignKey: field?.foreignKey ?? null,
    }))
    .filter((field) => field.name);
}

function guardSelfTest() {
  const before = blocked.length;
  const cases = [
    { name: 'getMessages updateRead=true 应被拦截', expectBlocked: true, run: () => guard('/api/aiConversations:getMessages?sessionId=x&paginate=false&updateRead=true') },
    { name: 'getMessages updateRead=false 应放行', expectBlocked: false, run: () => guard('/api/aiConversations:getMessages?sessionId=x&paginate=false&updateRead=false') },
    { name: 'POST departments:create 应被拦截', expectBlocked: true, run: () => guard('/api/departments:create', { method: 'POST' }) },
    { name: 'POST departments/1/members:add 应被拦截', expectBlocked: true, run: () => guard('/api/departments/1/members:add', { method: 'POST' }) },
    { name: 'GET 未允许动作 ai:listModels 应被拦截', expectBlocked: true, run: () => guard('/api/ai:listModels') },
    { name: '路径形状不符（伪装的 members:list）应被拦截', expectBlocked: true, run: () => guard('/api/roles/member/members:list') },
    { name: '错误目的地应被拦截', expectBlocked: true, run: () => guard('http://127.0.0.1:13000/api/departments:list') },
  ];
  const results = cases.map((item) => {
    try {
      item.run();
      return { name: item.name, blocked: false, ok: item.expectBlocked === false };
    } catch (error) {
      return { name: item.name, blocked: true, reason: String(error.message), ok: item.expectBlocked === true };
    }
  });
  blocked.length = before;
  return { ok: results.every((item) => item.ok), results };
}

async function main() {
  const evidence = {
    generatedAt: new Date().toISOString(),
    target: ALLOWED_ORIGIN,
    note: '精准必要只读；只记录计数/字段元数据/状态码，不记录部门、用户、角色名称或关系明细。',
    secretPathUsed: null,
    guardSelfTest: null,
    version: null,
    pluginState: null,
    departments: null,
    organizations: null,
    departmentFields: null,
    roles: null,
    associationProbes: [],
    blocked,
    requests: requestLog,
  };

  const secretPath = SECRET_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!secretPath) {
    console.error(`缺少凭据文件（候选：${SECRET_CANDIDATES.join(', ')}）`);
    process.exitCode = 2;
    return;
  }
  evidence.secretPathUsed = secretPath.replace(projectRoot, '<projectRoot>');
  evidence.guardSelfTest = guardSelfTest();
  const secrets = JSON.parse(readFileSync(secretPath, 'utf8'));
  const declared = String(secrets.apiBaseURL).replace(/\/+$/, '').replace(/\/api$/, '');
  if (declared !== ALLOWED_ORIGIN) {
    console.error(`凭据声明的目标 ${declared} 与允许目标 ${ALLOWED_ORIGIN} 不一致；中止。`);
    process.exitCode = 2;
    return;
  }

  let authenticator = 'basic';
  const publicList = await request('/api/authenticators:publicList');
  if (Array.isArray(publicList.body?.data) && publicList.body.data[0]?.name) {
    authenticator = publicList.body.data[0].name;
  }
  const info = await request('/api/app:getInfo');
  evidence.version = { status: info.status, version: info.body?.data?.version ?? null };

  const signIn = await request('/api/auth:signIn', {
    method: 'POST',
    authenticator,
    body: { email: secrets.email, password: secrets.password },
  });
  if (signIn.status !== 200) {
    evidence.signIn = { status: signIn.status };
    finish(evidence);
    process.exitCode = 1;
    return;
  }
  evidence.signIn = { status: signIn.status };
  const token = signIn.body?.data?.token;
  const auth = { token, authenticator };

  // 插件状态：只看与本候选相关的包（不输出整份 packageJson）。
  const pm = await request('/api/pm:list?pageSize=500', auth);
  if (Array.isArray(pm.body?.data)) {
    const names = ['@nocobase/plugin-departments', '@nocobase/plugin-acl', '@nocobase/plugin-users', '@nocobase/plugin-ai'];
    evidence.pluginState = pm.body.data
      .filter((plugin) => names.includes(plugin?.packageName) || names.includes(plugin?.name))
      .map((plugin) => ({
        packageName: plugin?.packageName ?? plugin?.name ?? null,
        version: plugin?.version ?? null,
        enabled: plugin?.enabled ?? null,
        installed: plugin?.installed ?? null,
        builtIn: plugin?.builtIn ?? null,
        isCompatible: plugin?.isCompatible ?? null,
        depsCompatible: plugin?.depsCompatible ?? null,
        removable: plugin?.removable ?? null,
      }));
    evidence.pluginStateTotal = pm.body.data.length;
  } else {
    evidence.pluginState = { status: pm.status };
  }

  const deptList = await request('/api/departments:list?pageSize=200', auth);
  evidence.departments = { status: deptList.status, ...describeRows(deptList.body), structure: departmentStructure(deptList.body) };

  const orgList = await request('/api/organizations:list?pageSize=50', auth);
  evidence.organizations = { status: orgList.status, ...describeRows(orgList.body) };

  const fields = await request('/api/collections/departments/fields:list?pageSize=200', auth);
  evidence.departmentFields = { status: fields.status, fields: fieldMetadata(fields.body) };

  const collections = await request('/api/collections:get?filterByTk=departments', auth);
  evidence.departmentsCollection = {
    status: collections.status,
    keys: collections.body?.data ? Object.keys(collections.body.data).slice(0, 30) : null,
    template: collections.body?.data?.template ?? null,
    titleField: collections.body?.data?.titleField ?? null,
    filterTargetKey: collections.body?.data?.filterTargetKey ?? null,
    autoGenId: collections.body?.data?.autoGenId ?? null,
    migrationRules: collections.body?.data?.migrationRules ?? null,
  };

  const roles = await request('/api/roles:list?pageSize=50', auth);
  evidence.roles = { status: roles.status, ...describeRows(roles.body) };

  // 关联读取：期望当前 500（插件停用）；只记录状态码。
  const firstDeptId = Array.isArray(deptList.body?.data) ? deptList.body.data[0]?.id : null;
  const firstRoleName = Array.isArray(roles.body?.data) ? roles.body.data[0]?.name : null;
  const users = await request('/api/users:list?pageSize=5', auth);
  const firstUserId = Array.isArray(users.body?.data) ? users.body.data[0]?.id : null;

  const probes = [
    ['departments/<id>/members:list', firstDeptId ? `/api/departments/${firstDeptId}/members:list?pageSize=1` : null],
    ['departments/<id>/roles:list', firstDeptId ? `/api/departments/${firstDeptId}/roles:list?pageSize=1` : null],
    ['roles/<role>/departments:list', firstRoleName ? `/api/roles/${encodeURIComponent(firstRoleName)}/departments:list?pageSize=1` : null],
    ['users/<id>/departments:list', firstUserId ? `/api/users/${firstUserId}/departments:list?pageSize=1` : null],
  ];
  for (const [label, path] of probes) {
    if (!path) {
      evidence.associationProbes.push({ label, status: null, skipped: 'no-parent-record' });
      continue;
    }
    const result = await request(path, auth);
    evidence.associationProbes.push({ label, status: result.status, ...describeRows(result.body) });
  }

  const signOut = await request('/api/auth:signOut', { method: 'POST', ...auth });
  evidence.signOut = { status: signOut.status };

  finish(evidence);
  process.exitCode = blocked.length === 0 && evidence.guardSelfTest?.ok ? 0 : 1;
}

function finish(evidence) {
  const out = process.env.CREWLOOM_DEPARTMENTS_EVIDENCE_OUT ?? DEFAULT_OUT;
  evidence.requests = requestLog;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`target=${ALLOWED_ORIGIN} version=${evidence.version?.version} blocked=${blocked.length}`);
  console.log(`pluginState=${JSON.stringify(evidence.pluginState)}`);
  console.log(`departments=${evidence.departments?.count} organizations=${evidence.organizations?.count}`);
  console.log(`departmentFields=${(evidence.departmentFields?.fields ?? []).map((f) => f.name).join(',')}`);
  console.log(`associationProbes=${JSON.stringify(evidence.associationProbes.map((p) => [p.label, p.status]))}`);
  console.log(`guardSelfTest.ok=${evidence.guardSelfTest?.ok}`);
  console.log(`evidence=${out}`);
}

await main();
