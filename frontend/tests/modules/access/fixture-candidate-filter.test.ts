// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * 本机合成 fixture 的真实 HTTP 行为检查（**开发检查**，不是正式验收）。
 *
 * 主模型在电脑端看到的现象是：部门成员候选里仍有已关联的成员、部门角色候选里仍有
 * 已关联的角色。产品侧的原因（角色的排除条件写错主键）由
 * `desktop-feedback-ui.test.tsx` 断言请求形态；这里断言 fixture **真的执行**产品发来的
 * 原生过滤条件，而不是静默返回全部数据。
 *
 * fixture 只绑定 127.0.0.1，未实现的路由返回本机 404；本检查用随机空闲端口，避免与
 * 其它预览/fixture 抢端口。
 */

let child: ChildProcess | null = null;
let base = '';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error('没有拿到空闲端口');
  return port;
}

async function waitForFixture(url: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/__fixture/state`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`fixture 没有在超时内就绪：${String(lastError)}`);
}

async function getJson(path: string): Promise<any> {
  const response = await fetch(`${base}/api/${path}`);
  expect(response.status, `${path} 的状态码`).toBe(200);
  return response.json();
}

function excludedIds(rows: Array<Record<string, unknown>>, key: string): unknown[] {
  return rows.map((row) => row[key]);
}

beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(
    process.execPath,
    ['tests/modules/access/controlled-departments-fixture.mjs', String(port)],
    {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CREWLOOM_FIXTURE_PRODUCT_PORT: '5326' },
    },
  );
  await waitForFixture(base);
});

afterAll(() => {
  child?.kill('SIGTERM');
  child = null;
});

describe('合成 fixture 的候选过滤（真实 HTTP）', () => {
  it('users:list 真的执行 $notIn：已关联的成员不再出现在候选里', async () => {
    const filter = encodeURIComponent(JSON.stringify({ id: { $notIn: [101] } }));
    const body = await getJson(`users:list?page=1&pageSize=10&filter=${filter}`);
    const ids = excludedIds(body.data, 'id');
    expect(ids).not.toContain(101);
    expect(ids).toContain(102);
    expect(body.meta.count).toBe(4);
  });

  it('roles:list 按真实主键 name 执行 $notIn：已关联的角色不再出现在候选里', async () => {
    const filter = encodeURIComponent(JSON.stringify({ name: { $notIn: ['r_sales'] } }));
    const body = await getJson(`roles:list?pageSize=10&filter=${filter}`);
    const names = excludedIds(body.data, 'name');
    expect(names).not.toContain('r_sales');
    expect(names).toContain('r_audit');
    expect(body.meta.count).toBe(2);
  });

  it('departments:list 按 id 执行 $notIn：已关联的部门不再出现在候选里', async () => {
    const filter = encodeURIComponent(JSON.stringify({ id: { $notIn: [1] } }));
    const body = await getJson(`departments:list?pageSize=10&filter=${filter}`);
    const ids = excludedIds(body.data, 'id');
    expect(ids).not.toContain(1);
    expect(ids).toContain(2);
  });

  it('users:listExcludeRole 按 roleName 排除已经在角色里的用户', async () => {
    const body = await getJson('users:listExcludeRole?roleName=r_sales&pageSize=10');
    const ids = excludedIds(body.data, 'id');
    expect(ids).not.toContain(2);
    expect(ids).toContain(101);
  });

  it('关键字过滤（$or + $includes）也真实生效', async () => {
    const filter = encodeURIComponent(
      JSON.stringify({ $or: [{ nickname: { $includes: '成员' } }, { username: { $includes: '成员' } }] }),
    );
    const body = await getJson(`users:list?pageSize=10&filter=${filter}`);
    const ids = excludedIds(body.data, 'id');
    expect(ids).toEqual([101, 102, 103]);
  });
});

describe('大关联集合场景（超过一页，真实分页）', () => {
  it('关联列表按分页返回完整集合，候选排除可用完整主键', async () => {
    const switched = await fetch(`${base}/__fixture/scenario?name=large-links`, { method: 'POST' });
    expect(switched.status).toBe(200);

    // 部门成员：120 项 / 每页 50 → 3 页，页间不重复也不缺项。
    const membersPage1 = await getJson('departments/1/members:list?page=1&pageSize=50');
    const membersPage2 = await getJson('departments/1/members:list?page=2&pageSize=50');
    const membersPage3 = await getJson('departments/1/members:list?page=3&pageSize=50');
    expect(membersPage1.data).toHaveLength(50);
    expect(membersPage1.meta.count).toBe(120);
    expect(membersPage1.meta.totalPage).toBe(3);
    expect(membersPage3.data).toHaveLength(20);
    const memberIds = [...membersPage1.data, ...membersPage2.data, ...membersPage3.data].map(
      (row: { id: number }) => row.id,
    );
    expect(new Set(memberIds).size).toBe(120);

    const memberFilter = encodeURIComponent(JSON.stringify({ id: { $notIn: memberIds } }));
    const memberCandidates = await getJson(`users:list?page=1&pageSize=10&filter=${memberFilter}`);
    expect(memberCandidates.data.some((user: { id: number }) => memberIds.includes(user.id))).toBe(false);

    // 部门角色：60 项 / 每页 50 → 2 页。
    const rolesPage1 = await getJson('departments/1/roles:list?page=1&pageSize=50');
    const rolesPage2 = await getJson('departments/1/roles:list?page=2&pageSize=50');
    expect(rolesPage1.data).toHaveLength(50);
    expect(rolesPage2.data).toHaveLength(10);
    const roleNames = [...rolesPage1.data, ...rolesPage2.data].map((row: { name: string }) => row.name);
    const roleFilter = encodeURIComponent(JSON.stringify({ name: { $notIn: roleNames } }));
    const roleCandidates = await getJson(`roles:list?pageSize=10&filter=${roleFilter}`);
    expect(roleCandidates.data.some((role: { name: string }) => roleNames.includes(role.name))).toBe(false);
    expect(roleCandidates.data.map((role: { name: string }) => role.name)).toContain('r_audit');

    // 用户部门 / 角色部门两个方向也超过一页。
    const userDepartmentsPage1 = await getJson('users/2/departments:list?page=1&pageSize=50');
    expect(userDepartmentsPage1.data).toHaveLength(50);
    expect(userDepartmentsPage1.meta.count).toBe(60);
    const roleDepartmentsPage2 = await getJson('roles/r_sales/departments:list?page=2&pageSize=50');
    expect(roleDepartmentsPage2.data).toHaveLength(10);

    // 切回默认场景后关联回到基准，避免场景切换残留。
    await fetch(`${base}/__fixture/scenario?name=normal`, { method: 'POST' });
    const baseMembers = await getJson('departments/1/members:list?page=1&pageSize=50');
    expect(baseMembers.data.map((row: { id: number }) => row.id)).toEqual([101]);
  });
});

describe('合成 fixture 的环境边界', () => {
  it('未实现的路由返回本机 404，并说明不会转发', async () => {
    const response = await fetch(`${base}/api/whatever:list`);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(JSON.stringify(body)).toContain('本机合成环境未实现');
  });

  it('控制页的产品地址来自环境参数，不写死历史端口', async () => {
    const response = await fetch(`${base}/`);
    const html = await response.text();
    expect(html).toContain('http://127.0.0.1:5326');
    expect(html).not.toContain('5324');
  });

  it('控制页保留场景切换与恢复初始数据入口', async () => {
    const response = await fetch(`${base}/`);
    const html = await response.text();
    expect(html).toContain('/__fixture/scenario');
    expect(html).toContain('/__fixture/reset');
    expect(html).toContain('_blank');
  });
});
