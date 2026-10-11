#!/usr/bin/env node
/**
 * 最终页面 UI 的真实浏览器核对（本机合成 fixture，不打真实 13000）。
 *
 * 覆盖（全部通过真实鼠标/键盘与真实 multipart 上传）：
 *  1. 四方向关联维护：部门→成员、部门→角色、用户→部门、角色→部门，
 *     每一步都断言 **fixture 收到的精确请求**（路径/方法/请求体）与 **界面读回**；
 *  2. 取消（整体替换的二次确认可取消）；
 *  3. 空态（scenario=empty：是"暂无成员"而不是"未开通"）；
 *  4. 403（scenario=forbidden：中文权限提示，不冒充空数据）；
 *  5. 角色 epoch（scenario=role401：`ROLE_NOT_FOUND_FOR_USER` 不把已登录用户踢下线）；
 *  6. 头像宿主：AC-01（真实 multipart 上传 → users:update 写引用 → 可见显示 → 移除）
 *     与 AI-02（真实头像标识渲染 → 点选 → aiEmployees:update 提交标识）；
 *  7. 工作台跨页入口（员工/会话/待办含抄送）与 DS-05 → AC-04，全部真实点击并检查落点；
 *  8. 390 窄屏：documentElement.scrollWidth 与关键控件 boundingBox 都在视口内 + 截图。
 *
 * 用法（需要 5326 上已有指向 fixture 的 vite dev/preview）：
 *   node tests/modules/access/browser-final-pages-ui.mjs
 * 环境变量：
 *   CREWLOOM_PREVIEW_URL（缺省 http://127.0.0.1:5326）
 *   CREWLOOM_FIXTURE_URL（缺省 http://127.0.0.1:5405）
 *   CREWLOOM_SHOT_DIR（缺省 docs/acceptance/full-pages-13000/final-pages-ui-evidence）
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  boxOf,
  evaluate,
  goto,
  launchBrowser,
  mouseClickSelector,
  mouseClickText,
  screenshot,
  sleep,
  typeInto,
  waitFor,
} from '../../../scripts/lib/cdp-browser.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(here, '..', '..', '..');
const repoRoot = resolve(frontendRoot, '..');
const BASE = process.env.CREWLOOM_PREVIEW_URL ?? 'http://127.0.0.1:5326';
const FIXTURE = process.env.CREWLOOM_FIXTURE_URL ?? 'http://127.0.0.1:5405';
const SHOT_DIR = process.env.CREWLOOM_SHOT_DIR
  ?? resolve(repoRoot, 'docs/acceptance/full-pages-13000/final-pages-ui-evidence/screenshots');
const FILE_TO_UPLOAD = resolve(frontendRoot, 'tests/modules/access/.tmp-avatar-upload.png');

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
  const payload = await response.json();
  return payload.data;
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

/** 取日志里某路径的请求（可只取最近 N 条之后的）。 */
function requestsOf(log, path, since = 0) {
  return log.slice(since).filter((entry) => entry.path === path);
}

/** 轮询 fixture 日志直到出现某个请求（UI 的保存是异步的，不要用固定 sleep 赌时序）。 */
async function waitForRequest(path, since, { timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = requestsOf(await fixtureLog(), path, since);
    if (found.length > 0) return found;
    await sleep(250);
  }
  return [];
}

/* ------------------------------ 浏览器小工具 ------------------------------ */

/**
 * 按**精确文本**点击（用于区分「移除」与「移除所选成员（0）」这类同前缀按钮）。
 *
 * `scope` 是 CSS 选择器前缀（例如某个关联编辑器的 `data-testid`），
 * 避免靠"第几个按钮"这种脆弱顺序定位。
 */
async function clickExactText(cdp, scope, selector, text, nth = 0) {
  const css = scope ? `${scope} ${selector}` : selector;
  const indexes = await evaluate(
    cdp,
    `(() => {
      const list = [...document.querySelectorAll(${JSON.stringify(css)})];
      const out = [];
      list.forEach((el, index) => {
        if ((el.textContent || '').trim() === ${JSON.stringify(text)}) out.push(index);
      });
      return out;
    })()`,
  );
  if (!indexes || indexes.length <= nth) throw new Error(`找不到 ${scope} 下第 ${nth + 1} 个「${text}」`);
  return mouseClickSelector(cdp, css, indexes[nth], { settleMs: 500 });
}

/** 在某个关联编辑器里点选候选（点 label 等价真实用户点击复选框文字）。 */
async function pickCandidate(cdp, testId, text) {
  return clickContainingText(cdp, `[data-testid=${testId}]`, 'label', text, 0);
}

async function clickContainingText(cdp, scope, selector, text, nth = 0) {
  const css = scope ? `${scope} ${selector}` : selector;
  const indexes = await evaluate(
    cdp,
    `(() => {
      const list = [...document.querySelectorAll(${JSON.stringify(css)})];
      const out = [];
      list.forEach((el, index) => {
        if ((el.textContent || '').includes(${JSON.stringify(text)})) out.push(index);
      });
      return out;
    })()`,
  );
  if (!indexes || indexes.length <= nth) throw new Error(`找不到 ${css} 下第 ${nth + 1} 个包含「${text}」的元素`);
  return mouseClickSelector(cdp, css, indexes[nth], { settleMs: 500 });
}

/** 真实文件选择（CDP 的 DOM.setFileInputFiles 等价用户在选择器里选文件）。 */
async function uploadFile(cdp, selector, filePath) {
  await cdp.send('DOM.enable');
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  if (!nodeId) throw new Error(`找不到文件输入：${selector}`);
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [filePath] });
  await sleep(800);
}

function bodyText(cdp) {
  return evaluate(cdp, 'document.body.innerText');
}

async function login(cdp) {
  await goto(cdp, `${BASE}/login`, 1500);
  await typeInto(cdp, 'input[name="crewloom-account"]', 'admin@fixture.test');
  await typeInto(cdp, 'input[name="crewloom-secret"]', 'fixture-password');
  await mouseClickText(cdp, 'button', '登录', { settleMs: 1500 });
  return waitFor(cdp, `location.pathname !== '/login'`, { timeoutMs: 15000 });
}

async function overflow(cdp) {
  return evaluate(
    cdp,
    `(() => {
      const doc = document.documentElement;
      return { innerWidth: window.innerWidth, scrollWidth: doc.scrollWidth, bodyScrollWidth: document.body.scrollWidth };
    })()`,
  );
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  // 一个真实的小 PNG（1x1），只用于"用户真的选了一个文件"。
  writeFileSync(
    FILE_TO_UPLOAD,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64',
    ),
  );

  await fixtureReset();

  const browser = await launchBrowser({ debugPort: 9455, width: 1440, height: 1000 });
  const { cdp, events, close } = browser;

  try {
    await step('登录（合成 fixture 的认证）', async () => {
      const ok = await login(cdp);
      if (!ok) throw new Error(`登录后仍在 ${await evaluate(cdp, 'location.pathname')}`);
      return '进入应用';
    });

    /* ------------------------- 1. 部门 → 成员 ------------------------- */
    await step('部门成员：真实加入候选成员，请求体是用户 id 裸数组且界面读回', async () => {
      await goto(cdp, `${BASE}/access/departments`, 1500);
      await waitFor(cdp, `document.body.innerText.includes('成员甲')`, { timeoutMs: 15000 });
      const before = (await fixtureLog()).length;

      await pickCandidate(cdp, 'department-members-editor', '成员乙');
      await clickContainingText(cdp, '[data-testid=department-members-editor]', 'button', '加入成员（已选 1）');

      const added = requestsOf(await fixtureLog(), 'departments/1/members:add', before);
      if (added.length !== 1) throw new Error(`期望 1 个 members:add，实到 ${added.length}`);
      if (added[0].method !== 'POST') throw new Error(`期望 POST，实到 ${added[0].method}`);
      if (JSON.stringify(added[0].body) !== '[102]') throw new Error(`请求体不是 [102]：${JSON.stringify(added[0].body)}`);
      const updated = await waitFor(cdp, `document.body.innerText.includes('成员乙')`, { timeoutMs: 8000 });
      if (!updated) throw new Error('界面没有读回新成员');
      const state = await fixtureState();
      if (!state.deptMembers['1'].includes(102)) throw new Error('fixture 端没有落库');
      return 'POST departments/1/members:add [102] + 列表更新';
    });

    await step('部门成员：移除成员，请求体是用户 id 裸数组且界面读回', async () => {
      const before = (await fixtureLog()).length;
      await clickExactText(cdp, '[data-testid=department-members-editor]', 'button', '移除', 0);
      const removed = requestsOf(await fixtureLog(), 'departments/1/members:remove', before);
      if (removed.length !== 1) throw new Error(`期望 1 个 members:remove，实到 ${removed.length}`);
      if (JSON.stringify(removed[0].body) !== '[101]') throw new Error(`请求体不是 [101]：${JSON.stringify(removed[0].body)}`);
      // 读回断言只看"已关联成员"表格：被移除的人会重新出现在候选里，页面文本整体仍含他的名字。
      const gone = await waitFor(
        cdp,
        `!([...document.querySelectorAll('[data-testid=department-members-editor] table')].map((t) => t.textContent).join('').includes('成员甲'))`,
        { timeoutMs: 8000 },
      );
      if (!gone) throw new Error('已关联成员表格里仍然显示成员甲');
      return 'POST departments/1/members:remove [101] + 列表更新';
    });

    await step('部门成员：整体替换是可取消的完整名单选择（含取消已有项后按最终名单提交）', async () => {
      await pickCandidate(cdp, 'department-members-editor', '成员丙');
      await clickContainingText(cdp, '[data-testid=department-members-editor]', 'button', '整体替换成员');
      const confirmShown = await bodyText(cdp);
      if (!confirmShown.includes('最终名单：默认勾选当前已关联项和本次所选')) throw new Error('没有出现完整名单面板');
      const before = (await fixtureLog()).length;
      await clickExactText(cdp, '[data-testid=department-members-editor]', 'button', '取消', 0);
      const after = await fixtureLog();
      const sets = requestsOf(after, 'departments/1/members:set', before);
      if (sets.length !== 0) throw new Error('取消后仍发出了 members:set');

      // 默认名单 = 当前已关联（102）+ 本次所选（103）。
      const beforeDefault = after.length;
      await clickContainingText(cdp, '[data-testid=department-members-editor]', 'button', '整体替换成员');
      await clickContainingText(cdp, '[data-testid=department-members-editor]', 'button', '确认替换');
      const appliedDefault = requestsOf(await fixtureLog(), 'departments/1/members:set', beforeDefault);
      if (appliedDefault.length !== 1) throw new Error(`期望 1 个 members:set，实到 ${appliedDefault.length}`);
      if (JSON.stringify(appliedDefault[0].body) !== '[102,103]') {
        throw new Error(`默认名单不是 [102,103]：${JSON.stringify(appliedDefault[0].body)}`);
      }

      // 在面板里取消一个**已有项**（102），提交的应是最终名单 [103]，不是固定并集。
      const beforeTrim = (await fixtureLog()).length;
      await clickContainingText(cdp, '[data-testid=department-members-editor]', 'button', '整体替换成员');
      await clickContainingText(
        cdp,
        '[data-testid=department-members-editor-set-panel]',
        'label',
        '成员乙',
        0,
      );
      await clickContainingText(cdp, '[data-testid=department-members-editor]', 'button', '确认替换');
      const appliedTrim = requestsOf(await fixtureLog(), 'departments/1/members:set', beforeTrim);
      if (appliedTrim.length !== 1) throw new Error(`期望 1 个 members:set，实到 ${appliedTrim.length}`);
      if (JSON.stringify(appliedTrim[0].body) !== '[103]') {
        throw new Error(`取消已有项后的最终名单不是 [103]：${JSON.stringify(appliedTrim[0].body)}`);
      }
      return '取消 0 请求；默认 [102,103]；取消已有项 102 后提交 [103]（最终名单，非固定并集）';
    });

    /* ------------------------- 2. 部门 → 角色 ------------------------- */
    await step('部门角色：关联角色（角色名数组）并可取消关联', async () => {
      const before = (await fixtureLog()).length;
      await pickCandidate(cdp, 'department-roles-editor', '审计');
      await clickContainingText(cdp, '[data-testid=department-roles-editor]', 'button', '关联角色（已选 1）');
      const log = await fixtureLog();
      const added = requestsOf(log, 'departments/1/roles:add', before);
      if (added.length !== 1) throw new Error(`期望 1 个 roles:add，实到 ${added.length}`);
      if (JSON.stringify(added[0].body) !== '["r_audit"]') throw new Error(`请求体不是 ["r_audit"]：${JSON.stringify(added[0].body)}`);
      const shown = await waitFor(cdp, `document.body.innerText.includes('审计')`, { timeoutMs: 8000 });
      if (!shown) throw new Error('界面没有读回部门角色');

      const beforeRemove = (await fixtureLog()).length;
      await clickExactText(cdp, '[data-testid=department-roles-editor]', 'button', '移除', 0);
      const removed = requestsOf(await fixtureLog(), 'departments/1/roles:remove', beforeRemove);
      if (removed.length !== 1) throw new Error(`期望 1 个 roles:remove，实到 ${removed.length}`);
      if (JSON.stringify(removed[0].body) !== '["r_sales"]') throw new Error(`请求体不是 ["r_sales"]：${JSON.stringify(removed[0].body)}`);
      return 'POST departments/1/roles:add ["r_audit"] / roles:remove ["r_sales"]';
    });

    /* ------------------------- 3. 用户 → 部门 ------------------------- */
    await step('用户部门：加入部门 + 设为主部门（真实字段 mainDepartmentId）', async () => {
      await goto(cdp, `${BASE}/access/users/2`, 1500);
      await waitFor(cdp, `document.body.innerText.includes('所属部门')`, { timeoutMs: 15000 });
      const before = (await fixtureLog()).length;
      await pickCandidate(cdp, 'user-departments-editor', '销售部');
      await clickContainingText(cdp, '[data-testid=user-departments-editor]', 'button', '加入部门（已选 1）');
      const added = requestsOf(await fixtureLog(), 'users/2/departments:add', before);
      if (added.length !== 1) throw new Error(`期望 1 个 users/2/departments:add，实到 ${added.length}`);
      if (JSON.stringify(added[0].body) !== '[3]') throw new Error(`请求体不是 [3]：${JSON.stringify(added[0].body)}`);

      const beforeMain = (await fixtureLog()).length;
      await clickExactText(cdp, '[data-testid=user-departments-editor]', 'button', '设为主部门', 0);
      const main = requestsOf(await fixtureLog(), 'users:update', beforeMain);
      if (main.length !== 1) throw new Error(`期望 1 个 users:update，实到 ${main.length}`);
      if (JSON.stringify(main[0].body) !== '{"mainDepartmentId":3}') {
        throw new Error(`主部门载荷不对：${JSON.stringify(main[0].body)}`);
      }
      return 'POST users/2/departments:add [3] + users:update {mainDepartmentId:3}';
    });

    /* ------------------------- 4. 角色 → 部门 ------------------------- */
    await step('角色部门：关联与取消关联（部门 id 数组）', async () => {
      await goto(cdp, `${BASE}/access/roles/r_sales`, 1500);
      const roleReady = await waitFor(cdp, `document.body.innerText.includes('关联部门')`, { timeoutMs: 15000 });
      if (!roleReady) throw new Error('角色详情页没有渲染出关联部门区域');
      const candidateReady = await waitFor(
        cdp,
        `!![...document.querySelectorAll('[data-testid=role-departments-editor] label')].find((el) => el.textContent.includes('财务部'))`,
        { timeoutMs: 15000 },
      );
      if (!candidateReady) throw new Error('候选部门里没有财务部');
      const before = (await fixtureLog()).length;
      await pickCandidate(cdp, 'role-departments-editor', '财务部');
      await clickContainingText(cdp, '[data-testid=role-departments-editor]', 'button', '关联部门（已选 1）');
      const added = requestsOf(await fixtureLog(), 'roles/r_sales/departments:add', before);
      if (added.length !== 1) throw new Error(`期望 1 个 roles/r_sales/departments:add，实到 ${added.length}`);
      if (JSON.stringify(added[0].body) !== '[2]') throw new Error(`请求体不是 [2]：${JSON.stringify(added[0].body)}`);

      const beforeRemove = (await fixtureLog()).length;
      await clickExactText(cdp, '[data-testid=role-departments-editor]', 'button', '移除', 0);
      const removed = requestsOf(await fixtureLog(), 'roles/r_sales/departments:remove', beforeRemove);
      if (removed.length !== 1) throw new Error(`期望 1 个 roles/r_sales/departments:remove，实到 ${removed.length}`);
      if (JSON.stringify(removed[0].body) !== '[1]') throw new Error(`请求体不是 [1]：${JSON.stringify(removed[0].body)}`);
      return 'POST roles/r_sales/departments:add [2] / remove [1]';
    });

    /* ------------------------- 5. 头像宿主 ------------------------- */
    await step('AC-01 用户头像：真实 multipart 上传 → 保存引用 → 可见显示 → 移除', async () => {
      await goto(cdp, `${BASE}/access/users/2`, 1500);
      // 必须锁定**页面里**这个宿主：顶栏账号菜单里也有一个头像控件（同一个 AttachmentControl）。
      await waitFor(
        cdp,
        `!!document.querySelector('[data-testid=user-avatar-host] input[type=file]')`,
        { timeoutMs: 15000 },
      );
      const before = (await fixtureLog()).length;
      await uploadFile(cdp, '[data-testid=user-avatar-host] input[type=file]', FILE_TO_UPLOAD);

      const log = await fixtureLog();
      const upload = requestsOf(log, 'attachments:upload', before);
      if (upload.length !== 1) throw new Error(`期望 1 个 attachments:upload，实到 ${upload.length}`);
      if (upload[0].method !== 'POST') throw new Error('上传不是 POST');
      if (upload[0].query.attachmentField !== 'users.avatar') {
        throw new Error(`缺少 attachmentField=users.avatar：${JSON.stringify(upload[0].query)}`);
      }
      if (!upload[0].body?.multipart) throw new Error('上传不是 multipart');

      const save = await waitForRequest('users:update', before);
      if (save.length < 1) throw new Error('上传后没有发出 users:update');
      if (save[0].query.filterByTk !== '2') {
        throw new Error(`保存的父记录不对：filterByTk=${save[0].query.filterByTk}`);
      }
      if (JSON.stringify(save[0].body) !== '{"avatar":{"id":90}}') {
        throw new Error(`保存载荷不对：${JSON.stringify(save[0].body)}`);
      }
      const shown = await waitFor(
        cdp,
        `(document.querySelector('[data-testid=user-avatar-host] img')?.getAttribute('src') ?? '').includes('/files/')`,
        { timeoutMs: 8000 },
      );
      if (!shown) throw new Error('页面宿主没有显示新头像');

      // 头像宿主里的"移除"要精确点：页面上还有账号菜单与部门关联的"移除"按钮。
      const removeReady = await waitFor(
        cdp,
        `!![...document.querySelectorAll('[data-testid=user-avatar-host] button')].find((el) => el.textContent.trim() === '移除')`,
        { timeoutMs: 10000 },
      );
      if (!removeReady) throw new Error('头像宿主没有渲染出移除按钮');
      const beforeRemove = (await fixtureLog()).length;
      await clickExactText(cdp, '[data-testid=user-avatar-host]', 'button', '移除', 0);
      const cleared = await waitForRequest('users:update', beforeRemove);
      if (cleared.length < 1) throw new Error('移除后没有发出 users:update');
      if (cleared[0].query.filterByTk !== '2' || JSON.stringify(cleared[0].body) !== '{"avatar":null}') {
        throw new Error(`移除载荷不对：${JSON.stringify(cleared[0])}`);
      }
      return 'multipart upload(users.avatar) + users:update?filterByTk=2 {avatar:{id}} → 显示 → {avatar:null}';
    });

    await step('AC-01 头像字段不存在时：不渲染上传入口，显示能力缺失说明', async () => {
      await fixtureScenario('no-avatar-field');
      await goto(cdp, `${BASE}/access/users/2`, 1500);
      const text = await waitFor(
        cdp,
        `document.body.innerText.includes('本系统还没有开启用户头像功能') ? document.body.innerText : ''`,
        { timeoutMs: 15000 },
      );
      if (!text) throw new Error('没有显示"本系统还没有开启用户头像功能"的能力缺失说明');
      const hasInput = await evaluate(cdp, `!!document.querySelector('[data-testid=user-avatar-host] input[type=file]')`);
      if (hasInput) throw new Error('能力缺失时仍渲染了文件上传入口');
      const before = (await fixtureLog()).length;
      await sleep(500);
      if (requestsOf(await fixtureLog(), 'attachments:upload', before).length !== 0) {
        throw new Error('能力缺失时仍发生了上传');
      }
      await fixtureScenario('normal');
      return '能力缺失态（无上传入口、无上传请求）';
    });

    await step('AI-02 员工头像：真实标识渲染 → 点选内置头像 → aiEmployees:update 提交标识', async () => {
      await goto(cdp, `${BASE}/ai/employees-config/employee-a`, 1500);
      await waitFor(cdp, `!!document.querySelector('[data-testid=employee-avatar-host]')`, { timeoutMs: 15000 });
      const firstSrc = await evaluate(cdp, `document.querySelector('[data-testid=employee-avatar-host] img')?.getAttribute('src') ?? ''`);
      if (!firstSrc.startsWith('data:image/svg+xml')) throw new Error('当前头像没有用真实渲染链渲染');
      await mouseClickText(cdp, 'button', '选择头像', { settleMs: 500 });
      const before = (await fixtureLog()).length;
      await mouseClickSelector(cdp, '[role="option"][aria-label="nocobase-001-male"]', 0, { settleMs: 300 });
      const afterPick = await evaluate(cdp, `document.querySelector('[data-testid=employee-avatar-host] img')?.getAttribute('src') ?? ''`);
      if (afterPick === firstSrc) throw new Error('点选后头像没有变化');
      await mouseClickText(cdp, 'button', '保存配置', { settleMs: 1200 });
      const updates = requestsOf(await fixtureLog(), 'aiEmployees:update', before);
      if (updates.length !== 1) throw new Error(`期望 1 个 aiEmployees:update，实到 ${updates.length}`);
      if (updates[0].body?.avatar !== 'nocobase-001-male') {
        throw new Error(`提交的头像标识不对：${JSON.stringify(updates[0].body?.avatar)}`);
      }
      if (requestsOf(await fixtureLog(), 'attachments:upload', before).length !== 0) {
        throw new Error('员工头像不应上传附件');
      }
      return 'aiEmployees:update {avatar:"nocobase-001-male"}（无附件上传）';
    });

    /* ------------------------- 6. 工作台 / DS-05 ------------------------- */
    await step('工作台：员工/会话/待办（含抄送）入口真实点击并落到对应详情页', async () => {
      await goto(cdp, `${BASE}/workbench`, 1500);
      await waitFor(cdp, `document.body.innerText.includes('最近待办')`, { timeoutMs: 15000 });
      const targets = [
        { text: '打开会话', href: '/ai/conversations/session-1' },
        { text: '查看员工', href: '/ai/directory/employee-a' },
        { text: '去处理', href: '/tasks/manual?id=501' },
        { text: '查看', href: '/tasks/cc?id=601' },
      ];
      const visited = [];
      for (const target of targets) {
        await goto(cdp, `${BASE}/workbench`, 1200);
        // 入口文案真实存在，且渲染成指向注册页面 href 的链接（不是降级文案）。
        const found = await waitFor(
          cdp,
          `[...document.querySelectorAll('a')].some((a) => a.getAttribute('href') === ${JSON.stringify(target.href)})`,
          { timeoutMs: 15000 },
        );
        if (!found) throw new Error(`没有渲染出 ${target.href} 的入口链接`);
        await mouseClickSelector(cdp, `a[href="${target.href}"]`, 0, { settleMs: 1200 });
        const path = await evaluate(cdp, `location.pathname + location.search`);
        if (path !== target.href) throw new Error(`「${target.text}」落到 ${path}，期望 ${target.href}`);
        const text = await bodyText(cdp);
        if (text.includes('尚未开放')) throw new Error(`「${target.text}」目标页仍显示"尚未开放"`);
        visited.push(`${target.text}→${path}`);
      }
      return visited.join('；');
    });

    await step('工作台：待办列表入口真实点击（/tasks/pending 与 /tasks/cc-list）', async () => {
      await goto(cdp, `${BASE}/workbench/my-tasks`, 1500);
      await waitFor(cdp, `document.body.innerText.includes('前往我的待办')`, { timeoutMs: 15000 });
      await mouseClickText(cdp, 'a', '前往我的待办', { settleMs: 1200 });
      const pending = await evaluate(cdp, 'location.pathname');
      await goto(cdp, `${BASE}/workbench/my-tasks`, 1200);
      await mouseClickText(cdp, 'a', '查看抄送', { settleMs: 1200 });
      const cc = await evaluate(cdp, 'location.pathname');
      if (pending !== '/tasks/pending') throw new Error(`待办入口落到 ${pending}`);
      if (cc !== '/tasks/cc-list') throw new Error(`抄送入口落到 ${cc}`);
      return '/tasks/pending；/tasks/cc-list';
    });

    await step('DS-05 → AC-04：数据源访问配置入口真实点击进入数据授权页并保留所选角色', async () => {
      await goto(cdp, `${BASE}/datasource/access`, 1500);
      await waitFor(cdp, `document.body.innerText.includes('前往数据授权维护')`, { timeoutMs: 15000 });
      // DS-05 默认选中的角色（角色按 name 排序后第一个 r_ 前缀角色）。
      const selected = await evaluate(
        cdp,
        `document.querySelector('select')?.value ?? ''`,
      );
      if (!selected) throw new Error('DS-05 没有选中角色');
      await mouseClickText(cdp, 'a', '前往数据授权维护', { settleMs: 1500 });
      const url = await evaluate(cdp, 'location.pathname + location.search');
      if (!url.startsWith('/access/data')) throw new Error(`落到 ${url}`);
      const role = new URLSearchParams(url.split('?')[1] ?? '').get('role');
      if (role !== selected) throw new Error(`角色没有带过去：DS-05 选中 ${selected}，链接里是 ${role}`);
      const heading = await evaluate(cdp, `document.querySelector('select')?.value ?? ''`);
      if (heading !== selected) throw new Error(`进入后角色被重置为 ${heading}，期望 ${selected}`);
      return `${url}（角色 ${selected} 保留）`;
    });

    /* ------------------------- 7. 空态 / 403 / 角色 epoch ------------------------- */
    await step('空态：关联接口可用但没有数据时显示"暂无成员"，不是"未开通"', async () => {
      await fixtureScenario('empty');
      await goto(cdp, `${BASE}/access/departments`, 1500);
      const text = await waitFor(cdp, `document.body.innerText.includes('该部门暂无成员') ? document.body.innerText : ''`, {
        timeoutMs: 15000,
      });
      if (!text) throw new Error('没有出现空态文案');
      if (text.includes('当前实例未开通部门成员关联')) throw new Error('把空数据显示成了"未开通"');
      return '该部门暂无成员';
    });

    await step('403：权限不足时给中文提示，不冒充空数据', async () => {
      await fixtureScenario('forbidden');
      await goto(cdp, `${BASE}/access/departments`, 1500);
      await waitFor(cdp, `document.body.innerText.includes('成员甲')`, { timeoutMs: 15000 });
      await mouseClickText(cdp, 'label', '成员乙', { settleMs: 300 });
      await mouseClickText(cdp, 'button', '加入成员（已选 1）', { settleMs: 1200 });
      const text = await bodyText(cdp);
      if (/No permissions|403/.test(text)) throw new Error('页面暴露了原始错误码/英文');
      if (!/权限|未能/.test(text)) throw new Error('没有给出中文失败说明');
      return '中文失败说明（无原始错误码）';
    });

    await step('角色 epoch：ROLE_NOT_FOUND_FOR_USER 不把已登录用户踢下线', async () => {
      await fixtureScenario('role401');
      await goto(cdp, `${BASE}/access/departments`, 1500);
      await waitFor(cdp, `document.body.innerText.includes('成员甲')`, { timeoutMs: 15000 });
      await mouseClickText(cdp, 'label', '成员乙', { settleMs: 300 });
      await mouseClickText(cdp, 'button', '加入成员（已选 1）', { settleMs: 1500 });
      const path = await evaluate(cdp, 'location.pathname');
      if (path.startsWith('/login')) throw new Error('被踢回登录页');
      const text = await bodyText(cdp);
      if (!text.includes('受控管理员') && !text.includes('当前角色')) throw new Error('身份信息消失');
      return `仍在 ${path}，身份保持`;
    });

    await fixtureScenario('normal');

    /* ------------------------- 8. 390 窄屏 ------------------------- */
    await step('390 窄屏：关键页面无横向溢出，关键控件在视口内（含截图）', async () => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      const pages = [
        { path: '/access/departments', shot: 'departments-390.png', primary: '[data-testid=department-members-editor]', scrollable: '[data-testid=department-members-editor] div' },
        { path: '/access/users/2', shot: 'user-detail-390.png', primary: '[data-testid=user-departments-editor]', scrollable: '[data-testid=user-departments-editor] div' },
        { path: '/ai/employees-config/employee-a', shot: 'employee-config-390.png', primary: '[data-testid=employee-avatar-host]', scrollable: null },
        { path: '/workbench', shot: 'workbench-390.png', primary: 'main', scrollable: null },
        { path: '/access/roles/r_sales', shot: 'role-detail-390.png', primary: '[data-testid=role-departments-editor]', scrollable: '[data-testid=role-departments-editor] div' },
      ];
      const report = [];
      for (const page of pages) {
        await goto(cdp, `${BASE}${page.path}`, 1600);
        const ready = await waitFor(
          cdp,
          `(() => {
            const el = document.querySelector(${JSON.stringify(page.primary)});
            if (!el) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          })()`,
          { timeoutMs: 15000 },
        );
        if (!ready) throw new Error(`${page.path} 的关键控件没有渲染出来（${page.primary}）`);
        const metrics = await overflow(cdp);
        if (metrics.scrollWidth > metrics.innerWidth + 1) {
          throw new Error(`${page.path} 横向溢出：scrollWidth=${metrics.scrollWidth} > innerWidth=${metrics.innerWidth}`);
        }
        // 关键控件必须落在视口内（超出的部分用户看不到、也点不到）。
        const primary = await boxOf(cdp, page.primary, 0);
        if (!primary || !primary.visible) throw new Error(`${page.path} 的关键控件不可见`);
        if (primary.x < -1 || primary.x + primary.width > metrics.innerWidth + 1) {
          throw new Error(`${page.path} 关键控件超出视口：x=${primary.x} w=${primary.width} vw=${metrics.innerWidth}`);
        }
        // 关联表格这种本来就会横向滚动的区域，必须由容器自己滚动，而不是撑破页面。
        if (page.scrollable) {
          const wrap = await evaluate(
            cdp,
            `(() => {
              const el = document.querySelector(${JSON.stringify(page.scrollable)});
              if (!el) return null;
              const cs = getComputedStyle(el);
              return { overflowX: cs.overflowX, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
            })()`,
          );
          if (wrap && wrap.scrollWidth > wrap.clientWidth && !['auto', 'scroll'].includes(wrap.overflowX)) {
            throw new Error(`${page.path} 的表格容器不能横向滚动：${JSON.stringify(wrap)}`);
          }
        }
        await screenshot(cdp, resolve(SHOT_DIR, page.shot));
        report.push(`${page.path} scrollWidth=${metrics.scrollWidth}/${metrics.innerWidth}`);
      }
      await cdp.send('Emulation.clearDeviceMetricsOverride');
      return report.join('；');
    });

    await step('桌面截图（四方向 / 头像 / 工作台）', async () => {
      const pages = [
        { path: '/access/departments', shot: 'departments-desktop.png' },
        { path: '/access/users/2', shot: 'user-detail-desktop.png' },
        { path: '/ai/employees-config/employee-a', shot: 'employee-config-desktop.png' },
        { path: '/workbench', shot: 'workbench-desktop.png' },
        { path: '/access/roles/r_sales', shot: 'role-detail-desktop.png' },
      ];
      for (const page of pages) {
        await goto(cdp, `${BASE}${page.path}`, 1500);
        await screenshot(cdp, resolve(SHOT_DIR, page.shot));
      }
      return pages.map((page) => page.shot).join('、');
    });

    /* ------------------------- 9. 前端异常 ------------------------- */
    await step('浏览器控制台：无未预期的页面异常', async () => {
      const pageErrors = events.pageErrors.filter((item) => item && item.trim() !== '');
      if (pageErrors.length > 0) throw new Error(`页面异常 ${pageErrors.length} 条：${pageErrors[0]}`);
      return `consoleErrors=${events.consoleErrors.length}`;
    });

    const evidence = {
      generatedAt: new Date().toISOString(),
      previewUrl: BASE,
      fixtureUrl: FIXTURE,
      mode: 'product（本机合成 fixture，未连接真实后端）',
      results,
      passed: results.filter((item) => item.ok).length,
      failed,
      // 脱敏：登录/退出/上传的请求体一律不落盘；其它请求体只保留本任务关注的关联与头像动作。
      apiRequests: events.apiRequests.map((entry) => {
        const sensitive = /auth:signIn|auth:signOut|attachments:upload/.test(entry.url);
        const interesting = /departments|users|roles|aiEmployees/.test(entry.url);
        return {
          method: entry.method,
          url: entry.url,
          status: entry.status,
          postData: sensitive ? '[redacted]' : interesting ? entry.postData : null,
        };
      }),
      consoleErrors: events.consoleErrors.map((item) => item.replace(/fixture-password/g, '[redacted]')),
      pageErrors: events.pageErrors.map((item) => item.replace(/fixture-password/g, '[redacted]')),
    };
    writeFileSync(
      resolve(dirname(SHOT_DIR), 'browser-final-pages-ui.json'),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
    console.log(`\n结果：${evidence.passed} 通过 / ${failed} 失败`);
  } finally {
    close();
    rmSync(FILE_TO_UPLOAD, { force: true });
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
