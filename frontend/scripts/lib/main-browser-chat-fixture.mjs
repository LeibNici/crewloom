/**
 * 电脑端聊天验收环境：**本机合成后端的数据与应答层**（端口 5404，纯本机，不外呼）。
 *
 * 定位与边界（硬约束）：
 *  - 这是 `scripts/main-browser-chat-server.mjs` 的"最后一层本机应答"：只处理**聊天环境特有的**
 *    元数据（员工 / 工具 / 模型服务配置 / 数据源 / 集合 / 记录 / AI 任务）；
 *  - 登录、令牌世代、角色、应用壳元数据、人工待办（TD-02）继续复用
 *    `scripts/lib/manual-fixture.mjs` 的 `respondFixture()`（不重写第二套认证）；
 *  - AI 会话的流式/工具/附件/上下文记录复用 `scripts/lib/controlled-ai-middleware.mjs`；
 *  - 本文件**不做任何网络请求**，未覆盖的动作由服务器层返回本机 501/403，绝不回退真实 13000；
 *  - 全部为**合成数据**：合成员工/工具/模型服务/集合/记录/账号，不含真实业务名称、真实凭据、
 *    真实业务数据。模型服务只返回**配置**，不提供任何推理或模型发现。
 *
 * 与真实 2.2.22 契约对齐的关键字段来源（行号相对 frontend/）：
 *  - `ai:listAllEnabledModels` → `LLMServiceItem{llmService,llmServiceTitle,provider?,enabledModels[]}`
 *    （`vendor/.../plugin-ai/src/client-v2/repositories/AIConfigRepository.ts:22-31,279-292`）；
 *  - `aiConversations:unreadCounts` → `data:{conversationUnreadCount,workflowTaskUnreadCount}`
 *    （`vendor/.../chatbox/hooks/useChatConversationActions.ts:80-85`）；
 *  - `aiEmployees:listByUser|list` 行必须含 `username`（`AIConfigRepository.ts:76-78`）；
 *  - `aiTools:list` 行必须含 `definition.name`（`AIConfigRepository.ts:80-84`）；
 *  - 上下文工作区读 `dataSources:list` / `collections:list` / `collections:get` / `<collection>:list`
 *    （`src/modules/ai/context/schema.ts:29-99`）；
 *  - TD-03 读 `aiWorkflowTasks:list|getBySession|accept|reject`（`src/modules/tasks/domain.ts:185-210`；
 *    `src/modules/tasks/pages/AiTaskPage.tsx:116-199`）。
 */

/* ------------------------------------------------------------------ *
 * 合成角色（两种测试角色；不含任何真实 13000 角色名）
 * ------------------------------------------------------------------ */

export const CHAT_ROLE_ALPHA = 'synth-operator';
export const CHAT_ROLE_BETA = 'synth-reviewer';
/** 原生 LocalePlugin 等匿名调用会带 `X-Role: anonymous`（vendor LocalePlugin.ts:21-48）。 */
export const ANONYMOUS_ROLE = 'anonymous';

export const CHAT_ROLES = [
  { name: CHAT_ROLE_ALPHA, title: '合成角色·操作员', default: true, hidden: false },
  { name: CHAT_ROLE_BETA, title: '合成角色·复核员', default: false, hidden: false },
];

const ROLE_NAMES = new Set([...CHAT_ROLES.map((role) => role.name), ANONYMOUS_ROLE, 'root', '__union__']);

/* ------------------------------------------------------------------ *
 * 合成元数据
 * ------------------------------------------------------------------ */

/** 关联字段候选（与 TD-02 同一份合成用户：张三 3 / 李四 7）。 */
export const SYNTH_USERS = [
  { id: 3, nickname: '张三（合成）', email: 'zhangsan@fixture.local' },
  { id: 7, nickname: '李四（合成）', email: 'lisi@fixture.local' },
];

/** 合成 AI 员工：**没有真实 13000 员工名**。 */
export const SYNTH_EMPLOYEES = [
  {
    username: 'synth-analyst',
    nickname: '合成分析员',
    position: '本机合成样本',
    bio: '本机合成员工，仅用于电脑端验收环境，不连接任何真实模型。',
    greeting: '你好，我是本机合成分析员。',
    enabled: true,
    builtIn: false,
    category: 'synthetic',
    modelSettings: { enabled: true, llmService: 'synth-llm-config', model: 'synth-model-a' },
    chatSettings: {},
    skillSettings: {},
    dataSourceSettings: {},
    enableKnowledgeBase: false,
  },
  {
    username: 'synth-drafter',
    nickname: '合成文案员',
    position: '本机合成样本',
    bio: '本机合成员工（第二个），用于验证员工切换。',
    greeting: '你好，我是本机合成文案员。',
    enabled: true,
    builtIn: false,
    category: 'synthetic',
    modelSettings: { enabled: true, llmService: 'synth-llm-config', model: 'synth-model-b' },
    chatSettings: {},
    skillSettings: {},
    dataSourceSettings: {},
    enableKnowledgeBase: false,
  },
];

/** `ai:listAllEnabledModels`：只回**配置**（本机合成模型），不回任何真实提供方。 */
export const SYNTH_ENABLED_MODELS = [
  {
    llmService: 'synth-llm-config',
    llmServiceTitle: '合成模型服务（本机·仅配置）',
    provider: 'synth-provider',
    providerTitle: '本机合成提供方',
    enabledModels: [
      { label: '合成模型 A（本机，不推理）', value: 'synth-model-a' },
      { label: '合成模型 B（本机，不推理）', value: 'synth-model-b' },
    ],
    supportWebSearch: false,
    webSearchModels: [],
    isToolConflict: false,
  },
];

/** `llmServices:list`：模型服务的**配置行**（不触发任何推理/发现）。 */
export const SYNTH_LLM_SERVICES = [
  {
    name: 'synth-llm-config',
    title: '合成模型服务（本机·仅配置）',
    provider: 'synth-provider',
    enabled: true,
    isDefault: true,
    supportedModelTypes: ['LLM'],
    options: { baseURL: 'http://127.0.0.1:5404/__local/never-called' },
  },
];

/** `aiTools:list` 行必须含 `definition.name`（`AIConfigRepository.ts:80-84`）。 */
export const SYNTH_TOOLS = [
  {
    definition: {
      name: 'executeFrontendTool',
      title: '执行前端工具',
      description: '原生内置执行器（由真实 FrontendToolRegistry 承担实际执行）。',
      schema: { type: 'object', properties: { toolId: { type: 'string' }, args: { type: 'object' } } },
    },
    source: 'builtin',
  },
  {
    definition: {
      name: 'synth_lookup',
      title: '合成查询工具（本机样本）',
      description: '本机合成工具，仅用于展示工具清单，不连接任何真实系统。',
      schema: { type: 'object', properties: { keyword: { type: 'string' } } },
    },
    source: 'synthetic',
  },
];

/** 数据源：`main` + 一个合成数据源（上下文工作区可选可配置数据源）。 */
export const SYNTH_DATASOURCES = [
  { key: 'main', name: 'main', displayName: '主数据源（合成）', type: 'main', enabled: true, isDefault: true },
  {
    key: 'synth_ops',
    name: 'synth_ops',
    displayName: '合成运营数据源（本机样本）',
    type: 'synthetic',
    enabled: true,
    options: { localOnly: true },
  },
];

const field = (name, type, interfaceName, title, extra = {}) => ({
  name,
  type,
  interface: interfaceName,
  title,
  ...extra,
});

/**
 * 合成集合（含 TD-02 关联字段所需的 `expenses.reviewers`，保持人工表单链路可用）。
 * 主键统一 `id`（bigInt/autoIncrement），供上下文工作区的记录选择使用。
 */
export const SYNTH_COLLECTIONS = [
  {
    name: 'expenses',
    title: '报销单（合成）',
    primaryKey: 'id',
    dataSourceKey: 'main',
    fields: [
      field('id', 'bigInt', 'integer', 'ID', { primaryKey: true, autoIncrement: true }),
      field('amount', 'double', 'number', '报销金额'),
      field('spentAt', 'date', 'date', '发生日期', { dateFormat: 'YYYY-MM-DD' }),
      field('category', 'string', 'select', '类别'),
      field('code', 'string', 'input', '报销编号'),
      field('urgent', 'boolean', 'checkbox', '是否加急'),
      field('reason', 'string', 'input', '加急原因'),
      {
        name: 'reviewers',
        type: 'belongsToMany',
        interface: 'm2m',
        title: '会签人',
        target: 'users',
        targetKey: 'id',
        sourceKey: 'id',
        uiSchema: {
          title: '会签人',
          'x-component': 'AssociationField',
          'x-component-props': { multiple: true, fieldNames: { label: 'nickname', value: 'id' } },
        },
      },
    ],
  },
  {
    name: 'users',
    title: '用户（合成）',
    titleField: 'nickname',
    primaryKey: 'id',
    dataSourceKey: 'main',
    fields: [
      field('id', 'bigInt', 'integer', 'ID', { primaryKey: true, autoIncrement: true }),
      field('nickname', 'string', 'input', '昵称'),
      field('email', 'string', 'email', '邮箱'),
    ],
  },
  {
    name: 'synth_tickets',
    title: '合成工单（主数据源）',
    primaryKey: 'id',
    dataSourceKey: 'main',
    fields: [
      field('id', 'bigInt', 'integer', 'ID', { primaryKey: true, autoIncrement: true }),
      field('subject', 'string', 'input', '主题'),
      field('status', 'string', 'select', '状态'),
      field('priority', 'string', 'select', '优先级'),
      field('createdAt', 'date', 'datetime', '创建时间'),
    ],
  },
  {
    name: 'synth_orders',
    title: '合成订单（合成运营数据源）',
    primaryKey: 'id',
    dataSourceKey: 'synth_ops',
    fields: [
      field('id', 'bigInt', 'integer', 'ID', { primaryKey: true, autoIncrement: true }),
      field('orderNo', 'string', 'input', '订单号'),
      field('amount', 'double', 'number', '金额'),
      field('region', 'string', 'select', '区域'),
    ],
  },
];

/** 合成记录（完全虚构，不含真实业务名称/数据）。 */
export const SYNTH_RECORDS = {
  expenses: [
    { id: 1, amount: 128, spentAt: '2026-10-01', category: 'meal', code: 'M-001', urgent: false, reason: null },
    { id: 2, amount: 256, spentAt: '2026-10-11', category: 'travel', code: 'T-100', urgent: true, reason: '合成样本' },
  ],
  users: SYNTH_USERS,
  synth_tickets: [
    { id: 1, subject: '合成工单·登录页文案', status: 'open', priority: 'high', createdAt: '2026-10-10T02:00:00.000Z' },
    { id: 2, subject: '合成工单·报表字段', status: 'pending', priority: 'low', createdAt: '2026-10-11T03:30:00.000Z' },
  ],
  synth_orders: [
    { id: 1, orderNo: 'SYN-2026-0001', amount: 88.5, region: 'north' },
    { id: 2, orderNo: 'SYN-2026-0002', amount: 199.0, region: 'south' },
  ],
};

/* ------------------------------------------------------------------ *
 * 状态
 * ------------------------------------------------------------------ */

/** TD-03 任务状态取值（与真实服务端字符串一致）。 */
export const TD03_STATUS = {
  pendingAcceptance: 'pending_acceptance',
  pendingApproval: 'pending_approval',
  rejected: 'rejected',
};

export function createChatState(overrides = {}) {
  return {
    /** 会话世代（令牌世代，来自 manual-fixture；这里镜像用于控制页显示）。 */
    roleEpoch: 1,
    /** 最近一次有效角色（控制页显示 + 角色世代隔离判定）。 */
    activeRole: CHAT_ROLE_ALPHA,
    /** 本机请求记录（含角色 / 角色世代 / 会话世代），供控制页可见核对。 */
    requests: [],
    /** 本机拒绝的外呼/写动作（deny 列表命中）。 */
    denied: [],
    /** 未支持而被本机 501 的 action（不外呼）。 */
    unsupported: [],
    /** 上传落盘的合成附件（filename → { buffer, sha256, bytes, contentType, at }）。 */
    uploads: new Map(),
    /**
     * 失败注入（控制页可见开关）：
     *  - mode: 'role'    → 401 ROLE_NOT_FOUND_FOR_USER（角色失效，不踢登录）
     *  - mode: 'session' → 401 EXPIRED_TOKEN（会话失效，需要重新登录）
     *  - action 为空表示对下一次任意 `/api` 请求生效（默认作用于控制页选定的动作）。
     */
    inject: { action: null, mode: null, remaining: 0, note: null },
    /** 角色世代写保护：旧世代角色下的工具决定/续跑在本机被拒绝并记录（默认开启）。 */
    roleEpochGuard: true,
    /** TD-03 受控任务状态。 */
    td03: {
      /** 由 controlled-ai-middleware 真实创建的会话 id（播种后写入）。 */
      sessionId: null,
      taskId: 'synth-ai-task-1',
      status: TD03_STATUS.pendingAcceptance,
      acceptedUserId: null,
      /** 播种时带入的真实 `code-editor` block uid（控制页可见；空表示默认 controlled uid）。 */
      codeBlockUid: null,
      acceptCount: 0,
      rejectCount: 0,
      decisionCount: 0,
      resumeCount: 0,
      lastDecision: null,
      lastResumeToolCallResults: null,
      history: [],
      seededAt: null,
    },
    ...overrides,
  };
}

export function resetChatState(state) {
  state.requests = [];
  state.denied = [];
  state.unsupported = [];
  state.uploads = new Map();
  state.inject = { action: null, mode: null, remaining: 0, note: null };
  state.td03 = {
    sessionId: null,
    taskId: 'synth-ai-task-1',
    status: TD03_STATUS.pendingAcceptance,
    acceptedUserId: null,
    codeBlockUid: null,
    acceptCount: 0,
    rejectCount: 0,
    decisionCount: 0,
    resumeCount: 0,
    lastDecision: null,
    lastResumeToolCallResults: null,
    history: [],
    seededAt: null,
  };
  return state;
}

/* ------------------------------------------------------------------ *
 * 工具函数
 * ------------------------------------------------------------------ */

const json = (data, meta) => (meta === undefined ? { data } : { data, meta });

export const ok = (data, meta) => ({ code: 200, body: json(data, meta) });

const fail = (code, errorCode, message) => ({ code, body: { errors: [{ code: errorCode, message }], data: null } });

function readHeader(headers, name) {
  if (!headers) return '';
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === lower) return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
  }
  return '';
}

/**
 * 当前请求的**真实 actor**（真实 2.2.20 契约是 `ctx.auth.user.id`）。
 *
 * 本机夹具令牌格式为 `fixture-token.<userId>.<epoch>`（`manual-fixture.mjs` 的
 * `fixtureTokenFor`），因此可以从 `Authorization: Bearer …` 解出是谁在请求。
 * 旧实现只看自定义头 `x-crewloom-synth-user`（产品从不发送）并固定回落到 3，
 * 导致李四登录后 `aiWorkflowTasks:getBySession.readonly` 仍按张三算成 false。
 * 显式头仍保留给脚本探针使用。
 */
function actorUserId(headers) {
  const explicit = readHeader(headers, 'x-crewloom-synth-user');
  if (explicit) return Number(explicit);
  const authorization = readHeader(headers, 'authorization');
  const matched = /^Bearer\s+fixture-token\.(\d+)\.\d+$/i.exec(authorization.trim());
  return matched ? Number(matched[1]) : 3;
}

/** 本机合成的附件（可见说明里的"合成无敏感测试文件"）。 */
export const SYNTH_ATTACHMENT = {
  filename: 'synthetic-note.txt',
  contentType: 'text/plain; charset=utf-8',
  content: [
    'Crewloom 本机合成测试附件（synthetic-note.txt）',
    '',
    '· 这份文件由本机合成环境提供，只用于验证上传/移除/元数据卡。',
    '· 不含任何真实凭据、真实业务数据或个人信息。',
    '· 上传只会写入 127.0.0.1:5404 进程内存，不会发送到任何真实后端。',
    '',
  ].join('\n'),
};

/* ------------------------------------------------------------------ *
 * 外呼 / 真实写动作的显式拒绝（不是"空成功"）
 * ------------------------------------------------------------------ */

/**
 * 本机合成环境**明确不做**的动作。
 *
 * 这些动作在真实后端会产生外部副作用（模型发现/推理、MCP 外呼、真实上传、
 * 真实数据源连接测试、数据源写入、找回密码发信）。本机一律**显式拒绝**并说明原因，
 * 既不静默空成功，也绝不回退真实 13000。
 */
const DENY_ACTIONS = [
  { match: /^ai:listModels$/, reason: '模型发现会外呼真实提供方；本机只回配置（ai:listAllEnabledModels）。' },
  { match: /^ai:listProviderModels$/, reason: '模型发现会外呼真实提供方；本机合成环境不执行。' },
  { match: /^ai:testFlight$/, reason: '试飞会真实推理；本机合成环境不执行。' },
  { match: /^aiMcpClients:(testConnection|listTools|rebuildClient|updateToolPermission)$/, reason: 'MCP 客户端会外呼第三方服务；本机合成环境不执行。' },
  { match: /^attachments:upload$/, reason: '本机合成环境不向任何真实目标上传附件；请用会话内的 aiFiles 本机上传。' },
  { match: /^aiFiles:(?!create)/, reason: '本机合成环境的附件只在会话内本机创建。' },
  { match: /^mainDataSource:(refresh|syncFields)$/, reason: '主数据源同步会写真实库结构；本机合成环境不执行。' },
  { match: /^dataSources:(testConnection|readTables|loadTables|create|update|destroy)$/, reason: '数据源连接测试/写入会外呼或改配置；本机合成环境不执行。' },
  { match: /^auth:lostPassword$/, reason: '找回密码会真实发信；本机合成环境不执行。' },
  { match: /^llmServices:(create|update|destroy|testConnection)$/, reason: '模型服务写入/连通性测试会外呼；本机只回配置。' },
  { match: /^aiSettings:(update|testConnection)$/, reason: 'AI 设置写入/测试会外呼；本机合成环境不执行。' },
  { match: /^notifications?:/, reason: '通知会外呼；本机合成环境不执行。' },
  { match: /^(users|roles|departments|organizations):(create|update|destroy|setDefaultRole|applyDataPermissions|setSystemRoleMode|changePassword)$/, reason: '本机合成环境不做真实权限/账号写入。' },
  { match: /^workflows:(create|update|destroy|revision)$/, reason: '本机合成环境不写真实工作流定义。' },
  { match: /^executions:(cancel|destroy)$/, reason: '本机合成环境不操作真实执行记录。' },
  { match: /^flow_nodes:/, reason: '本机合成环境不写真实流程节点。' },
  { match: /^aiConversations:updateToolArgs$/, reason: '本机合成环境不记录工具参数修改；请用批准 / 拒绝决定。' },
  { match: /^synth_neverCalled/, reason: '占位：确保没有任何本机动作被外呼。' },
];

export function denyReasonFor(action) {
  for (const entry of DENY_ACTIONS) if (entry.match.test(action)) return entry.reason;
  return null;
}

/* ------------------------------------------------------------------ *
 * 本机应答
 * ------------------------------------------------------------------ */

function collectionByName(name, dataSourceKey) {
  return SYNTH_COLLECTIONS.find(
    (collection) => collection.name === name && (!dataSourceKey || collection.dataSourceKey === dataSourceKey),
  );
}

function pageOf(rows, url) {
  const params = new URL(url, 'http://127.0.0.1').searchParams;
  const page = Number(params.get('page') ?? 1) || 1;
  const pageSize = Number(params.get('pageSize') ?? 20) || 20;
  const start = (page - 1) * pageSize;
  return { slice: rows.slice(start, start + pageSize), page, pageSize };
}

/** AI 任务（TD-03）行/详情。字段与真实 `aiWorkflowTasks` 契约一致。 */
export function td03Task(state, userId) {
  const td03 = state.td03;
  const mine = td03.acceptedUserId !== null && String(td03.acceptedUserId) === String(userId);
  const readonly =
    td03.status === TD03_STATUS.rejected || (td03.status === TD03_STATUS.pendingApproval && !mine);
  return {
    id: td03.taskId,
    sessionId: td03.sessionId,
    status: td03.status,
    acceptedUserId: td03.acceptedUserId,
    readonly,
    read: false,
    jobStatus: td03.status === TD03_STATUS.rejected ? -1 : 0,
    jobId: 4101,
    workflowId: 9001,
    nodeId: 9101,
    createdAt: '2026-10-11T02:00:00.000Z',
    updatedAt: new Date().toISOString(),
    aiEmployee: { username: 'synth-analyst', nickname: '合成分析员' },
    config: { mode: 0 },
    // 真实 2.2.22 的 getBySession **不返回**工具消息（工具调用来自 aiConversations:getMessages）。
    toolCalls: [],
  };
}

function td03ListRow(state, userId) {
  const task = td03Task(state, userId);
  return {
    id: task.id,
    sessionId: task.sessionId,
    status: task.status,
    jobId: task.jobId,
    jobStatus: task.jobStatus,
    acceptedUserId: task.acceptedUserId,
    read: task.read,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

/** 会话 id（含 TD-03 任务会话）→ 该会话创建时的角色世代，用于角色世代写保护。 */
function sessionRoleEpoch(state, sessionId) {
  if (!sessionId) return null;
  for (let index = state.requests.length - 1; index >= 0; index -= 1) {
    const entry = state.requests[index];
    if (entry.sessionId === sessionId && typeof entry.roleEpoch === 'number') return entry.roleEpoch;
  }
  return null;
}

/**
 * 本机合成环境的"聊天元数据"应答。
 *
 * @returns {{code:number, body:unknown}|null} null = 本层不处理，交给后续层。
 */
export function chatLocal(action, { method, url, headers, values }, state) {
  const userId = actorUserId(headers);

  // ---- AI 员工 ----
  if (action === 'aiEmployees:list' || action === 'aiEmployees:listByUser') {
    return ok(SYNTH_EMPLOYEES, { count: SYNTH_EMPLOYEES.length });
  }
  if (action === 'aiEmployees:get') {
    const username = new URL(url, 'http://127.0.0.1').searchParams.get('filterByTk') ?? '';
    const employee = SYNTH_EMPLOYEES.find((item) => item.username === username);
    return employee ? ok(employee) : fail(404, 'NOT_FOUND', `本机合成环境没有员工 ${username}`);
  }

  // ---- 工具 / 技能 / MCP / 模型服务配置 ----
  if (action === 'aiTools:list') return ok(SYNTH_TOOLS, { count: SYNTH_TOOLS.length });
  if (action === 'aiSkills:list') return ok([], { count: 0 });
  if (action === 'aiMcpClients:list') return ok([], { count: 0 });
  if (action === 'llmServices:list') return ok(SYNTH_LLM_SERVICES, { count: SYNTH_LLM_SERVICES.length });
  if (action === 'llmServices:get') {
    const name = new URL(url, 'http://127.0.0.1').searchParams.get('filterByTk') ?? '';
    const service = SYNTH_LLM_SERVICES.find((item) => item.name === name);
    return service ? ok(service) : fail(404, 'NOT_FOUND', `本机合成环境没有模型服务 ${name}`);
  }
  if (action === 'ai:listAllEnabledModels') return ok(SYNTH_ENABLED_MODELS);
  if (action === 'aiSettings:get') {
    return ok({ enabled: true, defaultModel: 'synth-model-a', localSynthetic: true });
  }

  // ---- 会话未读数（原生 ChatBox 徽标）----
  if (action === 'aiConversations:unreadCounts') {
    return ok({ conversationUnreadCount: 0, workflowTaskUnreadCount: 0 });
  }

  // ---- 数据源 / 集合 / 字段 / 记录（上下文工作区四类选择）----
  if (action === 'dataSources:list') return ok(SYNTH_DATASOURCES, { count: SYNTH_DATASOURCES.length });
  if (action === 'dataSources:get') {
    const key = new URL(url, 'http://127.0.0.1').searchParams.get('filterByTk') ?? 'main';
    const source = SYNTH_DATASOURCES.find((item) => item.key === key);
    return source ? ok(source) : fail(404, 'NOT_FOUND', `本机合成环境没有数据源 ${key}`);
  }
  if (action === 'collections:list') {
    const params = new URL(url, 'http://127.0.0.1').searchParams;
    const dataSourceKey = params.get('dataSource') ?? readHeader(headers, 'x-data-source') ?? '';
    const rows = SYNTH_COLLECTIONS.filter(
      (collection) => !dataSourceKey || dataSourceKey === 'main' || collection.dataSourceKey === dataSourceKey,
    ).map((collection) => ({
      name: collection.name,
      title: collection.title,
      titleField: collection.titleField,
      primaryKey: collection.primaryKey,
      dataSourceKey: collection.dataSourceKey,
    }));
    return ok(rows, { count: rows.length });
  }
  if (action === 'collections:get') {
    const name = new URL(url, 'http://127.0.0.1').searchParams.get('filterByTk') ?? '';
    const collection = collectionByName(name);
    if (!collection) return fail(404, 'NOT_FOUND', `本机合成环境没有集合 ${name}`);
    return ok({
      name: collection.name,
      title: collection.title,
      titleField: collection.titleField,
      primaryKey: collection.primaryKey,
      dataSourceKey: collection.dataSourceKey,
      fields: collection.fields,
    });
  }
  if (action === 'fields:list') return ok([], { count: 0 });

  // ---- 上下文数据源：记录由受控中间件持有（create/get/list/update/destroy 都在那里真实应答）----
  // 旧版本在这里把 update/destroy 直接判 501；那会让"编辑保存"永远失败。
  // 现在交给受控中间件按真实契约应答，本层不再拦截（未知动作仍由后续层 501）。

  // ---- TD-03 AI 任务 ----
  if (action === 'aiWorkflowTasks:list') {
    if (!state.td03.sessionId) return ok([], { count: 0 });
    const { slice, page, pageSize } = pageOf([td03ListRow(state, userId)], url);
    return ok(slice, { count: 1, page, pageSize, totalPage: 1 });
  }
  if (action === 'aiWorkflowTasks:getBySession') {
    const params = new URL(url, 'http://127.0.0.1').searchParams;
    const sessionId = params.get('sessionId') ?? values?.sessionId ?? '';
    if (!state.td03.sessionId || sessionId !== state.td03.sessionId) {
      return fail(404, 'AI_TASK_NOT_FOUND', '本机合成环境没有这条 AI 任务，请先在控制页"准备/重置 TD-03 任务"。');
    }
    return ok(td03Task(state, userId));
  }
  if (action === 'aiWorkflowTasks:unreadCount') {
    return ok({ count: state.td03.sessionId ? 1 : 0 });
  }
  if (action === 'aiWorkflowTasks:accept') {
    const td03 = state.td03;
    const sessionId = values?.sessionId ?? '';
    if (!td03.sessionId || sessionId !== td03.sessionId) {
      return fail(404, 'AI_TASK_NOT_FOUND', '本机合成环境没有这条 AI 任务。');
    }
    if (td03.status !== TD03_STATUS.pendingAcceptance || td03.acceptedUserId !== null) {
      return ok({ accepted: false, readUpdated: false, acceptedUserId: td03.acceptedUserId });
    }
    td03.acceptedUserId = userId;
    td03.status = TD03_STATUS.pendingApproval;
    td03.acceptCount += 1;
    td03.history.push({ at: new Date().toISOString(), kind: 'accept', userId, status: td03.status });
    return ok({ accepted: true, readUpdated: true, acceptedUserId: userId });
  }
  if (action === 'aiWorkflowTasks:reject') {
    const td03 = state.td03;
    const id = values?.id ?? '';
    if (!id) return fail(400, 'INVALID_PAYLOAD', 'id is required');
    if (td03.status !== TD03_STATUS.pendingApproval || String(td03.acceptedUserId) !== String(userId)) {
      return fail(
        403,
        'AI_TASK_NOT_REJECTABLE',
        '只有"已领取（待决策）且受理人是当前用户"的任务才能终止。',
      );
    }
    td03.status = TD03_STATUS.rejected;
    td03.rejectCount += 1;
    td03.history.push({ at: new Date().toISOString(), kind: 'reject', userId, result: values?.result ?? null });
    return ok({ rejected: true });
  }

  // ---- 角色世代写保护（拒绝旧角色世代下的写动作并保留证据）----
  if (
    state.roleEpochGuard &&
    ['aiConversations:updateUserDecision', 'aiConversations:resumeToolCall'].includes(action) &&
    values?.sessionId
  ) {
    const created = sessionRoleEpoch(state, String(values.sessionId));
    if (created !== null && created !== state.roleEpoch) {
      const note = `该会话的工具确认是在角色世代 ${created} 下产生的，当前已是世代 ${state.roleEpoch}；本机拒绝把旧世代的决定写到新世代上。`;
      state.requests.push({
        at: new Date().toISOString(),
        method,
        action,
        role: readHeader(headers, 'x-role') || null,
        roleEpoch: state.roleEpoch,
        code: 409,
        note: `role-epoch-guard: ${note}`,
      });
      return fail(409, 'ROLE_EPOCH_STALE', note);
    }
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * 组装好的本机应答（供控制页显示 / 自检）
 * ------------------------------------------------------------------ */

export function chatSelfSummary(state) {
  return {
    roles: CHAT_ROLES,
    users: SYNTH_USERS,
    employees: SYNTH_EMPLOYEES.map((item) => ({ username: item.username, nickname: item.nickname })),
    llmServices: SYNTH_LLM_SERVICES.map((item) => ({ name: item.name, title: item.title, provider: item.provider })),
    dataSources: SYNTH_DATASOURCES.map((item) => ({ key: item.key, displayName: item.displayName })),
    collections: SYNTH_COLLECTIONS.map((item) => ({
      name: item.name,
      title: item.title,
      dataSourceKey: item.dataSourceKey,
      records: (SYNTH_RECORDS[item.name] ?? []).length,
    })),
    td03: {
      taskId: state.td03.taskId,
      sessionId: state.td03.sessionId,
      status: state.td03.status,
      acceptedUserId: state.td03.acceptedUserId,
      acceptCount: state.td03.acceptCount,
      decisionCount: state.td03.decisionCount,
      resumeCount: state.td03.resumeCount,
      lastResumeToolCallResults: state.td03.lastResumeToolCallResults,
      history: state.td03.history.slice(-20),
    },
  };
}

export { ROLE_NAMES, json as synthesizeEnvelope };
