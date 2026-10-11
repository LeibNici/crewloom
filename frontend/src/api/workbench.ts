import { api } from './client';
import type { ApiListMeta } from './types';

/**
 * 工作台使用的只读接口封装。全部为真实后端调用，不做示例数据。
 *
 * 统计口径（依据 NocoBase 2.2.22 固定源码，对应 handler 行号见交付报告）：
 *  - `userWorkflowTaskStats:listMine`（plugin-workflow/src/server/actions/userWorkflowTaskStats.ts）
 *    handler 先按 `userId (+ type) + all > 0` 取出**全部**统计行，按 `workflowKey` 聚合出
 *    `stats.pending/all`，再用 workflows（`current: true`、`title $includes search`）
 *    分页渲染"流程行"：`{ rows, page, pageSize, hasNext }` → 经 dataWrapping 变成
 *    `{ data: rows, meta: { page, pageSize, hasNext } }`（**没有 count**）。
 *    `pageSize` 默认与上限都是 **200**，跨页必须累加 `stats.pending`。
 *    `type` 取值集合 = `registerTaskStatsProvider` 注册的类型，本版本只有 `manual`（人工待办）
 *    与 `cc`（抄送）；不传 `type` 即覆盖这两个已注册类型。这**不是**跨来源"全部待办"
 *    （AI 会话任务等其它来源不在其中）。
 *  - 行内 `title` 是**流程标题**，不是待办标题。
 *  - `userWorkflowTasks:listMine` 是 `actions.list`（filter userId），行只有
 *    `{ id, userId, type, stats }`（集合定义无 title/status 字段），`meta.count` 是
 *    "有多少条任务类型统计"，不是待办条数；`stats.pending/all` 是该类型下所有流程的
 *    物化全量合计（`refreshUserWorkflowTaskTypeStats`）。
 */

/** 原生 `userWorkflowTaskStats:listMine` 的一行（按流程聚合）。 */
export interface WorkflowTaskStatsRow {
  workflowKey: string;
  /** 流程标题（不是待办标题）。 */
  title?: string | null;
  stats: {
    pending: number;
    all: number;
  };
}

/** 原生 `userWorkflowTasks:listMine` 的一行（按任务类型聚合）。 */
export interface WorkflowTaskTypeRow {
  id: number | string;
  type: string;
  stats: {
    pending: number;
    all: number;
  };
}

export interface ConversationSummary {
  /**
   * 会话标识。
   *
   * 13000（2.2.20）实测：`aiConversations:list` 的列表项**没有 `id`**，标识就是 `sessionId`
   * （与 2.2.22 源码一致：`sendMessages` / `getMessages` 都用它）。这是实测实现约束，
   * 不是版本差异；实现上不得再读 `id`，否则界面会显示"会话 undefined"。
   */
  sessionId: string;
  title?: string | null;
  updatedAt?: string | null;
  aiEmployeeUsername?: string | null;
  read?: boolean | null;
  [key: string]: unknown;
}

export interface AiEmployeeSummary {
  id?: number | string;
  username?: string | null;
  nickname?: string | null;
  position?: string | null;
  bio?: string | null;
  avatar?: string | null;
  enabled?: boolean | null;
  [key: string]: unknown;
}

export interface CountResult<T = unknown> {
  items: T[];
  count: number | null;
  meta: ApiListMeta | undefined;
}

function toCountResult<T>(result: { data: unknown; meta?: ApiListMeta }): CountResult<T> {
  const items = Array.isArray(result.data) ? (result.data as T[]) : [];
  const count = typeof result.meta?.count === 'number' ? result.meta.count : null;
  return { items, count, meta: result.meta };
}

/** 原生 handler 的默认值与上限都是 200。 */
export const TASK_STATS_PAGE_SIZE = 200;
const MAX_TASK_STATS_PAGES = 50;

export interface PendingTaskStats {
  /** 所有分页 `stats.pending` 之和；跨页失败时本函数直接抛错，不返回部分累计。 */
  pendingTotal: number;
  /** 所有分页 `stats.all` 之和（历史累计口径）。 */
  allTotal: number;
  /** 涉及的流程数（所有分页行数）。 */
  workflowCount: number;
  rows: WorkflowTaskStatsRow[];
  pages: number;
  /** 数据来源说明（展示用，不含内部端点名）。 */
  scopeLabel: string;
}

/**
 * 本人工作流待处理任务的完整统计。
 *
 * 按 `stats.pending` 累加**所有分页**；任一页失败即抛错，绝不把部分累计当作总数。
 */
export async function fetchMyPendingTaskStats(): Promise<PendingTaskStats> {
  const rows: WorkflowTaskStatsRow[] = [];
  let page = 1;
  let pages = 0;
  for (let guard = 0; guard < MAX_TASK_STATS_PAGES; guard += 1) {
    const result = await api.resourceAction<WorkflowTaskStatsRow[]>('userWorkflowTaskStats', 'listMine', {
      params: { page, pageSize: TASK_STATS_PAGE_SIZE },
    });
    pages += 1;
    if (Array.isArray(result.data)) rows.push(...result.data);
    if (result.meta?.hasNext !== true) {
      return {
        pendingTotal: sum(rows, (row) => row.stats?.pending),
        allTotal: sum(rows, (row) => row.stats?.all),
        workflowCount: rows.length,
        rows,
        pages,
        scopeLabel: '本人工作流待处理（人工待办与抄送，按流程汇总）',
      };
    }
    page += 1;
  }
  throw new Error('待处理统计分页超出安全上限，未取得完整结果');
}

function sum(rows: WorkflowTaskStatsRow[], pick: (row: WorkflowTaskStatsRow) => unknown): number {
  return rows.reduce((total, row) => total + (Number(pick(row)) || 0), 0);
}

export interface TaskTypeStats {
  rows: WorkflowTaskTypeRow[];
  /** 任务类型统计行数（不是待办条数）。 */
  rowCount: number | null;
}

/**
 * 本人工作流任务的"按类型"物化合计（`userWorkflowTasks:listMine`）。
 *
 * 行内没有 title/status 字段，因此界面只按 `type` + `stats` 展示，不伪造任务标题。
 */
export async function fetchMyTaskTypeStats(): Promise<TaskTypeStats> {
  const result = await api.resourceAction<WorkflowTaskTypeRow[]>('userWorkflowTasks', 'listMine', {
    params: { pageSize: 50 },
  });
  const items = Array.isArray(result.data) ? result.data : [];
  const rowCount = typeof result.meta?.count === 'number' ? result.meta.count : null;
  return { rows: items, rowCount };
}

export async function fetchMyConversations(): Promise<CountResult<ConversationSummary>> {
  const result = await api.resourceAction<ConversationSummary[]>('aiConversations', 'list', {
    params: { pageSize: 5, sort: ['-updatedAt'] },
  });
  return toCountResult<ConversationSummary>(result);
}

export async function fetchMyEmployees(): Promise<CountResult<AiEmployeeSummary>> {
  const result = await api.resourceAction<AiEmployeeSummary[]>('aiEmployees', 'listByUser', {
    params: { pageSize: 6 },
  });
  return toCountResult<AiEmployeeSummary>(result);
}
