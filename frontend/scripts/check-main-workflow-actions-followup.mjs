#!/usr/bin/env node
/**
 * 53 轮**定向**行为核对（本机 5351 product 预览 + 5421 合成后端）。
 *
 * 只盯 Main 报的三件事，不重复 46 号的 19 项与 40 号的 59 项已通过项：
 *  1. 「上移 / 下移」必须有**真实落点**与完整 chain（不能点了零请求、却当成功）；
 *  2. 「删除分支」按真实原生契约分流：condition 的分支不给删；multi-conditions 先确认、
 *     取消不发写、确认才发一条 destroyBranch + 一条 config 同步；
 *  3. 已执行版本的只读边界覆盖**所有**改动作按钮；版本切换清掉上一版本的成功提示与写错误。
 *
 * 用法（服务已在跑）：
 *   CREWLOOM_FIXTURE_URL=http://127.0.0.1:5421 CREWLOOM_APP_URL=http://127.0.0.1:5351 \
 *     node scripts/check-main-workflow-actions-followup.mjs
 *
 * 性质：本脚本只是**开发证据**，正式验收由 Main 在内置浏览器里亲自点击完成。
 * 全部请求只到本机 5421/5351，不碰真实 13000，不外呼，不调用模型。
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  evaluate,
  goto,
  launchBrowser,
  mouseClickSelector,
  screenshot,
  sleep,
  waitFor,
} from './lib/cdp-browser.mjs';

const FIXTURE = process.env.CREWLOOM_FIXTURE_URL ?? 'http://127.0.0.1:5421';
const APP = process.env.CREWLOOM_APP_URL ?? 'http://127.0.0.1:5351';
const ACCOUNT = { email: process.env.CREWLOOM_FIXTURE_EMAIL ?? 'zhangsan@fixture.local', password: 'fixture' };
const DRAFT_ID = '900000000000001';
const EXECUTED_ID = '900000000000002';
const WIDE_ID = '900000000000005';
const BRANCH_FLOW_ID = '900000000000006';
const SHOT_DIR = process.env.CREWLOOM_SHOT_DIR ?? join(process.cwd(), '.shots', 'workflow-actions-followup');
const CANVAS = '[data-testid="native-workflow-canvas"]';

const results = [];
function check(name, ok, note = '') {
  results.push({ name, ok: Boolean(ok), note });
  console.log(`CHECK ${ok ? 'PASS' : 'FAIL'} ${name}${note ? ` — ${note}` : ''}`);
}

async function fixtureCall(path, options = {}) {
  const response = await fetch(`${FIXTURE}${path}`, options);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

const jsonPost = (payload, headers = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(payload),
});

/** 从入口沿 `downstreamId` 的直线链（分支头不在这条链上，由分支自己渲染）。 */
function linearChain(rows) {
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const entry = rows.find((row) => !row.upstreamId || !byId.has(String(row.upstreamId)));
  const seen = new Set();
  const chain = [];
  for (let cursor = entry; cursor && !seen.has(String(cursor.id)); cursor = byId.get(String(cursor.downstreamId))) {
    seen.add(String(cursor.id));
    chain.push(String(cursor.id));
  }
  return chain;
}

/** 从某个分支头沿 `downstreamId` 的路径链（真实画布里一条处理路径的渲染顺序）。 */
function pathChain(rows, headId) {
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const seen = new Set();
  const chain = [];
  for (
    let cursor = byId.get(String(headId));
    cursor && !seen.has(String(cursor.id));
    cursor = byId.get(String(cursor.downstreamId))
  ) {
    seen.add(String(cursor.id));
    chain.push(String(cursor.id));
  }
  return chain;
}

/** 用页面内表达式给目标元素打标记，再用**真实鼠标**点击（避免 DOM .click() 冒充用户点击）。 */
async function markAndClick(cdp, findExpression, settleMs = 2000) {
  const marked = await evaluate(
    cdp,
    `(() => {
      document.querySelectorAll('[data-crewloom-target]').forEach((el) => el.removeAttribute('data-crewloom-target'));
      const target = ${findExpression};
      if (!target) return false;
      target.setAttribute('data-crewloom-target', '1');
      return true;
    })()`,
  );
  if (!marked) return false;
  await mouseClickSelector(cdp, '[data-crewloom-target="1"]', 0, { settleMs });
  return true;
}

/**
 * 真实鼠标点击，但先把目标滚到视口**正中**再点。
 *
 * 顶部栏是 sticky：`markAndClick` 只看"是否在视口内"，贴顶的行（例如页面较长、
 * 前一步"取消"把滚动位置留在下方时）会被顶部栏盖住，鼠标事件落到顶部栏上。
 * 这里显式居中并关掉 helper 的自动滚动，保证点到的就是目标本身。
 */
async function markAndCenterClick(cdp, findExpression, settleMs = 2000) {
  const marked = await evaluate(
    cdp,
    `(() => {
      document.querySelectorAll('[data-crewloom-target]').forEach((el) => el.removeAttribute('data-crewloom-target'));
      const target = ${findExpression};
      if (!target) return false;
      target.setAttribute('data-crewloom-target', '1');
      target.scrollIntoView({ block: 'center', inline: 'center' });
      return true;
    })()`,
  );
  if (!marked) return false;
  await sleep(300);
  await mouseClickSelector(cdp, '[data-crewloom-target="1"]', 0, { settleMs, autoScroll: false });
  return true;
}

/** 宿主「节点处理顺序」里含 `rowText` 的那一行上的按钮表达式。 */
function rowButtonExpression(rowText, buttonText) {
  return `(() => {
    const row = [...document.querySelectorAll('div')].filter(
      (el) =>
        !el.closest('${CANVAS}') &&
        (el.innerText || '').includes(${JSON.stringify(rowText)}) &&
        el.querySelector('button')
    ).at(-1);
    return [...(row?.querySelectorAll('button') ?? [])].find(
      (b) => (b.innerText || '').replace(/\\s/g, '') === ${JSON.stringify(buttonText)}
    );
  })()`;
}

/** 宿主顺序列表的行标题（产品页自己的辅助清单）。 */
function hostRowTitlesExpression() {
  return `[...document.querySelectorAll('[class*="canvasNodeTitle"]')].map((el) => (el.textContent || '').trim())`;
}

/** 宿主顺序列表里某个按钮的 { exists, disabled } 汇总。 */
function hostButtonsExpression(names) {
  return `(() => {
    const wanted = ${JSON.stringify(names)};
    const rows = [];
    for (const name of wanted) {
      const found = [...document.querySelectorAll('button')].filter(
        (b) => !b.closest('${CANVAS}') && (b.innerText || '').replace(/\\s/g, '') === name
      );
      rows.push({ name, count: found.length, disabled: found.map((b) => b.disabled) });
    }
    return rows;
  })()`;
}

/** 原生 header 版本下拉切版本（真实用户路径：onVersionChange → 产品页 setParams）。 */
async function switchNativeVersion(cdp, targetId) {
  await mouseClickSelector(cdp, `${CANVAS} button[aria-label="version"]`, 0, { settleMs: 900 });
  const opened = await waitFor(cdp, `document.querySelectorAll('.ant-dropdown-menu-item').length > 0`, {
    timeoutMs: 10000,
  });
  if (!opened) return false;
  return markAndClick(
    cdp,
    `[...document.querySelectorAll('.ant-dropdown-menu-item')].find((el) => (el.innerText || '').includes(${JSON.stringify(
      `#${targetId}`,
    )}))`,
    2800,
  );
}

async function run() {
  // ---------- 0. 本机合成环境准备（重置 + 造 Main 同形的链：calc → script → condition → 两分支） ----------
  await fixtureCall('/control/reset', jsonPost({}));
  const signIn = await fixtureCall('/api/auth:signIn', jsonPost({ email: ACCOUNT.email, password: ACCOUNT.password }));
  const token = signIn.body?.data?.token;
  check('C0 本机合成后端可登录（5421，无真实后端）', signIn.status === 200 && typeof token === 'string');
  const auth = { authorization: `Bearer ${token}` };

  const listNodes = async (workflowId = DRAFT_ID) => {
    const res = await fixtureCall(
      `/api/flow_nodes:list?filter=${encodeURIComponent(JSON.stringify({ workflowId }))}&pageSize=200&sort%5B%5D=id`,
      { headers: auth },
    );
    return res.body?.data ?? [];
  };

  const seeded = await listNodes();
  const calc = seeded.find((row) => row.type === 'calculation');
  const createdScript = await fixtureCall(`/api/workflows/${DRAFT_ID}/nodes:create`, {
    ...jsonPost({ type: 'script', title: '检查脚本', config: { content: 'return 42;' }, upstreamId: calc?.id }, auth),
  });
  const scriptId = String(createdScript.body?.data?.id ?? '');
  const chainBefore = linearChain(await listNodes());
  const conditionNode = (await listNodes()).find((row) => row.type === 'condition');
  check(
    'C0 预置 Main 同形链：计算 → JavaScript → 条件判断（否 / 是）',
    createdScript.status === 200 &&
      scriptId.length > 0 &&
      String(createdScript.body?.data?.upstreamId) === String(calc?.id) &&
      chainBefore.join('→') === `${calc?.id}→${scriptId}→${conditionNode?.id}`,
    `chain=${chainBefore.join('→')}`,
  );

  if (!existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') && !process.env.CHROME_PATH) {
    check('C 真实浏览器核对', false, '没有找到 Chrome（设置 CHROME_PATH）');
    return;
  }
  mkdirSync(SHOT_DIR, { recursive: true });

  const browser = await launchBrowser({
    debugPort: Number(process.env.CREWLOOM_CDP_PORT ?? 9406),
    width: 1440,
    height: 980,
  });
  const { cdp, close, events } = browser;
  try {
    // ---------- 真实登录 ----------
    await goto(cdp, `${APP}/login`, 1200);
    await waitFor(cdp, `Boolean(document.querySelector('input[name="crewloom-account"]'))`, { timeoutMs: 20000 });
    await evaluate(
      cdp,
      `(() => {
        const account = document.querySelector('input[name="crewloom-account"]');
        const secret = document.querySelector('input[name="crewloom-secret"]');
        const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        set.call(account, ${JSON.stringify(ACCOUNT.email)});
        account.dispatchEvent(new Event('input', { bubbles: true }));
        set.call(secret, ${JSON.stringify(ACCOUNT.password)});
        secret.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`,
    );
    await mouseClickSelector(cdp, 'form button[type="submit"]', 0, { settleMs: 1800 });
    const loggedIn = await waitFor(cdp, `!location.pathname.startsWith('/login')`, { timeoutMs: 25000 });
    check('C1 真实登录页用合成账号登录（5421 合成登录）', Boolean(loggedIn), await evaluate(cdp, 'location.pathname'));

    const waitHostReady = async () => {
      const ready = await waitFor(cdp, `Boolean(document.querySelector('${CANVAS} .workflow-canvas'))`, {
        timeoutMs: 30000,
      });
      if (!ready) return false;
      return waitFor(cdp, `document.querySelectorAll('[class*="canvasNodeTitle"]').length > 0`, { timeoutMs: 20000 });
    };

    /* ================= 场景 1：上移 / 下移真实落点 ================= */
    await goto(cdp, `${APP}/workflow/canvas?workflowId=${DRAFT_ID}`, 2500);
    const hostReady = await waitHostReady();
    const canvasCardsBefore = await evaluate(
      cdp,
      `document.querySelectorAll('${CANVAS} [class*="workflow-node-type-"]').length`,
    );
    check('C2 原生画布与宿主顺序列表就绪', Boolean(hostReady) && Number(canvasCardsBefore) >= 5, `画布卡片=${canvasCardsBefore}`);

    const moveBefore = events.apiRequests.length;
    const upClicked = await markAndClick(cdp, rowButtonExpression('检查脚本', '上移'), 2600);
    const upMoves = events.apiRequests
      .slice(moveBefore)
      .filter((entry) => entry.url.includes('flow_nodes:move'));
    const upBody = String(upMoves[0]?.postData ?? '');
    check(
      'S1 第 2 行「上移」发出真实 move（不是零请求的 no-op）',
      upClicked && upMoves.length === 1 && upMoves[0].method === 'POST' && upMoves[0].status === 200,
      upMoves.length ? `${upMoves[0].method} ${upMoves[0].status} body=${upBody.slice(0, 80)}` : '未捕获 move 请求',
    );
    check(
      'S1 上移落点正确：移动的是 JavaScript 节点、目标是流程起点（upstreamId=null）',
      upMoves.length === 1 &&
        String(upMoves[0].url).includes(`filterByTk=${scriptId}`) &&
        /"upstreamId":null/.test(upBody.replace(/\s/g, '')),
      `filterByTk=${scriptId} body=${upBody.replace(/\s/g, '')}`,
    );

    const nodesAfterUp = await listNodes();
    const chainAfterUp = linearChain(nodesAfterUp);
    const scriptRow = nodesAfterUp.find((row) => String(row.id) === scriptId);
    const calcRow = nodesAfterUp.find((row) => String(row.id) === String(calc?.id));
    check(
      'S1 上移后 HTTP 链真实改变且整条连续：JavaScript 成为首节点，计算节点改接在它之后',
      String(scriptRow?.upstreamId ?? 'null') === 'null' &&
        String(calcRow?.upstreamId) === scriptId &&
        chainAfterUp.join('→') === `${scriptId}→${calc?.id}→${conditionNode?.id}` &&
        chainAfterUp.length === chainBefore.length &&
        new Set(nodesAfterUp.map((row) => String(row.id))).size === nodesAfterUp.length,
      `chain=${chainBefore.join('→')} ⇒ ${chainAfterUp.join('→')}`,
    );

    const hostTitlesAfterUp = await evaluate(cdp, hostRowTitlesExpression());
    const canvasCardsAfterUp = await evaluate(
      cdp,
      `document.querySelectorAll('${CANVAS} [class*="workflow-node-type-"]').length`,
    );
    const canvasWholeAfterUp = await evaluate(
      cdp,
      `(() => {
        const text = document.querySelector('${CANVAS}').innerText || '';
        return ['计算', 'JavaScript', '条件判断', '流程输出'].filter((title) => text.includes(title));
      })()`,
    );
    check(
      'S1 上移后宿主首行与原生画布都是新的完整顺序（画布没有断链/丢节点）',
      Array.isArray(hostTitlesAfterUp) &&
        hostTitlesAfterUp[0] === '检查脚本' &&
        Number(canvasCardsAfterUp) === Number(canvasCardsBefore) &&
        Array.isArray(canvasWholeAfterUp) &&
        canvasWholeAfterUp.length >= 4,
      `宿主首行=${hostTitlesAfterUp?.[0]} 画布=${canvasCardsBefore}→${canvasCardsAfterUp} 可见=${JSON.stringify(canvasWholeAfterUp)}`,
    );
    await screenshot(cdp, join(SHOT_DIR, '01-move-up-real-landing.png'));

    const moveDownBefore = events.apiRequests.length;
    const downClicked = await markAndClick(cdp, rowButtonExpression('检查脚本', '下移'), 2600);
    const downMoves = events.apiRequests
      .slice(moveDownBefore)
      .filter((entry) => entry.url.includes('flow_nodes:move'));
    const downBody = String(downMoves[0]?.postData ?? '');
    const chainAfterDown = linearChain(await listNodes());
    check(
      'S1 首项「下移」同样有真实落点：把计算节点换回流程起点，链回到原顺序',
      downClicked &&
        downMoves.length === 1 &&
        downMoves[0].status === 200 &&
        String(downMoves[0].url).includes(`filterByTk=${calc?.id}`) &&
        /"upstreamId":null/.test(downBody.replace(/\s/g, '')) &&
        chainAfterDown.join('→') === chainBefore.join('→'),
      `filterByTk=${calc?.id} chain=${chainAfterDown.join('→')}`,
    );

    /* ================= 场景 2：分支删除的契约与取消 ================= */
    const branchButtons = await evaluate(cdp, hostButtonsExpression(['删除分支']));
    const branchDisabled = Array.isArray(branchButtons) && branchButtons[0]?.count >= 2 && branchButtons[0]?.disabled.every(Boolean);
    const conditionHint = await evaluate(
      cdp,
      `[...document.querySelectorAll('[class*="cellHint"]')].some((el) => (el.textContent || '').includes('两条处理路径需要保留'))`,
    );
    check(
      'S2 condition 的分支头「删除分支」全部禁用，并显示业务语言原因（不是可点无效入口，也不出现内部术语）',
      Boolean(branchDisabled) && conditionHint === true,
      `buttons=${JSON.stringify(branchButtons)} hint=${conditionHint}`,
    );
    const conditionBranchBefore = events.apiRequests.length;
    await markAndClick(cdp, rowButtonExpression('处理结果', '删除分支'), 1400);
    const conditionBranchWrites = events.apiRequests
      .slice(conditionBranchBefore)
      .filter((entry) => entry.url.includes('flow_nodes:destroyBranch'));
    check(
      'S2 点击被禁用的 condition「删除分支」不会发出任何写请求',
      conditionBranchWrites.length === 0,
      `destroyBranch=${conditionBranchWrites.length}`,
    );
    await screenshot(cdp, join(SHOT_DIR, '02-condition-branch-not-deletable.png'));

    // multi-conditions（WIDE 版本）才是原生确证支持删除分支的类型。
    await goto(cdp, `${APP}/workflow/canvas?workflowId=${WIDE_ID}`, 2500);
    await waitHostReady();
    const wideNodesBefore = await listNodes(WIDE_ID);
    const wideBranch = wideNodesBefore.find((row) => row.type === 'multi-conditions');
    const wideHeadsBefore = wideNodesBefore
      .filter((row) => String(row.upstreamId) === String(wideBranch?.id) && row.branchIndex !== null)
      .map((row) => row.branchIndex)
      .sort((a, b) => a - b);

    /* ===== 场景 2c：同一处理路径内的相邻交换（Main 000005 的窄边界） ===== */
    // 000005 每条处理路径有两个串行步骤（处理 → 收尾）。53 §7.3 把它们一律禁用，
    // 这里按真实 `move` 契约证明"同一路径内相邻交换"可用且可逆。
    const wideMidHead = wideNodesBefore.find(
      (row) => String(row.upstreamId) === String(wideBranch?.id) && row.branchIndex === 2,
    );
    const wideMidTail = wideNodesBefore.find(
      (row) => String(row.upstreamId) === String(wideMidHead?.id) && row.branchIndex === null,
    );
    const wideLeftHead = wideNodesBefore.find(
      (row) => String(row.upstreamId) === String(wideBranch?.id) && row.branchIndex === 1,
    );
    const wideRightHead = wideNodesBefore.find(
      (row) => String(row.upstreamId) === String(wideBranch?.id) && row.branchIndex === 3,
    );
    const midRowButtons = (rowText) =>
      evaluate(
        cdp,
        `(() => {
          const row = [...document.querySelectorAll('div')].filter(
            (el) => !el.closest('${CANVAS}') && (el.innerText || '').includes(${JSON.stringify(rowText)}) && el.querySelector('button')
          ).at(-1);
          return [...(row?.querySelectorAll('button') ?? [])]
            .filter((b) => ['上移', '下移'].includes((b.innerText || '').trim()))
            .map((b) => ({ name: (b.innerText || '').trim(), disabled: b.disabled, title: b.title }));
        })()`,
      );
    const canvasCardsMidBefore = await evaluate(
      cdp,
      `document.querySelectorAll('${CANVAS} [class*="workflow-node-type-"]').length`,
    );
    const tailButtonsBefore = await midRowButtons('宽·中路收尾');
    const headButtonsBefore = await midRowButtons('宽·中路处理');
    const pick = (list, name) => (Array.isArray(list) ? list.find((item) => item.name === name) : undefined);
    check(
      'S2c 路径内的两个串行步骤：第二步可上移（不是被统一禁用），第一步不能上移出路径、第二步不能下移出路径，说明是业务语言',
      Boolean(wideMidHead) &&
        Boolean(wideMidTail) &&
        JSON.stringify(pathChain(wideNodesBefore, wideMidHead?.id)) ===
          JSON.stringify([wideMidHead?.id, wideMidTail?.id].map(String)) &&
        pick(tailButtonsBefore, '上移')?.disabled === false &&
        pick(tailButtonsBefore, '下移')?.disabled === true &&
        String(pick(tailButtonsBefore, '下移')?.title ?? '').includes('这条处理路径的最后一步') &&
        pick(headButtonsBefore, '上移')?.disabled === true &&
        String(pick(headButtonsBefore, '上移')?.title ?? '').includes('这条处理路径的第一步') &&
        pick(headButtonsBefore, '下移')?.disabled === false &&
        [tailButtonsBefore, headButtonsBefore].every((list) =>
          (list ?? []).every((item) => !/branchIndex|shift|原生|multi-conditions|分支父节点/.test(item.title)),
        ),
      `路2链=${pathChain(wideNodesBefore, wideMidHead?.id).join('→')} 收尾=${JSON.stringify(tailButtonsBefore)} 处理=${JSON.stringify(headButtonsBefore)}`,
    );

    const midUpBefore = events.apiRequests.length;
    const midUpClicked = await markAndClick(cdp, rowButtonExpression('宽·中路收尾', '上移'), 2600);
    const midUpMoves = events.apiRequests.slice(midUpBefore).filter((entry) => entry.url.includes('flow_nodes:move'));
    const midUpBody = String(midUpMoves[0]?.postData ?? '').replace(/\s/g, '');
    check(
      'S2c 第二步「上移」发出恰好一条真实 move，落点是它上一步原来的位置并承接该路径序号（branchIndex=2）',
      midUpClicked &&
        midUpMoves.length === 1 &&
        midUpMoves[0].status === 200 &&
        String(midUpMoves[0].url).includes(`filterByTk=${wideMidTail?.id}`) &&
        midUpBody.includes(`"upstreamId":"${wideBranch?.id}"`) &&
        midUpBody.includes('"branchIndex":2'),
      `filterByTk=${wideMidTail?.id} body=${midUpBody}`,
    );

    const wideMidAfter = await listNodes(WIDE_ID);
    const midHeadAfter = wideMidAfter.find(
      (row) => String(row.upstreamId) === String(wideBranch?.id) && row.branchIndex === 2,
    );
    const midOldHeadAfter = wideMidAfter.find((row) => String(row.id) === String(wideMidHead?.id));
    const midLeftAfter = wideMidAfter.find(
      (row) => String(row.upstreamId) === String(wideBranch?.id) && row.branchIndex === 1,
    );
    const midRightAfter = wideMidAfter.find(
      (row) => String(row.upstreamId) === String(wideBranch?.id) && row.branchIndex === 3,
    );
    const canvasCardsMidAfter = await evaluate(
      cdp,
      `document.querySelectorAll('${CANVAS} [class*="workflow-node-type-"]').length`,
    );
    check(
      'S2c 上移后：路径 2 仍是同一条完整路径（收尾接管首位、处理成为它的续行），序号 2 与挂靠条件不变，左右两路与画布完整',
      String(midHeadAfter?.id) === String(wideMidTail?.id) &&
        midHeadAfter?.branchIndex === 2 &&
        String(midOldHeadAfter?.upstreamId) === String(wideMidTail?.id) &&
        midOldHeadAfter?.branchIndex === null &&
        JSON.stringify(pathChain(wideMidAfter, wideMidTail?.id)) ===
          JSON.stringify([wideMidTail?.id, wideMidHead?.id].map(String)) &&
        String(midLeftAfter?.id) === String(wideLeftHead?.id) &&
        String(midRightAfter?.id) === String(wideRightHead?.id) &&
        Number(canvasCardsMidAfter) === wideNodesBefore.length &&
        Number(canvasCardsMidBefore) === wideNodesBefore.length,
      `路2首位=${midHeadAfter?.id}/序号${midHeadAfter?.branchIndex} 链=${pathChain(wideMidAfter, wideMidTail?.id).join('→')} 画布=${canvasCardsMidAfter}/${wideNodesBefore.length}`,
    );
    await screenshot(cdp, join(SHOT_DIR, '06-wide-branch-path-internal-move.png'));

    const midDownBefore = events.apiRequests.length;
    const midDownClicked = await markAndClick(cdp, rowButtonExpression('宽·中路收尾', '下移'), 2600);
    const midDownMoves = events.apiRequests.slice(midDownBefore).filter((entry) => entry.url.includes('flow_nodes:move'));
    const wideMidRestored = await listNodes(WIDE_ID);
    const midHeadRestored = wideMidRestored.find(
      (row) => String(row.upstreamId) === String(wideBranch?.id) && row.branchIndex === 2,
    );
    check(
      'S2c 再「下移」一次即换回原顺序（往返可逆），路径序号仍为 2、左右两路未动',
      midDownClicked &&
        midDownMoves.length === 1 &&
        midDownMoves[0].status === 200 &&
        String(midHeadRestored?.id) === String(wideMidHead?.id) &&
        String(wideMidRestored.find((row) => String(row.id) === String(wideMidTail?.id))?.upstreamId) ===
          String(wideMidHead?.id) &&
        JSON.stringify(wideHeadsBefore) === JSON.stringify([1, 2, 3]) &&
        String(
          wideMidRestored.find((row) => String(row.upstreamId) === String(wideBranch?.id) && row.branchIndex === 1)?.id,
        ) === String(wideLeftHead?.id),
      `路2首位=${midHeadRestored?.id} 链=${pathChain(wideMidRestored, wideMidHead?.id).join('→')}`,
    );

    const wideOpenBefore = events.apiRequests.length;
    const openConfirm = await markAndCenterClick(cdp, rowButtonExpression('宽·左路处理', '删除分支'), 1200);
    const confirmShown = await waitFor(cdp, `document.body.innerText.includes('删除分支「宽·左路处理」')`, {
      timeoutMs: 8000,
    });
    const writesWhileConfirm = events.apiRequests
      .slice(wideOpenBefore)
      .filter((entry) => entry.url.includes('flow_nodes:destroyBranch'));
    check(
      'S2 multi-conditions 点「删除分支」先出确认面板，未确认前零写请求',
      openConfirm && Boolean(confirmShown) && writesWhileConfirm.length === 0,
      `confirm=${Boolean(confirmShown)} destroyBranch=${writesWhileConfirm.length}`,
    );

    const cancelBefore = events.apiRequests.length;
    await markAndClick(cdp, `[...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === '取消' && !b.closest('.ant-drawer-content'))`, 1200);
    const confirmGone = await evaluate(cdp, `!document.body.innerText.includes('删除分支「宽·左路处理」')`);
    const writesAfterCancel = events.apiRequests
      .slice(cancelBefore)
      .filter((entry) => entry.url.includes('flow_nodes:destroyBranch'));
    check(
      'S2 取消后仍零写请求，确认面板关闭',
      Boolean(confirmGone) && writesAfterCancel.length === 0,
      `面板关闭=${Boolean(confirmGone)} destroyBranch=${writesAfterCancel.length}`,
    );

    const confirmDeleteBefore = events.apiRequests.length;
    const reopenClicked = await markAndCenterClick(cdp, rowButtonExpression('宽·左路处理', '删除分支'), 1200);
    const confirmShownAgain = await waitFor(cdp, `document.body.innerText.includes('删除分支「宽·左路处理」')`, { timeoutMs: 8000 });
    check(
      'S2 取消后可再次打开确认面板（同一个真实入口）',
      reopenClicked && Boolean(confirmShownAgain),
      `reopen=${reopenClicked} confirm=${Boolean(confirmShownAgain)}`,
    );
    await markAndClick(
      cdp,
      `[...document.querySelectorAll('button')].find((b) => (b.innerText || '').replace(/\\s/g, '') === '确认删除')`,
      2800,
    );
    const confirmDeleteWrites = events.apiRequests.slice(confirmDeleteBefore);
    const destroyCalls = confirmDeleteWrites.filter((entry) => entry.url.includes('flow_nodes:destroyBranch'));
    const configUpdates = confirmDeleteWrites.filter(
      (entry) => entry.url.includes('flow_nodes:update') && String(entry.postData ?? '').includes('conditions'),
    );
    check(
      'S2 确认后恰好一条 destroyBranch（上游 id + branchIndex=1 + shift=1）+ 一条条件配置同步',
      destroyCalls.length === 1 &&
        destroyCalls[0].status === 200 &&
        String(destroyCalls[0].url).includes(`filterByTk=${wideBranch?.id}`) &&
        String(destroyCalls[0].url).includes('branchIndex=1') &&
        String(destroyCalls[0].url).includes('shift=1') &&
        configUpdates.length === 1,
      `destroyBranch=${destroyCalls.length} url=${String(destroyCalls[0]?.url || '').split('?')[1] ?? ''} configUpdate=${configUpdates.length}`,
    );

    const wideNodesAfter = await listNodes(WIDE_ID);
    const wideHeadsAfter = wideNodesAfter
      .filter((row) => String(row.upstreamId) === String(wideBranch?.id) && row.branchIndex !== null)
      .map((row) => row.branchIndex)
      .sort((a, b) => a - b);
    const configAfter = wideNodesAfter.find((row) => String(row.id) === String(wideBranch?.id))?.config?.conditions ?? [];
    const canvasCardsWide = await evaluate(
      cdp,
      `document.querySelectorAll('${CANVAS} [class*="workflow-node-type-"]').length`,
    );
    check(
      'S2 删除后分支结构按契约前移：条件 2/3 → 1/2，条件配置同步为 2 条，画布仍完整',
      JSON.stringify(wideHeadsBefore) === JSON.stringify([1, 2, 3]) &&
        JSON.stringify(wideHeadsAfter) === JSON.stringify([1, 2]) &&
        Array.isArray(configAfter) &&
        configAfter.length === 2 &&
        Number(canvasCardsWide) === wideNodesAfter.length,
      `heads=${JSON.stringify(wideHeadsBefore)}→${JSON.stringify(wideHeadsAfter)} conditions=${configAfter.length} 画布卡片=${canvasCardsWide}/${wideNodesAfter.length}`,
    );
    await screenshot(cdp, join(SHOT_DIR, '03-multicondition-branch-deleted.png'));

    /* ========= 场景 2b：真实「分支 + 线性续行」图上的整体交换与往返 ========= */
    // 真实 2.2.20 允许条件节点既有两条处理路径、又有一条线性续行（汇合点）。
    // 早期 fixture 表达不了这种图，产品因此把真实后端允许的整体上移误禁用；这里用真实 UI 核对。
    await goto(cdp, `${APP}/workflow/canvas?workflowId=${BRANCH_FLOW_ID}`, 2500);
    await waitHostReady();
    const branchFlowBefore = await listNodes(BRANCH_FLOW_ID);
    const bfCondition = branchFlowBefore.find((row) => row.type === 'condition');
    const bfBoot = branchFlowBefore.find((row) => row.title === '续行·开始');
    const bfPrepare = branchFlowBefore.find((row) => row.title === '续行·准备');
    const bfMerge = branchFlowBefore.find((row) => row.title === '续行·合并');
    const bfTail = branchFlowBefore.find((row) => row.title === '续行·收尾');
    const bfExpectedBefore = [bfBoot?.id, bfPrepare?.id, bfCondition?.id, bfMerge?.id, bfTail?.id].map(String);
    const canvasLabelsBefore = await evaluate(
      cdp,
      `[...document.querySelectorAll('${CANVAS} [role="button"][aria-label]')].map((el) => el.getAttribute('aria-label') || '')`,
    );
    const canvasCardsBeforeBf = await evaluate(
      cdp,
      `document.querySelectorAll('${CANVAS} [class*="workflow-node-type-"]').length`,
    );
    check(
      'S2b 原生画布完整渲染「分支 + 续行」图：7 张卡片，条件之后的续行与收尾都在画布上',
      Number(canvasCardsBeforeBf) === branchFlowBefore.length &&
        branchFlowBefore.every((row) =>
          (canvasLabelsBefore ?? []).some((label) => String(label).includes(String(row.title))),
        ) &&
        linearChain(branchFlowBefore).join('→') === bfExpectedBefore.join('→'),
      `画布卡片=${canvasCardsBeforeBf}/${branchFlowBefore.length} chain=${linearChain(branchFlowBefore).join('→')}`,
    );

    const bfUpBefore = events.apiRequests.length;
    const bfUpClicked = await markAndClick(cdp, rowButtonExpression('续行·是否需要处理', '上移'), 2600);
    const bfUpMoves = events.apiRequests.slice(bfUpBefore).filter((entry) => entry.url.includes('flow_nodes:move'));
    const bfUpBody = String(bfUpMoves[0]?.postData ?? '').replace(/\s/g, '');
    check(
      'S2b 条件整体「上移」发出真实 move，落点是它的上一步（不再因本机表示能力被禁用）',
      bfUpClicked &&
        bfUpMoves.length === 1 &&
        bfUpMoves[0].status === 200 &&
        String(bfUpMoves[0].url).includes(`filterByTk=${bfCondition?.id}`) &&
        bfUpBody.includes(`"upstreamId":"${bfBoot?.id}"`),
      `filterByTk=${bfCondition?.id} body=${bfUpBody}`,
    );

    const bfAfterUp = await listNodes(BRANCH_FLOW_ID);
    const bfChainAfterUp = linearChain(bfAfterUp);
    const bfHeadsAfterUp = bfAfterUp.filter(
      (row) => String(row.upstreamId) === String(bfCondition?.id) && row.branchIndex != null,
    );
    const canvasCardsAfterBf = await evaluate(
      cdp,
      `document.querySelectorAll('${CANVAS} [class*="workflow-node-type-"]').length`,
    );
    const hostTitlesAfterBf = await evaluate(cdp, hostRowTitlesExpression());
    check(
      'S2b 上移后：主序列变为 开始→条件→准备→合并→收尾，"否 / 是"归属与序号不变，续行仍连通',
      bfChainAfterUp.join('→') === [bfBoot?.id, bfCondition?.id, bfPrepare?.id, bfMerge?.id, bfTail?.id].join('→') &&
        bfHeadsAfterUp.length === 2 &&
        bfHeadsAfterUp.map((row) => row.branchIndex).sort((a, b) => a - b).join(',') === '0,1' &&
        bfHeadsAfterUp.every((row) => String(row.upstreamId) === String(bfCondition?.id)) &&
        String(bfAfterUp.find((row) => String(row.id) === String(bfCondition?.id))?.downstreamId) === String(bfPrepare?.id) &&
        bfChainAfterUp.length === 5,
      `chain=${bfChainAfterUp.join('→')} heads=${bfHeadsAfterUp.map((row) => row.branchIndex).join(',')}`,
    );
    check(
      'S2b 上移后画布仍完整、宿主顺序里条件移到「准备」之前（真实 UI 落点）',
      Number(canvasCardsAfterBf) === branchFlowBefore.length &&
        Array.isArray(hostTitlesAfterBf) &&
        hostTitlesAfterBf[1] === '续行·是否需要处理',
      `画布=${canvasCardsAfterBf} 宿主前3=${JSON.stringify((hostTitlesAfterBf ?? []).slice(0, 3))}`,
    );
    await screenshot(cdp, join(SHOT_DIR, '05-branch-flow-condition-moved.png'));

    const bfDownBefore = events.apiRequests.length;
    const bfDownClicked = await markAndClick(cdp, rowButtonExpression('续行·是否需要处理', '下移'), 2600);
    const bfDownMoves = events.apiRequests.slice(bfDownBefore).filter((entry) => entry.url.includes('flow_nodes:move'));
    const bfRestored = await listNodes(BRANCH_FLOW_ID);
    check(
      'S2b 条件再「下移」一次即换回原顺序（往返可逆），分支与续行仍连通',
      bfDownClicked &&
        bfDownMoves.length === 1 &&
        bfDownMoves[0].status === 200 &&
        String(bfDownMoves[0].url).includes(`filterByTk=${bfPrepare?.id}`) &&
        linearChain(bfRestored).join('→') === bfExpectedBefore.join('→') &&
        String(bfRestored.find((row) => row.type === 'condition')?.downstreamId) === String(bfMerge?.id),
      `chain=${linearChain(bfRestored).join('→')}`,
    );

    const bfBranchTitles = await evaluate(
      cdp,
      `(() => {
        const row = [...document.querySelectorAll('div')].filter(
          (el) => !el.closest('${CANVAS}') && (el.innerText || '').includes('续行·否侧处理') && el.querySelector('button')
        ).at(-1);
        return [...(row?.querySelectorAll('button') ?? [])]
          .filter((b) => ['上移', '下移'].includes((b.innerText || '').trim()))
          .map((b) => ({ disabled: b.disabled, title: b.title }));
      })()`,
    );
    check(
      'S2b 单步处理路径（否侧 / 是侧）：上移与下移都因"路径首步 / 尾步"禁用，说明是业务语言（不承诺不存在的拖动）',
      Array.isArray(bfBranchTitles) &&
        bfBranchTitles.length === 2 &&
        bfBranchTitles.every(
          (item) =>
            item.disabled === true &&
            (item.title.includes('这条处理路径的第一步') || item.title.includes('这条处理路径的最后一步')) &&
            !/branchIndex|shift|原生|拖动/.test(item.title),
        ),
      JSON.stringify(bfBranchTitles),
    );

    /* ================= 场景 3：只读边界 + 版本切换清理 ================= */
    await goto(cdp, `${APP}/workflow/canvas?workflowId=${DRAFT_ID}`, 2500);
    await waitHostReady();
    // 先在可写版本上制造一条**成功提示**。
    await markAndClick(cdp, rowButtonExpression('检查脚本', '上移'), 2600);
    const noticeShown = await waitFor(cdp, `document.body.innerText.includes('已调整节点顺序。')`, { timeoutMs: 10000 });
    check('S3 可写版本上的真实动作给出成功提示', Boolean(noticeShown));

    const switched = await switchNativeVersion(cdp, EXECUTED_ID);
    const noticeCleared = await waitFor(cdp, `!document.body.innerText.includes('已调整节点顺序。')`, {
      timeoutMs: 12000,
    });
    check(
      'S3 原生版本下拉切到已执行版本后，上一版本的成功提示被清除',
      switched && Boolean(noticeCleared),
      `switched=${switched} 提示已清=${Boolean(noticeCleared)}`,
    );

    const executedButtons = await evaluate(
      cdp,
      hostButtonsExpression(['添加节点', '上移', '下移', '改接前序', '复制节点', '删除分支', '删除节点']),
    );
    const presentExecuted = (executedButtons ?? []).filter((item) => item.count > 0);
    check(
      'S3 已执行版本：所有出现的改动作按钮都是 disabled（添加/上移/下移/改接/复制/删除节点）',
      presentExecuted.length >= 6 && presentExecuted.every((item) => item.disabled.every(Boolean)),
      JSON.stringify(executedButtons),
    );
    const branchEntryOnExecuted = (executedButtons ?? []).find((item) => item.name === '删除分支');
    check(
      'S3 已执行版本没有可点的「删除分支」入口（该版本没有分支节点，入口不渲染；分支只读边界另有请求级用例）',
      !branchEntryOnExecuted || branchEntryOnExecuted.count === 0 || branchEntryOnExecuted.disabled.every(Boolean),
      `删除分支 count=${branchEntryOnExecuted?.count ?? 0}`,
    );

    const executedWriteBefore = events.apiRequests.length;
    await markAndClick(cdp, rowButtonExpression('已执行节点', '复制节点'), 1200);
    await markAndClick(cdp, rowButtonExpression('已执行节点', '删除节点'), 1200);
    const executedWrites = events.apiRequests
      .slice(executedWriteBefore)
      .filter((entry) => /flow_nodes:(update|move|duplicate|destroy|destroyBranch)/.test(entry.url));
    check(
      'S3 点击已执行版本的改动作按钮不发出任何写请求（不留下必然无效入口）',
      executedWrites.length === 0,
      `writes=${JSON.stringify(executedWrites.map((entry) => entry.url.split('?')[0]))}`,
    );
    await screenshot(cdp, join(SHOT_DIR, '04-executed-readonly.png'));

    // 切回可写版本：按钮恢复、草稿版本数据不受影响（版本隔离）。
    const backToDraft = await switchNativeVersion(cdp, DRAFT_ID);
    const draftButtons = await waitFor(
      cdp,
      `(() => {
        const up = [...document.querySelectorAll('button')].filter((b) => (b.innerText || '').trim() === '上移');
        return up.length > 0 && up.some((b) => !b.disabled) ? 'ok' : '';
      })()`,
      { timeoutMs: 15000 },
    );
    check('S3 切回草稿版本后改动作按钮恢复可用（版本切换不影响草稿数据）', backToDraft && Boolean(draftButtons));

    // 制造一条真实写错误（改接到当前位置 → 服务端 400），再切版本验证旧错误被清。
    const errorBefore = events.apiRequests.length;
    await markAndClick(cdp, rowButtonExpression('检查脚本', '改接前序'), 1000);
    await markAndClick(
      cdp,
      `[...document.querySelectorAll('button')].find((b) => (b.innerText || '').replace(/\\s/g, '') === '确认改接')`,
      2400,
    );
    const failedWrites = events.apiRequests
      .slice(errorBefore)
      .filter((entry) => entry.url.includes('flow_nodes:move') && entry.status >= 400);
    const errorShown = await waitFor(
      cdp,
      `[...document.querySelectorAll('[class*="errorText"]')].some((el) => (el.textContent || '').trim().length > 0)`,
      { timeoutMs: 10000 },
    );
    check(
      'S3 可写版本上的一次真实写失败会显示错误提示（400 不空成功）',
      failedWrites.length >= 1 && Boolean(errorShown),
      `400=${failedWrites.length} errorShown=${Boolean(errorShown)}`,
    );
    const switchedAgain = await switchNativeVersion(cdp, EXECUTED_ID);
    const errorCleared = await waitFor(
      cdp,
      `[...document.querySelectorAll('[class*="errorText"]')].every((el) => (el.textContent || '').trim().length === 0)`,
      { timeoutMs: 12000 },
    );
    check(
      'S3 再切到已执行版本后，上一版本的写错误提示被清除',
      switchedAgain && Boolean(errorCleared),
      `switched=${switchedAgain} 错误已清=${Boolean(errorCleared)}`,
    );

    const unexpected5xx = events.apiRequests.filter((entry) => entry.status >= 500);
    check(
      'C4 全程无未捕获页面异常、无非预期 5xx',
      events.pageErrors.length === 0 && unexpected5xx.length === 0,
      `pageErrors=${events.pageErrors.length} 5xx=${unexpected5xx.length}`,
    );
  } finally {
    try {
      await close();
    } catch {
      /* 关闭失败不影响结果 */
    }
    // 核对完把合成数据放回初始状态：Main 按报告步骤从头点一遍时看到的是干净场景。
    await fixtureCall('/control/reset', jsonPost({}));
  }
}

run()
  .catch((error) => {
    check('定向核对未抛异常', false, String(error?.stack ?? error));
  })
  .finally(() => {
    const failed = results.filter((item) => !item.ok);
    console.log(`\n=== 定向核对汇总：${results.length - failed.length}/${results.length} 通过（共 ${results.length}）===`);
    process.exitCode = failed.length === 0 ? 0 : 1;
  });
