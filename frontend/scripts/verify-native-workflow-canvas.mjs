#!/usr/bin/env node
/**
 * WF-02「原生工作流画布」宿主核对（真实浏览器，受控只读登录）。
 *
 * 目的：确认 `@nocobase/plugin-workflow/client-v2`（产品 `vendor/nocobase-2.2.22` 固定源码）
 * 的**真实画布**在产品页面里被装载并渲染：原生 `.workflow-canvas`、原生节点卡片、
 * 原生 `add-button` 入口；而不是上一版的"顺序列表 + 注入接口"。
 *
 * 边界：只登录 + 只读导航 + 只读接口（`workflows:list` / `workflows:get` / `flow_nodes:list` 等）；
 * 不点击任何会产生写入的动作（新增节点 / 保存 / 删除 / 自测），不调用模型。
 * 截图输出到 `frontend/.shots/workflow-native/`（gitignore，不入库）。
 *
 * 用法：
 *   CREWLOOM_PREVIEW_URL=http://127.0.0.1:5292 node scripts/verify-native-workflow-canvas.mjs
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const SECRET_PATH =
  process.env.CREWLOOM_13000_SECRETS ?? resolve(repoRoot, '.secrets/full-pages-13000-20261011.json');
const OUT_DIR = process.env.CREWLOOM_CANVAS_SHOT_DIR ?? resolve(repoRoot, 'frontend/.shots/workflow-native');
const BASE_URL = process.env.CREWLOOM_PREVIEW_URL ?? 'http://127.0.0.1:5292';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT ?? 9361);

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
  const profileDir = mkdtempSync(join(tmpdir(), 'crewloom-native-canvas-'));
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
      '--window-size=1600,1000',
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
        if (response.status >= 400 && /\/(src|vendor|node_modules|assets)\//.test(response.url)) {
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
    let emailTyped = false;
    let pwdTyped = false;
    let afterLoginUrl = '/login';
    for (let attempt = 0; attempt < 3 && afterLoginUrl === '/login'; attempt += 1) {
      await goto('/login');
      await sleep(2000);
      emailTyped = await typeInto('input[type="text"], input[type="email"]', String(secrets.email));
      pwdTyped = await typeInto('input[type="password"]', String(secrets.password));
      await evaluate(`(() => {
        const btn = [...document.querySelectorAll('button')].find((b) => /登录|登 录/.test(b.textContent || ''));
        if (btn) btn.click();
        return Boolean(btn);
      })()`);
      await sleep(5000);
      afterLoginUrl = await evaluate('location.pathname');
    }

    // 从流程列表点第一页第一条「编排」，拿到真实 workflowId（只读）。
    await goto('/workflow/list');
    await sleep(2500);
    const canvasHref = await evaluate(`(() => {
      const link = [...document.querySelectorAll('a')].find((a) => (a.getAttribute('href') || '').includes('/workflow/canvas?workflowId='));
      return link ? link.getAttribute('href') : null;
    })()`);

    let probe = null;
    if (canvasHref) {
      await cdp.send('Page.navigate', { url: `${BASE_URL}${canvasHref}` });
      for (let i = 0; i < 60; i += 1) {
        probe = await evaluate(`(() => {
          const host = document.querySelector('[data-testid="native-workflow-canvas"]');
          const canvas = host ? host.querySelector('.workflow-canvas') : null;
          const nodes = host ? host.querySelectorAll('[class*="workflow-node-type-"]') : [];
          const addButtons = host ? host.querySelectorAll('button[aria-label="add-button"]') : [];
          const canvasNode = host ? host.querySelector('.workflow-canvas-node, [class*="workflow-canvas-node"]') : null;
          return {
            hasHost: Boolean(host),
            hasCanvas: Boolean(canvas),
            nodeCount: nodes.length,
            addButtonCount: addButtons.length,
            canvasNodePresent: Boolean(canvasNode),
            hostText: host ? (host.innerText || '').slice(0, 300) : '',
            failedText: host && /无法打开|加载失败/.test(host.innerText || '') ? host.innerText.slice(0, 200) : null,
          };
        })()`);
        if (probe.hasCanvas && probe.nodeCount > 0) break;
        await sleep(2000);
      }
    }

    await shot('01-native-workflow-canvas-desktop.png');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 1, mobile: true });
    await sleep(1500);
    await shot('02-native-workflow-canvas-narrow.png');
    await cdp.send('Emulation.clearDeviceMetricsOverride');

    // 原生 registry 只读自省：产品实际注册了哪些 instruction/trigger（与目标 enabled 矩阵对比）。
    const registry = await evaluate(`(() => {
      if (typeof window.__crewloomWorkflowRegistry !== 'function') return { ready: false, reason: 'no-hook' };
      try { return window.__crewloomWorkflowRegistry(); } catch (error) { return { ready: false, reason: String(error) }; }
    })()`);

    // 画布上"暂不支持的节点"计数：真实数据里未注册的类型会以占位卡片出现。
    const unsupported = await evaluate(`(() => {
      const host = document.querySelector('[data-testid="native-workflow-canvas"]');
      if (!host) return null;
      const text = host.innerText || '';
      return {
        unsupportedMentions: (text.match(/暂不支持/g) || []).length,
        unknownCards: host.querySelectorAll('[class*="workflow-node-unknown"], [class*="unknown-node"]').length,
      };
    })()`);

    const evidenceOut = process.env.CREWLOOM_CANVAS_OUT;
    const ok =
      afterLoginUrl !== '/login' &&
      Boolean(canvasHref) &&
      Boolean(probe?.hasHost && probe?.hasCanvas && probe?.nodeCount > 0 && probe?.addButtonCount > 0) &&
      pageErrors.length === 0;
    if (!ok) process.exitCode = 1;
    const evidence = {
      baseUrl: BASE_URL,
      transportMode: process.env.CREWLOOM_TRANSPORT_MODE ?? 'product',
      afterLoginUrl,
      emailTyped,
      pwdTyped,
      canvasHref,
      probe,
      registry,
      unsupported,
      failedResponses: failedResponses.slice(0, 10),
      consoleErrors: consoleErrors.slice(0, 12),
      pageErrors: pageErrors.slice(0, 6),
      shots: [join(OUT_DIR, '01-native-workflow-canvas-desktop.png'), join(OUT_DIR, '02-native-workflow-canvas-narrow.png')],
      generatedAt: new Date().toISOString(),
    };
    if (evidenceOut) {
      mkdirSync(dirname(evidenceOut), { recursive: true });
      writeFileSync(evidenceOut, `${JSON.stringify(evidence, null, 2)}\n`);
    }
    console.error(
      `[native-canvas] result=${ok ? 'PASS' : 'FAIL'} login=${afterLoginUrl} href=${canvasHref} host=${probe?.hasHost} canvas=${probe?.hasCanvas} nodes=${probe?.nodeCount} addButtons=${probe?.addButtonCount} instructions=${registry?.instructionCount ?? '?'} triggers=${registry?.triggerCount ?? '?'} pageErrors=${pageErrors.length}`,
    );
    console.log(JSON.stringify(evidence, null, 2));
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
