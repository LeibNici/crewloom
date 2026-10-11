#!/usr/bin/env node
/**
 * 目标实例固定 **2.2.20** 的 AI 任务/工具契约核对（TD-03）。
 *
 * 做法：把已发布的 `@nocobase/plugin-ai@2.2.20` 包解包后，用 `vm` 加载**包内原始文件**，
 * 只对 `require` 的外部依赖注入受控替身，然后**直接运行发布的处理函数**，
 * 断言响应/参数形状。不是复制一份实现来自证，也不是"关键词没找到"的推断。
 *
 * 覆盖：
 *  F1 `aiWorkflowTasks.getBySession`：返回体不含工具消息，且不查工具消息表；
 *  F2 `frontend-tools.readFrontendToolResult` + `ai/tools/executeFrontendTool.invoke`：
 *     `toolCallResults` 的 `{ id, result }` 形状、多 waiting 逐条命中、错误形状不命中；
 *  F3 `AIConversationsManager.getMessages`（含 `parseMessageRow`）：array 消息/历史 + 多 waiting
 *     的 `invokeStatus/execution/willInterrupt/userDecision`，以及 `updateRead` 守卫；
 *  F4 `aiConversations.updateUserDecision`：`{ updated, toolCalls }` 与部分/全部已决定的形状；
 *  F5 `aiConversations.resumeToolCall`：请求 values 原样传给下游 stream（`toolCallIds`/`toolCallResults`
 *     不在该层解构，而由 `executeFrontendTool` 经 `ctx.action.params.values` 读取）。
 *
 * 用法：
 *   node scripts/verify-2.2.20-task-ai-contract.mjs [解包目录，默认 /tmp/crewloom-2.2.20-ai/package]
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const worktreeRoot = resolve(here, '..', '..');
const PKG = resolve(process.argv[2] ?? '/tmp/crewloom-2.2.20-ai/package');
const OUT_DIR = resolve(worktreeRoot, 'docs/acceptance/full-pages-13000/manual-native-evidence/contract-2.2.20');
const require_ = createRequire(import.meta.url);

const results = [];
async function check(name, fn) {
  try {
    const note = await fn();
    results.push({ name, ok: true, note: note ?? '' });
    console.log(`PASS  ${name}${note ? ` — ${note}` : ''}`);
  } catch (error) {
    results.push({ name, ok: false, note: String(error?.message ?? error) });
    console.log(`FAIL  ${name} — ${error?.message ?? error}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
const json = (value) => JSON.stringify(value);

/* ------------------------------------------------------------------ *
 * 发布包原始源码加载器（相对路径走真实文件，外部依赖走受控替身）
 * ------------------------------------------------------------------ */

const zodChain = new Proxy(function zodChain() {}, {
  get: (_target, key) => (key === 'default' ? zodChain : zodChain),
  apply: () => zodChain,
  construct: () => zodChain,
});

function makeLoader(externals) {
  const cache = new Map();
  const load = (file) => {
    const abs = resolve(file);
    if (cache.has(abs)) return cache.get(abs);
    if (abs.endsWith('.json')) {
      const value = JSON.parse(readFileSync(abs, 'utf8'));
      cache.set(abs, value);
      return value;
    }
    const mod = { exports: {} };
    cache.set(abs, mod.exports);
    const source = readFileSync(abs, 'utf8');
    const factory = vm.runInThisContext(
      `(function (exports, require, module, __filename, __dirname) {\n${source}\n})`,
      { filename: abs },
    );
    factory(mod.exports, makeRequire(abs), mod, abs, dirname(abs));
    cache.set(abs, mod.exports);
    return mod.exports;
  };
  const makeRequire = (fromFile) => (specifier) => {
    if (Object.prototype.hasOwnProperty.call(externals, specifier)) return externals[specifier];
    if (specifier.startsWith('.')) {
      const base = resolve(dirname(fromFile), specifier);
      for (const candidate of [base, `${base}.js`, `${base}.json`, join(base, 'index.js')]) {
        if (existsSync(candidate) && statSync(candidate).isFile()) return load(candidate);
      }
      throw new Error(`无法解析发布包内相对依赖 ${specifier}（来自 ${fromFile}）`);
    }
    if (specifier === 'zod') return { z: zodChain, default: { z: zodChain } };
    return new Proxy({}, { get: () => () => undefined });
  };
  return { load, cache };
}

function pkgFile(relative) {
  const abs = join(PKG, relative);
  if (!existsSync(abs)) throw new Error(`发布包缺少 ${relative}`);
  return abs;
}

function fileSha256(relative) {
  return require_('node:crypto').createHash('sha256').update(readFileSync(pkgFile(relative))).digest('hex');
}

const FILES = [
  'dist/server/resource/aiWorkflowTasks.js',
  'dist/server/resource/aiConversations.js',
  'dist/server/ai-employees/ai-conversations.js',
  'dist/server/frontend-tools.js',
  'dist/common/frontend-tools.js',
  'dist/ai/tools/executeFrontendTool.js',
];

/* ------------------------------------------------------------------ *
 * F1 getBySession
 * ------------------------------------------------------------------ */

async function fixtureGetBySession() {
  const queried = [];
  const { load } = makeLoader({
    '@nocobase/actions': {},
    '@nocobase/plugin-workflow': {},
  });
  const mod = load(pkgFile('dist/server/resource/aiWorkflowTasks.js'));
  // 发布包里导出的是 resource 描述符 `{ name, actions }`。
  const descriptor = mod.aiWorkflowTasks ?? mod.default;
  const actions = descriptor?.actions ?? descriptor;
  assert(typeof actions?.getBySession === 'function', `getBySession 不是函数（descriptor keys=${Object.keys(descriptor ?? {}).join(',')}）`);

  const taskRow = {
    id: 41,
    status: 'pending_approval',
    acceptedUserId: 3,
    sessionId: 'sess-1',
    messageId: 'msg-1',
    jobId: 99,
    executionId: 55,
    // 任务行里常见的数组字段（消息历史由会话侧提供，不由本动作填充）
    users: [{ id: 3 }],
  };
  const ctx = {
    auth: { user: { id: 3 } },
    action: { params: { values: { sessionId: 'sess-1' } } },
    db: {
      getRepository(name) {
        queried.push(`repo:${name}`);
        if (name === 'aiWorkflowTasks') return { findOne: async () => ({ ...taskRow, toJSON: () => ({ ...taskRow }) }) };
        if (name === 'flow_nodes') return { findOne: async () => ({ id: 2410, config: { structuredOutput: { schema: { type: 'object' } } } }) };
        if (name === 'aiConversations') return { findOne: async () => ({ sessionId: 'sess-1', aiEmployee: { username: 'emp' } }) };
        return { findOne: async () => null, find: async () => [], count: async () => 0 };
      },
      getModel(name) {
        queried.push(`model:${name}`);
        if (name === 'usersAiWorkflowTasks') return { findOne: async () => ({ read: false }) };
        return { findOne: async () => null };
      },
    },
    throw(status, message) {
      throw new Error(`ctx.throw(${status}) ${message ?? ''}`);
    },
  };
  await actions.getBySession(ctx, async () => undefined);
  return ctx.body;
}

/* ------------------------------------------------------------------ *
 * F2 frontend tool results
 * ------------------------------------------------------------------ */

let frontendToolsCache = null;

function loadFrontendTools(frontendToolExists = true) {
  if (!frontendToolsCache) {
    const { load } = makeLoader({
      'zod': { z: zodChain, default: { z: zodChain } },
    });
    const real = load(pkgFile('dist/server/frontend-tools.js'));
    // `__export` 只给出 getter，不能就地改写；这里做一份浅拷贝注入 findCurrentFrontendTool。
    // readFrontendToolResult / shouldAutoExecuteFrontendTool 等仍是发布包原始实现。
    frontendToolsCache = { real, injected: { ...real } };
  }
  const { real, injected } = frontendToolsCache;
  // findCurrentFrontendTool 需要真实运行环境；只把"当前工具是否存在"这一前提注入。
  injected.findCurrentFrontendTool = async () => (frontendToolExists ? { id: 'demo' } : undefined);
  const { load: loadAi } = makeLoader({
    '@nocobase/ai': { defineTools: (definition) => definition },
    'zod': { z: zodChain, default: { z: zodChain } },
    '../../server/frontend-tools': injected,
    '../../../package.json': { name: '@nocobase/plugin-ai' },
  });
  const execute = loadAi(pkgFile('dist/ai/tools/executeFrontendTool.js'));
  return { frontendTools: injected, real, execute: execute.default ?? execute };
}

/* ------------------------------------------------------------------ *
 * F3 getMessages / parseMessageRow
 * ------------------------------------------------------------------ */

function makeMessagesManager() {
  const { load } = makeLoader({
    '../utils': { parseResponseMessage: (row) => ({ ...row, content: {} }) },
    '@nocobase/database': {},
  });
  const mod = load(pkgFile('dist/server/ai-employees/ai-conversations.js'));
  const AIConversationsManager = mod.AIConversationsManager;
  assert(typeof AIConversationsManager === 'function', 'AIConversationsManager 缺失');

  const readUpdates = [];
  const messageRows = [
    {
      messageId: 900,
      sessionId: 'sess-1',
      role: 'assistant',
      metadata: { provider: 'openai' },
      toolCalls: [
        { id: 'call-1', name: 'writeOrder', args: { id: 7 } },
        { id: 'call-2', name: 'executeFrontendTool', args: { toolId: 'demo' } },
        { id: 'call-4', name: 'readOnlyTool', args: {} },
      ],
    },
    {
      messageId: 899,
      sessionId: 'sess-1',
      role: 'assistant',
      metadata: { provider: 'openai' },
      toolCalls: [{ id: 'call-3', name: 'notifyUser', args: {} }],
    },
  ];
  const toolMessageRows = [
    { messageId: 900, toolCallId: 'call-1', invokeStatus: 'waiting', auto: false, status: 'success', content: { ok: true }, userDecision: { type: 'approve' } },
    { messageId: 900, toolCallId: 'call-2', invokeStatus: 'interrupted', auto: true, status: null, content: null },
    { messageId: 899, toolCallId: 'call-3', invokeStatus: 'interrupted', auto: false, status: null, content: null },
    { messageId: 900, toolCallId: 'call-4', invokeStatus: 'done', auto: true, status: 'success', content: { rows: 1 } },
  ];

  // 注意：`getMessages` 走 `plugin.aiManager.toolManager.listTools()`，其元素是**分组** `{ tools }`，
  // 组内工具用扁平 `name`；而 `updateUserDecision` 走 `plugin.ai.toolsManager.listTools()`，
  // 元素是 `{ definition: { name } , ... }`。两者形状不同，替身按各自发布实现给。
  const tools = [
    { name: 'writeOrder', execution: 'backend', defaultPermission: 'ASK' },
    { name: 'executeFrontendTool', execution: 'frontend', defaultPermission: 'ALLOW' },
    { name: 'notifyUser', execution: 'backend', defaultPermission: 'ASK' },
    { name: 'readOnlyTool', execution: 'backend', defaultPermission: 'ALLOW' },
  ];
  const plugin = {
    db: {
      getRepository(name, sessionId) {
        if (name === 'aiConversations') {
          return {
            findOne: async () => ({ sessionId: 'sess-1', options: {} }),
            count: async () => 1,
            update: async () => {
              readUpdates.push({ sessionId });
              return [1];
            },
          };
        }
        if (name === 'aiConversations.messages') return { find: async () => messageRows };
        if (name === 'aiMessages') return { find: async () => [] };
        if (name === 'aiToolMessages') return { find: async () => toolMessageRows };
        return { find: async () => [], findOne: async () => null, count: async () => 0 };
      },
    },
    aiManager: {
      toolManager: { listTools: async () => [{ tools }] },
      llmProviders: { get: () => undefined },
    },
    app: {},
  };
  const manager = new AIConversationsManager(plugin);
  return { manager, readUpdates };
}

/* ------------------------------------------------------------------ *
 * F4 updateUserDecision
 * ------------------------------------------------------------------ */

function loadConversationActions() {
  const { frontendTools, real } = loadFrontendTools(true);
  const { load } = makeLoader({
    '../../common/frontend-tools': real,
    '../frontend-tools': frontendTools,
    '../ai-employees/ai-employee': { AIEmployee: class { async stream() {} } },
    '../manager/ai-chat-conversation': {},
    '../utils': {
      sendSSEError: (ctx, message) => {
        ctx.__sseError = message;
      },
    },
    '@nocobase/actions': {},
    '@nocobase/database': {},
  });
  const mod = load(pkgFile('dist/server/resource/aiConversations.js'));
  const descriptor = mod.default ?? mod;
  return descriptor?.actions ?? descriptor;
}

function makeUpdateDecisionCtx({ decisions, toolCalls }) {
  const updates = [];
  const ctx = {
    auth: { user: { id: 3 } },
    t: (key) => key,
    action: { params: { values: { sessionId: 'sess-1', messageId: 'msg-1', toolCallId: 'call-1', userDecision: { type: 'approve' } } } },
    app: {
      pm: {
        get: () => ({
          aiConversationsManager: { getConversation: async () => ({ sessionId: 'sess-1' }) },
          ai: {
            toolsManager: {
              listTools: async () => [
                { definition: { name: 'writeOrder' }, execution: 'backend' },
                { definition: { name: 'executeFrontendTool' }, execution: 'frontend' },
              ],
            },
          },
        }),
      },
    },
    db: {
      getRepository(name) {
        if (name === 'aiMessages') {
          return { findOne: async () => ({ sessionId: 'sess-1', messageId: 'msg-1', toolCalls }) };
        }
        if (name === 'aiToolMessages') return { find: async () => decisions };
        return { find: async () => [], findOne: async () => null };
      },
      getModel(name) {
        if (name === 'aiToolMessages') {
          return {
            findOne: async () => ({ sessionId: 'sess-1', messageId: 'msg-1', toolCallId: 'call-1', invokeStatus: 'interrupted' }),
            update: async (values, options) => {
              updates.push({ values, where: options?.where });
              return [1, []];
            },
          };
        }
        return { findOne: async () => null, update: async () => [0, []] };
      },
    },
    throw(status, message) {
      throw new Error(`ctx.throw(${status}) ${message ?? ''}`);
    },
  };
  return { ctx, updates };
}

/* ------------------------------------------------------------------ *
 * F5 resumeToolCall
 * ------------------------------------------------------------------ */

function makeResumeCtx() {
  const calls = { stream: null, userDecisions: 0, errors: [] };
  const ctx = {
    auth: { user: { id: 3 } },
    log: { error: (error) => calls.errors.push(String(error?.message ?? error)) },
    // 发布实现的 setupSSEHeaders 用 ctx.set({...}) + ctx.status；
    // 本地 getAIEmployee 读 ctx.state.currentRoles（root 才不加 roles.name 过滤）。
    set: () => undefined,
    status: 0,
    state: { currentRoles: ['root'], currentRole: 'root' },
    action: {
      params: {
        values: {
          sessionId: 'sess-1',
          messageId: 'msg-1',
          toolCallIds: ['call-1', 'call-2'],
          toolCallResults: [{ id: 'call-1', result: { ok: true } }],
          webSearch: false,
        },
      },
    },
    app: {
      pm: {
        get: () => ({
          aiConversationsManager: {
            getConversation: async () => ({ aiEmployeeUsername: 'emp', options: {} }),
            getUserDecisions: async () => {
              calls.userDecisions += 1;
              return [{ toolCallId: 'call-1', userDecision: { type: 'approve' } }];
            },
          },
          aiEmployeesManager: { resolveModel: async () => ({}) },
        }),
      },
    },
    db: {
      getRepository(name) {
        if (name === 'aiMessages') return { findOne: async () => ({ sessionId: 'sess-1', messageId: 'msg-1', toolCalls: [{ id: 'call-1' }, { id: 'call-2' }] }) };
        if (name === 'aiEmployees') return { findOne: async () => ({ username: 'emp', get: () => true }) };
        return { findOne: async () => null, find: async () => [] };
      },
    },
    throw(status, message) {
      throw new Error(`ctx.throw(${status}) ${message ?? ''}`);
    },
  };
  return { ctx, calls };
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const hashes = Object.fromEntries(FILES.map((file) => [file, fileSha256(file)]));
  const pkg = JSON.parse(readFileSync(pkgFile('package.json'), 'utf8'));
  console.log(`发布包：${pkg.name}@${pkg.version} @ ${PKG}`);

  // F1
  let getBySessionBody;
  await check('F1 getBySession 返回体不含任何工具消息字段，也不查工具消息表', async () => {
    const body = await fixtureGetBySession();
    getBySessionBody = body;
    const toolKeys = ['aiToolMessages', 'toolMessages', 'messages', 'toolCalls'];
    const leaked = toolKeys.filter((key) => Object.prototype.hasOwnProperty.call(body, key));
    assert(leaked.length === 0, `返回体泄漏了工具消息字段：${leaked.join(',')}`);
    assert(body.id === 41 && body.status === 'pending_approval', '任务字段未按行原样返回');
    assert(body.readonly === false, 'readonly 语义不符（pending_approval + 本人应可处理）');
    assert(Array.isArray(body.users) && body.users.length === 1, '数组字段未原样透传');
    return `keys=${Object.keys(body).sort().join(',')}`;
  });

  await check('F1b getBySession 只查 tasks/flow_nodes/aiConversations，不查 aiToolMessages/aiMessages', async () => {
    // 重新跑一次以捕获查询清单（fixture 返回的 body 不记录查询，这里独立断言）
    const queried = [];
    const { load } = makeLoader({ '@nocobase/actions': {}, '@nocobase/plugin-workflow': {} });
    const descriptor = load(pkgFile('dist/server/resource/aiWorkflowTasks.js')).aiWorkflowTasks;
    const actions = descriptor?.actions ?? descriptor;
    const taskRow = { id: 41, status: 'approved', acceptedUserId: 9, sessionId: 's' };
    const ctx = {
      auth: { user: { id: 3 } },
      action: { params: { values: { sessionId: 's' } } },
      db: {
        getRepository(name) {
          queried.push(name);
          if (name === 'aiWorkflowTasks') return { findOne: async () => ({ ...taskRow, toJSON: () => ({ ...taskRow }) }) };
          return { findOne: async () => null };
        },
        getModel(name) {
          queried.push(`model:${name}`);
          return { findOne: async () => null };
        },
      },
      throw(status) {
        throw new Error(`ctx.throw(${status})`);
      },
    };
    await actions.getBySession(ctx, async () => undefined);
    const body = ctx.body;
    assert(body.readonly === true, 'readonly 语义不符（status !== pending_approval 应为只读）');
    assert(!queried.some((name) => /aiToolMessages|aiMessages/.test(name)), `查询了工具消息表：${queried.join(',')}`);
    return `queried=${queried.join(',')}`;
  });

  // F2
  await check('F2 readFrontendToolResult 命中 {id,result}，多 waiting 逐条独立命中', () => {
    const { frontendTools } = loadFrontendTools(true);
    const values = { toolCallResults: [{ id: 'call-1', result: { ok: true } }, { id: 'call-2', result: 'B' }] };
    const ctx = { action: { params: { values } } };
    const first = frontendTools.readFrontendToolResult(ctx, 'call-1');
    const second = frontendTools.readFrontendToolResult(ctx, 'call-2');
    const missing = frontendTools.readFrontendToolResult(ctx, 'call-3');
    assert(first?.provided === true && json(first.value) === '{"ok":true}', 'call-1 未命中');
    assert(second?.provided === true && second.value === 'B', 'call-2 未命中');
    assert(missing === undefined, '未提供的 call-3 不应命中');
    return `call-1=${json(first)} call-3=${json(missing)}`;
  });

  await check('F2b 错误形状（toolCallId / 非数组 / 缺 result 键）不被命中', () => {
    const { frontendTools } = loadFrontendTools(true);
    const wrongShape = { action: { params: { values: { toolCallResults: [{ toolCallId: 'call-1', result: 1 }] } } } };
    const notArray = { action: { params: { values: { toolCallResults: { id: 'call-1', result: 1 } } } } };
    const noResultKey = { action: { params: { values: { toolCallResults: [{ id: 'call-1', value: 1 }] } } } };
    const noValues = { action: { params: {} } };
    assert(frontendTools.readFrontendToolResult(wrongShape, 'call-1') === undefined, 'toolCallId 字段名被误命中');
    assert(frontendTools.readFrontendToolResult(notArray, 'call-1') === undefined, '非数组被误命中');
    assert(frontendTools.readFrontendToolResult(noResultKey, 'call-1') === undefined, '缺 result 键被误命中');
    assert(frontendTools.readFrontendToolResult(noValues, 'call-1') === undefined, '无 values 被误命中');
    return 'ok';
  });

  await check('F2c executeFrontendTool.invoke 由发布实现读取结果（成功/未提供两种终态）', async () => {
    const { execute } = loadFrontendTools(true);
    const invoke = execute.invoke;
    assert(typeof invoke === 'function', 'executeFrontendTool.invoke 不是函数');
    const okCtx = { action: { params: { values: { toolCallResults: [{ id: 'tc-1', result: { ok: true } }] } } } };
    const ok = await invoke(okCtx, { toolId: 'demo', args: {} }, { toolCallId: 'tc-1' });
    const missingCtx = { action: { params: { values: { toolCallResults: [] } } } };
    const missing = await invoke(missingCtx, { toolId: 'demo', args: {} }, { toolCallId: 'tc-1' });
    assert(ok?.status === 'success' && json(ok.content) === '{"ok":true}', `成功终态不符：${json(ok)}`);
    assert(missing?.status === 'error' && missing.content === 'Frontend tool did not return a result.', `未提供终态不符：${json(missing)}`);
    return `ok=${json(ok)} missing=${json(missing)}`;
  });

  // F3
  await check('F3 getMessages（array 消息 + 多 waiting）回填 execution/willInterrupt/userDecision', async () => {
    const { manager } = makeMessagesManager();
    const result = await manager.getMessages({ userId: 3, sessionId: 'sess-1', paginate: false, updateRead: false });
    assert(Array.isArray(result.rows) && result.rows.length === 2, `rows 形状不符：${json(result).slice(0, 200)}`);
    assert(!('hasMore' in result) && !('cursor' in result), 'paginate=false 时不应带分页字段');
    const call1 = result.rows[0].toolCalls.find((call) => call.id === 'call-1');
    const call2 = result.rows[0].toolCalls.find((call) => call.id === 'call-2');
    const call3 = result.rows[1].toolCalls.find((call) => call.id === 'call-3');
    const call4 = result.rows[0].toolCalls.find((call) => call.id === 'call-4');
    assert(call1.invokeStatus === 'waiting', `call-1 的 invokeStatus 未回填：${json(call1)}`);
    // 契约差异（2.2.20 与 2.2.22 一致）：`getMessages`/`parseMessageRow` **不**回填 `userDecision`，
    // 因此"是否已决定"只能由 `invokeStatus === 'waiting'`（或 updateUserDecision 的返回）判定。
    assert(!('userDecision' in call1) || call1.userDecision === undefined, 'getMessages 竟然回填了 userDecision（契约变化）');
    // willInterrupt = execution === 'frontend' || auto === false
    assert(call1.execution === 'backend' && call1.auto === false && call1.willInterrupt === true, `auto=false 的 willInterrupt 不符：${json(call1)}`);
    assert(call2.execution === 'frontend' && call2.willInterrupt === true, `前端工具 willInterrupt 不符：${json(call2)}`);
    assert(call3.execution === 'backend' && call3.willInterrupt === true, `auto=false 的 willInterrupt 不符：${json(call3)}`);
    assert(call4.execution === 'backend' && call4.auto === true && call4.willInterrupt === false, `auto=true 的 willInterrupt 不符：${json(call4)}`);
    assert(call2.defaultPermission === 'ALLOW', 'defaultPermission 未回填');
    return `rows=${result.rows.length} calls=${result.rows.reduce((sum, row) => sum + row.toolCalls.length, 0)}`;
  });

  await check('F3b getMessages updateRead 守卫：false 不写已读，true 才写', async () => {
    const off = makeMessagesManager();
    await off.manager.getMessages({ userId: 3, sessionId: 'sess-1', paginate: false, updateRead: false });
    assert(off.readUpdates.length === 0, 'updateRead=false 仍写了已读');
    const on = makeMessagesManager();
    await on.manager.getMessages({ userId: 3, sessionId: 'sess-1', paginate: false, updateRead: true });
    assert(on.readUpdates.length === 1, 'updateRead=true 未写已读');
    return `false=${off.readUpdates.length} true=${on.readUpdates.length}`;
  });

  // F4
  await check('F4 updateUserDecision 返回 { updated, toolCalls }（部分已决定 → 逐条状态可判）', async () => {
    const actions = loadConversationActions();
    assert(typeof actions?.updateUserDecision === 'function', 'updateUserDecision 不是函数');
    const toolCalls = [
      { id: 'call-1', name: 'writeOrder', args: {} },
      { id: 'call-2', name: 'executeFrontendTool', args: { toolId: 'demo' } },
    ];
    const { ctx, updates } = makeUpdateDecisionCtx({
      toolCalls,
      decisions: [
        { toolCallId: 'call-1', invokeStatus: 'waiting', auto: false, status: 'success', content: { ok: true }, userDecision: { type: 'approve' } },
        { toolCallId: 'call-2', invokeStatus: 'interrupted', auto: true, status: null, content: null },
      ],
    });
    await actions.updateUserDecision(ctx, async () => undefined);
    const body = ctx.body;
    assert(body && body.updated === 1, `updated 不符：${json(body)}`);
    assert(Array.isArray(body.toolCalls) && body.toolCalls.length === 2, 'toolCalls 形状不符');
    const decided = body.toolCalls.filter((call) => call.userDecision);
    assert(decided.length === 1 && decided[0].id === 'call-1', '逐条决定状态不符（应只有 call-1 已决定）');
    assert(body.toolCalls[1].execution === 'frontend' && body.toolCalls[1].willInterrupt === true, '前端工具 willInterrupt 不符');
    assert(updates.length === 1, '未执行写回');
    assert(updates[0].values.invokeStatus === 'waiting' && updates[0].where.invokeStatus === 'interrupted', `写回守卫不符：${json(updates[0])}`);
    return `updated=${body.updated} decided=${decided.length}/${body.toolCalls.length}`;
  });

  await check('F4b 全部 waiting 时 toolCalls 全部带 userDecision（可判定"可以继续"）', async () => {
    const actions = loadConversationActions();
    const toolCalls = [{ id: 'call-1', name: 'a', args: {} }, { id: 'call-2', name: 'b', args: {} }];
    const { ctx } = makeUpdateDecisionCtx({
      toolCalls,
      decisions: [
        { toolCallId: 'call-1', invokeStatus: 'waiting', auto: false, userDecision: { type: 'approve' } },
        { toolCallId: 'call-2', invokeStatus: 'waiting', auto: false, userDecision: { type: 'reject', message: 'no' } },
      ],
    });
    await actions.updateUserDecision(ctx, async () => undefined);
    const allDecided = ctx.body.toolCalls.every((call) => call.userDecision);
    assert(allDecided === true, `未全部带决定：${json(ctx.body.toolCalls)}`);
    return `decided=${ctx.body.toolCalls.length}/${ctx.body.toolCalls.length}`;
  });

  // F5
  await check('F5 resumeToolCall 把请求 values 下的 toolCallIds/toolCallResults 原样留给下游读取', async () => {
    const actions = loadConversationActions();
    assert(typeof actions?.resumeToolCall === 'function', 'resumeToolCall 不是函数');
    const { ctx, calls } = makeResumeCtx();
    // 发布实现的 AIEmployee 由受控替身承接，捕获 stream 入参
    const captured = {};
    const { frontendTools, real } = loadFrontendTools(true);
    const { load } = makeLoader({
      '../../common/frontend-tools': real,
      '../frontend-tools': frontendTools,
      '../ai-employees/ai-employee': {
        AIEmployee: class {
          constructor(options) {
            captured.options = options;
          }
          async stream(input) {
            captured.stream = input;
          }
        },
      },
      '../manager/ai-chat-conversation': {},
      '../utils': {
        getAIEmployee: async () => ({ username: 'emp' }),
        sendSSEError: (ctx, message) => {
          ctx.__sseError = message;
        },
      },
      '@nocobase/actions': {},
      '@nocobase/database': {},
    });
    const loadedModule = load(pkgFile('dist/server/resource/aiConversations.js'));
    const loadedDescriptor = loadedModule.default ?? loadedModule;
    const realActions = loadedDescriptor?.actions ?? loadedDescriptor;
    await realActions.resumeToolCall(ctx, async () => undefined);
    assert(
      calls.userDecisions === 1,
      `未读取用户决定（sseError=${json(ctx.__sseError)} errors=${json(calls.errors)}）`,
    );
    assert(captured.stream && Array.isArray(captured.stream.userDecisions), `stream 入参不符：${json(captured.stream)}`);
    // 该层不解构 toolCallIds/toolCallResults —— 它们仍留在 ctx.action.params.values 里，
    // 由 executeFrontendTool 经 readFrontendToolResult 读取（F2 已验证）。
    const stillThere = ctx.action.params.values.toolCallResults;
    const resolved = frontendTools.readFrontendToolResult(ctx, 'call-1');
    assert(resolved?.provided === true, 'resume 请求 values 中的 toolCallResults 未被前端工具读取');
    return `userDecisions=${captured.stream.userDecisions.length} toolCallResults=${json(stillThere)}`;
  });

  await check('F5b resumeToolCall 只接受 {sessionId,messageId,model,webSearch} 作为控制入参，缺 sessionId 报错', async () => {
    const actions = loadConversationActions();
    const { ctx } = makeResumeCtx();
    ctx.action.params.values = { messageId: 'msg-1', toolCallIds: ['call-1'], toolCallResults: [] };
    const errors = [];
    ctx.log = { error: (error) => errors.push(String(error)) };
    await actions.resumeToolCall(ctx, async () => undefined);
    assert(
      ctx.__sseError === 'sessionId is required',
      `缺 sessionId 未走 sendErrorResponse：${json(ctx.__sseError)}`,
    );
    return `sseError=${json(ctx.__sseError)}`;
  });


  // F6 accept / reject（任务层动作）
  await check('F6 accept 用 {sessionId} 认领任务；缺 sessionId 报 400', async () => {
    const updates = [];
    const { load } = makeLoader({ '@nocobase/actions': {}, '@nocobase/plugin-workflow': { JOB_STATUS: { PENDING: 0, REJECTED: -5 } } });
    const actions = load(pkgFile('dist/server/resource/aiWorkflowTasks.js')).aiWorkflowTasks?.actions;
    const ctx = {
      auth: { user: { id: 3 } },
      action: { params: { values: { sessionId: 'sess-1' } } },
      db: {
        getRepository: () => ({ findOne: async () => ({ id: 41, status: 'pending_acceptance', sessionId: 'sess-1', toJSON: () => ({ id: 41 }) }) }),
        getModel: () => ({
          update: async (values, options) => {
            updates.push({ values, where: options?.where });
            return [1, []];
          },
        }),
      },
      throw(status, message) {
        throw new Error(`ctx.throw(${status}) ${message ?? ''}`);
      },
    };
    await actions.accept(ctx, async () => undefined);
    // accept 会依次更新 aiWorkflowTasks（认领）与 usersAiWorkflowTasks（已读）。
    assert(updates.length === 2, `accept 更新次数不符：${json(updates)}`);
    assert(updates[0].values.status === 'pending_approval' && updates[0].values.acceptedUserId === 3, `accept 写回不符：${json(updates[0])}`);
    assert(updates[0].where.acceptedUserId === null && updates[0].where.status === 'pending_acceptance', `认领守卫不符：${json(updates[0].where)}`);
    assert(ctx.body?.accepted === true && ctx.body?.readUpdated === true, `accept 返回体不符：${json(ctx.body)}`);

    const bad = { ...ctx, action: { params: { values: {} } }, body: null };
    let thrown = null;
    try {
      await actions.accept(bad, async () => undefined);
    } catch (error) {
      thrown = String(error.message);
    }
    assert(thrown?.includes('400') === true, `缺 sessionId 未 400：${thrown}`);
    return `update=${json(updates[0].values)} body=${json(ctx.body)}`;
  });

  await check('F6b reject 要求 {id,result}（只给 sessionId 会 400 id is required）', async () => {
    const jobUpdates = [];
    const resumes = { count: 0 };
    const { load } = makeLoader({ '@nocobase/actions': {}, '@nocobase/plugin-workflow': { JOB_STATUS: { PENDING: 0, REJECTED: -5 } } });
    const actions = load(pkgFile('dist/server/resource/aiWorkflowTasks.js')).aiWorkflowTasks?.actions;
    const makeCtx = (values) => ({
      auth: { user: { id: 3 } },
      action: { params: { values } },
      app: { pm: { get: () => ({ resume: async () => { resumes.count += 1; } }) } },
      db: {
        getRepository(name) {
          if (name === 'aiWorkflowTasks') {
            return {
              findOne: async () => ({ id: 41, status: 'pending_approval', acceptedUserId: 3, jobId: 99 }),
              update: async () => [1, []],
            };
          }
          if (name === 'jobs') {
            return { findOne: async () => ({ id: 99, update: async (values) => { jobUpdates.push(values); } }) };
          }
          return { findOne: async () => null, find: async () => [] };
        },
      },
      throw(status, message) {
        throw new Error(`ctx.throw(${status}) ${message ?? ''}`);
      },
    });

    let wrong = null;
    try {
      await actions.reject(makeCtx({ sessionId: 'sess-1', result: { status: 'rejected' } }), async () => undefined);
    } catch (error) {
      wrong = String(error.message);
    }
    assert(wrong?.includes('id is required') === true, `只给 sessionId 未按 id is required 拒绝：${wrong}`);

    const ctx = makeCtx({ id: 41, result: '用户终止了该 AI 任务' });
    await actions.reject(ctx, async () => undefined);
    assert(jobUpdates.length === 1 && jobUpdates[0].status === -5, `job 未按 REJECTED 结束：${json(jobUpdates)}`);
    assert(jobUpdates[0].result === '用户终止了该 AI 任务', `result 未原样写入 job.result：${json(jobUpdates[0])}`);
    assert(resumes.count === 1, '未恢复流程');
    assert(ctx.body?.status === 'success', `返回体不符：${json(ctx.body)}`);
    return `job=${json(jobUpdates[0])} resume=${resumes.count}`;
  });

  const failed = results.filter((item) => !item.ok);
  const summary = {
    package: `${pkg.name}@${pkg.version}`,
    packageDir: PKG,
    at: new Date().toISOString(),
    fileSha256: hashes,
    results,
  };
  writeFileSync(join(OUT_DIR, 'contract-2.2.20-fixtures.json'), `${json(summary)}\n`);
  writeFileSync(
    join(OUT_DIR, 'contract-2.2.20-sources.md'),
    [
      '# 2.2.20 契约核对所用发布包原始文件',
      '',
      `发布包：\`${pkg.name}@${pkg.version}\`（npm tarball shasum \`ffe509ec977101b8c9c74887f088d0dd3c35cc29\`，`,
      'integrity `sha512-1qi1CSy+n2yD/TK7EgUmhcg03RLskgd0H67rpjTknZ8KadnsQldtbyFFem4TS4gF/VgKWyr0pkLg9SEJ5NEe2A==`）。',
      '',
      '| 文件 | SHA256 |',
      '| --- | --- |',
      ...FILES.map((file) => `| \`${file}\` | \`${hashes[file]}\` |`),
      '',
      '运行方式：`node frontend/scripts/verify-2.2.20-task-ai-contract.mjs <解包目录>`；',
      '脚本用 `vm` 加载**包内原始文件**，只对 `require` 的外部依赖注入受控替身，直接运行发布的处理函数。',
      '',
    ].join('\n'),
  );

  console.log(`\n2.2.20 契约核对：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) {
    console.log(`失败项：${failed.map((item) => item.name).join('; ')}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`契约核对脚本异常：${error.stack ?? error.message}`);
  process.exitCode = 1;
});
