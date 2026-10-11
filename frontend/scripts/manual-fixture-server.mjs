#!/usr/bin/env node
/**
 * TD-02 人工表单：**本机合成 fixture HTTP 服务**（推荐 5402）。
 *
 * 用途：给「电脑端为主」的人工验收提供**真实 HTTP** 的合成后端。
 * Vite（preview/dev）用 `CREWLOOM_BACKEND_ORIGIN=http://127.0.0.1:<port>` 把
 * `/api`、`/files` 代理指向本服务；验收方在内置浏览器里用**真实页面**（登录页、
 * 待办列表、处理表单、动作按钮）亲自操作，不注入任何隐藏状态或脚本。
 *
 * 硬边界：
 *  - 只监听 127.0.0.1，只应答 `/api/*` 与 `/files/*`；**不做任何外呼**，
 *    未支持的接口在本机返回 501，绝不回退到真实 13000 或任何其它后端；
 *  - 数据全部来自 `scripts/lib/manual-fixture.mjs`（与 CI 的 28 条断言同一份）；
 *  - 口令/令牌都是本机合成值，不是真实 13000 账号。
 *
 * 用法：
 *   node scripts/manual-fixture-server.mjs            # 127.0.0.1:5402
 *   CREWLOOM_FIXTURE_PORT=5402 CREWLOOM_APP_URL=http://127.0.0.1:5323 \
 *     node scripts/manual-fixture-server.mjs
 *   node scripts/manual-fixture-server.mjs --check     # 自检后退出（不常驻）
 *
 * 可见控制页：http://127.0.0.1:5402/control
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FIXTURE_ACCOUNTS,
  FIXTURE_TASK_IDS,
  bumpFixtureEpoch,
  createFixtureState,
  fixtureTaskStates,
  markFixtureTaskProcessed,
  resetFixtureState,
  respondFixture,
} from './lib/manual-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CREWLOOM_FIXTURE_PORT ?? 5402);
const HOST = process.env.CREWLOOM_FIXTURE_HOST ?? '127.0.0.1';
const APP_URL = process.env.CREWLOOM_APP_URL ?? 'http://127.0.0.1:5323';
const MAX_LOG = 200;

/** 验收环境状态：启用验收独有端点，未支持接口本机 501。 */
const state = createFixtureState({ acceptanceUi: true, unknownPolicy: 'error' });

function log(line) {
  process.stdout.write(`[fixture] ${line}\n`);
}

function recordRequest(method, action, code) {
  state.requests.push({ at: new Date().toISOString(), method: method.toUpperCase(), action, code });
  if (state.requests.length > MAX_LOG) state.requests.splice(0, state.requests.length - MAX_LOG);
  log(`${method.toUpperCase()} ${action} -> ${code}`);
}

function sendJson(res, code, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    ...extraHeaders,
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function controlStatePayload() {
  return {
    fixtureUrl: `http://${HOST}:${PORT}`,
    appUrl: APP_URL,
    epoch: state.epoch,
    submitted: state.submitted,
    submittedAt: state.submittedAt,
    requests: state.requests.slice(-40).reverse(),
    unsupported: state.unsupported.slice(-40).reverse(),
    /** 合成任务当前状态：提交成功会真的把原任务改成"已处理"（重置可恢复）。 */
    taskStates: fixtureTaskStates(state),
    tasks: [
      { key: 'pending', label: '待处理（可填写/可提交）', id: FIXTURE_TASK_IDS.pending, note: '提交成功后这条任务在本机也变为"已处理"：重开即只读回显，待办列表与统计同步减少（重置恢复）。' },
      { key: 'processed', label: '已处理（只读回显）', id: FIXTURE_TASK_IDS.processed, note: '金额 256 / 日期 2026-10-11 / 类别差旅 / 会签人张三 / 编号 T-100。' },
      { key: 'conflict', label: '并发冲突（提交 409）', id: FIXTURE_TASK_IDS.conflict, note: '提交被本机 409 拒绝；页面保留已填内容并提示可显式刷新。要验证"刷新后看到别人的只读结果"，先点下方"标记冲突任务已处理"，再回页面点"刷新查看最新状态"。' },
      { key: 'otherAssignee', label: '另一受理人（只读隔离）', id: FIXTURE_TASK_IDS.otherAssignee, note: '任务受理人是别人（合成 userId=99，且没有对应姓名记录）：字段禁用、动作不渲染，页面说明"由其他人处理"。' },
      { key: 'submitted', label: '本机刚提交的结果（只读回读）', id: FIXTURE_TASK_IDS.submitted, note: '未提交前本机 404；提交一次后回读刚写入的合成结果。' },
    ],
    accounts: FIXTURE_ACCOUNTS.map((item) => ({ email: item.email, password: item.password, nickname: item.nickname, note: item.note })),
  };
}

function serveControl(res) {
  try {
    const html = readFileSync(join(here, 'manual-fixture-control.html'), 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  } catch (error) {
    sendJson(res, 500, { errors: [{ code: 'CONTROL_PAGE_MISSING', message: String(error?.message ?? error) }] });
  }
}

const server = createServer(async (req, res) => {
  const method = String(req.method ?? 'GET').toLowerCase();
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  const pathname = url.pathname;

  if (method === 'options') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type,authorization,x-role,x-authenticator',
    });
    res.end();
    return;
  }

  if (pathname === '/healthz') {
    sendJson(res, 200, { ok: true, epoch: state.epoch, requests: state.requests.length, unsupported: state.unsupported.length });
    return;
  }
  if (pathname === '/control' || pathname === '/') {
    serveControl(res);
    return;
  }
  if (pathname === '/control/state') {
    sendJson(res, 200, controlStatePayload());
    return;
  }
  if (pathname === '/control/reset' && method === 'post') {
    resetFixtureState(state);
    log('合成数据已重置（提交记录与请求日志清空；令牌世代不变）');
    sendJson(res, 200, controlStatePayload());
    return;
  }
  if (pathname === '/control/reset-all' && method === 'post') {
    resetFixtureState(state);
    state.epoch += 1;
    log('合成数据与令牌世代均已重置（需要重新登录）');
    sendJson(res, 200, controlStatePayload());
    return;
  }
  if (pathname === '/control/epoch' && method === 'post') {
    bumpFixtureEpoch(state);
    log(`令牌世代 -> ${state.epoch}（旧会话令牌立即 401）`);
    sendJson(res, 200, controlStatePayload());
    return;
  }
  if (pathname === '/control/resolve-conflict' && method === 'post') {
    // 模拟"冲突任务已被（别人/另一个会话）处理完成"：只改本机合成任务状态，不动用户填写。
    markFixtureTaskProcessed(state, FIXTURE_TASK_IDS.conflict, {
      formA: {
        amount: 120,
        category: 'meal',
        code: '',
        urgent: false,
        spentAt: '2026-10-10',
        reviewers: [{ id: 7, nickname: '李四' }],
      },
      _: 'approve',
    });
    log('冲突任务已标记为"已处理（他人/别处完成）"：刷新该任务即只读回显 120；重置可恢复。');
    sendJson(res, 200, controlStatePayload());
    return;
  }

  // 真实后端路径：/api/**（应用）与 /files/**（附件、标志图）。只在本机应答。
  if (pathname.startsWith('/api/')) {
    const action = pathname.replace(/^\/api\//, '');
    const captured = {};
    if (method === 'post' || method === 'put' || method === 'patch') {
      const body = await readBody(req);
      if (action.startsWith('workflowManualTasks:submit')) captured.submitPostData = body;
      if (action.startsWith('auth:signIn')) captured.signInBody = body;
    }
    const { code, body } = respondFixture({ method, url: `http://${HOST}:${PORT}${req.url}`, headers: req.headers }, state, captured);
    recordRequest(method, action, code);
    if (code === 200 && action.startsWith('workflowManualTasks:submit')) {
      log(`收到合成提交：${JSON.stringify(state.submitted)}`);
    }
    if (code === 501) log(`未支持接口被本机拒绝（不外呼）：${action}`);
    // 明确标记"应答来自本机合成 fixture"，便于一眼确认代理没有回退到真实后端。
    sendJson(res, code, body, { 'x-crewloom-fixture': '1' });
    return;
  }
  if (pathname.startsWith('/files/')) {
    recordRequest(method, pathname, 404);
    sendJson(res, 404, { errors: [{ code: 'FIXTURE_NO_FILES', message: '本机合成 fixture 不提供附件文件，也不会外呼。' }], data: null });
    return;
  }

  recordRequest(method, pathname, 404);
  sendJson(res, 404, { errors: [{ code: 'FIXTURE_NOT_FOUND', message: `本机合成 fixture 只应答 /api/** 与 /control：${pathname}` }], data: null });
});

server.listen(PORT, HOST, () => {
  log(`TD-02 合成 fixture 已启动：http://${HOST}:${PORT}`);
  log(`控制页（可见按钮）：http://${HOST}:${PORT}/control`);
  log(`应用地址（由 Vite 提供）：${APP_URL}`);
  log(`合成账号：${FIXTURE_ACCOUNTS.map((item) => `${item.email} / ${item.password}`).join('，')}`);
  log('未支持的接口只在本机 501；本进程不做任何外呼。');
  if (process.argv.includes('--check')) void runSelfCheck();
});

/**
 * `--check`：本进程自检（只打本机 fixture，不碰任何真实后端）。
 * 覆盖：合成登录 → 身份 → 可见列表 → 待处理/已处理/冲突/非受理人 → 合成提交与回读
 * → 未支持接口 501 → 令牌世代 401 → /files 本机 404 → 控制页可用。
 */
async function runSelfCheck() {
  const base = `http://${HOST}:${PORT}`;
  const results = [];
  const check = (name, ok, note = '') => {
    results.push({ name, ok, note });
    log(`SELFCHECK ${ok ? 'PASS' : 'FAIL'} ${name}${note ? ` — ${note}` : ''}`);
  };
  const call = async (path, options = {}) => {
    const response = await fetch(`${base}${path}`, options);
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body };
  };
  const jsonPost = (payload) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  try {
    const health = await call('/healthz');
    check('本机 fixture /healthz 可用', health.status === 200 && health.body?.ok === true);

    const account = FIXTURE_ACCOUNTS[0];
    const signIn = await call('/api/auth:signIn', jsonPost({ email: account.email, password: account.password }));
    const token = signIn.body?.data?.token;
    check('合成账号可登录（本机 200 + 令牌）', signIn.status === 200 && typeof token === 'string', `${account.email} → ${signIn.status}`);

    const bad = await call('/api/auth:signIn', jsonPost({ email: account.email, password: 'wrong' }));
    check('错误口令被本机 401 拒绝（不外呼）', bad.status === 401, String(bad.body?.errors?.[0]?.code ?? ''));

    const auth = { authorization: `Bearer ${token}` };
    const who = await call('/api/auth:check', { headers: auth });
    check('auth:check 返回合成身份', who.status === 200 && who.body?.data?.nickname === account.nickname, String(who.body?.data?.nickname));

    const list = await call('/api/workflowManualTasks:listMine?page=1&pageSize=20', { headers: auth });
    const rows = list.body?.data ?? [];
    check('可见待办列表含合成任务 id=7', list.status === 200 && rows.some((row) => Number(row.id) === FIXTURE_TASK_IDS.pending), `${rows.length} 行`);

    const pending = await call(`/api/workflowManualTasks:get?filterByTk=${FIXTURE_TASK_IDS.pending}`, { headers: auth });
    check('待处理任务带回原生 schema', pending.status === 200 && pending.body?.data?.node?.config?.schema?.block1?.properties?.formA, String(pending.body?.data?.node?.title ?? ''));
    check(
      '待处理任务带回真实受理人关联（userId → user.nickname）',
      pending.body?.data?.userId === account.id && pending.body?.data?.user?.nickname === account.nickname,
      `userId=${pending.body?.data?.userId} user=${JSON.stringify(pending.body?.data?.user ?? null)}`,
    );

    const processed = await call(`/api/workflowManualTasks:get?filterByTk=${FIXTURE_TASK_IDS.processed}`, { headers: auth });
    check('已处理任务回显 256 / 2026-10-11 / 张三', processed.body?.data?.result?.formA?.amount === 256 && processed.body?.data?.result?.formA?.spentAt === '2026-10-11' && processed.body?.data?.result?.formA?.reviewers?.[0]?.nickname === '张三');

    const other = await call(`/api/workflowManualTasks:get?filterByTk=${FIXTURE_TASK_IDS.otherAssignee}`, { headers: auth });
    check(
      '非受理人任务 userId=99（只读隔离；受理人只看任务 userId，jobs 无 userId 字段）',
      other.body?.data?.userId === 99 && other.body?.data?.job?.userId === undefined,
      `userId=${other.body?.data?.userId} job.userId=${other.body?.data?.job?.userId}`,
    );
    check(
      '非受理人没有姓名记录时 user 关联如实为 null（不伪造姓名）',
      other.body?.data?.user === null,
      JSON.stringify(other.body?.data?.user ?? null),
    );

    const conflict = await call(`/api/workflowManualTasks:submit?filterByTk=${FIXTURE_TASK_IDS.conflict}`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ result: { formA: {} }, _: 'approve' }),
    });
    check('冲突任务提交被本机 409 拒绝', conflict.status === 409, String(conflict.body?.errors?.[0]?.code ?? ''));
    const conflictAfter = await call(`/api/workflowManualTasks:get?filterByTk=${FIXTURE_TASK_IDS.conflict}`, { headers: auth });
    check(
      '409 冲突后任务仍是待处理（不编造状态，用户可继续填写）',
      conflictAfter.body?.data?.status === 0 && conflictAfter.body?.data?.result === null,
      `status=${conflictAfter.body?.data?.status}`,
    );

    const submit = await call(`/api/workflowManualTasks:submit?filterByTk=${FIXTURE_TASK_IDS.pending}`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ result: { formA: { amount: 256, spentAt: '2026-10-11', category: 'travel', code: 'T-100', urgent: true, reviewers: [{ id: 3, nickname: '张三' }] }, _: 'approve' } }),
    });
    check('待处理任务提交 200（只写合成数据）', submit.status === 200 && state.submitted?.result?.formA?.amount === 256);

    const pendingAfterSubmit = await call(`/api/workflowManualTasks:get?filterByTk=${FIXTURE_TASK_IDS.pending}`, { headers: auth });
    check(
      '提交成功后原任务 7 变为已处理并带回提交结果',
      pendingAfterSubmit.body?.data?.status === 1 && pendingAfterSubmit.body?.data?.result?.formA?.amount === 256,
      `status=${pendingAfterSubmit.body?.data?.status}`,
    );

    const statusFilter = encodeURIComponent(JSON.stringify({ status: 0 }));
    const listAfter = await call(`/api/workflowManualTasks:listMine?page=1&pageSize=20&filter=${statusFilter}`, { headers: auth });
    const rowsAfter = listAfter.body?.data ?? [];
    check(
      '提交成功后"待处理"列表不再包含已处理的 7（真实 listMine + status 过滤）',
      listAfter.status === 200 && !rowsAfter.some((row) => Number(row.id) === FIXTURE_TASK_IDS.pending),
      `${rowsAfter.length} 行`,
    );

    const statsAfter = await call('/api/userWorkflowTaskStats:listMine?page=1&pageSize=200', { headers: auth });
    const statsRow = (statsAfter.body?.data ?? [])[0];
    check(
      '本人待办统计按合成用户实时计算（提交后 pending=1 / all=3）',
      statsAfter.status === 200 && statsRow?.stats?.pending === 1 && statsRow?.stats?.all === 3,
      JSON.stringify(statsRow?.stats ?? null),
    );

    const readBack = await call(`/api/workflowManualTasks:get?filterByTk=${FIXTURE_TASK_IDS.submitted}`, { headers: auth });
    check('本机刚提交的结果可只读回读', readBack.status === 200 && readBack.body?.data?.result?.formA?.amount === 256, String(readBack.body?.data?.status));

    const forbidden = await call(`/api/workflowManualTasks:submit?filterByTk=${FIXTURE_TASK_IDS.otherAssignee}`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ result: { formA: { amount: 1 }, _: 'approve' } }),
    });
    check('非受理人提交被本机 403 拒绝（不伪造成功）', forbidden.status === 403, String(forbidden.status));

    const lisi = FIXTURE_ACCOUNTS[1];
    const lisiSignIn = await call('/api/auth:signIn', jsonPost({ email: lisi.email, password: lisi.password }));
    const lisiToken = lisiSignIn.body?.data?.token;
    const lisiAuth = { authorization: `Bearer ${lisiToken}` };
    const lisiList = await call(`/api/workflowManualTasks:listMine?page=1&pageSize=20&filter=${statusFilter}`, { headers: lisiAuth });
    check(
      '另一合成账号（李四）的待办列表为空（身份隔离）',
      lisiList.status === 200 && (lisiList.body?.data ?? []).length === 0,
      `${(lisiList.body?.data ?? []).length} 行`,
    );
    const lisiStats = await call('/api/userWorkflowTaskStats:listMine?page=1&pageSize=200', { headers: lisiAuth });
    check(
      '另一合成账号（李四）的待办统计为空（不再返回假 2）',
      lisiStats.status === 200 && (lisiStats.body?.data ?? []).length === 0,
      `${(lisiStats.body?.data ?? []).length} 行`,
    );

    const unknown = await call('/api/definitelyNotSupported:list', { headers: auth });
    check('未支持接口本机 501（不外呼）', unknown.status === 501, String(unknown.body?.errors?.[0]?.code ?? ''));

    // Main 反馈的已知缺口：正常登录后应用壳读 `collections:get?filterByTk=users` 判断头像能力。
    // 现在按真实契约从同一份合成元数据应答；未知集合仍走本机 501。
    const usersMeta = await call('/api/collections:get?filterByTk=users&appends%5B%5D=fields', { headers: auth });
    check(
      'collections:get 复用合成元数据应答 users（含 appends=fields 的字段清单）',
      usersMeta.status === 200 && usersMeta.body?.data?.name === 'users' && Array.isArray(usersMeta.body?.data?.fields),
      `status=${usersMeta.status} name=${usersMeta.body?.data?.name} fields=${(usersMeta.body?.data?.fields ?? []).length}`,
    );
    const expensesMeta = await call('/api/collections:get?filterByTk=expenses', { headers: auth });
    check(
      'collections:get 未带 appends 时不返回字段清单（按真实契约）',
      expensesMeta.status === 200 && expensesMeta.body?.data?.name === 'expenses' && expensesMeta.body?.data?.fields === undefined,
      `status=${expensesMeta.status} fields=${JSON.stringify(expensesMeta.body?.data?.fields)}`,
    );
    const unknownMeta = await call('/api/collections:get?filterByTk=notInFixture', { headers: auth });
    check(
      'collections:get 未知集合仍本机 501（不 blanket success）',
      unknownMeta.status === 501,
      `status=${unknownMeta.status}`,
    );

    const files = await call('/files/main/main/attachments/1.png', { headers: auth });
    check('/files 本机 404（不外呼）', files.status === 404);

    const control = await fetch(`${base}/control`);
    const html = await control.text();
    const controlState = await call('/control/state');
    check(
      '可见控制页可用（打开表单按钮 + 状态接口含合成账号）',
      control.status === 200 &&
        html.includes('打开表单') &&
        html.includes('/control/state') &&
        (controlState.body?.accounts ?? []).some((item) => item.email === account.email),
    );
    check(
      '控制页可见"标记冲突任务已处理"入口与任务状态',
      html.includes('标记冲突任务已处理') &&
        (controlState.body?.taskStates ?? []).some((item) => item.id === FIXTURE_TASK_IDS.conflict),
    );

    await call('/control/resolve-conflict', { method: 'POST' });
    const resolved = await call(`/api/workflowManualTasks:get?filterByTk=${FIXTURE_TASK_IDS.conflict}`, { headers: auth });
    check(
      '控制页标记后冲突任务变为只读结果（刷新可看到别人的 120）',
      resolved.body?.data?.status === 1 && resolved.body?.data?.result?.formA?.amount === 120,
      `status=${resolved.body?.data?.status}`,
    );

    const reset = await call('/control/reset', { method: 'POST' });
    check('重置合成数据清空提交记录', reset.status === 200 && state.submitted === null);
    const pendingReset = await call(`/api/workflowManualTasks:get?filterByTk=${FIXTURE_TASK_IDS.pending}`, { headers: auth });
    check(
      '重置后原任务 7 恢复待处理（可 visibleReset 恢复）',
      pendingReset.body?.data?.status === 0 && pendingReset.body?.data?.result === null,
      `status=${pendingReset.body?.data?.status}`,
    );

    const before = state.epoch;
    await call('/control/epoch', { method: 'POST' });
    const stale = await call('/api/auth:check', { headers: auth });
    check('令牌世代变更后旧会话 401', state.epoch === before + 1 && stale.status === 401, `epoch ${before} → ${state.epoch}`);
  } catch (error) {
    check('自检未抛异常', false, String(error?.message ?? error));
  }

  const failed = results.filter((item) => !item.ok);
  log(`SELFCHECK 结果：${results.length - failed.length}/${results.length} 通过`);
  server.close(() => process.exit(failed.length === 0 ? 0 : 1));
  setTimeout(() => process.exit(failed.length === 0 ? 0 : 1), 1500).unref();
}
