import { afterEach, describe, expect, it } from 'vitest';
import type { AxiosRequestConfig } from 'axios';
import { api, getHttpClient, setTransportMode } from '../../../src/api/client';
import {
  createContextDatasource,
  createEmployee,
  createMcpClient,
  destroyContextDatasource,
  listConversations,
  listEmployees,
  resolveAllowedModels,
  updateContextDatasource,
  updateEmployee,
  updateMcpClient,
} from '../../../src/modules/ai/resources';
import { employeeToFormState, formStateToValues } from '../../../src/modules/ai/pages/EmployeeConfigPage';
import { filterEmployeesByKeyword, redactEmployee } from '../../../src/modules/ai/pages/EmployeeDirectoryPage';
import { buildWorkContext } from '../../../src/modules/ai/pages/ConversationsPage';
import { maskUrl, redactMap } from '../../../src/modules/ai/pages/McpPage';
import type { AiEmployeeRow } from '../../../src/modules/ai/types';

/**
 * AI 模块的行为与序列化验证（受控 adapter，不产生真实网络/写入）。
 *
 * 覆盖：
 *  - 「可使用 / 可管理」两条列表各自的真实请求形状；
 *  - 员工表单状态 ↔ 提交值的往返（只提交本表单管理的字段）；
 *  - 专用模型允许集解析（与后端 resolveModel 的字段语义一致）；
 *  - `messages[0].workContext` 的上下文项构造；
 *  - 各产品动作的精确父标识与请求体形状（`values` 展开为请求体本身）；
 *  - 密钥遮蔽。
 */

const captured: AxiosRequestConfig[] = [];

function respondWith(data: unknown) {
  const client = getHttpClient();
  client.defaults.adapter = async (config) => {
    captured.push(config);
    return { data, status: 200, statusText: '200', headers: {}, config };
  };
}

afterEach(() => {
  captured.length = 0;
  setTransportMode('product');
});

describe('AI 列表请求形状', () => {
  it('可使用员工走 aiEmployees:listByUser（GET + 分页参数）', async () => {
    respondWith({ data: [], meta: { count: 0 } });
    await listEmployeesSafe();
    expect(captured[0].url).toBe('aiEmployees:listByUser');
    expect(String(captured[0].method).toLowerCase()).toBe('get');
    expect(captured[0].params).toMatchObject({ page: 1, pageSize: 12 });
  });

  it('可管理员工走 aiEmployees:list（GET）', async () => {
    respondWith({ data: [], meta: { count: 0 } });
    await listEmployees({ page: 1, pageSize: 12, sort: ['-createdAt'] });
    expect(captured[0].url).toBe('aiEmployees:list');
    expect(captured[0].params).toMatchObject({ pageSize: 12, sort: ['-createdAt'] });
  });

  it('会话列表不传 fields（13000 实测该参数会 400）', async () => {
    respondWith({ data: [], meta: {} });
    await listConversations({ page: 1, pageSize: 15, fields: ['id'], sort: ['-updatedAt'] });
    expect(captured[0].url).toBe('aiConversations:list');
    expect((captured[0].params as Record<string, unknown>).fields).toBeUndefined();
    expect(captured[0].params).toMatchObject({ page: 1, pageSize: 15 });
  });
});

async function listEmployeesSafe() {
  const { listUsableEmployees } = await import('../../../src/modules/ai/resources');
  return listUsableEmployees({ page: 1, pageSize: 12 });
}

describe('AI-01 可使用列表的本地过滤', () => {
  const rows: AiEmployeeRow[] = [
    { username: 'trade-manager', nickname: '贸易经理', position: '贸易' },
    { username: 'dev-merchandiser', nickname: '开发跟单', position: '开发' },
    { username: 'buyer', nickname: '采购', position: '采购' },
  ];

  it('按用户名 / 昵称 / 岗位任一命中，大小写不敏感', () => {
    expect(filterEmployeesByKeyword(rows, 'TRADE').map((row) => row.username)).toEqual(['trade-manager']);
    expect(filterEmployeesByKeyword(rows, '跟单').map((row) => row.username)).toEqual(['dev-merchandiser']);
    expect(filterEmployeesByKeyword(rows, '采购').map((row) => row.username)).toEqual(['buyer']);
  });

  it('空关键词原样返回；无命中返回空数组（不是全部）', () => {
    expect(filterEmployeesByKeyword(rows, '   ')).toHaveLength(3);
    expect(filterEmployeesByKeyword(rows, '不存在的人')).toEqual([]);
  });
});

describe('AI 受控写入形状（不发真实写入）', () => {
  it('员工启停：POST aiEmployees:update + filterByTk=username + body 就是 values', async () => {
    respondWith({ data: { username: 'assistant-01', enabled: false } });
    await updateEmployee('assistant-01', { enabled: false });
    const request = captured[0];
    expect(String(request.method).toLowerCase()).toBe('post');
    expect(request.url).toBe('aiEmployees:update');
    expect(request.params).toMatchObject({ filterByTk: 'assistant-01' });
    expect(typeof request.data === 'string' ? JSON.parse(request.data) : request.data).toEqual({ enabled: false });
  });

  it('新建员工：POST aiEmployees:create + 请求体不含 values 包装', async () => {
    respondWith({ data: { username: 'assistant-02' } });
    await createEmployee({ username: 'assistant-02', enabled: true, builtIn: false });
    const request = captured[0];
    expect(request.url).toBe('aiEmployees:create');
    expect(typeof request.data === 'string' ? JSON.parse(request.data) : request.data).toEqual({
      username: 'assistant-02',
      enabled: true,
      builtIn: false,
    });
  });

  it('上下文数据源 CRUD：精确父标识 filterByTk', async () => {
    respondWith({ data: { id: 'ctx-1' } });
    await createContextDatasource({ title: '本月订单', collectionName: 'orders' });
    expect(captured[0].url).toBe('aiContextDatasources:create');
    expect(typeof captured[0].data === 'string' ? JSON.parse(captured[0].data) : captured[0].data).toMatchObject({
      title: '本月订单',
      collectionName: 'orders',
    });

    respondWith({ data: { id: 'ctx-1' } });
    await updateContextDatasource('ctx-1', { title: '改名' });
    expect(captured[1].url).toBe('aiContextDatasources:update');
    expect(captured[1].params).toMatchObject({ filterByTk: 'ctx-1' });

    respondWith({ data: true });
    await destroyContextDatasource('ctx-1');
    expect(captured[2].url).toBe('aiContextDatasources:destroy');
    expect(captured[2].params).toMatchObject({ filterByTk: 'ctx-1' });
  });

  it('MCP 连接：POST create/update，身份模板原样提交', async () => {
    respondWith({ data: { name: 'docs' } });
    const values = {
      name: 'docs',
      transport: 'http',
      useUserContext: true,
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer {{ request.token }}' },
    };
    await createMcpClient(values);
    expect(captured[0].url).toBe('aiMcpClients:create');
    expect(typeof captured[0].data === 'string' ? JSON.parse(captured[0].data) : captured[0].data).toEqual(values);

    respondWith({ data: { name: 'docs' } });
    await updateMcpClient('docs', { enabled: false });
    expect(captured[1].url).toBe('aiMcpClients:update');
    expect(captured[1].params).toMatchObject({ filterByTk: 'docs' });
  });

  it('工具确认：POST aiConversations:updateUserDecision，body 含 sessionId/messageId/toolCallId/userDecision', async () => {
    respondWith({ data: { updated: 1, toolCalls: [] } });
    await api.resourceAction('aiConversations', 'updateUserDecision', {
      values: { sessionId: 's-1', messageId: 'm-1', toolCallId: 't-1', userDecision: { type: 'approve' } },
    });
    expect(captured[0].url).toBe('aiConversations:updateUserDecision');
    expect(typeof captured[0].data === 'string' ? JSON.parse(captured[0].data) : captured[0].data).toEqual({
      sessionId: 's-1',
      messageId: 'm-1',
      toolCallId: 't-1',
      userDecision: { type: 'approve' },
    });
  });
});

describe('员工表单状态与允许集', () => {
  const employee: AiEmployeeRow = {
    username: 'assistant-01',
    nickname: '助理一号',
    position: '客服',
    enabled: true,
    builtIn: true,
    category: 'business',
    bio: '负责答疑',
    about: '',
    avatar: 'nocobase-015-male',
    defaultPrompt: '你是客服',
    greeting: '你好',
    skillSettings: { skills: ['faq'], tools: [{ name: 'search', autoCall: true }] },
    modelSettings: { enabled: true, llmService: 'deepseek-main', model: 'deepseek-chat' },
    dataSourceSettings: { collections: [{ collection: 'main:orders' }] },
  };

  it('记录 → 表单状态 → 提交值，模型允许集与首选保持第一位', () => {
    const state = employeeToFormState(employee);
    expect(state.modelEnabled).toBe(true);
    expect(state.modelList).toEqual([{ llmService: 'deepseek-main', model: 'deepseek-chat' }]);
    const values = formStateToValues(state);
    expect(values.modelSettings).toMatchObject({
      enabled: true,
      llmService: 'deepseek-main',
      model: 'deepseek-chat',
      models: [{ llmService: 'deepseek-main', model: 'deepseek-chat' }],
    });
    expect(values.skillSettings).toEqual({ skills: ['faq'], tools: [{ name: 'search', autoCall: true }] });
    expect(values.dataSourceSettings).toEqual({ collections: [{ collection: 'main:orders' }] });
    // 只提交本表单管理的字段，不整体替换记录。
    expect(Object.keys(values).sort()).toEqual(
      [
        'about',
        'avatar',
        'bio',
        'category',
        'dataSourceSettings',
        'defaultPrompt',
        'deprecated',
        'enabled',
        'greeting',
        'modelSettings',
        'nickname',
        'position',
        'skillSettings',
      ].sort(),
    );
  });

  it('允许集解析：未启用限制 / 空允许集 / 多条允许集', () => {
    expect(resolveAllowedModels({ modelSettings: { enabled: false, model: 'x' } })).toEqual({
      enforced: false,
      models: [],
      preferred: null,
    });
    expect(resolveAllowedModels({ modelSettings: { enabled: true, models: [] } })).toEqual({
      enforced: true,
      models: [],
      preferred: null,
    });
    const multi = resolveAllowedModels({
      modelSettings: {
        enabled: true,
        models: [
          { llmService: 'a', model: 'm1' },
          { llmService: 'b', model: 'm2' },
          { llmService: '', model: 'bad' },
        ],
      },
    });
    expect(multi.enforced).toBe(true);
    expect(multi.models).toEqual([
      { llmService: 'a', model: 'm1' },
      { llmService: 'b', model: 'm2' },
    ]);
    expect(multi.preferred).toEqual({ llmService: 'a', model: 'm1' });
  });

  it('只读预览会隐藏可能的凭据键', () => {
    const redacted = redactEmployee({ username: 'x', apiKey: 'sk-real', nested: { token: 't' } } as AiEmployeeRow);
    expect(redacted.apiKey).toBe('（已隐藏）');
    expect(redacted.username).toBe('x');
  });
});

describe('AI-04 上下文随消息数组元素发送', () => {
  it('buildWorkContext 从已保存记录构造 messages[0].workContext 项', async () => {
    const record = {
      id: 'ctx-1',
      title: '本月订单',
      description: '',
      datasource: 'main',
      collectionName: 'orders',
      fields: ['id', 'amount'],
      filter: { createdAt: { $dateOn: 'today' } },
      sort: ['-createdAt'],
      limit: 20,
      enabled: true,
    };
    respondWith({ data: record });
    const items = await buildWorkContext(['ctx-1']);
    expect(captured[0].url).toBe('aiContextDatasources:get');
    expect(captured[0].params).toMatchObject({ filterByTk: 'ctx-1' });
    expect(items).toEqual([
      {
        type: 'datasource',
        uid: 'ctx-1',
        title: '本月订单',
        content: {
          datasource: 'main',
          collectionName: 'orders',
          fields: ['id', 'amount'],
          filter: { createdAt: { $dateOn: 'today' } },
          sort: ['-createdAt'],
          limit: 20,
        },
      },
    ]);
  });

  it('没有选择上下文时不发送额外请求', async () => {
    respondWith({ data: null });
    const items = await buildWorkContext([]);
    expect(items).toEqual([]);
    expect(captured).toHaveLength(0);
  });
});

describe('MCP 配置的脱敏展示', () => {
  it('令牌类键默认遮蔽，显式显示后才返回原文', () => {
    const headers = { Authorization: 'Bearer abc', 'X-Role': 'member' };
    expect(redactMap(headers, false)).toEqual({ Authorization: '（已隐藏）', 'X-Role': 'member' });
    expect(redactMap(headers, true)).toEqual(headers);
  });

  it('URL 查询串不展示（可能含令牌）', () => {
    expect(maskUrl('https://mcp.example.com/mcp?token=abc')).toBe('https://mcp.example.com/mcp?（已隐藏查询参数）');
    expect(maskUrl('https://mcp.example.com/mcp')).toBe('https://mcp.example.com/mcp');
  });
});
