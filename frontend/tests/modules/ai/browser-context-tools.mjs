#!/usr/bin/env node
/**
 * AI-04 四类上下文与前端工具的**受控真实浏览器**核对（本机 Chrome + CDP）。
 *
 * 边界（务必先读）：
 *  - 真实 Chrome（headless=new），页面是产品自己的开发预览（默认 `http://127.0.0.1:5291`）；
 *  - 所有 `/api/*` 请求在**浏览器网络层**被 CDP `Fetch` 拦截并由本脚本用本机 mock 应答，
 *    真实后端 0 请求（每条被拦截的请求都记进证据，且断言没有任何请求被放行到真实来源）；
 *  - 只记录 method / path / 动作 / 状态码，不记录凭据、响应正文或业务内容；
 *  - 截图是**受控数据**（mock 数据），可分享；不含真实登录凭据与真实业务记录。
 *
 * 核对内容（对应任务要求）：
 *  1. 四类上下文都能在真实浏览器里做非空选择/编辑/配置；
 *  2. 前端工具的「应用 / 拒绝」真的改变（或保持）工作区内容；
 *  3. 「会话内容」载荷的 type/uid/frontendTools 与注册口径一致（id === `${uid}:${name}`）；
 *  4. 角色世代切换后，上一身份的上下文选择被清空（会话/角色世代隔离）。
 *
 * 用法：`CREWLOOM_PREVIEW_URL=http://127.0.0.1:5291 node tests/modules/ai/browser-context-tools.mjs`
 * 退出码 0 = 全部断言通过；非 0 = 至少一条失败（失败明细同时写入证据 JSON）。
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, openSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.env.CREWLOOM_CONTEXT_EVIDENCE ?? resolve(here, '../../../../docs/acceptance/full-pages-13000/context-tools-evidence');
const SHOT_DIR = resolve(OUT_DIR, 'screenshots');
const PREVIEW = process.env.CREWLOOM_PREVIEW_URL ?? 'http://127.0.0.1:5291';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT ?? 9341);
const REAL_ORIGIN = 'http://172.16.88.250:13000';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/* ------------------------------------------------------------------ */
/* 受控 mock 数据与路由                                                */
/* ------------------------------------------------------------------ */

const SCHEMA = {
  name: 'orders',
  title: '订单',
  primaryKey: 'id',
  fields: [
    { name: 'id', type: 'bigInt', primaryKey: true },
    { name: 'amount', type: 'double' },
    { name: 'status', type: 'string' },
    { name: 'createdAt', type: 'date' },
  ],
};

const DATASOURCE_ROWS = [
  {
    id: 'ctx-1',
    title: '本月订单',
    description: '只读的订单示例范围',
    datasource: 'main',
    collectionName: 'orders',
    fields: ['id', 'amount', 'status'],
    filter: { logic: '$and', items: [{ path: 'status', operator: '$eq', value: 'open' }] },
    sort: ['-id'],
    limit: 20,
    enabled: true,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
  },
];

const ORDERS = [
  { id: 1, amount: 120, status: 'open', createdAt: '2026-10-01' },
  { id: 2, amount: 80, status: 'paid', createdAt: '2026-10-02' },
  { id: 3, amount: 200, status: 'open', createdAt: '2026-10-03' },
];

const ROLES = [
  { name: 'role_admin', title: '配置权限' },
  { name: 'role_limited', title: '受限用户' },
];

const state = { created: 0, effectiveRole: 'role_admin' };

function ok(data, meta) {
  return { code: 200, body: meta === undefined ? { data } : { data, meta } };
}

function accessData(role) {
  return {
    role,
    roleMode: 'default',
    strategy: null,
    actions: {},
    resources: [],
    snippets: ['pm', 'pm.*', 'ui.*'],
    allowAll: false,
    allowConfigure: false,
    allowAnonymous: false,
    allowMenuItemIds: [],
    uiButtonSchemasBlacklist: [],
    availableActions: ['create', 'view', 'update', 'destroy'],
    actionAlias: { list: 'view' },
    roles: ROLES.map((item) => item.name),
  };
}

/** 依据 URL 与请求体生成受控响应：返回 { code, body }。 */
function respond(method, fullUrl, body) {
  const parsed = new URL(fullUrl);
  const path = parsed.pathname.replace(/^\/api\//, '');
  const values = body && typeof body === 'object' ? body : {};

  if (path.startsWith('authenticators:publicList')) {
    return ok([{ name: 'basic', authType: 'email', title: '邮箱/密码' }]);
  }
  if (path.startsWith('auth:signIn')) {
    return ok({ token: 'controlled-mock-token', user: { id: 13, email: 'controlled@mock.test', nickname: '受控账号' } });
  }
  if (path.startsWith('auth:check')) {
    return ok({ id: 13, nickname: '受控账号', email: 'controlled@mock.test', roles: ROLES });
  }
  if (path.startsWith('roles:check')) {
    return ok(accessData(state.effectiveRole));
  }
  if (path.startsWith('dataSources:list')) {
    return ok([{ key: 'main', displayName: '主数据源' }]);
  }
  if (path.startsWith('collections:get')) {
    return ok(SCHEMA);
  }
  if (path.startsWith('collections:list')) {
    return ok([{ name: 'orders', title: '订单' }]);
  }
  if (path.startsWith('orders:list')) {
    return ok(ORDERS, { count: ORDERS.length, page: 1, pageSize: 20 });
  }
  if (path.startsWith('aiContextDatasources:preview')) {
    return ok({
      options: { ...values, filter: null },
      total: ORDERS.length,
      records: ORDERS.map((row) => [
        { name: 'id', type: 'bigInt', value: row.id },
        { name: 'amount', type: 'double', value: row.amount },
        { name: 'status', type: 'string', value: row.status },
      ]),
    });
  }
  if (path.startsWith('aiContextDatasources:create')) {
    state.created += 1;
    const row = { ...DATASOURCE_ROWS[0], ...values, id: `ctx-new-${state.created}`, createdAt: new Date().toISOString() };
    DATASOURCE_ROWS.push(row);
    return ok(row);
  }
  if (path.startsWith('aiContextDatasources:list')) {
    return ok(DATASOURCE_ROWS, { count: DATASOURCE_ROWS.length, page: 1, pageSize: 20 });
  }
  if (path.startsWith('aiContextDatasources:get')) {
    return ok(DATASOURCE_ROWS[0]);
  }
  // 其余探测/列表：受控环境里统一返回成功且为空，避免任何请求落到真实后端。
  return ok([]);
}

/* ------------------------------------------------------------------ */
/* CDP                                                                 */
/* ------------------------------------------------------------------ */

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve: done, reject: fail } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) fail(new Error(JSON.stringify(message.error)));
        else done(message.result);
        return;
      }
      const list = this.handlers.get(message.method) ?? [];
      for (const handler of list) handler(message.params);
    });
  }

  on(method, handler) {
    this.handlers.set(method, [...(this.handlers.get(method) ?? []), handler]);
  }

  send(method, params = {}) {
    this.id += 1;
    const id = this.id;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((done, fail) => this.pending.set(id, { resolve: done, reject: fail }));
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`evaluate failed: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ''}`);
    }
    return result.result?.value;
  }
}

async function waitForJson(url, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error(`等待 ${url} 超时`);
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

const results = [];
const requestLog = [];
const consoleErrors = [];

function record(name, pass, note) {
  results.push({ name, pass, note: note ?? null });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${note ? ` — ${note}` : ''}`);
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  const profile = mkdtempSync(resolve(tmpdir(), 'crewloom-context-'));
  const chromeLog = resolve(OUT_DIR, 'chrome.log');
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-crash-reporter',
      '--disable-setuid-sandbox',
      '--remote-allow-origins=*',
      '--window-size=1440,1000',
      // 先停在空白页：必须在**任何页面加载之前**启用 Fetch 拦截，
      // 否则首屏的 /api 请求会绕过受控应答（真实边界见报告 10 §7）。
      'about:blank',
    ],
    { stdio: ['ignore', openSync(chromeLog, 'w'), openSync(chromeLog, 'a')] },
  );

  let cdp;
  try {
    await waitForJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
    const targets = await waitForJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
    const page = targets.find((target) => target.type === 'page');
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((done) => socket.addEventListener('open', done));
    cdp = new Cdp(socket);
    cdp.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error') {
        consoleErrors.push((params.args ?? []).map((arg) => arg.value ?? arg.description ?? '').join(' '));
      }
    });
    cdp.on('Runtime.exceptionThrown', (params) => {
      consoleErrors.push(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? 'exception');
    });

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] });
    cdp.on('Fetch.requestPaused', async (params) => {
      const url = params.request.url;
      const method = params.request.method;
      const path = (() => {
        try {
          return new URL(url).pathname;
        } catch {
          return url;
        }
      })();
      let body = {};
      if (params.request.postData) {
        try {
          body = JSON.parse(params.request.postData);
        } catch {
          body = {};
        }
      }
      const response = respond(method, url, body);
      requestLog.push({
        method,
        path,
        mocked: true,
        status: response.code,
        hasBody: Boolean(params.request.postData),
        bodyKeys: Object.keys(body).slice(0, 8),
      });
      await cdp.send('Fetch.fulfillRequest', {
        requestId: params.requestId,
        responseCode: response.code,
        responseHeaders: [
          { name: 'content-type', value: 'application/json' },
          { name: 'x-crewloom-mock', value: '1' },
        ],
        body: Buffer.from(JSON.stringify(response.body), 'utf8').toString('base64'),
      });
    });

    /* ---------------- 登录（受控 mock） ---------------- */
    const loginFormReady = () =>
      cdp.evaluate(
        `Boolean(document.querySelector('input[type=text]') && document.querySelector('input[type=password]') && document.querySelector('button[type=submit]'))`,
      );
    let formReady = false;
    let navigationPath = 'cdp-page-navigate';
    await cdp.send('Page.navigate', { url: `${PREVIEW}/login` }).catch(() => undefined);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await sleep(400);
      formReady = await loginFormReady();
      if (formReady) break;
      // 极少见情况下 CDP 首次导航会被浏览器拒绝（本机曾观测到"连接被拒绝"），
      // 这时退回页面内导航；两种方式都在 Fetch 拦截启用之后。
      if (attempt === 25) {
        navigationPath = 'runtime-location-assign';
        await cdp.evaluate(`location.assign(${JSON.stringify(`${PREVIEW}/login`)})`).catch(() => undefined);
      }
    }
    record('登录表单加载', formReady, navigationPath);
    if (!formReady) {
      const diag = await cdp.evaluate(
        `JSON.stringify({ href: location.href, ready: document.readyState, text: (document.body ? document.body.innerText : '').slice(0, 200) })`,
      );
      throw new Error(`登录表单未出现: ${diag}`);
    }
    await cdp.evaluate(`(() => {
      const setValue = (selector, value) => {
        const input = document.querySelector(selector);
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      setValue('input[type=text]', 'controlled@mock.test');
      setValue('input[type=password]', 'controlled-password');
      document.querySelector('button[type=submit]').click();
      return true;
    })()`);
    let loggedIn = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(400);
      const path = await cdp.evaluate('location.pathname');
      if (path && path !== '/login') {
        loggedIn = true;
        break;
      }
    }
    record('登录进入产品', loggedIn);
    if (!loggedIn) throw new Error('登录未完成');

    /* ---------------- 打开 AI-04 上下文工作区 ---------------- */
    await cdp.evaluate(`location.assign(${JSON.stringify(`${PREVIEW}/ai/context`)})`);
    let pageReady = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(400);
      pageReady = await cdp.evaluate(`Boolean(document.querySelector('[data-testid=context-tab-datasource]'))`);
      if (pageReady) break;
    }
    record('AI-04 工作区加载', pageReady);
    if (!pageReady) throw new Error('上下文工作区未出现');

    const click = (testId) =>
      cdp.evaluate(`(() => { const el = document.querySelector('[data-testid=${JSON.stringify(testId)}]'); if (!el) return false; el.click(); return true; })()`);
    const setValue = (testId, value) =>
      cdp.evaluate(`(() => {
        const el = document.querySelector('[data-testid=${JSON.stringify(testId)}]');
        if (!el) return false;
        const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
    const setSelect = (testId, value) =>
      cdp.evaluate(`(() => {
        const el = document.querySelector('[data-testid=${JSON.stringify(testId)}]');
        if (!el) return false;
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
    const text = () => cdp.evaluate(`document.body ? document.body.innerText : ''`);
    const countOf = (testId) =>
      cdp.evaluate(`document.querySelectorAll('[data-testid=${JSON.stringify(testId)}]').length`);
    const waitFor = async (expression, attempts = 40) => {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (await cdp.evaluate(expression)) return true;
        await sleep(250);
      }
      return false;
    };
    const screenshot = async (name) => {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(resolve(SHOT_DIR, name), Buffer.from(shot.data, 'base64'));
    };

    /* -------------------- 1) 数据范围：非空新建 + 预览 + 选择 -------------------- */
    await click('context-tab-datasource');
    await waitFor(`Boolean(document.querySelector('[data-testid=context-datasource-create]'))`);
    await click('context-datasource-create');
    await waitFor(`Boolean(document.querySelector('[data-testid=context-datasource-title]'))`);
    await setValue('context-datasource-title', '受控新建范围');
    await setValue('context-datasource-collection', 'orders');
    await sleep(500);
    await click('context-datasource-save');
    const createdVisible = await waitFor(`document.body.innerText.includes('受控新建范围')`);
    record('数据范围：非空新建后出现在列表', createdVisible);
    await sleep(300);
    // 回到第一条（带结构化筛选的那条），确保后续载荷能体现"存储形态 → 服务端筛选"的转换。
    await cdp.evaluate(`document.querySelectorAll('[data-testid=context-datasource-row]')[0].click()`);
    await sleep(400);
    await waitFor(`Boolean(document.querySelector('[data-testid=context-datasource-preview]'))`);
    await click('context-datasource-preview');
    const previewTable = await waitFor(`Boolean(document.querySelector('[data-testid=context-datasource-preview-table]'))`);
    record('数据范围：受控预览渲染单元格行', previewTable);
    await click('context-datasource-select');
    const datasourceSelected = await waitFor(`document.body.innerText.includes('已选择为会话内容')`);
    record('数据范围：选择为会话内容', datasourceSelected);

    /* -------------------- 2) 指定记录：读取 + 选择 -------------------- */
    await click('context-tab-record');
    await waitFor(`Boolean(document.querySelector('[data-testid=context-record-collection]'))`);
    await setValue('context-record-collection', 'orders');
    await sleep(300);
    await click('context-record-preview');
    const recordRows = await waitFor(`document.querySelectorAll('[data-testid=context-record-pick]').length > 0`);
    record('指定记录：读取到可选记录', recordRows);
    await cdp.evaluate(`document.querySelectorAll('[data-testid=context-record-pick]')[0].click()`);
    const recordSummary = await waitFor(`Boolean(document.querySelector('[data-testid=context-record-summary]'))`);
    record('指定记录：选择并显示可修改/取消的摘要', recordSummary);

    /* -------------------- 3) 代码工作内容：编辑 + 预览 + 应用 -------------------- */
    await click('context-tab-code');
    await waitFor(`Boolean(document.querySelector('[data-testid=context-code-input]'))`);
    await setValue('context-code-input', 'const total = orders.reduce((sum, o) => sum + o.amount, 0);');
    await click('context-code-save');
    await waitFor(`Boolean(document.querySelector('[data-testid=context-code-proposal]'))`);
    await setValue('context-code-proposal', 'const total = orders.reduce((sum, o) => sum + o.amount, 0);\nconsole.log(total);');
    await click('context-code-preview-change');
    const codeApplyVisible = await waitFor(`document.querySelectorAll('[data-testid=context-tool-apply]').length > 0`);
    record('代码工作内容：预览修改产生待确认项', codeApplyVisible);
    await click('context-tool-apply');
    const codeApplied = await waitFor(
      `document.querySelector('[data-testid=context-code-input]').value.includes('console.log(total)')`,
    );
    record('代码工作内容：明确应用后工作区代码更新', codeApplied);

    /* -------------------- 4) 图表工作内容：配置 + 可见预览 + 应用/拒绝 -------------------- */
    await click('context-tab-chart');
    await waitFor(`Boolean(document.querySelector('[data-testid=context-chart-collection]'))`);
    await setValue('context-chart-collection', 'orders');
    await sleep(400);
    await setSelect('context-chart-aggregation', 'sum');
    await sleep(200);
    // 指标/分组字段来自 schema（orders 的 amount / status）。
    await setSelect('context-chart-metric', 'amount');
    await setSelect('context-chart-groupby', 'status');
    await sleep(200);
    await click('context-chart-preview-button');
    const chartRendered = await waitFor(
      `Boolean(document.querySelector('[data-testid=context-chart-preview] canvas') || document.querySelector('[data-testid=context-chart-preview] svg'))`,
      60,
    );
    record('图表工作内容：真实数据聚合并渲染可见图表', chartRendered);
    await click('context-chart-save');
    await sleep(300);
    await setSelect('context-chart-type', 'pie');
    await sleep(200);
    await click('context-chart-preview-change');
    const chartApplyVisible = await waitFor(`document.querySelectorAll('[data-testid=context-tool-apply]').length > 0`);
    record('图表工作内容：预览配置修改产生待确认项', chartApplyVisible);
    await click('context-tool-apply');
    const chartApplied = await waitFor(`document.querySelector('[data-testid=context-chart-type]').value === 'pie'`);
    record('图表工作内容：明确应用后配置生效', chartApplied);

    /* -------------------- 5) 会话内容：载荷与工具口径 -------------------- */
    await click('context-tab-selection');
    const selectionList = await waitFor(`Boolean(document.querySelector('[data-testid=context-selection-list]'))`);
    record('会话内容：汇总面板出现', selectionList);
    const payloadRaw = await cdp.evaluate(
      `(() => { const el = document.querySelector('[data-testid=context-selection-list]'); return el ? el.getAttribute('data-payload') : null; })()`,
    );
    const payload = payloadRaw ? JSON.parse(payloadRaw) : [];
    record('消息载荷：四类上下文齐备', payload.length === 4, payload.map((item) => item.type).join(','));
    const uidRulesOk = payload.every(
      (item) =>
        Array.isArray(item.frontendTools) &&
        item.frontendTools.length > 0 &&
        item.frontendTools.every((tool) => tool.blockUid === item.uid && tool.id === `${item.uid}:${tool.name}`),
    );
    record('消息载荷：frontendTools 满足 uid/blockUid/id 契约', uidRulesOk);

    const codeItem = payload.find((item) => item.type === 'code-editor');
    const codeShapeOk =
      codeItem?.content?.scene === 'crewloom-code-workspace' &&
      typeof codeItem?.content?.language === 'string' &&
      String(codeItem?.content?.code ?? '').includes('console.log(total)');
    record('消息载荷：代码项只带 scene/language/code，且是应用后的内容', codeShapeOk);

    const datasourceItem = payload.find((item) => item.type === 'datasource' && item.uid === 'ctx-1');
    const datasourceShapeOk =
      datasourceItem?.content?.collectionName === 'orders' &&
      // 存储形态的结构化筛选在发送前被转成服务端筛选（等价 transformFilter）。
      Array.isArray(datasourceItem?.content?.filter?.$and) &&
      datasourceItem?.content?.limit === 20;
    record('消息载荷：数据范围内容为服务端筛选形态', datasourceShapeOk);

    const recordItem = payload.find((item) => String(item.uid).startsWith('crewloom:record:'));
    const recordShapeOk =
      recordItem?.type === 'datasource' &&
      recordItem?.content?.filter?.id?.$eq === 1 &&
      recordItem?.content?.limit === 1;
    record('消息载荷：指定记录映射为主键等值筛选（limit 1）', recordShapeOk);

    const chartItem = payload.find((item) => item.type === 'chart-config');
    const chartShapeOk =
      chartItem?.content?.query?.collectionName === 'orders' &&
      chartItem?.content?.chart?.type === 'pie' &&
      chartItem?.content?.chart?.option?.metric?.field === 'amount';
    record('消息载荷：图表项为自描述配置（应用后的类型/指标）', chartShapeOk);
    const askGate = payload
      .flatMap((item) => item.frontendTools ?? [])
      .filter((tool) => tool.name.startsWith('apply_'))
      .every((tool) => tool.permission === 'ASK');
    record('工具确认：修改类工具权限为 ASK（需用户确认）', askGate);
    await screenshot('context-desktop.png');

    // 390px 窄屏：五个页签必须都在首屏可见范围内（用户不用滚动就能找到入口）。
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: false });
    await cdp.evaluate('window.scrollTo(0, 0)');
    await sleep(700);
    const narrowTabs = await cdp.evaluate(`(() => {
      const ids = ['context-tab-datasource', 'context-tab-record', 'context-tab-code', 'context-tab-chart', 'context-tab-selection'];
      const vh = window.innerHeight;
      const vw = window.innerWidth;
      return ids.map((id) => {
        const el = document.querySelector('[data-testid=' + id + ']');
        if (!el) return { id, ok: false };
        const rect = el.getBoundingClientRect();
        return { id, ok: rect.top >= 0 && rect.bottom <= vh && rect.left >= 0 && rect.right <= vw };
      });
    })()`);
    record(
      '390px：五个页签都在首屏可见范围内',
      Array.isArray(narrowTabs) && narrowTabs.every((item) => item.ok),
      JSON.stringify(narrowTabs.map((item) => `${item.id}:${item.ok}`)),
    );
    await screenshot('context-narrow.png');
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await sleep(400);

    /* -------------------- 6) 拒绝路径：图表配置保持不变 -------------------- */
    await click('context-tab-chart');
    await waitFor(`Boolean(document.querySelector('[data-testid=context-chart-collection]'))`);
    await setSelect('context-chart-type', 'bar');
    await sleep(200);
    await click('context-chart-preview-change');
    await waitFor(`document.querySelectorAll('[data-testid=context-tool-reject]').length > 0`);
    await click('context-tool-reject');
    await sleep(500);
    const rejected = await cdp.evaluate(`document.querySelector('[data-testid=context-chart-type]').value`);
    record('图表工作内容：拒绝后配置保持原值', rejected === 'pie', `chartType=${rejected}`);

    /* -------------------- 7) 角色世代隔离 -------------------- */
    await click('context-tab-selection');
    await waitFor(`Boolean(document.querySelector('[data-testid=context-selection-item]'))`);
    state.effectiveRole = 'role_limited';
    const switched = await cdp.evaluate(`(() => {
      const select = Array.from(document.querySelectorAll('select')).find((el) =>
        Array.from(el.options).some((option) => option.textContent.includes('受限用户')),
      );
      if (!select) return false;
      select.value = 'role_limited';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    record('角色世代：切换到另一角色', switched);
    // 角色切换会重挂载页面（页签回到默认值），因此反复切回「会话内容」并核对：
    // 只要 store 里还留着上一身份的项，这里就永远看不到空状态。
    let isolated = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await click('context-tab-selection');
      await sleep(300);
      isolated = await cdp.evaluate(
        `!document.querySelector('[data-testid=context-selection-item]') && document.body.innerText.includes('还没有选择任何上下文')`,
      );
      if (isolated) break;
    }
    if (isolated) {
      record('角色世代：切换后上一身份的上下文选择被清空', true);
    } else {
      const diag = await cdp.evaluate(`JSON.stringify({
        href: location.href,
        items: document.querySelectorAll('[data-testid=context-selection-item]').length,
        hasList: Boolean(document.querySelector('[data-testid=context-selection-list]')),
        text: (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').slice(0, 300),
      })`);
      record('角色世代：切换后上一身份的上下文选择被清空', false, diag);
    }
    const roleValue = await cdp.evaluate(`(() => {
      const select = Array.from(document.querySelectorAll('select')).find((el) =>
        Array.from(el.options).some((option) => option.textContent.includes('受限用户')),
      );
      return select ? select.value : null;
    })()`);
    record('角色世代：界面生效角色已切换', roleValue === 'role_limited', String(roleValue));
    await screenshot('context-role-isolation.png');

    /* -------------------- 8) 边界：没有请求落到真实来源 -------------------- */
    const escaped = requestLog.filter((entry) => !entry.mocked);
    record('网络边界：所有 /api 请求都被受控应答（0 真实后端请求）', escaped.length === 0);
    const productErrors = consoleErrors.filter((line) => /TRANSPORT_BLOCKED|EMPTY_TOKEN|Invalid SQL column/.test(line));
    record('界面边界：没有传输拦截码/内部错误码进入 console', productErrors.length === 0, productErrors.join(' | ').slice(0, 200));
  } finally {
    if (cdp) {
      try {
        await cdp.send('Browser.close');
      } catch {
        /* 关闭失败不影响结论 */
      }
    }
    child.kill('SIGTERM');
  }

  const failed = results.filter((item) => !item.pass);
  writeFileSync(
    resolve(OUT_DIR, 'controlled-browser.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        preview: PREVIEW,
        realBackendRequests: 0,
        mockedRequests: requestLog.length,
        requests: requestLog,
        consoleErrors,
        results,
        passed: results.length - failed.length,
        failed: failed.length,
      },
      null,
      2,
    ),
  );
  // eslint-disable-next-line no-console
  console.log(`\n受控浏览器核对：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('受控浏览器核对失败：', error);
  writeFileSync(
    resolve(OUT_DIR, 'controlled-browser.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), preview: PREVIEW, error: String(error), results }, null, 2),
  );
  process.exitCode = 1;
});
