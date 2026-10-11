import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harness, renderRegisteredBoard, resetHarness } from './page-harness';

/**
 * AC-01…AC-06 页面读取与状态测试（受控 adapter）。
 *
 * 断言页面确实调用契约里的真实接口路径，并且：
 *  - 空数据 / 无权限 分别呈现，不互相冒充；
 *  - 挂载时不发出任何 POST（不自动写、不外呼）。
 */

/**
 * `users` 集合的字段元数据（受控 adapter）。
 *
 * AC-01 头像宿主按**真实字段是否存在**决定是否渲染上传入口，因此这些用例要么显式提供
 * 含 `avatar` 的字段清单（证明宿主链），要么不提供（证明"能力缺失"是诚实状态）。
 */
const usersCollectionWithAvatar = {
  data: { name: 'users', fields: [{ name: 'id' }, { name: 'nickname' }, { name: 'avatar' }] },
};

const rolesResponse = {
  data: [
    { name: 'admin', title: '管理员', snippets: ['pm', 'pm.*'], default: false, allowConfigure: true, allowNewAiEmployee: true },
    { name: 'member', title: '普通成员', snippets: ['!pm'], default: true, hidden: true, allowConfigure: false, allowNewAiEmployee: true },
  ],
  meta: { count: 2, page: 1, pageSize: 200, totalPage: 1 },
};

beforeEach(() => {
  resetHarness();
});

afterEach(() => {
  resetHarness();
});

describe('AC-01 用户列表与详情', () => {
  it('列表读取 users:list（含 appends=roles/avatar）并展示角色与头像', async () => {
    harness.routes['collections:get'] = { body: usersCollectionWithAvatar };
    harness.routes['users:list'] = {
      body: {
        data: [
          {
            id: 1,
            nickname: '张三',
            username: 'zhangsan',
            email: 'z@example.test',
            roles: [{ name: 'member', title: '普通成员' }],
            avatar: { id: 9, url: '/files/main/main/attachments/9.png' },
          },
          { id: 2, nickname: '李四', username: 'lisi', email: 'l@example.test', roles: [] },
        ],
        meta: { count: 356, page: 1, pageSize: 20, totalPage: 18 },
      },
    };
    harness.routes['roles:list'] = { body: rolesResponse };

    renderRegisteredBoard('access', 'users');
    expect(await screen.findByText('张三')).toBeInTheDocument();
    expect(screen.getByText('李四')).toBeInTheDocument();
    expect(screen.getByText('普通成员')).toBeInTheDocument();
    expect(screen.getByText('共 356 条，第 1 / 18 页')).toBeInTheDocument();

    // 头像字段能力是异步确认的：先按 appends=roles 读，确认存在后自动按 appends=roles/avatar 重读。
    await waitFor(() => {
      expect(
        harness.captured.some(
          (item) => item.path === 'users:list' && (item.params.appends as string[] | undefined)?.includes('avatar'),
        ),
      ).toBe(true);
    });
    const listRequest = [...harness.captured].reverse().find((item) => item.path === 'users:list');
    expect(listRequest?.method).toBe('get');
    expect(listRequest?.params.appends).toEqual(['roles', 'avatar']);
    // 有头像的行渲染真实附件地址；没有头像的行明确显示"未设置"（不是空白）。
    expect(screen.getByAltText('张三的头像')).toHaveAttribute('src', '/files/main/main/attachments/9.png');
    expect(screen.getByText('未设置')).toBeInTheDocument();
    expect(harness.posts()).toHaveLength(0);
  });

  it('空结果是真实空态，不冒充无权限', async () => {
    harness.routes['users:list'] = { body: { data: [], meta: { count: 0, page: 1, pageSize: 20, totalPage: 0 } } };
    harness.routes['roles:list'] = { body: rolesResponse };
    renderRegisteredBoard('access', 'users');
    expect(await screen.findByText('没有找到用户')).toBeInTheDocument();
    expect(screen.queryByText('没有查看权限')).toBeNull();
  });

  it('403 呈现为无权限，而不是空数据', async () => {
    harness.routes['users:list'] = { status: 403, body: { errors: [{ message: 'No permissions' }] } };
    harness.routes['roles:list'] = { body: rolesResponse };
    renderRegisteredBoard('access', 'users');
    expect(await screen.findByText('没有查看权限')).toBeInTheDocument();
    expect(screen.queryByText('没有找到用户')).toBeNull();
  });

  it('详情读取 users:get?appends=roles/avatar，并区分"我的默认角色"与全局默认角色', async () => {
    harness.routes['collections:get'] = { body: usersCollectionWithAvatar };
    harness.routes['users:get'] = {
      body: {
        data: {
          id: 2,
          nickname: '李四',
          username: 'lisi',
          email: 'l@example.test',
          roles: [{ name: 'member', title: '普通成员' }],
        },
      },
    };
    harness.routes['roles:list'] = { body: rolesResponse };
    harness.routes['rolesUsers:list'] = {
      body: { data: [{ roleName: 'member', userId: 2, default: true }], meta: { count: 1 } },
    };

    renderRegisteredBoard('access', 'users/:id', {
      route: '/access/users/2',
      path: '/access/users/:id',
    });

    expect(await screen.findByText('角色分配')).toBeInTheDocument();
    await waitFor(() => {
      expect(
        harness.captured.some(
          (item) => item.path === 'users:get' && (item.params.appends as string[] | undefined)?.includes('avatar'),
        ),
      ).toBe(true);
    });
    const getRequest = [...harness.captured].reverse().find((item) => item.path === 'users:get');
    expect(getRequest?.params.filterByTk).toBe('2');
    expect(getRequest?.params.appends).toEqual(['roles', 'avatar']);
    // PUB-04 头像宿主挂在 AC-01 详情页：真实文件字段 + 真实文件选择入口。
    expect(screen.getByText('头像')).toBeInTheDocument();
    expect(screen.getByLabelText('选择用户头像')).toBeInTheDocument();
    expect(screen.getByText('该用户默认角色')).toBeInTheDocument();
    expect(screen.getByText('全局默认角色')).toBeInTheDocument();
    expect(harness.posts()).toHaveLength(0);
  });
});

describe('AC-02 角色与成员', () => {
  it('角色列表读取 roles:list 并标记全局默认角色', async () => {
    harness.routes['roles:list'] = { body: rolesResponse };
    renderRegisteredBoard('access', 'roles');
    expect(await screen.findByText('管理员')).toBeInTheDocument();
    expect(screen.getByText('全局默认')).toBeInTheDocument();
    expect(harness.posts()).toHaveLength(0);
  });

  it('角色详情按角色名读取成员与候选成员', async () => {
    harness.routes['roles:get'] = { body: { data: { name: 'member', title: '普通成员', snippets: ['!pm'] } } };
    harness.routes['roles/member/users:list'] = {
      body: { data: [{ id: 1, nickname: '张三', email: 'z@example.test' }], meta: { count: 1, page: 1, pageSize: 10, totalPage: 1 } },
    };
    harness.routes['users:listExcludeRole'] = {
      body: { data: [{ id: 2, nickname: '李四', email: 'l@example.test' }], meta: { count: 355, page: 1, pageSize: 10, totalPage: 36 } },
    };
    harness.routes['roles/member/resources:list'] = { body: { data: [], meta: { count: 0 } } };
    harness.routes['roles/member/aiEmployees:list'] = { body: { data: [], meta: { count: 13 } } };
    harness.routes['roles/member/desktopRoutes:list'] = { body: { data: [], meta: { count: 135 } } };

    renderRegisteredBoard('access', 'roles/:name', {
      route: '/access/roles/member',
      path: '/access/roles/:name',
    });

    expect(await screen.findByText('张三')).toBeInTheDocument();
    expect(await screen.findByText('李四')).toBeInTheDocument();

    const membersRequest = harness.captured.find((item) => item.path === 'roles/member/users:list');
    expect(membersRequest?.method).toBe('get');
    const candidatesRequest = harness.captured.find((item) => item.path === 'users:listExcludeRole');
    expect(candidatesRequest?.params.roleName).toBe('member');
    expect(harness.posts()).toHaveLength(0);
  });
});

describe('AC-03 功能与入口授权', () => {
  it('读取真实动作枚举、集合配置与原页面路由授权', async () => {
    harness.routes['roles:list'] = { body: rolesResponse };
    harness.routes['availableActions:list'] = {
      body: { data: [{ name: 'view', displayName: '查看', type: 'old-data' }] },
    };
    harness.routes['desktopRoutes:list'] = {
      body: { data: [{ id: 11, title: '首页', type: 'group', sort: 1 }], meta: { count: 167 } },
    };
    harness.routes['roles/admin/desktopRoutes:list'] = {
      body: { data: [{ id: 11, title: '首页', type: 'group', sort: 1 }], meta: { count: 1 } },
    };
    harness.routes['roles/admin/collections:list'] = {
      body: { data: [{ name: 'customers', title: '客户', usingConfig: 'strategy', exists: false }], meta: { count: 157 } },
    };
    harness.routes['roles/admin/menuUiSchemas:list'] = { body: { data: [], meta: { count: 0 } } };

    renderRegisteredBoard('access', 'features');
    expect(await screen.findByText('功能权限片段')).toBeInTheDocument();
    expect(await screen.findByText('原页面路由授权')).toBeInTheDocument();
    expect(await screen.findByText('客户')).toBeInTheDocument();

    expect(harness.captured.some((item) => item.path === 'roles/admin/desktopRoutes:list')).toBe(true);
    expect(harness.captured.some((item) => item.path === 'roles/admin/collections:list')).toBe(true);
    expect(harness.posts()).toHaveLength(0);
  });
});

describe('AC-04 数据授权', () => {
  it('读取角色资源、动作配置与记录范围', async () => {
    harness.routes['roles:list'] = {
      body: {
        data: [{ name: 'r_sales', title: '销售', snippets: [] }],
        meta: { count: 1, page: 1, pageSize: 200, totalPage: 1 },
      },
    };
    harness.routes['roles/r_sales/resources:list'] = {
      body: { data: [{ id: 9001, dataSourceKey: 'main', roleName: 'r_sales', name: 'customers', usingActionsConfig: true }], meta: { count: 124 } },
    };
    harness.routes['availableActions:list'] = {
      body: { data: [{ name: 'view', displayName: '查看' }, { name: 'update', displayName: '修改' }] },
    };
    harness.routes['dataSourcesRolesResourcesScopes:list'] = {
      body: { data: [{ id: 1, key: 'all', name: '全部记录', resourceName: 'customers', dataSourceKey: 'main' }], meta: { count: 2 } },
    };
    harness.routes['dataSourcesRolesResourcesActions:list'] = {
      body: { data: [{ id: 1, name: 'view', fields: ['name'], rolesResourceId: 9001 }], meta: { count: 1 } },
    };

    renderRegisteredBoard('access', 'data');
    expect(await screen.findByText('选择角色')).toBeInTheDocument();
    expect(await screen.findByText('customers')).toBeInTheDocument();
    expect(harness.posts()).toHaveLength(0);

    // 选中资源后才会按 rolesResourceId 读取该资源的动作配置。
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByText('customers'));
    await waitFor(() => {
      expect(harness.captured.some((item) => item.path === 'dataSourcesRolesResourcesActions:list')).toBe(true);
    });
    expect(await screen.findByText('条件编辑器（记录范围）')).toBeInTheDocument();
    const actionsRequest = harness.captured.find((item) => item.path === 'dataSourcesRolesResourcesActions:list');
    expect(actionsRequest?.params.appends).toEqual(['scope']);
    expect(harness.posts()).toHaveLength(0);
  });
});

describe('AC-05 员工与工具权限', () => {
  it('区分角色授权列表与本人可用列表', async () => {
    harness.routes['roles:list'] = {
      body: { data: [{ name: 'member', title: '普通成员', allowNewAiEmployee: true }], meta: { count: 1, page: 1, pageSize: 200, totalPage: 1 } },
    };
    harness.routes['roles/member/aiEmployees:list'] = {
      body: {
        data: [
          {
            username: 'employee-a',
            nickname: '数字员工 A',
            enabled: true,
            skillSettings: { tools: [{ name: 'tool-1', autoCall: false }, { name: 'tool-2', autoCall: true }] },
          },
        ],
        meta: { count: 13, page: 1, pageSize: 200, totalPage: 1 },
      },
    };
    harness.routes['aiEmployees:list'] = { body: { data: [{ username: 'employee-a', nickname: '数字员工 A' }], meta: { count: 13 } } };
    harness.routes['aiEmployees:listByUser'] = { body: { data: [{ username: 'employee-a', nickname: '数字员工 A' }], meta: { count: 13 } } };

    renderRegisteredBoard('access', 'employees');
    expect((await screen.findAllByText('数字员工 A')).length).toBeGreaterThan(0);
    expect(await screen.findByText('工具确认策略（只读）')).toBeInTheDocument();
    expect(harness.captured.some((item) => item.path === 'aiEmployees:listByUser')).toBe(true);
    expect(harness.posts()).toHaveLength(0);
  });
});

describe('AC-06 部门与组织结构', () => {
  it('读取真实部门树与组织；部门成员/角色接口不可用时按"未开通"呈现（不写死）', async () => {
    harness.routes['departments:list'] = {
      body: {
        data: [
          { id: 1, parentId: null, name: '总部', dept_code: 'HQ', status: 'active', organization_id: 1 },
          { id: 2, parentId: 1, name: '财务部', dept_code: 'FIN', status: 'active', organization_id: 1 },
        ],
        meta: { count: 50, page: 1, pageSize: 200, totalPage: 1 },
      },
    };
    harness.routes['organizations:list'] = {
      body: { data: [{ id: 1, name: '示例组织', org_code: 'ORG-1', status: 'active' }], meta: { count: 1 } },
    };
    // 13000 实测：插件停用时成员/角色关联接口返回服务端错误。
    harness.routes['departments/1/members:list'] = { status: 500, body: { errors: [{ message: 'error' }] } };
    harness.routes['departments/1/roles:list'] = { status: 500, body: { errors: [{ message: 'error' }] } };
    harness.routes['users/1/departments:list'] = { status: 500, body: { errors: [{ message: 'error' }] } };

    renderRegisteredBoard('access', 'departments');
    expect(await screen.findByText('总部')).toBeInTheDocument();
    // 子部门默认折叠：展开后再断言层级内容。
    fireEvent.click(screen.getByLabelText('展开'));
    expect(await screen.findByText('财务部')).toBeInTheDocument();
    expect(await screen.findByText('当前实例未开通部门成员关联')).toBeInTheDocument();
    expect(await screen.findByText('当前实例未开通部门角色关联')).toBeInTheDocument();
    // 未开通时不提供任何关联写入口，也不显示成"空数据"。
    expect(screen.queryByText('加入成员')).toBeNull();
    expect(screen.queryByText('已把所选用户加入该部门。')).toBeNull();
    expect(harness.posts()).toHaveLength(0);
  });

  it('能力已开通但关联读取失败时，给"可重试"而不是"未开通"', async () => {
    harness.routes['departments:list'] = {
      body: {
        data: [{ id: 1, parentId: null, name: '总部', dept_code: 'HQ', status: 'active' }],
        meta: { count: 1, page: 1, pageSize: 200, totalPage: 1 },
      },
    };
    harness.routes['organizations:list'] = { body: { data: [], meta: { count: 0 } } };
    // 能力探测：departments 集合上**有** members/roles 字段（说明插件已启用）。
    harness.routes['collections:get'] = {
      body: { data: { name: 'departments', fields: [{ name: 'id' }, { name: 'members' }, { name: 'roles' }] } },
    };
    // 但这次关联读取真的失败了。
    harness.routes['departments/1/members:list'] = { status: 500, body: { errors: [{ message: 'boom' }] } };
    harness.routes['departments/1/roles:list'] = { status: 500, body: { errors: [{ message: 'boom' }] } };
    harness.routes['users:list'] = { body: { data: [], meta: { count: 0 } } };
    harness.routes['roles:list'] = { body: rolesResponse };

    renderRegisteredBoard('access', 'departments');

    // 关键：不出现"未开通"，而是"已开通但这次读取失败，可重试"。
    // 成员与部门角色两个编辑器都会给出该说明。
    expect((await screen.findAllByText(/该能力在本实例已开通，但这次关联数据读取失败了/)).length).toBe(2);
    expect(screen.queryByText('当前实例未开通部门成员关联')).toBeNull();
    expect(screen.queryByText('当前实例未开通部门角色关联')).toBeNull();
    expect(screen.getByText(/关联能力已开通，但本次读取失败/)).toBeInTheDocument();
    // 重试入口存在（StateView 的错误态自带"重新读取"）。
    expect(screen.getAllByText('重新读取').length).toBeGreaterThan(0);
  });

  it('关联接口可用时渲染真实成员/角色视图，并按精确路径发出关联写请求', async () => {
    harness.routes['departments:list'] = {
      body: {
        data: [{ id: 1, parentId: null, name: '总部', dept_code: 'HQ', status: 'active' }],
        meta: { count: 1, page: 1, pageSize: 200, totalPage: 1 },
      },
    };
    harness.routes['organizations:list'] = { body: { data: [], meta: { count: 0 } } };
    harness.routes['departments/1/members:list'] = {
      body: {
        data: [{ id: 101, nickname: '成员甲', email: 'm@example.test' }],
        meta: { count: 1, page: 1, pageSize: 20, totalPage: 1 },
      },
    };
    harness.routes['departments/1/roles:list'] = {
      body: { data: [{ name: 'r_sales', title: '销售' }], meta: { count: 1, page: 1, pageSize: 50, totalPage: 1 } },
    };
    harness.routes['users:list'] = {
      body: {
        data: [{ id: 102, nickname: '候选人乙', email: 'c@example.test' }],
        meta: { count: 1, page: 1, pageSize: 10, totalPage: 1 },
      },
    };
    harness.routes['roles:list'] = { body: rolesResponse };
    harness.routes['departments/1/members:add'] = { body: { data: 'ok' } };

    renderRegisteredBoard('access', 'departments');

    // 能力已开通：不再显示"未开通"，直接显示真实关联视图。
    expect(await screen.findByText('成员甲')).toBeInTheDocument();
    expect(await screen.findByText('销售')).toBeInTheDocument();
    expect(screen.queryByText('当前实例未开通部门成员关联')).toBeNull();

    // 候选列表来自真实 users:list（排除已关联项的过滤条件在真实 HTTP 链路的
    // department-relations.controlled.test.ts 里断言），不使用缺乏证据的专用动作。
    const candidateList = harness.captured.find((item) => item.path === 'users:list');
    expect(candidateList?.method).toBe('get');
    expect(harness.captured.some((item) => item.path === 'users:listExcludeDept')).toBe(false);

    // 选择候选并加入：请求体是用户 id 裸数组。
    const candidateLabel = screen.getByText('候选人乙').closest('label');
    expect(candidateLabel).not.toBeNull();
    fireEvent.click(candidateLabel?.querySelector('input') as HTMLInputElement);
    fireEvent.click(screen.getByRole('button', { name: '加入成员（已选 1）' }));

    await waitFor(() => {
      expect(harness.posts().length).toBeGreaterThan(0);
    });
    const add = harness.posts().find((item) => item.path === 'departments/1/members:add');
    expect(add?.method).toBe('post');
    expect(add?.data).toEqual([102]);
  });
});
