/**
 * 13 个模型服务提供方的字段定义（组 A 独占）。
 *
 * 来源：固定源码 `plugin-ai/src/client-v2/llm-providers/forms.tsx` 与 `index.ts`
 * （`builtinLLMProviderModelOptionFields` 与各 `ProviderSettingsForm`）。这些字段是
 * **服务记录 `options` 里被提供方实际读取的键**，不是从响应键猜出来的：
 *  - 提供方连接字段：`apiKey`（必需，除 ollama 外）、`baseURL`（可选，服务端
 *    `provider.ts:104-105` 支持环境变量模板）、`httpReferer` / `xTitle`（仅 orcarouter、
 *    shengsuanyun）；ollama 没有必填的连接字段；
 *  - 模型参数字段：`temperature` / `topP` / `frequencyPenalty` / `presencePenalty` /
 *    `maxCompletionTokens`（或 `maxOutputTokens` / `maxTokens`）/ `responseFormat` /
 *    `timeout` / `maxRetries` / `topK` / `numPredict`。
 *
 * **重要**：原生表单把这些模型参数字段写在 `options` 下（`OptionsFields` 的
 * `namePrefix = ['options']`），而 `llmServices.options` 的更新语义是**整体替换**，
 * 因此保存时必须"读—改—写全量"，保留其它未在本表单出现的键（例如环境变量模板）。
 */

export interface OptionField {
  name: string;
  title: string;
  hint?: string;
  kind: 'number' | 'select' | 'text';
  defaultValue?: number | string;
  step?: number;
  min?: number;
  max?: number;
  options?: Array<{ label: string; value: string }>;
}

export interface ProviderSettingField {
  name: string;
  title: string;
  secret?: boolean;
  required?: boolean;
  hint?: string;
}

export interface ProviderDefinition {
  name: string;
  /** 后端 `ai:listLLMProviders` 返回的 title 缺失时的兜底显示名。 */
  fallbackTitle: string;
  /** 提供方连接字段。 */
  settings: ProviderSettingField[];
  /** 模型参数字段（按提供方差异）。 */
  modelOptions: OptionField[];
}

const responseFormatOptions = [
  { label: '文本', value: 'text' },
  { label: 'JSON', value: 'json_object' },
];

const responseFormatWithSchemaOptions = [
  ...responseFormatOptions,
  { label: 'JSON Schema', value: 'json_schema' },
];

const baseCompletionFields: OptionField[] = [
  {
    name: 'frequencyPenalty',
    title: '频率惩罚',
    hint: '取值 -2 到 2；越高越避免重复用词。',
    kind: 'number',
    defaultValue: 0,
    step: 0.1,
    min: -2,
    max: 2,
  },
  {
    name: 'maxCompletionTokens',
    title: '最大生成 Tokens',
    hint: '-1 表示由服务商默认值决定。',
    kind: 'number',
    defaultValue: -1,
  },
  {
    name: 'presencePenalty',
    title: '存在惩罚',
    hint: '取值 -2 到 2；越高越鼓励谈论新话题。',
    kind: 'number',
    defaultValue: 0,
    step: 0.1,
    min: -2,
    max: 2,
  },
  { name: 'temperature', title: '温度', hint: '越高回答越发散。', kind: 'number', defaultValue: 1, step: 0.1, min: 0, max: 1 },
  { name: 'topP', title: 'Top P', kind: 'number', defaultValue: 1, step: 0.5, min: 0, max: 1 },
  {
    name: 'responseFormat',
    title: '返回格式',
    kind: 'select',
    defaultValue: 'text',
    options: responseFormatWithSchemaOptions,
  },
  { name: 'timeout', title: '超时（毫秒）', kind: 'number', defaultValue: 60000 },
  { name: 'maxRetries', title: '失败重试次数', kind: 'number', defaultValue: 1 },
];

function withField(
  fields: OptionField[],
  name: string,
  patch: Partial<OptionField>,
): OptionField[] {
  return fields.map((field) => (field.name === name ? { ...field, ...patch } : field));
}

const apiKeySetting: ProviderSettingField = {
  name: 'apiKey',
  title: 'API Key',
  secret: true,
  required: true,
};

const baseURLSetting: ProviderSettingField = {
  name: 'baseURL',
  title: '服务地址（选填）',
  hint: '留空表示使用服务商默认地址；支持 {{ $env.变量名 }} 形式的环境变量模板。',
};

/** key = 服务记录里的 `provider` 取值（与 `ai:listLLMProviders` 的 name 对应）。 */
export const PROVIDERS: ProviderDefinition[] = [
  {
    name: 'google-genai',
    fallbackTitle: 'Google Gemini',
    settings: [apiKeySetting, baseURLSetting],
    modelOptions: withField(withField(baseCompletionFields, 'maxCompletionTokens', {
      name: 'maxOutputTokens',
      title: '最大输出 Tokens',
    }), 'temperature', { defaultValue: 0.7 }),
  },
  {
    name: 'openai',
    fallbackTitle: 'OpenAI（Responses）',
    settings: [apiKeySetting, baseURLSetting],
    modelOptions: baseCompletionFields.map((field) =>
      field.name === 'temperature' ? { ...field, defaultValue: 1 } : field,
    ),
  },
  {
    name: 'anthropic',
    fallbackTitle: 'Anthropic Claude',
    settings: [apiKeySetting, baseURLSetting],
    modelOptions: baseCompletionFields.map((field) =>
      field.name === 'temperature' ? { ...field, defaultValue: 0.7 } : field,
    ),
  },
  {
    name: 'openai-completions',
    fallbackTitle: 'OpenAI（Completions）',
    settings: [apiKeySetting, baseURLSetting],
    modelOptions: baseCompletionFields,
  },
  {
    name: 'deepseek',
    fallbackTitle: 'DeepSeek',
    settings: [apiKeySetting, baseURLSetting],
    modelOptions: baseCompletionFields.map((field) =>
      field.name === 'responseFormat' ? { ...field, options: responseFormatOptions } : field,
    ),
  },
  {
    name: 'dashscope',
    fallbackTitle: '通义千问（DashScope）',
    settings: [apiKeySetting, baseURLSetting],
    modelOptions: baseCompletionFields.map((field) =>
      field.name === 'temperature' ? { ...field, defaultValue: 0.7 } : field,
    ),
  },
  {
    name: 'ollama',
    fallbackTitle: 'Ollama（本机/自建）',
    settings: [baseURLSetting],
    modelOptions: [
      { name: 'temperature', title: '温度', kind: 'number', defaultValue: 0.8, step: 0.1, min: 0, max: 1 },
      { name: 'topP', title: 'Top P', kind: 'number', defaultValue: 0.9, step: 0.5, min: 0, max: 1 },
      { name: 'topK', title: 'Top K', kind: 'number', defaultValue: 40, min: 0 },
      { name: 'numPredict', title: '最多生成 Tokens', kind: 'number', defaultValue: -1 },
    ],
  },
  {
    name: 'kimi',
    fallbackTitle: 'Kimi（月之暗面）',
    settings: [apiKeySetting, baseURLSetting],
    modelOptions: baseCompletionFields.map((field) =>
      field.name === 'temperature' ? { ...field, defaultValue: 0.7 } : field,
    ),
  },
  {
    name: 'xai',
    fallbackTitle: 'xAI Grok',
    settings: [apiKeySetting, baseURLSetting],
    modelOptions: withField(
      withField(
        withField(baseCompletionFields, 'temperature', { defaultValue: 1 }),
        'topP',
        { step: 0.5 },
      ),
      'maxCompletionTokens',
      { defaultValue: -1 },
    ).filter((field) => field.name !== 'frequencyPenalty' && field.name !== 'presencePenalty'),
  },
  {
    name: 'mimo',
    fallbackTitle: 'MiMo',
    settings: [apiKeySetting, baseURLSetting],
    modelOptions: baseCompletionFields,
  },
  {
    name: 'mistral',
    fallbackTitle: 'Mistral',
    settings: [apiKeySetting, baseURLSetting],
    modelOptions: [
      { name: 'temperature', title: '温度', kind: 'number', defaultValue: 0.7, step: 0.1, min: 0, max: 2 },
      { name: 'topP', title: 'Top P', kind: 'number', defaultValue: 1, step: 0.1, min: 0, max: 1 },
      { name: 'maxTokens', title: '最大生成 Tokens', kind: 'number', defaultValue: -1, min: -1 },
      { name: 'frequencyPenalty', title: '频率惩罚', kind: 'number', defaultValue: 0, step: 0.1, min: -2, max: 2 },
      { name: 'presencePenalty', title: '存在惩罚', kind: 'number', defaultValue: 0, step: 0.1, min: -2, max: 2 },
      { name: 'responseFormat', title: '返回格式', kind: 'select', defaultValue: 'text', options: responseFormatOptions },
      { name: 'timeout', title: '超时（毫秒）', kind: 'number', defaultValue: 60000 },
      { name: 'maxRetries', title: '失败重试次数', kind: 'number', defaultValue: 1 },
    ],
  },
  {
    name: 'orcarouter',
    fallbackTitle: 'OrcaRouter',
    settings: [
      apiKeySetting,
      { name: 'httpReferer', title: 'HTTP Referer（选填）', hint: '会作为 HTTP-Referer 请求头发送。' },
      { name: 'xTitle', title: '应用名称（选填）', hint: '会作为 X-Title 请求头发送。' },
      baseURLSetting,
    ],
    modelOptions: baseCompletionFields.map((field) =>
      field.name === 'temperature' ? { ...field, max: 2 } : field,
    ),
  },
  {
    name: 'shengsuanyun',
    fallbackTitle: '胜算云',
    settings: [
      { name: 'apiKey', title: 'API Key', secret: true, required: true },
      { name: 'xTitle', title: 'X-Title', hint: '会作为 X-Title 请求头发送。' },
      baseURLSetting,
    ],
    modelOptions: [
      { name: 'temperature', title: '温度', kind: 'number', defaultValue: 1, step: 0.1, min: 0, max: 2 },
      { name: 'topP', title: 'Top P', kind: 'number', defaultValue: 1, step: 0.1, min: 0, max: 1 },
      { name: 'maxCompletionTokens', title: '最大生成 Tokens', kind: 'number', defaultValue: -1 },
      { name: 'responseFormat', title: '返回格式', kind: 'select', defaultValue: 'text', options: responseFormatWithSchemaOptions },
      { name: 'timeout', title: '超时（毫秒）', kind: 'number', defaultValue: 60000 },
      { name: 'maxRetries', title: '失败重试次数', kind: 'number', defaultValue: 1 },
    ],
  },
];

export const PROVIDER_BY_NAME: Record<string, ProviderDefinition> = Object.fromEntries(
  PROVIDERS.map((provider) => [provider.name, provider]),
);

export function providerDefinition(name: string | null | undefined): ProviderDefinition | undefined {
  return name ? PROVIDER_BY_NAME[name] : undefined;
}

export function providerTitle(
  name: string | null | undefined,
  providedTitle?: string | null,
): string {
  if (providedTitle && providedTitle.length > 0) return providedTitle;
  return providerDefinition(name)?.fallbackTitle ?? (name || '未选择服务商');
}
