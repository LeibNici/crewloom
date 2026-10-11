/**
 * 受控 AI 后端中间件（只在本机开发/预览服务器上、且显式开启时生效）。
 *
 * 作用：把**会真实调用模型 / 真实写业务数据**的那几个原生动作拦在本机，用可控的 HTTP + SSE
 * 应答替代；其它请求照常走真实代理（正常登录 + 精准只读）。
 *
 * 为什么这样做（而不是在浏览器里用 CDP 整段 fulfill）：
 *  - 需求要求 `ReadableStream` **增量**；CDP `Fetch.fulfillRequest` 只能一次性给整段 body，
 *    没有分块能力。跑在服务器中间件上用 `res.write` 才能真实地边发边收。
 *
 * 本地应答的动作（全部带 `x-crewloom-controlled: 1`）：
 *  - `aiConversations:create` / `sendMessages` / `resendMessages` / `abort` / `resumeStream` /
 *    `resumeToolCall` / `updateUserDecision` / `get` / `list`（受控会话）
 *  - `aiFiles:create`（multipart，字段 `file`）
 *  - `aiContextDatasources:create / get / list / update / destroy`（AI-04 工作区在受控运行里需要真实 CRUD；
 *    真实 2.2.20 的 update 是"按 values 局部更新"、destroy 按 `filterByTk` 删除）
 *
 * 安全网（本文件自己实现，不依赖 strict 模式）：
 *  - 除 `auth:signIn` / `auth:signOut` 与上面这些本地应答动作外，**任何非 GET 请求一律 403 拦下**
 *    并写入证据日志。这样即使脚本误触写动作，也不会到达真实后端。
 *  - 所有非本地应答的请求都会被记入证据（method / action / 是否 GET），供核对脚本证明
 *    "真实后端只收到只读请求"。
 *
 * 证据：进程内日志 + `GET /__crewloom/controlled-log`。日志只记录结构（字段名、id、条数、
 * 字节数、哈希），不记录凭据、请求头或响应正文。
 */

import { createHash } from 'node:crypto';
import { POLICY, isStrictDeniedAction } from './transport-policy.mjs';

const MARKER = /\[\[(error|slow|drop|tool|tools|stale|nocache)\]\]/;

/**
 * 由**浏览器真实注册表**执行的前端工具名（`plugin-ai` `common/frontend-tools`）。
 *
 * 真实 2.2.20/2.2.22 的 `aiConversations:getMessages` 会为每条 `toolCalls` 回填
 * `execution`（`parseMessageRow` 写 `invokeStatus`/`auto`/`status`/`content`/`execution`/`willInterrupt`）。
 * 少了 `execution` 时，TD-03 任务页会判定"没有前端工具需要执行"，于是不执行、也回传不了结果，
 * 最终以**空结果**继续执行——那正是"auto-resume 空 fallback"式的假成功。
 * 这里按真实契约回填：`executeFrontendTool` / `loadFrontendTool` 由浏览器注册表执行。
 */
const FRONTEND_TOOL_NAMES = new Set(['executeFrontendTool', 'loadFrontendTool']);

function pickScenario(text) {
  const match = MARKER.exec(text ?? '');
  if (!match) return 'normal';
  return match[1] === 'tools' ? 'tools' : match[1];
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function readRawBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function sendJson(res, body, status = 200) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('x-crewloom-controlled', '1');
  res.end(JSON.stringify(body));
}

function openSse(res) {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');
  res.setHeader('x-crewloom-controlled', '1');
  res.flushHeaders?.();
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function frame(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

const CONTROLLED_SESSIONS = new Set();
let sessionSeq = 0;
/** 记录哪些会话的增量缓存不可回放（用于 chunks_cache_missing 场景）。 */
const NO_CACHE_SESSIONS = new Set();
/** 每个受控会话的 `llmActiveState`（驱动原生的"后台仍在工作 → 续流"路径）。 */
const SESSION_STATES = new Map();
/** 每个受控会话绑定的员工（会话列表要按 username 显示）。 */
const SESSION_EMPLOYEES = new Map();
/**
 * 每个受控会话绑定的**员工对象**。
 *
 * 真实 2.2.20 的 `aiConversations:list/get` 返回的是 `aiEmployee` 对象（`types.ts:67`），
 * 客户端 `openConversation` 会读 `conversation.aiEmployee.username` 才能触发 resumeRoute；
 * 只回一个用户名字符串会让"打开仍在生成的会话 → resumeStream"整条路径静默失效。
 */
const SESSION_EMPLOYEE_OBJECTS = new Map();

/**
 * 每个受控会话**已经真实提供过的代码工作区 uid**（来自首条消息的 `workContext`）。
 *
 * 原生契约只在**首条**消息带 `workContext`，后续消息是空的；`[[tools]]` 作为后续消息发送时，
 * 若只按当前消息的（空）workContext 取 uid，就会退回中间件默认的
 * `crewloom:code:controlled:apply_code_change` —— 真实注册表里没有这个名字，
 * 只能得到 `unavailable`，无法证明"已提供上下文被真实消费"。
 * 这里记住**本会话自己已经提供过**的 uid（不是让产品第二条重复带上上下文，也不注册假回调）。
 */
const SESSION_CODE_UIDS = new Map();

/**
 * 每个受控会话的**生成记录**（支持"客户端断开后按缓存续流"）。
 *
 * `emitted` 只包含**真的写到连接上**的分段：主动停止时落库的就是它（历史只有已生成内容），
 * 不是 40 段的完整计划。`cached=false`（`[[nocache]]`）时 `resumeStream` 返回
 * `chunks_cache_missing`，对应真实 2.2.20 的"增量缓存不可回放"。
 */
const GENERATIONS = new Map();

function employeeOf(sessionId) {
  return SESSION_EMPLOYEE_OBJECTS.get(sessionId) ?? { username: SESSION_EMPLOYEES.get(sessionId) ?? lastEmployeeName };
}

function rememberEmployee(sessionId, raw) {
  const name = resolveEmployeeName(raw);
  if (name) {
    lastEmployeeName = name;
    SESSION_EMPLOYEES.set(sessionId, name);
  }
  if (raw && typeof raw === 'object') {
    SESSION_EMPLOYEE_OBJECTS.set(sessionId, raw);
  } else if (name && !SESSION_EMPLOYEE_OBJECTS.get(sessionId)) {
    SESSION_EMPLOYEE_OBJECTS.set(sessionId, { username: name });
  }
}
/** 工具调用状态：`${sessionId}:${messageId}` → { calls: [...] }。 */
const TOOL_STATES = new Map();
/** 每个受控会话的真实消息序列（让受控历史与界面上发生过的事一致）。 */
const SESSION_MESSAGES = new Map();
/** 每个受控会话的消息序号（messageId 稳定递增）。 */
const MESSAGE_SEQ = new Map();
let messageKeySeq = 1000;

function nextMessageId(sessionId) {
  const next = (MESSAGE_SEQ.get(sessionId) ?? 0) + 1;
  MESSAGE_SEQ.set(sessionId, next);
  return `${sessionId}-m${next}`;
}

/** 客户端在 create 里传的是**员工对象**，在 sendMessages 里传的是 username 字符串，两种都要认。 */
function resolveEmployeeName(value) {
  if (typeof value === 'string' && value) return value;
  if (value && typeof value === 'object' && typeof value.username === 'string' && value.username) return value.username;
  return null;
}

/** 最近一次见到的员工名：极端情况下（老客户端的请求形态不同）也能给出可渲染的角色。 */
let lastEmployeeName = 'mock-employee';

function assistantRole(sessionId) {
  return SESSION_EMPLOYEES.get(sessionId) ?? lastEmployeeName;
}

function pushMessage(sessionId, content, role) {
  record({ kind: 'assistant-push', sessionId, role, contentLength: String(content?.content ?? '').length });
  const list = SESSION_MESSAGES.get(sessionId) ?? [];
  list.push({
    key: (messageKeySeq += 1),
    role,
    createdAt: new Date().toISOString(),
    content,
  });
  SESSION_MESSAGES.set(sessionId, list);
  return list[list.length - 1];
}
/** 受控的数据范围记录（AI-04 工作区在本机自建的 fixture）。 */
const CONTROLLED_CONTEXTS = new Map();

/* ------------------------------- 证据日志 ------------------------------- */

const EVIDENCE_LIMIT = 400;
const evidence = [];
const proxiedRequests = [];
/**
 * 证据条目的**单调序号**。
 *
 * 长驻受控服务的日志会被 `EVIDENCE_LIMIT` 截断，按"数组长度"做基线在截断后会把
 * 本轮请求误判成旧条目（甚至一条都取不到）。核对脚本改为按 `seq > baseline` 过滤。
 */
let evidenceSeq = 0;
/**
 * 证据回调（可选）：宿主服务把它接到控制页可见的 TD-03 计数上。
 * 回调异常**不得**影响本机应答，因此单独 try/catch。
 */
let eventSink = null;

function record(entry) {
  evidenceSeq += 1;
  const item = { seq: evidenceSeq, at: new Date().toISOString(), ...entry };
  evidence.push(item);
  if (evidence.length > EVIDENCE_LIMIT) evidence.splice(0, evidence.length - EVIDENCE_LIMIT);
  if (eventSink) {
    try {
      eventSink(item);
    } catch {
      /* 证据回调异常不影响本机应答 */
    }
  }
}

function recordProxied(method, action, pathname) {
  proxiedRequests.push({ at: new Date().toISOString(), method, action, path: pathname });
  if (proxiedRequests.length > EVIDENCE_LIMIT) proxiedRequests.splice(0, proxiedRequests.length - EVIDENCE_LIMIT);
}

/* ------------------------------- multipart ------------------------------- */

/** 解析 multipart/form-data：返回每个 part 的字段名、文件名、类型、字节数与 sha256。 */
function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '');
  const boundary = (match?.[1] ?? match?.[2] ?? '').trim();
  if (!boundary) return null;
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = [];
  let index = buffer.indexOf(delimiter);
  while (index !== -1) {
    const next = buffer.indexOf(delimiter, index + delimiter.length);
    if (next === -1) break;
    const chunk = buffer.slice(index + delimiter.length, next);
    // 去掉前导 \r\n 与结尾 \r\n
    const start = chunk.indexOf(Buffer.from('\r\n\r\n'));
    if (start !== -1) {
      const headerText = chunk.slice(0, start).toString('utf8');
      const bodyStart = start + 4;
      const body = chunk.slice(bodyStart).toString('binary');
      const trimmed = body.endsWith('\r\n') ? body.slice(0, -2) : body;
      const disposition = /content-disposition:([^\r\n]*)/i.exec(headerText)?.[1] ?? '';
      const name = /name="([^"]*)"/i.exec(disposition)?.[1] ?? '';
      const filename = /filename="([^"]*)"/i.exec(disposition)?.[1] ?? '';
      const partType = /content-type:\s*([^\r\n]+)/i.exec(headerText)?.[1]?.trim() ?? '';
      const bytes = Buffer.from(trimmed, 'binary');
      parts.push({
        name,
        filename,
        contentType: partType,
        byteLength: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        preview: bytes.length <= 64 ? bytes.toString('utf8') : undefined,
      });
    }
    index = next;
  }
  return parts.filter((part) => part.name || part.filename);
}

/* ------------------------------- 消息与工具 ------------------------------- */

/**
 * 受控会话的历史（原生 v2 客户端读 `body.data` 是消息数组，真实 2.2.20 实测同形）。
 *
 * 内容 = 本会话里真实发生过的消息（用户消息 + 员工回复 / 工具调用），按服务端语义倒序返回，
 * 客户端会再翻转为正序。这样"流式结束后重新拉历史"不会把界面上刚发生的事情抹掉。
 */
function controlledHistory(sessionId) {
  const list = SESSION_MESSAGES.get(sessionId) ?? [];
  const messages = list.map((message) => ({
    key: message.key,
    role: message.role,
    createdAt: message.createdAt,
    content: { ...message.content },
  }));
  for (const message of messages) {
    const state = TOOL_STATES.get(`${sessionId}:${message.content.messageId}`);
    if (state && state.calls.length) {
      const toolCalls = state.calls.map((call) => ({
        id: call.id,
        name: call.name,
        args: call.args,
        messageId: message.content.messageId,
        // 真实 getMessages 会回填 execution；TD-03 靠它判断"这条要在浏览器注册表里执行"。
        execution: FRONTEND_TOOL_NAMES.has(call.name) ? 'frontend' : 'backend',
        invokeStatus: call.invokeStatus ?? 'interrupted',
        willInterrupt: true,
        auto: false,
        status: 'init',
      }));
      // 原生 ChatBox 从 `msg.content.tool_calls` 渲染工具卡……
      message.content.tool_calls = toolCalls;
      // ……而 Crewloom 的 TD-03 任务页从**消息行顶层** `toolCalls` 读同一条数据
      //（真实 2.2.20 的 getMessages 行就是这个形状：`rows[0].toolCalls`，
      // 见 `scripts/verify-2.2.20-task-ai-contract.mjs:504-507` 的 F3 断言）。
      // 两个消费端共用同一份真实受控状态，不是两份数据。
      message.toolCalls = toolCalls.map((call) => ({ ...call }));
    }
  }
  return [...messages].reverse();
}

function buildToolPlan(sessionId, workContext, scenario) {
  const codeItem = (Array.isArray(workContext) ? workContext : []).find((item) => item?.type === 'code-editor');
  const providedUid = typeof codeItem?.uid === 'string' && codeItem.uid ? codeItem.uid : null;
  if (providedUid) SESSION_CODE_UIDS.set(sessionId, providedUid);
  const rememberedUid = SESSION_CODE_UIDS.get(sessionId) ?? null;
  const uid = providedUid ?? rememberedUid ?? 'crewloom:code:controlled';
  const uidSource = providedUid ? 'current-workContext' : rememberedUid ? 'session-workContext' : 'controlled-default';
  record({ kind: 'tool-plan', sessionId, scenario, uid, uidSource });
  if (scenario === 'tool') {
    return [
      {
        id: 'controlled-tool-1',
        name: 'executeFrontendTool',
        args: { toolId: `${uid}:read_code_workspace`, args: {} },
      },
    ];
  }
  return [
    {
      id: 'controlled-tool-1',
      name: 'executeFrontendTool',
      args: { toolId: `${uid}:apply_code_change`, args: { code: '// controlled apply\nconst answer = 42;\n' } },
    },
    {
      id: 'controlled-tool-2',
      name: 'executeFrontendTool',
      args: { toolId: `${uid}:apply_code_change`, args: { code: '// 这一条会被用户拒绝，不应写入\n' } },
    },
    {
      id: 'controlled-tool-3',
      name: 'executeFrontendTool',
      args: { toolId: `${uid}:apply_code_change`, args: { code: '' } },
    },
  ];
}

/* ------------------------------- 生成生命周期 ------------------------------- */

/**
 * 客户端连接是否已经不在。
 *
 * 宿主 HTTP 外壳的 `forwardingResponse` 会把真实 `res` 的 `destroyed`/`writableEnded`
 * 透传出来（见 `main-browser-chat-server.mjs`），否则中间件只看得到代理对象。
 */
function clientGone(res) {
  return res?.destroyed === true || res?.writableEnded === true;
}

/**
 * 把一个生成记录落库为一条真实助手消息。
 *
 * @param partial true = 只落**已经写到连接上的分段**（主动停止）；false = 落完整内容（正常结束/续流完成）。
 */
function persistGeneration(sessionId, generation, partial) {
  if (generation.persisted) return;
  const text = (partial ? generation.emitted : generation.chunks).join('');
  if (!text) return;
  generation.persisted = true;
  pushMessage(
    sessionId,
    { type: 'text', messageId: nextMessageId(sessionId), content: text, from: 'main-agent' },
    assistantRole(sessionId),
  );
  record({ kind: 'generation-persist', sessionId, partial, chunks: generation.emitted.length, length: text.length });
}

/**
 * 按分段计划写流；每一步都检查取消/断线。
 *
 * @returns {Promise<{ stopped: boolean, reason: 'abort' | 'client-gone' | 'resume' | 'done' }>}
 */
async function runGeneration(res, sessionId, generation, startIndex = 0) {
  for (let index = startIndex; index < generation.chunks.length; index += 1) {
    if (generation.cancelled || clientGone(res)) {
      return { stopped: true, reason: generation.cancelled ? generation.stopReason ?? 'abort' : 'client-gone' };
    }
    frame(res, { type: 'content', from: 'main-agent', sessionId, body: generation.chunks[index] });
    generation.emitted.push(generation.chunks[index]);
    await delay(generation.delayMs);
  }
  if (generation.cancelled || clientGone(res)) {
    return { stopped: true, reason: generation.cancelled ? generation.stopReason ?? 'abort' : 'client-gone' };
  }
  frame(res, { type: 'stream_end', from: 'main-agent', sessionId });
  SESSION_STATES.set(sessionId, 'idle');
  persistGeneration(sessionId, generation, false);
  generation.done = true;
  res.end();
  return { stopped: false, reason: 'done' };
}

/**
 * 跑完一次分段流并处理"被打断"的两种语义：
 *  - 主动停止（abort）：落库**已生成**内容，会话回到 idle；
 *  - 客户端断开（断线/离开/刷新）：停止本轮写流，保留缓存并保持 `streaming`，
 *    等重新打开该会话时由 `resumeStream` 从缓存位置续上（不是把未生成内容写进历史）。
 */
async function runChunkedGeneration(res, sessionId, generation, startIndex = 0) {
  GENERATIONS.set(sessionId, generation);
  const outcome = await runGeneration(res, sessionId, generation, startIndex);
  if (!outcome.stopped) return outcome;
  if (outcome.reason === 'abort') {
    persistGeneration(sessionId, generation, true);
    SESSION_STATES.set(sessionId, 'idle');
  } else {
    SESSION_STATES.set(sessionId, 'streaming');
  }
  record({
    kind: 'generation-stopped',
    sessionId,
    scenario: generation.scenario,
    reason: outcome.reason,
    emitted: generation.emitted.length,
    total: generation.chunks.length,
  });
  return outcome;
}

/**
 * `[[nocache]]` 的**后台生成**：连接已断开、增量缓存不可回放，但真实 2.2.20 的服务端仍在
 * 继续生成，完成后才落库并把 `llmActiveState` 置回 `idle`。
 *
 * 旧夹具把 nocache 直接标成"已停止"且状态永远 `streaming`，于是控制页一直显示
 * streaming/不可回放，产品"后台工作中"横幅点刷新也永远不结束——既不是真错误，
 * 也到不了真实终态。这里补上真实语义：后台把剩余分段生成完 → 落库 → idle。
 *
 * 不写 socket、不伪造错误；`resumeStream` 在后台未完成时返回 `chunks_cache_missing`，
 * 完成后状态为 idle（客户端不再续流，直接读到已落库内容）。
 */
async function runBackgroundGeneration(sessionId, generation) {
  for (let index = generation.emitted.length; index < generation.chunks.length; index += 1) {
    if (generation.cancelled) {
      // 用户显式停止：只落已生成内容（与真实 abort 语义一致）。
      persistGeneration(sessionId, generation, true);
      SESSION_STATES.set(sessionId, 'idle');
      record({
        kind: 'generation-stopped',
        sessionId,
        scenario: generation.scenario,
        reason: generation.stopReason ?? 'abort',
        emitted: generation.emitted.length,
        total: generation.chunks.length,
      });
      return;
    }
    generation.emitted.push(generation.chunks[index]);
    await delay(generation.delayMs);
  }
  if (generation.cancelled) {
    persistGeneration(sessionId, generation, true);
    SESSION_STATES.set(sessionId, 'idle');
    return;
  }
  generation.done = true;
  persistGeneration(sessionId, generation, false);
  SESSION_STATES.set(sessionId, 'idle');
  record({
    kind: 'generation-background-done',
    sessionId,
    scenario: generation.scenario,
    chunks: generation.chunks.length,
    length: generation.chunks.join('').length,
  });
}

function emitToolFrames(res, sessionId, messageId, plan) {
  const from = 'main-agent';
  for (const call of plan) {
    frame(res, {
      type: 'tool_call_chunks',
      from,
      sessionId,
      body: [{ id: call.id, name: call.name, args: JSON.stringify(call.args), messageId, auto: false }],
    });
  }
  for (const call of plan) {
    frame(res, {
      type: 'tool_call_status',
      from,
      sessionId,
      body: {
        toolCall: { ...call, messageId, willInterrupt: true },
        invokeStatus: 'interrupted',
        status: 'init',
      },
    });
  }
}

async function streamConversation(res, { sessionId, scenario, text, workContext }) {
  openSse(res);
  const from = 'main-agent';
  frame(res, { type: 'stream_start', from, sessionId });

  if (scenario === 'stale') {
    // 旧会话的迟到 frame：客户端必须按 sessionId 丢弃（useChatMessageActions 里的隔离分支）。
    frame(res, { type: 'content', from, sessionId: 'controlled-session-other', body: '【旧会话的迟到内容】' });
    await delay(60);
  }

  if (scenario === 'error') {
    frame(res, { type: 'error', from, sessionId, errorName: 'CONTROLLED_FAILURE', body: '受控失败：模型服务不可用' });
    res.end();
    return;
  }

  if (scenario === 'drop') {
    frame(res, { type: 'content', from: 'main-agent', sessionId, body: '受控断线前的内容。' });
    pushMessage(
      sessionId,
      { type: 'text', messageId: nextMessageId(sessionId), content: '受控断线前的内容。', from: 'main-agent' },
      assistantRole(sessionId),
    );
    await delay(120);
    // 真正的 socket 断开（不是干净的 stream_end）。已收到的部分已经落库；
    // 服务端不再生成，因此状态回到 idle，避免"控制页永远 streaming"的假象。
    SESSION_STATES.set(sessionId, 'idle');
    record({ kind: 'socket-drop', sessionId, scenario: 'drop', persisted: 'partial' });
    res.destroy();
    return;
  }

  if (scenario === 'tool' || scenario === 'tools') {
    const messageId = nextMessageId(sessionId);
    const plan = buildToolPlan(sessionId, workContext, scenario);
    TOOL_STATES.set(`${sessionId}:${messageId}`, { sessionId, messageId, calls: plan.map((call) => ({ ...call })) });
    pushMessage(sessionId, { type: 'text', messageId, content: '', from: 'main-agent' }, assistantRole(sessionId));
    emitToolFrames(res, sessionId, messageId, plan);
    await delay(80);
    frame(res, { type: 'stream_end', from, sessionId });
    SESSION_STATES.set(sessionId, 'idle');
    res.end();
    return;
  }

  if (scenario === 'nocache') {
    // 服务端"仍在生成但增量缓存已不可回放"：先给一小段，再**真断开**；连接断开后
    // 服务端继续在后台把剩余内容生成完、落库，然后把 `llmActiveState` 置回 idle。
    // 重开会话时（仍在生成）`resumeStream` 返回 `chunks_cache_missing` + 当前
    // `llmActiveState`；后台完成后再打开/刷新就读到已落库的完整内容。
    const nocacheChunks = ['受控中断前的第一段。', '后台继续生成的内容。', '后台生成已经完成。'];
    frame(res, { type: 'content', from, sessionId, body: nocacheChunks[0] });
    NO_CACHE_SESSIONS.add(sessionId);
    const generation = {
      sessionId,
      scenario: 'nocache',
      chunks: nocacheChunks,
      emitted: [nocacheChunks[0]],
      cached: false,
      cancelled: false,
      stopReason: null,
      persisted: false,
      done: false,
      // 后台生成 2 段 × 4s ≈ 8s：给"重开看到后台工作中、等一会儿点刷新读到终态"留出可观察窗口，
      // 也贴近真实服务端"仍在生成"的时间尺度。
      delayMs: 4000,
    };
    GENERATIONS.set(sessionId, generation);
    await delay(80);
    SESSION_STATES.set(sessionId, 'streaming');
    res.destroy();
    // 后台继续生成（不写 socket）：完成后落库并变 idle，控制页可轮询到真实终态。
    void runBackgroundGeneration(sessionId, generation);
    return;
  }

  const chunks =
    scenario === 'slow'
      ? Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 段受控增量。`)
      : ['受控回复：', text ? `收到「${text.replace(MARKER, '').trim()}」。` : '', '这是本机受控流式内容。'];

  // 落库的助手消息必须用**当前会话绑定的员工名**作为 role：原生 `Messages.tsx:242-245`
  // 只在 `resolvedRoles[message.role]` 命中时才渲染，写死一个不存在的角色会让
  // "流正常结束 → loadMessages 用历史覆盖界面"之后消息整条消失（P2 的 stream-normal-end 假失败）。
  const generation = {
    sessionId,
    scenario,
    chunks: chunks.filter(Boolean),
    emitted: [],
    cached: true,
    cancelled: false,
    persisted: false,
    done: false,
    delayMs: scenario === 'slow' ? 250 : 60,
  };
  await runChunkedGeneration(res, sessionId, generation);
}

/* ------------------------------- 中间件 ------------------------------- */

const LOCAL_WRITE_ALLOWLIST = new Set(['auth:signIn', 'auth:signOut']);
/**
 * 已登记的只读动作（readActions ∪ readPostActions）。原生 SDK 对自定义动作默认用 POST
 * （例如 `aiEmployees:listByUser`、`aiConversations:unreadCounts`），它们仍然是读取，
 * 因此放行到真实后端；被 strict 判为"有外部副作用"的动作（模型发现等）一律不放行。
 */
const REGISTERED_READ_ACTIONS = new Set([...(POLICY.readActions ?? []), ...(POLICY.readPostActions ?? [])]);

function isAllowedReadPost(action) {
  if (LOCAL_WRITE_ALLOWLIST.has(action)) return true;
  if (isStrictDeniedAction(action)) return false;
  return REGISTERED_READ_ACTIONS.has(action);
}

export function createControlledAiMiddleware(options = {}) {
  // 可选的证据回调：宿主服务据此更新控制页可见的 TD-03 计数（决定次数 / 续跑次数 / 最近回传结果）。
  if (typeof options.onEvent === 'function') eventSink = options.onEvent;
  return async function controlledAiMiddleware(req, res, next) {
    const url = req.url ?? '';
    const pathname = url.split('?')[0];

    // 本机控制入口：切换某个受控会话的 `llmActiveState`（只影响本机受控应答）。
    if (pathname === '/__crewloom/controlled-state') {
      const params = new URL(url, 'http://127.0.0.1').searchParams;
      const sessionId = params.get('sessionId') ?? '';
      const state = params.get('llmActiveState') ?? '';
      if (sessionId) SESSION_STATES.set(sessionId, state || 'idle');
      record({ kind: 'state-set', sessionId, llmActiveState: state || 'idle' });
      sendJson(res, { ok: true, sessionId, llmActiveState: SESSION_STATES.get(sessionId) });
      return;
    }

    // 受控会话清单（本机控制面：让核对脚本能精确点开"仍在生成"的那个会话）。
    if (pathname === '/__crewloom/controlled-sessions') {
      sendJson(res, {
        sessions: [...CONTROLLED_SESSIONS].map((sessionId) => ({
          sessionId,
          title: `受控会话 ${sessionId.replace('controlled-session-', '')}`,
          llmActiveState: SESSION_STATES.get(sessionId) ?? 'idle',
        })),
      });
      return;
    }

    // 证据出口（非 /api 前缀，不受传输策略影响）。
    if (pathname === '/__crewloom/controlled-log') {
      sendJson(res, {
        entries: evidence,
        nextSeq: evidenceSeq,
        proxied: proxiedRequests,
        counts: {
          entries: evidence.length,
          proxied: proxiedRequests.length,
          proxiedNonGet: proxiedRequests.filter((item) => item.method !== 'GET').length,
        },
      });
      return;
    }

    if (!pathname.startsWith('/api/')) return next();

    const action = pathname.slice('/api/'.length);
    const method = (req.method ?? 'GET').toUpperCase();
    if (action === 'aiConversations:create' && method === 'POST') {
      const body = await readBody(req);
      sessionSeq += 1;
      const sessionId = `controlled-session-${sessionSeq}`;
      CONTROLLED_SESSIONS.add(sessionId);
      SESSION_STATES.set(sessionId, 'idle');
      lastEmployeeName = resolveEmployeeName(body.aiEmployee) ?? lastEmployeeName;
      SESSION_EMPLOYEES.set(sessionId, lastEmployeeName);
      rememberEmployee(sessionId, body.aiEmployee);
      record({ kind: 'employee-set', from: 'create', sessionId, employeeName: lastEmployeeName });
      record({ kind: 'conversation-create', sessionId, aiEmployee: body.aiEmployee ?? null });
      sendJson(res, {
        data: {
          sessionId,
          aiEmployee: employeeOf(sessionId),
          title: '受控会话',
          updatedAt: new Date().toISOString(),
          read: true,
          llmActiveState: 'idle',
        },
      });
      return;
    }

    if ((action === 'aiConversations:sendMessages' || action === 'aiConversations:resendMessages') && method === 'POST') {
      const body = await readBody(req);
      const sessionId = String(body.sessionId ?? 'controlled-session-1');
      CONTROLLED_SESSIONS.add(sessionId);
      const employeeName = resolveEmployeeName(body.aiEmployee);
      if (employeeName) {
        lastEmployeeName = employeeName;
        SESSION_EMPLOYEES.set(sessionId, employeeName);
      }
      rememberEmployee(sessionId, body.aiEmployee);
      record({
        kind: 'employee-set',
        from: 'send',
        sessionId,
        employeeName: employeeName ?? null,
        raw: typeof body.aiEmployee === 'string' ? body.aiEmployee : typeof body.aiEmployee,
      });
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const lastUser = [...messages].reverse().find((m) => m && m.role === 'user') ?? messages[messages.length - 1];
      const rawContent = lastUser?.content;
      const text =
        typeof rawContent === 'string'
          ? rawContent
          : typeof rawContent?.content === 'string'
            ? rawContent.content
            : typeof rawContent?.text === 'string'
              ? rawContent.text
              : '';
      const scenario = pickScenario(text);
      const workContext = Array.isArray(lastUser?.workContext) ? lastUser.workContext : [];
      const attachments = Array.isArray(lastUser?.attachments) ? lastUser.attachments : [];
      // 记住本会话**真实提供过**的代码工作区 uid（原生契约只在首条带 workContext）。
      // 后续 `[[tools]]` 用同一条真实上下文选工具 id，不要求产品第二条重复携带 context。
      const codeUid = workContext.find((item) => item?.type === 'code-editor' && typeof item?.uid === 'string' && item.uid)
        ?.uid;
      if (typeof codeUid === 'string' && codeUid) {
        SESSION_CODE_UIDS.set(sessionId, codeUid);
        record({ kind: 'work-context-code', sessionId, uid: codeUid });
      }
      record({
        kind: 'send',
        sessionId,
        scenario,
        messagesCount: messages.length,
        textLength: text.length,
        attachmentIds: attachments.map((item) => String(item?.id ?? item?.uid ?? '')),
        attachmentFilenames: attachments.map((item) => String(item?.filename ?? item?.name ?? '')),
        workContext: workContext.map((item) => ({
          type: item?.type ?? null,
          uid: item?.uid ?? null,
          hasContent: item?.content !== undefined && item?.content !== null,
          frontendToolIds: Array.isArray(item?.frontendTools)
            ? item.frontendTools.map((tool) => String(tool?.id ?? ''))
            : [],
        })),
      });
      if (scenario === 'nocache') NO_CACHE_SESSIONS.add(sessionId);
      pushMessage(
        sessionId,
        {
          type: 'text',
          messageId: nextMessageId(sessionId),
          content: text,
          attachments: attachments.length ? attachments : undefined,
          workContext: workContext.length ? workContext : undefined,
          from: 'main-agent',
        },
        'user',
      );
      SESSION_STATES.set(sessionId, 'streaming');
      await streamConversation(res, { sessionId, scenario, text, workContext });
      return;
    }

    if (action === 'aiConversations:abort' && method === 'POST') {
      const body = await readBody(req);
      const values = body && typeof body === 'object' && !Array.isArray(body) ? (body.values ?? body) : {};
      const sessionId = String(values.sessionId ?? '');
      const generation = sessionId ? GENERATIONS.get(sessionId) : null;
      if (generation && !generation.done) {
        // 主动停止：**立刻**停掉后台分段循环，并且只落库已经生成的分段。
        // 不这么做时循环会继续写完全部 40 段，历史里就出现"停止后才生成的内容"。
        generation.cancelled = true;
        generation.stopReason = 'abort';
        persistGeneration(sessionId, generation, true);
      }
      if (sessionId) SESSION_STATES.set(sessionId, 'idle');
      record({
        kind: 'abort',
        sessionId,
        emitted: generation ? generation.emitted.length : 0,
        total: generation ? generation.chunks.length : 0,
      });
      sendJson(res, { data: { aborted: true } });
      return;
    }

    if (action === 'aiConversations:resumeStream' && method === 'POST') {
      const body = await readBody(req);
      const values = body && typeof body === 'object' && !Array.isArray(body) ? (body.values ?? body) : {};
      const sessionId = String(values.sessionId ?? body.sessionId ?? 'controlled-session-1');
      const generation = GENERATIONS.get(sessionId) ?? null;
      const cacheMissing = NO_CACHE_SESSIONS.has(sessionId) || (generation ? generation.cached === false : false);
      record({
        kind: 'resumeStream',
        sessionId,
        cacheMissing,
        emitted: generation ? generation.emitted.length : 0,
        total: generation ? generation.chunks.length : 0,
      });
      if (cacheMissing) {
        // 真实 2.2.20 契约（`server/resource/aiConversations.js` resumeStream）：
        // 只有**仍在生成**（`llmActiveState !== 'idle'`）且缓存为空时才回
        // `chunks_cache_missing`，并且帧体带当前 `llmActiveState`；生成完成后
        // （idle）不再回该帧，直接结束——客户端随后读到的就是已落库内容。
        const llmActiveState = SESSION_STATES.get(sessionId) ?? 'idle';
        openSse(res);
        if (llmActiveState !== 'idle') {
          frame(res, { type: 'chunks_cache_missing', from: 'main-agent', sessionId, body: { llmActiveState } });
        }
        res.end();
        return;
      }
      if (generation && !generation.done && generation.cached && !generation.persisted) {
        // 缓存回放：把仍然活着的旧连接标记停住（避免两份内容），再从**已发出的位置**续上，
        // 结束后落库的是一条完整内容。
        generation.cancelled = true;
        generation.stopReason = 'resume';
        const replay = {
          ...generation,
          cancelled: false,
          stopReason: null,
        };
        await runChunkedGeneration(res, sessionId, replay, generation.emitted.length);
        return;
      }
      // 没有可回放缓存（例如从未生成过就点了继续接收）：保持真实 SSE 语义，给一段正常回复。
      await streamConversation(res, { sessionId, scenario: 'normal', text: '续流' });
      return;
    }

    if (action === 'aiConversations:resumeToolCall' && method === 'POST') {
      const body = await readBody(req);
      const sessionId = String(body.sessionId ?? 'controlled-session-1');
      record({
        kind: 'resumeToolCall',
        sessionId,
        messageId: body.messageId ?? null,
        aiEmployee: body.aiEmployee ?? null,
        toolCallIds: Array.isArray(body.toolCallIds) ? body.toolCallIds : [],
        toolCallResults: Array.isArray(body.toolCallResults)
          ? body.toolCallResults.map((item) => ({ id: item?.id ?? null, result: item?.result ?? null }))
          : [],
      });
      const key = `${sessionId}:${body.messageId}`;
      const state = TOOL_STATES.get(key);
      if (state) {
        for (const call of state.calls) {
          call.invokeStatus = 'done';
        }
      }
      SESSION_STATES.set(sessionId, 'idle');
      pushMessage(
        sessionId,
        { type: 'text', messageId: nextMessageId(sessionId), content: '工具已按你的决定继续执行。', from: 'main-agent' },
        assistantRole(sessionId),
      );
      openSse(res);
      frame(res, { type: 'stream_start', from: 'main-agent', sessionId });
      frame(res, { type: 'content', from: 'main-agent', sessionId, body: '工具已按你的决定继续执行。' });
      frame(res, { type: 'stream_end', from: 'main-agent', sessionId });
      res.end();
      return;
    }

    if (action === 'aiConversations:updateUserDecision' && method === 'POST') {
      const body = await readBody(req);
      // SDK 的资源动作把 `values` 直接作为请求体发送；兼容仍带 values 包装的调用。
      const values = body && typeof body === 'object' && !Array.isArray(body) ? (body.values ?? body) : {};
      const sessionId = String(values.sessionId ?? '');
      const messageId = String(values.messageId ?? '');
      const key = `${sessionId}:${messageId}`;
      const state = TOOL_STATES.get(key) ?? { sessionId, messageId, calls: [] };
      const target = state.calls.find((call) => call.id === values.toolCallId);
      if (target) {
        target.userDecision = values.userDecision;
        // 真实服务端在决定命中后把该工具置为 `waiting`（`getMessages` 回填同一状态），
        // 客户端据此判断"这条已决定、可以进入第二步继续执行"。
        target.invokeStatus = 'waiting';
      }
      TOOL_STATES.set(key, state);
      record({
        kind: 'updateUserDecision',
        sessionId,
        messageId,
        toolCallId: values.toolCallId ?? null,
        userDecision: values.userDecision ?? null,
      });
      sendJson(res, {
        data: {
          updated: target ? 1 : 0,
          accepted: true,
          toolCalls: state.calls.map((call) => ({
            id: call.id,
            name: call.name,
            args: call.args,
            invokeStatus: call.userDecision ? 'waiting' : (call.invokeStatus ?? 'interrupted'),
            ...(call.userDecision ? { userDecision: call.userDecision } : {}),
          })),
        },
      });
      return;
    }

    /**
     * 会话历史。
     *
     * **GET 与 POST 都要认**（实测）：
     *  - 产品请求层（`src/modules/ai/resources.ts`）用 GET，并显式带 `updateRead='false'`；
     *  - 原生 ChatBox（`useChatMessageActions.loadMessages`）在**产品模式**下发的是
     *    `POST /api/aiConversations:getMessages`，`values` 里带 `sessionId`/`updateRead`；
     *    `updateRead=false` 的只读改写只发生在 strict / `CREWLOOM_CONTROLLED_AI=1` 的
     *    `agentReadGuard` 路径上，产品预览不会改写。
     * 曾经只认 GET：产品模式下打开历史会话会落到"未支持 → 501"，消息区变空。
     */
    if (action === 'aiConversations:getMessages' && (method === 'GET' || method === 'POST')) {
      const params = new URL(url, 'http://127.0.0.1').searchParams;
      let sessionId = params.get('sessionId') ?? '';
      let updateRead = params.get('updateRead');
      if (method === 'POST') {
        const body = await readBody(req);
        const values = body && typeof body === 'object' && !Array.isArray(body) ? (body.values ?? body) : {};
        if (!sessionId && typeof values.sessionId === 'string') sessionId = values.sessionId;
        if (updateRead === null || updateRead === undefined) updateRead = values.updateRead;
      }
      if (!CONTROLLED_SESSIONS.has(sessionId)) return next();
      record({
        kind: 'getMessages',
        sessionId,
        method,
        // 记录收到的原值（字符串/布尔都按原样留证据）：真实契约只在 `true` 时标已读。
        updateRead: updateRead === undefined ? null : updateRead,
        updateReadType: typeof updateRead,
      });
      // 真实 2.2.20 的响应体是 `{ data: 消息数组 }`（实测见报告 19）；这里保持一致。
      sendJson(res, { data: controlledHistory(sessionId), meta: {} });
      return;
    }

    if (action === 'aiConversations:list' && method === 'GET') {
      const sessions = [...CONTROLLED_SESSIONS].map((sessionId) => ({
        sessionId,
        aiEmployee: employeeOf(sessionId),
        title: `受控会话 ${sessionId.replace('controlled-session-', '')}`,
        updatedAt: new Date().toISOString(),
        read: true,
        llmActiveState: SESSION_STATES.get(sessionId) ?? 'idle',
      }));
      record({ kind: 'conversation-list', count: sessions.length });
      sendJson(res, {
        data: sessions,
        meta: { count: sessions.length, page: 1, pageSize: 50, totalPage: 1 },
      });
      return;
    }

    if (action === 'aiConversations:get' && method === 'GET') {
      const sessionId = /"sessionId"\s*:\s*"([^"]+)"/.exec(decodeURIComponent(url))?.[1] ?? '';
      if (!CONTROLLED_SESSIONS.has(sessionId)) return next();
      record({ kind: 'conversation-get', sessionId, llmActiveState: SESSION_STATES.get(sessionId) ?? 'idle' });
      sendJson(res, {
        data: {
          sessionId,
          aiEmployee: employeeOf(sessionId),
          title: '受控会话',
          llmActiveState: SESSION_STATES.get(sessionId) ?? 'idle',
        },
      });
      return;
    }

    if (action === 'aiFiles:create' && method === 'POST') {
      const raw = await readRawBody(req);
      const parts = parseMultipart(raw, String(req.headers['content-type'] ?? ''));
      const filePart = parts?.find((part) => part.name === 'file' && part.filename) ?? null;
      record({
        kind: 'upload',
        contentType: String(req.headers['content-type'] ?? '').slice(0, 60),
        totalBytes: raw.length,
        parts: (parts ?? []).map((part) => ({
          name: part.name,
          filename: part.filename,
          contentType: part.contentType,
          byteLength: part.byteLength,
          sha256: part.sha256,
        })),
        fileField: filePart?.name ?? null,
        fileFieldIsFile: filePart?.name === 'file',
        filename: filePart?.filename ?? null,
      });
      if (!filePart) {
        sendJson(res, { errors: [{ message: 'controlled upload requires a file part named "file"' }] }, 400);
        return;
      }
      const filename = filePart.filename;
      sendJson(res, {
        data: {
          id: `controlled-file-${filePart.sha256.slice(0, 8)}`,
          filename,
          title: filename,
          mimetype: filePart.contentType || 'application/octet-stream',
          size: filePart.byteLength,
          url: `/files/controlled/${encodeURIComponent(filename)}`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });
      return;
    }

    if (action === 'aiContextDatasources:create' && method === 'POST') {
      const body = await readBody(req);
      // SDK 对 POST 动作会把 `values` 直接放进请求体；兼容仍带 values 包装的调用。
      const values = body && typeof body === 'object' && !Array.isArray(body) ? (body.values ?? body) : {};
      const id = `controlled-context-${CONTROLLED_CONTEXTS.size + 1}`;
      const record_ = {
        id,
        title: String(values.title ?? '受控数据范围'),
        datasource: String(values.datasource ?? 'main'),
        collectionName: String(values.collectionName ?? 'users'),
        fields: values.fields ?? null,
        filter: values.filter ?? null,
        sort: values.sort ?? null,
        limit: values.limit ?? null,
      };
      CONTROLLED_CONTEXTS.set(id, record_);
      record({ kind: 'context-create', id, collectionName: record_.collectionName });
      sendJson(res, { data: record_ });
      return;
    }

    if (action === 'aiContextDatasources:update' && method === 'POST') {
      const body = await readBody(req);
      // SDK 把 `values` 放进请求体、把 `filterByTk` 放进查询串（见 src/api/client.ts resourceAction）。
      const values = body && typeof body === 'object' && !Array.isArray(body) ? (body.values ?? body) : {};
      const id = decodeURIComponent(new URL(url, 'http://127.0.0.1').searchParams.get('filterByTk') ?? '');
      const current = CONTROLLED_CONTEXTS.get(id);
      if (!current) return next();
      // 真实 update 是"按 values 局部更新"：这里同样合并所有提交字段（保留稳定 id）。
      const updated = { ...current, ...values, id: current.id };
      CONTROLLED_CONTEXTS.set(id, updated);
      record({
        kind: 'context-update',
        id,
        title: updated.title,
        collectionName: updated.collectionName,
        fieldsCount: Array.isArray(updated.fields) ? updated.fields.length : null,
      });
      // 真实 2.2.20 的 update 返回 `{ data: 更新后的记录 }`；界面据此重新读回。
      sendJson(res, { data: updated });
      return;
    }

    if (action === 'aiContextDatasources:destroy' && method === 'POST') {
      const id = decodeURIComponent(new URL(url, 'http://127.0.0.1').searchParams.get('filterByTk') ?? '');
      const existed = CONTROLLED_CONTEXTS.delete(id);
      record({ kind: 'context-destroy', id, existed });
      sendJson(res, { data: existed ? 1 : 0 });
      return;
    }

    if (action === 'aiContextDatasources:get' && method === 'GET') {
      const id = /filterByTk=([^&]+)/.exec(url)?.[1] ?? '';
      const record_ = CONTROLLED_CONTEXTS.get(decodeURIComponent(id));
      if (!record_) return next();
      record({ kind: 'context-get', id: record_.id });
      sendJson(res, { data: record_ });
      return;
    }

    if (action === 'aiContextDatasources:list' && method === 'GET') {
      if (CONTROLLED_CONTEXTS.size === 0) return next();
      const rows = [...CONTROLLED_CONTEXTS.values()];
      record({ kind: 'context-list', count: rows.length });
      sendJson(res, { data: rows, meta: { count: rows.length } });
      return;
    }

    // 安全网：非本地应答的**写请求**一律拦下（正常登录/退出与已知只读 POST 例外）。
    if (method !== 'GET' && !isAllowedReadPost(action)) {
      record({ kind: 'blocked-write', action, method, reason: 'controlled-harness-non-get' });
      sendJson(res, { errors: [{ message: 'blocked by controlled harness: only read requests are proxied' }] }, 403);
      return;
    }

    recordProxied(method, action, pathname);
    return next();
  };
}

/* ------------------------------- 控制页可见的流状态 ------------------------------- */

/** 流生命周期事件类型（控制页"会话流与缓存"区只显示这些）。 */
const STREAM_EVENT_KINDS = new Set([
  'send',
  'socket-drop',
  'abort',
  'generation-stopped',
  'generation-persist',
  'resumeStream',
  'work-context-code',
  'tool-plan',
]);

/**
 * 每个受控会话的流与缓存状态（供可见控制页核对 drop / 停止 / 续流，不暴露任何业务正文）。
 *
 *  - `llmActiveState`：`getConversationLLMActiveState` 的真实来源；
 *  - `cached`：增量缓存是否可回放（`[[nocache]]` = false → `chunks_cache_missing`）；
 *  - `emitted / total`：真正写到连接上的分段数 / 计划分段数（停止后历史长度就取 `emitted`）；
 *  - `codeUid`：本会话已提供过的真实代码工作区 uid（后续 `[[tools]]` 就用它选工具 id）。
 */
export function controlledStreamState() {
  return [...CONTROLLED_SESSIONS].map((sessionId) => {
    const generation = GENERATIONS.get(sessionId) ?? null;
    return {
      sessionId,
      llmActiveState: SESSION_STATES.get(sessionId) ?? 'idle',
      cached: generation ? generation.cached : null,
      cacheMissing: NO_CACHE_SESSIONS.has(sessionId),
      emitted: generation ? generation.emitted.length : 0,
      total: generation ? generation.chunks.length : 0,
      done: generation ? Boolean(generation.done) : null,
      stopped: generation ? Boolean(generation.cancelled) : null,
      codeUid: SESSION_CODE_UIDS.get(sessionId) ?? null,
    };
  });
}

/** 最近的流生命周期事件（控制页可见；含 updateRead 原值等既有证据字段）。 */
export function controlledStreamEvents(limit = 30) {
  return evidence.filter((entry) => STREAM_EVENT_KINDS.has(entry.kind)).slice(-limit).reverse();
}

