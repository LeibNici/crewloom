/**
 * 工作流模块的取值/格式化工具（组 C 独占）。
 *
 * 只做"把后端真实字段安全读出来并转成中文展示"这一件事：
 * 不从响应键猜字段表、不复制内核规则、不新建通用层。
 * 后端返回的是未知形状，所有读取都先判类型，缺失时不编造默认业务值。
 */

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readString(source: unknown, key: string): string | null {
  const record = asRecord(source);
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function readNumber(source: unknown, key: string): number | null {
  const record = asRecord(source);
  const value = record?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

export function readBoolean(source: unknown, key: string): boolean | null {
  const record = asRecord(source);
  const value = record?.[key];
  if (typeof value === 'boolean') return value;
  return null;
}

export function readArray(source: unknown, key: string): unknown[] {
  const record = asRecord(source);
  const value = record?.[key];
  return Array.isArray(value) ? value : [];
}

/** 主键统一按字符串处理（flow_nodes/executions 是雪花 ID，可能超过安全整数）。 */
export function readId(source: unknown, key = 'id'): string | null {
  const record = asRecord(source);
  const value = record?.[key];
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

const pad = (value: number) => String(value).padStart(2, '0');

/** 后端时间统一是 ISO 字符串（含时区）；解析失败时原样返回，不伪造时间。 */
export function formatDateTime(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** 「多久之前」；时间在未来或无法解析时返回 null，由调用方决定展示什么。 */
export function formatRelative(value: unknown, now: number = Date.now()): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return null;
  const diff = now - time;
  if (diff < 0) return null;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  return formatDateTime(value);
}

/** 毫秒耗时；耗时不可用时返回 null（不显示 0 秒冒充）。 */
export function formatDuration(startedAt: unknown, finishedAt: unknown): string | null {
  const start = typeof startedAt === 'string' ? new Date(startedAt).getTime() : NaN;
  const end = typeof finishedAt === 'string' ? new Date(finishedAt).getTime() : NaN;
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  const ms = end - start;
  if (ms < 1000) return `${ms} 毫秒`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes} 分 ${Math.round((ms % 60_000) / 1000)} 秒`;
}

/**
 * 节点类型标识转给用户看的名字。
 *
 * 已知类型用**固定 2.2.22 registry 的中文题名**（与 `nodeTypes.ts` 的 `NODE_TYPE_SPECS.label`
 * 保持一致，避免同一类型在两个地方叫不同名字）；未接入插件提供的类型按后端原值展示，
 * **不猜**一个可能错误的中文名（前端不允许把内部标识伪装成业务名称）。
 */
export function humanizeType(type: string | null): string {
  if (!type) return '未配置类型';
  const known: Record<string, string> = {
    calculation: '计算',
    condition: '条件判断',
    'multi-conditions': '多条件分支',
    end: '结束流程',
    output: '输出',
    query: '查询数据',
    create: '新增数据',
    update: '更新数据',
    destroy: '删除数据',
    manual: '人工处理',
    'ai-employee': 'AI 员工',
  };
  return known[type] ?? type;
}

/** 截断长文本用于列表摘要；不改变原文（详情页仍读原始字段）。 */
export function truncate(value: string | null, max = 80): string {
  if (!value) return '';
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** JSON 安全格式化：非字符串/对象时原样转字符串；不吞掉结构信息。 */
export function stringifyJson(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
