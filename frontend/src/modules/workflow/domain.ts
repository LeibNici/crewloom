import { api } from '../../api/client';
import type { ApiListMeta, ListParams } from '../../api/types';
import { asRecord, readArray, readBoolean, readId, readNumber, readString } from './format';

/**
 * 工作流域的真实只读数据访问（组 C 独占）。
 *
 * 契约依据（十页闭环 + 13000 实测实现约束，不在此重新论证）：
 *  - 版本模型是 `key` + `current` + 同 key 多条；**没有 publish 动作**，启停即由
 *    `workflows:update { enabled }` 触发原生 `onBeforeSave` 维护 `current`；
 *  - 读取某流程节点：`flow_nodes:list?filter={"workflowId":N}`（`workflows/<id>/flow_nodes:list`
 *    在 2.2.20 返回 500，不使用）；
 *  - 执行绑定的是**具体版本 id**（`executions.workflowId`），不是 `key`；
 *  - 执行/作业状态是数字枚举（见 labels.ts）。
 *
 * 这里只做真实调用与形状判读，不做假数据、不在前端复制服务端规则。
 */

export const PAGE_SIZE = 20;
export const NODE_PAGE_SIZE = 200;

export interface WorkflowRow {
  id: string;
  title: string;
  key: string | null;
  current: boolean;
  enabled: boolean;
  sync: boolean;
  type: string | null;
  executed: number | null;
  versionExecuted: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  categories: Array<{ id: string; title: string }>;
  raw: Record<string, unknown>;
}

export interface WorkflowCategory {
  id: string;
  title: string;
}

export interface ExecutionRow {
  id: string;
  workflowId: string | null;
  status: number | null;
  reason: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  workflowTitle: string | null;
  workflowKey: string | null;
  raw: Record<string, unknown>;
}

export interface FlowNodeRow {
  id: string;
  key: string | null;
  title: string | null;
  type: string | null;
  upstreamId: string | null;
  downstreamId: string | null;
  branchIndex: number | null;
  config: unknown;
  raw: Record<string, unknown>;
}

export interface JobRow {
  id: string;
  nodeId: string | null;
  nodeKey: string | null;
  status: number | null;
  result: unknown;
  meta: unknown;
  log: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  raw: Record<string, unknown>;
}

export function toWorkflowRow(item: unknown): WorkflowRow {
  const record = asRecord(item) ?? {};
  return {
    id: readId(item) ?? '',
    title: readString(item, 'title') ?? '（未命名流程）',
    key: readString(item, 'key'),
    current: readBoolean(item, 'current') === true,
    enabled: readBoolean(item, 'enabled') === true,
    sync: readBoolean(item, 'sync') === true,
    type: readString(item, 'type'),
    executed: readNumber(item, 'executed'),
    versionExecuted: readNumber(asRecord(record.versionStats), 'executed'),
    createdAt: readString(item, 'createdAt'),
    updatedAt: readString(item, 'updatedAt'),
    categories: readArray(item, 'categories')
      .map((entry) => ({ id: readId(entry) ?? '', title: readString(entry, 'title') ?? '' }))
      .filter((entry) => entry.id !== ''),
    raw: record,
  };
}

export function toExecutionRow(item: unknown): ExecutionRow {
  const workflow = asRecord(asRecord(item)?.workflow);
  return {
    id: readId(item) ?? '',
    workflowId: readId(item, 'workflowId'),
    status: readNumber(item, 'status'),
    reason: readString(item, 'reason'),
    createdAt: readString(item, 'createdAt'),
    updatedAt: readString(item, 'updatedAt'),
    startedAt: readString(item, 'startedAt'),
    finishedAt: readString(item, 'finishedAt'),
    workflowTitle: readString(workflow, 'title'),
    workflowKey: readString(workflow, 'key'),
    raw: asRecord(item) ?? {},
  };
}

export function toFlowNodeRow(item: unknown): FlowNodeRow {
  return {
    id: readId(item) ?? '',
    key: readString(item, 'key'),
    title: readString(item, 'title'),
    type: readString(item, 'type'),
    upstreamId: readId(item, 'upstreamId'),
    downstreamId: readId(item, 'downstreamId'),
    branchIndex: readNumber(item, 'branchIndex'),
    config: asRecord(item) ? asRecord(item)!.config : undefined,
    raw: asRecord(item) ?? {},
  };
}

export function toJobRow(item: unknown): JobRow {
  return {
    id: readId(item) ?? '',
    nodeId: readId(item, 'nodeId'),
    nodeKey: readString(item, 'nodeKey'),
    status: readNumber(item, 'status'),
    result: asRecord(item)?.result,
    meta: asRecord(item)?.meta,
    log: readString(item, 'log'),
    startedAt: readString(item, 'startedAt'),
    updatedAt: readString(item, 'updatedAt'),
    raw: asRecord(item) ?? {},
  };
}

export interface ListResult<T> {
  rows: T[];
  meta: ApiListMeta;
  total: number | null;
}

function totalOf(meta: ApiListMeta | undefined): number | null {
  return typeof meta?.count === 'number' ? meta.count : null;
}

/** 流程列表：带同组版本统计与分类。 */
export async function fetchWorkflows(params: {
  page: number;
  pageSize?: number;
  filter?: Record<string, unknown>;
  sort?: string[];
}): Promise<ListResult<WorkflowRow>> {
  const result = await api.resourceAction<unknown[]>('workflows', 'list', {
    params: {
      page: params.page,
      pageSize: params.pageSize ?? PAGE_SIZE,
      sort: params.sort ?? ['-id'],
      appends: ['versionStats', 'categories'],
      ...(params.filter && Object.keys(params.filter).length > 0
        ? { filter: params.filter }
        : {}),
    } satisfies ListParams,
  });
  const rows = Array.isArray(result.data) ? result.data.map(toWorkflowRow) : [];
  return { rows, meta: result.meta ?? {}, total: totalOf(result.meta) };
}

export async function fetchWorkflow(id: string): Promise<WorkflowRow | null> {
  const result = await api.resourceAction<unknown>('workflows', 'get', {
    params: { filterByTk: id, appends: ['versionStats', 'categories'] },
  });
  return result.data ? toWorkflowRow(result.data) : null;
}

/** 同一逻辑流程（同 `key`）的全部版本；用于版本切换与服务端原语义展示。 */
export async function fetchWorkflowRevisions(key: string): Promise<WorkflowRow[]> {
  const result = await api.resourceAction<unknown[]>('workflows', 'list', {
    params: {
      filter: { key },
      sort: ['-id'],
      paginate: false,
      fields: ['id', 'title', 'key', 'enabled', 'current', 'createdAt', 'updatedAt', 'versionStats'],
    },
  });
  return Array.isArray(result.data) ? result.data.map(toWorkflowRow) : [];
}

export async function fetchWorkflowCategories(): Promise<WorkflowCategory[]> {
  const result = await api.resourceAction<unknown[]>('workflowCategories', 'list', {
    params: { pageSize: 200, sort: ['-id'] },
  });
  const rows = Array.isArray(result.data) ? result.data : [];
  return rows
    .map((entry) => ({ id: readId(entry) ?? '', title: readString(entry, 'title') ?? '' }))
    .filter((entry) => entry.id !== '');
}

/** 某流程版本的节点清单；用实测可用的 `flow_nodes:list` + workflowId 过滤。 */
export async function fetchFlowNodes(workflowId: string): Promise<FlowNodeRow[]> {
  const result = await api.resourceAction<unknown[]>('flow_nodes', 'list', {
    params: { filter: { workflowId }, pageSize: NODE_PAGE_SIZE, sort: ['id'] },
  });
  return Array.isArray(result.data) ? result.data.map(toFlowNodeRow) : [];
}

/** 执行记录列表：支持流程、状态、时间范围筛选。 */
export async function fetchExecutions(params: {
  page: number;
  pageSize?: number;
  filter?: Record<string, unknown>;
}): Promise<ListResult<ExecutionRow>> {
  const result = await api.resourceAction<unknown[]>('executions', 'list', {
    params: {
      page: params.page,
      pageSize: params.pageSize ?? PAGE_SIZE,
      sort: ['-id'],
      appends: ['workflow'],
      ...(params.filter && Object.keys(params.filter).length > 0
        ? { filter: params.filter }
        : {}),
    } satisfies ListParams,
  });
  const rows = Array.isArray(result.data) ? result.data.map(toExecutionRow) : [];
  return { rows, meta: result.meta ?? {}, total: totalOf(result.meta) };
}

export async function fetchExecution(id: string): Promise<ExecutionRow | null> {
  const result = await api.resourceAction<unknown>('executions', 'get', {
    params: { filterByTk: id, appends: ['workflow'] },
  });
  return result.data ? toExecutionRow(result.data) : null;
}

/**
 * 某次执行的作业（节点级输入输出）。
 *
 * 刻意**不**递归展开：只取本执行的作业，`jobs` 的关联不追加 `node.jobs` 之类的嵌套链。
 */
export async function fetchJobs(executionId: string): Promise<JobRow[]> {
  const result = await api.resourceAction<unknown[]>('jobs', 'list', {
    params: { filter: { executionId }, pageSize: NODE_PAGE_SIZE, sort: ['id'] },
  });
  return Array.isArray(result.data) ? result.data.map(toJobRow) : [];
}

/** 流程简表（执行筛选下拉与详情关联展示用）。 */
export async function fetchWorkflowOptions(): Promise<WorkflowRow[]> {
  const result = await api.resourceAction<unknown[]>('workflows', 'list', {
    params: { pageSize: 200, sort: ['-id'], fields: ['id', 'title', 'key', 'current', 'enabled'] },
  });
  return Array.isArray(result.data) ? result.data.map(toWorkflowRow) : [];
}
