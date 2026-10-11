import { createForm, type Form, type GeneralField } from '@formily/core';
import {
  createSchemaField,
  FormProvider,
  observer,
  SchemaComponentsContext,
  SchemaExpressionScopeContext,
  SchemaOptionsContext,
  useField,
  useFieldSchema,
  useForm,
} from '@formily/react';
import {
  Checkbox as AntCheckbox,
  Input as AntInput,
  InputNumber as AntInputNumber,
  Radio as AntRadio,
  Select as AntSelect,
  Switch as AntSwitch,
} from 'antd';
import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from 'react';
import { asRecord, readString } from '../../workflow/format';
import { isFormComponent, resolveFormKey, sameUserId, type FormValues, type ManualFormBlock } from '../manualForm';
import styles from '../tasks.module.css';

/**
 * TD-02：`node.config.schema` 的**真实 Formily 宿主**（组 C 独占）。
 *
 * 边界（对齐原生 `plugin-workflow-manual` 客户端源码，不重写 schema 解析）：
 *  1. 渲染引擎是真实 `@formily/react`：`createSchemaField()` 直接吃服务端下发的 schema，
 *     由 Formily 处理 `x-component` / `x-decorator` / `x-component-props` / `x-decorator-props` /
 *     `required` / `enum` / `default` / `x-validator` / **`x-reactions`**（`when`/`fulfill`/`otherwise`/`dependencies`）；
 *  2. 同名注册原生宿主组件：`FormBlockProvider` / `CustomFormBlockProvider` / `DetailsBlockProvider` /
 *     `ActionBarProvider` / `ManualActionStatusProvider` / `Form`(`FormV2`) / `ActionBar` / `Action` / 字段组件，
 *     语义（记录初始值、只读 pattern、动作可见性、提交形状）取自原生源码；
 *  3. `x-use-component-props` 按原生 `SchemaComponent` 的做法从宿主 hook 表解析并合并；
 *  4. 提交体与原生 `useSubmit` 一致：`{ result: { [formKey]: {...form.values, ...assignedValues}, _: actionKey } }`。
 *
 * **不冒充**：`@nocobase/client` 的 `SchemaComponent` 在本公共基线上 import 阶段不可用
 * （证据见报告 public-needs 段），因此这里直接使用它内部包装的同一套真实 Formily API；
 * `registerManualSchemaComponents` 保留为公共接入点：依赖就绪后按同名注册真实原生组件即整体切换。
 */

/* ------------------------------------------------------------------ *
 * 组件注册表
 * ------------------------------------------------------------------ */

export interface ManualSchemaComponentProps {
  value?: unknown;
  onChange?: (value: unknown) => void;
  disabled?: boolean;
  readOnly?: boolean;
  [key: string]: unknown;
}

export type ManualSchemaComponent = ComponentType<ManualSchemaComponentProps>;

let componentRegistry: Record<string, ManualSchemaComponent> = {};
let registryVersion = 0;
const registryListeners = new Set<() => void>();

/** 按 `x-component` 名注册/替换宿主组件（注册真实原生组件即切换渲染层）。 */
export function registerManualSchemaComponents(registry: Record<string, ManualSchemaComponent>): void {
  componentRegistry = { ...componentRegistry, ...registry };
  registryVersion += 1;
  for (const listener of registryListeners) listener();
}

export function getManualSchemaComponents(): Record<string, ManualSchemaComponent> {
  return componentRegistry;
}

function subscribeRegistry(listener: () => void): () => void {
  registryListeners.add(listener);
  return () => {
    registryListeners.delete(listener);
  };
}

function registrySnapshot(): number {
  return registryVersion;
}

/* ------------------------------------------------------------------ *
 * 宿主上下文
 * ------------------------------------------------------------------ */

export interface ManualFormHostValue {
  blocks: ManualFormBlock[];
  forms: Record<string, unknown>;
  storedResult: Record<string, unknown> | null;
  job: Record<string, unknown> | null;
  execution: Record<string, unknown> | null;
  currentUserId: string | null;
  /** 任务已处理：表单按 readPretty 回显（这是"看结果"，不是"没权限"）。 */
  readOnly: boolean;
  /** 当前用户不是受理人：字段 disabled、动作不渲染（与原生 `useFormBlockProps` 的 disabled 同义）。 */
  disabled: boolean;
  submitting: boolean;
  onSubmit: (block: ManualFormBlock, actionKey: string, values: FormValues) => void;
  /** 关联字段候选值：由页面走产品 SDK / P1 身份角色世代管线注入。 */
  loadAssociationOptions?: (
    block: ManualFormBlock,
    field: { name?: string; title?: string; component?: string; raw: Record<string, unknown> },
  ) => Promise<Array<{ label: string; value: unknown }>>;
}

const ManualFormHostContext = createContext<ManualFormHostValue | null>(null);

function useHost(): ManualFormHostValue {
  const host = useContext(ManualFormHostContext);
  if (!host) throw new Error('ManualSchemaHost 之外不能渲染 schema 组件');
  return host;
}

interface FormBlockValue {
  form: Form;
  formKey: string;
  block: ManualFormBlock | null;
  readOnly: boolean;
  stored: FormValues;
}

const FormBlockContext = createContext<FormBlockValue | null>(null);

function useFormBlock(): FormBlockValue {
  const block = useContext(FormBlockContext);
  if (!block) throw new Error('FormBlockProvider 之外不能渲染表单字段');
  return block;
}

/** 原生 `x-use-component-props` 引用的宿主 hook（与原生 scope 同名）。 */
const HOST_HOOKS: Record<string, () => Record<string, unknown>> = {
  useFormBlockProps: () => ({ form: useContext(FormBlockContext)?.form }),
  useDetailsBlockProps: () => ({ form: useContext(FormBlockContext)?.form }),
};

function useSchemaComponentProps<T extends Record<string, unknown>>(base: T): T {
  const schema = schemaRecord(useFieldSchema());
  const name = schema['x-use-component-props'];
  const hook = typeof name === 'string' ? HOST_HOOKS[name] : undefined;
  if (!hook) return base;
  try {
    return { ...base, ...hook() };
  } catch (error) {
    console.error('[crewloom] x-use-component-props 解析失败', name, error);
    return base;
  }
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function schemaRecord(schema: unknown): Record<string, unknown> {
  return (schema ?? {}) as Record<string, unknown>;
}

/** Formily `Schema` 实例 → 原始 JSON 快照（`x-*` 关键字都在里面）。 */
function schemaJson(schema: Record<string, unknown>): Record<string, unknown> {
  const toJSON = (schema as { toJSON?: () => Record<string, unknown> }).toJSON;
  if (typeof toJSON === 'function') {
    try {
      return toJSON.call(schema);
    } catch {
      return schema;
    }
  }
  return schema;
}

/** `GeneralField` 是联合类型；这里只取字段组件会读的字段状态（required/name/selfErrors）。 */
interface FieldState {
  required?: boolean;
  selfErrors?: string[];
  name?: string;
}

function useFieldState(): FieldState {
  return useField() as unknown as FieldState;
}

function titleOf(schema: Record<string, unknown>): string | undefined {
  const title = schema.title;
  return typeof title === 'string' && title.length > 0 ? title : undefined;
}

function ariaOf(schema: Record<string, unknown>): { 'aria-label'?: string } {
  const title = titleOf(schema);
  return title ? { 'aria-label': title } : {};
}

function toText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function enumOptionsOf(schema: Record<string, unknown>): Array<{ label: string; value: unknown }> {
  const source = Array.isArray(schema.enum) ? schema.enum : [];
  return source.map((entry) => {
    const record = asRecord(entry) ?? {};
    return { label: String(record.label ?? record.value ?? ''), value: record.value };
  });
}

/**
 * 渲染前的最小归一（**不改写 schema 语义**）：
 *  1. 带 `properties` 但缺 `type` 的节点补 `type:'void'`：真实 NocoBase 设计器始终写 `type`，
 *     历史/手工 schema 可能省略；Formily 缺 `type` 会当数据字段处理，补 void 才是它的原意；
 *  2. 必填字段补中文文案：原生文案由 i18n 编译，这里用 Formily 的 `x-validator` 规则对象承载同一语义，
 *     仍然由 Formily 校验必填，不改变必填含义。
 */
export function prepareSchemaForFormily(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = asRecord(schema.properties);
  const next: Record<string, unknown> = { ...schema };
  if (typeof next.type !== 'string' && properties) next.type = 'void';
  if (properties) {
    const clonedProperties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(properties)) {
      const child = asRecord(value);
      if (!child) continue;
      const cloned = prepareSchemaForFormily(child);
      if (child.required === true && child['x-validator'] === undefined) {
        const title = titleOf(child) ?? key;
        cloned['x-validator'] = { required: true, message: `请填写「${title}」` };
      }
      clonedProperties[key] = cloned;
    }
    next.properties = clonedProperties;
  }
  return next;
}

/* ------------------------------------------------------------------ *
 * 字段外壳
 * ------------------------------------------------------------------ */

/**
 * 字段外壳（label / 必填 / 描述 / Formily 反馈）。
 *
 * 用 Formily 的 `observer` 包一层：`selfErrors` 是 observable，Formily 的 `ReactiveField`
 * 本身不读它，只有观察它的组件才会在 `form.submit()` 校验失败后重渲染并显示错误。
 */
const FieldShell = observer(function FieldShell({
  children,
  hideLabel = false,
}: {
  children: ReactNode;
  hideLabel?: boolean;
}) {
  const field = useFieldState();
  const schema = schemaRecord(useFieldSchema());
  const title = titleOf(schema);
  const required = field.required === true || schema.required === true;
  const errors = (field.selfErrors ?? []).filter(Boolean);
  const description = typeof schema.description === 'string' ? schema.description : undefined;
  return (
    <div className={styles.formField}>
      {!hideLabel && title ? (
        <span className={styles.fieldLabel}>
          {title}
          {required ? <span className={styles.requiredMark}>*</span> : null}
        </span>
      ) : null}
      {children}
      {description ? <span className={styles.cellHint}>{description}</span> : null}
      {errors.length > 0 ? <span className={styles.fieldError}>{errors[0]}</span> : null}
    </div>
  );
});

/** 有 `x-decorator: FormItem` 时 label 由装饰器负责；否则字段组件自己出 label。 */
function FieldBody({ children }: { children: ReactNode }) {
  const schema = schemaRecord(useFieldSchema());
  if (schema['x-decorator'] === 'FormItem') return <>{children}</>;
  return <FieldShell>{children}</FieldShell>;
}

/* ------------------------------------------------------------------ *
 * 控件（只出控件本身，由字段组件 / CollectionField 复用）
 * ------------------------------------------------------------------ */

interface ControlProps {
  schema: Record<string, unknown>;
  props: ManualSchemaComponentProps;
}

function ControlInput({ schema, props }: ControlProps) {
  return (
    <AntInput
      {...ariaOf(schema)}
      className={styles.input}
      type={typeof props.type === 'string' ? props.type : undefined}
      disabled={props.disabled}
      readOnly={props.readOnly}
      placeholder={typeof props.placeholder === 'string' ? props.placeholder : undefined}
      value={toText(props.value)}
      onChange={(event) => props.onChange?.(event.target.value)}
    />
  );
}

function ControlTextArea({ schema, props }: ControlProps) {
  return (
    <AntInput.TextArea
      {...ariaOf(schema)}
      className={styles.textarea}
      rows={typeof props.rows === 'number' ? props.rows : 3}
      disabled={props.disabled}
      readOnly={props.readOnly}
      value={toText(props.value)}
      onChange={(event) => props.onChange?.(event.target.value)}
    />
  );
}

function ControlNumber({ schema, props }: ControlProps) {
  const raw = props.value;
  const numeric = typeof raw === 'number' ? raw : raw === null || raw === undefined || raw === '' ? null : Number(raw);
  return (
    <AntInputNumber
      {...ariaOf(schema)}
      className={styles.input}
      style={{ width: '100%' }}
      disabled={props.disabled}
      readOnly={props.readOnly}
      precision={typeof props.precision === 'number' ? props.precision : undefined}
      value={numeric === null || Number.isNaN(numeric) ? null : numeric}
      onChange={(next) => props.onChange?.(next === null || next === undefined || Number.isNaN(next) ? null : next)}
    />
  );
}

function ControlSelect({ schema, props }: ControlProps) {
  const multiple = props.mode === 'multiple' || schema.type === 'array';
  const options = enumOptionsOf(schema);
  return (
    <AntSelect
      {...ariaOf(schema)}
      className={styles.select}
      style={{ width: '100%' }}
      disabled={props.disabled}
      mode={multiple ? 'multiple' : undefined}
      allowClear
      placeholder="请选择"
      options={options as never}
      value={(multiple ? (Array.isArray(props.value) ? props.value : []) : props.value ?? undefined) as never}
      onChange={(next) => props.onChange?.(next ?? null)}
    />
  );
}

function ControlCheckbox({ schema, props }: ControlProps) {
  return (
    <AntCheckbox
      {...ariaOf(schema)}
      disabled={props.disabled}
      checked={props.value === true}
      onChange={(event) => props.onChange?.(event.target.checked)}
    >
      是
    </AntCheckbox>
  );
}

function ControlSwitch({ schema, props }: ControlProps) {
  return (
    <AntSwitch
      {...ariaOf(schema)}
      disabled={props.disabled}
      checked={props.value === true}
      onChange={(next) => props.onChange?.(next)}
    />
  );
}

function ControlCheckboxGroup({ schema, props }: ControlProps) {
  return (
    <AntCheckbox.Group
      aria-label={titleOf(schema)}
      disabled={props.disabled}
      options={enumOptionsOf(schema) as never}
      value={(Array.isArray(props.value) ? props.value : []) as never}
      onChange={(next) => props.onChange?.(next)}
    />
  );
}

function ControlRadioGroup({ schema, props }: ControlProps) {
  return (
    <AntRadio.Group
      aria-label={titleOf(schema)}
      disabled={props.disabled}
      options={enumOptionsOf(schema) as never}
      value={props.value as never}
      onChange={(event) => props.onChange?.(event.target.value)}
    />
  );
}

/** 日期/时间：值仍按 schema 的字符串语义提交（`YYYY-MM-DD` / `HH:mm`），与后端字段一致。 */
function ControlTemporal({ schema, props }: ControlProps) {
  const component = readString(schema, 'x-component');
  const showTime = props.showTime === true || (component === 'DatePicker' && schema.type === 'datetime');
  const type = component === 'TimePicker' ? 'time' : showTime ? 'datetime-local' : 'date';
  const slice = type === 'time' ? 5 : type === 'datetime-local' ? 16 : 10;
  return (
    <input
      {...ariaOf(schema)}
      className={styles.input}
      type={type}
      disabled={props.disabled || props.readOnly}
      value={toText(props.value).slice(0, slice)}
      onChange={(event) => props.onChange?.(event.target.value === '' ? null : event.target.value)}
    />
  );
}

function ControlJson({ schema, props }: ControlProps) {
  const [text, setText] = useState(() => (typeof props.value === 'string' ? props.value : toText(props.value)));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setText(typeof props.value === 'string' ? props.value : toText(props.value));
    setInvalid(false);
  }, [props.value]);
  return (
    <>
      <textarea
        {...ariaOf(schema)}
        className={styles.textarea}
        rows={4}
        spellCheck={false}
        disabled={props.disabled || props.readOnly}
        value={text}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          if (next.trim() === '') {
            setInvalid(false);
            props.onChange?.(null);
            return;
          }
          try {
            props.onChange?.(JSON.parse(next));
            setInvalid(false);
          } catch {
            setInvalid(true);
          }
        }}
      />
      {invalid ? <span className={styles.fieldError}>JSON 还没写完整，提交前必须能解析。</span> : null}
    </>
  );
}

/**
 * 关联字段（`AssociationField`）。
 *
 * 选项 / 回显：schema 自带 `enum` 直接用；否则用页面注入的 `loadAssociationOptions`
 * （同一 SDK / 身份角色世代管线）；都拿不到时用可自由输入的 tags 选择器，
 * 保证用户仍能录入，且**提交仍是数组**（不拼字符串）。
 */
function ControlAssociation({ schema, props }: ControlProps) {
  const host = useHost();
  const block = useFormBlock();
  const multiple = props.multiple === true || schema.type === 'array';
  const [loaded, setLoaded] = useState<Array<{ label: string; value: unknown }>>([]);
  const [loading, setLoading] = useState(false);
  const staticOptions = useMemo(() => enumOptionsOf(schema), [schema]);

  useEffect(() => {
    if (staticOptions.length > 0 || !host.loadAssociationOptions || !block.block) return undefined;
    let cancelled = false;
    setLoading(true);
    void host
      .loadAssociationOptions(block.block, {
        name: readString(schema, 'name') ?? undefined,
        title: titleOf(schema),
        component: 'AssociationField',
        // 传原始 JSON（Schema 实例的 `x-*` 关键字要走 toJSON 才是完整快照）。
        raw: schemaJson(schema),
      })
      .then((options) => {
        if (!cancelled) setLoaded(options);
      })
      .catch((error) => {
        console.error('[crewloom] 关联字段候选值读取失败', error);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [block.block, host, schema, staticOptions.length]);

  const options = useMemo(() => {
    const base = staticOptions.length > 0 ? staticOptions : loaded;
    const selected = multiple
      ? Array.isArray(props.value)
        ? props.value
        : []
      : props.value === undefined || props.value === null
        ? []
        : [props.value];
    const missing = selected
      .filter((entry) => !base.some((option) => String(option.value) === String(entry)))
      .map((entry) => ({ label: String(entry), value: entry }));
    return [...base, ...missing];
  }, [staticOptions, loaded, multiple, props.value]);

  const selectedValue = multiple
    ? Array.isArray(props.value)
      ? props.value
      : []
    : props.value === undefined || props.value === null || props.value === ''
      ? []
      : [props.value];

  return (
    <AntSelect
      {...ariaOf(schema)}
      className={styles.select}
      style={{ width: '100%' }}
      disabled={props.disabled}
      loading={loading}
      mode="tags"
      allowClear
      placeholder="选择或输入关联值"
      options={options as never}
      value={selectedValue as never}
      onChange={(next) => {
        const list = Array.isArray(next) ? next : next === undefined || next === null ? [] : [next];
        props.onChange?.(multiple ? list : (list[0] ?? null));
      }}
    />
  );
}

/* ------------------------------------------------------------------ *
 * 字段组件（`x-component` 名 → 控件）
 * ------------------------------------------------------------------ */

function makeFieldControl(Control: (props: ControlProps) => ReactNode): ManualSchemaComponent {
  return function FieldComponent(props: ManualSchemaComponentProps) {
    const schema = schemaRecord(useFieldSchema());
    return (
      <FieldBody>
        <Control schema={schema} props={props} />
      </FieldBody>
    );
  };
}

/**
 * `CollectionField`：按字段元数据（`x-component-props.field` 的 `interface` / `uiSchema['x-component']`）
 * 路由到对应控件。元数据来自 schema 或页面注入，不在这里重建。
 */
function CollectionFieldComponent(props: ManualSchemaComponentProps) {
  const schema = schemaRecord(useFieldSchema());
  const field = asRecord(props.field);
  const uiSchema = asRecord(field?.uiSchema);
  const declared = readString(uiSchema, 'x-component');
  const interfaceName = readString(field, 'interface');
  const type = readString(uiSchema, 'type') ?? readString(field, 'type');
  const merged = { ...schema, ...(uiSchema ?? {}), ...(declared ? { 'x-component': declared } : {}) };
  const control = controlFor(declared, interfaceName, type);
  return <FieldBody>{control({ schema: merged, props })}</FieldBody>;
}

function controlFor(
  componentName: string | null,
  interfaceName: string | null,
  type: string | null,
): (props: ControlProps) => ReactNode {
  if (componentName) {
    const direct = CONTROL_BY_COMPONENT[componentName];
    if (direct) return direct;
  }
  const byInterface = interfaceName ? CONTROL_BY_INTERFACE[interfaceName] : undefined;
  if (byInterface) return byInterface;
  if (type === 'array') return ControlAssociation;
  if (type === 'number' || type === 'integer' || type === 'float') return ControlNumber;
  if (type === 'boolean') return ControlCheckbox;
  if (type === 'json' || type === 'object') return ControlJson;
  return ControlInput;
}

const CONTROL_BY_COMPONENT: Record<string, (props: ControlProps) => ReactNode> = {
  Input: ControlInput,
  'Input.TextArea': ControlTextArea,
  Textarea: ControlTextArea,
  InputNumber: ControlNumber,
  Number: ControlNumber,
  Select: ControlSelect,
  Checkbox: ControlCheckbox,
  'Checkbox.Group': ControlCheckboxGroup,
  Switch: ControlSwitch,
  'Radio.Group': ControlRadioGroup,
  Radio: ControlRadioGroup,
  DatePicker: ControlTemporal,
  TimePicker: ControlTemporal,
  'Input.JSON': ControlJson,
  JSON: ControlJson,
  JSONTextArea: ControlJson,
  WorkflowVariableTextArea: ControlTextArea,
  WorkflowVariableJsonTextArea: ControlJson,
  RichText: ControlTextArea,
  Upload: ControlJson,
  AssociationField: ControlAssociation,
  RemoteSelect: ControlSelect,
};

const CONTROL_BY_INTERFACE: Record<string, (props: ControlProps) => ReactNode> = {
  input: ControlInput,
  textarea: ControlTextArea,
  email: ControlInput,
  phone: ControlInput,
  url: ControlInput,
  password: ControlInput,
  integer: ControlNumber,
  number: ControlNumber,
  percent: ControlNumber,
  checkbox: ControlCheckbox,
  radioGroup: ControlRadioGroup,
  checkboxGroup: ControlCheckboxGroup,
  select: ControlSelect,
  multipleSelect: ControlSelect,
  date: ControlTemporal,
  datetime: ControlTemporal,
  time: ControlTemporal,
  json: ControlJson,
  richText: ControlTextArea,
  m2o: ControlAssociation,
  oho: ControlAssociation,
  obo: ControlAssociation,
  m2m: ControlAssociation,
  o2m: ControlAssociation,
  linkTo: ControlAssociation,
  attachment: ControlJson,
};

/* ------------------------------------------------------------------ *
 * 布局
 * ------------------------------------------------------------------ */

function ContainerBlock(props: ManualSchemaComponentProps) {
  return (
    <div className={typeof props.className === 'string' ? props.className : undefined}>{props.children as ReactNode}</div>
  );
}

function CardBlock(props: ManualSchemaComponentProps) {
  const title = typeof props.title === 'string' ? props.title : undefined;
  return (
    <section className={styles.sectionCard}>
      {title ? <h3 className={styles.cellTitle}>{title}</h3> : null}
      {props.children as ReactNode}
    </section>
  );
}

function GridBlock(props: ManualSchemaComponentProps) {
  return <div className={styles.formGrid}>{props.children as ReactNode}</div>;
}

function GridRowBlock(props: ManualSchemaComponentProps) {
  return <div className={styles.gridRow}>{props.children as ReactNode}</div>;
}

function GridColBlock(props: ManualSchemaComponentProps) {
  return <div className={styles.gridCol}>{props.children as ReactNode}</div>;
}

function TabsBlock(props: ManualSchemaComponentProps) {
  const schema = schemaRecord(useFieldSchema());
  const properties = asRecord(schema.properties) ?? {};
  const keys = Object.keys(properties);
  const [active, setActive] = useState(keys[0] ?? '');
  const children = React.Children.toArray(props.children as ReactNode);
  if (keys.length <= 1) return <div>{children}</div>;
  return (
    <div className={styles.tabs}>
      <div className={styles.sourceTabs} role="tablist">
        {keys.map((key, index) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={active === key}
            className={active === key ? styles.sourceTabActive : styles.sourceTab}
            onClick={() => setActive(key)}
          >
            {titleOf(schemaRecord(properties[key])) ?? `选项卡 ${index + 1}`}
          </button>
        ))}
      </div>
      <div>{children[keys.indexOf(active)] ?? null}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 表单块与动作
 * ------------------------------------------------------------------ */

function storedValuesOf(storedResult: Record<string, unknown> | null, formKey: string): FormValues {
  return asRecord(storedResult?.[formKey]) ?? {};
}

/** 原生 `FormBlockProvider` / `CustomFormBlockProvider` / `DetailsBlockProvider`。 */
function makeFormBlockProvider(mode: 'form' | 'details'): ManualSchemaComponent {
  return function FormBlockProviderComponent(props: ManualSchemaComponentProps) {
    const host = useHost();
    const schema = schemaRecord(useFieldSchema());
    const field = useField() as GeneralField | undefined;
    const ancestors = field?.address?.segments ? field.address.segments.slice(0, -1).map(String) : [];
    const formKey = resolveFormKey(schema, host.forms, ancestors);
    const stored = storedValuesOf(host.storedResult, formKey);
    const block = host.blocks.find((entry) => entry.formKey === formKey) ?? null;
    const initialKey = JSON.stringify(stored);

    const form = useMemo(() => {
      const instance = createForm({
        initialValues: stored,
        pattern:
          mode === 'details' || host.readOnly ? 'readPretty' : host.disabled ? 'disabled' : 'editable',
      });
      // 块字段（以及块内的 `FormV2`）在 schema 里都是 void 容器，但它们的 Formily 字段实例挂在
      // **外层** root form 上，块内字段才挂在块 form 上。Formily 用 `buildDataPath` 剔除值路径里的
      // void 段：它需要在该 form 的 fields 里能找到这条地址链，否则 `form.values` 会多出容器层级
      // （`{block1:{formA:{amount}}}` 而不是 `{amount}`）。这里按块的地址链同步登记同名 void 容器，
      // 保证子字段创建时即可正确取值，`form.values` 与提交体 `result[formKey]` 同形。
      const chain = (field?.address?.segments ?? []).map(String);
      if (chain[chain.length - 1] !== formKey) chain.push(formKey);
      let prefix: string[] = [];
      for (const segment of chain) {
        prefix = [...prefix, segment];
        const identifier = prefix.join('.');
        if (!instance.fields[identifier]) instance.createVoidField({ name: identifier });
      }
      return instance;
    }, [formKey, initialKey, mode, host.readOnly, host.disabled, field]);

    useEffect(() => {
      form.setPattern(
        mode === 'details' || host.readOnly ? 'readPretty' : host.disabled ? 'disabled' : 'editable',
      );
    }, [form, host.readOnly, host.disabled, mode]);

    // 原生：已处理且该表单没有保存值的块不渲染。
    if (mode === 'form' && host.readOnly && Object.keys(stored).length === 0) return null;

    const contextValue = useMemo<FormBlockValue>(
      () => ({ form, formKey, block, readOnly: host.readOnly, stored }),
      [form, formKey, block, host.readOnly, stored],
    );

    // 原生块自身是 `CardItem`，内层再放 `Form`/`FormV2`；若 schema 没给内层表单组件，
    // 这里直接由块提供 FormProvider，避免字段挂到外层 root form 上（原生不会出现这种 schema）。
    const ownsFormComponent = isFormComponent(
      typeof schema['x-component'] === 'string' ? (schema['x-component'] as string) : undefined,
    );
    const children = (ownsFormComponent ? (
      props.children
    ) : (
      <FormScope form={form} block={block} disabled={props.disabled}>
        {props.children as ReactNode}
      </FormScope>
    )) as ReactNode;

    return <FormBlockContext.Provider value={contextValue}>{children}</FormBlockContext.Provider>;
  };
}

/**
 * Formily `FormProvider` + 完整的块内表单上下文。
 *
 * `FormProvider` 内置 ContextCleaner：它会把 SchemaComponents / SchemaExpressionScope / SchemaOptions
 * 置空（antd-v5 的 `Form` 亦然）。块内字段仍要按 `x-component` 解析组件、编译 `{{...}}`（含 `x-reactions`），
 * 因此在这里把外层 schema 上下文原样续接。
 */
function FormScope({
  form,
  block,
  disabled,
  children,
}: {
  form: Form;
  block: ManualFormBlock | null;
  disabled?: boolean;
  children: ReactNode;
}) {
  const schemaComponents = useContext(SchemaComponentsContext);
  const schemaScope = useContext(SchemaExpressionScopeContext);
  const schemaOptions = useContext(SchemaOptionsContext);
  const hasSchemaActions = (block?.schemaActions.length ?? 0) > 0;
  return (
    <FormProvider form={form}>
      <SchemaComponentsContext.Provider value={schemaComponents}>
        <SchemaExpressionScopeContext.Provider value={schemaScope}>
          <SchemaOptionsContext.Provider value={schemaOptions}>
            <div className={styles.formBlocks}>
              {children}
              {!hasSchemaActions && block ? (
                <FallbackActions block={block} form={form} disabled={disabled} />
              ) : null}
            </div>
          </SchemaOptionsContext.Provider>
        </SchemaExpressionScopeContext.Provider>
      </SchemaComponentsContext.Provider>
    </FormProvider>
  );
}

/** 原生 `FormV2` / `Form` 组件。 */
function FormComponent(props: ManualSchemaComponentProps) {
  const blockContext = useContext(FormBlockContext);
  const merged = useSchemaComponentProps<Record<string, unknown>>({ form: blockContext?.form });
  const form = (merged.form as Form | undefined) ?? blockContext?.form;
  if (!form) return null;
  return (
    <FormScope form={form} block={blockContext?.block ?? null} disabled={props.disabled}>
      {props.children as ReactNode}
    </FormScope>
  );
}

/** schema 未声明 ActionBar 时，用 `node.config.forms[formKey].actions` 渲染处理按钮。 */
function FallbackActions({ block, form, disabled }: { block: ManualFormBlock; form: Form; disabled?: boolean }) {
  const host = useHost();
  if (host.readOnly || host.disabled || block.actions.length === 0) return null;
  return (
    <div className={styles.formActions} data-testid="schema-fallback-actions">
      {block.actions.map((action) => (
        <button
          key={action.key}
          type="button"
          className={styles.primaryButton}
          disabled={disabled || host.submitting}
          onClick={() => {
            // 走 Formily 自己的校验/提交（失败时 errors 落到字段上，由 FieldShell 展示）。
            void form.submit((values) => host.onSubmit(block, action.key, values)).catch(() => undefined);
          }}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}

function ActionBarBlock(props: ManualSchemaComponentProps) {
  return <div className={styles.formActions}>{props.children as ReactNode}</div>;
}

/** 原生 `Action`：schema 里的处理动作按钮（提交体由宿主统一组装）。 */
function ActionComponent(props: ManualSchemaComponentProps) {
  const host = useHost();
  const blockContext = useFormBlock();
  const form = useForm();
  const field = useFieldState();
  const schema = schemaRecord(useFieldSchema());
  const actionKey = field.name ?? readString(schema, 'name') ?? '';
  const title = titleOf(schema) ?? actionKey;
  const assignedValues = asRecord(asRecord(asRecord(schema['x-action-settings'])?.assignedValues)?.values) ?? {};
  const type = readString(asRecord(schema['x-component-props']), 'type');
  if (!blockContext.block || !actionKey) return null;
  return (
    <button
      type="button"
      className={type === 'primary' ? styles.primaryButton : styles.secondaryButton}
      disabled={props.disabled || host.submitting}
      onClick={() => {
        // 原生 `useSubmit`：先 `form.submit()` 校验，再按 `{...values, ...assignedValues}` 组装。
        void form
          .submit((values) => host.onSubmit(blockContext.block as ManualFormBlock, actionKey, { ...values, ...assignedValues }))
          .catch(() => undefined);
      }}
    >
      {title}
    </button>
  );
}

/** 原生 `ActionBarProvider`：作业已结束时只保留提交过的那个表单的动作；非受理人不渲染动作。 */
function ActionBarProviderComponent(props: ManualSchemaComponentProps) {
  const host = useHost();
  const schema = schemaRecord(useFieldSchema());
  const field = useField() as GeneralField | undefined;
  const ancestors = field?.address?.segments ? field.address.segments.slice(0, -1).map(String) : [];
  const formKey = resolveFormKey(schema, host.forms, ancestors);
  const job = asRecord(host.job);
  const jobStatus = typeof job?.status === 'number' ? job.status : null;
  if (jobStatus !== null && jobStatus !== 0) {
    const submitted = asRecord(asRecord(job?.result)?.[formKey]);
    if (!submitted) return null;
  }
  // 原生 `e0`：当前用户不是这条待办的受理人时不渲染任何处理动作。
  if (job && job.userId !== undefined && job.userId !== null && !sameUserId(host.currentUserId, job.userId)) {
    return null;
  }
  return <>{props.children as ReactNode}</>;
}

/** 原生 `ManualActionStatusProvider`：已处理时只留下当时选中的动作，并由 pattern 禁用。 */
function ManualActionStatusProviderComponent(props: ManualSchemaComponentProps) {
  const host = useHost();
  const field = useFieldState();
  const schema = schemaRecord(useFieldSchema());
  if (host.disabled) return null;
  if (!host.readOnly) return <>{props.children as ReactNode}</>;
  const actionKey = field.name ?? readString(schema, 'name') ?? '';
  const chosen = readString(asRecord(host.job?.result), '_') ?? readString(host.storedResult, '_');
  if (chosen === null || chosen !== actionKey) return null;
  return <>{props.children as ReactNode}</>;
}

function FormItemDecorator(props: ManualSchemaComponentProps) {
  return <FieldShell>{props.children as ReactNode}</FieldShell>;
}

/* ------------------------------------------------------------------ *
 * 组件表
 * ------------------------------------------------------------------ */

function buildBuiltinComponents(): Record<string, ManualSchemaComponent> {
  const TextAreaField = makeFieldControl(ControlTextArea);
  const JsonFieldComponent = makeFieldControl(ControlJson);
  const CheckboxFieldComponent = makeFieldControl(ControlCheckbox);
  const CheckboxGroupComponent = makeFieldControl(ControlCheckboxGroup);
  const RadioGroupComponent = makeFieldControl(ControlRadioGroup);

  // Formily 用 `FormPath.getIn(components, 'Grid.Row')` 解析带点号的 `x-component`，
  // 因此点号名必须是**嵌套对象**（`components.Grid.Row`），只放扁平键名不会被解析到。
  const InputObject = Object.assign(makeFieldControl(ControlInput) as unknown as Record<string, ManualSchemaComponent>, {
    TextArea: TextAreaField,
    JSON: JsonFieldComponent,
  });
  const GridObject = Object.assign(GridBlock as unknown as Record<string, ManualSchemaComponent>, {
    Row: GridRowBlock,
    Col: GridColBlock,
  });
  const CheckboxObject = Object.assign(
    CheckboxFieldComponent as unknown as Record<string, ManualSchemaComponent>,
    { Group: CheckboxGroupComponent },
  );
  const RadioObject = Object.assign(
    RadioGroupComponent as unknown as Record<string, ManualSchemaComponent>,
    { Group: RadioGroupComponent },
  );

  return {
    // 布局
    Card: CardBlock,
    CardItem: CardBlock,
    Grid: GridObject as unknown as ManualSchemaComponent,
    GridRow: GridRowBlock,
    GridCol: GridColBlock,
    Space: ContainerBlock,
    FormLayout: ContainerBlock,
    TabPane: ContainerBlock,
    Divider: (() => <hr className={styles.divider} />) as unknown as ManualSchemaComponent,
    Tabs: TabsBlock,

    // 表单块与动作
    FormBlockProvider: makeFormBlockProvider('form'),
    CustomFormBlockProvider: makeFormBlockProvider('form'),
    DetailsBlockProvider: makeFormBlockProvider('details'),
    Form: FormComponent,
    FormV2: FormComponent,
    FormItem: FormItemDecorator,
    ActionBar: ActionBarBlock,
    ActionBarProvider: ActionBarProviderComponent,
    ManualActionStatusProvider: ManualActionStatusProviderComponent,
    Action: ActionComponent,

    // 字段
    Input: InputObject as unknown as ManualSchemaComponent,
    Textarea: TextAreaField,
    InputNumber: makeFieldControl(ControlNumber),
    Select: makeFieldControl(ControlSelect),
    Checkbox: CheckboxObject as unknown as ManualSchemaComponent,
    Switch: makeFieldControl(ControlSwitch),
    Radio: RadioObject as unknown as ManualSchemaComponent,
    DatePicker: makeFieldControl(ControlTemporal),
    TimePicker: makeFieldControl(ControlTemporal),
    JSON: JsonFieldComponent,
    JSONTextArea: JsonFieldComponent,
    WorkflowVariableTextArea: TextAreaField,
    WorkflowVariableJsonTextArea: JsonFieldComponent,
    RichText: TextAreaField,
    Upload: JsonFieldComponent,
    AssociationField: makeFieldControl(ControlAssociation),
    RemoteSelect: makeFieldControl(ControlSelect),
    CollectionField: CollectionFieldComponent,
  };
}

let cachedBuiltins: Record<string, ManualSchemaComponent> | null = null;

function builtinComponents(): Record<string, ManualSchemaComponent> {
  if (!cachedBuiltins) cachedBuiltins = buildBuiltinComponents();
  return cachedBuiltins;
}

function mergedComponents(): Record<string, ManualSchemaComponent> {
  const builtins = builtinComponents();
  const names = Object.keys(componentRegistry);
  if (names.length === 0) return builtins;
  const merged: Record<string, unknown> = { ...builtins };
  for (const name of names) {
    const parts = name.split('.');
    let cursor = merged;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const key = parts[index] as string;
      if (typeof cursor[key] !== 'function' && typeof cursor[key] !== 'object') cursor[key] = {};
      cursor = cursor[key] as Record<string, unknown>;
    }
    cursor[parts[parts.length - 1] as string] = componentRegistry[name];
  }
  return merged as unknown as Record<string, ManualSchemaComponent>;
}

const SchemaField = createSchemaField({ components: {}, scope: {} });

/* ------------------------------------------------------------------ *
 * 宿主
 * ------------------------------------------------------------------ */

export interface ManualSchemaHostProps {
  /** 归一后的根 schema（`{ type:'void', properties }`）。 */
  schema: Record<string, unknown>;
  blocks: ManualFormBlock[];
  forms: Record<string, unknown>;
  storedResult: Record<string, unknown> | null;
  job: Record<string, unknown> | null;
  execution: Record<string, unknown> | null;
  currentUserId: string | null;
  readOnly: boolean;
  disabled?: boolean;
  submitting: boolean;
  onSubmit: (block: ManualFormBlock, actionKey: string, values: FormValues) => void;
  loadAssociationOptions?: ManualFormHostValue['loadAssociationOptions'];
}

/** TD-02 根宿主：真实 Formily `SchemaField` 渲染 `node.config.schema`。 */
export function ManualSchemaHost(props: ManualSchemaHostProps) {
  const version = useSyncExternalStore(subscribeRegistry, registrySnapshot, registrySnapshot);
  const components = useMemo(() => mergedComponents(), [version]);
  const schema = useMemo(() => prepareSchemaForFormily(props.schema), [props.schema]);

  const hostValue = useMemo<ManualFormHostValue>(
    () => ({
      blocks: props.blocks,
      forms: props.forms,
      storedResult: props.storedResult,
      job: props.job,
      execution: props.execution,
      currentUserId: props.currentUserId,
      readOnly: props.readOnly,
      disabled: props.disabled === true,
      submitting: props.submitting,
      onSubmit: props.onSubmit,
      loadAssociationOptions: props.loadAssociationOptions,
    }),
    [
      props.blocks,
      props.forms,
      props.storedResult,
      props.job,
      props.execution,
      props.currentUserId,
      props.readOnly,
      props.disabled,
      props.submitting,
      props.onSubmit,
      props.loadAssociationOptions,
    ],
  );

  const scope = useMemo(
    () => ({
      // 原生 schema 的 `{{t(...)}}` 由 Formily ExpressionScope 编译；这里只做最小翻译。
      t: (key: string) => key,
      useCollectionRecordData: () => props.storedResult,
    }),
    [props.storedResult],
  );

  // Formily 的每个 Field/VoidField 都必须归属一个 form；schema 树本身的字段挂在根表单上，
  // 各表单块内部再由 FormBlockProvider 创建的独立 form（FormProvider）承载字段。与原生一致。
  const rootForm = useMemo(() => createForm(), []);

  if (Object.keys(asRecord(schema.properties) ?? {}).length === 0) return null;

  return (
    <ManualFormHostContext.Provider value={hostValue}>
      <FormProvider form={rootForm}>
        <SchemaField components={components as never} scope={scope} schema={schema as never} />
      </FormProvider>
    </ManualFormHostContext.Provider>
  );
}
