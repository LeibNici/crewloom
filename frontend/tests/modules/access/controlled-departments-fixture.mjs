#!/usr/bin/env node
/**
 * 本机**合成**验收环境（fixture）：给主模型的内置 browser control 用，**不是**真实后端。
 *
 * 用途（本轮）：让"部门四方向关联维护 / 用户与员工头像 / 工作台跨页入口"这些页面
 * 能在**不连接真实 13000、不写任何真实数据**的前提下被真人从界面点一遍，
 * 并且可以一键切换成各种真实状态（已开通 / 未开通 / 读取失败 / 无权限 / 角色失效 /
 * 空态 / 用户集合没有头像字段）。
 *
 * 硬边界：
 *  - 只绑定 127.0.0.1；**不是代理**，不向任何外部地址转发请求；
 *  - 未实现的接口返回**本机** 404 + 明确中文说明，绝不 fallback 到真实后端；
 *  - 不读取任何凭据文件；下面的账号是**合成**账号（与真实实例的认证无关）；
 *  - 控制页在 `http://127.0.0.1:<port>/`，只提供"切换场景/重置数据/看请求日志"，
 *    不注入产品页面、不隐藏状态、不执行产品源码。
 *
 * 用法：`node tests/modules/access/controlled-departments-fixture.mjs [port]`（默认 5405）
 *
 * 控制页里显示的产品地址可用环境变量覆盖，不写死某个固定端口：
 *  - `CREWLOOM_FIXTURE_PRODUCT_URL`（完整地址，优先）
 *  - `CREWLOOM_FIXTURE_PRODUCT_PORT`（只给端口，默认 5326）
 */

import { createServer } from 'node:http';

const PORT = Number(process.argv[2] ?? process.env.CREWLOOM_FIXTURE_PORT ?? 5405);

/**
 * 控制页显示的产品预览地址。
 *
 * 本树专属环境用产品 `5326` → fixture `5405`；换成其它端口时只改环境变量，
 * 不在源码里写死历史端口。
 */
const PRODUCT_URL =
  process.env.CREWLOOM_FIXTURE_PRODUCT_URL ??
  `http://127.0.0.1:${process.env.CREWLOOM_FIXTURE_PRODUCT_PORT ?? '5326'}`;

/** 合成账号（可公开，与真实 13000 的认证无关）。 */
const SYNTHETIC_ACCOUNT = { email: 'main@fixture.test', password: 'crewloom-fixture' };

/**
 * 可切换的场景。
 *
 * `pluginEnabled` 控制 `departments` 集合上是否有 `members`/`roles` 字段
 * （以及 `departmentsUsers`/`departmentsRoles` 集合是否存在）——这是"能力是否开通"的
 * 真实判定依据；`associationReadStatus` 单独控制"这次关联读取成功不成功"，
 * 因此可以区分「未开通」与「已开通但读取失败」。
 */
const SCENARIOS = {
  normal: {
    label: '已开通（默认）',
    detail: '关联字段存在、读取成功，可直接做四方向维护',
    pluginEnabled: true,
    associationReadStatus: 200,
    usersAvatarField: true,
    writeFailure: null,
    emptyLinks: false,
  },
  'plugin-disabled': {
    label: '能力未开通（插件未启用）',
    detail: 'departments 没有 members/roles 字段，关联读取 500（与真实 13000 当前状态一致）',
    pluginEnabled: false,
    associationReadStatus: 500,
    usersAvatarField: true,
    writeFailure: null,
    emptyLinks: false,
  },
  'read-error': {
    label: '能力已开通但读取失败',
    detail: '关联字段存在，但这次关联读取返回 500：页面应给"可重试"，不说成"未开通"',
    pluginEnabled: true,
    associationReadStatus: 500,
    usersAvatarField: true,
    writeFailure: null,
    emptyLinks: false,
  },
  empty: {
    label: '已开通但没有关联数据（空态）',
    detail: '关联读取成功、返回空数组：应显示"暂无成员"，不是"未开通"',
    pluginEnabled: true,
    associationReadStatus: 200,
    usersAvatarField: true,
    writeFailure: null,
    emptyLinks: true,
  },
  forbidden: {
    label: '无权限（写操作 403）',
    detail: '读取正常，关联写动作返回 403：页面应给中文权限提示，不显示原始错误码',
    pluginEnabled: true,
    associationReadStatus: 200,
    usersAvatarField: true,
    writeFailure: 403,
    emptyLinks: false,
  },
  role401: {
    label: '角色失效（写操作 401 ROLE_NOT_FOUND_FOR_USER）',
    detail: '写动作返回 401 角色失效：不应把已登录用户踢下线',
    pluginEnabled: true,
    associationReadStatus: 200,
    usersAvatarField: true,
    writeFailure: 401,
    emptyLinks: false,
  },
  'no-avatar-field': {
    label: '用户集合没有头像字段',
    detail: 'users 集合没有 avatar 字段：账号菜单与用户详情都不应出现无效的上传入口',
    pluginEnabled: true,
    associationReadStatus: 200,
    usersAvatarField: false,
    writeFailure: null,
    emptyLinks: false,
  },
  'large-links': {
    label: '大关联集合（超过一页）',
    detail: '总部 120 名成员、60 个角色，李四 60 个部门、销售 60 个部门：页面应分页读完整集合后再做候选排除与整体替换',
    pluginEnabled: true,
    associationReadStatus: 200,
    usersAvatarField: true,
    writeFailure: null,
    emptyLinks: false,
    largeLinks: true,
  },
};

/** 基准关联（每个场景切换前先回到这里，避免残留上一场景的数据）。 */
function baseLinks() {
  return {
    deptMembers: { 1: [101] },
    deptRoles: { 1: ['r_sales'] },
    userDepartments: { 2: [1] },
    roleDepartments: { r_sales: [1] },
    // 角色成员是唯一事实来源：root 有合成管理员（当前登录用户 id=1），销售有李四（2）。
    roleUsers: { root: [1], r_sales: [2] },
  };
}

/** 大关联场景的规模（都超过关联读取的一页）。 */
const BULK_MEMBER_COUNT = 120;
const BULK_ROLE_COUNT = 60;
const BULK_DEPARTMENT_COUNT = 60;

/** 幂等地补齐大关联场景需要的合成用户/角色/部门（切换场景不会重复添加）。 */
function ensureBulkData() {
  for (let index = 0; index < BULK_MEMBER_COUNT; index += 1) {
    const id = 1001 + index;
    if (!state.users.some((user) => user.id === id)) {
      state.users.push({
        id,
        nickname: `批量成员${String(index + 1).padStart(3, '0')}`,
        username: `bulk_member_${index + 1}`,
        email: `bulk${index + 1}@fixture.test`,
      });
    }
  }
  for (let index = 0; index < BULK_ROLE_COUNT; index += 1) {
    const name = bulkRoleName(index);
    if (!state.roles.some((role) => role.name === name)) {
      state.roles.push({ name, title: `批量角色${index + 1}`, snippets: [], default: false });
    }
  }
  for (let index = 0; index < BULK_DEPARTMENT_COUNT; index += 1) {
    const id = 2001 + index;
    if (!state.departments.some((department) => department.id === id)) {
      state.departments.push({
        id,
        parentId: 1,
        name: `批量部门${String(index + 1).padStart(2, '0')}`,
        dept_code: `BULK${index + 1}`,
        organization_id: 1,
        status: 'active',
        notes: null,
      });
    }
  }
}

function bulkRoleName(index) {
  return `r_bulk_${String(index + 1).padStart(2, '0')}`;
}

/** 初始数据（全部合成，不是任何真实业务数据）。 */
function initialState() {
  return {
    departments: [
      { id: 1, parentId: null, name: '总部', dept_code: 'HQ', organization_id: 1, status: 'active', notes: null },
      { id: 2, parentId: 1, name: '财务部', dept_code: 'FIN', organization_id: 1, status: 'active', notes: null },
      { id: 3, parentId: 1, name: '销售部', dept_code: 'SLS', organization_id: 1, status: 'active', notes: null },
    ],
    organizations: [{ id: 1, name: '示例组织', org_code: 'ORG-1', status: 'active' }],
    users: [
      { id: 1, nickname: '受控管理员', username: 'admin', email: 'main@fixture.test' },
      { id: 2, nickname: '李四', username: 'lisi', email: 'lisi@fixture.test' },
      { id: 101, nickname: '成员甲', username: 'member-a', email: 'a@fixture.test' },
      { id: 102, nickname: '成员乙', username: 'member-b', email: 'b@fixture.test' },
      { id: 103, nickname: '成员丙', username: 'member-c', email: 'c@fixture.test' },
    ],
    roles: [
      { name: 'root', title: 'Root', snippets: ['pm', 'pm.*', 'ui.*'], default: false },
      { name: 'r_sales', title: '销售', snippets: [], default: false },
      { name: 'r_audit', title: '审计', snippets: [], default: false },
    ],
    employees: [
      {
        username: 'employee-a',
        nickname: '数字员工 A',
        position: '助理',
        avatar: 'nocobase-015-male',
        bio: '简介',
        about: '详细介绍',
        greeting: '你好',
        enabled: true,
        builtIn: false,
        category: 'business',
      },
    ],
    conversations: [
      { sessionId: 'session-1', title: '会话一', updatedAt: '2026-10-11T09:00:00.000Z', aiEmployeeUsername: 'employee-a' },
    ],
    /**
     * TD-03 的最小 AI 任务场景（三条，覆盖真实 `readonly` 契约的三种状态）。
     *
     * 真实契约（2.2.20 `aiWorkflowTasks.js`）：
     *   readonly = status !== 'pending_approval' || acceptedUserId !== 当前用户；
     *   `reject` 另有 `status/acceptedUserId` 守卫（非受理人 403 AI_TASK_NOT_REJECTABLE）。
     * 当前登录的合成用户 id=1，因此：
     *  - `ai-task-other`：领取人是 3（张三）→ 非受理人，页面必须只读、终止禁用；
     *  - `ai-task-mine`：领取人是 1 → 受理人，可以决定/终止；
     *  - `ai-task-open`：待领取（acceptedUserId=null）→ readonly 本来就是 true，
     *    但**领取**必须仍然可用（不能一刀切禁用）。
     */
    aiTasks: [
      {
        id: 9001,
        sessionId: 'ai-task-other',
        status: 'pending_approval',
        acceptedUserId: 3,
        jobId: 7001,
        jobStatus: 0,
        read: false,
        createdAt: '2026-10-11T09:00:00.000Z',
        updatedAt: '2026-10-11T09:05:00.000Z',
      },
      {
        id: 9002,
        sessionId: 'ai-task-mine',
        status: 'pending_approval',
        acceptedUserId: 1,
        jobId: 7002,
        jobStatus: 0,
        read: false,
        createdAt: '2026-10-11T09:10:00.000Z',
        updatedAt: '2026-10-11T09:15:00.000Z',
      },
      {
        id: 9003,
        sessionId: 'ai-task-open',
        status: 'pending_acceptance',
        acceptedUserId: null,
        jobId: 7003,
        jobStatus: 0,
        read: false,
        createdAt: '2026-10-11T09:20:00.000Z',
        updatedAt: '2026-10-11T09:20:00.000Z',
      },
    ],
    manualTasks: [
      {
        id: '501',
        userId: 1,
        status: 0,
        nodeId: 501,
        node: { title: '填写报销单', type: 'manual' },
        workflow: { title: '报销审批' },
      },
    ],
    /**
     * 抄送（TD-04）。
     *
     * `userId` 是受理人；真实 `workflowCcTasks:get` 由服务端强制 `userId = 当前用户`，
     * 因此详情读取必须按它过滤（本环境的当前用户是合成管理员 id=1）。
     * `status`: 0=未读、1=已读；`read`/`readAll` 只把 status 置 1 并写 `readAt`，
     * **不推进流程**。
     */
    ccTasks: [
      {
        id: '601',
        userId: 1,
        status: 0,
        readAt: null,
        createdAt: '2026-10-11T09:30:00.000Z',
        nodeId: 601,
        node: { title: '抄送通知', type: 'cc' },
        workflow: { title: '报销审批' },
      },
      {
        id: '602',
        userId: 1,
        status: 1,
        readAt: '2026-10-11T09:40:00.000Z',
        createdAt: '2026-10-11T09:20:00.000Z',
        nodeId: 602,
        node: { title: '审批结果抄送', type: 'cc' },
        workflow: { title: '报销审批' },
      },
    ],
    /**
     * 数据源（DS-01/02）：本环境只有内建主数据源，且已加载；没有外部连接。
     * `displayName` 用后台真实的 i18n 模板形状，页面按既有降级显示为「主数据源」。
     */
    dataSources: [
      {
        key: 'main',
        displayName: '{{t("Main")}}',
        type: 'main',
        isDBInstance: true,
        enabled: true,
        status: 'loaded',
      },
    ],
    /**
     * DS-03/04：最小业务集合与字段（含一条 belongsTo 关系）。
     *
     * `collections:list` 只返回这些**业务**集合；插件集合（users/departments）仍由
     * `collections:get` 单独应答，用于部门关联能力探测，不出现在业务集合管理器里。
     */
    collections: [
      {
        name: 'customers',
        title: '客户',
        description: '合成客户档案（本机数据）',
        autoGenId: true,
        titleField: 'name',
        hidden: false,
      },
      {
        name: 'orders',
        title: '订单',
        description: '合成订单（本机数据）',
        autoGenId: true,
        titleField: 'code',
        hidden: false,
      },
    ],
    fields: {
      customers: [
        { name: 'id', type: 'bigInt', interface: 'integer', sort: 1 },
        { name: 'name', type: 'string', interface: 'input', sort: 2 },
        { name: 'amount', type: 'integer', interface: 'number', sort: 3 },
        { name: 'status', type: 'string', interface: 'select', sort: 4 },
        {
          name: 'owner',
          type: 'belongsTo',
          interface: 'm2o',
          sort: 5,
          target: 'users',
          foreignKey: 'ownerId',
          targetKey: 'id',
        },
        { name: 'createdAt', type: 'date', interface: 'datetime', sort: 6 },
      ],
      orders: [
        { name: 'id', type: 'bigInt', interface: 'integer', sort: 1 },
        { name: 'code', type: 'string', interface: 'input', sort: 2 },
        { name: 'total', type: 'integer', interface: 'number', sort: 3 },
        {
          name: 'customer',
          type: 'belongsTo',
          interface: 'm2o',
          sort: 4,
          target: 'customers',
          foreignKey: 'customerId',
          targetKey: 'id',
        },
      ],
    },
    /** 业务记录（可增改删；`owner`/`customer` 是关系目标，写入时按下划线外键保存）。 */
    records: {
      customers: [
        { id: 1, name: '合成客户甲', amount: 128, status: 'active', ownerId: 2, createdAt: '2026-10-01T02:00:00.000Z' },
        { id: 2, name: '合成客户乙', amount: 256, status: 'paused', ownerId: 101, createdAt: '2026-10-02T03:00:00.000Z' },
        { id: 3, name: '合成客户丙', amount: 64, status: 'active', ownerId: 1, createdAt: '2026-10-03T04:00:00.000Z' },
      ],
      orders: [
        { id: 1, code: 'SO-001', total: 128, customerId: 1 },
        { id: 2, code: 'SO-002', total: 256, customerId: 2 },
      ],
    },
    nextRecordId: { customers: 4, orders: 3 },
    /**
     * DS-03：主库中"尚未纳管"的合成物理表。
     *
     * 真实 2.2.20 的 `dataSources:readTables` 返回 `[{ name }]`（`MainDataSource.readTables()`
     * 把库里尚未映射为集合的表名包成对象），`loadTables` 会把选中的表写成 `collections` 记录
     * （`from: 'dbsync'`）。这里用同名形状的合成数据，让"读取物理表 → 加载为集合 → 反向同步字段"
     * 这条链路可以在本机被人真的走一遍，同时**不触碰任何真实库**。
     *
     * 初始就是**两张**合成物理表（`qa_physical_ledger` / `qa_physical_archive`），用来做
     * "反向同步只作用于当前集合"的判别：给两张表都在元数据里多加一个字段后，只同步其中一张，
     * 另一张（有自己物理结构的合成表）必须原样保留，请求体里也要有 `collections:[当前表]`。
     * 这模拟的是"元数据与物理结构不一致"的场景；**不代表**真实库里新加的字段会被随后同步删掉。
     */
    physicalTables: ['qa_physical_ledger', 'qa_physical_archive'],
    physicalTableFields: {
      qa_physical_ledger: [
        { name: 'id', type: 'bigInt', interface: 'integer', sort: 1 },
        { name: 'memo', type: 'string', interface: 'input', sort: 2 },
      ],
      qa_physical_archive: [
        { name: 'id', type: 'bigInt', interface: 'integer', sort: 1 },
        { name: 'memo', type: 'string', interface: 'input', sort: 2 },
        { name: 'archivedAt', type: 'date', interface: 'datetime', sort: 3 },
      ],
    },
    /** `mainDataSource:refresh` / `syncFields` 的调用记录（控制页可见，便于核对输入与副作用）。 */
    mainDataSourceRuns: [],
    /**
     * AC-01/02：角色成员关系（`rolesUsers` 透视表）是**唯一事实来源**。
     * 用户的 `roles` 由它派生；`users:update {roles:[...]}` 也写回这里，
     * 因此「用户详情改角色」与「角色详情改成员」看到的是同一份数据。
     */
    defaultUserRole: { 1: 'root' },
    /** AC-03：原桌面页面入口授权（按原关系读写）。 */
    desktopRoutes: [
      { id: 11, parentId: null, title: '工作台', type: 'group', sort: 1, schemaUid: 'route:workbench' },
      { id: 12, parentId: 11, title: '我的待办', type: 'page', sort: 2, schemaUid: 'route:workbench.tasks' },
      { id: 13, parentId: null, title: '用户与权限', type: 'group', sort: 3, schemaUid: 'route:access' },
      { id: 14, parentId: 13, title: '用户', type: 'page', sort: 4, schemaUid: 'route:access.users' },
    ],
    roleDesktopRoutes: { root: [11, 12, 13, 14], r_sales: [11, 12] },
    roleMenuSchemas: {
      root: [{ 'x-uid': 'menu:root-home', name: '管理工作台' }],
      r_sales: [{ 'x-uid': 'menu:sales-home', name: '销售工作台' }],
    },

    /** AC-04：数据授权（角色 × 数据源 × 集合 × 动作 × 记录范围）。 */
    roleResources: {
      r_sales: [
        { id: 201, dataSourceKey: 'main', roleName: 'r_sales', name: 'customers', usingActionsConfig: true },
        { id: 202, dataSourceKey: 'main', roleName: 'r_sales', name: 'orders', usingActionsConfig: false },
      ],
    },
    resourceActions: [
      { id: 301, rolesResourceId: 201, name: 'view', fields: ['id', 'name', 'amount', 'status'], scopeId: 1 },
      { id: 302, rolesResourceId: 201, name: 'update', fields: ['status'], scopeId: null },
    ],
    /** 记录范围：两个内置范围用后台真实的 i18n 模板名（页面按既有降级显示中文）。 */
    scopes: [
      { id: 1, key: 'own_records', name: '{{t("Own records")}}', resourceName: '', dataSourceKey: 'main' },
      { id: 2, key: 'all_records', name: '{{t("All records")}}', resourceName: '', dataSourceKey: 'main' },
    ],
    /** 可授权的动作枚举（AC-03/04 的勾选来源）。 */
    availableActions: [
      { name: 'view', displayName: '查看', type: 'old-data', aliases: ['list', 'get'] },
      { name: 'create', displayName: '新增', type: 'new-data', onNewRecord: true },
      { name: 'update', displayName: '修改', type: 'old-data' },
      { name: 'destroy', displayName: '删除', type: 'old-data' },
    ],
    nextResourceId: 203,
    nextResourceActionId: 303,
    nextScopeId: 3,
    deptMembers: { 1: [101] },
    deptRoles: { 1: ['r_sales'] },
    userDepartments: { 2: [1] },
    roleDepartments: { r_sales: [1] },
    roleUsers: { root: [1], r_sales: [2] },
    mainDepartment: { 2: 1 },
    avatar: { 2: { id: 9, url: '/files/fixture/main/attachments/9.png' } },
    scenario: 'normal',
    requestLog: [],
  };
}

let state = initialState();
let nextAttachmentId = 90;

const current = () => SCENARIOS[state.scenario] ?? SCENARIOS.normal;

function applyScenario(name) {
  if (!SCENARIOS[name]) return null;
  state.scenario = name;
  const config = SCENARIOS[name];
  // 每个场景先回到基准关联，再按场景覆盖，避免切换后残留上一场景的关联数据。
  Object.assign(state, baseLinks());
  if (config.emptyLinks) {
    state.deptMembers = { 1: [] };
    state.deptRoles = { 1: [] };
    state.userDepartments = { 2: [] };
    state.roleDepartments = { r_sales: [] };
    state.roleUsers = { r_sales: [] };
  }
  if (config.largeLinks) {
    ensureBulkData();
    state.deptMembers = { 1: Array.from({ length: BULK_MEMBER_COUNT }, (_, index) => 1001 + index) };
    state.deptRoles = { 1: Array.from({ length: BULK_ROLE_COUNT }, (_, index) => bulkRoleName(index)) };
    state.userDepartments = { 2: Array.from({ length: BULK_DEPARTMENT_COUNT }, (_, index) => 2001 + index) };
    state.roleDepartments = {
      r_sales: Array.from({ length: BULK_DEPARTMENT_COUNT }, (_, index) => 2001 + index),
    };
  }
  return { scenario: name, label: config.label, detail: config.detail };
}

function send(response, status, payload) {
  const body = JSON.stringify(payload ?? { data: null });
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(body);
}

/**
 * 列表查询：**真的应用产品发来的过滤条件**，并按分页切片。
 *
 * 之前这里直接返回全部行、忽略 `query.filter`，于是「候选里排除已关联项」这类
 * 由前端拼装的原生过滤条件在本环境里静默失效（例如已关联的 `r_sales` 仍出现在候选里）。
 * 这里只实现本产品实际会用到的原生操作符：`$notIn / $in / $includes / $notIncludes / $ne`
 * 以及 `$and / $or` 与相等比较；未识别的条件保守地按"不匹配"处理，而不是当作全部通过。
 */
function parseFilter(query) {
  const raw = query.filter;
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [value];
}

function matchCondition(row, condition) {
  if (!condition || typeof condition !== 'object') return true;
  return Object.entries(condition).every(([field, expected]) => {
    if (field === '$and') return asArray(expected).every((sub) => matchCondition(row, sub));
    if (field === '$or') return asArray(expected).some((sub) => matchCondition(row, sub));
    const value = row ? row[field] : undefined;
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if ('$notIn' in expected) return !asArray(expected.$notIn).includes(value);
      if ('$in' in expected) return asArray(expected.$in).includes(value);
      if ('$includes' in expected) return String(value ?? '').includes(String(expected.$includes));
      if ('$notIncludes' in expected) return !String(value ?? '').includes(String(expected.$notIncludes));
      if ('$ne' in expected) return value !== expected.$ne;
      return false;
    }
    return value === expected;
  });
}

function applyFilter(rows, query) {
  const filter = parseFilter(query);
  if (!filter) return rows;
  return rows.filter((row) => matchCondition(row, filter));
}

function list(rows, query) {
  const filtered = applyFilter(rows, query);
  const page = Number(query.page ?? 1) || 1;
  const pageSize = Number(query.pageSize ?? 200) || 200;
  const start = (page - 1) * pageSize;
  return {
    data: filtered.slice(start, start + pageSize),
    meta: {
      count: filtered.length,
      page,
      pageSize,
      totalPage: Math.max(1, Math.ceil(filtered.length / pageSize)),
    },
  };
}

/**
 * 解析查询串。
 *
 * **同名参数必须全部保留**：产品对数组参数（axios 默认序列化）发的是
 * `appends[]=roles&appends[]=avatar`；旧实现 `out[key] = value` 会让后一个值覆盖前一个，
 * 于是 fixture 只看到 `avatar`、用户列表丢掉角色（Main 在 5352 被动 CDP 抓到的真实 URL 就是这两项）。
 * 只出现一次的键仍是字符串（既有读取方不变），出现重复时升级为字符串数组。
 */
function parseQuery(raw) {
  const out = {};
  const search = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : '';
  for (const [key, value] of new URLSearchParams(search)) {
    if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = value;
    else out[key] = Array.isArray(out[key]) ? [...out[key], value] : [out[key], value];
  }
  return out;
}

/** 某个查询键的全部取值（同名多值都保留；`appends` 与 `appends[]` 分别取）。 */
function queryValues(query, key) {
  const value = query[key];
  if (value == null) return [];
  return (Array.isArray(value) ? value : [value]).map((item) => String(item));
}

/**
 * 取出关联动作的标识数组。
 *
 * 注意：**不能**写 `body?.values ?? body`——数组自带 `values` 方法（函数），
 * `??` 不会把它当作空值，会得到 `Array.prototype.values`（实测踩过）。
 */
function unwrapValues(body) {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object' && 'values' in body) return body.values;
  return body;
}

function asIds(values) {
  return (Array.isArray(values) ? values : [values]).map((item) => {
    if (item && typeof item === 'object') return item.id ?? item.userId ?? item.departmentId ?? item.roleName;
    return item;
  });
}

const departmentMembers = (id) =>
  (state.deptMembers[id] ?? []).map((userId) => state.users.find((user) => user.id === userId)).filter(Boolean);
const departmentRoles = (id) =>
  (state.deptRoles[id] ?? []).map((name) => state.roles.find((role) => role.name === name)).filter(Boolean);
const userDepartments = (id) =>
  (state.userDepartments[id] ?? [])
    .map((departmentId) => state.departments.find((item) => item.id === departmentId))
    .filter(Boolean);
const roleDepartments = (name) =>
  (state.roleDepartments[name] ?? [])
    .map((departmentId) => state.departments.find((item) => item.id === departmentId))
    .filter(Boolean);
const roleUsers = (name) =>
  (state.roleUsers[name] ?? [])
    .map((userId) => state.users.find((user) => user.id === userId))
    .filter(Boolean);

/* ---------------------------------------------------------------------------
 * AC-01 / AC-02 / AC-03 / AC-04 / DS-03 / DS-04 的派生数据与写入入口
 *
 * 原则：每一类关系只有**一份**事实来源，读接口全部由它派生、写接口全部写回它。
 *  - 角色成员：`state.roleUsers`（`rolesUsers` 透视表）→ 同时决定 `users.roles`、
 *    `roles/<name>/users` 与 `users:listExcludeRole`，因此用户侧与角色侧不会各说各话；
 *  - 数据授权：`state.roleResources` + `state.resourceActions` → 同时供 AC-04 与 DS-05 读取；
 *  - 入口授权：`state.roleDesktopRoutes` / `state.roleMenuSchemas`（字符串 x-uid）；
 *  - 集合字段与记录：`state.fields` / `state.records`。
 * ------------------------------------------------------------------------- */

/** 当前登录的合成用户（认证返回的管理员）。 */
const CURRENT_USER_ID = 1;

/** 某个用户当前的角色（由角色成员关系派生；这就是 `users.roles`）。 */
function rolesOfUser(userId) {
  const id = Number(userId);
  return state.roles.filter((role) => (state.roleUsers[role.name] ?? []).includes(id));
}

/** 改写某个用户的角色集合；`users:update {roles}` 的唯一写入入口。 */
function setUserRoles(userId, roleNames) {
  const id = Number(userId);
  const wanted = new Set(roleNames.map(String));
  for (const role of state.roles) {
    const members = new Set(state.roleUsers[role.name] ?? []);
    if (wanted.has(role.name)) members.add(id);
    else members.delete(id);
    state.roleUsers[role.name] = [...members];
  }
}

/** `rolesUsers` 透视行（`userId` 用字符串，与前端把 URL 参数当字符串过滤一致）。 */
function rolesUsersRows() {
  const rows = [];
  let index = 1;
  for (const role of state.roles) {
    for (const userId of state.roleUsers[role.name] ?? []) {
      rows.push({
        id: index,
        userId: String(userId),
        roleName: role.name,
        default: state.defaultUserRole[userId] === role.name,
      });
      index += 1;
    }
  }
  return rows;
}

/** AC-04：某个角色已授权的资源行。 */
function roleResourcesOf(roleName) {
  return state.roleResources[roleName] ?? [];
}

/** AC-04：某个资源下的动作行（按 `appends=scope` 带回范围对象，与真实契约一致）。 */
function resourceActionsOf(rolesResourceId) {
  return state.resourceActions
    .filter((row) => row.rolesResourceId === Number(rolesResourceId))
    .map((row) => ({
      ...row,
      scope: row.scopeId ? state.scopes.find((scope) => scope.id === row.scopeId) ?? null : null,
    }));
}

/**
 * 写入一处资源授权（`roles:applyDataPermissions` 与 `roles/<role>/resources:update` 共用）。
 *
 * 语义与真实事务动作一致：以资源为单位**整体替换**该资源的动作集合，
 * 未提交的资源不受影响；未提交的 `scopeId` 表示"全部记录"。
 */
function applyResourcePermission(roleName, resource) {
  const list = state.roleResources[roleName] ?? (state.roleResources[roleName] = []);
  let record = list.find((item) => item.name === resource.name);
  if (!record) {
    record = {
      id: state.nextResourceId,
      dataSourceKey: resource.dataSourceKey ?? 'main',
      roleName,
      name: resource.name,
      usingActionsConfig: true,
    };
    state.nextResourceId += 1;
    list.push(record);
  }
  if (resource.usingActionsConfig !== undefined) record.usingActionsConfig = resource.usingActionsConfig !== false;
  if (Array.isArray(resource.actions)) {
    state.resourceActions = state.resourceActions.filter((row) => row.rolesResourceId !== record.id);
    for (const entry of resource.actions) {
      const name = typeof entry?.name === 'string' ? entry.name : '';
      if (!name) continue;
      state.resourceActions.push({
        id: state.nextResourceActionId,
        rolesResourceId: record.id,
        name,
        fields: Array.isArray(entry.fields) ? entry.fields.map(String) : [],
        scopeId: entry.scopeId === undefined || entry.scopeId === null ? null : Number(entry.scopeId),
      });
      state.nextResourceActionId += 1;
    }
  }
  return record;
}

/** AC-03：`roles/<role>/collections` 的集合配置状态（按真实形状，一个集合一行）。 */
function roleCollectionConfigs(roleName) {
  const authorized = new Map(roleResourcesOf(roleName).map((row) => [row.name, row]));
  return state.collections.map((collection, index) => {
    const row = authorized.get(collection.name);
    return {
      id: index + 1,
      name: collection.name,
      title: collection.title,
      collectionName: collection.name,
      // 有独立资源记录 = 有配置；是否自定义动作配置由 `usingActionsConfig` 决定。
      exists: Boolean(row),
      usingConfig: row && row.usingActionsConfig ? 'role' : 'strategy',
    };
  });
}

/** DS-03：某个集合的字段（含关系字段的目标信息）。 */
function fieldsOfCollection(name) {
  return (state.fields[name] ?? []).map((field) => ({ ...field, collectionName: name }));
}

/** DS-03：全部字段（`fields:list`，AC-04 的字段勾选也用它并按 `collectionName` 过滤）。 */
function allFields() {
  return state.collections.flatMap((collection) => fieldsOfCollection(collection.name));
}

/** DS-04：关系目标行（`users` 是内建集合，其余是业务集合）。 */
function relationTargetRows(target) {
  if (target === 'users') return state.users;
  return state.records[target] ?? null;
}

/** DS-04：读出记录时把 belongsTo 关系展开成对象（真实 list/get 的 appends 语义）。 */
function withRelations(collectionName, row) {
  const out = { ...row };
  for (const field of state.fields[collectionName] ?? []) {
    if (typeof field.foreignKey !== 'string' || typeof field.target !== 'string') continue;
    const targetRows = relationTargetRows(field.target);
    const targetKey = field.targetKey ?? 'id';
    const foreignKeyValue = row[field.foreignKey];
    out[field.name] =
      (targetRows ?? []).find((item) => String(item[targetKey]) === String(foreignKeyValue)) ?? null;
  }
  return out;
}

/** 抄送/人工待办的准确计数（`userWorkflowTaskStats:listMine` 按流程聚合）。 */
function taskStatsRows() {
  const manualPending = state.manualTasks.filter((task) => task.status === 0).length;
  const ccPending = state.ccTasks.filter((task) => task.status === 0).length;
  return [
    {
      workflowKey: 'reimburse',
      title: '报销审批',
      stats: { pending: manualPending + ccPending, all: state.manualTasks.length + state.ccTasks.length },
    },
  ];
}

/** `userWorkflowTasks:listMine`：按任务类型聚合的行（不是待办条数）。 */
function taskTypeRows() {
  return [
    {
      id: 1,
      type: 'manual',
      stats: {
        pending: state.manualTasks.filter((task) => task.status === 0).length,
        all: state.manualTasks.length,
      },
    },
    {
      id: 2,
      type: 'cc',
      stats: {
        pending: state.ccTasks.filter((task) => task.status === 0).length,
        all: state.ccTasks.length,
      },
    },
  ];
}

/* ---------------------------------------------------------------------------
 * TD-03 AI 任务（最小场景，精确按真实 2.2.20 契约）
 * ------------------------------------------------------------------------- */

/**
 * 任务详情的 `readonly`：`status !== 'pending_approval' || acceptedUserId !== 当前用户`。
 *
 * 注意：待领取时它**本来就是 true**，所以页面不能拿它一刀切禁用「领取」；
 * 终止与决定则必须遵守它。
 */
function aiTaskReadonly(task) {
  return task.status !== 'pending_approval' || Number(task.acceptedUserId) !== CURRENT_USER_ID;
}

/** 页面展示的形状：任务字段 + `readonly`（不含工具消息，与真实 getBySession 一致）。 */
function aiTaskView(task) {
  return { ...task, readonly: aiTaskReadonly(task) };
}

/**
 * `aiConversations:getMessages` 的工具调用行。
 *
 * 真实形状：消息行**顶层** `toolCalls`，前端工具调用 `name = executeFrontendTool`，
 * 真正的动作在 `args.toolId`（`<uid>:<name>`）——页面用同一份工具定义换成可读题名。
 */
function aiTaskMessages() {
  const call = (id, toolId, args) => ({
    id,
    name: 'executeFrontendTool',
    messageId: 8101,
    invokeStatus: 'interrupted',
    execution: 'frontend',
    willInterrupt: true,
    args: { toolId, args },
  });
  return [
    {
      id: 8101,
      messageId: 8101,
      role: 'assistant',
      toolCalls: [
        call('call-read', 'crewloom:code-workspace:read_code_workspace', {}),
        call('call-apply', 'crewloom:code-workspace:apply_code_change', { code: 'const answer = 42;\n' }),
      ],
    },
  ];
}

/** 关联写动作：先看场景配置的失败状态，再真正改数据。 */
function mutateRelation(parent, child, parentId, action, values) {
  const config = current();
  if (config.writeFailure === 403) return { status: 403, body: { errors: [{ message: 'No permissions' }] } };
  if (config.writeFailure === 401) {
    return { status: 401, body: { errors: [{ message: 'ROLE_NOT_FOUND_FOR_USER', code: 'ROLE_NOT_FOUND_FOR_USER' }] } };
  }
  const ids = asIds(values);
  const mutateSet = (bucket, key, cast) => {
    const set = new Set(bucket[key] ?? []);
    if (action === 'add') ids.forEach((id) => set.add(cast(id)));
    if (action === 'remove') ids.forEach((id) => set.delete(cast(id)));
    if (action === 'set') {
      set.clear();
      ids.forEach((id) => set.add(cast(id)));
    }
    bucket[key] = [...set];
    return set;
  };
  if (parent === 'departments' && child === 'members') {
    mutateSet(state.deptMembers, parentId, Number);
    return { status: 200, body: { data: null } };
  }
  if (parent === 'departments' && child === 'roles') {
    mutateSet(state.deptRoles, parentId, String);
    return { status: 200, body: { data: null } };
  }
  if (parent === 'users' && child === 'departments') {
    const set = mutateSet(state.userDepartments, parentId, Number);
    if (state.mainDepartment[parentId] && !set.has(Number(state.mainDepartment[parentId]))) {
      delete state.mainDepartment[parentId];
    }
    return { status: 200, body: { data: null } };
  }
  if (parent === 'roles' && child === 'departments') {
    mutateSet(state.roleDepartments, parentId, Number);
    return { status: 200, body: { data: null } };
  }
  if (parent === 'roles' && child === 'users') {
    mutateSet(state.roleUsers, parentId, Number);
    return { status: 200, body: { data: null } };
  }
  if (parent === 'roles' && child === 'desktopRoutes') {
    mutateSet(state.roleDesktopRoutes, parentId, Number);
    return { status: 200, body: { data: null } };
  }
  if (parent === 'roles' && child === 'menuUiSchemas') {
    const currentSchemas = state.roleMenuSchemas[parentId] ?? [];
    const byUid = new Map(currentSchemas.map((row) => [String(row['x-uid'] ?? row.uid), row]));
    const upsert = (uid) =>
      byUid.set(String(uid), { 'x-uid': String(uid), name: `菜单 ${uid}` });
    if (action === 'set') byUid.clear();
    if (action !== 'remove') ids.forEach(upsert);
    else ids.forEach((uid) => byUid.delete(String(uid)));
    state.roleMenuSchemas[parentId] = [...byUid.values()];
    return { status: 200, body: { data: null } };
  }
  return null;
}

/**
 * DS-03 字段维护：`collections/<name>/fields:list|get|create|update|destroy`。
 *
 * 真实语义：字段名在集合内唯一；删除集合关系字段会同时移除该字段。
 * 未识别的集合或动作返回 null，由调用方落回本机 404。
 */
function collectionFieldAction(collectionName, action, query, body) {
  const fields = state.fields[collectionName];
  if (!fields) return null;
  const values = (body && typeof body === 'object' && !Array.isArray(body) && 'values' in body ? body.values : body) ?? {};
  if (action === 'list') return { status: 200, body: list(fields, query) };
  if (action === 'get') {
    const field = fields.find((item) => item.name === String(query.filterByTk ?? ''));
    return field
      ? { status: 200, body: { data: field } }
      : { status: 404, body: { errors: [{ message: 'field not found' }] } };
  }
  if (action === 'create') {
    const name = typeof values.name === 'string' ? values.name.trim() : '';
    if (!name) return { status: 400, body: { errors: [{ message: '字段标识不能为空' }] } };
    if (fields.some((item) => item.name === name)) {
      return { status: 400, body: { errors: [{ message: `字段 ${name} 已存在` }] } };
    }
    const field = { type: 'string', sort: fields.length + 1, ...values, name };
    fields.push(field);
    return { status: 200, body: { data: field } };
  }
  if (action === 'update') {
    const name = String(query.filterByTk ?? '');
    const field = fields.find((item) => item.name === name);
    if (!field) return { status: 404, body: { errors: [{ message: 'field not found' }] } };
    Object.assign(field, values, { name });
    return { status: 200, body: { data: field } };
  }
  if (action === 'destroy') {
    const name = String(query.filterByTk ?? '');
    const index = fields.findIndex((item) => item.name === name);
    if (index < 0) return { status: 404, body: { errors: [{ message: 'field not found' }] } };
    fields.splice(index, 1);
    return { status: 200, body: { data: null } };
  }
  return null;
}

/**
 * DS-04 业务记录：`<collection>:list|get|create|update|destroy|query`。
 *
 * 只对**已声明为业务集合**的名字生效（`state.records` 里有它），
 * 其它名字返回 null，由调用方继续走各自的资源处理或落回 404。
 */
function recordAction(collectionName, action, query, body) {
  const rows = state.records[collectionName];
  if (!rows) return null;
  const values = (body && typeof body === 'object' && !Array.isArray(body) && 'values' in body ? body.values : body) ?? {};
  if (action === 'list') return { status: 200, body: list(rows.map((row) => withRelations(collectionName, row)), query) };
  if (action === 'get') {
    const row = rows.find((item) => String(item.id) === String(query.filterByTk ?? ''));
    return row
      ? { status: 200, body: { data: withRelations(collectionName, row) } }
      : { status: 404, body: { errors: [{ message: 'record not found' }] } };
  }
  if (action === 'create') {
    const id = state.nextRecordId[collectionName];
    state.nextRecordId[collectionName] = id + 1;
    const row = { id, ...values };
    rows.push(row);
    return { status: 200, body: { data: withRelations(collectionName, row) } };
  }
  if (action === 'update') {
    const row = rows.find((item) => String(item.id) === String(query.filterByTk ?? ''));
    if (!row) return { status: 404, body: { errors: [{ message: 'record not found' }] } };
    for (const [key, value] of Object.entries(values)) {
      if (key === 'id') continue;
      if (value === null) delete row[key];
      else row[key] = value;
    }
    return { status: 200, body: { data: withRelations(collectionName, row) } };
  }
  if (action === 'destroy') {
    const index = rows.findIndex((item) => String(item.id) === String(query.filterByTk ?? ''));
    if (index < 0) return { status: 404, body: { errors: [{ message: 'record not found' }] } };
    rows.splice(index, 1);
    return { status: 200, body: { data: null } };
  }
  if (action === 'query') {
    // 聚合：只实现真实的 count/sum/avg/min/max 与按维度分组，不发明新的表达式。
    const measures = Array.isArray(values.measures) ? values.measures : [];
    const dimensions = Array.isArray(values.dimensions) ? values.dimensions.map(String) : [];
    const filter = values.filter && typeof values.filter === 'object' ? values.filter : null;
    const filtered = filter ? rows.filter((row) => matchCondition(row, filter)) : rows;
    const groups = new Map();
    for (const row of filtered) {
      const key = dimensions.map((dimension) => String(row[dimension] ?? '')).join('\u0000');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    const data = [...groups.values()].map((group) => {
      const out = {};
      for (const dimension of dimensions) out[dimension] = group[0][dimension] ?? null;
      for (const measure of measures) {
        const aggregation = String(measure?.aggregation ?? 'count');
        const field = typeof measure?.field === 'string' ? measure.field : '';
        const numbers = field
          ? group.map((row) => Number(row[field])).filter((value) => Number.isFinite(value))
          : group.map(() => 1);
        const key = field || 'count';
        if (aggregation === 'sum') out[key] = numbers.reduce((left, right) => left + right, 0);
        else if (aggregation === 'avg') out[key] = numbers.length > 0 ? numbers.reduce((a, b) => a + b, 0) / numbers.length : null;
        else if (aggregation === 'min') out[key] = numbers.length > 0 ? Math.min(...numbers) : null;
        else if (aggregation === 'max') out[key] = numbers.length > 0 ? Math.max(...numbers) : null;
        else out[key] = numbers.length;
      }
      return out;
    });
    return { status: 200, body: { data } };
  }
  return null;
}

/** 关联读取：按场景返回 200 或失败状态（用于区分"未开通"与"已开通但读取失败"）。 */
function readRelation(result) {
  const config = current();
  if (config.associationReadStatus !== 200) {
    return { status: config.associationReadStatus, body: { errors: [{ message: 'association read failed' }] } };
  }
  return { status: 200, body: result };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const escapeHtml = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 控制页（只在 fixture 端口上，不进产品构建）。 */
function controlPage() {
  const config = current();
  const buttons = Object.entries(SCENARIOS)
    .map(
      ([key, item]) =>
        `<button class="scenario ${key === state.scenario ? 'active' : ''}" data-scenario="${escapeHtml(key)}">` +
        `${escapeHtml(item.label)}<small>${escapeHtml(item.detail)}</small></button>`,
    )
    .join('\n');
  const rows = state.requestLog
    .slice(-40)
    .reverse()
    .map(
      (entry) =>
        `<tr><td>${escapeHtml(entry.method)}</td><td>${escapeHtml(entry.path)}${entry.unimplemented ? ' ⚠️未实现' : ''}</td>` +
        `<td>${escapeHtml(JSON.stringify(entry.query ?? {}))}</td>` +
        `<td>${escapeHtml(typeof entry.body === 'string' ? entry.body : JSON.stringify(entry.body ?? null))}</td></tr>`,
    )
    .join('\n');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>Crewloom 本机合成验收环境（${PORT}）</title>
<style>
 body{font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:24px;color:#1f2328;max-width:1080px}
 h1{font-size:20px;margin:0 0 4px} h2{font-size:15px;margin:24px 0 8px}
 .banner{background:#fff4e5;border:1px solid #ffd8a8;padding:10px 12px;border-radius:8px;margin:12px 0}
 .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:8px}
 .scenario{text-align:left;padding:10px 12px;border:1px solid #d0d7de;border-radius:8px;background:#fff;cursor:pointer}
 .scenario small{display:block;color:#57606a;font-weight:400;margin-top:4px}
 .scenario.active{border-color:#0969da;background:#ddf4ff}
 code{background:#f6f8fa;padding:1px 5px;border-radius:4px}
 table{border-collapse:collapse;width:100%;font-size:12px} td,th{border:1px solid #d0d7de;padding:4px 6px;vertical-align:top}
 th{background:#f6f8fa;text-align:left}
 a{color:#0969da} pre{background:#f6f8fa;padding:8px;border-radius:6px;overflow:auto;font-size:12px}
</style></head><body>
<h1>Crewloom 本机合成验收环境</h1>
<div class="banner">
 <strong>这不是真实实例。</strong>本服务只绑定 <code>127.0.0.1:${PORT}</code>，数据全部为合成数据；
 未实现的接口返回本机 404（不会转发到 172.16.88.250 或任何外部地址）。
 产品界面在 <a href="${escapeHtml(PRODUCT_URL)}/login" target="_blank">${escapeHtml(PRODUCT_URL)}</a>，其 /api 代理已指向本服务。
</div>
<p>合成账号：<code>${escapeHtml(SYNTHETIC_ACCOUNT.email)}</code>　密码：<code>${escapeHtml(SYNTHETIC_ACCOUNT.password)}</code>
（也接受任意非空账号密码，登录后都是同一个合成管理员；与真实实例的认证无关）</p>
<p>当前场景：<strong>${escapeHtml(config.label)}</strong> — ${escapeHtml(config.detail)}</p>
<p>可交互范围（全部本机合成数据）：部门四方向关联；用户资料与角色绑定；角色成员；
入口授权（原页面路由 / 菜单界面 / 权限片段）；数据授权（资源动作、字段、记录范围）；
数据源与业务集合、字段、关系、业务记录增改删；抄送列表的读取、单条已读/未读与全部已读。
计数（待办/未读）由当前合成数据实时算出，标记已读后立即变化。</p>

<h2>一键切换场景</h2>
<div class="grid" id="scenarios">${buttons}</div>
<p><button id="reset">恢复合成初始数据</button>　<button id="refresh">刷新本页</button></p>

<h2>TD-03 AI 任务场景（当前登录用户 id=1；新标签正常登录后打开）</h2>
<ul>
 <li><a href="${escapeHtml(PRODUCT_URL)}/tasks/ai?sessionId=ai-task-other" target="_blank">非受理人</a>
     — 领取人 3（张三），页面应显示「当前只读」，「终止任务」与决定全部禁用</li>
 <li><a href="${escapeHtml(PRODUCT_URL)}/tasks/ai?sessionId=ai-task-mine" target="_blank">受理人本人</a>
     — 领取人 1（当前用户），「终止任务」可用（仍需二次确认）</li>
 <li><a href="${escapeHtml(PRODUCT_URL)}/tasks/ai?sessionId=ai-task-open" target="_blank">待领取</a>
     — 「领取任务」必须可用（待领取时 readonly 本来就是 true）</li>
</ul>

<h2>合成数据现状</h2>
<pre id="state">加载中…</pre>

<h2>应用发出的请求（最近 40 条，倒序）</h2>
<table><thead><tr><th>方法</th><th>路径</th><th>查询</th><th>请求体</th></tr></thead><tbody id="log">${rows}</tbody></table>

<script>
function post(path){ return fetch(path,{method:'POST'}).then(()=>location.reload()); }
for (const button of document.querySelectorAll('.scenario')) {
  button.addEventListener('click', () => post('/__fixture/scenario?name=' + encodeURIComponent(button.dataset.scenario)));
}
document.getElementById('reset').addEventListener('click', () => post('/__fixture/reset'));
document.getElementById('refresh').addEventListener('click', () => location.reload());
fetch('/__fixture/state').then(r=>r.json()).then(j=>{
  document.getElementById('state').textContent = JSON.stringify(j.data,null,2);
});
</script></body></html>`;
}

const server = createServer((request, response) => {
  void (async () => {
    const rawUrl = request.url ?? '/';
    const path = rawUrl.split('?')[0];
    const query = parseQuery(rawUrl);
    const method = (request.method ?? 'GET').toUpperCase();
    const rawBody = await readBody(request);

    /* ---------------- 控制面（不记录进业务日志） ---------------- */
    if (path === '/' && method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(controlPage());
      return;
    }
    if (path === '/__fixture/scenarios') {
      send(response, 200, {
        data: Object.entries(SCENARIOS).map(([key, item]) => ({ key, label: item.label, detail: item.detail })),
        current: state.scenario,
      });
      return;
    }
    if (path === '/__fixture/scenario') {
      const name = String(query.name ?? (rawBody ? JSON.parse(rawBody).scenario : ''));
      const applied = applyScenario(name);
      send(response, applied ? 200 : 400, applied ? { data: applied } : { errors: [{ message: `未知场景：${name}` }] });
      return;
    }
    if (path === '/__fixture/reset') {
      state = initialState();
      nextAttachmentId = 90;
      send(response, 200, { data: 'ok' });
      return;
    }
    if (path === '/__fixture/log') {
      send(response, 200, { data: state.requestLog });
      return;
    }
    if (path === '/__fixture/state') {
      send(response, 200, {
        data: {
          scenario: state.scenario,
          scenarioLabel: current().label,
          pluginEnabled: current().pluginEnabled,
          associationReadStatus: current().associationReadStatus,
          usersAvatarField: current().usersAvatarField,
          writeFailure: current().writeFailure,
          departments: state.departments,
          users: state.users,
          roles: state.roles,
          employees: state.employees.map((item) => ({ username: item.username, avatar: item.avatar })),
          deptMembers: state.deptMembers,
          deptRoles: state.deptRoles,
          userDepartments: state.userDepartments,
          roleDepartments: state.roleDepartments,
          roleUsers: state.roleUsers,
          defaultUserRole: state.defaultUserRole,
          mainDepartment: state.mainDepartment,
          avatar: state.avatar,
          dataSources: state.dataSources,
          collections: state.collections,
          fields: state.fields,
          records: state.records,
          physicalTables: state.physicalTables,
          physicalTableFields: state.physicalTableFields,
          mainDataSourceRuns: state.mainDataSourceRuns,
          manualTasks: state.manualTasks,
          ccTasks: state.ccTasks,
          aiTasks: state.aiTasks.map((task) => aiTaskView(task)),
          desktopRoutes: state.desktopRoutes,
          roleDesktopRoutes: state.roleDesktopRoutes,
          roleMenuSchemas: state.roleMenuSchemas,
          roleResources: state.roleResources,
          resourceActions: state.resourceActions,
          scopes: state.scopes,
          availableActions: state.availableActions,
          taskStats: taskStatsRows(),
          unimplementedPaths: [...new Set(state.requestLog.filter((entry) => entry.unimplemented).map((entry) => entry.path))],
        },
      });
      return;
    }

    /* ---------------- 文件访问（头像 <img src>）：1x1 PNG ---------------- */
    if (path.startsWith('/files/')) {
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        'base64',
      );
      response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      response.end(png);
      return;
    }

    if (!path.startsWith('/api/')) {
      send(response, 404, { errors: [{ message: '本机合成环境只有 /api/** 与 /files/**' }] });
      return;
    }

    const apiPath = path.slice('/api/'.length);
    let body = null;
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }

    const logged = {
      method,
      path: apiPath,
      query,
      body:
        typeof body === 'string' && body.includes('name="file"')
          ? { multipart: true, fields: [...body.matchAll(/name="([^"]+)"/g)].map((match) => match[1]) }
          : body,
    };
    state.requestLog.push(logged);

    const config = current();
    const handle = () => {
      /* ---------------- 认证（合成） ---------------- */
      if (apiPath === 'authenticators:publicList') {
        return { status: 200, body: { data: [{ name: 'basic', authType: 'basic', options: {} }] } };
      }
      if (apiPath === 'auth:signIn') {
        const values = body && typeof body === 'object' ? body : {};
        if (!values.email || !values.password) {
          return { status: 401, body: { errors: [{ message: '请输入账号与密码' }] } };
        }
        return {
          status: 200,
          body: { data: { token: 'fixture-token', user: { id: 1, nickname: '受控管理员', email: String(values.email) } } },
        };
      }
      if (apiPath === 'auth:signOut') return { status: 200, body: { data: null } };
      if (apiPath === 'auth:check') {
        return {
          status: 200,
          body: {
            data: {
              id: 1,
              nickname: '受控管理员',
              email: SYNTHETIC_ACCOUNT.email,
              roles: [{ name: 'root', title: 'Root' }],
            },
          },
        };
      }
      if (apiPath === 'roles:check') {
        return {
          status: 200,
          body: {
            data: {
              role: 'root',
              roleMode: 'default',
              strategy: null,
              actions: {},
              resources: [],
              snippets: ['pm', 'pm.*', 'ui.*'],
              allowAll: true,
              allowConfigure: true,
              allowAnonymous: false,
              allowMenuItemIds: [],
              uiButtonSchemasBlacklist: [],
              availableActions: [],
              actionAlias: { list: 'view' },
              roles: ['root'],
            },
          },
        };
      }
      if (apiPath === 'app:getLang') return { status: 200, body: { data: { lang: 'zh-CN', resources: {} } } };
      if (apiPath === 'app:getInfo') {
        return { status: 200, body: { data: { version: '2.2.20-synthetic', lang: 'zh-CN', name: '本机合成环境' } } };
      }
      if (apiPath === 'systemSettings:get') {
        return {
          status: 200,
          body: { data: { title: '本机合成验收环境', appLang: 'zh-CN', enabledLanguages: ['zh-CN', 'en'] } },
        };
      }
      if (apiPath === 'storages:getBasicInfo') {
        return {
          status: 200,
          body: {
            data: { id: 1, name: 'fixture-local', type: 'local', title: '合成存储', public: null, rules: { size: 20971520 } },
          },
        };
      }
      if (apiPath === 'attachments:upload') {
        const id = nextAttachmentId++;
        return {
          status: 200,
          body: {
            data: { id, filename: 'avatar.png', mimetype: 'image/png', size: 12, url: `/files/fixture/main/attachments/${id}.png` },
          },
        };
      }

      /* ---------------- 集合元数据（能力判定依据） ---------------- */
      if (apiPath === 'collections:get') {
        const name = String(query.filterByTk ?? '');
        if (name === 'users') {
          const fields = [{ name: 'id' }, { name: 'nickname' }, { name: 'username' }, { name: 'roles' }];
          if (config.usersAvatarField) fields.splice(3, 0, { name: 'avatar' });
          return { status: 200, body: { data: { name: 'users', fields } } };
        }
        if (name === 'departments') {
          const fields = [
            { name: 'id' },
            { name: 'name' },
            { name: 'dept_code' },
            { name: 'parentId' },
            { name: 'organization_id' },
          ];
          if (config.pluginEnabled) {
            fields.push({ name: 'title' }, { name: 'isLeaf' }, { name: 'members' }, { name: 'roles' }, { name: 'owners' });
          }
          return { status: 200, body: { data: { name: 'departments', fields } } };
        }
        if (name === 'departmentsUsers' || name === 'departmentsRoles') {
          if (!config.pluginEnabled) return { status: 404, body: { errors: [{ message: 'collection not found' }] } };
          return { status: 200, body: { data: { name, fields: [{ name: 'id' }, { name: 'departmentId' }] } } };
        }
        // DS-03：业务集合详情（含字段清单；`appends=fields` 时与真实响应一致地带上 fields）。
        const collection = state.collections.find((item) => item.name === name);
        if (collection) {
          return { status: 200, body: { data: { ...collection, fields: fieldsOfCollection(name) } } };
        }
        return { status: 404, body: { errors: [{ message: 'collection not found' }] } };
      }

      /* ---------------- 数据源（DS-01 / DS-02） ---------------- */
      if (apiPath === 'dataSources:list') return { status: 200, body: list(state.dataSources, query) };
      if (apiPath === 'dataSources:listEnabled') {
        return { status: 200, body: list(state.dataSources.filter((item) => item.enabled !== false), query) };
      }
      if (apiPath === 'dataSources:get') {
        const dataSource = state.dataSources.find((item) => item.key === String(query.filterByTk ?? ''));
        return dataSource
          ? { status: 200, body: { data: dataSource } }
          : { status: 404, body: { errors: [{ message: 'data source not found' }] } };
      }

      /* ---------------- 集合与字段（DS-03） ---------------- */
      if (apiPath === 'collections:list') return { status: 200, body: list(state.collections, query) };
      if (apiPath === 'fields:list') return { status: 200, body: list(allFields(), query) };
      if (apiPath === 'collections:create') {
        const values = body?.values ?? body ?? {};
        const name = typeof values.name === 'string' ? values.name.trim() : '';
        if (!name) return { status: 400, body: { errors: [{ message: '集合标识不能为空' }] } };
        if (state.collections.some((item) => item.name === name) || state.fields[name]) {
          return { status: 400, body: { errors: [{ message: `集合 ${name} 已存在` }] } };
        }
        const collection = {
          name,
          title: values.title ?? name,
          description: values.description ?? '',
          autoGenId: values.autoGenId !== false,
          titleField: values.titleField ?? null,
          hidden: values.hidden === true,
        };
        state.collections.push(collection);
        state.fields[name] = [{ name: 'id', type: 'bigInt', interface: 'integer', sort: 1 }];
        state.records[name] = [];
        state.nextRecordId[name] = 1;
        return { status: 200, body: { data: collection } };
      }
      if (apiPath === 'collections:update') {
        const name = String(query.filterByTk ?? '');
        const collection = state.collections.find((item) => item.name === name);
        if (!collection) return { status: 404, body: { errors: [{ message: 'collection not found' }] } };
        const values = body?.values ?? body ?? {};
        for (const key of ['title', 'description', 'autoGenId', 'titleField', 'hidden']) {
          if (Object.prototype.hasOwnProperty.call(values, key)) collection[key] = values[key];
        }
        return { status: 200, body: { data: collection } };
      }
      if (apiPath === 'collections:destroy') {
        const name = String(query.filterByTk ?? '');
        const index = state.collections.findIndex((item) => item.name === name);
        if (index < 0) return { status: 404, body: { errors: [{ message: 'collection not found' }] } };
        state.collections.splice(index, 1);
        delete state.fields[name];
        delete state.records[name];
        delete state.nextRecordId[name];
        // 资源授权指向已删除集合时一并清理，避免留下指向不存在集合的授权行。
        for (const roleName of Object.keys(state.roleResources)) {
          const removed = state.roleResources[roleName].filter((row) => row.name === name);
          state.resourceActions = state.resourceActions.filter(
            (row) => !removed.some((item) => item.id === row.rolesResourceId),
          );
          state.roleResources[roleName] = state.roleResources[roleName].filter((row) => row.name !== name);
        }
        return { status: 200, body: { data: null } };
      }
      if (apiPath === 'dataSources:readTables') {
        // 真实 2.2.20：`MainDataSource.readTables()` 返回库里尚未映射为集合的表，形状是 `[{ name }]`。
        const managed = new Set(state.collections.map((item) => item.name));
        const tables = state.physicalTables
          .filter((name) => !managed.has(name))
          .map((name) => ({ name }));
        return { status: 200, body: { data: tables } };
      }
      if (apiPath === 'dataSources:loadTables') {
        // 真实 2.2.20：`MainDataSource.loadTables` 把物理表写成 `collections` 记录（`from: 'dbsync'`）。
        const values = body?.values ?? body ?? {};
        const requested = Array.isArray(values.tables) ? values.tables.map(String) : [];
        if (requested.length === 0) {
          return { status: 400, body: { errors: [{ message: '请先选择要加载的物理表' }] } };
        }
        const loaded = [];
        for (const name of requested) {
          if (state.collections.some((item) => item.name === name)) continue;
          if (!state.physicalTables.includes(name)) continue;
          const fields = state.physicalTableFields[name] ?? [
            { name: 'id', type: 'bigInt', interface: 'integer', sort: 1 },
          ];
          state.collections.push({
            name,
            title: name,
            description: '由物理表加载（本机合成）',
            autoGenId: true,
            titleField: null,
            hidden: false,
            from: 'dbsync',
          });
          state.fields[name] = fields.map((field, index) => ({ ...field, sort: field.sort ?? index + 1 }));
          state.records[name] = [];
          state.nextRecordId[name] = 1;
          state.physicalTables = state.physicalTables.filter((table) => table !== name);
          loaded.push(name);
        }
        if (loaded.length === 0) {
          return { status: 400, body: { errors: [{ message: '没有可加载的物理表（表不存在或已纳管）' }] } };
        }
        return { status: 200, body: { data: loaded.map((name) => ({ name })) } };
      }
      if (apiPath === 'mainDataSource:refresh') {
        // 真实 2.2.20：不接收 values；`main` 已 loaded 时 `plugin.loadCollections()` 重新 import
        // 插件自带的集合定义——不扫描物理表、不重建字段、不改业务数据（没有该目录时是空操作）。
        state.mainDataSourceRuns.push({ action: 'refresh', values: body?.values ?? body ?? null });
        return { status: 200, body: { data: null } };
      }
      if (apiPath === 'mainDataSource:syncFields') {
        // 真实 2.2.20：`MainDataSource.syncFieldsFromDatabase(ctx, values.collections)`，按物理表重建
        // 字段记录（物理表里没有的字段记录会被删除）。本机只对**已知合成物理结构**的集合这样做，
        // 未知物理结构时如实不改动（不假装重建）。
        // 这里的"缺省 = 全部集合"就是真实语义（59 已证实），所以产品**必须**显式带 `collections`：
        // 否则请求体 `{}` 会落到全部集合，与详情页"该集合"的说法不符。
        const values = body?.values ?? body ?? {};
        const requested = Array.isArray(values.collections) ? values.collections.map(String) : [];
        const targets = requested.length > 0 ? requested : state.collections.map((item) => item.name);
        const rebuilt = [];
        for (const name of targets) {
          if (!state.collections.some((item) => item.name === name)) continue;
          const physical = state.physicalTableFields[name];
          if (!physical) continue;
          state.fields[name] = physical.map((field, index) => ({ ...field, sort: field.sort ?? index + 1 }));
          rebuilt.push(name);
        }
        state.mainDataSourceRuns.push({ action: 'syncFields', values, rebuilt });
        return { status: 200, body: { data: null } };
      }

      /* ---------------- 目录数据 ---------------- */
      if (apiPath === 'departments:list') return { status: 200, body: list(state.departments, query) };
      if (apiPath === 'organizations:list') return { status: 200, body: list(state.organizations, query) };
      if (apiPath === 'roles:list') return { status: 200, body: list(state.roles, query) };
      if (apiPath === 'roles:get') {
        const role = state.roles.find((item) => item.name === String(query.filterByTk ?? ''));
        return role ? { status: 200, body: { data: role } } : { status: 404, body: { errors: [{ message: 'not found' }] } };
      }
      if (apiPath === 'roles:update') {
        const role = state.roles.find((item) => item.name === String(query.filterByTk ?? ''));
        if (!role) return { status: 404, body: { errors: [{ message: 'role not found' }] } };
        const values = body?.values ?? body ?? {};
        for (const key of ['title', 'snippets', 'strategy', 'default', 'allowConfigure']) {
          if (Object.prototype.hasOwnProperty.call(values, key)) role[key] = values[key];
        }
        return { status: 200, body: { data: role } };
      }
      if (apiPath === 'roles:applyDataPermissions') {
        const roleName = String(query.filterByTk ?? '');
        if (!state.roles.some((role) => role.name === roleName)) {
          return { status: 404, body: { errors: [{ message: 'role not found' }] } };
        }
        const values = body?.values ?? body ?? {};
        const resources = Array.isArray(values.resources) ? values.resources : [];
        if (resources.length === 0) {
          return { status: 400, body: { errors: [{ message: 'resources 不能为空' }] } };
        }
        const updated = resources.map((resource) =>
          applyResourcePermission(roleName, { dataSourceKey: values.dataSourceKey ?? 'main', ...resource }),
        );
        return { status: 200, body: { data: { updated: updated.length } } };
      }
      if (apiPath === 'users:list') {
        // 真实 2.2.20 契约：产品请求 `appends: ['roles', 'avatar']` 时，列表行必须带与 `users:get`
        // **同源**的角色与头像。此前列表直接返回原始 users，导致"列表显示未分配、详情却已有销售/审计"。
        // 这里从唯一的 `state.roleUsers`（rolesUsers 透视表）与 `state.avatar` 派生，不伪造全体角色。
        // axios 对数组参数默认序列化成 `appends[]=roles&appends[]=avatar`：**同名多值都要算**，
        // 只看单个值会让 roles 被 avatar 覆盖而丢失（Main 5352 被动 CDP 实测的正是这种组合）。
        const appends = [...queryValues(query, 'appends'), ...queryValues(query, 'appends[]')];
        const wantsRoles = appends.includes('roles');
        // 头像只在集合真有 avatar 字段时返回（与 `users:get` 的既有规则一致，不凭空出现）。
        const wantsAvatar = appends.includes('avatar') && config.usersAvatarField;
        const rows = state.users.map((user) => {
          const row = { ...user };
          if (wantsRoles) row.roles = rolesOfUser(user.id);
          if (wantsAvatar) row.avatar = state.avatar[user.id] ?? null;
          return row;
        });
        return { status: 200, body: list(rows, query) };
      }
      if (apiPath === 'users:listExcludeRole') {
        // 角色成员方向的候选：真实产品动作按 `roleName` 由服务端排除已在角色内的用户。
        const inRole = new Set(state.roleUsers[String(query.roleName ?? '')] ?? []);
        const candidates = state.users.filter((user) => !inRole.has(user.id));
        return { status: 200, body: list(candidates, query) };
      }
      if (apiPath === 'users:create') {
        const values = body?.values ?? body ?? {};
        const id = Math.max(0, ...state.users.map((user) => Number(user.id) || 0)) + 1;
        const user = {
          id,
          nickname: values.nickname ?? '',
          username: values.username ?? '',
          email: values.email ?? '',
        };
        state.users.push(user);
        setUserRoles(id, Array.isArray(values.roles) ? values.roles.map(String) : []);
        return { status: 200, body: { data: { ...user, roles: rolesOfUser(id) } } };
      }
      if (apiPath === 'users:destroy') {
        const id = Number(query.filterByTk);
        const index = state.users.findIndex((user) => user.id === id);
        if (index < 0) return { status: 404, body: { errors: [{ message: 'not found' }] } };
        state.users.splice(index, 1);
        setUserRoles(id, []);
        delete state.avatar[id];
        delete state.mainDepartment[id];
        return { status: 200, body: { data: null } };
      }
      if (apiPath === 'users:setDefaultRole') {
        const values = body?.values ?? body ?? {};
        // 原生 handler 只允许改**当前登录用户自己**的默认角色。
        if (values.roleName) state.defaultUserRole[CURRENT_USER_ID] = String(values.roleName);
        return { status: 200, body: { data: null } };
      }
      if (apiPath === 'rolesUsers:list') return { status: 200, body: list(rolesUsersRows(), query) };
      if (apiPath === 'availableActions:list') return { status: 200, body: list(state.availableActions, query) };
      if (apiPath === 'desktopRoutes:list') return { status: 200, body: list(state.desktopRoutes, query) };
      if (apiPath === 'dataSourcesRolesResourcesActions:list') {
        return {
          status: 200,
          body: list(
            state.resourceActions.map((row) => ({
              ...row,
              scope: row.scopeId ? state.scopes.find((scope) => scope.id === row.scopeId) ?? null : null,
            })),
            query,
          ),
        };
      }
      if (apiPath === 'dataSourcesRolesResourcesScopes:list') {
        return { status: 200, body: list(state.scopes, query) };
      }
      if (apiPath === 'dataSourcesRolesResourcesScopes:create') {
        const values = body?.values ?? body ?? {};
        const id = state.nextScopeId;
        state.nextScopeId += 1;
        const scope = {
          id,
          key: typeof values.key === 'string' && values.key ? values.key : `scope_${id}`,
          name: values.name ?? '',
          resourceName: values.resourceName ?? '',
          dataSourceKey: values.dataSourceKey ?? 'main',
          scope: values.scope ?? {},
        };
        state.scopes.push(scope);
        return { status: 200, body: { data: scope } };
      }

      if (apiPath === 'users:get') {
        const id = Number(query.filterByTk);
        const user = state.users.find((item) => item.id === id);
        if (!user) return { status: 404, body: { errors: [{ message: 'not found' }] } };
        const data = {
          ...user,
          // `users.roles` 由角色成员关系派生，因此用户详情与角色详情永远一致。
          roles: rolesOfUser(id),
          mainDepartmentId: state.mainDepartment[id] ?? null,
        };
        // 只有集合里真的有 avatar 字段时才返回该键（与真实实例一致：不凭空出现）。
        if (config.usersAvatarField) data.avatar = state.avatar[id] ?? null;
        return { status: 200, body: { data } };
      }
      if (apiPath === 'users:update') {
        const id = Number(query.filterByTk);
        const values = body?.values ?? body ?? {};
        // 真实 `users:update` 会把提交的字段写进记录，随后的 `users:get`/`users:list` 返回新值。
        // 之前只处理 avatar/mainDepartmentId，nickname/username/email/phone 被静默丢弃：
        // 响应 200、页面又显式 refetch，但记录没变（假成功）。这里按真实语义持久化这四个资料字段。
        const user = state.users.find((item) => item.id === id);
        if (!user) return { status: 404, body: { errors: [{ message: 'not found' }] } };
        for (const field of ['nickname', 'username', 'email', 'phone']) {
          if (!Object.prototype.hasOwnProperty.call(values, field)) continue;
          const next = values[field];
          if (next === null) delete user[field];
          else if (next !== undefined) user[field] = next;
        }
        // `roles` 是引用语义（角色名数组）：一次请求内完成绑定，写回角色成员关系。
        if (Object.prototype.hasOwnProperty.call(values, 'roles')) {
          const names = Array.isArray(values.roles)
            ? values.roles
                .map((item) => (item && typeof item === 'object' ? item.name : item))
                .filter((item) => item !== null && item !== undefined && item !== '')
                .map(String)
            : [];
          setUserRoles(id, names);
        }
        if (Object.prototype.hasOwnProperty.call(values, 'avatar')) {
          if (values.avatar && values.avatar.id != null) {
            state.avatar[id] = { id: values.avatar.id, url: `/files/fixture/main/attachments/${values.avatar.id}.png` };
          } else {
            delete state.avatar[id];
          }
        }
        if (Object.prototype.hasOwnProperty.call(values, 'mainDepartmentId')) {
          if (values.mainDepartmentId == null) delete state.mainDepartment[id];
          else state.mainDepartment[id] = Number(values.mainDepartmentId);
        }
        return { status: 200, body: { data: { ...user, roles: rolesOfUser(id) } } };
      }

      /* ---------------- 数字员工（AI-02 头像） ---------------- */
      if (apiPath === 'aiEmployees:create') {
        // 真实 2.2.20 契约：`aiEmployees` 以 `username` 为唯一键；重复创建必须 400，不能假 200。
        const values = body?.values ?? body ?? {};
        const username = String(values.username ?? '').trim();
        if (!username) {
          return { status: 400, body: { errors: [{ code: 'INVALID_USERNAME', message: 'username is required' }] } };
        }
        if (state.employees.some((item) => item.username === username)) {
          return { status: 400, body: { errors: [{ code: 'UNIQUE_VIOLATION', message: 'username already exists' }] } };
        }
        const employee = {
          username,
          nickname: values.nickname ?? username,
          position: values.position ?? '',
          avatar: values.avatar ?? null,
          bio: values.bio ?? '',
          enabled: values.enabled === undefined ? true : Boolean(values.enabled),
          modelSettings: values.modelSettings ?? {},
          createdAt: new Date().toISOString(),
        };
        state.employees.push(employee);
        return { status: 200, body: { data: employee } };
      }
      if (apiPath === 'aiEmployees:get') {
        const employee = state.employees.find((item) => item.username === String(query.filterByTk ?? ''));
        return employee
          ? { status: 200, body: { data: employee } }
          : { status: 404, body: { errors: [{ message: 'not found' }] } };
      }
      if (apiPath === 'aiEmployees:update') {
        const username = String(query.filterByTk ?? '');
        const values = body?.values ?? body ?? {};
        const employee = state.employees.find((item) => item.username === username) ?? state.employees[0];
        Object.assign(employee, values);
        return { status: 200, body: { data: employee } };
      }
      if (apiPath === 'aiEmployees:list') return { status: 200, body: list(state.employees, query) };
      if (apiPath === 'aiEmployees:listByUser') {
        return { status: 200, body: list(state.employees.filter((item) => item.enabled !== false), query) };
      }
      if (apiPath === 'aiTools:list') return { status: 200, body: list([], query) };
      if (apiPath === 'aiSkills:list') return { status: 200, body: list([], query) };
      if (apiPath === 'llmServices:list') return { status: 200, body: list([], query) };

      /* ---------------- 工作台 / 任务 ---------------- */
      if (apiPath === 'userWorkflowTaskStats:listMine') {
        return {
          status: 200,
          body: { data: taskStatsRows(), meta: { page: 1, pageSize: 200, hasNext: false } },
        };
      }
      if (apiPath === 'userWorkflowTasks:listMine') {
        const rows = taskTypeRows();
        return {
          status: 200,
          body: { data: rows, meta: { count: rows.length, page: 1, pageSize: 50, totalPage: 1 } },
        };
      }
      if (apiPath === 'aiConversations:list') return { status: 200, body: list(state.conversations, query) };
      if (apiPath === 'aiConversations:unreadCounts') return { status: 200, body: { data: [] } };
      if (apiPath === 'aiConversations:get') {
        const conversation = state.conversations.find((item) => item.sessionId === String(query.filterByTk ?? ''));
        return conversation
          ? { status: 200, body: { data: conversation } }
          : { status: 404, body: { errors: [{ message: 'not found' }] } };
      }
      if (apiPath === 'aiConversations:getMessages') {
        const sessionId = String(query.sessionId ?? '');
        return {
          status: 200,
          body: { data: sessionId.startsWith('ai-task-') ? aiTaskMessages() : [] },
        };
      }
      /* ---------------- AI 任务（TD-03）：只本机、按真实 readonly/受理人契约 ---------------- */
      if (apiPath === 'aiWorkflowTasks:list') {
        return { status: 200, body: list(state.aiTasks.map(aiTaskView), query) };
      }
      if (apiPath === 'aiWorkflowTasks:unreadCount') {
        return { status: 200, body: { data: { count: state.aiTasks.filter((task) => task.read !== true).length } } };
      }
      if (apiPath === 'aiWorkflowTasks:getBySession') {
        const task = state.aiTasks.find((item) => item.sessionId === String(query.sessionId ?? ''));
        return task
          ? { status: 200, body: { data: aiTaskView(task) } }
          : { status: 404, body: { errors: [{ message: 'not found' }] } };
      }
      if (apiPath === 'aiWorkflowTasks:accept') {
        const sessionId = String((body?.values ?? body ?? {}).sessionId ?? '');
        const task = state.aiTasks.find((item) => item.sessionId === sessionId);
        if (!task) return { status: 404, body: { errors: [{ message: 'not found' }] } };
        if (task.status !== 'pending_acceptance' || task.acceptedUserId !== null) {
          // 真实 accept 的条件不再成立时返回 accepted:false，而不是谎报"已领取"。
          return { status: 200, body: { data: { accepted: false, acceptedUserId: task.acceptedUserId ?? null } } };
        }
        task.acceptedUserId = CURRENT_USER_ID;
        task.status = 'pending_approval';
        task.updatedAt = new Date().toISOString();
        return { status: 200, body: { data: { accepted: true, readUpdated: false, acceptedUserId: CURRENT_USER_ID } } };
      }
      if (apiPath === 'aiWorkflowTasks:reject') {
        const values = body?.values ?? body ?? {};
        const task = state.aiTasks.find((item) => String(item.id) === String(values.id ?? ''));
        if (!task) return { status: 404, body: { errors: [{ message: 'not found' }] } };
        // 真实守卫：非受理人 / 非 pending_approval 一律 403。
        if (task.status !== 'pending_approval' || Number(task.acceptedUserId) !== CURRENT_USER_ID) {
          return {
            status: 403,
            body: { errors: [{ message: 'AI_TASK_NOT_REJECTABLE', code: 'AI_TASK_NOT_REJECTABLE' }] },
          };
        }
        task.status = 'rejected';
        task.updatedAt = new Date().toISOString();
        return { status: 200, body: { data: aiTaskView(task) } };
      }
      if (apiPath === 'aiConversations:updateUserDecision') {
        // 只记录决定（不触发模型）；返回真实形状 `{updated, toolCalls}` 供页面判定"是否全部已决定"。
        const values = body?.values ?? body ?? {};
        const message = aiTaskMessages()[0];
        const toolCalls = message.toolCalls.map((call) => ({
          ...call,
          invokeStatus: call.id === values.toolCallId ? 'waiting' : call.invokeStatus,
          userDecision: call.id === values.toolCallId ? values.userDecision ?? null : null,
        }));
        return { status: 200, body: { data: { updated: 1, toolCalls } } };
      }
      if (apiPath === 'aiConversations:resumeToolCall') {
        // 继续执行会真实外呼模型：本环境不做模型调用，如实返回 501，不用空 200 假装成功。
        return {
          status: 501,
          body: {
            errors: [
              {
                message:
                  '本机合成环境不执行模型调用：resumeToolCall 未实现。继续执行协议请在受控 AI 环境（5350/5420）验证。',
              },
            ],
          },
        };
      }
      if (apiPath === 'workflows:list') return { status: 200, body: list([], query) };
      if (apiPath === 'workflowManualTasks:listMine') {
        return {
          status: 200,
          body: list(state.manualTasks.filter((task) => task.userId === CURRENT_USER_ID), query),
        };
      }
      /* ---------------- 抄送（TD-04）：get / read / unread / readAll ---------------- */
      if (apiPath === 'workflowCcTasks:listMine') {
        return {
          status: 200,
          body: list(state.ccTasks.filter((task) => task.userId === CURRENT_USER_ID), query),
        };
      }
      if (apiPath === 'workflowCcTasks:get') {
        // 真实 `get` 由服务端强制 `userId = 当前用户`：别人的抄送在这里查不到（404，不是空数据）。
        const task = state.ccTasks.find(
          (item) => item.id === String(query.filterByTk ?? '') && item.userId === CURRENT_USER_ID,
        );
        return task
          ? { status: 200, body: { data: task } }
          : { status: 404, body: { errors: [{ message: 'not found' }] } };
      }
      if (apiPath === 'workflowCcTasks:read' || apiPath === 'workflowCcTasks:unread') {
        const task = state.ccTasks.find(
          (item) => item.id === String(query.filterByTk ?? '') && item.userId === CURRENT_USER_ID,
        );
        if (!task) return { status: 404, body: { errors: [{ message: 'not found' }] } };
        const read = apiPath === 'workflowCcTasks:read';
        task.status = read ? 1 : 0;
        task.readAt = read ? new Date().toISOString() : null;
        return { status: 200, body: { data: task } };
      }
      if (apiPath === 'workflowCcTasks:readAll') {
        // 只影响当前账号自己的未读标记，**不推进任何流程**。
        let updated = 0;
        for (const task of state.ccTasks) {
          if (task.userId !== CURRENT_USER_ID || task.status === 1) continue;
          task.status = 1;
          task.readAt = new Date().toISOString();
          updated += 1;
        }
        return { status: 200, body: { data: { updated } } };
      }
      if (apiPath === 'flow_nodes:list') return { status: 200, body: list([], query) };

      /* ---------------- 业务记录（DS-04）：<collection>:list|get|create|update|destroy|query ---------------- */
      const recordMatch = /^([a-zA-Z_]+):(list|get|create|update|destroy|query)$/.exec(apiPath);
      if (recordMatch) {
        const recordResult = recordAction(recordMatch[1], recordMatch[2], query, body);
        if (recordResult) return recordResult;
      }

      /* ---------------- 关联资源（四方向 / 字段 / 入口 / 数据授权） ---------------- */
      const match = /^([a-zA-Z_]+)\/([^/]+)\/([a-zA-Z_]+):([a-zA-Z]+)$/.exec(apiPath);
      if (match) {
        const [, parent, parentId, child, action] = match;
        // DS-03：`collections/<name>/fields:*`
        if (parent === 'collections' && child === 'fields') {
          const fieldResult = collectionFieldAction(parentId, action, query, body);
          if (fieldResult) return fieldResult;
        }
        // AC-04：`roles/<role>/resources:update`（单资源整体替换它的动作集合）
        if (parent === 'roles' && child === 'resources' && action === 'update') {
          const values = unwrapValues(body) ?? {};
          const resourceName = String(query.filterByTk ?? values.name ?? '');
          if (!resourceName) return { status: 400, body: { errors: [{ message: '缺少资源名' }] } };
          const record = applyResourcePermission(parentId, { ...values, name: resourceName });
          return { status: 200, body: { data: record } };
        }
        if (action === 'list') {
          if (parent === 'departments' && child === 'members') return readRelation(list(departmentMembers(parentId), query));
          if (parent === 'departments' && child === 'roles') return readRelation(list(departmentRoles(parentId), query));
          if (parent === 'users' && child === 'departments') return readRelation(list(userDepartments(parentId), query));
          if (parent === 'roles' && child === 'departments') return readRelation(list(roleDepartments(parentId), query));
          if (parent === 'roles' && child === 'users') return readRelation(list(roleUsers(parentId), query));
          if (parent === 'roles' && child === 'resources') return readRelation(list(roleResourcesOf(parentId), query));
          if (parent === 'roles' && child === 'aiEmployees') return readRelation(list([], query));
          if (parent === 'roles' && child === 'desktopRoutes') {
            const routes = (state.roleDesktopRoutes[parentId] ?? [])
              .map((id) => state.desktopRoutes.find((route) => route.id === id))
              .filter(Boolean);
            return readRelation(list(routes, query));
          }
          if (parent === 'roles' && child === 'menuUiSchemas') {
            return readRelation(list(state.roleMenuSchemas[parentId] ?? [], query));
          }
          if (parent === 'roles' && child === 'collections') {
            return readRelation(list(roleCollectionConfigs(parentId), query));
          }
          if (parent === 'dataSources' && child === 'collections') {
            return { status: 200, body: list(state.collections, query) };
          }
        } else {
          const mutated = mutateRelation(parent, child, parentId, action, unwrapValues(body));
          if (mutated) return mutated;
        }
      }

      /* ---------------- 未实现：本机 404，绝不转发 ---------------- */
      logged.unimplemented = true;
      return {
        status: 404,
        body: {
          errors: [
            {
              message: `本机合成环境未实现该接口：${apiPath}。它不会被转发到真实后端（172.16.88.250 不参与本环境的任何请求）。`,
            },
          ],
        },
      };
    };

    const result = handle();
    send(response, result.status, result.body);
  })();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[fixture] http://127.0.0.1:${PORT}  （控制页：http://127.0.0.1:${PORT}/）`);
});
