// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * 本机合成 fixture 的**业务闭环**检查（开发检查，不是正式验收）。
 *
 * 覆盖本轮新增的本机能力，全部通过真实 HTTP 打本机 fixture：
 *  - TD-04 抄送：`get` / 单条已读 / 未读 / 全部已读，以及**由数据实时算出的计数**；
 *  - DS-03/04：集合、字段（含 belongsTo 关系）、业务记录增改删与聚合；
 *  - AC-01/02：用户资料与角色绑定、角色成员（同一份事实来源，两边一致）；
 *  - AC-03：原页面路由 / 菜单界面 / 权限片段；
 *  - AC-04：资源授权读取、`applyDataPermissions` 写回、记录范围创建。
 *
 * fixture 只绑定 127.0.0.1，未实现的路由返回本机 404；本文件用随机空闲端口，
 * 不连接真实 13000，也不读取任何凭据。
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

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}/api/${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  return { status: response.status, body: await response.json() };
}

async function post(path: string, values?: unknown): Promise<{ status: number; body: any }> {
  return api(path, { method: 'POST', body: JSON.stringify(values === undefined ? {} : { values }) });
}

/** 每个 describe 都从干净的初始数据开始（已读/关系/授权的改动不互相影响）。 */
async function reset(): Promise<void> {
  const response = await fetch(`${base}/__fixture/reset`, { method: 'POST' });
  expect(response.status).toBe(200);
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
      env: { ...process.env, CREWLOOM_FIXTURE_PRODUCT_PORT: '5339' },
    },
  );
  await waitForFixture(base);
});

afterAll(() => {
  child?.kill('SIGTERM');
  child = null;
});

describe('TD-04 抄送：get / 已读 / 未读 / 全部已读与计数', () => {
  it('列表与详情按当前用户返回，未知 id 是本机 404（不是空数据）', async () => {
    await reset();
    const list = await api('workflowCcTasks:listMine?pageSize=20');
    expect(list.status).toBe(200);
    expect(list.body.data.map((row: { id: string }) => row.id)).toEqual(['601', '602']);
    expect(list.body.meta.count).toBe(2);

    const detail = await api('workflowCcTasks:get?filterByTk=601');
    expect(detail.status).toBe(200);
    expect(detail.body.data.node.title).toBe('抄送通知');
    expect(detail.body.data.status).toBe(0);

    const missing = await api('workflowCcTasks:get?filterByTk=999');
    expect(missing.status).toBe(404);
  });

  it('单条已读/未读与全部已读都真的改状态，并且计数随之变化', async () => {
    await reset();
    const before = await api('userWorkflowTaskStats:listMine?page=1&pageSize=200');
    // 人工 1 条待处理 + 抄送 1 条未读 = 2；全部 1 + 2 = 3。
    expect(before.body.data[0].stats).toEqual({ pending: 2, all: 3 });

    const read = await post('workflowCcTasks:read?filterByTk=601');
    expect(read.status).toBe(200);
    expect(read.body.data.status).toBe(1);
    expect(read.body.data.readAt).toBeTruthy();

    const afterRead = await api('userWorkflowTaskStats:listMine?page=1&pageSize=200');
    expect(afterRead.body.data[0].stats).toEqual({ pending: 1, all: 3 });

    const unread = await post('workflowCcTasks:unread?filterByTk=601');
    expect(unread.body.data.status).toBe(0);
    expect(unread.body.data.readAt).toBeNull();

    const readAll = await post('workflowCcTasks:readAll');
    expect(readAll.status).toBe(200);
    const list = await api('workflowCcTasks:listMine?pageSize=20');
    expect(list.body.data.every((row: { status: number }) => row.status === 1)).toBe(true);
    const afterAll = await api('userWorkflowTaskStats:listMine?page=1&pageSize=200');
    // 抄送都读了，只剩人工待办 1 条。
    expect(afterAll.body.data[0].stats).toEqual({ pending: 1, all: 3 });
  });
});

describe('DS-03 集合与字段（含关系）', () => {
  it('业务集合、字段清单与 belongsTo 关系都真实返回', async () => {
    await reset();
    const collections = await api('collections:list?pageSize=300');
    expect(collections.body.data.map((row: { name: string }) => row.name)).toEqual(['customers', 'orders']);

    const detail = await api('collections:get?filterByTk=customers&appends=fields');
    expect(detail.status).toBe(200);
    expect(detail.body.data.title).toBe('客户');
    expect(detail.body.data.fields.map((field: { name: string }) => field.name)).toContain('owner');

    const fields = await api('collections/customers/fields:list?pageSize=300');
    const owner = fields.body.data.find((field: { name: string }) => field.name === 'owner');
    expect(owner).toMatchObject({ type: 'belongsTo', target: 'users', foreignKey: 'ownerId' });

    const missing = await api('collections:get?filterByTk=not_exists');
    expect(missing.status).toBe(404);
  });

  it('字段可新增、可删除，且重复标识返回真实错误', async () => {
    await reset();
    const created = await post('collections/customers/fields:create', { name: 'level', type: 'string', interface: 'input' });
    expect(created.status).toBe(200);
    expect(created.body.data.name).toBe('level');

    const duplicate = await post('collections/customers/fields:create', { name: 'level', type: 'string' });
    expect(duplicate.status).toBe(400);

    const removed = await api('collections/customers/fields:destroy?filterByTk=level', { method: 'POST', body: '{}' });
    expect(removed.status).toBe(200);
    const after = await api('collections/customers/fields:list?pageSize=300');
    expect(after.body.data.some((field: { name: string }) => field.name === 'level')).toBe(false);
  });
});

describe('DS-04 业务记录读写（含关系展开与聚合）', () => {
  it('列表/详情带出 belongsTo 关系对象，筛选按真实条件生效', async () => {
    await reset();
    const list = await api('customers:list?page=1&pageSize=10');
    expect(list.body.meta.count).toBe(3);
    const first = list.body.data.find((row: { id: number }) => row.id === 1);
    expect(first.owner).toMatchObject({ id: 2, nickname: '李四' });

    const filter = encodeURIComponent(JSON.stringify({ status: 'active' }));
    const filtered = await api(`customers:list?page=1&pageSize=10&filter=${filter}`);
    expect(filtered.body.meta.count).toBe(2);

    const orders = await api('orders:list?pageSize=10');
    expect(orders.body.data[0].customer).toMatchObject({ id: 1, name: '合成客户甲' });
  });

  it('新增 → 读回 → 修改 → 读回 → 删除 → 404（真实状态机）', async () => {
    await reset();
    const created = await post('customers:create', { name: '合成客户丁', amount: 77, status: 'active', ownerId: 2 });
    expect(created.status).toBe(200);
    const id = created.body.data.id;

    const readBack = await api(`customers:get?filterByTk=${id}`);
    expect(readBack.body.data).toMatchObject({ name: '合成客户丁', amount: 77 });

    const updated = await post(`customers:update?filterByTk=${id}`, { status: 'paused' });
    expect(updated.body.data.status).toBe('paused');
    expect((await api(`customers:get?filterByTk=${id}`)).body.data.status).toBe('paused');

    const destroyed = await api(`customers:destroy?filterByTk=${id}`, { method: 'POST', body: '{}' });
    expect(destroyed.status).toBe(200);
    expect((await api(`customers:get?filterByTk=${id}`)).status).toBe(404);
  });

  it('聚合按维度分组返回真实合计', async () => {
    await reset();
    const result = await post('customers:query', {
      measures: [{ field: 'amount', aggregation: 'sum' }],
      dimensions: ['status'],
    });
    expect(result.status).toBe(200);
    expect(result.body.data).toEqual(
      expect.arrayContaining([
        { status: 'active', amount: 192 },
        { status: 'paused', amount: 256 },
      ]),
    );
  });
});

describe('AC-01 用户资料与角色绑定（与 AC-02 同一份成员关系）', () => {
  it('改角色绑定后，用户详情与角色成员两边同时变化', async () => {
    await reset();
    const before = await api('users:get?filterByTk=2');
    expect(before.body.data.roles.map((role: { name: string }) => role.name)).toEqual(['r_sales']);

    const updated = await post('users:update?filterByTk=2', { nickname: '李四', roles: ['r_audit'] });
    expect(updated.status).toBe(200);
    expect(updated.body.data.roles.map((role: { name: string }) => role.name)).toEqual(['r_audit']);

    const readBack = await api('users:get?filterByTk=2');
    expect(readBack.body.data.nickname).toBe('李四');
    expect(readBack.body.data.roles.map((role: { name: string }) => role.name)).toEqual(['r_audit']);

    const auditMembers = await api('roles/r_audit/users:list?pageSize=10');
    expect(auditMembers.body.data.map((user: { id: number }) => user.id)).toEqual([2]);
    const salesMembers = await api('roles/r_sales/users:list?pageSize=10');
    expect(salesMembers.body.meta.count).toBe(0);
  });

  it('rolesUsers 透视行与默认角色可读', async () => {
    await reset();
    const filter = encodeURIComponent(JSON.stringify({ userId: '2' }));
    const pivots = await api(`rolesUsers:list?pageSize=50&filter=${filter}`);
    expect(pivots.body.data).toEqual([
      { id: 2, userId: '2', roleName: 'r_sales', default: false },
    ]);
  });
});

describe('AC-02 角色成员读写', () => {
  it('候选排除已有成员，add/remove 真实改变成员', async () => {
    await reset();
    const candidates = await api('users:listExcludeRole?roleName=r_sales&pageSize=10');
    expect(candidates.body.data.map((user: { id: number }) => user.id)).not.toContain(2);
    expect(candidates.body.data.map((user: { id: number }) => user.id)).toContain(101);

    const added = await post('roles/r_sales/users:add', [101, 102]);
    expect(added.status).toBe(200);
    const afterAdd = await api('roles/r_sales/users:list?pageSize=10');
    expect(afterAdd.body.meta.count).toBe(3);

    const removed = await post('roles/r_sales/users:remove', [101]);
    expect(removed.status).toBe(200);
    const afterRemove = await api('roles/r_sales/users:list?pageSize=10');
    expect(afterRemove.body.data.map((user: { id: number }) => user.id)).toEqual([2, 102]);
  });
});

describe('AC-03 入口授权读写', () => {
  it('原页面路由可读可改，菜单界面与权限片段同样可写', async () => {
    await reset();
    const all = await api('desktopRoutes:list?pageSize=500');
    expect(all.body.data.map((route: { id: number }) => route.id)).toEqual([11, 12, 13, 14]);

    const authorized = await api('roles/root/desktopRoutes:list?pageSize=500');
    expect(authorized.body.data.map((route: { id: number }) => route.id)).toEqual([11, 12, 13, 14]);

    const removed = await post('roles/root/desktopRoutes:remove', [13, 14]);
    expect(removed.status).toBe(200);
    const afterRemove = await api('roles/root/desktopRoutes:list?pageSize=500');
    expect(afterRemove.body.data.map((route: { id: number }) => route.id)).toEqual([11, 12]);

    const schemas = await api('roles/root/menuUiSchemas:list?pageSize=200');
    expect(schemas.body.data.map((row: { 'x-uid': string }) => row['x-uid'])).toEqual(['menu:root-home']);
    const addedMenu = await post('roles/root/menuUiSchemas:add', ['menu:extra']);
    expect(addedMenu.status).toBe(200);
    const afterMenu = await api('roles/root/menuUiSchemas:list?pageSize=200');
    expect(afterMenu.body.data.map((row: { 'x-uid': string }) => row['x-uid'])).toContain('menu:extra');

    const snippets = await post('roles:update?filterByTk=r_sales', { snippets: ['pm', 'ui.*'] });
    expect(snippets.status).toBe(200);
    expect(snippets.body.data.snippets).toEqual(['pm', 'ui.*']);
  });

  it('角色在集合维度的配置状态由 AC-04 的授权派生', async () => {
    await reset();
    const configs = await api('roles/r_sales/collections:list?pageSize=500&dataSourceKey=main');
    expect(configs.body.data).toEqual([
      { id: 1, name: 'customers', title: '客户', collectionName: 'customers', usingConfig: 'role', exists: true },
      { id: 2, name: 'orders', title: '订单', collectionName: 'orders', usingConfig: 'strategy', exists: true },
    ]);
  });
});

describe('AC-04 数据授权读写', () => {  it('资源与动作（含记录范围）按真实形状读取', async () => {
    await reset();
    const resources = await api('roles/r_sales/resources:list?pageSize=300');
    expect(resources.body.data.map((row: { name: string }) => row.name)).toEqual(['customers', 'orders']);

    const filter = encodeURIComponent(JSON.stringify({ rolesResourceId: 201 }));
    const actions = await api(`dataSourcesRolesResourcesActions:list?pageSize=200&filter=${filter}`);
    expect(actions.body.data.map((row: { name: string }) => row.name)).toEqual(['view', 'update']);
    expect(actions.body.data[0].fields).toContain('amount');

    const scopes = await api('dataSourcesRolesResourcesScopes:list?pageSize=200');
    expect(scopes.body.data.map((row: { key: string }) => row.key)).toEqual(['own_records', 'all_records']);
  });

  it('applyDataPermissions 整体替换该资源的动作，读回一致', async () => {
    await reset();
    const applied = await post('roles:applyDataPermissions?filterByTk=r_sales', {
      dataSourceKey: 'main',
      resources: [
        {
          name: 'customers',
          usingActionsConfig: true,
          actions: [{ name: 'view', fields: ['id', 'name'], scopeId: 2 }],
        },
      ],
    });
    expect(applied.status).toBe(200);
    expect(applied.body.data.updated).toBe(1);

    const filter = encodeURIComponent(JSON.stringify({ rolesResourceId: 201 }));
    const actions = await api(`dataSourcesRolesResourcesActions:list?pageSize=200&filter=${filter}`);
    expect(actions.body.data).toEqual([
      expect.objectContaining({ name: 'view', fields: ['id', 'name'], scopeId: 2 }),
    ]);

    // 空的 resources 是真实错误，不用 200 空响应掩盖。
    const empty = await post('roles:applyDataPermissions?filterByTk=r_sales', { dataSourceKey: 'main', resources: [] });
    expect(empty.status).toBe(400);
  });

  it('单资源更新与自定义记录范围创建后都能读回', async () => {
    await reset();
    const single = await post('roles/r_sales/resources:update?filterByTk=orders', {
      name: 'orders',
      usingActionsConfig: true,
      actions: [{ name: 'view' }],
    });
    expect(single.status).toBe(200);
    const resources = await api('roles/r_sales/resources:list?pageSize=300');
    const orders = resources.body.data.find((row: { name: string }) => row.name === 'orders');
    expect(orders.usingActionsConfig).toBe(true);

    const scope = await post('dataSourcesRolesResourcesScopes:create', {
      key: 'customers_only_active',
      name: '仅启用客户',
      dataSourceKey: 'main',
      resourceName: 'customers',
      scope: { status: 'active' },
    });
    expect(scope.status).toBe(200);
    const scopes = await api('dataSourcesRolesResourcesScopes:list?pageSize=200');
    expect(scopes.body.data.map((row: { key: string }) => row.key)).toContain('customers_only_active');
  });
});

describe('TD-03 AI 任务：真实 readonly / 受理人契约', () => {
  it('readonly = status !== pending_approval || acceptedUserId !== 当前用户', async () => {
    await reset();
    const other = await api('aiWorkflowTasks:getBySession?sessionId=ai-task-other');
    expect(other.body.data).toMatchObject({ status: 'pending_approval', acceptedUserId: 3, readonly: true });

    const mine = await api('aiWorkflowTasks:getBySession?sessionId=ai-task-mine');
    expect(mine.body.data).toMatchObject({ status: 'pending_approval', acceptedUserId: 1, readonly: false });

    // 待领取时 readonly 本来就是 true；页面不能拿它一刀切禁用「领取」。
    const open = await api('aiWorkflowTasks:getBySession?sessionId=ai-task-open');
    expect(open.body.data).toMatchObject({ status: 'pending_acceptance', acceptedUserId: null, readonly: true });

    const missing = await api('aiWorkflowTasks:getBySession?sessionId=not-a-session');
    expect(missing.status).toBe(404);
  });

  it('非受理人终止 403；受理人可终止；待领取可领取（真实守卫，不谎报成功）', async () => {
    await reset();
    const forbidden = await post('aiWorkflowTasks:reject', { id: 9001, result: '用户终止' });
    expect(forbidden.status).toBe(403);
    expect(JSON.stringify(forbidden.body)).toContain('AI_TASK_NOT_REJECTABLE');

    const accepted = await post('aiWorkflowTasks:accept', { sessionId: 'ai-task-open' });
    expect(accepted.body.data).toMatchObject({ accepted: true, acceptedUserId: 1 });
    const afterAccept = await api('aiWorkflowTasks:getBySession?sessionId=ai-task-open');
    expect(afterAccept.body.data).toMatchObject({ status: 'pending_approval', readonly: false });

    // 已被别人领取时再领取：返回 accepted:false，而不是谎报"已领取"。
    const raced = await post('aiWorkflowTasks:accept', { sessionId: 'ai-task-other' });
    expect(raced.body.data.accepted).toBe(false);

    const rejected = await post('aiWorkflowTasks:reject', { id: 9002, result: '用户终止' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.data.status).toBe('rejected');
  });

  it('工具调用是 executeFrontendTool + 真实 toolId，继续执行在本环境如实 501', async () => {
    await reset();
    const messages = await api('aiConversations:getMessages?sessionId=ai-task-other&updateRead=false&paginate=false');
    const calls = messages.body.data[0].toolCalls;
    expect(calls.map((call: { name: string }) => call.name)).toEqual([
      'executeFrontendTool',
      'executeFrontendTool',
    ]);
    expect(calls.map((call: { args: { toolId: string } }) => call.args.toolId)).toEqual([
      'crewloom:code-workspace:read_code_workspace',
      'crewloom:code-workspace:apply_code_change',
    ]);

    // 决定只记录状态，不触发模型：返回真实形状 {updated, toolCalls}。
    const decision = await post('aiConversations:updateUserDecision', {
      sessionId: 'ai-task-other',
      messageId: 8101,
      toolCallId: 'call-read',
      userDecision: { type: 'approve' },
    });
    expect(decision.body.data.updated).toBe(1);

    // 继续执行会真实外呼模型：本环境不假装成功。
    const resume = await post('aiConversations:resumeToolCall', { sessionId: 'ai-task-other' });
    expect(resume.status).toBe(501);
  });
});

/** fixture 自身状态（`/__fixture/state`），用于核对调用记录与副作用。 */
async function fixtureState(): Promise<any> {
  const response = await fetch(`${base}/__fixture/state`);
  expect(response.status).toBe(200);
  return (await response.json()).data;
}

describe('DS-03 主库刷新 / 反向同步 / 物理表（按固定 2.2.20 契约实现的本机 fixture）', () => {
  it('mainDataSource:refresh 已实现且不接收 values（真实 2.2.20 只重新载入插件自带的集合定义）', async () => {
    await reset();
    const refreshed = await post('mainDataSource:refresh', {});
    expect(refreshed.status).toBe(200);

    // 刷新不改集合/字段/记录（真实实现不扫物理表、不重建字段）。
    const collectionsBefore = (await api('collections:list?pageSize=300')).body.data.map((row: { name: string }) => row.name);
    expect(collectionsBefore).toEqual(['customers', 'orders']);
    const state = await fixtureState();
    const lastRun = state.mainDataSourceRuns[state.mainDataSourceRuns.length - 1];
    expect(lastRun).toMatchObject({ action: 'refresh' });
  });

  it('dataSources:readTables 用真实 [{name}] 形状返回尚未纳管的物理表；loadTables 写入集合后可读回', async () => {
    await reset();
    const before = await api('dataSources:readTables');
    expect(before.status).toBe(200);
    // 初始有两张合成物理表（双表同步判别场景）。
    expect(before.body.data).toEqual([{ name: 'qa_physical_ledger' }, { name: 'qa_physical_archive' }]);

    const loaded = await post('dataSources:loadTables', { dataSourceKey: 'main', tables: ['qa_physical_ledger'] });
    expect(loaded.status).toBe(200);

    const after = await api('dataSources:readTables');
    // 已纳管的表不再出现，另一张仍未纳管。
    expect(after.body.data).toEqual([{ name: 'qa_physical_archive' }]);

    const collections = await api('collections:list?pageSize=300');
    expect(collections.body.data.map((row: { name: string }) => row.name)).toContain('qa_physical_ledger');
    const fields = await api('collections/qa_physical_ledger/fields:list?pageSize=300');
    expect(fields.body.data.map((field: { name: string }) => field.name)).toEqual(['id', 'memo']);

    // 加载不存在的表：如实 400，不谎报成功。
    const bogus = await post('dataSources:loadTables', { dataSourceKey: 'main', tables: ['not_a_table'] });
    expect(bogus.status).toBe(400);
  });

  it('mainDataSource:syncFields 只重建 collections 指定的集合；另一张合成物理表的额外元数据保持（真实 2.2.20 缺省才是全部）', async () => {
    await reset();
    await post('dataSources:loadTables', {
      dataSourceKey: 'main',
      tables: ['qa_physical_ledger', 'qa_physical_archive'],
    });
    // 两张合成表都"元数据里多一个物理表没有的字段"：模拟元数据与物理结构不一致的场景。
    expect((await post('collections/qa_physical_ledger/fields:create', { name: 'temp', type: 'string' })).status).toBe(200);
    expect((await post('collections/qa_physical_archive/fields:create', { name: 'temp', type: 'string' })).status).toBe(200);

    // 产品详情页的动作：显式只同步当前集合。
    const synced = await post('mainDataSource:syncFields', { collections: ['qa_physical_ledger'] });
    expect(synced.status).toBe(200);

    // 选中的表按物理结构重建（物理表里没有的字段记录被删除）。
    const ledgerFields = await api('collections/qa_physical_ledger/fields:list?pageSize=300');
    expect(ledgerFields.body.data.map((field: { name: string }) => field.name)).toEqual(['id', 'memo']);

    // 另一张合成物理表原样保留：它的额外元数据没有被"顺手"一起删掉。
    const archiveFields = await api('collections/qa_physical_archive/fields:list?pageSize=300');
    expect(archiveFields.body.data.map((field: { name: string }) => field.name)).toEqual(['id', 'memo', 'archivedAt', 'temp']);

    const state = await fixtureState();
    const lastRun = state.mainDataSourceRuns[state.mainDataSourceRuns.length - 1];
    expect(lastRun).toMatchObject({
      action: 'syncFields',
      values: { collections: ['qa_physical_ledger'] },
      rebuilt: ['qa_physical_ledger'],
    });
  });
});

describe('Main 复验三条（基线修复在本机环境可重跑）', () => {
  it('删除集合后详情返回 404（产品据此清缓存并跳回列表）', async () => {
    await reset();
    const created = await post('collections:create', { name: 'qa_drop', title: '待删除集合' });
    expect(created.status).toBe(200);
    expect((await api('collections:get?filterByTk=qa_drop&appends=fields')).status).toBe(200);

    const destroyed = await api('collections:destroy?filterByTk=qa_drop', { method: 'POST', body: '{}' });
    expect(destroyed.status).toBe(200);
    expect((await api('collections:get?filterByTk=qa_drop&appends=fields')).status).toBe(404);
  });

  it('aiEmployees:create 有真实唯一名/必填校验，创建后 list/get 立即可见', async () => {
    await reset();
    const created = await post('aiEmployees:create', {
      username: 'qa-employee',
      nickname: 'QA 新员工',
      enabled: false,
    });
    expect(created.status).toBe(200);
    expect(created.body.data).toMatchObject({ username: 'qa-employee', nickname: 'QA 新员工', enabled: false });

    const readBack = await api('aiEmployees:get?filterByTk=qa-employee');
    expect(readBack.status).toBe(200);
    expect(readBack.body.data.nickname).toBe('QA 新员工');

    const duplicate = await post('aiEmployees:create', { username: 'qa-employee' });
    expect(duplicate.status).toBe(400);
    expect(JSON.stringify(duplicate.body)).toContain('UNIQUE_VIOLATION');

    const missing = await post('aiEmployees:create', {});
    expect(missing.status).toBe(400);
    expect(JSON.stringify(missing.body)).toContain('INVALID_USERNAME');

    const listed = await api('aiEmployees:list?pageSize=50');
    expect(listed.body.data.some((row: { username: string }) => row.username === 'qa-employee')).toBe(true);
  });

  it('users:list 同时带 appends[]=roles&appends[]=avatar 时与 users:get 同源（Main 5352 抓到的真实多值组合）', async () => {
    await reset();
    // Main 5352 被动 CDP 抓到的真实 URL：同名 `appends[]` 出现两次，`getAll` 是 ['roles','avatar']。
    // 旧 parseQuery 用后值覆盖前值，只剩 avatar，列表因此显示"未分配"。
    const list = await api('users:list?pageSize=200&appends[]=roles&appends[]=avatar');
    const user2 = list.body.data.find((user: { id: number }) => user.id === 2);
    expect(user2.roles.map((role: { name: string }) => role.name)).toEqual(['r_sales']);

    const detail = await api('users:get?filterByTk=2');
    expect(detail.body.data.roles.map((role: { name: string }) => role.name)).toEqual(['r_sales']);

    // root 同样从那份 roleUsers 派生（不是"无条件给全角色"）。
    const root = list.body.data.find((user: { id: number }) => user.id === 1);
    expect(root.roles.map((role: { name: string }) => role.name)).toEqual(['root']);

    // 未分配角色的人两边都为空，不伪造全体角色。
    const unassigned = list.body.data.find((user: { id: number }) => user.id === 101);
    expect(unassigned.roles).toEqual([]);

    // 头像同样按 appends 派生（与 users:get 同一份 state.avatar，不是只认 roles）。
    expect(user2.avatar?.url).toBe('/files/fixture/main/attachments/9.png');
    expect(detail.body.data.avatar?.url).toBe('/files/fixture/main/attachments/9.png');

    // 同名参数顺序颠倒也必须两项都在（多值保留与顺序无关）。
    const swapped = await api('users:list?pageSize=200&appends[]=avatar&appends[]=roles');
    expect(
      swapped.body.data.find((user: { id: number }) => user.id === 2).roles.map((role: { name: string }) => role.name),
    ).toEqual(['r_sales']);

    // 只带 avatar（不含 roles）时列表确实不带角色键——证明不是无条件补角色。
    const avatarOnly = await api('users:list?pageSize=200&appends[]=avatar');
    expect(avatarOnly.body.data.find((user: { id: number }) => user.id === 2).roles).toBeUndefined();
    expect(avatarOnly.body.data.find((user: { id: number }) => user.id === 2).avatar?.url).toBe(
      '/files/fixture/main/attachments/9.png',
    );
  });
});
