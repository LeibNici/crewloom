/**
 * TD-02 人工处理表单：**本机合成 fixture**（唯一数据来源 + 唯一应答逻辑）。
 *
 * 两个使用方共用这一份：
 *  1. CI 核对脚本 `scripts/verify-manual-native-form.mjs`（28 条断言）——
 *     状态用 `createFixtureState()`（`acceptanceUi:false`、`unknownPolicy:'empty'`），
 *     应答与原脚本**逐字一致**（本模块把原来内联的 `controlledRespond` 原样搬进来，
 *     fixture 独有分支全部在它之外，且只在 `acceptanceUi:true` 时生效）；
 *  2. 可持续运行的本机验收环境 `scripts/manual-fixture-server.mjs`（HTTP，推荐 5402）——
 *     Vite 的 `/api`、`/files` 代理指向它；验收方在内置浏览器里用真实页面亲自操作。
 *     未支持的接口**只在本机返回 501**，绝不外呼真实后端。
 *
 * 数据边界（硬约束）：
 *  - 全部为合成数据：合成账号、合成流程/节点/schema、合成关联候选（张三/李四）；
 *  - 不含真实 13000 凭据、真实用户数据、真实业务标识；
 *  - 本模块不做任何网络请求，也不会“回退”到任何真实后端。
 */

/* ------------------------------------------------------------------ *
 * 合成账号与任务id
 * ------------------------------------------------------------------ */

/** 关联字段候选（与原 28 条断言一致：张三 3 / 李四 7）。 */
export const FIXTURE_USERS = [
  { id: 3, nickname: '张三' },
  { id: 7, nickname: '李四' },
];

/**
 * 本机合成登录账号（公开、非真实 13000 账号）。
 * 口令固定为 `fixture`，只在 127.0.0.1 的 fixture 上有效。
 */
export const FIXTURE_ACCOUNTS = [
  {
    id: 3,
    email: 'zhangsan@fixture.local',
    password: 'fixture',
    nickname: '张三',
    note: '合成用户·张三（是 id=7 任务的受理人）',
    roles: [{ name: 'root', title: 'Root' }],
  },
  {
    id: 7,
    email: 'lisi@fixture.local',
    password: 'fixture',
    nickname: '李四',
    note: '合成用户·李四（不是 id=7 任务的受理人，用于只读隔离）',
    roles: [{ name: 'root', title: 'Root' }],
  },
];

export const FIXTURE_TASK_IDS = {
  /** 待处理（可填写、可提交；提交 200 → 记入 state.submitted）。 */
  pending: 7,
  /** 已处理（只读回显 28 条断言里的那组值）。 */
  processed: 8,
  /** 并发冲突（提交返回 409）。 */
  conflict: 9,
  /** 非受理人（userId=99）：字段禁用、动作不渲染（只读隔离）。 */
  otherAssignee: 107,
  /** 刚被本机提交的任务（只读回读 state.submitted；未提交时本机 404）。 */
  submitted: 108,
};

/** 非受理人 id（没有对应登录账号，故意不是“我”）。 */
export const FIXTURE_OTHER_ASSIGNEE_ID = 99;

/** 合成流程/节点标题。 */
export const FIXTURE_WORKFLOW_TITLE = '报销审批（合成样本）';
export const FIXTURE_NODE_TITLE = '填写报销单';

/* ------------------------------------------------------------------ *
 * fixture 状态（验收环境可切换 / 可重置）
 * ------------------------------------------------------------------ */

/** 令牌世代前缀：`fixture-token.<userId>.<epoch>`。 */
export const FIXTURE_TOKEN_PREFIX = 'fixture-token';

export function createFixtureState(overrides = {}) {
  return {
    /** 令牌世代：变更后旧令牌一律 401（会话/角色世代隔离）。 */
    epoch: 1,
    /** 最近一次成功提交的合成数据（`{ result: {...} }`）。 */
    submitted: null,
    submittedAt: null,
    /** 合成任务的可重置状态（提交成功会真的改写原任务，重置恢复初始值）。 */
    tasks: initialFixtureTasks(),
    /** 本机收到的请求记录（方法 / action / 状态），只在本机展示。 */
    requests: [],
    /** 未支持而被本机拒绝的 action（只本机 501，不外呼）。 */
    unsupported: [],
    /** true：启用验收环境独有端点（列表/统计/107/108）与 501 策略。 */
    acceptanceUi: false,
    /** 未支持接口的策略：`empty`（CI 原样）| `error`（验收环境本机 501）。 */
    unknownPolicy: 'empty',
    ...overrides,
  };
}

/** 清空合成写入与请求记录（不动令牌世代），并把合成任务恢复到初始状态。 */
export function resetFixtureState(state) {
  state.submitted = null;
  state.submittedAt = null;
  state.tasks = initialFixtureTasks();
  state.requests = [];
  state.unsupported = [];
  return state;
}

/** 令牌世代 +1：旧会话令牌立即失效（需要重新登录）。 */
export function bumpFixtureEpoch(state) {
  state.epoch += 1;
  return state;
}

export function fixtureTokenFor(state, userId) {
  return `${FIXTURE_TOKEN_PREFIX}.${userId}.${state.epoch}`;
}

/* ------------------------------------------------------------------ *
 * 原 CI 受控应答（逐字搬移，保持 28 条断言的应答不变）
 * ------------------------------------------------------------------ */

const CONTROLLED_SCHEMA = {
  block1: {
    type: 'void',
    'x-decorator': 'FormBlockProvider',
    'x-component': 'CardItem',
    'x-component-props': { title: '处理表单' },
    properties: {
      formA: {
        type: 'void',
        'x-component': 'FormV2',
        'x-use-component-props': 'useFormBlockProps',
        properties: {
          grid: {
            type: 'void',
            'x-component': 'Grid',
            properties: {
              row1: {
                type: 'void',
                'x-component': 'Grid.Row',
                properties: {
                  amount: {
                    type: 'void',
                    'x-component': 'Grid.Col',
                    properties: {
                      amount: { name: 'amount', type: 'number', title: '报销金额', 'x-decorator': 'FormItem', 'x-component': 'InputNumber', required: true },
                    },
                  },
                  spentAt: {
                    type: 'void',
                    'x-component': 'Grid.Col',
                    properties: {
                      spentAt: { name: 'spentAt', type: 'string', title: '发生日期', 'x-decorator': 'FormItem', 'x-component': 'DatePicker', 'x-component-props': { dateFormat: 'YYYY-MM-DD', showTime: false } },
                    },
                  },
                },
              },
              row2: {
                type: 'void',
                'x-component': 'Grid.Row',
                properties: {
                  urgent: {
                    type: 'void',
                    'x-component': 'Grid.Col',
                    properties: {
                      urgent: { name: 'urgent', type: 'boolean', title: '是否加急', 'x-decorator': 'FormItem', 'x-component': 'Checkbox' },
                    },
                  },
                  reason: {
                    type: 'void',
                    'x-component': 'Grid.Col',
                    properties: {
                      reason: {
                        name: 'reason',
                        type: 'string',
                        title: '加急原因',
                        'x-decorator': 'FormItem',
                        'x-component': 'Input',
                        'x-reactions': { dependencies: ['.urgent'], fulfill: { state: { visible: '{{$deps[0] === true}}' } } },
                      },
                    },
                  },
                },
              },
              row3: {
                type: 'void',
                'x-component': 'Grid.Row',
                properties: {
                  category: {
                    type: 'void',
                    'x-component': 'Grid.Col',
                    properties: {
                      category: {
                        name: 'category',
                        type: 'string',
                        title: '类别',
                        'x-decorator': 'FormItem',
                        'x-component': 'Select',
                        enum: [
                          { label: '差旅', value: 'travel' },
                          { label: '餐费', value: 'meal' },
                        ],
                      },
                    },
                  },
                  reviewers: {
                    type: 'void',
                    'x-component': 'Grid.Col',
                    properties: {
                      reviewers: {
                        name: 'reviewers',
                        type: 'array',
                        title: '会签人',
                        'x-decorator': 'FormItem',
                        'x-component': 'AssociationField',
                        'x-collection-field': 'expenses.reviewers',
                        'x-component-props': { multiple: true, fieldNames: { label: 'nickname', value: 'id' } },
                      },
                    },
                  },
                  code: {
                    type: 'void',
                    'x-component': 'Grid.Col',
                    properties: {
                      code: {
                        name: 'code',
                        type: 'string',
                        title: '报销编号',
                        'x-decorator': 'FormItem',
                        'x-component': 'Input',
                        'x-reactions': { dependencies: ['.category'], fulfill: { state: { value: '{{$deps[0] === "travel" ? "T-100" : ""}}' } } },
                      },
                    },
                  },
                },
              },
            },
          },
          actions: {
            type: 'void',
            'x-decorator': 'ActionBarProvider',
            'x-component': 'ActionBar',
            properties: {
              approve: {
                type: 'void',
                name: 'approve',
                title: '通过',
                'x-decorator': 'ManualActionStatusProvider',
                'x-decorator-props': { value: 1 },
                'x-component': 'Action',
                'x-component-props': { type: 'primary', useAction: '{{ useSubmit }}' },
              },
            },
          },
        },
      },
    },
  },
};

/** 已处理任务的合成结果（与 28 条断言里的回显值一致）。 */
const PROCESSED_RESULT = {
  formA: {
    amount: 256,
    category: 'travel',
    code: 'T-100',
    urgent: true,
    spentAt: '2026-10-11',
    reviewers: [{ id: 3, nickname: '张三' }],
  },
  _: 'approve',
};

/**
 * 冲突任务在"已被处理"后的合成结果（控制页可见按钮触发，用于验证：
 * 用户对 409 冲突页显式点"刷新查看最新状态"后，看到的是**别人/别处**处理完的只读结果，
 * 而不是自己刚才没提交成功的草稿）。
 */
const CONFLICT_RESOLVED_RESULT = {
  formA: {
    amount: 120,
    category: 'meal',
    code: '',
    urgent: false,
    spentAt: '2026-10-10',
    reviewers: [{ id: 7, nickname: '李四' }],
  },
  _: 'approve',
};

/**
 * 合成任务的**可重置状态机**（按真实 `workflowManualTasks` 记录建模）。
 *
 * 真实契约（`plugin-workflow-manual/dist/server`）：
 *  - `workflowManualTasks` 有 `user` belongsTo（foreignKey `userId`）与 `status`/`result`；
 *  - `submit` 成功后把该任务 `status` 置为该动作的 status、`result` 置为
 *    `{ [formKey]: {...}, _: actionKey }`，原任务由此变为"已处理"；
 *  - `listMine` 按 `userId` 过滤（原生"待处理"页签再叠加 `status: 0`）。
 *
 * 因此 fixture 必须让"提交成功"真的改写原任务；否则页面刷新后仍显示待处理，
 * 那是夹具在造假状态，不是产品行为。
 */
export function initialFixtureTasks() {
  return {
    [FIXTURE_TASK_IDS.pending]: { userId: FIXTURE_ACCOUNTS[0].id, status: 0, result: null },
    [FIXTURE_TASK_IDS.processed]: { userId: FIXTURE_ACCOUNTS[0].id, status: 1, result: PROCESSED_RESULT },
    [FIXTURE_TASK_IDS.conflict]: { userId: FIXTURE_ACCOUNTS[0].id, status: 0, result: null },
    [FIXTURE_TASK_IDS.otherAssignee]: { userId: FIXTURE_OTHER_ASSIGNEE_ID, status: 0, result: null },
  };
}

/** 把某条合成任务置为"已处理"并写入结果（控制页按钮 / 提交成功都走这里）。 */
export function markFixtureTaskProcessed(state, id, result) {
  const key = String(id);
  const existed = state.tasks?.[key];
  if (!existed) return null;
  state.tasks[key] = { ...existed, status: 1, result: result ?? null };
  return state.tasks[key];
}

/** 合成任务的可见摘要（控制页展示用）。 */
export function fixtureTaskStates(state) {
  return Object.entries(state.tasks ?? {}).map(([id, entry]) => ({
    id: Number(id),
    userId: entry.userId,
    status: entry.status,
    processed: entry.status !== 0,
    hasResult: Boolean(entry.result),
  }));
}

/** 某合成用户的任务统计（真实 handler 按 `currentUser.id` 过滤；这里同样按 userId 计算）。 */
function fixtureStatsFor(state, userId) {
  const entries = Object.values(state.tasks ?? {}).filter((entry) => entry.userId === userId);
  if (entries.length === 0) return null;
  return {
    pending: entries.filter((entry) => entry.status === 0).length,
    all: entries.length,
  };
}

function fixtureUserOf(userId) {
  const found = FIXTURE_USERS.find((item) => item.id === userId);
  return found ? { id: found.id, nickname: found.nickname } : null;
}

const parseJson = (raw) => {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const readFilterByTk = (fullUrl) => new URL(asAbsoluteUrl(fullUrl)).searchParams.get('filterByTk');

/** 真实 `filter` 参数是 JSON 字符串（产品 `serializeFilter` / SDK 行为一致）。 */
function readFilterParam(fullUrl) {
  const raw = new URL(asAbsoluteUrl(fullUrl)).searchParams.get('filter');
  const parsed = parseJson(raw);
  return parsed && typeof parsed === 'object' ? parsed : {};
}

/**
 * `collections:get` 要读的集合名。
 *
 * 真实 `collections` 集合的 `filterTargetKey` 是 `name`，页面按惯例用 `filterByTk=<集合名>`
 * （`useUsersAvatarField` → `collections:get?filterByTk=users&appends=fields`）；
 * 这里同时接受 `name`，只是为了不把参数形状写死到一种猜测上。
 */
function readCollectionName(fullUrl) {
  const params = new URL(asAbsoluteUrl(fullUrl)).searchParams;
  return params.get('filterByTk') ?? params.get('name');
}

/**
 * 查询串里的 `appends`（SDK 序列化成 `appends[]=...`，也兼容 `appends=...` 与 JSON 数组）。
 * 只用来决定 `collections:get` 是否带上 `fields`，不做其它推断。
 */
function readAppends(fullUrl) {
  const params = new URL(asAbsoluteUrl(fullUrl)).searchParams;
  const raw = [...params.getAll('appends'), ...params.getAll('appends[]')];
  return raw.flatMap((value) => {
    const parsed = value.startsWith('[') ? parseJson(value) : null;
    return Array.isArray(parsed) ? parsed.map(String) : [String(value)];
  });
}

/**
 * 一条合成任务详情（供验收环境的 `workflowManualTasks:get`）。
 * `user` 关联按 `userId` 从合成用户表读取；没有对应记录时如实为 `null`，不伪造姓名。
 */
function fixtureTaskDetail(id, entry) {
  const base = controlledTask();
  const processed = entry.status !== 0;
  const result = entry.result ?? null;
  return {
    ...base,
    id: Number(id),
    status: entry.status,
    userId: entry.userId,
    result,
    user: fixtureUserOf(entry.userId),
    job: { ...base.job, status: processed ? 1 : 0, result },
    execution: { ...base.execution, status: processed ? 1 : 0 },
    workflow: { ...base.workflow, title: FIXTURE_WORKFLOW_TITLE },
  };
}

/** 某合成用户的可见任务行（`workflowManualTasks:listMine`；`status` 为 undefined 时不过滤）。 */
function fixtureTaskRows(state, userId, status) {
  return Object.keys(state.tasks ?? {})
    .map(Number)
    .sort((left, right) => left - right)
    .filter((id) => state.tasks[String(id)].userId === userId)
    .filter((id) => status === undefined || state.tasks[String(id)].status === status)
    .map((id) => {
      const entry = state.tasks[String(id)];
      return {
        id,
        status: entry.status,
        userId: entry.userId,
        workflowId: 172,
        nodeId: 2410,
        createdAt: '2026-10-11T01:00:00.000Z',
        workflow: {
          id: 172,
          title:
            id === FIXTURE_TASK_IDS.conflict
              ? `${FIXTURE_WORKFLOW_TITLE}·并发冲突`
              : FIXTURE_WORKFLOW_TITLE,
        },
        node: { id: 2410, title: FIXTURE_NODE_TITLE, type: 'manual' },
      };
    });
}

function controlledTask(overrides = {}) {
  return {
    id: 7,
    status: 0,
    userId: 3,
    createdAt: '2026-10-11T01:00:00.000Z',
    result: null,
    job: { id: 99, status: 0 },
    execution: { id: 55, status: 0 },
    workflow: { id: 172, title: '报销审批（受控样本）', current: true },
    node: {
      id: 2410,
      title: '填写报销单',
      type: 'manual',
      config: { mode: 0, forms: { formA: { type: 'create', actions: [{ key: 'approve', status: 1, title: '通过' }] } }, schema: CONTROLLED_SCHEMA },
    },
    ...overrides,
  };
}

const ACCESS_DATA = {
  role: 'root',
  roleMode: 'default',
  strategy: null,
  actions: {},
  resources: [],
  snippets: ['pm', 'pm.*', 'ui.*'],
  allowAll: true,
  allowConfigure: false,
  allowAnonymous: false,
  allowMenuItemIds: [],
  uiButtonSchemasBlacklist: [],
  availableActions: ['create', 'view', 'update', 'destroy'],
  actionAlias: { list: 'view' },
  roles: [],
};

export const json = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');
const ok = (data, meta) => ({ code: 200, body: { data, ...(meta ? { meta } : {}) } });

/**
 * 合成**集合元数据**（`collections:list` 与 `collections:get` 共用这一份，不各写一套）。
 *
 * 只声明本 fixture 真实用到的两个集合：
 *  - `expenses`：处理表单里「会签人」字段（`x-collection-field: expenses.reviewers`）的来源；
 *  - `users`：关联候选（张三/李四）与账号头像能力探测（`users.avatar`）读取的集合。
 *
 * 真实的 `collections` 集合以 `name` 为主键（`filterTargetKey: 'name'`），
 * 因此 `collections:get` 用 `filterByTk=<集合名>` 取详情（页面的 `useUsersAvatarField`
 * 正是 `collections:get?filterByTk=users&appends=fields`）。
 */
const FIXTURE_COLLECTIONS = [
  {
    name: 'expenses',
    title: '报销单',
    fields: [
      { name: 'id', type: 'bigInt', interface: 'integer', primaryKey: true, autoIncrement: true },
      {
        name: 'reviewers',
        type: 'belongsToMany',
        interface: 'm2m',
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
    title: '用户',
    titleField: 'nickname',
    fields: [
      { name: 'id', type: 'bigInt', interface: 'integer', primaryKey: true, autoIncrement: true },
      { name: 'nickname', type: 'string', interface: 'input', uiSchema: { 'x-component': 'Input', title: '昵称' } },
    ],
  },
];

/**
 * 原 `verify-manual-native-form.mjs` 的受控应答（逐字保留）。
 * 只处理 CI 跑到的端点；未支持端点按旧行为返回空数据（验收环境会在外层改成 501）。
 */
function controlledRespond(method, fullUrl, captured) {
  const parsed = new URL(fullUrl);
  const actionPath = parsed.pathname.replace(/^\/api\//, '');
  if (actionPath.startsWith('authenticators:publicList')) {
    return ok([{ name: 'basic', authType: 'email', title: '邮箱/密码' }]);
  }
  if (actionPath.startsWith('auth:signIn')) {
    return ok({ token: 'controlled-mock-token', user: { id: 3, email: 'controlled@mock.test', nickname: '受控用户' } });
  }
  if (actionPath.startsWith('auth:check')) {
    return ok({ id: 3, nickname: '受控用户', email: 'controlled@mock.test', roles: [] });
  }
  if (actionPath.startsWith('roles:check')) return ok(ACCESS_DATA);
  if (actionPath.startsWith('auth:signOut')) return ok({});
  // 关联字段（真实 AssociationField）需要集合元数据解析 `x-collection-field`。
  if (actionPath.startsWith('collections:list')) {
    return ok(FIXTURE_COLLECTIONS, { count: FIXTURE_COLLECTIONS.length });
  }
  if (actionPath.startsWith('workflowManualTasks:get')) {
    // id=9：并发冲突场景（提交返回 409，页面要刷新到最新状态并给出中文提示）。
    if (fullUrl.includes('filterByTk=9')) {
      return ok({ ...controlledTask(), id: 9 });
    }
    // id=8：已处理任务（原生 useFormBlockProps 走 readPretty、ActionBar 只保留已选动作）。
    if (fullUrl.includes('filterByTk=8')) {
      const done = controlledTask();
      return ok({
        ...done,
        id: 8,
        status: 1,
        result: {
          formA: {
            amount: 256,
            category: 'travel',
            code: 'T-100',
            urgent: true,
            spentAt: '2026-10-11',
            reviewers: [{ id: 3, nickname: '张三' }],
          },
          _: 'approve',
        },
        job: { id: 99, status: 1, result: { formA: { amount: 256 }, _: 'approve' } },
      });
    }
    return ok(controlledTask());
  }
  if (actionPath.startsWith('workflowManualTasks:submit')) {
    captured.submit = JSON.parse(String(captured.submitPostData ?? '{}'));
    if (fullUrl.includes('filterByTk=9')) {
      captured.conflictSubmit = captured.submit;
      return {
        code: 409,
        body: { errors: [{ code: 'LOCKED', message: 'Lock acquire error' }], data: null },
      };
    }
    return ok({ id: 7, status: 1 });
  }
  if (actionPath.startsWith('users:list')) {
    return ok([
      { id: 3, nickname: '张三' },
      { id: 7, nickname: '李四' },
    ]);
  }
  if (method === 'get') return ok([], { count: 0 });
  return ok({});
}

/* ------------------------------------------------------------------ *
 * fixture 层：合成登录 / 令牌世代 / 验收环境独有端点 / 未支持接口
 * ------------------------------------------------------------------ */

/** 不需要令牌也能访问的动作（登录方式、登录、退出、cookie 同步）。 */
const ANONYMOUS_ACTIONS = ['authenticators:publicList', 'auth:signIn', 'auth:signOut', 'auth:syncCookies'];

/**
 * 未登录也允许读的公开元数据（真实 NocoBase 里登录页/壳也需要它们）。
 * 其余 `/api` 动作在验收环境下都要求有效的本机合成令牌：没有令牌就是未登录，
 * 不能"默认已登录"，否则合成登录步骤会被绕过。
 */
const PUBLIC_ACTIONS = [
  ...ANONYMOUS_ACTIONS,
  'app:getInfo',
  'app:getLang',
  'systemSettings:get',
  'storages:getBasicInfo',
];

/**
 * CI 脚本实际跑到的端点（含应用壳的只读元数据）。
 * 不在表内、且不是 fixture 独有端点时：验收环境返回本机 501，CI 保持旧空应答。
 */
const SHELL_METADATA_ACTIONS = [
  'app:getInfo',
  'app:getLang',
  'systemSettings:get',
  'storages:getBasicInfo',
  'dataSources:list',
  'llmServices:list',
  'roles:list',
  'roles:check',
  'users:get',
  'users:list',
  'aiEmployees:list',
  'aiEmployees:listByUser',
  'aiConversations:list',
  'workflows:list',
  'collections:list',
  'auth:check',
  'auth:signOut',
  'auth:syncCookies',
  'authenticators:publicList',
  'auth:signIn',
  'workflowManualTasks:get',
  'workflowManualTasks:submit',
];

/** 验收环境独有端点（列表/统计/未读；CI 不调用）。 */
const ACCEPTANCE_ACTIONS = [
  'workflowManualTasks:listMine',
  'workflowManualTasks:list',
  'userWorkflowTaskStats:listMine',
  'userWorkflowTasks:listMine',
  'workflowCcTasks:listMine',
  'aiWorkflowTasks:list',
  'aiWorkflowTasks:unreadCount',
];

/** 允许传相对路径（本机 fixture 服务直接拿 `req.url`）。 */
const asAbsoluteUrl = (fullUrl) =>
  /^https?:\/\//i.test(String(fullUrl)) ? String(fullUrl) : `http://127.0.0.1${String(fullUrl)}`;
const actionOf = (fullUrl) => new URL(asAbsoluteUrl(fullUrl)).pathname.replace(/^\/api\//, '');
const stateOfAction = (actionPath, list) => list.some((item) => actionPath.startsWith(item));

function readHeader(headers, name) {
  if (!headers) return '';
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === lower) return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
  }
  return '';
}

function parseFixtureToken(token) {
  const matched = /^fixture-token\.(\d+)\.(\d+)$/.exec(String(token ?? '').trim());
  return matched ? { userId: Number(matched[1]), epoch: Number(matched[2]) } : null;
}

/** 从 Authorization 头解析本机合成会话（非 fixture 令牌 → `account:null, stale:false`）。 */
export function resolveFixtureSession(state, headers) {
  const authorization = readHeader(headers, 'authorization');
  const matched = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  const token = matched ? matched[1].trim() : '';
  const parsed = parseFixtureToken(token);
  if (!parsed) return { token: token || null, account: null, stale: false };
  const account = FIXTURE_ACCOUNTS.find((item) => item.id === parsed.userId) ?? null;
  return { token, account, stale: parsed.epoch !== state.epoch };
}

const fixtureUser = (account) => ({
  id: account.id,
  nickname: account.nickname,
  email: account.email,
  roles: account.roles,
});

const unsupported = (actionPath) => ({
  code: 501,
  body: {
    errors: [
      {
        code: 'FIXTURE_UNSUPPORTED',
        message: `本机合成 fixture 不支持 ${actionPath}；不会外呼真实后端。`,
      },
    ],
    data: null,
  },
});

/**
 * 统一应答入口（CI 脚本与 fixture 服务共用）。
 *
 * @param {{ method?: string, url: string, headers?: Record<string, unknown> }} request
 * @param {ReturnType<typeof createFixtureState>} state
 * @param {{ submitPostData?: string | null }} captured CI 脚本用：记录提交体
 * @returns {{ code: number, body: unknown }}
 */
export function respondFixture(request = {}, state = createFixtureState(), captured = {}) {
  const method = String(request.method ?? 'get').toLowerCase();
  const url = asAbsoluteUrl(request.url ?? '');
  const headers = request.headers ?? {};
  const actionPath = actionOf(url);
  const session = resolveFixtureSession(state, headers);

  // 1) 验收环境独有：真实可用的合成登录（CI 脚本走注入会话，不经过这里）。
  if (state.acceptanceUi && actionPath.startsWith('auth:signIn')) {
    const body = typeof captured.signInBody === 'string' ? captured.signInBody : '';
    let credentials = {};
    try {
      credentials = JSON.parse(body || '{}');
    } catch {
      credentials = {};
    }
    const account = FIXTURE_ACCOUNTS.find(
      (item) => item.email === String(credentials.email ?? '').trim() && item.password === String(credentials.password ?? ''),
    );
    if (!account) {
      captured.signInFailed = true;
      return {
        code: 401,
        body: { errors: [{ code: 'INVALID_TOKEN', message: '合成账号或口令不正确（本机 fixture 账号见 /control）' }], data: null },
      };
    }
    captured.signInFailed = false;
    return ok({ token: fixtureTokenFor(state, account.id), user: fixtureUser(account) });
  }

  // 2) 令牌世代（role epoch）：旧世代令牌一律 401，客户端按会话失效处理。
  if (session.stale && !stateOfAction(actionPath, ANONYMOUS_ACTIONS)) {
    return {
      code: 401,
      body: { errors: [{ code: 'EXPIRED_TOKEN', message: '合成会话世代已变更（epoch），请重新登录。' }], data: null },
    };
  }

  // 2.5) 验收环境：非公开动作必须带有效的本机合成令牌，否则按未登录处理。
  if (state.acceptanceUi && !session.account && !stateOfAction(actionPath, PUBLIC_ACTIONS)) {
    return {
      code: 401,
      body: { errors: [{ code: 'EMPTY_TOKEN', message: '未登录：请在本机 fixture 上用合成账号登录。' }], data: null },
    };
  }

  // 3) 合成身份：auth:check 用令牌里的账号（没有 fixture 令牌时保持 CI 原样）。
  if (state.acceptanceUi && session.account && actionPath.startsWith('auth:check')) {
    return ok(fixtureUser(session.account));
  }
  if (state.acceptanceUi && session.account && actionPath.startsWith('roles:check')) {
    const role = readHeader(headers, 'x-role') || session.account.roles[0]?.name || 'root';
    return ok({ ...ACCESS_DATA, role, roles: [{ name: role, title: role === 'root' ? 'Root' : role }] });
  }

  /**
   * 3.5) 验收环境：集合详情（`collections:get`）**复用同一份**合成集合元数据。
   *
   * Main 反馈的已知缺口：正常登录后应用壳会读 `collections:get?filterByTk=users&appends=fields`
   * 判断 `users.avatar` 是否存在；旧 fixture 只认 `collections:list`，于是这里返回 501。
   * 现在按真实契约从 `FIXTURE_COLLECTIONS` 里取同名集合（`appends` 含 `fields` 时才带字段清单），
   * **未知集合不在这里放行** —— 继续落到底部的本机 501，不做 blanket success。
   */
  if (state.acceptanceUi && actionPath.startsWith('collections:get')) {
    const name = readCollectionName(url);
    const collection = FIXTURE_COLLECTIONS.find((item) => item.name === name);
    if (collection) {
      const { fields, ...rest } = collection;
      return ok(readAppends(url).includes('fields') ? collection : rest);
    }
  }

  // 4) 验收环境独有：任务详情全部来自可重置的合成任务状态（含 `user` 关联与只读回显）。
  if (state.acceptanceUi && actionPath.startsWith('workflowManualTasks:get')) {
    const tk = readFilterByTk(url);
    if (tk === String(FIXTURE_TASK_IDS.submitted)) {
      if (!state.submitted) {
        return {
          code: 404,
          body: {
            errors: [{ code: 'FIXTURE_NO_SUBMISSION', message: '本机还没有收到过合成提交，请先在 id=7 上提交一次。' }],
            data: null,
          },
        };
      }
      const base = controlledTask();
      const submittedResult = state.submitted.result ?? state.submitted;
      const submitter = FIXTURE_ACCOUNTS[0].id;
      return ok({
        ...base,
        id: FIXTURE_TASK_IDS.submitted,
        status: 1,
        userId: submitter,
        result: submittedResult,
        user: fixtureUserOf(submitter),
        job: { id: 99, status: 1, result: submittedResult },
        execution: { ...base.execution, status: 1 },
        workflow: { id: 172, title: `${FIXTURE_WORKFLOW_TITLE}·本机刚提交`, current: true },
      });
    }
    const entry = state.tasks?.[tk];
    if (entry) return ok(fixtureTaskDetail(tk, entry));
  }

  // 5) 验收环境独有：可见任务列表与统计（按真实 handler 的 userId 过滤计算）。
  if (state.acceptanceUi && stateOfAction(actionPath, ACCEPTANCE_ACTIONS)) {
    const currentUserId = session.account?.id ?? FIXTURE_ACCOUNTS[0].id;
    if (actionPath.startsWith('workflowManualTasks:listMine') || actionPath.startsWith('workflowManualTasks:list')) {
      const filter = readFilterParam(url);
      const status = typeof filter.status === 'number' ? filter.status : undefined;
      const rows = fixtureTaskRows(state, currentUserId, status);
      return ok(rows, { count: rows.length });
    }
    if (actionPath.startsWith('userWorkflowTaskStats:listMine')) {
      const stats = fixtureStatsFor(state, currentUserId);
      if (!stats) return ok([], { count: 0 });
      return ok(
        [
          {
            id: 172,
            workflowKey: 172,
            workflowId: 172,
            userId: currentUserId,
            title: FIXTURE_WORKFLOW_TITLE,
            stats,
          },
        ],
        { count: 1 },
      );
    }
    if (actionPath.startsWith('userWorkflowTasks:listMine')) {
      const stats = fixtureStatsFor(state, currentUserId);
      if (!stats) return ok([], { count: 0 });
      return ok([{ id: 1, userId: currentUserId, type: 'workflowManualTasks', stats }]);
    }
    if (actionPath.startsWith('aiWorkflowTasks:unreadCount')) return ok({ count: 0 });
    return ok([], { count: 0 });
  }

  // 5.5) 验收环境：提交前按真实契约校验（任务存在 / 仍待处理 / 由本人受理）。
  if (state.acceptanceUi && actionPath.startsWith('workflowManualTasks:submit')) {
    const tk = readFilterByTk(url);
    const entry = state.tasks?.[tk];
    if (!entry) {
      return { code: 404, body: { errors: [{ code: 'NOT_FOUND', message: '这条待办不存在。' }], data: null } };
    }
    if (entry.status !== 0) {
      return {
        code: 400,
        body: { errors: [{ code: 'TASK_NOT_PENDING', message: '这条待办已经处理过了。' }], data: null },
      };
    }
    if (!session.account || entry.userId !== session.account.id) {
      return {
        code: 403,
        body: { errors: [{ code: 'FORBIDDEN', message: '这条待办由其他人处理，你不能代为提交。' }], data: null },
      };
    }
  }

  // 6) 未支持接口：验收环境只在本机报错，绝不外呼。
  const known = stateOfAction(actionPath, SHELL_METADATA_ACTIONS) || stateOfAction(actionPath, ACCEPTANCE_ACTIONS);
  if (!known) {
    state.unsupported.push(`${method.toUpperCase()} ${actionPath}`);
    if (state.unknownPolicy === 'error') return unsupported(actionPath);
  }

  // 7) 其余一律交给与 CI 逐字相同的那段应答。
  const result = controlledRespond(method, url, captured);

  // 8) 记录合成写入，并**真的改写原任务**（真实 submit 契约：status/result 落到原任务上）。
  if (state.acceptanceUi && actionPath.startsWith('workflowManualTasks:submit') && result.code === 200) {
    state.submitted = captured.submit ?? null;
    state.submittedAt = new Date().toISOString();
    markFixtureTaskProcessed(state, readFilterByTk(url), captured.submit?.result ?? null);
  }
  return result;
}

export { controlledRespond, CONTROLLED_SCHEMA, PROCESSED_RESULT };
