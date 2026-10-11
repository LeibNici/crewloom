#!/usr/bin/env node
/**
 * 受控浏览器验收（真实 Chrome + CDP 传输层拦截）。
 *
 * 目的：在**不触碰真实后端**的前提下，用真实浏览器验证那些不能在 13080 上构造的场景：
 *  1. `role-revoked`：角色失效（401 ROLE_NOT_FOUND_FOR_USER）→ 清本地角色、保留令牌、
 *     重新读取本人角色与权限，不强制登出；
 *  2. `session-expired`：真正的会话失效（401 EXPIRED_SESSION）→ 清会话并回到登录页；
 *  3. `unknown-permission`：网络/5xx → 显示可重试的"暂时无法确认"，不放行，恢复后重试成功；
 *  4. `only-use-union`：不渲染角色切换控件，并显示合并身份；
 *  5. `pending-stats`：`stats.pending` 跨分页累加；某页失败时不显示部分累计，而是"—"。
 *
 * 安全边界：
 *  - 所有 `/api/*` 请求在浏览器网络层被 CDP 拦截并由本脚本用本机 mock 应答，
 *    真实后端 0 请求；mock 响应带 `x-crewloom-mock: 1`，应用侧据此把记录标为受控；
 *  - 被拦截的请求同样经过 `scripts/lib/transport-policy.mjs` 的允许清单校验，
 *    出现未授权动作即记为违规并让脚本失败；
 *  - 只记录 method / path / 动作 / 状态码 / 受控标记，不记录凭据与响应正文。
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyRequest, getRequestLog, POLICY } from './lib/transport-policy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.env.CREWLOOM_SHOT_DIR ?? resolve(here, '../../docs/acceptance/p1-repair/screenshots');
const BASE_URL = process.env.CREWLOOM_PREVIEW_URL ?? 'http://127.0.0.1:5273';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT ?? 9335);
const ONLY = process.env.CONTROLLED_ONLY ?? '';

const results = [];
function record(name, ok, note) {
  results.push({ name, ok, note });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? ` — ${note}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* mock 数据                                                           */
/* ------------------------------------------------------------------ */

const ROLES = [
  { name: 'role_admin', title: '配置权限' },
  { name: 'role_limited', title: '受限用户' },
];

function accessData({
  role = 'role_admin',
  roleMode = 'default',
  snippets = ['pm', 'pm.*', 'ui.*'],
  allowAll = false,
  strategy = null,
  roles = [role],
} = {}) {
  return {
    role,
    roleMode,
    strategy,
    actions: {},
    resources: [],
    snippets,
    allowAll,
    allowConfigure: false,
    allowAnonymous: false,
    allowMenuItemIds: [],
    uiButtonSchemasBlacklist: [],
    availableActions: ['create', 'view', 'update', 'destroy'],
    actionAlias: { list: 'view' },
    roles,
  };
}

/** 每个场景的共享可变状态（由场景在运行时改写，用来模拟"服务端状态变化"）。 */
function baseState(scenario) {
  return {
    scenario,
    roleRevoked: false,
    sessionExpired: false,
    probesDown: false,
    templateFailPage: 0,
    roleMode: 'default',
    effectiveRole: 'role_admin',
    templatePages: {
      1: { rows: [
        { workflowKey: 'wf-1', title: '流程 A', stats: { pending: 2, all: 5 } },
        { workflowKey: 'wf-2', title: '流程 B', stats: { pending: 3, all: 6 } },
      ], hasNext: true },
      2: { rows: [{ workflowKey: 'wf-3', title: '流程 C', stats: { pending: 4, all: 7 } }], hasNext: false },
    },
  };
}

const json = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');
const ok = (data, meta) => ({ code: 200, body: { data, ...(meta ? { meta } : {}) } });
const fail = (code, payload) => ({
  code,
  body: payload ?? { errors: [{ message: 'mock failure' }] },
});

function probeStatus(path, state) {
  if (state.probesDown) return 503;
  if (path.startsWith('workflows:list')) return 403;
  if (path.startsWith('dataSources:list')) return 403;
  if (path.startsWith('llmServices:list')) return 403;
  if (path.startsWith('roles:list')) return 403;
  if (path.startsWith('users:list')) return 403;
  if (path.startsWith('aiEmployees:list?')) return 403;
  return 200;
}

/** 依据 URL 与请求头生成受控响应。返回 { code, body }。 */
function respond(method, fullUrl, headers, state) {
  const parsed = new URL(fullUrl);
  const actionPath = parsed.pathname.replace(/^\/api\//, '');
  const headerValue = (name) => {
    const key = Object.keys(headers ?? {}).find((item) => item.toLowerCase() === name);
    return key ? headers[key] : '';
  };
  const xRole = headerValue('x-role');

  if (state.sessionExpired) {
    return fail(401, { errors: [{ message: 'session expired', code: 'EXPIRED_SESSION' }] });
  }
  if (actionPath.startsWith('authenticators:publicList')) {
    return ok([{ name: 'basic', authType: 'email', title: '邮箱/密码' }]);
  }
  if (actionPath.startsWith('auth:signIn')) {
    return ok({
      token: 'controlled-mock-token',
      user: { id: 13, email: 'multi@mock.test', nickname: '受控多角色账号' },
    });
  }
  // 角色被撤销后，任何仍携带该角色上下文的请求都会得到原生角色错误码。
  if (state.roleRevoked && xRole) {
    return fail(401, {
      errors: [{ message: 'The role does not belong to the user', code: 'ROLE_NOT_FOUND_FOR_USER' }],
    });
  }
  if (actionPath.startsWith('auth:check')) {
    return ok({ id: 13, nickname: '受控多角色账号', email: 'multi@mock.test', roles: ROLES });
  }
  if (actionPath.startsWith('roles:check')) {
    if (state.roleMode === 'only-use-union') {
      return ok(accessData({ role: '__union__', roleMode: 'only-use-union', roles: ROLES.map((r) => r.name) }));
    }
    const requestedRole = xRole && xRole !== '__union__' ? xRole : state.effectiveRole;
    const snippets = requestedRole === 'role_admin' ? ['pm', 'pm.*', 'ui.*'] : [];
    return ok(accessData({ role: requestedRole, roleMode: state.roleMode, snippets, roles: [requestedRole] }));
  }
  if (actionPath.startsWith('userWorkflowTaskStats:listMine')) {
    const page = Number(parsed.searchParams.get('page') ?? 1);
    if (state.templateFailPage && page === state.templateFailPage) {
      return fail(500, { errors: [{ message: 'stats page failed' }] });
    }
    const pageData = state.templatePages[page] ?? { rows: [], hasNext: false };
    return ok(pageData.rows, { page, pageSize: 200, hasNext: pageData.hasNext });
  }
  if (actionPath.startsWith('userWorkflowTasks:listMine')) {
    // 显式的按类型物化合计（原生 refreshUserWorkflowTaskTypeStats 的语义）。
    // 本场景构造为"全部流程都是当前版本、且没有 all=0 的行"，因此按类型的合计
    // 与按流程的合计在原生语义下应当一致：pending 5+4=9、all 11+7=18。
    // 真实环境两者口径可能不同（见 docs/acceptance/p1-repair.md §3.5），此处不改接口语义。
    return ok(
      [
        { id: 1, type: 'manual', stats: { pending: 5, all: 11 } },
        { id: 2, type: 'cc', stats: { pending: 4, all: 7 } },
      ],
      { count: 2, page: 1, pageSize: 50 },
    );
  }
  if (actionPath.startsWith('aiConversations:list')) {
    return ok([], { count: 0, page: 1, pageSize: 5 });
  }
  if (actionPath.startsWith('aiEmployees:listByUser')) {
    return ok([{ id: 1, nickname: '受控员工', position: '测试' }]);
  }
  // 其余探测
  const status = probeStatus(actionPath, state);
  if (status !== 200) return fail(status, { errors: [{ message: 'No permissions' }] });
  return ok([]);
}

/* ------------------------------------------------------------------ */
/* CDP                                                                 */
/* ------------------------------------------------------------------ */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
        return;
      }
      const handler = this.handlers.get(msg.method);
      if (handler) handler(msg.params);
    });
  }

  on(method, handler) {
    this.handlers.set(method, handler);
  }

  send(method, params = {}, sessionId = this.sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error(`CDP 超时：${method}`));
        }
      }, 30000);
    });
  }
}

async function waitForDevtools(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return await response.json();
    } catch {
      /* 继续等待 */
    }
    await sleep(250);
  }
  throw new Error('Chrome 调试端口未就绪');
}

/**
 * 量测"本人工作流待处理任务"卡片里数字与失败提示是否真的落在视口内
 * （用于证明截图不是靠编辑裁出来的）。
 */
async function measureTaskCard(evaluate) {
  const raw = await evaluate(`(() => {
    const section = Array.from(document.querySelectorAll('main section'))
      .find((s) => s.textContent.includes('本人工作流待处理任务'));
    if (!section) return JSON.stringify(null);
    const within = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), visible: r.top >= 0 && r.bottom <= window.innerHeight };
    };
    const valueEl = Array.from(section.querySelectorAll('strong')).find((el) => /^(9|—)$/.test(el.textContent.trim()));
    const noteEl = Array.from(section.querySelectorAll('p')).find((el) => el.textContent.includes('暂时无法读取全部待处理任务'));
    return JSON.stringify({
      value: valueEl ? valueEl.textContent.trim() : null,
      valueRect: within(valueEl),
      noteRect: within(noteEl),
      innerHeight: window.innerHeight,
    });
  })()`);
  return raw ?? 'null';
}

const SCENARIOS = ['role-revoked', 'session-expired', 'unknown-permission', 'only-use-union', 'pending-stats'];

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profileDir = mkdtempSync(join(tmpdir(), 'crewloom-controlled-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      '--remote-allow-origins=*',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-crash-reporter',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-gpu',
      '--hide-scrollbars',
      '--window-size=1280,900',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  chrome.stderr.on('data', () => {});

  let cdp;
  let state = baseState('role-revoked');
  const violations = [];
  const intercepted = [];

  try {
    const versionInfo = await waitForDevtools(DEBUG_PORT);
    const ws = new WebSocket(versionInfo.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('CDP WebSocket 连接超时')), 20000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        res();
      }, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true });
    });
    cdp = new Cdp(ws);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    cdp.sessionId = sessionId;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

    // 传输层拦截：所有 /api/* 由本机 mock 应答，真实后端 0 请求。
    const fetchErrors = [];
    cdp.on('Fetch.requestPaused', (params) => {
      handlePaused(params).catch((error) => {
        fetchErrors.push(String(error));
      });
    });
    const handlePaused = async (params) => {
      const url = params.request.url;
      const method = params.request.method;
      const decision = classifyRequest({
        method,
        url,
        mode: 'mock',
        allowedOrigins: [new URL(BASE_URL).origin],
      });
      intercepted.push({ method, path: decision.path, action: decision.action, decision: decision.decision });
      if (decision.decision === 'blocked') {
        violations.push({ method, path: decision.path, reason: decision.reason });
        await cdp.send('Fetch.fulfillRequest', {
          requestId: params.requestId,
          responseCode: 403,
          responseHeaders: [
            { name: 'content-type', value: 'application/json' },
            { name: 'x-crewloom-mock', value: '1' },
          ],
          body: json({ errors: [{ code: 'TRANSPORT_BLOCKED', message: 'blocked by controlled harness' }] }),
        });
        return;
      }
      const { code, body } = respond(method, url, params.request.headers, state);
      await cdp.send('Fetch.fulfillRequest', {
        requestId: params.requestId,
        responseCode: code,
        responseHeaders: [
          { name: 'content-type', value: 'application/json' },
          { name: 'x-crewloom-mock', value: '1' },
        ],
        body: json(body),
      });
    };
    // 只拦截后端 API 路径；不能用 */api/*（会误命中 Vite 的 /src/api/* 源码请求）。
    await cdp.send('Fetch.enable', {
      patterns: [{ urlPattern: `${new URL(BASE_URL).origin}/api/*`, requestStage: 'Request' }],
    });

    const evaluate = async (expression) => {
      const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(`页面脚本异常：${result.exceptionDetails.text}`);
      return result.result.value;
    };
    const shot = async (name) => {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      writeFileSync(join(OUT_DIR, name), Buffer.from(data, 'base64'));
    };
    const waitFor = async (fn, predicate, timeoutMs = 20000) => {
      const deadline = Date.now() + timeoutMs;
      let last;
      while (Date.now() < deadline) {
        last = await evaluate(`(${fn.toString()})()`);
        if (predicate(last)) return last;
        await sleep(200);
      }
      throw new Error(`等待条件超时，最后取值：${JSON.stringify(last)}`);
    };
    const pageLogs = [];
    cdp.on('Runtime.consoleAPICalled', (params) => {
      pageLogs.push(`[console.${params.type}] ${params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
    });
    cdp.on('Runtime.exceptionThrown', (params) => {
      pageLogs.push(`[exception] ${params.exceptionDetails.text} ${params.exceptionDetails.exception?.description ?? ''}`);
    });
    const diagnostics = async () => ({
      path: await evaluate('location.pathname'),
      body: (await evaluate('document.body.innerText || ""')).replace(/\s+/g, ' ').slice(0, 200),
      transport: await evaluate('JSON.stringify(window.__CREWLOOM_TRANSPORT__ ?? null)'),
      intercepted: intercepted.slice(-12),
      fetchErrors,
      logs: pageLogs.slice(-8),
    });
    const waitReady = () =>
      waitFor(() => (document.querySelector('aside')?.textContent ?? ''), (t) => t.includes('模块'), 25000).catch(
        async (error) => {
          throw new Error(`${error.message}\n诊断：${JSON.stringify(await diagnostics())}`);
        },
      );

    const signInMock = async () => {
      await cdp.send('Page.navigate', { url: `${BASE_URL}/login` });
      await sleep(1200);
      await evaluate(`(() => {
        window.localStorage.setItem('crewloom.session.token', 'controlled-mock-token');
        window.localStorage.setItem('crewloom.session.auth', 'basic');
        return true;
      })()`);
      await cdp.send('Page.navigate', { url: `${BASE_URL}/workbench/overview` });
      await sleep(600);
      await waitReady();
    };

    for (const scenario of SCENARIOS) {
      if (ONLY && scenario !== ONLY) continue;
      state = baseState(scenario);
      if (scenario === 'session-expired') state.sessionExpired = true;
      if (scenario === 'unknown-permission') state.probesDown = true;
      if (scenario === 'only-use-union') state.roleMode = 'only-use-union';
      await cdp.send('Page.navigate', { url: `${BASE_URL}/login` });
      await sleep(600);
      await evaluate('window.localStorage.clear()');
      if (scenario === 'session-expired') state.sessionExpired = false;

      if (scenario === 'role-revoked') {
        await signInMock();
        const before = await evaluate(`JSON.stringify({
          path: location.pathname,
          options: Array.from(document.querySelectorAll('select[aria-label="切换当前角色"] option')).map((o) => o.textContent.trim()),
        })`);
        // 在界面上切到受限角色，随后该角色被撤销。
        await evaluate(`(() => {
          const select = document.querySelector('select[aria-label="切换当前角色"]');
          const option = Array.from(select.options).find((o) => o.textContent.includes('受限用户'));
          const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
          setter.call(select, option.value);
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return option.value;
        })()`);
        await sleep(800);
        state.roleRevoked = true;
        // 触发一次携带 X-Role 的请求（工作台的"刷新"按钮）。
        await evaluate(`(() => {
          const button = Array.from(document.querySelectorAll('main button')).find((b) => b.textContent.includes('刷新'));
          if (button) button.click();
          return !!button;
        })()`);
        await sleep(2500);
        const after = await evaluate(`JSON.stringify({
          path: location.pathname,
          hasToken: window.localStorage.getItem('crewloom.session.token') !== null,
          text: (document.querySelector('main')?.textContent ?? '').slice(0, 400),
          roleValue: document.querySelector('select[aria-label="切换当前角色"]')?.value ?? '(none)',
          cleared: window.localStorage.getItem('crewloom.session.role') === null,
        })`);
        const parsed = JSON.parse(after);
        record(
          '角色被撤销：不强制登出，保留令牌并重新读取本人角色',
          parsed.path.startsWith('/workbench') && parsed.hasToken === true && parsed.cleared === true,
          `path=${parsed.path} hasToken=${parsed.hasToken} roleCleared=${parsed.cleared}`,
        );
        record(
          '角色被撤销后界面给出友好说明，且候选仍来自 auth:check',
          parsed.text.includes('原来的角色已不可用') && parsed.text.includes('配置权限'),
          parsed.text.replace(/\s+/g, ' ').slice(0, 140),
        );
        record('角色撤销场景的初始候选来自 auth:check（两个角色）', before.includes('配置权限') && before.includes('受限用户'), before);
        await shot('c01-role-revoked.png');
      }

      if (scenario === 'session-expired') {
        await signInMock();
        state.sessionExpired = true;
        await evaluate(`(() => {
          const button = Array.from(document.querySelectorAll('main button')).find((b) => b.textContent.includes('刷新'));
          if (button) button.click();
          return !!button;
        })()`);
        await sleep(2500);
        const after = await evaluate(`JSON.stringify({
          path: location.pathname,
          hasToken: window.localStorage.getItem('crewloom.session.token') !== null,
        })`);
        const parsed = JSON.parse(after);
        record(
          '会话真正失效：退出到登录页并清空本地令牌',
          parsed.path.startsWith('/login') && parsed.hasToken === false,
          `path=${parsed.path} hasToken=${parsed.hasToken}`,
        );
        await shot('c02-session-expired.png');
      }

      if (scenario === 'unknown-permission') {
        await signInMock();
        const unknownState = await evaluate(`JSON.stringify({
          hint: document.querySelector('aside')?.textContent ?? '',
          banner: Array.from(document.querySelectorAll('[role="status"]')).map((n) => n.textContent).join(' | '),
        })`);
        record(
          '服务故障时不做权限断言：显示可重试的"无法确认"，不显示"无权限"',
          unknownState.includes('暂时无法确认') && !unknownState.includes('无法进入'),
          unknownState.replace(/\s+/g, ' ').slice(0, 160),
        );
        await cdp.send('Page.navigate', { url: `${BASE_URL}/model/services` });
        await sleep(2500);
        const deepText = await evaluate(`document.querySelector('main')?.textContent ?? ''`);
        record(
          '故障期间深链保持未知（不是"无权限"），且不放行',
          deepText.includes('暂时无法确认') && !deepText.includes('无法进入'),
          deepText.replace(/\s+/g, ' ').slice(0, 120),
        );
        await shot('c03-unknown-permission.png');

        // 服务仍在故障时点重试 → 仍保持未知；随后服务恢复再重试 → 重新判定
        await cdp.send('Page.navigate', { url: `${BASE_URL}/workbench/overview` });
        await sleep(2000);
        const clickRetry = () =>
          evaluate(`(() => {
            const button = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === '重试');
            if (button) button.click();
            return !!button;
          })()`);
        await clickRetry();
        await sleep(1800);
        const stillUnknown = await evaluate(
          `Array.from(document.querySelectorAll('[role="status"]')).some((n) => n.textContent.includes('暂时无法确认'))`,
        );
        record('服务仍不可用时重试后保持未知（不放行）', stillUnknown === true, `bannerStillUnknown=${stillUnknown}`);
        state.probesDown = false;
        await clickRetry();
        await sleep(2500);
        const recovered = await evaluate(
          `JSON.stringify({
            unknownText: Array.from(document.querySelectorAll('[role="status"]'))
              .filter((n) => n.textContent.includes('暂时无法确认')).length,
            nav: Array.from(document.querySelectorAll('aside nav a')).map((a) => a.textContent.trim()),
          })`,
        );
        const parsed = JSON.parse(recovered);
        record(
          '服务恢复后重试可重新判定权限（未知状态消失、菜单按新结果更新）',
          parsed.unknownText === 0 && parsed.nav.length >= 3,
          `unknownBanners=${parsed.unknownText} nav=${parsed.nav.join('|')}`,
        );
        await shot('c04-unknown-recovered.png');
      }

      if (scenario === 'only-use-union') {
        await signInMock();
        const unionState = await evaluate(`JSON.stringify({
          hasSelect: !!document.querySelector('select[aria-label="切换当前角色"]'),
          text: document.querySelector('main')?.textContent ?? '',
        })`);
        const parsed = JSON.parse(unionState);
        record(
          'only-use-union：不渲染角色切换控件，并显示合并身份',
          parsed.hasSelect === false && parsed.text.includes('正在使用全部角色的合并权限'),
          `hasSelect=${parsed.hasSelect}`,
        );
        await shot('c05-only-use-union.png');
      }

      if (scenario === 'pending-stats') {
        // 这一场景需要把"本人工作流待处理任务"卡片与失败提示放进截图视口，
        // 因此用更高的视口并把卡片滚到视口内（真实渲染，不做任何截图编辑）。
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: 1280,
          height: 1200,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await signInMock();
        await evaluate(`(() => {
          const section = Array.from(document.querySelectorAll('main section'))
            .find((s) => s.textContent.includes('本人工作流待处理任务'));
          if (section) section.scrollIntoView({ block: 'center' });
          return !!section;
        })()`);
        await sleep(400);
        const multi = await evaluate(
          `(() => { const m = (document.querySelector('main')?.textContent ?? '').match(/待处理任务\\s*(\\d+|—)/); return m ? m[1] : null; })()`,
        );
        const multiRect = JSON.parse(await measureTaskCard(evaluate));
        record(
          '多页 stats.pending 全部累加后才显示总数（2+3+4=9）',
          multi === '9',
          `value=${multi}`,
        );
        record(
          '数字 9 实际进入截图视口',
          multiRect?.value === '9' && multiRect?.valueRect?.visible === true,
          JSON.stringify(multiRect),
        );
        const successCopy = await evaluate(`(() => {
          const section = Array.from(document.querySelectorAll('main section'))
            .find((s) => s.textContent.includes('本人工作流待处理任务'));
          const text = section ? section.textContent : '';
          return JSON.stringify({
            hint: /累计 18 条工作流任务/.test(text),
            noPageInfo: !/页|已读取/.test(text),
            typeRows: ['人工待办', '抄送'].every((label) => text.includes(label)),
            manual: /人工待办\\s*待处理 5\\s*累计 11/.test(text.replace(/\\s+/g, ' ')),
            cc: /抄送\\s*待处理 4\\s*累计 7/.test(text.replace(/\\s+/g, ' ')),
          });
        })()`);
        const copyState = JSON.parse(successCopy);
        record(
          '成功状态只表达业务含义（累计任务数），不出现页数等实现细节',
          copyState.hint === true && copyState.noPageInfo === true,
          JSON.stringify(copyState),
        );
        record(
          '受控 fixture 显式给出互相一致的按类型非空数据（manual 5/11 + cc 4/7 → 9/18）',
          copyState.typeRows === true && copyState.manual === true && copyState.cc === true,
          JSON.stringify(copyState),
        );
        await shot('c06-pending-multipage.png');

        state.templateFailPage = 2;
        await evaluate(`(() => {
          const button = Array.from(document.querySelectorAll('main button')).find((b) => b.textContent.includes('刷新'));
          if (button) button.click();
          return !!button;
        })()`);
        await sleep(2500);
        await evaluate(`(() => {
          const section = Array.from(document.querySelectorAll('main section'))
            .find((s) => s.textContent.includes('本人工作流待处理任务'));
          if (section) section.scrollIntoView({ block: 'center' });
          return !!section;
        })()`);
        await sleep(400);
        const partial = await evaluate(`JSON.stringify({
          value: (() => { const m = (document.querySelector('main')?.textContent ?? '').match(/待处理任务\\s*(\\d+|—)/); return m ? m[1] : null; })(),
          note: document.querySelector('main')?.textContent?.includes('暂时无法读取全部待处理任务，请刷新重试') ?? false,
          // 只检查这条失败提示本身是否含内部技术词（页面其它位置的正常文案不在此范围）。
          internalWords: (() => {
            const el = Array.from(document.querySelectorAll('main p'))
              .find((p) => p.textContent.includes('暂时无法读取全部待处理任务'));
            if (!el) return true;
            return /分页|总数|统计行|meta|接口|端点|后端返回/.test(el.textContent);
          })(),
          // 失败时不保留上一次成功读取的累计数字（不能拿旧汇总/部分累计充数）。
          staleTotals: (() => {
            const section = Array.from(document.querySelectorAll('main section'))
              .find((s) => s.textContent.includes('本人工作流待处理任务'));
            return section ? /累计 \\d+ 条工作流任务/.test(section.textContent) : true;
          })(),
        })`);
        const parsed = JSON.parse(partial);
        const partialRect = JSON.parse(await measureTaskCard(evaluate));
        record(
          '某页失败时不显示部分累计，而是"—"并给出普通用户能看懂的完整性提示',
          parsed.value === '—' &&
            parsed.note === true &&
            parsed.internalWords === false &&
            parsed.staleTotals === false,
          JSON.stringify(parsed),
        );
        record(
          '失败提示与"—"实际进入截图视口',
          partialRect?.value === '—' &&
            partialRect?.valueRect?.visible === true &&
            partialRect?.noteRect?.visible === true,
          JSON.stringify(partialRect),
        );
        await shot('c07-pending-partial-failure.png');
      }
    }

    record(
      '受控拦截的请求全部在允许清单内（无未授权动作）',
      violations.length === 0 && intercepted.length > 0,
      `intercepted=${intercepted.length} violations=${violations.length}${violations.length ? ` ${JSON.stringify(violations)}` : ''}`,
    );
  } finally {
    try {
      if (cdp) await cdp.send('Browser.close');
    } catch {
      /* 忽略 */
    }
    chrome.kill('SIGTERM');
    await sleep(400);
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  }

  const failed = results.filter((item) => !item.ok);
  const summary = {
    baseUrl: BASE_URL,
    outDir: OUT_DIR,
    finishedAt: new Date().toISOString(),
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    policy: { backendOrigin: POLICY.backendOrigin, readActions: POLICY.readActions, writeActions: POLICY.writeActions },
    intercepted,
    violations,
    nodeRequestLog: getRequestLog(),
    results,
  };
  writeFileSync(join(OUT_DIR, 'browser-controlled.json'), JSON.stringify(summary, null, 2));
  console.log(`\n受控浏览器验收：${summary.passed}/${summary.total} 通过；截图目录 ${OUT_DIR}`);
  if (failed.length > 0 || violations.length > 0) process.exitCode = 1;
}

await main();
