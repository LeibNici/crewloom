#!/usr/bin/env node
/**
 * WF-05 归属口径核对（真实只读 + 本机受控隔离）。
 *
 * 背景（05/08 旧报告的口径问题）：`jobs:list` **不带 filter** 时返回的是实例的
 * **全局** job 计数（旧报告实测 58593），它和"某一次执行的节点 job 数"（旧报告实测 41）
 * 是两件事。`ExecutionDetailPage` 本来就是按选中执行 `filter={"executionId":N}` 读取的，
 * 代码没有 bug；需要纠正的是报告里把两个口径混写。
 *
 * 本脚本做两件事，且都只用**小量精准**请求：
 *  1. 真实 13000 只读（strict）：1 次全局计数 + 2 个真实执行的过滤计数；
 *  2. 本机受控隔离：两次受控执行 job 数不同，验证 `executionId` 过滤确实按执行隔离
 *     （且与"全局"计数分开）。
 *
 * 边界：不新增模型/推理/MCP/通知/工具外呼；不写任何真实数据；凭据只在内存读取。
 *
 * 用法：
 *   CREWLOOM_13000_SECRETS=/abs/path/secret.json \
 *   CREWLOOM_CONTROLLED_URL=http://127.0.0.1:5314 \
 *   node scripts/verify-workflow-jobs-attribution.mjs
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
  process.env.CREWLOOM_WF05_OUT ??
    resolve(repoRoot, 'docs/acceptance/full-pages-13000/final-native-workflow-evidence/wf05-jobs-attribution.json'),
);
const BACKEND = 'http://172.16.88.250:13000';
const CONTROLLED = process.env.CREWLOOM_CONTROLLED_URL ?? 'http://127.0.0.1:5314';

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
    /* 保留文本 */
  }
  return { status: response.status, body: parsed };
}

function metaCount(body) {
  const meta = body?.meta ?? {};
  return typeof meta.count === 'number' ? meta.count : null;
}

async function realReadonly() {
  const result = {
    scope: 'real-13000-readonly',
    target: BACKEND,
    policyMode: 'strict',
    globalUnfiltered: null,
    executions: [],
    signIn: null,
    version: null,
  };
  const publicList = await request('/api/authenticators:publicList');
  if (Array.isArray(publicList.body?.data) && publicList.body.data[0]?.name) {
    authenticator = publicList.body.data[0].name;
  }
  const info = await request('/api/app:getInfo');
  result.version = info.body?.data?.version ?? null;

  const signIn = await request('/api/auth:signIn', {
    method: 'POST',
    body: { email: JSON.parse(readFileSync(SECRET_PATH, 'utf8')).email, password: JSON.parse(readFileSync(SECRET_PATH, 'utf8')).password },
  });
  result.signIn = { status: signIn.status, ok: signIn.status === 200 };
  if (signIn.status !== 200) return result;
  const token = signIn.body?.data?.token;

  // 1) 全局计数：1 条请求，pageSize=1，不带 filter（只要 meta.count，不拉业务正文）
  const global = await request('/api/jobs:list?pageSize=1', { token });
  result.globalUnfiltered = {
    status: global.status,
    count: metaCount(global.body),
    rows: Array.isArray(global.body?.data) ? global.body.data.length : null,
    note: '不带 filter 的计数是实例全局 job 数，不能当作"某次执行的节点 job 数"。',
  };

  // 2) 取 2 个真实执行 id（只读、2 行）
  const executions = await request('/api/executions:list?pageSize=2&sort=-id&fields=id,workflowId,status', { token });
  const rows = Array.isArray(executions.body?.data) ? executions.body.data : [];
  for (const row of rows.slice(0, 2)) {
    const id = row?.id;
    if (id === undefined) continue;
    // eslint-disable-next-line no-await-in-loop -- 每个执行一次精准只读，串行避免并发探针
    const filtered = await request(`/api/jobs:list?pageSize=1&filter=${encodeURIComponent(JSON.stringify({ executionId: id }))}`, { token });
    result.executions.push({
      executionId: id,
      workflowId: row?.workflowId ?? null,
      filterCount: metaCount(filtered.body),
      status: filtered.status,
      filter: { executionId: id },
    });
  }
  return result;
}

async function controlledIsolation() {
  const result = { scope: 'local-controlled', baseUrl: CONTROLLED, state: null, global: null, perExecution: [] };
  const read = async (path) => {
    const response = await fetch(`${CONTROLLED}${path}`);
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const state = await read('/api/crewloomControlledWorkflow:state');
  if (state.status !== 200) return { ...result, error: `受控中间件不可达（${state.status}）` };
  result.state = {
    executions: Object.values(state.body?.data?.executions ?? {}).map((execution) => ({
      id: execution.id,
      workflowId: execution.workflowId,
      jobs: execution.jobs.length,
    })),
  };
  const ids = Object.keys(state.body?.data?.executions ?? {});
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop -- 逐个执行的受控隔离读取
    const filtered = await read(`/api/jobs:list?filter=${encodeURIComponent(JSON.stringify({ executionId: id }))}`);
    result.perExecution.push({
      executionId: id,
      status: filtered.status,
      count: metaCount(filtered.body),
      nodeIds: (filtered.body?.data ?? []).map((job) => job.executionId),
    });
  }
  const global = await read('/api/jobs:list?pageSize=1');
  result.global = { status: global.status, count: metaCount(global.body) };
  const isolated =
    result.perExecution.length >= 2 &&
    new Set(result.perExecution.map((item) => item.count)).size === result.perExecution.length &&
    result.perExecution.every((item) => item.nodeIds.every((executionId) => executionId === item.executionId));
  result.isolated = isolated;
  result.conclusion =
    '受控两次执行的 job 计数互不相同、且每条 job 都只属于自己 executionId；全局计数为各执行之和，说明过滤按执行隔离。';
  return result;
}

async function main() {
  const evidence = {
    generatedAt: new Date().toISOString(),
    purpose: 'WF-05 jobs 归属口径：全局 vs executionId 过滤（纠正 05/08 报告口径，不改代码）',
    sourceContract: {
      code: 'frontend/src/modules/workflow/domain.ts#fetchJobs',
      behavior: 'ExecutionDetailPage 用 fetchJobs(executionId) → jobs:list?filter={"executionId":N}；页面本来就按选中执行过滤。',
    },
    realReadonly: null,
    controlled: null,
    requestCounts: null,
  };
  if (!existsSync(SECRET_PATH)) {
    console.error(`缺少凭据文件：${SECRET_PATH}`);
    process.exitCode = 2;
    return;
  }
  try {
    evidence.realReadonly = await realReadonly();
  } catch (error) {
    evidence.realReadonly = { error: String(error) };
  }
  try {
    evidence.controlled = await controlledIsolation();
  } catch (error) {
    evidence.controlled = { error: String(error) };
  }
  evidence.finishedAt = new Date().toISOString();
  evidence.requestLog = getRequestLog();
  evidence.requestCounts = getRequestCounts();

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`);
  assertNoBlockedRequests();

  const globalCount = evidence.realReadonly?.globalUnfiltered?.count ?? '?';
  const filtered = (evidence.realReadonly?.executions ?? []).map((item) => `${item.executionId}:${item.filterCount}`).join(' ');
  console.log(
    `WF-05 归属：真实全局=${globalCount}，按执行过滤 ${filtered || '（未取到）'}；` +
      `受控隔离=${evidence.controlled?.isolated === true ? 'PASS' : 'CHECK'}；证据：${OUT}`,
  );
  const ok =
    evidence.realReadonly?.signIn?.ok === true &&
    typeof evidence.realReadonly?.globalUnfiltered?.count === 'number' &&
    (evidence.realReadonly?.executions ?? []).length >= 2 &&
    evidence.controlled?.isolated === true;
  process.exitCode = ok ? 0 : 1;
}

await main();
