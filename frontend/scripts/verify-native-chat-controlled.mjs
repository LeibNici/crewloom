#!/usr/bin/env node
/**
 * AI-03 原生 ChatBox + AI-04 上下文/工具桥的**受控交互**核对
 * （真实 Chrome + 本机受控 HTTP/SSE 后端 + 真实产品源码）。
 *
 * 运行前提：目标地址是一个 `CREWLOOM_CONTROLLED_AI=1` 的 dev 服务
 * （`scripts/lib/controlled-ai-middleware.mjs` 在本机应答会话/上传/上下文写入，
 * 并把其它非 GET 请求一律 403 拦下；其余请求走真实 13000 只读代理）。
 *
 * 覆盖（每条都有 DOM / 请求两侧证据）：
 *  1. 桌面与 390px 下原生会话控件的**几何 + 命中测试**，并真实点击输入/发送/附件/员工选择；
 *  2. 受控流式六态：正常结束 / 失败（中文）/ 显式中止 / 断线（中文）/ 旧会话帧隔离 / 续流缓存缺失；
 *  3. `aiFiles:create`：真实 file input → multipart（字段名 `file`、文件名、字节、sha256）→
 *     元数据展示 → 移除后不再随消息发送 → 保留时随**首条消息** `attachments` 落 payload；
 *  4. 首条消息的 `workContext`：四类上下文项 + 每项 `frontendToolIds`（`<uid>:<name>` 形状）；
 *  5. 原生两阶段工具确认：3 条工具逐条 `updateUserDecision`（允许 / 拒绝 / 允许）→
 *     `resumeToolCall` 带正确 `{id,result}`（拒绝项不执行、失败项回传 error）→
 *     真实 `FrontendToolRegistry` 执行后**产品工作区内容真的变了**；
 *  6. 历史（非空、消息数组形态）与切换会话的隔离。
 *
 * 用法：
 *   CREWLOOM_PREVIEW_URL=http://127.0.0.1:5310 node scripts/verify-native-chat-controlled.mjs
 *   CREWLOOM_VERIFY_SKIP=contexts,tools   # 只跑布局/流式（迭代用）
 */

import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { launchChrome, createPage, readSecrets, sleep, RECT_PROBE } from './lib/cdp-session.mjs';

const BASE_URL = process.env.CREWLOOM_PREVIEW_URL ?? 'http://127.0.0.1:5310';
const SECRET_PATH =
  process.env.CREWLOOM_13000_SECRETS ?? resolve(process.cwd(), '../../../.secrets/full-pages-13000-20261011.json');
const OUT_DIR = process.env.CREWLOOM_CONTROLLED_SHOT_DIR ?? resolve(process.cwd(), '.shots/ai-controlled');
const REPORT_PATH = process.env.CREWLOOM_CONTROLLED_REPORT ?? resolve(OUT_DIR, 'controlled-native-chat.json');
const SKIP = new Set(String(process.env.CREWLOOM_VERIFY_SKIP ?? '').split(',').filter(Boolean));

const results = [];
function record(name, ok, note = '') {
  results.push({ name, ok: Boolean(ok), note });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? ` — ${note}` : ''}`);
}

let desktopProbe = null;
let narrowProbe = null;

const secrets = readSecrets(SECRET_PATH);
const { cdp, cleanup } = await launchChrome({ debugPort: Number(process.env.CHROME_DEBUG_PORT ?? 9382) });
const page = createPage({ cdp, baseUrl: BASE_URL, outDir: OUT_DIR });

const FRAME = '[data-testid="native-chatbox-frame"]';
const SELECTORS = {
  frame: FRAME,
  input: `${FRAME} textarea`,
  send: `${FRAME} button.ant-btn-circle.ant-btn-primary`,
  attach: `${FRAME} button:has(.anticon-paper-clip)`,
  context: `${FRAME} button:has(.anticon-appstore-add)`,
  search: `${FRAME} button:has(.anticon-global)`,
  employee: `${FRAME} .ant-dropdown-trigger`,
  panel: `${FRAME} > div[role="dialog"]`,
};

/**
 * SPA 内路由跳转（React Router 的 popstate 通道）。
 *
 * 必须用它而不是 `page.goto`：`Page.navigate` 会**整页重载**，浏览器内存里的模块状态
 * （AI-04 的上下文选择、原生宿主单例）都会被清掉——那正是"准备好了内容却在会话里看不到"的假象来源。
 */
async function spaGoto(path) {
  await page.evaluate(`(() => {
    history.pushState({}, '', ${JSON.stringify(path)});
    window.dispatchEvent(new PopStateEvent('popstate'));
  })()`);
  await sleep(1200);
}

async function frameText() {
  return page.evaluate(`(() => { const f = document.querySelector(${JSON.stringify(FRAME)}); return f ? f.innerText : ''; })()`);
}

async function messageShape() {
  return page.evaluate(
    `(() => { const api = window.__CREWLOOM_NATIVE_AI__; return api ? api.describe().messageShape : null; })()`,
  );
}

/**
 * 在原生宿主里按 `aria-label` 正则点击一个元素（原生控件没有 data-testid）。
 * 找不到时返回 `{ok:false}`，调用方据此判断，而不是把"元素存在"当成"点击生效"。
 */
async function clickFrameAria(patternSource) {
  return page.evaluate(`(() => {
    const frame = document.querySelector(${JSON.stringify(FRAME)});
    if (!frame) return { ok: false, reason: 'no-frame' };
    const matcher = new RegExp(${JSON.stringify(patternSource)});
    const all = [...frame.querySelectorAll('[aria-label]')];
    const el = all.find((node) => matcher.test(node.getAttribute('aria-label') || ''));
    if (!el) {
      return { ok: false, reason: 'no-match', labels: all.map((node) => node.getAttribute('aria-label')).slice(0, 24) };
    }
    el.click();
    return { ok: true, label: el.getAttribute('aria-label') || '', tag: el.tagName };
  })()`);
}

/**
 * 关掉会话列表浮层。
 *
 * 非展开态下原生会渲染一个铺满宿主、`z-index:10` 的关闭遮罩（`aria-label="Close conversation list"`），
 * 列表面板再盖在它上面。390px 时这个浮层会压住输入区——不先关掉，
 * 控件命中测试会把"浮层挡着"误判成控件本身不可用。
 */
async function closeConversationList() {
  const open = await page.evaluate(`(() => {
    const frame = document.querySelector(${JSON.stringify(FRAME)});
    if (!frame) return false;
    const panel = frame.querySelector('.ai-chatbox-conversations-list');
    const overlay = [...frame.querySelectorAll('[aria-label]')].some((node) =>
      /Close conversation list|关闭会话列表/.test(node.getAttribute('aria-label') || ''),
    );
    return overlay || Boolean(panel && panel.getBoundingClientRect().height > 0);
  })()`);
  if (!open) return { open: false, closed: false };
  let closed = await clickFrameAria('Close conversation list|关闭会话列表');
  if (!closed.ok) closed = await clickFrameAria('Conversation list|会话列表');
  await sleep(600);
  return { open: true, closed: closed.ok };
}

/** 真实点击原生「新会话」按钮（让 `currentConversation` 离开目标会话，才能触发 resumeAfterLoad）。 */
async function startNewConversation() {
  let clicked = await clickFrameAria('New conversation|新会话|新建会话');
  if (!clicked.ok) {
    // 原生按钮的 aria-label 随 i18n 变化；兜底按图标类名定位（仍是同一个真实按钮）。
    clicked = await page.evaluate(`(() => {
      const frame = document.querySelector(${JSON.stringify(FRAME)});
      if (!frame) return { ok: false, reason: 'no-frame' };
      const button = frame.querySelector('button:has(.anticon-plus-circle)');
      if (!button) {
        return {
          ok: false,
          reason: 'no-new-conversation-button',
          labels: [...frame.querySelectorAll('[aria-label]')].map((node) => node.getAttribute('aria-label')).slice(0, 24),
        };
      }
      button.click();
      return { ok: true, via: 'icon' };
    })()`);
  }
  await sleep(1000);
  return clicked;
}

/**
 * 用**真实鼠标事件**点击会话列表里的某条会话。
 *
 * `el.click()` 在 @ant-design/x 的 Conversations 上不一定触发 `onActiveChange`
 * （它的可点击区域/事件绑定在特定容器上），因此这里先取可点击容器的矩形，再走
 * `Input.dispatchMouseEvent` 的真实命中路径，并回报点击后的 currentConversation 以自证。
 */
async function clickConversationByTitle(title) {
  // 会话列表是异步刷新的：等目标标题真的出现在列表里再点，避免"刷新未完成 → no-item"。
  await waitFor(
    async () =>
      page.evaluate(`(() => {
        const frame = document.querySelector(${JSON.stringify(FRAME)});
        if (!frame) return false;
        return [...frame.querySelectorAll('*')].some((el) => (el.textContent || '').trim() === ${JSON.stringify(title)});
      })()`),
    { timeoutMs: 15000, intervalMs: 400, label: `会话项 ${title}` },
  ).catch(() => {});
  const box = await page.evaluate(`(() => {
    const frame = document.querySelector(${JSON.stringify(FRAME)});
    if (!frame) return { ok: false, reason: 'no-frame' };
    const target = [...frame.querySelectorAll('*')].find((el) => (el.textContent || '').trim() === ${JSON.stringify(title)});
    if (!target) return { ok: false, reason: 'no-item', text: (frame.innerText || '').slice(0, 160) };
    const clickable = target.closest('[class*="conversations-item"]') || target.closest('li') || target;
    clickable.scrollIntoView({ block: 'center' });
    const rect = clickable.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return { ok: false, reason: 'empty-rect' };
    return { ok: true, x: rect.left + rect.width / 2, y: rect.top + Math.min(rect.height / 2, 16) };
  })()`);
  if (!box.ok) return box;
  await sleep(150);
  await page.clickAt(box.x, box.y);
  await sleep(800);
  const currentSession = await page.evaluate(
    `(() => { const api = window.__CREWLOOM_NATIVE_AI__; const state = api ? api.describe().toolCallState : null; return state ? state.sessionId : null; })()`,
  );
  return { ok: true, title, currentSession: currentSession ?? null };
}

async function controlledLog() {
  const response = await fetch(`${BASE_URL}/__crewloom/controlled-log`);
  return response.json();
}

/** 只取本次运行产生的证据（受控服务是长驻进程，日志会跨运行累积，且超过上限会被截断）。 */
let evidenceBaseline = 0;
async function newEntries(kind) {
  const log = await controlledLog();
  const entries = log.entries
    .filter((entry) => (typeof entry.seq === 'number' ? entry.seq > evidenceBaseline : true))
    .filter((entry) => !kind || entry.kind === kind);
  return entries;
}

async function waitFor(predicate, { timeoutMs = 25000, intervalMs = 300, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const value = await predicate();
    if (value) return value;
    // eslint-disable-next-line no-await-in-loop
    await sleep(intervalMs);
  }
  throw new Error(`等待超时：${label}`);
}

async function typeIntoNative(text) {
  const focused = await page.evaluate(`(() => {
    const box = document.querySelector(${JSON.stringify(SELECTORS.input)});
    if (!box) return false;
    box.focus();
    return true;
  })()`);
  if (!focused) return false;
  await page.typeText(text);
  await sleep(120);
  return true;
}

async function sendNative(text) {
  if (!(await typeIntoNative(text))) return false;
  await page.pressEnter();
  return true;
}

async function setTestIdValue(testId, value) {
  // 按元素真实类型取 setter：React 受控组件必须走原型 setter + 原生事件才会更新状态。
  return page.evaluate(`(() => {
    const el = document.querySelector('[data-testid=' + JSON.stringify(${JSON.stringify(testId)}) + ']');
    if (!el) return { ok: false, reason: 'missing' };
    const proto =
      el instanceof window.HTMLSelectElement
        ? window.HTMLSelectElement.prototype
        : el instanceof window.HTMLTextAreaElement
          ? window.HTMLTextAreaElement.prototype
          : el instanceof window.HTMLInputElement
            ? window.HTMLInputElement.prototype
            : null;
    if (!proto) return { ok: false, reason: 'unsupported-tag:' + el.tagName };
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, ${JSON.stringify(String(value))});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  })()`);
}

/** 等原生 select 真的出现目标 option（选项是异步加载的，设置过早会被 React 重置）。 */
async function waitForOption(testId, value) {
  return waitFor(
    async () =>
      page.evaluate(`(() => {
        const el = document.querySelector('[data-testid=' + JSON.stringify(${JSON.stringify(testId)}) + ']');
        if (!el || el.tagName !== 'SELECT') return null;
        return [...el.options].some((option) => option.value === ${JSON.stringify(String(value))}) ? true : null;
      })()`),
    { timeoutMs: 20000, label: `${testId} 选项 ${value}` },
  ).catch(() => false);
}

async function clickTestId(testId, index = 0) {
  return page.clickSelector(`[data-testid=${JSON.stringify(testId)}]`, { index });
}

/**
 * 点击一个控件：先真实鼠标点击（会滚动到视口并做命中测试），
 * 命中失败时退回元素自身的 click()（React 合成事件同样会触发），并回报用了哪条路径。
 */
async function clickControl(testId, index = 0) {
  const selector = `[data-testid=${JSON.stringify(testId)}]`;
  const probe = await page.evaluate(RECT_PROBE(`${selector}`));
  const realClick = await page.clickSelector(selector, { index });
  if (realClick) return { ok: true, via: 'mouse', probe };
  const fallback = await page.evaluate(`(() => {
    const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
    if (!el) return false;
    el.click();
    return true;
  })()`);
  return { ok: Boolean(fallback), via: 'element', probe };
}

async function countTestId(testId) {
  return page.evaluate(`document.querySelectorAll('[data-testid=' + JSON.stringify(${JSON.stringify(testId)}) + ']').length`);
}

/** 控件几何：先滚动到视口内，再判断矩形与命中测试。 */
async function probeControls() {
  const out = {};
  for (const [name, selector] of Object.entries(SELECTORS)) {
    if (name === 'panel') continue;
    await page.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return;
      try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch {}
    })()`);
    out[name] = await page.evaluate(RECT_PROBE(selector));
  }
  return out;
}

function controlsOk(probe) {
  const failures = [];
  for (const [name, info] of Object.entries(probe)) {
    if (!info) {
      failures.push(`${name}:missing`);
      continue;
    }
    if (!info.visible) failures.push(`${name}:hidden`);
    if (!info.inViewport) failures.push(`${name}:offscreen(${JSON.stringify(info.rect)},${JSON.stringify(info.viewport)})`);
    if (!info.hitTest) failures.push(`${name}:blocked`);
  }
  return { ok: failures.length === 0, failures };
}

async function login() {
  await page.goto('/login');
  await sleep(1200);
  await page.evaluate(`(() => {
    const set = (el, value) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const email = document.querySelector('input[type="text"], input[type="email"]');
    const password = document.querySelector('input[type="password"]');
    if (email) set(email, ${JSON.stringify(String(secrets.email))});
    if (password) set(password, ${JSON.stringify(String(secrets.password))});
    return Boolean(email && password);
  })()`);
  await sleep(200);
  await page.clickSelector('button[type="submit"]');
  await sleep(4500);
  return page.evaluate('location.pathname');
}

async function waitForNativeChat() {
  let last = { hasFrame: false, hasInput: false };
  await waitFor(
    async () => {
      last = await page.evaluate(`(() => {
        const frame = document.querySelector(${JSON.stringify(FRAME)});
        const box = frame ? frame.querySelector('textarea') : null;
        return { hasFrame: Boolean(frame), hasInput: Boolean(box) };
      })()`);
      // 只有真的出现输入框才算就绪：返回对象恒为真值，必须显式判断。
      return last.hasFrame && last.hasInput ? last : null;
    },
    { timeoutMs: 120000, intervalMs: 1500, label: '原生会话输入框' },
  ).catch(() => {});
  return last;
}

/** AI-04：准备四类上下文（数据范围由受控中间件应答，其余为真实只读数据）。 */
async function prepareContexts() {
  const steps = [];
  /** 页签上的 `会话内容（n）` 就是当前已选条数：不用切换页签也能确认每一步是否生效。 */
  const selectedCount = async () => {
    const text = await page.evaluate(
      `((document.querySelector('[data-testid="context-tab-selection"]') || {}).textContent || '')`,
    );
    const match = /（(\d+)）/.exec(String(text));
    return match ? Number(match[1]) : 0;
  };
  const ensureGrew = async (label, before, click, { attempts = 3, timeoutMs = 8000 } = {}) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await click();
      const ok = await waitFor(
        async () => ((await selectedCount()) > before ? true : null),
        { timeoutMs, intervalMs: 400, label },
      ).catch(() => false);
      if (ok) {
        steps.push({ label, count: await selectedCount() });
        return true;
      }
    }
    steps.push({ label, count: await selectedCount(), failed: true });
    return false;
  };

  // 0) 数据范围 fixture：本轮的 13000 账号是**真实只读角色**，`aiContextDatasources:create`
  //    不在其 ACL 里，界面的「新建数据范围」会被真实权限置灰。这里按受控运行的口径把这条
  //    记录写进**本机中间件**（POST 只到 127.0.0.1 的受控端点，不到真实后端），
  //    随后仍然走真实产品界面把它选为会话内容——验证的是"界面选择 → 首条消息 workContext"链路。
  let seededDatasource = null;
  try {
    const seeded = await fetch(`${BASE_URL}/api/aiContextDatasources:create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: '受控数据范围',
        datasource: 'main',
        collectionName: 'aiContextDatasources',
        fields: ['title'],
        filter: null,
        sort: null,
        limit: 5,
      }),
    });
    seededDatasource = (await seeded.json())?.data ?? null;
  } catch (error) {
    seededDatasource = { error: String(error?.message ?? error) };
  }
  steps.push({ label: 'datasource-fixture', id: seededDatasource?.id ?? null });

  await page.goto('/ai/context');
  await sleep(1800);

  // 1) 数据范围（选择本机受控 fixture；真实只读角色没有 create 权限，新建入口按设计不可用）
  await clickTestId('context-tab-datasource');
  await sleep(500);
  await waitFor(() => countTestId('context-datasource-row'), { timeoutMs: 15000, label: '数据范围行' }).catch(() => {});
  const datasourceRows = await countTestId('context-datasource-row');
  if (datasourceRows === 0) {
    steps.push({ label: 'datasource-select', count: 0, failed: true, reason: 'no-controlled-row' });
  } else {
    await ensureGrew('datasource-select', 0, () => clickTestId('context-datasource-select'));
  }

  // 2) 代码工作内容（纯本地）
  await clickTestId('context-tab-code');
  await sleep(400);
  await setTestIdValue('context-code-input', 'const before = 1;\n');
  await sleep(200);
  await ensureGrew('code-save', await selectedCount(), () => clickTestId('context-code-save'));

  // 3) 图表工作内容（字段选择走真实 collections 读取）
  await clickTestId('context-tab-chart');
  await sleep(800);
  await waitForOption('context-chart-collection', 'dataSources');
  await setTestIdValue('context-chart-collection', 'dataSources');
  await sleep(400);
  await setTestIdValue('context-chart-fields', 'name');
  await sleep(200);
  await ensureGrew('chart-save', await selectedCount(), () => clickTestId('context-chart-save'));

  // 4) 指定记录（受控数据范围集合，本机中间件应答；避免真实业务行进入截图/证据）
  await clickTestId('context-tab-record');
  await sleep(700);
  await setTestIdValue('context-record-collection', 'aiContextDatasources');
  await sleep(300);
  const beforeRecord = await selectedCount();
  await clickTestId('context-record-preview');
  await waitFor(() => countTestId('context-record-pick'), { timeoutMs: 20000, label: '记录行' }).catch(() => {});
  await ensureGrew('record-pick', beforeRecord, () => clickTestId('context-record-pick'));

  await clickTestId('context-tab-selection');
  await sleep(500);
  const count = await countTestId('context-selection-item');
  const kinds = await page.evaluate(`(() => {
    const list = document.querySelector('[data-testid="context-selection-list"]');
    if (!list) return [];
    try {
      return (JSON.parse(list.getAttribute('data-payload') || '[]') || []).map((item) => item.type || item.kind || '?');
    } catch {
      return ['unparsable'];
    }
  })()`);
  return { count, steps, kinds };
}

/** 附件：真实 file input + CDP DOM.setFileInputFiles。 */
async function setFileInput(path) {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await cdp.send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: `${FRAME} input[type="file"]`,
  });
  if (!nodeId) return false;
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [path] });
  return true;
}

async function main() {
  try {
    const afterLogin = await login();
    record('login', afterLogin !== '/login', `afterLoginUrl=${afterLogin}`);
    const baselineLog = await controlledLog();
    evidenceBaseline = typeof baselineLog.nextSeq === 'number' ? baselineLog.nextSeq : baselineLog.entries.length;

    if (process.env.CREWLOOM_VERIFY_ONLY === 'contexts') {
      const prepared = await prepareContexts();
      record('ai04-prepare-four-contexts', prepared.count === 4, JSON.stringify(prepared));
      await page.shot('00-context-workspaces.png');
      return;
    }

    // 前置：准备四类上下文（会话宿主接管时会把它们交给输入区）。
    let selectionCount = 0;
    if (!SKIP.has('contexts')) {
      const prepared = await prepareContexts();
      selectionCount = prepared.count;
      record('ai04-prepare-four-contexts', selectionCount === 4, JSON.stringify(prepared.kinds));
      await page.shot('00-context-workspaces.png');
    }

    await spaGoto('/ai/conversations');
    const native = await waitForNativeChat();
    record('native-chatbox-mounted', native.hasFrame && native.hasInput, JSON.stringify(native));

    // ---------- 桌面布局：控件可见、可点 ----------
    desktopProbe = await probeControls();
    const desktop = controlsOk(desktopProbe);
    record('layout-desktop-controls', desktop.ok, desktop.ok ? 'all-in-viewport' : desktop.failures.join(' | '));
    await page.shot('01-desktop-chat.png');

    // 员工选择弹层（真实员工）
    const employeeTriggerIndex = await page.evaluate(`(() => {
      const list = [...document.querySelectorAll(${JSON.stringify(SELECTORS.employee)})];
      return list.findIndex((el) => (el.innerText || '').trim().length > 0);
    })()`);
    await page.clickSelector(SELECTORS.employee, { index: Math.max(0, employeeTriggerIndex) });
    await sleep(600);
    const employeeDropdown = await page.evaluate(`(() => {
      const dropdowns = [...document.querySelectorAll('.ant-dropdown:not(.ant-dropdown-hidden), .ant-select-dropdown')];
      return dropdowns.map((d) => ({ text: (d.innerText || '').slice(0, 60), visible: d.getBoundingClientRect().height > 0 }));
    })()`);
    record(
      'employee-dropdown-open',
      Array.isArray(employeeDropdown) && employeeDropdown.some((item) => item.visible && item.text.length > 0),
      JSON.stringify(employeeDropdown).slice(0, 160),
    );
    // 关掉下拉层，避免遮住输入区影响后续真实点击。
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
    await page.evaluate(`document.body.click()`);
    await sleep(400);

    // ---------- 首条消息：四类上下文 + 附件 ----------
    const handoffState = await page.evaluate(
      `(() => { const api = window.__CREWLOOM_NATIVE_AI__; return api ? api.describe() : null; })()`,
    );
    const chipsBefore = await page.evaluate(
      `document.querySelectorAll('${FRAME} .ant-tag, ${FRAME} [class*="ant-sender"] .ant-tag').length`,
    );
    if (!SKIP.has('contexts')) {
      record(
        'handoff-context-items-visible',
        chipsBefore >= 4,
        `chips=${chipsBefore} handoff=${JSON.stringify(handoffState?.handoff ?? null)} store=${handoffState?.contextItemCount ?? 'n/a'}`,
      );
    }

    if (!SKIP.has('attachments')) {
      const uploadPath = resolve(OUT_DIR, 'controlled-upload.txt');
      writeFileSync(uploadPath, 'crewloom controlled upload\n');
      const fileSet = await setFileInput(uploadPath);
      const uploadEntry = await waitFor(
        async () => (await newEntries('upload'))[0] ?? null,
        { timeoutMs: 20000, label: '受控上传请求' },
      ).catch(() => null);
      record(
        'aifiles-upload-multipart',
        Boolean(fileSet && uploadEntry && uploadEntry.fileFieldIsFile && uploadEntry.filename),
        JSON.stringify(uploadEntry ?? { fileSet }).slice(0, 260),
      );
      // 卡片里的文件名会被 CSS 省略号截断，因此断言"卡片存在 + 文本以文件名开头"。
      const chipProbe = await waitFor(
        async () => {
          const probe = await page.evaluate(`(() => {
            const frame = document.querySelector(${JSON.stringify(FRAME)});
            if (!frame) return null;
            const cards = [...frame.querySelectorAll('.ant-attachment-list-card')];
            return { cards: cards.length, text: (frame.textContent || '').includes('controlled-upl') };
          })()`);
          return probe && probe.cards >= 1 ? probe : null;
        },
        { timeoutMs: 15000, label: '附件卡片' },
      ).catch(() => null);
      record('aifiles-chip-visible', Boolean(chipProbe), JSON.stringify(chipProbe));
      await page.shot('02-attachment-uploaded.png');
    }

    // 首条消息：带上下文 + 附件 + 触发多工具
    if (!SKIP.has('contexts') && !SKIP.has('tools')) {
      await sendNative('[[tools]]');
      const sendEntry = await waitFor(
        async () => (await newEntries('send'))[0] ?? null,
        { timeoutMs: 20000, label: '首条消息' },
      ).catch(() => null);
      const types = (sendEntry?.workContext ?? []).map((item) => item.type).sort();
      const toolsOk = (sendEntry?.workContext ?? []).every(
        (item) =>
          Array.isArray(item.frontendToolIds) &&
          item.frontendToolIds.length > 0 &&
          item.frontendToolIds.every((id) => id.startsWith(`${item.uid}:`)),
      );
      record(
        'first-message-four-contexts',
        JSON.stringify(types) === JSON.stringify(['chart-config', 'code-editor', 'datasource', 'datasource']) && toolsOk,
        `types=${JSON.stringify(types)} toolsOk=${toolsOk}`,
      );
      record(
        'first-message-attachment-payload',
        Array.isArray(sendEntry?.attachmentIds) && sendEntry.attachmentIds.length === 1,
        `attachmentIds=${JSON.stringify(sendEntry?.attachmentIds ?? [])}`,
      );

      // ---------- 工具两阶段确认 ----------
      await sleep(3000);
      const toolDiag = await page.evaluate(`(() => {
        const frame = document.querySelector(${JSON.stringify(FRAME)});
        const text = frame ? frame.innerText : '';
        return {
          text: text.slice(-400),
          decisionCards: document.querySelectorAll('[data-testid="native-tool-decision-card"]').length,
          buttons: [...(frame ? frame.querySelectorAll('button') : [])].map((b) => (b.textContent || '').trim()).filter(Boolean),
          aiTools: (window.__CREWLOOM_NATIVE_AI__ && window.__CREWLOOM_NATIVE_AI__.describe && window.__CREWLOOM_NATIVE_AI__.describe().handoff) || null,
        };
      })()`);
      console.log('TOOLDIAG', JSON.stringify(toolDiag));
      await waitFor(() => countTestId('native-tool-decision-card'), { timeoutMs: 30000, label: '工具确认卡片' });
      await sleep(500);
      const cards = await countTestId('native-tool-decision-card');
      record('tool-decision-cards', cards === 3, `cards=${cards}`);

      // 逐条决定：按**卡片序号**定位，而不是按按钮序号（每张卡片各有一组允许/拒绝）。
      const clickCardDecision = async (cardIndex, kind) => {
        const box = await page.evaluate(`(() => {
          const card = document.querySelectorAll('[data-testid="native-tool-decision-card"]')[${cardIndex}];
          if (!card) return null;
          const button = card.querySelector('[data-testid="native-tool-${kind}"]');
          if (!button) return null;
          button.scrollIntoView({ block: 'center' });
          const rect = button.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        })()`);
        if (box) {
          await sleep(200);
          await page.clickAt(box.x, box.y);
          return { ok: true, via: 'mouse' };
        }
        const fallback = await page.evaluate(`(() => {
          const card = document.querySelectorAll('[data-testid="native-tool-decision-card"]')[${cardIndex}];
          const button = card && card.querySelector('[data-testid="native-tool-${kind}"]');
          if (!button) return false;
          button.click();
          return true;
        })()`);
        return { ok: Boolean(fallback), via: 'element' };
      };
      const clicks = [];
      clicks.push(await clickCardDecision(0, 'approve')); // tc1 允许
      await sleep(1000);
      clicks.push(await clickCardDecision(1, 'reject')); // tc2 拒绝
      await sleep(1000);
      clicks.push(await clickCardDecision(2, 'approve')); // tc3 允许（参数非法 → 失败）
      console.log('TOOLCLICKS', JSON.stringify(clicks));
      const toolState = await page.evaluate(
        `(() => {
          const api = window.__CREWLOOM_NATIVE_AI__;
          const card = document.querySelector('[data-testid="native-tool-decision-card"]');
          return {
            card: card ? { messageId: card.getAttribute('data-message-id'), invokeStatus: card.getAttribute('data-invoke-status'), toolId: card.getAttribute('data-tool-id') } : null,
            state: api ? api.describe().toolCallState : null,
          };
        })()`,
      );
      console.log('TOOLSTATE', JSON.stringify(toolState));

      const decisionLog = await waitFor(
        async () => {
          const decisions = await newEntries('updateUserDecision');
          return decisions.length >= 3 ? decisions : null;
        },
        { timeoutMs: 25000, label: '三条工具决定' },
      ).catch(() => []);
      const decisionTypes = decisionLog.map((entry) => entry.userDecision?.type);
      record(
        'tool-updateUserDecision-per-tool',
        decisionLog.length === 3 && JSON.stringify(decisionTypes) === JSON.stringify(['approve', 'reject', 'approve']),
        `decisions=${JSON.stringify(decisionTypes)}`,
      );

      const resumeEntry = await waitFor(
        async () => (await newEntries('resumeToolCall'))[0] ?? null,
        { timeoutMs: 25000, label: 'resumeToolCall' },
      ).catch(() => null);
      const resultIds = (resumeEntry?.toolCallResults ?? []).map((item) => item.id);
      const accepted = (resumeEntry?.toolCallResults ?? []).find((item) => item.id === 'controlled-tool-1');
      const failed = (resumeEntry?.toolCallResults ?? []).find((item) => item.id === 'controlled-tool-3');
      record(
        'tool-resumeToolCall-results',
        Boolean(
          resumeEntry &&
            (resumeEntry.toolCallIds ?? []).length === 3 &&
            resultIds.includes('controlled-tool-1') &&
            // 拒绝的工具只出现在 toolCallIds，不回传结果
            !resultIds.includes('controlled-tool-2') &&
            accepted?.result?.status === 'success' &&
            accepted?.result?.content?.applied === true &&
            failed?.result?.status === 'error',
        ),
        JSON.stringify({ ids: resumeEntry?.toolCallIds ?? [], resultIds, accepted: accepted?.result ?? null }).slice(0, 320),
      );

      const resumeText = await waitFor(
        async () => (await frameText()).includes('工具已按你的决定继续执行'),
        { timeoutMs: 20000, label: '工具续流回复' },
      ).then(() => true).catch(() => false);
      record('tool-resume-stream-rendered', resumeText, '');
      await page.shot('03-tool-resume.png');

      // 消费者效果：产品工作区里的代码真的被改写（SPA 跳转，保留内存里的工作区状态）
      await spaGoto('/ai/context');
      await sleep(1200);
      const codeTabClick = await clickTestId('context-tab-code');
      // 代码区先渲染默认文本、再由 store 同步 effect 覆盖成工作区内容，因此要等**已应用**的内容出现，
      // 不能把"第一次读到的任意字符串"当成结果（否则会把默认占位文本误判为已应用）。
      let lastCodeValue = null;
      const appliedCode = await waitFor(
        async () => {
          lastCodeValue = await page.evaluate(
            `(() => { const el = document.querySelector('[data-testid="context-code-input"]'); return el ? el.value : null; })()`,
          );
          return typeof lastCodeValue === 'string' && lastCodeValue.includes('const answer = 42;') ? lastCodeValue : null;
        },
        { timeoutMs: 15000, label: '代码工作区已应用工具结果' },
      ).catch(() => null);
      record(
        'tool-apply-consumer-effect',
        typeof appliedCode === 'string' && appliedCode.includes('const answer = 42;'),
        `tabClick=${JSON.stringify(codeTabClick)} value=${JSON.stringify(String(appliedCode ?? lastCodeValue).slice(0, 80))}`,
      );
      await spaGoto('/ai/conversations');
    }

    // ---------- 移除附件后不再随消息发送 ----------
    if (!SKIP.has('attachments')) {
      await page.evaluate(`(() => {
        const box = document.querySelector(${JSON.stringify(SELECTORS.input)});
        if (box) box.focus();
      })()`);
      await sendNative('移除附件后发送');
      await waitFor(async () => (await frameText()).includes('这是本机受控流式内容'), {
        timeoutMs: 25000,
        label: '第二次受控回复',
      }).catch(() => {});
      const uploadPath2 = resolve(OUT_DIR, 'controlled-removed.txt');
      writeFileSync(uploadPath2, 'crewloom removed upload\n');
      await setFileInput(uploadPath2);
      await waitFor(
        async () => (await frameText()).includes('controlled-removed.txt'),
        { timeoutMs: 15000, label: '第二个附件卡片' },
      ).catch(() => {});
      const removed = await page.evaluate(`(() => {
        const btn = document.querySelector(${JSON.stringify(FRAME)} + ' .ant-attachment-list-card-remove');
        if (!btn) return false;
        btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        btn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        btn.click();
        return true;
      })()`);
      await sleep(600);
      await sendNative('移除后不带附件');
      await waitFor(
        async () => ((await newEntries('send')).length >= 3 ? true : null),
        { timeoutMs: 25000, label: '第三次发送' },
      ).catch(() => {});
      const sends = await newEntries('send');
      const lastSend = sends[sends.length - 1];
      record(
        'attachment-removed-not-sent',
        Boolean(removed && lastSend && (lastSend.attachmentIds ?? []).length === 0),
        `removed=${removed} attachmentIds=${JSON.stringify(lastSend?.attachmentIds ?? [])}`,
      );

      // 上下文与附件一样只随首条消息发送：后续消息必须在 payload 里**不再重复** workContext。
      if (!SKIP.has('contexts')) {
        const withContext = sends.filter((entry) => (entry.workContext ?? []).length > 0);
        const later = sends.filter((entry) => entry !== sends[0]);
        const laterWithoutContext = later.every((entry) => (entry.workContext ?? []).length === 0);
        record(
          'work-context-first-message-only',
          sends.length >= 2 && withContext.length === 1 && sends[0] === withContext[0] && laterWithoutContext,
          `sends=${sends.length} withContext=${withContext.length} laterWithoutContext=${laterWithoutContext}`,
        );
      }
    }

    // ---------- 流式结束后 composer 可再发 ----------
    // 上一条流必须先真的结算（发送按钮从"停止"恢复为"发送"），否则读到的 loading 态会被误判为不可用。
    await waitFor(
      async () => ((await frameText()).includes('收到「移除后不带附件」') ? true : null),
      { timeoutMs: 25000, label: '第三条回复结束' },
    ).catch(() => {});
    await waitFor(
      async () =>
        page.evaluate(
          `Boolean(document.querySelector(${JSON.stringify(FRAME)} + ' button.ant-btn-circle.ant-btn-primary'))`,
        ),
      { timeoutMs: 15000, label: '发送按钮恢复' },
    ).catch(() => {});
    const composerState = await page.evaluate(`(() => {
      const frame = document.querySelector(${JSON.stringify(FRAME)});
      if (!frame) return null;
      const box = frame.querySelector('textarea');
      const send = frame.querySelector('button.ant-btn-circle.ant-btn-primary');
      return {
        hasBox: Boolean(box),
        boxDisabled: box ? box.disabled : null,
        hasSend: Boolean(send),
        sendDisabled: send ? send.disabled : null,
        sendVisible: send ? send.getBoundingClientRect().width > 0 : false,
      };
    })()`);
    await sendNative('结束后再发');
    const resendRendered = await waitFor(
      async () => ((await frameText()).includes('收到「结束后再发」') ? true : null),
      { timeoutMs: 25000, label: '结束后再发回复' },
    )
      .then(() => true)
      .catch(() => false);
    record(
      'stream-composer-resend-after-end',
      Boolean(
        composerState?.hasBox &&
          composerState?.hasSend &&
          composerState.sendVisible &&
          composerState.boxDisabled === false &&
          resendRendered,
      ),
      `composer=${JSON.stringify(composerState)} rendered=${resendRendered}`,
    );

    // ---------- 流式六态 ----------
    await sendNative('受控正常');
    await sleep(1200);
    const normalDiag = await page.evaluate(
      `(() => { const api = window.__CREWLOOM_NATIVE_AI__; return api ? api.describe().messageShape : null; })()`,
    );
    console.log('MSGSHAPE', JSON.stringify(normalDiag));
    const normalText = await waitFor(
      async () => (await frameText()).includes('这是本机受控流式内容'),
      { timeoutMs: 25000, label: '正常流式回复' },
    ).then(() => true).catch(() => false);
    record('stream-normal-end', normalText, '');

    await sendNative('[[error]]');
    const errorText = await waitFor(
      async () => ((await frameText()).includes('这次回复没有生成成功') ? true : false),
      { timeoutMs: 25000, label: '失败态中文文案' },
    ).then(() => true).catch(() => false);
    const errorFrame = await frameText();
    record(
      'stream-error-chinese',
      errorText && !/network error|CONTROLLED_FAILURE|TypeError/i.test(errorFrame),
      JSON.stringify(errorFrame.slice(-120)),
    );

    await sendNative('[[slow]]');
    await sleep(3000);
    const beforeSegments = ((await frameText()).match(/段受控增量/g) || []).length;
    const stopped = await page.evaluate(`(() => {
      const frame = document.querySelector(${JSON.stringify(FRAME)});
      if (!frame) return false;
      const button = [...frame.querySelectorAll('button')].find((b) => /sender-actions-btn/.test(String(b.className)));
      if (button) { button.click(); return true; }
      const stop = [...frame.querySelectorAll('button')].find((b) => /anticon-stop|anticon-pause/.test(String(b.innerHTML)));
      if (stop) { stop.click(); return true; }
      return false;
    })()`);
    await sleep(2500);
    const afterSegments = ((await frameText()).match(/段受控增量/g) || []).length;
    record(
      'stream-explicit-stop',
      Boolean(stopped && beforeSegments > 0 && afterSegments < 40),
      `stopped=${stopped} before=${beforeSegments} after=${afterSegments}/40`,
    );

    await sendNative('[[drop]]');
    await sleep(3000);
    const dropFrame = await frameText();
    const dropInput = await page.evaluate(`Boolean(document.querySelector(${JSON.stringify(FRAME)} + ' textarea'))`);
    record(
      'stream-disconnect-chinese',
      /网络连接中断|没有完成|请检查网络/.test(dropFrame) && dropInput === true,
      JSON.stringify(dropFrame.slice(-120)),
    );

    await sendNative('[[stale]]');
    await sleep(2500);
    const staleFrame = await frameText();
    record('stream-stale-frame-isolated', !staleFrame.includes('旧会话的迟到内容'), '');

    // ---------- 历史（非空、消息数组形态）与续流（缓存缺失 / 缓存可回放） ----------
    if (!SKIP.has('resume')) {
      await sendNative('[[nocache]]');
      await sleep(2500);
      // 原生 `openConversation` 对"已经是当前会话"的条目直接返回（`Conversations.tsx:193-197`），
      // 根本不会走 resumeAfterLoad。受控会话此刻正是 currentConversation，必须先真实点「新会话」离开它。
      const leftBeforeResume = await startNewConversation();
      await sleep(800);
      // 打开会话列表并点回受控会话 → resumeAfterLoad → resumeStream
      await clickFrameAria('Conversation list|会话列表');
      await sleep(1200);
      const listDiag = await page.evaluate(`(() => {
        const frame = document.querySelector(${JSON.stringify(FRAME)});
        if (!frame) return null;
        const text = frame.innerText || '';
        const candidates = [...frame.querySelectorAll('*')].filter((el) => (el.textContent || '').trim().startsWith('受控会话'));
        return {
          text: text.slice(0, 300),
          candidates: candidates.length,
          tags: candidates.slice(0, 4).map((el) => el.tagName + '.' + String(el.className).slice(0, 40)),
        };
      })()`);
      console.log('LISTDIAG', JSON.stringify(listDiag));
      const controlledSessions = await (await fetch(`${BASE_URL}/__crewloom/controlled-sessions`)).json();
      const streamingSession = [...(controlledSessions.sessions ?? [])]
        .reverse()
        .find((item) => item.llmActiveState === 'streaming');
      const clicked = await clickConversationByTitle(streamingSession?.title ?? '受控会话 1');
      const clickedConversation = Boolean(clicked?.ok) && clicked?.currentSession === streamingSession?.sessionId;
      const resumeEntry = await waitFor(
        async () => (await newEntries('resumeStream'))[0] ?? null,
        { timeoutMs: 30000, label: 'resumeStream 请求' },
      ).catch(() => null);
      record(
        'resume-chunks-cache-missing',
        Boolean(leftBeforeResume.ok && clickedConversation && resumeEntry && resumeEntry.cacheMissing === true),
        `left=${JSON.stringify(leftBeforeResume)} clicked=${JSON.stringify(clicked)} entry=${JSON.stringify(resumeEntry ?? null)}`,
      );
      await page.shot('04-resume-cache-missing.png');

      // 缓存缺失后：历史仍能加载（服务端消息数组非空，且界面真的把历史内容渲染出来）
      const getMessages = await newEntries('getMessages');
      const shapeAfterResume = await messageShape();
      const historyMessages = Array.isArray(shapeAfterResume?.messages) ? shapeAfterResume.messages : [];
      const historyTextVisible = (await frameText()).includes('受控中断前的第一段');
      record(
        'history-loaded-non-empty',
        getMessages.length > 0 && historyMessages.length > 0 && historyTextVisible,
        `getMessages=${getMessages.length} messageShape=${historyMessages.length} historyVisible=${historyTextVisible}`,
      );
      record(
        'getMessages-updateRead-false',
        getMessages.length > 0 && getMessages.every((entry) => entry.updateRead === 'false'),
        JSON.stringify(getMessages.map((entry) => entry.updateRead)),
      );

      // 让服务端状态回到 idle 并刷新 → 后台工作中提示消失
      const sessionId = resumeEntry?.sessionId ?? '';
      if (sessionId) {
        await fetch(`${BASE_URL}/__crewloom/controlled-state?sessionId=${encodeURIComponent(sessionId)}&llmActiveState=idle`);
      }
      await page.evaluate(`(() => {
        const link = [...document.querySelectorAll('a,span')].find((el) => (el.textContent || '').trim() === '点击');
        if (link) link.click();
      })()`);
      await sleep(2500);
      const finalFrame = await frameText();
      record('resume-recovered-after-idle', !finalFrame.includes('正在后台工作'), JSON.stringify(finalFrame.slice(-100)));

      // ---- 缓存可回放：第二个受控会话（不在 chunks_cache_missing 集合里），服务端仍在 streaming ----
      const sessionsBefore = (await (await fetch(`${BASE_URL}/__crewloom/controlled-sessions`)).json()).sessions ?? [];
      await startNewConversation();
      const sendsBefore = (await newEntries('send')).length;
      await sendNative('缓存续流第二会话');
      await waitFor(async () => ((await newEntries('send')).length > sendsBefore ? true : null), {
        timeoutMs: 25000,
        label: '第二会话发送',
      }).catch(() => {});
      await sleep(1500);
      const sessionsAfter = (await (await fetch(`${BASE_URL}/__crewloom/controlled-sessions`)).json()).sessions ?? [];
      const secondSession =
        sessionsAfter.filter((item) => !sessionsBefore.some((prev) => prev.sessionId === item.sessionId)).pop() ?? null;
      if (secondSession) {
        // 服务端"仍在生成"：这条会话的增量缓存是可回放的（没有走过 nocache）。
        await fetch(
          `${BASE_URL}/__crewloom/controlled-state?sessionId=${encodeURIComponent(secondSession.sessionId)}&llmActiveState=streaming`,
        );
      }
      await startNewConversation();
      await clickFrameAria('Conversation list|会话列表');
      await sleep(1200);
      const replayClicked = secondSession
        ? await clickConversationByTitle(secondSession.title)
        : { ok: false, reason: 'no-second-session' };
      const replayEntry = await waitFor(
        async () => (await newEntries('resumeStream')).find((entry) => entry.cacheMissing === false) ?? null,
        { timeoutMs: 30000, label: '可回放 resumeStream' },
      ).catch(() => null);
      const replayRendered = await waitFor(async () => ((await frameText()).includes('收到「续流」') ? true : null), {
        timeoutMs: 20000,
        label: '续流内容',
      })
        .then(() => true)
        .catch(() => false);
      record(
        'resume-cache-replay',
        Boolean(replayClicked?.ok && replayEntry && replayRendered),
        `clicked=${JSON.stringify(replayClicked)} entry=${JSON.stringify(replayEntry ?? null)} rendered=${replayRendered}`,
      );
    }

    // ---------- 390px 布局 ----------
    // 会话列表在非展开态是铺满宿主的浮层：先真实关掉它，否则几何/命中测试会把
    // "列表浮层挡住输入区"当成控件本身不可用（假失败）。
    const listClosedForNarrow = await closeConversationList();
    console.log('NARROW-LIST', JSON.stringify(listClosedForNarrow));
    await page.setViewport(390, 844);
    await page.evaluate('window.scrollTo(0, 0)');
    await sleep(600);
    narrowProbe = await probeControls();
    const narrow = controlsOk(narrowProbe);
    record('layout-narrow-controls', narrow.ok, narrow.ok ? 'all-in-viewport' : narrow.failures.join(' | '));
    await page.shot('05-narrow-chat.png');

    // 窄屏真实点击：输入 + 发送
    await setViewportClickNarrow();
    const narrowSend = await (async () => {
      const ok = await typeIntoNative('窄屏受控');
      await page.pressEnter();
      return ok;
    })();
    const narrowReply = await waitFor(
      async () => (await frameText()).includes('窄屏受控'),
      { timeoutMs: 25000, label: '窄屏发送回复' },
    ).then(() => true).catch(() => false);
    record('layout-narrow-send-clickable', narrowSend && narrowReply, `typed=${narrowSend} replied=${narrowReply}`);
    await page.shot('06-narrow-after-send.png');
    await page.clearViewport();

    // ---------- TD-03 冷启动：fresh page（未先打开会话界面）也能装配共享原生运行上下文 ----------
    // `page.goto` 是整页重载：不经过会话界面，直接进 AI 任务页，验证同一份真实运行上下文能被按需装配。
    await page.goto('/tasks/ai');
    await sleep(2500);
    const runtimeProbe = await waitFor(
      async () => {
        const info = await page.evaluate(`(() => {
          try {
            const api = window.__CREWLOOM_NATIVE_RUNTIME__;
            if (!api) return null;
            return api.describe();
          } catch (error) {
            return { __error: String((error && error.message) || error).slice(0, 300) };
          }
        })()`);
        return info && info.mounted ? info : null;
      },
      { timeoutMs: 90000, intervalMs: 1500, label: 'TD03 冷启动共享运行上下文' },
    ).catch(() => null);
    const productState = await page.evaluate(`(() => {
      try {
        const root = document.querySelector('[data-testid="ai-task-page"]');
        const api = window.__CREWLOOM_NATIVE_RUNTIME__;
        return {
          bridgeState: root ? root.getAttribute('data-bridge-state') : 'no-page',
          runtime: api ? api.describe() : null,
        };
      } catch (error) {
        return { __error: String((error && error.message) || error).slice(0, 200) };
      }
    })()`);
    if (!runtimeProbe) console.log('TDFALLBACK', JSON.stringify(productState).slice(0, 500));
    record(
      'td03-cold-start-shared-runtime',
      Boolean(runtimeProbe?.mounted && runtimeProbe?.hasExecutor && runtimeProbe?.registryList),
      `probe=${JSON.stringify(runtimeProbe ?? null).slice(0, 200)} product=${JSON.stringify(productState).slice(0, 260)}`,
    );
    await page.shot('07-td03-cold-start.png');

    record('no-page-errors', cdp.errors.length === 0, cdp.errors.slice(0, 2).join(' | '));

    const failed = results.filter((item) => !item.ok).length;
    console.log(JSON.stringify({ baseUrl: BASE_URL, failed, total: results.length }, null, 2));
    process.exitCode = failed === 0 ? 0 : 1;
  } catch (error) {
    record('script-error', false, String(error?.message ?? error).slice(0, 200));
    process.exitCode = 1;
  } finally {
    try {
      writeFileSync(
        REPORT_PATH,
        JSON.stringify(
          {
            baseUrl: BASE_URL,
            generatedAt: new Date().toISOString(),
            results,
            desktopProbe,
            narrowProbe,
            pageErrors: cdp.errors.slice(0, 5),
            controlledLog: await controlledLog(),
          },
          null,
          2,
        ),
      );
    } catch (error) {
      console.log('报告写入失败', String(error?.message ?? error));
    }
    cleanup();
  }
}

async function setViewportClickNarrow() {
  // 真实点击输入框（窄屏命中测试已经证明可点；这里再点一次确保焦点在输入框上）
  await page.clickSelector(SELECTORS.input).catch(() => {});
  await sleep(200);
}

await main();
