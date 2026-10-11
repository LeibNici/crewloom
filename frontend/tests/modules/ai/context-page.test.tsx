import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AxiosRequestConfig, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { getHttpClient, setAuthContext, setTransportMode } from '../../../src/api/client';
import { useSessionStore } from '../../../src/auth/store';
import { ContextPage } from '../../../src/modules/ai/pages/ContextPage';
import { __resetForTests, getSelections, getProposals } from '../../../src/modules/ai/context/store';

/**
 * AI-04 四类上下文工作区的页面级行为（jsdom + 受控 adapter）。
 *
 * 这里证明的是**产品界面真的把选择写进了会话上下文模型**（store → payload），
 * 以及预览请求真的按 POST + values 的形状发出、工具确认真的能应用/拒绝。
 * 原生 ChatBox 的浏览器核对在本机 Chrome（`browser-context-tools.mjs`）里做，
 * 不拿这里的 jsdom 结果冒充"原生组件已运行"。
 */

const requests: AxiosRequestConfig[] = [];

function body(config: AxiosRequestConfig): Record<string, unknown> {
  if (typeof config.data === 'string') {
    try {
      return JSON.parse(config.data) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return (config.data ?? {}) as Record<string, unknown>;
}

function respond(config: InternalAxiosRequestConfig, data: unknown, meta?: unknown) {
  return {
    data: meta === undefined ? { data } : { data, meta },
    status: 200,
    statusText: '200',
    headers: {},
    config,
  };
}

const DATASOURCE_ROW = {
  id: 'ctx-1',
  title: '本月订单',
  description: '只看本月',
  datasource: 'main',
  collectionName: 'orders',
  fields: ['id', 'amount'],
  filter: { logic: '$and', items: [{ path: 'status', operator: '$eq', value: 'open' }] },
  sort: ['-id'],
  limit: 20,
  enabled: true,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
};

const ORDERS = [
  { id: 1, amount: 120, status: 'open' },
  { id: 2, amount: 80, status: 'paid' },
];

const SCHEMA = {
  name: 'orders',
  title: '订单',
  primaryKey: 'id',
  fields: [
    { name: 'id', type: 'bigInt', primaryKey: true },
    { name: 'amount', type: 'double' },
    { name: 'status', type: 'string' },
  ],
};

function installAdapter() {
  getHttpClient().defaults.adapter = async (config) => {
    requests.push(config);
    const url = String(config.url ?? '');
    if (url.includes('dataSources:list')) return respond(config, [{ key: 'main' }]);
    if (url.includes('collections:list')) return respond(config, [{ name: 'orders', title: '订单' }]);
    if (url.includes('collections:get')) return respond(config, SCHEMA);
    if (url.includes('orders:list')) return respond(config, ORDERS, { count: ORDERS.length });
    if (url.includes('aiContextDatasources:preview')) {
      // 固定 2.2.20 契约：{ options, total, records }，records 是单元格行 {name,type,value}。
      return respond(config, {
        options: { limit: 10 },
        total: 2,
        records: [
          [
            { name: 'id', type: 'bigInt', value: 1 },
            { name: 'amount', type: 'double', value: 120 },
          ],
          [
            { name: 'id', type: 'bigInt', value: 2 },
            { name: 'amount', type: 'double', value: 80 },
          ],
        ],
      });
    }
    if (url.includes('aiContextDatasources:list')) return respond(config, [DATASOURCE_ROW], { count: 1 });
    if (url.includes('aiContextDatasources:get')) return respond(config, DATASOURCE_ROW);
    if (url.includes('aiContextDatasources:')) return respond(config, DATASOURCE_ROW);
    return respond(config, []);
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ContextPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  __resetForTests();
  requests.length = 0;
  setTransportMode('product');
  setAuthContext({ token: 'controlled-token', role: 'admin', authenticator: 'basic' });
  useSessionStore.setState({ access: { allowAll: true, snippets: [], actions: {}, resources: [] } as never });
  installAdapter();
});

afterEach(() => {
  __resetForTests();
  useSessionStore.setState({ access: null });
  setAuthContext({ token: null, role: null, authenticator: null });
  vi.restoreAllMocks();
});

describe('AI-04 页面：四类上下文工作区', () => {
  it('页签就是四类入口，切换后能看到各自工作区', async () => {
    renderPage();
    // 页面上不再放"实现说明/类型总览"，四类入口直接是页签；文案是普通使用指引。
    expect(screen.queryByText('实现方式待设计')).toBeNull();
    expect(screen.queryByText('上下文类型')).toBeNull();
    expect(screen.queryByText(/服务端|原生客户端|schema|前端工具/)).toBeNull();
    for (const label of ['数据范围', '指定记录', '代码工作内容', '图表工作内容', '会话内容']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }

    fireEvent.click(screen.getByTestId('context-tab-record'));
    expect(screen.getByText('指定记录的工作内容')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('context-tab-code'));
    expect(screen.getByTestId('context-code-input')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('context-tab-chart'));
    expect(screen.getByTestId('context-chart-collection')).toBeInTheDocument();
  });

  it('数据范围预览按 POST + values（结构化筛选）发出，并渲染服务端返回的单元格行', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('context-datasource-preview')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('context-datasource-preview'));

    await waitFor(() => expect(screen.getByTestId('context-datasource-preview-table')).toBeInTheDocument());
    const preview = requests.filter((request) => String(request.url).includes('aiContextDatasources:preview'));
    expect(preview).toHaveLength(1);
    expect(String(preview[0].method).toLowerCase()).toBe('post');
    // SDK 会把 `params.values` 摊成请求体本身（服务端读 `ctx.request.body` 作为 values）。
    const sent = body(preview[0]);
    expect(sent).toMatchObject({
      datasource: 'main',
      collectionName: 'orders',
      filter: { logic: '$and', items: [{ path: 'status', operator: '$eq', value: 'open' }] },
    });
    expect(screen.getByText(/范围内的记录总数：2/)).toBeInTheDocument();
  });

  it('指定记录：读取 → 选择 → 摘要可取消', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('context-tab-record'));
    fireEvent.change(screen.getByTestId('context-record-collection'), { target: { value: 'orders' } });
    fireEvent.click(screen.getByTestId('context-record-preview'));

    await waitFor(() => expect(screen.getAllByTestId('context-record-pick').length).toBe(2));
    fireEvent.click(screen.getAllByTestId('context-record-pick')[0]);

    await waitFor(() => expect(screen.getByTestId('context-record-summary')).toBeInTheDocument());
    expect(getSelections()).toHaveLength(1);
    expect(getSelections()[0]).toMatchObject({
      kind: 'record',
      collectionName: 'orders',
      primaryKey: 'id',
      recordId: 1,
    });

    fireEvent.click(screen.getByTestId('context-record-clear'));
    await waitFor(() => expect(getSelections()).toHaveLength(0));
  });

  it('代码工作内容：保存为会话内容，预览修改后可明确应用或拒绝', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('context-tab-code'));
    fireEvent.change(screen.getByTestId('context-code-input'), { target: { value: 'const total = 1;' } });
    fireEvent.click(screen.getByTestId('context-code-save'));

    await waitFor(() => expect(screen.getByTestId('context-code-proposal')).toBeInTheDocument());
    expect(getSelections()[0]).toMatchObject({ kind: 'code', code: 'const total = 1;' });

    fireEvent.change(screen.getByTestId('context-code-proposal'), { target: { value: 'const total = 2;' } });
    fireEvent.click(screen.getByTestId('context-code-preview-change'));
    await waitFor(() => expect(screen.getAllByTestId('context-tool-apply').length).toBe(1));

    fireEvent.click(screen.getByTestId('context-tool-apply'));
    await waitFor(() => expect(getSelections()[0]).toMatchObject({ code: 'const total = 2;' }));
    expect(getProposals()).toHaveLength(0);
  });

  it('代码工作内容：拒绝后内容不变', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('context-tab-code'));
    fireEvent.change(screen.getByTestId('context-code-input'), { target: { value: 'const total = 1;' } });
    fireEvent.click(screen.getByTestId('context-code-save'));
    await waitFor(() => expect(screen.getByTestId('context-code-proposal')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('context-code-proposal'), { target: { value: 'const total = 2;' } });
    fireEvent.click(screen.getByTestId('context-code-preview-change'));
    await waitFor(() => expect(screen.getAllByTestId('context-tool-reject').length).toBe(1));
    fireEvent.click(screen.getByTestId('context-tool-reject'));

    await waitFor(() => expect(getProposals()).toHaveLength(0));
    expect(getSelections()[0]).toMatchObject({ code: 'const total = 1;' });
  });

  it('图表工作内容：保存配置并能预览修改后应用', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('context-tab-chart'));
    fireEvent.change(screen.getByTestId('context-chart-collection'), { target: { value: 'orders' } });
    fireEvent.change(screen.getByTestId('context-chart-aggregation'), { target: { value: 'sum' } });
    fireEvent.click(screen.getByTestId('context-chart-save'));

    await waitFor(() => expect(getSelections()[0]).toMatchObject({ kind: 'chart', collectionName: 'orders', aggregation: 'sum' }));
    fireEvent.change(screen.getByTestId('context-chart-type'), { target: { value: 'pie' } });
    fireEvent.click(screen.getByTestId('context-chart-preview-change'));

    await waitFor(() => expect(screen.getAllByTestId('context-tool-apply').length).toBe(1));
    fireEvent.click(screen.getByTestId('context-tool-apply'));
    await waitFor(() => expect(getSelections()[0]).toMatchObject({ chartType: 'pie' }));
  });

  it('会话内容页签汇总已选内容、显示真实工具与载荷（含 type/uid 契约）', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('context-tab-code'));
    fireEvent.change(screen.getByTestId('context-code-input'), { target: { value: 'select 1;' } });
    fireEvent.click(screen.getByTestId('context-code-save'));
    await waitFor(() => expect(getSelections()).toHaveLength(1));

    fireEvent.click(screen.getByTestId('context-tab-selection'));
    const list = await screen.findByTestId('context-selection-list');
    const payload = JSON.parse(list.getAttribute('data-payload') ?? '[]') as Array<Record<string, unknown>>;
    expect(payload).toHaveLength(1);
    expect(payload[0]).toMatchObject({ type: 'code-editor', uid: 'crewloom:code-workspace' });
    const tools = payload[0].frontendTools as Array<{ id: string; blockUid: string; permission: string }>;
    expect(tools.map((tool) => tool.id)).toEqual([
      'crewloom:code-workspace:read_code_workspace',
      'crewloom:code-workspace:preview_code_change',
      'crewloom:code-workspace:apply_code_change',
    ]);
    expect(tools.every((tool) => tool.blockUid === 'crewloom:code-workspace')).toBe(true);
    // 面向用户只显示能力说明（不出现工具名/注册表等实现词）。
    expect(screen.getByText(/是否应用由你确认/)).toBeInTheDocument();
    expect(screen.getByTestId('context-goto-conversations')).toBeInTheDocument();
  });

  it('预览：真实 2.2.20 的 records（单元格行）/total 渲染出实际字段值', async () => {
    // 固定 2.2.20 与真实 13000 只读核对的 HTTP 200 体都是 { options, total, records }；
    // records 是 {name,type,value} 单元格行，total 是筛选命中的总条数。
    // Main 在 5334/5413 的 expenses 范围（2 行、每行“—”）就是"读 rows/count 假外壳"造成的。
    installAdapter();
    const client = getHttpClient();
    const baseAdapter = client.defaults.adapter as (config: InternalAxiosRequestConfig) => Promise<AxiosResponse>;
    client.defaults.adapter = (async (config: InternalAxiosRequestConfig) => {
      if (String(config.url ?? '').includes('aiContextDatasources:preview')) {
        return respond(config, {
          options: { limit: 10 },
          total: 2,
          records: [
            [
              { name: 'id', type: 'bigInt', value: 1 },
              { name: 'amount', type: 'double', value: 128 },
            ],
            [
              { name: 'id', type: 'bigInt', value: 2 },
              { name: 'amount', type: 'double', value: 256 },
            ],
          ],
        });
      }
      return baseAdapter(config);
    }) as typeof client.defaults.adapter;

    renderPage();
    await waitFor(() => expect(screen.getByTestId('context-datasource-preview')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('context-datasource-preview'));

    await waitFor(() => expect(screen.getByTestId('context-datasource-preview-table')).toBeInTheDocument());
    expect(screen.getByText(/范围内的记录总数：2/)).toBeInTheDocument();
    const table = screen.getByTestId('context-datasource-preview-table');
    expect(table.querySelectorAll('tbody tr')).toHaveLength(2);
    // 断言**实际字段值**可见（不是每行“—”）：这才能抓住"只修了 rows/count 外壳"的假通过。
    const bodyText = table.textContent ?? '';
    expect(bodyText).toContain('id=1');
    expect(bodyText).toContain('amount=128');
    expect(bodyText).toContain('id=2');
    expect(bodyText).toContain('amount=256');
    expect(table.querySelectorAll('tbody tr')[0].textContent).not.toBe('1—');
  });
});
