import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AxiosRequestConfig } from 'axios';
import { Registry } from '@nocobase/utils/client';
import { getHttpClient, setAuthContext, setTransportMode } from '../../../src/api/client';
import {
  loadVendorFrontendToolRegistry,
  loadVendorIsFrontendToolManifest,
  loadVendorParseWorkContext,
  type VendorFrontendToolManifest,
  type VendorFrontendToolRegistry,
} from './native-vendor-loader';
import { buildFirstMessagePayload, buildWorkContext, CHART_WORKSPACE_UID, CODE_WORKSPACE_UID } from '../../../src/modules/ai/context/payload';
import { __clearToolCacheForTests, prepareChatBoxContextItems, registerCrewloomNativeContexts } from '../../../src/modules/ai/context/native';
import { __resetForTests, upsertSelection } from '../../../src/modules/ai/context/store';
import type { ChartSelection, CodeSelection, DatasourceSelection, RecordSelection } from '../../../src/modules/ai/context/types';

/**
 * AI-04 的载荷与**真实原生解析**契约。
 *
 * `parseWorkContext` / `FrontendToolRegistry` / `isFrontendToolManifest` 都是固定 2.2.22 的
 * vendor 源码（经 `./native-vendor-loader` 在运行期加载，原因见该文件），因此
 * "注册 → getContent/getFrontendTools → 解析后的 ContextItem"这条链路就是原生宿主里真正会走的那条。
 * 唯一替代的是 13000 后端（用受控 adapter 返回固定响应）。
 */

interface ParsedContextItem {
  type: string;
  uid: string;
  content?: unknown;
  frontendTools?: VendorFrontendToolManifest[];
}

let FrontendToolRegistryCtor: new () => VendorFrontendToolRegistry;
let parseWorkContext: Awaited<ReturnType<typeof loadVendorParseWorkContext>>;
let isFrontendToolManifest: (value: unknown) => boolean;

beforeAll(async () => {
  FrontendToolRegistryCtor = await loadVendorFrontendToolRegistry();
  parseWorkContext = await loadVendorParseWorkContext();
  isFrontendToolManifest = await loadVendorIsFrontendToolManifest();
});

/**
 * 最小 `aiManager`：`workContext` 用上游真实的 `Registry`（重复注册会抛错，语义一致），
 * `frontendTools` 用上游真实的 `FrontendToolRegistry`。宿主里这两者由插件的 `AIManager`
 * 提供（`manager/ai-manager.ts:54,64`），这里只是不把整个插件图拉进 tsc program。
 */
interface ManagerLike {
  workContext: Registry<unknown>;
  frontendTools: VendorFrontendToolRegistry;
  registerWorkContext: (name: string, options: unknown) => void;
  getWorkContext: (name: string) => unknown;
}

function makeApp(): { app: unknown; manager: ManagerLike } {
  const workContext = new Registry<unknown>();
  const frontendTools = new FrontendToolRegistryCtor();
  const manager: ManagerLike = {
    workContext,
    frontendTools,
    registerWorkContext(name, options) {
      workContext.register(name, { name, ...(options as Record<string, unknown>) });
    },
    getWorkContext(name) {
      return workContext.get(name);
    },
  };
  const plugin = { aiManager: manager };
  const app = {
    pm: { get: (key: unknown) => (key === 'ai' ? plugin : undefined) },
  };
  return { app, manager };
}

const DATASOURCE_SELECTION: DatasourceSelection = {
  kind: 'datasource',
  uid: 'ctx-1',
  title: '本月订单',
  datasource: 'main',
  collectionName: 'orders',
  fields: ['id', 'amount'],
  filter: { logic: '$and', items: [{ path: 'status', operator: '$eq', value: 'open' }] },
  sort: ['-createdAt'],
  limit: 20,
};

const RECORD_SELECTION: RecordSelection = {
  kind: 'record',
  uid: 'crewloom:record:main:orders:7',
  title: '订单 7',
  datasource: 'main',
  collectionName: 'orders',
  primaryKey: 'id',
  recordId: 7,
  fields: ['id', 'amount'],
};

const CODE_SELECTION: CodeSelection = {
  kind: 'code',
  uid: CODE_WORKSPACE_UID,
  title: '代码工作区',
  scene: 'crewloom-code-workspace',
  language: 'typescript',
  code: 'const total = 1;',
  data: { datasource: 'main', collectionName: 'orders', fields: ['id', 'amount'], label: '订单' },
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
  limit: 100,
  chartType: 'bar',
  options: { showLegend: true, smooth: false, stacked: false },
};

beforeEach(() => {
  __resetForTests();
  __clearToolCacheForTests();
  setTransportMode('product');
});

afterEach(() => {
  __resetForTests();
  __clearToolCacheForTests();
  setAuthContext({ token: null, role: null, authenticator: null });
  vi.restoreAllMocks();
});

describe('AI-04 四类上下文进原生解析（真实 parseWorkContext）', () => {
  it('注册后 parseWorkContext 能拿到 content，并给每项挂上真实工具 manifest', async () => {
    upsertSelection(DATASOURCE_SELECTION);
    upsertSelection(RECORD_SELECTION);
    upsertSelection(CODE_SELECTION);
    upsertSelection(CHART_SELECTION);

    const { app, manager } = makeApp();
    // 模拟上游 plugin.load() 已经注册过的类型：我们的注册不能再动它
    // （`Registry.register` 默认不允许覆盖，重复注册会直接抛错）。
    const upstreamCodeEditor = { name: 'code-editor', marker: 'upstream' };
    const upstreamChartConfig = { name: 'chart-config', marker: 'upstream' };
    manager.registerWorkContext('code-editor', upstreamCodeEditor);
    manager.registerWorkContext('chart-config', upstreamChartConfig);

    const summary = registerCrewloomNativeContexts(app);

    expect(summary.ok).toBe(true);
    // v2 原生宿主里 datasource 缺失，这正是本块补的真实缺口。
    expect(summary.registeredDatasource).toBe(true);
    expect(manager.getWorkContext('datasource')).toBeTruthy();
    // 上游注册项被原样保留（`registerWorkContext` 会复制一层，所以比较内容而不是引用）。
    expect(manager.getWorkContext('code-editor')).toStrictEqual(upstreamCodeEditor);
    expect(manager.getWorkContext('chart-config')).toStrictEqual(upstreamChartConfig);

    const items = prepareChatBoxContextItems();
    const parsed = (await parseWorkContext(app, items)) as unknown as ParsedContextItem[];

    const byUid = new Map(parsed.map((item) => [item.uid, item] as const));
    // 数据范围：内容在构造时就带了存储形态筛选 → 发送前转成服务端筛选形态。
    expect(byUid.get('ctx-1')?.content).toMatchObject({
      datasource: 'main',
      collectionName: 'orders',
      filter: { $and: [{ status: { $eq: 'open' } }] },
      limit: 20,
    });
    // 指定记录：真实 datasource 类型 + 主键等值筛选 + limit 1。
    expect(byUid.get('crewloom:record:main:orders:7')?.content).toMatchObject({
      collectionName: 'orders',
      filter: { id: { $eq: 7 } },
      limit: 1,
    });
    // 代码：只带服务端模板需要的 scene / language / code。
    expect(byUid.get(CODE_WORKSPACE_UID)?.type).toBe('code-editor');
    expect(byUid.get(CODE_WORKSPACE_UID)?.content).toEqual({
      scene: 'crewloom-code-workspace',
      language: 'typescript',
      code: 'const total = 1;',
    });
    // 图表：自描述配置（chart-config 服务端走默认 JSON 策略）。
    expect(byUid.get(CHART_WORKSPACE_UID)?.type).toBe('chart-config');
    expect(byUid.get(CHART_WORKSPACE_UID)?.content).toMatchObject({
      query: { collectionName: 'orders', limit: 100 },
      chart: { type: 'bar', option: { metric: { field: 'amount', aggregation: 'sum' }, groupBy: 'status' } },
    });

    // 每一类都带上了真实注册表里的 manifest，且满足服务端的硬约束。
    for (const item of parsed) {
      expect(Array.isArray(item.frontendTools)).toBe(true);
      expect((item.frontendTools ?? []).length).toBeGreaterThan(0);
      for (const manifest of item.frontendTools ?? []) {
        expect(isFrontendToolManifest(manifest)).toBe(true);
        // server/frontend-tools.ts:39-70：blockUid 必须等于所在 ContextItem.uid，id 必须是 `${uid}:${name}`。
        expect(manifest.blockUid).toBe(item.uid);
        expect(manifest.id).toBe(`${item.uid}:${manifest.name}`);
      }
    }

    const codeTools = byUid.get(CODE_WORKSPACE_UID)?.frontendTools?.map((tool) => tool.name) ?? [];
    expect(codeTools).toEqual(['read_code_workspace', 'preview_code_change', 'apply_code_change']);
    const apply = byUid.get(CODE_WORKSPACE_UID)?.frontendTools?.find((tool) => tool.name === 'apply_code_change');
    // 修改类工具必须 ASK：客户端的 updateUserDecision 两步确认只对 ASK/interrupted 生效。
    expect(apply?.permission).toBe('ASK');

    const chartToolNames = byUid.get(CHART_WORKSPACE_UID)?.frontendTools?.map((tool) => tool.name) ?? [];
    expect(chartToolNames).toEqual(['read_chart_config', 'preview_chart_config', 'apply_chart_config']);
  });

  it('会话菜单只带 uid 时，getContent 通过真实请求回查定义并转成服务端筛选', async () => {
    const captured: AxiosRequestConfig[] = [];
    getHttpClient().defaults.adapter = async (config) => {
      captured.push(config);
      return {
        data: {
          data: {
            id: 'ctx-9',
            title: '来自菜单',
            datasource: 'main',
            collectionName: 'orders',
            fields: ['id'],
            filter: { logic: '$and', items: [{ path: 'status', operator: '$eq', value: 'paid' }] },
            sort: ['-id'],
            limit: 5,
          },
        },
        status: 200,
        statusText: '200',
        headers: {},
        config,
      };
    };
    setAuthContext({ token: 'controlled-token', role: 'member', authenticator: 'basic' });

    const { app } = makeApp();
    // 注册时没有已准备项，因此不会有工具体；菜单加入的是"只有 uid"的项（与上游 v1 一致）。
    registerCrewloomNativeContexts(app);

    const parsed = (await parseWorkContext(app, [
      { type: 'datasource', uid: 'ctx-9', title: '来自菜单' },
    ])) as unknown as ParsedContextItem[];

    expect(captured.length).toBe(1);
    expect(String(captured[0].url)).toContain('aiContextDatasources:get');
    expect(parsed[0].content).toMatchObject({
      datasource: 'main',
      collectionName: 'orders',
      filter: { $and: [{ status: { $eq: 'paid' } }] },
      limit: 5,
    });
    // 回查时顺手注册了这一项的工具，紧接着 getFrontendTools 就能取到（parseWorkContext 内同序）。
    expect(parsed[0].frontendTools?.map((tool) => tool.name)).toEqual(['preview_datasource_records']);
  });

  it('首条消息才携带 workContext 与附件（与 useChatMessageActions 同形）', () => {
    const items = buildWorkContext([CODE_SELECTION]);
    const payload = buildFirstMessagePayload(['第一段', '第二段'], items, [{ id: 1 }]);
    expect(payload).toHaveLength(2);
    expect(payload[0]).toMatchObject({ role: 'user', content: '第一段' });
    expect(payload[0].workContext).toEqual(items);
    expect(payload[0].attachments).toEqual([{ id: 1 }]);
    expect(payload[1].workContext).toBeUndefined();
    expect(payload[1].attachments).toBeUndefined();
  });

  it('同一 uid 重新注册会覆盖旧工具，不会留下上一轮的 manifest', async () => {
    upsertSelection(CODE_SELECTION);
    const { app, manager } = makeApp();
    registerCrewloomNativeContexts(app);
    const first = manager.frontendTools.list(CODE_WORKSPACE_UID).map((tool) => tool.id);
    registerCrewloomNativeContexts(app);
    const second = manager.frontendTools.list(CODE_WORKSPACE_UID).map((tool) => tool.id);
    expect(second).toEqual(first);
    expect(new Set(second).size).toBe(second.length);
  });
});
