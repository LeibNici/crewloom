/**
 * 结构化筛选 ↔ 服务端筛选 的转换。
 *
 * 为什么需要两份形态（全部来自固定源码，不是我们的偏好）：
 *
 *  1. `aiContextDatasources.filter` **存储形态**是 `{ logic, items: [{path, operator, value}] }`：
 *     服务端 `aiContextDatasources:preview` 会先 `transformFilter(options.filter)`
 *     （`server/manager/ai-context-datasource-manager.ts:99-101`），`transformFilter`
 *     对非 `{logic,items}` 直接抛 `Invalid filter: filter must have logic and items properties`
 *     （`@nocobase/utils` `lib/transformFilter.js`）。
 *  2. 随消息发送的 `workContext[].content.filter` 必须是**服务端筛选形态**
 *     `{[path]: {[operator]: value}}`：`datasource` 解析策略把它直接交给
 *     `collection.repository.find({ filter })`（同文件 `:107-116`），中间**没有** transform。
 *     上游 v1 客户端也是这么做的：`getContent` 里 `transformFilter(datasource.filter)`
 *     （`client-v2/ai-employees/context/datasource.tsx:80-98`）。
 *
 * 这里是 `transformFilter` + `removeNullCondition` 的忠实移植（去掉了 lodash/flat 依赖，
 * 只保留本项目用到的语义）：值为 `null` / `undefined` / `''` / 空数组的条件不进入结果，
 * 全部为空时返回 `undefined`。
 */
import type { UiFilterCondition, UiFilterGroup } from './types';

export type ServerFilter = Record<string, unknown> | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isCondition(value: unknown): value is UiFilterCondition {
  return isRecord(value) && 'path' in value && 'operator' in value;
}

function isGroup(value: unknown): value is UiFilterGroup {
  return isRecord(value) && 'logic' in value && 'items' in value;
}

/** 是否是结构化筛选（存储形态）。旧版纯 JSON 筛选返回 false。 */
export function isUiFilter(value: unknown): value is UiFilterGroup {
  return isGroup(value) && Array.isArray((value as UiFilterGroup).items);
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

function transformGroup(group: UiFilterGroup): ServerFilter {
  const items: unknown[] = [];
  for (const item of group.items) {
    if (isCondition(item)) {
      if (isEmptyValue(item.value)) continue;
      items.push({ [item.path]: { [item.operator]: item.value } });
      continue;
    }
    if (isGroup(item)) {
      const nested = transformGroup(item);
      if (nested) items.push(nested);
      continue;
    }
  }
  if (items.length === 0) return undefined;
  return { [group.logic]: items };
}

/**
 * 结构化筛选 → 服务端筛选。
 *
 * 对应 `transformFilter`（对合法输入）：空条件被丢弃，全空时返回 `undefined`。
 * 输入不是结构化筛选时**原样返回**（旧记录可能是纯 JSON 筛选，不能悄悄丢掉）。
 */
export function toServerFilter(filter: unknown): ServerFilter {
  if (filter === null || filter === undefined) return undefined;
  if (isUiFilter(filter)) return transformGroup(filter);
  if (isRecord(filter)) return filter;
  return undefined;
}

export function emptyUiFilter(logic: UiFilterGroup['logic'] = '$and'): UiFilterGroup {
  return { logic, items: [] };
}

/** 从任意输入得到一个可编辑的结构化筛选；旧格式返回空筛选并让调用方提示。 */
export function toEditableFilter(filter: unknown): UiFilterGroup {
  if (isUiFilter(filter)) {
    return {
      logic: filter.logic,
      items: filter.items.map((item) => (isGroup(item) ? toEditableFilter(item) : { ...item })),
    };
  }
  return emptyUiFilter();
}

/** 人类可读的筛选摘要（界面用；不暴露内部 JSON）。 */
export function describeFilter(filter: unknown): string {
  const server = toServerFilter(filter);
  if (!server) return '全部记录';
  const parts: string[] = [];
  const walk = (node: unknown, joiner: string) => {
    if (!isRecord(node)) return;
    for (const [key, value] of Object.entries(node)) {
      if ((key === '$and' || key === '$or') && Array.isArray(value)) {
        value.forEach((child) => walk(child, key === '$and' ? '且' : '或'));
        continue;
      }
      if (isRecord(value)) {
        const operator = Object.keys(value)[0] ?? '';
        const raw = value[operator];
        parts.push(`${key} ${operator} ${typeof raw === 'object' ? JSON.stringify(raw) : String(raw)}`);
      }
    }
    void joiner;
  };
  walk(server, '且');
  return parts.length > 0 ? parts.join('，') : '全部记录';
}

/** 结构校验：结构化筛选必须每层都有合法 logic / items。 */
export function validateUiFilter(filter: UiFilterGroup): string | null {
  if (filter.logic !== '$and' && filter.logic !== '$or') return '筛选条件的关系只能是「并且」或「或者」。';
  for (const item of filter.items) {
    if (isCondition(item)) {
      if (!item.path) return '筛选条件缺少字段。';
      if (!item.operator) return '筛选条件缺少运算符。';
      continue;
    }
    if (isGroup(item)) {
      const nested = validateUiFilter(item);
      if (nested) return nested;
      continue;
    }
    return '筛选条件格式不正确。';
  }
  return null;
}
