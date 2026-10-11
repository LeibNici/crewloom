#!/usr/bin/env node
/**
 * 真实浏览器回归（54 轮 · 第 7 项）：同一 runtime 内**重新选择同一工作区**应能再次带入首条消息。
 *
 * 场景（Main 在 5338/5416 实测）：已经在同一标签打开过聊天 → 到代码页保存代码 → 进会话看到卡片 →
 * 点「新建对话」清掉卡片（合理）→ 回代码页再次「保存为会话内容」→ 回聊天卡片却没回来；
 * 只有新开独立标签才正常。
 *
 * 关键：全程**站内导航**（不整页刷新），否则进程内的上下文选择会随页面重载丢失——
 * 那正是"只有新标签正常"的对照条件之一，不能把整页刷新当成产品路径。
 *
 * 用法：CREWLOOM_APP_URL=http://127.0.0.1:5350 CREWLOOM_CHAT_URL=http://127.0.0.1:5420 \
 *         node scripts/check-main-chat-context-reselect.mjs
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
const CODE_INPUT = '[data-testid="context-code-input"]';
const CODE_TEXT = 'const before = 1;';

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

async function clickButtonExact(cdp, label) {
  const index = await evaluate(
    cdp,
    `(() => {
      const list = [...document.querySelectorAll('button')];
      return list.findIndex((b) => (b.innerText || '').trim() === ${JSON.stringify(label)});
    })()`,
  );
  if (index < 0) throw new Error(`找不到按钮：${label}`);
  return mouseClickSelector(cdp, 'button', index, { settleMs: 600 });
}

async function clickAnchorExact(cdp, label) {
  const index = await evaluate(
    cdp,
    `(() => {
      const list = [...document.querySelectorAll('a')];
      return list.findIndex((a) => (a.innerText || '').trim() === ${JSON.stringify(label)});
    })()`,
  );
  if (index < 0) throw new Error(`找不到链接：${label}`);
  return mouseClickSelector(cdp, 'a', index, { settleMs: 900 });
}

const frameText = (cdp) =>
  evaluate(cdp, `(() => { const f = document.querySelector(${JSON.stringify(FRAME)}); return f ? f.innerText : ''; })()`);

/** 站内导航：会话页 → 数字员工模块页 → 任务与数据上下文。 */
async function goToContextInApp(cdp) {
  await clickAnchorExact(cdp, '数字员工');
  await waitFor(cdp, `location.pathname === '/ai'`, { timeoutMs: 10000 });
  const index = await evaluate(
    cdp,
    `(() => {
      const list = [...document.querySelectorAll('a')];
      return list.findIndex((a) => (a.getAttribute('href') || '') === '/ai/context');
    })()`,
  );
  if (index < 0) throw new Error('模块页没有 /ai/context 链接');
  await mouseClickSelector(cdp, 'a', index, { settleMs: 900 });
  const arrived = await waitFor(cdp, `location.pathname === '/ai/context'`, { timeoutMs: 10000 });
  if (!arrived) throw new Error('站内导航没有到达 /ai/context');
}

/** 站内导航：上下文页 → 会话页（点「到会话中使用」，同时触发显式交接请求）。 */
async function goToConversationsInApp(cdp) {
  await clickAnchorExact(cdp, '到会话中使用');
  const arrived = await waitFor(cdp, `location.pathname === '/ai/conversations'`, { timeoutMs: 10000 });
  if (!arrived) throw new Error('站内导航没有到达 /ai/conversations');
}

async function saveCodeFromContextPage(cdp) {
  await waitFor(cdp, `Boolean(document.querySelector('[data-testid="context-tab-code"]'))`, { timeoutMs: 20000 });
  await mouseClickSelector(cdp, '[data-testid="context-tab-code"]', 0, { settleMs: 500 });
  await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(CODE_INPUT)}))`, { timeoutMs: 15000 });
  // 输入框可能有旧值：先清空再输入（macOS 上 typeInto 的 Ctrl+A 不会全选）。
  await evaluate(
    cdp,
    `(() => {
      const el = document.querySelector(${JSON.stringify(CODE_INPUT)});
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return el.value;
    })()`,
  );
  await typeInto(cdp, CODE_INPUT, CODE_TEXT);
  await sleep(200);
  await clickButtonExact(cdp, '保存为会话内容');
  await sleep(300);
}

async function sendEvents() {
  const state = await (await fetch(`${CHAT_URL}/control/state`)).json();
  return (state.streamEvents ?? []).filter((entry) => entry.kind === 'send');
}

async function main() {
  let browser = null;
  try {
    browser = await launchBrowser({ debugPort: 9451, width: 1440, height: 1000 });
  } catch (error) {
    check('0. headless Chrome 启动', false, reason(error));
    return;
  }
  const { cdp } = browser;
  try {
    await login(cdp);
    // 首次进入会话页（整页加载 OK：此时选择为空）；之后全程站内导航。
    await goto(cdp, `${APP_URL}/ai/conversations`, 4500);
    const mounted = await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(FRAME)}))`, { timeoutMs: 25000 });
    check('0. 原生 ChatBox 首次挂载（同一 runtime）', mounted);
    if (!mounted) return;
    await sleep(1500);

    // 第一次：站内到代码页保存 → 站内回会话应看到卡片。
    await goToContextInApp(cdp);
    await saveCodeFromContextPage(cdp);
    await goToConversationsInApp(cdp);
    await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(FRAME)}))`, { timeoutMs: 25000 });
    const firstCard = await waitFor(
      cdp,
      `(document.querySelector(${JSON.stringify(FRAME)}).innerText || '').includes('代码工作区')`,
      { timeoutMs: 15000 },
    );
    check('1. 首次保存后回到会话，输入区带有代码工作内容卡片', firstCard, (await frameText(cdp)).replace(/\n/g, ' | ').slice(0, 140));

    // 新建对话：清掉卡片（合理）。
    await clickFrameButton(cdp, '新建对话');
    await sleep(900);
    const cleared = !(await frameText(cdp)).includes('代码工作区');
    check('2. 新建对话后卡片被清掉（保留原语义）', cleared, (await frameText(cdp)).replace(/\n/g, ' | ').slice(0, 120));

    // 第二次：同一 runtime、同一工作区再次保存 → 卡片应回来。
    await goToContextInApp(cdp);
    await saveCodeFromContextPage(cdp);
    await goToConversationsInApp(cdp);
    await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(FRAME)}))`, { timeoutMs: 25000 });
    const secondCard = await waitFor(
      cdp,
      `(document.querySelector(${JSON.stringify(FRAME)}).innerText || '').includes('代码工作区')`,
      { timeoutMs: 15000 },
    );
    check(
      '3. 同一 runtime 内再次「保存为会话内容」后卡片回来（不靠新标签）',
      secondCard,
      (await frameText(cdp)).replace(/\n/g, ' | ').slice(0, 140),
    );

    // 发送两条：首条带 workContext，第二条不重复。
    await sendMessage(cdp, '第一条：带上下文');
    await sleep(3500);
    await sendMessage(cdp, '第二条：不重复上下文');
    await sleep(2500);
    const recent = (await sendEvents()).slice(0, 2).reverse();
    const firstContext = Array.isArray(recent[0]?.workContext) ? recent[0].workContext : [];
    const secondContext = Array.isArray(recent[1]?.workContext) ? recent[1].workContext : [];
    check(
      '4. 首条消息真的携带代码 workContext（1 项、uid=crewloom:code-workspace）',
      firstContext.length === 1 && firstContext[0].type === 'code-editor' && firstContext[0].uid === 'crewloom:code-workspace',
      JSON.stringify(firstContext),
    );
    check('5. 第二条消息不再重复带上下文（原契约保持）', secondContext.length === 0, JSON.stringify(secondContext));
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
