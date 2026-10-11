/**
 * 原生运行上下文的**共享单例**（AI-03 会话宿主与 TD-03 任务页共用同一个实例）。
 *
 * 为什么要单独一层：
 *  - 原生 `Application` / `FrontendToolRegistry` 是**进程内单例**才能成立：会话界面与任务页
 *    必须拿到同一份注册表，否则任务页执行的是另一套（或空的）工具表，等于 FakeRegistry。
 *  - 但会话界面（`ChatBoxLayout`）需要 React 才能渲染，而任务页只需要"装配好的运行上下文"。
 *    因此把"构造 Application → `app.load()` → 补注册上下文/工具卡片/目录 → 注册桥宿主"
 *    抽到这里；React 渲染仍留在 `nativeChatHost.tsx`。
 *  - 构造 `Application` 会拉起固定的原生闭包（`@nocobase/client-v2` / `@nocobase/plugin-ai`），
 *    所以任务页通过**动态 import**调用这里，不把它静态拉进每个页面的依赖图。
 *
 * 失败语义：装配失败时返回 null 并允许重试；**不伪造**任何运行上下文。
 */
import { Application, NocoBaseBuildInPlugin, type ApplicationOptions } from '@nocobase/client-v2';
import PluginACLClientV2 from '@nocobase/plugin-acl/client-v2';
import PluginAIClientV2, { getGlobalChatBoxRuntime } from '@nocobase/plugin-ai/client-v2';
import { sdk } from '../../../api/client';
import { registerCrewloomNativeContexts } from '../context/native';
import { installNativeChatI18n } from './nativeChatI18n';
import { NativeToolDecisionCard } from './nativeToolDecisionCard';
import {
  getNativeAIBridge,
  installFrontendToolCatalogEntry,
  registerNativeAIBridgeHost,
  registerNativeToolUI,
} from './bridge';
import { installNativeChatStreamRecovery } from './streamRecovery';

/**
 * 用产品 SDK 客户端作为原生运行时的出站客户端。
 *
 * `Application` 在构造期调用该方法并把它写进 `app.apiClient` 与 `flowEngine.context.api`，
 * 因此覆写它比构造后再赋值更安全（后者会让 `systemSettings` 等已捕获旧实例的持有者失配）。
 */
class CrewloomNativeApplication extends Application {
  // 覆写基类的抽象工厂：返回产品唯一的 SDK 客户端，保持令牌/角色/续期/传输策略单一来源。
  protected createApiClient(_options: ApplicationOptions) {
    (sdk as unknown as { app: unknown }).app = this;
    // 宿主侧流收尾适配：只拦原生会话的 SSE 动作，把“断线/主动停止”规整成可结算的终态；
    // 产品 SDK 本身不被改动（Proxy 只作用在这个 Application 的 apiClient 上）。
    return installNativeChatStreamRecovery(sdk) as never;
  }
}

export type NativeChatBoxRuntime = ReturnType<typeof getGlobalChatBoxRuntime>;

export interface NativeRuntimeHandle {
  app: Application;
  runtime: NativeChatBoxRuntime;
  /** `datasource` 上下文是否由本次装配补注册（上游 v2 load 不含它）。 */
  datasourceRegistered: boolean;
  /** 「允许 / 拒绝」工具卡片是否注册进真实 toolsManager。 */
  toolCardRegistered: boolean;
  /** `executeFrontendTool` 是否补进了 AI 配置仓库目录。 */
  toolCatalogPatched: boolean;
}

let hostApp: Application | null = null;
let hostLoad: Promise<void> | null = null;
let runtimeReady: Promise<NativeRuntimeHandle | null> | null = null;
let lastHandle: NativeRuntimeHandle | null = null;

function buildHost(): Application {
  // ws:false —— 不建立 NocoBase 的 WebSocket；原生按 HTTP 轮询/事件降级。
  return new CrewloomNativeApplication({
    name: 'main',
    apiClient: { baseURL: '/api' },
    ws: false,
    router: { type: 'memory', initialEntries: ['/'] },
    plugins: [
      // `NocoBaseBuildInPlugin` 的构造签名在发布类型里按 `Application` 收窄，
      // 与 `PluginType`（按 `BaseApplication` 泛型）不兼容；运行时是同一个类。
      NocoBaseBuildInPlugin as never,
      // 中性别名（name/packageName）与真实插件加载器一致：原生组件用 `pm.get('acl')` / `pm.get('ai')`
      // 之类的名字解析插件实例。
      [PluginACLClientV2 as never, { name: 'acl', packageName: '@nocobase/plugin-acl' } as never],
      [PluginAIClientV2 as never, { name: 'ai', packageName: '@nocobase/plugin-ai' } as never],
    ],
  });
}

/**
 * 进程内单例的 Application（未 `load()`）。
 *
 * 原因（实测）：React 19 的 `StrictMode` 会重复执行渲染与副作用，若在 `useMemo`/`useState`
 * 初始化器里构造 `Application`，会建出两个实例、把 `NocoBaseBuildInPlugin` 的 admin 布局注册两次
 * （`Layout 'admin' has already been registered`）。模块级懒单例保证副作用只执行一次。
 */
export function getNativeHostApp(): Application {
  if (!hostApp) hostApp = buildHost();
  return hostApp;
}

/** `app.load()` 只执行一次；失败后允许重试（清掉 rejected promise）。 */
async function ensureHostLoaded(app: Application): Promise<void> {
  if (!hostLoad) hostLoad = app.load();
  try {
    await hostLoad;
  } catch (error) {
    hostLoad = null;
    throw error;
  }
}

/**
 * 装配（或复用）共享原生运行上下文。
 *
 * 幂等：并发的调用方共享同一个 promise；成功后重复调用直接返回同一 handle；
 * 失败时清空以便重试，并返回 null（调用方据此判断"桥不可用"，而不是伪造）。
 */
export async function ensureNativeRuntime(): Promise<NativeRuntimeHandle | null> {
  if (lastHandle) {
    // 已装配过：仍按**当前**上下文选择刷新一次工具体注册（幂等：registerContextTools 先 clear 再 register）。
    // 原因：运行上下文是进程内单例，用户可能先在会话页装配（当时还没有上下文选择），之后才到
    // AI-04 准备代码工作区、再冷启动 TD-03 任务页；不刷新时任务页要执行的
    // `${uid}:apply_code_change` 不在真实注册表里，会报 "Frontend tool ... is unavailable"。
    // 这里只补注册真实注册表，不伪造任何工具；失败只记录，调用方仍按真实结果处理。
    try {
      registerCrewloomNativeContexts(lastHandle.app);
    } catch (error) {
      console.error('[crewloom] 刷新上下文工具注册失败', error);
    }
    return lastHandle;
  }
  if (!runtimeReady) {
    runtimeReady = (async () => {
      const app = getNativeHostApp();
      await ensureHostLoaded(app);
      // 中文失败文案：把本实例 i18n 里缺失的错误 key（network error / 上传失败 …）
      // 映射成"发生了什么 + 下一步"，不改 vendor 字节、不影响产品全局 i18n。
      installNativeChatI18n(app);
      // AI-04 补注册：上游 v2 的 load() 不注册 `datasource` 上下文类型；
      // 同时把已准备项的工具体注册进真实 registry。
      const contextSummary = registerCrewloomNativeContexts(app);
      const runtime = getGlobalChatBoxRuntime();
      // 桥宿主必须先注册：`registerNativeToolUI` 通过桥宿主解析真实 `toolsManager`，
      // 注册顺序反了会让工具卡片注册静默失败（返回 false）。宿主在运行上下文存活期间保持注册：
      // TD-03 与会话页用的是同一个真实注册表。
      registerNativeAIBridgeHost({ app, runtime });
      // 前端工具确认卡片：注册在**同一个真实 toolsManager** 上（上游的扩展点）。
      const toolCardRegistered = registerNativeToolUI('executeFrontendTool', {
        ui: { card: NativeToolDecisionCard },
      });
      // 内置执行器不在后端 `aiTools:list` 里，必须把它补进 AI 配置仓库的目录。
      const toolCatalogPatched = installFrontendToolCatalogEntry(app);
      lastHandle = {
        app,
        runtime,
        datasourceRegistered: contextSummary.registeredDatasource,
        toolCardRegistered,
        toolCatalogPatched,
      };
      exposeRuntimeDiagnostics(lastHandle);
      return lastHandle;
    })().catch((error) => {
      console.error('[crewloom] 原生运行上下文装配失败', error);
      runtimeReady = null;
      return null;
    });
  }
  return runtimeReady;
}

/**
 * 只读诊断入口（浏览器核对脚本用；不暴露任何会改状态的调用）。
 *
 * 与会话宿主的 `__CREWLOOM_NATIVE_AI__` 分开：这个标记由**共享装配层**写入，
 * 因此用户直接打开 TD-03 任务页（没先进过会话界面）时也能读到"运行上下文是否就绪"。
 */
function exposeRuntimeDiagnostics(handle: NativeRuntimeHandle): void {
  if (typeof window === 'undefined') return;
  (window as unknown as Record<string, unknown>).__CREWLOOM_NATIVE_RUNTIME__ = {
    describe: () => {
      const app = handle.app as unknown as {
        aiManager?: { toolsManager?: { tools?: { get?: (name: string) => unknown } } };
        pm?: { get?: (name: unknown) => unknown };
      };
      // 必须用内部 Registry 直接取条目：`toolsManager.useTools()` 会调用每个工具的
      // `useHooks()`（React Hook），在组件外调用会抛 "Invalid hook call"。
      const executor = app.aiManager?.toolsManager?.tools?.get?.('executeFrontendTool') as
        | { invoke?: unknown }
        | undefined;
      const plugin = app.pm?.get?.('ai') as
        | { aiManager?: { frontendTools?: { list?: (uid: string) => unknown[] } } }
        | undefined;
      return {
        ...getNativeAIBridge().describe(),
        // 真实内置执行器是否在 toolsManager 里（模型侧执行前端工具走的就是它）。
        hasExecutor: typeof executor?.invoke === 'function',
        // 真实 FrontendToolRegistry 是否可用（list/execute 的宿主）。
        registryList: typeof plugin?.aiManager?.frontendTools?.list === 'function',
        datasourceRegistered: handle.datasourceRegistered,
        toolCardRegistered: handle.toolCardRegistered,
        toolCatalogPatched: handle.toolCatalogPatched,
      };
    },
    version: 1,
  };
}

/** 已经装配好的运行上下文（未装配时 null，不触发装配）。 */
export function peekNativeRuntime(): NativeRuntimeHandle | null {
  return lastHandle;
}
