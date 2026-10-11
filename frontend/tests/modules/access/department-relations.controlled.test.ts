// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetAuthContext, setApiBase, setAuthContext, setTransportMode } from '../../../src/api/client';
import {
  addDepartmentMembers,
  addDepartmentRoles,
  addRoleDepartments,
  addUserDepartments,
  associationAvailability,
  listDepartmentMembers,
  listDepartmentRoles,
  listRoleDepartments,
  listUserDepartments,
  listUsers,
  removeDepartmentMembers,
  removeDepartmentRoles,
  removeRoleDepartments,
  removeUserDepartments,
  setDepartmentMembers,
  setDepartmentRoles,
  setRoleDepartments,
  setUserDepartments,
  updateUserMainDepartment,
} from '../../../src/modules/access/operations';
import { lastRequest, startControlledServer, type ControlledServer } from './controlled-server';

/**
 * AC-06 四个方向的关联维护：受控写验证（本机真实 HTTP 服务 + SDK 请求管线）。
 *
 * 断言的契约来自 `@nocobase/plugin-departments@2.2.20` 的**发布产物**
 * （`dist/server/middlewares/reset-user-departments-cache.js` 里
 * `associatedName/resourceName` 与 `add|remove|set` 的实际组合），
 * 以及 `patches/nocobase-2.2.20-departments/tools/app-http-chain.mjs` 里
 * 逐条真实 HTTP 调用的请求体形状：
 *
 * | 方向 | 路径 | 请求体 |
 * | --- | --- | --- |
 * | 部门→成员 | `POST /api/departments/<id>/members:add\|remove\|set` | 用户 id 裸数组 |
 * | 部门→角色 | `POST /api/departments/<id>/roles:add\|remove\|set` | 角色名裸数组 |
 * | 用户→部门 | `POST /api/users/<id>/departments:add\|remove\|set` | 部门 id 裸数组 |
 * | 角色→部门 | `POST /api/roles/<name>/departments:add\|remove\|set` | 部门 id 裸数组 |
 *
 * 边界：不连接 13000、不写任何真实数据；服务只绑定 127.0.0.1 随机端口。
 */
let server: ControlledServer;

beforeAll(async () => {
  server = await startControlledServer();
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  server.reset();
  setApiBase(server.baseURL);
  setTransportMode('product');
  setAuthContext({ token: 'controlled-token', role: 'r_test', authenticator: 'basic' });
  server.respond(() => ({ body: { data: null } }));
});

afterEach(() => {
  resetAuthContext();
  setApiBase('/api');
});

describe('部门 → 成员（departments/<id>/members）', () => {
  it('add / remove / set 的路径、方法与裸数组请求体', async () => {
    await addDepartmentMembers(1, [101, 102]);
    await removeDepartmentMembers(1, [101]);
    await setDepartmentMembers(1, [102, 103]);

    const add = lastRequest(server, 'departments/1/members:add');
    expect(add?.method).toBe('POST');
    expect(add?.body).toEqual([101, 102]);

    expect(lastRequest(server, 'departments/1/members:remove')?.body).toEqual([101]);
    expect(lastRequest(server, 'departments/1/members:set')?.body).toEqual([102, 103]);
    expect(server.requests).toHaveLength(3);
  });

  it('读取成员是 GET，分页参数走查询串', async () => {
    server.respond(() => ({ body: { data: [], meta: { count: 0 } } }));
    await listDepartmentMembers(7, { page: 2, pageSize: 20 });

    const request = lastRequest(server, 'departments/7/members:list');
    expect(request?.method).toBe('GET');
    expect(request?.query.page).toBe('2');
    expect(request?.query.pageSize).toBe('20');
  });
});

describe('部门 → 角色（departments/<id>/roles）', () => {
  it('add / remove / set 的请求体是角色名数组', async () => {
    await addDepartmentRoles(1, ['r_sales']);
    await removeDepartmentRoles(1, ['r_sales', 'r_audit']);
    await setDepartmentRoles(1, ['r_audit']);

    expect(lastRequest(server, 'departments/1/roles:add')?.body).toEqual(['r_sales']);
    expect(lastRequest(server, 'departments/1/roles:remove')?.body).toEqual(['r_sales', 'r_audit']);
    expect(lastRequest(server, 'departments/1/roles:set')?.body).toEqual(['r_audit']);
  });

  it('读取部门角色是 GET', async () => {
    server.respond(() => ({ body: { data: [], meta: { count: 0 } } }));
    await listDepartmentRoles(1, { pageSize: 50 });
    const request = lastRequest(server, 'departments/1/roles:list');
    expect(request?.method).toBe('GET');
    expect(request?.query.pageSize).toBe('50');
  });
});

describe('用户 → 部门（users/<id>/departments）', () => {
  it('add / remove / set 的请求体是部门 id 数组', async () => {
    await addUserDepartments(9, [1, 2]);
    await removeUserDepartments(9, [2]);
    await setUserDepartments(9, [3]);

    expect(lastRequest(server, 'users/9/departments:add')?.body).toEqual([1, 2]);
    expect(lastRequest(server, 'users/9/departments:remove')?.body).toEqual([2]);
    expect(lastRequest(server, 'users/9/departments:set')?.body).toEqual([3]);
  });

  it('读取用户部门是 GET', async () => {
    server.respond(() => ({ body: { data: [], meta: { count: 0 } } }));
    await listUserDepartments(9, { pageSize: 20 });
    expect(lastRequest(server, 'users/9/departments:list')?.method).toBe('GET');
  });

  it('主部门走真实字段 users.mainDepartmentId 的通用更新（含清空）', async () => {
    await updateUserMainDepartment(9, 3);
    const set = lastRequest(server, 'users:update');
    expect(set?.method).toBe('POST');
    expect(set?.query.filterByTk).toBe('9');
    expect(set?.body).toEqual({ mainDepartmentId: 3 });

    server.reset();
    server.respond(() => ({ body: { data: null } }));
    await updateUserMainDepartment(9, null);
    expect(lastRequest(server, 'users:update')?.body).toEqual({ mainDepartmentId: null });
  });
});

describe('角色 → 部门（roles/<name>/departments）', () => {
  it('add / remove / set 的请求体是部门 id 数组，父标识是角色名', async () => {
    await addRoleDepartments('r_sales', [1]);
    await removeRoleDepartments('r_sales', [1, 2]);
    await setRoleDepartments('r_sales', [2, 3]);

    expect(lastRequest(server, 'roles/r_sales/departments:add')?.body).toEqual([1]);
    expect(lastRequest(server, 'roles/r_sales/departments:remove')?.body).toEqual([1, 2]);
    expect(lastRequest(server, 'roles/r_sales/departments:set')?.body).toEqual([2, 3]);
  });

  it('读取角色部门是 GET', async () => {
    server.respond(() => ({ body: { data: [], meta: { count: 0 } } }));
    await listRoleDepartments('r_sales', { pageSize: 20 });
    expect(lastRequest(server, 'roles/r_sales/departments:list')?.method).toBe('GET');
  });
});

describe('候选列表与能力归因', () => {
  it('候选成员复用真实 users:list，并在本地用 $notIn 排除已关联项', async () => {
    server.respond(() => ({ body: { data: [], meta: { count: 0 } } }));
    await listUsers({ page: 1, pageSize: 10, filter: { id: { $notIn: [101, 102] } } });

    const request = lastRequest(server, 'users:list');
    expect(request?.method).toBe('GET');
    expect(String(request?.query.filter)).toContain('notIn');
    // 不使用参数名缺乏本仓库证据的 users:listExcludeDept。
    expect(request?.path).toBe('users:list');
  });

  it('关联失败要区分"能力未开通 / 已开通但读取失败 / 无法确认"（不把 500 一律当未开通）', () => {
    const base = {
      state: 'ready' as const,
      rows: [],
      meta: {},
      total: null,
      isFetching: false,
      refetch: () => {},
      message: null,
    };
    const failed = (kind: string) =>
      associationAvailability({ ...base, state: 'error', error: { kind } as never }, 'unknown');

    // 列表成功（含空数据）永远是"可用"。
    expect(associationAvailability({ ...base, error: null }, 'disabled')).toBe('available');
    expect(associationAvailability({ ...base, state: 'empty', error: null }, 'enabled')).toBe('available');

    // 500/404：能力探测说 disabled → 未开通；说 enabled → 真实读取失败；探测未回来 → 继续确认；探测失败 → 无法确认。
    expect(associationAvailability({ ...base, state: 'error', error: { kind: 'backend-unavailable' } as never }, 'disabled')).toBe('unavailable');
    expect(associationAvailability({ ...base, state: 'error', error: { kind: 'not-found' } as never }, 'disabled')).toBe('unavailable');
    expect(associationAvailability({ ...base, state: 'error', error: { kind: 'backend-unavailable' } as never }, 'enabled')).toBe('read-error');
    expect(associationAvailability({ ...base, state: 'error', error: { kind: 'backend-unavailable' } as never }, 'loading')).toBe('checking');
    expect(failed('backend-unavailable')).toBe('indeterminate');

    // 权限与身份问题各有独立归因。
    expect(associationAvailability({ ...base, state: 'error', error: { kind: 'forbidden' } as never }, 'enabled')).toBe('denied');
    expect(associationAvailability({ ...base, state: 'error', error: { kind: 'unauthenticated' } as never }, 'enabled')).toBe('error');
    expect(associationAvailability({ ...base, state: 'error', error: { kind: 'network' } as never }, 'enabled')).toBe('error');
    expect(associationAvailability({ ...base, state: 'loading', error: null }, 'enabled')).toBe('checking');
  });

  it('strict 模式下关联写动作在发出前被拦截（0 请求）', async () => {
    setTransportMode('strict');
    await expect(addDepartmentMembers(1, [101])).rejects.toBeTruthy();
    await expect(setRoleDepartments('r_sales', [1])).rejects.toBeTruthy();
    await expect(addUserDepartments(9, [1])).rejects.toBeTruthy();
    expect(server.requests).toHaveLength(0);
  });
});
