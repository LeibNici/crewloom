import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AxiosRequestConfig } from 'axios';
import { getHttpClient, setAuthContext, setTransportMode } from '../../../src/api/client';
import {
  loadVendorBuiltinFrontendTools,
  loadVendorFrontendToolRegistry,
  type VendorFrontendToolRegistry,
  type VendorToolsOptions,
} from './native-vendor-loader';
import { CHART_WORKSPACE_UID, CODE_WORKSPACE_UID, buildWorkContext } from '../../../src/modules/ai/context/payload';
import { contextToolManifests, registerContextTools, runContextTool } from '../../../src/modules/ai/context/tools';
import {
  __resetForTests,
  getProposals,
  getSelections,
  settleProposal,
  upsertSelection,
} from '../../../src/modules/ai/context/store';
import type { ChartSelection, CodeSelection, DatasourceSelection } from '../../../src/modules/ai/context/types';

/**
 * AI-04 前端工具的**真实执行链路**。
 *
 * `FrontendToolRegistry` / `executeFrontendTool` / `loadFrontendTool` 来自固定 2.2.22 的 vendor
 * 源码（经 `./native-vendor-loader` 在运行期加载）：`executeFrontendTool.invoke(app, {toolId, args})`
 * 就是原生 ChatBox 在用户确认后（`useToolCallActions.ts:58-77`）调用的那个入口。
 * 因此这里证明的是"宿主真的执行了我们的工具"，不是把工具本身 mock 掉。
 */

let FrontendToolRegistryCtor: new () => VendorFrontendToolRegistry;
let loadFrontendTool: [string, VendorToolsOptions];
let executeFrontendTool: [string, VendorToolsOptions];

beforeAll(async () => {
  FrontendToolRegistryCtor = await loadVendorFrontendToolRegistry();
  const builtin = await loadVendorBuiltinFrontendTools();
  loadFrontendTool = builtin.loadFrontendTool;
  executeFrontendTool = builtin.executeFrontendTool;
});

const CODE_SELECTION: CodeSelection = {
  kind: 'code',
  uid: CODE_WORKSPACE_UID,
  title: '代码工作区',
  scene: 'crewloom-code-workspace',
  language: 'typescript',
  code: 'const total = 1;',
  data: null,
};

const CHART_SELECTION: ChartSelection = {
  kind: 'chart',
  uid: CHART_WORKSPACE_UID,
  title: '订单图表',
  datasource: 'main',
  collectionName: 'orders',
  fields: ['id', 'amount', 'status'],
  metricField: 'amount',
  aggregation: 'sum',
  groupBy: 'status',
  filter: null,
  sort: null,
  limit: 30,
  chartType: 'bar',
  options: { showLegend: true, smooth: false, stacked: false },
};

const DATASOURCE_SELECTION: DatasourceSelection = {
  kind: 'datasource',
  uid: 'ctx-1',
  title: '本月订单',
  datasource: 'main',
  collectionName: 'orders',
  fields: ['id', 'amount'],
  filter: { logic: '$and', items: [{ path: 'status', operator: '$eq', value: 'open' }] },
  sort: ['-id'],
  limit: 50,
};

function makeApp(registry: VendorFrontendToolRegistry) {
  const plugin = { aiManager: { frontendTools: registry } };
  return { pm: { get: (key: unknown) => (key === 'ai' ? plugin : undefined) } };
}

beforeEach(() => {
  __resetForTests();
  setTransportMode('product');
});

afterEach(() => {
  __resetForTests();
  setAuthContext({ token: null, role: null, authenticator: null });
  vi.restoreAllMocks();
});

describe('AI-04 前端工具（真实 registry + 真实 invoke）', () => {
  it('executeFrontendTool 会执行到注册的 execute，应用类工具为 ASK', async () => {
    const registry = new FrontendToolRegistryCtor();
    registerContextTools(registry, 'code', CODE_WORKSPACE_UID);
    const app = makeApp(registry);

    const [name, options] = loadFrontendTool;
    expect(name).toBe('loadFrontendTool');
    const manifest = (await options.invoke(app, { toolId: `${CODE_WORKSPACE_UID}:apply_code_change` })) as {
      id: string;
      blockUid: string;
      permission: string;
      inputSchema: Record<string, unknown>;
    };
    expect(manifest.id).toBe(`${CODE_WORKSPACE_UID}:apply_code_change`);
    expect(manifest.blockUid).toBe(CODE_WORKSPACE_UID);
    expect(manifest.permission).toBe('ASK');
    expect(manifest.inputSchema).toMatchObject({ type: 'object' });

    expect(getSelections()).toHaveLength(0);
    upsertSelection(CODE_SELECTION);

    const [executeName, executeOptions] = executeFrontendTool;
    expect(executeName).toBe('executeFrontendTool');
    const result = await executeOptions.invoke(app, {
      toolId: `${CODE_WORKSPACE_UID}:apply_code_change`,
      args: { code: 'const total = 2;' },
    });
    expect(result).toEqual({ status: 'success', content: { applied: true, language: 'typescript', lines: 1 } });
    expect(getSelections()[0]).toMatchObject({ kind: 'code', code: 'const total = 2;' });
  });

  it('未注册的 toolId 会按上游语义抛错（不会静默成功）', async () => {
    const registry = new FrontendToolRegistryCtor();
    registerContextTools(registry, 'code', CODE_WORKSPACE_UID);
    const app = makeApp(registry);
    await expect(
      executeFrontendTool[1].invoke(app, { toolId: 'missing:apply_code_change', args: {} }),
    ).rejects.toThrow('unavailable');
  });

  it('预览→拒绝：不触碰工作区内容，只结算提案', async () => {
    upsertSelection(CODE_SELECTION);
    const preview = await runContextTool('code', CODE_WORKSPACE_UID, 'preview_code_change', { code: 'const total = 9;' });
    expect(preview.status).toBe('success');
    const pending = getProposals();
    expect(pending).toHaveLength(1);
    expect(pending[0].toolName).toBe('apply_code_change');

    settleProposal(pending[0].id, 'rejected');
    expect(getProposals()).toHaveLength(0);
    expect(getSelections()[0]).toMatchObject({ code: 'const total = 1;' });
  });

  it('预览→应用：写入工作区内容并结算提案', async () => {
    upsertSelection(CODE_SELECTION);
    await runContextTool('code', CODE_WORKSPACE_UID, 'preview_code_change', { code: 'const total = 9;' });
    const pending = getProposals()[0];
    const applied = await runContextTool('code', CODE_WORKSPACE_UID, 'apply_code_change', pending.args as Record<string, unknown>);
    expect(applied.status).toBe('success');
    settleProposal(pending.id, 'applied');
    expect(getSelections()[0]).toMatchObject({ code: 'const total = 9;' });
    expect(getProposals()).toHaveLength(0);
  });

  it('图表工具同样只改自己的工作区，并且拒绝参数会回退到当前值', async () => {
    upsertSelection(CHART_SELECTION);
    const preview = await runContextTool('chart', CHART_WORKSPACE_UID, 'preview_chart_config', {
      chartType: 'pie',
      aggregation: 'avg',
      groupBy: 'id',
    });
    expect(preview.status).toBe('success');
    const proposal = getProposals()[0];
    expect(proposal.preview).toMatchObject({
      changed: true,
      current: { chartType: 'bar', aggregation: 'sum', groupBy: 'status' },
      proposed: { chartType: 'pie', aggregation: 'avg', groupBy: 'id' },
    });

    const applied = await runContextTool('chart', CHART_WORKSPACE_UID, 'apply_chart_config', {
      chartType: 'not-a-type',
      aggregation: 12,
    });
    expect(applied.status).toBe('success');
    expect(getSelections()[0]).toMatchObject({ kind: 'chart', chartType: 'bar', aggregation: 'sum' });
  });

  it('参数不合法 / 没有对应工作区时返回明确错误，而不是假装成功', async () => {
    const noWorkspace = await runContextTool('code', CODE_WORKSPACE_UID, 'apply_code_change', { code: 'x' });
    expect(noWorkspace.status).toBe('error');

    upsertSelection(CODE_SELECTION);
    const emptyCode = await runContextTool('code', CODE_WORKSPACE_UID, 'preview_code_change', { code: '' });
    expect(emptyCode.status).toBe('error');

    const unknown = await runContextTool('code', CODE_WORKSPACE_UID, 'no_such_tool', {});
    expect(unknown.status).toBe('error');
  });

  it('数据范围工具走真实只读请求，并把条数上限收敛到 50 以内', async () => {
    const captured: AxiosRequestConfig[] = [];
    getHttpClient().defaults.adapter = async (config) => {
      captured.push(config);
      return {
        data: { data: [{ id: 1, amount: 10 }], meta: { count: 1 } },
        status: 200,
        statusText: '200',
        headers: {},
        config,
      };
    };
    setAuthContext({ token: 'controlled-token', role: 'member', authenticator: 'basic' });
    upsertSelection(DATASOURCE_SELECTION);

    const result = await runContextTool('datasource', 'ctx-1', 'preview_datasource_records', { limit: 999 });
    expect(result.status).toBe('success');
    expect(captured).toHaveLength(1);
    expect(String(captured[0].url)).toContain('orders:list');
    expect(captured[0].params?.pageSize).toBe(50);
    expect(result.content).toMatchObject({ collectionName: 'orders', returned: 1 });
  });

  it('产品页展示的 manifest 与真实注册表 list(uid) 完全一致（不会出现两份定义）', () => {
    const registry = new FrontendToolRegistryCtor();
    registerContextTools(registry, 'code', CODE_WORKSPACE_UID);
    registerContextTools(registry, 'chart', CHART_WORKSPACE_UID);
    registerContextTools(registry, 'datasource', DATASOURCE_SELECTION.uid);
    expect(contextToolManifests('code', CODE_WORKSPACE_UID)).toEqual(registry.list(CODE_WORKSPACE_UID));
    expect(contextToolManifests('chart', CHART_WORKSPACE_UID)).toEqual(registry.list(CHART_WORKSPACE_UID));
    expect(contextToolManifests('datasource', DATASOURCE_SELECTION.uid)).toEqual(registry.list(DATASOURCE_SELECTION.uid));
  });

  it('四类工作区构造出的项都带有可执行的工具体（与注册口径一致）', () => {
    const items = buildWorkContext([CODE_SELECTION, CHART_SELECTION, DATASOURCE_SELECTION]);
    const registry = new FrontendToolRegistryCtor();
    for (const item of items) {
      registerContextTools(registry, item.type === 'code-editor' ? 'code' : item.type === 'chart-config' ? 'chart' : 'datasource', item.uid);
    }
    for (const item of items) {
      const manifests = registry.list(item.uid);
      expect(manifests.length).toBeGreaterThan(0);
      expect(manifests.every((manifest) => manifest.blockUid === item.uid)).toBe(true);
    }
  });
});
