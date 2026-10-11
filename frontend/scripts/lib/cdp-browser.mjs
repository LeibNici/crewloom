/**
 * CDP 浏览器助手（Node 侧，只依赖 node 内置 WebSocket/fetch）。
 *
 * 用途：本组所有"真实浏览器交互"核对脚本共用同一份启动/连接/输入/截图实现，
 * 避免每个脚本各写一份 CDP 样板而失配。它只做**驱动与采集**，不含任何业务断言。
 *
 * 关键点（实测）：
 *  - `Input.dispatchMouseEvent` 才是"真实鼠标"；`element.click()` 只是 DOM 事件。
 *    需要证明"用户点击真的触发了请求"的地方一律用 `mouseClickSelector`；
 *  - `Runtime.evaluate` 只用于读取 DOM 状态与做几何测量，不代替点击；
 *  - 凭据由调用方从 `.secrets` 读入内存后传入，本模块不读任何凭据文件、不打印明文。
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.sessionId = null;
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}, sessionId = this.sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
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
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Chrome 调试端口未就绪');
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 启动 headless Chrome 并连接。
 *
 * @returns {Promise<{ cdp: Cdp, chrome: import('node:child_process').ChildProcess, close: () => void, events: {...} }>}
 */
export async function launchBrowser({
  debugPort = 9391,
  width = 1600,
  height = 1000,
  chromePath = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
} = {}) {
  const profileDir = mkdtempSync(join(tmpdir(), 'crewloom-cdp-'));
  const chrome = spawn(
    chromePath,
    [
      '--headless=new',
      `--remote-debugging-port=${debugPort}`,
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
      `--window-size=${width},${height}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  chrome.stderr.on('data', () => {});

  const versionInfo = await waitForDevtools(debugPort);
  const ws = new WebSocket(versionInfo.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const cdp = new Cdp(ws);
  const { targetInfos } = await cdp.send('Target.getTargets');
  const page = targetInfos.find((t) => t.type === 'page');
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  cdp.sessionId = sessionId;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Network.enable');

  const consoleErrors = [];
  const pageErrors = [];
  /** 所有 /api 请求（含 POST body）与响应状态，用于"UI 真的发了请求"证据。 */
  const apiRequests = [];
  const byRequestId = new Map();

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    const params = msg.params ?? {};
    if (msg.method === 'Network.requestWillBeSent') {
      const url = String(params.request?.url ?? '');
      if (url.includes('/api/')) {
        const entry = {
          requestId: params.requestId,
          method: params.request?.method ?? 'GET',
          url: url.replace(/^https?:\/\/[^/]+/, ''),
          postData: typeof params.request?.postData === 'string' ? params.request.postData.slice(0, 4000) : null,
          status: null,
          at: new Date().toISOString(),
        };
        byRequestId.set(params.requestId, entry);
        apiRequests.push(entry);
      }
    }
    if (msg.method === 'Network.responseReceived') {
      const entry = byRequestId.get(params.requestId);
      if (entry) entry.status = params.response?.status ?? null;
      const { response } = params;
      if (response && response.status >= 400 && /\/(src|vendor|node_modules|assets)\//.test(response.url ?? '')) {
        consoleErrors.push(`asset ${response.status} ${response.url}`);
      }
    }
    if (msg.method === 'Runtime.consoleAPICalled' && params.type === 'error') {
      consoleErrors.push((params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 400));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(String(params?.exceptionDetails?.exception?.description ?? '').slice(0, 600));
    }
  });

  const close = () => {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    chrome.kill('SIGKILL');
    try {
      rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* 临时目录清理失败不影响结论 */
    }
  };

  return { cdp, chrome, close, events: { consoleErrors, pageErrors, apiRequests } };
}

/** 页面内求值（只读用途；点击一律走真实鼠标）。 */
export async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(`页面脚本异常：${result.exceptionDetails.text}`);
  return result.result.value;
}

export async function goto(cdp, url, settleMs = 1500) {
  await cdp.send('Page.navigate', { url });
  await sleep(settleMs);
}

export async function screenshot(cdp, filePath) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, Buffer.from(data, 'base64'));
  return filePath;
}

/** 元素在视口中的几何（含是否在视口内）。 */
export async function boxOf(cdp, selector, index = 0) {
  return evaluate(
    cdp,
    `(() => {
      const list = document.querySelectorAll(${JSON.stringify(selector)});
      const el = list[${index}];
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return {
        x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        cx: rect.x + rect.width / 2, cy: rect.y + rect.height / 2,
        inViewport: rect.top >= 0 && rect.left >= 0 && rect.bottom <= window.innerHeight + 1 && rect.right <= window.innerWidth + 1,
        visible: rect.width > 0 && rect.height > 0,
        count: list.length,
      };
    })()`,
  );
}

/** 把元素滚动到视口内（真实鼠标点击前的前置步骤，不是点击本身）。 */
export async function scrollIntoView(cdp, selector, index = 0) {
  const done = await evaluate(
    cdp,
    `(() => {
      const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
      if (!el) return false;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      return true;
    })()`,
  );
  if (done) await sleep(250);
  return done;
}

/**
 * 真实鼠标点击（mousedown+mouseup），坐标来自元素几何中心。
 *
 * `autoScroll` 缺省 true：元素不在视口内时先滚动到视口中心再点。**浮层（下拉菜单）必须传
 * false**：滚动会让 antd 的浮层关闭，反而点不到。
 */
export async function mouseClickSelector(cdp, selector, index = 0, { settleMs = 400, autoScroll = true } = {}) {
  let box = await boxOf(cdp, selector, index);
  if (!box || !box.visible) throw new Error(`找不到可点击元素：${selector}[${index}]`);
  if (!box.inViewport && autoScroll) {
    await scrollIntoView(cdp, selector, index);
    box = await boxOf(cdp, selector, index);
    if (!box || !box.visible) throw new Error(`滚动后仍找不到可点击元素：${selector}[${index}]`);
  }
  const viewport = await evaluate(cdp, `({ w: window.innerWidth, h: window.innerHeight })`);
  const x = Math.round(Math.min(Math.max(box.cx, 2), viewport.w - 2));
  const y = Math.round(Math.min(Math.max(box.cy, 2), viewport.h - 2));
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(settleMs);
  return box;
}

/** 在指定坐标处做真实鼠标拖拽（用于画布拖拽与滑块）。 */
export async function mouseDrag(cdp, from, to, { steps = 12, settleMs = 500 } = {}) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round(from.x),
    y: Math.round(from.y),
    button: 'none',
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: Math.round(from.x),
    y: Math.round(from.y),
    button: 'left',
    clickCount: 1,
  });
  for (let step = 1; step <= steps; step += 1) {
    const x = Math.round(from.x + ((to.x - from.x) * step) / steps);
    const y = Math.round(from.y + ((to.y - from.y) * step) / steps);
    // eslint-disable-next-line no-await-in-loop -- 拖拽必须逐点派发，鼠标轨迹是业务逻辑的一部分
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
    // eslint-disable-next-line no-await-in-loop
    await sleep(16);
  }
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: Math.round(to.x),
    y: Math.round(to.y),
    button: 'left',
    clickCount: 1,
  });
  await sleep(settleMs);
}

/** 按可见文本找元素（返回匹配的下标，供 mouseClickSelector 用）。 */
export async function indexByText(cdp, selector, text) {
  return evaluate(
    cdp,
    `(() => {
      const list = [...document.querySelectorAll(${JSON.stringify(selector)})];
      return list.findIndex((el) => (el.innerText || el.textContent || '').includes(${JSON.stringify(text)}));
    })()`,
  );
}

/** 真实鼠标点击第一个可见文本匹配的元素。浮层用 `autoScroll: false`（滚动会关掉浮层）。 */
export async function mouseClickText(cdp, selector, text, { settleMs = 400, autoScroll = true } = {}) {
  const index = await indexByText(cdp, selector, text);
  if (index < 0) throw new Error(`找不到文本「${text}」的元素：${selector}`);
  return mouseClickSelector(cdp, selector, index, { settleMs, autoScroll });
}

/** 真实键盘输入（先真实点击聚焦）。 */
export async function typeInto(cdp, selector, value, index = 0) {
  await mouseClickSelector(cdp, selector, index, { settleMs: 120 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 });
  for (const char of value) {
    // eslint-disable-next-line no-await-in-loop -- 逐字符输入才等价真实键盘
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: char });
    // eslint-disable-next-line no-await-in-loop
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp' });
    // eslint-disable-next-line no-await-in-loop
    await sleep(12);
  }
  return true;
}

/** 轮询直到条件表达式为真（返回最终值）。 */
export async function waitFor(cdp, expression, { timeoutMs = 20000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- 轮询等待 UI 状态是必要的
    last = await evaluate(cdp, expression);
    if (last) return last;
    // eslint-disable-next-line no-await-in-loop
    await sleep(intervalMs);
  }
  return last;
}

/** 读回某个请求的响应体（用于"UI 真的收到受控应答"的证据）。失败返回 null。 */
export async function getResponseBody(cdp, requestId) {
  if (!requestId) return null;
  try {
    const result = await cdp.send('Network.getResponseBody', { requestId });
    return typeof result?.body === 'string' ? result.body.slice(0, 2000) : null;
  } catch {
    return null;
  }
}

/** 在指定坐标做真实鼠标点击（用于"按标签定位控件"等需要先自行测量的场景）。 */
export async function mouseClickAt(cdp, x, y, { settleMs = 400, clickCount = 1 } = {}) {
  const viewport = await evaluate(cdp, `({ w: window.innerWidth, h: window.innerHeight })`);
  const px = Math.round(Math.min(Math.max(x, 2), viewport.w - 2));
  const py = Math.round(Math.min(Math.max(y, 2), viewport.h - 2));
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, button: 'none', clickCount: 0 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', clickCount });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', clickCount });
  await sleep(settleMs);
  return { x: px, y: py };
}

/** 真实鼠标滚轮（可指定横/纵向增量，用于验证"宿主/原生标准滚动"是否真的能滚）。 */
export async function mouseWheel(cdp, x, y, { deltaX = 0, deltaY = 0, settleMs = 400 } = {}) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: Math.round(x),
    y: Math.round(y),
    deltaX,
    deltaY,
    button: 'none',
  });
  await sleep(settleMs);
}
