#!/usr/bin/env node
/**
 * WF-02/WF-03 **受控**核对：真实原生画布 + 本机受控工作流后端。
 *
 * 目的：证明原生画布里的**真实用户操作**（真实鼠标点击 / 拖拽）会触发真实的
 * `workflows/<版本>/nodes:create`、`flow_nodes:update|move|duplicate|destroy|test`
 * 请求，并且动作结果形成**可重载的真实状态**（位置 / 分支顺序 / duplicate id / 旧版本不误写），
 * 以及权限 / 已执行版本 / 服务端错误的中文反馈。
 *
 * 边界（脚本内实现）：
 *  - 受控后端是本机 `CREWLOOM_CONTROLLED_WORKFLOW=1` 的中间件，**不落真实 13000**；
 *  - 真实后端只做正常登录 + 精准只读（strict 传输策略）；
 *  - 不执行 target 的任何流程，不调用模型，不外呼工具/MCP；
 *  - 凭据只在进程内存读取，不进 argv/env/日志/证据。
 *
 * 用法：
 *   CREWLOOM_PREVIEW_URL=http://127.0.0.1:5314 \
 *   CREWLOOM_13000_SECRETS=/abs/path/secret.json \
 *   node scripts/verify-native-workflow-canvas-controlled.mjs
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  boxOf,
  evaluate,
  getResponseBody,
  goto,
  indexByText,
  launchBrowser,
  mouseClickAt,
  mouseClickSelector,
  mouseClickText,
  mouseWheel,
  screenshot,
  scrollIntoView,
  sleep,
  waitFor,
} from './lib/cdp-browser.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const FRONTEND = resolve(here, '..');
const SECRET_PATH =
  process.env.CREWLOOM_13000_SECRETS ?? resolve(repoRoot, '.secrets/full-pages-13000-20261011.json');
const BASE = process.env.CREWLOOM_PREVIEW_URL ?? 'http://127.0.0.1:5314';
const OUT = resolve(
  process.env.CREWLOOM_CONTROLLED_OUT ??
    resolve(
      repoRoot,
      'docs/acceptance/full-pages-13000/final-native-workflow-evidence/native-workflow-controlled-run-final.json',
    ),
);
const SHOTS = resolve(process.env.CREWLOOM_CONTROLLED_SHOT_DIR ?? resolve(FRONTEND, '.shots/workflow-controlled'));
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT ?? 9392);

const DRAFT_ID = '900000000000001';
const EXECUTED_ID = '900000000000002';
const OTHER_ID = '900000000000003';
const DRAFT2_ID = '900000000000004';
const WIDE_ID = '900000000000005';
const CANVAS = '[data-testid="native-workflow-canvas"]';
const CALC = `${CANVAS} .workflow-node-type-calculation`;
const COND = `${CANVAS} .workflow-node-type-condition`;

const steps = [];
const shots = [];

function record(name, ok, detail) {
  steps.push({ name, ok: Boolean(ok), at: new Date().toISOString(), ...detail });
  console.error(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${JSON.stringify(detail).slice(0, 500)}`}`);
  return ok;
}

async function serverState() {
  const response = await fetch(`${BASE}/api/crewloomControlledWorkflow:state`);
  return (await response.json()).data;
}

async function setScenario(test) {
  await fetch(`${BASE}/api/crewloomControlledWorkflow:scenario`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ test }),
  });
}

async function resetControlled() {
  await fetch(`${BASE}/api/crewloomControlledWorkflow:reset`, { method: 'POST' });
}

function writeRequests(events, fragment) {
  return events.apiRequests.filter((item) => item.method === 'POST' && item.url.includes(`/api/${fragment}`));
}

async function uiNodes(cdp) {
  return evaluate(
    cdp,
    `(() => [...document.querySelectorAll('${CANVAS} [class*="workflow-node-type-"]')]
      .filter((card) => card.querySelector('[role="button"]'))
      .map((card) => ({
        type: (card.className.match(/workflow-node-type-([\\w-]+)/) || [])[1] ?? null,
        aria: card.querySelector('[role="button"]').getAttribute('aria-label') ?? '',
      })))()`,
  );
}

async function waitForCanvas(cdp) {
  return waitFor(cdp, `Boolean(document.querySelector('${CANVAS} .workflow-canvas'))`, {
    timeoutMs: 90000,
    intervalMs: 1500,
  });
}

async function gotoCanvas(cdp, workflowId) {
  await goto(cdp, `${BASE}/workflow/canvas?workflowId=${workflowId}`, 3500);
  await waitForCanvas(cdp);
  await sleep(1500);
}

async function login(cdp, secrets) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    /* eslint-disable no-await-in-loop -- 登录重试是业务逻辑，必须串行 */
    await goto(cdp, `${BASE}/login`, 1800);
    await sleep(1800);
    await evaluate(cdp, `(() => { const el=document.querySelector('input[type="text"], input[type="email"]'); if (el) el.focus(); return Boolean(el); })()`);
    for (const char of String(secrets.email)) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: char });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp' });
    }
    await evaluate(cdp, `(() => { const el=document.querySelector('input[type="password"]'); if (el) el.focus(); return Boolean(el); })()`);
    for (const char of String(secrets.password)) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: char });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp' });
    }
    await evaluate(cdp, `(() => { const b=[...document.querySelectorAll('button')].find(x=>/登录|登 录/.test(x.textContent||'')); if(b) b.click(); return Boolean(b); })()`);
    await sleep(5000);
    const path = await evaluate(cdp, 'location.pathname');
    if (path !== '/login') return path;
    /* eslint-enable no-await-in-loop */
  }
  return '/login';
}

async function openAddMenu(cdp, buttonSelector, index) {
  await mouseClickSelector(cdp, buttonSelector, index, { settleMs: 1500 });
  return waitFor(cdp, `document.querySelectorAll('.ant-drawer .ant-menu-item').length > 0`, {
    timeoutMs: 15000,
    intervalMs: 250,
  });
}

/**
 * 打开原生节点动作菜单（antd Dropdown，trigger 是 hover）。
 *
 * 关键点（实测）：
 *  - 必须**先真实悬停**动作按钮才会展开；直接 click 不一定行；
 *  - 关闭过的 Dropdown 会留在 DOM 里（`ant-dropdown-hidden`），所以只认**可见**浮层里的
 *    `.ant-dropdown-menu-item`，否则会拿到上一次的隐藏项、点不到。
 */
const VISIBLE_DROPDOWN_ITEM = '.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item';

async function openNodeActionMenu(cdp, scopeSelector, index = 0) {
  const buttonSelector = `${scopeSelector} .workflow-node-action-button`;
  const readItems = () =>
    evaluate(cdp, `[...document.querySelectorAll(${JSON.stringify(VISIBLE_DROPDOWN_ITEM)})].map((el)=>(el.innerText||'').trim())`);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- 悬停→读取→（必要时）点击是串行的真实交互
    await scrollIntoView(cdp, `${scopeSelector} .workflow-node-meta`, index);
    // eslint-disable-next-line no-await-in-loop
    const box = await boxOf(cdp, buttonSelector, index);
    if (!box) throw new Error(`找不到节点动作按钮：${buttonSelector}[${index}]`);
    // eslint-disable-next-line no-await-in-loop
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(box.cx),
      y: Math.round(box.cy),
      button: 'none',
    });
    // eslint-disable-next-line no-await-in-loop
    await sleep(900);
    // eslint-disable-next-line no-await-in-loop
    let items = await readItems();
    if (items.length === 0) {
      // eslint-disable-next-line no-await-in-loop
      await mouseClickSelector(cdp, buttonSelector, index, { settleMs: 900, autoScroll: false });
      // eslint-disable-next-line no-await-in-loop
      items = await readItems();
    }
    if (items.length > 0) return items;
  }
  return [];
}

/** 按字段标签点击 scope 内的控件（真实鼠标；坐标由页面测量得到）。 */
async function clickControlByLabel(cdp, scopeSelector, labelText, { settleMs = 300 } = {}) {
  const box = await evaluate(
    cdp,
    `(() => {
      const scope = document.querySelector(${JSON.stringify(scopeSelector)});
      if (!scope) return null;
      // 1) 产品的字段控件大多带 aria-label（NodeConfigForm 的 common props）。
      let control = scope.querySelector('[aria-label=' + JSON.stringify(${JSON.stringify(labelText)}) + ']');
      if (!control) {
        // 2) 否则按字段标签定位：字段块是 div.formField（不是 <label>），
        //    结构 = span.fieldLabel + 控件 + hint；往上找到同时含控件的那个祖先。
        const spans = [...scope.querySelectorAll('span')];
        const labelSpan = spans.find((el) => (el.textContent || '').includes(${JSON.stringify(labelText)}));
        let container = labelSpan;
        while (container && !container.querySelector('input, textarea, select')) {
          container = container.parentElement;
        }
        control = container ? container.querySelector('input, textarea, select, button') : null;
      }
      if (!control) return null;
      const r = control.getBoundingClientRect();
      return { cx: r.x + r.width / 2, cy: r.y + r.height / 2, tag: control.tagName, visible: r.width > 0 && r.height > 0 };
    })()`,
  );
  if (!box || !box.visible) throw new Error(`受控字段控件找不到：${labelText}`);
  await mouseClickAt(cdp, box.cx, box.cy, { settleMs });
  return box;
}

/** 关闭所有原生抽屉/弹窗（步骤之间复位的真实操作：点各抽屉的关闭 X）。 */
async function closeOpenOverlays(cdp) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- 逐个关闭浮层
    const open = await evaluate(
      cdp,
      `document.querySelectorAll('.ant-drawer-open, .ant-modal-wrap:not([style*="display: none"])').length`,
    );
    if (!open) break;
    // eslint-disable-next-line no-await-in-loop
    await evaluate(
      cdp,
      `(() => {
        document.querySelectorAll('.ant-drawer-open .ant-drawer-close, .ant-modal-wrap .ant-modal-close').forEach((button) => button.click());
        return true;
      })()`,
    );
    // eslint-disable-next-line no-await-in-loop
    await sleep(600);
  }
  await sleep(300);
}

async function confirmModalIfAny(cdp) {
  const shown = await waitFor(cdp, `Boolean(document.querySelector('.ant-modal-confirm-btns .ant-btn-primary'))`, {
    timeoutMs: 4000,
    intervalMs: 200,
  });
  if (shown) {
    await mouseClickSelector(cdp, '.ant-modal-confirm-btns .ant-btn-primary', 0, { settleMs: 1500 });
  }
  return Boolean(shown);
}

async function main() {
  const evidence = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE,
    controlledBackend: true,
    boundary: {
      writes: '本机受控中间件（CREWLOOM_CONTROLLED_WORKFLOW=1）；不落真实 13000',
      realReads: '仅正常登录 + 精准只读（strict 传输策略）',
      noModelCalls: true,
      noTargetWorkflowExecution: true,
    },
    controlledIds: {
      draft: DRAFT_ID,
      executed: EXECUTED_ID,
      other: OTHER_ID,
      draft2: DRAFT2_ID,
      wide: WIDE_ID,
    },
    steps: [],
    shots: [],
  };

  if (!existsSync(SECRET_PATH)) {
    console.error(`缺少凭据文件：${SECRET_PATH}`);
    process.exitCode = 2;
    return;
  }
  const secrets = JSON.parse(readFileSync(SECRET_PATH, 'utf8'));

  const reachable = await fetch(`${BASE}/api/crewloomControlledWorkflow:state`)
    .then((r) => r.ok)
    .catch(() => false);
  if (!reachable) {
    console.error(`受控中间件未启用或预览不可达：${BASE}（需要 CREWLOOM_CONTROLLED_WORKFLOW=1）`);
    process.exitCode = 2;
    return;
  }
  await resetControlled();

  const { cdp, close, events } = await launchBrowser({ debugPort: DEBUG_PORT, width: 1600, height: 1000 });
  try {
    const afterLogin = await login(cdp, secrets);
    evidence.afterLoginUrl = afterLogin;
    record('login', afterLogin !== '/login', { afterLogin });
    if (afterLogin === '/login') throw new Error('登录未成功，后续受控核对无法进行');

    // ---------------- S1：受控画布 + 原生 registry ----------------
    await gotoCanvas(cdp, DRAFT_ID);
    const registry = await evaluate(
      cdp,
      `(() => (typeof window.__crewloomWorkflowRegistry === 'function' ? window.__crewloomWorkflowRegistry() : { ready: false }))()`,
    );
    const initialUi = await uiNodes(cdp);
    const initialState = await serverState();
    shots.push(await screenshot(cdp, join(SHOTS, '01-desktop-draft.png')));
    record('canvas-renders-controlled-workflow', initialUi.length === 4 && registry.instructionCount >= 20, {
      uiNodes: initialUi,
      instructionCount: registry.instructionCount,
      instructionTypes: registry.instructionTypes,
      triggerTypes: registry.triggerTypes,
      serverNodes: initialState.nodes.map((n) => `${n.type}:${n.title}`),
    });

    // ---------------- S2：原生「+」新增 script 节点 ----------------
    const beforeAdd = (await serverState()).nodes.length;
    const menuReady = await openAddMenu(cdp, `${CANVAS} button[aria-label="add-button"]`, 0);
    const menuItems = await evaluate(
      cdp,
      `[...document.querySelectorAll('.ant-drawer .ant-menu-item')].map((el)=>(el.innerText||'').trim())`,
    );
    await mouseClickText(cdp, '.ant-drawer .ant-menu-item', 'JavaScript', { settleMs: 600 });
    await sleep(2500);
    const afterAddState = await serverState();
    const creates = writeRequests(events, `workflows/${DRAFT_ID}/nodes:create`);
    const createdNode = afterAddState.nodes.find((n) => n.type === 'script');
    record(
      'native-add-node (script via registry)',
      Boolean(menuReady) &&
        creates.length === 1 &&
        creates[0].status === 200 &&
        afterAddState.nodes.length === beforeAdd + 1 &&
        Boolean(createdNode) &&
        createdNode.config?.content === 'return "Hello world!";',
      {
        menuItems,
        requestStatus: creates[0]?.status ?? null,
        requestBody: creates[0]?.postData ?? null,
        newNode: createdNode ?? null,
        nodeCount: { before: beforeAdd, after: afterAddState.nodes.length },
      },
    );
    shots.push(await screenshot(cdp, join(SHOTS, '02-desktop-after-add-script.png')));

    // ---------------- S3：分支连接（条件「是」分支新增输出节点） ----------------
    const branchButtonCount = await evaluate(
      cdp,
      `document.querySelectorAll('${COND} button[aria-label="add-button"]').length`,
    );
    let branchOk = false;
    let branchDetail = { branchButtonCount };
    if (branchButtonCount >= 3) {
      // 条件卡片内的按钮 DOM 顺序：否(前/后) → 是(前/后)，取「是」分支的第一个。
      const branchIndexInCard = branchButtonCount - 2;
      await openAddMenu(cdp, `${COND} button[aria-label="add-button"]`, branchIndexInCard);
      await mouseClickText(cdp, '.ant-drawer .ant-menu-item', '流程输出', { settleMs: 500 });
      await sleep(2500);
      const state = await serverState();
      const condition = state.nodes.find((n) => n.type === 'condition');
      const branches = state.nodes
        .filter((n) => n.upstreamId === condition?.id)
        .map((n) => n.branchIndex)
        .sort((a, b) => Number(a) - Number(b));
      const created = state.nodes.find(
        (n) => n.type === 'output' && n.upstreamId === condition?.id && n.branchIndex === 1,
      );
      const allCreates = writeRequests(events, `workflows/${DRAFT_ID}/nodes:create`);
      branchOk =
        Boolean(created) &&
        branches.includes(0) &&
        branches.includes(1) &&
        allCreates.length === 2 &&
        allCreates[1].status === 200;
      branchDetail = {
        ...branchDetail,
        conditionId: condition?.id ?? null,
        branchIndexes: branches,
        created: created ?? null,
        createRequests: allCreates.length,
      };
    }
    record('native-add-node-into-branch', branchOk, branchDetail);

    // ---------------- S4：原生拖拽移动节点 ----------------
    const dragBefore = await serverState();
    const dragTarget =
      dragBefore.nodes.find((n) => n.type === 'output' && n.branchIndex === 1) ?? dragBefore.nodes.at(-1);
    let dragOk = false;
    let dragDetail = { nodeId: dragTarget.id };
    try {
      await scrollIntoView(cdp, `${CANVAS} .workflow-node-type-output .workflow-node-meta`);
      const plan = await evaluate(
        cdp,
        `(() => {
          const host = document.querySelector('${CANVAS}');
          const cards = [...host.querySelectorAll('[class*="workflow-node-type-"]')];
          const target = cards.find((c) => (c.querySelector('[role="button"]')?.getAttribute('aria-label')||'').endsWith(${JSON.stringify(dragTarget.title)}));
          if (!target) return null;
          const tr = target.getBoundingClientRect();
          return { from: { x: Math.round(tr.x + tr.width/2), y: Math.round(tr.y + 12) } };
        })()`,
      );
      if (!plan) throw new Error('找不到拖拽源节点卡片');
      const from = plan.from;
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none' });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 });
      for (let step = 1; step <= 6; step += 1) {
        // eslint-disable-next-line no-await-in-loop -- 拖拽轨迹必须逐点派发
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: from.x + 4 * step,
          y: from.y + 6 * step,
          button: 'left',
          buttons: 1,
        });
        // eslint-disable-next-line no-await-in-loop
        await sleep(30);
      }
      const dropZones = await waitFor(
        cdp,
        `(() => {
          const zones = [...document.querySelectorAll('${CANVAS} [aria-label="drop-zone"], ${CANVAS} .drop-zone')];
          if (!zones.length) return null;
          const boxes = zones.map((z) => { const r = z.getBoundingClientRect(); return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), safe: z.className.includes('drop-safe') }; });
          return { count: boxes.length, first: boxes[0], safeFirst: boxes.find((b) => b.safe) ?? null };
        })()`,
        { timeoutMs: 6000, intervalMs: 200 },
      );
      if (!dropZones) throw new Error('拖拽开始后没有出现 drop-zone');
      const drop = dropZones.safeFirst ?? dropZones.first;
      for (let step = 1; step <= 12; step += 1) {
        // eslint-disable-next-line no-await-in-loop -- 拖拽轨迹必须逐点派发
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: Math.round(from.x + ((drop.x - from.x) * step) / 12),
          y: Math.round(from.y + ((drop.y - from.y) * step) / 12),
          button: 'left',
          buttons: 1,
        });
        // eslint-disable-next-line no-await-in-loop
        await sleep(25);
      }
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: drop.x, y: drop.y, button: 'left', buttons: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: drop.x, y: drop.y, button: 'left', clickCount: 1 });
      await sleep(1500);
      const modalShown = await confirmModalIfAny(cdp);
      await sleep(2000);
      const moveReqs = writeRequests(events, 'flow_nodes:move');
      const state = await serverState();
      const moved = state.nodes.find((n) => n.id === dragTarget.id);
      dragOk = moveReqs.length >= 1 && moveReqs.at(-1).status === 200 && moved?.upstreamId === null && moved?.branchIndex === null;
      dragDetail = {
        ...dragDetail,
        dropZones: dropZones.count,
        drop,
        modalShown,
        moveRequests: moveReqs.map((r) => ({ status: r.status, body: r.postData })),
        moved: moved ?? null,
      };
    } catch (error) {
      dragDetail = { ...dragDetail, error: String(error) };
    }
    record('native-drag-move-node', dragOk, dragDetail);
    shots.push(await screenshot(cdp, join(SHOTS, '03-desktop-after-move.png')));

    // ---------------- S5：原生复制 / 粘贴（duplicate） ----------------
    const beforeDup = await serverState();
    let dupOk = false;
    let dupDetail = {};
    try {
      const menu = await openNodeActionMenu(cdp, CALC, 0);
      await mouseClickText(cdp, VISIBLE_DROPDOWN_ITEM, '复制', { settleMs: 800, autoScroll: false });
      const clipboardShown = await waitFor(cdp, `Boolean(document.querySelector('.workflow-clipboard-card'))`, {
        timeoutMs: 6000,
        intervalMs: 250,
      });
      const pasteCount = await waitFor(cdp, `document.querySelectorAll('${CANVAS} button[aria-label="paste-zone"]').length`, {
        timeoutMs: 8000,
        intervalMs: 300,
      });
      if (pasteCount > 0) {
        await mouseClickSelector(cdp, `${CANVAS} button[aria-label="paste-zone"]`, 0, { settleMs: 1000 });
        await confirmModalIfAny(cdp);
      }
      await sleep(2500);
      const dupReqs = writeRequests(events, 'flow_nodes:duplicate');
      const state = await serverState();
      const ids = state.nodes.map((n) => n.id);
      dupOk =
        Boolean(clipboardShown) &&
        pasteCount > 0 &&
        dupReqs.length === 1 &&
        dupReqs[0].status === 200 &&
        state.nodes.length === beforeDup.nodes.length + 1 &&
        new Set(ids).size === ids.length;
      dupDetail = {
        actionMenu: menu,
        clipboardShown: Boolean(clipboardShown),
        pasteZones: pasteCount,
        duplicateRequests: dupReqs.map((r) => ({ status: r.status, body: r.postData })),
        nodeCount: { before: beforeDup.nodes.length, after: state.nodes.length },
        duplicateIds: new Set(ids).size === ids.length ? 'unique' : 'DUPLICATED',
      };
    } catch (error) {
      dupDetail = { error: String(error) };
    }
    record('native-duplicate-node', dupOk, dupDetail);

    // ---------------- S6：原生删除节点 ----------------
    const beforeDel = await serverState();
    let delOk = false;
    let delDetail = {};
    try {
      const lastIndex =
        (await evaluate(cdp, `document.querySelectorAll('${CANVAS} [class*="workflow-node-type-"]').length`)) - 1;
      const menu = await openNodeActionMenu(cdp, `${CANVAS} [class*="workflow-node-type-"]`, lastIndex);
      await mouseClickText(cdp, VISIBLE_DROPDOWN_ITEM, '删除', { settleMs: 1000, autoScroll: false });
      const confirmShown = await confirmModalIfAny(cdp);
      await sleep(2500);
      const delReqs = writeRequests(events, 'flow_nodes:destroy');
      const state = await serverState();
      delOk =
        confirmShown &&
        delReqs.length === 1 &&
        delReqs[0].status === 200 &&
        state.nodes.length === beforeDel.nodes.length - 1;
      delDetail = {
        actionMenu: menu,
        confirmShown,
        destroyRequests: delReqs.map((r) => ({ status: r.status, body: r.postData })),
        nodeCount: { before: beforeDel.nodes.length, after: state.nodes.length },
      };
    } catch (error) {
      delDetail = { error: String(error) };
    }
    record('native-delete-node', delOk, delDetail);

    // ---------------- S7：节点配置保存 + 回读 ----------------
    const expression = `40 + ${Math.floor(Math.random() * 1000)}`;
    let saveOk = false;
    let saveDetail = { expression };
    try {
      await mouseClickSelector(cdp, `${CALC} .workflow-node-meta`, 0, { settleMs: 2000 });
      const drawerOpen = await waitFor(cdp, `Boolean(document.querySelector('.ant-drawer-content'))`, {
        timeoutMs: 12000,
        intervalMs: 300,
      });
      const editorReady = await waitFor(cdp, `Boolean(document.querySelector('.ant-drawer-content [contenteditable="true"]'))`, {
        timeoutMs: 15000,
        intervalMs: 400,
      });
      await mouseClickSelector(cdp, '.ant-drawer-content [contenteditable="true"]', 0, { settleMs: 400 });
      // 全选用 CDP 的编辑命令（macOS headless 下 Meta+A 不一定生效），随后仍是真实键盘输入。
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        windowsVirtualKeyCode: 65,
        code: 'KeyA',
        key: 'a',
        modifiers: 4,
        commands: ['selectAll'],
      });
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        windowsVirtualKeyCode: 65,
        code: 'KeyA',
        key: 'a',
        modifiers: 4,
      });
      await cdp.send('Input.insertText', { text: expression });
      await sleep(500);
      const editorText = await evaluate(
        cdp,
        `(document.querySelector('.ant-drawer-content [contenteditable="true"]')?.innerText ?? '')`,
      );
      const submitIndex = await indexByText(cdp, 'body .ant-drawer-content button', '提 交');
      if (submitIndex < 0) throw new Error('抽屉里找不到提交按钮');
      // 先点一次让表单 blur/同步，再提交
      await mouseClickSelector(cdp, 'body .ant-drawer-content button', submitIndex, { settleMs: 2500 });
      const updateReqs = writeRequests(events, 'flow_nodes:update');
      const last = updateReqs.at(-1);
      let body = null;
      try {
        body = JSON.parse(last?.postData ?? 'null');
      } catch {
        body = null;
      }
      const state = await serverState();
      const calc = state.nodes.find((n) => n.type === 'calculation');
      // 回读：整页重载后从受控后端重新读取该版本节点
      await gotoCanvas(cdp, DRAFT_ID);
      const reloaded = await evaluate(
        cdp,
        `fetch('/api/flow_nodes:list?filter=' + encodeURIComponent(JSON.stringify({ workflowId: '${DRAFT_ID}' })))
           .then((r) => r.json())
           .then((b) => (b.data || []).find((n) => n.type === 'calculation')?.config?.expression ?? null)`,
      );
      saveOk =
        Boolean(drawerOpen) &&
        Boolean(editorReady) &&
        updateReqs.length >= 1 &&
        last.status === 200 &&
        body?.config?.expression === expression &&
        calc?.config?.expression === expression &&
        reloaded === expression;
      saveDetail = {
        drawerOpen: Boolean(drawerOpen),
        editorReady: Boolean(editorReady),
        editorText,
        updateRequests: updateReqs.length,
        lastStatus: last?.status ?? null,
        sentValues: body,
        serverConfig: calc?.config ?? null,
        reloadedExpression: reloaded,
      };
    } catch (error) {
      saveDetail = { ...saveDetail, error: String(error) };
    }
    record('native-config-save-and-read-back', saveOk, saveDetail);

    // ---------------- S8：节点自测（success / failure / permission / error） ----------------
    const selfTest = {};
    const runScenario = async (scenario) => {
      await setScenario(scenario);
      await mouseClickSelector(cdp, `${CALC} .workflow-node-meta`, 0, { settleMs: 1800 });
      await waitFor(cdp, `Boolean(document.querySelector('.ant-drawer-content [contenteditable="true"]'))`, {
        timeoutMs: 15000,
        intervalMs: 400,
      });
      const testIndex = await waitFor(
        cdp,
        `[...document.querySelectorAll('body .ant-drawer-content button')].findIndex((b) => (b.innerText||'').includes('测试执行'))`,
        { timeoutMs: 12000, intervalMs: 400 },
      );
      if (testIndex < 0) throw new Error('找不到「测试执行」按钮');
      await mouseClickSelector(cdp, 'body .ant-drawer-content button', testIndex, { settleMs: 1500 });
      const dialogOpen = await waitFor(cdp, `Boolean(document.querySelector('.ant-modal-content'))`, {
        timeoutMs: 10000,
        intervalMs: 300,
      });
      const modalButtons = await evaluate(
        cdp,
        `[...document.querySelectorAll('.ant-modal-content button')].map((b) => (b.innerText||'').trim())`,
      );
      void modalButtons;
      const runIndex = await evaluate(
        cdp,
        `[...document.querySelectorAll('.ant-modal-content button')].findIndex((b) => (b.innerText||'').replace(/\\s/g, '').includes('运行'))`,
      );
      if (runIndex >= 0) {
        await mouseClickSelector(cdp, '.ant-modal-content button', runIndex, { settleMs: 2000 });
      } else {
        const dump = await evaluate(
          cdp,
          `({ modals: document.querySelectorAll('.ant-modal-content').length, buttons: [...document.querySelectorAll('.ant-modal-content button')].map((b) => (b.innerText||'').trim()), text: (document.querySelector('.ant-modal-content')?.innerText||'').slice(0,300) })`,
        );
        throw new Error(`测试弹窗里找不到「运行」按钮：${JSON.stringify(dump)}`);
      }
      await sleep(2000);
      const modalText = await evaluate(
        cdp,
        `((document.querySelector('.ant-modal-content')?.innerText) || (document.querySelector('.ant-drawer-content')?.innerText) || '').slice(0, 900)`,
      );
      // 关闭弹窗与抽屉，为下一场景复位
      await evaluate(
        cdp,
        `(() => {
          const closeModal = document.querySelector('.ant-modal-content .ant-modal-close');
          if (closeModal) closeModal.click();
          const closeDrawer = document.querySelector('.ant-drawer-close');
          if (closeDrawer) closeDrawer.click();
          return true;
        })()`,
      );
      await sleep(1200);
      const testRequests = writeRequests(events, 'flow_nodes:test');
      const lastRequest = testRequests.at(-1);
      const responseBody = lastRequest ? await getResponseBody(cdp, lastRequest.requestId) : null;
      return {
        dialogOpen: Boolean(dialogOpen),
        modalText,
        requests: testRequests.map((r) => ({ status: r.status, body: r.postData })),
        responseBody,
      };
    };
    try {
      selfTest.success = await runScenario('success');
      selfTest.failure = await runScenario('failure');
      selfTest.permission = await runScenario('permission');
      selfTest.error = await runScenario('error');
      await setScenario('success');
    } catch (error) {
      selfTest.crash = String(error);
    }
    // 原生 `TestRunButton` 的成功/失败是 `t('Resolved')/t('Failed')`（本实例中文：完成/失败）；
    // 403/500 的文案必须是我们映射后的中文（不能是 `Request failed with status code 403`）。
    const testOk =
      Boolean(selfTest.success?.modalText?.includes('完成')) &&
      Boolean(selfTest.failure?.modalText?.includes('失败')) &&
      Boolean(selfTest.permission?.modalText?.includes('权限')) &&
      Boolean(selfTest.error?.modalText?.includes('内部错误')) &&
      !/Request failed with status code/.test(
        [selfTest.permission?.modalText, selfTest.error?.modalText].filter(Boolean).join(' '),
      );
    record('native-node-self-test (success/failure/permission/error)', testOk, selfTest);

    // ---------------- S9：已执行版本限制 + 版本隔离 ----------------
    await gotoCanvas(cdp, EXECUTED_ID);
    const executedProbe = await evaluate(
      cdp,
      `(() => {
        const host = document.querySelector('${CANVAS}');
        return {
          addButtons: host.querySelectorAll('button[aria-label="add-button"]').length,
          placeholders: host.querySelectorAll('.workflow-add-node-button').length,
          alert: (host.innerText || '').match(/已执行[^\\n]*/)?.[0] ?? null,
          text: (host.innerText || '').slice(0, 300),
        };
      })()`,
    );
    const isolated = await serverState();
    const attempts = await evaluate(
      cdp,
      `(async () => {
        const response = await fetch('/api/workflows/${EXECUTED_ID}/nodes:create', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'output', title: 'should-not-be-created', config: {} }),
        });
        return { status: response.status, body: await response.json().catch(() => null) };
      })()`,
    );
    record(
      'executed-version-limit-and-isolation',
      executedProbe.addButtons === 0 &&
        executedProbe.placeholders > 0 &&
        attempts.status === 400 &&
        String(attempts.body?.errors?.[0]?.message ?? '').includes('执行记录'),
      { executedProbe, createAttempt: attempts, versions: isolated.versions },
    );
    shots.push(await screenshot(cdp, join(SHOTS, '04-desktop-executed-version.png')));

    // ---------------- S10：390px 画布可操作性 ----------------
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await sleep(1500);
    await gotoCanvas(cdp, DRAFT_ID);
    await scrollIntoView(cdp, `${CANVAS} button[aria-label="add-button"]`);
    const addBox = await boxOf(cdp, `${CANVAS} button[aria-label="add-button"]`, 0);
    const cardBox = await boxOf(cdp, `${CANVAS} .workflow-node-type-calculation`, 0);

    // 页面级滚动（用户真正能做的"移动画布区域"动作）+ 原生画布容器真实的溢出行为。
    const pan = await evaluate(
      cdp,
      `(() => {
        const scroller = document.scrollingElement || document.documentElement;
        const before = scroller.scrollTop;
        scroller.scrollTop = before + 200;
        const wrapper = document.querySelector('${CANVAS} .workflow-canvas-wrapper');
        const cs = wrapper ? getComputedStyle(wrapper) : null;
        return {
          pageScrolled: scroller.scrollTop > before,
          before,
          after: scroller.scrollTop,
          wrapperOverflow: cs ? cs.overflow : null,
          wrapperScrollable: wrapper ? wrapper.scrollHeight > wrapper.clientHeight || wrapper.scrollWidth > wrapper.clientWidth : null,
        };
      })()`,
    );

    // 原生缩放滑块（antd Slider, vertical reverse, step 10）：真实鼠标点 rail 的下半部改变缩放。
    // 实测：headless 下合成拖拽 handle 与方向键都不改变值，**点 rail** 会（100 → 70）。
    let zoom = null;
    await scrollIntoView(cdp, `${CANVAS} .workflow-canvas-zoomer .ant-slider-rail`);
    const rail = await boxOf(cdp, `${CANVAS} .workflow-canvas-zoomer .ant-slider-rail`, 0);
    if (rail && rail.visible) {
      const zoomBefore = await evaluate(cdp, `document.querySelector('${CANVAS} .workflow-canvas').style.zoom`);
      const targetY = Math.round(rail.y + rail.height * 0.7);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(rail.cx), y: targetY, button: 'none' });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(rail.cx), y: targetY, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(rail.cx), y: targetY, button: 'left', clickCount: 1 });
      await sleep(800);
      const zoomAfter = await evaluate(cdp, `({ zoom: document.querySelector('${CANVAS} .workflow-canvas').style.zoom, aria: document.querySelector('${CANVAS} .workflow-canvas-zoomer .ant-slider-handle')?.getAttribute('aria-valuenow') })`);
      zoom = { before: zoomBefore, after: zoomAfter.zoom, ariaValueNow: zoomAfter.aria, rail };
    }

    await mouseClickSelector(cdp, `${CALC} .workflow-node-meta`, 0, { settleMs: 2500 });
    const drawerBox = await boxOf(cdp, 'body .ant-drawer-content', 0);
    const drawerInsideCanvas = await evaluate(
      cdp,
      `(() => { const c = document.querySelector('${CANVAS}'); const d = document.querySelector('.ant-drawer-content-wrapper'); return Boolean(c && d && c.contains(d)); })()`,
    );
    const drawerButtonCount = await evaluate(cdp, `document.querySelectorAll('body .ant-drawer-content button').length`);
    const submitIndex = await indexByText(cdp, 'body .ant-drawer-content button', '提 交');
    const submitBox = submitIndex >= 0 ? await boxOf(cdp, 'body .ant-drawer-content button', submitIndex) : null;
    shots.push(await screenshot(cdp, join(SHOTS, '05-narrow-390-canvas.png')));
    const narrowOk =
      Boolean(addBox?.visible && addBox?.inViewport) &&
      Boolean(cardBox?.visible && cardBox?.inViewport) &&
      pan.pageScrolled === true &&
      Number.parseFloat(zoom?.after ?? '1') !== Number.parseFloat(zoom?.before ?? '1') &&
      Boolean(drawerBox?.visible && drawerBox?.inViewport && drawerBox.width <= 390) &&
      Boolean(submitBox?.visible && submitBox?.inViewport);
    record('narrow-390-canvas-pan-zoom-drawer', narrowOk, {
      addBox,
      cardBox,
      pan,
      zoom,
      drawerBox,
      drawerInsideCanvas,
      drawerButtons: drawerButtonCount,
      submitBox,
    });
    await cdp.send('Emulation.clearDeviceMetricsOverride');

    // ---------------- S11：manual（人工处理）真实注册 + 真实配置/保存/回读 ----------------
    const registryBeforeManual = await evaluate(
      cdp,
      `(() => (typeof window.__crewloomWorkflowRegistry === 'function' ? window.__crewloomWorkflowRegistry() : { ready: false }))()`,
    );
    await closeOpenOverlays(cdp);
    // 前面的步骤会把草稿改乱（含把节点拖成第二个起点，渲染树里就不再显示）。
    // 人工处理这一步要验证"真实点击新增 + 打开真实配置"，因此先把受控库复位成确定的 4 节点图。
    await resetControlled();
    await gotoCanvas(cdp, DRAFT_ID);
    const manualBefore = (await serverState()).nodes.length;
    let manualOk = false;
    let manualDetail = {
      registryInstructionCount: registryBeforeManual.instructionCount,
      registryHasManual: (registryBeforeManual.instructionTypes ?? []).includes('manual'),
      hostAdapters: registryBeforeManual.hostAdapters ?? null,
      manualEntry: (registryBeforeManual.instructions ?? []).find((item) => item.type === 'manual') ?? null,
    };
    try {
      await scrollIntoView(cdp, `${CANVAS} button[aria-label="add-button"]`);
      const addCount = await evaluate(cdp, `document.querySelectorAll('${CANVAS} button[aria-label="add-button"]').length`);
      // 用**链路内**的插槽（第 1 个节点之后的那个），保证新节点接在入口链上、一定被画布渲染。
      // 若用最后一个插槽，新节点会成为"第二个起点"（upstreamId=null），而画布只渲染第一个入口——
      // 实测那样后端有节点、画布却不显示（这正是本次先失败的原因）。
      await openAddMenu(cdp, `${CANVAS} button[aria-label="add-button"]`, 1);
      const menuItems = await evaluate(
        cdp,
        `[...document.querySelectorAll('.ant-drawer .ant-menu-item')].map((el)=>(el.innerText||'').trim())`,
      );
      await mouseClickText(cdp, '.ant-drawer .ant-menu-item', '人工处理', { settleMs: 600 });
      await sleep(2500);
      const afterAdd = await serverState();
      const creates = writeRequests(events, `workflows/${DRAFT_ID}/nodes:create`);
      const manualNode = afterAdd.nodes.find((n) => n.type === 'manual');
      // 等原生画布真的渲染出人工处理卡片（受控后端已创建，UI 刷新是异步的）
      const manualCardReady = await waitFor(cdp, `Boolean(document.querySelector('${CANVAS} .workflow-node-type-manual'))`, {
        timeoutMs: 20000,
        intervalMs: 500,
      });
      manualDetail = { ...manualDetail, manualCardReady: Boolean(manualCardReady) };
      if (!manualCardReady) throw new Error('原生画布没有渲染出 workflow-node-type-manual 卡片');
      // 打开真正的人工处理配置抽屉
      await mouseClickSelector(cdp, `${CANVAS} .workflow-node-type-manual .workflow-node-meta`, 0, { settleMs: 2200 });
      const fieldsetReady = await waitFor(cdp, `Boolean(document.querySelector('[data-testid="manual-native-fieldset"]'))`, {
        timeoutMs: 15000,
        intervalMs: 400,
      });
      // 产品的字段块是 div.formField + span.fieldLabel（不是 <label>），所以按 span 文本收集。
      const fieldLabels = await evaluate(
        cdp,
        `[...document.querySelectorAll('[data-testid="manual-native-fieldset"] span')].map((el)=>(el.textContent||'').trim()).filter((text)=>text.length > 0 && text.length < 20)`,
      );
      manualDetail = { ...manualDetail, fieldsetReady: Boolean(fieldsetReady), fieldLabels };
      // 真实键盘改「任务名称」+ 真实点击「负责人」输入并回车
      const manualTitle = `受控人工待办-${Math.floor(Math.random() * 1000)}`;
      await clickControlByLabel(cdp, '[data-testid="manual-native-fieldset"]', '任务名称', { settleMs: 200 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 65, code: 'KeyA', key: 'a', modifiers: 4, commands: ['selectAll'] });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 65, code: 'KeyA', key: 'a', modifiers: 4 });
      await cdp.send('Input.insertText', { text: manualTitle });
      await clickControlByLabel(cdp, '[data-testid="manual-native-fieldset"]', '负责人', { settleMs: 200 });
      await cdp.send('Input.insertText', { text: '1' });
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter' });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter' });
      await sleep(400);
      const submitIndex = await indexByText(cdp, 'body .ant-drawer-content button', '提 交');
      if (submitIndex < 0) throw new Error('人工处理抽屉里找不到提交按钮');
      await mouseClickSelector(cdp, 'body .ant-drawer-content button', submitIndex, { settleMs: 2500 });
      const updateReqs = writeRequests(events, 'flow_nodes:update');
      const lastUpdate = updateReqs.at(-1);
      let updateBody = null;
      try {
        updateBody = JSON.parse(lastUpdate?.postData ?? 'null');
      } catch {
        updateBody = null;
      }
      const stateAfter = await serverState();
      const savedManual = stateAfter.nodes.find((n) => n.id === manualNode?.id) ?? null;
      // 回读：整页重载后重新从受控后端读
      await gotoCanvas(cdp, DRAFT_ID);
      const reloadedManual = await evaluate(
        cdp,
        `fetch('/api/flow_nodes:list?filter=' + encodeURIComponent(JSON.stringify({ workflowId: '${DRAFT_ID}' })))
           .then((r) => r.json())
           .then((b) => { const node = (b.data || []).find((n) => n.type === 'manual'); return node ? { title: node.config?.title ?? null, mode: node.config?.mode ?? null, assignees: node.config?.assignees ?? null } : null; })`,
      );
      manualOk =
        manualDetail.registryHasManual === true &&
        manualDetail.hostAdapters?.manual === true &&
        manualDetail.manualCardReady === true &&
        Boolean(fieldsetReady) &&
        fieldLabels.some((label) => label.includes('负责人')) &&
        Boolean(manualNode) &&
        creates.at(-1)?.status === 200 &&
        String(creates.at(-1)?.postData ?? '').includes('"type":"manual"') &&
        savedManual?.config?.mode === 1 &&
        savedManual?.config?.title === manualTitle &&
        // 上游 `ManualConfig.assignees` 是 `(number | string)[]`；产品字段按文本保存，比较时统一成字符串。
        Array.isArray(savedManual?.config?.assignees) &&
        savedManual.config.assignees.map(String).includes('1') &&
        reloadedManual?.title === manualTitle &&
        reloadedManual?.mode === 1 &&
        Array.isArray(reloadedManual?.assignees) &&
        reloadedManual.assignees.map(String).includes('1') &&
        updateBody?.config?.title === manualTitle;
      manualDetail = {
        ...manualDetail,
        menuItems,
        fieldLabels,
        fieldsetReady: Boolean(fieldsetReady),
        manualNodeId: manualNode?.id ?? null,
        createStatus: creates.at(-1)?.status ?? null,
        createBody: creates.at(-1)?.postData ?? null,
        nodeCount: { before: manualBefore, after: stateAfter.nodes.length },
        savedConfig: savedManual?.config ?? null,
        reloadedManual,
        updateStatus: lastUpdate?.status ?? null,
        updateBody,
      };
    } catch (error) {
      manualDetail = { ...manualDetail, error: String(error) };
    }
    record('manual-registered-and-configured (real UI)', manualOk, manualDetail);
    shots.push(await screenshot(cdp, join(SHOTS, '06-desktop-manual-configured.png')));

    // ---------------- S12：原生 header 版本切换 → 改配置/保存 → 切回（不串线） ----------------
    let versionOk = false;
    let versionDetail = {};
    try {
      await gotoCanvas(cdp, DRAFT_ID);
      const draft1Before = await serverState();
      const draft1Node = draft1Before.nodes.find((n) => n.type === 'calculation');
      // 真实点击 header 版本下拉 → 选第二版
      await mouseClickSelector(cdp, 'button[aria-label="version"]', 0, { settleMs: 1200 });
      const revisionItems = await evaluate(
        cdp,
        `[...document.querySelectorAll('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item')].map((el)=>(el.innerText||'').replace(/\\n/g,' ').trim())`,
      );
      const draft2Index = await indexByText(cdp, '.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item', DRAFT2_ID);
      if (draft2Index < 0) throw new Error(`版本下拉里没有 ${DRAFT2_ID}`);
      await mouseClickSelector(cdp, '.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item', draft2Index, {
        settleMs: 3000,
        autoScroll: false,
      });
      await sleep(2000);
      const afterSwitch = await evaluate(
        cdp,
        `(() => { const host = document.querySelector('${CANVAS}'); return { text: (host?.innerText||'').slice(0,120), cards: host ? [...host.querySelectorAll('[class*="workflow-node-type-"]')].map((c)=>c.querySelector('[role="button"]')?.getAttribute('aria-label')||'') : [], productQuery: new URLSearchParams(location.search).get('workflowId') }; })()`,
      );
      const switchRequests = events.apiRequests
        .filter((item) => item.url.includes('workflows:get') && item.url.includes(DRAFT2_ID))
        .map((item) => `${item.method} ${item.url}`);
      // 在第二版上改配置并保存
      const expression2 = `600 + ${Math.floor(Math.random() * 1000)}`;
      await mouseClickSelector(cdp, `${CALC} .workflow-node-meta`, 0, { settleMs: 2200 });
      await waitFor(cdp, `Boolean(document.querySelector('.ant-drawer-content [contenteditable="true"]'))`, {
        timeoutMs: 15000,
        intervalMs: 400,
      });
      await mouseClickSelector(cdp, '.ant-drawer-content [contenteditable="true"]', 0, { settleMs: 400 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 65, code: 'KeyA', key: 'a', modifiers: 4, commands: ['selectAll'] });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 65, code: 'KeyA', key: 'a', modifiers: 4 });
      await cdp.send('Input.insertText', { text: expression2 });
      await sleep(400);
      const submit2 = await indexByText(cdp, 'body .ant-drawer-content button', '提 交');
      if (submit2 < 0) throw new Error('第二版抽屉里找不到提交按钮');
      await mouseClickSelector(cdp, 'body .ant-drawer-content button', submit2, { settleMs: 2500 });
      const v2Updates = writeRequests(events, 'flow_nodes:update');
      const v2Last = v2Updates.at(-1);
      // 切回第一版
      await mouseClickSelector(cdp, 'button[aria-label="version"]', 0, { settleMs: 1200 });
      const backIndex = await indexByText(cdp, '.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item', DRAFT_ID);
      await mouseClickSelector(cdp, '.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item', backIndex, {
        settleMs: 3000,
        autoScroll: false,
      });
      await sleep(2000);
      const finalState = await serverState();
      const draft1NodesAfter = finalState.versionNodes?.[DRAFT_ID] ?? [];
      const draft2NodesAfter = finalState.versionNodes?.[DRAFT2_ID] ?? [];
      const draft1NodeAfter = draft1NodesAfter.find((n) => n.id === draft1Node.id);
      const draft2Calc = draft2NodesAfter.find((n) => n.type === 'calculation');
      const backTo = await evaluate(cdp, `(() => { const host = document.querySelector('${CANVAS}'); return { text: (host?.innerText||'').slice(0,120) }; })()`);
      versionOk =
        switchRequests.length >= 1 &&
        draft2NodesAfter.length === 2 &&
        Boolean(afterSwitch.text.includes(DRAFT2_ID)) &&
        afterSwitch.productQuery === DRAFT2_ID &&
        v2Last?.status === 200 &&
        v2Last.url.includes(`filterByTk=${draft2Calc.id}`) &&
        draft2Calc.config?.expression === expression2 &&
        draft1NodeAfter.config?.expression === draft1Node.config?.expression &&
        backTo.text.includes(DRAFT_ID);
      versionDetail = {
        revisionItems,
        switchRequests,
        afterSwitch,
        updateUrl: v2Last?.url ?? null,
        updateStatus: v2Last?.status ?? null,
        draft2Expression: draft2Calc.config?.expression ?? null,
        expectedExpression2: expression2,
        draft1ExpressionBefore: draft1Node.config?.expression ?? null,
        draft1ExpressionAfter: draft1NodeAfter.config?.expression ?? null,
        backTo,
      };
    } catch (error) {
      versionDetail = { ...versionDetail, error: String(error) };
    }
    record('native-header-version-switch-and-edit-isolation', versionOk, versionDetail);
    shots.push(await screenshot(cdp, join(SHOTS, '07-desktop-version-switched-draft2.png')));

    // ---------------- S13：390 宽分支可达（原生画布标准横向滚动，非新造 pan） ----------------
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await sleep(1500);
    await gotoCanvas(cdp, WIDE_ID);
    await scrollIntoView(cdp, `${CANVAS} .workflow-canvas`);
    let wideOk = false;
    let wideDetail = {};
    try {
      const geometry = await evaluate(
        cdp,
        `(() => {
          const canvas = document.querySelector('${CANVAS} .workflow-canvas');
          const cs = getComputedStyle(canvas);
          const cards = [...document.querySelectorAll('${CANVAS} [class*="workflow-node-type-"]')];
          const boxes = cards.map((el) => { const r = el.getBoundingClientRect(); return { label: el.querySelector('[role="button"]')?.getAttribute('aria-label')||'', left: Math.round(r.left), right: Math.round(r.right), cy: Math.round(r.y + r.height/2) }; });
          return { overflowX: cs.overflow, scrollWidth: canvas.scrollWidth, clientWidth: canvas.clientWidth, scrollLeft: canvas.scrollLeft, canvasRect: (() => { const r = canvas.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(), boxes };
        })()`,
      );
      // 目标 = 初始状态下最靠右（因此最不可达）的分支节点。
      const targetLabel = geometry.boxes.reduce((max, box) => (box.left > max.left ? box : max), geometry.boxes[0]);
      // 真实滚轮在画布上横向滚动（等价触控板/Shift+滚轮的用户手势）
      const centerY = geometry.canvasRect.y + Math.min(geometry.canvasRect.h / 2, 200);
      const centerX = geometry.canvasRect.x + geometry.canvasRect.w / 2;
      let scrollAfter = geometry.scrollLeft;
      let afterScroll = null;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- 逐次滚轮是真实用户手势，直到目标进入视口
        await mouseWheel(cdp, centerX, centerY, { deltaX: 240, settleMs: 400 });
        // eslint-disable-next-line no-await-in-loop
        afterScroll = await evaluate(
          cdp,
          `(() => {
            const canvas = document.querySelector('${CANVAS} .workflow-canvas');
            const boxes = [...document.querySelectorAll('${CANVAS} [class*="workflow-node-type-"]')].map((el) => { const r = el.getBoundingClientRect(); return { label: el.querySelector('[role="button"]')?.getAttribute('aria-label')||'', left: Math.round(r.left), right: Math.round(r.right), inViewport: r.left >= 0 && r.right <= window.innerWidth }; });
            return { scrollLeft: canvas.scrollLeft, boxes };
          })()`,
        );
        // eslint-disable-next-line no-await-in-loop
        scrollAfter = afterScroll.scrollLeft;
        if (afterScroll.boxes.some((b) => b.label === targetLabel.label && b.inViewport)) break;
      }
      const reachable = afterScroll.boxes.find((b) => b.label === targetLabel.label) ?? null;
      // 真实点击已滚到视口内的远端分支节点 → 抽屉 → 保存
      const targetOutputIndex = await evaluate(
        cdp,
        `[...document.querySelectorAll('${CANVAS} .workflow-node-type-output [role="button"]')].findIndex((el) => (el.getAttribute('aria-label')||'') === ${JSON.stringify(targetLabel.label)})`,
      );
      await mouseClickSelector(
        cdp,
        `${CANVAS} .workflow-node-type-output .workflow-node-meta`,
        Math.max(0, targetOutputIndex),
        { settleMs: 2200 },
      );
      const drawerReady = await waitFor(cdp, `Boolean(document.querySelector('body .ant-drawer-content [contenteditable="true"], body .ant-drawer-content textarea, body .ant-drawer-content input'))`, {
        timeoutMs: 15000,
        intervalMs: 400,
      });
      const drawerBox = await boxOf(cdp, 'body .ant-drawer-content', 0);
      const submitIdx = await indexByText(cdp, 'body .ant-drawer-content button', '提 交');
      const submitBox = submitIdx >= 0 ? await boxOf(cdp, 'body .ant-drawer-content button', submitIdx) : null;
      let saveStatus = null;
      if (submitIdx >= 0) {
        await mouseClickSelector(cdp, 'body .ant-drawer-content button', submitIdx, { settleMs: 2000 });
        const updates = writeRequests(events, 'flow_nodes:update');
        saveStatus = updates.at(-1)?.status ?? null;
      }
      shots.push(await screenshot(cdp, join(SHOTS, '08-narrow-390-wide-branch.png')));
      wideOk =
        geometry.overflowX === 'auto' &&
        geometry.scrollWidth > geometry.clientWidth &&
        scrollAfter > geometry.scrollLeft &&
        Boolean(reachable?.inViewport) &&
        Boolean(drawerReady) &&
        Boolean(drawerBox?.inViewport && drawerBox.width <= 390) &&
        Boolean(submitBox?.inViewport) &&
        saveStatus === 200;
      wideDetail = {
        geometry: { overflowX: geometry.overflowX, scrollWidth: geometry.scrollWidth, clientWidth: geometry.clientWidth, canvasRect: geometry.canvasRect, boxCount: geometry.boxes.length },
        targetLabel: targetLabel.label,
        scrollLeftBefore: geometry.scrollLeft,
        scrollLeftAfter: scrollAfter,
        reachable,
        drawerReady: Boolean(drawerReady),
        drawerBox,
        submitBox,
        saveStatus,
        note: '用的是原生 `.workflow-canvas` 的 overflow:auto 标准横向滚动（上游样式），没有新造 pan，也没有改画布引擎。',
      };
    } catch (error) {
      wideDetail = { ...wideDetail, error: String(error) };
    }
    record('narrow-390-wide-branch-reachable (native horizontal scroll)', wideOk, wideDetail);
    await cdp.send('Emulation.clearDeviceMetricsOverride');

    evidence.steps = steps;
    evidence.shots = shots;
    evidence.controlledFinalState = await serverState();
    evidence.pageErrors = events.pageErrors.slice(0, 10);
    evidence.failed = steps.filter((s) => !s.ok).map((s) => s.name);
    evidence.exitCode = evidence.failed.length === 0 ? 0 : 1;
  } catch (error) {
    evidence.fatal = String(error?.stack ?? error);
    evidence.steps = steps;
    evidence.shots = shots;
    evidence.failed = steps.filter((s) => !s.ok).map((s) => s.name);
    evidence.exitCode = 1;
  } finally {
    close();
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`);
  const failed = evidence.failed ?? ['fatal'];
  console.error(
    `[native-workflow-controlled] ${failed.length === 0 ? 'PASS' : 'FAIL'} ${steps.length - failed.length}/${steps.length} 步通过；证据：${OUT}`,
  );
  if (evidence.fatal) console.error(evidence.fatal);
  process.exitCode = evidence.exitCode ?? 1;
}

await main();
