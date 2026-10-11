#!/usr/bin/env node
/**
 * 上下文数据源契约判别测试（纯本机，不起浏览器、不外呼）。
 *
 * 覆盖 Main 在 5334/5413 实测的两个真实缺陷：
 *  1. 预览表 2 行但每行是“—”：夹具当时返回 `{rows: 记录对象, count}` 假外壳，
 *     而固定 2.2.20 的真实契约是 `{options, total, records: 单元格行 {name,type,value}[][]}`。
 *     本脚本断言预览按**真实契约**返回，并且 expenses 的 128/256 真的在单元格里。
 *  2. 编辑上下文保存 → `aiContextDatasources:update` 501：本机夹具必须像真实服务端一样
 *     支持 update/get/delete 并让重新读取看到更新后的值。
 *
 * 用法：node scripts/check-main-chat-context-contract.mjs   退出码 0 = 全部通过。
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CREWLOOM_CONTEXT_PORT ?? 5464);
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];

function check(name, ok, note = '') {
  results.push({ name, ok: Boolean(ok), note });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? ` — ${note}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/healthz`);
      if (response.ok) return true;
    } catch {
      /* 继续等待 */
    }
    await sleep(200);
  }
  return false;
}

async function api(url, { method = 'GET', body } = {}) {
  const response = await fetch(`${BASE}/api/${url}`, {
    method,
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, body: payload };
}

async function main() {
  const server = spawn(process.execPath, [join(here, 'main-browser-chat-server.mjs')], {
    env: { ...process.env, CREWLOOM_CHAT_PORT: String(PORT), CREWLOOM_APP_URL: 'http://127.0.0.1:1' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    if (!(await waitForServer())) {
      check('0. 本机受控后端启动', false, `${BASE}/healthz 未就绪`);
      return;
    }
    check('0. 本机受控后端启动', true, `port=${PORT}`);

    // 预览：真实 2.2.20 契约（records 单元格行 + total），不是 rows/count 假外壳。
    const preview = await api('aiContextDatasources:preview', {
      method: 'POST',
      body: { datasource: 'main', collectionName: 'expenses', fields: ['id', 'amount'], limit: 20 },
    });
    const data = preview.body?.data ?? {};
    check('1a. 预览 POST 返回 200', preview.status === 200, `status=${preview.status}`);
    check(
      '1b. 预览体是真实契约 {options,total,records}，没有 rows/count 假外壳',
      Array.isArray(data.records) &&
        typeof data.total === 'number' &&
        data.rows === undefined &&
        data.count === undefined,
      `keys=${JSON.stringify(Object.keys(data))}`,
    );
    const flat = (data.records ?? []).flat();
    const cells = flat.filter((cell) => cell && typeof cell === 'object');
    check(
      '1c. records 是单元格行 {name,type,value}',
      Array.isArray(data.records) &&
        data.records.every((row) => Array.isArray(row)) &&
        cells.length === flat.length &&
        cells.every((cell) => typeof cell.name === 'string' && typeof cell.type === 'string' && 'value' in cell),
      `rows=${Array.isArray(data.records) ? data.records.length : 'n/a'}`,
    );
    const amountValues = cells.filter((cell) => cell.name === 'amount').map((cell) => cell.value);
    check(
      '1d. expenses 实际字段值 128 / 256 在单元格里（不是每行 —）',
      amountValues.length === 2 && amountValues.includes(128) && amountValues.includes(256),
      `amounts=${JSON.stringify(amountValues)}`,
    );
    check('1e. 总数按命中条数（total=2）', data.total === 2, `total=${data.total}`);

    // 编辑保存：create → update → get/list 读回 → destroy。
    const created = await api('aiContextDatasources:create', {
      method: 'POST',
      body: {
        title: '合成范围·编辑前',
        datasource: 'main',
        collectionName: 'expenses',
        fields: ['id'],
        filter: null,
        sort: null,
        limit: 20,
      },
    });
    const id = created.body?.data?.id;
    check('2a. create 返回记录 id 且回显字段', created.status === 200 && typeof id === 'string' && id.length > 0, `id=${id}`);

    const updated = await api(`aiContextDatasources:update?filterByTk=${encodeURIComponent(id)}`, {
      method: 'POST',
      body: { title: '合成范围·编辑后', fields: ['id', 'amount'], limit: 5 },
    });
    check(
      '2b. update 返回 200（此前夹具是 501）并回显新值',
      updated.status === 200 && updated.body?.data?.title === '合成范围·编辑后' && updated.body?.data?.limit === 5,
      `status=${updated.status} data=${JSON.stringify(updated.body?.data ?? null)}`,
    );

    const readBack = await api(`aiContextDatasources:get?filterByTk=${encodeURIComponent(id)}`);
    check(
      '2c. get 读回更新后的值（UI 重新读取的契约）',
      readBack.status === 200 &&
        readBack.body?.data?.title === '合成范围·编辑后' &&
        JSON.stringify(readBack.body?.data?.fields) === JSON.stringify(['id', 'amount']),
      `title=${readBack.body?.data?.title}`,
    );

    const list = await api('aiContextDatasources:list');
    const rows = list.body?.data ?? [];
    check(
      '2d. list 同步更新后的记录',
      Array.isArray(rows) && rows.some((row) => row.id === id && row.title === '合成范围·编辑后'),
      `count=${rows.length}`,
    );

    const destroyed = await api(`aiContextDatasources:destroy?filterByTk=${encodeURIComponent(id)}`, { method: 'POST' });
    const afterDestroy = await api(`aiContextDatasources:get?filterByTk=${encodeURIComponent(id)}`);
    check(
      '2e. destroy 后 get 不再返回该记录（真实删除语义）',
      destroyed.status === 200 && afterDestroy.status !== 200,
      `destroy=${destroyed.status} getAfter=${afterDestroy.status}`,
    );
  } finally {
    server.kill('SIGTERM');
  }
}

await main();
const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
