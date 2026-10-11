#!/usr/bin/env node
/**
 * 真实浏览器回归（54 轮 · 第 6 项）：非本人 AI 任务按真实 `readonly` 契约只读。
 *
 * 场景（Main 在 5338/5416 实测）：任务 9 由张三（id 3）领取，会话失效后以李四（id 7）正常登录，
 * 仍能批准/修改/否决。根因是夹具固定按 actor=3 计算 `readonly`（产品其实已经读取并遵守 readonly）。
 * 本脚本用李四打开该任务，断言界面只读、决定按钮禁用、且没有发出任何决定请求。
 *
 * 用法：CREWLOOM_APP_URL=http://127.0.0.1:5350 CREWLOOM_CHAT_URL=http://127.0.0.1:5420 \
 *         node scripts/check-main-chat-54-task-readonly.mjs
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
const ACCOUNT = { email: 'lisi@fixture.local', password: 'fixture' };

const results = [];
function check(name, ok, note = '') {
  results.push({ name, ok: Boolean(ok), note });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? ` — ${note}` : ''}`);
}
const reason = (error) => String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 200);

async function control(path, body) {
  const response = await fetch(`${CHAT_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return response.json().catch(() => null);
}

async function login(cdp) {
  await goto(cdp, `${APP_URL}/login`, 2500);
  const shown = await waitFor(cdp, `Boolean(document.querySelector('input[name="crewloom-account"]'))`, { timeoutMs: 25000 });
  if (!shown) throw new Error('登录页没有出现账号输入框');
  await sleep(400);
  await typeInto(cdp, 'input[name="crewloom-account"]', ACCOUNT.email);
  await typeInto(cdp, 'input[name="crewloom-secret"]', ACCOUNT.password);
  await mouseClickSelector(cdp, 'button[type="submit"]');
  const arrived = await waitFor(cdp, `location.pathname === '/workbench'`, { timeoutMs: 25000 });
  if (!arrived) throw new Error(`李四登录后未到达 /workbench（当前 ${await evaluate(cdp, 'location.pathname')}）`);
}

const bodyText = (cdp) => evaluate(cdp, 'document.body.innerText || ""');

async function main() {
  // 准备：任务由张三（3）领取、状态 pending_approval。
  await control('/control/td03/seed', {});
  const reset = await control('/control/td03/reset', { status: 'pending_approval' });
  const sessionId = reset?.td03?.sessionId ?? null;
  check(
    '0. 夹具任务已由张三（3）领取（pending_approval）',
    reset?.td03?.status === 'pending_approval' && Number(reset?.td03?.acceptedUserId) === 3,
    `session=${sessionId} accepted=${reset?.td03?.acceptedUserId}`,
  );

  let browser = null;
  try {
    browser = await launchBrowser({ debugPort: 9456, width: 1440, height: 1000 });
  } catch (error) {
    check('1. headless Chrome 启动', false, reason(error));
    return;
  }
  const { cdp } = browser;
  try {
    await login(cdp);
    await goto(cdp, `${APP_URL}/tasks/ai?sessionId=${encodeURIComponent(sessionId)}`, 4500);
    const loaded = await waitFor(cdp, `(document.body.innerText || '').includes('工具调用') || (document.body.innerText || '').includes('当前只读')`, {
      timeoutMs: 25000,
    });
    check('2. 李四能打开该 AI 任务页', loaded);
    if (!loaded) return;

    const text = await bodyText(cdp);
    check('3. 页面按真实 readonly 显示「当前只读」', text.includes('当前只读'), text.replace(/\s+/g, ' ').slice(0, 160));

    const decisions = await evaluate(
      cdp,
      `(() => {
        const labels = ['批准这次调用', '修改参数后批准', '否决这次调用'];
        const buttons = [...document.querySelectorAll('button')].filter((b) => labels.includes((b.innerText || '').trim()));
        return { count: buttons.length, allDisabled: buttons.length > 0 && buttons.every((b) => b.disabled) };
      })()`,
    );
    check(
      '4. 决定按钮全部禁用（不是仍可批准/修改/否决）',
      decisions.count >= 3 && decisions.allDisabled === true,
      JSON.stringify(decisions),
    );

    const more = await evaluate(
      cdp,
      `(() => {
        const button = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === '继续执行');
        return button ? { present: true, disabled: button.disabled } : { present: false };
      })()`,
    );
    check('5.「继续执行」若出现也是禁用（只读不能续跑）', !more.present || more.disabled === true, JSON.stringify(more));

    // 真实请求证据：只读下不应出现任何决定/续跑请求。
    const log = await (await fetch(`${CHAT_URL}/__crewloom/controlled-log`)).json();
    const entry = (kind) => (log.entries ?? []).filter((item) => item.kind === kind && item.sessionId === sessionId);
    const decisionRequests = entry('updateUserDecision');
    const resumeRequests = entry('resumeToolCall');
    check('6. 没有发出 updateUserDecision 决定请求', decisionRequests.length === 0, JSON.stringify(decisionRequests));
    check('7. 没有发出 resumeToolCall 续跑请求', resumeRequests.length === 0, JSON.stringify(resumeRequests));
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
