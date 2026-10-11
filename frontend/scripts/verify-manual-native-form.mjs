#!/usr/bin/env node
/**
 * TD-02 人工表单（真实 Formily 宿主）浏览器核对。
 *
 * 两种模式：
 *  - `controlled`（缺省）：所有 `/api/*` 在 CDP 网络层由本机受控应答，真实后端 0 请求。
 *    在产品**真实页面**（`/tasks/manual?id=…`）上验证 Formily schema 的非空交互：
 *    嵌套布局、必填校验、数字/日期类型、`x-reactions` 显隐与赋值、关联选择（走 `users:list`）、
 *    `{result:{formKey,_}}` 提交形状；并产出桌面 + 窄屏截图（可分享）。
 *  - `real`：真实 13000 正常登录 + 只读导航（凭据只在进程内存读取，不进 argv/env/日志/截图）。
 *    13000 上人工待办为 0 条，因此只核对"真实服务照实显示的只读状态"，并如实记录。
 *
 * 用法：
 *   CREWLOOM_PREVIEW_URL=http://127.0.0.1:5293 node scripts/verify-manual-native-form.mjs
 *   CREWLOOM_MANUAL_MODE=real CREWLOOM_PREVIEW_URL=http://127.0.0.1:5293 \
 *     node scripts/verify-manual-native-form.mjs
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureState, json, respondFixture } from './lib/manual-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const worktreeRoot = resolve(here, '..', '..');
const ROOT_REPO = '/Users/chenming/IdeaProjects/crewloom';
const SECRET_PATH = join(ROOT_REPO, '.secrets/full-pages-13000-20261011.json');
const BASE_URL = process.env.CREWLOOM_PREVIEW_URL ?? 'http://127.0.0.1:5293';
const MODE = process.env.CREWLOOM_MANUAL_MODE === 'real' ? 'real' : 'controlled';
const OUT_DIR =
  MODE === 'real'
    ? process.env.CREWLOOM_MANUAL_SHOT_DIR ?? join(worktreeRoot, 'frontend/.shots/manual-native-real')
    : process.env.CREWLOOM_MANUAL_SHOT_DIR ??
      join(worktreeRoot, 'docs/acceptance/full-pages-13000/manual-native-evidence');
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT ?? 9363);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function record(name, ok, note) {
  results.push({ name, ok, note: note ?? '' });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? ` — ${note}` : ''}`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.sessionId = null;
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else res(msg.result);
        return;
      }
      if (msg.method && this.handlers.has(msg.method)) {
        for (const handler of this.handlers.get(msg.method)) handler(msg.params);
      }
    });
  }

  on(method, handler) {
    const list = this.handlers.get(method) ?? [];
    list.push(handler);
    this.handlers.set(method, list);
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
    await sleep(250);
  }
  throw new Error('Chrome 调试端口未就绪');
}

/* ------------------------------------------------------------------ *
 * 受控数据
 *
 * 数据与应答逻辑现在只有一份，放在 `scripts/lib/manual-fixture.mjs`：
 * 本脚本（CI 核对，28 条断言）与 `scripts/manual-fixture-server.mjs`
 * （本机验收环境，Vite 的 /api 代理指向它）共用，避免两处各写一份后失配。
 * 这里用 `unknownPolicy: 'empty'`（与原内联实现逐字一致），
 * 验收环境那份用 `acceptanceUi: true` + `unknownPolicy: 'error'`。
 * ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const secrets =
    MODE === 'real' ? JSON.parse(readFileSync(SECRET_PATH, 'utf8')) : null;
  if (MODE === 'real' && (typeof secrets?.email !== 'string' || typeof secrets?.password !== 'string')) {
    throw new Error('真实凭据读取失败（缺 email/password）');
  }

  const profileDir = mkdtempSync(join(tmpdir(), 'crewloom-manual-'));
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
  const captured = { submitPostData: null, intercepted: [], conversations: [] };
  /** CI 核对用的 fixture 状态（`acceptanceUi:false` → 应答与原内联实现逐字一致）。 */
  const fixtureState = createFixtureState();
  /** 标签页可见性保护的状态（headless 下 Chrome 会把空闲标签页置为 hidden，见 ensureRendered）。 */
  const visibility = { timer: null, reasserts: 0, final: 'unknown' };
  try {
    const versionInfo = await waitForDevtools(DEBUG_PORT);
    const ws = new WebSocket(versionInfo.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('CDP 连接超时')), 20000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        res();
      }, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
    });
    cdp = new Cdp(ws);
    /**
     * 核对必须跑在**前台可见**的标签页上。
     *
     * 实测（`visibilitychange` 记录）：headless 窗口里的标签页会被 Chrome 置为 `hidden`
     * （另开标签页时约在页面加载后 2.7s；即便挂到启动时那个 active 页面，置前后也会被再次
     * 置为 hidden）。`hidden` 页面会暂停 `requestAnimationFrame` 与 `ResizeObserver` 投递，
     * 于是依赖尺寸测量的真实组件（antd Select 的 `maxTagCount="responsive"` → rc-overflow）
     * 拿不到容器宽度，已选关联项就不会渲染成可见标签 —— 那是"看不见的标签页"，不是产品行为。
     *
     * 因此这里：① 挂到 Chrome 启动时的 active 页面（而不是另开标签页）；② 用
     * `startVisibilityGuard()` 在被置为 hidden 时立刻置前；③ 在需要读 UI 的地方用
     * `ensureRendered()` 等到 `requestAnimationFrame` 真的有节拍。
     */
    const { targetInfos } = await cdp.send('Target.getTargets');
    const activePage = (targetInfos ?? []).find((info) => info.type === 'page');
    const targetId = activePage?.targetId ?? (await cdp.send('Target.createTarget', { url: 'about:blank' })).targetId;
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    cdp.sessionId = sessionId;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Page.bringToFront');

    if (MODE === 'controlled') {
      // 在页面脚本之前注入受控会话（token 由本机 mock 校验）。
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `localStorage.setItem('crewloom.session.token','controlled-mock-token');localStorage.setItem('crewloom.session.auth','basic');`,
      });
      cdp.on('Fetch.requestPaused', (params) => {
        const { requestId, request } = params;
        const actionPath = new URL(request.url).pathname.replace(/^\/api\//, '');
        captured.intercepted.push(`${request.method} ${actionPath}`);
        if (actionPath.startsWith('workflowManualTasks:submit')) captured.submitPostData = request.postData ?? null;
        const { code, body } = respondFixture({ method: request.method, url: request.url, headers: request.headers }, fixtureState, captured);
        cdp
          .send('Fetch.fulfillRequest', {
            requestId,
            responseCode: code,
            responseHeaders: [
              { name: 'content-type', value: 'application/json' },
              { name: 'x-crewloom-mock', value: '1' },
            ],
            body: json(body),
          })
          .catch(() => {});
      });
      await cdp.send('Fetch.enable', {
        patterns: [{ urlPattern: `${new URL(BASE_URL).origin}/api/*`, requestStage: 'Request' }],
      });
    }

    const evaluate = async (expression) => {
      const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(`页面脚本异常：${result.exceptionDetails.text}`);
      return result.result.value;
    };
    const shot = async (name, beyondViewport = false) => {
      // 截图同样要求标签页可见并在渲染（hidden 页面截出来不是用户看到的画面）。
      await ensureRendered();
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: beyondViewport });
      writeFileSync(join(OUT_DIR, name), Buffer.from(data, 'base64'));
    };
    const setViewport = async (width, height, mobile) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: Boolean(mobile) });
    };
    const goto = async (path) => {
      await cdp.send('Page.navigate', { url: `${BASE_URL}${path}` });
      await sleep(2500);
      // Chrome（headless=new）会在窗口被判定为不可见后把标签页置为 hidden，并暂停
      // requestAnimationFrame 与 ResizeObserver 投递。核对依赖真实渲染（例如真实 antd Select
      // 的 maxTagCount="responsive" 需要 rc-overflow 量到容器宽度才会渲染已选标签），
      // 因此每次导航后显式把该标签页置前，让它像用户正在看的页面一样持续渲染。
      await cdp.send('Page.bringToFront');
      await sleep(250);
    };
    /**
     * 把被测标签页置前，并等到它**真的在渲染**（`requestAnimationFrame` 有节拍）。
     *
     * 为什么必须这样：Chrome（headless=new）会在窗口被判定为不可见后把标签页置为
     * `hidden`，`hidden` 页面会暂停 `requestAnimationFrame` 与 `ResizeObserver` 投递。
     * 真实组件里依赖尺寸测量的部分（antd Select 的 `maxTagCount="responsive"` →
     * rc-overflow 需要量到容器宽度）在不可见标签页里就永远不渲染已选标签 ——
     * 那是"看不见的标签页"，不是产品行为。核对要和真实使用者一致：页面可见、在渲染。
     */
    const ensureRendered = async () => {
      await cdp.send('Page.bringToFront');
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const painted = await evaluate(`new Promise((resolve) => {
          let done = false;
          requestAnimationFrame(() => { done = true; resolve(document.visibilityState); });
          setTimeout(() => { if (!done) resolve('raf-timeout'); }, 300);
        })`);
        if (painted === 'visible') return true;
        await sleep(200);
      }
      return false;
    };
    // 整个核对过程保持标签页可见：被 Chrome 置为 hidden 时立刻置前。
    const startVisibilityGuard = () => {
      if (visibility.timer) return;
      visibility.timer = setInterval(() => {
        evaluate('document.visibilityState')
          .then((state) => {
            if (state !== 'visible') {
              visibility.reasserts += 1;
              return cdp.send('Page.bringToFront');
            }
            return undefined;
          })
          .catch(() => {
            /* 导航瞬间 evaluate 可能失败，下一拍再试 */
          });
      }, 500);
      visibility.timer.unref?.();
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
        await sleep(20);
      }
      return true;
    };
    const setInputValue = async (selector, value) => evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    // 真实 NocoBase 组件的 label 在 FormItem 上（不是 input 的 aria-label），
    // 因此按"字段标题"定位同一 `.ant-formily-item`，再取其中的控件。
    const itemSelector = (label) => `(() => {
      const items = [...document.querySelectorAll('.ant-formily-item')];
      return items.find((item) => ((item.querySelector('.ant-formily-item-label') || {}).textContent || '').includes(${JSON.stringify(label)})) || null;
    })()`;
    const selectByLabel = async (label) => evaluate(`(() => {
      const item = ${itemSelector(label)};
      const selector = item && item.querySelector('.ant-select-selector');
      if (!selector) return false;
      for (const type of ['mousedown', 'mouseup', 'click']) selector.dispatchEvent(new MouseEvent(type, { bubbles: true }));
      return true;
    })()`);
    const inputValueOfLabel = async (label) => evaluate(`(() => {
      const item = ${itemSelector(label)};
      const input = item && item.querySelector('input, textarea');
      return input ? input.value : null;
    })()`);
    const typeIntoLabel = async (label, value) => evaluate(`(() => {
      const item = ${itemSelector(label)};
      const el = item && item.querySelector('input, textarea');
      if (!el) return false;
      el.focus();
      return true;
    })()`) && typeInto(`.ant-formily-item:has(.ant-formily-item-label) input`, value);

    const openSelect = async (ariaLabel) => evaluate(`(() => {
      const input = document.querySelector('[aria-label=${JSON.stringify(ariaLabel)}]');
      if (!input) return false;
      const selector = input.closest('.ant-select')?.querySelector('.ant-select-selector') ?? input;
      for (const type of ['mousedown', 'mouseup', 'click']) {
        selector.dispatchEvent(new MouseEvent(type, { bubbles: true }));
      }
      return true;
    })()`);
    const clickOption = async (text) => evaluate(`(() => {
      const option = [...document.querySelectorAll('.ant-select-item-option')].find((o) => (o.textContent || '').includes(${JSON.stringify(text)}));
      if (!option) return false;
      for (const type of ['mousedown', 'mouseup', 'click']) {
        option.dispatchEvent(new MouseEvent(type, { bubbles: true }));
      }
      return true;
    })()`);
    const pageText = async () => (await evaluate('document.body.innerText || ""')).replace(/\s+/g, ' ');
    const waitForText = async (needle, timeoutMs = 20000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const text = await pageText();
        if (text.includes(needle)) return true;
        await sleep(250);
      }
      return false;
    };

    const logs = [];
    cdp.on('Runtime.exceptionThrown', (params) => {
      logs.push(`[exception] ${params.exceptionDetails.text} ${params.exceptionDetails.exception?.description ?? ''}`);
    });
    cdp.on('Runtime.consoleAPICalled', (params) => {
      const text = params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      if (params.type === 'error' || text.includes('[crewloom]')) {
        logs.push(`[console.${params.type}] ${text}`);
      }
    });

    if (MODE === 'controlled') {
      await setViewport(1440, 1000, false);
      await goto('/tasks/manual?id=7');
      startVisibilityGuard();
      if (process.env.CREWLOOM_MANUAL_DUMP === '1') {
        const dump = await evaluate(`(() => ({
          text: document.body.innerText,
          html: document.getElementById('root')?.innerHTML ?? '',
          controls: [...document.querySelectorAll('input, button, .ant-select')].slice(0, 40).map((el) => ({
            tag: el.tagName,
            cls: String(el.className).slice(0, 60),
            aria: el.getAttribute('aria-label'),
            text: (el.textContent || '').slice(0, 20),
          })),
          probe: (() => { const el = document.querySelector('[data-testid=probe-form-ctx]'); return el ? el.getAttribute('data-hasform') : 'missing'; })(),
          probeCount: document.querySelectorAll('[data-testid=probe-form-ctx]').length,
          inlineCount: document.querySelectorAll('[data-testid=probe-inline-ctx]').length,
          hostCount: document.querySelectorAll('[data-testid=probe-host]').length,
          domPath: (() => {
            const target = document.querySelector('.ant-input-number');
            const chain = [];
            let el = target;
            while (el && el.id !== 'root') {
              chain.push(el.tagName + (el.className ? '.' + String(el.className).split(' ').slice(0, 2).join('.') : '') + (el.getAttribute('data-testid') ? '[' + el.getAttribute('data-testid') + ']' : '') + (el.getAttribute('data-probe') ? '{' + el.getAttribute('data-probe') + '}' : ''));
              el = el.parentElement;
            }
            return chain.reverse();
          })(),
          markerCounts: Object.fromEntries(['probe-host','probe-inline-ctx','probe-in-record','probe-in-div','probe-after-blockctx','probe-form-ctx'].map((id) => [id, document.querySelectorAll('[data-testid=' + id + ']').length])),
          htmlHasProbe: (document.getElementById('root')?.innerHTML || '').includes('probe-form-ctx'),
          testids: [...document.querySelectorAll('[data-testid]')].map((el) => el.getAttribute('data-testid')).slice(0, 20),
          selectors: {
            number: Boolean(document.querySelector('.ant-input-number-input')),
            date: Boolean(document.querySelector('.ant-picker-input input')),
            dateNative: Boolean(document.querySelector('input[type=date]')),
            checkbox: Boolean(document.querySelector('.ant-checkbox-input')),
            formilyItem: Boolean(document.querySelector('.ant-formily-item')),
            grid: Boolean(document.querySelector('.nb-grid-container')),
          },
        }))()`);
        writeFileSync(join(OUT_DIR, 'manual-native-dump.json'), `${JSON.stringify(dump, null, 2)}\n`);
        console.log('DUMP_TEXT:', dump.text.replace(/\s+/g, ' ').slice(0, 600));
        console.log('DUMP_SELECTORS:', JSON.stringify(dump.selectors));
      }
      const rendered = await waitForText('报销金额');
      record('受控页面渲染出 schema 字段（真实 Formily + 真实 antd 组件）', rendered, (await pageText()).slice(0, 160));

      const domProbe = await evaluate(`(() => ({
        hasNumber: Boolean(document.querySelector('.ant-input-number-input')),
        hasDate: Boolean(document.querySelector('.ant-picker-input input')),
        hasAction: [...document.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === '通过'),
        hasReason: (document.body.innerText || '').includes('加急原因'),
      }))()`);
      record('数字字段是 antd InputNumber', domProbe.hasNumber);
      record('日期字段是真实 antd DatePicker', domProbe.hasDate);
      record('schema 的 ActionBar 渲染出处理按钮', domProbe.hasAction);

      // 必填校验（真实 Formily validate）
      await evaluate(`(() => { const b=document.querySelector('[aria-label="action-Action-通过"]') || [...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='通过'); b&&b.click(); return true; })()`);
      const requiredShown = await (async () => {
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          const message = await evaluate(`(() => {
            const help = [...document.querySelectorAll('.ant-formily-item-error-help, .ant-formily-item-error')].map((el) => el.textContent || '').join(' | ');
            const body = document.body.innerText || '';
            const lines = body.split('\\n').filter((line) => line.includes('报销金额') || /required|请填写/.test(line));
            return help + ' || ' + lines.join(' | ');
          })()`);
          if (message && (message.includes('报销金额') || message.includes('请填写'))) {
            console.log('REQUIRED_MESSAGE:', message.slice(0, 200));
            return true;
          }
          await sleep(200);
        }
        return false;
      })();
      record('必填未填时真实 Formily/FormItem 拦住提交并给出字段级提示', requiredShown);
      record(
        '必填校验期间没有发出 submit 请求',
        !captured.intercepted.some((entry) => entry.includes('workflowManualTasks:submit')),
      );

      // x-reactions 显隐
      record('未勾选时 x-reactions 隐藏"加急原因"', !domProbe.hasReason);
      await evaluate(`(() => { const el=document.querySelector('input[type="checkbox"]'); el&&el.click(); return true; })()`);
      const reasonShown = await waitForText('加急原因', 8000);
      record('勾选后 x-reactions 显示"加急原因"', reasonShown);

      // 填值：数字 + 日期 + 加急原因
      await typeInto('.ant-input-number-input', '256');
      await setInputValue('.ant-picker-input input', '2026-10-11');
      // 真实 DatePicker 需要确认（回车）才把值写进表单。
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      await sleep(300);
      await evaluate(`(() => {
        const items = [...document.querySelectorAll('.ant-formily-item')];
        const item = items.find((i) => ((i.querySelector('.ant-formily-item-label') || {}).textContent || '').includes('加急原因'));
        const el = item && item.querySelector('input, textarea');
        if (!el) return false;
        el.focus();
        return true;
      })()`);
      await typeInto('.ant-input', '客户催办');
      await sleep(200);

      // 关联选项（走 users:list）和 x-reactions 赋值
      await selectByLabel('类别');
      await sleep(600);
      await clickOption('差旅');
      const codeFilled = await (async () => {
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          const value = await inputValueOfLabel('报销编号');
          if (value === 'T-100') return true;
          await sleep(200);
        }
        return false;
      })();
      record('x-reactions.fulfill.state.value 按依赖字段联动赋值', codeFilled);

      // 关联字段（真实 AssociationField，m2m）：候选值来自 target collection，
      // 选择后提交必须是真实引用（数组），不是被拼成字符串。
      await ensureRendered();
      await selectByLabel('会签人');
      await sleep(900);
      const optionsShown = await waitForText('张三', 8000);
      record(
        '关联字段候选值经真实 target collection 读取（users:list）',
        optionsShown && captured.intercepted.some((entry) => entry.includes('users:list')),
      );
      await clickOption('张三');
      await sleep(600);
      // 读最终 DOM 前确认标签页可见且真的在渲染（见 ensureRendered 的说明）：
      // 真实 antd Select 用 rc-overflow 量宽度后才渲染已选标签。
      await ensureRendered();
      await sleep(400);
      const associationDom = await evaluate(`(() => {
        const items = [...document.querySelectorAll('.ant-formily-item')];
        const item = items.find((i) => ((i.querySelector('.ant-formily-item-label') || {}).textContent || '').includes('会签人'));
        return item ? item.outerHTML.slice(0, 4000) : '';
      })()`);
      captured.associationDom = associationDom;
      const associationEcho = await evaluate(`(() => {
        const items = [...document.querySelectorAll('.ant-formily-item')];
        const item = items.find((i) => ((i.querySelector('.ant-formily-item-label') || {}).textContent || '').includes('会签人'));
        if (!item) return { tags: [], text: '' };
        return {
          tags: [...item.querySelectorAll('.ant-tag')].map((el) => ({
            aria: el.getAttribute('aria-label'),
            text: (el.textContent || '').trim(),
          })),
          text: (item.innerText || '').replace(/\\s+/g, ' ').trim(),
        };
      })()`);
      record(
        '关联字段选择后在表单里渲染真实选中标签',
        associationEcho.tags.some((tag) => (tag.text || '').includes('张三')) || associationEcho.text.includes('张三'),
        JSON.stringify(associationEcho).slice(0, 240),
      );

      await evaluate(`(() => {
        const card = [...document.querySelectorAll('section, div')].find((el) => (el.textContent || '').includes('处理表单') && el.querySelector('.ant-input-number-input'));
        (card ?? document.body).scrollIntoView({ block: 'start' });
        return true;
      })()`);
      await sleep(300);
      await shot('manual-form-controlled-desktop-1440.png');
      await setViewport(390, 844, true);
      await sleep(900);
      await evaluate(`(() => { window.scrollTo(0, 0); return true; })()`);
      await sleep(300);
      const narrow = await evaluate(`(() => {
        const viewportWidth = document.documentElement.clientWidth;
        const boxOf = (label) => {
          const items = [...document.querySelectorAll('.ant-formily-item')];
          const item = items.find((i) => ((i.querySelector('.ant-formily-item-label') || {}).textContent || '').includes(label));
          const control = item && (item.querySelector('.ant-input-number, .ant-select, .ant-picker, input, textarea') || item);
          if (!control) return null;
          const r = control.getBoundingClientRect();
          return { label, left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), height: Math.round(r.height) };
        };
        const action = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '通过');
        const actionRect = action ? action.getBoundingClientRect() : null;
        return {
          viewportWidth,
          scrollWidth: document.documentElement.scrollWidth,
          bodyScrollWidth: document.body.scrollWidth,
          controls: ['报销金额', '发生日期', '会签人', '类别'].map(boxOf).filter(Boolean),
          action: actionRect ? { left: Math.round(actionRect.left), right: Math.round(actionRect.right), width: Math.round(actionRect.width), height: Math.round(actionRect.height) } : null,
          datePickerLocale: (() => {
            const panel = document.querySelector('.ant-picker-dropdown');
            return panel ? (panel.textContent || '').replace(/\s+/g, ' ').slice(0, 120) : null;
          })(),
          // 浮层（日期/下拉/提示）是 portal 弹层，不算页面内容溢出；这里只找内容元素。
          overflowing: [...document.querySelectorAll('body *')]
            .filter((el) => !el.closest('.ant-picker-dropdown, .ant-select-dropdown, .ant-tooltip, .ant-dropdown, .ant-modal-root'))
            .map((el) => { const r = el.getBoundingClientRect(); return { tag: el.tagName, cls: String(el.className).slice(0, 50), right: Math.round(r.right), width: Math.round(r.width) }; })
            .filter((entry) => entry.right > viewportWidth + 1 && entry.width > 0)
            .slice(0, 12),
        };
      })()`);
      captured.narrow = narrow;
      const inViewport = (box) => box && box.width > 0 && box.height > 0 && box.left >= 0 && box.right <= narrow.viewportWidth + 1;
      record(
        '390px：页面内容没有横向溢出（不含浮层）',
        narrow.bodyScrollWidth <= narrow.viewportWidth + 1 &&
          (narrow.overflowing || []).length === 0,
        `viewport=${narrow.viewportWidth} bodyScrollWidth=${narrow.bodyScrollWidth} overflowing=${(narrow.overflowing || []).length}`,
      );
      record(
        '390px：字段控件都在视口内且可点击',
        narrow.controls.length >= 4 && narrow.controls.every(inViewport),
        JSON.stringify(narrow.controls),
      );
      record('390px：处理动作按钮在视口内', inViewport(narrow.action), JSON.stringify(narrow.action));
      // 真实点击：在窄屏宽度下清空并重新输入数字、勾选加急（不是只做 DOM 存在性判断）。
      await evaluate(`(() => {
        const el = document.querySelector('.ant-input-number-input');
        if (!el) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.focus();
        return true;
      })()`);
      await typeInto('.ant-input-number-input', '1024');
      await sleep(300);
      const narrowTyped = await evaluate(`(() => { const el=document.querySelector('.ant-input-number-input'); return el ? el.value : null; })()`);
      record('390px：真实输入生效（清空后重新键入）', narrowTyped === '1024', String(narrowTyped));
      // 复原成交付时使用 256，避免影响后续提交断言。
      await evaluate(`(() => {
        const el = document.querySelector('.ant-input-number-input');
        if (!el) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.focus();
        return true;
      })()`);
      await typeInto('.ant-input-number-input', '256');
      await sleep(300);
      await shot('manual-form-controlled-narrow-390.png', true);
      await setViewport(1440, 1000, false);
      await sleep(400);

      // 提交
      await evaluate(`(() => { const b=document.querySelector('[aria-label="action-Action-通过"]') || [...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='通过'); b&&b.click(); return true; })()`);
      const submitted = await (async () => {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          if (captured.submit) return true;
          await sleep(200);
        }
        return false;
      })();
      record('点击处理动作发出真实提交请求', submitted);
      const body = captured.submit ?? {};
      const result = body.result ?? {};
      const formValues = result.formA ?? {};
      record(
        '提交体是 {result:{formKey,_}}，_ 与 formKey 同级',
        Object.keys(body).length === 1 && result._ === 'approve' && Object.keys(result).sort().join(',') === '_,formA',
        JSON.stringify(body).slice(0, 200),
      );
      record(
        '提交值类型正确（数字 number / date-only 归一 YYYY-MM-DD / 类别与联动值 / 关联为真实引用数组）',
        formValues.amount === 256 &&
          // date-only 字段按服务端 collection field 契约（dateFormat）归一为 YYYY-MM-DD。
          formValues.spentAt === '2026-10-11' &&
          formValues.reason === '客户催办' &&
          formValues.category === 'travel' &&
          formValues.code === 'T-100' &&
          Array.isArray(formValues.reviewers) &&
          formValues.reviewers.length === 1 &&
          (formValues.reviewers[0] === 3 || formValues.reviewers[0]?.id === 3),
        JSON.stringify(formValues).slice(0, 240),
      );
      // 已处理任务：真实原生链的只读态（readPretty 文本 + 不可提交）
      await setViewport(1440, 1000, false);
      await goto('/tasks/manual?id=8');
      await waitForText('报销金额', 20000);
      const readonlyProbe = await evaluate(`(() => {
        const items = [...document.querySelectorAll('.ant-formily-item')];
        const valueOf = (label) => {
          const item = items.find((i) => ((i.querySelector('.ant-formily-item-label') || {}).textContent || '').includes(label));
          return item ? (item.innerText || '').replace(/\\s+/g, ' ').trim() : '';
        };
        return {
          text: document.body.innerText || '',
          amount: valueOf('报销金额'),
          spentAt: valueOf('发生日期'),
          category: valueOf('类别'),
          code: valueOf('报销编号'),
          reviewers: valueOf('会签人'),
          editableInputs: [...document.querySelectorAll('.ant-formily-item input')].map((el) => ({ cls: el.className, disabled: el.disabled, readonly: el.readOnly })),
          actions: [...document.querySelectorAll('button')]
            .filter((b) => (b.textContent || '').trim() === '通过')
            .map((b) => ({ disabled: b.disabled })),
          amountDom: (() => {
            const item = items.find((i) => ((i.querySelector('.ant-formily-item-label') || {}).textContent || '').includes('报销金额'));
            return item ? item.outerHTML.slice(0, 1200) : '';
          })(),
        };
      })()`);
      captured.readonlyProbe = readonlyProbe;
      record(
        '已处理任务：页面按"已处理/只读"呈现，不再提示重新填写',
        readonlyProbe.text.includes('已处理') && readonlyProbe.text.includes('这条待办已经处理过'),
      );
      record('已处理任务：保存的金额按 record.result[formKey] 回显', readonlyProbe.amount.includes('256'), readonlyProbe.amount.slice(0, 80));
      record('已处理任务：保存的日期回显', readonlyProbe.spentAt.length > 0 && /2026/.test(readonlyProbe.spentAt), readonlyProbe.spentAt.slice(0, 80));
      record('已处理任务：保存的类别回显', readonlyProbe.category.includes('差旅'), readonlyProbe.category.slice(0, 80));
      record('已处理任务：x-reactions 联动值回显', readonlyProbe.code.includes('T-100'), readonlyProbe.code.slice(0, 80));
      record('已处理任务：关联选择只读回显', readonlyProbe.reviewers.includes('张三'), readonlyProbe.reviewers.slice(0, 120));
      record(
        '已处理任务：原生 ManualActionStatusProvider 把处理动作置为禁用',
        readonlyProbe.actions.length > 0 && readonlyProbe.actions.every((entry) => entry.disabled),
        JSON.stringify(readonlyProbe.actions),
      );
      await shot('manual-form-readonly-desktop-1440.png');
      await goto('/tasks/manual?id=7');
      await waitForText('报销金额', 20000);

      // 409 并发冲突：真实原生链提交 → 服务端 409 → 页面保留用户输入并给出中文提示（不显示内部错误）。
      await setViewport(1440, 1000, false);
      await goto('/tasks/manual?id=9');
      await waitForText('报销金额', 20000);
      await typeInto('.ant-input-number-input', '256');
      await evaluate(`(() => { const b=document.querySelector('[aria-label="action-Action-通过"]') || [...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='通过'); b&&b.click(); return true; })()`);
      const conflictShown = await waitForText('正在被其他人处理', 10000);
      record('409 冲突：真实提交被服务端拒绝', Boolean(captured.conflictSubmit), JSON.stringify(captured.conflictSubmit ?? {}).slice(0, 120));
      record('409 冲突：页面给出可恢复的中文提示（不显示内部报错）', conflictShown, (await pageText()).slice(-200));
      const conflictText = await pageText();
      record(
        '409 冲突：界面没有暴露技术报错',
        !/Lock acquire|409|TypeError|Error:/i.test(conflictText),
        conflictText.slice(-120),
      );
      // 回归断言：冲突不能把用户尚未提交的内容清空（此前 409 后自动 load 会用服务端初值重建表单）。
      const conflictAmount = await evaluate(`(() => { const el=document.querySelector('.ant-input-number-input'); return el ? el.value : null; })()`);
      record('409 冲突：尚未提交的输入被保留（金额仍在输入框）', conflictAmount === '256', String(conflictAmount));
      const conflictRefresh = await evaluate(`(() => [...document.querySelectorAll('button')].some((b) => (b.textContent || '').includes('刷新查看最新状态')))()`);
      record('409 冲突：提供显式"刷新查看最新状态"入口', conflictRefresh === true);
    } else {
      // 真实 13000：正常登录 + 只读导航
      await setViewport(1440, 1000, false);
      await sleep(3000);
      await goto('/login');
      startVisibilityGuard();
      await typeInto('input[type="text"], input[type="email"]', String(secrets.email));
      await typeInto('input[type="password"]', String(secrets.password));
      await evaluate(`(() => { const btn=[...document.querySelectorAll('button')].find(b=>/登录|登 录/.test(b.textContent||'')); btn&&btn.click(); return true; })()`);
      await sleep(4000);
      const path = await evaluate('location.pathname');
      record('真实 13000 正常登录成功（凭据只在内存）', path !== '/login', path);

      await goto('/tasks/pending');
      await sleep(1500);
      const pendingText = await pageText();
      record('真实待办列表只读呈现（13000 人工待办为 0 条）', pendingText.includes('待办') || pendingText.includes('人工'), pendingText.slice(0, 160));
      await shot('manual-tasks-real-13000-desktop-1440.png');

      await setViewport(390, 844, true);
      await sleep(600);
      await shot('manual-tasks-real-13000-narrow-390.png', true);
      await setViewport(1440, 1000, false);
    }

    try {
      visibility.final = await evaluate('document.visibilityState');
    } catch {
      visibility.final = 'unknown';
    }
    writeFileSync(
      join(OUT_DIR, MODE === 'real' ? 'manual-real-check.json' : 'manual-controlled-browser-check.json'),
      `${JSON.stringify(
        {
          mode: MODE,
          baseUrl: BASE_URL,
          at: new Date().toISOString(),
          // 证据：整轮核对驱动的是**可见且在渲染**的标签页（reasserts = 被 Chrome 置为
          // hidden 后重新置前的次数）；hidden 页面会暂停 rAF/ResizeObserver，不能用来核对 UI。
          visibility: { reasserts: visibility.reasserts, final: visibility.final },
          results,
          intercepted: MODE === 'controlled' ? captured.intercepted : undefined,
          submitBody: MODE === 'controlled' ? captured.submit : undefined,
          associationDom: MODE === 'controlled' ? captured.associationDom : undefined,
          readonlyProbe: MODE === 'controlled' ? captured.readonlyProbe : undefined,
          narrow: MODE === 'controlled' ? captured.narrow : undefined,
          conflictSubmit: MODE === 'controlled' ? captured.conflictSubmit : undefined,
          pageErrors: logs.slice(0, 120),
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    if (visibility.timer) {
      clearInterval(visibility.timer);
      visibility.timer = null;
    }
    try {
      if (cdp) await cdp.send('Browser.close');
    } catch {
      /* 忽略 */
    }
    chrome.kill('SIGTERM');
    try {
      rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Chrome 退出时 profile 目录可能仍在收尾，清理失败不影响核对结论 */
    }
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${MODE} 结果：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) {
    console.log(`失败项：${failed.map((item) => item.name).join('; ')}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`核对脚本异常：${error.message}`);
  process.exitCode = 1;
});
