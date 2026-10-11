#!/usr/bin/env node
/**
 * 13000 部署前检（**只读**）：正常 web auth + 精准 RO。
 *
 * 目的（本轮任务 1/3/4/7 中**只读可得**的部分）：
 *  - 复核目标 app 版本、关键插件 enabled/installed/version（departments / field-sort / ai / auth / users / acl / backups…）；
 *  - 复核 departments / organizations / users / roles 的 collection 元数据与字段形状（不默认 through 不存在、不默认空）；
 *  - 复核既有计数（departments / organizations / users / roles / collections / workflows / executions）；
 *  - 记录 4 条关联 GET 的**当前**状态（真实 13000 当前应为 500），作为 B1 enable 前的 pre-state 基线；
 *  - `backups:list` 只读探测平台备份能力是否存在（不创建备份）。
 *
 * 硬边界（脚本内实现）：
 *  - 目的地固定 `http://172.16.88.250:13000`，路径必须在 `/api` 下；
 *  - 显式允许清单 + 路径形状校验；非允许动作在发出前拦截；
 *  - 只允许 GET（+ 仅 `auth:signIn` 的 POST）；任何写动作、`updateRead≠false`、模型/MCP/工作流执行/上传全部拦截；
 *  - 凭据只在内存读 `.secrets/full-pages-13000-20261011.json`（0600），不打屏、不进 argv/env、不进证据；
 *  - 公开证据只写计数/类型/状态码/字段名；**不含**部门/用户/角色名或任何业务值；
 *  - 原始响应体只写本树 `.work/13000-preflight-20261011/raw/`（gitignore）。
 *
 * 用法：node tools/backend-deployment-preflight.mjs [--guard-only]
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
].filter(Boolean);

const WORK = resolve(patchRoot, '.work/13000-preflight-20261011');
const RAW = resolve(WORK, 'raw');
// 证据目录落在**本工作树**内（root 仓库的 docs 不在本会话可写范围，且 PM 文档不由本组改）
const EVIDENCE = resolve(patchRoot, '../../docs/acceptance/full-pages-13000/backend-deployment-preflight-evidence');

const ALLOWED_GET_ACTIONS = new Set([
  'app:getInfo', 'authenticators:publicList', 'auth:check', 'pm:list',
  'collections:list', 'collections:get', 'fields:list',
  'departments:list', 'departments:get', 'organizations:list',
  'roles:list', 'users:list', 'workflows:list', 'executions:list', 'backups:list',
  'members:list',
]);
const ALLOWED_GET_PATHS = [
  /^\/api\/(app:getInfo|authenticators:publicList|auth:check|pm:list|collections:list|collections:get|departments:list|departments:get|organizations:list|roles:list|users:list|workflows:list|executions:list|backups:list)$/,
  /^\/api\/collections\/[^/]+\/fields:list$/,
  /^\/api\/departments\/[^/]+\/members:list$/,
  /^\/api\/departments\/[^/]+\/roles:list$/,
  /^\/api\/roles\/[^/]+\/departments:list$/,
  /^\/api\/users\/[^/]+\/departments:list$/,
];
const WRITE_ACTIONS = new Set(['auth:signIn']);

const blocked = [];
const requestLog = [];
const rawDir = RAW;

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
    if (!ALLOWED_GET_PATHS.some((pattern) => pattern.test(url.pathname))) record('path-shape-not-allowlisted');
  } else if (upper === 'POST') {
    if (!key || !WRITE_ACTIONS.has(key)) record(`post-not-allowed:${key}`);
  } else {
    record('method-not-allowed');
  }
  return { url, key };
}

async function request(fullPath, { method = 'GET', token, authenticator, body, saveAs } = {}) {
  const { url } = guard(fullPath, { method });
  const headers = { 'Content-Type': 'application/json' };
  if (authenticator) headers['X-Authenticator'] = authenticator;
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = { _nonJson: text.slice(0, 120) }; }
  requestLog.push({ path: url.pathname, query: url.search, method, status: response.status, bytes: text.length });
  if (saveAs) {
    mkdirSync(rawDir, { recursive: true });
    writeFileSync(resolve(rawDir, saveAs), text);
  }
  return { status: response.status, body: parsed };
}

/** 无业务名的字段元数据。 */
function fieldsOf(body) {
  const rows = Array.isArray(body?.data) ? body.data : [];
  return rows
    .map((f) => ({
      name: f?.name ?? null,
      type: f?.type ?? null,
      interface: f?.interface ?? null,
      primaryKey: f?.primaryKey === true,
      allowNull: f?.allowNull ?? null,
      target: f?.target ?? null,
      through: f?.through ?? null,
      foreignKey: f?.foreignKey ?? null,
      unique: f?.unique === true,
    }))
    .filter((f) => f.name)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function summarizeAssociation(status, body) {
  return {
    status,
    dataIsArray: Array.isArray(body?.data),
    dataLength: Array.isArray(body?.data) ? body.data.length : null,
    count: typeof body?.meta?.count === 'number' ? body.meta.count : null,
    errorCode: body?.errors?.[0]?.code ?? (typeof body?.errors?.[0]?.message === 'string' ? body.errors[0].message.slice(0, 90) : null),
  };
}

function guardSelfTest() {
  const before = blocked.length;
  const cases = [
    { name: 'POST backups:create 应被拦截', expectBlocked: true, run: () => guard('/api/backups:create', { method: 'POST' }) },
    { name: 'POST departments:create 应被拦截', expectBlocked: true, run: () => guard('/api/departments:create', { method: 'POST' }) },
    { name: 'POST departments/1/members:add 应被拦截', expectBlocked: true, run: () => guard('/api/departments/1/members:add', { method: 'POST' }) },
    { name: 'GET 未允许动作 ai:listModels 应被拦截', expectBlocked: true, run: () => guard('/api/ai:listModels') },
    { name: 'GET aiConversations:getMessages 缺 updateRead=false 应被拦截', expectBlocked: true, run: () => guard('/api/aiConversations:getMessages?sessionId=x&paginate=false') },
    { name: '路径形状不符（伪装的 members:list）应被拦截', expectBlocked: true, run: () => guard('/api/roles/member/members:list') },
    { name: '错误目的地应被拦截', expectBlocked: true, run: () => guard('http://127.0.0.1:13000/api/departments:list') },
    { name: 'GET 允许的 backups:list 应放行', expectBlocked: false, run: () => guard('/api/backups:list?pageSize=1') },
    { name: 'GET 允许的 collections/<x>/fields:list 应放行', expectBlocked: false, run: () => guard('/api/collections/departments/fields:list') },
  ];
  const results = cases.map((item) => {
    try { item.run(); return { name: item.name, blocked: false, ok: item.expectBlocked === false }; }
    catch (error) { return { name: item.name, blocked: true, reason: String(error.message), ok: item.expectBlocked === true }; }
  });
  blocked.length = before;
  return { ok: results.every((r) => r.ok), results };
}

const INTERESTING_PLUGINS = new Set([
  'departments', 'field-sort', 'ai', 'auth', 'users', 'acl', 'error-handler',
  'data-source-main', 'data-source-manager', 'backups', 'workflow', 'workflow-manual', 'ui-schema-storage',
]);

const guardOnly = process.argv.includes('--guard-only');

async function main() {
  mkdirSync(WORK, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(),
    target: ALLOWED_ORIGIN,
    mode: '只读前检（正常 web auth + 精准 RO）；未安装/未启用/未重启/未打补丁/未创建备份',
    guardSelfTest: guardSelfTest(),
    secretPathUsed: null,
    version: null,
    plugins: null,
    schema: {},
    counts: {},
    associationPreState: [],
    workflowState: {},
    backupsProbe: null,
    blocked,
    requests: requestLog,
  };

  if (guardOnly) {
    writeSummary(summary);
    console.log(JSON.stringify({ guardSelfTest: summary.guardSelfTest }, null, 2));
    return 0;
  }

  const secretPath = SECRET_CANDIDATES.find((c) => existsSync(c));
  if (!secretPath) {
    console.error('缺少授权登录文件（只允许 .secrets/full-pages-13000-20261011.json）');
    summary.blocked.push({ path: '-', method: '-', reason: 'authorized-secret-file-missing' });
    writeSummary(summary);
    return 2;
  }
  summary.secretPathUsed = secretPath.replace(projectRoot, '<projectRoot>');
  const secrets = JSON.parse(readFileSync(secretPath, 'utf8'));
  const declared = String(secrets.apiBaseURL ?? '').replace(/\/+$/, '').replace(/\/api$/, '');
  if (declared !== ALLOWED_ORIGIN) {
    console.error('授权文件声明的目标与允许目标不一致；中止');
    writeSummary(summary);
    return 2;
  }

  // 1) 公共认证列表 + app 版本
  const publicList = await request('/api/authenticators:publicList', { saveAs: 'authenticators-publicList.json' });
  const authenticator = Array.isArray(publicList.body?.data) && publicList.body.data[0]?.name ? publicList.body.data[0].name : 'basic';
  const info = await request('/api/app:getInfo', { saveAs: 'app-getInfo.json' });
  summary.version = { status: info.status, version: info.body?.data?.version ?? null };

  // 2) 正常 web 登录（唯一 POST）
  const signIn = await request('/api/auth:signIn', {
    method: 'POST', authenticator, saveAs: 'auth-signIn.json',
    body: { email: secrets.email, password: secrets.password },
  });
  const token = signIn.body?.data?.token ?? null;
  summary.signIn = { status: signIn.status, tokenPresent: Boolean(token) };
  if (!token) { writeSummary(summary); return 1; }

  const authCheck = await request('/api/auth:check', { token, saveAs: 'auth-check.json' });
  summary.authCheck = { status: authCheck.status, roleCount: Array.isArray(authCheck.body?.data?.roles) ? authCheck.body.data.roles.length : null };

  // 3) 关键插件状态
  const pmList = await request('/api/pm:list?pageSize=500', { token, saveAs: 'pm-list.json' });
  const plugins = Array.isArray(pmList.body?.data) ? pmList.body.data : [];
  summary.plugins = {
    status: pmList.status,
    total: typeof pmList.body?.meta?.count === 'number' ? pmList.body.meta.count : plugins.length,
    enabled: plugins.filter((p) => p?.enabled === true).length,
    selected: plugins
      .filter((p) => INTERESTING_PLUGINS.has(p?.name))
      .map((p) => ({ name: p.name, version: p.version ?? null, enabled: p.enabled === true, installed: p.installed === true, isCompatible: p.isCompatible ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };

  // 4) collection 元数据 + 字段形状
  const collectionsList = await request('/api/collections:list?pageSize=1', { token, saveAs: 'collections-list.json' });
  summary.counts.collections = typeof collectionsList.body?.meta?.count === 'number' ? collectionsList.body.meta.count : null;

  for (const name of ['departments', 'organizations', 'users', 'roles']) {
    const meta = await request(`/api/collections:get?filterByTk=${name}`, { token, saveAs: `collections-get-${name}.json` });
    const fields = await request(`/api/collections/${name}/fields:list?pageSize=300`, { token, saveAs: `collections-${name}-fields.json` });
    const d = meta.body?.data ?? {};
    summary.schema[name] = {
      metaStatus: meta.status,
      present: meta.status === 200 && Boolean(d.name ?? d.key),
      template: d.template ?? null,
      tree: d.tree ?? null,
      autoGenId: d.autoGenId ?? null,
      titleField: d.titleField ?? null,
      filterTargetKey: d.filterTargetKey ?? null,
      migrationRules: d.migrationRules ?? null,
      fieldsStatus: fields.status,
      fields: fieldsOf(fields.body),
    };
  }
  // B1 新增列/关系字段在 users/roles 上的碰撞检查
  const userFieldNames = (summary.schema.users?.fields ?? []).map((f) => f.name);
  const roleFieldNames = (summary.schema.roles?.fields ?? []).map((f) => f.name);
  summary.b1Collision = {
    usersHasMainDepartmentIdField: userFieldNames.includes('mainDepartmentId'),
    usersHasMainDepartmentField: userFieldNames.includes('mainDepartment'),
    usersHasDepartmentsField: userFieldNames.includes('departments'),
    rolesHasDepartmentsField: roleFieldNames.includes('departments'),
    departmentsHasTitleField: (summary.schema.departments?.fields ?? []).some((f) => f.name === 'title'),
    departmentsHasIsLeafField: (summary.schema.departments?.fields ?? []).some((f) => f.name === 'is_leaf' || f.name === 'isLeaf'),
    departmentsHasSortField: (summary.schema.departments?.fields ?? []).some((f) => f.name === 'sort'),
    departmentsHasMembersField: (summary.schema.departments?.fields ?? []).some((f) => f.name === 'members'),
    departmentsHasRolesField: (summary.schema.departments?.fields ?? []).some((f) => f.name === 'roles'),
    note: 'API 只能看 collection-manager 元数据；through 物理表/列/FK/唯一约束/既有行无法由 API 判定，必须 DB 只读前检',
  };

  // 5) 既有计数
  for (const [key, path] of [
    ['departments', '/api/departments:list?pageSize=1'],
    ['organizations', '/api/organizations:list?pageSize=1'],
    ['users', '/api/users:list?pageSize=1'],
    ['roles', '/api/roles:list?pageSize=1'],
    ['workflows', '/api/workflows:list?pageSize=1'],
    ['executions', '/api/executions:list?pageSize=1'],
  ]) {
    const res = await request(path, { token, saveAs: `count-${key}.json` });
    summary.counts[key] = typeof res.body?.meta?.count === 'number' ? res.body.meta.count : (Array.isArray(res.body?.data) ? res.body.data.length : null);
    summary.counts[`${key}Status`] = res.status;
  }

  // 6) 4 条关联 GET 的当前 pre-state（B1 enable 前基线）
  const deptList = await request('/api/departments:list?pageSize=1', { token });
  const firstDeptId = deptList.body?.data?.[0]?.id ?? null;
  const roleList = await request('/api/roles:list?pageSize=1', { token });
  const firstRoleName = roleList.body?.data?.[0]?.name ?? null;
  const userList = await request('/api/users:list?pageSize=1', { token });
  const firstUserId = userList.body?.data?.[0]?.id ?? null;
  const probes = [
    ['departments/<id>/members:list', firstDeptId ? `/api/departments/${firstDeptId}/members:list?pageSize=1` : null],
    ['departments/<id>/roles:list', firstDeptId ? `/api/departments/${firstDeptId}/roles:list?pageSize=1` : null],
    ['roles/<role>/departments:list', firstRoleName ? `/api/roles/${encodeURIComponent(firstRoleName)}/departments:list?pageSize=1` : null],
    ['users/<id>/departments:list', firstUserId ? `/api/users/${firstUserId}/departments:list?pageSize=1` : null],
  ];
  for (const [label, path] of probes) {
    if (!path) { summary.associationPreState.push({ label, status: null, note: 'no-id-available' }); continue; }
    const res = await request(path, { token, saveAs: `assoc-${label.replace(/[^a-z]+/gi, '-')}.json` });
    summary.associationPreState.push({ label, ...summarizeAssociation(res.status, res.body) });
  }

  // 7) 维护窗口相关：工作流/执行状态 + 平台备份只读探测
  const latestExec = await request('/api/executions:list?pageSize=1&sort=-id&fields[]=id&fields[]=status&fields[]=createdAt', { token, saveAs: 'executions-latest.json' });
  // EXECUTION_STATUS 来源：@nocobase/plugin-workflow dist/common/executionStatus.js（STARTED=0, RESOLVED=1, QUEUEING=null）
  const startedExec = await request(`/api/executions:list?pageSize=1&filter=${encodeURIComponent(JSON.stringify({ status: 0 }))}`, { token, saveAs: 'executions-started.json' });
  summary.workflowState = {
    workflows: summary.counts.workflows,
    executions: summary.counts.executions,
    latestExecutionStatus: latestExec.body?.data?.[0]?.status ?? null,
    startedExecutionsCount: typeof startedExec.body?.meta?.count === 'number' ? startedExec.body.meta.count : null,
    startedQueryStatus: startedExec.status,
    executionStatusEnumSource: '@nocobase/plugin-workflow dist/common/executionStatus.js（vendored 2.2.22；STARTED=0, RESOLVED=1, QUEUEING=null）',
    note: '只读计数；未执行任何流程、未调用 flow.test/execute。started=0 的过滤返回非 500 即证明该枚举在目标可用',
  };
  const backups = await request('/api/backups:list?pageSize=1', { token, saveAs: 'backups-list.json' });
  summary.backupsProbe = {
    status: backups.status,
    readable: backups.status === 200,
    count: typeof backups.body?.meta?.count === 'number' ? backups.body.meta.count : null,
    note: '只读探测平台备份能力；本轮未创建任何备份',
  };

  writeSummary(summary);
  console.log(`preflight done: version=${summary.version.version} plugins=${summary.plugins.selected.length} assoc=${summary.associationPreState.map((a) => a.status).join('/')}`);
  console.log(`evidence: ${EVIDENCE}`);
  return 0;
}

function writeSummary(summary) {
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(resolve(EVIDENCE, 'preflight-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(resolve(WORK, 'preflight-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
}

process.exitCode = await main();
