/**
 * 四类产品上下文 → 真实 `ContextItem` 载荷的构造。
 *
 * 关键约束（全部来自固定源码，见 `./types.ts` 顶部表格）：
 *  - `type` 只能是真实 consumer 认识的名字；
 *  - `content` 的形状必须与该 consumer 一致（`datasource` 见
 *    `server/manager/ai-context-datasource-manager.ts:226-229`，`code-editor` 见
 *    `server/manager/ai-coding-manager.ts:24-27`）；
 *  - `frontendTools[].blockUid === item.uid` 且 `id === \`${uid}:${name}\``
 *    （`server/frontend-tools.ts:39-70`）。
 *
 * 附带关系同样按上游：`workContext` 只挂在**第一条**消息上
 * （`client-v2/ai-employees/chatbox/hooks/useChatMessageActions.ts:718-725`）。
 */
import { toServerFilter } from './filter';
import type {
  ChartSelection,
  CodeSelection,
  ContextSelection,
  DatasourceQueryContent,
  DatasourceSelection,
  FrontendToolManifest,
  RecordSelection,
  WorkContextItem,
} from './types';

/** 代码工作区与图表工作区的会话项 uid（同时也是各自前端工具的 blockUid）。 */
export const CODE_WORKSPACE_UID = 'crewloom:code-workspace';
export const CHART_WORKSPACE_UID = 'crewloom:chart-workspace';

/** 指定记录项的 uid：命名空间化，避免与已保存数据源 id 冲突。 */
export function recordUid(selection: Pick<RecordSelection, 'datasource' | 'collectionName' | 'recordId'>): string {
  return `crewloom:record:${selection.datasource}:${selection.collectionName}:${selection.recordId}`;
}

function compact(query: DatasourceQueryContent): DatasourceQueryContent {
  return {
    datasource: query.datasource,
    collectionName: query.collectionName,
    fields: query.fields && query.fields.length > 0 ? query.fields : null,
    filter: query.filter ?? null,
    sort: query.sort && query.sort.length > 0 ? query.sort : null,
    limit: query.limit ?? null,
  };
}

/** 已保存的上下文数据源 → `datasource` 项（uid 就是记录 id，供 `getContent` 回查）。 */
export function buildDatasourceItem(selection: DatasourceSelection): WorkContextItem {
  return {
    type: 'datasource',
    uid: selection.uid,
    title: selection.title,
    content: compact({
      datasource: selection.datasource,
      collectionName: selection.collectionName,
      fields: selection.fields,
      filter: toServerFilter(selection.filter) ?? null,
      sort: selection.sort,
      limit: selection.limit,
    }),
  };
}

/**
 * 「原页面区块上下文」的等价实现：一条**明确指定**的记录。
 *
 * 发送的是真实的 `datasource` 类型，内容用主键等值筛选把范围收敛到这一条记录，
 * 因此服务端仍按当前角色 ACL 解析（无权限 → 空结果，不是 403）。
 */
export function buildRecordItem(selection: RecordSelection): WorkContextItem {
  const uid = recordUid(selection);
  return {
    type: 'datasource',
    uid,
    title: selection.title,
    content: compact({
      datasource: selection.datasource,
      collectionName: selection.collectionName,
      fields: selection.fields,
      filter: { [selection.primaryKey]: { $eq: selection.recordId } },
      sort: null,
      limit: 1,
    }),
  };
}

/** 代码工作内容 → `code-editor` 项（服务端模板使用 scene / language / code）。 */
export function buildCodeItem(selection: CodeSelection): WorkContextItem {
  return {
    type: 'code-editor',
    uid: CODE_WORKSPACE_UID,
    title: selection.title,
    content: {
      scene: selection.scene,
      language: selection.language,
      code: selection.code,
    },
  };
}

/** 代码工作区所选数据 → 独立的 `datasource` 项（数据范围本身也有真实 consumer）。 */
export function buildCodeDataItem(selection: CodeSelection): WorkContextItem | null {
  if (!selection.data) return null;
  return {
    type: 'datasource',
    uid: `${CODE_WORKSPACE_UID}:data`,
    title: `${selection.title} · 数据`,
    content: compact({
      datasource: selection.data.datasource,
      collectionName: selection.data.collectionName,
      fields: selection.data.fields,
      filter: null,
      sort: null,
      limit: 200,
    }),
  };
}

/** 图表工作内容 → `chart-config` 项（自描述配置，服务端默认策略原样 JSON 化）。 */
export function buildChartItem(selection: ChartSelection): WorkContextItem {
  return {
    type: 'chart-config',
    uid: CHART_WORKSPACE_UID,
    title: selection.title,
    content: {
      query: {
        datasource: selection.datasource,
        collectionName: selection.collectionName,
        fields: selection.fields,
        filter: selection.filter ?? null,
        sort: selection.sort ?? null,
        limit: selection.limit,
      },
      chart: {
        type: selection.chartType,
        option: {
          metric: { field: selection.metricField, aggregation: selection.aggregation },
          groupBy: selection.groupBy || null,
          showLegend: selection.options.showLegend,
          smooth: selection.options.smooth,
          stacked: selection.options.stacked,
        },
      },
    },
  };
}

/** 单一选择 → 一个或多个真实 `ContextItem`（代码工作区可同时带出它的数据项）。 */
export function buildItemsForSelection(selection: ContextSelection): WorkContextItem[] {
  switch (selection.kind) {
    case 'datasource':
      return [buildDatasourceItem(selection)];
    case 'record':
      return [buildRecordItem(selection)];
    case 'code': {
      const code = buildCodeItem(selection);
      const data = buildCodeDataItem(selection);
      return data ? [code, data] : [code];
    }
    case 'chart':
      return [buildChartItem(selection)];
  }
}

/**
 * 全部选择 → 首条消息的 `workContext`（顺序稳定、按 type+uid 去重，与上游
 * `chat-messages.ts:325-333` 的去重口径一致）。
 */
export function buildWorkContext(selections: ContextSelection[]): WorkContextItem[] {
  const map = new Map<string, WorkContextItem>();
  for (const selection of selections) {
    for (const item of buildItemsForSelection(selection)) {
      map.set(`${item.type}:${item.uid}`, item);
    }
  }
  return Array.from(map.values());
}

/** 把真实注册表里的 manifest 挂到对应项上（`parseWorkContext` 的等价动作）。 */
export function attachFrontendTools(
  items: WorkContextItem[],
  listManifests: (uid: string) => FrontendToolManifest[],
): WorkContextItem[] {
  return items.map((item) => {
    const manifests = listManifests(item.uid) ?? [];
    return manifests.length > 0 ? { ...item, frontendTools: manifests } : { ...item };
  });
}

/**
 * 首条消息载荷（与 `useChatMessageActions.ts:718-725` 同形）：
 * `attachments` 与 `workContext` 只在 `index === 0` 上。
 */
export function buildFirstMessagePayload(
  messages: string[],
  workContext: WorkContextItem[],
  attachments?: unknown[],
): Array<Record<string, unknown>> {
  return messages.map((content, index) => ({
    role: 'user',
    content,
    attachments: index === 0 ? attachments : undefined,
    workContext: index === 0 ? workContext : undefined,
  }));
}

/** 人类可读的已选内容摘要（界面用，不展示内部 type/uid/JSON）。 */
export function describeSelection(selection: ContextSelection): string {
  switch (selection.kind) {
    case 'datasource':
      return [
        selection.collectionName,
        selection.fields?.length ? `字段 ${selection.fields.join('、')}` : '全部可读字段',
        selection.limit ? `最多 ${selection.limit} 条` : null,
      ]
        .filter(Boolean)
        .join(' · ');
    case 'record':
      return `${selection.collectionName} · 记录 ${String(selection.recordId)}`;
    case 'code':
      return `${selection.language} 代码 · ${selection.code.split('\n').length} 行${
        selection.data ? ` · 数据 ${selection.data.collectionName}` : ''
      }`;
    case 'chart':
      return `${selection.collectionName} · ${selection.aggregation} ${selection.metricField || ''}${
        selection.groupBy ? ` 按 ${selection.groupBy}` : ''
      } · ${selection.chartType}`;
  }
}
