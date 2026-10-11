import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harness, renderRegisteredBoard, resetHarness } from '../access/page-harness';
import { resolveRouteTarget } from '../../../src/permissions/modules';

/**
 * DS-01…DS-05 页面读取与状态测试（受控 adapter）。
 *
 * 重点：
 *  - 断言页面确实读取真实契约路径（dataSources / collections / fields / 业务集合记录）；
 *  - 断言挂载期间**没有 POST**：`readTables` / `loadTables` / `testConnection` /
 *    `syncFields` / `refresh` 与记录写入都只能由用户点击触发，不允许自动外呼；
 *  - 空数据与能力未开通分别呈现。
 */

beforeEach(() => {
  resetHarness();
});

afterEach(() => {
  resetHarness();
});

const FORBIDDEN_AUTOMATIC_ACTIONS = [
  'dataSources:readTables',
  'dataSources:loadTables',
  'dataSources:testConnection',
  'mainDataSource:syncFields',
  'mainDataSource:refresh',
];

function expectNoAutomaticExternalActions(): void {
  for (const path of FORBIDDEN_AUTOMATIC_ACTIONS) {
    expect(harness.captured.some((item) => item.path === path)).toBe(false);
  }
  expect(harness.posts()).toHaveLength(0);
}

describe('DS-01 数据源列表', () => {
  it('展示主数据源真实状态，并把 listEnabled 为空与外部连接未开通分开表达', async () => {
    harness.routes['dataSources:list'] = {
      body: {
        data: [
          {
            key: 'main',
            displayName: '主数据库',
            type: 'main',
            enabled: true,
            fixed: true,
            status: 'loaded',
          },
        ],
        meta: { count: 1, page: 1, pageSize: 50, totalPage: 1 },
      },
    };
    harness.routes['dataSources:listEnabled'] = { body: { data: [] } };

    renderRegisteredBoard('datasource', 'list');
    expect(await screen.findByText('主数据库')).toBeInTheDocument();
    expect(await screen.findByText('当前没有启用的外部数据源')).toBeInTheDocument();
    expect(await screen.findByText('外部数据库连接未开通')).toBeInTheDocument();
    expectNoAutomaticExternalActions();
  });

  it('无权限时按 403 呈现，不显示为能力未开通', async () => {
    harness.routes['dataSources:list'] = { status: 403, body: { errors: [{ message: 'No permissions' }] } };
    harness.routes['dataSources:listEnabled'] = { status: 403, body: { errors: [{ message: 'No permissions' }] } };
    renderRegisteredBoard('datasource', 'list');
    expect((await screen.findAllByText('没有查看权限')).length).toBeGreaterThan(0);
    expect(screen.queryByText('外部数据库连接未开通')).toBeNull();
  });
});

describe('DS-02 数据源详情', () => {
  it('主数据源走内建说明，不伪造外部连接表单', async () => {
    harness.routes['dataSources:get'] = {
      body: { data: { key: 'main', displayName: '主数据库', type: 'main', isDBInstance: true } },
    };
    harness.routes['dataSources:list'] = {
      body: { data: [{ key: 'main', displayName: '主数据库', type: 'main', enabled: true, status: 'loaded' }], meta: { count: 1 } },
    };
    harness.routes['collections:list'] = {
      body: { data: [{ name: 'customers', title: '客户' }], meta: { count: 157, page: 1, pageSize: 1, totalPage: 157 } },
    };

    renderRegisteredBoard('datasource', 'list/:key', { route: '/datasource/list/main', path: '/datasource/list/:key' });
    expect(await screen.findByText('主数据源（内建固定）')).toBeInTheDocument();
    expect(await screen.findByText('主数据源说明')).toBeInTheDocument();
    expect(screen.queryByText('保存连接配置')).toBeNull();
    expectNoAutomaticExternalActions();
  });
});

describe('DS-03 数据表与字段', () => {
  it('集合清单来自 collections:list（真实 schema），不显示插件集合', async () => {
    harness.routes['collections:list'] = {
      body: {
        data: [
          { name: 'customers', title: '客户', hidden: false, autoGenId: true, titleField: 'name' },
          { name: 'items', title: '物料', hidden: false, autoGenId: true, titleField: 'name' },
        ],
        meta: { count: 157, page: 1, pageSize: 300, totalPage: 1 },
      },
    };
    renderRegisteredBoard('datasource', 'tables');
    expect(await screen.findByText('客户')).toBeInTheDocument();
    expect(screen.getByText('物料')).toBeInTheDocument();
    expect(screen.getByText('共 157 个业务集合')).toBeInTheDocument();
    expectNoAutomaticExternalActions();
  });

  it('集合详情字段来自 collections/<name>/fields:list，并从真实 type/interface 呈现', async () => {
    harness.routes['collections:get'] = {
      body: { data: { name: 'customers', title: '客户', autoGenId: true, titleField: 'name' } },
    };
    harness.routes['collections/customers/fields:list'] = {
      body: {
        data: [
          { name: 'id', type: 'bigInt', interface: 'integer' },
          { name: 'name', type: 'string', interface: 'input', description: '客户名称' },
          { name: 'status', type: 'string', interface: 'select' },
        ],
        meta: { count: 25, page: 1, pageSize: 300, totalPage: 1 },
      },
    };

    renderRegisteredBoard('datasource', 'tables/:collectionName', {
      route: '/datasource/tables/customers',
      path: '/datasource/tables/:collectionName',
    });

    expect(await screen.findByText('客户名称')).toBeInTheDocument();
    expect(screen.getByText('id')).toBeInTheDocument();
    expect(screen.getByText('新增字段')).toBeInTheDocument();
    // 反向同步/表加载必须由用户确认后触发。
    expect(screen.getByText('反向同步字段')).toBeInTheDocument();
    expectNoAutomaticExternalActions();
  });

  it('点「反向同步字段」只提交当前集合的 collections，不再发空载荷（Main 5352 实测缺陷回归）', async () => {
    harness.routes['collections:get'] = {
      body: { data: { name: 'customers', title: '客户', autoGenId: true, titleField: 'name' } },
    };
    harness.routes['collections/customers/fields:list'] = {
      body: { data: [{ name: 'id', type: 'bigInt', interface: 'integer' }], meta: { count: 1 } },
    };
    harness.routes['mainDataSource:syncFields'] = { body: { data: null } };

    renderRegisteredBoard('datasource', 'tables/:collectionName', {
      route: '/datasource/tables/customers',
      path: '/datasource/tables/:collectionName',
    });

    await screen.findByText('反向同步字段');
    fireEvent.click(screen.getByText('反向同步字段'));
    fireEvent.click(await screen.findByText('确认同步'));

    await waitFor(() => {
      expect(harness.posts().some((item) => item.path === 'mainDataSource:syncFields')).toBe(true);
    });
    // 真实 2.2.20：`values.collections` 缺省 = 全部集合；详情页动作必须显式限定当前集合。
    const syncRequest = harness.posts().find((item) => item.path === 'mainDataSource:syncFields');
    expect(syncRequest?.data).toEqual({ collections: ['customers'] });
  });

  it('删除集合成功后不保留失效的可写详情（Main 52 实测缺陷回归）', async () => {
    harness.routes['collections:get'] = {
      body: { data: { name: 'qa_samples', title: '质量样本', autoGenId: true } },
    };
    harness.routes['collections/qa_samples/fields:list'] = {
      body: { data: [{ name: 'id', type: 'bigInt', interface: 'integer' }], meta: { count: 1 } },
    };
    harness.routes['collections:destroy'] = { body: { data: {} } };

    renderRegisteredBoard('datasource', 'tables/:collectionName', {
      route: '/datasource/tables/qa_samples',
      path: '/datasource/tables/:collectionName',
    });

    expect(await screen.findByText('新增字段')).toBeInTheDocument();
    fireEvent.click(screen.getByText('删除该集合'));
    fireEvent.click(await screen.findByText('确认删除'));

    // 真成功删除（非 404）后：旧详情不得继续可写。
    await waitFor(() => expect(screen.queryByText('新增字段')).not.toBeInTheDocument());
    expect(screen.queryByText('删除该集合')).not.toBeInTheDocument();
    expect(harness.posts().some((item) => item.path === 'collections:destroy')).toBe(true);
  });

  it('删除失败时保留原内容与错误提示（不误清详情）', async () => {
    harness.routes['collections:get'] = {
      body: { data: { name: 'qa_samples', title: '质量样本', autoGenId: true } },
    };
    harness.routes['collections/qa_samples/fields:list'] = {
      body: { data: [{ name: 'id', type: 'bigInt', interface: 'integer' }], meta: { count: 1 } },
    };
    harness.routes['collections:destroy'] = { status: 500, body: { errors: [{ message: '删除失败' }] } };

    renderRegisteredBoard('datasource', 'tables/:collectionName', {
      route: '/datasource/tables/qa_samples',
      path: '/datasource/tables/:collectionName',
    });

    expect(await screen.findByText('新增字段')).toBeInTheDocument();
    fireEvent.click(screen.getByText('删除该集合'));
    fireEvent.click(await screen.findByText('确认删除'));

    // 失败：内容仍在，用户可重试。
    await waitFor(() => expect(harness.posts().some((item) => item.path === 'collections:destroy')).toBe(true));
    expect(screen.getByText('新增字段')).toBeInTheDocument();
  });
});

describe('DS-04 数据预览与操作', () => {
  it('记录列表读取 <collection>:list，筛选/排序不自动触发外呼动作', async () => {
    harness.routes['collections:list'] = {
      body: { data: [{ name: 'customers', title: '客户' }], meta: { count: 157 } },
    };
    harness.routes['collections/customers/fields:list'] = {
      body: {
        data: [
          { name: 'id', type: 'bigInt', interface: 'integer' },
          { name: 'name', type: 'string', interface: 'input' },
          { name: 'status', type: 'string', interface: 'select' },
        ],
        meta: { count: 3 },
      },
    };
    harness.routes['customers:list'] = {
      body: {
        data: [
          { id: 1, name: '客户甲', status: 'active' },
          { id: 2, name: '客户乙', status: 'inactive' },
        ],
        meta: { count: 4, page: 1, pageSize: 10, totalPage: 1 },
      },
    };

    renderRegisteredBoard('datasource', 'preview/:collectionName', {
      route: '/datasource/preview/customers',
      path: '/datasource/preview/:collectionName',
    });

    expect(await screen.findByText('客户甲')).toBeInTheDocument();
    expect(screen.getByText('客户乙')).toBeInTheDocument();
    expect(screen.getByText('聚合查询')).toBeInTheDocument();

    const listRequest = harness.captured.find((item) => item.path === 'customers:list');
    expect(listRequest?.method).toBe('get');
    expect(listRequest?.params.pageSize).toBe(10);
    expectNoAutomaticExternalActions();
  });

  it('记录为空是真实空态；403 是无权限；两者不混同', async () => {
    harness.routes['collections/customers/fields:list'] = { body: { data: [{ name: 'id', type: 'bigInt' }], meta: { count: 1 } } };
    harness.routes['customers:list'] = { body: { data: [], meta: { count: 0, page: 1, pageSize: 10, totalPage: 0 } } };
    renderRegisteredBoard('datasource', 'preview/:collectionName', {
      route: '/datasource/preview/customers',
      path: '/datasource/preview/:collectionName',
    });
    expect(await screen.findByText('这个集合当前没有记录')).toBeInTheDocument();
    expect(screen.queryByText('没有查看权限')).toBeNull();
  });

  it('聚合按钮只在点击后才发出 <collection>:query', async () => {
    harness.routes['collections/customers/fields:list'] = {
      body: { data: [{ name: 'status', type: 'string' }, { name: 'amount', type: 'double' }], meta: { count: 2 } },
    };
    harness.routes['customers:list'] = { body: { data: [], meta: { count: 0 } } };
    harness.routes['customers:query'] = { body: { data: [{ status: 'active', count: 4 }] } };

    renderRegisteredBoard('datasource', 'preview/:collectionName', {
      route: '/datasource/preview/customers',
      path: '/datasource/preview/:collectionName',
    });
    await screen.findByText('聚合查询');
    expect(harness.captured.some((item) => item.path === 'customers:query')).toBe(false);

    fireEvent.click(screen.getByText('执行聚合'));
    await waitFor(() => {
      expect(harness.captured.some((item) => item.path === 'customers:query')).toBe(true);
    });
    expect(await screen.findByText('active')).toBeInTheDocument();
  });
});

describe('DS-05 访问配置入口', () => {
  it('按角色读取资源授权规模并指向统一数据授权页', async () => {
    harness.routes['roles:list'] = {
      body: { data: [{ name: 'r_sales', title: '销售' }], meta: { count: 16 } },
    };
    harness.routes['roles/r_sales/resources:list'] = {
      body: {
        data: [{ id: 1, dataSourceKey: 'main', roleName: 'r_sales', name: 'customers', usingActionsConfig: true }],
        meta: { count: 124 },
      },
    };
    harness.routes['dataSourcesRolesResourcesScopes:list'] = { body: { data: [], meta: { count: 2 } } };
    harness.routes['dataSourcesRolesResourcesActions:list'] = { body: { data: [], meta: { count: 3109 } } };

    renderRegisteredBoard('datasource', 'access');
    expect(await screen.findByText('customers')).toBeInTheDocument();
    expect(screen.getByText('资源授权 124')).toBeInTheDocument();

    // DS-05 → AC-04 的入口是**注册表里真实存在**的页面（不是硬编码死链）：
    // 渲染成链接，href 指向 /access/data 并带上当前选中的角色，且能被 resolveRouteTarget 解析到具体页面。
    const maintenance = screen.getByText('前往数据授权维护');
    expect(maintenance.closest('a')?.getAttribute('href')).toBe('/access/data?role=r_sales');
    expect(resolveRouteTarget('/access/data?role=r_sales')?.board).toBeTruthy();
    expect(resolveRouteTarget('/access/data?role=r_sales')?.module.id).toBe('access');

    expectNoAutomaticExternalActions();
  });
});
