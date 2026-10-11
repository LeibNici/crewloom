import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { beforeEach, describe, expect, it } from 'vitest';
import { getHttpClient, setAuthContext } from '../../../src/api/client';
import { fetchManualTasks } from '../../../src/modules/tasks/domain';

/**
 * TD-01 人工待办的读取契约。
 *
 * 回归背景：真实 `workflowManualTasks:listMine` 只按 `userId` 过滤（不过滤状态），
 * 原生"待处理"页签显式带 `status: 0`。本页是"我的待处理"，必须发送同一过滤条件，
 * 否则任务被处理后会继续显示成待处理。
 */
describe('TD-01 人工待办列表读取契约', () => {
  let captured: Array<{ url?: string; params?: Record<string, unknown> }> = [];

  beforeEach(() => {
    captured = [];
    setAuthContext({ token: 'test-token', role: null });
    const client = getHttpClient();
    client.defaults.adapter = async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
      captured.push({ url: config.url, params: config.params as Record<string, unknown> | undefined });
      return { data: { data: [], meta: { count: 0 } }, status: 200, statusText: '200', headers: {}, config };
    };
  });

  it('按真实 listMine 契约发送 status=0 过滤与 appends', async () => {
    await fetchManualTasks({ page: 1, appends: ['node', 'workflow'] });
    expect(captured).toHaveLength(1);
    expect(String(captured[0].url)).toContain('workflowManualTasks:listMine');
    // `filter` 与 SDK 行为一致地序列化成 JSON 字符串。
    expect(captured[0].params?.filter).toBe(JSON.stringify({ status: 0 }));
    expect(captured[0].params?.appends).toEqual(['node', 'workflow']);
  });
});
