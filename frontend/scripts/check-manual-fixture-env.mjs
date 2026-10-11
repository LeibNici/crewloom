#!/usr/bin/env node
/**
 * TD-02 本机验收环境：**端到端连通性自检**（环境自检，不是验收）。
 *
 * 目的只有一个：在把环境交给人工验收之前，确认
 *   Vite（电脑端 preview/dev） → 服务器代理 → 本机合成 fixture → 真实页面
 * 这条链真的通：合成账号能在**真实登录页**登录、**可见待办列表**能点进处理表单、
 * schema 字段与关联候选能渲染、处理动作能把合成数据写进 fixture。
 *
 * 与 `verify-manual-native-form.mjs` 的区别（有意如此）：
 *  - 不做任何 CDP 网络拦截（`Fetch.enable`），全部请求真的经过 Vite 代理打到 fixture；
 *  - 不注入 localStorage / 会话 / 任何隐藏状态；
 *  - 不产出验收计数，只打印"环境自检 PASS/FAIL"；
 *  - 跑完把 fixture 的合成提交记录重置，留给人工验收一个干净状态。
 *
 * 用法：
 *   CREWLOOM_APP_URL=http://127.0.0.1:5323 CREWLOOM_FIXTURE_URL=http://127.0.0.1:5402 \
 *     node scripts/check-manual-fixture-env.mjs
 * 退出码 0 = 全通过；1 = 有失败项（详见输出）。
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP_URL = process.env.CREWLOOM_APP_URL ?? 'http://127.0.0.1:5323';
const FIXTURE_URL = process.env.CREWLOOM_FIXTURE_URL ?? 'http://127.0.0.1:5402';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT ?? 9365);
const ACCOUNT = { email: 'zhangsan@fixture.local', password: 'fixture' };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, ok, note = '') => {
  results.push({ name, ok, note });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? ` — ${note}` : ''}`);
};

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId: this.sessionId }));
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
    await sleep(250);
  }
  throw new Error('Chrome 调试端口未就绪');
}

const profileDir = mkdtempSync(join(tmpdir(), 'crewloom-fixture-smoke-'));
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

let cdp;
try {
  const version = await waitForDevtools(DEBUG_PORT);
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true });
  });
  cdp = new Cdp(ws);
  const { targetInfos } = await cdp.send('Target.getTargets');
  const page = (targetInfos ?? []).find((info) => info.type === 'page');
  const targetId = page?.targetId ?? (await cdp.send('Target.createTarget', { url: 'about:blank' })).targetId;
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  cdp.sessionId = sessionId;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.bringToFront');

  const evaluate = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`页面脚本异常：${result.exceptionDetails.text}`);
    return result.result.value;
  };
  const pageText = async () => (await evaluate('document.body.innerText || ""')).replace(/\s+/g, ' ');
  const waitForText = async (needle, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await pageText()).includes(needle)) return true;
      await sleep(250);
    }
    return false;
  };
  const goto = async (path) => {
    await cdp.send('Page.navigate', { url: `${APP_URL}${path}` });
    await sleep(2500);
    // headless 下标签页会被置为 hidden 并暂停 rAF/ResizeObserver；环境自检也要看真实渲染。
    await cdp.send('Page.bringToFront');
    await sleep(250);
  };
  const typeInto = async (selector, value) => {
    const focused = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); return true; })()`);
    if (!focused) return false;
    for (const char of value) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: char });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp' });
      await sleep(20);
    }
    return true;
  };

  // 1) fixture 自身
  const health = await fetch(`${FIXTURE_URL}/healthz`);
  check('本机合成 fixture 在运行（/healthz）', health.ok, FIXTURE_URL);

  // 2) 服务器代理确实绑定到 fixture（响应头 x-crewloom-fixture，而不是真实后端）
  const viaProxy = await fetch(`${APP_URL}/api/app:getInfo`);
  check(
    'Vite 的 /api 代理绑定本机 fixture（响应头 x-crewloom-fixture=1）',
    viaProxy.headers.get('x-crewloom-fixture') === '1',
    `${APP_URL}/api/app:getInfo → ${viaProxy.status}`,
  );

  // 3) 真实登录页 + 合成账号
  await goto('/login');
  const loginShown = await waitForText('登录', 15000);
  check('真实登录页可打开', loginShown);
  await typeInto('input[type="text"], input[type="email"]', ACCOUNT.email);
  await typeInto('input[type="password"]', ACCOUNT.password);
  await evaluate(`(() => { const btn=[...document.querySelectorAll('button')].find(b=>/登录|登 录/.test(b.textContent||'')); btn&&btn.click(); return true; })()`);
  await sleep(4000);
  const path = await evaluate('location.pathname');
  check('合成账号在真实登录页登录成功', path !== '/login', `${ACCOUNT.email} → ${path}`);

  // 4) 可见待办列表 → 直达处理表单
  await goto('/tasks/pending');
  const listShown = await waitForText('报销审批（合成样本）', 20000);
  check('可见待办列表出现合成任务', listShown, (await pageText()).slice(0, 120));
  const clicked = await evaluate(`(() => {
    const link = [...document.querySelectorAll('a')].find((a) => (a.getAttribute('href') || '').includes('/tasks/manual?id='));
    if (!link) return null;
    const href = link.getAttribute('href');
    link.click();
    return href;
  })()`);
  check('待办列表的入口可点进处理表单', Boolean(clicked), String(clicked));
  await sleep(3000);

  // 5) 表单字段与关联候选（真实 SchemaComponent + 真实 AssociationField）
  const formShown = await waitForText('报销金额', 20000);
  check('处理表单渲染出 schema 字段', formShown && (await waitForText('会签人', 8000)));
  const candidates = await (async () => {
    await evaluate(`(() => {
      const items = [...document.querySelectorAll('.ant-formily-item')];
      const item = items.find((i) => ((i.querySelector('.ant-formily-item-label') || {}).textContent || '').includes('会签人'));
      const selector = item && item.querySelector('.ant-select-selector');
      if (!selector) return false;
      for (const type of ['mousedown', 'mouseup', 'click']) selector.dispatchEvent(new MouseEvent(type, { bubbles: true }));
      return true;
    })()`);
    return waitForText('张三', 8000);
  })();
  check('关联字段候选值来自 fixture 的 users:list（可见「张三」）', candidates);

  // 6) 处理动作把合成数据写进 fixture（真实按钮 + 真实请求）
  await evaluate(`(() => { const el=document.querySelector('input[type="checkbox"]'); el&&el.click(); return true; })()`);
  await sleep(300);
  await typeInto('.ant-input-number-input', '256');
  await evaluate(`(() => {
    const items = [...document.querySelectorAll('.ant-formily-item')];
    const item = items.find((i) => ((i.querySelector('.ant-formily-item-label') || {}).textContent || '').includes('类别'));
    const selector = item && item.querySelector('.ant-select-selector');
    if (!selector) return false;
    for (const type of ['mousedown', 'mouseup', 'click']) selector.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    return true;
  })()`);
  await sleep(600);
  await evaluate(`(() => {
    const option = [...document.querySelectorAll('.ant-select-item-option')].find((o) => (o.textContent || '').includes('差旅'));
    if (!option) return false;
    for (const type of ['mousedown', 'mouseup', 'click']) option.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    return true;
  })()`);
  await sleep(400);
  await evaluate(`(() => { const b=[...document.querySelectorAll('button')].find((x)=>(x.textContent||'').trim()==='通过'); b&&b.click(); return true; })()`);
  await sleep(2500);

  const stateAfterSubmit = await (await fetch(`${FIXTURE_URL}/control/state`)).json();
  check(
    '真实页面按钮提交后，fixture 记录到合成提交体',
    stateAfterSubmit.submitted?.result?.formA?.amount === 256,
    JSON.stringify(stateAfterSubmit.submitted ?? {}).slice(0, 160),
  );
  const task7 = (stateAfterSubmit.taskStates ?? []).find((item) => item.id === 7);
  check('真实页面提交后原任务 7 在 fixture 里变为已处理', task7?.processed === true, JSON.stringify(task7 ?? null));

  // 7) 重新打开原任务：应为只读回显（不再是"待处理可填写"）
  await goto('/tasks/manual?id=7');
  const readonlyShown = await waitForText('这条待办已经处理过', 20000);
  check('提交后重新打开原任务为只读回显', readonlyShown, (await pageText()).slice(0, 160));

  // 8) 收尾：重置合成数据，给人工验收留干净状态
  const reset = await fetch(`${FIXTURE_URL}/control/reset`, { method: 'POST' });
  const stateAfterReset = await reset.json();
  check('收尾重置合成数据（人工验收从干净状态开始）', reset.ok && stateAfterReset.submitted === null);
  const task7Reset = (stateAfterReset.taskStates ?? []).find((item) => item.id === 7);
  check('收尾重置把原任务 7 恢复为待处理', task7Reset?.processed === false, JSON.stringify(task7Reset ?? null));
} catch (error) {
  check('环境自检未抛异常', false, String(error?.message ?? error));
} finally {
  try {
    if (cdp) await cdp.send('Browser.close');
  } catch {
    /* 忽略 */
  }
  chrome.kill('SIGTERM');
  try {
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* 忽略 */
  }
}

const failed = results.filter((item) => !item.ok);
console.log(`\n环境自检：${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) {
  console.log(`失败项：${failed.map((item) => item.name).join('; ')}`);
  process.exitCode = 1;
}
