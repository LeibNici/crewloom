/**
 * TD-02：人工处理表单的**真实 NocoBase v1 组件链**（Crewloom tasks 模块独占适配层）。
 *
 * 这里不再自研同名 provider：`SchemaComponent`、`DetailsBlockProvider`、字段组件
 * （`Input`/`InputNumber`/`Select`/`DatePicker`/`CollectionField`/`AssociationField`…）、
 * `FormBlockContext`、`RecordProvider`、`CollectionManagerProvider`… 全部来自
 * `@nocobase/client`（已发布 2.2.22，`x-component` 名按 NocoBase 全局注册表解析）。
 *
 * 只有 `plugin-workflow-manual` 的 v1 client 自己定义的那一层（`FormBlockProvider` /
 * `ActionBarProvider` / `ManualActionStatusProvider` / `useSubmit` / `useFormBlockProps` /
 * `useDetailsBlockProps`）必须在本模块内等价实现 —— 它们不在 `@nocobase/client` 里，
 * 原实现在插件 bundle 内部、未导出。实现逐句对照目标实例 2.2.20 的
 * `@nocobase/plugin-workflow-manual/dist/client/index.js`（语义见 21 报告）：
 *  - `FormBlockProvider`：`formKey = Object.keys(fieldSchema.toJSON().properties)[0]`，
 *    `initialValues = record.result[formKey]`，`createForm({ initialValues })`；
 *  - `useFormBlockProps`：按 `execution.status || userJob.status` 与当前用户决定
 *    `readPretty` / `disabled` / `editable`，返回 `{ form }`；
 *  - `useSubmit`：`form.submit()` 后提交 `{ result: { [formKey]: {...values, ...assignedValues.values}, _: actionKey } }`；
 *  - `ActionBarProvider`：作业结束且该表单没有保存值时不渲染动作；
 *  - `ManualActionStatusProvider`：已处理时只显示当时选中的动作并禁用。
 *
 * `currentRecord` / `$nForm` 语义来自真实服务端：`$nForm = values.result[formKey]`；
 * `_record` 在 2.2.20 的真实源码中不存在（否证，见 12 报告 §4），本层不发明。
 */
import { createForm, type Form } from '@formily/core';
import { MemoryRouter } from 'react-router-dom';
import { useField, useFieldSchema, useForm } from '@formily/react';
import {
  Action,
  ActionBar,
  ActionContextProvider,
  APIClient,
  Application,
  ApplicationContext,
  AssociationField,
  BlockProvider,
  BlockRequestContext_deprecated,
  CardItem,
  Checkbox,
  CollectionField,
  CollectionManager,
  CollectionProvider_deprecated,
  CurrentUserContext,
  DatePicker,
  DEFAULT_DATA_SOURCE_KEY,
  DetailsBlockProvider,
  Divider,
  FormActiveFieldsProvider,
  FormBlockContext,
  FormItem,
  FormV2,
  Grid,
  Input,
  InputNumber,
  NocoBaseBuildInPlugin,
  Password,
  Radio,
  CollectionRecordProvider,
  RemoteSelect,
  SchemaComponent,
  Select,
  Space,
  Tabs,
  TemplateBlockProvider,
  TimePicker,
  Upload,
  useActionContext,
  useAPIClient,
  useBlockRequestContext,
  useCollectionRecordData,
  useCompile,
  useCurrentUserContext,
  useDataSourceHeaders,
  useFormBlockContext,
} from '@nocobase/client';
import {
  Component,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { sdk } from '../../../../api/client';
import styles from '../../tasks.module.css';
import { asRecord } from '../../../workflow/format';
import {
  collectTemporalContracts,
  normalizeTemporalValues,
  sameUserId,
  type TemporalFieldContract,
} from '../../manualForm';
import { getManualSchemaComponents } from '../manualSchemaHost';

/* ------------------------------------------------------------------ *
 * workflow 服务器的任务上下文
 *
 * 原生用 `@nocobase/plugin-workflow/client` 的 `FlowContext`；该包不在本产品的
 * vendored 闭包里，因此这里按**同一形状**提供（值由页面从 `workflowManualTasks:get`
 * 的真实响应组装），scope 钩子的读取路径与 2.2.20 发布实现逐句一致。
 * ------------------------------------------------------------------ */

export interface ManualFlowValue {
  /** `workflowManualTasks:get` 去掉 node/workflow/execution 后的任务记录。 */
  userJob: Record<string, unknown>;
  workflow: Record<string, unknown>;
  nodes: unknown[];
  execution: Record<string, unknown>;
}

const ManualFlowContext = createContext<ManualFlowValue | null>(null);

/**
 * 提交回调：原生 `useSubmit` 负责**组装**提交体（`{result:{[formKey]:...,_}}`），
 * 真正的请求仍交给页面既有的 useMutation 管线（409/网络失败/会话世代与提示都在那里）。
 */
export interface ManualSubmitContextValue {
  submit: (payload: Record<string, unknown>) => Promise<void>;
  submitting?: boolean;
}

const ManualSubmitContext = createContext<ManualSubmitContextValue | null>(null);

function useManualSubmit(): ManualSubmitContextValue {
  const value = useContext(ManualSubmitContext);
  if (!value) throw new Error('人工表单宿主之外不能提交');
  return value;
}

/**
 * 宿主按 `record.result[formKey]` 建好的表单实例表。
 *
 * 为什么宿主也要持有 form：真实 `x-component: 'Tabs'` 的根 schema 下，表块的
 * `FormBlockProvider` 只出现在 tab 标签分支，内容分支渲染的是块内属性（`FormV2`）。
 * 此时 `useFormBlockContext()` 在内容分支为空 —— 原生插件在自己的完整应用里由块级
 * provider 覆盖；本适配层里由宿主按 `formKey` 提供**同一个** form，实时
 * `FormBlockContext` 存在时优先用它（同一语义，不做替身业务逻辑）。
 */
const ManualFormsContext = createContext<Record<string, Form> | null>(null);

/** 按服务端 collection field 契约归一日期/时间值（不全局截断）。 */
const ManualTemporalContext = createContext<TemporalFieldContract[]>([]);

function useTemporalContracts(): TemporalFieldContract[] {
  return useContext(ManualTemporalContext);
}

function useManualFormFor(formKey: string | undefined): Form | undefined {
  const forms = useContext(ManualFormsContext);
  if (!forms) return undefined;
  if (formKey && forms[formKey]) return forms[formKey];
  const first = Object.keys(forms)[0];
  return first ? forms[first] : undefined;
}

function useManualFlow(): ManualFlowValue {
  const value = useContext(ManualFlowContext);
  if (!value) throw new Error('人工表单宿主之外不能渲染 schema 组件');
  return value;
}

/* ------------------------------------------------------------------ *
 * 逐句对照 2.2.20 的插件级组件 / scope 钩子
 * ------------------------------------------------------------------ */

/**
 * `@nocobase/client` 的部分 provider 类型声明不完整（缺 `children` 等），
 * 这里只放宽**类型**，运行期仍是真实组件，不做任何替身。
 */
const asProvider = (component: unknown): ComponentType<Record<string, unknown>> =>
  component as ComponentType<Record<string, unknown>>;

/**
 * 真实 `CollectionRecordProvider`（`data-source/collection-record`）：原生
 * `useCollectionRecordData()` 读的就是这个 context（`RecordProvider` 是另一套旧 context，
 * 用它会让 `FormBlockProvider` 拿不到任务记录、初始值与只读模式都会失效）。
 */
const RecordProviderCompat = asProvider(CollectionRecordProvider);

/** 2.2.20 `instruction/FormBlockProvider.tsx`（`function x(r)`）。 */
function ManualFormBlockProvider(props: { children?: ReactNode; dataSource?: string; collection?: unknown }) {
  const record = useCollectionRecordData() as { result?: Record<string, unknown>; status?: unknown } | undefined;
  const fieldSchema = useFieldSchema() as unknown as { toJSON: () => Record<string, unknown> };
  const field = useField();
  const formBlockRef = useRef<HTMLDivElement | null>(null);
  const dataSource = props.dataSource || DEFAULT_DATA_SOURCE_KEY;
  const formKey = Object.keys((fieldSchema.toJSON().properties as Record<string, unknown>) ?? {})[0];
  const initialValues = record?.result?.[formKey] as Record<string, unknown> | undefined;

  const hostForm = useManualFormFor(formKey);
  const createdForm = useMemo(() => createForm({ initialValues }), [initialValues]);
  const form = hostForm ?? createdForm;
  const service = useMemo(() => ({ loading: false, data: { data: initialValues } }), [initialValues]);
  const api = useAPIClient();
  const headers = useDataSourceHeaders(dataSource);
  const resource = useMemo(
    () => (api as { resource: (name: unknown, of?: unknown, headers?: unknown) => unknown }).resource(props.collection, undefined, headers),
    [api, props.collection, headers],
  );
  const parent = useBlockRequestContext();
  const value = useMemo(
    () => ({ params: {}, form, field, service, updateAssociationValues: [], formBlockRef }),
    [field, form, service],
  );

  // 原生：作业已处理且该表单没有保存值时整块不渲染。
  if (record?.status && !initialValues) return null;

  const TemplateBlock = asProvider(TemplateBlockProvider);
  const CollectionProvider = asProvider(CollectionProvider_deprecated);
  const Block = asProvider(BlockProvider);
  const FormActiveFields = asProvider(FormActiveFieldsProvider);
  const Templates = asProvider(FormV2.Templates);

  return (
    <TemplateBlock>
      <CollectionProvider collection={props.collection}>
          <Block name={(props as { name?: string }).name || 'form'} block="form" parentRecord={null}>
            <FormActiveFields name="form">
              <BlockRequestContext_deprecated.Provider
                value={{ block: 'form', props, field, service, resource, __parent: parent }}
              >
                <FormBlockContext.Provider value={value}>
                  <RecordProviderCompat record={initialValues} parent={null}>
                    <Templates form={form} />
                    <div ref={formBlockRef}>{props.children}</div>
                  </RecordProviderCompat>
                </FormBlockContext.Provider>
              </BlockRequestContext_deprecated.Provider>
            </FormActiveFields>
          </Block>
      </CollectionProvider>
    </TemplateBlock>
  );
}

/** 2.2.20 `scope.useFormBlockProps`（`function e8`）。 */
function useNativeFormBlockProps(): { form: Form } {
  const flow = useManualFlow();
  const record = useCollectionRecordData() as Record<string, unknown> | undefined;
  const current = useCurrentUserContext() as { data?: { data?: { id?: unknown } } } | undefined;
  const fieldSchema = useFieldSchema() as unknown as { name?: string } | undefined;
  const contextForm = useFormBlockContext().form as Form | undefined;
  const form = contextForm ?? (useManualFormFor(fieldSchema?.name) as Form);
  const processed = Boolean(flow.execution.status) || Boolean(flow.userJob.status);
  const pattern = processed
    ? record
      ? 'readPretty'
      : 'disabled'
    : !sameUserId(current?.data?.data?.id, flow.userJob.userId)
      ? 'disabled'
      : 'editable';
  useEffect(() => {
    form?.setPattern(pattern as never);
  }, [pattern, form]);
  return { form };
}

/** 2.2.20 `scope.useDetailsBlockProps`（`function e6`）。 */
function useNativeDetailsBlockProps(): { form: Form } {
  const fieldSchema = useFieldSchema() as unknown as { name?: string } | undefined;
  const contextForm = useFormBlockContext().form as Form | undefined;
  return { form: (contextForm ?? useManualFormFor(fieldSchema?.name)) as Form };
}

/** 2.2.20 `scope.useSubmit`（`function e3`）：组装体与原生逐字一致，提交交给页面管线。 */
function useNativeSubmit() {
  const action = useActionContext() as { setSubmitted?: (value: boolean) => void; setVisible?: (value: boolean) => void };
  const form = useForm();
  const field = useField() as unknown as { name: string; data?: Record<string, unknown> };
  const fieldSchema = useFieldSchema() as unknown as {
    name: string;
    parent: { parent: { name: string } };
    'x-action-settings'?: { assignedValues?: { values?: Record<string, unknown> } };
  };
  const flow = useManualFlow();
  const host = useManualSubmit();
  const temporal = useTemporalContracts();
  const formKey = fieldSchema.parent.parent.name;
  const actionKey = fieldSchema.name ?? field.name;
  const assigned = fieldSchema['x-action-settings']?.assignedValues ?? {};
  return {
    run: async () => {
      // 原生：执行已结束 / 作业已处理时直接返回（不重复提交）。
      if (flow.execution.status || flow.userJob.status) return;
      // 先走 Formily 自己的校验；失败时错误落在字段上，不组装提交体。
      await form.submit();
      const normalized = normalizeTemporalValues(form.values as Record<string, unknown>, temporal);
      await host.submit({
        result: {
          [formKey]: { ...normalized, ...(assigned.values ?? {}) },
          _: actionKey,
        },
      });
      action.setSubmitted?.(true);
      action.setVisible?.(false);
    },
  };
}

/** 2.2.20 `ActionBarProvider`（`function e0`）。 */
function ManualActionBarProvider(props: { children?: ReactNode }) {
  const current = useCurrentUserContext() as { data?: { data?: { id?: unknown } } } | undefined;
  const flow = useManualFlow();
  const fieldSchema = useFieldSchema() as unknown as { parent: { toJSON: () => { name?: string } } };
  const formKey = fieldSchema.parent.toJSON().name;
  const job = flow.userJob as { status?: unknown; result?: Record<string, unknown>; userId?: unknown };
  let children = props.children;
  if (job.status) {
    if (!job.result?.[formKey as string]) children = null;
  } else if (current?.data?.data?.id !== job.userId) {
    children = null;
  }
  return <>{children}</>;
}

/** 2.2.20 `ManualActionStatusProvider`（`function e2`）。 */
function ManualActionStatusProvider(props: { value?: unknown; children?: ReactNode }) {
  const flow = useManualFlow();
  const field = useField() as unknown as { disabled?: boolean; visible?: boolean };
  const fieldSchema = useFieldSchema() as unknown as { name?: string; title?: unknown };
  const compile = useCompile();
  const processed = Boolean(flow.execution.status) || Boolean(flow.userJob.status);
  useEffect(() => {
    if (!processed) return;
    field.disabled = true;
    field.visible =
      flow.userJob.status === props.value && (flow.userJob.result as { _?: unknown } | undefined)?._ === fieldSchema.name;
  }, [processed, flow, props.value, field, fieldSchema.name]);
  if (processed) {
    return (
      <button type="button" className="ant-btn ant-btn-primary" disabled>
        {compile(fieldSchema.title) as ReactNode}
      </button>
    );
  }
  return <>{props.children}</>;
}

/* ------------------------------------------------------------------ *
 * schema 组件表（真实的 NocoBase 全局组件 + 插件级同名组件）
 * ------------------------------------------------------------------ */

const FIELD_COMPONENTS = {
  Input,
  InputNumber,
  Select,
  DatePicker,
  TimePicker,
  Checkbox,
  Radio,
  Upload,
  RemoteSelect,
  Password,
  CollectionField,
  // 关联字段直接用 `@nocobase/client` 导出的真实 `AssociationField`（`connect(o4, mapReadPretty)`）：
  // Formily 的 connect 本身就负责 `value`/`onChange` 双向绑定，另包一层只会掩盖原生行为。
  AssociationField,
} as unknown as Record<string, unknown>;

const LAYOUT_COMPONENTS = {
  CardItem,
  FormItem,
  FormV2,
  Grid,
  Tabs,
  Space,
  Divider,
  ActionBar,
  Action,
} as unknown as Record<string, unknown>;

function buildComponents(): Record<string, unknown> {
  const base: Record<string, unknown> = {
    FormBlockProvider: ManualFormBlockProvider,
    CustomFormBlockProvider: ManualFormBlockProvider,
    DetailsBlockProvider,
    ActionBarProvider: ManualActionBarProvider,
    ManualActionStatusProvider,
    ...LAYOUT_COMPONENTS,
    ...FIELD_COMPONENTS,
  };
  // 保留既有注册桥接：`registerManualSchemaComponents` 注册的同名组件**替换真实组件**
  // （注册真实原生组件即整体切换；注册自定义组件即覆盖）。点号名同样嵌套注册。
  for (const [name, component] of Object.entries(getManualSchemaComponents())) {
    const parts = name.split('.');
    let cursor: Record<string, unknown> = base;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const key = parts[index] as string;
      if (typeof cursor[key] !== 'object' || cursor[key] === null) cursor[key] = {};
      cursor = cursor[key] as Record<string, unknown>;
    }
    cursor[parts[parts.length - 1] as string] = component;
  }
  return base;
}

/* ------------------------------------------------------------------ *
 * 最小应用适配：一个真实的 @nocobase/client Application
 *
 * 真实 NocoBase 的 schema 组件依赖 `useApp()`（`schemaInitializerManager` 等）与
 * `APIClientProvider`。这里只装配"渲染真实 schema"所必需的部分：真实 `Application`
 * （`NocoBaseBuildInPlugin` 注册核心组件与 initializer 注册表）+ 产品 SDK 客户端，
 * **不**渲染 NocoBase 自带的管理壳。
 * ------------------------------------------------------------------ */

let nativeApp: Application | null = null;
let nativeAppLoad: Promise<Application> | null = null;
/**
 * 原生 Application 使用的出站客户端。缺省是产品唯一的 SDK 客户端；
 * 受控核对/测试可在创建 Application 之前注入同类型的 APIClient（不改变组件链）。
 */
let nativeApiClient: APIClient | null = null;

export function __setManualNativeApiClientForTests(client: APIClient | null): void {
  nativeApiClient = client;
  nativeApp = null;
  nativeAppLoad = null;
}

function getNativeApp(): Application {
  if (!nativeApp) {
    class CrewloomManualApplication extends Application {
      // 产品唯一的 SDK 客户端：认证、角色、续期、会话世代与传输策略都是同一来源。
      protected createApiClient(): APIClient {
        const client = (nativeApiClient ?? sdk) as APIClient;
        (client as unknown as { app: unknown }).app = this;
        return client;
      }
    }
    nativeApp = new CrewloomManualApplication({
      name: 'main',
      apiClient: { baseURL: '/api' },
      ws: false,
      router: { type: 'memory', initialEntries: ['/'] },
      plugins: [NocoBaseBuildInPlugin as never],
    });
  }
  return nativeApp;
}

/**
 * 真实 v1 `CollectionManager` 单例：由产品 Application 的数据源管理器持有，
 * 集合元数据来自真实 `collections:list` 只读接口。关联字段（`AssociationField`）靠它解析
 * `x-collection-field` 的目标字段；拿不到时表单仍渲染，候选值如实为空，不伪造。
 */
let nativeCollectionManager: unknown = null;

export function __nativeCollectionManager(): unknown {
  return nativeCollectionManager;
}

async function loadCollections(app: Application): Promise<void> {
  try {
    const response = (await (app.apiClient as unknown as {
      request: (options: unknown) => Promise<{ data?: { data?: unknown[] } }>;
    }).request({ url: 'collections:list', params: { paginate: false } })) as { data?: { data?: unknown[] } };
    const collections = Array.isArray(response?.data?.data) ? (response?.data?.data as unknown[]) : [];
    if (collections.length === 0) return;
    // 真实 v1 `CollectionManager`（`@nocobase/client` 导出）承载真实集合元数据；
    // 关联字段（`AssociationField`）通过 `useCollectionManager()` 读它解析 `x-collection-field`。
    const manager = (
      app as unknown as {
        dataSourceManager?: { getDataSource?: (key?: string) => { collectionManager?: unknown } | undefined };
      }
    ).dataSourceManager?.getDataSource?.(DEFAULT_DATA_SOURCE_KEY)?.collectionManager;
    if (manager && typeof (manager as { addCollections?: unknown }).addCollections === 'function') {
      (manager as { addCollections: (list: unknown[]) => void }).addCollections(collections);
      nativeCollectionManager = manager;
      console.log('[crewloom] 集合元数据就绪（应用管理器）', collections.length);
      return;
    }
    nativeCollectionManager = new CollectionManager(collections as never, undefined as never);
    console.log('[crewloom] 集合元数据就绪', collections.length);
  } catch (error) {
    // 集合元数据读不到时表单仍可渲染；关联字段会如实表现为取不到候选值，不伪造。
    console.error('[crewloom] 集合元数据读取失败', error);
  }
}

function ensureNativeApp(): Promise<Application> {
  const app = getNativeApp();
  if (!nativeAppLoad) {
    const pending: Promise<Application> = app.load().then(async () => {
      await loadCollections(app);
      return app;
    });
    nativeAppLoad = pending;
    pending.catch(() => {
      // 失败后允许重试（清掉 rejected promise）。
      if (nativeAppLoad === pending) nativeAppLoad = null;
    });
  }
  return nativeAppLoad;
}

/* ------------------------------------------------------------------ *
 * 宿主
 * ------------------------------------------------------------------ */

/**
 * 真实组件链的渲染兜底：任何原生组件异常都只显示自然中文说明，
 * 不把 NocoBase 内部错误面板或英文技术信息暴露给普通用户；诊断只进 console。
 */
class NativeChainBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, _info: ErrorInfo) {
    console.error('[crewloom] 人工表单原生渲染失败', error);
  }

  render() {
    if (this.state.failed) {
      return (
        <p style={{ color: '#8c8c8c' }}>
          这张处理表单暂时无法显示。请刷新页面重试；如果一直这样，请联系管理员核对流程节点的表单配置。
        </p>
      );
    }
    return this.props.children;
  }
}

export interface ManualNativeChainProps {
  /** 归一后的根 schema（`{ type:'void', properties }`）。 */
  schema: Record<string, unknown>;
  /** 任务记录（`workflowManualTasks:get` 的完整响应，含 `result`）。 */
  record: Record<string, unknown>;
  /** 提交回调：接收原生 `useSubmit` 组装的提交体（`{ result: {...} }`）。 */
  onSubmit: (payload: Record<string, unknown>) => Promise<void>;
  /** 是否正在提交（禁用动作按钮）。 */
  submitting?: boolean;
  /** 当前用户 id，类型与后端一致（数字/字符串都可能是真实值，比较时不强转）。 */
  currentUserId?: string | number | null;
  /** 页面解析出的表块 formKey（与提交体 `result[formKey]` 同源）。 */
  formKeys?: string[];
}

export function ManualNativeChain(props: ManualNativeChainProps) {
  const [app, setApp] = useState<Application | null>(null);
  const [failure, setFailure] = useState<unknown>(null);

  useEffect(() => {
    let alive = true;
    ensureNativeApp().then(
      (value) => {
        if (alive) setApp(value);
      },
      (error) => {
        if (alive) setFailure(error);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  if (failure) throw failure;

  const flow = useMemo<ManualFlowValue>(() => {
    const record = asRecord(props.record) ?? {};
    const { node: _node, workflow: _workflow, execution: _execution, ...userJob } = record;
    return {
      userJob,
      workflow: asRecord(record.workflow) ?? {},
      nodes: Array.isArray(asRecord(record.workflow)?.nodes) ? (asRecord(record.workflow)?.nodes as unknown[]) : [],
      execution: asRecord(record.execution) ?? {},
    };
  }, [props.record]);

  // 真实 v1 `Application` 自带的 provider 栈（`addCustomProviders()` 注册）：
  // APIClient / AppSchemaComponentProvider(components+scope) / DataSourceApplicationProvider(app.dataSourceManager) 等。
  // 这是与字段组件**同来源同实例**的一套上下文，不用手写 provider 拼。
  const Providers = useMemo(() => {
    if (!app) return null;
    const getCompose = (app as unknown as { getComposeProviders?: () => unknown }).getComposeProviders;
    if (typeof getCompose !== 'function') return null;
    return getCompose.call(app) as ComponentType<{ children?: ReactNode }>;
  }, [app]);

  /**
   * 按 `record.result[formKey]` 建真实 Formily 表单（与原生 FormBlockProvider 同一处语义）。
   *
   * 依赖刻意**不是**整个 record 对象，而是"任务 id + 处理状态 + 服务端已保存值"的签名：
   *  - 409 冲突后用户显式刷新、或并发重新读取拿到同一条仍待处理且服务端值未变的任务时，
   *    表单实例保持不变 → 用户尚未提交的输入不会被重建清空；
   *  - 任务被处理（status 变化）、换了任务（id 变化）或服务端保存值变化时签名变化 →
   *    重建表单并以服务端 `result[formKey]` 为初始值（只读回显走同一条路）。
   */
  const formsSignature = useMemo(() => {
    const record = asRecord(props.record) ?? {};
    const result = asRecord(record.result) ?? {};
    const keys =
      props.formKeys && props.formKeys.length > 0
        ? props.formKeys
        : Object.keys(asRecord(props.schema.properties) ?? {});
    return JSON.stringify({
      id: record.id ?? null,
      status: record.status ?? null,
      values: keys.map((key) => [key, result[key] ?? null]),
    });
  }, [props.record, props.formKeys, props.schema]);

  const forms = useMemo(() => {
    const record = asRecord(props.record) ?? {};
    const result = asRecord(record.result) ?? {};
    const keys =
      props.formKeys && props.formKeys.length > 0
        ? props.formKeys
        : Object.keys(asRecord(props.schema.properties) ?? {});
    const map: Record<string, Form> = {};
    for (const key of keys) {
      if (!key) continue;
      map[key] = createForm({ initialValues: (result[key] as Record<string, unknown>) ?? undefined });
    }
    return map;
    // 只按服务端值签名重建；`submitting` 等其它重渲染不重建表单实例（保住用户输入）。
  }, [formsSignature]);

  const temporalContracts = useMemo(() => collectTemporalContracts(props.schema), [props.schema]);

  const components = useMemo(() => buildComponents(), []);
  const scope = useMemo(
    () => ({
      useSubmit: useNativeSubmit,
      useFormBlockProps: useNativeFormBlockProps,
      useDetailsBlockProps: useNativeDetailsBlockProps,
    }),
    [],
  );

  const submitValue = useMemo<ManualSubmitContextValue>(
    () => ({ submit: props.onSubmit, submitting: props.submitting }),
    [props.onSubmit, props.submitting],
  );

  if (!app) {
    return <p style={{ color: '#8c8c8c' }}>正在准备表单渲染环境…</p>;
  }

  return (
    <NativeChainBoundary>
    <ApplicationContext.Provider value={app as never}>
      {Providers ? (
      /* v1 provider 栈内部的组件（会话守卫等）也会用 react-router-dom 的 useNavigate，
         因此 Router 必须在 Providers **外层**。 */
      <MemoryRouter initialEntries={['/']}>
      <Providers>
        {/* 真实 antd 组件（DatePicker 的"今天/此刻"、空态、确认框等）按项目语言显示中文。 */}
        <ConfigProvider locale={zhCN}>
        {/* 真实 v1 `CurrentUserProvider` 会自己请求 /auth:check 并在未登录时跳转 /signin；
            产品已由 P1 会话负责登录态，这里在真实 provider 栈之内提供同一 context 的值
            （形状一致：SWR 风格 { data: { data } }）。 */}
        <CurrentUserContext.Provider
          value={{ data: { data: props.currentUserId ? { id: props.currentUserId } : null } } as never}
        >
          <ManualTemporalContext.Provider value={temporalContracts}>
          <ManualFormsContext.Provider value={forms}>
          <ManualFlowContext.Provider value={flow}>
            <RecordProviderCompat record={props.record} parent={undefined}>
              <ActionContextProvider value={{ setVisible: () => undefined, setSubmitted: () => undefined }}>
                <ManualSubmitContext.Provider value={submitValue}>
                  <div className={styles.nativeFormSurface}>
                  <SchemaComponent
                    components={components as never}
                    scope={scope as never}
                    schema={
                      {
                        type: 'void',
                        name: `manual-${(props.record as { id?: unknown }).id ?? ''}`,
                        'x-component': 'Tabs',
                        properties: props.schema.properties ?? {},
                      } as never
                    }
                  />
                  </div>
                </ManualSubmitContext.Provider>
              </ActionContextProvider>
            </RecordProviderCompat>
          </ManualFlowContext.Provider>
          </ManualFormsContext.Provider>
          </ManualTemporalContext.Provider>
        </CurrentUserContext.Provider>
        </ConfigProvider>
      </Providers>
      </MemoryRouter>
      ) : null}
    </ApplicationContext.Provider>
    </NativeChainBoundary>
  );
}

/** 便于测试与核对：暴露真实组件表（不做任何替身）。 */
export function manualNativeComponents(): Record<string, unknown> {
  return buildComponents();
}

/** 便于测试与核对：真实的 schema 选项 scope（原生同名钩子）。 */
export function manualNativeScope(): Record<string, unknown> {
  return {
    useSubmit: useNativeSubmit,
    useFormBlockProps: useNativeFormBlockProps,
    useDetailsBlockProps: useNativeDetailsBlockProps,
  };
}

/** 仅供核对脚本/测试：重置应用单例。 */
export function __resetManualNativeAppForTests(): void {
  nativeApp = null;
  nativeAppLoad = null;
}

export { useNativeSubmit, useNativeFormBlockProps, useNativeDetailsBlockProps, useManualFlow, ManualFlowContext };

export type { Form };
