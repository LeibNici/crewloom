/** 界面用到的小工具（只做展示，不做业务判断）。 */

export function formatFields(fields: unknown): string {
  if (Array.isArray(fields)) return fields.filter((item) => typeof item === 'string').join(', ') || '—';
  if (typeof fields === 'string') return fields;
  return '—';
}

export function safeJson(value: unknown): string {
  if (value === null || value === undefined) return '—';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '（无法显示）';
  }
}

export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** 预览返回的是单元格 `{name, type, value}`，统一渲染成一行文本。 */
export function cellText(cell: unknown): string {
  if (!cell || typeof cell !== 'object') return String(cell ?? '—');
  const record = cell as { name?: unknown; value?: unknown };
  const value = record.value;
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') {
    try {
      return truncate(JSON.stringify(value), 120);
    } catch {
      return '（无法显示）';
    }
  }
  return String(value);
}
