import { api } from '../../api/client';
import type { ApiListMeta, ListParams } from '../../api/types';
import { asRecord, readArray, readBoolean, readId, readNumber, readString } from '../workflow/format';

/**
 * 任务与待办模块的真实只读数据访问（组 C 独占）。
 *
 * 契约依据（十页闭环 + 32 页矩阵，不重复论证）：
 *  - 三个来源彼此独立、各自分页：人工待办 `workflowManualTasks:listMine`、
 *    抄送 `workflowCcTasks:listMine`、AI 任务 `aiWorkflowTasks:list`（handler 内部按当前用户过滤）；
 *  - **没有**跨来源的全局分页/排序/总计数接口（那是候选建议，不是现有能力），
 *    因此界面按来源分栏、各自分页，并把"本来源当前页"与"全部"分开表述；
 *  - 统计 `userWorkflowTaskStats:listMine` 的行是**按流程聚合**的（行内 title 是流程标题），
 *    `stats.pending/all` 是该类型下的物化合计；`pageSize` 默认与上限均为 200，跨页必须累加；
 *  - AI 未读数走 `aiWorkflowTasks:unreadCount`。
 */

export type TaskSourceKey = 'manual' | 'cc' | 'ai';

export interface TaskStats {
  pending: number;
  all: number;
}

/** 人工待办（`workflowManualTasks:listMine`）。 */
export interface ManualTaskRow {
  id: string;
  status: number | null;
  userId: string | null;
  workflowId: string | null;
  nodeId: string | null;
  jobId: string | null;
  createdAt: string | null;
  workflowTitle: string | null;
  nodeTitle: string | null;
  nodeType: string | null;
  raw: Record<string, unknown>;
}

/** 抄送（`workflowCcTasks:listMine`）。 */
export interface CcTaskRow {
  id: string;
  status: number | null;
  readAt: string | null;
  createdAt: string | null;
  workflowId: string | null;
  nodeId: string | null;
  workflowTitle: string | null;
  nodeTitle: string | null;
  nodeType: string | null;
  raw: Record<string, unknown>;
}

/** AI 工作流任务（`aiWorkflowTasks:list`）。 */
export interface AiTaskRow {
  id: string;
  status: string | null;
  sessionId: string | null;
  jobId: string | null;
  jobStatus: number | null;
  acceptedUserId: string | null;
  read: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  raw: Record<string, unknown>;
}

export interface PageResult<T> {
  rows: T[];
  total: number | null;
  meta: ApiListMeta;
}

function totalOf(meta: ApiListMeta | undefined): number | null {
  return typeof meta?.count === 'number' ? meta.count : null;
}

function workflowOf(item: unknown): Record<string, unknown> | null {
  return asRecord(asRecord(item)?.workflow);
}

function nodeOf(item: unknown): Record<string, unknown> | null {
  return asRecord(asRecord(item)?.node);
}

export function toManualTaskRow(item: unknown): ManualTaskRow {
  const workflow = workflowOf(item);
  const node = nodeOf(item);
  return {
    id: readId(item) ?? '',
    status: readNumber(item, 'status'),
    userId: readId(item, 'userId'),
    workflowId: readId(item, 'workflowId'),
    nodeId: readId(item, 'nodeId'),
    jobId: readId(item, 'jobId'),
    createdAt: readString(item, 'createdAt'),
    workflowTitle: readString(workflow, 'title'),
    nodeTitle: readString(node, 'title'),
    nodeType: readString(node, 'type'),
    raw: asRecord(item) ?? {},
  };
}

export function toCcTaskRow(item: unknown): CcTaskRow {
  const workflow = workflowOf(item);
  const node = nodeOf(item);
  return {
    id: readId(item) ?? '',
    status: readNumber(item, 'status'),
    readAt: readString(item, 'readAt'),
    createdAt: readString(item, 'createdAt'),
    workflowId: readId(item, 'workflowId'),
    nodeId: readId(item, 'nodeId'),
    workflowTitle: readString(workflow, 'title'),
    nodeTitle: readString(node, 'title'),
    nodeType: readString(node, 'type'),
    raw: asRecord(item) ?? {},
  };
}

export function toAiTaskRow(item: unknown): AiTaskRow {
  return {
    id: readId(item) ?? '',
    status: readString(item, 'status'),
    sessionId: readString(item, 'sessionId'),
    jobId: readId(item, 'jobId'),
    jobStatus: readNumber(item, 'jobStatus'),
    acceptedUserId: readId(item, 'acceptedUserId'),
    read: readBoolean(item, 'read') === true,
    createdAt: readString(item, 'createdAt'),
    updatedAt: readString(item, 'updatedAt'),
    raw: asRecord(item) ?? {},
  };
}

export const TASK_PAGE_SIZE = 20;

export async function fetchManualTasks(params: {
  page: number;
  pageSize?: number;
  appends?: string[];
}): Promise<PageResult<ManualTaskRow>> {
  const result = await api.resourceAction<unknown[]>('workflowManualTasks', 'listMine', {
    params: {
      page: params.page,
      pageSize: params.pageSize ?? TASK_PAGE_SIZE,
      sort: ['-id'],
      appends: params.appends ?? ['node', 'workflow'],
      // 真实契约：`workflowManualTasks:listMine` 只按 `userId` 过滤，**不**区分状态；
      // 原生"待处理"页签显式带 `status: 0`（`tt.pending = { status: 0, ... }`）。
      // 本页是"我的待处理"，因此按同一契约显式过滤待处理，避免把已处理任务显示成待处理。
      filter: { status: 0 },
    } satisfies ListParams,
  });
  const rows = Array.isArray(result.data) ? result.data.map(toManualTaskRow) : [];
  return { rows, total: totalOf(result.meta), meta: result.meta ?? {} };
}

/** 人工待办详情：一次请求即带回渲染表单所需的 node/job/workflow/execution 关联。 */
export async function fetchManualTask(id: string): Promise<Record<string, unknown> | null> {
  const result = await api.resourceAction<unknown>('workflowManualTasks', 'get', {
    params: {
      filterByTk: id,
      // `user` 是 `workflowManualTasks` 真实的 belongsTo 关联（foreignKey `userId` → `users`），
      // 原生列表/详情就用它显示受理人（`fieldNames: { label: 'nickname', value: 'id' }`）。
      appends: ['node', 'job', 'workflow', 'workflow.nodes', 'execution', 'execution.jobs', 'user'],
    },
  });
  return result.data ? asRecord(result.data) : null;
}

export async function fetchCcTasks(params: { page: number; pageSize?: number }): Promise<PageResult<CcTaskRow>> {
  const result = await api.resourceAction<unknown[]>('workflowCcTasks', 'listMine', {
    params: {
      page: params.page,
      pageSize: params.pageSize ?? TASK_PAGE_SIZE,
      sort: ['-id'],
    } satisfies ListParams,
  });
  const rows = Array.isArray(result.data) ? result.data.map(toCcTaskRow) : [];
  return { rows, total: totalOf(result.meta), meta: result.meta ?? {} };
}

export async function fetchCcTask(id: string): Promise<CcTaskRow | null> {
  const result = await api.resourceAction<unknown>('workflowCcTasks', 'get', {
    params: { filterByTk: id },
  });
  return result.data ? toCcTaskRow(result.data) : null;
}

export async function fetchAiTasks(params: { page: number; pageSize?: number }): Promise<PageResult<AiTaskRow>> {
  const result = await api.resourceAction<unknown[]>('aiWorkflowTasks', 'list', {
    params: {
      page: params.page,
      pageSize: params.pageSize ?? TASK_PAGE_SIZE,
      sort: ['-id'],
    } satisfies ListParams,
  });
  const rows = Array.isArray(result.data) ? result.data.map(toAiTaskRow) : [];
  return { rows, total: totalOf(result.meta), meta: result.meta ?? {} };
}

/** AI 任务详情；`readonly` 由服务端按 status + acceptedUserId 计算。 */
export async function fetchAiTaskBySession(sessionId: string): Promise<Record<string, unknown> | null> {
  const result = await api.resourceAction<unknown>('aiWorkflowTasks', 'getBySession', {
    params: { sessionId },
  });
  return result.data ? asRecord(result.data) : null;
}

export async function fetchAiUnreadCount(): Promise<number | null> {
  const result = await api.resourceAction<unknown>('aiWorkflowTasks', 'unreadCount', {});
  const data = asRecord(result.data);
  const count = readNumber(data, 'count');
  return count;
}

export interface TaskStatsSummary {
  pendingTotal: number;
  allTotal: number;
  workflowCount: number;
  pages: number;
}

const TASK_STATS_PAGE_SIZE = 200;
const MAX_TASK_STATS_PAGES = 50;

/**
 * 本人工作流待处理统计（人工待办 + 抄送按流程聚合）。
 *
 * 逐页累加**所有**分页的 `stats.pending`；任一页失败即抛错，
 * 绝不把部分累计当作总数（沿用工作台的既有口径）。
 */
export async function fetchTaskStats(): Promise<TaskStatsSummary> {
  let page = 1;
  let pages = 0;
  let pendingTotal = 0;
  let allTotal = 0;
  let workflowCount = 0;
  for (let guard = 0; guard < MAX_TASK_STATS_PAGES; guard += 1) {
    const result = await api.resourceAction<unknown[]>('userWorkflowTaskStats', 'listMine', {
      params: { page, pageSize: TASK_STATS_PAGE_SIZE },
    });
    pages += 1;
    const rows = Array.isArray(result.data) ? result.data : [];
    if (result.meta?.hasNext !== true) {
      for (const row of rows) {
        const stats = asRecord(asRecord(row)?.stats);
        pendingTotal += readNumber(stats, 'pending') ?? 0;
        allTotal += readNumber(stats, 'all') ?? 0;
        workflowCount += 1;
      }
      return { pendingTotal, allTotal, workflowCount, pages };
    }
    for (const row of rows) {
      const stats = asRecord(asRecord(row)?.stats);
      pendingTotal += readNumber(stats, 'pending') ?? 0;
      allTotal += readNumber(stats, 'all') ?? 0;
      workflowCount += 1;
    }
    page += 1;
  }
  throw new Error('待处理统计分页超出安全上限，未取得完整结果');
}

/**
 * 人工待办详情里的完整渲染布局（`node.config.schema`）与处理配置。
 *
 * 这两个字段的形状由服务端人工节点定义决定（`ManualInstruction`），
 * 前端只做"取出来 → 交给渲染器"，不在前端重建 schema。
 */
export function manualSchemaOf(task: Record<string, unknown> | null): Record<string, unknown> | null {
  const node = asRecord(task?.node);
  const config = asRecord(node?.config);
  return asRecord(config?.schema);
}

export function manualFormsOf(task: Record<string, unknown> | null): Record<string, unknown> {
  const node = asRecord(task?.node);
  const config = asRecord(node?.config);
  return asRecord(config?.forms) ?? {};
}

export function manualAssigneesOf(task: Record<string, unknown> | null): unknown[] {
  const node = asRecord(task?.node);
  const config = asRecord(node?.config);
  return readArray(config, 'assignees');
}

/**
 * 这条待办的**实际受理人** id。
 *
 * 真实契约（2.2.20 与 2.2.22 发布源码逐字一致，已核对）：
 *  - `plugin-workflow-manual/src/server/collections/workflowManualTasks.ts`：
 *    任务自己有 `user` belongsTo（foreignKey `userId` → `users`）；
 *  - 同插件 `src/server/actions.ts`：`listMine` 只按 `{ userId: currentUser.id }` 过滤，
 *    `submit` 的资格判定是 `assignees.includes(currentUser.id) && task.userId === currentUser.id`；
 *  - 任务关联的 `job` 指向 `jobs`（`plugin-workflow/src/common/collections/jobs.ts`），
 *    该集合**没有** `userId` 字段，也没有任何 handler 把受理人写进作业。
 *
 * 因此受理人 id 只读任务自己的 `userId`：**不**读作业 `job.userId`（无此契约），
 * 也**不**读节点配置的 `assignees` 候选列表（那是候选人，不是这条待办的受理人）。
 */
export function manualAssigneeIdOf(
  task: Record<string, unknown> | null,
): string | number | null {
  return readId(asRecord(task), 'userId');
}

/**
 * 详情请求里 `appends=user` 带回来的受理人记录（取不到就是 `null`，不伪造姓名）。
 *
 * 与 `manualAssigneeIdOf` 同源：只认任务自己的 `user` 关联。
 * `jobs` 集合没有 `user` 关联，作业侧不存在可用的姓名来源，因此没有作业兜底。
 */
export function manualAssigneeUserOf(
  task: Record<string, unknown> | null,
): Record<string, unknown> | null {
  return asRecord(asRecord(task)?.user);
}

/** 关联字段的候选值来源（collection + 显示/取值字段）。 */
export interface AssociationTarget {
  collection: string;
  fieldNames?: { label?: string; value?: string };
}

/**
 * 从字段 schema 里读出关联目标。
 *
 * 只认 schema 自己声明的来源：`x-collection-field`（原生 `collection.field` 形式）、
 * `x-component-props.field.target`（CollectionField 的原生字段元数据）、
 * 或 `x-component-props.target`。读不到就返回 null —— 由关联组件退化为可自由输入的选择器，
 * 不猜测数据表。
 */
export function associationTargetOf(raw: Record<string, unknown> | null): AssociationTarget | null {
  const record = asRecord(raw);
  if (!record) return null;
  const componentProps = asRecord(record['x-component-props']) ?? {};
  const fieldMeta = asRecord(componentProps.field) ?? {};
  const uiProps = asRecord(asRecord(fieldMeta.uiSchema)?.['x-component-props']);
  const collectionField = readString(record, 'x-collection-field');
  const collection =
    readString(fieldMeta, 'target') ??
    readString(componentProps, 'target') ??
    (collectionField ? collectionField.split('.')[0] ?? null : null);
  if (!collection) return null;
  const fieldNames = asRecord(componentProps.fieldNames) ?? asRecord(uiProps?.fieldNames);
  const label = readString(fieldNames, 'label');
  const value = readString(fieldNames, 'value');
  return {
    collection,
    ...(label || value ? { fieldNames: { ...(label ? { label } : {}), ...(value ? { value } : {}) } } : {}),
  };
}

/**
 * 关联字段候选值：走与其它页面相同的 SDK 请求管线（认证、角色、续期与会话世代都在同一条链上）。
 * 只读列表；后端 ACL 决定返回哪些记录。
 */
export async function fetchAssociationOptions(
  target: AssociationTarget,
): Promise<Array<{ label: string; value: unknown }>> {
  const result = await api.resourceAction<unknown[]>(target.collection, 'list', {
    params: { pageSize: 50, sort: ['-id'] },
  });
  const rows = Array.isArray(result.data) ? result.data : [];
  const valueKey = target.fieldNames?.value ?? 'id';
  const labelKeys = target.fieldNames?.label
    ? [target.fieldNames.label]
    : ['title', 'nickname', 'username', 'name'];
  return rows
    .map((row) => {
      const record = asRecord(row) ?? {};
      const value = record[valueKey];
      let label: unknown;
      for (const key of labelKeys) {
        if (record[key] !== undefined && record[key] !== null && record[key] !== '') {
          label = record[key];
          break;
        }
      }
      return { label: label === undefined ? String(value ?? '') : String(label), value };
    })
    .filter((option) => option.value !== undefined && option.value !== null);
}

/** AI 任务详情里可能带回的工具消息（结构由服务端决定，取不到就返回空数组，不猜）。 */
export interface AiToolCallView {
  toolCallId: string;
  name: string;
  invokeStatus: string | null;
  messageId: string | null;
  args: unknown;
  content: unknown;
  userDecision: unknown;
  /**
   * 工具执行位置：`frontend` 表示由浏览器（原生 flow-engine）执行，`backend` 表示服务端执行。
   * 证据：`plugin-ai/dist/server/ai-employees/ai-conversations.js` 的 `parseMessageRow`
   * 写入 `toolCall.execution` / `toolCall.willInterrupt`。
   */
  execution: string | null;
  willInterrupt: boolean;
  auto: boolean | null;
  status: string | null;
}

function toolCallsOf(message: unknown): AiToolCallView[] {
  const record = asRecord(message);
  const messageId = readString(record, 'messageId') ?? readId(record, 'id');
  return readArray(record, 'toolCalls').map((entry) => {
    const call = asRecord(entry) ?? {};
    return {
      toolCallId: readId(call, 'id') ?? readString(call, 'toolCallId') ?? '',
      name: readString(call, 'name') ?? '未命名工具',
      invokeStatus: readString(call, 'invokeStatus'),
      messageId: readId(call, 'messageId') ?? messageId,
      args: call.args,
      content: call.content,
      userDecision: call.userDecision,
      execution: readString(call, 'execution'),
      willInterrupt: readBoolean(call, 'willInterrupt') === true,
      auto: readBoolean(call, 'auto'),
      status: readString(call, 'status'),
    };
  });
}

/**
 * 从 AI 任务详情中提取工具调用。
 *
 * 服务端 `aiWorkflowTasks:getBySession`（2.2.22）**不返回**工具消息，只返回任务字段 +
 * `readonly`/`config`/`aiEmployee`；这里仍按已知位置读取（历史/兼容形状），取不到就是空数组。
 */
export function aiToolCallsOf(task: Record<string, unknown> | null): AiToolCallView[] {
  if (!task) return [];
  for (const key of ['aiToolMessages', 'toolMessages', 'messages']) {
    const value = task[key];
    if (Array.isArray(value) && value.length > 0) {
      return value.flatMap((message) => toolCallsOf(message)).filter((call) => call.toolCallId !== '');
    }
  }
  const direct = readArray(task, 'toolCalls');
  if (direct.length > 0) return toolCallsOf(task);
  return [];
}

/**
 * 会话消息里提取工具调用。
 *
 * 证据：`plugin-ai/dist/server/ai-employees/ai-conversations.js` 的 `getMessages` 会为每条消息的
 * `toolCalls` 回填 `invokeStatus` / `execution` / `willInterrupt` / `status` / `content` / `userDecision`，
 * 这正是原生 ChatBox 用来渲染工具确认的数据。
 */
export function aiToolCallsOfMessages(rows: unknown[]): AiToolCallView[] {
  return rows.flatMap((row) => toolCallsOf(row)).filter((call) => call.toolCallId !== '');
}

/**
 * 会话历史（`aiConversations:getMessages`）。
 *
 * **必须显式 `updateRead=false`**：该动作在 `updateRead=true` 时会把会话标记为已读（写操作）。
 * 这里只用于读取待确认的工具调用，不改动已读状态。
 */
export async function fetchAiSessionMessages(sessionId: string): Promise<unknown[]> {
  const result = await api.resourceAction<unknown>('aiConversations', 'getMessages', {
    params: { sessionId, updateRead: false, paginate: 'false' },
  });
  if (Array.isArray(result.data)) return result.data;
  return readArray(result.data, 'rows');
}

/** 合并详情与会话消息里的工具调用（同一 toolCallId 以会话消息为准，它带 invokeStatus/execution）。 */
export function mergeAiToolCalls(
  fromDetail: AiToolCallView[],
  fromMessages: AiToolCallView[],
): AiToolCallView[] {
  const merged = new Map<string, AiToolCallView>();
  for (const call of fromDetail) merged.set(call.toolCallId, call);
  for (const call of fromMessages) merged.set(call.toolCallId, call);
  return [...merged.values()];
}

/**
 * 前端工具的结果集（原生 `resumeToolCall` 的 `toolCallResults`）。
 *
 * 服务端读取形状（`plugin-ai/dist/server/frontend-tools.js` 的 `readFrontendToolResult`）：
 * 数组项为 `{ id: <toolCallId>, result: <值> }`，只对 `id` 命中且带 `result` 的项生效。
 * 这里只回传**确实已有结果**的前端工具；没有结果就不伪造。
 */
export function frontendToolResultsOf(calls: AiToolCallView[]): Array<{ id: string; result: unknown }> {
  return calls
    .filter((call) => call.execution === 'frontend' && call.content !== undefined && call.content !== null)
    .map((call) => ({ id: call.toolCallId, result: call.content }));
}

/**
 * 工具调用是否已经做出决定。
 *
 * **2.2.20 / 2.2.22 契约（发布包原始实现实测，见 `frontend/scripts/verify-2.2.20-task-ai-contract.mjs`）**：
 * `aiConversations:getMessages` 的 `parseMessageRow` **不**回填 `userDecision`，
 * 它只回填 `invokeStatus`/`auto`/`status`/`content`/`execution`/`willInterrupt`；
 * 服务端 `updateUserDecision` 命中后会把该工具置为 `invokeStatus: 'waiting'`（更新条件为原 `interrupted`）。
 * 因此"是否已决定"必须同时看 `userDecision`（`updateUserDecision` 的返回里才有）与 `invokeStatus === 'waiting'`。
 */
export function isAiToolCallDecided(call: AiToolCallView): boolean {
  if (call.userDecision !== undefined && call.userDecision !== null) return true;
  return call.invokeStatus === 'waiting';
}
