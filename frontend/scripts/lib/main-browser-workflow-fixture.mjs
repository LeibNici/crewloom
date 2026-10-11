/**
 * 电脑端**工作流（WF-01..05）+ 模型配置（LM-01..05）验收环境**的本机合成数据层。
 *
 * 分层（能复用就不重写）：
 *  - **工作流读写状态机**复用 `scripts/lib/controlled-workflow-middleware.mjs`：
 *    本文件不重写 `workflows:get`、`flow_nodes:list|get`、`nodes:create`、
 *    `flow_nodes:update|move|duplicate|destroy|destroyBranch|test`，
 *    而是**持有同一个 store**，只补中间件没覆盖、但产品页面真实会发的动作：
 *    列表（过滤/分页/字段/排序）、分类、创建/改名/启停/删除/复制版本、
 *    执行记录列表与详情（含 9 态状态筛选）、作业（node job）读取。
 *  - **模型配置（LM）**是本文件自己的合成契约层：服务、提供方、显式模型目录、
 *    默认设置读回、以及**不产生任何真实费用**的试飞应答。
 *
 * 硬边界（与 35 聊天环境同一口径）：
 *  - 只应答本机 HTTP；不发任何出站请求，不持有真实凭据；
 *  - 未实现的动作由服务器外壳返回 **501**（不是空成功）；
 *  - `ai:listModels` / `ai:listProviderModels` / `ai:testFlight` 在真实后端会**外呼提供方**，
 *    这里一律由本机按真实响应 shape 应答，因此可在零预算下验收"成功/失败"两条路径；
 *  - `llmServices:list|get` 按真实契约返回**明文 options**（含合成 apiKey），
 *    `ai:listLLMServices` 按真实契约**剔除 options**；产品 UI 不得把 apiKey 渲染进 DOM，
 *    本环境自检会直接检查 DOM 里没有合成密钥子串。
 */

import {
  CONTROLLED_WORKFLOW_IDS as WF,
  makeNode,
  readAppends,
  versionPayload,
} from './controlled-workflow-middleware.mjs';

const now = () => new Date().toISOString();
const ok = (data, meta) => ({ code: 200, body: { data, ...(meta ? { meta } : {}) } });
const fail = (code, errorCode, message) => ({
  code,
  body: { errors: [{ code: errorCode, message }], data: null },
});

/* ================================================================== *
 * 一、通用解析
 * ================================================================== */

function searchParamsOf(url) {
  return new URL(String(url ?? '/'), 'http://127.0.0.1').searchParams;
}

/** `filter` 在查询串里是 JSON 字符串（与 SDK 一致）；解析失败按"无过滤"处理并记录下来。 */
export function parseFilterParam(searchParams) {
  const raw = searchParams.get('filter');
  if (!raw) return { filter: {}, raw: null, invalid: false };
  try {
    const parsed = JSON.parse(raw);
    return {
      filter: parsed && typeof parsed === 'object' ? parsed : {},
      raw,
      invalid: !(parsed && typeof parsed === 'object'),
    };
  } catch {
    return { filter: {}, raw, invalid: true };
  }
}

/** 收集数组参数（SDK 用 `x[]=` 记法；这里同时收 `x`、`x[]`、`x[n]`）。 */
export function readArrayParam(searchParams, name) {
  const values = [...searchParams.getAll(name), ...searchParams.getAll(`${name}[]`)];
  for (const [key, value] of searchParams.entries()) {
    if (new RegExp(`^${name}\\[\\d+\\]$`).test(key)) values.push(value);
  }
  return values.flatMap((value) => String(value).split(',')).filter(Boolean);
}

function readSortParam(searchParams) {
  return readArrayParam(searchParams, 'sort');
}

function paginateOf(searchParams) {
  return searchParams.get('paginate') !== 'false';
}

function pageOf(searchParams) {
  const page = Number(searchParams.get('page') ?? 1);
  const pageSize = Number(searchParams.get('pageSize') ?? 20);
  return {
    page: Number.isFinite(page) && page > 0 ? page : 1,
    pageSize: Number.isFinite(pageSize) && pageSize > 0 ? Math.min(pageSize, 500) : 20,
  };
}

function pickFields(row, fields) {
  if (!fields.length) return row;
  const out = {};
  for (const field of fields) {
    // 原生 `fields[]=versionStats.executed` 用的是**点号路径**，必须按下标取值。
    if (field.includes('.')) {
      const parts = field.split('.');
      let cursor = row;
      let okPath = true;
      for (const part of parts) {
        if (cursor && typeof cursor === 'object' && part in cursor) cursor = cursor[part];
        else {
          okPath = false;
          break;
        }
      }
      if (okPath) out[parts[parts.length - 1]] = cursor;
      continue;
    }
    if (field in row) out[field] = row[field];
  }
  return out;
}

function compareRows(a, b, sorts) {
  for (const entry of sorts) {
    const desc = entry.startsWith('-');
    const key = desc ? entry.slice(1) : entry;
    const left = a?.[key];
    const right = b?.[key];
    if (left === right) continue;
    const leftNum = typeof left === 'number' ? left : Number.isFinite(Number(left)) && left !== null && left !== '' ? Number(left) : null;
    const rightNum = typeof right === 'number' ? right : Number.isFinite(Number(right)) && right !== null && right !== '' ? Number(right) : null;
    if (leftNum !== null && rightNum !== null) {
      const diff = leftNum - rightNum;
      if (diff !== 0) return desc ? -diff : diff;
      continue;
    }
    const diff = String(left ?? '').localeCompare(String(right ?? ''));
    if (diff !== 0) return desc ? -diff : diff;
  }
  return 0;
}

/* ================================================================== *
 * 二、工作流：分类 / 执行样本 / 列表与写动作
 * ================================================================== */

export const WORKFLOW_CATEGORIES = [
  { id: '1', title: '合成分类·审批' },
  { id: '2', title: '合成分类·同步' },
];

/** 版本 → 分类（合成关联；真实实例里由 `workflows_categories` 关联表提供）。 */
const VERSION_CATEGORIES = {
  [WF.DRAFT_ID]: ['1'],
  [WF.DRAFT2_ID]: ['1'],
  [WF.WIDE_ID]: ['1'],
  [WF.EXECUTED_ID]: ['2'],
  [WF.OTHER_ID]: ['2'],
};

/**
 * 执行样本：覆盖真实 9 态里的代表值（`null` 排队中 / `0` 进行中 / `1` 已完成 /
 * `-1` 执行失败 / `-2` 出错 / `-4` 已取消），让"状态筛选"能在界面上被真实点出来。
 * 只写进本机 store 内存，不代表任何真实业务记录。
 */
function buildExecutionSeed(store) {
  const makeJobs = (executionId, count, status, workflowId) =>
    Array.from({ length: count }, (_, index) => {
      const node = makeNode({ type: 'output', title: `受控节点 ${index + 1}` });
      return {
        id: `${executionId}${String(index + 1).padStart(2, '0')}`,
        executionId,
        workflowId,
        nodeId: node.id,
        nodeKey: node.key,
        type: index === 0 ? 'collection' : 'output',
        status,
        result: { controlled: true, step: index + 1 },
        meta: { controlled: true, input: index },
        log: `本机受控执行日志（第 ${index + 1} 步）`,
        startedAt: now(),
        updatedAt: now(),
      };
    });

  const seeds = [
    // 与中间件自带的两条保持兼容：920001（2 job）/ 920002（4 job）已在 store 里，这里只补状态与时间。
    { id: '920003', workflowId: WF.OTHER_ID, status: null, reason: null, jobCount: 0 },
    { id: '920004', workflowId: WF.OTHER_ID, status: 0, reason: null, jobCount: 1 },
    { id: '920005', workflowId: WF.DRAFT_ID, status: 1, reason: null, jobCount: 3 },
    { id: '920006', workflowId: WF.DRAFT_ID, status: -1, reason: null, jobCount: 2 },
    { id: '920007', workflowId: WF.WIDE_ID, status: -2, reason: null, jobCount: 2 },
    { id: '920008', workflowId: WF.WIDE_ID, status: -4, reason: 'manual_cancel', jobCount: 1 },
  ];

  for (const seed of seeds) {
    store.executions[seed.id] = {
      id: seed.id,
      workflowId: seed.workflowId,
      status: seed.status,
      reason: seed.reason,
      createdAt: now(),
      updatedAt: now(),
      startedAt: seed.status === null ? null : now(),
      finishedAt: seed.status === null || seed.status === 0 ? null : now(),
      jobs: makeJobs(seed.id, seed.jobCount, seed.status ?? 0, seed.workflowId),
    };
  }
}

/** 把本环境特有的合成数据补进受控 workflow store（可重复调用，幂等覆盖）。 */
export function seedWorkflowStore(store) {
  store.categories = WORKFLOW_CATEGORIES.map((item) => ({ ...item }));
  store.versionCategories = JSON.parse(JSON.stringify(VERSION_CATEGORIES));
  // 中间件自带的 920001 / 920002 补时间与 reason 字段，让执行详情页字段齐全。
  for (const execution of Object.values(store.executions)) {
    if (!execution.createdAt) execution.createdAt = now();
    if (!execution.updatedAt) execution.updatedAt = now();
    if (!('reason' in execution)) execution.reason = null;
    if (!('startedAt' in execution)) execution.startedAt = now();
    if (!('finishedAt' in execution)) execution.finishedAt = now();
    for (const job of execution.jobs) {
      if (!job.type) job.type = 'output';
      if (!('workflowId' in job)) job.workflowId = execution.workflowId;
      if (!('startedAt' in job)) job.startedAt = now();
      if (!('updatedAt' in job)) job.updatedAt = now();
    }
  }
  buildExecutionSeed(store);
  return store;
}

function categoriesOf(version, store) {
  const ids = store.versionCategories?.[version.id] ?? [];
  const table = store.categories ?? WORKFLOW_CATEGORIES;
  return ids
    .map((id) => table.find((item) => item.id === id))
    .filter(Boolean)
    .map((item) => ({ id: item.id, title: item.title }));
}

function matchesWorkflowFilter(version, filter, store) {
  for (const [key, expected] of Object.entries(filter ?? {})) {
    if (key === 'key') {
      if (typeof expected === 'string' && version.key !== expected) return false;
      continue;
    }
    if (key === 'id') {
      if (String(version.id) !== String(expected)) return false;
      continue;
    }
    if (key === 'enabled' || key === 'current' || key === 'sync') {
      if (Boolean(version[key]) !== Boolean(expected)) return false;
      continue;
    }
    if (key === 'type') {
      if (String(version.type) !== String(expected)) return false;
      continue;
    }
    if (key === 'title') {
      const includes = expected && typeof expected === 'object' ? expected.$includes : expected;
      if (!String(version.title ?? '').includes(String(includes ?? ''))) return false;
      continue;
    }
    if (key === 'categories.id') {
      const wanted = expected && typeof expected === 'object' ? expected.$eq : expected;
      if (!categoriesOf(version, store).some((item) => String(item.id) === String(wanted))) return false;
      continue;
    }
    // 未建模的过滤键：**不静默当成匹配**。返回一个显式的本机错误，由调用方在控制页看到。
    return { unsupported: key };
  }
  return true;
}

function executionRow(execution, store, { withWorkflow }) {
  const version = store.versions[String(execution.workflowId)];
  return {
    id: String(execution.id),
    workflowId: execution.workflowId === null ? null : String(execution.workflowId),
    status: execution.status ?? null,
    reason: execution.reason ?? null,
    createdAt: execution.createdAt ?? now(),
    updatedAt: execution.updatedAt ?? now(),
    startedAt: execution.startedAt ?? null,
    finishedAt: execution.finishedAt ?? null,
    ...(withWorkflow
      ? { workflow: version ? { id: version.id, title: version.title, key: version.key } : null }
      : {}),
  };
}

function matchesExecutionFilter(execution, filter, store) {
  for (const [key, expected] of Object.entries(filter ?? {})) {
    if (key === 'workflowId') {
      if (String(execution.workflowId) !== String(expected)) return false;
      continue;
    }
    if (key === 'key') {
      // 原生执行历史抽屉按**逻辑流程 key**过滤（跨版本分组）。
      const version = store.versions[String(execution.workflowId)];
      if (!version || version.key !== String(expected)) return false;
      continue;
    }
    if (key === 'id') {
      const value = execution.id;
      if (expected && typeof expected === 'object') {
        if ('$lt' in expected && !(Number(value) < Number(expected.$lt))) return false;
        if ('$gt' in expected && !(Number(value) > Number(expected.$gt))) return false;
        continue;
      }
      if (String(value) !== String(expected)) return false;
      continue;
    }
    if (key === 'status') {
      if (expected === null) {
        if (execution.status !== null && execution.status !== undefined) return false;
        continue;
      }
      if (expected && typeof expected === 'object') {
        if ('$eq' in expected) {
          const wanted = expected.$eq;
          const actual = execution.status ?? null;
          if (wanted === null ? actual !== null : Number(actual) !== Number(wanted)) return false;
          continue;
        }
      }
      if (Number(execution.status ?? NaN) !== Number(expected)) return false;
      continue;
    }
    if (key === 'createdAt') {
      const value = execution.createdAt ?? '';
      if (expected && typeof expected === 'object') {
        if (expected.$gte && value < String(expected.$gte)) return false;
        if (expected.$lte && value > String(expected.$lte)) return false;
        continue;
      }
      return false;
    }
    return { unsupported: key };
  }
  return true;
}

function journalWrites(store, entry) {
  store.journal.push({ at: now(), ...entry });
  if (store.journal.length > 500) store.journal.shift();
}

/**
 * 工作流补充分发（**中间件之外的读写**）。
 *
 * @returns {{code:number, body:unknown}|null} null = 不是本层负责的动作，交给下一层。
 */
export function workflowLocal(action, ctx, store) {
  const { method, url, values } = ctx;
  const sp = searchParamsOf(url);
  const filterByTk = String(sp.get('filterByTk') ?? values?.filterByTk ?? '');
  const { filter, raw: rawFilter, invalid } = parseFilterParam(sp);

  /* ---------------- 分类 ---------------- */
  if (action === 'workflowCategories:list' && method === 'GET') {
    const rows = store.categories ?? WORKFLOW_CATEGORIES;
    return ok(
      rows.map((item) => ({ ...item })),
      { count: rows.length },
    );
  }

  if (action === 'workflowCategories:create' && method === 'POST') {
    const title = String(values?.title ?? '').trim();
    if (!title) return fail(400, 'INVALID_TITLE', '分类名称不能为空。');
    const category = { id: String(1000 + (store.categories?.length ?? 0)), title };
    store.categories = [...(store.categories ?? WORKFLOW_CATEGORIES), category];
    journalWrites(store, { method, action, payload: values, local: true });
    return ok(category);
  }

  /* ---------------- 列表（过滤 / 分页 / 字段 / 排序 / appends） ---------------- */
  if (action === 'workflows:list' && method === 'GET') {
    if (invalid) {
      return fail(400, 'SYNTH_BAD_FILTER', `本机合成环境读不懂这个 filter：${rawFilter}`);
    }
    const rows = Object.values(store.versions);
    const matched = [];
    for (const version of rows) {
      const verdict = matchesWorkflowFilter(version, filter, store);
      if (verdict && typeof verdict === 'object' && verdict.unsupported) {
        journalWrites(store, { method, action, filter, unsupportedFilterKey: verdict.unsupported });
        return fail(
          400,
          'SYNTH_UNSUPPORTED_FILTER',
          `本机合成环境没有建模这个流程过滤键「${verdict.unsupported}」；不返回可能误导的空成功。`,
        );
      }
      if (verdict === true) matched.push(version);
    }
    const sorts = readSortParam(sp);
    if (sorts.length) matched.sort((a, b) => compareRows(a, b, sorts));
    const { page, pageSize } = pageOf(sp);
    const shouldPaginate = paginateOf(sp);
    const slice = shouldPaginate ? matched.slice((page - 1) * pageSize, page * pageSize) : matched;
    const fields = readArrayParam(sp, 'fields');
    const appends = readAppends(sp);
    const data = slice.map((version) => {
      if (fields.length) return pickFields(version, fields);
      const payload = versionPayload(version, sp);
      if (appends.includes('categories')) payload.categories = categoriesOf(version, store);
      return payload;
    });
    journalWrites(store, { method, action, filter, rows: data.length, total: matched.length, local: true });
    return ok(data, {
      count: matched.length,
      page,
      pageSize,
      totalPage: Math.max(1, Math.ceil(matched.length / pageSize)),
    });
  }

  /* ---------------- 创建 / 改名 / 启停 / 删除 ---------------- */
  if (action === 'workflows:create' && method === 'POST') {
    // 真实契约：`type` 必填且必须是已注册的触发器（`400 Trigger type is required`）。
    // 页面上这条走不到（产品固定传 `type:'collection'`），但保留它是为了"非法输入不空成功"。
    if (!values?.type) {
      return fail(400, 'WORKFLOW_TRIGGER_TYPE_REQUIRED', 'Trigger type is required');
    }
    const title = String(values?.title ?? '').trim();
    if (!title) return fail(400, 'INVALID_TITLE', 'Workflow title is required');
    const id = nextWorkflowId(store);
    const version = {
      id,
      key: id,
      title,
      type: values.type,
      enabled: values?.enabled === true,
      current: false,
      sync: false,
      executed: 0,
      description: values?.description ?? '',
      config: values?.config ?? { collection: 'users', mode: 1 },
      versionStats: { executed: 0 },
      stats: { executed: 0 },
      createdAt: now(),
      updatedAt: now(),
      nodes: [],
    };
    store.versions[id] = version;
    store.versionCategories[id] = [];
    journalWrites(store, { method, action, payload: values, createdId: id, local: true });
    return ok({ ...version });
  }

  if (action === 'workflows:update' && method === 'POST') {
    const version = store.versions[filterByTk];
    if (!version) return fail(404, 'NOT_FOUND', `本机合成环境里没有流程版本 ${filterByTk}。`);
    // 真实契约：已执行版本不能再改 `config`（`title/description/enabled/triggerTitle/options/categories` 仍可改）。
    const executed = Number(version.versionStats?.executed ?? 0);
    if (values?.config !== undefined && executed > 0) {
      return fail(400, 'WORKFLOW_EXECUTED_CONFIG_IMMUTABLE', 'config of executed workflow can not be updated');
    }
    if (typeof values?.title === 'string' && values.title.trim()) version.title = values.title.trim();
    if (typeof values?.description === 'string') version.description = values.description;
    if (typeof values?.triggerTitle === 'string') version.triggerTitle = values.triggerTitle;
    if (values?.options !== undefined) version.options = values.options;
    if (values?.config !== undefined) version.config = values.config;
    if (values?.enabled !== undefined) {
      version.enabled = Boolean(values.enabled);
      // 真实语义（报告 20 §2 / 十页契约）：**启用即置 current 并归档上一版本**（同一次保存事务内），
      // 归档用 `enabled:false, current:null`（不是 `false`，唯一索引 `['key','current']` 的要求）。
      if (version.enabled) {
        for (const sibling of Object.values(store.versions)) {
          if (sibling.key !== version.key) continue;
          if (sibling.id === version.id) sibling.current = true;
          else {
            sibling.current = null;
            sibling.enabled = false;
          }
        }
      }
    }
    version.updatedAt = now();
    journalWrites(store, { method, action, filterByTk, payload: values, enabled: version.enabled, local: true });
    return ok({ ...version });
  }

  if (action === 'workflows:destroy' && method === 'POST') {
    const version = store.versions[filterByTk];
    if (!version) return fail(404, 'NOT_FOUND', `本机合成环境里没有流程版本 ${filterByTk}。`);
    const removed = [];
    if (version.current) {
      // 真实语义（WF-01 页面文案同口径）：删除当前生效版本会连带删除同一 key 的全部版本。
      for (const [id, item] of Object.entries(store.versions)) {
        if (item.key === version.key) {
          removed.push(id);
          delete store.versions[id];
          delete store.versionCategories?.[id];
        }
      }
    } else {
      removed.push(version.id);
      delete store.versions[version.id];
      delete store.versionCategories?.[version.id];
    }
    journalWrites(store, { method, action, filterByTk, removed, local: true });
    return ok({ id: version.id, removed });
  }

  if (action === 'workflows:revision' && method === 'POST') {
    const source = store.versions[filterByTk];
    if (!source) return fail(404, 'NOT_FOUND', `本机合成环境里没有流程版本 ${filterByTk}。`);
    const id = nextWorkflowId(store);
    const sameKey = typeof filter.key === 'string' && filter.key !== '';
    const cloneNodes = (source.nodes ?? []).map((node) => ({ ...node, id: undefined }));
    const idMap = new Map();
    const nodes = cloneNodes.map((node) => {
      const created = makeNode({
        title: node.title,
        type: node.type,
        config: JSON.parse(JSON.stringify(node.config ?? {})),
        upstreamId: null,
        branchIndex: node.branchIndex ?? null,
        workflowId: id,
      });
      idMap.set(String(node.id), created.id);
      return { created, original: node };
    });
    for (const entry of nodes) {
      entry.created.upstreamId = entry.original.upstreamId ? idMap.get(String(entry.original.upstreamId)) ?? null : null;
      entry.created.downstreamId = entry.original.downstreamId ? idMap.get(String(entry.original.downstreamId)) ?? null : null;
    }
    const version = {
      id,
      // 带 `filter.key` = 同一流程的**新版本**（沿用 key）；不带 = 复制为**独立流程**（新 key）。
      key: sameKey ? source.key : id,
      title: String(values?.title ?? source.title),
      type: source.type,
      enabled: false,
      current: !sameKey,
      sync: false,
      executed: 0,
      description: source.description ?? '',
      config: JSON.parse(JSON.stringify(source.config ?? {})),
      versionStats: { executed: 0 },
      stats: { executed: 0 },
      createdAt: now(),
      updatedAt: now(),
      nodes: nodes.map((entry) => entry.created),
    };
    store.versions[id] = version;
    store.versionCategories[id] = [...(store.versionCategories?.[source.id] ?? [])];
    journalWrites(store, { method, action, filterByTk, sameKey, createdId: id, local: true });
    return ok({ ...version });
  }

  /* ---------------- 触发一次执行（原生 ExecuteWorkflowButton） ---------------- */
  if (action === 'workflows:execute' && method === 'POST') {
    const version = store.versions[filterByTk];
    if (!version) return fail(404, 'NOT_FOUND', `本机合成环境里没有流程版本 ${filterByTk}。`);
    const id = nextExecutionId(store);
    store.executions[id] = {
      id,
      workflowId: version.id,
      status: null,
      reason: null,
      createdAt: now(),
      updatedAt: now(),
      startedAt: null,
      finishedAt: null,
      jobs: [],
    };
    journalWrites(store, { method, action, filterByTk, executionId: id, local: true });
    // 原生 `ExecuteWorkflowButton` 读的是 `response.data.data` = `{execution, newVersionId}`
    // （见 `plugin-workflow/src/client-v2/triggers/ExecuteWorkflowButton.tsx:90-99`）。
    return ok({ execution: { id, workflowId: version.id, status: null }, newVersionId: null });
  }

  /* ---------------- 执行记录：列表 / 详情 / 取消 / 删除 ---------------- */
  if (action === 'executions:list' && method === 'GET') {
    if (invalid) return fail(400, 'SYNTH_BAD_FILTER', `本机合成环境读不懂这个 filter：${rawFilter}`);
    const withWorkflow = readAppends(sp).includes('workflow');
    const matched = [];
    for (const execution of Object.values(store.executions)) {
      const verdict = matchesExecutionFilter(execution, filter, store);
      if (verdict && typeof verdict === 'object' && verdict.unsupported) {
        return fail(
          400,
          'SYNTH_UNSUPPORTED_FILTER',
          `本机合成环境没有建模这个执行过滤键「${verdict.unsupported}」；不返回可能误导的空成功。`,
        );
      }
      if (verdict === true) matched.push(execution);
    }
    const sorts = readSortParam(sp);
    if (sorts.length) matched.sort((a, b) => compareRows(a, b, sorts));
    const { page, pageSize } = pageOf(sp);
    const shouldPaginate = paginateOf(sp);
    const slice = shouldPaginate ? matched.slice((page - 1) * pageSize, page * pageSize) : matched;
    const data = slice.map((execution) => executionRow(execution, store, { withWorkflow }));
    journalWrites(store, { method, action, filter, rows: data.length, total: matched.length, local: true });
    return ok(data, {
      count: matched.length,
      page,
      pageSize,
      totalPage: Math.max(1, Math.ceil(matched.length / pageSize)),
    });
  }

  if (action === 'executions:get' && method === 'GET') {
    const execution = store.executions[filterByTk];
    if (!execution) return fail(404, 'NOT_FOUND', `本机合成环境里没有执行记录 ${filterByTk}。`);
    const appends = readAppends(sp);
    const except = readArrayParam(sp, 'except');
    const row = executionRow(execution, store, { withWorkflow: true });
    // 原生执行抽屉会一次取回关联数据（`appends[]=jobs` 等），产品页则分两次读。
    if (appends.includes('jobs')) {
      row.jobs = execution.jobs.map((job) => ({
        ...job,
        // `except[]=jobs.result` 是原生默认查询的一部分：被 except 的字段不应返回。
        ...(except.includes('jobs.result') ? { result: undefined } : {}),
      }));
      if (except.includes('jobs.result')) for (const job of row.jobs) delete job.result;
    }
    journalWrites(store, { method, action, filterByTk, appends, local: true });
    return ok(row);
  }

  if (action === 'executions:cancel' && method === 'POST') {
    const execution = store.executions[filterByTk];
    if (!execution) return fail(404, 'NOT_FOUND', `本机合成环境里没有执行记录 ${filterByTk}。`);
    // 真实契约：`status` 非 falsy 的执行不能取消（只有 QUEUEING(null) / STARTED(0) 可以）。
    if (execution.status !== null && execution.status !== 0) {
      return fail(400, 'EXECUTION_NOT_CANCELABLE', 'Execution is not cancelable');
    }
    // 真实契约：取消成功置 `ABORTED(-3)` + `reason='manual_cancel'`，PENDING(0) job 同样置 ABORTED。
    execution.status = -3;
    execution.reason = 'manual_cancel';
    execution.finishedAt = now();
    execution.updatedAt = now();
    for (const job of execution.jobs) if (job.status === 0) job.status = -3;
    journalWrites(store, { method, action, filterByTk, status: execution.status, local: true });
    return ok({ id: execution.id, status: execution.status });
  }

  if (action === 'executions:destroy' && method === 'POST') {
    // 原生执行抽屉支持三种目标：单条 `filterByTk` / 批量 `ids[]` / 按逻辑流程 `filter={key}`。
    const ids = readArrayParam(sp, 'ids');
    const targets = [];
    if (filterByTk) targets.push(filterByTk);
    for (const id of ids) targets.push(id);
    if (targets.length === 0 && typeof filter?.key === 'string') {
      for (const execution of Object.values(store.executions)) {
        const version = store.versions[String(execution.workflowId)];
        if (version && version.key === filter.key) targets.push(execution.id);
      }
    }
    if (targets.length === 0) targets.push(filterByTk);
    const removed = [];
    const skippedRunning = [];
    for (const id of targets) {
      const execution = store.executions[id];
      if (!execution) continue;
      // 真实契约：运行中（STARTED=0）的执行会被 handler 静默排除，删除不生效也不报错。
      if (execution.status === 0) {
        skippedRunning.push(id);
        continue;
      }
      delete store.executions[id];
      removed.push(id);
    }
    if (removed.length === 0 && skippedRunning.length === 0) {
      return fail(404, 'NOT_FOUND', `本机合成环境里没有执行记录 ${filterByTk}。`);
    }
    journalWrites(store, { method, action, filterByTk, removed, skippedRunning, local: true });
    return ok({ id: filterByTk || null, removed });
  }

  /* ---------------- 作业（node job）：列表 / 详情 ---------------- */
  if (action === 'jobs:list' && method === 'GET') {
    const all = Object.values(store.executions).flatMap((execution) =>
      execution.jobs.map((job) => ({ ...job, executionId: String(job.executionId ?? execution.id) })),
    );
    let matched = all;
    const executionId = filter?.executionId;
    if (executionId !== undefined) {
      matched = all.filter((job) => String(job.executionId) === String(executionId));
    }
    const { page, pageSize } = pageOf(sp);
    const shouldPaginate = paginateOf(sp);
    const slice = shouldPaginate ? matched.slice((page - 1) * pageSize, page * pageSize) : matched;
    journalWrites(store, {
      method,
      action,
      filter,
      rows: slice.length,
      total: matched.length,
      scope: executionId === undefined ? 'all-controlled-executions' : 'execution',
      local: true,
    });
    return ok(slice, {
      count: matched.length,
      page,
      pageSize,
      totalPage: Math.max(1, Math.ceil(matched.length / pageSize)),
    });
  }

  if (action === 'jobs:get' && method === 'GET') {
    const job = Object.values(store.executions)
      .flatMap((execution) => execution.jobs)
      .find((item) => String(item.id) === filterByTk);
    if (!job) return fail(404, 'NOT_FOUND', `本机合成环境里没有作业 ${filterByTk}。`);
    journalWrites(store, { method, action, filterByTk, local: true });
    return ok({ ...job });
  }

  /* ---------------- 原生宿主启动期与节点面板的附属读（本机显式应答，不留 501） ---------------- */
  // 原生画布宿主会加载 `NocoBaseBuildInPlugin`，启动期会发这批请求（见
  // `docs/verification/native-canvas-source/artifacts/requests-source.jsonl:1-7`）。
  // 它们不是"未知动作"，但本环境必须给出**明确**应答，否则画布启动会带错误。
  if (action === 'app:getLang' && method === 'GET') {
    // `LocalePlugin.afterAdd`（`core/client-v2/.../LocalePlugin.ts:24-52`）读 `data.lang` 并
    // `i18n.changeLanguage(data.lang)`；不返回 lang 时整个原生画布会留在英文。
    journalWrites(store, { method, action, lang: 'zh-CN', local: true });
    return ok({ lang: 'zh-CN', locale: 'zh-CN', resources: {}, cron: {} });
  }
  if (action === 'collections:get' && method === 'GET') {
    // 原生 collection 触发器/关联字段选择要读集合元数据（`collections:get`）。
    const name = String(sp.get('filterByTk') ?? values?.filterByTk ?? sp.get('name') ?? 'users');
    const isUsers = name === 'users';
    return ok({
      name,
      title: isUsers ? '用户' : name,
      titleField: isUsers ? 'nickname' : 'id',
      primaryKey: 'id',
      dataSourceKey: 'main',
      fields: isUsers
        ? [
            { name: 'id', type: 'bigInt', interface: 'integer', primaryKey: true, autoIncrement: true },
            { name: 'nickname', type: 'string', interface: 'input', uiSchema: { title: '昵称', 'x-component': 'Input' } },
          ]
        : [{ name: 'id', type: 'bigInt', interface: 'integer', primaryKey: true, autoIncrement: true }],
    });
  }
  if (action === 'flowModels:findOne' && method === 'GET') {
    journalWrites(store, { method, action, uid: sp.get('uid'), local: true });
    return ok(null);
  }
  if (action === 'flowModels:save' && method === 'POST') {
    // 原生布局模型的保存：真实后端会落库；本机只记日志并回显，绝不外呼、也不落磁盘。
    journalWrites(store, { method, action, note: 'layout model save accepted locally', local: true });
    return ok({ ...(values ?? {}), uid: sp.get('uid') ?? values?.uid ?? null });
  }
  if (action === 'desktopRoutes:listAccessible' && method === 'GET') {
    return ok([], { count: 0 });
  }
  if (action === 'uiLayouts:listAccessible' && method === 'GET') {
    return ok([], { count: 0 });
  }
  if (action === 'availableActions:list' && method === 'GET') {
    return ok([], { count: 0 });
  }
  // 通知/抄送节点的渠道选择（`plugin-notification-manager` 的 `MessageConfigForm`）。
  if ((action === 'notificationChannels:list' || action === 'notificationChannels:get') && method === 'GET') {
    return action.endsWith(':get') ? ok(null) : ok([], { count: 0 });
  }
  // 人工/审批节点的负责人候选：产品已由 manual-fixture 应答；原生 `UsersSelect` 走 users:list（同下层）。

  return null;
}

function nextWorkflowId(store) {
  const numeric = Object.keys(store.versions).map((id) => Number(id)).filter((id) => Number.isFinite(id));
  const max = numeric.length ? Math.max(...numeric) : 900000000000000;
  return String(max + 1);
}

function nextExecutionId(store) {
  const numeric = Object.keys(store.executions).map((id) => Number(id)).filter((id) => Number.isFinite(id));
  const max = numeric.length ? Math.max(...numeric) : 920000;
  return String(max + 1);
}

/* ================================================================== *
 * 三、模型配置（LM-01..05）
 * ================================================================== */

/**
 * 合成提供方清单。`name` 必须与产品 `src/modules/model/providers.ts` 的 13 个定义一一对应，
 * 否则 LM-02/LM-05 的表单会因为找不到字段定义而退化。
 */
export const MODEL_PROVIDERS = [
  { name: 'google-genai', title: 'Google Gemini', supportedModel: ['gemini-2.5-pro', 'gemini-2.5-flash'], supportWebSearch: true, webSearchModels: ['gemini-2.5-flash'] },
  { name: 'openai', title: 'OpenAI（Responses）', supportedModel: ['gpt-4o', 'gpt-4o-mini'], supportWebSearch: true, webSearchModels: ['gpt-4o-mini'] },
  { name: 'anthropic', title: 'Anthropic', supportedModel: ['claude-3-5-sonnet-latest'], supportWebSearch: false, webSearchModels: [] },
  { name: 'openai-completions', title: 'OpenAI（Completions）', supportedModel: ['gpt-4o-mini'], supportWebSearch: false, webSearchModels: [] },
  { name: 'deepseek', title: 'DeepSeek', supportedModel: ['deepseek-chat', 'deepseek-reasoner'], supportWebSearch: false, webSearchModels: [] },
  { name: 'dashscope', title: '通义千问（DashScope）', supportedModel: ['qwen-plus', 'qwen-max'], supportWebSearch: false, webSearchModels: [] },
  { name: 'ollama', title: 'Ollama（本机）', supportedModel: ['qwen2.5:7b', 'llama3.1:8b'], supportWebSearch: false, webSearchModels: [] },
  { name: 'kimi', title: 'Kimi（月之暗面）', supportedModel: ['moonshot-v1-8k'], supportWebSearch: false, webSearchModels: [] },
  { name: 'xai', title: 'xAI Grok', supportedModel: ['grok-2-latest'], supportWebSearch: false, webSearchModels: [] },
  { name: 'mimo', title: 'MiMo', supportedModel: ['mimo-7b'], supportWebSearch: false, webSearchModels: [] },
  { name: 'mistral', title: 'Mistral', supportedModel: ['mistral-large-latest'], supportWebSearch: false, webSearchModels: [] },
  { name: 'orcarouter', title: 'OrcaRouter', supportedModel: ['orcarouter/auto'], supportWebSearch: false, webSearchModels: [] },
  { name: 'shengsuanyun', title: ' ShengSuanYun', supportedModel: ['ssy-auto'], supportWebSearch: false, webSearchModels: [] },
];

/**
 * 合成密钥：**公开的假值**，只用于验证"读—改—写整体替换"与"UI 不回显密钥"。
 * 它不是任何真实服务的凭据，也不应出现在报告里。
 */
export const SYNTH_API_KEY = 'sk-synth-environment-fake-key';
export const SYNTH_BASE_URL = 'http://127.0.0.1:9/synth-model-gateway';

export function createModelState() {
  return {
    providers: MODEL_PROVIDERS.map((item) => ({ ...item })),
    services: [
      {
        name: 'synth-deepseek',
        title: '合成服务·DeepSeek',
        provider: 'deepseek',
        enabled: true,
        sort: 1,
        options: {
          apiKey: SYNTH_API_KEY,
          baseURL: SYNTH_BASE_URL,
          temperature: 0.7,
          timeout: 5000,
          maxRetries: 0,
        },
        enabledModels: {
          mode: 'custom',
          models: [
            { label: 'deepseek-chat', value: 'deepseek-chat' },
            { label: 'deepseek-reasoner', value: 'deepseek-reasoner' },
          ],
        },
        modelOptions: { temperature: 0.7, maxCompletionTokens: -1 },
        createdAt: now(),
        updatedAt: now(),
      },
      {
        name: 'synth-ollama',
        title: '合成服务·Ollama（旧数组形状）',
        provider: 'ollama',
        enabled: true,
        sort: 2,
        options: { baseURL: 'http://127.0.0.1:9/ollama' },
        // 历史数据的字符串数组形状（合同 C5/D5）：界面必须兼容且不改写它的语义。
        enabledModels: ['qwen2.5:7b'],
        modelOptions: { temperature: 0.8 },
        createdAt: now(),
        updatedAt: now(),
      },
      {
        // 停用服务：真实 `ai:listLLMServices` 会强制 `filter.enabled = {$ne:false}`，
        // 因此它**不应**出现在 LM-01/03/04 的脱敏列表里，只应出现在 `llmServices:list`（管理读）。
        name: 'synth-disabled',
        title: '合成服务·已停用（不出现在脱敏列表）',
        provider: 'mistral',
        enabled: false,
        sort: 3,
        options: { apiKey: SYNTH_API_KEY, baseURL: SYNTH_BASE_URL },
        enabledModels: { mode: 'custom', models: [{ label: 'mistral-large-latest', value: 'mistral-large-latest' }] },
        modelOptions: {},
        createdAt: now(),
        updatedAt: now(),
      },
    ],
    // `aiSettings:get` 真实契约：`options`（默认 `{storage:'local'}`）被**摊平到顶层**返回。
    settings: {
      storage: 'local',
      defaultLLMService: null,
      defaultModel: null,
      localSynthetic: true,
    },
    employees: [
      {
        username: 'synth-assistant',
        nickname: '合成助手',
        enabled: true,
        sort: 1,
        modelSettings: {
          enabled: true,
          llmService: 'synth-deepseek',
          model: 'deepseek-chat',
          models: [{ label: 'deepseek-chat', value: 'deepseek-chat' }],
        },
      },
      {
        username: 'synth-reporter',
        nickname: '合成报表员',
        enabled: true,
        sort: 2,
        modelSettings: { enabled: false, llmService: null, model: null, models: [] },
      },
    ],
    /** 下一次 `ai:testFlight` 的受控应答：success | failure。 */
    testScenario: 'success',
    journal: [],
  };
}

export function resetModelState(state) {
  Object.assign(state, createModelState());
  return state;
}

/**
 * `ai:listLLMServices` 的真实契约（`plugin-ai` 服务端）：`({options, ...rest}) => rest`，
 * 即**剔除 `options`**（含 apiKey/baseURL），并强制 `filter.enabled = {$ne:false}`。
 * 这里额外带上 `optionKeys`（只有键名）便于控制页核对"键还在、值没出网"。
 */
function maskService(service) {
  const { options, ...rest } = service;
  return { ...rest, optionKeys: Object.keys(options ?? {}).sort() };
}

/**
 * 列表分页 + `meta` 信封。真实契约里 `count/page/pageSize/totalPage` 在 `meta`，
 * `paginate=false` 时只有裸数组（没有 meta）；`ai:*` 的 `simplePaginate` 分支用 `meta.hasNext`。
 */
function pagedEnvelope(rows, searchParams, { defaultPageSize = 20, hasNext = false } = {}) {
  if (searchParams.get('paginate') === 'false') return { data: rows };
  const { page, pageSize } = pageOf(searchParams);
  const effectiveSize = searchParams.get('pageSize') ? pageSize : defaultPageSize;
  const start = (page - 1) * effectiveSize;
  const slice = rows.slice(start, start + effectiveSize);
  const total = rows.length;
  return {
    data: slice,
    meta: {
      count: total,
      page,
      pageSize: effectiveSize,
      totalPage: Math.max(1, Math.ceil(total / effectiveSize)),
      ...(hasNext ? { hasNext: start + effectiveSize < total } : {}),
    },
  };
}

/** `enabledModels` 的真实校验（`plugin-ai` `LLMService`）：空 id / 重复 id 都返回 400 + `data.index`。 */
function validateEnabledModels(raw) {
  if (raw === undefined || raw === null) return { ok: true };
  const candidates = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray(raw.models)
      ? raw.models
      : null;
  if (candidates === null) return { ok: true };
  const seen = new Set();
  for (let index = 0; index < candidates.length; index += 1) {
    const item = candidates[index];
    const value = item && typeof item === 'object' ? item.value : item;
    const id = String(value ?? '').trim();
    if (!id) return { ok: false, code: 'LLM_SERVICE_MODEL_ID_REQUIRED', index };
    if (seen.has(id)) return { ok: false, code: 'LLM_SERVICE_MODEL_ID_DUPLICATE', index };
    seen.add(id);
  }
  return { ok: true };
}

/** 归一 `enabledModels`：去掉没有 `value` 的条目（真实服务端行为）。 */
function normalizeEnabledModelsPayload(raw) {
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) return raw.map((item) => String(item)).filter(Boolean);
  if (raw && typeof raw === 'object') {
    const models = Array.isArray(raw.models) ? raw.models : [];
    return {
      ...raw,
      models: models
        .map((item) =>
          item && typeof item === 'object'
            ? { label: String(item.label ?? item.value ?? ''), value: String(item.value ?? '') }
            : { label: String(item ?? ''), value: String(item ?? '') },
        )
        .filter((item) => item.value.length > 0),
    };
  }
  return raw;
}


function journalModel(state, entry) {
  state.journal.push({ at: now(), ...entry });
  if (state.journal.length > 500) state.journal.shift();
}

/** `aiSettings:get` 的真实返回：`options`（默认 `{storage:'local'}`）被摊平到顶层。 */
function flattenSettings(state) {
  const { options, ...columns } = state.settings;
  return { ...(options ?? {}), ...columns };
}

/**
 * `aiSettings:update` 的真实契约：只有 `defaultLLMService` / `defaultModel` 落到自己的列，
 * 其余键**浅合并**进 `options`（与 `llmServices.options` 的整体替换语义相反）。
 */
function applySettingsUpdate(state, values) {
  const applied = {};
  const rest = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    if (key === 'defaultLLMService' || key === 'defaultModel') {
      if (value !== undefined) {
        applied[key] = value ?? null;
        state.settings[key] = value ?? null;
      }
      continue;
    }
    if (value !== undefined) rest[key] = value;
  }
  state.settings.options = { ...(state.settings.options ?? {}), ...rest };
  state.settings.updatedAt = now();
  return applied;
}

/**
 * 模型配置分发。
 *
 * @returns {{code:number, body:unknown}|null} null = 不是本层负责的动作。
 */
export function modelLocal(action, ctx, state) {
  const { method, url, values } = ctx;
  const sp = searchParamsOf(url);
  const { filter } = parseFilterParam(sp);
  const filterByTk = String(sp.get('filterByTk') ?? values?.filterByTk ?? '');

  if (action === 'ai:listLLMProviders' && method === 'GET') {
    journalModel(state, { method, action, rows: state.providers.length });
    return ok(state.providers.map((item) => ({ ...item })), { count: state.providers.length });
  }

  if (action === 'ai:listLLMServices' && method === 'GET') {
    // 真实契约：强制 `enabled != false`（停用服务不出现在脱敏列表里）。
    const rows = state.services.filter((item) => item.enabled !== false).map(maskService);
    journalModel(state, { method, action, rows: rows.length, masked: true, enabledOnly: true });
    return { code: 200, body: pagedEnvelope(rows, sp, { defaultPageSize: 50, hasNext: true }) };
  }

  if (action === 'llmServices:list' && method === 'GET') {
    // 管理读：含明文 `options`；真实默认 pageSize 50（data-source-manager 列表）。
    let rows = state.services.map((item) => ({ ...item }));
    const keyword = filter?.title?.$includes ?? filter?.title;
    if (typeof keyword === 'string' && keyword) {
      rows = rows.filter((item) => String(item.title ?? '').includes(keyword));
    }
    const sorts = readSortParam(sp);
    if (sorts.length) rows.sort((a, b) => compareRows(a, b, sorts));
    const fields = readArrayParam(sp, 'fields');
    if (fields.length) rows = rows.map((row) => pickFields(row, fields));
    journalModel(state, { method, action, rows: rows.length, plaintextOptions: true });
    return { code: 200, body: pagedEnvelope(rows, sp, { defaultPageSize: 50 }) };
  }

  if (action === 'llmServices:get' && method === 'GET') {
    const service = state.services.find((item) => item.name === filterByTk);
    journalModel(state, { method, action, name: filterByTk, found: Boolean(service) });
    // 真实实测：不存在的服务返回 **200 `{data:null}`**（不是 404）。
    return ok(service ? { ...service } : null);
  }

  if (action === 'llmServices:create' && method === 'POST') {
    const name = String(values?.name ?? '').trim();
    if (!name) return fail(400, 'INVALID_NAME', 'Service name is required');
    if (state.services.some((item) => item.name === name)) {
      return fail(400, 'DUPLICATE_NAME', `LLM service "${name}" already exists`);
    }
    if (!values?.provider) return fail(400, 'INVALID_PROVIDER', 'Provider is required');
    const check = validateEnabledModels(values.enabledModels);
    if (!check.ok) {
      return {
        code: 400,
        body: { errors: [{ code: check.code, message: check.code }], data: { index: check.index } },
      };
    }
    const service = {
      name,
      title: values.title ?? name,
      provider: values.provider,
      enabled: values.enabled !== false,
      sort: Number(values.sort ?? state.services.length + 1),
      options: values.options ?? {},
      enabledModels: normalizeEnabledModelsPayload(values.enabledModels) ?? { mode: 'recommended', models: [] },
      modelOptions: values.modelOptions ?? {},
      createdAt: now(),
      updatedAt: now(),
    };
    state.services.push(service);
    journalModel(state, { method, action, name, created: true, optionKeys: Object.keys(service.options).sort() });
    return ok({ ...service });
  }

  if (action === 'llmServices:update' && method === 'POST') {
    const service = state.services.find((item) => item.name === filterByTk);
    if (!service) return fail(404, 'NOT_FOUND', `LLM service "${filterByTk}" not found`);
    const check = validateEnabledModels(values?.enabledModels);
    if (!check.ok) {
      return {
        code: 400,
        body: { errors: [{ code: check.code, message: check.code }], data: { index: check.index } },
      };
    }
    for (const key of ['title', 'provider', 'enabled', 'sort']) {
      if (values?.[key] !== undefined) service[key] = values[key];
    }
    // 真实契约：`options` **整体替换**（省略才保留原值）——不是 jsonb 深合并。
    if (values?.options !== undefined) service.options = values.options;
    if (values?.enabledModels !== undefined) {
      service.enabledModels = normalizeEnabledModelsPayload(values.enabledModels) ?? service.enabledModels;
    }
    if (values?.modelOptions !== undefined) service.modelOptions = values.modelOptions;
    service.updatedAt = now();
    journalModel(state, {
      method,
      action,
      name: filterByTk,
      optionsReplaced: values?.options !== undefined,
      optionKeys: Object.keys(service.options ?? {}).sort(),
    });
    return ok({ ...service });
  }

  if (action === 'llmServices:destroy' && method === 'POST') {
    const index = state.services.findIndex((item) => item.name === filterByTk);
    if (index < 0) return fail(404, 'NOT_FOUND', `LLM service "${filterByTk}" not found`);
    state.services.splice(index, 1);
    journalModel(state, { method, action, name: filterByTk, destroyed: true });
    return ok({ name: filterByTk, deleted: true });
  }

  /* ---------------- 模型目录（显式、受控、不外呼） ---------------- */
  // 真实契约是 GET `ai:listModels?llmService=<name>&model=<LLM|EMBEDDING>`；
  // 产品侧因动作名不在 readActions 里而发 POST（body `{llmService,model}`）。两种都收。
  if (action === 'ai:listModels' && (method === 'GET' || method === 'POST')) {
    const name = String(method === 'GET' ? sp.get('llmService') ?? '' : values?.llmService ?? '');
    const service = state.services.find((item) => item.name === name);
    if (!service) return fail(400, 'INVALID_LLM_SERVICE', 'invalid llm service');
    if (!state.providers.some((item) => item.name === service.provider)) {
      return fail(400, 'INVALID_LLM_PROVIDER', 'invalid llm provider');
    }
    const models = normalizeEnabledModelValues(service.enabledModels);
    journalModel(state, { method, action, name, models: models.length, source: 'enabledModels' });
    return ok(models.map((id) => ({ id })), { count: models.length });
  }

  if (action === 'ai:listProviderModels' && method === 'POST') {
    const provider = state.providers.find((item) => item.name === values?.provider);
    if (!provider) return fail(400, 'INVALID_LLM_PROVIDER', 'invalid llm provider');
    const options = values?.options ?? {};
    if (options.baseURL !== undefined && options.baseURL !== null && String(options.baseURL).trim() === '') {
      return fail(400, 'INVALID_BASE_URL', 'Invalid baseURL');
    }
    if (!options.apiKey && provider.name !== 'ollama') {
      return fail(400, 'API_KEY_REQUIRED', 'API Key required');
    }
    const supported = provider.supportedModel ?? [];
    journalModel(state, { method, action, provider: provider.name, models: supported.length });
    return ok(supported.map((id) => ({ id })), { count: supported.length });
  }

  /* ---------------- LM-04 默认设置 ---------------- */
  if (action === 'aiSettings:get' && method === 'GET') {
    journalModel(state, { method, action });
    return ok(flattenSettings(state));
  }

  if (action === 'aiSettings:publicGet' && method === 'GET') {
    return ok({ storage: state.settings.storage ?? 'local' });
  }

  if (action === 'aiSettings:update' && method === 'POST') {
    const applied = applySettingsUpdate(state, values);
    journalModel(state, { method, action, applied });
    return ok(flattenSettings(state));
  }

  /* ---------------- LM-05 试飞：本机受控、零费用 ---------------- */
  if (action === 'ai:testFlight' && method === 'POST') {
    const scenario = state.testScenario;
    journalModel(state, {
      method,
      action,
      provider: values?.provider,
      model: values?.model,
      scenario,
      // 只记录"有没有密钥/地址"，**不记录任何密钥值**。
      hasApiKey: Boolean(values?.options?.apiKey),
      hasBaseURL: Boolean(values?.options?.baseURL),
    });
    if (scenario === 'failure') {
      // 真实契约：`{status,code,message}`；原生客户端按 `code !== 0` 判失败，产品按 `status` 判。
      return ok({
        status: 'error',
        code: -1,
        message: 'Invalid API key or unsupported model (local synthetic answer; no provider was called).',
      });
    }
    return ok({
      status: 'success',
      code: 0,
      message: 'Local synthetic answer: configuration accepted (no provider was called, no cost).',
      provider: values?.provider ?? null,
      model: values?.model ?? null,
    });
  }

  /* ---------------- 员工（LM-04 的只读关联） ---------------- */
  if ((action === 'aiEmployees:list' || action === 'aiEmployees:listByUser') && (method === 'GET' || method === 'POST')) {
    const rows = state.employees
      .filter((item) => (action === 'aiEmployees:listByUser' ? item.enabled === true : true))
      .map((item) => ({ ...item }));
    journalModel(state, { method, action, rows: rows.length });
    return ok(rows, { count: rows.length });
  }

  if (action === 'aiEmployees:get' && method === 'GET') {
    const employee = state.employees.find((item) => item.username === filterByTk);
    if (!employee) return fail(404, 'NOT_FOUND', `本机合成环境没有员工 ${filterByTk}。`);
    return ok({ ...employee });
  }

  return null;
}

/** `enabledModels` 的两种真实形状（对象 `{mode,models}` / 历史字符串数组）→ 模型 id 列表。 */
export function normalizeEnabledModelValues(raw) {
  if (Array.isArray(raw)) return raw.map((item) => String(item)).filter(Boolean);
  if (raw && typeof raw === 'object') {
    const models = Array.isArray(raw.models) ? raw.models : [];
    return models
      .map((item) => (item && typeof item === 'object' ? String(item.value ?? item.label ?? '') : String(item ?? '')))
      .filter(Boolean);
  }
  return [];
}

/** 控制页用的可读摘要（**不含密钥值**，只列键名）。 */
export function modelSelfSummary(state) {
  return {
    providers: state.providers.map((item) => item.name),
    services: state.services.map((item) => ({
      name: item.name,
      title: item.title,
      provider: item.provider,
      enabled: item.enabled,
      optionKeys: Object.keys(item.options ?? {}).sort(),
      hasApiKey: Boolean(item.options?.apiKey),
      enabledModels: normalizeEnabledModelValues(item.enabledModels),
      enabledModelsShape: Array.isArray(item.enabledModels) ? 'legacy-array' : item.enabledModels?.mode ?? 'unset',
    })),
    settings: { ...state.settings },
    employees: state.employees.map((item) => ({
      username: item.username,
      nickname: item.nickname,
      restricted: item.modelSettings?.enabled === true,
      models: normalizeEnabledModelValues(item.modelSettings?.models),
      preferred: item.modelSettings?.model ?? null,
    })),
    testScenario: state.testScenario,
    journal: state.journal.slice(-80),
  };
}

/** 控制页用的工作流摘要（执行状态、版本、分类、最近日志）。 */
export function workflowSelfSummary(store) {
  return {
    categories: (store.categories ?? WORKFLOW_CATEGORIES).map((item) => ({ ...item })),
    versions: Object.values(store.versions).map((version) => ({
      id: version.id,
      key: version.key,
      title: version.title,
      current: Boolean(version.current),
      enabled: Boolean(version.enabled),
      executed: Number(version.versionStats?.executed ?? 0),
      nodeCount: (version.nodes ?? []).length,
      categories: categoriesOf(version, store).map((item) => item.id),
    })),
    executions: Object.values(store.executions).map((execution) => ({
      id: execution.id,
      workflowId: execution.workflowId,
      status: execution.status ?? null,
      reason: execution.reason ?? null,
      jobCount: execution.jobs.length,
    })),
    testScenario: store.testScenario,
    journal: store.journal.slice(-80),
  };
}

export { WF as WORKFLOW_IDS };
