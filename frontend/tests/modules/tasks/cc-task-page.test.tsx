// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getHttpClient, setAuthContext } from '../../../src/api/client';
import { CcListPage, CcTaskPage } from '../../../src/modules/tasks/pages/CcTaskPage';
import type { ModulePageProps } from '../../../src/modules/types';
import type { CcTaskRow } from '../../../src/modules/tasks/domain';

/**
 * TD-04 抄送的**非空受控交互**。
 *
 * 覆盖评审要求：非空读/未读/全部已读的真实请求与状态回显，
 * 并保持"已读不推进流程"的文案（抄送只维护自己的阅读标记）。
 */

interface Captured {
  method?: string;
  url?: string;
  params?: Record<string, unknown>;
  data?: unknown;
}

let captured: Captured[] = [];

function install(rows: unknown[]): void {
  const client = getHttpClient();
  client.defaults.adapter = async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
    captured.push({
      method: config.method,
      url: config.url,
      params: config.params as Record<string, unknown> | undefined,
      data: config.data,
    });
    const url = String(config.url ?? '');
    if (url.includes('workflowCcTasks:listMine')) {
      return { data: { data: rows, meta: { count: rows.length } }, status: 200, statusText: '200', headers: {}, config };
    }
    return { data: { data: {} }, status: 200, statusText: '200', headers: {}, config };
  };
}

const props = {} as ModulePageProps;

beforeEach(() => {
  captured = [];
  setAuthContext({ token: 'test-token', role: null });
});

describe('TD-04 抄送列表（非空）', () => {
  it('展示未读/已读两条记录，并可一键全部标为已读', async () => {
    install([
      { id: 900, status: 0, createdAt: '2026-10-11T01:00:00.000Z', workflow: { title: '报销审批' }, node: { title: '抄送节点' } },
      { id: 901, status: 1, readAt: '2026-10-11T02:00:00.000Z', createdAt: '2026-10-10T01:00:00.000Z', workflow: { title: '采购审批' }, node: { title: '抄送节点' } },
    ]);
    const router = createMemoryRouter([{ path: '/tasks/cc-list', element: <CcListPage /> }], {
      initialEntries: ['/tasks/cc-list'],
    });
    render(<RouterProvider router={router} />);

    expect(await screen.findByText('报销审批')).toBeTruthy();
    expect(screen.getByText('未读')).toBeTruthy();
    expect(screen.getByText('已读')).toBeTruthy();
    expect(screen.getByText(/共 2 条/)).toBeTruthy();
    // 已读 ≠ 推进流程的说明必须在页面上。
    expect(screen.getByText(/标记已读不会让流程继续/)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: '全部标为已读' }));
    await waitFor(() => expect(captured.some((entry) => String(entry.url).includes('workflowCcTasks:readAll'))).toBe(true));
    const readAll = captured.find((entry) => String(entry.url).includes('workflowCcTasks:readAll'));
    expect(readAll?.method).toBe('post');
    expect(await screen.findByText(/这不会推进任何流程/)).toBeTruthy();
  });
});

describe('TD-04 抄送详情（非空，受控读写）', () => {
  it('未读详情可标记已读，并重新读取详情显示最新状态', async () => {
    let status = 0;
    const detail = (): CcTaskRow => ({
      id: '900',
      status,
      readAt: status === 1 ? '2026-10-11T03:00:00.000Z' : null,
      createdAt: '2026-10-11T01:00:00.000Z',
      workflowId: '172',
      nodeId: '2410',
      workflowTitle: '报销审批',
      nodeTitle: '抄送节点',
      nodeType: 'cc',
      raw: {},
    });
    const fetchDetail = vi.fn(async () => detail());
    install([]);

    const router = createMemoryRouter(
      [{ path: '/tasks/cc', element: <CcTaskPage {...props} deps={{ fetchDetail }} /> }],
      { initialEntries: ['/tasks/cc?id=900'] },
    );
    render(<RouterProvider router={router} />);

    expect(await screen.findByText('未读')).toBeTruthy();
    expect(screen.getByText('报销审批')).toBeTruthy();
    expect(screen.getByText('尚未阅读')).toBeTruthy();

    status = 1;
    await userEvent.click(screen.getByRole('button', { name: '标记为已读' }));
    await waitFor(() => expect(captured.some((entry) => String(entry.url).includes('workflowCcTasks:read'))).toBe(true));

    const read = captured.find((entry) => String(entry.url).includes('workflowCcTasks:read'));
    expect(read?.method).toBe('post');
    expect(read?.params).toMatchObject({ filterByTk: '900' });
    // 只读动作不应带任何业务 values（body 为空对象，序列化后即 `{}`）。
    expect(JSON.parse(String(read?.data ?? '{}'))).toEqual({});
    expect(await screen.findByText(/已标记为已读。注意：这不会推进流程。/)).toBeTruthy();
    // 处理状态回显：详情被重新读取，页面显示已读状态。
    expect(await screen.findByText('已读')).toBeTruthy();
    expect(fetchDetail.mock.calls.length).toBeGreaterThan(1);
  });

  it('已读详情可改回未读（未读动作只重置自己的阅读标记）', async () => {
    let status: number | null = 1;
    const fetchDetail = vi.fn(async () => ({
      id: '901',
      status,
      readAt: status === 1 ? '2026-10-11T02:00:00.000Z' : null,
      createdAt: '2026-10-10T01:00:00.000Z',
      workflowId: '172',
      nodeId: '2411',
      workflowTitle: '采购审批',
      nodeTitle: '抄送节点',
      nodeType: 'cc',
      raw: {},
    }));
    install([]);
    const router = createMemoryRouter(
      [{ path: '/tasks/cc', element: <CcTaskPage {...props} deps={{ fetchDetail }} /> }],
      { initialEntries: ['/tasks/cc?id=901'] },
    );
    render(<RouterProvider router={router} />);

    expect(await screen.findByText('已读')).toBeTruthy();
    status = 0;
    await userEvent.click(screen.getByRole('button', { name: '标记为未读' }));
    await waitFor(() => expect(captured.some((entry) => String(entry.url).includes('workflowCcTasks:unread'))).toBe(true));
    const unread = captured.find((entry) => String(entry.url).includes('workflowCcTasks:unread'));
    expect(unread?.method).toBe('post');
    expect(unread?.params).toMatchObject({ filterByTk: '901' });
    expect(await screen.findByText('已标记为未读。')).toBeTruthy();
  });
});
