/**
 * 受控浏览器核对的共用底座（真实 Chrome + CDP）。
 *
 * 只做与产品无关的机械动作：启动/连接 Chrome、`Runtime.evaluate`、截图、真实点击/输入、
 * 视口切换、读取元素几何。避免每个核对脚本各写一份，行为不一致。
 *
 * 凭据只在进程内存里从 0600 的 `.secrets` 文件读取，**不打印、不写盘、不进 argv**。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.sessionId = null;
    this.errors = [];
    /** 页面 console 输出（只用于诊断；不写盘、不含凭据）。 */
    this.console = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Runtime.consoleAPICalled') {
        const args = (msg.params?.args ?? []).map((arg) => String(arg.value ?? arg.description ?? '')).join(' ');
        this.console.push({ type: msg.params?.type, text: args.slice(0, 300) });
        if (this.console.length > 200) this.console.shift();
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.errors.push(String(msg.params?.exceptionDetails?.exception?.description ?? '').slice(0, 400));
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else res(msg.result);
      }
    });
  }

  send(method, params = {}, sessionId = this.sessionId, timeoutMs = 30000) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((res, reject) => {
      this.pending.set(id, { resolve: res, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, timeoutMs);
    });
  }
}

export function readSecrets(secretPath) {
  return JSON.parse(readFileSync(secretPath, 'utf8'));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function launchChrome({ debugPort, windowSize = '1440,1000' }) {
  const chromePath = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const profileDir = mkdtempSync(join(tmpdir(), 'crewloom-chrome-'));
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
      `--window-size=${windowSize}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  chrome.stderr.on('data', () => {});
  const deadline = Date.now() + 30000;
  let versionInfo = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      if (response.ok) {
        versionInfo = await response.json();
        break;
      }
    } catch {
      /* 继续等 */
    }
    await sleep(250);
  }
  if (!versionInfo) throw new Error('Chrome 调试端口未就绪');
  const ws = new WebSocket(versionInfo.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
  const cdp = new Cdp(ws);
  const { targetInfos } = await cdp.send('Target.getTargets');
  const page = targetInfos.find((item) => item.type === 'page');
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  cdp.sessionId = sessionId;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('DOM.enable');
  await cdp.send('Network.enable');
  return {
    cdp,
    cleanup() {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      chrome.kill('SIGKILL');
      try {
        rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* ignore */
      }
    },
  };
}

export function createPage({ cdp, baseUrl, outDir }) {
  mkdirSync(outDir, { recursive: true });

  const evaluateOnce = async (expression) => {
    // 原生闭包很大：首次渲染时主线程可能被同步脚本占住，evaluate 需要等更久。
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, cdp.sessionId, 120000);
    if (result.exceptionDetails) {
      const detail =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.exception?.value ??
        result.exceptionDetails.text;
      throw new Error(`页面脚本异常：${String(detail).slice(0, 300)}`);
    }
    return result.result.value;
  };

  const evaluate = async (expression) => {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await evaluateOnce(expression);
      } catch (error) {
        lastError = error;
        await sleep(1500);
      }
    }
    throw lastError;
  };

  const goto = async (path) => {
    await cdp.send('Page.navigate', { url: `${baseUrl}${path}` });
    await sleep(1500);
  };

  const shot = async (name) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(join(outDir, name), Buffer.from(data, 'base64'));
  };

  /** 真实鼠标点击（不是 ele.click()）：走 Input.dispatchMouseEvent，命中测试与用户一致。 */
  const clickAt = async (x, y) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };

  const clickSelector = async (selector, { index = 0 } = {}) => {
    // 先把元素滚到视口中间：页面上很长的表单/卡片里，按钮可能在首屏之外，
    // 直接按 getBoundingClientRect 的坐标点击会落到视口外（等于没点到）。
    const scrolled = await evaluate(`(() => {
      const list = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const el = list[${index}];
      if (!el) return false;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      return true;
    })()`);
    if (!scrolled) return false;
    await sleep(200);
    const box = await evaluate(`(() => {
      const list = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const el = list[${index}];
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      if (y < 0 || y > window.innerHeight || x < 0 || x > window.innerWidth) return null;
      return { x, y };
    })()`);
    if (!box) return false;
    await clickAt(box.x, box.y);
    return true;
  };

  const typeText = async (text) => {
    await cdp.send('Input.insertText', { text });
  };

  const pressEnter = async () => {
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      key: 'Enter',
      code: 'Enter',
    });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      windowsVirtualKeyCode: 13,
      key: 'Enter',
      code: 'Enter',
    });
  };

  const setViewport = async (width, height) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width <= 500 });
    await sleep(600);
  };

  const clearViewport = async () => {
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await sleep(400);
  };

  return { evaluate, goto, shot, clickAt, clickSelector, typeText, pressEnter, setViewport, clearViewport };
}

/** 元素几何 + 命中测试（中心点命中的元素是否是它自己或后代）。 */
export const RECT_PROBE = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const hit = document.elementFromPoint(cx, cy);
  const style = getComputedStyle(el);
  return {
    selector: ${JSON.stringify(selector)},
    rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
    inViewport:
      rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth + 0.5 && rect.bottom <= window.innerHeight + 0.5,
    hitTest: Boolean(hit && (hit === el || el.contains(hit) || hit.contains(el))),
    visible: style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0,
    viewport: { w: window.innerWidth, h: window.innerHeight },
  };
})()`;
