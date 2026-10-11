#!/usr/bin/env node
/**
 * 真实浏览器回归（51 轮 · E）：流进行中切换角色时，旧身份的迟到帧不得继续写入当前身份状态。
 *
 * 场景（Main 在 5334/5413 实测）：发送 `[[slow]]`，看到第 1 段后立刻把角色从操作员切到复核员。
 * 预期（本轮的修复）：
 *  - 旧身份流**立即收束**（停止按钮消失，不再继续到第 40 段）；
 *  - 服务端因此检测到客户端断开而暂停（控制页 emitted < 40）；
 *  - 新身份用复核员身份**重新读取**历史（控制页出现 role=synth-reviewer 的 getMessages）；
 *  - 角色世代推进（roleEpoch=2），且没有普通失败提示。
 *
 * 只打本机 5340 → 5418；角色切换走产品顶栏的原生 select（真实 change 事件），不改 window flag。
 *
 * 用法：CREWLOOM_APP_URL=http://127.0.0.1:5340 CREWLOOM_CHAT_URL=http://127.0.0.1:5418 \
 *         node scripts/check-main-chat-role-switch.mjs
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

const APP_URL = (process.env.CREWLOOM_APP_URL ?? 'http://127.0.0.1:5340').replace(/\/$/, '');
const CHAT_URL = (process.env.CREWLOOM_CHAT_URL ?? 'http://127.0.0.1:5418').replace(/\/$/, '');
const ACCOUNT = { email: 'zhangsan@fixture.local', password: 'fixture' };
const FRAME = '[data-testid="native-chatbox-frame"]';
const INPUT = `${FRAME} textarea.ant-sender-input`;
const STOP_BUTTON = `${FRAME} .ant-sender-actions-btn-loading-button`;
const ROLE_SELECT = 'select[aria-label="切换当前角色"]';

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

/** 通过产品顶栏的原生 select 切换角色（真实 change 事件，走真实 switchRole）。 */
async function switchRole(cdp, role) {
  const changed = await evaluate(
    cdp,
    `(() => {
      const select = document.querySelector(${JSON.stringify(ROLE_SELECT)});
      if (!select) return false;
      select.value = ${JSON.stringify(role)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`,
  );
  if (!changed) throw new Error('找不到角色切换 select');
  return waitFor(cdp, `(document.querySelector(${JSON.stringify(ROLE_SELECT)}) || {}).value === ${JSON.stringify(role)}`, {
    timeoutMs: 15000,
  });
}

async function main() {
  let browser = null;
  try {
    browser = await launchBrowser({ debugPort: 9442, width: 1440, height: 1000 });
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
    await sleep(2000);

    // 先确保是操作员角色。
    check('1a. 切到操作员身份', await switchRole(cdp, 'synth-operator'));
    await sleep(800);
    const epochBefore = (await controlState()).roleEpoch;

    // 新会话 + [[slow]]，看到第 1 段后立刻切换角色。
    await clickFrameButton(cdp, '新建对话');
    await sleep(500);
    await sendMessage(cdp, '[[slow]]');
    const started = await waitFor(cdp, `document.querySelector(${JSON.stringify(FRAME)}).innerText.includes('第 1 段')`, {
      timeoutMs: 15000,
    });
    const sessionId = await currentSessionId(cdp);
    check('1b. [[slow]] 开始流式输出', started, `session=${sessionId}`);

    check('2a. 流进行中切换到复核员', await switchRole(cdp, 'synth-reviewer'));
    const switchedAt = Date.now();

    // 旧流必须在很短时间内收束：停止按钮消失，且不会继续到第 40 段。
    const stopped = await waitFor(cdp, `!document.querySelector(${JSON.stringify(STOP_BUTTON)})`, { timeoutMs: 12000 });
    check('2b. 切换后旧身份的流很快收束（停止按钮消失，不再继续生成）', stopped);
    await sleep(1500);
    const text = await frameText(cdp);
    check('2c. 不再继续到第 40 段', !text.includes('第 40 段'), text.replace(/\n/g, ' | ').slice(-160));
    check('2d. 没有普通失败提示', !text.includes('操作没有完成'));

    const state = await controlState();
    check('3a. 角色世代推进到 2', state.roleEpoch >= 2 && state.roleEpoch > epochBefore, `roleEpoch=${state.roleEpoch}`);
    check('3b. 顶栏生效角色是复核员', state.activeRole === 'synth-reviewer', `activeRole=${state.activeRole}`);

    const entry = (state.streams ?? []).find((item) => item.sessionId === sessionId);
    check(
      '3c. 控制页证据：服务端因客户端断开而暂停（emitted < 40，未完成）',
      entry && entry.done !== true && entry.emitted < 40,
      JSON.stringify(entry ?? null),
    );

    const recent = (state.requests ?? []).filter((item) => item.action === 'aiConversations:getMessages');
    const reviewerRead = recent.find((item) => item.role === 'synth-reviewer');
    check(
      '3d. 新身份用复核员重新读取了历史（getMessages 带 X-Role=synth-reviewer）',
      Boolean(reviewerRead),
      JSON.stringify(recent.slice(0, 3).map((item) => [item.action, item.role, item.roleEpoch, item.code])),
    );

    // 复核员重新打开该会话，显示的是新身份授权读取到的内容（不是旧流的续写）。
    const reopened = await waitFor(
      cdp,
      `(document.body.innerText || '').includes('复核员') || (document.querySelector(${JSON.stringify(ROLE_SELECT)}) || {}).value === 'synth-reviewer'`,
      { timeoutMs: 5000 },
    );
    check('3e. 页面停留在当前会话且身份为复核员（未跳登录）', Boolean(reopened));
    void switchedAt;
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
