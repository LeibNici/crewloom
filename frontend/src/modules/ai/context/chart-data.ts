/**
 * 图表工作区的预览数据：真实读取一小段记录并在前端聚合。
 *
 * 用项目**已有**的图表能力（`echarts` / `echarts-for-react`，已在 `package.json` 依赖里），
 * 不新增图表库，也不引入外部图床或平台。
 *
 * 聚合口径（界面与说明一致）：
 *  - `count` 直接计行数（不要求 metric 字段存在）；
 *  - `sum` / `avg` / `min` / `max` 只统计**数值**（数字，或可被 `Number()` 解析的字符串），
 *    无法解析的行不计入分母（界面在结果里给出有效行数）。
 */
import type { ChartAggregation, ChartSelection } from './types';
import { listRecords } from './schema';

export interface ChartMetric {
  label: string;
  value: number;
}

export interface ChartPreviewData {
  points: ChartMetric[];
  total: number;
  usedRows: number;
  numericRows: number;
  truncated: boolean;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function labelOf(value: unknown): string {
  if (value === null || value === undefined || value === '') return '（空）';
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['title', 'name', 'label', 'nickname', 'id']) {
      if (typeof record[key] === 'string' || typeof record[key] === 'number') return String(record[key]);
    }
    return '（复合值）';
  }
  return String(value);
}

function aggregate(values: number[], aggregation: ChartAggregation): number {
  if (aggregation === 'count') return values.length;
  if (values.length === 0) return 0;
  switch (aggregation) {
    case 'sum':
      return values.reduce((total, value) => total + value, 0);
    case 'avg':
      return values.reduce((total, value) => total + value, 0) / values.length;
    case 'min':
      return Math.min(...values);
    case 'max':
      return Math.max(...values);
  }
}

export async function loadChartPreview(selection: ChartSelection): Promise<ChartPreviewData> {
  const limit = Math.min(Math.max(selection.limit || 100, 1), 200);
  const fields = selection.fields.length > 0 ? selection.fields : null;
  const { rows, count } = await listRecords(selection.collectionName, {
    pageSize: limit,
    ...(fields ? { fields } : {}),
    ...(selection.filter ? { filter: selection.filter } : {}),
    ...(selection.sort ? { sort: selection.sort as string[] } : {}),
    dataSource: selection.datasource,
  });

  const groups = new Map<string, number[]>();
  let numericRows = 0;
  for (const row of rows) {
    const key = selection.groupBy ? labelOf(row[selection.groupBy]) : selection.metricField || '全部';
    const bucket = groups.get(key) ?? [];
    if (selection.aggregation === 'count') {
      bucket.push(1);
    } else {
      const value = toNumber(row[selection.metricField]);
      if (value !== null) {
        numericRows += 1;
        bucket.push(value);
      }
    }
    groups.set(key, bucket);
  }

  const points: ChartMetric[] = Array.from(groups.entries())
    .map(([label, values]) => ({ label, value: Number(aggregate(values, selection.aggregation).toFixed(4)) }))
    .sort((a, b) => (selection.chartType === 'line' ? 0 : b.value - a.value))
    .slice(0, 50);

  return {
    points,
    total: count ?? rows.length,
    usedRows: rows.length,
    numericRows,
    truncated: (count ?? rows.length) > rows.length,
  };
}
