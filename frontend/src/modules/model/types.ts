/**
 * 模型配置模块（LM-01 … LM-05）的类型与 enabledModels 形状归一。
 *
 * 依据（报告 02 §8 的 C5/D5、十页契约附录 D）：
 *  - `llmServices` 的主键是 **`name`**，没有 `id`；
 *  - `llmServices:list|get` 返回的 `options` 是**明文**（可能含 `apiKey`/`baseURL`），
 *    普通用户展示必须走 `ai:listLLMServices`（后端已剔除 `options`）；
 *  - `enabledModels` 在 13000 上是**对象** `{mode, models}`，在旧数据里可能是**字符串数组**：
 *    实现必须同时兼容，且**不改变**它本身的语义；
 *  - `aiSettings.defaultLLMService` / `defaultModel` 当前为 `null` —— 只说明"现在未配置"。
 */

export interface LlmServiceRow {
  name: string;
  title?: string | null;
  provider?: string | null;
  enabled?: boolean | null;
  /** 只有 `llmServices:list|get` 会返回；`ai:listLLMServices` 不含本字段。 */
  options?: Record<string, unknown> | null;
  enabledModels?: unknown;
  modelOptions?: Record<string, unknown> | null;
  sort?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  [key: string]: unknown;
}

export interface LlmProviderRow {
  name: string;
  title?: string | null;
  supportedModel?: string[];
  supportWebSearch?: boolean | null;
  webSearchModels?: string[] | null;
  [key: string]: unknown;
}

export interface EnabledModel {
  label: string;
  value: string;
}

export type EnabledModelsMode = 'recommended' | 'custom' | 'legacy-array' | 'unset';

export interface NormalizedEnabledModels {
  mode: EnabledModelsMode;
  models: EnabledModel[];
  /** 原始值，便于在界面上如实说明"后端存的是什么"。 */
  raw: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 归一 `enabledModels`。
 *
 * 服务端语义（`plugin-ai/src/server/manager/ai-manager.ts:141-163`）：
 *  - 对象且 `mode === 'recommended'` → 使用提供方的推荐模型（记录里的 `models` 不参与）；
 *  - 对象且 `mode === 'custom'` → 只使用 `models` 里的条目；
 *  - 数组 → 空数组等价于推荐模型；非空时每个字符串就是一个模型 id；
 *  - 其它/缺失 → 推荐模型。
 *
 * 前端据此展示与编辑，不新增"强制禁用"之类的规则。
 */
export function normalizeEnabledModels(raw: unknown): NormalizedEnabledModels {
  if (Array.isArray(raw)) {
    const models: EnabledModel[] = raw
      .map((item) => (typeof item === 'string' ? item : ''))
      .filter((item) => item.length > 0)
      .map((item) => ({ label: item, value: item }));
    return { mode: 'legacy-array', models, raw };
  }
  if (isRecord(raw)) {
    const mode = raw.mode === 'custom' ? 'custom' : raw.mode === 'recommended' ? 'recommended' : 'unset';
    const models: EnabledModel[] = Array.isArray(raw.models)
      ? raw.models
          .filter((item): item is Record<string, unknown> => isRecord(item))
          .map((item) => ({
            label: typeof item.label === 'string' && item.label.length > 0 ? item.label : String(item.value ?? ''),
            value: typeof item.value === 'string' ? item.value : '',
          }))
          .filter((item) => item.value.length > 0)
      : [];
    return { mode: mode === 'unset' ? 'unset' : mode, models, raw };
  }
  return { mode: 'unset', models: [], raw };
}

/** 归一后的形状写回后端时的取值（保留原有形状语义）。 */
export function toEnabledModelsPayload(
  mode: 'recommended' | 'custom',
  models: EnabledModel[],
  previous: NormalizedEnabledModels,
): unknown {
  if (mode === 'recommended') {
    // 保留原有对象里的其它键（例如已保存的 models），只切换 mode。
    if (isRecord(previous.raw)) {
      return { ...previous.raw, mode: 'recommended' };
    }
    return { mode: 'recommended', models: [] };
  }
  return { mode: 'custom', models: models.map((item) => ({ label: item.label || item.value, value: item.value })) };
}

export interface AiSettingsRow {
  defaultLLMService?: string | null;
  defaultModel?: string | null;
  [key: string]: unknown;
}

export interface ProviderModelRow {
  id?: string;
  [key: string]: unknown;
}

export interface TestFlightResult {
  status?: 'success' | 'error' | string;
  code?: string | number;
  message?: string;
  [key: string]: unknown;
}
