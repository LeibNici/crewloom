/**
 * 测试侧加载**固定 2.2.22 vendor 源码**的入口（动态、非字面量 specifier）。
 *
 * 为什么要动态：`tsconfig.test.json` 的 `include` 覆盖 `tests/**`，静态 import vendor 源码会把
 * 整个上游文件树拉进 tsc program，而上游源码不满足本项目的严格开关（`verbatimModuleSyntax`、
 * `noUnusedLocals` 等），会让 `pnpm run typecheck` 失败。用运行期拼出的 specifier，tsc 不解析它，
 * 但 Vite/vitest 仍会在运行时按产品同一套别名与解析规则加载真实模块。
 *
 * 因此测试里断言的是**原生真正会执行的代码**，不是复刻实现。
 */

const VENDOR = '../../../vendor/nocobase-2.2.22/packages/plugins/@nocobase/plugin-ai/src';

export interface VendorFrontendToolManifest {
  id: string;
  blockUid: string;
  name: string;
  title?: string;
  description: string;
  permission: 'ASK' | 'ALLOW';
  inputSchema: Record<string, unknown>;
}

export interface VendorFrontendToolRegistry {
  register: (blockUid: string, registration: Record<string, unknown>) => VendorFrontendToolManifest;
  clear: (blockUid: string) => void;
  list: (blockUid: string) => VendorFrontendToolManifest[];
  getManifest: (toolId: string) => VendorFrontendToolManifest;
  execute: (toolId: string, args: unknown) => Promise<unknown>;
}

export interface VendorToolsOptions {
  invoke: (app: unknown, params: Record<string, unknown>) => Promise<unknown>;
}

export async function loadVendorParseWorkContext(): Promise<
  (app: unknown, items: Array<Record<string, unknown>>) => Promise<Array<Record<string, unknown>>>
> {
  const module = (await import(/* @vite-ignore */ `${VENDOR}/client-v2/ai-employees/chatbox/utils.ts`)) as {
    parseWorkContext: (app: unknown, items: Array<Record<string, unknown>>) => Promise<Array<Record<string, unknown>>>;
  };
  return module.parseWorkContext;
}

export async function loadVendorFrontendToolRegistry(): Promise<new () => VendorFrontendToolRegistry> {
  const module = (await import(
    /* @vite-ignore */ `${VENDOR}/client-v2/manager/frontend-tool-registry.ts`
  )) as { FrontendToolRegistry: new () => VendorFrontendToolRegistry };
  return module.FrontendToolRegistry;
}

export async function loadVendorBuiltinFrontendTools(): Promise<{
  loadFrontendTool: [string, VendorToolsOptions];
  executeFrontendTool: [string, VendorToolsOptions];
}> {
  const module = (await import(
    /* @vite-ignore */ `${VENDOR}/client-v2/ai-employees/frontend-tools.ts`
  )) as {
    loadFrontendTool: [string, VendorToolsOptions];
    executeFrontendTool: [string, VendorToolsOptions];
  };
  return { loadFrontendTool: module.loadFrontendTool, executeFrontendTool: module.executeFrontendTool };
}

export async function loadVendorIsFrontendToolManifest(): Promise<(value: unknown) => boolean> {
  const module = (await import(/* @vite-ignore */ `${VENDOR}/common/frontend-tools.ts`)) as {
    isFrontendToolManifest: (value: unknown) => boolean;
  };
  return module.isFrontendToolManifest;
}
