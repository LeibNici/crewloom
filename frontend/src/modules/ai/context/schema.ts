/**
 * 数据表 / 字段 schema 的读取（共用的真实只读链路）。
 *
 * 只走 `src/api/client.ts` 的既有请求管线：
 *  - 数据源清单：`dataSources:list`
 *  - 集合清单：`collections:list`
 *  - 集合详情（含 `primaryKey` 与字段定义）：`collections:get?filterByTk=<name>`
 *
 * 与 DS 模块一致：插件集合读不到 schema 时界面按源码定义如实说明，不用响应键推全量字段。
 */
import { api } from '../../../api/client';
import type { ListParams } from '../../../api/types';

export interface SchemaField {
  name: string;
  title?: string;
  type?: string;
  interface?: string;
  primaryKey?: boolean;
}

export interface CollectionSchema {
  name: string;
  title?: string;
  primaryKey: string;
  fields: SchemaField[];
}

export async function listDataSourceKeys(): Promise<string[]> {
  const result = await api.resourceAction<Array<Record<string, unknown>>>('dataSources', 'list', {
    params: { pageSize: 50 },
  });
  return (Array.isArray(result.data) ? result.data : [])
    .map((row) => (typeof row.key === 'string' ? row.key : typeof row.name === 'string' ? row.name : ''))
    .filter((key) => key.length > 0);
}

export async function listCollectionOptions(params?: ListParams): Promise<Array<{ name: string; title?: string }>> {
  const result = await api.resourceAction<Array<Record<string, unknown>>>('collections', 'list', {
    params: params ?? { pageSize: 300, sort: ['name'] },
  });
  return (Array.isArray(result.data) ? result.data : [])
    .map((row) => ({
      name: String(row.name ?? ''),
      title: typeof row.title === 'string' ? row.title : undefined,
    }))
    .filter((item) => item.name.length > 0);
}

function readFields(raw: unknown): SchemaField[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
    .map((field) => ({
      name: String(field.name ?? ''),
      title: typeof field.title === 'string' ? field.title : undefined,
      type: typeof field.type === 'string' ? field.type : undefined,
      interface: typeof field.interface === 'string' ? field.interface : undefined,
      primaryKey: field.primaryKey === true,
    }))
    .filter((field) => field.name.length > 0);
}

/** 集合 schema：字段清单 + 主键名（记录选择要用真实主键做等值筛选）。 */
export async function getCollectionSchema(collectionName: string): Promise<CollectionSchema> {
  const result = await api.resourceAction<Record<string, unknown>>('collections', 'get', {
    params: { filterByTk: collectionName },
  });
  const data = result.data ?? {};
  const fields = readFields(data.fields);
  const rawPrimary = data.primaryKey;
  const primaryKey =
    typeof rawPrimary === 'string' && rawPrimary.length > 0
      ? rawPrimary
      : (fields.find((field) => field.primaryKey)?.name ?? 'id');
  return {
    name: collectionName,
    title: typeof data.title === 'string' ? data.title : undefined,
    primaryKey,
    fields,
  };
}

/** 只读地读取一小段记录（受控上限，避免把整表拉进浏览器）。 */
export async function listRecords(
  collectionName: string,
  params: ListParams & { dataSource?: string },
): Promise<{ rows: Array<Record<string, unknown>>; count: number | null }> {
  const { dataSource, ...rest } = params;
  const result = await api.resourceAction<Array<Record<string, unknown>>>(
    collectionName,
    'list',
    { params: rest },
    { dataSource },
  );
  const count = typeof (result.meta as { count?: unknown } | undefined)?.count === 'number'
    ? ((result.meta as { count: number }).count)
    : null;
  return { rows: Array.isArray(result.data) ? result.data : [], count };
}
