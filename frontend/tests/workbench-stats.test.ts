import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchMyPendingTaskStats, fetchMyTaskTypeStats, TASK_STATS_PAGE_SIZE } from '../src/api/workbench';
import { getHttpClient, resetAuthContext, setApiBase, setAuthContext } from '../src/api/client';

/**
 * 工作台待处理统计的契约测试（受控 adapter，本机数据）。
 *
 * 覆盖：按 `stats.pending` 累加**所有分页**、pageSize 依原生 handler 默认/上限 200、
 * 依据 `meta.hasNext` 翻页、某页失败时**不返回部分累计**、
 * `userWorkflowTasks` 没有 title/status 字段因此只按 type+stats 呈现。
 */

interface Captured {
  url?: string;
  method?: string;
  params?: Record<string, unknown>;
}

let captured: Captured[] = [];
let responder: (config: InternalAxiosRequestConfig) => { status: number; body: unknown };

function installAdapter(): void {
  const client = getHttpClient();
  client.defaults.adapter = async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
    captured.push({
      url: config.url,
      method: config.method,
      params: config.params as Record<string, unknown>,
    });
    const { status, body } = responder(config);
    const response: AxiosResponse = {
      data: body,
      status,
      statusText: String(status),
      headers: {},
      config,
    };
    if (status >= 400) {
      throw new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', config, undefined, response);
    }
    return response;
  };
}

beforeEach(() => {
  window.localStorage.clear();
  setApiBase('/api');
  resetAuthContext();
  setAuthContext({ token: 'stats-token', role: null });
  captured = [];
  responder = () => ({ status: 200, body: { data: [] } });
  installAdapter();
});

afterEach(() => {
  resetAuthContext();
  window.localStorage.clear();
});

describe('userWorkflowTaskStats:listMine 分页统计', () => {
  it('累加所有分页的 stats.pending，并按原生 pageSize 上限翻页', async () => {
    responder = (config) => {
      const page = Number(config.params?.page ?? 1);
      if (page === 1) {
        return {
          status: 200,
          body: {
            data: [
              { workflowKey: 'wf-1', title: '流程 A', stats: { pending: 2, all: 5 } },
              { workflowKey: 'wf-2', title: '流程 B', stats: { pending: 3, all: 8 } },
            ],
            meta: { page: 1, pageSize: TASK_STATS_PAGE_SIZE, hasNext: true },
          },
        };
      }
      return {
        status: 200,
        body: {
          data: [{ workflowKey: 'wf-3', title: '流程 C', stats: { pending: 4, all: 9 } }],
          meta: { page: 2, pageSize: TASK_STATS_PAGE_SIZE, hasNext: false },
        },
      };
    };

    const result = await fetchMyPendingTaskStats();

    expect(result.pendingTotal).toBe(9);
    expect(result.allTotal).toBe(22);
    expect(result.workflowCount).toBe(3);
    expect(result.pages).toBe(2);
    // 两次请求都是 GET，pageSize 与原生上限一致，page 依次为 1、2。
    expect(captured).toHaveLength(2);
    expect(captured[0].method).toBe('get');
    expect(captured[0].url).toBe('userWorkflowTaskStats:listMine');
    expect(captured[0].params).toMatchObject({ page: 1, pageSize: 200 });
    expect(captured[1].params).toMatchObject({ page: 2, pageSize: 200 });
    // 不传 type：覆盖已注册的 manual + cc（说明文字里写明范围）。
    expect(captured[0].params).not.toHaveProperty('type');
    expect(result.scopeLabel).toContain('工作流');
  });

  it('空列表真实返回 0（不是"—"）', async () => {
    responder = () => ({
      status: 200,
      body: { data: [], meta: { page: 1, pageSize: 200, hasNext: false } },
    });

    const result = await fetchMyPendingTaskStats();

    expect(result.pendingTotal).toBe(0);
    expect(result.workflowCount).toBe(0);
    expect(result.pages).toBe(1);
  });

  it('某一页失败时抛错，绝不把部分累计当作总数', async () => {
    responder = (config) => {
      const page = Number(config.params?.page ?? 1);
      if (page === 1) {
        return {
          status: 200,
          body: {
            data: [{ workflowKey: 'wf-1', title: '流程 A', stats: { pending: 2, all: 5 } }],
            meta: { page: 1, pageSize: TASK_STATS_PAGE_SIZE, hasNext: true },
          },
        };
      }
      return { status: 500, body: { errors: [{ message: 'boom' }] } };
    };

    await expect(fetchMyPendingTaskStats()).rejects.toMatchObject({ kind: 'backend-unavailable' });
    // 第二页确实被请求过，但调用方拿不到任何"部分总数"。
    expect(captured).toHaveLength(2);
  });

  it('某页网络中断同样不返回部分累计', async () => {
    responder = (config) => {
      const page = Number(config.params?.page ?? 1);
      if (page === 1) {
        return {
          status: 200,
          body: {
            data: [{ workflowKey: 'wf-1', title: '流程 A', stats: { pending: 2, all: 5 } }],
            meta: { page: 1, pageSize: 200, hasNext: true },
          },
        };
      }
      throw new AxiosError('Network Error', 'ERR_NETWORK');
    };

    await expect(fetchMyPendingTaskStats()).rejects.toMatchObject({ kind: 'network' });
  });

  it('meta.hasNext 缺失时按"没有下一页"处理（不无限翻页）', async () => {
    responder = () => ({
      status: 200,
      body: { data: [{ workflowKey: 'wf-1', stats: { pending: 1, all: 1 } }] },
    });

    const result = await fetchMyPendingTaskStats();

    expect(result.pages).toBe(1);
    expect(result.pendingTotal).toBe(1);
    expect(captured).toHaveLength(1);
  });
});

describe('userWorkflowTasks:listMine 类型统计', () => {
  it('只有 id/type/stats 字段，meta.count 表示统计行数而不是待办条数', async () => {
    responder = () => ({
      status: 200,
      body: {
        data: [
          { id: 1, type: 'manual', stats: { pending: 2, all: 6 } },
          { id: 2, type: 'cc', stats: { pending: 1, all: 3 } },
        ],
        meta: { count: 2, page: 1, pageSize: 50 },
      },
    });

    const result = await fetchMyTaskTypeStats();

    expect(result.rows.map((row) => row.type)).toEqual(['manual', 'cc']);
    expect(result.rowCount).toBe(2);
    expect(captured[0].method).toBe('get');
    expect(captured[0].params).toMatchObject({ pageSize: 50 });
    // 行里没有 title / status（原生集合定义如此）。
    expect(result.rows[0]).not.toHaveProperty('title');
    expect(result.rows[0]).not.toHaveProperty('status');
  });
});
