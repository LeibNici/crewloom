import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { harness, renderPage, resetHarness } from '../access/page-harness';
import { ServiceConfigPage } from '../../../src/modules/model/pages/ServiceConfigPage';
import { ServicesPage } from '../../../src/modules/model/pages/ServicesPage';

/**
 * 主模型亲见反馈（LM-01 / LM-02）的定向回归。
 *
 *  1. LM-02：保存温度后，编辑表单必须立即显示**刚保存的**值，
 *     不能因为打开页面时读到的旧配置而回退（整页 reload 才正确的那种"视图陈旧"）；
 *     同时未修改的配置键必须保留，已保存的密钥不得回显到 DOM。
 *  2. LM-02：编辑已有服务时服务商只读（与固定 2.2.22 原生契约一致），新建时可选。
 *  3. LM-01：本页客户端筛选后，显示的条数要区分"当前筛选"与"全部"，
 *     不能把结果数冒充后端总数，也不能让分页条继续显示与结果矛盾的总数。
 *
 * 全部走受控 adapter，不连真实后端、不外呼模型。
 */

const SECRET = 'sk-synth-secret-value';
const BASE_URL = 'http://127.0.0.1:9/synth-model-gateway';

function serviceRecord(options: Record<string, unknown>) {
  return {
    name: 'synth-deepseek',
    title: '合成服务·DeepSeek',
    provider: 'deepseek',
    enabled: true,
    options,
    enabledModels: { mode: 'custom', models: [{ label: 'deepseek-chat', value: 'deepseek-chat' }] },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('LM-02 服务配置保存后的表单同步', () => {
  let currentOptions: Record<string, unknown>;

  beforeEach(() => {
    resetHarness();
    currentOptions = {
      apiKey: SECRET,
      baseURL: BASE_URL,
      temperature: 0.7,
      timeout: 5000,
      maxRetries: 0,
    };
    harness.respond(async (request) => {
      if (request.path === 'llmServices:get') {
        return { body: { data: serviceRecord(currentOptions) } };
      }
      if (request.path === 'llmServices:update') {
        const values = (request.data ?? {}) as { options?: Record<string, unknown> };
        if (values.options) currentOptions = values.options;
        return { body: { data: serviceRecord(currentOptions) } };
      }
      if (request.path === 'ai:listLLMProviders') {
        return { body: { data: [{ name: 'deepseek', title: 'DeepSeek' }, { name: 'ollama', title: 'Ollama' }] } };
      }
      return { body: { data: [] } };
    });
  });

  function renderConfig() {
    return renderPage(
      <ServiceConfigPage />,
      { route: '/model/services/synth-deepseek', path: '/model/services/:name' },
    );
  }

  async function temperatureInput(): Promise<HTMLInputElement> {
    const input = (await screen.findByLabelText(/温度/)) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('0.7'));
    return input;
  }

  it('保存 0.4 后表单立即显示 0.4，不回退到打开页面时的 0.7', async () => {
    renderConfig();
    const temperature = await temperatureInput();

    fireEvent.change(temperature, { target: { value: '0.4' } });
    expect(temperature.value).toBe('0.4');

    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await screen.findByText('已保存。');

    await waitFor(() => {
      expect((screen.getByLabelText(/温度/) as HTMLInputElement).value).toBe('0.4');
    });
  });

  it('保存只改温度：其它配置键保留，密钥输入为空且明文密钥不在 DOM', async () => {
    renderConfig();
    const temperature = await temperatureInput();
    fireEvent.change(temperature, { target: { value: '0.4' } });
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await screen.findByText('已保存。');

    const update = harness.captured.find((item) => item.path === 'llmServices:update');
    expect(update).toBeTruthy();
    expect((update!.data as { options: Record<string, unknown> }).options).toMatchObject({
      apiKey: SECRET,
      baseURL: BASE_URL,
      temperature: 0.4,
      timeout: 5000,
      maxRetries: 0,
    });

    const keyInput = screen.getByPlaceholderText('已配置（留空表示不修改）') as HTMLInputElement;
    expect(keyInput.value).toBe('');
    expect(document.body.textContent ?? '').not.toContain(SECRET);
  });

  it('编辑已有服务时服务商只读', async () => {
    renderConfig();
    expect(await screen.findByTestId('service-provider-readonly')).toHaveTextContent('DeepSeek');
    expect(screen.queryByRole('combobox', { name: /服务商/ })).toBeNull();
  });

  it('新建服务时服务商可选', async () => {
    renderPage(<ServiceConfigPage />, { route: '/model/services/new', path: '/model/services/:name' });
    expect(await screen.findByRole('combobox', { name: /服务商/ })).toBeInTheDocument();
  });
});

describe('LM-01 服务列表筛选后的计数', () => {
  beforeEach(() => {
    resetHarness();
    harness.routes['ai:listLLMServices'] = {
      body: {
        data: [
          { name: 'synth-deepseek', title: '合成服务·DeepSeek', provider: 'deepseek', enabled: true, sort: 1 },
          { name: 'synth-ollama', title: '合成服务·Ollama', provider: 'ollama', enabled: true, sort: 2 },
        ],
        meta: { count: 2, page: 1, pageSize: 12, totalPage: 1 },
      },
    };
  });

  it('按服务商筛选后同时给出当前结果数与全部条数，不冒充后端总数', async () => {
    renderPage(<ServicesPage />, { route: '/model/services', path: '/model/services' });
    await screen.findByText('合成服务·DeepSeek');
    expect(await screen.findByText(/共 2 条/)).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox', { name: '按服务商筛选' }), {
      target: { value: 'deepseek' },
    });

    expect(await screen.findByText(/已按服务商筛选：显示 1 条（本页 2 条 \/ 全部 2 条）/)).toBeInTheDocument();
    expect(screen.queryByText('合成服务·Ollama')).toBeNull();
    expect(screen.queryByText(/共 2 条/)).toBeNull();
  });
});
