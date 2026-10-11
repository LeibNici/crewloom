/**
 * TD-03：AI 任务页的**真实前端工具执行桥**（Crewloom tasks 模块独占消费端）。
 *
 * 原生链路（2.2.20/2.2.22 `plugin-ai` 客户端）：
 *  - 服务端 `frontend-tools.ts` 只认 `toolCallResults` 的 `{ id: <toolCallId>, result: <值> }`；
 *  - 客户端 `FrontendToolRegistry.execute(toolId, args)` 真正执行工具，
 *    模型侧通过 `ai/tools/executeFrontendTool.invoke` → `getRegistry(app).execute(toolId, args)` 到达；
 *  - `useToolCallActions` 里 `t.invoke(app, toolCall.args)` 的异常会被包成
 *    `{ id, result: { status: 'error', content: message } }`（不是静默丢弃）。
 *
 * 这里只用**已存在的宿主 runtime 入口**取真实注册表：
 * `nativeChatHost` 的 `createApiClient` 会把真实 `Application` 挂到产品 SDK 上（`sdk.app`），
 * 于是 `sdk.app.pm.get('ai').aiManager.frontendTools` 就是原生 `FrontendToolRegistry` 本身。
 * 拿不到宿主时**不伪造**：调用方保持"只回传已有结果"。
 *
 * 冷启动（用户直接打开任务页、还没进过会话界面）由 `ensureSharedNativeRuntime()` 按需装配
 * **同一个**共享运行上下文（`../ai/native/runtime`）：动态 import，避免把固定的原生闭包
 * 静态拉进每个页面（jsdom 单测也解析不了它）。
 */
import { sdk } from '../../api/client';
import { asRecord } from '../workflow/format';

/** 与原生 `FrontendToolRegistry` 相同的最小契约（不新增替身实现）。 */
export interface NativeFrontendToolRegistry {
  execute: (toolId: string, args: unknown) => Promise<unknown>;
  getManifest?: (toolId: string) => unknown;
}

/** 模型侧"执行前端工具"的工具名（`plugin-ai` common/frontend-tools）。 */
export const EXECUTE_FRONTEND_TOOL_NAME = 'executeFrontendTool';
export const LOAD_FRONTEND_TOOL_NAME = 'loadFrontendTool';

interface AppLike {
  pm?: { get?: (name: string) => unknown };
}

/**
 * 从**已存在的宿主 runtime 入口**取真实注册表。
 *
 * 返回 null 表示原生宿主尚未装配（用户还没打开过原生会话界面）：此时不执行、不伪造结果。
 */
export function resolveNativeToolRegistry(): NativeFrontendToolRegistry | null {
  const app = (sdk as unknown as { app?: AppLike }).app;
  const plugin = app?.pm?.get?.('ai') as { aiManager?: { frontendTools?: NativeFrontendToolRegistry } } | undefined;
  const registry = plugin?.aiManager?.frontendTools;
  return registry && typeof registry.execute === 'function' ? registry : null;
}

let runtimeBootstrap: Promise<boolean> | null = null;

/**
 * 冷启动时按需装配**共享原生运行上下文**（真实 `Application` + 真实 `FrontendToolRegistry`）。
 *
 * - 已经装配过（`sdk.app` 有真实注册表）时，仍会再走一次 `runtime.ensureNativeRuntime()`：
 *   它按**当前**上下文选择刷新工具体注册（幂等），否则"先打开过会话页、之后才在 AI-04
 *   准备上下文"的用户，在任务页会拿到 `Frontend tool "...:apply_code_change" is unavailable`；
 * - 未装配时动态 `import()` 固定源码闭包：任务页直接打开时也能初始化，但不把闭包静态拉进每个页面；
 * - 任何失败都返回 false 并允许下一次重试，**不伪造**注册表。
 */
export async function ensureSharedNativeRuntime(): Promise<boolean> {
  if (resolveNativeToolRegistry()) {
    try {
      const module = await import('../ai/native/runtime');
      await module.ensureNativeRuntime();
    } catch (error) {
      console.error('[crewloom] 刷新共享原生运行上下文失败', error);
    }
    return resolveNativeToolRegistry() !== null;
  }
  if (!runtimeBootstrap) {
    runtimeBootstrap = import('../ai/native/runtime')
      .then((module) => module.ensureNativeRuntime())
      .then((handle) => {
        const ok = Boolean(handle) && resolveNativeToolRegistry() !== null;
        if (!ok) runtimeBootstrap = null;
        return ok;
      })
      .catch((error) => {
        console.error('[crewloom] 共享原生运行上下文装配失败', error);
        runtimeBootstrap = null;
        return false;
      });
  }
  return runtimeBootstrap;
}

export interface BridgeToolCall {
  toolCallId: string;
  name: string;
  args: unknown;
  execution: string | null;
  /** 已记录的用户决定（`getMessages` 不回填，来自 `updateUserDecision` 的返回）。 */
  userDecision?: unknown;
}

export interface BridgeOutcome {
  toolCallIds: string[];
  toolCallResults: Array<{ id: string; result: unknown }>;
  /** 真正执行成功的前端工具数。 */
  executed: number;
  /** 执行抛错（已按原生形状包成 error result）的前端工具数。 */
  failed: number;
  /** 前端工具但没有可识别 toolId 的条目（不执行，也不伪造结果）。 */
  unresolved: string[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function decisionType(decision: unknown): string | null {
  return typeof asRecord(decision)?.type === 'string' ? (asRecord(decision)?.type as string) : null;
}

/**
 * 按原生 `useToolCallActions` 的语义执行选定的前端工具。
 *
 * - 非 `execution === 'frontend'` 的调用：只进 `toolCallIds`，不产生结果；
 * - 用户已 `reject` 的调用：只进 `toolCallIds`，不执行；
 * - `executeFrontendTool`：`registry.execute(args.toolId, args.args ?? {})`；
 * - `loadFrontendTool`：`registry.getManifest(args.toolId)`；
 * - 其他前端工具名：没有原生宿主工具表时**不猜**，记入 `unresolved`。
 */
export async function runSelectedFrontendTools(
  calls: BridgeToolCall[],
  registry: NativeFrontendToolRegistry | null,
): Promise<BridgeOutcome> {
  const toolCallIds = calls.map((call) => call.toolCallId);
  const toolCallResults: BridgeOutcome['toolCallResults'] = [];
  const unresolved: string[] = [];
  let executed = 0;
  let failed = 0;

  for (const call of calls) {
    if (call.execution !== 'frontend') continue;
    if (decisionType(call.userDecision) === 'reject') continue;
    const args = asRecord(call.args) ?? {};
    const toolId = typeof args.toolId === 'string' ? args.toolId : null;
    if (!registry || !toolId) {
      unresolved.push(call.toolCallId);
      continue;
    }
    try {
      const result =
        call.name === LOAD_FRONTEND_TOOL_NAME
          ? await registry.getManifest?.(toolId)
          : await registry.execute(toolId, args.args ?? {});
      toolCallResults.push({ id: call.toolCallId, result });
      executed += 1;
    } catch (error) {
      toolCallResults.push({ id: call.toolCallId, result: { status: 'error', content: errorMessage(error) } });
      failed += 1;
    }
  }

  return { toolCallIds, toolCallResults, executed, failed, unresolved };
}
