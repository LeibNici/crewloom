/**
 * AI-04 四类上下文的产品侧模型。
 *
 * 发送给原生 ChatBox 的每一项都必须是上游 `ContextItem` 的形状
 * （固定源码 `plugin-ai/src/client-v2/ai-employees/types.ts:78-84`）：
 *
 *   { type, uid, title?, content?, frontendTools? }
 *
 * `type` 不是自造字符串：它必须是**真实 consumer 认识**的类型名，否则要么走服务端
 * 默认策略（`JSON.stringify(item)`），要么在客户端解析阶段被忽略。本文件声明的四类，
 * 分别对应下面这些已核实的 consumer（报告 10 §2 有完整对照表）：
 *
 * | 产品概念 | `type` | 客户端注册（2.2.22 原生 v2） | 服务端解析策略 |
 * | --- | --- | --- | --- |
 * | 数据范围 / 指定记录 | `datasource` | **v2 未注册**（只在旧 `client/index.tsx:153`）；由本模块补注册 | `datasource`（`server/plugin.ts:369`，ACL 受控） |
 * | 代码工作内容 | `code-editor` | 已注册（`plugin.tsx:134`，无 `getFrontendTools`） | `code-editor`（`server/plugin.ts:372`） |
 * | 图表工作内容 | `chart-config` | 已注册（`plugin.tsx:135`，无 `getFrontendTools`） | 无 → 默认 `JSON.stringify` |
 *
 * `frontendTools` 里的 manifest 形状与 `@nocobase/plugin-ai/common/frontend-tools.ts`
 * 的 `FrontendToolManifest` 一致；`isFrontendToolManifest`（真实模块）在测试里校验它。
 * 注意服务端的硬约束（`server/frontend-tools.ts:39-70`）：`manifest.blockUid` 必须等于
 * 所在 `ContextItem.uid`，且 `manifest.id` 必须是 `${uid}:${name}`，否则 manifest 被丢弃。
 */
import type { ContextItem } from '@nocobase/plugin-ai/client-v2';

/** 上游 `FrontendToolManifest`（由真实 `ContextItem` 类型推导，避免复制一份会漂移的定义）。 */
export type FrontendToolManifest = NonNullable<ContextItem['frontendTools']>[number];

/** 发给原生 ChatBox 的上下文项。 */
export type WorkContextItem = ContextItem;

/** 四类产品上下文。`type` 是真实 consumer 的类型名，`kind` 只用于产品内部区分。 */
export type ContextKind = 'datasource' | 'record' | 'code' | 'chart';

/** 结构化筛选（`aiContextDatasources.filter` 的**存储形态**；服务端 `preview` 期望它）。 */
export interface UiFilterCondition {
  path: string;
  operator: string;
  value?: unknown;
}

export interface UiFilterGroup {
  logic: '$and' | '$or';
  items: Array<UiFilterCondition | UiFilterGroup>;
}

export const FILTER_OPERATORS = [
  { value: '$eq', label: '等于' },
  { value: '$ne', label: '不等于' },
  { value: '$gt', label: '大于' },
  { value: '$gte', label: '大于等于' },
  { value: '$lt', label: '小于' },
  { value: '$lte', label: '小于等于' },
  { value: '$includes', label: '包含' },
  { value: '$notIncludes', label: '不包含' },
  { value: '$dateOn', label: '日期是' },
  { value: '$dateAfter', label: '日期晚于' },
  { value: '$dateBefore', label: '日期早于' },
  { value: '$empty', label: '为空' },
  { value: '$notEmpty', label: '不为空' },
] as const;

/** 服务端 `datasource` 策略消费的查询内容（`InnerQueryOptions`，`server/manager/ai-context-datasource-manager.ts:226-229`）。 */
export interface DatasourceQueryContent {
  datasource: string;
  collectionName: string;
  fields?: string[] | null;
  filter?: Record<string, unknown> | null;
  sort?: unknown[] | null;
  limit?: number | null;
}

/**
 * 已保存的上下文数据源被选中为会话内容。
 *
 * 注意两份筛选形态：`filter` 是记录里的**存储形态**（`{logic, items}`，服务端 preview
 * 期望它），构造消息内容时由 `toServerFilter` 转成服务端形态——与上游 v1
 * `context/datasource.tsx:80-98` 的 `transformFilter(datasource.filter)` 一致。
 */
export interface DatasourceSelection {
  kind: 'datasource';
  /** 会话项 uid：已保存记录 id（`getContent` 回查用它）。 */
  uid: string;
  title: string;
  datasource: string;
  collectionName: string;
  fields: string[] | null;
  filter: unknown;
  sort: unknown[] | null;
  limit: number | null;
}

/**
 * 「原页面区块上下文」在 Crewloom 的等价实现：用户明确选择
 * **数据源 + 数据表 + 字段 + 一条记录**，不伪造旧 `FlowModelUID`、不默认抓当前页面。
 * 发送类型仍是真实的 `datasource`（服务端按 ACL 解析记录），映射关系见报告 10 §2.2。
 */
export interface RecordSelection {
  kind: 'record';
  uid: string;
  title: string;
  datasource: string;
  collectionName: string;
  /** 记录主键字段名（`collections:get` 的 `primaryKey`，默认 `id`）。 */
  primaryKey: string;
  recordId: string | number;
  fields: string[] | null;
}

/** 代码工作内容：真实代码区 + 语言 + （可选的）所用数据选择与 schema 信息。 */
export interface CodeSelection {
  kind: 'code';
  uid: string;
  title: string;
  /** 代码分区标识，进 `code-editor` 服务端模板（`scene`）。 */
  scene: string;
  language: string;
  code: string;
  /** 与这段代码一起使用的数据选择；展开为**独立的 `datasource` 项**（真实 consumer）。 */
  data?: {
    datasource: string;
    collectionName: string;
    fields: string[] | null;
    label: string;
  } | null;
}

export const CHART_TYPES = [
  { value: 'bar', label: '柱状图' },
  { value: 'line', label: '折线图' },
  { value: 'pie', label: '饼图' },
] as const;

export const CHART_AGGREGATIONS = [
  { value: 'count', label: '计数' },
  { value: 'sum', label: '求和' },
  { value: 'avg', label: '平均' },
  { value: 'min', label: '最小' },
  { value: 'max', label: '最大' },
] as const;

export type ChartType = (typeof CHART_TYPES)[number]['value'];
export type ChartAggregation = (typeof CHART_AGGREGATIONS)[number]['value'];

/**
 * 图表工作内容：数据表 / 字段 / 聚合 / 图表样式与必要 options。
 *
 * `chart-config` 在 2.2.22 没有服务端解析策略，走默认 `JSON.stringify(item)`，
 * 因此这里的内容必须是**自描述**的完整配置；报告 10 §2.4 如实说明这一点。
 */
export interface ChartSelection {
  kind: 'chart';
  uid: string;
  title: string;
  datasource: string;
  collectionName: string;
  fields: string[];
  metricField: string;
  aggregation: ChartAggregation;
  groupBy: string;
  filter: Record<string, unknown> | null;
  sort: unknown[] | null;
  limit: number;
  chartType: ChartType;
  options: {
    showLegend: boolean;
    smooth: boolean;
    stacked: boolean;
  };
}

export type ContextSelection = DatasourceSelection | RecordSelection | CodeSelection | ChartSelection;

/** `datasource` 客户端 `getContent` 的返回（v1 `context/datasource.tsx:80-98`）。 */
export interface DatasourceResolvedContent extends DatasourceQueryContent {}
