/**
 * 数据源模块（组 B）类型。
 *
 * 字段名来自 **13000（2.2.20）真实只读响应**（见 group-b-evidence/live-metadata-discovery*.json）：
 *  - `dataSources:list` → `key / displayName / type / options / enabled / fixed / status`；
 *  - `dataSources:get?filterByTk=main` → `key / displayName / type / isDBInstance`；
 *  - `collections:list` → `name / title / hidden / description / autoGenId / titleField / filterTargetKey …`；
 *  - `collections/<name>/fields:list` → 真实 schema：`name / type / interface / target / foreignKey / sourceKey / targetKey / reverseKey / parentKey / onDelete / uiSchema / validation`；
 *  - 业务集合记录：`<collection>:list|get|create|update|destroy`。
 */

export interface DataSourceRecord {
  key: string;
  displayName?: string | null;
  type?: string | null;
  options?: Record<string, unknown> | null;
  enabled?: boolean;
  fixed?: boolean;
  status?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface DataSourceDetail {
  key: string;
  displayName?: string | null;
  type?: string | null;
  isDBInstance?: boolean;
}

export interface CollectionRecord {
  key?: string;
  name: string;
  title?: string | null;
  inherit?: boolean | null;
  hidden?: boolean | null;
  description?: string | null;
  template?: string | null;
  logging?: boolean | null;
  autoGenId?: boolean | null;
  titleField?: string | null;
  filterTargetKey?: string | null;
  unavailableActions?: string[] | null;
  fields?: CollectionFieldRecord[] | null;
}

export interface CollectionFieldRecord {
  key?: string;
  name: string;
  type: string;
  interface?: string | null;
  description?: string | null;
  collectionName?: string;
  parentKey?: string | null;
  reverseKey?: string | null;
  target?: string | null;
  foreignKey?: string | null;
  sourceKey?: string | null;
  targetKey?: string | null;
  onDelete?: string | null;
  uiSchema?: Record<string, unknown> | null;
  validation?: Record<string, unknown> | null;
}

export type CollectionRecordData = Record<string, unknown>;

export interface ReadTablesResult {
  /** 后端返回的物理表名列表（可能为空）。 */
  tables: string[];
  /** 若响应不是预期的表数组，保留原始形状供界面如实说明。 */
  rawType: string;
}
