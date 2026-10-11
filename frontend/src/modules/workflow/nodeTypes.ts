/**
 * 工作流节点类型的**配置语义定义**（组 C 独占）。
 *
 * 来源：固定 2.2.22 源码 `plugin-workflow/src/server/instructions/*.ts` 的 `configSchema`
 * 与 `client-v2/nodes/*.tsx` 的字段集。这里只做"把已确认的字段语义搬到前端表单"，
 * 不复制后端校验器、不发明新字段：
 *
 * | 类型 | config 形状（源码） |
 * | --- | --- |
 * | calculation | `{ engine?: 'math.js'\|'formula.js', expression?: string }` |
 * | condition | `{ rejectOnFalse: boolean, engine: 'basic'\|'math.js'\|'formula.js', calculation?, expression? }` |
 * | multi-conditions | `{ conditions: [{ uid?, title?, engine?, calculation?, expression? }], continueOnNoMatch? }` |
 * | query | `{ collection: string, multiple?, params: { filter?, appends?, page?, pageSize?, sort? }, failOnEmpty? }` |
 * | create | `{ collection: string, params: { values?, appends? } }` |
 * | update | `{ collection: string, params: { filter?, values?, individualHooks? } }` |
 * | destroy | `{ collection: string, params: { filter? } }` |
 * | output | `{ value: any }` |
 * | end | `{ endStatus: 1 \| -1 }` |
 * | manual | `{ schema, forms, assignees?, mode?, title? }`（布局由 schema 定义，逐字段编辑见 schema 编辑器） |
 *
 * **未知类型**不在这里定义：页面保留原始 `config` 并提供原始编辑（明确边界）。
 */

export type NodeFieldKind =
  | 'text'
  | 'textarea'
  | 'number'
  | 'boolean'
  | 'select'
  | 'key-value'
  | 'json'
  | 'string-list'
  | 'condition-list'
  | 'end-status'
  | 'schema';

export interface NodeFieldSpec {
  /** config 内的点号路径，例如 `params.filter`。 */
  path: string;
  label: string;
  kind: NodeFieldKind;
  hint?: string;
  required?: boolean;
  /** select 的取值。 */
  options?: Array<{ value: string; label: string }>;
  /** 必填错误文案（缺省用通用文案）。 */
  requiredMessage?: string;
  /** 是否建议展示在常见配置区（高级字段默认折叠）。 */
  advanced?: boolean;
}

export type NodeValidationErrors = Record<string, string>;

export interface NodeTypeSpec {
  type: string;
  /** 面向用户的类型名（固定源码 registry 的中文题名）。 */
  label: string;
  /** 该类型在固定源码里的分组/用途说明。 */
  description: string;
  fields: NodeFieldSpec[];
  /** 新建该类型节点时的初始 config（与源码初始值一致）。 */
  defaults: Record<string, unknown>;
  /** 配置校验提示（不替代后端校验，只做保存前的前端体检）。 */
  validate?: (config: Record<string, unknown>) => NodeValidationErrors;
}

const ENGINE_OPTIONS = [
  { value: 'math.js', label: 'Math.js 表达式' },
  { value: 'formula.js', label: 'Formula.js 表达式' },
];

const CONDITION_ENGINE_OPTIONS = [{ value: 'basic', label: '基础条件' }, ...ENGINE_OPTIONS];

/** 集合名必填（与源码 `Collection is not configured` 对应）。 */
const COLLECTION_FIELD: NodeFieldSpec = {
  path: 'collection',
  label: '数据表',
  kind: 'text',
  required: true,
  requiredMessage: '请填写数据表名称（必填）',
  hint: '使用 dataSource:collection 形式可以指定非主数据源。',
};

function expressionCheck(config: Record<string, unknown>, path: string, label: string): Record<string, string> {
  const raw = readPath(config, path);
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '') return { [path]: `请填写「${label}」` };
  // 轻量体检：括号/引号不配对时表达式几乎必然失败，提前拦住并给出可理解提示。
  let depth = 0;
  let quote: string | null = null;
  for (const char of value) {
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (depth < 0) break;
  }
  if (depth !== 0 || quote) {
    return { [path]: `「${label}」的括号或引号没有成对，请检查后再保存` };
  }
  return {};
}

/** 按点号路径读取配置值（`params.filter` → `config.params.filter`）。 */
export function readPath(config: Record<string, unknown> | null | undefined, path: string): unknown {
  if (!config) return undefined;
  return path.split('.').reduce<unknown>((current, key) => {
    if (current && typeof current === 'object' && !Array.isArray(current)) {
      return (current as Record<string, unknown>)[key];
    }
    return undefined;
  }, config);
}

/** 按点号路径写配置值（空值会删除该键，避免写出 `null` 语义）。 */
export function writePath(
  config: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const keys = path.split('.');
  const next: Record<string, unknown> = { ...config };
  let cursor: Record<string, unknown> = next;
  for (let index = 0; index < keys.length - 1; index += 1) {
    const key = keys[index];
    const child = cursor[key];
    const clone = child && typeof child === 'object' && !Array.isArray(child) ? { ...(child as Record<string, unknown>) } : {};
    cursor[key] = clone;
    cursor = clone;
  }
  const last = keys[keys.length - 1];
  if (value === undefined) delete cursor[last];
  else cursor[last] = value;
  return next;
}

export const NODE_TYPE_SPECS: Record<string, NodeTypeSpec> = {
  calculation: {
    type: 'calculation',
    label: '计算',
    description: '用表达式计算一个值，结果可以给下游节点引用。',
    fields: [
      {
        path: 'engine',
        label: '计算引擎',
        kind: 'select',
        options: ENGINE_OPTIONS,
        hint: '源码默认 math.js；formula.js 提供表格函数。',
      },
      {
        path: 'expression',
        label: '计算表达式',
        kind: 'textarea',
        required: true,
        requiredMessage: '请填写计算表达式',
        hint: '可以引用前序节点的结果与系统变量，例如 {{$jobsMapByNodeKey.xxx}} 或 {{$context.data.id}}。',
      },
    ],
    defaults: { engine: 'math.js', expression: '' },
    validate: (config) => expressionCheck(config, 'expression', '计算表达式'),
  },
  condition: {
    type: 'condition',
    label: '条件判断',
    description: '按条件决定流程继续或分支到「是 / 否」。',
    fields: [
      {
        path: 'rejectOnFalse',
        label: '判断方式',
        kind: 'select',
        options: [
          { value: 'true', label: '条件成立时继续（不成立则流程失败）' },
          { value: 'false', label: '分支为「是 / 否」两条路径' },
        ],
        hint: '与源码 Mode 选项一致；新建节点默认"继续"。',
      },
      {
        path: 'engine',
        label: '计算引擎',
        kind: 'select',
        options: CONDITION_ENGINE_OPTIONS,
        hint: '基础条件用可视化条件组；math.js / formula.js 用表达式。',
      },
      {
        path: 'calculation',
        label: '基础条件组',
        kind: 'json',
        advanced: true,
        hint: '仅"基础条件"引擎使用；结构与原生条件编辑器一致（and/or + 判断项）。',
      },
      {
        path: 'expression',
        label: '条件表达式',
        kind: 'textarea',
        advanced: true,
        hint: '仅 math.js / formula.js 引擎使用。',
      },
    ],
    defaults: { rejectOnFalse: true, engine: 'basic' },
    validate: (config) => {
      const engine = typeof config.engine === 'string' ? config.engine : 'basic';
      const errors: Record<string, string> = {};
      if (engine === 'basic') {
        const calculation = config.calculation;
        if (calculation === undefined || calculation === null) {
          errors.calculation = '请配置基础条件（当前为空）';
        }
      } else {
        Object.assign(errors, expressionCheck(config, 'expression', '条件表达式'));
      }
      return errors;
    },
  },
  'multi-conditions': {
    type: 'multi-conditions',
    label: '多条件分支',
    description: '按多条条件依次匹配，命中哪条就走哪个分支。',
    fields: [
      {
        path: 'conditions',
        label: '条件列表',
        kind: 'condition-list',
        hint: '每条条件包含标题、引擎与条件内容；顺序即匹配顺序。',
      },
      {
        path: 'continueOnNoMatch',
        label: '都不匹配时继续',
        kind: 'boolean',
        hint: '不勾选时所有条件都不成立会让流程失败。',
      },
    ],
    defaults: { conditions: [], continueOnNoMatch: false },
    validate: (config): NodeValidationErrors => {
      const conditions = Array.isArray(config.conditions) ? config.conditions : [];
      if (conditions.length === 0) return { conditions: '请至少添加一条条件' };
      const missing = conditions.findIndex((item) => {
        const record = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
        return !record.title && !record.expression && !record.calculation;
      });
      return missing >= 0 ? { conditions: `第 ${missing + 1} 条条件还没有内容` } : {};
    },
  },
  query: {
    type: 'query',
    label: '查询数据',
    description: '按条件查询数据表记录，可返回单条或多条。',
    fields: [
      COLLECTION_FIELD,
      { path: 'multiple', label: '查询多条', kind: 'boolean', hint: '不勾选时只取第一条。' },
      { path: 'failOnEmpty', label: '查不到时判定失败', kind: 'boolean' },
      {
        path: 'params.filter',
        label: '查询条件',
        kind: 'json',
        hint: '与接口 filter 同结构，例如 {"status":{"$eq":"open"}}。',
      },
      { path: 'params.appends', label: '附带关联', kind: 'string-list', advanced: true },
      { path: 'params.sort', label: '排序', kind: 'json', advanced: true, hint: '形如 [{"field":"id","direction":"desc"}]。' },
      { path: 'params.page', label: '页码', kind: 'number', advanced: true },
      { path: 'params.pageSize', label: '每页条数', kind: 'number', advanced: true },
    ],
    defaults: { collection: '', multiple: false, params: {}, failOnEmpty: false },
    validate: (config): NodeValidationErrors =>
      typeof config.collection === 'string' && config.collection.trim() !== ''
        ? {}
        : { collection: '请填写数据表名称（必填）' },
  },
  create: {
    type: 'create',
    label: '新增数据',
    description: '向数据表写入一条新记录。',
    fields: [
      COLLECTION_FIELD,
      { path: 'params.values', label: '写入内容', kind: 'key-value', hint: '字段名 → 值；值可以引用前序节点产生的变量。' },
      { path: 'params.appends', label: '附带关联', kind: 'string-list', advanced: true },
    ],
    defaults: { collection: '', params: { values: {} } },
    validate: (config): NodeValidationErrors =>
      typeof config.collection === 'string' && config.collection.trim() !== ''
        ? {}
        : { collection: '请填写数据表名称（必填）' },
  },
  update: {
    type: 'update',
    label: '更新数据',
    description: '按条件更新数据表记录。',
    fields: [
      COLLECTION_FIELD,
      { path: 'params.filter', label: '更新条件', kind: 'json', hint: '不填会更新全部记录，请谨慎。' },
      { path: 'params.values', label: '更新内容', kind: 'key-value' },
      { path: 'params.individualHooks', label: '逐条触发钩子', kind: 'boolean', advanced: true },
    ],
    defaults: { collection: '', params: { values: {} } },
    validate: (config): NodeValidationErrors =>
      typeof config.collection === 'string' && config.collection.trim() !== ''
        ? {}
        : { collection: '请填写数据表名称（必填）' },
  },
  destroy: {
    type: 'destroy',
    label: '删除数据',
    description: '按条件删除数据表记录。',
    fields: [COLLECTION_FIELD, { path: 'params.filter', label: '删除条件', kind: 'json', hint: '不填会删除全部记录，请谨慎。' }],
    defaults: { collection: '', params: {} },
    validate: (config): NodeValidationErrors =>
      typeof config.collection === 'string' && config.collection.trim() !== ''
        ? {}
        : { collection: '请填写数据表名称（必填）' },
  },
  output: {
    type: 'output',
    label: '输出',
    description: '把值写入这次执行的输出，便于在执行详情里查看。',
    fields: [{ path: 'value', label: '输出内容', kind: 'json' }],
    defaults: { value: null },
  },
  end: {
    type: 'end',
    label: '结束流程',
    description: '结束这次执行，并指定最终状态。',
    fields: [{ path: 'endStatus', label: '结束状态', kind: 'end-status', required: true }],
    defaults: { endStatus: 1 },
  },
  manual: {
    type: 'manual',
    label: '人工处理',
    description: '把流程暂停，等人填写表单并选择处理结果。',
    /*
     * 字段与默认值对齐**上游 v1 `Manual` instruction 的 fieldset**
     * （`plugin-workflow-manual/src/client/instruction/index.tsx`）与**上游 server 契约**
     * `ManualConfig`（`src/server/ManualInstruction.ts`）：
     *  - `assignees` 上游 `required`、默认 `[]`；
     *  - `mode` 上游默认 **1**（`ModeConfig`：0=协作处理/所有人共享一个任务，1=分别处理+全部通过，-1=分别处理+任意通过）；
     *  - `title` 上游默认是 `{{useNodeContext().title}}` 模板，这里留空由节点标题兜底
     *    （服务端 `run()` 在 `config.title` 为空时用 `node.title`）；
     *  - `schema` 上游默认 `null`，这里用等价的空 `void` schema，便于产品 schema 编辑器直接编辑；
     *  - `forms` 默认 `{}`。
     */
    fields: [
      { path: 'title', label: '任务名称', kind: 'text', hint: '显示在处理人待办列表里的标题；留空时用节点标题。' },
      {
        path: 'mode',
        label: '处理方式',
        kind: 'select',
        options: [
          { value: '0', label: '协作处理（所有人共享同一个任务）' },
          { value: '1', label: '分别处理（每人一个任务，全部通过才继续）' },
          { value: '-1', label: '分别处理（每人一个任务，任意一人通过即可）' },
        ],
        hint: '只有「协作处理」会让所有负责人共用同一个任务。',
      },
      {
        path: 'assignees',
        label: '负责人',
        kind: 'string-list',
        required: true,
        requiredMessage: '请至少填写一位负责人。',
        hint: '填写负责人的用户编号（可在「用户与权限 → 用户」里查到）；流程到这一步会为每位负责人生成待办。',
      },
      { path: 'forms', label: '处理动作配置', kind: 'json', advanced: true, hint: '表单名 → { 动作、类型、数据来源 }；结构由填写界面决定。' },
      { path: 'schema', label: '填写界面（布局结构）', kind: 'schema', advanced: true },
    ],
    defaults: { assignees: [], mode: 1, forms: {}, schema: { type: 'void', properties: {} } },
  },
};

/**
 * 目标 13000 当前 **enabled** 的其它工作流 instruction 的中文名（本地已注册可用的部分）。
 *
 * 来源：各上游插件 `src/locale/zh-CN.json` 里该 instruction 的 title 键，逐条对应，
 * **不是自造名称**：
 *
 * | type | 上游插件 | 上游 zh-CN 键 |
 * | --- | --- | --- |
 * | script | plugin-workflow-javascript | 原生画布标题 `JavaScript`（`nodes/script.tsx` 的 `tExpr('JavaScript')`） |
 * | aggregate | plugin-workflow-aggregate | `Aggregate` → 聚合查询 |
 * | loop | plugin-workflow-loop | `Loop` → 循环 |
 * | notification | plugin-workflow-notification | `Notification` → 通知 |
 * | cc | plugin-workflow-cc | `CC` → 抄送 |
 * | dateCalculation | plugin-workflow-date-calculation | `Date calculation` → 日期计算 |
 * | delay | plugin-workflow-delay | `Delay` → 延时 |
 * | json-query | plugin-workflow-json-query | `JSON calculation` → JSON 计算 |
 * | json-variable-mapping | plugin-workflow-json-variable-mapping | `JSON variable mapping` → JSON 变量映射 |
 * | mailer | plugin-workflow-mailer | `Mailer` → 邮件发送 |
 * | parallel | plugin-workflow-parallel | `Parallel branch` → 并行分支 |
 * | request | plugin-workflow-request | `HTTP request` → HTTP 请求 |
 * | response-message | plugin-workflow-response-message | `Response message` → 响应消息 |
 * | sql | plugin-workflow-sql | `SQL action` → SQL 操作 |
 * | variable | plugin-workflow-variable | `Variable` → 变量 |
 * | llm | plugin-workflow（核心） | 核心 registry 的 `llm` 指令 |
 *
 * 这些类型**没有**本文件的 `NodeFieldSpec`：它们的字段级配置面板由**原生画布**
 * 的 instruction `FieldsetLoader` 提供（真实源码），本文件不为它们发明字段结构。
 * 这里只提供"新建节点时的中文显示名"。
 */
export const EXTRA_TYPE_LABELS: Record<string, string> = {
  script: 'JavaScript',
  aggregate: '聚合查询',
  loop: '循环',
  notification: '通知',
  cc: '抄送',
  dateCalculation: '日期计算',
  delay: '延时',
  'json-query': 'JSON 计算',
  'json-variable-mapping': 'JSON 变量映射',
  mailer: '邮件发送',
  parallel: '并行分支',
  request: 'HTTP 请求',
  'response-message': '响应消息',
  sql: 'SQL 操作',
  variable: '变量',
  llm: '大模型',
};

/** 任意已注册类型的显示名：优先本文件的字段语义定义，其次上面的上游中文名。 */
export function nodeTypeLabel(type: string | null | undefined): string {
  if (!type) return '未设置';
  return nodeTypeSpec(type)?.label ?? EXTRA_TYPE_LABELS[type] ?? type;
}

/**
 * 旧版（v1）节点类型名 → 现代类型名。
 *
 * 2.2.22 的 v2 registry 只注册现代名（calculation/condition/create/update/destroy/end/output/query/
 * multi-conditions/manual）。历史流程里可能存在 v1 名字（如 `calculation` 在 v1 里也叫这个，
 * 但 `parallel`/`aggregate`/`json-query` 等属其它插件）。**只做已确认的等价映射**，
 * 不确定的一律当作未知类型处理（保留原始 config）。
 */
export const LEGACY_TYPE_ALIASES: Record<string, string> = {};

/** 已知类型的能力查询。 */
export function nodeTypeSpec(type: string | null | undefined): NodeTypeSpec | null {
  if (!type) return null;
  const resolved = LEGACY_TYPE_ALIASES[type] ?? type;
  return NODE_TYPE_SPECS[resolved] ?? null;
}

/** 新建节点下拉用的类型清单（与 v2 registry 的 9 个指令 + manual 对齐）。 */
export const CREATABLE_NODE_TYPES = [
  'calculation',
  'condition',
  'multi-conditions',
  'query',
  'create',
  'update',
  'destroy',
  'output',
  'end',
  'manual',
].map((type) => NODE_TYPE_SPECS[type]);

/** 按节点类型校验当前 config，返回"字段路径 → 中文错误"。 */
export function validateNodeConfig(type: string | null | undefined, config: Record<string, unknown>): Record<string, string> {
  const spec = nodeTypeSpec(type);
  if (!spec) return {};
  const errors: Record<string, string> = {};
  for (const field of spec.fields) {
    if (!field.required) continue;
    const value = readPath(config, field.path);
    const empty = value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
    if (empty) errors[field.path] = field.requiredMessage ?? `请填写「${field.label}」`;
  }
  return { ...errors, ...(spec.validate?.(config) ?? {}) };
}

/** 用类型默认值生成一份新节点的初始 config。 */
export function defaultConfigFor(type: string): Record<string, unknown> {
  const spec = nodeTypeSpec(type);
  return spec ? (JSON.parse(JSON.stringify(spec.defaults)) as Record<string, unknown>) : {};
}
