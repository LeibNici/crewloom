#!/usr/bin/env node
/**
 * 真实浏览器回归（51 轮）：上下文预览行显示 / 编辑保存读回 / 会话列表中文。
 *
 * 只打本机受控环境（默认 5340 → 5418），不外呼、不改 window flag、不注入 localStorage。
 *
 * 用法：
 *   CREWLOOM_APP_URL=http://127.0.0.1:5340 CREWLOOM_CHAT_URL=http://127.0.0.1:5418 \
 *     node scripts/check-main-chat-51-browser.mjs
 *
 * 退出码 0 = 全部通过。
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

const APP_URL = (process.env.CREWLOOM_APP_URL ?? 'http://127.0.0.1:5340').replace(/\/$/, '');
const CHAT_URL = (process.env.CREWLOOM_CHAT_URL ?? 'http://127.0.0.1:5418').replace(/\/$/, '');
const ACCOUNT = { email: 'zhangsan@fixture.local', password: 'fixture' };
const FRAME = '[data-testid="native-chatbox-frame"]';
const PREVIEW_BUTTON = '[data-testid="context-datasource-preview"]';
const PREVIEW_TABLE = '[data-testid="context-datasource-preview-table"]';
const TITLE_INPUT = '[data-testid="context-datasource-title"]';
const CREATED_TITLE = `合成报销范围·51-${Date.now()}`;
const NEW_TITLE = `${CREATED_TITLE}-已改`;

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
  return mouseClickSelector(cdp, `${FRAME} button`, index, { settleMs: 700 });
}

const bodyText = (cdp) => evaluate(cdp, 'document.body.innerText || ""');

/** 按**精确文本**真实点击按钮（includes 会误命中标题里带同样字的行按钮）。 */
async function clickButtonExact(cdp, label) {
  const index = await evaluate(
    cdp,
    `(() => {
      const list = [...document.querySelectorAll('button')];
      return list.findIndex((b) => (b.innerText || '').trim() === ${JSON.stringify(label)});
    })()`,
  );
  if (index < 0) throw new Error(`找不到按钮：${label}`);
  return mouseClickSelector(cdp, 'button', index, { settleMs: 400 });
}

async function controlLog() {
  const response = await fetch(`${CHAT_URL}/__crewloom/controlled-log`);
  return response.json();
}

async function main() {
  // 先用夹具 HTTP 建一条真实的 expenses 数据范围，供产品页预览/编辑使用。
  const created = await fetch(`${CHAT_URL}/api/aiContextDatasources:create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: CREATED_TITLE,
      datasource: 'main',
      collectionName: 'expenses',
      fields: ['id', 'amount'],
      filter: null,
      sort: null,
      limit: 20,
    }),
  }).then((response) => response.json());
  const recordId = created?.data?.id ?? null;
  check('0a. 夹具真实创建 expenses 数据范围', typeof recordId === 'string' && recordId.length > 0, `id=${recordId}`);

  let browser = null;
  try {
    browser = await launchBrowser({ debugPort: 9441, width: 1440, height: 1000 });
  } catch (error) {
    check('0b. headless Chrome 启动', false, reason(error));
    return;
  }
  const { cdp } = browser;
  try {
    await login(cdp);

    // D. 会话列表中文：Conversations / Workflow tasks 不再英文。
    await goto(cdp, `${APP_URL}/ai/conversations`, 4500);
    const mounted = await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(FRAME)}))`, { timeoutMs: 25000 });
    check('1a. 原生 ChatBox 挂载', mounted);
    if (mounted) {
      await sleep(2000);
      await clickFrameButton(cdp, '会话列表');
      await sleep(800);
      const text = await bodyText(cdp);
      check(
        '1b. 会话列表页签是中文「会话」「流程待办」',
        text.includes('会话') && text.includes('流程待办'),
        text.slice(0, 120).replace(/\n/g, ' '),
      );
      check('1c. 不再出现英文 Conversations / Workflow tasks', !text.includes('Conversations') && !text.includes('Workflow tasks'));
    }

    // B/C. 上下文预览行显示 + 编辑保存读回。
    await goto(cdp, `${APP_URL}/ai/context`, 4500);
    const previewReady = await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(PREVIEW_BUTTON)}))`, {
      timeoutMs: 25000,
    });
    check('2a. 上下文页加载出数据范围预览入口', previewReady);
    if (previewReady) {
      await mouseClickSelector(cdp, PREVIEW_BUTTON, 0, { settleMs: 600 });
      await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(PREVIEW_TABLE)}))`, { timeoutMs: 15000 });
      const previewText = await evaluate(
        cdp,
        `(document.querySelector(${JSON.stringify(PREVIEW_TABLE)}) || {}).innerText || ''`,
      );
      check(
        '2b. 预览表显示真实字段值 amount=128 / amount=256（不是每行 —）',
        previewText.includes('amount=128') && previewText.includes('amount=256'),
        previewText.replace(/\n/g, ' | ').slice(0, 160),
      );
      check('2c. 预览总数显示 2', previewText.includes('范围内的记录总数：2') || (await bodyText(cdp)).includes('范围内的记录总数：2'));

      // 编辑**本次创建的那条**：先点它自己的行，再改标题保存，界面重新读回。
      const rowIndex = await evaluate(
        cdp,
        `(() => {
          const rows = [...document.querySelectorAll('[data-testid="context-datasource-row"]')];
          return rows.findIndex((row) => (row.innerText || '').includes(${JSON.stringify(CREATED_TITLE)}));
        })()`,
      );
      if (rowIndex < 0) throw new Error('列表里找不到本次创建的数据范围');
      await mouseClickSelector(cdp, '[data-testid="context-datasource-row"]', rowIndex, { settleMs: 500 });
      await clickButtonExact(cdp, '编辑');
      check('2d. 打开编辑表单', await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(TITLE_INPUT)}))`, { timeoutMs: 10000 }));
      // 清空后再输入（macOS 上 typeInto 的 Ctrl+A 不会全选，直接输入会追加）。
      await evaluate(
        cdp,
        `(() => {
          const el = document.querySelector(${JSON.stringify(TITLE_INPUT)});
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, '');
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return el.value;
        })()`,
      );
      await typeInto(cdp, TITLE_INPUT, NEW_TITLE);
      await sleep(200);
      await clickButtonExact(cdp, '保存');
      check('2e. 点击保存', true);
      const savedOk = await waitFor(cdp, `(document.body.innerText || '').includes(${JSON.stringify(NEW_TITLE)})`, {
        timeoutMs: 15000,
      });
      const afterText = await bodyText(cdp);
      check('2f. 保存后界面重新读回新标题', savedOk, afterText.slice(0, 120).replace(/\n/g, ' '));
      check('2g. 没有出现保存失败/服务不可用提示', !afterText.includes('保存失败') && !afterText.includes('服务暂时不可用'));

      const log = await controlLog();
      const updated = (log.entries ?? []).filter((entry) => entry.kind === 'context-update');
      check(
        '2h. 夹具真实记录到 context-update（本地状态已变，不是 501/空成功）',
        updated.some((entry) => entry.title === NEW_TITLE),
        JSON.stringify(updated.slice(-1)),
      );

      // 整页刷新后仍在（从夹具重新读取）。
      await goto(cdp, `${APP_URL}/ai/context`, 4500);
      const persisted = await waitFor(cdp, `(document.body.innerText || '').includes(${JSON.stringify(NEW_TITLE)})`, {
        timeoutMs: 20000,
      });
      check('2i. 刷新后编辑结果仍在（fixture update/get/list 真实状态）', persisted);
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
