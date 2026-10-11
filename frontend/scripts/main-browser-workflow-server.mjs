#!/usr/bin/env node
/**
 * 电脑端**工作流（WF-01..05）+ 模型配置（LM-01..05）验收环境**：纯本机合成后端 HTTP 服务
 * （默认 `127.0.0.1:5410`）。
 *
 * 用途：给「主模型内置浏览器（电脑端优先）」的真实验收提供**完全本机**的后端：
 * 产品前端（`vite preview`，默认 5329）把 `/api`、`/files` 代理到本服务；本服务
 * **只监听 127.0.0.1**，对 `/api/**`、`/files/**`、控制页与未知路径全部在**本进程内**应答，
 * **绝不做任何外呼**，也绝不回退真实 13000。
 *
 * 分层（能复用就不重写）：
 *  1. 本文件：HTTP 外壳、请求记录、控制页 API、未知路由 501/404、`--check` 自检；
 *  2. `scripts/lib/controlled-workflow-middleware.mjs`：**原样复用**工作流读写状态机
 *     （`workflows:get`、`flow_nodes:list|get`、`nodes:create`、`flow_nodes:update|move|
 *     duplicate|destroy|destroyBranch|test`），本服务与 `vite.config.ts` 的受控插件
 *     用**同一个** store 工厂；
 *  3. `scripts/lib/main-browser-workflow-fixture.mjs`：中间件之外、但产品页面真实会发的动作
 *     （流程列表过滤分页 / 分类 / 创建 / 改名 / 启停 / 删除 / 复制版本 / 执行记录与详情 /
 *     作业读取）+ 全部 LM 动作；
 *  4. `scripts/lib/manual-fixture.mjs`：合成登录、令牌世代、应用壳元数据、`users:list`
 *     ——**原样复用**（不改它的字节）。
 *
 * 可见控制页：http://127.0.0.1:5410/control
 *
 * 用法：
 *   node scripts/main-browser-workflow-server.mjs                     # 127.0.0.1:5410
 *   CREWLOOM_WORKFLOW_PORT=5410 CREWLOOM_APP_URL=http://127.0.0.1:5329 \
 *     node scripts/main-browser-workflow-server.mjs
 *   node scripts/main-browser-workflow-server.mjs --check             # 自检后退出
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import {
  CONTROLLED_WORKFLOW_IDS,
  createControlledWorkflowMiddleware,
  createControlledWorkflowStore,
} from './lib/controlled-workflow-middleware.mjs';
import {
  FIXTURE_ACCOUNTS,
  bumpFixtureEpoch,
  createFixtureState,
  resetFixtureState,
  resolveFixtureSession,
  respondFixture,
} from './lib/manual-fixture.mjs';
import {
  createModelState,
  modelLocal,
  modelSelfSummary,
  resetModelState,
  seedWorkflowStore,
  workflowLocal,
  workflowSelfSummary,
} from './lib/main-browser-workflow-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const HOST = process.env.CREWLOOM_WORKFLOW_HOST ?? '127.0.0.1';
const PORT = Number(process.env.CREWLOOM_WORKFLOW_PORT ?? 5410);
const APP_URL = process.env.CREWLOOM_APP_URL ?? 'http://127.0.0.1:5329';
const MAX_LOG = 400;

/** 应用壳 / 合成登录 / users:list（复用 manual-fixture；未知动作本机 501）。 */
const fixtureState = createFixtureState({ acceptanceUi: true, unknownPolicy: 'error' });
/** 工作流 store：与中间件共用同一个实例，本文件补的动作也读写它。 */
const workflowStore = seedWorkflowStore(createControlledWorkflowStore());
/** 受控工作流中间件（原样复用）。 */
const controlledWorkflow = createControlledWorkflowMiddleware({ store: workflowStore });
/** LM 合成状态。 */
const modelState = createModelState();

const requests = [];
const denied = [];
const unsupported = [];

function log(line) {
  process.stdout.write(`[wf-5410] ${line}\n`);
}

function record(entry) {
  requests.push({ at: new Date().toISOString(), ...entry });
  if (requests.length > MAX_LOG) requests.splice(0, requests.length - MAX_LOG);
}

function readHeader(headers, name) {
  if (!headers) return '';
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === lower) return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
  }
  return '';
}

function sendJson(res, code, payload, extraHeaders = {}) {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    // 一眼确认应答来自本机合成后端（代理没有回退真实后端）。
    'x-crewloom-local': '1',
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

/* ------------------------------------------------------------------ *
 * 受控工作流中间件：只捕获、不直写真实响应
 * ------------------------------------------------------------------ */

function makeMiddlewareRequest({ method, url, headers, rawBody }) {
  const stream = Readable.from(rawBody && rawBody.length ? [rawBody] : []);
  stream.method = method;
  stream.url = url;
  stream.headers = headers ?? {};
  return stream;
}

function captureResponse() {
  let sent = false;
  const chunks = [];
  const headers = {};
  const res = {
    statusCode: 200,
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = value;
    },
    getHeader(name) {
      return headers[String(name).toLowerCase()];
    },
    removeHeader(name) {
      delete headers[String(name).toLowerCase()];
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      sent = true;
    },
    write(chunk) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return true;
    },
  };
  return {
    res,
    get sent() {
      return sent;
    },
    get status() {
      return res.statusCode;
    },
    get body() {
      return chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
    },
  };
}

/** 运行中间件；只在本机内存里搭建 req/res，不接触真实 socket。 */
async function runControlledWorkflow({ method, url, headers, rawBody }) {
  const req = makeMiddlewareRequest({ method, url, headers, rawBody });
  const capture = captureResponse();
  let nexted = false;
  await controlledWorkflow(req, capture.res, () => {
    nexted = true;
  });
  return { handled: capture.sent, status: capture.status, body: capture.body, nexted };
}

/* ------------------------------------------------------------------ *
 * /api 分发
 * ------------------------------------------------------------------ */

/**
 * 登录门（与 manual-fixture 的验收语义一致，但提前到本文件最前面）。
 *
 * 为什么必须在这里也做一次：工作流 / 模型两层的分发在 `respondFixture` **之前**，
 * 如果不先判会话，未登录的 `workflows:list` 会被工作流层直接答成 200，
 * 等于绕过合成登录。这里保证"没登录就是没登录"。
 */
const PUBLIC_ACTIONS = new Set([
  'authenticators:publicList',
  'auth:signIn',
  'auth:signOut',
  'auth:syncCookies',
  'app:getInfo',
  'app:getLang',
  'systemSettings:get',
  'storages:getBasicInfo',
]);

async function dispatchApi(req, res, { action, url, method, headers, rawBody, values }) {
  const ctx = { method, url, headers, values, rawBody };

  // 0) 登录门：公开动作放行；过期令牌 401 EXPIRED_TOKEN；没有有效令牌 401 EMPTY_TOKEN。
  if (!PUBLIC_ACTIONS.has(action)) {
    const session = resolveFixtureSession(fixtureState, headers);
    if (session.stale) {
      record({ method, action, code: 401, note: 'EXPIRED_TOKEN' });
      sendJson(res, 401, {
        errors: [{ code: 'EXPIRED_TOKEN', message: '合成会话世代已变更（epoch），请重新登录。' }],
        data: null,
      });
      return;
    }
    if (!session.account) {
      record({ method, action, code: 401, note: 'EMPTY_TOKEN' });
      sendJson(res, 401, {
        errors: [{ code: 'EMPTY_TOKEN', message: '未登录：请在本机 fixture 上用合成账号登录。' }],
        data: null,
      });
      return;
    }
  }

  // 1) 工作流补充分发（列表/分类/创建/启停/删除/复制/执行记录/作业 + 原生宿主附属读）。
  const wf = workflowLocal(action, ctx, workflowStore);
  if (wf) {
    record({ method, action, code: wf.code, layer: 'workflow-fixture' });
    sendJson(res, wf.code, wf.body);
    return;
  }

  // 2) 模型配置（LM-01..05）：全部本机应答，`ai:testFlight` 不产生任何费用。
  const lm = modelLocal(action, ctx, modelState);
  if (lm) {
    record({ method, action, code: lm.code, layer: 'model-fixture' });
    sendJson(res, lm.code, lm.body);
    return;
  }

  // 3) 受控工作流中间件（复用）：`workflows:get` / `flow_nodes:*` / `nodes:create` / 自测场景。
  const controlled = await runControlledWorkflow({ method, url, headers, rawBody });
  if (controlled.handled) {
    record({ method, action, code: controlled.status, layer: 'controlled-workflow' });
    sendJson(res, controlled.status, safeJson(controlled.body));
    return;
  }

  // 4) manual-fixture：合成登录 / 令牌世代 / 应用壳元数据 / users:list / collections:list。
  const captured = {};
  if (method !== 'GET' && rawBody) {
    const text = rawBody.toString('utf8');
    if (action.startsWith('auth:signIn')) captured.signInBody = text;
  }
  const result = respondFixture(
    { method: method.toLowerCase(), url: `http://${HOST}:${PORT}${url}`, headers },
    fixtureState,
    captured,
  );

  const fixture501 =
    result.code === 501 && Array.isArray(result.body?.errors) && result.body.errors[0]?.code === 'FIXTURE_UNSUPPORTED';
  if (fixture501) {
    unsupported.push(`${method} ${action}`);
    if (unsupported.length > MAX_LOG) unsupported.splice(0, unsupported.length - MAX_LOG);
    record({ method, action, code: 501, note: '未支持（本机 501，不外呼）' });
    log(`未支持接口只在本机 501：${method} ${action}`);
    sendJson(res, 501, {
      errors: [
        {
          code: 'SYNTH_UNSUPPORTED',
          message: `本机合成环境不支持 ${action}；不会外呼真实后端。请在控制页查看未支持清单，或补进本机应答。`,
        },
      ],
      data: null,
    });
    return;
  }

  record({ method, action, code: result.code, layer: 'manual-fixture' });
  sendJson(res, result.code, result.body);
}

function safeJson(text) {
  if (!text) return { data: null };
  try {
    return JSON.parse(text);
  } catch {
    return { data: null };
  }
}

/* ------------------------------------------------------------------ *
 * /files 分发（本环境没有附件能力，一律本机 404，不外呼）
 * ------------------------------------------------------------------ */

function dispatchFiles(res, pathname) {
  sendJson(res, 404, {
    errors: [
      {
        code: 'SYNTH_NO_FILE',
        message: `本机合成环境没有这个附件：${pathname}（合成环境不取真实附件，也不外呼）。`,
      },
    ],
    data: null,
  });
}

/* ------------------------------------------------------------------ *
 * 控制页与 /control API（可见；不是产品 UI）
 * ------------------------------------------------------------------ */

const WORKFLOW_SCENARIOS = [
  { key: 'success', text: '节点自测·成功', note: '原生 `flow_nodes:test` 返回 `{data:{status:1,result,log}}`；result 回显提交的 type/config。' },
  { key: 'failure', text: '节点自测·失败', note: '返回 `{data:{status:-1,result:null,log}}`，原生渲染「失败」。' },
  { key: 'permission', text: '节点自测·无权限', note: '返回 403；页面文案应是中文权限提示，不是 `Request failed with status code 403`。' },
  { key: 'error', text: '节点自测·内部错误', note: '返回 500；页面文案应是中文内部错误提示。' },
];

function controlState() {
  return {
    serverUrl: `http://${HOST}:${PORT}`,
    appUrl: APP_URL,
    /** 令牌世代（manual-fixture）：变更后旧令牌 401 EXPIRED_TOKEN → 需要重新登录。 */
    tokenEpoch: fixtureState.epoch,
    accounts: FIXTURE_ACCOUNTS.map((item) => ({
      email: item.email,
      password: item.password,
      nickname: item.nickname,
      note: item.note,
    })),
    workflow: workflowSelfSummary(workflowStore),
    workflowScenarios: WORKFLOW_SCENARIOS,
    model: modelSelfSummary(modelState),
    pages: [
      { label: '流程列表（WF-01）', url: `${APP_URL}/workflow/list` },
      { label: '执行记录（WF-04）', url: `${APP_URL}/workflow/executions` },
      { label: '执行详情（WF-05）', url: `${APP_URL}/workflow/execution?id=920005` },
      { label: '流程编排画布（WF-02/03）', url: `${APP_URL}/workflow/canvas?workflowId=${CONTROLLED_WORKFLOW_IDS.DRAFT_ID}` },
      { label: '画布·已执行版本', url: `${APP_URL}/workflow/canvas?workflowId=${CONTROLLED_WORKFLOW_IDS.EXECUTED_ID}` },
      { label: '模型服务列表（LM-01）', url: `${APP_URL}/model/services` },
      { label: '服务配置（LM-02）', url: `${APP_URL}/model/services/synth-deepseek` },
      { label: '可用模型（LM-03）', url: `${APP_URL}/model/models` },
      { label: '默认与员工模型（LM-04）', url: `${APP_URL}/model/defaults` },
      { label: '配置验证（LM-05）', url: `${APP_URL}/model/verify` },
    ],
    syntheticIds: {
      draft: CONTROLLED_WORKFLOW_IDS.DRAFT_ID,
      executed: CONTROLLED_WORKFLOW_IDS.EXECUTED_ID,
      other: CONTROLLED_WORKFLOW_IDS.OTHER_ID,
      draft2: CONTROLLED_WORKFLOW_IDS.DRAFT2_ID,
      wide: CONTROLLED_WORKFLOW_IDS.WIDE_ID,
      executions: Object.keys(workflowStore.executions),
    },
    requests: requests.slice(-70).reverse(),
    denied: denied.slice(-30).reverse(),
    unsupported: unsupported.slice(-40).reverse(),
  };
}

function serveControl(res) {
  try {
    const html = readFileSync(join(here, 'main-browser-workflow-control.html'), 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-crewloom-local': '1' });
    res.end(html);
  } catch (error) {
    sendJson(res, 500, { errors: [{ code: 'CONTROL_PAGE_MISSING', message: String(error?.message ?? error) }] });
  }
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** 把受控工作流 store 重置为初始受控数据（保持同一个 store 实例，中间件继续指向它）。 */
function resetWorkflowStore() {
  const fresh = seedWorkflowStore(createControlledWorkflowStore());
  for (const key of Object.keys(workflowStore)) delete workflowStore[key];
  Object.assign(workflowStore, fresh);
}

async function handleControl(req, res, { pathname, method }) {
  if (pathname === '/control' || pathname === '/') {
    serveControl(res);
    return true;
  }
  if (pathname === '/control/state') {
    sendJson(res, 200, controlState());
    return true;
  }
  if (!pathname.startsWith('/control/')) return false;

  const body = method === 'POST' ? await readJsonBody(req) : {};

  if (pathname === '/control/reset') {
    // 保留令牌世代（不把验收方踢下线），只清合成写入 / 日志 / 未支持清单。
    resetFixtureState(fixtureState);
    resetWorkflowStore();
    resetModelState(modelState);
    requests.length = 0;
    denied.length = 0;
    unsupported.length = 0;
    log('合成数据已重置（令牌世代不变）');
    sendJson(res, 200, controlState());
    return true;
  }
  if (pathname === '/control/reset-all') {
    resetFixtureState(fixtureState);
    resetWorkflowStore();
    resetModelState(modelState);
    requests.length = 0;
    denied.length = 0;
    unsupported.length = 0;
    bumpFixtureEpoch(fixtureState);
    log(`合成数据与令牌世代均已重置（epoch → ${fixtureState.epoch}，需要重新登录）`);
    sendJson(res, 200, controlState());
    return true;
  }
  if (pathname === '/control/token-epoch') {
    bumpFixtureEpoch(fixtureState);
    log(`令牌世代 → ${fixtureState.epoch}（旧令牌立即 401 EXPIRED_TOKEN，需要重新登录）`);
    sendJson(res, 200, controlState());
    return true;
  }
  if (pathname === '/control/workflow/scenario') {
    const next = ['success', 'failure', 'permission', 'error'].includes(body.test) ? body.test : 'success';
    workflowStore.testScenario = next;
    log(`节点自测场景 → ${next}`);
    sendJson(res, 200, controlState());
    return true;
  }
  if (pathname === '/control/workflow/reset') {
    resetWorkflowStore();
    log('受控工作流数据已重置（令牌世代不变）');
    sendJson(res, 200, controlState());
    return true;
  }
  if (pathname === '/control/model/scenario') {
    modelState.testScenario = body.test === 'failure' ? 'failure' : 'success';
    log(`试飞场景 → ${modelState.testScenario}（始终本机应答，零费用）`);
    sendJson(res, 200, controlState());
    return true;
  }
  if (pathname === '/control/model/reset') {
    resetModelState(modelState);
    log('模型配置合成数据已重置');
    sendJson(res, 200, controlState());
    return true;
  }

  sendJson(res, 404, {
    errors: [{ code: 'CONTROL_NOT_FOUND', message: `控制页没有这个端点：${pathname}` }],
    data: null,
  });
  return true;
}

/* ------------------------------------------------------------------ *
 * HTTP 入口
 * ------------------------------------------------------------------ */

const server = createServer(async (req, res) => {
  const method = String(req.method ?? 'GET').toUpperCase();
  const url = req.url ?? '/';
  const parsed = new URL(url, `http://${HOST}:${PORT}`);
  const pathname = parsed.pathname;

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type,authorization,x-role,x-authenticator,x-data-source',
      'x-crewloom-local': '1',
    });
    res.end();
    return;
  }

  try {
    if (pathname === '/healthz') {
      sendJson(res, 200, {
        ok: true,
        local: true,
        outbound: false,
        tokenEpoch: fixtureState.epoch,
        workflowTestScenario: workflowStore.testScenario,
        modelTestScenario: modelState.testScenario,
        requests: requests.length,
        unsupported: unsupported.length,
      });
      return;
    }

    if (pathname === '/control' || pathname === '/' || pathname.startsWith('/control/')) {
      if (await handleControl(req, res, { pathname, method })) return;
    }

    if (pathname.startsWith('/files/')) {
      dispatchFiles(res, pathname);
      return;
    }

    if (pathname.startsWith('/api/')) {
      const rawBody = method === 'GET' || method === 'HEAD' ? null : await readBody(req);
      let values = null;
      if (rawBody && rawBody.length) {
        try {
          const parsedBody = JSON.parse(rawBody.toString('utf8'));
          values = parsedBody && typeof parsedBody === 'object' ? (parsedBody.values ?? parsedBody) : parsedBody;
        } catch {
          values = null;
        }
      }
      const action = pathname.slice('/api/'.length);
      await dispatchApi(req, res, { action, url, method, headers: req.headers, rawBody, values });
      return;
    }

    // 未知路径：本机说明，不外呼。
    record({ method, action: pathname, code: 404, note: '未知路径（本机 404）' });
    sendJson(res, 404, {
      errors: [
        {
          code: 'SYNTH_NOT_FOUND',
          message: `本机合成环境只应答 /api/**、/files/** 与 /control：${pathname}（不会外呼真实后端）。`,
        },
      ],
      data: null,
    });
  } catch (error) {
    log(`处理 ${method} ${url} 失败：${error?.stack ?? error}`);
    if (!res.headersSent) {
      sendJson(res, 500, {
        errors: [{ code: 'SYNTH_INTERNAL', message: `本机合成环境内部错误：${String(error?.message ?? error)}` }],
        data: null,
      });
    } else {
      res.end();
    }
  }
});

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

server.listen(PORT, HOST, () => {
  log(`本机合成后端已启动：http://${HOST}:${PORT}`);
  log(`可见控制页：http://${HOST}:${PORT}/control`);
  log(`产品预览（由 Vite 提供）：${APP_URL}`);
  log('未支持接口只在本机 501；/files 只在本机 404；本进程不做任何外联。');
  log(`合成账号：${FIXTURE_ACCOUNTS.map((item) => `${item.email} / ${item.password}`).join('，')}`);
  if (process.argv.includes('--check')) void runSelfCheck();
});

export { server, controlState, dispatchApi, fixtureState, modelState, workflowStore };

/* ------------------------------------------------------------------ *
 * `--check`：本进程自检（只打本机 5410，不碰任何真实后端）
 * ------------------------------------------------------------------ */

async function runSelfCheck() {
  const base = `http://${HOST}:${PORT}`;
  const results = [];
  const check = (name, okFlag, note = '') => {
    results.push({ name, ok: okFlag, note });
    log(`SELFCHECK ${okFlag ? 'PASS' : 'FAIL'} ${name}${note ? ` — ${note}` : ''}`);
  };
  const call = async (path, options = {}) => {
    const response = await fetch(`${base}${path}`, options);
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: response.status, body, text, local: response.headers.get('x-crewloom-local') === '1' };
  };
  const jsonPost = (payload, headers = {}) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });

  try {
    const health = await call('/healthz');
    check(
      '本机服务 /healthz 可用且声明 local/outbound=false',
      health.status === 200 && health.body?.local === true && health.body?.outbound === false,
    );

    const account = FIXTURE_ACCOUNTS[0];
    const signIn = await call('/api/auth:signIn', jsonPost({ email: account.email, password: account.password }));
    const token = signIn.body?.data?.token;
    check('合成账号可在本机登录（200 + 令牌）', signIn.status === 200 && typeof token === 'string', account.email);
    const auth = { authorization: `Bearer ${token}` };

    const initialExecutions = (await call('/control/state')).body?.workflow?.executions?.length ?? 0;

    const flows = await call('/api/workflows:list?page=1&pageSize=20&sort%5B%5D=-id', { headers: auth });
    check(
      '流程列表：过滤/分页信封（meta.count + versionStats）',
      flows.status === 200 && Array.isArray(flows.body?.data) && typeof flows.body?.meta?.count === 'number',
      `count=${flows.body?.meta?.count}`,
    );

    const created = await call('/api/workflows:create', {
      ...jsonPost({ title: '自检流程', type: 'collection', enabled: false }, auth),
    });
    const createdId = created.body?.data?.id;
    check('新建流程 200 且返回新版本 id', created.status === 200 && Boolean(createdId), String(createdId));
    const badCreate = await call('/api/workflows:create', jsonPost({ title: '缺 type' }, auth));
    check(
      '新建流程缺 type → 400 Trigger type is required（不空成功）',
      badCreate.status === 400 && /Trigger type is required/.test(String(badCreate.body?.errors?.[0]?.message)),
      `${badCreate.status}`,
    );

    const toggled = await call(`/api/workflows:update?filterByTk=${createdId}`, jsonPost({ enabled: true }, auth));
    check(
      '启用流程：current=true 且归档同 key 其它版本（enabled:false/current:null）',
      toggled.status === 200 && toggled.body?.data?.current === true && toggled.body?.data?.enabled === true,
    );

    const renamed = await call(`/api/workflows:update?filterByTk=${createdId}`, jsonPost({ title: '自检流程·改名' }, auth));
    check('改名流程 200 且标题回读一致', renamed.status === 200 && renamed.body?.data?.title === '自检流程·改名');

    const copied = await call(`/api/workflows:revision?filterByTk=${createdId}`, jsonPost({ title: '自检流程 副本' }, auth));
    check(
      '复制为独立流程：新 key、独立版本',
      copied.status === 200 && copied.body?.data?.id !== createdId && copied.body?.data?.key === copied.body?.data?.id,
    );

    const newVersion = await call(
      `/api/workflows:revision?filterByTk=${encodeURIComponent(createdId)}&filter=${encodeURIComponent(JSON.stringify({ key: createdId }))}`,
      jsonPost({}, auth),
    );
    check(
      '新建版本：沿用同 key（版本切换用）',
      newVersion.status === 200 && newVersion.body?.data?.key === createdId && newVersion.body?.data?.id !== createdId,
    );

    const nodes = await call(
      `/api/flow_nodes:list?filter=${encodeURIComponent(JSON.stringify({ workflowId: CONTROLLED_WORKFLOW_IDS.DRAFT_ID }))}&pageSize=200&sort%5B%5D=id`,
      { headers: auth },
    );
    check('受控画布节点读取（flow_nodes:list + workflowId 过滤）', nodes.status === 200 && Array.isArray(nodes.body?.data), `nodes=${nodes.body?.data?.length}`);

    const createdNode = await call(`/api/workflows/${CONTROLLED_WORKFLOW_IDS.DRAFT_ID}/nodes:create`, {
      ...jsonPost({ type: 'script', title: '自检 JavaScript', config: { content: 'return 1;' } }, auth),
    });
    check('新增节点（nodes:create）200 且类型回读一致', createdNode.status === 200 && createdNode.body?.data?.type === 'script');

    const configured = await call(
      `/api/flow_nodes:update?filterByTk=${createdNode.body?.data?.id}`,
      jsonPost({ config: { content: 'return 42;' } }, auth),
    );
    check('节点配置保存（flow_nodes:update）200 且 config 回读一致', configured.status === 200 && configured.body?.data?.config?.content === 'return 42;');

    /* ---- 节点复制 / 移动 / 删除：盯"链仍可从入口整条遍历"，不是节点数 +1 ----
     * 真实 2.2.20 `flow_nodes:duplicate` 的位置**只**由 `values.upstreamId`/`values.branchIndex` 决定：
     * 只带 `filterByTk` 时服务端按 `upstreamId=null` 把副本插到流程最前，而不是"接在被复制节点之后"
     * （`plugin-workflow/src/server/actions/nodes.ts:172-198`）。Main 在 5329/5410 上看到的
     * "复制后原生画布只剩一个节点、`calc.downstreamId=null`"就来自 fixture 没有照这段实现。 */
    const listDraftNodes = async () =>
      (
        await call(
          `/api/flow_nodes:list?filter=${encodeURIComponent(JSON.stringify({ workflowId: CONTROLLED_WORKFLOW_IDS.DRAFT_ID }))}&pageSize=200&sort%5B%5D=id`,
          { headers: auth },
        )
      ).body?.data ?? [];
    /** 从入口沿 `downstreamId` 走一遍直线链（分支头不在直线链里，由分支自己渲染）。 */
    const linearChain = (rows) => {
      const byId = new Map(rows.map((row) => [String(row.id), row]));
      const entry = rows.find((row) => !row.upstreamId || !byId.has(String(row.upstreamId)));
      const seen = new Set();
      const chain = [];
      for (let cursor = entry; cursor && !seen.has(String(cursor.id)); cursor = byId.get(String(cursor.downstreamId))) {
        seen.add(String(cursor.id));
        chain.push(String(cursor.id));
      }
      return chain;
    };
    const sourceId = String(createdNode.body?.data?.id);
    const beforeChain = linearChain(await listDraftNodes());
    const duplicated = await call(
      `/api/flow_nodes:duplicate?filterByTk=${sourceId}`,
      jsonPost({ upstreamId: sourceId, branchIndex: null }, auth),
    );
    const afterDupRows = await listDraftNodes();
    const afterDupChain = linearChain(afterDupRows);
    const sourceIndexAfterDup = afterDupChain.indexOf(sourceId);
    check(
      '复制节点（values.upstreamId=源节点）：副本严格接在源节点之后',
      duplicated.status === 200 &&
        String(duplicated.body?.data?.upstreamId) === sourceId &&
        sourceIndexAfterDup >= 0 &&
        afterDupChain[sourceIndexAfterDup + 1] === String(duplicated.body?.data?.id),
      `chain=${afterDupChain.join('→')}`,
    );
    check(
      '复制后链可整条遍历且 id/key 唯一（不是只看节点数 +1）',
      beforeChain.indexOf(sourceId) >= 0 &&
        afterDupChain.length === beforeChain.length + 1 &&
        new Set(afterDupRows.map((row) => String(row.id))).size === afterDupRows.length &&
        new Set(afterDupRows.map((row) => String(row.key))).size === afterDupRows.length,
      `len=${beforeChain.length}→${afterDupChain.length} nodes=${afterDupRows.length}`,
    );

    const headDup = await call(`/api/flow_nodes:duplicate?filterByTk=${sourceId}`, jsonPost({}, auth));
    check(
      'duplicate 不带 values：按上游契约插到流程最前（不是接在原节点之后）',
      headDup.status === 200 && headDup.body?.data?.upstreamId === null,
      `upstreamId=${String(headDup.body?.data?.upstreamId)}`,
    );
    const movedBack = await call(
      `/api/flow_nodes:move?filterByTk=${headDup.body?.data?.id}`,
      jsonPost({ upstreamId: sourceId, branchIndex: null }, auth),
    );
    const movedChain = linearChain(await listDraftNodes());
    check(
      '移动节点（flow_nodes:move）：解开旧位置后插入目标位置，链仍连续',
      movedBack.status === 200 &&
        movedChain.indexOf(sourceId) >= 0 &&
        movedChain[movedChain.indexOf(sourceId) + 1] === String(headDup.body?.data?.id),
      `chain=${movedChain.join('→')}`,
    );
    const destroyed = await call(`/api/flow_nodes:destroy?filterByTk=${headDup.body?.data?.id}`, jsonPost({}, auth));
    const destroyedChain = linearChain(await listDraftNodes());
    check(
      '删除节点（flow_nodes:destroy）：上下游互接，链仍可从入口整条遍历',
      destroyed.status === 200 &&
        destroyedChain.length === movedChain.length - 1 &&
        destroyedChain.indexOf(sourceId) >= 0 &&
        !destroyedChain.includes(String(headDup.body?.data?.id)),
      `chain=${destroyedChain.join('→')}`,
    );

    /* ---- 删除分支：真实契约是 `filterByTk` = 分支挂靠的上游节点 + `branchIndex` 必填 ---- */
    const conditionNode = (await listDraftNodes()).find((row) => row.type === 'condition');
    const branchHeadsBefore = (await listDraftNodes()).filter(
      (row) => String(row.upstreamId) === String(conditionNode?.id) && row.branchIndex != null,
    );
    const branchMissingIndex = await call(`/api/flow_nodes:destroyBranch?filterByTk=${conditionNode?.id}`, jsonPost({}, auth));
    check(
      '删除分支缺 branchIndex → 400 branchIndex is required（不空成功）',
      branchMissingIndex.status === 400 &&
        /branchIndex is required/.test(String(branchMissingIndex.body?.errors?.[0]?.message)),
      `${branchMissingIndex.status}`,
    );
    const branchRemoved = await call(
      `/api/flow_nodes:destroyBranch?filterByTk=${conditionNode?.id}&branchIndex=0&shift=1`,
      jsonPost({}, auth),
    );
    const branchHeadsAfter = (await listDraftNodes()).filter(
      (row) => String(row.upstreamId) === String(conditionNode?.id) && row.branchIndex != null,
    );
    const yesHeadBefore = branchHeadsBefore.find((row) => row.branchIndex === 1);
    check(
      '删除分支（上游节点 + branchIndex + shift=1）：分支头及其下游一起删除，剩余分支序号前移',
      branchRemoved.status === 200 &&
        branchHeadsBefore.length === 2 &&
        branchHeadsAfter.length === 1 &&
        branchHeadsAfter[0]?.branchIndex === 0,
      `heads=${branchHeadsBefore.length}→${branchHeadsAfter.length}`,
    );
    check(
      'condition 的 shift 删除会改变剩余分支含义：原 branchIndex=1（是）被前移到 0（否）→ 宿主不得提供该入口',
      String(branchHeadsAfter[0]?.id) === String(yesHeadBefore?.id) && branchHeadsAfter[0]?.branchIndex === 0,
      `剩余=${String(branchHeadsAfter[0]?.id)}（原 branchIndex=1）→ branchIndex=0`,
    );

    /* ---- 相邻交换的真实契约：位置没变化必须 400（宿主不能把 no-op 当成功） ---- */
    const noopMove = await call(
      `/api/flow_nodes:move?filterByTk=${conditionNode?.id}`,
      jsonPost({ upstreamId: conditionNode?.upstreamId ?? null, branchIndex: null }, auth),
    );
    check(
      '移动节点到当前位置 → 400 Node does not need to be moved（不空成功）',
      noopMove.status === 400 && /does not need to be moved/.test(String(noopMove.body?.errors?.[0]?.message)),
      `${noopMove.status}`,
    );

    /* ---- 分支删除语义按**上游节点类型**分流：multi-conditions 是 0=Otherwise + 1..N=条件 ---- */
    const listWideNodes = async () =>
      (
        await call(
          `/api/flow_nodes:list?filter=${encodeURIComponent(JSON.stringify({ workflowId: CONTROLLED_WORKFLOW_IDS.WIDE_ID }))}&pageSize=200&sort%5B%5D=id`,
          { headers: auth },
        )
      ).body?.data ?? [];
    const wideBefore = await listWideNodes();
    const wideBranch = wideBefore.find((row) => row.type === 'multi-conditions');
    const wideHeadOf = (rows, branchIndex) =>
      rows.find((row) => String(row.upstreamId) === String(wideBranch?.id) && row.branchIndex === branchIndex);
    const wideHeadIndexes = (rows) =>
      rows
        .filter((row) => String(row.upstreamId) === String(wideBranch?.id) && row.branchIndex != null)
        .map((row) => row.branchIndex)
        .sort((a, b) => a - b);
    const headsBefore = wideHeadIndexes(wideBefore);
    const conditionOneBefore = wideHeadOf(wideBefore, 1);
    const conditionTwoBefore = wideHeadOf(wideBefore, 2);
    const conditionThreeBefore = wideHeadOf(wideBefore, 3);
    check(
      'multi-conditions 分支序号按真实契约（0=否则 + 1..N=条件；不能沿用 0-based 近似）',
      JSON.stringify(headsBefore) === JSON.stringify([1, 2, 3]),
      JSON.stringify(headsBefore),
    );

    /* ---- 同一处理路径内的相邻交换：真实 move 的 branchIndex 落点（Main 000005 的窄边界） ---- */
    const wideMidHead = wideHeadOf(wideBefore, 2);
    const wideMidTail = wideBefore.find(
      (row) => String(row.upstreamId) === String(wideMidHead?.id) && row.branchIndex == null,
    );
    const wideLeftBefore = wideHeadOf(wideBefore, 1);
    const wideRightBefore = wideHeadOf(wideBefore, 3);
    /** 从某条处理路径的分支头沿 `downstreamId` 走一遍（真实画布一条路径的渲染顺序）。 */
    const pathChain = (rows, headId) => {
      const byId = new Map(rows.map((row) => [String(row.id), row]));
      const seen = new Set();
      const chain = [];
      for (let cursor = byId.get(String(headId)); cursor && !seen.has(String(cursor.id)); cursor = byId.get(String(cursor.downstreamId))) {
        seen.add(String(cursor.id));
        chain.push(String(cursor.id));
      }
      return chain;
    };
    check(
      '多条件每条处理路径确有两个串行步骤（中间那路的样本：处理 → 收尾）',
      Boolean(wideMidHead) &&
        Boolean(wideMidTail) &&
        JSON.stringify(pathChain(wideBefore, wideMidHead?.id)) ===
          JSON.stringify([wideMidHead?.id, wideMidTail?.id].map(String)),
      `路2链=${pathChain(wideBefore, wideMidHead?.id).join('→')}`,
    );
    const wideMidSwap = await call(
      `/api/flow_nodes:move?filterByTk=${wideMidTail?.id}`,
      jsonPost({ upstreamId: wideBranch?.id, branchIndex: 2 }, auth),
    );
    const wideMidAfter = await listWideNodes();
    const midHeadAfter = wideHeadOf(wideMidAfter, 2);
    const midOldHeadAfter = wideMidAfter.find((row) => String(row.id) === String(wideMidHead?.id));
    check(
      '处理路径内相邻交换：路径第二步上移到同路首位（branchIndex 落点），路径序号与挂靠条件不变、左右两路未动',
      wideMidSwap.status === 200 &&
        String(midHeadAfter?.id) === String(wideMidTail?.id) &&
        midHeadAfter?.branchIndex === 2 &&
        String(midHeadAfter?.upstreamId) === String(wideBranch?.id) &&
        String(midOldHeadAfter?.upstreamId) === String(wideMidTail?.id) &&
        midOldHeadAfter?.branchIndex == null &&
        JSON.stringify(pathChain(wideMidAfter, wideMidTail?.id)) ===
          JSON.stringify([wideMidTail?.id, wideMidHead?.id].map(String)) &&
        String(wideHeadOf(wideMidAfter, 1)?.id) === String(wideLeftBefore?.id) &&
        String(wideHeadOf(wideMidAfter, 3)?.id) === String(wideRightBefore?.id),
      `路2首位=${midHeadAfter?.id}/${midHeadAfter?.branchIndex} 链=${pathChain(wideMidAfter, wideMidTail?.id).join('→')}`,
    );
    const wideMidSwapBack = await call(
      `/api/flow_nodes:move?filterByTk=${wideMidHead?.id}`,
      jsonPost({ upstreamId: wideBranch?.id, branchIndex: 2 }, auth),
    );
    const wideRestored = await listWideNodes();
    check(
      '路径内交换可逆：再下移一步换回原顺序（同一条 move 契约），分支序号仍为 1/2/3',
      wideMidSwapBack.status === 200 &&
        String(wideHeadOf(wideRestored, 2)?.id) === String(wideMidHead?.id) &&
        wideHeadOf(wideRestored, 2)?.branchIndex === 2 &&
        String(wideRestored.find((row) => String(row.id) === String(wideMidTail?.id))?.upstreamId) ===
          String(wideMidHead?.id) &&
        JSON.stringify(wideHeadIndexes(wideRestored)) === JSON.stringify([1, 2, 3]),
      `路2首位=${wideHeadOf(wideRestored, 2)?.id} heads=${JSON.stringify(wideHeadIndexes(wideRestored))}`,
    );
    const wideRemoved = await call(
      `/api/flow_nodes:destroyBranch?filterByTk=${wideBranch?.id}&branchIndex=2&shift=1`,
      jsonPost({}, auth),
    );
    const wideAfter = await listWideNodes();
    const headsAfter = wideHeadIndexes(wideAfter);
    check(
      'multi-conditions 删除第 2 个条件：只前移 >2 的分支，条件 1（含义未变）保持 branchIndex=1',
      wideRemoved.status === 200 &&
        JSON.stringify(headsAfter) === JSON.stringify([1, 2]) &&
        !wideAfter.some((row) => String(row.id) === String(conditionTwoBefore?.id)) &&
        wideHeadOf(wideAfter, 1)?.id === conditionOneBefore?.id &&
        wideHeadOf(wideAfter, 2)?.id === conditionThreeBefore?.id,
      `heads=${JSON.stringify(headsBefore)}→${JSON.stringify(headsAfter)} 条件1保持=${wideHeadOf(wideAfter, 1)?.id === conditionOneBefore?.id}`,
    );

    /* ---- 「分支 + 线性续行」：真实图上分支父节点可以整体移动，分支归属与续行都保持 ---- */
    const listBranchFlowNodes = async () =>
      (
        await call(
          `/api/flow_nodes:list?filter=${encodeURIComponent(JSON.stringify({ workflowId: CONTROLLED_WORKFLOW_IDS.BRANCH_FLOW_ID }))}&pageSize=200&sort%5B%5D=id`,
          { headers: auth },
        )
      ).body?.data ?? [];
    const flowBefore = await listBranchFlowNodes();
    const flowCondition = flowBefore.find((row) => row.type === 'condition');
    const flowBoot = flowBefore.find((row) => row.title === '续行·开始');
    const flowPrepare = flowBefore.find((row) => row.title === '续行·准备');
    const flowMerge = flowBefore.find((row) => row.title === '续行·合并');
    const flowTail = flowBefore.find((row) => row.title === '续行·收尾');
    const flowHeads = flowBefore.filter(
      (row) => String(row.upstreamId) === String(flowCondition?.id) && row.branchIndex != null,
    );
    const flowChainBefore = linearChain(flowBefore);
    check(
      '分支 + 线性续行可被本机 fixture 表达：条件同时有两条分支与一条续行，链可整条遍历',
      flowHeads.length === 2 &&
        JSON.stringify(linearChain(flowBefore)) ===
          JSON.stringify([flowBoot?.id, flowPrepare?.id, flowCondition?.id, flowMerge?.id, flowTail?.id].map(String)) &&
        String(flowCondition?.downstreamId) === String(flowMerge?.id) &&
        flowChainBefore.length === 5,
      `heads=${flowHeads.map((row) => row.branchIndex).join(',')} chain=${flowChainBefore.join('→')}`,
    );
    const flowMoved = await call(
      `/api/flow_nodes:move?filterByTk=${flowCondition?.id}`,
      jsonPost({ upstreamId: flowBoot?.id, branchIndex: null }, auth),
    );
    const flowAfterMove = await listBranchFlowNodes();
    const movedCondition = flowAfterMove.find((row) => String(row.id) === String(flowCondition?.id));
    const movedHeads = flowAfterMove.filter(
      (row) => String(row.upstreamId) === String(flowCondition?.id) && row.branchIndex != null,
    );
    const movedPrepare = flowAfterMove.find((row) => String(row.id) === String(flowPrepare?.id));
    check(
      '条件整体上移：主序列变成 开始→条件→准备→合并→收尾，分支归属与"否/是"序号不变',
      flowMoved.status === 200 &&
        JSON.stringify(linearChain(flowAfterMove)) ===
          JSON.stringify([flowBoot?.id, flowCondition?.id, flowPrepare?.id, flowMerge?.id, flowTail?.id].map(String)) &&
        movedHeads.length === 2 &&
        movedHeads.map((row) => row.branchIndex).sort().join(',') === '0,1' &&
        movedHeads.every((row) => String(row.upstreamId) === String(flowCondition?.id)) &&
        String(movedCondition?.downstreamId) === String(flowPrepare?.id) &&
        String(movedPrepare?.upstreamId) === String(flowCondition?.id) &&
        linearChain(flowAfterMove).length === 5,
      `chain=${linearChain(flowAfterMove).join('→')} heads=${movedHeads.map((row) => row.branchIndex).join(',')}`,
    );
    const flowMovedBack = await call(
      `/api/flow_nodes:move?filterByTk=${flowPrepare?.id}`,
      jsonPost({ upstreamId: flowBoot?.id, branchIndex: null }, auth),
    );
    const flowRestored = await listBranchFlowNodes();
    check(
      '条件再下移一步即可换回原顺序（往返可逆），分支与续行仍连通',
      flowMovedBack.status === 200 &&
        JSON.stringify(linearChain(flowRestored)) ===
          JSON.stringify([flowBoot?.id, flowPrepare?.id, flowCondition?.id, flowMerge?.id, flowTail?.id].map(String)) &&
        String(flowRestored.find((row) => row.type === 'condition')?.downstreamId) === String(flowMerge?.id) &&
        linearChain(flowRestored).length === 5,
      `chain=${linearChain(flowRestored).join('→')}`,
    );

    await call('/api/crewloomControlledWorkflow:scenario', jsonPost({ test: 'success' }, auth));
    const testOk = await call('/api/flow_nodes:test', {
      ...jsonPost({ type: 'script', config: { content: 'return 1;' } }, auth),
    });
    check(
      '节点自测 success：单层 {data:{status,result,log}} 且回显提交的 type',
      testOk.status === 200 && testOk.body?.data?.status === 1 && testOk.body?.data?.result?.type === 'script',
    );
    await call('/api/crewloomControlledWorkflow:scenario', jsonPost({ test: 'failure' }, auth));
    const testFail = await call('/api/flow_nodes:test', jsonPost({ type: 'script', config: {} }, auth));
    check('节点自测 failure：status=-1', testFail.status === 200 && testFail.body?.data?.status === -1);
    await call('/api/crewloomControlledWorkflow:scenario', jsonPost({ test: 'permission' }, auth));
    const testDenied = await call('/api/flow_nodes:test', jsonPost({ type: 'script', config: {} }, auth));
    check('节点自测 permission：403（响应层应转成中文权限提示）', testDenied.status === 403);
    await call('/api/crewloomControlledWorkflow:scenario', jsonPost({ test: 'error' }, auth));
    const testError = await call('/api/flow_nodes:test', jsonPost({ type: 'script', config: {} }, auth));
    check('节点自测 error：500', testError.status === 500);
    await call('/api/crewloomControlledWorkflow:scenario', jsonPost({ test: 'success' }, auth));

    const executedCreate = await call(`/api/workflows/${CONTROLLED_WORKFLOW_IDS.EXECUTED_ID}/nodes:create`, {
      ...jsonPost({ type: 'output', title: '不该成功', config: {} }, auth),
    });
    check(
      '已执行版本禁止增删改：400 且带真实英文 message',
      executedCreate.status === 400 && typeof executedCreate.body?.errors?.[0]?.message === 'string',
      `${executedCreate.status}`,
    );

    const executions = await call(
      `/api/executions:list?page=1&pageSize=20&sort%5B%5D=-id&filter=${encodeURIComponent(JSON.stringify({ status: 1 }))}`,
      { headers: auth },
    );
    check(
      '执行列表状态过滤：只回已完成状态',
      executions.status === 200 && Array.isArray(executions.body?.data) && executions.body.data.every((row) => row.status === 1),
      `rows=${executions.body?.data?.length}`,
    );
    const queueing = await call(
      `/api/executions:list?filter=${encodeURIComponent(JSON.stringify({ status: { $eq: null } }))}`,
      { headers: auth },
    );
    check(
      '执行列表「排队中」按 null 过滤（与真实 9 态一致）',
      queueing.status === 200 && queueing.body.data.length > 0 && queueing.body.data.every((row) => row.status === null),
    );

    const detail = await call('/api/executions:get?filterByTk=920005', { headers: auth });
    check('执行详情（executions:get）200', detail.status === 200 && detail.body?.data?.id === '920005');
    const jobs = await call(`/api/jobs:list?filter=${encodeURIComponent(JSON.stringify({ executionId: '920005' }))}&pageSize=200&sort%5B%5D=id`, {
      headers: auth,
    });
    check(
      '按 executionId 读作业：只回本次执行的 job（WF-05 口径）',
      jobs.status === 200 && jobs.body.data.length === 3 && jobs.body.data.every((job) => String(job.executionId) === '920005'),
      `jobs=${jobs.body?.data?.length}`,
    );

    const cancelled = await call('/api/executions:cancel?filterByTk=920004', jsonPost({}, auth));
    check('取消进行中的执行：status → -3 + reason=manual_cancel', cancelled.status === 200 && cancelled.body?.data?.status === -3);
    const cancelFinished = await call('/api/executions:cancel?filterByTk=920005', jsonPost({}, auth));
    check('已结束的执行不可取消：400', cancelFinished.status === 400);

    const providers = await call('/api/ai:listLLMProviders', { headers: auth });
    check('LM 提供方目录：13 个提供方', providers.status === 200 && providers.body?.data?.length === 13);

    const masked = await call('/api/ai:listLLMServices?pageSize=100&sort%5B%5D=sort', { headers: auth });
    const maskedHasOptions = (masked.body?.data ?? []).some((row) => 'options' in row);
    check(
      '脱敏服务列表：剔除 options、剔除停用服务、含 meta.count/hasNext',
      masked.status === 200 &&
        maskedHasOptions === false &&
        (masked.body?.data ?? []).every((row) => row.enabled !== false) &&
        typeof masked.body?.meta?.count === 'number',
      `rows=${masked.body?.data?.length}`,
    );

    const raw = await call('/api/llmServices:list?pageSize=100', { headers: auth });
    const rawHasKey = (raw.body?.data ?? []).some((row) => typeof row.options?.apiKey === 'string');
    check('管理读 llmServices:list：含明文 options（读—改—写整体替换所需）', raw.status === 200 && rawHasKey);
    const missing = await call('/api/llmServices:get?filterByTk=__no_such_service__', { headers: auth });
    check('llmServices:get 不存在 → 200 {data:null}（真实契约，不是 404）', missing.status === 200 && missing.body?.data === null);

    const updated = await call('/api/llmServices:update?filterByTk=synth-deepseek', {
      ...jsonPost({ options: { apiKey: 'replaced', baseURL: 'http://127.0.0.1:9/x', temperature: 0.3 } }, auth),
    });
    check(
      '保存服务配置：options 整体替换（未传键被丢弃，符合真实语义）',
      updated.status === 200 && updated.body?.data?.options?.apiKey === 'replaced' && updated.body?.data?.options?.timeout === undefined,
    );
    await call('/api/llmServices:update?filterByTk=synth-deepseek', {
      ...jsonPost({ options: { apiKey: 'sk-synth-environment-fake-key', baseURL: 'http://127.0.0.1:9/synth-model-gateway', temperature: 0.7, timeout: 5000, maxRetries: 0 } }, auth),
    });
    const badModels = await call('/api/llmServices:update?filterByTk=synth-deepseek', {
      ...jsonPost({ enabledModels: { mode: 'custom', models: [{ label: '', value: '' }] } }, auth),
    });
    check(
      'enabledModels 校验：空 id → 400 LLM_SERVICE_MODEL_ID_REQUIRED + data.index',
      badModels.status === 400 &&
        badModels.body?.errors?.[0]?.code === 'LLM_SERVICE_MODEL_ID_REQUIRED' &&
        badModels.body?.data?.index === 0,
    );

    const models = await call('/api/ai:listModels', { ...jsonPost({ llmService: 'synth-deepseek', model: '' }, auth) });
    check(
      '显式模型目录（ai:listModels）：只回 enabledModels 里的 id，不外呼',
      models.status === 200 && models.body.data.map((row) => row.id).join(',') === 'deepseek-chat,deepseek-reasoner',
    );
    const providerModels = await call('/api/ai:listProviderModels', {
      ...jsonPost({ provider: 'deepseek', options: { apiKey: 'x' }, model: '' }, auth),
    });
    check('提供方模型目录（ai:listProviderModels）本机应答', providerModels.status === 200 && providerModels.body.data.length === 2);

    const settings = await call('/api/aiSettings:get', { headers: auth });
    check(
      '默认设置读取：默认两键为 null（摊平顶层）',
      settings.status === 200 && settings.body?.data?.defaultLLMService === null && settings.body?.data?.defaultModel === null,
    );
    const saved = await call('/api/aiSettings:update', jsonPost({ defaultLLMService: 'synth-deepseek', defaultModel: 'deepseek-chat' }, auth));
    check('默认设置保存 200', saved.status === 200 && saved.body?.data?.defaultLLMService === 'synth-deepseek');
    const readBack = await call('/api/aiSettings:get', { headers: auth });
    check(
      '默认设置保存后回读一致',
      readBack.body?.data?.defaultLLMService === 'synth-deepseek' && readBack.body?.data?.defaultModel === 'deepseek-chat',
    );
    await call('/api/aiSettings:update', jsonPost({ defaultLLMService: null, defaultModel: null }, auth));

    await call('/control/model/scenario', jsonPost({ test: 'success' }));
    const flightOk = await call('/api/ai:testFlight', { ...jsonPost({ provider: 'deepseek', options: { apiKey: 'x' }, model: 'deepseek-chat' }, auth) });
    check(
      '试飞成功（本机受控）：status=success 且 code=0',
      flightOk.status === 200 && flightOk.body?.data?.status === 'success' && flightOk.body?.data?.code === 0,
    );
    await call('/control/model/scenario', jsonPost({ test: 'failure' }));
    const flightFail = await call('/api/ai:testFlight', { ...jsonPost({ provider: 'deepseek', options: { apiKey: 'x' }, model: 'bad' }, auth) });
    check(
      '试飞失败（本机受控）：status=error 且 code!=0',
      flightFail.status === 200 && flightFail.body?.data?.status === 'error' && flightFail.body?.data?.code !== 0,
    );
    await call('/control/model/scenario', jsonPost({ test: 'success' }));

    const employees = await call('/api/aiEmployees:list?pageSize=200&sort%5B%5D=sort', { headers: auth });
    check('员工模型配置读取（LM-04）', employees.status === 200 && employees.body.data.length === 2);

    const nativeExtras = await Promise.all([
      call('/api/flowModels:findOne?uid=admin-layout-model-app-switcher-actions', { headers: auth }),
      call('/api/desktopRoutes:listAccessible?tree=true', { headers: auth }),
      call('/api/uiLayouts:listAccessible', { headers: auth }),
      call('/api/notificationChannels:list', { headers: auth }),
    ]);
    check(
      '原生宿主启动期附属读全部本机应答（不是 501）',
      nativeExtras.every((item) => item.status === 200),
      nativeExtras.map((item) => item.status).join('/'),
    );

    const unknown = await call('/api/synth_not_implemented:list', { headers: auth });
    check('未知动作只在本机 501（不空成功、不外呼）', unknown.status === 501 && unknown.body?.errors?.[0]?.code === 'SYNTH_UNSUPPORTED');

    const fileMiss = await call('/files/app/main/attachments/1.txt', { headers: auth });
    check('/files 只在本机 404（不取真实附件）', fileMiss.status === 404);

    const control = await call('/control/state');
    check(
      '控制页状态可用（账号/合成 id/请求记录）',
      control.status === 200 && Array.isArray(control.body?.accounts) && typeof control.body?.workflow === 'object',
    );

    const unauthorized = await call('/api/workflows:list?pageSize=1');
    check('未登录读取非公开动作 → 401（合成登录不可绕过）', unauthorized.status === 401);

    await call('/control/reset', jsonPost({}));
    const afterReset = await call('/control/state');
    check(
      '控制页重置：合成数据回初始（令牌世代不变）',
      afterReset.status === 200 &&
        afterReset.body?.workflow?.executions?.length === initialExecutions &&
        afterReset.body?.workflow?.versions?.every((version) => version.executed === 0 || version.id !== createdId),
      `executions=${afterReset.body?.workflow?.executions?.length}（初始 ${initialExecutions}）`,
    );
  } catch (error) {
    check('自检未抛异常', false, String(error?.stack ?? error));
  }

  const failed = results.filter((item) => !item.ok);
  log(`SELFCHECK 汇总：${results.length - failed.length}/${results.length} 通过`);
  process.exitCode = failed.length === 0 ? 0 : 1;
  server.close();
}
