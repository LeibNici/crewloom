/**
 * AI 模块（AI-01 … AI-06）的资源行类型。
 *
 * 字段来源分两类，**不互相冒充**：
 *  - 集合字段：来自固定的 NocoBase 2.2.22 源码集合定义
 *    （`plugin-ai/src/collections/*.ts`、`server/collections/*.ts`，报告 02 §8 的 D4 约束：
 *     插件集合读不到 `collections:get` schema，因此这里按源码定义声明，不用响应键反推全量字段）；
 *  - 运行期可选：标为 `?` 的字段在 13000 上可能存在也可能为空，界面只展示拿到的值。
 *
 * 所有类型都允许后端返回额外键，页面不得因未知键报错。
 */

export interface AiEmployeeRow {
  username: string;
  nickname?: string | null;
  position?: string | null;
  avatar?: string | null;
  bio?: string | null;
  about?: string | null;
  defaultPrompt?: string | null;
  greeting?: string | null;
  chatSettings?: Record<string, unknown> | null;
  skillSettings?: AiSkillSettings | null;
  modelSettings?: AiModelSettings | null;
  dataSourceSettings?: AiDataSourceSettings | null;
  enableKnowledgeBase?: boolean | null;
  knowledgeBasePrompt?: string | null;
  knowledgeBase?: Record<string, unknown> | null;
  enabled?: boolean | null;
  builtIn?: boolean | null;
  category?: string | null;
  deprecated?: boolean | null;
  [key: string]: unknown;
}

export interface AiModelSettings {
  enabled?: boolean;
  llmService?: string;
  model?: string;
  models?: Array<{ llmService?: string; model?: string }>;
  [key: string]: unknown;
}

export interface AiSkillSettings {
  toolsVersion?: number;
  skillsVersion?: number;
  tools?: Array<{ name: string; autoCall?: boolean }>;
  skills?: string[];
  [key: string]: unknown;
}

export interface AiDataSourceSettings {
  collections?: Array<{ collection?: string }>;
  [key: string]: unknown;
}

export interface AiToolRow {
  scope?: string | null;
  from?: string | null;
  execution?: string | null;
  defaultPermission?: string | null;
  silence?: boolean | null;
  introduction?: { title?: string | null; about?: string | null } | null;
  definition?: { name?: string | null; description?: string | null } | null;
  [key: string]: unknown;
}

export interface AiSkillRow {
  name: string;
  title?: string | null;
  description?: string | null;
  scope?: string | null;
  tools?: unknown;
  [key: string]: unknown;
}

/** `aiConversations:list` 的列表项：**没有 `id`**，标识是 `sessionId`（报告 02 §8 的 C1/D1）。 */
export interface AiConversationRow {
  sessionId: string;
  title?: string | null;
  aiEmployeeUsername?: string | null;
  category?: string | null;
  llmActiveState?: string | null;
  read?: boolean | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  options?: Record<string, unknown> | null;
  [key: string]: unknown;
}

/** `aiConversations:getMessages?sessionId=` 返回的一条消息（源码集合 `aiMessages`）。 */
export interface AiMessageRow {
  messageId: number | string;
  role?: string | null;
  content?: unknown;
  toolCalls?: unknown;
  attachments?: unknown;
  workContext?: unknown;
  metadata?: unknown;
  createdAt?: string | null;
  updatedAt?: string | null;
  [key: string]: unknown;
}

/** `aiContextDatasources` 记录（源码集合 `ai-context-datasource.ts`）。 */
export interface AiContextDatasourceRow {
  id: string;
  title: string;
  description?: string | null;
  datasource: string;
  collectionName: string;
  fields?: unknown;
  filter?: unknown;
  sort?: unknown;
  limit?: number | null;
  enabled?: boolean | null;
  [key: string]: unknown;
}

/** `aiMcpClients` 记录（源码集合 `ai-mcp-clients.ts` + `core/ai` 的 MCPOptions）。 */
export interface AiMcpClientRow {
  name: string;
  title?: string | null;
  description?: string | null;
  enabled?: boolean | null;
  transport?: string | null;
  useUserContext?: boolean | null;
  command?: string | null;
  args?: unknown;
  env?: unknown;
  url?: string | null;
  headers?: unknown;
  restart?: unknown;
  [key: string]: unknown;
}

export interface McpToolEntry {
  name: string;
  title?: string | null;
  description?: string | null;
  serverName?: string | null;
  permission?: string | null;
  [key: string]: unknown;
}

export interface McpTestResult {
  success?: boolean;
  message?: string | null;
  error?: string | null;
  details?: unknown;
  toolsCount?: number | null;
  tools?: McpToolEntry[] | null;
  toolsTruncated?: boolean | null;
  [key: string]: unknown;
}

/** AI-05 的 transport 取值（源码 `core/ai/src/mcp-manager/types.ts`）。 */
export const MCP_TRANSPORTS = ['http', 'sse', 'stdio'] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

/** 员工分类取值（源码集合注释：business / developer）。 */
export const EMPLOYEE_CATEGORIES = [
  { value: 'business', label: '业务员工' },
  { value: 'developer', label: '开发者员工' },
];
