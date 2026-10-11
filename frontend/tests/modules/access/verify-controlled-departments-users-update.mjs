#!/usr/bin/env node
/**
 * 本机 HTTP 验证：`controlled-departments-fixture.mjs` 的 `users:update` 资料字段**真的落库**。
 *
 * 背景（Main 亲验 5326→5405）：改用户 2 的昵称为「李四验收」时，产品确实发了
 * `POST users:update?filterByTk=2 {nickname:"李四验收"}`、拿到 200、也显式 refetch，
 * 但 `control.users` 仍是「李四」，heading 不变、保存按钮仍可点。根因是 fixture 的
 * `users:update` 只处理 avatar/mainDepartmentId，其余字段被静默丢弃（假成功）。
 *
 * 本脚本只打本机 fixture：先把 4 个资料字段写进记录，再用 `users:get` 读回核对；
 * 同时核对 avatar/mainDepartment 原行为与未实现接口的本机 404 都还在。
 *
 * 用法：`node tests/modules/access/verify-controlled-departments-users-update.mjs`
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, 'controlled-departments-fixture.mjs');

const results = [];
function check(name, ok, note = '') {
  results.push({ name, ok: Boolean(ok), note });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? ` — ${note}` : ''}`);
}

function freePort() {
  return new Promise((done) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => done(port));
    });
  });
}

async function api(base, path, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function run() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [FIXTURE, String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  try {
    // 等服务起来（最多 5s）。
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const state = await api(base, '/__fixture/state');
        if (state.status === 200) {
          ready = true;
          break;
        }
      } catch {
        /* 还没起来 */
      }
      await sleep(100);
    }
    if (!ready) throw new Error(`fixture 未在 5s 内就绪（stderr=${stderr.slice(0, 200)}）`);

    // 1) 四个资料字段真的写入并可读回。
    const updates = [
      { nickname: '李四验收' },
      { username: 'lisi-verified' },
      { email: 'lisi-verified@fixture.test' },
      { phone: '13800000002' },
    ];
    for (const values of updates) {
      const saved = await api(base, '/api/users:update?filterByTk=2', { method: 'POST', body: values });
      check(`POST users:update ${JSON.stringify(values)} → 200`, saved.status === 200, `status=${saved.status}`);
    }
    const got = await api(base, '/api/users:get?filterByTk=2');
    const user = got.body?.data ?? {};
    check('users:get 返回新昵称', user.nickname === '李四验收', `nickname=${JSON.stringify(user.nickname)}`);
    check('users:get 返回新 username', user.username === 'lisi-verified', `username=${JSON.stringify(user.username)}`);
    check('users:get 返回新 email', user.email === 'lisi-verified@fixture.test', `email=${JSON.stringify(user.email)}`);
    check('users:get 返回新 phone', user.phone === '13800000002', `phone=${JSON.stringify(user.phone)}`);

    // 列表页也读得到（产品列表/搜索与详情同一份记录）。
    const listed = await api(base, '/api/users:list?pageSize=50');
    const listedUser = (listed.body?.data ?? []).find((item) => item.id === 2);
    check('users:list 同步新昵称', listedUser?.nickname === '李四验收', `nickname=${JSON.stringify(listedUser?.nickname)}`);

    // 2) 原 avatar 行为保留。
    const avatarSet = await api(base, '/api/users:update?filterByTk=2', { method: 'POST', body: { avatar: { id: 12 } } });
    const afterAvatar = await api(base, '/api/users:get?filterByTk=2');
    check(
      'avatar 写入仍生效',
      avatarSet.status === 200 && afterAvatar.body?.data?.avatar?.id === 12,
      `avatar=${JSON.stringify(afterAvatar.body?.data?.avatar)}`,
    );
    await api(base, '/api/users:update?filterByTk=2', { method: 'POST', body: { avatar: null } });
    const afterAvatarClear = await api(base, '/api/users:get?filterByTk=2');
    check('avatar 清空仍生效', afterAvatarClear.body?.data?.avatar === null, `avatar=${JSON.stringify(afterAvatarClear.body?.data?.avatar)}`);

    // 3) 原 mainDepartment 行为保留。
    await api(base, '/api/users:update?filterByTk=2', { method: 'POST', body: { mainDepartmentId: 3 } });
    const afterDept = await api(base, '/api/users:get?filterByTk=2');
    check('mainDepartmentId 写入仍生效', afterDept.body?.data?.mainDepartmentId === 3, `mainDepartmentId=${afterDept.body?.data?.mainDepartmentId}`);
    await api(base, '/api/users:update?filterByTk=2', { method: 'POST', body: { mainDepartmentId: null } });
    const afterDeptClear = await api(base, '/api/users:get?filterByTk=2');
    check('mainDepartmentId 清空仍生效', afterDeptClear.body?.data?.mainDepartmentId === null, `mainDepartmentId=${afterDeptClear.body?.data?.mainDepartmentId}`);

    // 4) 未实现接口仍是本机 404（不转发、不假成功）。
    const missing = await api(base, '/api/definitely_not_implemented:list');
    check('未实现接口仍 404', missing.status === 404, `status=${missing.status}`);
  } finally {
    child.kill('SIGTERM');
    await sleep(200);
    if (!child.killed) child.kill('SIGKILL');
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length === 0 ? 0 : 1);
}

run().catch((error) => {
  console.error(`验证脚本异常：${error?.stack ?? error}`);
  process.exit(1);
});
