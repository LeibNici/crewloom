#!/usr/bin/env node
/**
 * 公共页面（PUB-01 / PUB-03 / PUB-06）的真实浏览器核对。
 *
 * 运行前提：本机已用 **strict 模式** 启动指向 13000 的预览，例如
 *   CREWLOOM_TRANSPORT_MODE=strict VITE_DEV_PORT=5279 pnpm run dev
 * 然后 `CREWLOOM_PREVIEW_URL=http://127.0.0.1:5279 node scripts/verify-public-browser.mjs`。
 *
 * 核对内容（全部只读，除正常登录/退出外不发 POST）：
 *  1. 登录页：真实 13000 未开通自助找回 → 点「忘记密码？」只说明原因，不出现邮箱表单；
 *  2. 真实账号登录 → 工作台：后台应用信息来自 systemSettings、待办/会话/员工来自真实接口，
 *     页面上不得出现 "undefined"（会话标识必须用 sessionId 而不是 id）；
 *  3. 账号菜单：展示后台应用名称、版本与可用语言（PUB-06），并保持 Crewloom 产品品牌；
 *  4. 修改密码页可直达（PUB-01），含三项口令输入，且页面不显示任何内部标识。
 *
 * 安全约束：
 *  - 凭据只在进程内存里从 `.secrets/full-pages-13000-20261011.json`（0600）读取，
 *    逐字符注入到输入框，不进 argv、不进日志、不进截图说明；
 *  - 不调用上传、不改密码、不发重置邮件、不触发模型；
 *  - 截图保存到 `frontend/.shots/public/`（已 gitignore）：工作台截图含真实业务数据，**不提交**。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const SECRET_CANDIDATES = [
  resolve(repoRoot, '.secrets/full-pages-13000-20261011.json'),
  resolve(repoRoot, '..', '..', '.secrets/full-pages-13000-20261011.json'),
];
const SECRET_PATH =
  process.env.CREWLOOM_13000_SECRETS ??
  SECRET_CANDIDATES.find((candidate) => existsSync(candidate)) ??
  SECRET_CANDIDATES[0];
const OUT_DIR = process.env.CREWLOOM_PUBLIC_SHOT_DIR ?? resolve(repoRoot, 'frontend/.shots/public');
const BASE_URL = process.env.CREWLOOM_PREVIEW_URL ?? 'http://127.0.0.1:5279';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT ?? 9345);

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

function createHelpers(cdp) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const evaluate = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`页面脚本异常：${result.exceptionDetails.text}`);
    return result.result.value;
  };

  const goto = async (path) => {
    await cdp.send('Page.navigate', { url: `${BASE_URL}${path}` });
    await sleep(1200);
  };

  const bodyText = () => evaluate('document.body.innerText');

  const shot = async (name) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(join(OUT_DIR, name), Buffer.from(data, 'base64'));
    return name;
  };

  /** 逐字符输入：不经过剪贴板，也不把内容写进日志。 */
  const typeInto = async (selector, value) => {
    await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      return true;
    })()`);
    for (const char of value) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: char });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp' });
      await sleep(8);
    }
  };

  const clickText = async (selector, text) =>
    evaluate(`(() => {
      const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
      const target = nodes.find((node) => node.textContent.includes(${JSON.stringify(text)}));
      if (!target) return false;
      target.click();
      return true;
    })()`);

  const clickSelector = async (selector) =>
    evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.click();
      return true;
    })()`);

  const waitFor = async (predicate, timeoutMs = 12000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await sleep(250);
    }
    return false;
  };

  return { evaluate, goto, bodyText, shot, typeInto, clickText, clickSelector, waitFor, sleep };
}

async function main() {
  if (!existsSync(SECRET_PATH)) {
    console.error(`缺少凭据文件：${SECRET_PATH}`);
    process.exitCode = 2;
    return;
  }
  const secrets = JSON.parse(readFileSync(SECRET_PATH, 'utf8'));
  mkdirSync(OUT_DIR, { recursive: true });
  const profileDir = mkdtempSync(join(tmpdir(), 'crewloom-public-cdp-'));

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

  try {
    const versionInfo = await waitForDevtools(DEBUG_PORT);
    const ws = new WebSocket(versionInfo.webSocketDebuggerUrl);
    await new Promise((res, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP 连接超时')), 20000);
      ws.addEventListener('open', () => { clearTimeout(timer); res(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP 连接失败')); }, { once: true });
    });
    const cdp = new Cdp(ws);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    cdp.sessionId = sessionId;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 2, mobile: false });

    const h = createHelpers(cdp);

    // 1. 登录页与找回密码能力（真实 13000 未开通）
    await h.goto('/login');
    const loginText = await h.bodyText();
    record('登录页显示 Crewloom 产品名', loginText.includes('Crewloom'), null);
    record('登录页有「忘记密码？」入口', loginText.includes('忘记密码'), null);
    await h.clickText('button', '忘记密码');
    const recoveryOk = await h.waitFor(async () => (await h.bodyText()).includes('未开通自助找回'));
    record('未开通自助找回时只说明原因', recoveryOk, recoveryOk ? null : '未看到未开通说明');
    const recoveryText = await h.bodyText();
    record('未开通时不渲染邮箱找回表单', !recoveryText.includes('发送重置邮件'), null);
    await h.shot('01-login-recovery.png');

    // 2. 真实登录 → 工作台
    await h.typeInto('input[name="crewloom-account"]', String(secrets.email));
    await h.typeInto('input[name="crewloom-secret"]', String(secrets.password));
    await h.clickText('button[type="submit"]', '登录');
    const landed = await h.waitFor(async () => !(await h.bodyText()).includes('邮箱或用户名'), 20000);
    record('真实账号登录成功并进入应用', landed, null);

    // 登录后的落点由角色/权限决定，工作台断言显式导航过去。
    await h.goto('/workbench');
    const workbenchReady = await h.waitFor(async () => (await h.bodyText()).includes('本人工作流待处理任务'), 20000);
    record('工作台加载真实数据', workbenchReady, null);
    const workbenchText = await h.bodyText();
    record('工作台不出现 undefined', !workbenchText.includes('undefined'), null);
    record(
      '工作台不出现未翻译的 i18n 模板',
      !/\{\{\s*t\(/.test(workbenchText),
      workbenchText.match(/\{\{\s*t\([^)]*\)\}\}/)?.[0] ?? null,
    );
    record('侧栏保持 Crewloom 品牌', workbenchText.includes('Crewloom'), null);
    record(
      '工作台展示后台应用信息',
      workbenchText.includes('后台应用') || workbenchText.includes('瑞源') || workbenchText.includes('未设置'),
      null,
    );
    await h.shot('02-workbench.png');

    // 3. 账号菜单（PUB-06）
    await h.clickSelector('details > summary');
    const menuOpen = await h.waitFor(async () => (await h.bodyText()).includes('后台信息'));
    record('账号菜单展示后台信息', menuOpen, null);
    const menuText = await h.bodyText();
    record('账号菜单不泄露内部标识', !/roleMode|allow-use-union|401|403/.test(menuText), null);
    record('账号菜单包含修改密码入口', menuText.includes('修改密码'), null);
    await h.shot('03-account-menu.png');

    // 4. 修改密码页（PUB-01）
    await h.goto('/account/password');
    const pwReady = await h.waitFor(async () => (await h.bodyText()).includes('修改密码'), 12000);
    record('修改密码页可直达', pwReady, null);
    const pwFields = await h.evaluate('document.querySelectorAll(\'input[type="password"]\').length');
    record('修改密码页有三个口令输入框', pwFields === 3, `实际 ${pwFields}`);
    const pwText = await h.bodyText();
    record('修改密码页不显示内部错误码', !/changePassword|401|403|auth:/.test(pwText), null);
    await h.shot('04-change-password.png');

    // 5. 正常退出（POST auth:signOut 是允许的）
    await h.goto('/workbench');
    await h.clickSelector('details > summary');
    await h.clickText('button', '退出登录');
    const signedOut = await h.waitFor(async () => (await h.bodyText()).includes('忘记密码'), 12000);
    record('正常退出回到登录页', signedOut, null);

    const failed = results.filter((item) => !item.ok);
    writeFileSync(
      join(OUT_DIR, 'public-browser-summary.json'),
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          preview: BASE_URL,
          note: '真实 13000 只读浏览器核对；截图含真实业务数据，不入库。',
          results,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`\n合计 ${results.length} 项，失败 ${failed.length} 项；截图与摘要：${OUT_DIR}`);
    process.exitCode = failed.length === 0 ? 0 : 1;
  } finally {
    chrome.kill('SIGKILL');
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      /* Chrome 退出后仍可能残留临时 profile 文件；清理失败不影响核对结论。 */
    }
  }
}

await main();
