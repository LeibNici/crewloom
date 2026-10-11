// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { getHttpClient, setAuthContext } from '../../../src/api/client';
import { WorkflowListPage } from '../../../src/modules/workflow/pages/WorkflowListPage';
import { WorkflowCanvasPage } from '../../../src/modules/workflow/pages/WorkflowCanvasPage';

/**
 * WF-01 / WF-02 的真实请求管线测试（受控 adapter）。
 *
 * 断言的是产品实际发出的 URL、方法与请求体，重点覆盖两条已确认契约：
 *  - "为同一流程新建版本"必须把 `key` 放在 **filter** 里（不是 values）；
 *  - "复制为独立流程"只传 values，不带 filter.key；
 *  - 流程节点用 `flow_nodes:list?filter={"workflowId":N}` 读取（2.2.20 实测可用读法）。
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

function installAdapter(handlers: Record<string, (config: InternalAxiosRequestConfig) => unknown>): void {
  const client = getHttpClient();
  client.defaults.adapter = async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
    captured.push({
      method: config.method,
      url: config.url,
      params: config.params as Record<string, unknown> | undefined,
      data: config.data,
    });
    const url = String(config.url ?? '');
    for (const [key, makeBody] of Object.entries(handlers)) {
      if (url.includes(key)) {
        return { data: makeBody(config), status: 200, statusText: '200', headers: {}, config };
      }
    }
    return { data: { data: [] }, status: 200, statusText: '200', headers: {}, config };
  };
}

beforeEach(() => {
  captured = [];
  setAuthContext({ token: 'test-token', role: null });
});

describe('WF-01 流程列表', () => {
  const workflows = [
    {
      id: 172,
      title: '订单同步',
      key: 'abc',
      current: true,
      enabled: true,
      type: 'collection',
      versionStats: { executed: 2 },
      updatedAt: '2026-10-11T02:00:00.000Z',
      categories: [{ id: 1, title: '业务' }],
    },
    {
      id: 171,
      title: '订单同步',
      key: 'abc',
      current: false,
      enabled: false,
      type: 'collection',
      versionStats: { executed: 0 },
    },
  ];

  function setup() {
    installAdapter({
      'workflows:list': () => ({ data: workflows, meta: { count: 2, page: 1, pageSize: 20 } }),
      'workflowCategories:list': () => ({ data: [{ id: 1, title: '业务' }], meta: { count: 1 } }),
      'workflows:update': () => ({ data: { id: 172 } }),
      'workflows:revision': () => ({ data: { id: 200, key: 'abc' } }),
      'workflows:destroy': () => ({ data: {} }),
      'workflows:create': () => ({ data: { id: 201 } }),
    });
    const router = createMemoryRouter([{ path: '/workflow/list', element: <WorkflowListPage /> }], {
      initialEntries: ['/workflow/list'],
    });
    return render(<RouterProvider router={router} />);
  }

  it('区分当前生效版本与历史版本，并显示按版本的执行次数', async () => {
    setup();
    expect(await screen.findByText('当前生效版本')).toBeTruthy();
    expect(screen.getByText('历史版本')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText(/该版本已执行 2 次/)).toBeTruthy();

    const list = captured.find((entry) => String(entry.url).includes('workflows:list'));
    expect(list?.method).toBe('get');
    expect(list?.params).toMatchObject({ page: 1, pageSize: 20 });
    expect(list?.params?.appends).toEqual(['versionStats', 'categories']);
  });

  it('启停只提交 enabled，由服务端维护 current', async () => {
    setup();
    await screen.findByText('当前生效版本');
    const buttons = screen.getAllByRole('button', { name: '停用' });
    await userEvent.click(buttons[0]);
    await waitFor(() => {
      expect(captured.some((entry) => String(entry.url).includes('workflows:update'))).toBe(true);
    });
    const update = captured.find((entry) => String(entry.url).includes('workflows:update'));
    expect(update?.method).toBe('post');
    expect(update?.params).toMatchObject({ filterByTk: '172' });
    expect(parse(update?.data)).toEqual({ enabled: false });
  });

  it('“新建版本”把 key 放进 filter，且不带 values', async () => {
    setup();
    await screen.findByText('当前生效版本');
    const buttons = screen.getAllByRole('button', { name: '新建版本' });
    await userEvent.click(buttons[0]);
    await waitFor(() => {
      expect(captured.some((entry) => String(entry.url).includes('workflows:revision'))).toBe(true);
    });
    const revision = captured.find((entry) => String(entry.url).includes('workflows:revision'));
    expect(revision?.method).toBe('post');
    expect(revision?.params).toMatchObject({ filterByTk: '172' });
    expect(parse(revision?.params?.filter)).toEqual({ key: 'abc' });
    // 同组新版本不带 values（带 values 会变成另一条独立流程）。
    expect(parse(revision?.data)).toEqual({});
  });

  it('“复制为独立流程”只传 values，不带 filter.key', async () => {
    setup();
    await screen.findByText('当前生效版本');
    const buttons = screen.getAllByRole('button', { name: '复制为独立流程' });
    await userEvent.click(buttons[0]);
    await waitFor(() => {
      expect(captured.some((entry) => String(entry.url).includes('workflows:revision'))).toBe(true);
    });
    const revision = captured.find((entry) => String(entry.url).includes('workflows:revision'));
    expect(revision?.params).toMatchObject({ filterByTk: '172' });
    expect(revision?.params?.filter).toBeUndefined();
    expect(parse(revision?.data)).toEqual({ title: '订单同步 副本' });
  });
});

describe('WF-02 流程编排', () => {
  it('用 flow_nodes:list + workflowId 过滤读取节点，并按上游关系排序', async () => {
    installAdapter({
      'workflows:get': () => ({
        data: {
          id: 172,
          title: '订单同步',
          key: 'abc',
          current: true,
          enabled: true,
          type: 'collection',
          versionStats: { executed: 0 },
        },
      }),
      'flow_nodes:list': () => ({
        data: [
          { id: 3, title: '结束', type: 'end', upstreamId: 2, downstreamId: null },
          { id: 2, title: '计算金额', type: 'calculation', upstreamId: 1, config: { expression: '3 + 4' } },
          { id: 1, title: '触发', type: 'collection', upstreamId: null },
        ],
        meta: { count: 3 },
      }),
    });
    const router = createMemoryRouter([{ path: '/workflow/canvas', element: <WorkflowCanvasPage /> }], {
      initialEntries: ['/workflow/canvas?workflowId=172'],
    });
    render(<RouterProvider router={router} />);

    expect(await screen.findByText('订单同步 · 流程编排')).toBeTruthy();
    expect(await screen.findByText('计算金额')).toBeTruthy();
    expect(screen.getAllByText('结束').length).toBeGreaterThan(0);
    // 配置摘要来自真实 config 字段。
    expect(screen.getByText(/配置摘要：3 \+ 4/)).toBeTruthy();

    const nodes = captured.find((entry) => String(entry.url).includes('flow_nodes:list'));
    expect(nodes?.method).toBe('get');
    expect(parse(nodes?.params?.filter)).toEqual({ workflowId: '172' });
    // 实测可用的读法：不使用 workflows/<id>/flow_nodes:list。
    expect(nodes?.url).toBe('flow_nodes:list');
  });

  it('已执行版本给出明确限制说明，不提供会必然失败的操作承诺', async () => {
    installAdapter({
      'workflows:get': () => ({
        data: {
          id: 172,
          title: '订单同步',
          key: 'abc',
          current: true,
          enabled: true,
          type: 'collection',
          versionStats: { executed: 5 },
        },
      }),
      'flow_nodes:list': () => ({ data: [{ id: 1, title: '触发', type: 'collection' }], meta: { count: 1 } }),
    });
    const router = createMemoryRouter([{ path: '/workflow/canvas', element: <WorkflowCanvasPage /> }], {
      initialEntries: ['/workflow/canvas?workflowId=172'],
    });
    render(<RouterProvider router={router} />);
    expect(await screen.findByText(/这个版本已经有执行记录/)).toBeTruthy();
  });

  it('新增节点走 workflows/<版本>/nodes:create，而不是 flow_nodes:create', async () => {
    installAdapter({
      'workflows:get': () => ({
        data: {
          id: 172,
          title: '订单同步',
          key: 'abc',
          current: true,
          enabled: true,
          type: 'collection',
          versionStats: { executed: 0 },
        },
      }),
      'flow_nodes:list': () => ({
        data: [{ id: 1, title: '触发', type: 'collection', upstreamId: null }],
        meta: { count: 1 },
      }),
      'nodes:create': () => ({ data: { id: 300, type: 'calculation' } }),
    });
    const router = createMemoryRouter([{ path: '/workflow/canvas', element: <WorkflowCanvasPage /> }], {
      initialEntries: ['/workflow/canvas?workflowId=172'],
    });
    render(<RouterProvider router={router} />);
    await screen.findByText('订单同步 · 流程编排');

    await userEvent.click(screen.getByRole('button', { name: '添加节点' }));
    const titleInput = screen.getByPlaceholderText('计算');
    await userEvent.type(titleInput, '汇总金额');
    await userEvent.click(screen.getByRole('button', { name: '确认添加' }));

    await waitFor(() => {
      expect(captured.some((entry) => String(entry.url).includes('nodes:create'))).toBe(true);
    });
    const created = captured.find((entry) => String(entry.url).includes('nodes:create'));
    expect(created?.method).toBe('post');
    // 关联资源形状：父资源 workflows + 父记录 id 172 + 子动作 nodes:create。
    expect(created?.url).toBe('workflows/172/nodes:create');
    // 新节点带该类型的源码初值（calculation：math.js + 空表达式），不是空 config。
    expect(parse(created?.data)).toEqual({
      type: 'calculation',
      title: '汇总金额',
      config: { engine: 'math.js', expression: '' },
    });
    expect(String(created?.url)).not.toContain('flow_nodes:create');
  });

  it('「复制节点」把副本落点放进 values（真实 duplicate 只认 values.upstreamId）', async () => {
    installAdapter({
      'workflows:get': () => ({
        data: {
          id: 172,
          title: '订单同步',
          key: 'abc',
          current: true,
          enabled: true,
          type: 'collection',
          versionStats: { executed: 0 },
        },
      }),
      'flow_nodes:list': () => ({
        data: [
          { id: 1, title: '触发', type: 'collection', upstreamId: null, downstreamId: 2 },
          { id: 2, title: '计算金额', type: 'calculation', upstreamId: 1, downstreamId: 3, config: { expression: '1 + 1' } },
          { id: 3, title: '结束', type: 'end', upstreamId: 2, downstreamId: null },
        ],
        meta: { count: 3 },
      }),
      'flow_nodes:duplicate': () => ({ data: { id: 4, upstreamId: 2 } }),
    });
    const router = createMemoryRouter([{ path: '/workflow/canvas', element: <WorkflowCanvasPage /> }], {
      initialEntries: ['/workflow/canvas?workflowId=172'],
    });
    render(<RouterProvider router={router} />);
    await screen.findByText('订单同步 · 流程编排');

    // 第 2 个「复制节点」按钮属于节点 2（列表按上游关系排序：触发 → 计算金额 → 结束）。
    await userEvent.click(screen.getAllByRole('button', { name: '复制节点' })[1]);

    await waitFor(() => {
      expect(captured.some((entry) => String(entry.url).includes('flow_nodes:duplicate'))).toBe(true);
    });
    const duplicate = captured.find((entry) => String(entry.url).includes('flow_nodes:duplicate'));
    expect(duplicate?.method).toBe('post');
    expect(duplicate?.url).toBe('flow_nodes:duplicate');
    expect(duplicate?.params?.filterByTk).toBe('2');
    // 不带落点时真实服务端会把副本插到流程最前（upstreamId=null），必须显式给出目标位置。
    expect(parse(duplicate?.data)).toEqual({ upstreamId: '2', branchIndex: null });
  });

  it('「删除分支」只在 multi-conditions 上提供：先确认，再按真实契约传上游 id + branchIndex + shift，并同步条件配置', async () => {
    installAdapter({
      'workflows:get': () => ({
        data: {
          id: 172,
          title: '订单同步',
          key: 'abc',
          current: true,
          enabled: true,
          type: 'collection',
          versionStats: { executed: 0 },
        },
      }),
      'flow_nodes:list': () => ({
        data: [
          { id: 1, title: '触发', type: 'collection', upstreamId: null, downstreamId: 2 },
          {
            id: 2,
            title: '多条件',
            type: 'multi-conditions',
            upstreamId: 1,
            downstreamId: null,
            config: {
              conditions: [
                { uid: 'c1', title: '左' },
                { uid: 'c2', title: '中' },
                { uid: 'c3', title: '右' },
              ],
              continueOnNoMatch: false,
            },
          },
          { id: 4, title: '左路', type: 'output', upstreamId: 2, downstreamId: null, branchIndex: 1 },
          { id: 5, title: '中路', type: 'output', upstreamId: 2, downstreamId: null, branchIndex: 2 },
          { id: 6, title: '右路', type: 'output', upstreamId: 2, downstreamId: null, branchIndex: 3 },
        ],
        meta: { count: 5 },
      }),
      'flow_nodes:destroyBranch': () => ({ data: { id: 4 } }),
      'flow_nodes:update': () => ({ data: { id: 2 } }),
    });
    const router = createMemoryRouter([{ path: '/workflow/canvas', element: <WorkflowCanvasPage /> }], {
      initialEntries: ['/workflow/canvas?workflowId=172'],
    });
    render(<RouterProvider router={router} />);
    await screen.findByText('订单同步 · 流程编排');

    // 点第 1 个「删除分支」（branchIndex=1 的左路）→ 先出确认面板，此刻**还没有**写请求。
    await userEvent.click(screen.getAllByRole('button', { name: '删除分支' })[0]);
    expect(await screen.findByText(/删除分支「左路」/)).toBeTruthy();
    expect(captured.some((entry) => String(entry.url).includes('flow_nodes:destroyBranch'))).toBe(false);

    // 取消 → 一条写请求都不发。
    await userEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByText(/删除分支「左路」/)).toBeNull();
    expect(captured.some((entry) => String(entry.url).includes('flow_nodes:destroyBranch'))).toBe(false);

    // 再点一次并确认 → 恰好一条 destroyBranch + 一条 config 同步。
    await userEvent.click(screen.getAllByRole('button', { name: '删除分支' })[0]);
    await screen.findByText(/删除分支「左路」/);
    await userEvent.click(screen.getByRole('button', { name: '确认删除' }));

    await waitFor(() => {
      expect(captured.some((entry) => String(entry.url).includes('flow_nodes:destroyBranch'))).toBe(true);
    });
    const destroyBranch = captured.find((entry) => String(entry.url).includes('flow_nodes:destroyBranch'));
    expect(destroyBranch?.method).toBe('post');
    expect(destroyBranch?.url).toBe('flow_nodes:destroyBranch');
    // filterByTk 是分支挂靠的上游节点（2），不是分支头自己（4）；branchIndex 必填且按原生 1..N。
    expect(destroyBranch?.params?.filterByTk).toBe('2');
    expect(destroyBranch?.params?.branchIndex).toBe(1);
    expect(destroyBranch?.params?.shift).toBe(1);
    // 与原生 `onRemoveConfirm` 一致：同步把 config.conditions 里对应条件删掉。
    const configUpdate = captured.find((entry) => String(entry.url).includes('flow_nodes:update'));
    expect(configUpdate?.params?.filterByTk).toBe('2');
    expect(parse(configUpdate?.data)).toEqual({
      config: {
        conditions: [
          { uid: 'c2', title: '中' },
          { uid: 'c3', title: '右' },
        ],
        continueOnNoMatch: false,
      },
    });
  });

  it('condition / parallel 的分支头不提供可用的「删除分支」（否/是含义固定，删除会改号）', async () => {
    installAdapter({
      'workflows:get': () => ({
        data: {
          id: 172,
          title: '订单同步',
          key: 'abc',
          current: true,
          enabled: true,
          type: 'collection',
          versionStats: { executed: 0 },
        },
      }),
      'flow_nodes:list': () => ({
        data: [
          { id: 1, title: '触发', type: 'collection', upstreamId: null, downstreamId: 2 },
          { id: 2, title: '判断', type: 'condition', upstreamId: 1, downstreamId: null, config: {} },
          { id: 4, title: '否侧', type: 'output', upstreamId: 2, downstreamId: null, branchIndex: 0 },
          { id: 5, title: '是侧', type: 'output', upstreamId: 2, downstreamId: null, branchIndex: 1 },
        ],
        meta: { count: 4 },
      }),
      'flow_nodes:destroyBranch': () => ({ data: { id: 4 } }),
    });
    const router = createMemoryRouter([{ path: '/workflow/canvas', element: <WorkflowCanvasPage /> }], {
      initialEntries: ['/workflow/canvas?workflowId=172'],
    });
    render(<RouterProvider router={router} />);
    await screen.findByText('订单同步 · 流程编排');

    // 两个分支头各有一个「删除分支」按钮，但都不可用（禁用 + 业务语言说明），不是"点了没反应"。
    const buttons = screen.getAllByRole('button', { name: '删除分支' });
    expect(buttons.length).toBe(2);
    for (const button of buttons) expect((button as HTMLButtonElement).disabled).toBe(true);
    // 说明必须是普通用户能懂的文案：不出现序号、shift、原生、类型名等内部术语。
    const hints = screen.getAllByText(/两条处理路径需要保留/);
    expect(hints.length).toBeGreaterThan(0);
    const pageText = document.body.textContent ?? '';
    for (const term of ['branchIndex', 'shift', '原生', 'multi-conditions', '分支父节点']) {
      expect(pageText).not.toContain(term);
    }
    await userEvent.click(buttons[0]);
    expect(captured.some((entry) => String(entry.url).includes('flow_nodes:destroyBranch'))).toBe(false);
  });

  it('分支父节点带线性续行时，「上移」整体交换条件与上一步（不再因本机表示能力被禁用）', async () => {
    installAdapter({
      'workflows:get': () => ({
        data: {
          id: 172,
          title: '订单同步',
          key: 'abc',
          current: true,
          enabled: true,
          type: 'collection',
          versionStats: { executed: 0 },
        },
      }),
      'flow_nodes:list': () => ({
        data: [
          { id: 1, title: '开始', type: 'calculation', upstreamId: null, downstreamId: 2 },
          { id: 2, title: '准备', type: 'calculation', upstreamId: 1, downstreamId: 3 },
          { id: 3, title: '是否需要处理', type: 'condition', upstreamId: 2, downstreamId: 6, config: {} },
          { id: 4, title: '否侧处理', type: 'output', upstreamId: 3, downstreamId: null, branchIndex: 0 },
          { id: 5, title: '是侧处理', type: 'output', upstreamId: 3, downstreamId: null, branchIndex: 1 },
          { id: 6, title: '合并', type: 'output', upstreamId: 3, downstreamId: 7 },
          { id: 7, title: '收尾', type: 'output', upstreamId: 6, downstreamId: null },
        ],
        meta: { count: 7 },
      }),
      'flow_nodes:move': () => ({ data: { id: 3 } }),
    });
    const router = createMemoryRouter([{ path: '/workflow/canvas', element: <WorkflowCanvasPage /> }], {
      initialEntries: ['/workflow/canvas?workflowId=172'],
    });
    render(<RouterProvider router={router} />);
    await screen.findByText('订单同步 · 流程编排');

    // 主序列 = 开始 → 准备 → 条件(否/是) → 合并 → 收尾；条件行的「上移」可用。
    const rows = screen.getAllByRole('button', { name: '上移' });
    const conditionUp = rows[2] as HTMLButtonElement;
    expect(conditionUp.disabled).toBe(false);
    // 每条处理路径只有一步时，它既是首步也是尾步：上移/下移都禁用，并说明是路径首/末步。
    const upButtons = screen.getAllByRole('button', { name: '上移' }) as HTMLButtonElement[];
    const downButtons = screen.getAllByRole('button', { name: '下移' }) as HTMLButtonElement[];
    // 顺序 = 开始 / 准备 / 条件 / 否侧 / 是侧 / 合并 / 收尾；只有"否侧 / 是侧"在分支里。
    expect(upButtons[3].disabled).toBe(true);
    expect(upButtons[4].disabled).toBe(true);
    expect(upButtons[3].title).toContain('这条处理路径的第一步');
    expect(upButtons[4].title).toContain('这条处理路径的第一步');
    expect(downButtons[3].title).toContain('这条处理路径的最后一步');
    expect(downButtons[4].title).toContain('这条处理路径的最后一步');
    // 首步的上移是"已经在最前面"，与"路径首步"区分开；条件之后的续行仍在主序列上。
    expect(upButtons[0].title).toContain('已经是第一步');
    expect(upButtons[5].disabled).toBe(false);
    const pageText = document.body.textContent ?? '';
    for (const term of ['branchIndex', 'shift', '原生', 'multi-conditions', '分支父节点']) {
      expect(pageText).not.toContain(term);
    }

    await userEvent.click(conditionUp);
    await waitFor(() => {
      expect(captured.some((entry) => String(entry.url).includes('flow_nodes:move'))).toBe(true);
    });
    const move = captured.find((entry) => String(entry.url).includes('flow_nodes:move'));
    expect(move?.method).toBe('post');
    // 整体交换条件与「准备」：条件落到「准备」原来的位置（紧跟在「开始」之后）。
    expect(move?.params?.filterByTk).toBe('3');
    expect(parse(move?.data)).toEqual({ upstreamId: '1', branchIndex: null });
  });

  it('处理路径内的相邻交换：中路第二步上移到同路首位（承接该路径序号），路径首/末步各自禁用', async () => {
    installAdapter({
      'workflows:get': () => ({
        data: {
          id: 173,
          title: '宽分支',
          key: 'wide',
          current: true,
          enabled: true,
          type: 'collection',
          versionStats: { executed: 0 },
        },
      }),
      'flow_nodes:list': () => ({
        data: [
          { id: 1, title: '入口', type: 'calculation', upstreamId: null, downstreamId: 2 },
          {
            id: 2,
            title: '三路分支',
            type: 'multi-conditions',
            upstreamId: 1,
            downstreamId: null,
            config: {
              conditions: [
                { uid: 'left', title: '左' },
                { uid: 'middle', title: '中' },
                { uid: 'right', title: '右' },
              ],
            },
          },
          { id: 3, title: '左路处理', type: 'output', upstreamId: 2, downstreamId: 4, branchIndex: 1 },
          { id: 4, title: '左路收尾', type: 'output', upstreamId: 3, downstreamId: null },
          { id: 5, title: '中路处理', type: 'output', upstreamId: 2, downstreamId: 6, branchIndex: 2 },
          { id: 6, title: '中路收尾', type: 'output', upstreamId: 5, downstreamId: null },
          { id: 7, title: '右路处理', type: 'output', upstreamId: 2, downstreamId: 8, branchIndex: 3 },
          { id: 8, title: '右路收尾', type: 'output', upstreamId: 7, downstreamId: null },
        ],
        meta: { count: 8 },
      }),
      'flow_nodes:move': () => ({ data: { id: 6 } }),
    });
    const router = createMemoryRouter([{ path: '/workflow/canvas', element: <WorkflowCanvasPage /> }], {
      initialEntries: ['/workflow/canvas?workflowId=173'],
    });
    render(<RouterProvider router={router} />);
    await screen.findByText('宽分支 · 流程编排');

    // 展示顺序 = 入口 / 三路分支 / 左路处理 / 左路收尾 / 中路处理 / 中路收尾 / 右路处理 / 右路收尾。
    const upButtons = screen.getAllByRole('button', { name: '上移' }) as HTMLButtonElement[];
    const downButtons = screen.getAllByRole('button', { name: '下移' }) as HTMLButtonElement[];
    // 中路第二步（收尾）：同一路径内可以上移；它是路径尾步，不能下移。
    expect(upButtons[5].disabled).toBe(false);
    expect(upButtons[5].title).toContain('与上一步交换');
    expect(downButtons[5].disabled).toBe(true);
    expect(downButtons[5].title).toContain('这条处理路径的最后一步');
    // 中路第一步（处理）：是路径首步，不能上移；可以与下一步交换。
    expect(upButtons[4].disabled).toBe(true);
    expect(upButtons[4].title).toContain('这条处理路径的第一步');
    expect(downButtons[4].disabled).toBe(false);
    // 左右两路的可用性与中路一致，路径内部不再被统一禁用。
    expect(upButtons[3].disabled).toBe(false);
    expect(upButtons[7].disabled).toBe(false);
    expect(upButtons[2].disabled).toBe(true);
    for (const term of ['branchIndex', 'shift', '原生', 'multi-conditions', '分支父节点']) {
      expect(document.body.textContent ?? '').not.toContain(term);
    }

    await userEvent.click(upButtons[5]);
    await waitFor(() => {
      expect(captured.some((entry) => String(entry.url).includes('flow_nodes:move'))).toBe(true);
    });
    const moves = captured.filter((entry) => String(entry.url).includes('flow_nodes:move'));
    expect(moves).toHaveLength(1);
    expect(moves[0].method).toBe('post');
    // 落点 = 前一步（中路处理）原来的位置：挂在三路分支下、承接它的路径序号 2。
    expect(moves[0].params?.filterByTk).toBe('6');
    expect(parse(moves[0].data)).toEqual({ upstreamId: '2', branchIndex: 2 });
  });

  it('「上移 / 下移」发出一次真实 move（相邻交换），首/末行与分支节点禁用', async () => {
    installAdapter({
      'workflows:get': () => ({
        data: {
          id: 172,
          title: '订单同步',
          key: 'abc',
          current: true,
          enabled: true,
          type: 'collection',
          versionStats: { executed: 0 },
        },
      }),
      'flow_nodes:list': () => ({
        data: [
          { id: 1, title: '触发', type: 'collection', upstreamId: null, downstreamId: 2 },
          { id: 2, title: '计算金额', type: 'calculation', upstreamId: 1, downstreamId: 3, config: { expression: '1 + 1' } },
          { id: 3, title: '结束', type: 'end', upstreamId: 2, downstreamId: null },
        ],
        meta: { count: 3 },
      }),
      'flow_nodes:move': () => ({ data: { id: 2 } }),
    });
    const router = createMemoryRouter([{ path: '/workflow/canvas', element: <WorkflowCanvasPage /> }], {
      initialEntries: ['/workflow/canvas?workflowId=172'],
    });
    render(<RouterProvider router={router} />);
    await screen.findByText('订单同步 · 流程编排');

    // 首行不能上移（边界直接禁用，避免 no-op 被当成功）。
    expect((screen.getAllByRole('button', { name: '上移' })[0] as HTMLButtonElement).disabled).toBe(true);

    // 第 2 行上移 = 把节点 2 移到流程起点（一次 move）。
    await userEvent.click(screen.getAllByRole('button', { name: '上移' })[1]);
    await waitFor(() => {
      expect(captured.some((entry) => String(entry.url).includes('flow_nodes:move'))).toBe(true);
    });
    const move = captured.find((entry) => String(entry.url).includes('flow_nodes:move'));
    expect(move?.method).toBe('post');
    expect(move?.params?.filterByTk).toBe('2');
    expect(parse(move?.data)).toEqual({ upstreamId: null, branchIndex: null });
  });

  it('已执行版本：所有改动作按钮禁用（不留下必然无效的可点入口）', async () => {
    installAdapter({
      'workflows:get': () => ({
        data: {
          id: 172,
          title: '订单同步',
          key: 'abc',
          current: true,
          enabled: true,
          type: 'collection',
          versionStats: { executed: 3 },
        },
      }),
      'flow_nodes:list': () => ({
        data: [
          { id: 1, title: '触发', type: 'collection', upstreamId: null, downstreamId: 2 },
          {
            id: 2,
            title: '多条件',
            type: 'multi-conditions',
            upstreamId: 1,
            downstreamId: null,
            // 用**契约上支持删除分支**的类型：这样"删除分支禁用"只可能来自只读边界，
            // 而不是来自类型不支持——判别的是 writable，不是能力。
            config: {
              conditions: [
                { uid: 'c1', title: '左' },
                { uid: 'c2', title: '右' },
              ],
            },
          },
          { id: 4, title: '左路', type: 'output', upstreamId: 2, downstreamId: null, branchIndex: 1 },
          { id: 5, title: '右路', type: 'output', upstreamId: 2, downstreamId: null, branchIndex: 2 },
        ],
        meta: { count: 4 },
      }),
    });
    const router = createMemoryRouter([{ path: '/workflow/canvas', element: <WorkflowCanvasPage /> }], {
      initialEntries: ['/workflow/canvas?workflowId=172'],
    });
    render(<RouterProvider router={router} />);
    await screen.findByText('订单同步 · 流程编排');
    expect(screen.getByText(/这个版本已经有执行记录/)).toBeTruthy();

    for (const name of ['添加节点', '上移', '下移', '改接前序', '复制节点', '删除分支', '删除节点']) {
      const buttons = screen.getAllByRole('button', { name });
      expect(buttons.length).toBeGreaterThan(0);
      for (const button of buttons) expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    // 可读的「配置」入口不受影响。
    expect(screen.getAllByRole('link', { name: '配置' }).length).toBeGreaterThan(0);
  });

  it('切换版本会清掉上一个版本的成功提示与写错误', async () => {
    installAdapter({
      'workflows:get': (config) => ({
        data: {
          id: String(config.params?.filterByTk ?? '172'),
          title: '订单同步',
          key: 'abc',
          current: true,
          enabled: true,
          type: 'collection',
          versionStats: { executed: 0 },
        },
      }),
      'flow_nodes:list': (config) => {
        const filter = parse(config.params?.filter) as { workflowId?: string } | null;
        return filter?.workflowId === '173'
          ? { data: [{ id: 20, title: '第二版节点', type: 'output', upstreamId: null }], meta: { count: 1 } }
          : {
              data: [
                { id: 1, title: '触发', type: 'collection', upstreamId: null, downstreamId: 2 },
                { id: 2, title: '计算金额', type: 'calculation', upstreamId: 1, downstreamId: null, config: {} },
              ],
              meta: { count: 2 },
            };
      },
      'flow_nodes:duplicate': () => ({ data: { id: 9, upstreamId: 2 } }),
    });
    const router = createMemoryRouter([{ path: '/workflow/canvas', element: <WorkflowCanvasPage /> }], {
      initialEntries: ['/workflow/canvas?workflowId=172'],
    });
    render(<RouterProvider router={router} />);
    await screen.findByText('订单同步 · 流程编排');

    await userEvent.click(screen.getAllByRole('button', { name: '复制节点' })[0]);
    expect(await screen.findByText('已复制该节点。')).toBeTruthy();

    await router.navigate('/workflow/canvas?workflowId=173');
    await waitFor(() => {
      expect(screen.queryByText('已复制该节点。')).toBeNull();
    });
    expect(await screen.findByText('第二版节点')).toBeTruthy();
  });
});
