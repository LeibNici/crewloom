#!/usr/bin/env node
/**
 * 电脑端聊天验收环境：**纯本机合成后端 HTTP 服务**（默认 127.0.0.1:5404）。
 *
 * 用途：给「主模型内置浏览器（电脑端优先）」的真实验收提供**完全本机**的后端：
 * 产品前端（`vite preview`，默认 5327）把 `/api`、`/files` 代理到本服务；本服务
 * **只监听 127.0.0.1**，对 `/api/**`、`/files/**`、未知路径全部在**本进程内**应答，
 * **绝不做任何外呼**，也绝不回退真实 13000。
 *
 * 分层（能复用就不重写）：
 *  1. 本文件：HTTP 外壳、请求记录、失败注入、外呼拒绝清单、控制页、未知路由 501/404；
 *  2. `scripts/lib/controlled-ai-middleware.mjs`：AI 会话（SSE 场景 / 工具两阶段 / 附件上传 /
 *     上下文数据源记录）——**原样复用**，不新写假 ChatBox / 假 FrontendToolRegistry；
 *  3. `scripts/lib/manual-fixture.mjs`：合成登录、令牌世代、角色上下文、应用壳元数据、
 *     人工待办（TD-02）——**原样复用**（不改它的字节）；
 *  4. `scripts/lib/main-browser-chat-fixture.mjs`：本环境特有的合成元数据
 *     （员工 / 工具 / 模型服务配置 / 数据源 / 集合 / 记录 / TD-03 AI 任务）。
 *
 * 可见控制页：http://127.0.0.1:5404/control
 *
 * 用法：
 *   node scripts/main-browser-chat-server.mjs                    # 127.0.0.1:5404
 *   CREWLOOM_CHAT_PORT=5404 CREWLOOM_APP_URL=http://127.0.0.1:5327 \
 *     node scripts/main-browser-chat-server.mjs
 *   node scripts/main-browser-chat-server.mjs --check             # 自检后退出
 */

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import {
  createControlledAiMiddleware,
  controlledStreamEvents,
  controlledStreamState,
} from './lib/controlled-ai-middleware.mjs';
import {
  FIXTURE_ACCOUNTS,
  FIXTURE_TASK_IDS,
  bumpFixtureEpoch,
  createFixtureState,
  resetFixtureState,
  respondFixture,
} from './lib/manual-fixture.mjs';
import {
  CHAT_ROLES,
  CHAT_ROLE_ALPHA,
  CHAT_ROLE_BETA,
  ROLE_NAMES,
  SYNTH_ATTACHMENT,
  SYNTH_COLLECTIONS,
  SYNTH_DATASOURCES,
  SYNTH_RECORDS,
  TD03_STATUS,
  chatLocal,
  chatSelfSummary,
  createChatState,
  denyReasonFor,
  ok,
  resetChatState,
  td03Task,
} from './lib/main-browser-chat-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const HOST = process.env.CREWLOOM_CHAT_HOST ?? '127.0.0.1';
const PORT = Number(process.env.CREWLOOM_CHAT_PORT ?? 5404);
const APP_URL = process.env.CREWLOOM_APP_URL ?? 'http://127.0.0.1:5327';
const MAX_LOG = 300;

/** 人工待办 fixture（TD-02）：验收模式 + 未支持接口本机 501。 */
const fixtureState = createFixtureState({ acceptanceUi: true, unknownPolicy: 'error' });
/** 本环境特有状态。 */
const chatState = createChatState();
/** 受控 AI 中间件（原样复用；只多接一个证据回调，用于控制页可见的 TD-03 计数）。 */
const controlledAi = createControlledAiMiddleware({
  onEvent: (entry) => {
    if (entry.kind === 'updateUserDecision') {
      chatState.td03.decisionCount += 1;
      chatState.td03.lastDecision = {
        messageId: entry.messageId ?? null,
        toolCallId: entry.toolCallId ?? null,
        userDecision: entry.userDecision ?? null,
      };
    }
    if (entry.kind === 'resumeToolCall') {
      chatState.td03.resumeCount += 1;
      // 原样保留本机收到的续跑载荷：控制页据此可见"被拒绝的那条不在结果里"。
      chatState.td03.lastResumeToolCallResults = {
        messageId: entry.messageId ?? null,
        toolCallIds: entry.toolCallIds ?? [],
        toolCallResults: entry.toolCallResults ?? [],
      };
    }
  },
});

function log(line) {
  process.stdout.write(`[chat-5404] ${line}\n`);
}

/* ------------------------------------------------------------------ *
 * 请求记录（含角色 / 角色世代 / 会话世代，供控制页可见核对）
 * ------------------------------------------------------------------ */

function record(entry) {
  chatState.requests.push({ at: new Date().toISOString(), ...entry });
  if (chatState.requests.length > MAX_LOG) chatState.requests.splice(0, chatState.requests.length - MAX_LOG);
}

function readHeader(headers, name) {
  if (!headers) return '';
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === lower) return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
  }
  return '';
}

function sendJson(res, code, payload, extraHeaders = {}) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    // 一眼确认应答来自本机合成后端（代理没有回退真实后端）。
    'x-crewloom-local': '1',
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

function localFail(code, errorCode, message) {
  return { code, body: { errors: [{ code: errorCode, message }], data: null } };
}

/* ------------------------------------------------------------------ *
 * 失败注入（控制页可见开关；不向产品页注入任何隐藏状态）
 * ------------------------------------------------------------------ */

function takeInjection(action) {
  const inject = chatState.inject;
  if (!inject.mode) return null;
  const matches = inject.action === null || inject.action === '*' || inject.action === action;
  if (!matches) return null;
  if (inject.remaining === 0) return null;
  if (inject.remaining > 0) inject.remaining -= 1;
  if (inject.mode === 'role') {
    return localFail(
      401,
      'ROLE_NOT_FOUND_FOR_USER',
      '（本机合成注入）当前角色对该用户已不可用：客户端应保留登录、只清角色选择并重读权限。',
    );
  }
  return localFail(
    401,
    'EXPIRED_TOKEN',
    '（本机合成注入）会话令牌已失效：客户端应清会话并回到登录页。',
  );
}

/* ------------------------------------------------------------------ *
 * 受控 AI 中间件：可流式转发，也可仅捕获（用于 TD-03 播种）
 * ------------------------------------------------------------------ */

function replayRequest({ method, url, headers, rawBody }) {
  const stream = Readable.from(rawBody && rawBody.length ? [rawBody] : []);
  stream.method = method;
  stream.url = url;
  stream.headers = headers;
  return stream;
}

/** 把中间件的写入**实时转发**给真实响应（保持真实 SSE 增量）。 */
function forwardingResponse(res) {
  const proxy = {
    statusCode: 200,
    sent: false,
    setHeader(name, value) {
      res.setHeader(name, value);
    },
    getHeader(name) {
      return res.getHeader(name);
    },
    removeHeader(name) {
      res.removeHeader(name);
    },
    flushHeaders() {
      if (!res.headersSent) res.flushHeaders?.();
    },
    write(chunk) {
      proxy.sent = true;
      if (!res.headersSent) res.statusCode = proxy.statusCode;
      return res.write(chunk);
    },
    end(chunk) {
      proxy.sent = true;
      if (!res.headersSent) res.statusCode = proxy.statusCode;
      return res.end(chunk);
    },
    destroy() {
      proxy.sent = true;
      return res.destroy();
    },
    // 让受控中间件看得见**真实连接是否已经断开**：否则它只拿到代理对象，
    // 客户端离开后仍会把 40 段全部生成并落库（Main 实测的"停止后历史反而完整"）。
    get destroyed() {
      return res.destroyed === true;
    },
    get writableEnded() {
      return res.writableEnded === true;
    },
    on(event, handler) {
      if ((event === 'close' || event === 'error') && typeof res.on === 'function') res.on(event, handler);
    },
    once() {},
    emit() {},
  };
  return proxy;
}

/** 仅捕获中间件的输出（TD-03 播种用；不与浏览器交互）。 */
function capturingResponse() {
  const chunks = [];
  return {
    statusCode: 200,
    sent: false,
    chunks,
    setHeader() {},
    getHeader() {
      return undefined;
    },
    removeHeader() {},
    flushHeaders() {},
    write(chunk) {
      this.sent = true;
      chunks.push(Buffer.from(chunk));
    },
    end(chunk) {
      this.sent = true;
      if (chunk !== undefined) chunks.push(Buffer.from(chunk));
    },
    destroy() {
      this.sent = true;
    },
    on() {},
    once() {},
    emit() {},
  };
}

async function runControlledAi({ method, url, headers, rawBody, res }) {
  const proxy = forwardingResponse(res);
  let passedThrough = false;
  await controlledAi(replayRequest({ method, url, headers, rawBody }), proxy, () => {
    passedThrough = true;
  });
  return { passedThrough, sent: proxy.sent };
}

async function captureControlledAi({ method, url, headers, rawBody }) {
  const capture = capturingResponse();
  await controlledAi(replayRequest({ method, url, headers, rawBody }), capture, () => {});
  const text = Buffer.concat(capture.chunks).toString('utf8');
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: capture.statusCode, sent: capture.sent, text, body };
}

/* ------------------------------------------------------------------ *
 * TD-03 播种：真实走受控中间件（真实会话 + 真实工具调用状态）
 * ------------------------------------------------------------------ */

const LOCAL_HEADERS = { 'content-type': 'application/json', 'x-crewloom-local-internal': '1' };

/**
 * 用 `[[tools]]` 场景在**受控中间件里真实创建**一个会话（3 条前端工具调用）。
 *
 * 不伪造任何工具状态、不预置续跑结果：任务页读到的历史、做出的决定、继续执行时
 * 收到的 `toolCallResults` 都来自这条真实链路。
 *
 * `codeBlockUid`（可选，控制页可见字段）：把这条受控消息带上一个真实 `code-editor`
 * 上下文项，工具计划就会用 `<codeBlockUid>:apply_code_change`。用户先在 AI-04 准备代码
 * 工作区（真实注册表里注册的就是同名工具），再播种/进入任务页时，"批准的那条"才会真的
 * 改动工作区，而不是报 `Frontend tool ... is unavailable`。
 */
export async function seedTd03({ status = TD03_STATUS.pendingAcceptance, codeBlockUid = null } = {}) {
  const created = await captureControlledAi({
    method: 'POST',
    url: '/api/aiConversations:create',
    headers: LOCAL_HEADERS,
    rawBody: Buffer.from(
      JSON.stringify({ aiEmployee: { username: 'synth-analyst', nickname: '合成分析员' } }),
      'utf8',
    ),
  });
  const sessionId = created.body?.data?.sessionId;
  if (!sessionId) throw new Error(`TD-03 播种失败：受控会话未创建（status=${created.status}）`);

  const uid = typeof codeBlockUid === 'string' && codeBlockUid.trim() ? codeBlockUid.trim() : null;
  const sent = await captureControlledAi({
    method: 'POST',
    url: '/api/aiConversations:sendMessages',
    headers: LOCAL_HEADERS,
    rawBody: Buffer.from(
      JSON.stringify({
        sessionId,
        aiEmployee: 'synth-analyst',
        messages: [
          {
            role: 'user',
            content: '[[tools]]',
            ...(uid
              ? {
                  workContext: [
                    {
                      type: 'code-editor',
                      uid,
                      title: '代码工作区',
                      content: { scene: 'crewloom-code-workspace', language: 'javascript', code: '// workspace\n' },
                    },
                  ],
                }
              : {}),
          },
        ],
      }),
      'utf8',
    ),
  });
  if (!sent.sent) throw new Error('TD-03 播种失败：受控 sendMessages 未被本机应答');

  chatState.td03.sessionId = sessionId;
  chatState.td03.status = status;
  chatState.td03.acceptedUserId = null;
  chatState.td03.codeBlockUid = uid;
  chatState.td03.seededAt = new Date().toISOString();
  chatState.td03.history.push({ at: chatState.td03.seededAt, kind: 'seed', sessionId, status, codeBlockUid: uid });
  // 记录会话创建时的角色世代（角色世代写保护据此判定）。
  record({ method: 'POST', action: 'aiConversations:sendMessages', sessionId, role: chatState.activeRole, roleEpoch: chatState.roleEpoch, code: 200, note: 'td03-seed' });
  return { sessionId, status, codeBlockUid: uid };
}

/* ------------------------------------------------------------------ *
 * 二次本机应答（中间件放行之后、manual-fixture 之前的补充）
 * ------------------------------------------------------------------ */

/**
 * 中间件放行后仍属"本机合成"的动作：上下文数据源列表/预览、动态集合记录。
 * 返回 null 表示本层不处理。
 */
function localAfterMiddleware(action, { method, url, headers, values }, state) {
  if (action === 'aiContextDatasources:list') return ok([], { count: 0 });
  if (action === 'aiContextDatasources:get') {
    return localFail(404, 'NOT_FOUND', '本机合成环境没有这条上下文数据源记录（会话内的记录由受控中间件应答）。');
  }
  if (action === 'aiContextDatasources:preview') {
    // 按固定 2.2.20 的 `AIContextDatasourceManager.innerQuery()` 真实形状应答：
    // `{ options, total, records }`，`records` 是**单元格行** `{name,type,value}[][]`，
    // `total` 是筛选命中的总条数。旧版这里返回 `{rows: 记录对象, count}` 是假外壳，
    // 会让真实目标上"读成 0 行/行显示 —"的问题被夹具掩盖。
    const collectionName = String(values?.collectionName ?? 'synth_tickets');
    const collection = SYNTH_COLLECTIONS.find((item) => item.name === collectionName);
    const records = SYNTH_RECORDS[collectionName] ?? [];
    const requested = Array.isArray(values?.fields) ? values.fields.filter((field) => typeof field === 'string') : [];
    const fields = requested.length > 0 ? requested : (collection?.fields ?? []).map((field) => field.name);
    const limit = Number(values?.limit ?? 20) || 20;
    const cells = records.slice(0, limit).map((record) =>
      fields.map((name) => {
        const meta = (collection?.fields ?? []).find((field) => field.name === name);
        return { name, type: meta?.type ?? 'unknown', value: record?.[name] ?? null };
      }),
    );
    return ok({ options: values ?? {}, total: records.length, records: cells });
  }
  // 动态集合读取：<collection>:list / <collection>:get（上下文工作区选记录）
  const dynamic = /^([A-Za-z_][A-Za-z0-9_]*):(list|get)$/.exec(action);
  if (dynamic) {
    const [, name, verb] = dynamic;
    const collection = SYNTH_COLLECTIONS.find((item) => item.name === name);
    if (collection) {
      const rows = SYNTH_RECORDS[name] ?? [];
      if (verb === 'list') {
        const params = new URL(url, 'http://127.0.0.1').searchParams;
        const page = Number(params.get('page') ?? 1) || 1;
        const pageSize = Number(params.get('pageSize') ?? 20) || 20;
        const start = (page - 1) * pageSize;
        return ok(rows.slice(start, start + pageSize), {
          count: rows.length,
          page,
          pageSize,
          totalPage: Math.max(1, Math.ceil(rows.length / pageSize)),
        });
      }
      const tk = new URL(url, 'http://127.0.0.1').searchParams.get('filterByTk');
      const row = rows.find((item) => String(item.id) === String(tk));
      return row ? ok(row) : localFail(404, 'NOT_FOUND', `本机合成环境没有 ${name} 记录 ${tk}`);
    }
  }
  return null;
}

/** 角色 / 身份应答的富化（在 manual-fixture 之后；不改变它的 401/世代语义）。 */
function enrichAuthResult(action, result, { headers }) {
  if (result.code !== 200 || !result.body) return result;
  const requestedRole = readHeader(headers, 'x-role');
  if (action === 'auth:check') {
    const data = result.body.data;
    if (data && typeof data === 'object') {
      data.roles = CHAT_ROLES.map((role) => ({ ...role }));
      data.defaultRole = CHAT_ROLE_ALPHA;
    }
    return result;
  }
  if (action === 'roles:check') {
    const data = result.body.data;
    if (data && typeof data === 'object') {
      // 服务端按 X-Role 决定生效角色；不接受时回落默认角色（客户端会放弃显式选择）。
      const effective = ROLE_NAMES.has(requestedRole) && requestedRole !== 'anonymous' && requestedRole !== 'root'
        ? requestedRole
        : CHAT_ROLE_ALPHA;
      data.role = effective;
      data.roleMode = 'default';
      data.roles = CHAT_ROLES.map((role) => ({ ...role }));
      if (effective !== chatState.activeRole) {
        chatState.activeRole = effective;
        chatState.roleEpoch += 1;
        const switched = chatState.requests[chatState.requests.length - 1];
        if (switched) switched.note = `role-switch → ${effective}（角色世代 ${chatState.roleEpoch}）`;
        log(`角色世代 → ${chatState.roleEpoch}（生效角色 ${effective}）`);
      } else {
        chatState.activeRole = effective;
      }
      // 角色世代在切换判定**之后**写入响应：客户端/自检据此看到"换角色会推进世代"。
      data.roleEpoch = chatState.roleEpoch;
    }
    return result;
  }
  if (action === 'roles:list') {
    return ok(
      CHAT_ROLES.map((role) => ({
        ...role,
        allowConfigure: false,
        snippets: ['pm', 'pm.*', 'ui.*'],
        strategy: null,
        actions: {},
        resources: [],
        availableActions: ['create', 'view', 'update', 'destroy'],
      })),
      { count: CHAT_ROLES.length },
    );
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * /api 分发
 * ------------------------------------------------------------------ */

async function dispatchApi(req, res, { pathname, url, method, headers, rawBody, values }) {
  const action = pathname.slice('/api/'.length);
  const role = readHeader(headers, 'x-role') || null;

  // 1) 失败注入（控制页可见开关）：在到达任何层之前生效。
  const injected = takeInjection(action);
  if (injected) {
    record({ method, action, role, roleEpoch: chatState.roleEpoch, code: injected.code, note: `inject:${chatState.inject.mode}` });
    log(`注入 401（${chatState.inject.mode}）→ ${action}`);
    if (injected.code === 401 && chatState.inject.mode === 'session') {
      // 会话失效注入同时让本机令牌世代前进：旧令牌真的失效（不是只改一个响应码）。
      bumpFixtureEpoch(fixtureState);
    }
    return sendJson(res, injected.code, injected.body);
  }

  // 2) X-Role 合法性：不属于该用户的角色 → 真实契约里的角色失效（保 token，不踢登录）。
  if (role && !ROLE_NAMES.has(role)) {
    record({ method, action, role, roleEpoch: chatState.roleEpoch, code: 401, note: 'ROLE_NOT_FOUND_FOR_USER' });
    return sendJson(
      res,
      401,
      localFail(401, 'ROLE_NOT_FOUND_FOR_USER', `合成账号没有角色 ${role}（本机合成角色见 /control）。`).body,
    );
  }

  // 3) 外呼 / 真实写动作：显式拒绝（不是空成功）。
  const denyReason = denyReasonFor(action);
  if (denyReason) {
    chatState.denied.push({ at: new Date().toISOString(), method, action, reason: denyReason });
    record({ method, action, role, roleEpoch: chatState.roleEpoch, code: 403, note: '本地拒绝（不外呼）' });
    log(`本机拒绝（不外呼）：${method} ${action}`);
    return sendJson(res, 403, localFail(403, 'SYNTH_LOCAL_DENIED', denyReason).body);
  }

  // 4) 本环境特有的合成元数据（员工 / 工具 / 模型服务配置 / 数据源 / 集合 / TD-03 任务）。
  const local = chatLocal(action, { method, url, headers, values }, chatState);
  if (local) {
    record({ method, action, role, roleEpoch: chatState.roleEpoch, code: local.code });
    return sendJson(res, local.code, local.body);
  }

  // 5) 受控 AI 中间件（复用）：AI 会话流式 / 工具两阶段 / 附件 / 上下文记录。
  //    `aiFiles:create` 的字节先在本机留存一份，让附件链接可下载（应答仍由中间件给出）。
  if (action === 'aiFiles:create' && method === 'POST' && rawBody) {
    const saved = rememberUpload(rawBody, readHeader(headers, 'content-type'));
    if (saved) log(`本机留存附件：${saved.filename}（${saved.bytes} 字节，sha256 ${saved.sha256.slice(0, 12)}…）`);
  }
  const before = chatState.requests.length;
  const controlled = await runControlledAi({ method, url, headers, rawBody, res });
  if (controlled.sent) {
    record({ method, action, role, roleEpoch: chatState.roleEpoch, code: 200, note: 'controlled-ai' });
    return undefined;
  }
  if (chatState.requests.length !== before) {
    // 中间件已应答过（例如 /__crewloom/*），但未写 res：正常路径不会到这里。
    log(`中间件已处理但未写入响应：${method} ${action}`);
  }

  // 6) 中间件放行后的补充本机应答。
  const after = localAfterMiddleware(action, { method, url, headers, values }, chatState);
  if (after) {
    record({ method, action, role, roleEpoch: chatState.roleEpoch, code: after.code });
    return sendJson(res, after.code, after.body);
  }

  // 7) manual-fixture：合成登录 / 令牌世代 / 应用壳元数据 / 人工待办（TD-02）。
  const captured = {};
  if (method !== 'GET' && rawBody) {
    const text = rawBody.toString('utf8');
    if (action.startsWith('workflowManualTasks:submit')) captured.submitPostData = text;
    if (action.startsWith('auth:signIn')) captured.signInBody = text;
  }
  let result = respondFixture(
    { method: method.toLowerCase(), url: `http://${HOST}:${PORT}${url}`, headers },
    fixtureState,
    captured,
  );

  // 8) 角色 / 身份富化。
  result = enrichAuthResult(action, result, { headers });

  const fixture501 =
    result.code === 501 && Array.isArray(result.body?.errors) && result.body.errors[0]?.code === 'FIXTURE_UNSUPPORTED';

  record({
    method,
    action,
    role,
    roleEpoch: chatState.roleEpoch,
    code: fixture501 ? 501 : result.code,
    ...(fixture501 ? { note: '未支持（本机 501，不外呼）' } : {}),
  });
  if (fixture501) {
    chatState.unsupported.push(`${method} ${action}`);
    if (chatState.unsupported.length > MAX_LOG) chatState.unsupported.splice(0, chatState.unsupported.length - MAX_LOG);
    log(`未支持接口只在本机 501：${method} ${action}`);
    return sendJson(res, 501, {
      errors: [
        {
          code: 'SYNTH_UNSUPPORTED',
          message: `本机合成环境不支持 ${action}；不会外呼真实后端。请在控制页查看未支持清单，或补进本机应答。`,
        },
      ],
      data: null,
    });
  }
  return sendJson(res, result.code, result.body);
}

/* ------------------------------------------------------------------ *
 * /files 分发（本机附件）
 * ------------------------------------------------------------------ */

function dispatchFiles(res, pathname) {
  const match = /^\/files\/controlled\/(.+)$/.exec(decodeURIComponent(pathname));
  const name = match?.[1];
  const stored = name ? chatState.uploads.get(name) : null;
  if (stored) {
    res.writeHead(200, {
      'content-type': stored.contentType,
      'content-length': stored.buffer.length,
      'cache-control': 'no-store',
      'x-crewloom-local': '1',
    });
    res.end(stored.buffer);
    return;
  }
  sendJson(res, 404, {
    errors: [
      {
        code: 'SYNTH_NO_FILE',
        message: `本机合成环境没有这个附件：${pathname}（合成环境不取真实附件，也不外呼）。`,
      },
    ],
    data: null,
  });
}

/* ------------------------------------------------------------------ *
 * 控制页与 /control API（可见；不是产品 UI）
 * ------------------------------------------------------------------ */

const SCENARIOS = [
  { key: 'normal', text: '普通消息', note: '正常 SSE 增量回复，结束后可重新发送。' },
  { key: 'error', text: '[[error]]', note: '流内错误帧：中文错误提示（errorName CONTROLLED_FAILURE）。' },
  {
    key: 'drop',
    text: '[[drop]]',
    note: '真 socket 断开（服务端 res.destroy，不是干净的 stream_end）：已收到的内容保留，界面给出中文断线说明；控制页“会话流与缓存”里该会话回到 idle。',
  },
  {
    key: 'slow',
    text: '[[slow]]',
    note: '慢流（40 段 × 250ms）。① 运行中点“停止”：abort 后生成立刻停，历史只有已生成的分段；② 直接离开/刷新页面再打开该会话：走 cacheReplay，从缓存位置续上剩余分段。',
  },
  { key: 'stale', text: '[[stale]]', note: '旧会话迟到帧：必须按 sessionId 丢弃。' },
  {
    key: 'nocache',
    text: '[[nocache]]',
    note: '生成中中断且增量缓存不可回放：重开该会话走 chunks_cache_missing（cacheMissing），界面是真实语义「后台仍在工作 / 点击刷新」；服务端随后在后台生成完并落库，控制页从 streaming 变 idle。等 idle 后点刷新即可读到完整内容（不伪造错误）。对照 [[slow]] 的中断重开走 cacheReplay。',
  },
  {
    key: 'tools',
    text: '[[tools]]',
    note: '3 条前端工具调用：逐条批准/拒绝，第二步“继续执行”。作为后续消息发送时，工具 id 取自本会话已提供过的真实代码工作区上下文（不需要第二条重复带上下文）。',
  },
  { key: 'tool', text: '[[tool]]', note: '单条只读工具（read_code_workspace）。' },
];

function controlState() {
  const td03 = chatState.td03;
  return {
    serverUrl: `http://${HOST}:${PORT}`,
    appUrl: APP_URL,
    /** 令牌世代（manual-fixture）：变更后旧令牌 401 EXPIRED_TOKEN → 需要重新登录。 */
    tokenEpoch: fixtureState.epoch,
    /** 角色世代：角色切换 +1，用于可见的角色世代隔离。 */
    roleEpoch: chatState.roleEpoch,
    activeRole: chatState.activeRole,
    roles: CHAT_ROLES,
    roleEpochGuard: chatState.roleEpochGuard,
    inject: chatState.inject,
    /** 会话流与缓存状态（drop / 停止 / 续流的可见核对来源）。 */
    streams: controlledStreamState(),
    streamEvents: controlledStreamEvents(30),
    accounts: FIXTURE_ACCOUNTS.map((item) => ({
      email: item.email,
      password: item.password,
      nickname: item.nickname,
      note: item.note,
    })),
    scenarios: SCENARIOS,
    synthetic: chatSelfSummary(chatState),
    requests: chatState.requests.slice(-60).reverse(),
    denied: chatState.denied.slice(-30).reverse(),
    unsupported: chatState.unsupported.slice(-40).reverse(),
    uploads: [...chatState.uploads.entries()].map(([filename, meta]) => ({
      filename,
      bytes: meta.buffer.length,
      sha256: meta.sha256,
      at: meta.at,
    })),
    td03: {
      taskId: td03.taskId,
      sessionId: td03.sessionId,
      status: td03.status,
      acceptedUserId: td03.acceptedUserId,
      /** 播种时带入的真实 `code-editor` block uid（为空表示用中间件默认的 controlled uid）。 */
      codeBlockUid: td03.codeBlockUid ?? null,
      acceptCount: td03.acceptCount,
      rejectCount: td03.rejectCount,
      decisionCount: td03.decisionCount,
      resumeCount: td03.resumeCount,
      lastDecision: td03.lastDecision ?? null,
      lastResumeToolCallResults: td03.lastResumeToolCallResults,
      history: td03.history.slice(-20),
      taskUrl: td03.sessionId ? `${APP_URL}/tasks/ai?sessionId=${td03.sessionId}` : null,
      listUrl: `${APP_URL}/tasks/pending`,
    },
    fixtureTasks: [
      { key: 'pending', label: '人工待办（可填写/提交）', id: FIXTURE_TASK_IDS.pending },
      { key: 'processed', label: '人工待办（已处理，只读回显）', id: FIXTURE_TASK_IDS.processed },
      { key: 'conflict', label: '人工待办（提交 409）', id: FIXTURE_TASK_IDS.conflict },
    ],
  };
}

function serveControl(res) {
  try {
    const html = readFileSync(join(here, 'main-browser-chat-control.html'), 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  } catch (error) {
    sendJson(res, 500, { errors: [{ code: 'CONTROL_PAGE_MISSING', message: String(error?.message ?? error) }] });
  }
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function handleControl(req, res, { pathname, method }) {
  if (pathname === '/control' || pathname === '/') {
    serveControl(res);
    return true;
  }
  if (pathname === '/control/state') {
    sendJson(res, 200, controlState());
    return true;
  }
  if (pathname === '/control/fixture-attachment.txt') {
    const buffer = Buffer.from(SYNTH_ATTACHMENT.content, 'utf8');
    res.writeHead(200, {
      'content-type': SYNTH_ATTACHMENT.contentType,
      'content-length': buffer.length,
      'cache-control': 'no-store',
      'x-crewloom-local': '1',
    });
    res.end(buffer);
    return true;
  }
  if (!pathname.startsWith('/control/')) return false;

  const body = method === 'POST' ? await readJsonBody(req) : {};

  if (pathname === '/control/reset') {
    resetFixtureState(fixtureState);
    // 保留令牌世代与角色世代（不把验收方踢下线），只清合成写入/日志/未支持清单。
    chatState.requests = [];
    chatState.denied = [];
    chatState.unsupported = [];
    chatState.uploads = new Map();
    chatState.inject = { action: null, mode: null, remaining: 0, note: null };
    log('合成数据已重置（令牌世代与角色世代不变）');
    sendJson(res, 200, controlState());
    return true;
  }
  if (pathname === '/control/reset-all') {
    resetFixtureState(fixtureState);
    resetChatState(chatState);
    bumpFixtureEpoch(fixtureState);
    log(`合成数据与令牌世代均已重置（epoch → ${fixtureState.epoch}，需要重新登录）`);
    sendJson(res, 200, controlState());
    return true;
  }
  if (pathname === '/control/token-epoch') {
    bumpFixtureEpoch(fixtureState);
    log(`令牌世代 → ${fixtureState.epoch}（旧令牌立即 401 EXPIRED_TOKEN，需要重新登录）`);
    sendJson(res, 200, controlState());
    return true;
  }
  if (pathname === '/control/role-epoch') {
    chatState.roleEpoch += 1;
    log(`角色世代 → ${chatState.roleEpoch}`);
    sendJson(res, 200, controlState());
    return true;
  }
  if (pathname === '/control/inject') {
    const mode = body.mode === 'role' || body.mode === 'session' ? body.mode : null;
    chatState.inject = {
      action: typeof body.action === 'string' && body.action ? body.action : null,
      mode,
      remaining: Number.isFinite(Number(body.remaining)) ? Number(body.remaining) : -1,
      note: typeof body.note === 'string' ? body.note : null,
    };
    log(`失败注入：${mode ?? '关闭'} @ ${chatState.inject.action ?? '任意动作'}（remaining=${chatState.inject.remaining}）`);
    sendJson(res, 200, controlState());
    return true;
  }
  if (pathname === '/control/role-epoch-guard') {
    chatState.roleEpochGuard = body.enabled !== false;
    log(`角色世代写保护：${chatState.roleEpochGuard ? '开启' : '关闭'}`);
    sendJson(res, 200, controlState());
    return true;
  }
  if (pathname === '/control/td03/reset') {
    const status = [TD03_STATUS.pendingAcceptance, TD03_STATUS.pendingApproval, TD03_STATUS.rejected].includes(body.status)
      ? body.status
      : TD03_STATUS.pendingAcceptance;
    const codeBlockUid = typeof body.codeBlockUid === 'string' && body.codeBlockUid.trim() ? body.codeBlockUid.trim() : null;
    if (!chatState.td03.sessionId) {
      await seedTd03({ status, codeBlockUid });
    } else {
      chatState.td03.status = status;
      chatState.td03.acceptedUserId = status === TD03_STATUS.pendingAcceptance ? null : 3;
      chatState.td03.history.push({ at: new Date().toISOString(), kind: 'reset-status', status });
    }
    log(`TD-03 任务状态 → ${chatState.td03.status}（会话 ${chatState.td03.sessionId}）`);
    sendJson(res, 200, controlState());
    return true;
  }
  if (pathname === '/control/td03/seed') {
    const status = [TD03_STATUS.pendingAcceptance, TD03_STATUS.pendingApproval, TD03_STATUS.rejected].includes(body.status)
      ? body.status
      : TD03_STATUS.pendingAcceptance;
    const codeBlockUid = typeof body.codeBlockUid === 'string' && body.codeBlockUid.trim() ? body.codeBlockUid.trim() : null;
    const seeded = await seedTd03({ status, codeBlockUid });
    log(
      `TD-03 已用受控中间件真实播种：会话 ${seeded.sessionId}，状态 ${seeded.status}，codeBlockUid=${seeded.codeBlockUid ?? '（默认 controlled）'}`,
    );
    sendJson(res, 200, controlState());
    return true;
  }

  sendJson(res, 404, {
    errors: [{ code: 'CONTROL_NOT_FOUND', message: `控制页没有这个端点：${pathname}` }],
    data: null,
  });
  return true;
}

/* ------------------------------------------------------------------ *
 * HTTP 入口
 * ------------------------------------------------------------------ */

const server = createServer(async (req, res) => {
  const method = String(req.method ?? 'GET').toUpperCase();
  const url = req.url ?? '/';
  const parsed = new URL(url, `http://${HOST}:${PORT}`);
  const pathname = parsed.pathname;

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type,authorization,x-role,x-authenticator,x-data-source',
      'x-crewloom-local': '1',
    });
    res.end();
    return;
  }

  try {
    if (pathname === '/healthz') {
      sendJson(res, 200, {
        ok: true,
        local: true,
        outbound: false,
        tokenEpoch: fixtureState.epoch,
        roleEpoch: chatState.roleEpoch,
        requests: chatState.requests.length,
        unsupported: chatState.unsupported.length,
        denied: chatState.denied.length,
      });
      return;
    }

    if (pathname === '/control' || pathname === '/' || pathname.startsWith('/control/')) {
      if (await handleControl(req, res, { pathname, method })) return;
    }

    // 受控中间件的控制/证据出口（/__crewloom/*）——同一个真实中间件实例。
    if (pathname.startsWith('/__crewloom/')) {
      const rawBody = method === 'GET' ? null : await readRaw(req);
      const handled = await runControlledAi({ method, url, headers: req.headers, rawBody, res });
      if (handled.sent) return;
      sendJson(res, 404, { errors: [{ code: 'NOT_FOUND', message: `本机合成环境没有 ${pathname}` }], data: null });
      return;
    }

    if (pathname.startsWith('/files/')) {
      dispatchFiles(res, pathname);
      return;
    }

    if (pathname.startsWith('/api/')) {
      const rawBody = method === 'GET' || method === 'HEAD' ? null : await readRaw(req);
      let values = null;
      if (rawBody && rawBody.length) {
        try {
          const parsedBody = JSON.parse(rawBody.toString('utf8'));
          values = parsedBody && typeof parsedBody === 'object' ? (parsedBody.values ?? parsedBody) : parsedBody;
        } catch {
          values = null;
        }
      }
      await dispatchApi(req, res, { pathname, url, method, headers: req.headers, rawBody, values });
      return;
    }

    // 未知路径：本机说明，不外呼。
    record({ method, action: pathname, code: 404, note: '未知路径（本机 404）' });
    sendJson(res, 404, {
      errors: [
        {
          code: 'SYNTH_NOT_FOUND',
          message: `本机合成环境只应答 /api/**、/files/** 与 /control：${pathname}（不会外呼真实后端）。`,
        },
      ],
      data: null,
    });
  } catch (error) {
    log(`处理 ${method} ${url} 失败：${error?.stack ?? error}`);
    if (!res.headersSent) {
      sendJson(res, 500, {
        errors: [{ code: 'SYNTH_INTERNAL', message: `本机合成环境内部错误：${String(error?.message ?? error)}` }],
        data: null,
      });
    } else {
      res.end();
    }
  }
});

async function readRaw(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/* ------------------------------------------------------------------ *
 * 附件字节留存（上传只写本机内存）
 * ------------------------------------------------------------------ */

/**
 * 记录 `aiFiles:create` 上传的真实字节，供 `/files/controlled/<name>` 回放。
 *
 * 中间件仍然自己应答上传（元数据/卡片的来源不变）；这里只把同一份内存字节留一份，
 * 让附件链接在本机可下载。没有文件时返回 null，不影响中间件应答。
 */
export function rememberUpload(rawBody, contentType) {
  if (!rawBody || !rawBody.length) return null;
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType ?? ''));
  const boundary = (match?.[1] ?? match?.[2] ?? '').trim();
  if (!boundary) return null;
  const delimiter = Buffer.from(`--${boundary}`);
  let index = rawBody.indexOf(delimiter);
  while (index !== -1) {
    const next = rawBody.indexOf(delimiter, index + delimiter.length);
    if (next === -1) break;
    const chunk = rawBody.slice(index + delimiter.length, next);
    const headerEnd = chunk.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd !== -1) {
      const headerText = chunk.slice(0, headerEnd).toString('utf8');
      const filename = /filename="([^"]*)"/i.exec(headerText)?.[1] ?? '';
      const name = /name="([^"]*)"/i.exec(headerText)?.[1] ?? '';
      const partType = /content-type:\s*([^\r\n]+)/i.exec(headerText)?.[1]?.trim() ?? 'application/octet-stream';
      if (name === 'file' && filename) {
        let bytes = chunk.slice(headerEnd + 4);
        if (bytes.slice(-2).toString('binary') === '\r\n') bytes = bytes.slice(0, -2);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        chatState.uploads.set(filename, {
          buffer: bytes,
          sha256,
          contentType: partType,
          at: new Date().toISOString(),
        });
        return { filename, sha256, bytes: bytes.length };
      }
    }
    index = next;
  }
  return null;
}

server.listen(PORT, HOST, () => {
  log(`本机合成后端已启动：http://${HOST}:${PORT}`);
  log(`可见控制页：http://${HOST}:${PORT}/control`);
  log(`产品预览（由 Vite 提供）：${APP_URL}`);
  log('未支持接口只在本机 501；外呼/真实写动作在本机 403；本进程不做任何外联。');
  log(`合成账号：${FIXTURE_ACCOUNTS.map((item) => `${item.email} / ${item.password}`).join('，')}`);
  if (process.argv.includes('--check')) void runSelfCheck();
});

export { server, controlState, dispatchApi, fixtureState, chatState };

/* ------------------------------------------------------------------ *
 * `--check`：本进程自检（只打本机 5404，不碰任何真实后端）
 * ------------------------------------------------------------------ */

/**
 * 覆盖：健康检查 → 合成登录 → 身份含两种合成角色 → 角色切换与角色世代 →
 * 非法角色 401（角色失效，不踢登录）→ 合成员工/工具/模型配置/数据源/集合/记录 →
 * 外呼动作本机 403 → 未知动作本机 501 → /files 本机 404 →
 * 受控会话 SSE（[[tools]]）→ 历史非空且带 execution=frontend →
 * 逐条决定 + 继续执行 → TD-03 播种/领取/终止 → 失败注入 → 控制页可用 → 令牌世代 401。
 */
async function runSelfCheck() {
  const base = `http://${HOST}:${PORT}`;
  const results = [];
  const check = (name, okFlag, note = '') => {
    results.push({ name, ok: okFlag, note });
    log(`SELFCHECK ${okFlag ? 'PASS' : 'FAIL'} ${name}${note ? ` — ${note}` : ''}`);
  };
  const call = async (path, options = {}) => {
    const response = await fetch(`${base}${path}`, options);
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return {
      status: response.status,
      body,
      text,
      local: response.headers.get('x-crewloom-local') === '1',
    };
  };
  const jsonPost = (payload, headers = {}) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });

  try {
    const health = await call('/healthz');
    check('本机服务 /healthz 可用且声明 local/outbound=false', health.status === 200 && health.body?.local === true && health.body?.outbound === false);

    const account = FIXTURE_ACCOUNTS[0];
    const signIn = await call('/api/auth:signIn', jsonPost({ email: account.email, password: account.password }));
    const token = signIn.body?.data?.token;
    check('合成账号可在本机登录（200 + 令牌）', signIn.status === 200 && typeof token === 'string', `${account.email} → ${signIn.status}`);

    const badSignIn = await call('/api/auth:signIn', jsonPost({ email: account.email, password: 'wrong' }));
    check('错误口令被本机 401 拒绝（不外呼）', badSignIn.status === 401, String(badSignIn.body?.errors?.[0]?.code ?? ''));

    const auth = { authorization: `Bearer ${token}` };
    const who = await call('/api/auth:check', { headers: auth });
    const roles = who.body?.data?.roles ?? [];
    check(
      'auth:check 返回合成身份且含两种测试角色',
      who.status === 200 && roles.length === 2 && roles.some((role) => role.name === CHAT_ROLE_ALPHA) && roles.some((role) => role.name === CHAT_ROLE_BETA),
      `roles=${roles.map((role) => role.name).join(',')}`,
    );

    const accessAlpha = await call('/api/roles:check', { headers: { ...auth, 'x-role': CHAT_ROLE_ALPHA } });
    const accessBeta = await call('/api/roles:check', { headers: { ...auth, 'x-role': CHAT_ROLE_BETA } });
    check(
      'roles:check 按 X-Role 回显生效角色并推进角色世代',
      accessAlpha.status === 200 &&
        accessAlpha.body?.data?.role === CHAT_ROLE_ALPHA &&
        accessBeta.body?.data?.role === CHAT_ROLE_BETA &&
        Number(accessBeta.body?.data?.roleEpoch) > Number(accessAlpha.body?.data?.roleEpoch),
      `${CHAT_ROLE_ALPHA}(#${accessAlpha.body?.data?.roleEpoch}) → ${CHAT_ROLE_BETA}(#${accessBeta.body?.data?.roleEpoch})`,
    );

    const bogusRole = await call('/api/roles:check', { headers: { ...auth, 'x-role': 'synth-nonexistent-role' } });
    check(
      '非法角色返回 401 ROLE_NOT_FOUND_FOR_USER（角色失效，不需要重新登录）',
      bogusRole.status === 401 && bogusRole.body?.errors?.[0]?.code === 'ROLE_NOT_FOUND_FOR_USER',
      String(bogusRole.body?.errors?.[0]?.code ?? ''),
    );

    const rolesList = await call('/api/roles:list?pageSize=50', { headers: auth });
    check('roles:list 含两种合成角色', rolesList.status === 200 && (rolesList.body?.data ?? []).length === 2);

    const employees = await call('/api/aiEmployees:listByUser', { headers: auth });
    check(
      '本机合成员工可用（含合成分析员/文案员）',
      employees.status === 200 && (employees.body?.data ?? []).length === 2,
      (employees.body?.data ?? []).map((item) => item.username).join(','),
    );

    const models = await call('/api/ai:listAllEnabledModels', jsonPost({}, auth));
    check(
      'ai:listAllEnabledModels 只回本机配置（合成提供方，1 个服务）',
      models.status === 200 && (models.body?.data ?? []).length === 1 && models.body.data[0].provider === 'synth-provider',
      String(models.body?.data?.[0]?.llmService ?? ''),
    );

    const services = await call('/api/llmServices:list', { headers: auth });
    check('llmServices:list 只回配置（1 条合成服务）', services.status === 200 && (services.body?.data ?? []).length === 1);

    const sources = await call('/api/dataSources:list', { headers: auth });
    check('dataSources:list 含 main 与合成数据源', sources.status === 200 && (sources.body?.data ?? []).length === 2);

    const collections = await call('/api/collections:list', { headers: auth });
    const tickets = await call('/api/synth_tickets:list?pageSize=10', { headers: auth });
    check(
      'collections:list + 动态集合读取可用（合成工单 2 行）',
      collections.status === 200 && (collections.body?.data ?? []).length >= 4 && (tickets.body?.data ?? []).length === 2,
      `${(collections.body?.data ?? []).length} 集合 / ${(tickets.body?.data ?? []).length} 行`,
    );

    const listModels = await call('/api/ai:listModels', jsonPost({ model: 'LLM' }, auth));
    check(
      '禁止的模型发现动作在本机被显式拒绝（403，不外呼）',
      listModels.status === 403 && listModels.body?.errors?.[0]?.code === 'SYNTH_LOCAL_DENIED',
      String(listModels.body?.errors?.[0]?.code ?? ''),
    );

    const uploadDenied = await call('/api/attachments:upload', jsonPost({}, auth));
    check('真实目标上传动作在本机被显式拒绝（403）', uploadDenied.status === 403);

    const unknown = await call('/api/synth_notImplemented:list', { headers: auth });
    check(
      '未知动作本机 501 并说明不外呼',
      unknown.status === 501 && unknown.body?.errors?.[0]?.code === 'SYNTH_UNSUPPORTED',
      String(unknown.body?.errors?.[0]?.code ?? ''),
    );

    const files = await call('/files/main/main/attachments/1.png', { headers: auth });
    check('/files 未知路径本机 404（不外呼）', files.status === 404);

    // ---- 受控会话：[[tools]] 场景（真实要经过受控中间件）----
    const created = await call('/api/aiConversations:create', jsonPost({ aiEmployee: { username: 'synth-analyst', nickname: '合成分析员' } }, auth));
    const sessionId = created.body?.data?.sessionId;
    check('受控会话可在本机创建', created.status === 200 && typeof sessionId === 'string', String(sessionId));

    const stream = await call(
      `/api/aiConversations:sendMessages`,
      jsonPost({ sessionId, aiEmployee: 'synth-analyst', messages: [{ role: 'user', content: '[[tools]]' }] }, auth),
    );
    const hasToolChunks = stream.text.includes('tool_call_chunks') && stream.text.includes('tool_call_status');
    check('受控 SSE 返回流开始 / 工具调用帧 / 流结束', stream.status === 200 && stream.text.includes('stream_start') && hasToolChunks && stream.text.includes('stream_end'));

    const history = await call(`/api/aiConversations:getMessages?sessionId=${encodeURIComponent(sessionId)}&updateRead=false&paginate=false`, { headers: auth });
    const rows = Array.isArray(history.body?.data) ? history.body.data : [];
    const calls = rows.flatMap((row) => (Array.isArray(row?.content?.tool_calls) ? row.content.tool_calls : []));
    check(
      '历史非空且工具调用带 execution=frontend（TD-03 才会真实执行前端工具）',
      rows.length > 0 && calls.length === 3 && calls.every((call) => call.execution === 'frontend'),
      `rows=${rows.length} calls=${calls.length} execution=${calls[0]?.execution ?? '-'}`,
    );

    const firstCall = calls[0];
    const decision = await call(
      '/api/aiConversations:updateUserDecision',
      jsonPost(
        { sessionId, messageId: firstCall?.messageId, toolCallId: firstCall?.id, userDecision: { type: 'approve' } },
        auth,
      ),
    );
    check('逐条决定被本机记录（updated=1 + userDecision）', decision.status === 200 && decision.body?.data?.updated === 1);

    const resume = await call(
      '/api/aiConversations:resumeToolCall',
      jsonPost({ sessionId, messageId: firstCall?.messageId, toolCallIds: calls.map((call) => call.id), toolCallResults: [{ id: firstCall?.id, result: { applied: true } }], webSearch: false }, auth),
    );
    check('第二步 continue（resumeToolCall）在本机真实应答 SSE', resume.status === 200 && resume.text.includes('stream_end'));

    // ---- TD-03：播种 → 详情 → 领取（不是批准）→ 终止 ----
    const seeded = await seedTd03({ status: TD03_STATUS.pendingAcceptance });
    const detail = await call(`/api/aiWorkflowTasks:getBySession?sessionId=${encodeURIComponent(seeded.sessionId)}`, { headers: auth });
    check(
      'TD-03 任务详情非空（真实播种会话 + 状态/readonly）',
      detail.status === 200 && detail.body?.data?.sessionId === seeded.sessionId && detail.body?.data?.status === TD03_STATUS.pendingAcceptance,
      `status=${detail.body?.data?.status}`,
    );

    const accepted = await call('/api/aiWorkflowTasks:accept', jsonPost({ sessionId: seeded.sessionId }, auth));
    const afterAccept = await call(`/api/aiWorkflowTasks:getBySession?sessionId=${encodeURIComponent(seeded.sessionId)}`, { headers: auth });
    check(
      '领取只把状态推进到待决策（claim 不是批准）',
      accepted.body?.data?.accepted === true &&
        afterAccept.body?.data?.status === TD03_STATUS.pendingApproval &&
        afterAccept.body?.data?.acceptedUserId === 3,
      `status=${afterAccept.body?.data?.status}`,
    );

    const rejected = await call('/api/aiWorkflowTasks:reject', jsonPost({ id: accepted.body?.data?.taskId ?? seeded.sessionId, result: '自检终止' }, auth));
    check('已领取任务可被本机终止（reject）', rejected.status === 200 && rejected.body?.data?.rejected === true);

    // ---- 失败注入：角色失效 vs 会话失效 ----
    await call('/control/inject', jsonPost({ action: 'aiConversations:updateUserDecision', mode: 'role', remaining: 1 }));
    const injectedRole = await call('/api/aiConversations:updateUserDecision', jsonPost({ sessionId, messageId: 'm1', toolCallId: 'x', userDecision: { type: 'approve' } }, auth));
    check(
      '注入角色失效：401 ROLE_NOT_FOUND_FOR_USER（客户端保留登录、只清角色）',
      injectedRole.status === 401 && injectedRole.body?.errors?.[0]?.code === 'ROLE_NOT_FOUND_FOR_USER',
      String(injectedRole.body?.errors?.[0]?.code ?? ''),
    );

    await call('/control/inject', jsonPost({ action: '*', mode: 'session', remaining: 1 }));
    const injectedSession = await call('/api/aiConversations:list', { headers: auth });
    check(
      '注入会话失效：401 EXPIRED_TOKEN（客户端清会话并回到登录页）',
      injectedSession.status === 401 && injectedSession.body?.errors?.[0]?.code === 'EXPIRED_TOKEN',
      String(injectedSession.body?.errors?.[0]?.code ?? ''),
    );
    await call('/control/inject', jsonPost({ mode: null }));

    // ---- 控制页 + 令牌世代 ----
    const control = await fetch(`${base}/control`);
    const html = await control.text();
    const state = await call('/control/state');
    check(
      '可见控制页可用（场景标识 / 合成账号 / 角色世代 / 未知路由清单）',
      control.status === 200 &&
        html.includes('/control/state') &&
        (state.body?.scenarios ?? []).some((item) => item.text === '[[tools]]') &&
        (state.body?.accounts ?? []).length === 2 &&
        Array.isArray(state.body?.unsupported),
    );

    const beforeEpoch = fixtureState.epoch;
    await call('/control/token-epoch', { method: 'POST' });
    const stale = await call('/api/auth:check', { headers: auth });
    check(
      '令牌世代变更后旧令牌 401 EXPIRED_TOKEN（需要重新登录）',
      fixtureState.epoch === beforeEpoch + 1 && stale.status === 401 && stale.body?.errors?.[0]?.code === 'EXPIRED_TOKEN',
      `epoch ${beforeEpoch} → ${fixtureState.epoch}`,
    );

    check('所有 /api 应答都带 x-crewloom-local 标记（未回退真实后端）', state.status === 200 && health.local === true && unknown.local === true);
  } catch (error) {
    check('自检未抛异常', false, String(error?.stack ?? error));
  }

  const failed = results.filter((item) => !item.ok);
  log(`SELFCHECK 结果：${results.length - failed.length}/${results.length} 通过`);
  server.close(() => process.exit(failed.length === 0 ? 0 : 1));
  setTimeout(() => process.exit(failed.length === 0 ? 0 : 1), 2000).unref();
}
