#!/usr/bin/env node
/**
 * TD-03 **冷启动真实前端工具消费**：真实浏览器（本机预览 5331 → 本机合成后端 5411）验证
 * 「批准 1 / 拒绝 2 / 批准空 code 3」之后：被拒绝的那条不执行、结果集不含它，
 * 且真实的 code consumer 真的把第 1 条写进了 AI-04 代码工作区。
 *
 * 与 `check-main-browser-chat-env.mjs` 的分工：
 *  - 那个脚本只证明环境连通（21 项），不证明 TD-03 的工具消费闭环；
 *  - 本脚本专门走**冷启动**（fresh 登录后不先打开聊天页）：先在 `/ai/context` 保存真实代码
 *    工作区（同一文档内的 store），再播种一条 workContext 指向**同一个 block uid** 的 AI 任务，
 *    然后进 `/tasks/ai` 逐条决定并在同一页面续跑。
 *
 * 关键证据都取**本机控制原始记录**（`/control/state` 的 `td03.lastResumeToolCallResults`），
 * 不是只看界面文案：
 *  - `toolCallIds` 含全部 3 条（原生协议）；
 *  - `toolCallResults` 只含被执行的 1 与 3：1 是 `{applied:true}`，3 是真实错误；
 *  - 被拒绝的 `controlled-tool-2` **不在**结果里，且它的代码没有出现在工作区。
 *
 * 只打本机 `APP_URL` / `CHAT_URL`，不外呼、不改源码、不停止任何既有服务。
 *
 * 用法：
 *   CREWLOOM_APP_URL=http://127.0.0.1:5331 CREWLOOM_CHAT_URL=http://127.0.0.1:5411 \
 *     node scripts/check-main-ai-task-execution.mjs
 */

import {
  launchBrowser,
  goto,
  evaluate,
  typeInto,
  mouseClickSelector,
  mouseClickAt,
  sleep,
  waitFor,
} from './lib/cdp-browser.mjs';

const APP_URL = (process.env.CREWLOOM_APP_URL ?? 'http://127.0.0.1:5331').replace(/\/$/, '');
const CHAT_URL = (process.env.CREWLOOM_CHAT_URL ?? 'http://127.0.0.1:5411').replace(/\/$/, '');
const CODE_UID = process.env.CREWLOOM_CODE_BLOCK_UID ?? 'crewloom:code-workspace';
const DEBUG_PORT = Number(process.env.CREWLOOM_CDP_PORT ?? 9413);
const ACCOUNT = { email: 'zhangsan@fixture.local', password: 'fixture' };

const INITIAL_CODE = '// main code workspace start\n';
const EXPECTED_APPLIED = '// controlled apply\nconst answer = 42;\n';
const REJECTED_CODE = '// 这一条会被用户拒绝，不应写入\n';

const results = [];
function check(name, ok, note = '') {
  results.push({ name, ok: Boolean(ok), note });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? ` — ${note}` : ''}`);
}
const reason = (error) => String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 240);

async function step(name, fn) {
  try {
    const outcome = await fn();
    if (outcome && typeof outcome === 'object' && 'ok' in outcome) check(name, outcome.ok, outcome.note ?? '');
    else check(name, outcome !== false, '');
  } catch (error) {
    check(name, false, `异常：${reason(error)}`);
  }
}

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

/** 同一文档内的 SPA 导航：不整页刷新，保持 context store 与原生运行上下文单例。 */
async function spaNavigate(cdp, path) {
  await evaluate(
    cdp,
    `(() => { window.history.pushState({}, '', ${JSON.stringify(path)}); window.dispatchEvent(new PopStateEvent('popstate')); return true; })()`,
  );
  await sleep(1200);
  return evaluate(cdp, 'location.pathname + location.search');
}

/** 按可见文本点击一个原生 button（真实鼠标）。 */
async function clickButtonByText(cdp, text, index = 0) {
  const box = await evaluate(
    cdp,
    `(() => {
      const list = [...document.querySelectorAll('button')].filter((b) => (b.textContent || '').trim() === ${JSON.stringify(text)});
      const button = list[${index}];
      if (!button) return null;
      button.scrollIntoView({ block: 'center' });
      const rect = button.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, disabled: button.disabled };
    })()`,
  );
  if (!box) throw new Error(`找不到可点的按钮「${text}」`);
  if (box.disabled) throw new Error(`按钮「${text}」当前不可点（disabled）`);
  await sleep(150);
  await mouseClickAt(cdp, box.x, box.y, { settleMs: 500 });
}

async function countButtons(cdp, text) {
  return evaluate(
    cdp,
    `[...document.querySelectorAll('button')].filter((b) => (b.textContent || '').trim() === ${JSON.stringify(text)}).length`,
  );
}

async function waitForButtonCount(cdp, text, expected, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let count = -1;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- 轮询 UI 变化是必要的
    count = await countButtons(cdp, text);
    if (count === expected) return count;
    // eslint-disable-next-line no-await-in-loop
    await sleep(300);
  }
  return count;
}

async function stateOf() {
  const response = await fetch(`${CHAT_URL}/control/state`);
  if (!response.ok) throw new Error(`/control/state → ${response.status}`);
  return response.json();
}

async function seedTask() {
  const response = await fetch(`${CHAT_URL}/control/td03/seed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'pending_acceptance', codeBlockUid: CODE_UID }),
  });
  const body = await response.json();
  return { status: response.status, td03: body?.td03 ?? null };
}

async function main() {
  let browser = null;
  try {
    browser = await launchBrowser({ debugPort: DEBUG_PORT, width: 1440, height: 1100 });
  } catch (error) {
    check('Chrome 启动', false, reason(error));
    return finish();
  }

  const { cdp, events } = browser;
  try {
    await step('0. 合成账号真实登录 → /workbench', async () => {
      await login(cdp);
      return { ok: true, note: await evaluate(cdp, 'location.pathname') };
    });

    await step('1. 冷启动准备：/ai/context 保存真实代码工作区（不先打开聊天页）', async () => {
      await goto(cdp, `${APP_URL}/ai/context`, 2500);
      await evaluate(
        cdp,
        `(() => {
          const tab = [...document.querySelectorAll('[role="tab"]')].find((node) => (node.textContent || '').includes('代码工作内容'));
          if (tab) tab.click();
          return Boolean(tab);
        })()`,
      );
      const ready = await waitFor(cdp, `Boolean(document.querySelector('[data-testid="context-code-input"]'))`, {
        timeoutMs: 20000,
      });
      if (!ready) throw new Error('代码工作内容 tab 没有出现代码输入框');
      await typeInto(cdp, '[data-testid="context-code-input"]', INITIAL_CODE);
      await sleep(200);
      await evaluate(cdp, `document.querySelector('[data-testid="context-code-save"]').click()`);
      const saved = await waitFor(cdp, `document.body.innerText.includes('已保存为本次会话的代码工作内容')`, {
        timeoutMs: 15000,
      });
      return { ok: Boolean(saved), note: `代码工作区 uid=${CODE_UID} 已保存` };
    });

    let seeded = null;
    await step('2. 控制页播种：workContext 指向同一个真实 code blockUid', async () => {
      seeded = await seedTask();
      const uid = seeded.td03?.codeBlockUid ?? null;
      return {
        ok: seeded.status === 200 && uid === CODE_UID && Boolean(seeded.td03?.sessionId),
        note: `session=${seeded.td03?.sessionId ?? '-'} codeBlockUid=${uid ?? '-'}`,
      };
    });
    const sessionId = seeded?.td03?.sessionId ?? '';
    if (!sessionId) throw new Error('播种失败，后续检查无法进行');

    await step('3. 同一文档进入 /tasks/ai：出现 3 条待决定前端工具', async () => {
      await spaNavigate(cdp, `/tasks/ai?sessionId=${encodeURIComponent(sessionId)}`);
      const ready = await waitFor(cdp, `document.body.innerText.includes('批准这次调用')`, { timeoutMs: 25000 });
      const count = await countButtons(cdp, '批准这次调用');
      return { ok: Boolean(ready) && count === 3, note: `批准按钮=${count}` };
    });

    await step('4. 领取任务（pending_acceptance → pending_approval，认领≠批准）', async () => {
      await clickButtonByText(cdp, '领取任务');
      const ok = await waitFor(cdp, `document.body.innerText.includes('待审核')`, { timeoutMs: 20000 });
      return { ok: Boolean(ok), note: '已领取' };
    });

    await step('5. 逐条决定：批准 1 / 拒绝 2 / 批准空 code 3', async () => {
      await clickButtonByText(cdp, '批准这次调用', 0);
      await waitForButtonCount(cdp, '批准这次调用', 2);
      await clickButtonByText(cdp, '否决这次调用', 0);
      await waitForButtonCount(cdp, '批准这次调用', 1);
      await clickButtonByText(cdp, '批准这次调用', 0);
      const remaining = await waitForButtonCount(cdp, '批准这次调用', 0);
      return { ok: remaining === 0, note: '3 条决定已记录' };
    });

    await step('6. 继续执行（第二步真实 resumeToolCall）', async () => {
      const resume = await evaluate(
        cdp,
        `(() => {
          const button = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '继续执行');
          return button ? !button.disabled : false;
        })()`,
      );
      if (!resume) throw new Error('「继续执行」仍不可点（仍有未决定工具）');
      await clickButtonByText(cdp, '继续执行');
      await clickButtonByText(cdp, '确认继续');
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop -- 轮询网络事件是必要的
        if (events.apiRequests.some((entry) => entry.url.includes('resumeToolCall'))) break;
        // eslint-disable-next-line no-await-in-loop
        await sleep(300);
      }
      return { ok: events.apiRequests.some((entry) => entry.url.includes('resumeToolCall')), note: 'resumeToolCall 已发出' };
    });

    await step('7. 本机原始记录：toolCallResults 只有 1 与 3，被拒绝的 2 不在结果里', async () => {
      const state = await stateOf();
      const td = state.td03;
      const payload = td.lastResumeToolCallResults ?? {};
      const ids = (payload.toolCallResults ?? []).map((entry) => entry.id);
      const first = payload.toolCallResults?.[0]?.result ?? null;
      const third = payload.toolCallResults?.[1]?.result ?? null;
      const contractOk =
        ids.length === 2 &&
        ids[0] === 'controlled-tool-1' &&
        ids[1] === 'controlled-tool-3' &&
        !ids.includes('controlled-tool-2') &&
        Array.isArray(payload.toolCallIds) &&
        payload.toolCallIds.length === 3 &&
        first?.status === 'success' &&
        first?.content?.applied === true &&
        third?.status === 'error' &&
        typeof third?.content === 'string' &&
        third.content.length > 0;
      return {
        ok: contractOk,
        note: `toolCallIds=${JSON.stringify(payload.toolCallIds)} results=${JSON.stringify(ids)} 1=${JSON.stringify(first)} 3=${JSON.stringify(third)}`,
      };
    });

    await step('8. 决定/续跑计数真实（3 次决定 + 1 次续跑）', async () => {
      const state = await stateOf();
      return {
        ok: state.td03.decisionCount === 3 && state.td03.resumeCount === 1,
        note: `decisionCount=${state.td03.decisionCount} resumeCount=${state.td03.resumeCount} lastDecision=${JSON.stringify(state.td03.lastDecision)}`,
      };
    });

    await step('9. 真实 code consumer：回到 /ai/context 能看到第 1 条应用结果', async () => {
      await spaNavigate(cdp, '/ai/context');
      await evaluate(
        cdp,
        `(() => {
          const tab = [...document.querySelectorAll('[role="tab"]')].find((node) => (node.textContent || '').includes('代码工作内容'));
          if (tab) tab.click();
          return Boolean(tab);
        })()`,
      );
      await waitFor(cdp, `Boolean(document.querySelector('[data-testid="context-code-input"]'))`, { timeoutMs: 15000 });
      await sleep(400);
      const value = await evaluate(cdp, `document.querySelector('[data-testid="context-code-input"]').value`);
      const applied = value === EXPECTED_APPLIED;
      const rejectedAbsent = !String(value).includes('这一条会被用户拒绝');
      return {
        ok: applied && rejectedAbsent,
        note: `工作区=${JSON.stringify(value)} applied=${applied} 未写入被拒绝内容=${rejectedAbsent}`,
      };
    });
  } catch (error) {
    check('组内异常', false, reason(error));
  } finally {
    browser.close();
  }

  return finish();
}

function finish() {
  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`脚本异常：${error?.stack ?? error}`);
  process.exit(1);
});
