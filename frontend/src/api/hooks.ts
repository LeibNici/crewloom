import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { resourceGet, resourceList } from './client';
import { CrewloomError, toUserMessage } from './errors';
import type { ApiListMeta, ListParams } from './types';

/**
 * 列表/详情的公共取数钩子（**公共负责人唯一维护**）。
 *
 * 只做三件已有能力之上的真实共性，不新建通用 CRUD 平台：
 *  1. 统一走 `src/api/client.ts` 的 SDK 请求管线（认证、角色、续期、异步世代都在那里）；
 *  2. 把结果归一到**六态**，让"无权限 / 未登录 / 空数据 / 未知失败"不再混用同一句文案；
 *  3. 暴露 `refetch` 与原始错误，页面自己决定要不要展示技术细节（默认只展示中文 userMessage）。
 *
 * 状态含义（不得合并）：
 *  - `loading`      正在读取；
 *  - `ready`        读到数据（`rows.length > 0`）；
 *  - `empty`        后端明确返回了空结果集（有权限，只是没有数据）；
 *  - `denied`       后端明确拒绝（403）；
 *  - `unauthorized` 未登录 / 会话失效 / 角色失效（由请求层的状态机接管）；
 *  - `error`        其它失败（网络、5xx、404、参数错误…）：可重试，**不当作无权限**。
 */
export type ResourceState = 'loading' | 'ready' | 'empty' | 'denied' | 'unauthorized' | 'error';

export interface ResourceListResult<T> {
  state: ResourceState;
  rows: T[];
  meta: ApiListMeta;
  /** `meta.count`（后端分页总数）；非分页响应为 null。 */
  total: number | null;
  error: CrewloomError | null;
  /** 面向用户的中文提示；成功时为 null。 */
  message: string | null;
  isFetching: boolean;
  refetch: () => void;
}

export interface UseResourceListOptions {
  params?: ListParams;
  enabled?: boolean;
  /** 数据源上下文（缺省 main）。 */
  dataSource?: string;
  /** 额外查询键片段，用于区分同资源不同筛选。 */
  keySuffix?: unknown;
  staleTime?: number;
}

function asCrewloomError(error: unknown): CrewloomError | null {
  if (!error) return null;
  if (error instanceof CrewloomError) return error;
  return new CrewloomError({
    kind: 'unexpected',
    userMessage: toUserMessage(error),
    detail: error instanceof Error ? error.message : String(error),
  });
}

function classify(error: CrewloomError | null, isEmpty: boolean): ResourceState {
  if (!error) return isEmpty ? 'empty' : 'ready';
  if (error.kind === 'forbidden') return 'denied';
  if (error.kind === 'unauthenticated' || error.kind === 'role-invalid') return 'unauthorized';
  return 'error';
}

export function useResourceList<T>(
  resource: string,
  options: UseResourceListOptions = {},
): ResourceListResult<T> {
  const { params, enabled = true, dataSource, keySuffix, staleTime } = options;
  const query = useQuery({
    queryKey: ['resource', resource, 'list', params ?? null, dataSource ?? 'main', keySuffix ?? null],
    queryFn: () => resourceList<T>(resource, params, { dataSource }),
    enabled,
    staleTime,
  });

  const error = asCrewloomError(query.error);
  const rows = useMemo(() => (query.data?.data ?? []) as T[], [query.data]);
  const meta = (query.data?.meta ?? {}) as ApiListMeta;

  return {
    state: query.isLoading ? 'loading' : classify(error, rows.length === 0),
    rows,
    meta,
    total: typeof meta.count === 'number' ? meta.count : null,
    error,
    message: error ? toUserMessage(error) : null,
    isFetching: query.isFetching,
    refetch: () => void query.refetch(),
  };
}

export interface ResourceGetResult<T> {
  state: ResourceState;
  data: T | null;
  error: CrewloomError | null;
  message: string | null;
  isFetching: boolean;
  refetch: () => void;
}

export interface UseResourceGetOptions {
  params?: ListParams;
  enabled?: boolean;
  dataSource?: string;
  staleTime?: number;
}

export function useResourceGet<T>(
  resource: string,
  filterByTk: string | number | null | undefined,
  options: UseResourceGetOptions = {},
): ResourceGetResult<T> {
  const { params, enabled = true, dataSource, staleTime } = options;
  const query = useQuery({
    queryKey: ['resource', resource, 'get', filterByTk ?? null, params ?? null, dataSource ?? 'main'],
    queryFn: () => resourceGet<T>(resource, filterByTk as string | number, params, { dataSource }),
    enabled: enabled && filterByTk !== null && filterByTk !== undefined,
    staleTime,
  });

  const error = asCrewloomError(query.error);
  const data = (query.data?.data ?? null) as T | null;

  return {
    state: query.isLoading ? 'loading' : classify(error, data === null),
    data,
    error,
    message: error ? toUserMessage(error) : null,
    isFetching: query.isFetching,
    refetch: () => void query.refetch(),
  };
}
