import { asRecord, readArray, readBoolean, readString } from '../workflow/format';

/**
 * 人工处理表单的 schema 解析（组 C 独占）。
 *
 * 只实现**已由源码确认**的那部分约定（十页闭环 §B1）：
 *  - 渲染布局内联在 `node.config.schema`（Formily 结构）；
 *  - `formKey` = 表单块 schema 的**第一个顶层属性名**（原生 `FormBlockProvider` 就是
 *    `Object.keys(fieldSchema.toJSON().properties ?? {})[0]`）；
 *  - 处理配置在 `node.config.forms[formKey]`（`actions[].key/status`、`type`、`dataSource`）；
 *  - 提交体 `{ result: { [formKey]: 表单值, _: actionKey } }`，`_` 与 formKey 同级。
 *
 * 不认识的部分**不猜**：解析器只负责把结构读出来，未知组件由渲染层原样标注。
 */

export interface FormlyNode {
  type?: string;
  name?: string;
  title?: string;
  required?: boolean;
  description?: string;
  enum?: Array<{ label?: string; value?: unknown }>;
  component?: string;
  componentProps?: Record<string, unknown>;
  decorator?: string;
  properties: Record<string, FormlyNode>;
  /** 原始 schema 片段，渲染层需要时可直接查看。 */
  raw: Record<string, unknown>;
}

function toNode(value: unknown, propertyKey?: string): FormlyNode | null {
  const record = asRecord(value);
  if (!record) return null;
  const properties: Record<string, FormlyNode> = {};
  for (const [key, child] of Object.entries(asRecord(record.properties) ?? {})) {
    const node = toNode(child, key);
    if (node) properties[key] = node;
  }
  const enumRaw = readArray(record, 'enum');
  return {
    type: readString(record, 'type') ?? undefined,
    // Formily 字段名缺省就是它在 properties 里的属性名，读取时必须保留这个来源。
    name: readString(record, 'name') ?? propertyKey,
    title: readString(record, 'title') ?? undefined,
    required: readBoolean(record, 'required') === true,
    description: readString(record, 'description') ?? undefined,
    enum: enumRaw.length
      ? enumRaw.map((entry) => ({
          label: readString(entry, 'label') ?? String(asRecord(entry)?.value ?? ''),
          value: asRecord(entry)?.value,
        }))
      : undefined,
    component: readString(record, 'x-component') ?? undefined,
    componentProps: (asRecord(record)?.['x-component-props'] ?? undefined) as Record<string, unknown> | undefined,
    decorator: readString(record, 'x-decorator') ?? undefined,
    properties,
    raw: record,
  };
}

export function parseSchema(schema: unknown): FormlyNode | null {
  return toNode(schema);
}

/** 原生表单块的组件名（`Form`/`FormV2` 都承载一个 Formily 表单）。 */
export const FORM_COMPONENTS = ['Form', 'FormV2', 'FormLayout'] as const;

export function isFormComponent(component: string | undefined): boolean {
  return component !== undefined && (FORM_COMPONENTS as readonly string[]).includes(component);
}

/**
 * 把 `node.config.schema` 归一成 Formily 根 schema。
 *
 * **真实形状**（两处源码证据）：
 *  - 服务端迁移 `plugin-workflow-manual/dist/server/migrations/20240325213145-fix-schema.js`
 *    把配置重建为 `{ properties: schema }`，即 `config.schema` 本身就是**顶层属性表**（键=字段名）；
 *  - 客户端运行时 `plugin-workflow-manual/dist/client` 直接
 *    `SchemaComponent({ schema: { type:'void', name:'manual-<id>', 'x-component':'Tabs', properties: node.config.schema } })`。
 *
 * 旧写法（带 `type:'void'` + `properties` 的根 schema）在历史配置/旧测试里出现过，这里一并兼容；
 * 只做"根包装"，不解读、不改写任何字段、layout 或 `x-reactions`。
 */
export function normalizeSchemaRoot(raw: unknown): Record<string, unknown> | null {
  const record = asRecord(raw);
  if (!record) return null;
  const nested = asRecord(record.properties);
  const looksLikeRootSchema = typeof record.type === 'string' || typeof record['x-component'] === 'string';
  if (looksLikeRootSchema && nested) {
    return {
      type: 'void',
      ...(typeof record.name === 'string' ? { name: record.name } : {}),
      ...(typeof record['x-component'] === 'string' ? { 'x-component': record['x-component'] } : {}),
      properties: nested,
    };
  }
  return { type: 'void', properties: record };
}

/**
 * `formKey` 的权威来源：提交体 `result[formKey]` 与 `node.config.forms[formKey]` 共用的键。
 *
 * 原生结构里它是**表块字段的第一个属性名**（即内层 `Form`/`FormV2` 字段的名字）：
 *  - `plugin-workflow-manual` 的 `parseFormOptions` 取 `Object.keys(blockSchema.properties)[0]`；
 *  - 运行时 `useSubmit` 取 `useFieldSchema().parent.parent.name`（= 该 Form 字段名）。
 *
 * 这里按同一顺序列候选（内层表单字段名 → 表块名 → 第一个属性名 → 祖先路径），
 * 取第一个出现在 `forms` 配置里的名字；都不在时退回第一个候选，**不猜**别的。
 */
export function resolveFormKey(
  blockSchema: Record<string, unknown>,
  forms: Record<string, unknown>,
  ancestorNames: string[] = [],
): string {
  const properties = asRecord(blockSchema.properties) ?? {};
  const firstKey = Object.keys(properties)[0];
  const first = firstKey ? asRecord(properties[firstKey]) : null;
  const firstName =
    first && isFormComponent(typeof first['x-component'] === 'string' ? first['x-component'] : undefined)
      ? (typeof first.name === 'string' && first.name.length > 0 ? first.name : firstKey)
      : null;
  const ownName = typeof blockSchema.name === 'string' && blockSchema.name.length > 0 ? blockSchema.name : null;
  const candidates = [firstName, ownName, firstKey, ...[...ancestorNames].reverse()].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  return candidates.find((name) => Object.prototype.hasOwnProperty.call(forms, name)) ?? candidates[0] ?? 'form';
}

/**
 * schema 里声明的处理动作名（`ActionBar` 下的 `Action` 字段名）。
 *
 * 这些名字与 `node.config.forms[formKey].actions[].key` 同源；schema 里有动作时
 * 就由 schema 的 ActionBar 渲染按钮，没有时才用 forms 配置兜底。
 */
export function schemaActionNamesOf(block: ManualFormBlock): string[] {
  const names: string[] = [];
  const walk = (node: FormlyNode, depth: number) => {
    if (depth > 12) return;
    for (const child of Object.values(node.properties)) {
      if (child.component === 'Action' && child.name) names.push(child.name);
      walk(child, depth + 1);
    }
  };
  walk(block.raw, 0);
  return names;
}

export interface ManualActionConfig {
  key: string;
  label: string;
  status?: unknown;
}

export interface ManualFormBlock {
  /** 表单标识：schema 顶层属性名，也是提交体 `result[formKey]` 的键。 */
  formKey: string;
  /** 该表单块的位置路径（用于展示与排错）。 */
  path: string[];
  /** 表单块内字段（不含布局包装）。 */
  fields: FormlyNode[];
  /** 处理动作：`node.config.forms[formKey].actions[]`。 */
  actions: ManualActionConfig[];
  /** schema 的 ActionBar 里声明的动作名（与 `actions[].key` 同源）。 */
  schemaActions: string[];
  /** 处理类型（create/update 等）与数据源，用于文案说明。 */
  handlerType: string | null;
  dataSource: string | null;
  collection: string | null;
  /** schema 里声明的初始值。 */
  initialValues: Record<string, unknown>;
  raw: FormlyNode;
}

const FORM_BLOCK_DECORATORS = [
  'FormBlockProvider',
  'CustomFormBlockProvider',
  'FormBlock',
  'DetailsBlockProvider',
];
const LAYOUT_COMPONENTS = new Set([
  'Card',
  'CardItem',
  'Grid',
  'Grid.Row',
  'GridRow',
  'Grid.Col',
  'GridCol',
  'Tabs',
  'TabPane',
  'Space',
  'FormLayout',
  'Form',
  'FormV2',
  'FormItem',
  'Page',
  'BlockItem',
  'ActionBar',
  'Action',
  'DetailsBlockProvider',
  'Details',
  'Drawer',
  'Collapse',
  'CollapseItem',
  'Divider',
  'VoidField',
]);

function isFormBlock(node: FormlyNode): boolean {
  if (node.decorator && FORM_BLOCK_DECORATORS.includes(node.decorator)) return true;
  if (node.component && ['Form', 'FormV2', 'FormBlockProvider', 'FormLayout'].includes(node.component)) return true;
  return false;
}

function collectFields(node: FormlyNode, out: FormlyNode[], depth = 0): void {
  if (depth > 12) return;
  for (const child of Object.values(node.properties)) {
    if (child.component && !LAYOUT_COMPONENTS.has(child.component)) {
      out.push(child);
    }
    collectFields(child, out, depth + 1);
  }
}

interface FormsConfig {
  actions?: Array<{ key?: unknown; status?: unknown; title?: unknown }>;
  type?: unknown;
  dataSource?: unknown;
  collection?: unknown;
}

function actionsOf(forms: Record<string, unknown>, formKey: string): ManualActionConfig[] {
  const config = asRecord(forms[formKey]) as FormsConfig | null;
  const actions: NonNullable<FormsConfig['actions']> = Array.isArray(config?.actions) ? config.actions : [];
  return actions.map((action, index) => {
    const key = typeof action?.key === 'string' && action.key.length > 0 ? action.key : `action-${index + 1}`;
    const title = typeof action?.title === 'string' && action.title.length > 0 ? action.title : null;
    return { key, label: title ?? defaultActionLabel(key), status: action?.status };
  });
}

function defaultActionLabel(key: string): string {
  const known: Record<string, string> = {
    submit: '提交',
    approve: '通过',
    reject: '否决',
    save: '保存',
    continue: '继续',
  };
  return known[key] ?? key;
}

/**
 * 从 `node.config.schema` 中找出所有表单块，并关联 `node.config.forms[formKey]` 的处理配置。
 *
 * 找不到表单块时返回空数组，调用方据此显示"该节点的表单定义无法识别"，
 * 而不是伪造一个表单。
 */
export function collectFormBlocks(schema: unknown, forms: Record<string, unknown>): ManualFormBlock[] {
  const root = parseSchema(normalizeSchemaRoot(schema));
  if (!root) return [];
  const blocks: ManualFormBlock[] = [];

  const walk = (node: FormlyNode, path: string[], depth: number) => {
    if (depth > 12) return;
    for (const [key, child] of Object.entries(node.properties)) {
      const childPath = [...path, key];
      if (isFormBlock(child)) {
        // `formKey` 与原生 `parseFormOptions` / `useSubmit` 用同一套解析（见 `resolveFormKey`）。
        const formKey = resolveFormKey(child.raw, forms, childPath);
        const config = (asRecord(forms[formKey]) ?? {}) as FormsConfig;
        const fields: FormlyNode[] = [];
        collectFields(child, fields);
        const block: ManualFormBlock = {
          formKey,
          path: childPath,
          fields,
          actions: actionsOf(forms, formKey),
          schemaActions: [],
          handlerType: typeof config.type === 'string' ? config.type : null,
          dataSource: typeof config.dataSource === 'string' ? config.dataSource : null,
          collection: typeof config.collection === 'string' ? config.collection : null,
          initialValues: asRecord(child.raw['x-initial-values']) ?? {},
          raw: child,
        };
        block.schemaActions = schemaActionNamesOf(block);
        blocks.push(block);
        continue;
      }
      walk(child, childPath, depth + 1);
    }
  };

  walk(root, [], 0);
  return blocks;
}

/** 一个表单块已经填好的值（按字段名）。 */
export type FormValues = Record<string, unknown>;

/**
 * 是否同一个用户。
 *
 * 为什么需要归一：`users.id` / `workflowManualTasks.userId` 在 NocoBase 是 bigint，
 * 序列化后可能是数字或字符串（真实 2.2.20 客户端用严格 `!==` 比较，遇到类型不一致会
 * 把本人误判成"非受理人"）。这里按 id 的字符串值比较，语义仍是"同一个用户"，
 * 不放宽任何权限判定。
 */
export function sameUserId(left: unknown, right: unknown): boolean {
  if (left === null || left === undefined || right === null || right === undefined) return false;
  if (left === '' || right === '') return false;
  return String(left) === String(right);
}

/** 校验必填字段；返回"字段名 → 错误文案"。空白字符串与未选择都算未填。 */
export function validateRequired(block: ManualFormBlock, values: FormValues): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of block.fields) {
    if (!field.required) continue;
    const name = field.name;
    if (!name) continue;
    const value = values[name];
    if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
      errors[name] = `请填写「${field.title ?? name}」`;
    }
  }
  return errors;
}

/**
 * 提交体：`{ result: { [formKey]: values, _: actionKey } }`。
 *
 * 服务端从 `result` 里取第一个非 `_` 的键作为 formKey，因此每个表单块单独提交一次。
 */
export function buildSubmitPayload(formKey: string, actionKey: string, values: FormValues): Record<string, unknown> {
  return { result: { [formKey]: values, _: actionKey } };
}

/** 供页面复用：把一个表单块的值组装成提交体（与渲染器使用同一实现）。 */
export function payloadFor(block: ManualFormBlock, actionKey: string, values: FormValues): Record<string, unknown> {
  return buildSubmitPayload(block.formKey, actionKey, values);
}

/** 读取作业结果里的 `_`（上次选择的处理动作），用于只读展示。 */
export function lastActionOf(result: unknown): string | null {
  return readString(asRecord(result), '_');
}

/** 把 schema 字段的初始值读出来（原生把 `result[formKey]` 当作表单初始值）。 */
export function initialValuesOf(block: ManualFormBlock, result: unknown): FormValues {
  const stored = asRecord(asRecord(result)?.[block.formKey]);
  return { ...block.initialValues, ...(stored ?? {}) };
}

/* ------------------------------------------------------------------ *
 * 日期/时间字段契约（按服务端已有 collection field.type/interface/dateFormat）
 * ------------------------------------------------------------------ */

export type TemporalKind = 'date' | 'datetime' | 'time';

export interface TemporalFieldContract {
  /** 字段名（提交体 `result[formKey][name]` 的键）。 */
  name: string;
  kind: TemporalKind;
  /** 归一后的字符串格式（`date` 为 `YYYY-MM-DD`，`time` 为 `HH:mm:ss`，`datetime` 保持 ISO）。 */
  format: string;
}

const DATE_COMPONENTS: Record<string, TemporalKind> = {
  DatePicker: 'date',
  TimePicker: 'time',
};

/**
 * 从 `node.config.schema` 读出日期/时间字段的**契约**（不猜、不全局截断）：
 *  - `x-component` 是 `DatePicker`/`TimePicker` 才纳入；
 *  - 字段类型 `type: 'datetime'` 或 `x-component-props.showTime === true` → datetime；
 *  - `x-component-props.dateFormat` 优先（服务端 collection field 的 uiSchema 就写在这里）；
 *  - 否则按已确认契约给默认：date → `YYYY-MM-DD`，time → `HH:mm:ss`。
 */
export function collectTemporalContracts(schema: unknown): TemporalFieldContract[] {
  const contracts: TemporalFieldContract[] = [];
  const walk = (node: FormlyNode, depth: number) => {
    if (depth > 12) return;
    for (const child of Object.values(node.properties)) {
      const kind = child.component ? DATE_COMPONENTS[child.component] : undefined;
      if (kind && child.name) {
        const props = child.componentProps ?? {};
        const showTime = props.showTime === true;
        const resolvedKind: TemporalKind = kind === 'date' && (child.type === 'datetime' || showTime) ? 'datetime' : kind;
        const declared = typeof props.dateFormat === 'string' && props.dateFormat.length > 0 ? props.dateFormat : null;
        contracts.push({
          name: child.name,
          kind: resolvedKind,
          format:
            declared ??
            (resolvedKind === 'date' ? 'YYYY-MM-DD' : resolvedKind === 'time' ? 'HH:mm:ss' : 'YYYY-MM-DDTHH:mm:ss.SSSZ'),
        });
      }
      walk(child, depth + 1);
    }
  };
  const root = parseSchema(normalizeSchemaRoot(schema));
  if (root) walk(root, 0);
  return contracts;
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

function formatDate(date: Date, format: string): string {
  return format
    .replace('YYYY', String(date.getFullYear()))
    .replace('MM', pad(date.getMonth() + 1))
    .replace('DD', pad(date.getDate()))
    .replace('HH', pad(date.getHours()))
    .replace('mm', pad(date.getMinutes()))
    .replace('ss', pad(date.getSeconds()));
}

/**
 * 按契约归一日期/时间值：值来自真实 antd DatePicker（dayjs 或 dayjs 序列化后的 ISO 字符串），
 * 只有**声明了日期契约的字段**会被转换，不对整棵表单做全局截断。
 */
export function normalizeTemporalValues(
  values: FormValues,
  contracts: TemporalFieldContract[],
): FormValues {
  if (contracts.length === 0) return values;
  const next: FormValues = { ...values };
  for (const contract of contracts) {
    const raw = next[contract.name];
    if (raw === undefined || raw === null || raw === '') continue;
    const date = new Date(typeof raw === 'object' && raw !== null && 'toDate' in raw ? (raw as { toDate: () => Date }).toDate() : (raw as string | number | Date));
    if (Number.isNaN(date.getTime())) continue;
    if (contract.kind === 'datetime' && contract.format === 'YYYY-MM-DDTHH:mm:ss.SSSZ') {
      next[contract.name] = date.toISOString();
      continue;
    }
    next[contract.name] = formatDate(date, contract.format);
  }
  return next;
}
