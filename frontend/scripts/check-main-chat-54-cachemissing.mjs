#!/usr/bin/env node
/**
 * 真实浏览器回归（54 轮 · 第 5 项）：cacheMissing 的真实终态。
 *
 * 真实 2.2.20 协议（`server/resource/aiConversations.js` resumeStream）：缓存为空且服务端仍在生成
 * （`llmActiveState !== 'idle'`）时返回 `chunks_cache_missing`，界面语义是「在后台工作中 / 点击刷新」——
 * **不是**错误。服务端随后完成生成并落库，`llmActiveState` 变 idle；此时点刷新即可读到完整内容。
 *
 * 本脚本：发送 `[[nocache]]` → 刷新并重开会话 → 断言出现“后台工作中”横幅（不是假错误），
 * control 证据 `resumeStream(cacheMissing:true)`；等 control 变 idle 后点「点击」刷新，
 * 断言横幅消失并出现后台落库的完整内容。
 *
 * 用法：CREWLOOM_APP_URL=http://127.0.0.1:5350 CREWLOOM_CHAT_URL=http://127.0.0.1:5420 \
 *         node scripts/check-main-chat-54-cachemissing.mjs
 */

import {
  launchBrowser,
  goto,
  evaluate,
  typeInto,
  mouseClickSelector,
  sleep,
  waitFor,
} from './lib/cdp-browser.mjs';

const APP_URL = (process.env.CREWLOOM_APP_URL ?? 'http://127.0.0.1:5350').replace(/\/$/, '');
const CHAT_URL = (process.env.CREWLOOM_CHAT_URL ?? 'http://127.0.0.1:5420').replace(/\/$/, '');
const ACCOUNT = { email: 'zhangsan@fixture.local', password: 'fixture' };
const FRAME = '[data-testid="native-chatbox-frame"]';
const INPUT = `${FRAME} textarea.ant-sender-input`;

const results = [];
function check(name, ok, note = '') {
  results.push({ name, ok: Boolean(ok), note });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? ` — ${note}` : ''}`);
}
const reason = (error) => String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 200);

async function login(cdp) {
  await goto(cdp, `${APP_URL}/login`, 2500);
  const shown = await waitFor(cdp, `Boolean(document.querySelector('input[name="crewloom-account"]'))`, { timeoutMs: 25000 });
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

async function clickFrameButton(cdp, needle) {
  const index = await evaluate(
    cdp,
    `(() => {
      const list = [...document.querySelectorAll(${JSON.stringify(`${FRAME} button`)})];
      return list.findIndex((b) => [b.innerText || '', b.getAttribute('aria-label') || '', b.getAttribute('title') || ''].some((t) => t.includes(${JSON.stringify(needle)})));
    })()`,
  );
  if (index < 0) throw new Error(`找不到按钮：${needle}`);
  return mouseClickSelector(cdp, `${FRAME} button`, index, { settleMs: 700 });
}

const frameText = (cdp) =>
  evaluate(cdp, `(() => { const f = document.querySelector(${JSON.stringify(FRAME)}); return f ? f.innerText : ''; })()`);

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

async function controlState() {
  return (await fetch(`${CHAT_URL}/control/state`)).json();
}

async function main() {
  let browser = null;
  try {
    browser = await launchBrowser({ debugPort: 9457, width: 1440, height: 1000 });
  } catch (error) {
    check('0. headless Chrome 启动', false, reason(error));
    return;
  }
  const { cdp } = browser;
  try {
    await login(cdp);
    await goto(cdp, `${APP_URL}/ai/conversations`, 4500);
    const mounted = await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(FRAME)}))`, { timeoutMs: 25000 });
    check('0. 原生 ChatBox 挂载', mounted);
    if (!mounted) return;
    await sleep(1500);

    await clickFrameButton(cdp, '新建对话');
    await sleep(500);
    await sendMessage(cdp, '[[nocache]]');
    // 只等“消息已发出”，不要在断线/历史回填期间等第一段（那会吃掉后台窗口）。
    const sent = await waitFor(
      cdp,
      `(document.querySelector(${JSON.stringify(FRAME)}).innerText || '').includes('[[nocache]]')`,
      { timeoutMs: 8000 },
    );
    const sessionId = await currentSessionId(cdp);
    check('1. [[nocache]] 已发出并触发真断开', sent && Boolean(sessionId), `session=${sessionId}`);

    // 立刻刷新（真断开）再从会话列表重开：此时服务端仍在后台生成。
    await goto(cdp, `${APP_URL}/ai/conversations`, 2000);
    await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(FRAME)}))`, { timeoutMs: 25000 });
    await clickFrameButton(cdp, '会话列表');
    await waitFor(cdp, `document.querySelectorAll('li.ant-conversations-item').length > 0`, { timeoutMs: 15000 });
    const label = `受控会话 ${String(sessionId ?? '').replace('controlled-session-', '')}`;
    await mouseClickTextLike(cdp, label);
    // 真实语义：重开时仍在生成 → 显示“在后台工作中 / 点击刷新”（不是错误）。
    const banner = await waitFor(cdp, `(document.querySelector(${JSON.stringify(FRAME)}).innerText || '').includes('在后台工作中')`, {
      timeoutMs: 15000,
    });
    const text = await frameText(cdp);
    check('2. 重开后显示真实“后台工作中/点击刷新”语义（不是假缓存错误）', banner, text.replace(/\n/g, ' | ').slice(0, 160));
    check('3. 没有出现普通失败提示', !text.includes('操作没有完成'));

    const state = await controlState();
    const resume = (state.streamEvents ?? []).find((entry) => entry.kind === 'resumeStream' && entry.sessionId === sessionId);
    check(
      '4. control 证据：resumeStream(cacheMissing:true)，且服务端仍在生成',
      resume?.cacheMissing === true,
      JSON.stringify(resume ?? null),
    );

    // 等后台真实完成（streaming → idle + done），再点“点击”刷新读终态。
    let entry = null;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const control = await controlState();
      entry = (control.streams ?? []).find((item) => item.sessionId === sessionId) ?? null;
      if (entry?.llmActiveState === 'idle' && entry?.done === true) break;
      await sleep(300);
    }
    check('5. 后台生成完成：control 真实终态 idle + done（可轮询）', entry?.llmActiveState === 'idle' && entry?.done === true, JSON.stringify(entry ?? null));

    // 点横幅里的“点击”链接（refreshMessages）。
    const clicked = await evaluate(
      cdp,
      `(() => {
        const links = [...document.querySelectorAll('a')];
        const link = links.find((a) => (a.innerText || '').trim() === '点击');
        if (!link) return false;
        link.click();
        return true;
      })()`,
    );
    check('6. 找到并点击“点击”刷新入口', clicked === true);
    const finalText = await waitFor(
      cdp,
      `(document.querySelector(${JSON.stringify(FRAME)}).innerText || '').includes('后台生成已经完成')`,
      { timeoutMs: 15000 },
    ).then(() => frameText(cdp)).catch(() => frameText(cdp));
    check('7. 刷新后读到后台落库的完整内容', finalText.includes('后台生成已经完成'), finalText.replace(/\n/g, ' | ').slice(0, 160));
    check('8. loading 结算：横幅消失（不再停在后台工作中）', !finalText.includes('在后台工作中'));
  } catch (error) {
    check('运行异常', false, reason(error));
  } finally {
    browser.close();
  }
}

/** 点击会话列表项（按文本包含）。 */
async function mouseClickTextLike(cdp, label) {
  const index = await evaluate(
    cdp,
    `(() => {
      const list = [...document.querySelectorAll('li.ant-conversations-item')];
      return list.findIndex((el) => (el.innerText || '').includes(${JSON.stringify(label)}));
    })()`,
  );
  if (index < 0) throw new Error(`找不到会话项：${label}`);
  return mouseClickSelector(cdp, 'li.ant-conversations-item', index, { settleMs: 700 });
}

await main();
const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
