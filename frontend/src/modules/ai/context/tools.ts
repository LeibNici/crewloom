/**
 * 四类上下文的前端工具（真宿主可执行范围）。
 *
 * 运行链路（固定源码）：
 *  1. 模型工具集里出现 `loadFrontendTool` / `executeFrontendTool`
 *     （`server/frontend-tools.ts:52` 的 `extractFrontendToolManifests`；内置工具由
 *      `plugin.tsx` 的 `registerPluginAIClientV2BuiltinTools` 注册）；
 *  2. 用户确认后，客户端 `useToolCallActions.ts:28-87` 先 `aiConversations:updateUserDecision`，
 *     再把 `toolCallResults` 交给 `aiConversations:resumeToolCall`；
 *  3. 其中 `executeFrontendTool.invoke` → `FrontendToolRegistry.execute(toolId, args)`
 *     （`client-v2/ai-employees/frontend-tools.ts`），最终调用这里注册的 `execute`。
 *
 * 因此这里的每个 `execute` 都必须是**宿主真的能执行**的动作：
 *  - 只读工具（`permission: 'ALLOW'`）：读当前工作区 / 读一小段记录，不外呼；
 *  - 修改工具（`permission: 'ASK'`）：只有用户在上一步明确确认后才会被调用，
 *    并且只改产品自己的上下文工作区状态，不发任何外部请求。
 *
 * 本文件不注册任何"看似存在但不能执行"的工具：四类里没有可执行动作用途的（数据源上下文
 * 由服务端 `datasource` 策略直接解析记录）就不注册多余工具。
 */
import { api } from '../../../api/client';
import { toServerFilter } from './filter';
import { CrewloomError } from '../../../api/errors';
import { recordProposal, recordRun, settleProposal, upsertSelection, getSelections } from './store';
import type { ContextKind, ContextSelection, DatasourceQueryContent, WorkContextItem } from './types';

export interface ContextToolDefinition {
  name: string;
  title: string;
  description: string;
  permission: 'ASK' | 'ALLOW';
  inputSchema: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface FrontendToolRegistryLike {
  register: (
    blockUid: string,
    registration: {
      name: string;
      title?: string;
      description: string;
      permission?: 'ASK' | 'ALLOW';
      inputSchema?: Record<string, unknown>;
      execute: (args: unknown) => unknown | Promise<unknown>;
    },
  ) => unknown;
  clear?: (blockUid: string) => void;
  list?: (blockUid: string) => Array<{ id: string; blockUid: string; name: string }>;
  /** 真实注册表的执行入口（`manager/frontend-tool-registry.ts:execute`）。 */
  execute?: (toolId: string, args: unknown) => Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function failure(error: unknown): { status: 'error'; content: string } {
  return {
    status: 'error',
    content: error instanceof CrewloomError ? error.userMessage : error instanceof Error ? error.message : String(error),
  };
}

function success(content: unknown): { status: 'success'; content: unknown } {
  return { status: 'success', content };
}

/** 从当前选择里取一项（工具执行时用它读写工作区状态）。 */
function selectionOf(kind: ContextKind) {
  return getSelections().find((selection) => selection.kind === kind) ?? null;
}

async function readRecords(query: DatasourceQueryContent, limit: number): Promise<unknown> {
  const sort = Array.isArray(query.sort) ? query.sort.map((item) => String(item)) : undefined;
  const result = await api.resourceAction<unknown[]>(query.collectionName, 'list', {
    params: {
      pageSize: Math.min(Math.max(limit, 1), 50),
      ...(query.fields && query.fields.length > 0 ? { fields: query.fields } : {}),
      ...(query.filter ? { filter: query.filter } : {}),
      ...(sort && sort.length > 0 ? { sort } : {}),
    },
  });
  const rows = Array.isArray(result.data) ? result.data : [];
  return {
    datasource: query.datasource,
    collectionName: query.collectionName,
    fields: query.fields ?? null,
    returned: rows.length,
    records: rows,
  };
}

function codeToolDefinitions(uid: string): ContextToolDefinition[] {
  return [
    {
      name: 'read_code_workspace',
      title: '读取代码工作区',
      description: '读取当前代码工作区的语言与完整代码，用于确认现状后再提出修改。',
      permission: 'ALLOW',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => {
        const selection = selectionOf('code');
        if (!selection || selection.kind !== 'code') return success({ available: false });
        recordRun({ uid, toolName: 'read_code_workspace', decision: 'read', at: new Date().toISOString() });
        return success({
          language: selection.language,
          scene: selection.scene,
          code: selection.code,
          dataSelection: selection.data
            ? { collectionName: selection.data.collectionName, fields: selection.data.fields }
            : null,
        });
      },
    },
    {
      name: 'preview_code_change',
      title: '预览代码修改',
      description: '在不落盘的前提下预览一段新代码与当前代码的差异；用户可据此选择应用或拒绝。',
      permission: 'ALLOW',
      inputSchema: {
        type: 'object',
        properties: { code: { type: 'string', description: '建议替换的完整代码' } },
        required: ['code'],
      },
      execute: async (args) => {
        const selection = selectionOf('code');
        if (!selection || selection.kind !== 'code') return failure(new Error('当前没有代码工作区内容。'));
        const code = args.code;
        if (typeof code !== 'string' || code.length === 0) {
          return failure(new Error('preview_code_change 需要一个非空的 code 字符串。'));
        }
        const preview = {
          language: selection.language,
          currentLines: selection.code.split('\n').length,
          proposedLines: code.split('\n').length,
          changed: code !== selection.code,
          proposed: code,
        };
        recordProposal({
          id: `${uid}:preview_code_change:${Date.now()}`,
          uid,
          toolName: 'apply_code_change',
          args: { code },
          preview,
          at: new Date().toISOString(),
          status: 'pending',
        });
        return success(preview);
      },
    },
    {
      name: 'apply_code_change',
      title: '应用代码修改',
      description: '把用户已确认的代码写入代码工作区。属于修改动作，必须由用户明确确认后才会执行。',
      permission: 'ASK',
      inputSchema: {
        type: 'object',
        properties: { code: { type: 'string', description: '要应用的完整代码' } },
        required: ['code'],
      },
      execute: async (args) => {
        const selection = selectionOf('code');
        if (!selection || selection.kind !== 'code') return failure(new Error('当前没有代码工作区内容。'));
        const code = args.code;
        if (typeof code !== 'string' || code.length === 0) {
          return failure(new Error('apply_code_change 需要一个非空的 code 字符串。'));
        }
        upsertSelection({ ...selection, code });
        recordRun({ uid, toolName: 'apply_code_change', decision: 'applied', at: new Date().toISOString() });
        return success({ applied: true, language: selection.language, lines: code.split('\n').length });
      },
    },
  ];
}

function chartToolDefinitions(uid: string): ContextToolDefinition[] {
  return [
    {
      name: 'read_chart_config',
      title: '读取图表配置',
      description: '读取当前图表的字段、聚合、样式与数据范围。',
      permission: 'ALLOW',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => {
        const selection = selectionOf('chart');
        if (!selection || selection.kind !== 'chart') return success({ available: false });
        recordRun({ uid, toolName: 'read_chart_config', decision: 'read', at: new Date().toISOString() });
        return success({
          collectionName: selection.collectionName,
          fields: selection.fields,
          metricField: selection.metricField,
          aggregation: selection.aggregation,
          groupBy: selection.groupBy,
          chartType: selection.chartType,
          options: selection.options,
          limit: selection.limit,
        });
      },
    },
    {
      name: 'preview_chart_config',
      title: '预览图表配置修改',
      description: '在不改动当前图表的前提下预览一份新配置；用户可据此选择应用或拒绝。',
      permission: 'ALLOW',
      inputSchema: {
        type: 'object',
        properties: {
          chartType: { type: 'string', enum: ['bar', 'line', 'pie'] },
          aggregation: { type: 'string', enum: ['count', 'sum', 'avg', 'min', 'max'] },
          groupBy: { type: 'string' },
        },
      },
      execute: async (args) => {
        const selection = selectionOf('chart');
        if (!selection || selection.kind !== 'chart') return failure(new Error('当前没有图表工作区内容。'));
        const next = {
          ...selection,
          chartType:
            args.chartType === 'bar' || args.chartType === 'line' || args.chartType === 'pie'
              ? args.chartType
              : selection.chartType,
          aggregation:
            args.aggregation === 'count' ||
            args.aggregation === 'sum' ||
            args.aggregation === 'avg' ||
            args.aggregation === 'min' ||
            args.aggregation === 'max'
              ? args.aggregation
              : selection.aggregation,
          groupBy: typeof args.groupBy === 'string' && args.groupBy ? args.groupBy : selection.groupBy,
        };
        const preview = {
          changed:
            next.chartType !== selection.chartType ||
            next.aggregation !== selection.aggregation ||
            next.groupBy !== selection.groupBy,
          current: {
            chartType: selection.chartType,
            aggregation: selection.aggregation,
            groupBy: selection.groupBy,
          },
          proposed: { chartType: next.chartType, aggregation: next.aggregation, groupBy: next.groupBy },
        };
        recordProposal({
          id: `${uid}:preview_chart_config:${Date.now()}`,
          uid,
          toolName: 'apply_chart_config',
          args,
          preview,
          at: new Date().toISOString(),
          status: 'pending',
        });
        return success(preview);
      },
    },
    {
      name: 'apply_chart_config',
      title: '应用图表配置',
      description: '把用户已确认的图表配置写入图表工作区。属于修改动作，必须由用户明确确认后才会执行。',
      permission: 'ASK',
      inputSchema: {
        type: 'object',
        properties: {
          chartType: { type: 'string', enum: ['bar', 'line', 'pie'] },
          aggregation: { type: 'string', enum: ['count', 'sum', 'avg', 'min', 'max'] },
          groupBy: { type: 'string' },
        },
      },
      execute: async (args) => {
        const selection = selectionOf('chart');
        if (!selection || selection.kind !== 'chart') return failure(new Error('当前没有图表工作区内容。'));
        const next = { ...selection };
        if (args.chartType === 'bar' || args.chartType === 'line' || args.chartType === 'pie') {
          next.chartType = args.chartType;
        }
        if (
          args.aggregation === 'count' ||
          args.aggregation === 'sum' ||
          args.aggregation === 'avg' ||
          args.aggregation === 'min' ||
          args.aggregation === 'max'
        ) {
          next.aggregation = args.aggregation;
        }
        if (typeof args.groupBy === 'string') next.groupBy = args.groupBy;
        upsertSelection(next);
        recordRun({ uid, toolName: 'apply_chart_config', decision: 'applied', at: new Date().toISOString() });
        return success({ applied: true, chartType: next.chartType, aggregation: next.aggregation });
      },
    },
  ];
}

function datasourceToolDefinitions(uid: string): ContextToolDefinition[] {
  return [
    {
      name: 'preview_datasource_records',
      title: '读取数据范围预览',
      description: '按当前数据范围读取一小段记录（只读，最多 50 条）。',
      permission: 'ALLOW',
      inputSchema: {
        type: 'object',
        properties: { limit: { type: 'number', description: '最多返回多少条，默认 5' } },
      },
      execute: async (args) => {
        const selections = getSelections();
        const selection =
          selections.find(
            (item): item is Extract<ContextSelection, { kind: 'datasource' }> =>
              item.kind === 'datasource' && item.uid === uid,
          ) ??
          selections.find(
            (item): item is Extract<ContextSelection, { kind: 'record' }> =>
              item.kind === 'record' && item.uid === uid,
          ) ??
          null;
        if (!selection) return failure(new Error('当前没有数据范围内容。'));
        const query: DatasourceQueryContent =
          selection.kind === 'datasource'
            ? {
                datasource: selection.datasource,
                collectionName: selection.collectionName,
                fields: selection.fields,
                filter: toServerFilter(selection.filter) ?? null,
                sort: selection.sort,
                limit: selection.limit,
              }
            : {
                datasource: selection.datasource,
                collectionName: selection.collectionName,
                fields: selection.fields,
                filter: { [selection.primaryKey]: { $eq: selection.recordId } },
                sort: null,
                limit: 1,
              };
        const requested = typeof args.limit === 'number' && Number.isFinite(args.limit) ? args.limit : 5;
        const content = await readRecords(query, requested);
        recordRun({ uid, toolName: 'preview_datasource_records', decision: 'read', at: new Date().toISOString() });
        return success(content);
      },
    },
  ];
}

/** 某类上下文在宿主里真实可执行的前端工具。 */
export function contextToolDefinitions(kind: ContextKind, uid: string): ContextToolDefinition[] {
  switch (kind) {
    case 'datasource':
    case 'record':
      return datasourceToolDefinitions(uid);
    case 'code':
      return codeToolDefinitions(uid);
    case 'chart':
      return chartToolDefinitions(uid);
  }
}

/**
 * 把某一项的工具体注册进**真实**的 `FrontendToolRegistry`
 * （`app.pm.get('ai').aiManager.frontendTools`，`manager/frontend-tool-registry.ts`）。
 *
 * 先 `clear(uid)` 再注册：同一个 uid 在重新进入会话时不能残留旧定义
 * （上游 `runjs/registerAIEmployeeRunJSFacade.ts:109-115` 也是这个次序）。
 */
export function registerContextTools(registry: FrontendToolRegistryLike, kind: ContextKind, uid: string): void {
  registry.clear?.(uid);
  for (const definition of contextToolDefinitions(kind, uid)) {
    registry.register(uid, {
      name: definition.name,
      title: definition.title,
      description: definition.description,
      permission: definition.permission,
      inputSchema: definition.inputSchema,
      execute: (args) => definition.execute(isRecord(args) ? args : {}),
    });
  }
}

/** 注册后取回真实 manifest 列表（`ContextItem.frontendTools` 的来源）。 */
export function listContextToolManifests(
  registry: FrontendToolRegistryLike,
  uid: string,
): WorkContextItem['frontendTools'] {
  const manifests = registry.list?.(uid) ?? [];
  return manifests as WorkContextItem['frontendTools'];
}

/**
 * 由**同一份定义**推出的 manifest（不经过 app 实例）。
 *
 * 用途：产品页（AI-04 工作区）与会话页是两个路由，前者没有原生宿主实例；
 * 而它展示的"这一项会带上哪些工具"必须与宿主注册进真实 registry 的结果一致。
 * `./context-tools.test.ts` 断言这里的结果与真实 `FrontendToolRegistry.list(uid)` 完全相等，
 * 因此不存在两份会漂移的 manifest 定义。
 */
export function contextToolManifests(kind: ContextKind, uid: string): NonNullable<WorkContextItem['frontendTools']> {
  return contextToolDefinitions(kind, uid).map((definition) => ({
    id: `${uid}:${definition.name}`,
    blockUid: uid,
    name: definition.name,
    title: definition.title,
    description: definition.description,
    permission: definition.permission,
    inputSchema: definition.inputSchema,
  }));
}

/**
 * 产品侧运行器：工作区界面用「预览 / 应用」按钮走**同一份**工具定义，
 * 因此界面与原生 ChatBox 的工具执行不会出现两套行为。
 */
export async function runContextTool(
  kind: ContextKind,
  uid: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ status: 'success' | 'error'; content: unknown }> {
  const definition = contextToolDefinitions(kind, uid).find((item) => item.name === name);
  if (!definition) return { status: 'error', content: `没有名为 ${name} 的上下文工具。` };
  try {
    const result = await definition.execute(args);
    return isRecord(result) && (result.status === 'success' || result.status === 'error')
      ? (result as { status: 'success' | 'error'; content: unknown })
      : { status: 'success', content: result };
  } catch (error) {
    return failure(error);
  }
}

/** 界面上「拒绝」：只结算提案，不触碰任何工作区数据。 */
export function rejectProposal(id: string): void {
  settleProposal(id, 'rejected');
}

const ALL_KINDS: ContextKind[] = ['datasource', 'record', 'code', 'chart'];

/**
 * 由工具 id（`<uid>:<name>`）反查我们自己的工具定义，用于把原生工具卡片写成中文。
 *
 * 找不到时返回 null：调用方给出中性的通用说明，不显示内部 id 给普通用户。
 */
export function describeContextTool(
  toolId: string,
): { uid: string; name: string; title: string; kind: ContextKind; permission: 'ASK' | 'ALLOW' } | null {
  const colon = toolId.lastIndexOf(':');
  if (colon <= 0) return null;
  const uid = toolId.slice(0, colon);
  const name = toolId.slice(colon + 1);
  for (const kind of ALL_KINDS) {
    const definition = contextToolDefinitions(kind, uid).find((item) => item.name === name);
    if (definition) {
      return { uid, name, title: definition.title, kind, permission: definition.permission };
    }
  }
  return null;
}
