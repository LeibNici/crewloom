import { afterEach, describe, expect, it } from 'vitest';
import type { AxiosRequestConfig } from 'axios';
import { getHttpClient, setTransportMode } from '../../../src/api/client';
import {
  getServiceRaw,
  listProviders,
  listServicesMasked,
  mergeServiceOptions,
  optionKeys,
  testFlight,
  updateAiSettings,
  updateService,
} from '../../../src/modules/model/resources';
import { normalizeEnabledModels, toEnabledModelsPayload } from '../../../src/modules/model/types';
import { PROVIDERS, providerDefinition, providerTitle } from '../../../src/modules/model/providers';
import { optionFieldsToState, patchFromModelParameters } from '../../../src/modules/model/model-parameters';

/**
 * 模型配置模块（LM-01 … LM-05）的行为验证。
 *
 * 覆盖真实契约里最容易出错的三件事：
 *  1. `enabledModels` 的**对象 / 数组两种形状**同时兼容，且不改写原语义；
 *  2. `options` 的**整体替换**语义下，保存必须"读—改—写全量"，不能丢键、也不能用掩码覆盖真实密钥；
 *  3. 外呼类动作的形状（`ai:listProviderModels` / `ai:testFlight`）与严格模式的拦截。
 *
 * 全部使用受控 adapter，不访问真实后端、不产生费用。
 */

const captured: AxiosRequestConfig[] = [];

function respondWith(data: unknown) {
  const client = getHttpClient();
  client.defaults.adapter = async (config) => {
    captured.push(config);
    return { data, status: 200, statusText: '200', headers: {}, config };
  };
}

function bodyOf(request: AxiosRequestConfig): unknown {
  return typeof request.data === 'string' ? JSON.parse(request.data) : request.data;
}

afterEach(() => {
  captured.length = 0;
  setTransportMode('product');
});

describe('enabledModels 形状兼容', () => {
  it('对象（13000 实测形状）：recommended / custom', () => {
    expect(normalizeEnabledModels({ mode: 'recommended', models: [] })).toMatchObject({
      mode: 'recommended',
      models: [],
    });
    const custom = normalizeEnabledModels({
      mode: 'custom',
      models: [
        { label: 'DeepSeek Chat', value: 'deepseek-chat' },
        { value: 'deepseek-reasoner' },
        { label: '空值会被忽略', value: '' },
      ],
    });
    expect(custom.mode).toBe('custom');
    expect(custom.models).toEqual([
      { label: 'DeepSeek Chat', value: 'deepseek-chat' },
      { label: 'deepseek-reasoner', value: 'deepseek-reasoner' },
    ]);
  });

  it('数组（旧形状）：字符串 id 列表；空数组等价于推荐', () => {
    expect(normalizeEnabledModels(['a', 'b'])).toMatchObject({
      mode: 'legacy-array',
      models: [
        { label: 'a', value: 'a' },
        { label: 'b', value: 'b' },
      ],
    });
    expect(normalizeEnabledModels([]).models).toEqual([]);
    expect(normalizeEnabledModels(null)).toMatchObject({ mode: 'unset', models: [] });
  });

  it('写回：自定义写成对象；推荐模式保留原有对象里的其它键', () => {
    const legacy = normalizeEnabledModels(['old-id']);
    expect(toEnabledModelsPayload('custom', [{ label: 'X', value: 'x' }], legacy)).toEqual({
      mode: 'custom',
      models: [{ label: 'X', value: 'x' }],
    });
    const objectRecommended = normalizeEnabledModels({ mode: 'custom', models: [{ value: 'a' }], extra: 1 });
    expect(toEnabledModelsPayload('recommended', [], objectRecommended)).toEqual({
      mode: 'recommended',
      models: [{ value: 'a' }],
      extra: 1,
    });
    // 旧数组 → 切到推荐时写成对象（形状迁移），不改动任何模型 id。
    expect(toEnabledModelsPayload('recommended', [], legacy)).toEqual({ mode: 'recommended', models: [] });
  });
});

describe('options 读—改—写（整体替换语义）', () => {
  it('mergeServiceOptions 保留未修改的键，只覆盖补丁键', () => {
    const loaded = { apiKey: 'sk-real', baseURL: 'https://api.example.com', temperature: 1, custom: 'keep' };
    const merged = mergeServiceOptions(loaded, { temperature: 0.2 });
    expect(merged).toEqual({
      apiKey: 'sk-real',
      baseURL: 'https://api.example.com',
      temperature: 0.2,
      custom: 'keep',
    });
    expect(optionKeys(merged)).toEqual(['apiKey', 'baseURL', 'custom', 'temperature']);
  });

  it('patchFromModelParameters 只把有值的数字/选项下发，空值不下发', () => {
    const fields = providerDefinition('deepseek')!.modelOptions;
    const state = optionFieldsToState(fields, { temperature: 0.9, topP: 1, maxRetries: 2 });
    expect(state.temperature).toBe('0.9');
    const patch = patchFromModelParameters(fields, { ...state, topP: '' });
    expect(patch).toMatchObject({ temperature: 0.9, maxRetries: 2 });
    expect('topP' in patch).toBe(false);
  });

  it('保存服务：重新读取完整 options → 打补丁 → 整体回传（不丢键、不用掩码覆盖密钥）', async () => {
    respondWith({ data: { name: 'deepseek-main' } });
    await getServiceRaw('deepseek-main');
    expect(captured[0].url).toBe('llmServices:get');
    expect(captured[0].params).toMatchObject({ filterByTk: 'deepseek-main' });

    const loadedOptions = {
      apiKey: 'sk-real-value',
      baseURL: 'https://api.deepseek.com',
      temperature: 1,
    };
    const merged = mergeServiceOptions(loadedOptions, { temperature: 0.3 });
    respondWith({ data: { name: 'deepseek-main' } });
    await updateService('deepseek-main', { options: merged, enabledModels: { mode: 'custom', models: [] } });

    const request = captured[1];
    expect(request.url).toBe('llmServices:update');
    expect(request.params).toMatchObject({ filterByTk: 'deepseek-main' });
    expect(bodyOf(request)).toEqual({
      options: { apiKey: 'sk-real-value', baseURL: 'https://api.deepseek.com', temperature: 0.3 },
      enabledModels: { mode: 'custom', models: [] },
    });
  });
});

describe('13 个服务提供方的字段定义', () => {
  it('覆盖固定源码注册的全部提供方名', () => {
    const expected = [
      'google-genai',
      'openai',
      'anthropic',
      'openai-completions',
      'deepseek',
      'dashscope',
      'ollama',
      'kimi',
      'xai',
      'mimo',
      'mistral',
      'orcarouter',
      'shengsuanyun',
    ];
    expect(PROVIDERS.map((provider) => provider.name).sort()).toEqual(expected.sort());
    expect(PROVIDERS).toHaveLength(13);
  });

  it('除 ollama 外都要求 API Key；orcarouter / shengsuanyun 有额外请求头字段', () => {
    for (const provider of PROVIDERS) {
      expect(provider.modelOptions.length).toBeGreaterThan(0);
      const hasApiKey = provider.settings.some((field) => field.name === 'apiKey');
      expect(hasApiKey).toBe(provider.name !== 'ollama');
    }
    expect(providerDefinition('orcarouter')!.settings.map((field) => field.name)).toContain('httpReferer');
    expect(providerDefinition('orcarouter')!.settings.map((field) => field.name)).toContain('xTitle');
    expect(providerDefinition('shengsuanyun')!.settings.map((field) => field.name)).toContain('xTitle');
    expect(providerDefinition('mistral')!.modelOptions.map((field) => field.name)).toContain('maxTokens');
    expect(providerDefinition('ollama')!.modelOptions.map((field) => field.name)).toContain('topK');
    expect(providerDefinition('google-genai')!.modelOptions.map((field) => field.name)).toContain('maxOutputTokens');
  });

  it('显示名优先用后端返回的 title', () => {
    expect(providerTitle('deepseek', 'DeepSeek 官方')).toBe('DeepSeek 官方');
    expect(providerTitle('deepseek')).toBe('DeepSeek');
    expect(providerTitle('unknown-provider')).toBe('unknown-provider');
  });
});

describe('只读入口与外呼动作的形状', () => {
  it('脱敏服务列表走 GET ai:listLLMServices（不读取明文 options 的接口）', async () => {
    respondWith({ data: [{ name: 'deepseek-main', title: '主服务', provider: 'deepseek', enabled: true }], meta: {} });
    const result = await listServicesMasked({ pageSize: 50 });
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe('ai:listLLMServices');
    expect(String(captured[0].method).toLowerCase()).toBe('get');
    // 后端已剔除 options；这里断言界面拿到的是脱敏行，没有 options 字段。
    expect(Object.keys(result.rows[0])).not.toContain('options');
  });

  it('服务商清单走 GET ai:listLLMProviders', async () => {
    respondWith({ data: [{ name: 'deepseek', title: 'DeepSeek' }] });
    await listProviders();
    expect(captured[0].url).toBe('ai:listLLMProviders');
    expect(String(captured[0].method).toLowerCase()).toBe('get');
  });

  it('默认设置只提交两个键（不会顺手改动 aiSettings.options）', async () => {
    respondWith({ data: {} });
    await updateAiSettings({ defaultLLMService: 'deepseek-main', defaultModel: 'deepseek-chat' });
    expect(captured[0].url).toBe('aiSettings:update');
    expect(bodyOf(captured[0])).toEqual({
      defaultLLMService: 'deepseek-main',
      defaultModel: 'deepseek-chat',
    });

    respondWith({ data: {} });
    await updateAiSettings({ defaultLLMService: null, defaultModel: null });
    expect(bodyOf(captured[1])).toEqual({ defaultLLMService: null, defaultModel: null });
  });

  it('试飞形状：POST ai:testFlight + {provider, options, model}', async () => {
    respondWith({ data: { status: 'success' } });
    await testFlight({ provider: 'deepseek', options: { apiKey: 'sk-x' }, model: 'deepseek-chat' });
    expect(captured[0].url).toBe('ai:testFlight');
    expect(String(captured[0].method).toLowerCase()).toBe('post');
    expect(bodyOf(captured[0])).toEqual({
      provider: 'deepseek',
      options: { apiKey: 'sk-x' },
      model: 'deepseek-chat',
    });
  });

  it('严格只读模式会拦下 provider 模型发现与试飞（不产生外呼）', async () => {
    setTransportMode('strict');
    respondWith({ data: {} });
    const { listProviderModels, listServiceModels } = await import('../../../src/modules/model/resources');
    await expect(listProviderModels({ provider: 'deepseek', options: {} })).rejects.toBeTruthy();
    await expect(listServiceModels({ llmService: 'deepseek-main' })).rejects.toBeTruthy();
    await expect(testFlight({ provider: 'deepseek', options: {}, model: 'm' })).rejects.toBeTruthy();
    expect(captured).toHaveLength(0);
  });
});
