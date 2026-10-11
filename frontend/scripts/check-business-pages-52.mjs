#!/usr/bin/env node
/**
 * 52 轮业务文案/跨页与本机业务闭环的真实浏览器定向核对（本机合成 fixture，不打真实 13000）。
 *
 * 覆盖本轮改动：
 *  1. TD-03：可读工具题名与用途、非受理人终止禁用/只读说明、受理人可终止、待领取可领取；
 *  2. TD-04：抄送详情可读、单条已读/全部已读真的改状态，且计数随之变化；
 *  3. DS-05 → AC-04：带入所选角色（不再重置为默认角色）；
 *  4. DS-03/04：业务集合、字段（含关系）与业务记录的新增/读取；
 *  5. AC-01/02/03/04：用户角色绑定、角色成员、入口授权、数据授权各一条真实读写闭环。
 *
 * 用法（先起好 fixture 与指向它的产品预览）：
 *   CREWLOOM_PREVIEW_URL=http://127.0.0.1:5339 CREWLOOM_FIXTURE_URL=http://127.0.0.1:5417 \
 *     node scripts/check-business-pages-52.mjs
 * 环境变量：CREWLOOM_PREVIEW_URL（缺省 :5339）、CREWLOOM_FIXTURE_URL（缺省 :5417）、
 *          CREWLOOM_SHOT_DIR（缺省 .work/business-52-shots，截图只留本机）。
 */

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluate,
  goto,
  launchBrowser,
  mouseClickSelector,
  mouseClickText,
  screenshot,
  sleep,
  typeInto,
  waitFor,
} from './lib/cdp-browser.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(here, '..');
const BASE = process.env.CREWLOOM_PREVIEW_URL ?? 'http://127.0.0.1:5339';
const FIXTURE = process.env.CREWLOOM_FIXTURE_URL ?? 'http://127.0.0.1:5417';
const SHOT_DIR = process.env.CREWLOOM_SHOT_DIR ?? resolve(frontendRoot, '.work/business-52-shots');

const results = [];
let failed = 0;

function record(step, ok, detail) {
  results.push({ step, ok, detail });
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? `  — ${detail}` : ''}`);
}

async function step(name, fn) {
  try {
    const detail = await fn();
    record(name, true, typeof detail === 'string' ? detail : undefined);
    return detail;
  } catch (error) {
    record(name, false, String(error?.message ?? error).slice(0, 300));
    return null;
  }
}

/* ------------------------------ fixture 控制面 ------------------------------ */

async function fixture(path, init) {
  const response = await fetch(`${FIXTURE}${path}`, init);
  return (await response.json()).data;
}
const fixtureReset = () => fixture('/__fixture/reset', { method: 'POST' });
const fixtureScenario = (scenario) =>
  fixture('/__fixture/scenario', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario }),
  });
const fixtureLog = () => fixture('/__fixture/log');
const fixtureState = () => fixture('/__fixture/state');
const requestsOf = (log, path, since = 0) => log.slice(since).filter((entry) => entry.path === path);

async function waitForRequest(path, since, { timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = requestsOf(await fixtureLog(), path, since);
    if (found.length > 0) return found;
    await sleep(250);
  }
  return [];
}

/* ------------------------------ 页面小工具 ------------------------------ */

const bodyText = (cdp) => evaluate(cdp, 'document.body.innerText');

async function login(cdp) {
  await goto(cdp, `${BASE}/login`, 1500);
  await typeInto(cdp, 'input[name="crewloom-account"]', 'admin@fixture.test');
  await typeInto(cdp, 'input[name="crewloom-secret"]', 'fixture-password');
  await mouseClickText(cdp, 'button', '登录', { settleMs: 1500 });
  return waitFor(cdp, `location.pathname !== '/login'`, { timeoutMs: 15000 });
}

/** 按钮是否禁用（按精确文本找按钮，找不到就是失败）。 */
async function buttonDisabled(cdp, text) {
  return evaluate(
    cdp,
    `(() => {
      const button = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === ${JSON.stringify(text)});
      if (!button) return null;
      return button.disabled === true;
    })()`,
  );
}

/** 按精确文本点击（同文案按钮只允许一个命中）。 */
async function clickExact(cdp, text, { settleMs = 600 } = {}) {
  await mouseClickText(cdp, 'button', text, { settleMs });
}

async function selectValue(cdp, selector = 'select', index = 0) {
  return evaluate(cdp, `document.querySelectorAll(${JSON.stringify(selector)})[${index}]?.value ?? null`);
}

async function pickSelectOption(cdp, { index = 0, value }) {
  await evaluate(
    cdp,
    `(() => {
      const select = document.querySelectorAll('select')[${index}];
      if (!select) throw new Error('没有第 ${index} 个 select');
      select.value = ${JSON.stringify(value)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`,
  );
  await sleep(600);
}

/** 勾选/取消一个复选框（按 aria-label 精确匹配）。 */
async function setCheckbox(cdp, ariaLabel, checked) {
  const ok = await evaluate(
    cdp,
    `(() => {
      const box = document.querySelector('input[aria-label=' + JSON.stringify(${JSON.stringify(ariaLabel)}) + ']');
      if (!box) return false;
      if (box.checked !== ${checked}) box.click();
      return true;
    })()`,
  );
  if (!ok) throw new Error(`找不到复选框 ${ariaLabel}`);
  await sleep(300);
}

/** 按按钮文案前缀点击（用于 `添加所选用户（1）` 这类带计数的按钮）。 */
async function clickButtonStartingWith(cdp, prefix, { settleMs = 800 } = {}) {
  const ok = await evaluate(
    cdp,
    `(() => {
      const button = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim().startsWith(${JSON.stringify(prefix)}));
      if (!button) return false;
      button.click();
      return true;
    })()`,
  );
  if (!ok) throw new Error(`找不到以「${prefix}」开头的按钮`);
  await sleep(settleMs);
}

/** 按字段标签（Field 渲染的 <span>）给表单控件赋值，模拟真实输入事件。 */
async function fillLabeledField(cdp, labelPrefix, value) {
  const ok = await evaluate(
    cdp,
    `(() => {
      const label = [...document.querySelectorAll('label')].find((el) =>
        ((el.querySelector('span') || {}).textContent || '').trim().startsWith(${JSON.stringify(labelPrefix)}),
      );
      if (!label) return false;
      const control = label.querySelector('input, textarea');
      if (!control) return false;
      const proto = control.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(control, ${JSON.stringify(value)});
      control.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`,
  );
  if (!ok) throw new Error(`找不到字段「${labelPrefix}」的输入控件`);
  await sleep(300);
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  await fixtureReset();
  await fixtureScenario('normal');

  const browser = await launchBrowser({ debugPort: 9456, width: 1440, height: 1000 });
  const { cdp, close } = browser;

  try {
    await step('登录（本机合成账号）', async () => {
      const ok = await login(cdp);
      if (!ok) throw new Error(`登录后仍在 ${await evaluate(cdp, 'location.pathname')}`);
      return '进入应用';
    });

    /* ---------------------- 1. TD-03 AI 任务 ---------------------- */
    await step('TD-03 非受理人：只读、终止禁用、提示说明由其他人领取', async () => {
      await goto(cdp, `${BASE}/tasks/ai?sessionId=ai-task-other`, 1500);
      await waitFor(cdp, `document.body.innerText.includes('当前只读')`, { timeoutMs: 15000 });
      const text = await bodyText(cdp);
      if (!text.includes('已由其他人领取')) throw new Error('没有说明"已由其他人领取"');
      if (text.includes('任务已由你领取')) throw new Error('把别人的任务说成"已由你领取"');
      const disabled = await buttonDisabled(cdp, '终止任务');
      if (disabled !== true) throw new Error(`终止任务 disabled=${disabled}`);
      for (const label of ['批准这次调用', '修改参数后批准', '否决这次调用', '继续执行']) {
        const value = await buttonDisabled(cdp, label);
        if (value !== true) throw new Error(`${label} disabled=${value}`);
      }
      await screenshot(cdp, resolve(SHOT_DIR, 'td03-non-assignee.png'));
      return '当前只读 + 终止/决定全部禁用';
    });

    await step('TD-03 工具卡：可读题名 + 实际用途 + 必要标识与参数', async () => {
      const text = await bodyText(cdp);
      if (text.includes('executeFrontendTool')) throw new Error('仍显示内部工具名 executeFrontendTool');
      for (const title of ['读取代码工作区', '应用代码修改']) {
        if (!text.includes(title)) throw new Error(`没有可读题名「${title}」`);
      }
      if (!text.includes('只读取你当前的工作内容')) throw new Error('缺少只读用途说明');
      if (!text.includes('会修改你当前的工作内容')) throw new Error('缺少修改用途说明');
      if (!text.includes('crewloom:code-workspace:apply_code_change')) throw new Error('缺少工具标识');
      if (!text.includes('const answer = 42')) throw new Error('没有展示工具参数（代码内容）');
      if (text.includes('需要在对应的会话里执行')) throw new Error('仍保留"必须回聊天执行"的过期说明');
      return '读取代码工作区 / 应用代码修改 + 标识 + 参数';
    });

    await step('TD-03 受理人本人：终止可用且说明是本人领取', async () => {
      await goto(cdp, `${BASE}/tasks/ai?sessionId=ai-task-mine`, 1500);
      await waitFor(cdp, `document.body.innerText.includes('pending') || document.body.innerText.includes('待审核')`, {
        timeoutMs: 15000,
      });
      const text = await bodyText(cdp);
      if (!text.includes('任务已由你领取')) throw new Error('受理人提示不正确');
      const disabled = await buttonDisabled(cdp, '终止任务');
      if (disabled !== false) throw new Error(`终止任务 disabled=${disabled}`);
      return '终止任务 enabled';
    });

    await step('TD-03 待领取：领取可用（readonly 不一刀切）', async () => {
      await goto(cdp, `${BASE}/tasks/ai?sessionId=ai-task-open`, 1500);
      await waitFor(cdp, `document.body.innerText.includes('待领取')`, { timeoutMs: 15000 });
      const accept = await buttonDisabled(cdp, '领取任务');
      if (accept !== false) throw new Error(`领取任务 disabled=${accept}`);
      const reject = await buttonDisabled(cdp, '终止任务');
      if (reject !== true) throw new Error(`终止任务 disabled=${reject}`);
      return '领取可用 / 终止禁用';
    });

    /* ---------------------- 2. TD-04 抄送 ---------------------- */
    await step('TD-04 抄送列表与详情：601 能打开，不再"找不到"', async () => {
      await goto(cdp, `${BASE}/tasks/cc-list`, 1500);
      await waitFor(cdp, `document.body.innerText.includes('共 2 条')`, { timeoutMs: 15000 });
      await goto(cdp, `${BASE}/tasks/cc?id=601`, 1500);
      const text = await waitFor(
        cdp,
        `document.body.innerText.includes('抄送通知') ? document.body.innerText : ''`,
        { timeoutMs: 15000 },
      );
      if (!text) throw new Error('抄送详情没有渲染出来');
      if (text.includes('抄送详情暂时读不到')) throw new Error('详情仍读不到');
      if (!text.includes('未读')) throw new Error('601 应显示未读');
      return '详情可读、状态未读';
    });

    await step('TD-04 单条已读：状态与计数都跟着变（不推进流程）', async () => {
      const before = (await fixtureLog()).length;
      await clickExact(cdp, '标记为已读');
      const requests = await waitForRequest('workflowCcTasks:read', before);
      if (requests.length !== 1) throw new Error(`workflowCcTasks:read 请求数 ${requests.length}`);
      await waitFor(cdp, `document.body.innerText.includes('已读')`, { timeoutMs: 15000 });
      const text = await bodyText(cdp);
      if (!text.includes('这不会推进流程')) throw new Error('缺少"不推进流程"说明');
      const state = await fixtureState();
      const task = state.ccTasks.find((item) => item.id === '601');
      if (task.status !== 1 || !task.readAt) throw new Error(`fixture 状态未更新：${JSON.stringify(task)}`);
      if (state.taskStats[0].stats.pending !== 1) {
        throw new Error(`计数没跟着变：${JSON.stringify(state.taskStats[0].stats)}`);
      }
      return `read 1 次；fixture status=1；pending=${state.taskStats[0].stats.pending}`;
    });

    await step('TD-04 全部标为已读：列表全部已读且计数准确', async () => {
      await goto(cdp, `${BASE}/tasks/cc-list`, 1500);
      await waitFor(cdp, `document.body.innerText.includes('共 2 条')`, { timeoutMs: 15000 });
      const before = (await fixtureLog()).length;
      await clickExact(cdp, '全部标为已读');
      const requests = await waitForRequest('workflowCcTasks:readAll', before);
      if (requests.length !== 1) throw new Error(`readAll 请求数 ${requests.length}`);
      const state = await fixtureState();
      if (!state.ccTasks.every((item) => item.status === 1)) throw new Error('仍有未读抄送');
      // 只剩人工待办 1 条。
      if (state.taskStats[0].stats.pending !== 1) {
        throw new Error(`pending 应为 1，实为 ${state.taskStats[0].stats.pending}`);
      }
      const text = await bodyText(cdp);
      if ((text.match(/未读/g) ?? []).length > 0) throw new Error('列表仍显示未读');
      return 'readAll 1 次；全部已读；pending=1';
    });

    /* ---------------------- 3. DS-05 → AC-04 ---------------------- */
    await step('DS-05 → AC-04：进入后仍停在所选角色', async () => {
      await goto(cdp, `${BASE}/datasource/access`, 1500);
      await waitFor(cdp, `document.body.innerText.includes('前往数据授权维护')`, { timeoutMs: 15000 });
      const selected = await selectValue(cdp);
      if (!selected) throw new Error('DS-05 没有选中角色');
      await mouseClickText(cdp, 'a', '前往数据授权维护', { settleMs: 1500 });
      const url = await evaluate(cdp, 'location.pathname + location.search');
      if (!url.startsWith('/access/data')) throw new Error(`落到 ${url}`);
      const role = new URLSearchParams(url.split('?')[1] ?? '').get('role');
      if (role !== selected) throw new Error(`链接角色 ${role} ≠ 所选 ${selected}`);
      const applied = await selectValue(cdp);
      if (applied !== selected) throw new Error(`进入后角色被重置为 ${applied}，期望 ${selected}`);
      return `${url}（角色 ${selected} 保留）`;
    });

    /* ---------------------- 4. DS-03 / DS-04 ---------------------- */
    await step('DS-03 集合与字段：客户集合与关系字段可见', async () => {
      await goto(cdp, `${BASE}/datasource/tables`, 1500);
      await waitFor(cdp, `document.body.innerText.includes('客户')`, { timeoutMs: 15000 });
      const list = await bodyText(cdp);
      if (!list.includes('订单')) throw new Error('集合列表缺少订单');
      await goto(cdp, `${BASE}/datasource/tables/customers`, 1500);
      const detail = await waitFor(
        cdp,
        `document.body.innerText.includes('owner') ? document.body.innerText : ''`,
        { timeoutMs: 15000 },
      );
      if (!detail) throw new Error('客户字段清单里没有 owner');
      if (!/users|belongsTo|多对一/.test(detail)) throw new Error('关系字段的目标没有展示');
      return 'customers/orders + owner 关系字段';
    });

    await step('DS-04 业务记录：列表带关系对象，新增一条后列表与 fixture 都变化', async () => {
      await goto(cdp, `${BASE}/datasource/preview/customers`, 1500);
      await waitFor(cdp, `document.body.innerText.includes('合成客户甲')`, { timeoutMs: 15000 });
      const list = await bodyText(cdp);
      if (!list.includes('李四')) throw new Error('关系对象（负责人）没有显示');

      await clickExact(cdp, '新增记录', { settleMs: 800 });
      await waitFor(cdp, `document.body.innerText.includes('新增记录')`, { timeoutMs: 10000 });
      await fillLabeledField(cdp, 'name', '合成客户戊');
      await fillLabeledField(cdp, 'amount', '321');
      await fillLabeledField(cdp, 'status', 'active');
      const before = (await fixtureLog()).length;
      await clickExact(cdp, '保存', { settleMs: 1200 });
      const created = await waitForRequest('customers:create', before);
      if (created.length !== 1) throw new Error(`customers:create 次数 ${created.length}`);
      const state = await fixtureState();
      if (!state.records.customers.some((row) => row.name === '合成客户戊')) {
        throw new Error('fixture 没有新增记录');
      }
      await goto(cdp, `${BASE}/datasource/preview/customers`, 1200);
      await waitFor(cdp, `document.body.innerText.includes('合成客户戊')`, { timeoutMs: 15000 });
      await screenshot(cdp, resolve(SHOT_DIR, 'ds04-record-created.png'));
      return `customers:create 1 次；读回 ${state.records.customers.length} 条`;
    });

    /* ---------------------- 5. AC-01 / AC-02 ---------------------- */
    await step('AC-01 用户角色绑定：保存后用户详情与角色成员一致', async () => {
      await goto(cdp, `${BASE}/access/users/2`, 1800);
      await waitFor(cdp, `document.body.innerText.includes('李四')`, { timeoutMs: 15000 });
      // 角色勾选：把「审计」勾上。
      const picked = await evaluate(
        cdp,
        `(() => {
          const label = [...document.querySelectorAll('label')].find((el) => (el.textContent || '').trim().startsWith('审计'));
          if (!label) return false;
          const box = label.querySelector('input[type=checkbox]');
          if (!box) return false;
          if (!box.checked) box.click();
          return true;
        })()`,
      );
      if (!picked) throw new Error('没有找到「审计」角色勾选框');
      const before = (await fixtureLog()).length;
      await clickExact(cdp, '保存角色', { settleMs: 1200 });
      const updates = await waitForRequest('users:update', before);
      if (updates.length !== 1) throw new Error(`users:update 次数 ${updates.length}`);
      const state = await fixtureState();
      if (!(state.roleUsers.r_audit ?? []).includes(2)) {
        throw new Error(`角色成员没有写回：${JSON.stringify(state.roleUsers)}`);
      }
      await goto(cdp, `${BASE}/access/roles/r_audit`, 1500);
      const text = await waitFor(cdp, `document.body.innerText.includes('李四') ? document.body.innerText : ''`, {
        timeoutMs: 15000,
      });
      if (!text) throw new Error('角色详情里看不到李四');
      return 'users:update 1 次；r_audit 成员含李四';
    });

    await step('AC-02 角色成员：从候选加入成员甲并读回', async () => {
      await goto(cdp, `${BASE}/access/roles/r_sales`, 1500);
      await waitFor(cdp, `document.body.innerText.includes('成员')`, { timeoutMs: 15000 });
      const clicked = await evaluate(
        cdp,
        `(() => {
          const box = document.querySelector('input[aria-label^="选择候选 "]');
          if (!box) return null;
          const label = box.getAttribute('aria-label');
          if (!box.checked) box.click();
          return label;
        })()`,
      );
      if (!clicked) throw new Error('没有候选成员可选');
      const before = (await fixtureLog()).length;
      await clickButtonStartingWith(cdp, '添加所选用户', { settleMs: 1200 });
      const added = await waitForRequest('roles/r_sales/users:add', before);
      if (added.length !== 1) throw new Error(`users:add 次数 ${added.length}`);
      const state = await fixtureState();
      const members = state.roleUsers.r_sales ?? [];
      if (members.length < 2) throw new Error(`成员没有增加：${JSON.stringify(members)}`);
      return `users:add 1 次；r_sales 成员 ${JSON.stringify(members)}`;
    });

    /* ---------------------- 6. AC-03 / AC-04 ---------------------- */
    await step('AC-03 入口授权：取消两条原页面路由并保存', async () => {
      await goto(cdp, `${BASE}/access/features`, 1800);
      await waitFor(cdp, `document.body.innerText.includes('原页面路由授权')`, { timeoutMs: 15000 });
      await setCheckbox(cdp, '原页面路由 13', false);
      await setCheckbox(cdp, '原页面路由 14', false);
      const before = (await fixtureLog()).length;
      await clickExact(cdp, '保存入口授权', { settleMs: 1200 });
      const removed = await waitForRequest('roles/root/desktopRoutes:remove', before);
      if (removed.length !== 1) throw new Error(`desktopRoutes:remove 次数 ${removed.length}`);
      const state = await fixtureState();
      if (JSON.stringify(state.roleDesktopRoutes.root) !== JSON.stringify([11, 12])) {
        throw new Error(`入口授权没有写回：${JSON.stringify(state.roleDesktopRoutes.root)}`);
      }
      return `remove 1 次；root 现有 ${JSON.stringify(state.roleDesktopRoutes.root)}`;
    });

    await step('AC-04 数据授权：勾选动作并保存（真实 applyDataPermissions）', async () => {
      await goto(cdp, `${BASE}/access/data?role=r_sales`, 1800);
      await waitFor(cdp, `document.body.innerText.includes('动作授权')`, { timeoutMs: 15000 });
      const role = await selectValue(cdp);
      if (role !== 'r_sales') throw new Error(`角色应为 r_sales，实为 ${role}`);
      await mouseClickText(cdp, 'button', 'customers', { settleMs: 800 });
      await waitFor(cdp, `document.body.innerText.includes('动作授权：customers')`, { timeoutMs: 15000 });
      await setCheckbox(cdp, '启用动作 create', true);
      const before = (await fixtureLog()).length;
      await mouseClickText(cdp, 'button', '保存', { settleMs: 1500 });
      const applied = await waitForRequest('roles:applyDataPermissions', before);
      if (applied.length !== 1) throw new Error(`applyDataPermissions 次数 ${applied.length}`);
      const state = await fixtureState();
      const resource = state.roleResources.r_sales.find((row) => row.name === 'customers');
      const actions = state.resourceActions
        .filter((row) => row.rolesResourceId === resource.id)
        .map((row) => row.name);
      if (!actions.includes('create')) throw new Error(`动作没有写回：${JSON.stringify(actions)}`);
      return `applyDataPermissions 1 次；customers 动作 ${JSON.stringify(actions)}`;
    });

    /* ---------------------- 7. 文案与内部术语 ---------------------- */
    await step('业务可见文案：工具/知识库页不再出现注册表与插件实现说明', async () => {
      await goto(cdp, `${BASE}/ai/tools`, 1800);
      const tools = await waitFor(cdp, `document.body.innerText.includes('工具清单') ? document.body.innerText : ''`, {
        timeoutMs: 15000,
      });
      for (const forbidden of ['注册表', '后端一次性返回', '本地筛选', '服务端分页']) {
        if (tools.includes(forbidden)) throw new Error(`工具页仍出现「${forbidden}」`);
      }
      await goto(cdp, `${BASE}/ai/knowledge`, 1500);
      const knowledge = await waitFor(
        cdp,
        `document.body.innerText.includes('能力未开通') ? document.body.innerText : ''`,
        { timeoutMs: 15000 },
      );
      if (!knowledge) throw new Error('知识库页没有渲染');
      for (const forbidden of ['插件', '接口', '集合']) {
        if (knowledge.includes(forbidden)) throw new Error(`知识库页仍出现「${forbidden}」`);
      }
      return '工具页/知识库页无内部实现说明';
    });

    await step('模块首页：入口只列已实现页面，无内部术语', async () => {
      await goto(cdp, `${BASE}/ai`, 1500);
      const text = await waitFor(cdp, `document.body.innerText.includes('员工目录') ? document.body.innerText : ''`, {
        timeoutMs: 15000,
      });
      if (!text) throw new Error('数字员工模块首页没有渲染');
      if (text.includes(':username') || text.includes(':sessionId')) throw new Error('出现参数死链');
      if (text.includes('尚未开放')) throw new Error('出现占位文案');
      return '入口列表正常';
    });
  } finally {
    close();
  }

  console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}  (${results.length} steps)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
