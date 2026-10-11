// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { getHttpClient, setAuthContext } from '../../../src/api/client';
import { NodeConfigPage } from '../../../src/modules/workflow/pages/NodeConfigPage';

/**
 * WF-03 节点配置页：按类型表单的实际编辑与保存请求（受控 adapter，走产品真实请求管线）。
 *
 * 覆盖评审要求：已知类型必须有**可操作字段**（不是只有一个 JSON textarea），
 * 校验能拦住缺项，保存时写出该类型真实的 config 形状；未知类型走原始配置边界。
 */

interface Captured {
  method?: string;
  url?: string;
  params?: Record<string, unknown>;
  data?: unknown;
}

let captured: Captured[] = [];

function parse(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function install(nodes: unknown[]): void {
  const client = getHttpClient();
  client.defaults.adapter = async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
    captured.push({
      method: config.method,
      url: config.url,
      params: config.params as Record<string, unknown> | undefined,
      data: config.data,
    });
    const url = String(config.url ?? '');
    if (url.includes('workflows:get')) {
      return {
        data: { data: { id: 172, title: '订单同步', key: 'abc', current: true, enabled: true, type: 'collection', versionStats: { executed: 0 } } },
        status: 200,
        statusText: '200',
        headers: {},
        config,
      };
    }
    if (url.includes('flow_nodes:list')) {
      return { data: { data: nodes, meta: { count: nodes.length } }, status: 200, statusText: '200', headers: {}, config };
    }
    return { data: { data: {} }, status: 200, statusText: '200', headers: {}, config };
  };
}

function renderNode(nodeId: string) {
  const router = createMemoryRouter([{ path: '/workflow/node', element: <NodeConfigPage /> }], {
    initialEntries: [`/workflow/node?workflowId=172&nodeId=${nodeId}`],
  });
  return render(<RouterProvider router={router} />);
}

beforeEach(() => {
  captured = [];
  setAuthContext({ token: 'test-token', role: null });
});

describe('WF-03 已知节点类型的可操作配置', () => {
  it('查询节点渲染数据表/多条/失败判定等真实字段，保存写出源码 config 形状', async () => {
    install([{ id: 2410, title: '查询订单', type: 'query', upstreamId: null, config: { collection: 'orders', multiple: true, params: {} } }]);
    renderNode('2410');

    expect(await screen.findByText('查询数据配置')).toBeTruthy();
    // 已知类型给出中文标签的可操作字段，而不是一句"未知类型"。
    expect(screen.getByRole('textbox', { name: '数据表' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: '查询多条' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: '查不到时判定失败' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: '查询条件' })).toBeTruthy();

    await userEvent.click(screen.getByRole('checkbox', { name: '查不到时判定失败' }));
    await userEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(captured.some((entry) => String(entry.url).includes('flow_nodes:update'))).toBe(true));

    const update = captured.find((entry) => String(entry.url).includes('flow_nodes:update'));
    expect(update?.method).toBe('post');
    expect(update?.params).toMatchObject({ filterByTk: '2410' });
    const body = parse(update?.data) as { title?: string; config?: Record<string, unknown> };
    expect(body.title).toBe('查询订单');
    expect(body.config).toMatchObject({ collection: 'orders', multiple: true, failOnEmpty: true, params: {} });
  });

  it('数据表必填：缺失时给出提示且不发保存请求', async () => {
    install([{ id: 2411, title: '新增记录', type: 'create', upstreamId: null, config: { params: { values: { a: 1 } } } }]);
    renderNode('2411');

    expect(await screen.findByText('新增数据配置')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '保存配置' }));
    expect(await screen.findByText(/请填写数据表名称/)).toBeTruthy();
    expect(captured.some((entry) => String(entry.url).includes('flow_nodes:update'))).toBe(false);
  });

  it('新增数据节点的写入内容用键值编辑器修改（而不是改 JSON 文本）', async () => {
    install([{ id: 2412, title: '新增记录', type: 'create', upstreamId: null, config: { collection: 'orders', params: { values: { status: 'open' } } } }]);
    renderNode('2412');

    expect(await screen.findByText('新增数据配置')).toBeTruthy();
    const valueInput = await screen.findByDisplayValue('open');
    await userEvent.clear(valueInput);
    await userEvent.type(valueInput, 'closed');
    await userEvent.click(screen.getByRole('button', { name: '保存配置' }));

    await waitFor(() => expect(captured.some((entry) => String(entry.url).includes('flow_nodes:update'))).toBe(true));
    const update = captured.find((entry) => String(entry.url).includes('flow_nodes:update'));
    const body = parse(update?.data) as { config?: { params?: { values?: Record<string, unknown> } } };
    expect(body.config?.params?.values).toEqual({ status: 'closed' });
  });

  it('多条件节点：条件列表可增删，并校验空条件', async () => {
    install([{ id: 2413, title: '多条件', type: 'multi-conditions', upstreamId: null, config: { conditions: [] } }]);
    renderNode('2413');

    expect(await screen.findByText('多条件分支配置')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '保存配置' }));
    expect(await screen.findByText('请至少添加一条条件')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: '添加条件' }));
    const titleInput = screen.getByRole('textbox', { name: '第 1 条条件标题' });
    await userEvent.type(titleInput, '金额大于 1000');
    await userEvent.click(screen.getByRole('button', { name: '保存配置' }));

    await waitFor(() => expect(captured.some((entry) => String(entry.url).includes('flow_nodes:update'))).toBe(true));
    const update = captured.find((entry) => String(entry.url).includes('flow_nodes:update'));
    const body = parse(update?.data) as { config?: { conditions?: Array<{ title?: string }> } };
    expect(body.config?.conditions?.[0]?.title).toBe('金额大于 1000');
  });

  it('未知类型走原始配置边界：明确提示且完整保留原 config', async () => {
    const unknownConfig = { custom: { nested: [1, 2, 3] }, flag: true };
    install([{ id: 2414, title: '未来的节点', type: 'plugin-x-node', upstreamId: null, config: unknownConfig }]);
    renderNode('2414');

    expect(await screen.findByText('未知节点类型')).toBeTruthy();
    expect(screen.getByText(/没有它的配置面板/)).toBeTruthy();
    const raw = screen.getByRole('textbox', { name: '配置内容' }) as HTMLTextAreaElement;
    expect(raw.value).toContain('"custom"');
    expect(raw.value).toContain('1');

    await userEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(captured.some((entry) => String(entry.url).includes('flow_nodes:update'))).toBe(true));
    const update = captured.find((entry) => String(entry.url).includes('flow_nodes:update'));
    const body = parse(update?.data) as { config?: Record<string, unknown> };
    expect(body.config).toEqual(unknownConfig);
  });

  it('已执行版本禁止编辑（保存入口不出现，并给出新建版本引导）', async () => {
    const client = getHttpClient();
    client.defaults.adapter = async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
      captured.push({ method: config.method, url: config.url, params: config.params as Record<string, unknown> | undefined, data: config.data });
      const url = String(config.url ?? '');
      if (url.includes('workflows:get')) {
        return {
          data: { data: { id: 172, title: '订单同步', key: 'abc', current: true, enabled: true, type: 'collection', versionStats: { executed: 9 } } },
          status: 200,
          statusText: '200',
          headers: {},
          config,
        };
      }
      return {
        data: { data: [{ id: 2415, title: '计算', type: 'calculation', upstreamId: null, config: { engine: 'math.js', expression: '1+1' } }] },
        status: 200,
        statusText: '200',
        headers: {},
        config,
      };
    };
    renderNode('2415');
    expect(await screen.findByText(/这个版本已执行过，不能修改/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '保存配置' })).toBeNull();
  });
});
