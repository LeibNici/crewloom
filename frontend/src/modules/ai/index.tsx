import { accessCheck, defineModule } from '../types';
import { ModuleHub } from './ModuleHub';
import { EmployeeDirectoryPage } from './pages/EmployeeDirectoryPage';
import { EmployeeConfigPage } from './pages/EmployeeConfigPage';
import { ConversationsPage } from './pages/ConversationsPage';
import { ContextPage } from './pages/ContextPage';
import { ToolsPage } from './pages/ToolsPage';
import { McpPage } from './pages/McpPage';
import { KnowledgePage } from './pages/KnowledgePage';

/**
 * 数字员工模块（AI-01 … AI-06）——**组 A（AI + LM）独占文件**。
 *
 * 权限来源（固定源码 `plugin-ai/src/server/plugin.ts:285-320`）：
 *  - `aiEmployees:listByUser` / `aiConversations:*` / `aiTools:list` / `aiSkills:list` = `loggedIn`；
 *  - `aiEmployees:*`（含 list/get/create/update）、`aiContextDatasources:create|update|destroy` =
 *    片段 `pm.ai.ai-employees`；
 *  - `aiMcpClients:*` = 片段 `pm.ai.mcp-settings`；
 *  - `aiSettings:*` = 片段 `pm.ai.ai-settings`；`ai:*` / `llmServices:*` = 片段 `pm.ai.llm-services`。
 *
 * 页面入口与按钮的可用性同时参考声明式权限与后端真实返回：后端始终是最终判定者，
 * 页面里的列表/详情一律按真实请求的六态渲染（无权限、空数据、失败分开表达）。
 *
 * 2.2.20 实测实现约束（写实现前先读，报告 02 §8）：
 *  - **D1** `aiConversations` 列表项没有 `id`，标识是 `sessionId`；
 *  - **D2** `aiConversations:list` 不要传 `fields`（实测 400）；
 *  - **D4** 插件集合读不到 `collections:get` schema，字段清单按固定源码定义，不用响应键推全量。
 */
export const aiModule = defineModule({
  id: 'ai',
  title: '数字员工',
  path: '/ai',
  subtitle: '员工、会话与能力配置',
  access: accessCheck('ai.use', '查看可使用员工', 'aiEmployees', 'listByUser'),
  probeId: 'ai.use',
  IndexComponent: ModuleHub,
  boards: [
    /* ------------------------------- AI-01 员工目录 ------------------------------- */
    {
      path: 'directory',
      title: '员工目录',
      description: '查看可使用与可管理的员工，支持筛选、分页、详情与启停。',
      access: accessCheck('ai.directory', '查看员工目录', 'aiEmployees', 'listByUser'),
      probeId: 'ai.use',
      endpoints: ['aiEmployees:listByUser', 'aiEmployees:list', 'aiEmployees:get', 'aiEmployees:update'],
      Component: EmployeeDirectoryPage,
    },
    {
      path: 'directory/:username',
      title: '员工详情',
      description: '某位员工的资料、能力概览与启停状态。',
      access: accessCheck('ai.directory.detail', '查看员工详情', 'aiEmployees', 'get'),
      probeId: 'ai.use',
      endpoints: ['aiEmployees:get', 'aiEmployees:update'],
      Component: EmployeeDirectoryPage,
    },

    /* ------------------------------- AI-02 员工配置 ------------------------------- */
    {
      path: 'employees-config',
      title: '员工配置',
      description: '新建与编辑员工资料、提示词、专用模型允许集、技能工具与数据范围。',
      access: accessCheck('ai.employees.config', '查看员工配置', 'aiEmployees', 'list'),
      probeId: 'ai.directory',
      endpoints: [
        'aiEmployees:list',
        'aiEmployees:get',
        'aiEmployees:create',
        'aiEmployees:update',
        'aiTools:list',
        'aiSkills:list',
      ],
      Component: EmployeeConfigPage,
    },
    {
      path: 'employees-config/:username',
      title: '员工配置详情',
      description: '编辑某位员工的完整配置。',
      access: accessCheck('ai.employees.config.detail', '编辑员工配置', 'aiEmployees', 'get'),
      probeId: 'ai.directory',
      endpoints: ['aiEmployees:get', 'aiEmployees:update'],
      Component: EmployeeConfigPage,
    },

    /* ------------------------------- AI-03 会话工作区 ------------------------------- */
    {
      path: 'conversations',
      title: '会话工作区',
      description: '历史会话、消息、实时输出、停止生成、继续接收与工具确认。',
      access: accessCheck('ai.conversations', '查看会话', 'aiConversations', 'list'),
      probeId: 'ai.conversations',
      endpoints: [
        'aiConversations:list',
        'aiConversations:getMessages',
        'aiConversations:create',
        'aiConversations:sendMessages',
        'aiConversations:resendMessages',
        'aiConversations:abort',
        'aiConversations:resumeStream',
        'aiConversations:updateUserDecision',
        'aiConversations:resumeToolCall',
      ],
      Component: ConversationsPage,
    },
    {
      path: 'conversations/:sessionId',
      title: '会话详情',
      description: '某个会话的消息与实时交互。',
      access: accessCheck('ai.conversations.detail', '查看会话详情', 'aiConversations', 'get'),
      probeId: 'ai.conversations',
      endpoints: ['aiConversations:get', 'aiConversations:getMessages'],
      Component: ConversationsPage,
    },

    /* ------------------------------- AI-04 任务与数据上下文 ------------------------------- */
    {
      path: 'context',
      title: '任务与数据上下文',
      description: '四类上下文工作区：数据范围、指定记录、代码工作内容、图表工作内容，并汇总本次会话要带上的内容。',
      access: accessCheck('ai.context', '查看上下文数据源', 'aiContextDatasources', 'list'),
      probeId: 'ai.use',
      endpoints: [
        'aiContextDatasources:list',
        'aiContextDatasources:get',
        'aiContextDatasources:preview',
        'aiContextDatasources:create',
        'aiContextDatasources:update',
        'aiContextDatasources:destroy',
        'dataSources:list',
        'collections:list',
        'collections:get',
      ],
      Component: ContextPage,
    },

    /* ------------------------------- AI-05 工具技能与 MCP ------------------------------- */
    {
      path: 'tools',
      title: '工具与技能',
      description: '查看当前可用的工具与技能，并确认员工实际绑定了哪些能力。',
      access: accessCheck('ai.tools', '查看工具与技能', 'aiTools', 'list'),
      probeId: 'ai.use',
      endpoints: ['aiTools:list', 'aiSkills:list', 'aiTools:listBinding', 'aiSkills:listBinding'],
      Component: ToolsPage,
    },
    {
      path: 'mcp',
      title: 'MCP 连接',
      description: '管理外部 MCP 连接、身份模板与调用边界。',
      access: accessCheck('ai.mcp', '查看 MCP 连接', 'aiMcpClients', 'list'),
      probeId: 'ai.directory',
      endpoints: [
        'aiMcpClients:list',
        'aiMcpClients:get',
        'aiMcpClients:create',
        'aiMcpClients:update',
        'aiMcpClients:destroy',
        'aiMcpClients:testConnection',
        'aiMcpClients:listTools',
        'aiMcpClients:rebuildClient',
        'aiMcpClients:updateToolPermission',
      ],
      Component: McpPage,
    },

    /* ------------------------------- AI-06 知识库 ------------------------------- */
    {
      path: 'knowledge',
      title: '知识库',
      description: '当前环境没有开通知识库能力；这里如实说明现状与后续入口。',
      access: accessCheck('ai.knowledge', '查看知识库', 'aiEmployees', 'listByUser'),
      probeId: 'ai.use',
      // 唯一会调用的接口：只读的集合清单，用来核实"本实例是否存在知识库相关集合"。
      // 该能力真正缺失，因此没有其它端点可登记。
      endpoints: ['collections:list'],
      Component: KnowledgePage,
    },
  ],
});
