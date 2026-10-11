import { associatedAction, api, resourceAction } from '../../api/client';
import type { ListParams } from '../../api/types';
import { useResourceActionList, type AssociatedListResult } from '../access/operations';
import type {
  CollectionFieldRecord,
  CollectionRecord,
  CollectionRecordData,
  DataSourceDetail,
  DataSourceRecord,
  ReadTablesResult,
} from './types';

/**
 * 数据源模块的请求（只在既有请求管线上做类型化包装）。
 *
 * 边界（02-foundation §3）：
 *  - `dataSources:readTables` / `loadTables` / `testConnection` **会对真实外部库建连**（POST 但语义接近读取），
 *    因此只登记为产品动作，**只在真实用户主动点击时**调用；Agent 自动验证（strict）会先拦截；
 *  - 业务集合记录读写走 `<collection>:list|get|create|update|destroy`，后端 ACL 最终判定；
 *  - 聚合走 `<collection>:query`（`values={measures,dimensions,orders,filter}`）。
 */

// --- 数据源（DS-01 / DS-02） ---------------------------------------------

export function listDataSources(params: ListParams = { pageSize: 50 }) {
  return resourceAction<DataSourceRecord[]>('dataSources', 'list', { params });
}

/**
 * 已启用数据源列表（`dataSources:listEnabled`）。
 *
 * 该动作是**只读**，但 `src/api/url.ts` 的只读动作集合不含 `listEnabled`，
 * `resourceAction` 会把它当写动作发成 POST。这里显式用 GET（13000 实测 GET 可用），
 * 仍走同一条 SDK 管线，不改公共文件。
 */
export function listEnabledDataSources(params: ListParams = { pageSize: 50 }) {
  return api.request<DataSourceRecord[]>({ url: '/dataSources:listEnabled', method: 'get', params });
}

/** 已启用数据源列表的六态视图。 */
export function useEnabledDataSources(): AssociatedListResult<DataSourceRecord> {
  return useResourceActionList<DataSourceRecord>(['dataSources', 'listEnabled'], () =>
    listEnabledDataSources({ pageSize: 50 }),
  );
}

export function getDataSource(key: string) {
  return resourceAction<DataSourceDetail>('dataSources', 'get', { params: { filterByTk: key } });
}

/**
 * 连接测试：会真实建连，只在用户主动点击时调用。
 *
 * 载荷形状（静态研究）：`values.{dataSourceKey,dbOptions}`。
 */
export function testConnection(values: Record<string, unknown>) {
  return resourceAction<unknown>('dataSources', 'testConnection', { values });
}

export function createDataSource(values: Record<string, unknown>) {
  return resourceAction<DataSourceRecord>('dataSources', 'create', { values });
}

export function updateDataSource(key: string, values: Record<string, unknown>) {
  return resourceAction<DataSourceRecord>('dataSources', 'update', { params: { filterByTk: key }, values });
}

export function destroyDataSource(key: string) {
  return resourceAction<unknown>('dataSources', 'destroy', { params: { filterByTk: key } });
}

// --- 集合与字段（DS-03） -------------------------------------------------

export function listCollections(params: ListParams = { pageSize: 300, sort: ['name'] }) {
  return resourceAction<CollectionRecord[]>('collections', 'list', { params });
}

export function getCollection(name: string, params: ListParams = { appends: ['fields'] }) {
  return resourceAction<CollectionRecord>('collections', 'get', { params: { ...params, filterByTk: name } });
}

export function createCollection(values: Record<string, unknown>) {
  return resourceAction<CollectionRecord>('collections', 'create', { values });
}

export function updateCollection(name: string, values: Record<string, unknown>) {
  return resourceAction<CollectionRecord>('collections', 'update', { params: { filterByTk: name }, values });
}

export function destroyCollection(name: string) {
  return resourceAction<unknown>('collections', 'destroy', { params: { filterByTk: name } });
}

/** 字段清单：父资源斜杠形式 `collections/<name>/fields:list`（13000 实测可用）。 */
export function listCollectionFields(name: string, params: ListParams = { pageSize: 300, sort: ['sort'] }) {
  return associatedAction<CollectionFieldRecord[]>('collections', name, 'fields', 'list', { params });
}

export function getCollectionField(name: string, fieldName: string) {
  return associatedAction<CollectionFieldRecord>('collections', name, 'fields', 'get', {
    params: { filterByTk: fieldName },
  });
}

/** 字段增改删：`collections/<name>/fields:create|update|destroy`（父标识＝集合名）。 */
export function createCollectionField(name: string, values: Record<string, unknown>) {
  return associatedAction<CollectionFieldRecord>('collections', name, 'fields', 'create', { values });
}

export function updateCollectionField(name: string, fieldName: string, values: Record<string, unknown>) {
  return associatedAction<CollectionFieldRecord>('collections', name, 'fields', 'update', {
    params: { filterByTk: fieldName },
    values,
  });
}

export function destroyCollectionField(name: string, fieldName: string) {
  return associatedAction<unknown>('collections', name, 'fields', 'destroy', {
    params: { filterByTk: fieldName },
  });
}

// --- 物理表读取与加载（DS-03，会对外部库建连） --------------------------

/** `values.{dataSourceKey,dbOptions}`；对 main 返回尚未纳管的物理表。 */
export function readTables(values: { dataSourceKey: string; dbOptions?: Record<string, unknown> }) {
  return resourceAction<readonly string[] | Record<string, unknown>>('dataSources', 'readTables', { values });
}

/** `values.{dataSourceKey,tables}`：把物理表加载为集合。 */
export function loadTables(values: { dataSourceKey: string; tables: string[] }) {
  return resourceAction<unknown>('dataSources', 'loadTables', { values });
}

/**
 * 主库反向同步字段（按物理表重建**指定集合**的字段）。
 *
 * 真实 2.2.20 的实际契约：`MainDataSource.syncFieldsFromDatabase(ctx, values.collections)`；
 * `values.collections` **缺省（或空）表示全部集合**（59 已用 2.2.20 发布产物隔离核对证实，
 * 本机 fixture 复现同一语义）。集合详情页的这个动作只针对**当前集合**，所以必须显式带
 * `collections: [当前集合]`；拿不到当前集合名时**直接拒绝**：
 * 绝不把"未知"当成"全部"，也不靠改文案把全库同步说成单表意图（那是扩大用户动作）。
 */
export function syncMainDataSourceFields(collectionName: string) {
  const name = String(collectionName ?? '').trim();
  if (!name) {
    throw new Error('缺少当前集合名称，已取消反向同步（不会改为同步全部集合）。');
  }
  return resourceAction<unknown>('mainDataSource', 'syncFields', { values: { collections: [name] } });
}

/**
 * 重新加载主库自带的集合定义（`mainDataSource:refresh`）。
 *
 * 固定 2.2.20 实际契约（`patches/nocobase-2.2.20` 对应的发布产物 + 隔离核对，见
 * `scripts/verify-2.2.20-main-data-source-contract.mjs`）：
 *  - 不接收任何 `values`；`main` 状态为 `loaded` 时调用 `plugin.loadCollections()`；
 *  - 该调用落到基类 `Plugin.loadCollections`，只把插件包内
 *    `server/collections/*` 的**集合定义文件**重新 import 进运行中的应用；
 *  - 不扫描物理表、不重建字段、不改业务数据；没有该目录时是空操作。
 * 因此界面不说它"刷新数据"，只按真实含义呈现为"重新加载集合定义"。
 */
export function refreshMainDataSource() {
  return resourceAction<unknown>('mainDataSource', 'refresh', { values: {} });
}

/**
 * 读取尚未纳管的物理表（`dataSources:readTables`）。
 *
 * 固定 2.2.20 的 `MainDataSource.readTables()` 返回 `[{ name }]`（不是字符串数组），
 * 这里两种形状都归一成表名，避免真实后端返回对象数组时界面显示空。
 */
export function normalizeReadTables(result: unknown): ReadTablesResult {
  const readNames = (list: unknown[]): string[] =>
    list
      .map((item) => {
        if (typeof item === 'string' && item) return item;
        if (item && typeof item === 'object') {
          const name = (item as { name?: unknown }).name;
          if (typeof name === 'string' && name) return name;
        }
        return null;
      })
      .filter((item): item is string => item !== null);
  if (Array.isArray(result)) {
    return { tables: readNames(result), rawType: 'array' };
  }
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    for (const key of ['tables', 'data', 'rows']) {
      if (Array.isArray(record[key])) {
        return { tables: readNames(record[key] as unknown[]), rawType: `object.${key}` };
      }
    }
  }
  return { tables: [], rawType: result === null ? 'null' : typeof result };
}

// --- 业务集合记录（DS-04） ----------------------------------------------

export function listCollectionRecords(collection: string, params: ListParams) {
  return resourceAction<CollectionRecordData[]>(collection, 'list', { params });
}

export function getCollectionRecord(collection: string, id: string | number) {
  return resourceAction<CollectionRecordData>(collection, 'get', { params: { filterByTk: id } });
}

export function createCollectionRecord(collection: string, values: Record<string, unknown>) {
  return resourceAction<CollectionRecordData>(collection, 'create', { values });
}

export function updateCollectionRecord(collection: string, id: string | number, values: Record<string, unknown>) {
  return resourceAction<CollectionRecordData>(collection, 'update', { params: { filterByTk: id }, values });
}

export function destroyCollectionRecord(collection: string, id: string | number) {
  return resourceAction<unknown>(collection, 'destroy', { params: { filterByTk: id } });
}

/** 聚合查询：`values={measures,dimensions,orders,filter}`；至少一个 measure 或 dimension。 */
export function aggregateCollectionRecords(collection: string, values: Record<string, unknown>) {
  return resourceAction<CollectionRecordData[]>(collection, 'query', { values });
}

// --- 访问配置入口（DS-05） ----------------------------------------------

/**
 * 角色在数据源维度的资源授权（`roles/<roleName>/resources:list`）。
 *
 * 与 AC-04 使用**同一份** `dataSourcesRolesResources` 数据，不另建规则；
 * 13000 实测 `dataSources/main/roles:list` 返回 500（父资源斜杠形式在该实例不可用），
 * 因此统一走角色侧的关联路径。
 */
export function listRoleResources(roleName: string, params: ListParams) {
  return associatedAction<Array<Record<string, unknown>>>('roles', roleName, 'resources', 'list', { params });
}

/** 条件构建：与 AC-04 共用同一套原生过滤语义（不另立规则）。 */
export { buildScope, CONDITION_OPERATOR_LABELS } from '../access/operations';
export type { ConditionClause, ConditionOperator } from '../access/operations';
