#!/usr/bin/env node
/**
 * 组 C（WF + TD）受控浏览器冒烟：在真实预览里逐页打开本组页面。
 *
 * 目的：验证注册表路由、页面渲染与真实只读数据在**真实浏览器**里确实可用
 * （单测与真实只读联调都不能替代浏览器渲染证据）。
 *
 * 安全与边界：
 *  - 只读：脚本只做导航与截图，**不点击任何保存/启停/提交/删除按钮**；
 *  - 登录只走正常 `auth:signIn`，令牌留在浏览器 localStorage 内，不打印、不写日志；
 *  - 凭据只从主工作区 `.secrets/full-pages-13000-20261011.json`（0600）按路径读取；
 *  - 截图可能包含真实业务标题，输出到本组目录 `tests/modules/workflow/.artifacts/`（由同目录 `.gitignore` 排除），**不提交**；
 *  - 使用独立空闲端口，不触碰 5273/5274/5275/3080。
 *
 * 用法：
 *   CREWLOOM_PREVIEW_URL=http://127.0.0.1:5281 node tests/modules/workflow/browser-check.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(here, '../../..');
const repoRoot = resolve(frontendRoot, '..');
const SECRET_PATH = '/Users/chenming/IdeaProjects/crewloom/.secrets/full-pages-13000-20261011.json';
const OUT_DIR = process.env.CREWLOOM_SHOT_DIR ?? resolve(here, '.artifacts');
const BASE_URL = process.env.CREWLOOM_PREVIEW_URL ?? 'http://127.0.0.1:5281';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT ?? 9455);

const results = [];
function record(name, ok, note) {
  results.push({ name, ok, note });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? ` — ${note}` : ''}`);
}

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
        if (msg.error) reject(new Error(`${msg.error.message}`));
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!existsSync(SECRET_PATH)) {
    console.error('缺少凭据文件（只按路径读取，不打印内容）');
    process.exitCode = 2;
    return;
  }
  const secrets = JSON.parse(readFileSync(SECRET_PATH, 'utf8'));
  const apiOrigin = String(secrets.apiBaseURL).replace(/\/api\/?$/, '');

  // 先在实际 API 上登录，拿一个真实令牌；同时在只读范围内取几条真实 id 用于详情页。
  const signIn = await fetch(`${apiOrigin}/api/auth:signIn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: secrets.email, password: secrets.password }),
  });
  if (!signIn.ok) {
    console.error(`登录失败：HTTP ${signIn.status}`);
    process.exitCode = 3;
    return;
  }
  const signInBody = await signIn.json();
  const token = signInBody?.data?.token;
  if (!token) {
    console.error('登录响应缺少令牌');
    process.exitCode = 3;
    return;
  }
  const authHeaders = { Authorization: `Bearer ${token}`, 'X-Data-Source': 'main' };
  const readJson = async (path) => {
    const response = await fetch(`${apiOrigin}/api/${path}`, { headers: authHeaders });
    if (!response.ok) return null;
    return await response.json();
  };

  const workflows = await readJson('workflows:list?pageSize=1&sort=-id');
  const workflowId = workflows?.data?.[0]?.id ?? null;
  const nodes = workflowId
    ? await readJson(`flow_nodes:list?pageSize=50&sort=id&filter=${encodeURIComponent(JSON.stringify({ workflowId }))}`)
    : null;
  const knownNodeType = ['calculation', 'condition', 'query', 'create', 'update', 'destroy', 'output', 'end', 'multi-conditions'];
  const nodeRows = Array.isArray(nodes?.data) ? nodes.data : [];
  const knownNode = nodeRows.find((node) => knownNodeType.includes(node?.type)) ?? nodeRows[0] ?? null;
  const nodeId = knownNode?.id ?? null;
  const executions = await readJson('executions:list?pageSize=1&sort=-id');
  const executionId = executions?.data?.[0]?.id ?? null;

  mkdirSync(OUT_DIR, { recursive: true });
  const profileDir = mkdtempSync(join(tmpdir(), 'crewloom-group-c-'));

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
      // 受限沙箱环境下 Chrome 的 crashpad/sandbox 初始化会失败，关闭后仍可正常渲染。
      '--disable-crash-reporter',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-gpu',
      '--hide-scrollbars',
      '--window-size=1440,1000',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let cdp = null;
  let cdpProcess = null;
  try {
    const version = await waitForDevtools(DEBUG_PORT);
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('CDP 连接超时')), 20000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        res();
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        rej(new Error('CDP 连接失败'));
      });
    });
    cdp = new Cdp(ws);
    cdpProcess = cdp;

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    // 浏览器级命令（Target.*）不带 sessionId 发送；attach 之后再把会话绑定到实例上。
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }, undefined);
    cdp.sessionId = sessionId;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });

    // 注入真实会话令牌（浏览器内使用，脚本不打印令牌）。
    await cdp.send('Page.navigate', { url: `${BASE_URL}/login` });
    await sleep(1200);
    await cdp.send('Runtime.evaluate', {
      expression: `window.localStorage.setItem('crewloom.session.token', ${JSON.stringify(token)}); 'ok'`,
      returnByValue: true,
    });
    await cdp.send('Runtime.evaluate', {
      expression: `window.localStorage.setItem('crewloom.session.auth', 'basic'); 'ok'`,
      returnByValue: true,
    });

    const evaluate = async (expression) => {
      const { result } = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      return result?.value;
    };

    const visit = async (name, path, { expectTitle, expectText } = {}) => {
      await cdp.send('Page.navigate', { url: `${BASE_URL}${path}` });
      // 等页面出现主标题（应用是 SPA，路由渲染后才有 h2）。
      const deadline = Date.now() + 20000;
      let heading = '';
      while (Date.now() < deadline) {
        heading = (await evaluate(`document.querySelector('h2')?.textContent ?? ''`)) ?? '';
        if (heading.length > 0) break;
        await sleep(250);
      }
      // 详情类页面要先取数据再渲染正文；等期望文案出现（最多 15 秒），避免把加载态当成结果。
      if (expectText) {
        const textDeadline = Date.now() + 15000;
        while (Date.now() < textDeadline) {
          const current = (await evaluate(`document.body.innerText`)) ?? '';
          if (current.includes(expectText)) break;
          await sleep(300);
        }
      }
      await sleep(400);
      const bodyText = (await evaluate(`document.body.innerText`)) ?? '';
      const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(OUT_DIR, `${name}.png`), Buffer.from(screenshot.data, 'base64'));

      const titleOk = expectTitle ? heading.includes(expectTitle) : heading.length > 0;
      const textOk = expectText ? bodyText.includes(expectText) : true;
      const hasInternalJargon = /HTTP \d|TRANSPORT_BLOCKED|TypeError|undefined|\[object Object\]/.test(bodyText);
      record(name, titleOk && textOk && !hasInternalJargon, `标题=「${heading}」${hasInternalJargon ? '（发现内部字样）' : ''}`);
      return bodyText;
    };

    await visit('wf-01-list', '/workflow/list', { expectTitle: '流程列表', expectText: '共' });
    await visit('wf-04-executions', '/workflow/executions', { expectTitle: '执行记录', expectText: '共' });
    if (executionId) {
      await visit('wf-05-execution-detail', `/workflow/execution?id=${executionId}`, {
        expectTitle: `执行 #${executionId}`,
        expectText: '节点处理结果',
      });
    } else {
      record('wf-05-execution-detail', false, '真实执行数据为空，无法打开详情页');
    }
    if (workflowId) {
      await visit('wf-02-canvas', `/workflow/canvas?workflowId=${workflowId}`, {
        expectTitle: '流程编排',
        expectText: '节点处理顺序',
      });
    } else {
      record('wf-02-canvas', false, '真实流程数据为空，无法打开编排页');
    }
    if (workflowId && nodeId) {
      await visit('wf-03-node-config', `/workflow/node?workflowId=${workflowId}&nodeId=${nodeId}`, {
        expectTitle: '节点配置',
      });
    } else {
      record('wf-03-node-config', false, '没有可用的真实节点，无法打开节点配置页');
    }
    await visit('td-01-pending', '/tasks/pending', { expectTitle: '我的待处理', expectText: '本人工作流待处理' });
    await visit('td-01-processed', '/tasks/processed', { expectTitle: '已处理' });
    await visit('td-04-cc-list', '/tasks/cc-list', { expectTitle: '抄送我的' });
    await visit('td-04-cc-detail', '/tasks/cc?id=0', { expectTitle: '抄送详情' });
    await visit('td-02-manual', '/tasks/manual?id=0', { expectTitle: '人工处理' });
    await visit('td-03-ai', '/tasks/ai?sessionId=missing-session', { expectTitle: 'AI 任务' });
    await visit('td-05-approval', '/tasks/approval', { expectTitle: '专业审批', expectText: '没有开通专业审批能力' });

    const failed = results.filter((item) => !item.ok);
    const report = {
      generatedAt: new Date().toISOString(),
      preview: BASE_URL,
      note: '受控浏览器冒烟：只读导航 + 截图，未点击任何写入按钮；截图含真实业务标题，仅本机保留。',
      total: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
      results,
    };
    writeFileSync(join(OUT_DIR, 'browser-smoke.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.exitCode = failed.length === 0 ? 0 : 1;
  } finally {
    try {
      if (cdpProcess) await cdpProcess.send('Browser.close');
    } catch {
      /* 忽略关闭错误 */
    }
    try {
      chrome.kill('SIGTERM');
    } catch {
      /* 忽略 */
    }
  }
}

await main();
