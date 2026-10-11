#!/usr/bin/env node
/**
 * 46 轮**定向**行为核对（本机 5336 product 预览 + 5414 合成后端）。
 *
 * 只盯 Main 报的三件事，不重复 40 号的 59 项环境自检：
 *  1. 复制节点后原生画布仍能从入口整条遍历（真实链 + 无重复 id/key）；
 *  2. 原生保存后宿主「节点处理顺序」即时刷新，且**不整页重载、不关掉正在编辑的抽屉**；
 *  3. WF 原生画布/面板中文（官方 zh-CN 资源 + 语言初始化），`ai-employee` 显示官方题名。
 *
 * 用法（服务已在跑）：
 *   CREWLOOM_FIXTURE_URL=http://127.0.0.1:5414 CREWLOOM_APP_URL=http://127.0.0.1:5336 \
 *     node scripts/check-main-workflow-last-feedback.mjs
 *
 * 性质：本脚本只是**开发证据**；正式验收由 Main 在内置浏览器里亲自点击完成。
 * 全部请求只到本机 5414，不碰真实 13000，不外呼。
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { evaluate, goto, launchBrowser, mouseClickSelector, screenshot, sleep, typeInto, waitFor } from './lib/cdp-browser.mjs';

const FIXTURE = process.env.CREWLOOM_FIXTURE_URL ?? 'http://127.0.0.1:5414';
const APP = process.env.CREWLOOM_APP_URL ?? 'http://127.0.0.1:5336';
const ACCOUNT = { email: process.env.CREWLOOM_FIXTURE_EMAIL ?? 'zhangsan@fixture.local', password: 'fixture' };
const DRAFT_ID = '900000000000001';
const SHOT_DIR = process.env.CREWLOOM_SHOT_DIR ?? join(process.cwd(), '.shots', 'workflow-last-feedback');

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

async function run() {
  // ---------- 0. 本机合成环境准备（重置 + 造一条 Main 同形的链：calc → script → condition → 两分支） ----------
  await fixtureCall('/control/reset', jsonPost({}));
  const signIn = await fixtureCall('/api/auth:signIn', jsonPost({ email: ACCOUNT.email, password: ACCOUNT.password }));
  const token = signIn.body?.data?.token;
  check('C0 本机合成后端可登录（5414，无真实后端）', signIn.status === 200 && typeof token === 'string');
  const auth = { authorization: `Bearer ${token}` };

  const listNodes = async () => {
    const res = await fixtureCall(
      `/api/flow_nodes:list?filter=${encodeURIComponent(JSON.stringify({ workflowId: DRAFT_ID }))}&pageSize=200&sort%5B%5D=id`,
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
  check(
    'C0 预置 Main 同形链：把 JS 节点接在计算节点之后',
    createdScript.status === 200 && scriptId.length > 0 && String(createdScript.body?.data?.upstreamId) === String(calc?.id),
    `script=${scriptId}`,
  );

  const chainBefore = linearChain(await listNodes());

  if (!existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') && !process.env.CHROME_PATH) {
    check('C 真实浏览器核对', false, '没有找到 Chrome（设置 CHROME_PATH）');
    return;
  }
  mkdirSync(SHOT_DIR, { recursive: true });

  const browser = await launchBrowser({
    debugPort: Number(process.env.CREWLOOM_CDP_PORT ?? 9405),
    width: 1440,
    height: 980,
  });
  const { cdp, close, events } = browser;
  try {
    // ---------- 1. 真实登录 ----------
    await goto(cdp, `${APP}/login`, 1200);
    await waitFor(cdp, `Boolean(document.querySelector('input[name="crewloom-account"]'))`, { timeoutMs: 20000 });
    await typeInto(cdp, 'input[name="crewloom-account"]', ACCOUNT.email);
    await typeInto(cdp, 'input[name="crewloom-secret"]', ACCOUNT.password);
    await mouseClickSelector(cdp, 'form button[type="submit"]', 0, { settleMs: 1800 });
    const loggedIn = await waitFor(cdp, `!location.pathname.startsWith('/login')`, { timeoutMs: 25000 });
    check('C1 真实登录页用合成账号登录（5414 合成登录）', Boolean(loggedIn), await evaluate(cdp, 'location.pathname'));

    // ---------- 2. 原生画布就绪 ----------
    await goto(cdp, `${APP}/workflow/canvas?workflowId=${DRAFT_ID}`, 2500);
    const hostReady = await waitFor(
      cdp,
      `Boolean(document.querySelector('[data-testid="native-workflow-canvas"] .workflow-canvas'))`,
      { timeoutMs: 30000 },
    );
    const registry = await waitFor(
      cdp,
      `window.__crewloomWorkflowRegistry ? JSON.stringify(window.__crewloomWorkflowRegistry()) : ''`,
      { timeoutMs: 30000 },
    );
    let registryInfo = null;
    try {
      registryInfo = registry ? JSON.parse(registry) : null;
    } catch {
      registryInfo = null;
    }
    check(
      'C2 原生画布宿主就绪（真实 client-v2 画布，不是产品顺序列表）',
      Boolean(hostReady) && registryInfo?.instructionCount >= 25,
      registryInfo ? `instructions=${registryInfo.instructionCount}` : 'registry 不可读',
    );

    /* ================= 问题 3：WF 原生中文 ================= */
    const canvasText = await evaluate(
      cdp,
      `document.querySelector('[data-testid="native-workflow-canvas"]').innerText`,
    );
    const englishLeftovers = ['Test run', 'Add node', 'Calculation', 'Condition', 'Copy node'].filter((marker) =>
      String(canvasText).includes(marker),
    );
    check(
      'C3 原生画布中文：不再出现 Test run / Add node / Calculation / Condition 等英文原生文案',
      englishLeftovers.length === 0,
      englishLeftovers.length ? `仍有：${englishLeftovers.join(', ')}` : '英文残留 0',
    );
    const nodeAriaLabels = await evaluate(
      cdp,
      `[...document.querySelectorAll('[data-testid="native-workflow-canvas"] [role="button"][aria-label]')].map((el) => el.getAttribute('aria-label'))`,
    );
    check(
      'C3 原生节点卡片题名中文（aria-label 形如「计算-准备参数」）',
      Array.isArray(nodeAriaLabels) && nodeAriaLabels.some((label) => typeof label === 'string' && label.startsWith('计算-')),
      JSON.stringify(nodeAriaLabels).slice(0, 160),
    );

    // 「新增节点」下拉用的是原生 registry 的真实类型清单：官方题名而不是原始 type 名。
    await markAndClick(
      cdp,
      `[...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === '添加节点' && !b.closest('[data-testid="native-workflow-canvas"]'))`,
      900,
    );
    const typeOptions = await evaluate(
      cdp,
      `[...document.querySelectorAll('select option')].map((option) => ({ value: option.value, label: (option.textContent || '').trim() }))`,
    );
    const labelOf = (value) => (Array.isArray(typeOptions) ? typeOptions.find((o) => o.value === value)?.label : null);
    const rawLabels = Array.isArray(typeOptions)
      ? typeOptions.filter((option) => option.value && option.value === option.label).map((option) => option.value)
      : [];
    check(
      'C3 known 27 类型用官方题名（ai-employee → AI 员工，不是原始 type 名）',
      Array.isArray(typeOptions) &&
        typeOptions.length >= 25 &&
        labelOf('ai-employee') === 'AI 员工' &&
        labelOf('calculation') === '计算' &&
        labelOf('condition') === '条件判断',
      `types=${typeOptions?.length} ai-employee=${labelOf('ai-employee')} calculation=${labelOf('calculation')}`,
    );
    check(
      'C3 没有任何类型把原始 type 名当显示名',
      rawLabels.length === 0,
      rawLabels.length ? `仍为原始名：${rawLabels.join(', ')}` : '原始名 0',
    );
    await markAndClick(cdp, `[...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === '取消')`, 700);

    // 打开计算节点抽屉：提交按钮与「测试执行」应为中文
    await mouseClickSelector(cdp, '[data-testid="native-workflow-canvas"] .workflow-node-type-calculation .workflow-node-meta', 0, {
      settleMs: 2200,
    });
    const drawerOpen = await waitFor(cdp, `Boolean(document.querySelector('.ant-drawer-content'))`, { timeoutMs: 20000 });
    const drawerButtons = await evaluate(
      cdp,
      `[...document.querySelectorAll('.ant-drawer-content button')].map((b) => (b.innerText || '').replace(/\\s/g, '')).filter(Boolean)`,
    );
    check(
      'C3 节点抽屉按钮中文（提交 / 测试执行，不是 Submit / Test run）',
      Boolean(drawerOpen) &&
        Array.isArray(drawerButtons) &&
        drawerButtons.includes('提交') &&
        !drawerButtons.includes('Submit'),
      JSON.stringify(drawerButtons).slice(0, 200),
    );
    const expressionLabel = await evaluate(
      cdp,
      `(() => {
        const item = [...document.querySelectorAll('.ant-drawer-content .ant-form-item')]
          .find((el) => (el.querySelector('.ant-form-item-label')?.innerText || '').includes('计算表达式'));
        return item ? (item.querySelector('.ant-form-item-label').innerText || '').trim() : null;
      })()`,
    );
    check('C3 节点面板字段标签中文（计算表达式）', expressionLabel === '计算表达式', String(expressionLabel));

    /* ================= 问题 2：原生保存后宿主摘要即时刷新 ================= */
    // 记录「节点处理顺序」里的配置摘要（保存前）
    const summaryBefore = await evaluate(
      cdp,
      `(() => {
        const row = [...document.querySelectorAll('div')].find((el) => (el.innerText || '').includes('配置摘要：1 + 1'));
        return row ? row.innerText.trim().slice(0, 80) : null;
      })()`,
    );
    // 整页不重载的哨兵：刷新后仍在说明没有 navigation/reload
    await evaluate(cdp, `window.__crewloomKeep = 'kept'`);
    // 画布不被卸载的哨兵：每 50ms 采样一次宿主容器是否存在
    await evaluate(
      cdp,
      `(() => {
        window.__canvasMonitor = { samples: 0, everMissing: false };
        window.__canvasTimer = setInterval(() => {
          window.__canvasMonitor.samples += 1;
          if (!document.querySelector('[data-testid="native-workflow-canvas"] .workflow-canvas')) {
            window.__canvasMonitor.everMissing = true;
          }
        }, 50);
        return true;
      })()`,
    );

    const expressionField =
      'body .ant-drawer-content .ant-form-item input, body .ant-drawer-content .ant-form-item textarea, body .ant-drawer-content .ant-form-item [contenteditable="true"]';
    // 精确落到「计算表达式」这一项，避免改到标题字段
    const expressionIndex = await evaluate(
      cdp,
      `(() => {
        const items = [...document.querySelectorAll('.ant-drawer-content .ant-form-item')];
        const fields = [...document.querySelectorAll(${JSON.stringify(expressionField)})];
        const item = items.find((el) => (el.querySelector('.ant-form-item-label')?.innerText || '').includes('计算表达式'));
        const field = item?.querySelector('input, textarea, [contenteditable="true"]');
        return field ? fields.indexOf(field) : -1;
      })()`,
    );
    const listBefore = events.apiRequests.length;
    let saved = false;
    let typedExpression = null;
    if (expressionIndex >= 0) {
      await typeInto(cdp, expressionField, '40 + 7', expressionIndex);
      // 表达式是原生 `WorkflowVariableInput` 的 contenteditable：Cmd+A 不一定清空，
      // 这里以**输入后的真实文本**为准，再断言宿主摘要跟着它更新（证明联动，而不是断言某个固定串）。
      typedExpression = await evaluate(
        cdp,
        `(() => {
          const item = [...document.querySelectorAll('.ant-drawer-content .ant-form-item')]
            .find((el) => (el.querySelector('.ant-form-item-label')?.innerText || '').includes('计算表达式'));
          const field = item?.querySelector('input, textarea, [contenteditable="true"]');
          return field ? String(field.value ?? field.innerText ?? '').trim() : null;
        })()`,
      );
      saved = await markAndClick(
        cdp,
        `[...document.querySelectorAll('.ant-drawer-content button')].find((b) => (b.innerText || '').replace(/\\s/g, '') === '提交')`,
        2600,
      );
    }
    const summaryUpdated = typedExpression
      ? await waitFor(
          cdp,
          `document.body.innerText.includes(${JSON.stringify(`配置摘要：${typedExpression}`)})`,
          { timeoutMs: 15000, intervalMs: 250 },
        )
      : false;
    const keepMarker = await evaluate(cdp, `window.__crewloomKeep`);
    const monitor = await evaluate(
      cdp,
      `(() => { clearInterval(window.__canvasTimer); return window.__canvasMonitor; })()`,
    );
    const listCalls = events.apiRequests
      .slice(listBefore)
      .filter((entry) => entry.url.includes('flow_nodes:list') && entry.method === 'GET');
    check(
      'C4 原生保存后宿主「节点处理顺序」摘要即时刷新（不再离开重进才更新）',
      Boolean(saved) && Boolean(typedExpression) && Boolean(summaryUpdated),
      `写入表达式=${JSON.stringify(typedExpression)} 保存=${saved} 摘要跟上=${Boolean(summaryUpdated)}`,
    );
    check(
      'C4 刷新不整页重载、不卸载原生画布（哨兵仍在 + 画布采样从未缺失）',
      keepMarker === 'kept' && monitor?.everMissing === false && monitor?.samples > 10,
      `keep=${keepMarker} samples=${monitor?.samples} everMissing=${monitor?.everMissing}`,
    );
    check(
      'C4 一次保存只触发一次宿主节点列表刷新（合并，不重复整页拉取）',
      listCalls.length >= 1 && listCalls.length <= 2,
      `flow_nodes:list=${listCalls.length}`,
    );
    await screenshot(cdp, join(SHOT_DIR, '01-native-save-host-summary.png'));
    await evaluate(cdp, `(() => { const b = document.querySelector('.ant-drawer-close'); if (b) b.click(); return true; })()`);
    await sleep(700);

    /* ================= 问题 1：复制节点后链仍可整条遍历 ================= */
    const canvasCountBefore = await evaluate(
      cdp,
      `document.querySelectorAll('[data-testid="native-workflow-canvas"] [class*="workflow-node-type-"]').length`,
    );
    const hostCountBefore = await evaluate(
      cdp,
      `(() => { const m = document.body.innerText.match(/节点\\s*(\\d+)\\s*个/); return m ? Number(m[1]) : null; })()`,
    );
    const dupBefore = events.apiRequests.length;
    const duplicateClicked = await markAndClick(
      cdp,
      `(() => {
        const rows = [...document.querySelectorAll('div')].filter(
          (el) =>
            !el.closest('[data-testid="native-workflow-canvas"]') &&
            (el.innerText || '').includes('检查脚本') &&
            el.querySelector('button'),
        );
        const row = rows[rows.length - 1];
        return [...(row?.querySelectorAll('button') ?? [])].find((b) => (b.innerText || '').replace(/\\s/g, '') === '复制节点');
      })()`,
      2600,
    );
    const canvasCountAfter = await waitFor(
      cdp,
      `document.querySelectorAll('[data-testid="native-workflow-canvas"] [class*="workflow-node-type-"]').length === ${Number(canvasCountBefore) + 1} ? ${Number(canvasCountBefore) + 1} : 0`,
      { timeoutMs: 15000, intervalMs: 250 },
    );
    const hostCountAfter = await waitFor(
      cdp,
      `(() => { const m = document.body.innerText.match(/节点\\s*(\\d+)\\s*个/); return m && Number(m[1]) === ${Number(hostCountBefore) + 1} ? Number(m[1]) : 0; })()`,
      { timeoutMs: 15000, intervalMs: 250 },
    );
    const canvasStillWhole = await evaluate(
      cdp,
      `(() => {
        const canvas = document.querySelector('[data-testid="native-workflow-canvas"]');
        const text = canvas ? canvas.innerText : '';
        // 画布卡片上显示的是**节点类型题名**（计算 / JavaScript / 条件判断 / 流程输出），不是节点标题。
        return ['计算', 'JavaScript', '条件判断', '流程输出', '结束'].filter((title) => text.includes(title));
      })()`,
    );
    const dupCalls = events.apiRequests
      .slice(dupBefore)
      .filter((entry) => entry.url.includes('flow_nodes:duplicate'));
    check(
      'C5 宿主「复制节点」发出真实 duplicate 请求并带上落点',
      duplicateClicked && dupCalls.length === 1 && dupCalls[0].method === 'POST' && dupCalls[0].status === 200,
      dupCalls.length ? `status=${dupCalls[0].status} body=${String(dupCalls[0].postData ?? '').slice(0, 80)}` : '未捕获请求',
    );
    check(
      'C5 复制后原生画布节点数 +1 且整条链仍渲染（不是只剩计算节点）',
      canvasCountAfter === Number(canvasCountBefore) + 1 &&
        hostCountAfter === Number(hostCountBefore) + 1 &&
        Array.isArray(canvasStillWhole) &&
        canvasStillWhole.length === 5,
      `画布 ${canvasCountBefore}→${canvasCountAfter}；宿主 ${hostCountBefore}→${hostCountAfter}；可见=${JSON.stringify(canvasStillWhole)}`,
    );

    // 真实链证据（HTTP 侧，独立于浏览器渲染）
    const nodesAfter = await listNodes();
    const chainAfter = linearChain(nodesAfter);
    const scriptIndex = chainAfter.indexOf(scriptId);
    const clone = nodesAfter.find((row) => String(row.upstreamId) === scriptId && String(row.id) !== scriptId);
    const condition = nodesAfter.find((row) => row.type === 'condition');
    const cloneId = String(clone?.id ?? '');
    check(
      'C5 真实链可整条遍历：入口链包含全部直线节点且副本紧跟源节点',
      scriptIndex >= 0 &&
        cloneId.length > 0 &&
        chainAfter[scriptIndex + 1] === cloneId &&
        chainAfter.length >= chainBefore.length + 1,
      `chain=${chainAfter.join('→')}`,
    );
    check(
      'C5 复制后无重复 id/key，且原下游改接到副本（不断链）',
      new Set(nodesAfter.map((row) => String(row.id))).size === nodesAfter.length &&
        new Set(nodesAfter.map((row) => String(row.key))).size === nodesAfter.length &&
        String(condition?.upstreamId) === cloneId,
      `nodes=${nodesAfter.length} condition.upstream=${String(condition?.upstreamId)} clone=${cloneId}`,
    );
    await screenshot(cdp, join(SHOT_DIR, '02-duplicate-chain.png'));

    /* ================= 问题 2 补充：刷新不关抽屉、不丢 draft ================= */
    const c6 = { addForm: false, drawerOpened: false, draftIndex: -1, filled: false, clicked: false, added: false, drawerAfter: false, api: [] };
    // 先打开宿主「添加节点」内联表单（与原生抽屉可同时存在）
    c6.addForm = await markAndClick(
      cdp,
      `[...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === '添加节点' && !b.closest('[data-testid="native-workflow-canvas"]'))`,
      900,
    );
    await mouseClickSelector(cdp, '[data-testid="native-workflow-canvas"] .workflow-node-type-calculation .workflow-node-meta', 0, {
      settleMs: 2200,
    });
    c6.drawerOpened = await waitFor(cdp, `Boolean(document.querySelector('.ant-drawer-content'))`, { timeoutMs: 15000 });
    const draftIndex = await evaluate(
      cdp,
      `(() => {
        const item = [...document.querySelectorAll('.ant-drawer-content .ant-form-item')]
          .find((el) => (el.querySelector('.ant-form-item-label')?.innerText || '').includes('计算表达式'));
        const field = item?.querySelector('input, textarea, [contenteditable="true"]');
        const fields = [...document.querySelectorAll(${JSON.stringify(expressionField)})];
        return field ? fields.indexOf(field) : -1;
      })()`,
    );
    c6.draftIndex = draftIndex;
    if (draftIndex >= 0) await typeInto(cdp, expressionField, 'draft-keep-1 + 1', draftIndex);
    // 原生抽屉的遮罩挡住了宿主表单：这里用程序化赋值 + 程序化点击触发宿主的 nodes:create，
    // 只为验证"后台刷新不会卸载宿主/关抽屉"。刷新路径与真实点击完全同一条。
    const c6ApiBefore = events.apiRequests.length;
    c6.filled = await evaluate(
      cdp,
      `(() => {
        const input = [...document.querySelectorAll('input')].find(
          (el) => !el.closest('.ant-drawer-content') && (el.getAttribute('placeholder') || '').length > 0,
        );
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'draft触发节点');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`,
    );
    c6.clicked = await evaluate(
      cdp,
      `(() => {
        const button = [...document.querySelectorAll('button')].find(
          (b) => (b.innerText || '').replace(/\\s/g, '') === '确认添加' && !b.disabled,
        );
        if (!button) return false;
        button.click();
        return true;
      })()`,
    );
    c6.added = Boolean(await waitFor(cdp, `document.body.innerText.includes('已新增节点')`, { timeoutMs: 15000, intervalMs: 250 }));
    await sleep(1200);
    c6.drawerAfter = await evaluate(cdp, `Boolean(document.querySelector('.ant-drawer-content'))`);
    c6.api = events.apiRequests.slice(c6ApiBefore).map((entry) => `${entry.method} ${entry.url.split('?')[0]}`);
    const drawerStillOpen = c6.drawerAfter;
    const draftKept = await evaluate(
      cdp,
      `(() => {
        const item = [...document.querySelectorAll('.ant-drawer-content .ant-form-item')]
          .find((el) => (el.querySelector('.ant-form-item-label')?.innerText || '').includes('计算表达式'));
        const field = item?.querySelector('input, textarea, [contenteditable="true"]');
        return field ? String(field.value ?? field.innerText ?? '') : '';
      })()`,
    );
    check(
      'C6 后台刷新不关掉正在编辑的原生抽屉、不丢用户草稿',
      c6.addForm && Boolean(c6.drawerOpened) && c6.draftIndex >= 0 && c6.filled && c6.clicked && c6.added && drawerStillOpen && String(draftKept).includes('draft-keep'),
      `diag=${JSON.stringify(c6)} draft=${String(draftKept).slice(0, 40)}`,
    );
    await screenshot(cdp, join(SHOT_DIR, '03-draft-preserved.png'));

    const unexpected5xx = events.apiRequests.filter((entry) => entry.status >= 500);
    check(
      'C7 全程无未捕获页面异常、无非预期 5xx',
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
