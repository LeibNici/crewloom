#!/usr/bin/env node
/**
 * 主浏览器会话环境：**环境连通性自检**（不是验收）。
 *
 * 目的：在把环境交给人工/后续核对之前，确认
 *   产品预览（Vite preview, 默认 5327） → 本机合成后端（默认 5404）
 * 这条链真的通：真实登录页能登录、原生 ChatBox 能挂载并发消息、工具确认卡能走
 * 「逐条决定 → resumeToolCall」两步协议、上下文工作区能读到本机合成集合、AI 任务页能
 * 领取并展示待决策工具、附件能真实 multipart 上传并按同一份字节回放、失败注入能按契约
 * 区分「角色失效（留在页面）」与「会话失效（回登录页）」。
 *
 * 与 `verify-*.mjs` 的区别（有意如此）：
 *  - 不产出验收结论、不写报告、不做截图归档；
 *  - 只打印 `PASS/FAIL` 行与一行汇总，退出码 0（全通过）/1（有失败）；
 *  - 失败**不中断**后续检查：每项独立 try/catch，缺项也会打出 FAIL 行。
 *
 * 边界（硬约束）：
 *  - 只访问本机 `CREWLOOM_APP_URL`（默认 http://127.0.0.1:5327）与
 *    `CREWLOOM_CHAT_URL`（默认 http://127.0.0.1:5404）；不访问任何外部网络；
 *  - 不停止/重启任何既有服务，不修改源码，不动用户的 Chrome（`launchBrowser` 用临时 profile）；
 *  - 只为自检创建合成会话与合成任务状态（预期副作用，不清理）。
 *
 * 用法：
 *   CREWLOOM_APP_URL=http://127.0.0.1:5327 CREWLOOM_CHAT_URL=http://127.0.0.1:5404 \
 *     node scripts/check-main-browser-chat-env.mjs
 */

import { createHash } from 'node:crypto';
import {
  launchBrowser,
  goto,
  evaluate,
  typeInto,
  mouseClickSelector,
  mouseClickText,
  mouseClickAt,
  sleep,
  waitFor,
} from './lib/cdp-browser.mjs';

const APP_URL = (process.env.CREWLOOM_APP_URL ?? 'http://127.0.0.1:5327').replace(/\/$/, '');
const CHAT_URL = (process.env.CREWLOOM_CHAT_URL ?? 'http://127.0.0.1:5404').replace(/\/$/, '');
const ACCOUNT = { email: 'zhangsan@fixture.local', password: 'fixture' };
const FRAME = '[data-testid="native-chatbox-frame"]';
const INPUT = `${FRAME} textarea.ant-sender-input`;
const TOOL_CARD = '[data-testid="native-tool-decision-card"]';

const results = [];
const doneChecks = new Set();
const failed = () => results.filter((item) => !item.ok);

function check(name, ok, note = '') {
  results.push({ name, ok: Boolean(ok), note });
  doneChecks.add(name);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? ` — ${note}` : ''}`);
}

const reason = (error) => String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 240);

/** 单项检查：异常只影响这一项。返回 `{ok, note}` 或布尔值。 */
async function step(name, fn) {
  try {
    const outcome = await fn();
    if (outcome && typeof outcome === 'object' && 'ok' in outcome) check(name, outcome.ok, outcome.note ?? '');
    else check(name, outcome !== false, '');
  } catch (error) {
    check(name, false, `异常：${reason(error)}`);
  }
}

/**
 * 一组共享同一个 Chrome 实例的检查。
 * 每个自检组用独立 Chrome + 独立 debugPort（9411 起），跑完一定 close()。
 * 组内提前抛异常时，未跑到的检查名也要补 FAIL 行，避免"少一行"被误读成通过。
 */
async function runGroup({ port, checks, fn }) {
  let browser = null;
  try {
    browser = await launchBrowser({ debugPort: port, width: 1440, height: 1100 });
  } catch (error) {
    for (const name of checks) if (!doneChecks.has(name)) check(name, false, `Chrome 启动失败：${reason(error)}`);
    return;
  }
  try {
    await fn({ cdp: browser.cdp, events: browser.events });
  } catch (error) {
    for (const name of checks) if (!doneChecks.has(name)) check(name, false, `组内异常：${reason(error)}`);
  } finally {
    browser.close();
  }
}

/* ------------------------------------------------------------------ *
 * 浏览器动作小工具（真实鼠标 / 真实键盘）
 * ------------------------------------------------------------------ */

/** 真实登录页登录（选择器来自本机合成登录表单）。 */
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
  if (!arrived) {
    throw new Error(`登录后未到达 /workbench（当前 ${await evaluate(cdp, 'location.pathname')}）`);
  }
}

/** 原生 ChatBox 的发送键：真实回车（keyDown / char / keyUp 三段，text='\r'）。 */
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

async function frameText(cdp) {
  return evaluate(cdp, `(() => { const f = document.querySelector(${JSON.stringify(FRAME)}); return f ? f.innerText : ''; })()`);
}

/** 在原生输入框里真实输入并回车发送；返回内容是否真的写进了输入框。 */
async function sendMessage(cdp, text) {
  await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(INPUT)}))`, { timeoutMs: 20000 });
  await typeInto(cdp, INPUT, text);
  await sleep(150);
  // 原生 TextArea 发送后可能残留一个换行（自动高度/受控组件行为），比较时去掉尾部空白。
  const value = await evaluate(cdp, `(document.querySelector(${JSON.stringify(INPUT)}) || {}).value || ''`);
  if (String(value).replace(/\s+$/, '') !== text) return false;
  await pressEnter(cdp);
  return true;
}

async function countToolCards(cdp) {
  return evaluate(cdp, `document.querySelectorAll(${JSON.stringify(TOOL_CARD)}).length`);
}

/**
 * 真实点击原生「新会话」，让 `currentConversation` 离开目标会话。
 *
 * 实测：停留在某个会话上时，再从会话列表点它不会触发历史加载
 * （`getMessages` 不会重发，卡片沿用流式期间的状态）；必须先离开再点回，
 * 才会走真实历史加载、把 `content.messageId` 回填到卡片上。
 */
async function startNewConversation(cdp) {
  const box = await evaluate(
    cdp,
    `(() => {
      const frame = document.querySelector(${JSON.stringify(FRAME)});
      if (!frame) return null;
      const byAria = [...frame.querySelectorAll('[aria-label]')].find((node) =>
        /New conversation|新会话|新建会话/.test(node.getAttribute('aria-label') || ''),
      );
      const el = byAria || frame.querySelector('button:has(.anticon-plus-circle)');
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, via: byAria ? 'aria' : 'icon' };
    })()`,
  );
  if (box) {
    await mouseClickAt(cdp, box.x, box.y);
    await sleep(1200);
    return true;
  }
  // 兜底：原生按钮的 aria-label 随 i18n 变化时按图标类名点同一个真实按钮。
  return evaluate(
    cdp,
    `(() => {
      const frame = document.querySelector(${JSON.stringify(FRAME)});
      const button = frame && frame.querySelector('button:has(.anticon-plus-circle)');
      if (!button) return false;
      button.click();
      return true;
    })()`,
  );
}

/** 真实鼠标点击某张工具卡里的「允许/拒绝」（按钮在卡片内部，不能用全局选择器点）。 */
async function clickCardDecision(cdp, cardIndex, kind) {
  const box = await evaluate(
    cdp,
    `(() => {
      const card = document.querySelectorAll(${JSON.stringify(TOOL_CARD)})[${cardIndex}];
      if (!card) return null;
      const button = card.querySelector('[data-testid="native-tool-${kind}"]');
      if (!button) return null;
      button.scrollIntoView({ block: 'center' });
      const rect = button.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`,
  );
  if (!box) throw new Error(`工具卡 ${cardIndex} 的「${kind}」按钮不可点`);
  await sleep(200);
  await mouseClickAt(cdp, box.x, box.y);
}

/** 真实鼠标点击一个按可见文本命中的 button（用于「领取任务」「批准这次调用」）。 */async function clickButtonByText(cdp, text, index = 0) {
  const box = await evaluate(
    cdp,
    `(() => {
      const list = [...document.querySelectorAll('button')].filter((b) => (b.textContent || '').trim() === ${JSON.stringify(text)});
      const button = list[${index}];
      if (!button) return null;
      button.scrollIntoView({ block: 'center' });
      const rect = button.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`,
  );
  if (!box) throw new Error(`找不到可点的按钮「${text}」`);
  await sleep(200);
  await mouseClickAt(cdp, box.x, box.y);
}

/* ------------------------------------------------------------------ *
 * 网络证据（只用 CDP 事件，不改写请求）
 * ------------------------------------------------------------------ */

/**
 * 取响应的**完整** body。
 *
 * `cdp-browser.mjs` 的 `getResponseBody` 会把 body 截到 2000 字符（够 UI 证据用），
 * 但会话列表应答会长于 2000，截断后 JSON 解析失败；这里直接走 CDP 原语取全文。
 */
async function fullResponseBody(cdp, requestId) {
  if (!requestId) return null;
  try {
    const result = await cdp.send('Network.getResponseBody', { requestId });
    return typeof result?.body === 'string' ? result.body : null;
  } catch {
    return null;
  }
}

/** 拿 POST body：优先用事件里的 postData，缺失时向 CDP 单独取一次。 */
async function postDataOf(cdp, entry) {
  if (typeof entry?.postData === 'string' && entry.postData.length > 0) return entry.postData;
  try {
    const result = await cdp.send('Network.getRequestPostData', { requestId: entry.requestId });
    return typeof result?.postData === 'string' ? result.postData : null;
  } catch {
    return null;
  }
}

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** 等待某个 /api 请求出现（按 url 片段），返回该请求条目或 null。 */
async function waitForRequest(cdp, events, fromIndex, needle, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = events.apiRequests.slice(fromIndex).find((entry) => entry.url.includes(needle));
    if (hit) return hit;
    if (Date.now() >= deadline) return null;
    // eslint-disable-next-line no-await-in-loop -- 轮询网络事件是必要的
    await sleep(300);
  }
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

let authToken = null;
/** 脚本开始时的 `unsupported` 清单长度（第 3 项自检自己会往里加一条，需要扣掉）。 */
let ownProbeBaseline = 0;

/** 取合成令牌（供需要真实身份的 HTTP 检查用）；失败不抛，由各检查自行报错。 */
async function ensureToken() {
  if (typeof authToken === 'string' && authToken.length > 0) return authToken;
  try {
    const response = await fetch(`${APP_URL}/api/auth:signIn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ACCOUNT),
    });
    const body = await response.json();
    authToken = typeof body?.data?.token === 'string' ? body.data.token : null;
  } catch {
    authToken = null;
  }
  return authToken;
}

async function main() {
  // 先取一次基线：第 3 项会故意打一次未知动作，本机必然把它记进 unsupported。
  try {
    const baseline = await (await fetch(`${CHAT_URL}/control/state`)).json();
    ownProbeBaseline = (baseline?.unsupported ?? []).filter((entry) => entry === 'GET synth_not_implemented:list').length;
  } catch {
    ownProbeBaseline = 0;
  }

  // ---------------- 只走 HTTP 的本机应答契约（1~5） ----------------
  await step('1. 合成后端 /healthz 声明 ok/local 且 outbound=false', async () => {
    const response = await fetch(`${CHAT_URL}/healthz`);
    const body = await response.json();
    return {
      ok: response.ok && body.ok === true && body.local === true && body.outbound === false,
      note: `${CHAT_URL}/healthz → ${response.status} ${JSON.stringify({ ok: body.ok, local: body.local, outbound: body.outbound })}`,
    };
  });

  await step('2. 经预览的 /api/app:getInfo 带 x-crewloom-local=1（没有回退真实后端）', async () => {
    const response = await fetch(`${APP_URL}/api/app:getInfo`);
    const header = response.headers.get('x-crewloom-local');
    return { ok: header === '1', note: `x-crewloom-local=${header}（${response.status}）` };
  });

  // 3~5、18 需要合成令牌：本机受控中间件对未登记动作要求真实令牌（无令牌会先 401）。
  // 取令牌本身不算检查项；取不到时由上列各检查各自 FAIL 并写明原因。
  await ensureToken();
  const authHeaders = () => (authToken ? { authorization: `Bearer ${authToken}` } : {});

  await step('3. 未知动作在本机 501 且 code=SYNTH_UNSUPPORTED（不外呼）', async () => {
    const response = await fetch(`${APP_URL}/api/synth_not_implemented:list`, { headers: authHeaders() });
    const body = await response.json().catch(() => null);
    return {
      ok: response.status === 501 && body?.errors?.[0]?.code === 'SYNTH_UNSUPPORTED',
      note: `${response.status} code=${body?.errors?.[0]?.code ?? '-'}`,
    };
  });

  await step('4. 外呼动作 /api/ai:listModels 在本机 403 且 code=SYNTH_LOCAL_DENIED', async () => {
    const response = await fetch(`${APP_URL}/api/ai:listModels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ model: 'LLM' }),
    });
    const body = await response.json().catch(() => null);
    return {
      ok: response.status === 403 && body?.errors?.[0]?.code === 'SYNTH_LOCAL_DENIED',
      note: `${response.status} code=${body?.errors?.[0]?.code ?? '-'}`,
    };
  });

  await step('5. 未知附件路径经预览 404（本机不取真实附件）', async () => {
    const response = await fetch(`${APP_URL}/files/main/main/attachments/1.png`, { headers: authHeaders() });
    return { ok: response.status === 404, note: `/files/main/main/attachments/1.png → ${response.status}` };
  });

  // ---------------- 真实登录页 / 工作台（6~8） ----------------
  await runGroup({
    port: 9411,
    checks: [
      '6. 真实登录页用合成账号登录成功并进入 /workbench',
      '7. 角色选择器含两个合成角色',
      '8. 工作台正文含「可使用的模块」且不含「功能尚未开放」',
    ],
    fn: async ({ cdp }) => {
      await step('6. 真实登录页用合成账号登录成功并进入 /workbench', async () => {
        await login(cdp);
        return { ok: true, note: `${ACCOUNT.email} → /workbench` };
      });

      await step('7. 角色选择器含两个合成角色', async () => {
        const options = await evaluate(
          cdp,
          `(() => {
            const select = document.querySelector('select[aria-label="切换当前角色"]');
            return select ? [...select.options].map((option) => (option.textContent || '').trim()) : null;
          })()`,
        );
        const wanted = ['合成角色·操作员', '合成角色·复核员'];
        return { ok: Array.isArray(options) && wanted.every((title) => options.includes(title)), note: JSON.stringify(options) };
      });

      await step('8. 工作台正文含「可使用的模块」且不含「功能尚未开放」', async () => {
        const text = (await evaluate(cdp, 'document.body.innerText || ""')).replace(/\s+/g, ' ');
        const hasModules = text.includes('可使用的模块');
        const hasPlaceholder = text.includes('功能尚未开放');
        return { ok: hasModules && !hasPlaceholder, note: `含模块区=${hasModules} 含占位文案=${hasPlaceholder}` };
      });
    },
  });

  // ---------------- 会话页：原生 ChatBox / 消息 / 工具两阶段（9~13） ----------------
  await runGroup({
    port: 9412,
    checks: [
      '9. /ai/conversations 原生 ChatBox 挂载且输入框存在',
      '10. 普通消息 4 秒内出现「受控回复」',
      '11. [[tools]] 出现 3 张工具确认卡',
      '12. 从会话列表点回本条会话后 3 张卡的 data-message-id 非空',
      '13. 允许/拒绝/允许 → 3 次 updateUserDecision + 1 次 resumeToolCall（3 个 toolCallId + 真实结果）',
    ],
    fn: async ({ cdp, events }) => {
      let sessionId = null;
      let listBase = 0;

      await step('9. /ai/conversations 原生 ChatBox 挂载且输入框存在', async () => {
        await login(cdp);
        await goto(cdp, `${APP_URL}/ai/conversations`, 3500);
        const probe = await waitFor(
          cdp,
          `(() => {
            const frame = document.querySelector(${JSON.stringify(FRAME)});
            const input = frame ? frame.querySelector('textarea.ant-sender-input') : null;
            return frame && input ? { frame: true, input: true } : null;
          })()`,
          { timeoutMs: 30000 },
        );
        return { ok: Boolean(probe), note: JSON.stringify(probe ?? { frame: false, input: false }) };
      });

      await step('10. 普通消息 4 秒内出现「受控回复」', async () => {
        const typed = await sendMessage(cdp, '环境自检：普通消息');
        const started = Date.now();
        const arrived = await waitFor(cdp, `(document.querySelector(${JSON.stringify(FRAME)}) || {}).innerText?.includes('受控回复')`, {
          timeoutMs: 4000,
        });
        const elapsed = Date.now() - started;
        return {
          ok: Boolean(arrived),
          note: `输入生效=${typed} 耗时 ${elapsed}ms；帧内文本=${JSON.stringify((await frameText(cdp)).replace(/\s+/g, ' ').slice(-80))}`,
        };
      });

      await step('11. [[tools]] 出现 3 张工具确认卡', async () => {
        // 等上一条流收尾（输入框重新可用）再发第二条，避免落在 streaming 状态里。
        await waitFor(cdp, `!document.querySelector(${JSON.stringify(INPUT)}).disabled`, { timeoutMs: 10000 });
        await sleep(1200);
        listBase = events.apiRequests.length;
        const typed = await sendMessage(cdp, '[[tools]]');
        if (!typed) throw new Error('第二条消息没有真的写进原生输入框');
        await waitFor(cdp, `document.querySelectorAll(${JSON.stringify(TOOL_CARD)}).length === 3`, { timeoutMs: 30000 });
        const cards = await countToolCards(cdp);
        return { ok: cards === 3, note: `卡片数=${cards}` };
      });

      await step('12. 从会话列表点回本条会话后 3 张卡的 data-message-id 非空', async () => {
        // 本条会话的 sessionId 取自真实网络：发送后客户端会请求 getMessages?sessionId=...
        const getReqs = events.apiRequests
          .slice(listBase)
          .filter((entry) => entry.url.includes('aiConversations:getMessages?sessionId='));
        const last = getReqs[getReqs.length - 1];
        const matched = last && /sessionId=([^&]+)/.exec(last.url);
        sessionId = matched ? decodeURIComponent(matched[1]) : null;
        if (!sessionId) throw new Error('没能从网络事件里确认本条会话的 sessionId');

        // 关键前置（实测）：点回"当前正在看的会话"不会触发历史加载。
        // 必须先真实点一次原生「新会话」离开它，再点回，才会走 getMessages 回填 content.messageId。
        const left = await startNewConversation(cdp);
        const cardsAfterNew = await countToolCards(cdp);
        await sleep(800);

        await mouseClickSelector(cdp, '[aria-label="Conversation list"]');
        await waitFor(cdp, `document.querySelectorAll('li.ant-conversations-item').length > 0`, { timeoutMs: 15000 });
        await sleep(600);

        // 会话列表按标题展示；先用会话列表接口的完整应答把 sessionId 映射成标题（不猜序号）。
        let title = null;
        const listEntry = [...events.apiRequests]
          .reverse()
          .find((entry) => entry.url.includes('aiConversations:list') && entry.url.includes('pageSize=50'));
        const rows = parseJson(await fullResponseBody(cdp, listEntry?.requestId))?.data;
        if (Array.isArray(rows)) {
          const mine = rows.find((row) => String(row?.sessionId ?? row?.id) === sessionId);
          title = mine?.title ?? null;
        }
        // 兜底：列表展示顺序为"旧 → 新"，最后一项即最新会话。
        if (!title) {
          const texts = await evaluate(
            cdp,
            `[...document.querySelectorAll('li.ant-conversations-item')].map((el) => (el.innerText || '').trim()).filter(Boolean)`,
          );
          title = texts[texts.length - 1] ?? null;
        }
        if (!title) throw new Error('没能定位本条会话在列表里的标题');

        const clickBase = events.apiRequests.length;
        await mouseClickText(cdp, 'li.ant-conversations-item', title, { settleMs: 400 });
        const reload = await waitForRequest(cdp, events, clickBase, `getMessages?sessionId=${sessionId}`, 25000);

        await sleep(2500);
        const probe = await evaluate(
          cdp,
          `(() => {
            const cards = [...document.querySelectorAll(${JSON.stringify(TOOL_CARD)})];
            return { count: cards.length, messageIds: cards.map((card) => card.getAttribute('data-message-id')) };
          })()`,
        );
        const ok =
          Boolean(left) &&
          cardsAfterNew === 0 &&
          Boolean(reload) &&
          probe.count === 3 &&
          probe.messageIds.every((id) => typeof id === 'string' && id.length > 0);
        return {
          ok,
          note: `会话=${sessionId} 标题=${title} 已离开当前会话=${Boolean(left)}(新会话后卡片=${cardsAfterNew}) 点回触发历史加载=${Boolean(reload)} 卡片数=${probe.count} messageId=${JSON.stringify(probe.messageIds)}`,
        };
      });

      await step('13. 允许/拒绝/允许 → 3 次 updateUserDecision + 1 次 resumeToolCall（3 个 toolCallId + 真实结果）', async () => {
        const base = events.apiRequests.length;
        await clickCardDecision(cdp, 0, 'approve');
        await sleep(1200);
        await clickCardDecision(cdp, 1, 'reject');
        await sleep(1200);
        await clickCardDecision(cdp, 2, 'approve');

        const decisions = [];
        const decisionDeadline = Date.now() + 25000;
        while (decisions.length < 3 && Date.now() < decisionDeadline) {
          decisions.length = 0;
          decisions.push(
            ...events.apiRequests.slice(base).filter((entry) => entry.url.includes('aiConversations:updateUserDecision')),
          );
          if (decisions.length >= 3) break;
          // eslint-disable-next-line no-await-in-loop -- 等第三条决定请求到达
          await sleep(300);
        }
        const types = [];
        for (const entry of decisions) {
          // eslint-disable-next-line no-await-in-loop -- 逐条取 postData
          const body = parseJson(await postDataOf(cdp, entry));
          types.push(body?.userDecision?.type ?? null);
        }

        const resumeEntry = await waitForRequest(cdp, events, base, 'aiConversations:resumeToolCall', 25000);
        const resumeBody = resumeEntry ? parseJson(await postDataOf(cdp, resumeEntry)) : null;
        const toolCallIds = Array.isArray(resumeBody?.toolCallIds) ? resumeBody.toolCallIds : [];
        const toolCallResults = Array.isArray(resumeBody?.toolCallResults) ? resumeBody.toolCallResults : [];
        // 只要求"有真实结果"（成功或来自真实注册表的错误文本都算），不断言必须有成功结果。
        const resultsReal =
          toolCallResults.length > 0 &&
          toolCallResults.every((item) => item && typeof item.id === 'string' && item.result !== undefined && item.result !== null);
        const ok =
          decisions.length === 3 &&
          JSON.stringify(types) === JSON.stringify(['approve', 'reject', 'approve']) &&
          Boolean(resumeEntry) &&
          toolCallIds.length === 3 &&
          resultsReal;
        return {
          ok,
          note: `决定=${decisions.length} 类型=${JSON.stringify(types)} resumeToolCall=${Boolean(resumeEntry)} toolCallIds=${toolCallIds.length} toolCallResults=${toolCallResults.length}`,
        };
      });
    },
  });

  // ---------------- 上下文工作区（14~15） ----------------
  await runGroup({
    port: 9413,
    checks: ['14. /ai/context 五个上下文 tab 可见', '15. record tab 出现本机合成集合名（synth_tickets/synth_orders）'],
    fn: async ({ cdp }) => {
      await step('14. /ai/context 五个上下文 tab 可见', async () => {
        await login(cdp);
        await goto(cdp, `${APP_URL}/ai/context`, 3500);
        const shown = await waitFor(
          cdp,
          `(() => {
            const keys = ['datasource', 'record', 'code', 'chart', 'selection'];
            const visible = keys.filter((key) => {
              const el = document.querySelector('[data-testid="context-tab-' + key + '"]');
              return el && el.getBoundingClientRect().width > 0;
            });
            return visible.length === keys.length ? visible : null;
          })()`,
          { timeoutMs: 25000 },
        );
        return { ok: Array.isArray(shown) && shown.length === 5, note: JSON.stringify(shown ?? []) };
      });

      await step('15. record tab 出现本机合成集合名（synth_tickets/synth_orders）', async () => {
        await mouseClickSelector(cdp, '[data-testid="context-tab-record"]');
        // 集合清单在 datalist 里（不是可见正文），必须按 DOM 断言。
        const options = await waitFor(
          cdp,
          `(() => {
            const list = [...document.querySelectorAll('#crewloom-record-collections option')].map((option) => option.value);
            return list.includes('synth_tickets') || list.includes('synth_orders') ? list : null;
          })()`,
          { timeoutMs: 25000 },
        );
        return { ok: Array.isArray(options), note: `集合候选=${JSON.stringify(options ?? [])}` };
      });
    },
  });

  // ---------------- AI 任务页：播种 → 详情 → 领取（16~17） ----------------
  let td03SessionId = null;
  await runGroup({
    port: 9414,
    checks: ['16. 播种后 /tasks/ai?sessionId= 详情非空（3 个 executeFrontendTool）', '17. 领取任务后出现「待审核」与「批准这次调用」'],
    fn: async ({ cdp }) => {
      await step('16. 播种后 /tasks/ai?sessionId= 详情非空（3 个 executeFrontendTool）', async () => {
        const seedResponse = await fetch(`${CHAT_URL}/control/td03/seed`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: 'pending_acceptance' }),
        });
        const seeded = await seedResponse.json();
        td03SessionId = seeded?.td03?.sessionId ?? null;
        if (!td03SessionId) throw new Error('控制页播种没有返回 td03.sessionId');

        await login(cdp);
        await goto(cdp, `${APP_URL}/tasks/ai?sessionId=${encodeURIComponent(td03SessionId)}`, 4000);
        const probe = await waitFor(
          cdp,
          `(() => {
            const page = document.querySelector('[data-testid="ai-task-page"]');
            if (!page) return null;
            const approves = [...page.querySelectorAll('button[aria-label^="批准 "]')];
            const text = (document.body.innerText || '').replace(/\\s+/g, ' ');
            if (approves.length !== 3) return null;
            return {
              count: approves.length,
              names: approves.map((button) => button.getAttribute('aria-label')),
              text,
            };
          })()`,
          { timeoutMs: 30000 },
        );
        if (!probe) throw new Error(`任务页没有渲染出 3 个待决策工具（会话 ${td03SessionId}）`);
        const allExecute = probe.names.every((label) => label.includes('executeFrontendTool'));
        const ok =
          allExecute && probe.text.includes('领取任务') && !probe.text.includes('没有待决策的工具调用');
        return {
          ok,
          note: `会话=${td03SessionId} 工具卡=${probe.count} 均含 executeFrontendTool=${allExecute} 含领取任务=${probe.text.includes('领取任务')} 含空态=${probe.text.includes('没有待决策的工具调用')}`,
        };
      });

      await step('17. 领取任务后出现「待审核」与「批准这次调用」', async () => {
        await clickButtonByText(cdp, '领取任务');
        const shown = await waitFor(
          cdp,
          `(() => {
            const text = (document.body.innerText || '').replace(/\\s+/g, ' ');
            return text.includes('待审核') && text.includes('批准这次调用') ? text : null;
          })()`,
          { timeoutMs: 25000 },
        );
        if (!shown) {
          const text = (await evaluate(cdp, 'document.body.innerText || ""')).replace(/\s+/g, ' ');
          throw new Error(`领取后正文没有同时出现「待审核」和「批准这次调用」：${text.slice(0, 160)}`);
        }
        return { ok: true, note: '状态已推进到待审核，工具决定按钮可见' };
      });
    },
  });

  // ---------------- 附件：真实 multipart 上传 + 同字节回放（18） ----------------
  await step('18. 合成文件经预览 multipart 上传后按同一份字节回放（sha256 相等）', async () => {
    await ensureToken();
    const source = Buffer.from(await (await fetch(`${CHAT_URL}/control/fixture-attachment.txt`)).arrayBuffer());
    const form = new FormData();
    form.append('file', new Blob([source], { type: 'text/plain' }), 'fixture-attachment.txt');
    const upload = await fetch(`${APP_URL}/api/aiFiles:create`, { method: 'POST', headers: authHeaders(), body: form });
    const meta = await upload.json().catch(() => null);
    const filename = meta?.data?.filename;
    if (upload.status !== 200 || !filename) {
      throw new Error(`上传未返回元数据：${upload.status} ${JSON.stringify(meta).slice(0, 160)}`);
    }
    const replay = await fetch(`${APP_URL}/files/controlled/${encodeURIComponent(filename)}`);
    const replayBuffer = Buffer.from(await replay.arrayBuffer());
    const same = replay.status === 200 && sha256(replayBuffer) === sha256(source);
    return {
      ok: same,
      note: `filename=${filename} size=${meta?.data?.size ?? '-'} 上传字节=${source.length} 回放字节=${replayBuffer.length} sha256 相等=${same}`,
    };
  });

  // ---------------- 未支持 / 拒绝清单（19） ----------------
  await step('19. /control/state 除自检自己那一次未知动作探测外无其它未支持项，且 denied 含 ai:listModels', async () => {
    const state = await (await fetch(`${CHAT_URL}/control/state`)).json();
    const unsupported = Array.isArray(state?.unsupported) ? state.unsupported : null;
    const denied = Array.isArray(state?.denied) ? state.denied : [];
    const deniedListModels = denied.some((entry) => entry?.action === 'ai:listModels');
    // 第 3 项自检**必然**要打一次未知动作，本机因此会把它记进 unsupported（自证 501）。
    // 这里的口径是"环境里不存在除自检自己那一次探测之外的未支持动作"，
    // 否则同一份脚本里第 3 项与第 19 项会互相矛盾，永远不可能同时通过。
    const ownProbe = 'GET synth_not_implemented:list';
    const countOf = (list) => (list ?? []).filter((entry) => entry === ownProbe).length;
    const unexpected = (unsupported ?? []).filter((entry) => entry !== ownProbe);
    // 本次自检只应该新增 1 条（第 3 项的那一次）；多出来的说明本机还遇到了别的未支持动作。
    const ownProbeDelta = countOf(unsupported) - ownProbeBaseline;
    return {
      ok: Array.isArray(unsupported) && unexpected.length === 0 && ownProbeDelta === 1 && deniedListModels,
      note: `unsupported=${JSON.stringify(unsupported)}（脚本开始时已有 ${ownProbeBaseline} 条同类探测；除自检自己那一次之外的条目=${JSON.stringify(unexpected)}）；denied 含 ai:listModels=${deniedListModels}（共 ${denied.length} 条）`,
    };
  });

  // ---------------- 失效注入（role）：留在任务页（20） ----------------
  await runGroup({
    port: 9415,
    checks: ['20. 注入角色失效：点「批准这次调用」后仍留在 /tasks/ai（不跳登录页）'],
    fn: async ({ cdp }) => {
      try {
        await step('20. 注入角色失效：点「批准这次调用」后仍留在 /tasks/ai（不跳登录页）', async () => {
          if (!td03SessionId) throw new Error('没有可用的 TD-03 会话（第 16 项未播种成功）');
          await login(cdp);
          await goto(cdp, `${APP_URL}/tasks/ai?sessionId=${encodeURIComponent(td03SessionId)}`, 4000);
          const ready = await waitFor(cdp, `document.querySelectorAll('button[aria-label^="批准 "]').length === 3`, {
            timeoutMs: 30000,
          });
          if (!ready) throw new Error('任务页没有待决策的工具按钮，无法触发决定请求');

          const inject = await fetch(`${CHAT_URL}/control/inject`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'aiConversations:updateUserDecision', mode: 'role', remaining: 1 }),
          });
          if (!inject.ok) throw new Error(`注入开关未生效：${inject.status}`);

          await clickButtonByText(cdp, '批准这次调用');
          await sleep(3000);
          const pathname = await evaluate(cdp, 'location.pathname + location.search');
          const text = (await evaluate(cdp, 'document.body.innerText || ""')).replace(/\s+/g, ' ');
          return {
            ok: pathname.includes('/tasks/ai'),
            note: `注入后 URL=${pathname}（未跳登录页=${!pathname.includes('/login')}）仍能看到任务内容=${text.includes('工具调用决定')}`,
          };
        });
      } finally {
        // 无论断言结果如何都要关掉注入，避免污染后续检查。
        await fetch(`${CHAT_URL}/control/inject`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: null }),
        }).catch(() => {});
      }
    },
  });

  // ---------------- 失效注入（session）：回到登录页（21） ----------------
  // 放最后：会话失效注入会推进本机令牌世代，令当前令牌真的失效。
  await runGroup({
    port: 9416,
    checks: ['21. 注入会话失效：触发 /api 请求后客户端回到 /login'],
    fn: async ({ cdp }) => {
      try {
        await step('21. 注入会话失效：触发 /api 请求后客户端回到 /login', async () => {
          await login(cdp);
          // 先离开应用页面，避免登录页之外的后台请求提前消耗这一次注入。
          await goto(cdp, 'about:blank', 500);
          const inject = await fetch(`${CHAT_URL}/control/inject`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: '*', mode: 'session', remaining: 1 }),
          });
          if (!inject.ok) throw new Error(`注入开关未生效：${inject.status}`);

          await goto(cdp, `${APP_URL}/workbench`, 1500);
          const atLogin = await waitFor(cdp, `location.pathname === '/login'`, { timeoutMs: 25000 });
          const pathname = await evaluate(cdp, 'location.pathname');
          return { ok: Boolean(atLogin), note: `最终 URL=${pathname}` };
        });
      } finally {
        await fetch(`${CHAT_URL}/control/inject`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: null }),
        }).catch(() => {});
      }
    },
  });
}

try {
  await main();
} catch (error) {
  check('自检脚本未抛异常', false, reason(error));
} finally {
  const failures = failed();
  console.log(
    `\n环境自检汇总：通过 ${results.length - failures.length}/${results.length}${failures.length > 0 ? `；失败项：${failures.map((item) => item.name).join('；')}` : ''}`,
  );
  process.exitCode = failures.length === 0 ? 0 : 1;
}
