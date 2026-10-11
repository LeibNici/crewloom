/**
 * TD-03 需要的**薄公共调用入口**（AI native / context 模块，绑定真实原生宿主）。
 *
 * 设计约束（为什么长这样）：
 *  - **不造 FakeRegistry、不造通用框架**：所有 provider 都来自实际加载的原生宿主
 *    （`app.pm.get('ai').aiManager.frontendTools` / `aiManager.toolsManager`）；
 *    宿主没挂载时入口返回 `mounted: false`，绝不伪造成功。
 *  - **只做薄封装**：`executeTool` 走原生的 `executeFrontendTool.invoke`
 *    （`client-v2/ai-employees/frontend-tools.ts` → `FrontendToolRegistry.execute`），
 *    `decideTool` / `resumeToolCall` 走原生相同的 `aiConversations:*` 动作与产品 SDK 管线。
 *  - **异步世代（generation）约定**：每个方法在开始执行时抓一份身份快照
 *    （会话 epoch + 用户 + 生效角色 + 会话 id），返回值里同时带 `generation` 与 `current`。
 *    晚到的结果只要 `current === false`，消费方必须丢弃（切 user/role/session 后的旧回调隔离）。
 *
 * 供另一个任务（forms / TD-03）后续根统合消费；本模块不写 tasks 目录。
 */
import { api, getSessionEpoch } from '../../../api/client';
import { NativeToolDecisionCard } from './nativeToolDecisionCard';
import { useSessionStore } from '../../../auth/store';
import { getAiManager, handoffPreparedItemsToChatBox, prepareChatBoxContextItems, registerCrewloomNativeContexts } from '../context/native';
import { getSelections } from '../context/store';
import { contextToolManifests, registerContextTools, type FrontendToolRegistryLike } from '../context/tools';
import type { ContextKind, ContextSelection, WorkContextItem } from '../context/types';

export interface NativeBridgeGeneration {
  /** `src/api/client.ts` 的会话世代：登录/退出/令牌变化时自增。 */
  epoch: number;
  user: string | null;
  role: string | null;
  /** 调用方给出的会话 id（没有会话时为 null）。 */
  sessionId: string | null;
}

export interface NativeBridgeResult<T> {
  ok: boolean;
  /** 调用开始时的身份快照。 */
  generation: NativeBridgeGeneration;
  /** 完成时是否仍属于同一身份世代；false 表示这是**晚到的旧回调**，消费方必须丢弃。 */
  current: boolean;
  value?: T;
  /** 失败原因（稳定字符串，界面文案由消费方决定）。 */
  error?: string;
}

export interface NativeToolInvokeResult {
  status: 'success' | 'error';
  content: unknown;
}

export interface NativeToolDecisionInput {
  sessionId: string;
  messageId: string;
  toolCallId: string;
  decision: 'approve' | 'edit' | 'reject';
  editedAction?: { name: string; args: unknown };
}

export interface NativeUserDecisionResponse {
  updated: number;
  toolCalls: Array<{
    id: string;
    name: string;
    args: unknown;
    userDecision?: { type?: string } & Record<string, unknown>;
  }>;
  /** 该消息下所有工具是否都已有决定（原生 `chatToolCallModel.isAllWaiting` 的服务端等价判断）。 */
  allDecided: boolean;
}

interface ToolsRegistryLike {
  get?: (key: string) => unknown;
  map?: Map<string, unknown>;
}

interface ToolsManagerLike {
  /**
   * **React Hook**：内部会调用每个工具的 `useHooks()`，只能在组件里调用
   * （原生 `useToolCallActions` 就是这么用的）。宿主外的命令式执行用 `tools.get(...)`。
   */
  useTools?: () => { get?: (name: string) => { invoke?: (app: unknown, params: unknown) => unknown } | undefined };
  registerTools?: (name: string, options: unknown) => void;
  /** `DefaultToolsManager` 内部那个不允许覆盖的 Registry（见 registerNativeToolUI）。 */
  tools?: ToolsRegistryLike;
}

interface AiManagerLikeWithTools {
  frontendTools?: FrontendToolRegistryLike;
  toolsManager?: ToolsManagerLike;
}

interface NativeHostLike {
  app: unknown;
  runtime: unknown;
}

/** 当前挂载的原生宿主（由 nativeChatHost 在 load() 之后注册）。 */
let host: NativeHostLike | null = null;

/** 说明性元数据，供消费方/核对脚本读取（不含任何业务内容）。 */
export interface NativeAIBridgeDescriptor {
  mounted: boolean;
  generation: NativeBridgeGeneration;
  /** 真实 `FrontendToolRegistry` 里当前注册的工具 id（`<uid>:<name>`）。 */
  toolIds: string[];
  contextItemCount: number;
}

export function registerNativeAIBridgeHost(next: NativeHostLike): void {
  host = next;
}

export function clearNativeAIBridgeHost(): void {
  host = null;
}

function identity(userId: unknown, role: string | null, sessionId: string | null): NativeBridgeGeneration {
  return {
    epoch: getSessionEpoch(),
    user: userId == null ? null : String(userId),
    role: role ?? null,
    sessionId,
  };
}

function generationNow(sessionId: string | null = null): NativeBridgeGeneration {
  const state = useSessionStore.getState();
  const user = state.user as { id?: unknown } | null;
  return identity(user?.id, state.activeRole ?? null, sessionId);
}

function sameGeneration(a: NativeBridgeGeneration, b: NativeBridgeGeneration): boolean {
  return a.epoch === b.epoch && a.user === b.user && a.role === b.role && a.sessionId === b.sessionId;
}

function wrap<T>(start: NativeBridgeGeneration, sessionId: string | null, run: () => T): { result: NativeBridgeResult<T>; value: T } {
  const value = run();
  const finish = generationNow(sessionId);
  return {
    value,
    result: { ok: true, generation: start, current: sameGeneration(start, finish), value },
  };
}

function failure<T>(start: NativeBridgeGeneration, sessionId: string | null, error: unknown): NativeBridgeResult<T> {
  const finish = generationNow(sessionId);
  return {
    ok: false,
    generation: start,
    current: sameGeneration(start, finish),
    error: error instanceof Error ? error.message : String(error),
  };
}

function frontendTools(): FrontendToolRegistryLike | null {
  const manager = getAiManager(host?.app) as AiManagerLikeWithTools | null;
  return manager?.frontendTools ?? null;
}

/**
 * 工具注册/执行用的是**核心** `app.aiManager.toolsManager`
 * （`client-v2` 的 `AIManager`；`useToolCallActions` 与 AI 配置仓库都用它）。
 * 插件自己的 `pm.get('ai').aiManager` 只有 `frontendTools`/`workContext`，没有 `toolsManager`，
 * 用错对象会导致"注册了但原生卡片不出现"的假成功。
 */
function toolsManager(): ToolsManagerLike | null {
  const core = (host?.app as { aiManager?: AiManagerLikeWithTools } | undefined)?.aiManager;
  if (core?.toolsManager) return core.toolsManager;
  const plugin = getAiManager(host?.app) as AiManagerLikeWithTools | null;
  return plugin?.toolsManager ?? null;
}

export interface NativeAIBridge {
  /** 只读描述（mounted 为 false 时其余字段为空值）。 */
  describe(): NativeAIBridgeDescriptor;
  /** 注册上下文类型 + 当前项的工具体（幂等）。宿主未挂载时返回 ok:false。 */
  prepareContext(selections?: ContextSelection[]): NativeBridgeResult<NativeAIBridgeDescriptor>;
  /** 把已准备内容交给原生会话输入区；返回交接条数。 */
  handoff(sessionId?: string | null): NativeBridgeResult<number>;
  /** 当前会话项的 `ContextItem`（含工具体 manifest），首条消息 payload 的来源。 */
  prepareItems(selections?: ContextSelection[]): WorkContextItem[];
  /** 真实 `FrontendToolRegistry.getManifest`。 */
  loadToolManifest(toolId: string): Promise<NativeBridgeResult<unknown>>;
  /** 真实 `FrontendToolRegistry.execute`（经原生 `executeFrontendTool.invoke`）。 */
  executeTool(toolId: string, args?: Record<string, unknown>): Promise<NativeBridgeResult<NativeToolInvokeResult | unknown>>;
  /** 真实 `aiConversations:updateUserDecision`。 */
  decideTool(input: NativeToolDecisionInput): Promise<NativeBridgeResult<NativeUserDecisionResponse>>;
  /** 真实 `aiConversations:resumeToolCall`（SSE；返回是否已被服务端接受）。 */
  resumeToolCall(input: {
    sessionId: string;
    messageId: string;
    toolCallIds: string[];
    toolCallResults: Array<{ id: string; result: unknown }>;
    employeeUsername: string;
  }): Promise<NativeBridgeResult<{ accepted: boolean }>>;
  /** 订阅身份世代变化（切 user/role/session）；返回取消订阅函数。 */
  onGenerationChange(listener: (generation: NativeBridgeGeneration) => void): () => void;
}

let bridgeHostGeneration = generationNow();
const generationListeners = new Set<(generation: NativeBridgeGeneration) => void>();

useSessionStore.subscribe(() => {
  const current = generationNow();
  if (current.epoch === bridgeHostGeneration.epoch && current.user === bridgeHostGeneration.user && current.role === bridgeHostGeneration.role) {
    return;
  }
  bridgeHostGeneration = current;
  for (const listener of generationListeners) {
    try {
      listener(current);
    } catch {
      /* 监听器异常不影响状态机 */
    }
  }
});

/**
 * 给某个后端工具挂一个 UI 卡片（真实 `app.aiManager.toolsManager`），供原生 `ToolCard` 使用。
 *
 * 注意：`DefaultToolsManager` 内部的 `Registry` 构造时 `override: false`，
 * 而 `executeFrontendTool` 在插件 `load()` 时已经注册过（`registerPluginAIClientV2BuiltinTools`），
 * 直接 `registerTools` 会抛 `does not allow to override existing keys`。
 * 因此这里保留原有 `invoke`，只在原生注册表的同一条目上补 `ui`（同一实例，不新建框架）。
 * 任何失败都只记录并返回 false：工具卡片是增强，不允许影响会话宿主能否起来。
 */
export function registerNativeToolUI(name: string, options: unknown): boolean {
  const manager = toolsManager();
  if (!manager) return false;
  try {
    const existing = manager.tools?.get?.(name);
    if (existing && manager.tools?.map?.set) {
      manager.tools.map.set(name, { ...(existing as Record<string, unknown>), ...(options as Record<string, unknown>) });
      return true;
    }
    if (typeof manager.registerTools !== 'function') return false;
    manager.registerTools(name, options);
    return true;
  } catch (error) {
    console.warn('[crewloom] 工具卡片注册失败（不影响会话）', error);
    return false;
  }
}

/** 前端工具执行器的后端工具名（`common/frontend-tools.ts` 的常量值）。 */
export const FRONTEND_TOOL_EXECUTOR_NAME = 'executeFrontendTool';

type AiConfigRepositoryLike = {
  aiTools?: unknown[];
  doRefreshAITools?: (sessionId?: string) => Promise<void>;
  __crewloomFrontendToolCatalog?: boolean;
};

/**
 * 让原生工具卡片能找到"前端工具执行器"这一条工具。
 *
 * 为什么需要：`ToolCard` 只从 **AI 配置仓库的 `aiTools`（后端 `aiTools:list` 的结果）**
 * 里按名字查 `ui.card`（`ToolCard.tsx:84-97`），而 `executeFrontendTool` 是客户端内置工具，
 * 不在该列表里 → 原生只会渲染默认卡片（一个"允许使用"按钮，无法逐条拒绝）。
 *
 * 做法（最薄接入，不改 vendor 字节、不新建框架）：
 * 在真实仓库实例的 `doRefreshAITools` 之后把这一条补进 `aiTools`，`ui.card` 指向我们自己的
 * 中文确认卡片。执行链完全不受影响：真正调用工具的仍然是 `app.aiManager.toolsManager`
 * 里的内置 `executeFrontendTool.invoke`。
 *
 * 幂等；任何一步不匹配（例如上游改了私有方法名）都只返回 false 并退回原生默认卡片。
 */
export function installFrontendToolCatalogEntry(app: unknown): boolean {
  const context = (app as { flowEngine?: { context?: { aiConfigRepository?: AiConfigRepositoryLike } } } | undefined)
    ?.flowEngine?.context;
  const repository = context?.aiConfigRepository;
  if (!repository || typeof repository.doRefreshAITools !== 'function') return false;
  if (repository.__crewloomFrontendToolCatalog) return true;

  const entry = {
    scope: 'GENERAL',
    execution: 'frontend',
    defaultPermission: 'ALLOW',
    introduction: {
      title: '执行界面操作',
      about: '数字员工请求在你的界面上执行一步操作（例如改代码或改图表配置）。',
    },
    definition: {
      name: FRONTEND_TOOL_EXECUTOR_NAME,
      description:
        'Execute a frontend tool from the current frontendToolCatalog. Use loadFrontendTool first when you need its input schema.',
    },
    ui: { card: NativeToolDecisionCard },
  };

  const original = repository.doRefreshAITools.bind(repository);
  repository.doRefreshAITools = async (sessionId?: string) => {
    await original(sessionId);
    const list = Array.isArray(repository.aiTools) ? repository.aiTools : [];
    if (list.some((tool) => (tool as { definition?: { name?: string } })?.definition?.name === FRONTEND_TOOL_EXECUTOR_NAME)) {
      return;
    }
    repository.aiTools = [...list, entry];
  };
  repository.__crewloomFrontendToolCatalog = true;
  return true;
}

export function getNativeAIBridge(): NativeAIBridge {
  return {
    describe() {
      const registry = frontendTools();
      const selections = getSelections();
      const toolIds: string[] = [];
      for (const item of prepareChatBoxContextItems(selections)) {
        const manifests = registry?.list?.(item.uid) ?? contextToolManifests(kindOf(item), item.uid);
        for (const manifest of manifests) toolIds.push(String((manifest as { id?: unknown }).id ?? ''));
      }
      return {
        mounted: Boolean(host),
        generation: generationNow(),
        toolIds: toolIds.filter(Boolean),
        contextItemCount: selections.length,
      };
    },

    prepareContext(selections = getSelections()) {
      const start = generationNow();
      if (!host) return failure(start, null, new Error('native-host-not-mounted'));
      try {
        const summary = registerCrewloomNativeContexts(host.app);
        const registry = frontendTools();
        for (const item of prepareChatBoxContextItems(selections)) {
          const kind = kindOf(item);
          if (registry) {
            registerContextTools(registry, kind, item.uid);
          }
        }
        const { result } = wrap(start, null, () => ({
          mounted: true,
          generation: start,
          toolIds: prepareChatBoxContextItems(selections).flatMap((item) =>
            (registry?.list?.(item.uid) ?? contextToolManifests(kindOf(item), item.uid)).map((manifest) =>
              String((manifest as { id?: unknown }).id ?? ''),
            ),
          ),
          contextItemCount: summary.itemCount,
        }));
        return result;
      } catch (error) {
        return failure(start, null, error);
      }
    },

    handoff(sessionId = null) {
      const start = generationNow(sessionId);
      try {
        const { result } = wrap(start, sessionId, () => handoffPreparedItemsToChatBox(host?.runtime, { force: true }));
        return result;
      } catch (error) {
        return failure(start, sessionId, error);
      }
    },

    prepareItems(selections = getSelections()) {
      return prepareChatBoxContextItems(selections);
    },

    async loadToolManifest(toolId: string) {
      const start = generationNow();
      try {
        const { result } = wrap(start, null, () => {
          const registry = frontendTools();
          if (!registry?.list) return null;
          const uid = toolId.slice(0, toolId.lastIndexOf(':'));
          const manifests = registry.list(uid) ?? [];
          return manifests.find((manifest) => (manifest as { id?: string }).id === toolId) ?? null;
        });
        return result;
      } catch (error) {
        return failure(start, null, error);
      }
    },

    async executeTool(toolId: string, args: Record<string, unknown> = {}) {
      const start = generationNow();
      const manager = getAiManager(host?.app) as AiManagerLikeWithTools | null;
      const registry = manager?.frontendTools;
      if (!host || !registry?.register) return failure(start, null, new Error('native-host-not-mounted'));
      try {
        // 与模型侧同一条真实链路：executeFrontendTool.invoke(app, {toolId, args})
        // → FrontendToolRegistry.execute(toolId, args)。
        const value = await registryExecute(registry, toolId, args);
        const finish = generationNow();
        return { ok: true, generation: start, current: sameGeneration(start, finish), value };
      } catch (error) {
        return failure(start, null, error);
      }
    },

    async decideTool(input: NativeToolDecisionInput) {
      const start = generationNow(input.sessionId);
      try {
        const userDecision =
          input.decision === 'edit'
            ? { type: 'edit' as const, editedAction: input.editedAction }
            : { type: input.decision };
        const response = await api.resourceAction<{
          updated?: number;
          toolCalls?: NativeUserDecisionResponse['toolCalls'];
        }>('aiConversations', 'updateUserDecision', {
          values: {
            sessionId: input.sessionId,
            messageId: input.messageId,
            toolCallId: input.toolCallId,
            userDecision,
          },
        });
        const toolCalls = Array.isArray(response.data?.toolCalls) ? response.data!.toolCalls! : [];
        const value: NativeUserDecisionResponse = {
          updated: Number(response.data?.updated ?? 0),
          toolCalls,
          allDecided:
            toolCalls.length > 0 &&
            toolCalls.every((call) => call.userDecision !== undefined && call.userDecision !== null),
        };
        const finish = generationNow(input.sessionId);
        return { ok: true, generation: start, current: sameGeneration(start, finish), value };
      } catch (error) {
        return failure(start, input.sessionId, error);
      }
    },

    async resumeToolCall(input) {
      const start = generationNow(input.sessionId);
      try {
        await api.request({
          url: 'aiConversations:resumeToolCall',
          method: 'post',
          headers: { Accept: 'text/event-stream' },
          data: {
            sessionId: input.sessionId,
            messageId: input.messageId,
            aiEmployee: input.employeeUsername,
            toolCallIds: input.toolCallIds,
            toolCallResults: input.toolCallResults,
            webSearch: false,
          },
          responseType: 'stream',
          adapter: 'fetch',
        });
        const finish = generationNow(input.sessionId);
        return { ok: true, generation: start, current: sameGeneration(start, finish), value: { accepted: true } };
      } catch (error) {
        return failure(start, input.sessionId, error);
      }
    },

    onGenerationChange(listener) {
      generationListeners.add(listener);
      return () => generationListeners.delete(listener);
    },
  };
}

function kindOf(item: WorkContextItem): ContextKind {
  if (item.type === 'code-editor') return 'code';
  if (item.type === 'chart-config') return 'chart';
  if (item.type === 'datasource') return item.uid.startsWith('crewloom:record:') ? 'record' : 'datasource';
  return 'datasource';
}

/**
 * 调用真实 `FrontendToolRegistry.execute`。
 *
 * 正常路径是原生内置工具 `executeFrontendTool.invoke(app, {toolId, args})`；宿主里该工具一定存在
 * （`plugin.tsx` 的 `registerPluginAIClientV2BuiltinTools`）。拿不到内置工具时退回注册表自身，
 * 仍然是**同一个真实注册表实例**，不新建假注册表。
 */
async function registryExecute(
  registry: FrontendToolRegistryLike,
  toolId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const manager = toolsManager();
  // 直接读内部 Registry 条目：`toolsManager.useTools()` 会调用工具的 `useHooks()`（React Hook），
  // 只能在组件里调用；这里是宿主外的命令式执行路径，用它会在浏览器里抛 "Invalid hook call"。
  const builtin = manager?.tools?.get?.('executeFrontendTool') as
    | { invoke?: (app: unknown, params: unknown) => unknown }
    | undefined;
  if (builtin?.invoke) {
    return builtin.invoke(host?.app, { toolId, args });
  }
  if (!registry.execute) throw new Error('frontend-tool-registry-has-no-execute');
  return registry.execute(toolId, args);
}
