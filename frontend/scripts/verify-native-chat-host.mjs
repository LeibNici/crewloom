#!/usr/bin/env node
/**
 * AI-03「原生 ChatBox」宿主装载核对（真实浏览器，受控只读登录）。
 *
 * 目的：确认固定 2.2.22 上游 ChatBox（`@nocobase/plugin-ai/client-v2` → 产品 `vendor/nocobase-2.2.22`）
 * 在**产品页面内**能被宿主真正装载：切到「原生 ChatBox」页签后，上游运行时被加载并渲染，
 * 而不是只把异常吞掉显示占位。
 *
 * 边界：只登录 + 只读导航；不发送消息、不调用模型、不上传文件。凭据只在进程内存读取。
 * 截图输出到 `frontend/.shots/ai-native/`（含真实会话列表，**gitignore，不入库**）。
 *
 * 用法：
 *   CREWLOOM_PREVIEW_URL=http://127.0.0.1:5277 node scripts/verify-native-chat-host.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const SECRET_PATH =
  process.env.CREWLOOM_13000_SECRETS ?? resolve(repoRoot, '.secrets/full-pages-13000-20261011.json');
const OUT_DIR = process.env.CREWLOOM_NATIVE_SHOT_DIR ?? resolve(repoRoot, 'frontend/.shots/ai-native');
const BASE_URL = process.env.CREWLOOM_PREVIEW_URL ?? 'http://127.0.0.1:5277';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT ?? 9351);

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.sessionId = null;
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else res(msg.result);
      }
    });
  }

  send(method, params = {}, sessionId = this.sessionId) {
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

async function main() {
  const secrets = JSON.parse(readFileSync(SECRET_PATH, 'utf8'));
  mkdirSync(OUT_DIR, { recursive: true });
  const profileDir = mkdtempSync(join(tmpdir(), 'crewloom-native-chat-'));
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
      '--window-size=1440,1000',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  chrome.stderr.on('data', () => {});

  const consoleErrors = [];
  const pageErrors = [];
  let cdp;

  try {
    const versionInfo = await waitForDevtools(DEBUG_PORT);
    const ws = new WebSocket(versionInfo.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    cdp = new Cdp(ws);
    const { targetInfos } = await cdp.send('Target.getTargets');
    const page = targetInfos.find((t) => t.type === 'page');
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    cdp.sessionId = sessionId;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Network.enable');
    const failedResponses = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Network.responseReceived') {
        const { response } = msg.params;
        if (response.status >= 400 && /\/(src|vendor|node_modules)\//.test(response.url)) {
          failedResponses.push({ status: response.status, url: response.url });
        }
      }
    });
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        consoleErrors.push((msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 400));
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        pageErrors.push(String(msg.params?.exceptionDetails?.exception?.description ?? '').slice(0, 600));
      }
    });

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const evaluate = async (expression) => {
      const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(`页面脚本异常：${result.exceptionDetails.text}`);
      return result.result.value;
    };
    const goto = async (path) => {
      await cdp.send('Page.navigate', { url: `${BASE_URL}${path}` });
      await sleep(1500);
    };
    const shot = async (name) => {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      writeFileSync(join(OUT_DIR, name), Buffer.from(data, 'base64'));
    };

    // 登录（正常 auth；逐字符输入，不进日志、不进 argv）
    const typeInto = async (selector, value) => {
      const focused = await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.focus();
        return true;
      })()`);
      if (!focused) return false;
      for (const char of value) {
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: char });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp' });
        await sleep(12);
      }
      return true;
    };

    await sleep(8000);
    await goto('/login');
    const emailTyped = await typeInto('input[type="text"], input[type="email"]', String(secrets.email));
    const pwdTyped = await typeInto('input[type="password"]', String(secrets.password));
    await evaluate(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => /登录|登 录/.test(b.textContent || ''));
      if (btn) btn.click();
      return Boolean(btn);
    })()`);
    await sleep(4000);

    const afterLoginUrl = await evaluate('location.pathname');
    await goto('/ai/conversations');
    await sleep(1500);

    // 原生聊天是 AI-03 的默认界面：等待上游组件真正出现（输入框/消息区）
    let probe = null;
    for (let i = 0; i < 45; i += 1) {
      probe = await evaluate(`(() => {
        const frame = document.querySelector('[data-testid="native-chatbox-frame"]');
        // 输入框必须**在原生宿主容器内**：页面别处（含隐藏的旧实现）的元素不算数。
        const textarea = frame
          ? frame.querySelector('textarea, [contenteditable="true"], .ant-input, input[type="text"]')
          : null;
        const text = document.body.innerText || '';
        return {
          hasFrame: Boolean(frame),
          hasInput: Boolean(textarea),
          inputTag: textarea ? textarea.tagName.toLowerCase() : null,
          frameText: frame ? (frame.innerText || '').slice(0, 400) : '',
          unavailableShown: text.includes('会话暂时无法打开'),
          preparingShown: text.includes('正在准备聊天界面'),
          antdChat: Boolean(frame && frame.querySelector('.ant-btn, .ant-avatar, .ant-card, textarea')),
          bodySnippet: text.slice(0, 300),
        };
      })()`);
      if (probe.hasFrame && probe.hasInput && probe.antdChat) break;
      await sleep(2000);
    }
    await sleep(1500);

    await shot('01-native-chat-desktop.png');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await sleep(1200);
    const narrowProbe = await evaluate(`(() => {
      const frame = document.querySelector('[data-testid="native-chatbox-frame"]');
      return {
        hasFrame: Boolean(frame),
        hasInput: Boolean(frame && frame.querySelector('textarea, [contenteditable="true"], .ant-input, input[type="text"]')),
      };
    })()`);
    await shot('02-native-chat-narrow.png');
    await cdp.send('Emulation.clearDeviceMetricsOverride');

    await goto('/login');
    await sleep(600);

    const ok =
      Boolean(probe?.hasFrame && probe?.hasInput && probe?.antdChat && narrowProbe?.hasFrame && narrowProbe?.hasInput) &&
      afterLoginUrl !== '/login' &&
      pageErrors.length === 0;
    if (!ok) process.exitCode = 1;
    console.error(
      `[native-chat] result=${ok ? 'PASS' : 'FAIL'} login=${afterLoginUrl} hasFrame=${probe?.hasFrame} hasInput=${probe?.hasInput} antdChat=${probe?.antdChat} narrowFrame=${narrowProbe?.hasFrame} narrowInput=${narrowProbe?.hasInput} pageErrors=${pageErrors.length} phase=${probe?.unavailableShown ? 'unavailable' : probe?.preparingShown ? 'preparing' : 'other'}`,
    );
    console.log(
      JSON.stringify(
        {
          baseUrl: BASE_URL,
          afterLoginUrl,
          emailTyped,
          pwdTyped,
          probe,
          narrowProbe,
          failedResponses: failedResponses.slice(0, 10),
          consoleErrors: consoleErrors.slice(0, 12),
          pageErrors: pageErrors.slice(0, 6),
          shots: [join(OUT_DIR, '01-native-chat-desktop.png'), join(OUT_DIR, '02-native-chat-narrow.png')],
        },
        null,
        2,
      ),
    );
  } finally {
    try {
      cdp?.ws?.close();
    } catch {
      /* ignore */
    }
    chrome.kill('SIGKILL');
    try {
      rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* 临时目录清理失败不影响核对结论 */
    }
  }
}

await main();
