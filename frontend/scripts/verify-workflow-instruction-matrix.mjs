#!/usr/bin/env node
/**
 * WF-02/WF-03 第 1 步：**目标 13000 当前 enabled 的全部 instruction 类型**核对。
 *
 * 之前只拿**某一个流程**的 5 种类型当"全部"（真实流程 id 不写进源码），本轮必须回答：
 *   1. 目标实例真实启用了哪些工作流节点插件（`pm:list` 只读）；
 *   2. **所有流程**的 flow_nodes 类型分布（不是单个流程）；
 *   3. 产品原生 registry 实际注册了哪些 instruction（由浏览器侧核对脚本写入，
 *      本脚本读取后合并，见 `--registry`）。
 *
 * 边界（脚本内实现，不靠文字约定）：
 *  - 目的地固定 `http://172.16.88.250:13000`（policy 中的 backendOrigin）；
 *  - 强制 `strict`：只放行允许清单内的只读 GET + 正常 `auth:signIn/signOut`；
 *  - 不新增模型/推理/MCP/通知/工具外呼，不写任何业务数据，不发空体/非法写探针；
 *  - `getMessages` 本脚本不调用；凭据只在进程内存读取，不进 argv/env/日志/证据。
 *
 * 用法：
 *   CREWLOOM_13000_SECRETS=/abs/path/secret.json \
 *     node scripts/verify-workflow-instruction-matrix.mjs
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoBlockedRequests, getRequestCounts, getRequestLog, guardedFetch } from './lib/transport-policy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const SECRET_PATH =
  process.env.CREWLOOM_13000_SECRETS ?? resolve(repoRoot, '.secrets/full-pages-13000-20261011.json');
const OUT = resolve(
  process.env.CREWLOOM_MATRIX_OUT ??
    resolve(repoRoot, 'docs/acceptance/full-pages-13000/final-native-workflow-evidence/instruction-matrix-13000.json'),
);
const REGISTRY_IN = process.env.CREWLOOM_REGISTRY_IN ?? null;
const BACKEND = 'http://172.16.88.250:13000';
const MAX_NODE_PAGES = 20;
const NODE_PAGE_SIZE = 200;

let authenticator = 'basic';

async function request(path, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Authenticator': authenticator };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await guardedFetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    baseOrigin: BACKEND,
    allowedOrigins: [BACKEND],
    policyMode: 'strict',
  });
  const text = await response.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* 保留文本片段 */
  }
  return { status: response.status, body: parsed };
}

function countOf(body) {
  const meta = body?.meta ?? {};
  return typeof meta.count === 'number' ? meta.count : null;
}

function rowsOf(body) {
  return Array.isArray(body?.data) ? body.data : [];
}

/** 读全量 flow_nodes：先拿 count，再按 200/页翻页；超出上限如实记录。 */
async function readAllFlowNodes(token) {
  const first = await request(`/api/flow_nodes:list?pageSize=1`, { token });
  const total = countOf(first.body);
  const nodes = [];
  let page = 1;
  let truncated = false;
  for (; page <= MAX_NODE_PAGES; page += 1) {
    const result = await request(
      `/api/flow_nodes:list?page=${page}&pageSize=${NODE_PAGE_SIZE}&sort=id&fields=id,key,title,type,workflowId,upstreamId,downstreamId,branchIndex`,
      { token },
    );
    if (result.status !== 200) {
      return { total, nodes, truncated: true, errorStatus: result.status, pagesRead: page - 1 };
    }
    const rows = rowsOf(result.body);
    nodes.push(...rows);
    if (rows.length < NODE_PAGE_SIZE) break;
    if (total !== null && nodes.length >= total) break;
  }
  if (total !== null && nodes.length < total) truncated = true;
  return { total, nodes, truncated, pagesRead: Math.min(page, MAX_NODE_PAGES) };
}

async function readAllWorkflows(token) {
  const result = await request(
    '/api/workflows:list?paginate=false&pageSize=500&sort=id&fields=id,key,title,type,enabled,current,sync',
    { token },
  );
  return { status: result.status, rows: rowsOf(result.body), count: countOf(result.body) };
}

/** 目标启用的插件（只读）。返回按状态分类的名称列表，不输出任何配置值。 */
async function readPlugins(token) {
  const result = await request('/api/pm:list?pageSize=500', { token });
  if (result.status !== 200) {
    return { status: result.status, readable: false, plugins: null };
  }
  const rows = rowsOf(result.body);
  return {
    status: result.status,
    readable: true,
    plugins: rows.map((row) => ({
      name: row?.name ?? null,
      packageName: row?.packageName ?? null,
      enabled: row?.enabled === true,
      installed: row?.installed === true,
      version: row?.version ?? null,
    })),
  };
}

function distribution(nodes) {
  const byType = {};
  for (const node of nodes) {
    const type = typeof node?.type === 'string' ? node.type : '(missing)';
    byType[type] = (byType[type] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(byType).sort((a, b) => b[1] - a[1]));
}

function typesByWorkflow(nodes) {
  const map = new Map();
  for (const node of nodes) {
    const id = String(node?.workflowId ?? '(none)');
    if (!map.has(id)) map.set(id, new Set());
    if (typeof node?.type === 'string') map.get(id).add(node.type);
  }
  return Object.fromEntries(
    Array.from(map.entries())
      .sort((a, b) => Number(b[0]) - Number(a[0]))
      .map(([id, set]) => [id, Array.from(set).sort()]),
  );
}

async function main() {
  const evidence = {
    generatedAt: new Date().toISOString(),
    target: BACKEND,
    policyMode: 'strict',
    purpose: '目标 13000 当前 enabled 的全部 instruction 类型 + 所有流程节点分布（只读）',
    version: null,
    signIn: null,
    workflows: null,
    flowNodes: null,
    distribution: null,
    typesByWorkflow: null,
    workflowPlugins: null,
    productRegistry: null,
    requestCounts: null,
  };

  if (!existsSync(SECRET_PATH)) {
    console.error(`缺少凭据文件：${SECRET_PATH}`);
    process.exitCode = 2;
    return;
  }
  const secrets = JSON.parse(readFileSync(SECRET_PATH, 'utf8'));

  const publicList = await request('/api/authenticators:publicList');
  if (Array.isArray(publicList.body?.data) && publicList.body.data[0]?.name) {
    authenticator = publicList.body.data[0].name;
  }
  const info = await request('/api/app:getInfo');
  evidence.version = { status: info.status, version: info.body?.data?.version ?? null };

  const signIn = await request('/api/auth:signIn', {
    method: 'POST',
    body: { email: secrets.email, password: secrets.password },
  });
  evidence.signIn = { status: signIn.status, ok: signIn.status === 200 };
  if (signIn.status !== 200) {
    finish(evidence, 1, 'signIn 未成功，无法继续只读核对');
    return;
  }
  const token = signIn.body?.data?.token;

  const workflows = await readAllWorkflows(token);
  evidence.workflows = {
    status: workflows.status,
    rows: workflows.rows.length,
    enabledCurrent: workflows.rows.filter((row) => row?.enabled === true && row?.current === true).length,
    enabledVersions: workflows.rows.filter((row) => row?.enabled === true).length,
    distinctKeys: new Set(workflows.rows.map((row) => row?.key).filter(Boolean)).size,
    triggerTypes: Array.from(new Set(workflows.rows.map((row) => row?.type).filter(Boolean))).sort(),
  };

  const flowNodes = await readAllFlowNodes(token);
  evidence.flowNodes = {
    metaCount: flowNodes.total,
    read: flowNodes.nodes.length,
    truncated: flowNodes.truncated === true,
    pagesRead: flowNodes.pagesRead,
    errorStatus: flowNodes.errorStatus ?? null,
  };
  evidence.distribution = distribution(flowNodes.nodes);
  evidence.typesByWorkflow = typesByWorkflow(flowNodes.nodes);

  const plugins = await readPlugins(token);
  evidence.workflowPlugins = plugins.readable
    ? {
        status: plugins.status,
        readable: true,
        total: plugins.plugins.length,
        enabled: plugins.plugins.filter((item) => item.enabled).length,
        enabledNames: plugins.plugins
          .filter((item) => item.enabled)
          .map((item) => item.name)
          .sort(),
        disabledNames: plugins.plugins
          .filter((item) => !item.enabled)
          .map((item) => item.name)
          .sort(),
        workflowPlugins: plugins.plugins
          .filter((item) => String(item.packageName ?? item.name ?? '').includes('workflow'))
          .map((item) => ({ packageName: item.packageName, name: item.name, enabled: item.enabled, version: item.version }))
          .sort((a, b) => String(a.packageName).localeCompare(String(b.packageName))),
        notificationManager: plugins.plugins.find((item) => item.name === 'notification-manager') ?? null,
      }
    : { status: plugins.status, readable: false, workflowPlugins: null };

  if (REGISTRY_IN && existsSync(REGISTRY_IN)) {
    evidence.productRegistry = JSON.parse(readFileSync(REGISTRY_IN, 'utf8'));
  }

  const ok = workflows.status === 200 && flowNodes.total !== null;
  finish(evidence, ok ? 0 : 1, ok ? null : '工作流/节点读取未成功');
}

function finish(evidence, exitCode, message) {
  evidence.finishedAt = new Date().toISOString();
  evidence.requestLog = getRequestLog();
  evidence.requestCounts = getRequestCounts();
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`);
  assertNoBlockedRequests();
  const types = evidence.distribution ? Object.entries(evidence.distribution) : [];
  console.log(
    `instruction 矩阵：版本 ${evidence.version?.version ?? '?'}，流程版本 ${evidence.workflows?.rows ?? '?'}，` +
      `节点 ${evidence.flowNodes?.read ?? '?'}/${evidence.flowNodes?.metaCount ?? '?'}，` +
      `类型 ${types.map(([type, count]) => `${type}:${count}`).join(' ') || '无'}；` +
      `请求 ${evidence.requestCounts?.allowed ?? '?'} 放行 / ${evidence.requestCounts?.blocked ?? '?'} 拦截；证据：${OUT}`,
  );
  if (message) console.error(message);
  process.exitCode = exitCode;
}

await main();
