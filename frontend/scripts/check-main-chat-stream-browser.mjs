#!/usr/bin/env node
/**
 * 真实浏览器回归：Main 实测的聊天流缺陷（drop / 主动停止 / cacheReplay）在产品页面上的表现。
 *
 * 只打本机受控环境（默认 5338 → 5416），不外呼、不改 window flag、不注入 localStorage：
 * 走真实登录页、真实原生 ChatBox 输入与真实键盘/鼠标。
 *
 * 用法：
 *   CREWLOOM_APP_URL=http://127.0.0.1:5338 CREWLOOM_CHAT_URL=http://127.0.0.1:5416 \
 *     node scripts/check-main-chat-stream-browser.mjs
 *
 * 退出码 0 = 全部通过。
 */

import {
  launchBrowser,
  goto,
  evaluate,
  typeInto,
  mouseClickSelector,
  mouseClickText,
  sleep,
  waitFor,
} from './lib/cdp-browser.mjs';

const APP_URL = (process.env.CREWLOOM_APP_URL ?? 'http://127.0.0.1:5338').replace(/\/$/, '');
const CHAT_URL = (process.env.CREWLOOM_CHAT_URL ?? 'http://127.0.0.1:5416').replace(/\/$/, '');
const ACCOUNT = { email: 'zhangsan@fixture.local', password: 'fixture' };
const FRAME = '[data-testid="native-chatbox-frame"]';
const INPUT = `${FRAME} textarea.ant-sender-input`;
const STOP_BUTTON = `${FRAME} .ant-sender-actions-btn-loading-button`;

const results = [];
function check(name, ok, note = '') {
  results.push({ name, ok: Boolean(ok), note });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? ` — ${note}` : ''}`);
}
const reason = (error) => String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 200);

async function login(cdp) {
  await goto(cdp, `${APP_URL}/login`, 2500);
  const shown = await waitFor(cdp, `Boolean(document.querySelector('input[name="crewloom-account"]'))`, {
    timeoutMs: 25000,
  });
  if (!shown) throw new Error('登录页没有出现账号输入框');
  await sleep(400);
  await typeInto(cdp, 'input[name="crewloom-account"]', ACCOUNT.email);
  await typeInto(cdp, 'input[name="crewloom-secret"]', ACCOUNT.password);
  await mouseClickSelector(cdp, 'button[type="submit"]');
  const arrived = await waitFor(cdp, `location.pathname === '/workbench'`, { timeoutMs: 25000 });
  if (!arrived) throw new Error(`登录后未到达 /workbench（当前 ${await evaluate(cdp, 'location.pathname')}）`);
}

async function pressEnter(cdp) {
  for (const type of ['keyDown', 'char', 'keyUp']) {
    // eslint-disable-next-line no-await-in-loop -- 三段必须按顺序派发才是真实回车
    await cdp.send('Input.dispatchKeyEvent', {
      type,
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      key: 'Enter',
      code: 'Enter',
      text: '\r',
      unmodifiedText: '\r',
    });
  }
}

async function sendMessage(cdp, text) {
  await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(INPUT)}))`, { timeoutMs: 20000 });
  await typeInto(cdp, INPUT, text);
  await sleep(200);
  await pressEnter(cdp);
}

/** 真实点击框架内的按钮：文本 / aria-label / title 任一命中（原生按钮多为图标 + 无障碍名）。 */
async function clickFrameButton(cdp, needle) {
  const index = await evaluate(
    cdp,
    `(() => {
      const list = [...document.querySelectorAll(${JSON.stringify(`${FRAME} button`)})];
      return list.findIndex((b) => [b.innerText || '', b.getAttribute('aria-label') || '', b.getAttribute('title') || ''].some((t) => t.includes(${JSON.stringify(needle)})));
    })()`,
  );
  if (index < 0) throw new Error(`找不到按钮：${needle}`);
  return mouseClickSelector(cdp, `${FRAME} button`, index, { settleMs: 900 });
}

/** 真实点击「新建对话」：让消息区清空，避免沿用上一条消息的文本造成假等待。 */
async function startNewConversation(cdp) {
  await clickFrameButton(cdp, '新建对话');
  await sleep(600);
}

const frameText = (cdp) =>
  evaluate(cdp, `(() => { const f = document.querySelector(${JSON.stringify(FRAME)}); return f ? f.innerText : ''; })()`);

/** 只读诊断：原生 ChatBox 当前会话 id（产品代码暴露的只读入口，不是注入状态）。 */
async function currentSessionId(cdp) {
  return evaluate(
    cdp,
    `(() => {
      const d = window.__CREWLOOM_NATIVE_AI__;
      const s = d && typeof d.describe === 'function' ? d.describe() : null;
      return (s && s.toolCallState && s.toolCallState.sessionId) || null;
    })()`,
  );
}

async function controlSessions() {
  const response = await fetch(`${CHAT_URL}/control/state`);
  const payload = await response.json();
  return payload.streams ?? [];
}

async function streamEntry(sessionId) {
  if (!sessionId) return null;
  return (await controlSessions()).find((item) => item.sessionId === sessionId) ?? null;
}

async function main() {
  let browser = null;
  try {
    browser = await launchBrowser({ debugPort: 9432, width: 1440, height: 1000 });
  } catch (error) {
    check('0. headless Chrome 启动', false, reason(error));
    return;
  }
  const { cdp } = browser;
  try {
    await login(cdp);
    await goto(cdp, `${APP_URL}/ai/conversations`, 4500);
    const mounted = await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(FRAME)}))`, {
      timeoutMs: 25000,
    });
    check('0. 原生 ChatBox 挂载（真实产品页面）', mounted);
    if (!mounted) return;
    await sleep(2500);

    // 1. [[drop]]：真断线后必须收敛，并给出中文断线说明 + 保留已收到内容。
    {
      await sendMessage(cdp, '[[drop]]');
      let noteSeen = false;
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        const text = await frameText(cdp);
        if (text.includes('连接中断')) {
          noteSeen = true;
          break;
        }
        await sleep(400);
      }
      const text = await frameText(cdp);
      check('1a. [[drop]] 后出现中文断线说明（不再一直停在“正在生成”）', noteSeen, text.slice(-160).replace(/\n/g, ' '));
      check('1b. [[drop]] 已收到的内容保留', text.includes('受控断线前的内容'));
      const entry = await streamEntry(await currentSessionId(cdp));
      check(
        '1c. 控制页里该会话状态收敛为 idle',
        entry?.llmActiveState === 'idle',
        JSON.stringify(entry && [entry.sessionId, entry.llmActiveState]),
      );
    }

    // 2. [[slow]] + 真实点击“停止”：正常终态、保留部分内容、不出现普通失败提示。
    {
      await startNewConversation(cdp);
      await sendMessage(cdp, '[[slow]]');
      const started = await waitFor(cdp, `document.querySelector(${JSON.stringify(FRAME)}).innerText.includes('第 1 段')`, {
        timeoutMs: 15000,
      });
      const sessionId = await currentSessionId(cdp);
      check('2a. [[slow]] 开始流式输出', started);
      if (started) {
        await sleep(600);
        await mouseClickSelector(cdp, STOP_BUTTON, 0, { settleMs: 200 });
        // 等停止后的历史回填与结算。
        await sleep(4000);
        const text = await frameText(cdp);
        check('2b. 主动停止后没有普通失败提示（“操作没有完成”）', !text.includes('操作没有完成'), text.slice(-160).replace(/\n/g, ' '));
        check('2c. 主动停止后已收到的部分内容仍然保留', text.includes('第 1 段'));
        const loadingGone = !(await evaluate(cdp, `Boolean(document.querySelector(${JSON.stringify(STOP_BUTTON)}))`));
        check('2d. 主动停止后没有残留的“停止”按钮（loading 已结算）', loadingGone);
        const entry = await streamEntry(sessionId);
        check(
          '2e. 控制页证据：该会话已停止且只生成了部分分段（不是完整 40 段）',
          entry?.llmActiveState === 'idle' && entry.total === 40 && entry.emitted > 0 && entry.emitted < 40,
          JSON.stringify(entry && [entry.sessionId, entry.llmActiveState, `${entry.emitted}/${entry.total}`]),
        );
      }
    }

    // 3. cacheReplay：[[slow]] 生成中刷新页面，再点回该会话，从缓存续上剩余分段。
    {
      await startNewConversation(cdp);
      await sendMessage(cdp, '[[slow]]');
      await waitFor(cdp, `document.querySelector(${JSON.stringify(FRAME)}).innerText.includes('第 1 段')`, {
        timeoutMs: 15000,
      });
      const sessionId = await currentSessionId(cdp);
      await sleep(500);
      // 整页刷新会真正断开连接：服务端保留缓存并保持 streaming。
      await goto(cdp, `${APP_URL}/ai/conversations`, 4500);
      await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(FRAME)}))`, { timeoutMs: 25000 });
      const listButtonSelector = `${FRAME} button`;
      const listButtonExpr = `Boolean([...document.querySelectorAll(${JSON.stringify(listButtonSelector)})].find((b) => [b.innerText || '', b.getAttribute('aria-label') || '', b.getAttribute('title') || ''].some((t) => t.includes('会话列表'))))`;
      check('3a. 刷新后仍能看到「会话列表」入口', await waitFor(cdp, listButtonExpr, { timeoutMs: 20000 }));
      await clickFrameButton(cdp, '会话列表');
      await waitFor(cdp, `document.querySelectorAll('li.ant-conversations-item').length > 0`, { timeoutMs: 15000 });
      const label = `受控会话 ${String(sessionId ?? '').replace('controlled-session-', '')}`;
      await mouseClickText(cdp, 'li.ant-conversations-item', label, { settleMs: 600 });
      // 重开会话后原生应自动 resumeStream；等它把剩余分段续完并落库。
      let entry = null;
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline) {
        entry = await streamEntry(sessionId);
        if (entry?.done === true && entry.total === 40) break;
        await sleep(500);
      }
      check(
        '3b. cacheReplay：重开会话把剩余分段续完并落库（状态 idle）',
        entry?.done === true && entry.total === 40 && entry.llmActiveState === 'idle',
        JSON.stringify(entry && [entry.sessionId, entry.llmActiveState, `${entry.emitted}/${entry.total}`, entry.done]),
      );
    }
  } catch (error) {
    check('运行异常', false, reason(error));
  } finally {
    browser.close();
  }
}

await main();
const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
