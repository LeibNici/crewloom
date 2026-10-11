// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetAuthContext, setApiBase, setAuthContext, setTransportMode } from '../../../src/api/client';
import {
  addRoleAiEmployees,
  addRoleDesktopRoutes,
  addRoleMembers,
  applyDataPermissions,
  changeMyPassword,
  createDepartment,
  createRole,
  createRoleResourceScope,
  removeRoleMembers,
  setSystemRoleMode,
  setMyDefaultRole,
  updateDepartment,
  updateRole,
  updateRoleResource,
  destroyDepartment,
  updateUser,
  updateUserRoles,
  createUser,
} from '../../../src/modules/access/operations';
import { lastRequest, startControlledServer, type ControlledServer } from './controlled-server';

/**
 * 组 B 受控写验证（本机真实 HTTP 服务 + SDK 请求管线）。
 *
 * 覆盖：用户/角色/成员/入口授权/数据授权/部门维护的**精确路径、方法、查询串与请求体**，
 * 以及"只提交改动字段（保留未知字段）"和"旧角色的 401 不覆盖新角色上下文"。
 *
 * 边界：不连接 13000，不写任何真实数据；服务只绑定 127.0.0.1 随机端口。
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
});

afterEach(() => {
  resetAuthContext();
  setApiBase('/api');
});

describe('用户与角色写入载荷', () => {
  it('新建用户：角色按引用语义（角色名数组）随用户一次提交', async () => {
    server.respond(() => ({ body: { data: { id: 901 } } }));
    await createUser({ nickname: '受控用户', email: 'u@example.test', roles: ['member', 'r_sales'] });

    const request = lastRequest(server, 'users:create');
    expect(request?.method).toBe('POST');
    expect(request?.body).toEqual({
      nickname: '受控用户',
      email: 'u@example.test',
      roles: ['member', 'r_sales'],
    });
    // 引用语义不需要 updateAssociationValues
    expect(request?.query.updateAssociationValues).toBeUndefined();
  });

  it('更新用户角色：单次 users:update，filterByTk 走查询串，不拆成多次关联请求', async () => {
    server.respond(() => ({ body: { data: { id: 7 } } }));
    await updateUserRoles(7, ['member', 'r_finance']);

    const request = lastRequest(server, 'users:update');
    expect(request?.method).toBe('POST');
    expect(request?.query.filterByTk).toBe('7');
    expect(request?.body).toEqual({ roles: ['member', 'r_finance'] });
    expect(request?.query.updateAssociationValues).toBeUndefined();
    expect(server.requests).toHaveLength(1);
  });

  it('更新用户只提交改动字段，未修改的未知字段不会被覆盖', async () => {
    server.respond(() => ({ body: { data: { id: 7 } } }));
    await updateUser(7, { nickname: '只改昵称' });

    const request = lastRequest(server, 'users:update');
    expect(request?.body).toEqual({ nickname: '只改昵称' });
    expect((request?.body as Record<string, unknown>).phone).toBeUndefined();
    expect((request?.body as Record<string, unknown>).roles).toBeUndefined();
  });

  it('用户默认角色走 users:setDefaultRole，载荷 {roleName}', async () => {
    server.respond(() => ({ body: { data: 'ok' } }));
    await setMyDefaultRole('r_sales');
    const request = lastRequest(server, 'users:setDefaultRole');
    expect(request?.method).toBe('POST');
    expect(request?.body).toEqual({ roleName: 'r_sales' });
  });

  it('本人改密走 auth:changePassword，载荷三项', async () => {
    server.respond(() => ({ body: { data: null } }));
    await changeMyPassword({ oldPassword: 'o', newPassword: 'n', confirmPassword: 'n' });
    const request = lastRequest(server, 'auth:changePassword');
    expect(request?.method).toBe('POST');
    expect(request?.body).toEqual({ oldPassword: 'o', newPassword: 'n', confirmPassword: 'n' });
  });
});

describe('角色与成员写入载荷', () => {
  it('角色创建/更新使用角色字段；主键 name 走 filterByTk', async () => {
    server.respond(() => ({ body: { data: { name: 'r_new' } } }));
    await createRole({ name: 'r_new', title: '新角色', snippets: ['pm.acl.roles'] });
    expect(lastRequest(server, 'roles:create')?.body).toEqual({
      name: 'r_new',
      title: '新角色',
      snippets: ['pm.acl.roles'],
    });

    await updateRole('r_new', { allowNewAiEmployee: false });
    const update = lastRequest(server, 'roles:update');
    expect(update?.query.filterByTk).toBe('r_new');
    expect(update?.body).toEqual({ allowNewAiEmployee: false });
  });

  it('多角色模式走 roles:setSystemRoleMode，载荷 {roleMode}', async () => {
    server.respond(() => ({ body: { data: null } }));
    await setSystemRoleMode('allow-use-union');
    const request = lastRequest(server, 'roles:setSystemRoleMode');
    expect(request?.method).toBe('POST');
    expect(request?.body).toEqual({ roleMode: 'allow-use-union' });
  });

  it('角色成员增删：父标识=角色名，请求体是用户 id 裸数组', async () => {
    server.respond(() => ({ body: { data: null } }));
    await addRoleMembers('r_sales', [11, 12]);
    await removeRoleMembers('r_sales', [13]);

    const add = lastRequest(server, 'roles/r_sales/users:add');
    expect(add?.method).toBe('POST');
    expect(add?.body).toEqual([11, 12]);
    expect(add?.rawBody).toBe('[11,12]');

    const remove = lastRequest(server, 'roles/r_sales/users:remove');
    expect(remove?.method).toBe('POST');
    expect(remove?.body).toEqual([13]);
  });

  it('入口授权：desktopRoutes 关联 add/remove 提交 id 数组', async () => {
    server.respond(() => ({ body: { data: null } }));
    await addRoleDesktopRoutes('member', [101, 102]);
    const request = lastRequest(server, 'roles/member/desktopRoutes:add');
    expect(request?.method).toBe('POST');
    expect(request?.body).toEqual([101, 102]);
  });

  it('员工授权：roles/<role>/aiEmployees 提交 username 数组', async () => {
    server.respond(() => ({ body: { data: null } }));
    await addRoleAiEmployees('member', ['employee-a', 'employee-b']);
    const request = lastRequest(server, 'roles/member/aiEmployees:add');
    expect(request?.method).toBe('POST');
    expect(request?.body).toEqual(['employee-a', 'employee-b']);
  });

  it('数据授权批量保存：roles:applyDataPermissions + 事务载荷（动作/字段/范围）', async () => {
    server.respond(() => ({ body: { data: { count: 1 } } }));
    await applyDataPermissions('r_sales', {
      dataSourceKey: 'main',
      resources: [
        {
          name: 'customers',
          usingActionsConfig: true,
          actions: [
            { name: 'view', fields: ['name', 'status'] },
            { name: 'update', fields: ['status'], scopeId: 2 },
          ],
        },
      ],
    });

    const request = lastRequest(server, 'roles:applyDataPermissions');
    expect(request?.method).toBe('POST');
    expect(request?.query.filterByTk).toBe('r_sales');
    expect(request?.body).toEqual({
      dataSourceKey: 'main',
      resources: [
        {
          name: 'customers',
          usingActionsConfig: true,
          actions: [
            { name: 'view', fields: ['name', 'status'] },
            { name: 'update', fields: ['status'], scopeId: 2 },
          ],
        },
      ],
    });
  });

  it('单资源授权：roles/<role>/resources:update，filterByTk=资源名', async () => {
    server.respond(() => ({ body: { data: null } }));
    await updateRoleResource('r_sales', 'customers', {
      name: 'customers',
      usingActionsConfig: true,
      actions: [{ name: 'view', fields: ['name'] }],
    });
    const request = lastRequest(server, 'roles/r_sales/resources:update');
    expect(request?.method).toBe('POST');
    expect(request?.query.filterByTk).toBe('customers');
    expect(request?.body).toEqual({
      name: 'customers',
      usingActionsConfig: true,
      actions: [{ name: 'view', fields: ['name'] }],
    });
  });

  it('自定义记录范围：dataSourcesRolesResourcesScopes:create 提交原生过滤对象', async () => {
    server.respond(() => ({ body: { data: { id: 9 } } }));
    await createRoleResourceScope({
      key: 'customers_only_mine',
      name: '仅本人创建',
      dataSourceKey: 'main',
      resourceName: 'customers',
      scope: { createdById: '{{ ctx.state.currentUser.id }}' },
    });
    const request = lastRequest(server, 'dataSourcesRolesResourcesScopes:create');
    expect(request?.method).toBe('POST');
    expect(request?.body).toEqual({
      key: 'customers_only_mine',
      name: '仅本人创建',
      dataSourceKey: 'main',
      resourceName: 'customers',
      scope: { createdById: '{{ ctx.state.currentUser.id }}' },
    });
  });
});

describe('部门写入载荷（按真实自定义字段）', () => {
  it('新建/更新/删除部门使用 name / dept_code / organization_id / parentId', async () => {
    server.respond(() => ({ body: { data: { id: 51 } } }));
    await createDepartment({
      name: '新部门',
      dept_code: 'D-51',
      parentId: 12,
      organization_id: 1,
      status: 'active',
      notes: '受控',
    });
    const create = lastRequest(server, 'departments:create');
    expect(create?.method).toBe('POST');
    expect(create?.body).toEqual({
      name: '新部门',
      dept_code: 'D-51',
      parentId: 12,
      organization_id: 1,
      status: 'active',
      notes: '受控',
    });

    await updateDepartment(51, { name: '改名部门' });
    const update = lastRequest(server, 'departments:update');
    expect(update?.query.filterByTk).toBe('51');
    expect(update?.body).toEqual({ name: '改名部门' });

    await destroyDepartment(51);
    const destroy = lastRequest(server, 'departments:destroy');
    expect(destroy?.method).toBe('POST');
    expect(destroy?.query.filterByTk).toBe('51');
  });
});

describe('请求上下文', () => {
  it('所有写入都带 X-Data-Source: main（数据源上下文由本项目请求层补齐）', async () => {
    server.respond(() => ({ body: { data: null } }));
    await updateUser(7, { nickname: 'x' });
    const request = lastRequest(server, 'users:update');
    expect(request?.dataSourceHeader).toBe('main');
  });
});

