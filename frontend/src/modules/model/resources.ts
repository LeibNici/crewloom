import { api } from '../../api/client';
import { CrewloomError, toUserMessage } from '../../api/errors';
import { readAction } from '../ai/read-action';
import type { ApiListMeta, ListParams } from '../../api/types';
import type { ResourceState } from '../../api/hooks';
import type {
  AiSettingsRow,
  LlmProviderRow,
  LlmServiceRow,
  ProviderModelRow,
  TestFlightResult,
} from './types';

/**
 * 模型配置模块的资源封装（组 A 独占）。
 *
 * 全部走 `src/api/client.ts` 的既有请求管线；不新建请求通道、不手工拼地址或身份头。
 *
 * 明文与脱敏的边界（报告 02 §8 的 D5）：
 *  - `listServicesMasked` → `ai:listLLMServices`，**后端已剔除 `options`**，普通用户展示走这条；
 *  - `getService` / `listServicesRaw` → `llmServices:*`，返回**明文 `options`**，
 *    只有具备服务管理权限的管理编辑才调用，且页面**不得把 apiKey/baseURL 渲染到 DOM**。
 */

export interface Paged<T> {
  rows: T[];
  meta: ApiListMeta;
}

export function resourceStateOf(error: unknown, isEmpty: boolean): ResourceState {
  if (!error) return isEmpty ? 'empty' : 'ready';
  if (error instanceof CrewloomError) {
    if (error.kind === 'forbidden') return 'denied';
    if (error.kind === 'unauthenticated' || error.kind === 'role-invalid') return 'unauthorized';
  }
  return 'error';
}

export function resourceMessageOf(error: unknown): string | null {
  return error ? toUserMessage(error) : null;
}

function paged<T>(result: { data: unknown; meta?: ApiListMeta }): Paged<T> {
  return {
    rows: Array.isArray(result.data) ? (result.data as T[]) : [],
    meta: (result.meta ?? {}) as ApiListMeta,
  };
}

/* ------------------------------- LM-01 / LM-02 / LM-03 服务 ------------------------------- */

/** 脱敏的服务列表（普通用户可见；不含 `options`）。 */
export async function listServicesMasked(params?: ListParams): Promise<Paged<LlmServiceRow>> {
  return paged<LlmServiceRow>(await readAction<LlmServiceRow[]>('ai', 'listLLMServices', params));
}

/** 明文服务列表（含 `options`）：仅管理编辑使用。 */
export async function listServicesRaw(params?: ListParams): Promise<Paged<LlmServiceRow>> {
  return paged<LlmServiceRow>(await api.resourceAction<LlmServiceRow[]>('llmServices', 'list', { params }));
}

/** 读取单个服务（含明文 `options`）：仅管理编辑使用。 */
export async function getServiceRaw(name: string): Promise<LlmServiceRow | null> {
  const result = await api.resourceAction<LlmServiceRow>('llmServices', 'get', {
    params: { filterByTk: name },
  });
  return (result.data ?? null) as LlmServiceRow | null;
}

export async function createService(values: Record<string, unknown>): Promise<LlmServiceRow | null> {
  const result = await api.resourceAction<LlmServiceRow>('llmServices', 'create', { values });
  return (result.data ?? null) as LlmServiceRow | null;
}

export async function updateService(
  name: string,
  values: Record<string, unknown>,
): Promise<LlmServiceRow | null> {
  const result = await api.resourceAction<LlmServiceRow>('llmServices', 'update', {
    values,
    params: { filterByTk: name },
  });
  return (result.data ?? null) as LlmServiceRow | null;
}

export async function destroyService(name: string): Promise<void> {
  await api.resourceAction('llmServices', 'destroy', { params: { filterByTk: name } });
}

export async function listProviders(): Promise<LlmProviderRow[]> {
  const result = await readAction<LlmProviderRow[]>('ai', 'listLLMProviders');
  return Array.isArray(result.data) ? result.data : [];
}

/* ------------------------------- LM-04 默认与员工模型 ------------------------------- */

export async function getAiSettings(): Promise<AiSettingsRow> {
  const result = await api.resourceAction<AiSettingsRow>('aiSettings', 'get');
  return (result.data ?? {}) as AiSettingsRow;
}

/**
 * 保存默认服务 / 默认模型。
 *
 * 服务端把 `defaultLLMService` / `defaultModel` 之外的键并入 `options`（十页契约 D2），
 * 因此这里**只提交这两个键**，不会顺手改掉其它设置。
 */
export async function updateAiSettings(values: {
  defaultLLMService: string | null;
  defaultModel: string | null;
}): Promise<void> {
  await api.resourceAction('aiSettings', 'update', { values });
}

/* ------------------------------- 外呼类动作（仅真实用户主动触发） ------------------------------- */

/** 从服务商实时发现模型（外呼）。 */
export async function listProviderModels(input: {
  provider: string;
  options: Record<string, unknown>;
  model?: string;
}): Promise<ProviderModelRow[]> {
  const result = await api.resourceAction<ProviderModelRow[]>('ai', 'listProviderModels', {
    values: { provider: input.provider, options: input.options, model: input.model ?? '' },
  });
  return Array.isArray(result.data) ? result.data : [];
}

/** 从已保存服务实时发现模型（外呼）。 */
export async function listServiceModels(input: {
  llmService: string;
  model?: string;
}): Promise<ProviderModelRow[]> {
  const result = await api.resourceAction<ProviderModelRow[]>('ai', 'listModels', {
    values: { llmService: input.llmService, model: input.model ?? '' },
  });
  return Array.isArray(result.data) ? result.data : [];
}

/**
 * 配置验证（试飞）。
 *
 * 会真实调用模型并**产生费用**：只在真实用户主动点击时调用；
 * 严格自动验证模式在传输层直接拦截（`ai:testFlight` 在 `strictDenyActions` 里）。
 */
export async function testFlight(input: {
  provider: string;
  options: Record<string, unknown>;
  model: string;
}): Promise<TestFlightResult> {
  const result = await api.resourceAction<TestFlightResult>('ai', 'testFlight', { values: input });
  return (result.data ?? {}) as TestFlightResult;
}

/* ------------------------------- options 的读—改—写 ------------------------------- */

/**
 * `llmServices.options` 的更新语义是**整体替换**（十页契约 D1）：
 * 传 `{options:{部分键}}` 会把未传的键丢掉。因此保存时必须在**最新读取到的完整 options** 上打补丁。
 *
 * 本函数不发送请求，只负责合并；调用方必须先 `getServiceRaw(name)` 再合并再 `updateService`。
 */
export function mergeServiceOptions(
  loadedOptions: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown>,
  removals: string[] = [],
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(loadedOptions ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    merged[key] = value;
  }
  for (const key of removals) delete merged[key];
  return merged;
}

/**
 * 列出服务 `options` 里已加载的配置项名称。
 *
 * 只返回**键名**，不返回任何值：这样界面可以告诉管理员"这条服务已经配置了哪些项"，
 * 又不会把 `apiKey` / `baseURL` 之类的值渲染进 DOM。
 */
export function optionKeys(options: Record<string, unknown> | null | undefined): string[] {
  return Object.keys(options ?? {}).sort();
}
