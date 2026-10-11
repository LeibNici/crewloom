#!/usr/bin/env node
/**
 * 61 轮两个真实适配缺陷的**真实浏览器**定向核对（本机合成环境，不打真实 13000）。
 *
 * 只用真实鼠标点击驱动产品页面，断言的是**页面自己发出的请求**与 fixture 记录：
 *  1. 用户列表：产品对数组参数发的是 `appends[]=roles&appends[]=avatar`（同名两次）。
 *     旧 fixture `parseQuery` 用后值覆盖前值 → 只剩 avatar → 列表显示"未分配"。
 *     这里核对页面请求里两项都在、列表与详情角色一致（root / 李四=销售），且**不是**无条件补角色。
 *  2. 集合详情「反向同步字段」：真实 2.2.20 里 `values.collections` 缺省 = 全部集合。
 *     这里核对确认框说的是"该集合"，页面真的发出 `{"collections":["qa_physical_ledger"]}`，
 *     选中的表被重建，**另一张合成物理表**上多出的元数据保持不动。
 *
 * 用法（先起好 fixture 与指向它的产品预览）：
 *   CREWLOOM_PREVIEW_URL=http://127.0.0.1:5354 CREWLOOM_FIXTURE_URL=http://127.0.0.1:5424 \
 *     node scripts/check-main-61-adapter-fixes.mjs
 * 环境变量：CREWLOOM_PREVIEW_URL（缺省 :5354）、CREWLOOM_FIXTURE_URL（缺省 :5424）、
 *          CREWLOOM_SHOT_DIR（缺省 .work/final-adapter-fixes-shots，截图只留本机）。
 *
 * 不读任何凭据文件、不连外部地址、不做真实 schema 写入。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluate,
  goto,
  launchBrowser,
  mouseClickText,
  screenshot,
  sleep,
  typeInto,
  waitFor,
} from './lib/cdp-browser.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(here, '..');
const BASE = process.env.CREWLOOM_PREVIEW_URL ?? 'http://127.0.0.1:5354';
const FIXTURE = process.env.CREWLOOM_FIXTURE_URL ?? 'http://127.0.0.1:5424';
const SHOT_DIR = process.env.CREWLOOM_SHOT_DIR ?? resolve(frontendRoot, '.work/final-adapter-fixes-shots');

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
    record(name, false, String(error?.message ?? error).slice(0, 400));
    return null;
  }
}

/* ------------------------------ fixture 控制面 ------------------------------ */

async function fixture(path, init) {
  const response = await fetch(`${FIXTURE}${path}`, init);
  return (await response.json()).data;
}
const fixtureReset = () => fixture('/__fixture/reset', { method: 'POST' });
const fixtureLog = () => fixture('/__fixture/log');
const fixtureState = () => fixture('/__fixture/state');
const requestsOf = (log, path, since = 0) => log.slice(since).filter((entry) => entry.path === path);

async function waitForRequest(path, since, { timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = requestsOf(await fixtureLog(), path, since);
    if (found.length > 0) return found;
    await sleep(250);
  }
  return [];
}

/** 直接的 fixture HTTP 写入（**只用于准备合成初始状态**；被测动作一律走真实页面）。 */
async function fixtureWrite(path, values) {
  const response = await fetch(`${FIXTURE}/api/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ values }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

/* ------------------------------ 页面小工具 ------------------------------ */

const bodyText = (cdp) => evaluate(cdp, 'document.body.innerText');

async function login(cdp) {
  await goto(cdp, `${BASE}/login`, 1500);
  await typeInto(cdp, 'input[name="crewloom-account"]', 'main@fixture.test');
  await typeInto(cdp, 'input[name="crewloom-secret"]', 'crewloom-fixture');
  await mouseClickText(cdp, 'button', '登录', { settleMs: 1500 });
  return waitFor(cdp, `location.pathname !== '/login'`, { timeoutMs: 15000 });
}

/** 按精确文案点按钮。 */
async function clickExact(cdp, text, { settleMs = 600 } = {}) {
  await mouseClickText(cdp, 'button', text, { settleMs });
}

/** 某一行（tr）的可读文本。 */
async function rowTextContaining(cdp, text) {
  return evaluate(
    cdp,
    `(() => {
      const row = [...document.querySelectorAll('tr')].find((tr) => (tr.innerText || '').includes(${JSON.stringify(text)}));
      return row ? row.innerText.replace(/\\s+/g, ' ').trim() : null;
    })()`,
  );
}

/** 解析 CDP 捕获的页面请求 POST body（拿不到就返回 null）。 */
function postDataOf(apiRequests, pathFragment) {
  const entry = [...apiRequests].reverse().find((item) => item.url.includes(pathFragment));
  if (!entry) return null;
  try {
    return entry.postData ? JSON.parse(entry.postData) : null;
  } catch {
    return entry.postData;
  }
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  await fixtureReset();

  const browser = await launchBrowser({ debugPort: 9471, width: 1440, height: 1000 });
  const { cdp, close, events } = browser;
  let ledgerBefore = null;

  try {
    await step('登录（本机合成账号）', async () => {
      const ok = await login(cdp);
      if (!ok) throw new Error(`登录后仍在 ${await evaluate(cdp, 'location.pathname')}`);
      return '进入应用';
    });

    /* ---------------- 缺陷一：同名 appends[] 多值 ---------------- */
    await step('用户列表：真实页面同时发出 appends[]=roles 与 appends[]=avatar（两项都在）', async () => {
      const since = (await fixtureLog()).length;
      await goto(cdp, `${BASE}/access/users`, 1800);
      await waitFor(cdp, `document.body.innerText.includes('李四')`, { timeoutMs: 15000 });
      const found = await waitForRequest('users:list', since);
      if (found.length === 0) throw new Error('页面没有发出 users:list');
      const withRole = found.filter((entry) => {
        const value = entry.query?.['appends[]'];
        return Array.isArray(value) ? value.includes('roles') && value.includes('avatar') : false;
      });
      if (withRole.length === 0) {
        throw new Error(`没有任何 users:list 同时带 roles+avatar；实际 query 样本 ${JSON.stringify(found.map((e) => e.query))}`);
      }
      // CDP 侧同样核对真实 URL（解码后应含两个同名键）。
      const urls = events.apiRequests.filter((item) => item.url.includes('users:list')).map((item) => decodeURIComponent(item.url));
      const bothInUrl = urls.some((url) => url.includes('appends[]=roles') && url.includes('appends[]=avatar'));
      if (!bothInUrl) throw new Error(`CDP 捕获的 users:list URL 不同时含两项：${JSON.stringify(urls.slice(-3))}`);
      return `users:list ${found.length} 次；多值样本 ${JSON.stringify(withRole[withRole.length - 1].query['appends[]'])}`;
    });

    await step('用户列表：root 与 李四 的角色真的派生出来（不再是"未分配"）', async () => {
      const rootRow = await rowTextContaining(cdp, '受控管理员');
      const lisiRow = await rowTextContaining(cdp, '李四');
      if (!lisiRow) throw new Error('列表里没有李四这一行');
      if (!lisiRow.includes('销售')) throw new Error(`李四行没有销售角色：${lisiRow}`);
      if (lisiRow.includes('未分配')) throw new Error(`李四行仍显示未分配：${lisiRow}`);
      if (!rootRow || !rootRow.includes('Root')) throw new Error(`root 行没有 Root 角色：${rootRow}`);
      // 未分配角色的成员也照实显示空，不是"无条件给全角色"。
      const memberRow = await rowTextContaining(cdp, '成员甲');
      if (!memberRow || !memberRow.includes('未分配')) throw new Error(`成员甲应显示未分配：${memberRow}`);
      await screenshot(cdp, resolve(SHOT_DIR, '01-users-list-roles.png'));
      return `李四=${lisiRow}｜root=${rootRow}｜成员甲=未分配`;
    });

    await step('用户列表：appends[]=avatar 与 users:get 同源（李四行的头像真的渲染出来）', async () => {
      const count = await evaluate(cdp, `document.querySelectorAll('img[alt="李四的头像"]').length`);
      if (count < 1) throw new Error('列表里没有渲染李四的头像图片');
      const src = await evaluate(cdp, `document.querySelector('img[alt="李四的头像"]')?.getAttribute('src') ?? null`);
      if (!src || !src.includes('/files/')) throw new Error(`头像 src 不是合成的文件地址：${src}`);
      await screenshot(cdp, resolve(SHOT_DIR, '01b-users-list-avatar.png'));
      return `img alt=李四的头像 src=${src}`;
    });

    await step('用户详情与列表同源：李四详情角色是销售（users:get 与 users:list 一致）', async () => {
      const since = (await fixtureLog()).length;
      await goto(cdp, `${BASE}/access/users/2`, 1800);
      await waitFor(cdp, `document.body.innerText.includes('李四')`, { timeoutMs: 15000 });
      const got = await waitForRequest('users:get', since);
      if (got.length === 0) throw new Error('详情没有发出 users:get');
      const text = await bodyText(cdp);
      if (!text.includes('销售')) throw new Error('李四详情没有显示销售角色');
      return `users:get ${got.length} 次；详情含销售`;
    });

    /* ---------------- 缺陷二：反向同步范围 ---------------- */
    await step('准备双表场景：真实页面读取并加载两张合成物理表', async () => {
      await goto(cdp, `${BASE}/datasource/tables/customers`, 1800);
      await waitFor(cdp, `document.body.innerText.includes('读取尚未纳管的物理表')`, { timeoutMs: 15000 });
      const sinceRead = (await fixtureLog()).length;
      await clickExact(cdp, '读取尚未纳管的物理表', { settleMs: 1200 });
      const read = await waitForRequest('dataSources:readTables', sinceRead);
      if (read.length === 0) throw new Error('没有发出 dataSources:readTables');
      await waitFor(cdp, `document.body.innerText.includes('qa_physical_ledger')`, { timeoutMs: 15000 });
      const text = await bodyText(cdp);
      if (!text.includes('qa_physical_archive')) throw new Error('页面没有同时列出第二张合成物理表 qa_physical_archive');

      // 真实鼠标勾选两张表（label 包着 checkbox）。
      await mouseClickText(cdp, 'label', 'qa_physical_ledger', { settleMs: 250 });
      await mouseClickText(cdp, 'label', 'qa_physical_archive', { settleMs: 250 });

      const sinceLoad = (await fixtureLog()).length;
      await mouseClickText(cdp, 'button', '加载所选表为集合', { settleMs: 1000 });
      const loaded = await waitForRequest('dataSources:loadTables', sinceLoad);
      if (loaded.length !== 1) throw new Error(`dataSources:loadTables 次数 ${loaded.length}`);
      const state = await fixtureState();
      for (const name of ['qa_physical_ledger', 'qa_physical_archive']) {
        if (!state.collections.some((collection) => collection.name === name)) throw new Error(`fixture 没有加载 ${name}`);
      }
      return `readTables ${read.length} 次；loadTables 表=${JSON.stringify(loaded[0].body?.tables)}`;
    });

    await step('准备双表场景：两张表各多一个物理表里没有的元数据字段（fixture 直接写入的准备数据）', async () => {
      for (const name of ['qa_physical_ledger', 'qa_physical_archive']) {
        const created = await fixtureWrite(`collections/${name}/fields:create`, { name: 'qa_stale_meta', type: 'string' });
        if (created.status !== 200) throw new Error(`${name} 准备字段失败：${created.status} ${JSON.stringify(created.body)}`);
      }
      const state = await fixtureState();
      const ledgerNames = state.fields.qa_physical_ledger.map((field) => field.name);
      const archiveNames = state.fields.qa_physical_archive.map((field) => field.name);
      ledgerBefore = ledgerNames;
      return `ledger=${JSON.stringify(ledgerNames)}｜archive=${JSON.stringify(archiveNames)}`;
    });

    await step('集合详情：确认框说的是"该集合"，没有改成"整个库"的说法', async () => {
      await goto(cdp, `${BASE}/datasource/tables/qa_physical_ledger`, 1800);
      await waitFor(cdp, `document.body.innerText.includes('反向同步字段')`, { timeoutMs: 15000 });
      const text = await bodyText(cdp);
      if (!text.includes('该集合')) throw new Error('确认/说明里没有"该集合"的单表表述');
      if (/整个(主)?库|全部集合|所有集合/.test(text)) throw new Error('文案被改成全库/全部集合的说法');
      await clickExact(cdp, '反向同步字段', { settleMs: 700 });
      const modal = await waitFor(cdp, `document.body.innerText.includes('确认同步') ? document.body.innerText : ''`, {
        timeoutMs: 10000,
      });
      if (!modal || !modal.includes('该集合')) throw new Error('确认弹窗没有"该集合"表述');
      return '页面与弹窗均为单表表述';
    });

    await step('真实点击反向同步：请求体是 collections:[qa_physical_ledger]，不是空对象', async () => {
      const before = (await fixtureLog()).length;
      await clickExact(cdp, '确认同步', { settleMs: 1500 });
      const synced = await waitForRequest('mainDataSource:syncFields', before);
      if (synced.length !== 1) throw new Error(`mainDataSource:syncFields 次数 ${synced.length}`);
      const body = synced[0].body;
      if (JSON.stringify(body) !== JSON.stringify({ collections: ['qa_physical_ledger'] })) {
        throw new Error(`请求体不是 collections:[qa_physical_ledger]：${JSON.stringify(body)}`);
      }
      // CDP 侧同样核对页面真的发出这个 body（不只 fixture helper）。
      const cdpBody = postDataOf(events.apiRequests, 'mainDataSource:syncFields');
      if (JSON.stringify(cdpBody) !== JSON.stringify({ collections: ['qa_physical_ledger'] })) {
        throw new Error(`CDP 捕获的请求体不一致：${JSON.stringify(cdpBody)}`);
      }
      await screenshot(cdp, resolve(SHOT_DIR, '02-sync-fields-scoped.png'));
      return `fixture body=${JSON.stringify(body)}｜CDP body=${JSON.stringify(cdpBody)}`;
    });

    await step('判别：选中的表被重建，另一张合成物理表的额外元数据保持不动', async () => {
      const state = await fixtureState();
      const ledgerNames = state.fields.qa_physical_ledger.map((field) => field.name);
      const archiveNames = state.fields.qa_physical_archive.map((field) => field.name);
      if (JSON.stringify(ledgerNames) !== JSON.stringify(['id', 'memo'])) {
        throw new Error(`qa_physical_ledger 应被重建为 id/memo，实际 ${JSON.stringify(ledgerNames)}`);
      }
      if (!archiveNames.includes('qa_stale_meta')) {
        throw new Error(`qa_physical_archive 的 qa_stale_meta 被误删：${JSON.stringify(archiveNames)}`);
      }
      if (JSON.stringify(archiveNames) !== JSON.stringify(['id', 'memo', 'archivedAt', 'qa_stale_meta'])) {
        throw new Error(`qa_physical_archive 应原样保留，实际 ${JSON.stringify(archiveNames)}`);
      }
      const lastRun = state.mainDataSourceRuns[state.mainDataSourceRuns.length - 1];
      if (JSON.stringify(lastRun.rebuilt) !== JSON.stringify(['qa_physical_ledger'])) {
        throw new Error(`rebuilt 应只有 qa_physical_ledger：${JSON.stringify(lastRun.rebuilt)}`);
      }
      // 页面读回的字段也只剩物理结构。
      await goto(cdp, `${BASE}/datasource/tables/qa_physical_ledger`, 1800);
      await waitFor(cdp, `document.body.innerText.includes('memo')`, { timeoutMs: 15000 });
      const text = await bodyText(cdp);
      if (text.includes('qa_stale_meta')) throw new Error('同步后页面仍显示 qa_stale_meta');
      return `ledger=${JSON.stringify(ledgerNames)}｜archive=${JSON.stringify(archiveNames)}｜rebuilt=${JSON.stringify(lastRun.rebuilt)}`;
    });

    await step('旧行为对照：少了 collections 的载荷在 fixture 会落到全部集合（真实 2.2.20 缺省语义）', async () => {
      // 这是"旧代码会发出的空载荷"在 fixture 上的表现，用来证明修的是真实差别，不是文案。
      await fixtureReset();
      await fixtureWrite('dataSources:loadTables', { dataSourceKey: 'main', tables: ['qa_physical_ledger', 'qa_physical_archive'] });
      for (const name of ['qa_physical_ledger', 'qa_physical_archive']) {
        await fixtureWrite(`collections/${name}/fields:create`, { name: 'qa_stale_meta', type: 'string' });
      }
      const response = await fetch(`${FIXTURE}/api/mainDataSource:syncFields`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (response.status !== 200) throw new Error(`空载荷 syncFields 状态 ${response.status}`);
      const state = await fixtureState();
      const rebuilt = state.mainDataSourceRuns[state.mainDataSourceRuns.length - 1].rebuilt;
      if (JSON.stringify(rebuilt) !== JSON.stringify(['qa_physical_ledger', 'qa_physical_archive'])) {
        throw new Error(`空载荷应重建全部集合，实际 ${JSON.stringify(rebuilt)}`);
      }
      return `空载荷 rebuilt=${JSON.stringify(rebuilt)}（两张都被动到，正是旧实现的后果）`;
    });
  } finally {
    close();
  }

  // 检查会改本机 fixture 的合成状态；交回给 Main 前恢复到干净的初始数据（双表场景仍在）。
  await fixtureReset();

  /* ------------------------------ 结果与证据 ------------------------------ */
  const evidence = {
    generatedAt: new Date().toISOString(),
    preview: BASE,
    fixture: FIXTURE,
    total: results.length,
    failed,
    steps: results,
    ledgerBefore,
  };
  const outFile = resolve(frontendRoot, '.work/final-adapter-fixes-shots/check-result.json');
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

  console.log(`\n结果：${results.length - failed}/${results.length} 通过，失败 ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
