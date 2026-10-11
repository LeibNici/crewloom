/**
 * 组 A 的真实浏览器核对（CDP，本机 Chrome）。
 *
 * ⚠️ 本机实测：在 DSH 的文件沙箱（workspace-write）里启动 Chrome 会在
 * "sandbox initialization failed: Operation not permitted" 处崩溃，
 * 因此**该脚本在当前环境未运行成功**（原始输出见
 * `group-a-evidence/logs/browser-group-a-01.log` 与 `screenshots-local/chrome.log`）。
 * 脚本保留为可在非沙箱环境复现的核对路径；本轮的页面级真实数据证据改用
 * `tests/modules/ai/live-13000-group-a-pages.test.tsx`（jsdom + 真实 13000 只读）。
 *
 * 目的：在真实浏览器里登录 13000、逐页打开 AI-01..06 与 LM-01..05，确认：
 *  1. 页面能渲染真实后端数据（不是占位骨架）；
 *  2. 页面上**不出现**内部错误码 / 原始报错 / 传输拦截码；
 *  3. LM-01 的卡片与 DOM 里**不出现** `options.apiKey` / `options.baseURL` 之类的明文；
 *  4. 逐页截图（**真实数据截图**，只保存在本机 evidence/screenshots-local，不提交）。
 *
 * 只做只读浏览与正常登录；不点击任何保存/发送/删除/测试按钮。
 *
 * 用法：
 *   VITE_DEV_PORT=5281 pnpm run dev &
 *   node tests/modules/ai/browser-group-a.mjs
 *
 * 凭据只从主工作区的 `.secrets/full-pages-13000-20261011.json` 读取，
 * 不打印、不写入截图或报告。需要本机已安装 Google Chrome。
 */

import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const PREVIEW = process.env.CREWLOOM_PREVIEW ?? 'http://127.0.0.1:5286';
const DEBUG_PORT = Number(process.env.CREWLOOM_CDP_PORT ?? 9333);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT_DIR = resolve(process.cwd(), '../docs/acceptance/full-pages-13000/group-a-evidence/screenshots-local');
const SECRET_CANDIDATES = [
  process.env.CREWLOOM_13000_SECRET,
  resolve(process.cwd(), '../.secrets/full-pages-13000-20261011.json'),
  resolve(process.cwd(), '../../../.secrets/full-pages-13000-20261011.json'),
].filter(Boolean);

/**
 * 待核对路由。
 * `follow` = 列表渲染后要点进去的详情链接选择器（详情路由只有在真实数据下才有意义）。
 */
const ROUTES = [
  { name: 'ai-01-directory', path: '/ai/directory', follow: 'a[href^="/ai/directory/"]' },
  { name: 'ai-02-employees-config', path: '/ai/employees-config', follow: 'a[href^="/ai/employees-config/"]' },
  { name: 'ai-03-conversations', path: '/ai/conversations', follow: 'a[href^="/ai/conversations/"]' },
  { name: 'ai-04-context', path: '/ai/context' },
  { name: 'ai-05-tools', path: '/ai/tools' },
  { name: 'ai-05-mcp', path: '/ai/mcp' },
  { name: 'ai-06-knowledge', path: '/ai/knowledge' },
  { name: 'lm-01-services', path: '/model/services' },
  // LM-02 的详情路由：用新建态浏览表单（只读浏览，不点保存）。
  { name: 'lm-02-service-config-new', path: '/model/services/new' },
  { name: 'lm-03-models', path: '/model/models' },
  { name: 'lm-04-defaults', path: '/model/defaults' },
  { name: 'lm-05-verify', path: '/model/verify' },
];

function readSecret() {
  for (const candidate of SECRET_CANDIDATES) {
    if (!existsSync(candidate)) continue;
    return JSON.parse(readFileSync(candidate, 'utf8'));
  }
  return null;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitForJson(url, timeoutMs = 15000) {
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      /* 还没起来 */
    }
    if (Date.now() - started > timeoutMs) throw new Error(`等待 ${url} 超时`);
    await sleep(200);
  }
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve: done, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else done(message.result);
        return;
      }
      if (message.method && /^(Runtime\.(consoleAPICalled|exceptionThrown)|Log\.entryAdded)$/.test(message.method)) {
        this.events.push(message);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((done, reject) => this.pending.set(id, { resolve: done, reject }));
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`页面脚本异常: ${result.exceptionDetails.text}`);
    }
    return result.result.value;
  }
}

async function main() {
  const secrets = readSecret();
  if (!secrets) {
    console.log(JSON.stringify({ ok: false, reason: 'missing-secret' }));
    process.exitCode = 1;
    return;
  }
  if (!existsSync(CHROME)) {
    console.log(JSON.stringify({ ok: false, reason: 'chrome-not-found' }));
    process.exitCode = 1;
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  // 每次运行用独立 profile：避免复用上一次残留的 Chrome 实例（会拿到已失效的调试会话）。
  // profile 放在系统临时目录：Chrome 的网络服务需要在该目录建 IPC socket，
  // 放在工作区内会被 DSH 文件沙箱限制（表现为浏览器报"连接被拒绝"）。
  // 截图仍然写回工作区的 evidence 目录；临时 profile 不属于产品依赖。
  const profile = process.env.CREWLOOM_CHROME_PROFILE ?? `/tmp/crewloom-group-a-chrome-${process.pid}`;
  const chromeLog = resolve(OUT_DIR, `chrome-${process.pid}.log`);
  const chrome = spawn(
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
      // 直接在命令行给出登录地址：实测在本机沙箱下，用 CDP 的 Page.navigate 发起首个请求
      // 会被浏览器报"连接被拒绝"，而命令行导航可以正常加载。
      `${PREVIEW}/login`,
    ],
    { stdio: ['ignore', openSync(chromeLog, 'w'), openSync(chromeLog, 'a')] },
  );

  const results = [];
  try {
    await waitForJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
    const targets = await waitForJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
    const page = targets.find((target) => target.type === 'page');
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((done) => socket.addEventListener('open', done));
    const cdp = new Cdp(socket);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // 1) 登录（凭据只在内存中；脚本从不打印它们）
    // 开发服务器首次加载要现场编译模块，等待表单真正出现再输入。
    await cdp.send('Log.enable').catch(() => undefined);
    let formReady = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await sleep(400);
      formReady = await cdp.evaluate(
        `Boolean(document.querySelector('input[type=text]') && document.querySelector('input[type=password]') && document.querySelector('button[type=submit]'))`,
      );
      if (formReady) break;
    }
    if (!formReady) {
      const diag = await cdp.evaluate(`JSON.stringify({
        href: location.href,
        title: document.title,
        readyState: document.readyState,
        htmlLength: document.documentElement.outerHTML.length,
        bodyText: (document.body && document.body.textContent || '').slice(0, 300),
      })`);
      writeFileSync(
        resolve(OUT_DIR, 'login-diagnostic.json'),
        JSON.stringify({ diag: JSON.parse(diag), events: cdp.events.slice(0, 40) }, null, 2),
      );
      throw new Error(`登录表单未出现: ${diag}`);
    }
    await cdp.evaluate(`(() => {
      const setValue = (selector, value) => {
        const input = document.querySelector(selector);
        if (!input) throw new Error('missing ' + selector);
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      setValue('input[type=text]', ${JSON.stringify(secrets.email)});
      setValue('input[type=password]', ${JSON.stringify(secrets.password)});
      document.querySelector('button[type=submit]').click();
      return true;
    })()`);

    let loggedIn = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await sleep(500);
      const href = await cdp.evaluate('location.pathname');
      if (href && href !== '/login') {
        loggedIn = true;
        break;
      }
    }
    results.push({ step: 'login', ok: loggedIn });

    if (!loggedIn) {
      const text = await cdp.evaluate('document.body.innerText.slice(0, 400)');
      writeFileSync(resolve(OUT_DIR, 'login-failure.txt'), String(text));
    }

    // 2) 逐页打开并核对
    const forbiddenPatterns = [
      'TRANSPORT_BLOCKED',
      'EMPTY_TOKEN',
      'ROLE_NOT_FOUND',
      'Invalid SQL column',
      'is not allowed',
      'stack trace',
    ];
    const waitRendered = async () => {
      // 等页面自身渲染完：模块级权限探测（refreshProbes）是顺序执行的，
      // 首次进入某个模块时会先显示"正在恢复登录状态…"，此时截图没有意义。
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await sleep(400);
        const rendered = await cdp.evaluate(`(() => {
          const heading = document.querySelector('h2');
          const text = document.body ? (document.body.textContent || '') : '';
          return Boolean(heading && (heading.textContent || '').trim().length > 0)
            && !text.includes('正在恢复登录状态');
        })()`);
        if (rendered) return true;
      }
      return false;
    };

    const capture = async (name, rendered) => {
      await sleep(300);
      const snapshot = await cdp.evaluate(`(() => {
        const text = document.body.innerText;
        return {
          path: location.pathname,
          title: document.querySelector('h2')?.innerText ?? '',
          textLength: text.length,
          text,
          inputs: document.querySelectorAll('input, select, textarea').length,
          buttons: document.querySelectorAll('button').length,
        };
      })()`);
      const hits = forbiddenPatterns.filter((pattern) => String(snapshot.text).includes(pattern));
      // 明文检查：模型服务的页面 DOM 里不得出现 options.apiKey / options.baseURL 的值或键名。
      const leaks = name.startsWith('lm-')
        ? ['apiKey', 'baseURL', 'Bearer '].filter((pattern) => String(snapshot.text).includes(pattern))
        : [];
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(resolve(OUT_DIR, `${name}.png`), Buffer.from(shot.data, 'base64'));
      results.push({
        step: name,
        rendered,
        path: snapshot.path,
        title: snapshot.title,
        ok: rendered && hits.length === 0 && leaks.length === 0 && snapshot.textLength > 40,
        internalCodes: hits,
        leaks,
        inputs: snapshot.inputs,
        buttons: snapshot.buttons,
      });
    };

    for (const route of ROUTES) {
      const { name, path, follow } = route;
      await cdp.send('Page.navigate', { url: `${PREVIEW}${path}` });
      const rendered = await waitRendered();
      await capture(name, rendered);

      // AI-01 关键词筛选（本地过滤）：输入完整用户名后列表必须收敛到 1 行。
      if (name === 'ai-01-directory' && rendered) {
        const target = await cdp.evaluate(`(() => {
          const link = document.querySelector('a[href^="/ai/directory/"]');
          if (!link) return null;
          const href = link.getAttribute('href') || '';
          return decodeURIComponent(href.split('/').pop() || '');
        })()`);
        if (target) {
          const before = await cdp.evaluate(`document.querySelectorAll('a[href^="/ai/directory/"]').length`);
          await cdp.evaluate(`(() => {
            const input = Array.from(document.querySelectorAll('input')).find((el) => (el.getAttribute('aria-label') || '').includes('筛选'));
            if (!input) throw new Error('missing filter input');
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(input, ${'`'}${'`'} + ${JSON.stringify(target)});
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
          })()`);
          await sleep(700);
          const after = await cdp.evaluate(`document.querySelectorAll('a[href^="/ai/directory/"]').length`);
          results.push({
            step: 'ai-01-directory-filter',
            rendered: true,
            ok: after === 1 && before > 1,
            matchedRows: after,
            rowsBeforeFilter: before,
          });
        }
      }

      if (follow && rendered) {
        const href = await cdp.evaluate(
          `(() => { const link = document.querySelector(${JSON.stringify(follow)}); return link ? link.getAttribute('href') : null; })()`,
        );
        if (href) {
          await cdp.send('Page.navigate', { url: `${PREVIEW}${href}` });
          const detailRendered = await waitRendered();
          await capture(`${name}-detail`, detailRendered);
        } else {
          results.push({ step: `${name}-detail`, rendered: false, ok: false, reason: 'no-detail-link' });
        }
      }
    }

    console.log(
      JSON.stringify(
        {
          ok: results.every((item) => item.ok),
          preview: PREVIEW,
          routeCount: ROUTES.length,
          results,
        },
        null,
        2,
      ),
    );
  } finally {
    chrome.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.log(JSON.stringify({ ok: false, reason: String(error?.message ?? error) }));
  process.exitCode = 1;
});
