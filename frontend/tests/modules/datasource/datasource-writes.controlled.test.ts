// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetAuthContext, setApiBase, setAuthContext, setTransportMode } from '../../../src/api/client';
import {
  aggregateCollectionRecords,
  createCollection,
  createCollectionField,
  createCollectionRecord,
  destroyCollection,
  destroyCollectionField,
  destroyCollectionRecord,
  loadTables,
  readTables,
  refreshMainDataSource,
  syncMainDataSourceFields,
  testConnection,
  updateCollectionField,
  updateCollectionRecord,
} from '../../../src/modules/datasource/operations';
import { lastRequest, startControlledServer, type ControlledServer } from '../access/controlled-server';

/**
 * DS 受控写验证（本机真实 HTTP 服务 + SDK 请求管线）。
 *
 * 覆盖：集合/字段增改删、记录增改删（含 X-Data-Source）、聚合查询、
 * 以及 `readTables` / `loadTables` / `testConnection` / `syncFields` / `refresh`
 * **只在产品模式由用户触发时才发出**，严格模式下一律在发出前被拦截（0 个真实请求）。
 *
 * 不连接 13000，不写任何真实数据。
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
  setTransportMode('product');
  resetAuthContext();
  setApiBase('/api');
});

describe('集合与字段写入载荷', () => {
  it('字段创建：父资源斜杠形式 collections/<name>/fields:create', async () => {
    server.respond(() => ({ body: { data: { name: 'new_field' } } }));
    await createCollectionField('customers', {
      name: 'new_field',
      type: 'string',
      interface: 'input',
      description: '受控字段',
      validation: { required: false, unique: false },
    });

    const request = lastRequest(server, 'collections/customers/fields:create');
    expect(request?.method).toBe('POST');
    expect(request?.body).toEqual({
      name: 'new_field',
      type: 'string',
      interface: 'input',
      description: '受控字段',
      validation: { required: false, unique: false },
    });
    expect(request?.dataSourceHeader).toBe('main');
  });

  it('字段更新与删除使用 filterByTk=字段名', async () => {
    server.respond(() => ({ body: { data: {} } }));
    await updateCollectionField('customers', 'name', { description: '改名说明' });
    const update = lastRequest(server, 'collections/customers/fields:update');
    expect(update?.method).toBe('POST');
    expect(update?.query.filterByTk).toBe('name');
    expect(update?.body).toEqual({ description: '改名说明' });

    await destroyCollectionField('customers', 'name');
    const destroy = lastRequest(server, 'collections/customers/fields:destroy');
    expect(destroy?.method).toBe('POST');
    expect(destroy?.query.filterByTk).toBe('name');
  });

  it('集合创建/删除使用集合主键 filterByTk', async () => {
    server.respond(() => ({ body: { data: {} } }));
    await createCollection({ name: 'crewloom_controlled', title: '受控集合', autoGenId: true });
    const create = lastRequest(server, 'collections:create');
    expect(create?.method).toBe('POST');
    expect(create?.body).toEqual({ name: 'crewloom_controlled', title: '受控集合', autoGenId: true });

    await destroyCollection('crewloom_controlled');
    const destroy = lastRequest(server, 'collections:destroy');
    expect(destroy?.method).toBe('POST');
    expect(destroy?.query.filterByTk).toBe('crewloom_controlled');
  });
});

describe('业务集合记录写入载荷', () => {
  it('新增/更新/删除记录走 <collection>:create|update|destroy，并带数据源上下文', async () => {
    server.respond(() => ({ body: { data: { id: 301 } } }));
    await createCollectionRecord('customers', { name: '受控客户', status: 'active' });
    const create = lastRequest(server, 'customers:create');
    expect(create?.method).toBe('POST');
    expect(create?.body).toEqual({ name: '受控客户', status: 'active' });
    expect(create?.dataSourceHeader).toBe('main');

    await updateCollectionRecord('customers', 301, { status: 'inactive' });
    const update = lastRequest(server, 'customers:update');
    expect(update?.query.filterByTk).toBe('301');
    // 只提交改动字段，未改动/未知字段不会被覆盖
    expect(update?.body).toEqual({ status: 'inactive' });

    await destroyCollectionRecord('customers', 301);
    const destroy = lastRequest(server, 'customers:destroy');
    expect(destroy?.method).toBe('POST');
    expect(destroy?.query.filterByTk).toBe('301');
  });

  it('聚合查询走 <collection>:query，载荷含 measures/dimensions/filter', async () => {
    server.respond(() => ({ body: { data: [{ status: 'active', count: 4 }] } }));
    await aggregateCollectionRecords('customers', {
      measures: [{ field: undefined, aggregation: 'count' }],
      dimensions: ['status'],
      filter: { status: 'active' },
    });
    const request = lastRequest(server, 'customers:query');
    expect(request?.method).toBe('POST');
    expect(request?.body).toEqual({
      measures: [{ aggregation: 'count' }],
      dimensions: ['status'],
      filter: { status: 'active' },
    });
  });
});

describe('外部/写语义动作只在产品模式由用户触发', () => {
  it('产品模式：readTables / loadTables / testConnection / syncFields / refresh 能到达受控服务', async () => {
    server.respond(() => ({ body: { data: [] } }));

    await readTables({ dataSourceKey: 'main' });
    expect(lastRequest(server, 'dataSources:readTables')?.body).toEqual({ dataSourceKey: 'main' });

    await loadTables({ dataSourceKey: 'main', tables: ['t1', 't2'] });
    expect(lastRequest(server, 'dataSources:loadTables')?.body).toEqual({
      dataSourceKey: 'main',
      tables: ['t1', 't2'],
    });

    await testConnection({ dataSourceKey: 'main' });
    expect(lastRequest(server, 'dataSources:testConnection')).toBeTruthy();

    await syncMainDataSourceFields('customers');
    const syncRequest = lastRequest(server, 'mainDataSource:syncFields');
    expect(syncRequest?.method).toBe('POST');
    // 详情页动作只同步当前集合：请求体必须显式带 `collections`（真实 2.2.20 里缺省 = 全部集合）。
    expect(syncRequest?.body).toEqual({ collections: ['customers'] });

    await refreshMainDataSource();
    expect(lastRequest(server, 'mainDataSource:refresh')?.method).toBe('POST');
  });

  it('反向同步缺少当前集合名时直接拒绝，不发任何请求（不把"未知"当成全库）', () => {
    server.respond(() => ({ body: { data: null } }));
    expect(() => syncMainDataSourceFields('')).toThrow(/不会改为同步全部集合/);
    expect(() => syncMainDataSourceFields('   ')).toThrow(/不会改为同步全部集合/);
    expect(server.requests.filter((item) => item.path === 'mainDataSource:syncFields')).toHaveLength(0);
  });

  it('严格模式：这些动作在发出前被拦截，受控服务一个请求都收不到', async () => {
    setTransportMode('strict');

    await expect(readTables({ dataSourceKey: 'main' })).rejects.toBeTruthy();
    await expect(loadTables({ dataSourceKey: 'main', tables: ['t1'] })).rejects.toBeTruthy();
    await expect(testConnection({ dataSourceKey: 'main' })).rejects.toBeTruthy();
    await expect(syncMainDataSourceFields('customers')).rejects.toBeTruthy();
    await expect(refreshMainDataSource()).rejects.toBeTruthy();
    await expect(createCollectionRecord('customers', { name: 'x' })).rejects.toBeTruthy();
    await expect(updateCollectionRecord('customers', 1, { name: 'x' })).rejects.toBeTruthy();
    await expect(destroyCollectionRecord('customers', 1)).rejects.toBeTruthy();
    await expect(aggregateCollectionRecords('customers', { measures: [{ aggregation: 'count' }] })).rejects.toBeTruthy();

    expect(server.requests).toHaveLength(0);
  });
});
