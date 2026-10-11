#!/usr/bin/env node
/**
 * 电脑端**工作流（WF-01..05）+ 模型配置（LM-01..05）验收环境**连通性自检。
 *
 * 两个部分，都是**开发证据**，不是验收结论（正式验收由主模型在内置浏览器里亲自完成）：
 *   A. `本机 HTTP`：只打本机合成后端（默认 127.0.0.1:5410），核对真实契约形状、
 *      写动作、状态机与"未知动作 501 / 未登录 401 / 不外呼"；
 *   B. `真实浏览器`：只在提供了 `CREWLOOM_APP_URL`（默认 http://127.0.0.1:5329）且本机
 *      Chrome 可用时执行：用**真实登录页**登录合成账号，逐页打开，真实鼠标/键盘触发
 *      代表性写动作，核对 UI 真的发出了对应请求且服务端真的变了。
 *
 * 用法：
 *   node scripts/check-main-browser-workflow-env.mjs
 *   CREWLOOM_FIXTURE_URL=http://127.0.0.1:5410 CREWLOOM_APP_URL=http://127.0.0.1:5329 \
 *     node scripts/check-main-browser-workflow-env.mjs
 *   node scripts/check-main-browser-workflow-env.mjs --http-only
 */

import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { evaluate, goto, launchBrowser, mouseClickSelector, screenshot, sleep, typeInto, waitFor } from './lib/cdp-browser.mjs';

const FIXTURE = (process.env.CREWLOOM_FIXTURE_URL ?? 'http://127.0.0.1:5410').replace(/\/$/, '');
const APP = (process.env.CREWLOOM_APP_URL ?? 'http://127.0.0.1:5329').replace(/\/$/, '');
const SHOT_DIR = process.env.CREWLOOM_SHOT_DIR ?? join(process.cwd(), '.shots', 'workflow-model-env');
const ACCOUNT = { email: 'zhangsan@fixture.local', password: 'fixture' };
const SYNTH_KEY = 'sk-synth-environment-fake-key';
const HTTP_ONLY = process.argv.includes('--http-only');

const results = [];
function check(name, ok, note = '') {
  results.push({ name, ok: Boolean(ok), note });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? ` — ${note}` : ''}`);
}
function skip(name, note) {
  results.push({ name, ok: null, note });
  console.log(`SKIP  ${name} — ${note}`);
}

async function call(path, options = {}) {
  const response = await fetch(`${FIXTURE}${path}`, options);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: response.status, body, text, local: response.headers.get('x-crewloom-local') === '1' };
}
const jsonPost = (payload, headers = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(payload),
});
const filterParam = (value) => encodeURIComponent(JSON.stringify(value));

/* ================================================================== *
 * A. 本机 HTTP 契约
 * ================================================================== */

async function runHttpChecks() {
  // 先回到已知初始状态：本脚本可重复运行，不受上一轮浏览器写动作影响。
  await call('/control/reset', jsonPost({}));
  const health = await call('/healthz');
  check('A1 本机服务健康且声明 local/outbound=false', health.status === 200 && health.body?.local === true && health.body?.outbound === false);

  const signIn = await call('/api/auth:signIn', jsonPost({ email: ACCOUNT.email, password: ACCOUNT.password }));
  const token = signIn.body?.data?.token;
  check('A2 合成账号在真实登录接口上可登录', signIn.status === 200 && typeof token === 'string');
  const auth = { authorization: `Bearer ${token}` };

  const noAuth = await call('/api/workflows:list?pageSize=1');
  check('A3 未登录时非公开动作 401（合成登录不可绕过）', noAuth.status === 401 && noAuth.body?.errors?.[0]?.code === 'EMPTY_TOKEN');

  const list = await call('/api/workflows:list?page=1&pageSize=2&sort%5B%5D=-id&appends%5B%5D=versionStats&appends%5B%5D=categories', { headers: auth });
  check(
    'A4 WF-01 列表：appends[] + 分页信封 + versionStats/categories',
    list.status === 200 &&
      Array.isArray(list.body?.data) &&
      list.body.data.length === 2 &&
      typeof list.body?.meta?.count === 'number' &&
      'versionStats' in (list.body.data[0] ?? {}) &&
      Array.isArray(list.body.data[0]?.categories),
    `count=${list.body?.meta?.count}`,
  );

  const filtered = await call(
    `/api/workflows:list?filter=${filterParam({ title: { $includes: '受控' }, enabled: true })}`,
    { headers: auth },
  );
  check(
    'A5 WF-01 过滤：title.$includes + enabled 组合生效',
    filtered.status === 200 && filtered.body.data.length > 0 && filtered.body.data.every((row) => row.enabled === true),
    `rows=${filtered.body?.data?.length}`,
  );

  const cat = await call('/api/workflowCategories:list?pageSize=200&sort%5B%5D=-id', { headers: auth });
  check('A6 流程分类列表可用', cat.status === 200 && cat.body.data.length === 2);

  const created = await call('/api/workflows:create', { ...jsonPost({ title: '环境自检流程', type: 'collection', enabled: false }, auth) });
  const newId = created.body?.data?.id;
  check('A7 新建流程返回真实版本记录', created.status === 200 && Boolean(newId) && created.body.data.current === false);

  const enabled = await call(`/api/workflows:update?filterByTk=${newId}`, jsonPost({ enabled: true }, auth));
  check('A8 启用即成为 current（真实 beforeSave 语义）', enabled.status === 200 && enabled.body.data.current === true);

  const newVersion = await call(
    `/api/workflows:revision?filterByTk=${newId}&filter=${filterParam({ key: newId })}`,
    jsonPost({}, auth),
  );
  check('A9 新建版本沿用同 key（版本切换前提）', newVersion.status === 200 && newVersion.body.data.key === newId && newVersion.body.data.id !== newId);

  const duplicate = await call(`/api/workflows:revision?filterByTk=${newId}`, jsonPost({ title: '环境自检流程 副本' }, auth));
  check('A10 复制为独立流程用新 key', duplicate.status === 200 && duplicate.body.data.key === duplicate.body.data.id && duplicate.body.data.id !== newId);

  const draftNodes = await call(`/api/flow_nodes:list?filter=${filterParam({ workflowId: '900000000000001' })}&pageSize=200&sort%5B%5D=id`, { headers: auth });
  check('A11 WF-02 受控画布节点读取 4 个原生节点', draftNodes.status === 200 && draftNodes.body.data.length === 4);

  const node = await call('/api/workflows/900000000000001/nodes:create', { ...jsonPost({ type: 'script', title: '自检脚本节点', config: { content: 'return 1;' } }, auth) });
  check('A12 WF-02 新增节点（nodes:create）返回真实节点', node.status === 200 && node.body.data.type === 'script' && node.body.data.workflowId === '900000000000001');
  const saved = await call(`/api/flow_nodes:update?filterByTk=${node.body.data.id}`, jsonPost({ config: { content: 'return 7;' }, title: '自检脚本节点·改' }, auth));
  check('A13 WF-03 节点配置保存并回读一致', saved.status === 200 && saved.body.data.config.content === 'return 7;' && saved.body.data.title === '自检脚本节点·改');

  // `nodes:create` 不带 upstreamId 时按真实契约插到流程最前（upstreamId=null），
  // 所以"移动到 upstreamId=null"是**没有变化**的移动，真实服务端会 400（`Node does not need to be moved`）。
  // 这里改成一个真实的位置变化：把新节点接到计算节点之后。
  const moveTarget = draftNodes.body.data.find((row) => row.type === 'calculation');
  const moved = await call(
    `/api/flow_nodes:move?filterByTk=${node.body.data.id}`,
    jsonPost({ upstreamId: moveTarget.id, branchIndex: null }, auth),
  );
  check(
    'A14 WF-02 节点移动（flow_nodes:move）成功',
    moved.status === 200 && String(moved.body.data.upstreamId) === String(moveTarget.id),
    `upstreamId=${String(moved.body?.data?.upstreamId)}`,
  );
  const dup = await call(`/api/flow_nodes:duplicate?filterByTk=${node.body.data.id}`, jsonPost({ upstreamId: null, branchIndex: null }, auth));
  check('A15 WF-02 节点复制（flow_nodes:duplicate）成功', dup.status === 200 && dup.body.data.id !== node.body.data.id);
  const destroyed = await call(`/api/flow_nodes:destroy?filterByTk=${dup.body.data.id}`, jsonPost({}, auth));
  check('A16 WF-02 节点删除（flow_nodes:destroy）成功', destroyed.status === 200);

  for (const [scenario, expect] of [
    ['success', (r) => r.status === 200 && r.body?.data?.status === 1 && r.body.data.result.type === 'script'],
    ['failure', (r) => r.status === 200 && r.body?.data?.status === -1],
    ['permission', (r) => r.status === 403],
    ['error', (r) => r.status === 500],
  ]) {
    await call('/api/crewloomControlledWorkflow:scenario', jsonPost({ test: scenario }, auth));
    const ran = await call('/api/flow_nodes:test', { ...jsonPost({ type: 'script', config: { content: 'return 1;' } }, auth) });
    check(`A17 节点自测受控结果（${scenario}）`, expect(ran), `${ran.status}`);
  }
  await call('/api/crewloomControlledWorkflow:scenario', jsonPost({ test: 'success' }, auth));

  const executedCreate = await call('/api/workflows/900000000000002/nodes:create', { ...jsonPost({ type: 'output', title: 'x', config: {} }, auth) });
  check(
    'A18 已执行版本拒绝新增节点（400 + 中文适配文案）',
    executedCreate.status === 400 && /执行记录/.test(String(executedCreate.body?.errors?.[0]?.message)),
  );

  const execAll = await call('/api/executions:list?pageSize=50&sort%5B%5D=-id&appends%5B%5D=workflow', { headers: auth });
  const execDone = await call(`/api/executions:list?filter=${filterParam({ status: 1 })}`, { headers: auth });
  const execQueue = await call(`/api/executions:list?filter=${filterParam({ status: { $eq: null } })}`, { headers: auth });
  check(
    'A19 WF-04 执行列表 + 状态筛选（含 null 排队中）',
    execAll.status === 200 &&
      execAll.body.data.every((row) => typeof row.workflow?.title === 'string') &&
      execDone.body.data.every((row) => row.status === 1) &&
      execQueue.body.data.length > 0 &&
      execQueue.body.data.every((row) => row.status === null),
    `all=${execAll.body?.data?.length} done=${execDone.body?.data?.length} queue=${execQueue.body?.data?.length}`,
  );

  const detail = await call('/api/executions:get?filterByTk=920005&appends%5B%5D=workflow', { headers: auth });
  const jobs = await call(`/api/jobs:list?filter=${filterParam({ executionId: '920005' })}&pageSize=200&sort%5B%5D=id`, { headers: auth });
  const jobOne = await call(`/api/jobs:get?filterByTk=${jobs.body.data[0].id}`, { headers: auth });
  check(
    'A20 WF-05 执行详情 + 按 executionId 读作业 + job 详情（含 type）',
    detail.status === 200 &&
      detail.body.data.id === '920005' &&
      jobs.body.data.length === 3 &&
      jobs.body.data.every((job) => String(job.executionId) === '920005' && typeof job.type === 'string') &&
      jobOne.status === 200 &&
      jobOne.body.data.id === jobs.body.data[0].id,
  );

  const cancelled = await call('/api/executions:cancel?filterByTk=920004', jsonPost({}, auth));
  const cannotCancel = await call('/api/executions:cancel?filterByTk=920005', jsonPost({}, auth));
  check('A21 WF-05 取消语义：进行中可取消(-3)，已结束 400', cancelled.status === 200 && cancelled.body.data.status === -3 && cannotCancel.status === 400);

  const providers = await call('/api/ai:listLLMProviders', { headers: auth });
  check('A22 LM-02 提供方目录 13 项', providers.status === 200 && providers.body.data.length === 13);

  const masked = await call('/api/ai:listLLMServices?pageSize=100&sort%5B%5D=sort', { headers: auth });
  const raw = await call('/api/llmServices:list?pageSize=100', { headers: auth });
  check(
    'A23 LM-01 脱敏列表剔除 options/停用服务；管理读保留明文 options',
    masked.status === 200 &&
      masked.body.data.every((row) => !('options' in row) && row.enabled !== false) &&
      typeof masked.body?.meta?.hasNext === 'boolean' &&
      raw.body.data.some((row) => typeof row.options?.apiKey === 'string'),
    `masked=${masked.body?.data?.length} raw=${raw.body?.data?.length}`,
  );

  const missing = await call('/api/llmServices:get?filterByTk=__none__', { headers: auth });
  check('A24 LM-02 不存在的服务返回 200 {data:null}（真实契约）', missing.status === 200 && missing.body.data === null);

  const updated = await call('/api/llmServices:update?filterByTk=synth-deepseek', { ...jsonPost({ options: { apiKey: SYNTH_KEY, baseURL: 'http://127.0.0.1:9/x', temperature: 0.4 } }, auth) });
  const readBack = await call('/api/llmServices:get?filterByTk=synth-deepseek', { headers: auth });
  check(
    'A25 LM-02 options 整体替换（省略键被丢弃，回读一致）',
    updated.status === 200 && readBack.body.data.options.temperature === 0.4 && readBack.body.data.options.timeout === undefined,
  );

  const badModels = await call('/api/llmServices:update?filterByTk=synth-deepseek', { ...jsonPost({ enabledModels: { mode: 'custom', models: [{ label: 'a', value: 'a' }, { label: 'a', value: 'a' }] } }, auth) });
  check(
    'A26 LM-02 enabledModels 重复 id → 400 LLM_SERVICE_MODEL_ID_DUPLICATE + index',
    badModels.status === 400 && badModels.body.errors[0].code === 'LLM_SERVICE_MODEL_ID_DUPLICATE' && badModels.body.data.index === 1,
  );

  const models = await call('/api/ai:listModels', { ...jsonPost({ llmService: 'synth-deepseek', model: '' }, auth) });
  const providerModels = await call('/api/ai:listProviderModels', { ...jsonPost({ provider: 'deepseek', options: { apiKey: 'x' }, model: '' }, auth) });
  check(
    'A27 LM-03 显式模型目录（服务）与提供方目录都本机应答，不外呼',
    models.status === 200 &&
      models.body.data.map((row) => row.id).join(',') === 'deepseek-chat,deepseek-reasoner' &&
      providerModels.status === 200 &&
      providerModels.body.data.length === 2,
  );

  const settings0 = await call('/api/aiSettings:get', { headers: auth });
  const settingsSaved = await call('/api/aiSettings:update', jsonPost({ defaultLLMService: 'synth-deepseek', defaultModel: 'deepseek-chat' }, auth));
  const settings1 = await call('/api/aiSettings:get', { headers: auth });
  const settingsCleared = await call('/api/aiSettings:update', jsonPost({ defaultLLMService: null, defaultModel: null }, auth));
  check(
    'A28 LM-04 默认设置保存与读回（可清空）',
    settings0.body.data.defaultLLMService === null &&
      settingsSaved.body.data.defaultLLMService === 'synth-deepseek' &&
      settings1.body.data.defaultModel === 'deepseek-chat' &&
      settingsCleared.body.data.defaultLLMService === null,
  );

  await call('/control/model/scenario', jsonPost({ test: 'success' }));
  const ok = await call('/api/ai:testFlight', { ...jsonPost({ provider: 'deepseek', options: { apiKey: SYNTH_KEY }, model: 'deepseek-chat' }, auth) });
  await call('/control/model/scenario', jsonPost({ test: 'failure' }));
  const bad = await call('/api/ai:testFlight', { ...jsonPost({ provider: 'deepseek', options: { apiKey: SYNTH_KEY }, model: 'bad-model' }, auth) });
  await call('/control/model/scenario', jsonPost({ test: 'success' }));
  check(
    'A29 LM-05 试飞成功/失败都在本机应答（零费用）',
    ok.status === 200 && ok.body.data.status === 'success' && ok.body.data.code === 0 && bad.body.data.status === 'error' && bad.body.data.code !== 0,
  );

  const employees = await call('/api/aiEmployees:list?pageSize=200&sort%5B%5D=sort', { headers: auth });
  check('A30 LM-04 员工模型配置可读', employees.status === 200 && employees.body.data.length === 2);

  const unknown = await call('/api/synth_not_implemented:list', { headers: auth });
  const fileMiss = await call('/files/app/main/attachments/1.txt', { headers: auth });
  const outside = await call('/not-api');
  check('A31 未知动作本机 501 / files 本机 404 / 未知路径 404（绝不外呼）', unknown.status === 501 && fileMiss.status === 404 && outside.status === 404);

  const controlHtml = await fetch(`${FIXTURE}/control`);
  const controlText = await controlHtml.text();
  check('A32 可见控制页可用（含流程/模型/场景/重置）', controlHtml.status === 200 && controlText.includes('工作流') && controlText.includes('模型配置合成数据'));

  const controlState = await call('/control/state');
  check('A33 控制页状态含合成账号、受控 id、场景与请求记录', controlState.status === 200 && Array.isArray(controlState.body?.accounts) && typeof controlState.body?.syntheticIds?.draft === 'string');

  await call('/control/reset', jsonPost({}));
  const afterReset = await call('/control/state');
  check('A34 重置后回到初始合成数据（执行 8 条、版本 5 个）', afterReset.body?.workflow?.executions?.length === 8 && afterReset.body?.workflow?.versions?.length === 5, `exec=${afterReset.body?.workflow?.executions?.length} ver=${afterReset.body?.workflow?.versions?.length}`);
}

/* ================================================================== *
 * B. 真实浏览器（真实登录页 + 真实鼠标/键盘）
 * ================================================================== */

function apiCalls(events, actionFragment) {
  return events.apiRequests.filter((entry) => entry.url.includes(actionFragment));
}
function lastCall(events, actionFragment) {
  const list = apiCalls(events, actionFragment);
  return list.length ? list[list.length - 1] : null;
}
/**
 * 原生 `<select>` 无法用脚本点击弹出选项：这里用原生 setter + 真实 `change` 事件。
 * 按"哪一个 select 含有这个 option value"定位，避免依赖 aria-label。
 */
async function setSelectByOption(cdp, value) {
  return evaluate(
    cdp,
    `(() => {
      const target = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === ${JSON.stringify(value)}));
      if (!target) return null;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(target, ${JSON.stringify(value)});
      target.dispatchEvent(new Event('change', { bubbles: true }));
      return target.value;
    })()`,
  );
}
/**
 * 按去掉空白后的文本点击按钮（antd 的中文按钮会渲染成「提 交」）。
 * `text` 可以是字符串或字符串数组（同一语义的中文/英文按钮文案都试一遍）。
 */
async function clickButton(cdp, scope, text, settleMs = 1500) {
  const candidates = Array.isArray(text) ? text : [text];
  for (const candidate of candidates) {
    const needle = String(candidate).replace(/\s/g, '');
    const index = await evaluate(
      cdp,
      `[...document.querySelectorAll(${JSON.stringify(scope)})].findIndex((b) => (b.innerText || '').replace(/\\s/g, '').includes(${JSON.stringify(needle)}))`,
    );
    if (index >= 0) {
      await mouseClickSelector(cdp, scope, index, { settleMs });
      return candidate;
    }
  }
  return false;
}
async function bodyText(cdp) {
  return evaluate(cdp, 'document.body.innerText');
}

async function runBrowserChecks() {
  if (!existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') && !process.env.CHROME_PATH) {
    skip('B 真实浏览器核对', '没有找到 Chrome（设置 CHROME_PATH 后可运行）');
    return;
  }
  mkdirSync(SHOT_DIR, { recursive: true });

  let browser;
  try {
    browser = await launchBrowser({ debugPort: Number(process.env.CREWLOOM_CDP_PORT ?? 9399), width: 1500, height: 1000 });
  } catch (error) {
    skip('B 真实浏览器核对', `Chrome/CDP 启动失败：${String(error?.message ?? error)}`);
    return;
  }
  const { cdp, close, events } = browser;

  try {
    // B1 真实登录页
    await goto(cdp, `${APP}/login`, 1200);
    await waitFor(cdp, `Boolean(document.querySelector('input[name="crewloom-account"]'))`, { timeoutMs: 20000 });
    await typeInto(cdp, 'input[name="crewloom-account"]', ACCOUNT.email);
    await typeInto(cdp, 'input[name="crewloom-secret"]', ACCOUNT.password);
    await mouseClickSelector(cdp, 'form button[type="submit"]', 0, { settleMs: 1800 });
    const loggedIn = await waitFor(cdp, `!location.pathname.startsWith('/login')`, { timeoutMs: 25000 });
    check('B1 真实登录页用合成账号登录成功', Boolean(loggedIn), await evaluate(cdp, 'location.pathname'));

    // B2 逐页渲染
    const pages = [
      ['/workflow/list', 'B2a WF-01 流程列表渲染', '流程列表'],
      ['/workflow/executions', 'B2b WF-04 执行记录渲染', '执行记录'],
      ['/workflow/execution?id=920005', 'B2c WF-05 执行详情渲染', '执行 #920005'],
      ['/model/services', 'B2d LM-01 服务列表渲染', '模型服务'],
      ['/model/services/synth-deepseek', 'B2e LM-02 服务配置渲染', '服务配置'],
      ['/model/models', 'B2f LM-03 可用模型渲染', '可用模型'],
      ['/model/defaults', 'B2g LM-04 默认与员工模型渲染', '默认与员工模型'],
      ['/model/verify', 'B2h LM-05 配置验证渲染', '配置验证'],
    ];
    for (const [route, name, marker] of pages) {
      await goto(cdp, `${APP}${route}`, 1600);
      const seen = await waitFor(cdp, `document.body.innerText.includes(${JSON.stringify(marker)})`, { timeoutMs: 12000 });
      const text = await bodyText(cdp);
      check(name, Boolean(seen) && !text.includes(SYNTH_KEY), `含「${marker}」=${Boolean(seen)}；DOM 出现合成密钥=${text.includes(SYNTH_KEY)}`);
    }

    // B3 原生画布：宿主就绪 + registry + 面包屑（nativeLink 修复可验）
    await goto(cdp, `${APP}/workflow/canvas?workflowId=900000000000001`, 2500);
    const hostReady = await waitFor(cdp, `Boolean(document.querySelector('[data-testid="native-workflow-canvas"]'))`, { timeoutMs: 30000 });
    const registry = await waitFor(cdp, `window.__crewloomWorkflowRegistry ? JSON.stringify(window.__crewloomWorkflowRegistry()) : ''`, { timeoutMs: 30000 });
    let registryInfo = null;
    try {
      registryInfo = registry ? JSON.parse(registry) : null;
    } catch {
      registryInfo = null;
    }
    check(
      'B3a 原生画布宿主与原生 registry 就绪（27 instruction / manual 适配器）',
      Boolean(hostReady) && registryInfo && registryInfo.instructionCount >= 25 && registryInfo.hostAdapters?.manual === true,
      registryInfo ? `instructions=${registryInfo.instructionCount} triggers=${registryInfo.triggerCount}` : 'registry 不可读',
    );
    const breadcrumb = await evaluate(
      cdp,
      `(() => {
        const links = [...document.querySelectorAll('.workflow-canvas a, [data-testid="native-workflow-canvas"] a')];
        const target = links.find((a) => /workflow$/i.test(a.getAttribute('href') || '') || (a.innerText || '').trim() === '工作流');
        return target ? { href: target.getAttribute('href'), text: (target.innerText || '').trim() } : null;
      })()`,
    );
    check(
      'B3b 原生面包屑 href 是真实路径（不是 [object Object]）',
      Boolean(breadcrumb) && typeof breadcrumb.href === 'string' && breadcrumb.href.length > 0 && !breadcrumb.href.includes('[object Object]'),
      JSON.stringify(breadcrumb),
    );

    // B4 代表性真实写动作：节点配置保存
    await mouseClickSelector(cdp, '[data-testid="native-workflow-canvas"] .workflow-node-type-calculation .workflow-node-meta', 0, { settleMs: 2200 });
    const drawer = await waitFor(cdp, `Boolean(document.querySelector('.ant-drawer-content'))`, { timeoutMs: 20000 });
    const before = events.apiRequests.length;
    const editable =
      'body .ant-drawer-content [contenteditable="true"], body .ant-drawer-content input:not([type="checkbox"]), body .ant-drawer-content textarea';
    const hasField = await evaluate(cdp, `Boolean(document.querySelector(${JSON.stringify(editable)}))`);
    let clickedSubmit = false;
    if (hasField) {
      await typeInto(cdp, editable, '40 + 7');
      clickedSubmit = await clickButton(cdp, 'body .ant-drawer-content button', ['提交', 'Submit'], 2400);
    }
    const drawerRequests = events.apiRequests.slice(before);
    const savedNode = drawerRequests.find((entry) => entry.url.includes('flow_nodes:update') && entry.method === 'POST');
    const drawerDiagnostics = savedNode
      ? ''
      : JSON.stringify({
          drawer: Boolean(drawer),
          field: hasField,
          submit: clickedSubmit,
          buttons: await evaluate(cdp, `[...document.querySelectorAll('body .ant-drawer-content button')].map((b) => (b.innerText || '').trim())`),
        });
    check(
      'B4 画布里真实打开节点面板并保存（flow_nodes:update 200）',
      Boolean(drawer) && Boolean(savedNode) && savedNode.status === 200,
      savedNode ? `status=${savedNode.status}` : `没有捕获到 flow_nodes:update ${drawerDiagnostics}`,
    );
    await screenshot(cdp, join(SHOT_DIR, '01-workflow-canvas-node-save.png'));
    await evaluate(cdp, `(() => { const b = document.querySelector('.ant-drawer-close'); if (b) b.click(); return true; })()`);
    await sleep(800);

    // B5 节点自测：四种受控结果（成功 / 失败 / 无权限 / 内部错误）
    const selfTestDiagnostics = [];
    const runSelfTest = async (scenario) => {
      await call('/control/workflow/scenario', jsonPost({ test: scenario }));
      await mouseClickSelector(cdp, '[data-testid="native-workflow-canvas"] .workflow-node-type-calculation .workflow-node-meta', 0, { settleMs: 2000 });
      await waitFor(cdp, `Boolean(document.querySelector('.ant-drawer-content'))`, { timeoutMs: 20000 });
      const clicked = await clickButton(cdp, 'body .ant-drawer-content button', ['测试执行', '试运行', 'Test run'], 1500);
      const modal = await waitFor(cdp, `Boolean(document.querySelector('.ant-modal-content'))`, { timeoutMs: 12000 });
      if (!modal) {
        selfTestDiagnostics.push(
          JSON.stringify({
            scenario,
            clicked,
            buttons: await evaluate(cdp, `[...document.querySelectorAll('body .ant-drawer-content button')].map((b) => (b.innerText || '').trim())`),
          }),
        );
      } else {
        await clickButton(cdp, '.ant-modal-content button', ['运行', 'Run'], 2400);
        await sleep(1200);
      }
      const text = await evaluate(cdp, `((document.querySelector('.ant-modal-content')?.innerText) || (document.querySelector('.ant-drawer-content')?.innerText) || '').slice(0, 600)`);
      await evaluate(cdp, `(() => { const c = document.querySelector('.ant-modal-content .ant-modal-close'); if (c) c.click(); const d = document.querySelector('.ant-drawer-close'); if (d) d.click(); return true; })()`);
      await sleep(900);
      return text;
    };
    const okText = await runSelfTest('success');
    const failText = await runSelfTest('failure');
    const permissionText = await runSelfTest('permission');
    const errorText = await runSelfTest('error');
    const testCalls = apiCalls(events, 'flow_nodes:test');
    const statuses = testCalls.map((entry) => entry.status).join(',');
    check(
      'B5a 节点自测成功/失败在原生面板里可区分（受控 200）',
      (okText.includes('完成') || okText.includes('Resolved')) && (failText.includes('失败') || failText.includes('Failed')),
      `success=${JSON.stringify(okText.slice(0, 40))} failure=${JSON.stringify(failText.slice(0, 40))}`,
    );
    check(
      'B5b 节点自测无权限/内部错误显示中文提示（不是 Request failed with status code）',
      403 === testCalls[testCalls.length - 2]?.status &&
        500 === testCalls[testCalls.length - 1]?.status &&
        permissionText.includes('权限') &&
        errorText.includes('内部错误') &&
        !/Request failed with status code/.test(`${permissionText} ${errorText}`),
      `状态序列=${statuses} permission=${JSON.stringify(permissionText.slice(0, 50))} error=${JSON.stringify(errorText.slice(0, 50))}${selfTestDiagnostics.length ? ` 诊断=${selfTestDiagnostics.join(' | ')}` : ''}`,
    );
    check(
      'B5c 四次自测请求都真实发出（UI → /api/flow_nodes:test）',
      testCalls.length >= 4 && testCalls.slice(-4).every((entry) => entry.method === 'POST'),
      `请求=${testCalls.length}`,
    );
    await call('/control/workflow/scenario', jsonPost({ test: 'success' }));

    // B3c nativeLink 面包屑：真实点击应回到产品流程列表（`onOpenList`），而不是跳到无效地址
    const breadcrumbPathBefore = await evaluate(cdp, 'location.pathname');
    const breadcrumbClicked = await clickButton(cdp, '[data-testid="native-workflow-canvas"] a', ['Workflow', '工作流'], 2000);
    const breadcrumbPathAfter = await waitFor(cdp, `location.pathname !== ${JSON.stringify(breadcrumbPathBefore)} ? location.pathname : ''`, { timeoutMs: 8000 });
    check(
      'B3c 点击原生面包屑可回到产品流程列表（nativeLink 修复端到端可验）',
      Boolean(breadcrumbClicked) && String(breadcrumbPathAfter).startsWith('/workflow'),
      `点击前=${breadcrumbPathBefore} 点击后=${breadcrumbPathAfter || '（未变化）'}`,
    );

    // B6 流程列表里的真实写动作：停用/启用
    await goto(cdp, `${APP}/workflow/list`, 2000);
    const beforeToggle = events.apiRequests.length;
    const toggleIndex = await evaluate(cdp, `[...document.querySelectorAll('button')].findIndex((b) => ['停用','启用'].includes((b.innerText||'').trim()))`);
    if (toggleIndex >= 0) await mouseClickSelector(cdp, 'button', toggleIndex, { settleMs: 2200 });
    const toggleCall = events.apiRequests.slice(beforeToggle).find((entry) => entry.url.includes('workflows:update'));
    check('B6 WF-01 列表真实停用/启用（workflows:update 200）', Boolean(toggleCall) && toggleCall.status === 200, toggleCall ? `status=${toggleCall.status}` : '未捕获 workflows:update');
    await screenshot(cdp, join(SHOT_DIR, '02-workflow-list-toggle.png'));

    // B7 LM-02 真实保存（服务配置页提交）
    await goto(cdp, `${APP}/model/services/synth-deepseek`, 2000);
    const beforeSave = events.apiRequests.length;
    const saveIndex = await evaluate(cdp, `[...document.querySelectorAll('button')].findIndex((b) => /保存/.test((b.innerText||'').trim()))`);
    if (saveIndex >= 0) await mouseClickSelector(cdp, 'button', saveIndex, { settleMs: 2400 });
    const saveCall = events.apiRequests.slice(beforeSave).find((entry) => entry.url.includes('llmServices:') && entry.method === 'POST');
    const lmText = await bodyText(cdp);
    check('B7 LM-02 真实保存服务配置（llmServices 写 200，密钥不出现在 DOM）', Boolean(saveCall) && saveCall.status === 200 && !lmText.includes(SYNTH_KEY), saveCall ? `status=${saveCall.status}` : '未捕获写请求');
    await screenshot(cdp, join(SHOT_DIR, '03-model-service-config.png'));

    // B8 LM-04 默认设置保存 + 读回
    await goto(cdp, `${APP}/model/defaults`, 2000);
    const serviceSelected = await setSelectByOption(cdp, 'synth-deepseek');
    await sleep(600);
    const modelSelected = await setSelectByOption(cdp, 'deepseek-chat');
    await sleep(500);
    const beforeDefault = events.apiRequests.length;
    const clickedDefaultSave = await clickButton(cdp, 'button', ['保存默认设置', 'Save'], 2400);
    const defaultSaved = events.apiRequests.slice(beforeDefault).find((entry) => entry.url.includes('aiSettings:update'));
    check(
      'B8 LM-04 默认模型真实保存（aiSettings:update 200）',
      Boolean(serviceSelected) && Boolean(modelSelected) && clickedDefaultSave && Boolean(defaultSaved) && defaultSaved.status === 200,
      `service=${serviceSelected} model=${modelSelected} status=${defaultSaved?.status ?? '-'}`,
    );
    await screenshot(cdp, join(SHOT_DIR, '04-model-defaults.png'));

    // B9 LM-05 试飞失败/成功（本机受控、零费用）
    await goto(cdp, `${APP}/model/verify`, 1800);
    const providerSet = await setSelectByOption(cdp, 'deepseek');
    const modelInput = 'input[placeholder="例如 deepseek-chat"]';
    const hasModelInput = await evaluate(cdp, `Boolean(document.querySelector(${JSON.stringify(modelInput)}))`);
    if (providerSet && hasModelInput) {
      await sleep(400);
      await typeInto(cdp, modelInput, 'deepseek-chat');
      const hasKeyInput = await evaluate(cdp, `Boolean(document.querySelector('input[type="password"]'))`);
      if (hasKeyInput) await typeInto(cdp, 'input[type="password"]', SYNTH_KEY);
      await mouseClickSelector(cdp, 'input[type="checkbox"]', 0, { settleMs: 300 });
      await call('/control/model/scenario', jsonPost({ test: 'failure' }));
      const beforeFlight = events.apiRequests.length;
      await clickButton(cdp, 'button', ['开始验证'], 2200);
      const flight = events.apiRequests.slice(beforeFlight).find((entry) => entry.url.includes('ai:testFlight'));
      const failText = await bodyText(cdp);
      await call('/control/model/scenario', jsonPost({ test: 'success' }));
      const beforeFlight2 = events.apiRequests.length;
      await clickButton(cdp, 'button', ['开始验证'], 2200);
      const flight2 = events.apiRequests.slice(beforeFlight2).find((entry) => entry.url.includes('ai:testFlight'));
      const okText = await bodyText(cdp);
      check(
        'B9 LM-05 试飞失败与成功在真实页面可区分（ai:testFlight 200，无外呼）',
        Boolean(flight) && flight.status === 200 && failText.includes('验证失败') && Boolean(flight2) && flight2.status === 200 && okText.includes('验证通过'),
        `fail含验证失败=${failText.includes('验证失败')} success含验证通过=${okText.includes('验证通过')}`,
      );
      await screenshot(cdp, join(SHOT_DIR, '05-model-verify.png'));
    } else {
      skip('B9 LM-05 试飞核对', `页面没有可脚本选择的提供方下拉或模型输入框（provider=${providerSet} modelInput=${hasModelInput}）`);
    }

    // B10 页面错误汇总
    const ignorable = /ResizeObserver|favicon|Download the React DevTools/;
    const realPageErrors = events.pageErrors.filter((item) => !ignorable.test(item));
    const realConsoleErrors = events.consoleErrors.filter((item) => !ignorable.test(item));
    check('B10 全部页面无未捕获异常 / 无资源 4xx-5xx', realPageErrors.length === 0 && realConsoleErrors.length === 0, `pageErrors=${realPageErrors.length} consoleErrors=${realConsoleErrors.length}`);

    const apiStatuses = events.apiRequests.map((entry) => entry.status);
    // `flow_nodes:test` 的 500 是**故意注入**的「内部错误」场景（B5b 验证中文文案），不算环境缺陷。
    const intentional = events.apiRequests.filter((entry) => entry.status === 500 && entry.url.includes('flow_nodes:test'));
    const serverErrors = events.apiRequests.filter(
      (entry) => (entry.status ?? 0) >= 500 && entry.status !== 501 && !intentional.includes(entry),
    );
    const unsupportedCalls = events.apiRequests.filter((entry) => entry.status === 501);
    const unsupportedActions = [...new Set(unsupportedCalls.map((entry) => `${entry.method} ${entry.url.split('?')[0]}`))];
    if (unsupportedActions.length) {
      console.log(`      本机 501（未支持，设计如此）共 ${unsupportedCalls.length} 次：${unsupportedActions.join('、')}`);
    }
    check(
      'B11 页面发出的 /api 请求没有非预期 5xx（501 与故意注入的 500 单独列出）',
      serverErrors.length === 0,
      `requests=${apiStatuses.length} 非预期5xx=${serverErrors.length} 501=${unsupportedCalls.length} 故意注入500=${intentional.length}`,
    );
  } finally {
    close();
  }
}

/* ================================================================== *
 * 汇总
 * ================================================================== */

async function main() {
  console.log(`本机合成后端：${FIXTURE}`);
  console.log(`产品预览：${APP}`);
  console.log('--- A. 本机 HTTP 契约 ---');
  await runHttpChecks();
  if (!HTTP_ONLY) {
    console.log('--- B. 真实浏览器（真实登录 + 真实鼠标/键盘） ---');
    await runBrowserChecks();
  } else {
    skip('B 真实浏览器核对', '--http-only');
  }

  const passed = results.filter((item) => item.ok === true).length;
  const failed = results.filter((item) => item.ok === false);
  const skipped = results.filter((item) => item.ok === null).length;
  console.log(`\n=== 环境自检汇总：${passed} 通过 / ${failed.length} 失败 / ${skipped} 跳过（共 ${results.length}）===`);
  for (const item of failed) console.log(`FAIL  ${item.name}${item.note ? ` — ${item.note}` : ''}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('环境自检本身出错：', error);
  process.exitCode = 2;
});
