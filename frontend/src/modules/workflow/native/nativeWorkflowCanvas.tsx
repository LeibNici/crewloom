import {
  Component,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import { Route, Router, Routes } from 'react-router-dom';
import { AntdAppProvider, Application, NocoBaseBuildInPlugin, type ApplicationOptions } from '@nocobase/client-v2';
import { FlowEngineGlobalsContextProvider, FlowEngineProvider } from '@nocobase/flow-engine';
import PluginACLClientV2 from '@nocobase/plugin-acl/client-v2';
import PluginAIClientV2 from '@nocobase/plugin-ai/client-v2';
import PluginNotificationManagerClientV2 from '@nocobase/plugin-notification-manager/client-v2';
import PluginWorkflowActionTriggerClientV2 from '@nocobase/plugin-workflow-action-trigger/client-v2';
import PluginWorkflowAggregateClientV2 from '@nocobase/plugin-workflow-aggregate/client-v2';
import PluginWorkflowCCClientV2 from '@nocobase/plugin-workflow-cc/client-v2';
import PluginWorkflowClientV2, { WORKFLOW_CANVAS_ROUTE_NAME } from '@nocobase/plugin-workflow/client-v2';
import PluginWorkflowCustomActionTriggerClientV2 from '@nocobase/plugin-workflow-custom-action-trigger/client-v2';
import PluginWorkflowDateCalculationClientV2 from '@nocobase/plugin-workflow-date-calculation/client-v2';
import PluginWorkflowDelayClientV2 from '@nocobase/plugin-workflow-delay/client-v2';
import PluginWorkflowJavaScriptClientV2 from '@nocobase/plugin-workflow-javascript/client-v2';
import PluginWorkflowJsonQueryClientV2 from '@nocobase/plugin-workflow-json-query/client-v2';
import PluginWorkflowJsonVariableMappingClientV2 from '@nocobase/plugin-workflow-json-variable-mapping/client-v2';
import PluginWorkflowLoopClientV2 from '@nocobase/plugin-workflow-loop/client-v2';
import PluginWorkflowMailerClientV2 from '@nocobase/plugin-workflow-mailer/client-v2';
import PluginWorkflowManualClientV2 from '@nocobase/plugin-workflow-manual/client-v2';
import PluginWorkflowNotificationClientV2 from '@nocobase/plugin-workflow-notification/client-v2';
import PluginWorkflowParallelClientV2 from '@nocobase/plugin-workflow-parallel/client-v2';
import PluginWorkflowRequestInterceptorClientV2 from '@nocobase/plugin-workflow-request-interceptor/client-v2';
import PluginWorkflowRequestClientV2 from '@nocobase/plugin-workflow-request/client-v2';
import PluginWorkflowResponseMessageClientV2 from '@nocobase/plugin-workflow-response-message/client-v2';
import PluginWorkflowSqlClientV2 from '@nocobase/plugin-workflow-sql/client-v2';
import PluginWorkflowVariableClientV2 from '@nocobase/plugin-workflow-variable/client-v2';
import { sdk } from '../../../api/client';
import { PageCard, StatusPill } from '../../../components/Card';
import { nodeTypeLabel } from '../nodeTypes';
import { registerManualInstructionAdapter } from './manualInstructionAdapter';
import { isWorkflowHomeTarget, resolveNativeLinkTarget } from './nativeLinkTarget';
import { installNativeNodeMutationBridge } from './nativeMutationBridge';
import { installNativeWorkflowI18n } from './nativeWorkflowI18n';
import styles from '../workflow.module.css';

/**
 * WF-02 的**原生画布宿主**（`@nocobase/plugin-workflow/client-v2` 的固定源码入口）。
 *
 * 与上一版 `nativeCanvasBridge.tsx`（只有接口 + 注入点）的区别：这里不再等别人注入，
 * 而是自己装配真实原生运行上下文并挂载插件**自己的画布路由组件**：
 *  1. `Application`（`createApiClient` 覆写为产品 `sdk`：令牌/角色/续期/会话世代/传输策略单一来源）；
 *  2. `await app.load()`——插件在 `load()` 里注册全部 instruction / trigger 与画布路由；
 *  3. 用插件注册的 `componentLoader` 取回 `pages/WorkflowCanvasPage`（原生页面），
 *     在 `FlowEngineProvider` + `MemoryRouter('/:id')` 里渲染它。
 *
 * **不渲染 `app.getRootComponent()`**：那会把 NocoBase 自带的管理壳（真实 desktopRoutes 菜单）
 * 整块嵌进产品页面。这里只挂原生画布页面本身，页面里的 header / 节点 / 分支 / 配置抽屉
 * 仍然 100% 来自上游源码。
 *
 * 插件集合**按目标 13000 当前 enabled 的工作流插件清单**装配（`pm:list` 只读实测，见
 * `docs/acceptance/full-pages-13000/final-native-workflow-evidence/instruction-matrix-13000.json`），
 * 不是"只挑一个流程用到的类型"。每个插件的 instruction/trigger 注册点见 20 §2。
 */

/**
 * 原生运行上下文是进程内单例：React StrictMode 会重复执行初始化，
 * 重复 `new Application()` 会让 `NocoBaseBuildInPlugin` 重复注册 admin 布局
 * （`Layout 'admin' has already been registered`）。
 */
let hostApp: Application | null = null;
let hostLoad: Promise<void> | null = null;
let hostCanvasPage: ComponentType | null = null;
/**
 * `manual` 适配器是否由本宿主注册。
 * `null` = 还没注册过；注册后固定为结果，**不因为后续重复调用 `ensureHostReady()` 而改写**
 * （`registerManualInstructionAdapter()` 在第二次调用时会看到已存在而返回 `false`）。
 */
let hostManualAdapterRegistered: boolean | null = null;
/**
 * 官方中文资源是否已注册。
 * `addResourceBundle` 本身幂等，但没必要每次 `ensureHostReady()` 都铺一遍 20 个命名空间。
 */
let hostWorkflowI18nInstalled = false;

class CrewloomWorkflowApplication extends Application {
  protected createApiClient(_options: ApplicationOptions) {
    (sdk as unknown as { app: unknown }).app = this;
    return sdk as never;
  }
}

/**
 * 目标 13000 `pm:list` 实测 enabled 的工作流节点/触发器插件（19 个）+ notification-manager。
 * `plugin-workflow-dynamic-calculation` 在目标上是 disabled，因此不注册（不假装支持）。
 *
 * 顺序有意如此：`workflow` 必须最先（其它插件在 `load()` 里通过 `pm.get('workflow')`
 * 取它的 registry）；`notification-manager` 在 cc / notification 之前（它们的面板依赖它）。
 */
const WORKFLOW_NODE_PLUGINS = (
  [
    [PluginWorkflowManualClientV2, 'workflow-manual', '@nocobase/plugin-workflow-manual'],
    [PluginNotificationManagerClientV2, 'notification-manager', '@nocobase/plugin-notification-manager'],
    [PluginWorkflowJavaScriptClientV2, 'workflow-javascript', '@nocobase/plugin-workflow-javascript'],
    [PluginWorkflowAggregateClientV2, 'workflow-aggregate', '@nocobase/plugin-workflow-aggregate'],
    [PluginWorkflowLoopClientV2, 'workflow-loop', '@nocobase/plugin-workflow-loop'],
    [PluginWorkflowNotificationClientV2, 'workflow-notification', '@nocobase/plugin-workflow-notification'],
    [PluginWorkflowCCClientV2, 'workflow-cc', '@nocobase/plugin-workflow-cc'],
    [PluginWorkflowDateCalculationClientV2, 'workflow-date-calculation', '@nocobase/plugin-workflow-date-calculation'],
    [PluginWorkflowDelayClientV2, 'workflow-delay', '@nocobase/plugin-workflow-delay'],
    [PluginWorkflowJsonQueryClientV2, 'workflow-json-query', '@nocobase/plugin-workflow-json-query'],
    [
      PluginWorkflowJsonVariableMappingClientV2,
      'workflow-json-variable-mapping',
      '@nocobase/plugin-workflow-json-variable-mapping',
    ],
    [PluginWorkflowMailerClientV2, 'workflow-mailer', '@nocobase/plugin-workflow-mailer'],
    [PluginWorkflowParallelClientV2, 'workflow-parallel', '@nocobase/plugin-workflow-parallel'],
    [PluginWorkflowRequestClientV2, 'workflow-request', '@nocobase/plugin-workflow-request'],
    [
      PluginWorkflowRequestInterceptorClientV2,
      'workflow-request-interceptor',
      '@nocobase/plugin-workflow-request-interceptor',
    ],
    [PluginWorkflowResponseMessageClientV2, 'workflow-response-message', '@nocobase/plugin-workflow-response-message'],
    [PluginWorkflowSqlClientV2, 'workflow-sql', '@nocobase/plugin-workflow-sql'],
    [PluginWorkflowVariableClientV2, 'workflow-variable', '@nocobase/plugin-workflow-variable'],
    [PluginWorkflowActionTriggerClientV2, 'workflow-action-trigger', '@nocobase/plugin-workflow-action-trigger'],
    [
      PluginWorkflowCustomActionTriggerClientV2,
      'workflow-custom-action-trigger',
      '@nocobase/plugin-workflow-custom-action-trigger',
    ],
  ] as const
).map(([plugin, name, packageName]) => [plugin as never, { name, packageName } as never] as never[]) as never[];

function buildHost(): Application {
  return new CrewloomWorkflowApplication({
    name: 'main',
    apiClient: { baseURL: '/api' },
    ws: false,
    router: { type: 'memory', initialEntries: ['/'] },
    plugins: [
      NocoBaseBuildInPlugin as never,
      [PluginACLClientV2 as never, { name: 'acl', packageName: '@nocobase/plugin-acl' } as never],
      // 必须带中性别名 `workflow`：原生画布通过 `pm.get('workflow')` 解析 Instruction registry。
      [
        PluginWorkflowClientV2 as never,
        { name: 'workflow', packageName: '@nocobase/plugin-workflow' } as never,
      ],
      // AI 员工节点（ai-employee）。
      [PluginAIClientV2 as never, { name: 'ai', packageName: '@nocobase/plugin-ai' } as never],
      ...WORKFLOW_NODE_PLUGINS,
    ],
  });
}

/**
 * 原生画布路径（与上游 `getWorkflowCanvasPath()` 同形）。
 * 上游 `WorkflowRevisionsDropdown` / `WorkflowMenu` / `WorkflowPane` 都用它做版本切换。
 */
export function workflowCanvasPath(id: string | number): string {
  return `/admin/workflow/workflows/${encodeURIComponent(String(id))}`;
}

/**
 * 把原生 `Link` / `router` 传进来的目标转成真实 URL。
 *
 * 契约来自固定 vendor 源码与 react-router 的 `useHref` 实现：`react-router-dom` 的
 * `<Link to>` 最终把目标交给 navigator 的 `createHref()`，而它收到的是**解析后的路径对象**
 * `{ pathname, search, hash }`，不是原始字符串（详见 `./nativeLinkTarget.ts`）。
 */
export { resolveNativeLinkTarget } from './nativeLinkTarget';

/**
 * 原生传进来的画布路径有两种真实形态（上游 `useWorkflowRuntimePaths()` 按 runtime 版本二选一）：
 *  - modern：`/admin/workflow/workflows/<id>`
 *  - legacy：`/admin/settings/workflow/workflows/<id>`（本宿主实测走的是这一支）
 * 这里匹配两者（含可选 query/hash），只取版本 id。
 */
const CANVAS_PATH_PATTERN = /\/workflow\/workflows\/([^/?#]+)/;

/**
 * 宿主路由能力（对应上游 `BaseApplication` 在根组件里定义的 `ctx.router = router.router`）。
 *
 * 上游 `ctx.router` 是 `RouterManager.getRouterComponent()` 建出来的**应用级 data router**；
 * 本产品只挂载画布页、不渲染 NocoBase 管理壳，所以那个 router 从未创建——实测点击
 * 画布 header 的版本下拉会抛 `TypeError: Cannot read properties of undefined (reading 'navigate')`
 * （`WorkflowRevisionsDropdown.tsx:31`）。
 *
 * 这里提供的是**宿主适配器**：一个只认流程画布路径的内存导航器。
 *  - `/admin/workflow/workflows/<id>` → 切换画布到该版本（真实原生版本切换）；
 *  - 其它原生路径（任务中心、执行详情、工作流首页）不在本宿主挂载范围内 → 保持当前画布，
 *    不做假跳转（产品自己的导航仍由产品路由负责）。
 */
let hostRouterNavigate: ((to: string) => void) | null = null;
/** 诊断用：原生 `ctx.router.navigate()` 被调用的次数与最后一次目标路径（只读自省）。 */
const hostRouterCalls: Array<{ at: string; to: string; handled: boolean }> = [];

function ensureHostRouterProperty(app: Application): void {
  app.flowEngine.context.defineProperty('router', {
    cache: false,
    get: () => ({
      navigate: (to: unknown) => {
        const target = resolveNativeLinkTarget(to);
        const handled = Boolean(hostRouterNavigate) && CANVAS_PATH_PATTERN.test(target);
        hostRouterCalls.push({ at: new Date().toISOString(), to: target, handled });
        if (hostRouterCalls.length > 50) hostRouterCalls.shift();
        hostRouterNavigate?.(target);
      },
      getBasename: () => '',
    }),
  });
}

/** 画布内存路由：把原生的 `navigate()` 与 `useParams()` 接到同一个 location。 */
function NativeCanvasRouter({
  workflowId,
  onVersionChange,
  onOpenList,
  children,
}: {
  workflowId: string;
  onVersionChange?: (nextId: string) => void;
  /** 原生「工作流」面包屑回首页时，交给产品自己的路由打开流程列表。 */
  onOpenList?: () => void;
  children: ReactNode;
}) {
  const [pathname, setPathname] = useState(() => workflowCanvasPath(workflowId));

  const navigate = useCallback(
    (to: unknown) => {
      const target = resolveNativeLinkTarget(to);
      const match = CANVAS_PATH_PATTERN.exec(target);
      if (match) {
        setPathname(workflowCanvasPath(decodeURIComponent(match[1])));
        return;
      }
      // 原生 header 的「工作流」面包屑指向原生工作流首页；宿主没有那套管理壳，
      // 因此交给产品页自己的路由回到流程列表（不新造一套 router）。
      if (isWorkflowHomeTarget(target)) onOpenList?.();
    },
    [onOpenList],
  );

  // 产品页切换 `?workflowId=` 时，把原生画布也带到对应版本。
  useEffect(() => {
    setPathname((current) => {
      const next = workflowCanvasPath(workflowId);
      return current === next ? current : next;
    });
  }, [workflowId]);

  // 原生版本切换 → 通知产品页同步（产品页据此更新 ?workflowId=）。
  useEffect(() => {
    const match = CANVAS_PATH_PATTERN.exec(pathname);
    if (match) onVersionChange?.(decodeURIComponent(match[1]));
    // `onVersionChange` 有意不进依赖：只在路径变化时回调一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  useEffect(() => {
    hostRouterNavigate = navigate;
    return () => {
      if (hostRouterNavigate === navigate) hostRouterNavigate = null;
    };
  }, [navigate]);

  const location = useMemo(
    () => ({ pathname, search: '', hash: '', state: null, key: pathname }),
    [pathname],
  );
  const navigator = useMemo(
    () => ({
      // react-router 的 `useHref()` 会把**解析后的路径对象**交给 `createHref()`，
      // 必须按对象/字符串两种形态都生成真实 URL（详见 `resolveNativeLinkTarget`）。
      createHref: (to: unknown) => resolveNativeLinkTarget(to) || '/',
      push: (to: unknown) => navigate(to),
      replace: (to: unknown) => navigate(to),
      go: () => {},
    }),
    [navigate],
  );

  return (
    <Router location={location} navigator={navigator}>
      {children}
    </Router>
  );
}

function getHostApp(): Application {
  if (!hostApp) hostApp = buildHost();
  return hostApp;
}

/**
 * 装载原生运行时并取回插件注册的画布页面组件。
 *
 * 页面组件来自插件**自己**注册的路由（`componentLoader`），不复制任何画布逻辑。
 */
async function ensureHostReady(): Promise<{ app: Application; CanvasPage: ComponentType }> {
  const app = getHostApp();
  if (!hostLoad) hostLoad = app.load();
  try {
    await hostLoad;
  } catch (error) {
    hostLoad = null;
    throw error;
  }
  if (!hostCanvasPage) {
    const route = app.router.get(WORKFLOW_CANVAS_ROUTE_NAME) as
      | { componentLoader?: () => Promise<{ default?: ComponentType }> }
      | undefined;
    if (!route?.componentLoader) {
      throw new Error('原生工作流插件没有注册画布路由');
    }
    const module = await route.componentLoader();
    const page = module?.default;
    if (!page) throw new Error('流程编排路由没有返回页面组件');
    hostCanvasPage = page;
  }
  // 宿主适配器：`manual`（人工处理）在上游 2.x 的 v2 插件里没有 instruction（原因见适配器文件注释），
  // 这里在 `app.load()` 之后补注册。已存在则不覆盖（未来上游补齐时自动让位）。
  // 只认第一次的结果：`ensureHostReady()` 会被多次调用，重复调用会因"已存在"返回 false。
  if (hostManualAdapterRegistered === null) {
    hostManualAdapterRegistered = registerManualInstructionAdapter(app);
  }
  // 官方中文资源注册 + 语言初始化（必须在 `app.load()` 之后：LocalePlugin.afterAdd 会先写一份）。
  // 放在这里而不是 `buildHost()`，是为了让 `app.load()` 里各插件注册的 instruction 元数据
  // 在面板真正渲染前就能命中中文。
  if (!hostWorkflowI18nInstalled) {
    installNativeWorkflowI18n(app);
    hostWorkflowI18nInstalled = true;
  }
  // 上游根组件定义的 `ctx.router`（版本切换等原生导航依赖它）；本宿主补上只认画布路径的导航器。
  ensureHostRouterProperty(app);
  return { app, CanvasPage: hostCanvasPage };
}

/**
 * 只读诊断：宿主画布"重新取数"（重挂载页面组件）的决策记录。
 * 供浏览器核对脚本取证（为什么这一次重挂了 / 为什么跳过），不影响任何行为。
 */
export const canvasResyncDiagnostics = {
  bumped: 0,
  skippedByOverlay: 0,
  lastOverlay: null as string | null,
  lastBumpedAt: null as string | null,
};

/**
 * `FlowEngineGlobalsContextProvider` 每次渲染都会**重建**抽屉/弹窗的 holder 组件类型
 * （`flow-engine/src/views/useDrawer.tsx` 末尾把 `React.memo(React.forwardRef(...))` 定义在 hook 里），
 * 于是父级每重渲染一次，holder 就被重挂载、正在编辑的原生抽屉会被关掉。
 * 产品页在宿主动作后会重渲染（notice / nodes / loading…），实测"只在宿主表单里点一下按钮"就会
 * 关掉原生抽屉；Main 的"不关闭抽屉丢用户draft"正是踩在这上面。
 * 这里把 provider 子树整体 memo 住：宿主重渲染时 children 元素不变 → provider 不再重渲染。
 */
const MemoGlobalsProvider = memo(FlowEngineGlobalsContextProvider);

function nativeOverlayOpen(): string | null {
  if (typeof document === 'undefined') return null;
  if (document.querySelector('.ant-drawer-content')) return 'drawer';
  if (document.querySelector('.ant-modal-content')) return 'modal';
  return null;
}

interface RegistryLike {
  get?: (key: string) => unknown;
  getEntities?: () => Iterable<unknown>;
  getValues?: () => Iterable<unknown>;
}

interface WorkflowPluginLike {
  instructions?: RegistryLike;
  triggers?: RegistryLike;
}

type InstructionLike = { type?: string; title?: unknown; group?: string; testable?: boolean };

/**
 * 用**官方题名**作为类型显示名。
 *
 * 上游 instruction 的 `title` 是 `{{t("…", { ns })}` 模板（例如 `ai-employee` 是
 * `tExpr('AI employee')`），`flowEngine.context.t()` 正是画布 `useT()` 用的同一个翻译器，
 * 会展开模板并命中上面注册的官方 zh-CN 资源。命中不了（或拿到的还是模板/英文键）时回退到
 * 产品侧 `nodeTypeLabel()`，**不改真实 type 值**。
 */
function resolveInstructionTitle(app: Application, raw: unknown, type: string): string {
  const fallback = nodeTypeLabel(type);
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    const translated = app.flowEngine.context.t(raw);
    if (typeof translated !== 'string' || !translated || translated.startsWith('{{')) return fallback;
    return translated;
  } catch {
    return fallback;
  }
}

/** 把 registry 的 entries 规范成 `{ key, value }`（`getEntities()` 给的是 Map entries）。 */
function registryEntries(registry: RegistryLike | undefined): Array<{ key: string | null; value: unknown }> {
  const entries = registry?.getEntities?.();
  if (entries) {
    return Array.from(entries as Iterable<unknown>).map((entry) =>
      Array.isArray(entry)
        ? { key: typeof entry[0] === 'string' ? entry[0] : null, value: entry[1] }
        : { key: null, value: entry },
    );
  }
  const values = registry?.getValues?.();
  return values ? Array.from(values as Iterable<unknown>).map((value) => ({ key: null, value })) : [];
}

/**
 * 供测试/证据读取原生插件实例（Instruction registry / Trigger registry）。
 *
 * 这是**只读**自省：不改 registry，也不触发任何请求。浏览器核对脚本用它把
 * "产品实际注册了哪些 instruction" 写进证据（与目标 13000 的 enabled 插件矩阵对比）。
 */
export function readNativeWorkflowRegistry(): Record<string, unknown> {
  const app = hostApp;
  if (!app) return { ready: false };
  const plugin = app.pm.get('workflow') as WorkflowPluginLike | undefined;
  const describe = (entries: Array<{ key: string | null; value: unknown }>) =>
    entries
      .map(({ key, value }) => {
        const item = (value ?? {}) as InstructionLike;
        return {
          // trigger 实例没有 `type` 字段，注册键就是它的类型名。
          type: typeof item.type === 'string' ? item.type : key,
          title: typeof item.title === 'string' ? item.title : null,
          group: typeof item.group === 'string' ? item.group : null,
          testable: item.testable === true,
        };
      })
      .filter((item) => item.type);
  const instructionList = describe(registryEntries(plugin?.instructions));
  const triggerList = describe(registryEntries(plugin?.triggers));
  const aliases = (app.pm as unknown as { pluginsAliases?: Record<string, unknown> }).pluginsAliases ?? {};
  return {
    ready: true,
    pluginFound: Boolean(plugin),
    pluginClass: plugin?.constructor?.name,
    instructionCount: instructionList.length,
    instructionTypes: instructionList.map((item) => item.type),
    instructions: instructionList,
    triggerCount: triggerList.length,
    triggerTypes: triggerList.map((item) => item.type),
    triggers: triggerList,
    /**
     * 宿主适配器状态：`manual` 是上游缺失、由宿主补齐的类型（见 manualInstructionAdapter.tsx）。
     * `manual` 直接看 registry 里该实例上的**稳定标记** `crewloomHostAdapter`
     * （不用 `constructor.name`：生产构建会压缩类名，dev 能过、build 会失效——实测）。
     * `manualModuleFlag` 是注册时模块级标志的原始值，仅作诊断。
     */
    hostAdapters: {
      manual:
        (plugin?.instructions?.get?.('manual') as { crewloomHostAdapter?: string } | undefined)
          ?.crewloomHostAdapter === 'manual',
      manualModuleFlag: hostManualAdapterRegistered === true,
      router: typeof hostRouterNavigate === 'function',
    },
    routerCalls: hostRouterCalls.slice(),
    /** 已注册插件别名（name 与 packageName 都记）。 */
    pluginNames: Object.keys(aliases).sort(),
  };
}

declare global {
  interface Window {
    /** 只读自省入口：浏览器核对脚本读取原生 instruction/trigger registry。 */
    __crewloomWorkflowRegistry?: () => Record<string, unknown>;
  }
}

if (typeof window !== 'undefined') {
  window.__crewloomWorkflowRegistry = readNativeWorkflowRegistry;
  (window as unknown as { __crewloomCanvasResync?: typeof canvasResyncDiagnostics }).__crewloomCanvasResync =
    canvasResyncDiagnostics;
}

export interface NativeInstructionOption {
  value: string;
  label: string;
  /** 该 instruction 源码 `createDefaultConfig()` 的真实初值（失败时为 `{}`，不猜结构）。 */
  defaultConfig: Record<string, unknown>;
}

/**
 * 原生 registry 里的可新增节点类型（**真实来源**，不是产品侧硬编码清单）。
 *
 * 用途：编排页「新增节点」下拉在原生宿主就绪后改用这份清单，避免"后端已启用、
 * 画布能渲染，但产品下拉里没有"的不一致。字段级配置仍由原生画布的面板负责。
 */
export function readNativeInstructionOptions(): NativeInstructionOption[] {
  const app = hostApp;
  if (!app) return [];
  const plugin = app.pm.get('workflow') as WorkflowPluginLike | undefined;
  const options: NativeInstructionOption[] = [];
  for (const { key, value } of registryEntries(plugin?.instructions)) {
    const item = (value ?? {}) as InstructionLike & { createDefaultConfig?: () => Record<string, unknown> };
    const type = typeof item.type === 'string' ? item.type : key;
    if (!type) continue;
    let defaultConfig: Record<string, unknown> = {};
    try {
      const created = item.createDefaultConfig?.();
      if (created && typeof created === 'object' && !Array.isArray(created)) defaultConfig = created;
    } catch {
      /* 某个 instruction 的初值构造失败不影响其它类型；按空对象处理，不猜结构。 */
    }
    options.push({ value: type, label: resolveInstructionTitle(app, item.title, type), defaultConfig });
  }
  return options;
}

class CanvasBoundary extends Component<{ children: ReactNode; onError: () => void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, _info: ErrorInfo) {
    // 技术细节只留 console；界面走下面的中文说明。
    console.error('[crewloom] 原生画布渲染失败', error);
    this.props.onError();
  }

  render() {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

export interface NativeWorkflowCanvasProps {
  workflowId: string;
  /**
   * 画布内**节点写成功**后回调，让页面刷新自己的顺序列表（保存配置 / 新增 / 复制 / 移动 / 删除）。
   * 宿主只负责"通知"，刷新方式（是否静默、是否合并）由页面决定，避免关掉原生抽屉丢用户草稿。
   */
  onChanged?: () => void;
  /**
   * 宿主自己发起的节点变更（「节点处理顺序」里的新增/复制/移动/删除）成功后 +1。
   *
   * 原生画布的节点数据是它自己 `useRequest(workflows:get)` 的一份快照，只有**画布内**发起的
   * 变更才会自动 `refresh()`；宿主列表发起的变更不会。这里让画布页面组件重新挂载一次来重新取数
   * （`key` 只加在页面组件上；节点配置抽屉由 `FlowEngineGlobalsContextProvider` 的 viewer 承载，
   * 不在被重挂载的子树里，因此**不会**关掉抽屉、丢用户草稿——见 46 报告 C6 实测）。
   */
  resyncToken?: number;
  /** 原生宿主就绪后回调：编排页据此把「新增节点」下拉换成 registry 的真实类型清单。 */
  onReady?: (options: NativeInstructionOption[]) => void;
  /**
   * 用户在**原生 header 的版本下拉**里切到同一流程的另一个版本时回调，让产品页自己的
   * 版本卡片/顺序列表跟着切（否则原生画布已切换、产品页还停在旧版本，出现两套版本）。
   */
  onVersionChange?: (workflowId: string) => void;
  /** 用户点**原生 header 面包屑的「工作流」**时回调：由产品路由打开流程列表。 */
  onOpenList?: () => void;
}

type HostState =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'failed'; message: string };

/**
 * 原生画布宿主组件。
 *
 * `MemoryRouter` 的 entry 直接给出 `/:id`，与插件注册的
 * `/admin/workflow/workflows/:id` 使用同一个 `useParams().id`。
 */
export function NativeWorkflowCanvas({
  workflowId,
  onChanged,
  resyncToken,
  onReady,
  onVersionChange,
  onOpenList,
}: NativeWorkflowCanvasProps) {
  const [state, setState] = useState<HostState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const ready = useMemo(() => state.kind === 'ready', [state.kind]);
  /**
   * 宿主发起节点变更时递增：只重挂载原生**页面组件**（触发它自己重新 `workflows:get`），
   * 不动 `Application`/`FlowEngineProvider`/viewer 这些宿主外层，抽屉与草稿保持。
   */
  const [canvasRevision, setCanvasRevision] = useState(0);
  const resyncTokenRef = useRef(resyncToken);

  /**
   * 原生画布节点写成功 → 通知宿主页面刷新自己的数据。
   *
   * 画布与产品页共用同一个 `sdk`（见 `CrewloomWorkflowApplication.createApiClient`），
   * 所以在该实例的响应拦截器上判别"写动作 + 成功"即可，不需要新事件总线，也不监听读请求。
   * `onChanged` 放 ref：页面每次渲染都会传新函数，但拦截器只挂一次。
   */
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  useEffect(() => installNativeNodeMutationBridge(sdk.axios, () => onChangedRef.current?.()), []);

  useEffect(() => {
    if (resyncTokenRef.current === resyncToken) return;
    resyncTokenRef.current = resyncToken;
    // 原生抽屉/弹窗打开时**不**重挂载画布：那会打断并丢掉用户正在编辑的内容。
    // 真实用户也点不到被遮罩挡住的宿主按钮；真正的"原生变更 → 宿主刷新"走静默刷新（不卸载画布）。
    const overlay = nativeOverlayOpen();
    if (overlay) {
      canvasResyncDiagnostics.skippedByOverlay += 1;
      canvasResyncDiagnostics.lastOverlay = overlay;
      return;
    }
    canvasResyncDiagnostics.bumped += 1;
    canvasResyncDiagnostics.lastBumpedAt = new Date().toISOString();
    setCanvasRevision((value) => value + 1);
  }, [resyncToken]);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    void (async () => {
      try {
        await ensureHostReady();
        if (!cancelled) {
          setState({ kind: 'ready' });
          onReady?.(readNativeInstructionOptions());
        }
      } catch (error) {
        if (!cancelled) {
          setState({ kind: 'failed', message: error instanceof Error ? error.message : String(error) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // `onReady` 有意不进依赖：宿主是单例，只在首次就绪时通知一次，避免重复触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, workflowId]);

  const CanvasPage = ready ? hostCanvasPage : null;

  /**
   * 原生导航回调放 ref：宿主每次渲染都会传新函数，但 provider 子树必须保持稳定，
   * 否则又会走到上面的"holder 被重挂载、抽屉被关掉"。
   */
  const onVersionChangeRef = useRef(onVersionChange);
  onVersionChangeRef.current = onVersionChange;
  const onOpenListRef = useRef(onOpenList);
  onOpenListRef.current = onOpenList;
  const handleVersionChange = useCallback((nextId: string) => onVersionChangeRef.current?.(nextId), []);
  const handleOpenList = useCallback(() => onOpenListRef.current?.(), []);

  /**
   * 原生 provider 子树：只在**真正需要**时重建（首次就绪 / 切换版本 / 宿主变更后的画布重取数）。
   * `canvasRevision` 只加在原生页面组件上（`key`），provider 与 viewer 不受影响。
   */
  const canvasSurface = useMemo(
    () =>
      CanvasPage ? (
        <AntdAppProvider>
          <MemoGlobalsProvider>
            <NativeCanvasRouter
              workflowId={workflowId}
              onVersionChange={handleVersionChange}
              onOpenList={handleOpenList}
            >
              <Routes>
                <Route path="/admin/workflow/workflows/:id" element={<CanvasPage key={canvasRevision} />} />
              </Routes>
            </NativeCanvasRouter>
          </MemoGlobalsProvider>
        </AntdAppProvider>
      ) : null,
    // `CanvasPage` 只在宿主就绪后由 null 变成组件；同一版本内不再变化。
    [CanvasPage, workflowId, canvasRevision, handleVersionChange, handleOpenList],
  );

  if (state.kind === 'failed') {
    return (
      <PageCard title="流程编排暂时无法打开">
        <p className={styles.warnText}>
          画布运行时没有准备好。可以先使用下方的顺序编排；稍后重试，若一直打不开请联系管理员。
        </p>
        <div className={styles.formActions}>
          <button type="button" className={styles.primaryButton} onClick={() => setAttempt((value) => value + 1)}>
            重试
          </button>
        </div>
      </PageCard>
    );
  }

  return (
    <PageCard
      title="流程编排"
      description="在这里直接编辑流程的节点、分支与连线，改动会立即保存。"
      actions={ready ? <StatusPill tone="ok">已接入</StatusPill> : undefined}
    >
      <div className={styles.canvasNative} data-testid="native-workflow-canvas">
        {CanvasPage ? (
          <CanvasBoundary onError={() => setState({ kind: 'failed', message: 'render' })}>
            {/*
              必须补齐原生根级的两个 provider（顺序与 `BaseApplication.addBaseProviders/addFinalProviders` 一致）：
               - `AntdAppProvider`：antd `<App>`，原生 `App.useApp()` 的 modal/message/notification 来源；
               - `FlowEngineGlobalsContextProvider`：在 flow 上下文里定义 `viewer`（drawer/dialog/embed/popover）。
              缺了它，任何"打开节点配置抽屉 / 新增节点抽屉"的点击都会抛
              `TypeError: Cannot read properties of undefined (reading 'drawer')`
              （实测；只渲染画布本体时不会暴露，一旦交互就必然命中）。
            */}
            <FlowEngineProvider engine={getHostApp().flowEngine}>{canvasSurface}</FlowEngineProvider>
          </CanvasBoundary>
        ) : (
          <p className={styles.mutedText}>正在加载流程编排…</p>
        )}
        {/*
          原生运行时期望的浮层容器（上游由 AdminLayout 提供 `#nocobase-app-container`）。
          缺失时 `DrawerComponent` / `DialogComponent` 的 `getContainer` 解析为 null，
          rc-drawer / antd Modal 会把抽屉与弹窗挂到 `document.body`（实测），产品侧就无法用
          「画布宿主作用域」的窄屏 CSS 修正原生抽屉固定 50% 宽度的问题（390 下「提交」会跑出视口）。
          这里给出一个视口原点上的 0 尺寸容器：内部浮层自己就是 `position: fixed`，覆盖整个视口；
          不设 transform，因此不会被 `.canvasNative` 的 `overflow: hidden` 裁剪，也不会改变坐标基准。
        */}
        <div id="nocobase-app-container" style={{ position: 'fixed', top: 0, left: 0, width: 0, height: 0 }} />
      </div>
    </PageCard>
  );
}
