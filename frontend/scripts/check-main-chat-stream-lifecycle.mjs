#!/usr/bin/env node
/**
 * 聊天流生命周期判别测试（纯本机，不起浏览器、不外呼）。
 *
 * 覆盖 Main 在报告 33/45 里实测到的三类真实缺陷，逐项断言**可判别**的行为：
 *  1. `[[drop]]`：真 socket 断开（读流在秒级内以错误结束），已收到内容落库，状态回 idle；
 *  2. 主动停止：`abort` 之后后台生成必须停，历史里只有**已经生成**的分段（不是完整 40 段）；
 *  3. 客户端断开 → `resumeStream`：命中缓存续流（cacheReplay），
 *     `[[nocache]]` 则明确返回 `chunks_cache_missing`；
 *  4. 多工具后续消息 `[[tools]]`：用**本会话已经提供过**的真实 workContext uid 生成工具 id，
 *     不要求产品第二条消息重复携带上下文，也不注册任何假工具。
 *
 * 用法：
 *   node scripts/check-main-chat-stream-lifecycle.mjs
 * 退出码 0 = 全部通过。
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CREWLOOM_LIFECYCLE_PORT ?? 5461);
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];

function check(name, ok, note = '') {
  results.push({ name, ok: Boolean(ok), note });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? ` — ${note}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/healthz`);
      if (response.ok) return true;
    } catch {
      /* 继续等待 */
    }
    await sleep(200);
  }
  return false;
}

async function api(url, body, extra = {}) {
  return fetch(`${BASE}/api/${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...extra,
  });
}

async function createSession() {
  const response = await api('aiConversations:create', { aiEmployee: { username: 'synth-analyst' } });
  const payload = await response.json();
  return payload.data.sessionId;
}

async function activeState(sessionId) {
  const filter = encodeURIComponent(JSON.stringify({ sessionId }));
  const response = await fetch(`${BASE}/api/aiConversations:get?filterByTk=${filter}`);
  const payload = await response.json().catch(() => ({}));
  return payload?.data?.llmActiveState ?? null;
}

async function history(sessionId) {
  const response = await fetch(
    `${BASE}/api/aiConversations:getMessages?sessionId=${encodeURIComponent(sessionId)}&updateRead=false`,
  );
  const payload = await response.json();
  return payload.data ?? [];
}

/** 从读流里收到 n 个 content 分段后返回（不关闭连接）。 */
async function readContentFrames(response, target) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let count = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { done: true, count };
    const text = decoder.decode(value, { stream: true });
    count += (text.match(/"type":"content"/g) ?? []).length;
    if (count >= target) return { done: false, count };
  }
}

/** 读完整条流，返回 { text, errorName, elapsedMs }。 */
async function readToEnd(response) {
  const started = Date.now();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { text, errorName: null, elapsedMs: Date.now() - started };
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    return { text, errorName: error?.name ?? 'Error', elapsedMs: Date.now() - started };
  }
}

const assistantTexts = (rows) =>
  rows.filter((row) => row.role !== 'user').map((row) => String(row.content?.content ?? ''));

async function main() {
  const server = spawn(process.execPath, [join(here, 'main-browser-chat-server.mjs')], {
    env: { ...process.env, CREWLOOM_CHAT_PORT: String(PORT), CREWLOOM_APP_URL: 'http://127.0.0.1:1' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  try {
    if (!(await waitForServer())) {
      check('0. 本机受控后端启动', false, `${BASE}/healthz 未就绪`);
      return;
    }
    check('0. 本机受控后端启动', true, `port=${PORT}`);

    // 1. drop：真断开 + 已收到内容保留 + 状态收敛。
    {
      const sessionId = await createSession();
      const response = await api('aiConversations:sendMessages', {
        sessionId,
        aiEmployee: 'synth-analyst',
        messages: [{ role: 'user', content: '[[drop]]' }],
      });
      const outcome = await readToEnd(response);
      const rows = await history(sessionId);
      check(
        '1a. [[drop]] 是真 socket 断开（读流在 3s 内以错误结束，而不是一直挂着）',
        outcome.errorName !== null && outcome.elapsedMs < 3000,
        `error=${outcome.errorName} elapsed=${outcome.elapsedMs}ms`,
      );
      check(
        '1b. [[drop]] 已收到的部分内容落库',
        assistantTexts(rows).some((text) => text.includes('受控断线前的内容')),
        `assistant=${JSON.stringify(assistantTexts(rows))}`,
      );
      check('1c. [[drop]] 后会话状态回到 idle（不再假 streaming）', (await activeState(sessionId)) === 'idle');
    }

    // 2. slow + 主动停止：生成停、历史只有已生成分段。
    {
      const sessionId = await createSession();
      const controller = new AbortController();
      const response = await api(
        'aiConversations:sendMessages',
        { sessionId, aiEmployee: 'synth-analyst', messages: [{ role: 'user', content: '[[slow]]' }] },
        { signal: controller.signal },
      );
      const read = await readContentFrames(response, 3);
      controller.abort();
      const abortResponse = await api('aiConversations:abort', { sessionId });
      check('2a. abort 动作本机应答 200', abortResponse.status === 200, `status=${abortResponse.status}`);
      const rowsAtStop = await history(sessionId);
      const lengthsAtStop = assistantTexts(rowsAtStop).map((text) => text.length);
      check(
        '2b. 停止后历史只含已生成分段（不是完整 40 段）',
        lengthsAtStop.length === 1 && lengthsAtStop[0] === 30,
        `assistantLengths=${JSON.stringify(lengthsAtStop)} readContent=${read.count}`,
      );
      await sleep(2500);
      const rowsLater = await history(sessionId);
      const lengthsLater = assistantTexts(rowsLater).map((text) => text.length);
      check(
        '2c. 停止 2.5s 后后台生成确实停了（历史长度不再增长）',
        JSON.stringify(lengthsLater) === JSON.stringify(lengthsAtStop),
        `after=${JSON.stringify(lengthsLater)}`,
      );
      check('2d. 停止后状态 idle', (await activeState(sessionId)) === 'idle');
    }

    // 3. slow + 客户端断开 → resumeStream（cacheReplay）。
    {
      const sessionId = await createSession();
      const controller = new AbortController();
      const response = await api(
        'aiConversations:sendMessages',
        { sessionId, aiEmployee: 'synth-analyst', messages: [{ role: 'user', content: '[[slow]]' }] },
        { signal: controller.signal },
      );
      await readContentFrames(response, 3);
      controller.abort();
      await sleep(400);
      const stateAfterDisconnect = await activeState(sessionId);
      const rowsAfterDisconnect = await history(sessionId);
      check(
        '3a. 客户端断开但服务端仍在生成：状态 streaming 且未落未完成的完整内容',
        stateAfterDisconnect === 'streaming' && assistantTexts(rowsAfterDisconnect).length === 0,
        `state=${stateAfterDisconnect} assistant=${JSON.stringify(assistantTexts(rowsAfterDisconnect))}`,
      );
      const resumed = await api('aiConversations:resumeStream', { sessionId });
      const resumedText = await resumed.text();
      const replayed = (resumedText.match(/"type":"content"/g) ?? []).length;
      check(
        '3b. cacheReplay：resumeStream 从缓存位置续上剩余分段并给出 stream_end',
        replayed > 0 && replayed < 40 && resumedText.includes('"type":"stream_end"'),
        `replayed=${replayed}`,
      );
      const rowsAfterResume = await history(sessionId);
      const finalText = assistantTexts(rowsAfterResume)[0] ?? '';
      check(
        '3c. 续流结束后落库的是一条完整内容（40 段），状态 idle',
        rowsAfterResume.filter((row) => row.role !== 'user').length === 1 &&
          finalText.includes('第 40 段受控增量') &&
          (await activeState(sessionId)) === 'idle',
        `length=${finalText.length}`,
      );
    }

    // 4. nocache → chunks_cache_missing。
    {
      const sessionId = await createSession();
      const controller = new AbortController();
      const response = await api(
        'aiConversations:sendMessages',
        { sessionId, aiEmployee: 'synth-analyst', messages: [{ role: 'user', content: '[[nocache]]' }] },
        { signal: controller.signal },
      );
      await readContentFrames(response, 1).catch(() => ({ count: 0 }));
      controller.abort();
      await sleep(300);
      const resumed = await api('aiConversations:resumeStream', { sessionId });
      const resumedText = await resumed.text();
      check(
        '4. [[nocache]] 重开后明确返回 chunks_cache_missing（不空跑、不伪造内容）',
        resumedText.includes('chunks_cache_missing'),
        `frames=${resumedText.slice(0, 80)}`,
      );
    }

    // 5. 多工具后续消息：工具 id 取自本会话已提供的真实 workContext。
    {
      const sessionId = await createSession();
      // 第一条：真实代码工作区上下文（uid 由控制页/上下文页决定），不带任何场景标识。
      const first = await api('aiConversations:sendMessages', {
        sessionId,
        aiEmployee: 'synth-analyst',
        messages: [
          {
            role: 'user',
            content: '看看这段代码',
            workContext: [
              {
                type: 'code-editor',
                uid: 'crewloom:code-workspace',
                title: '代码工作区',
                content: { scene: 'crewloom-code-workspace', language: 'javascript', code: 'const a = 1;\n' },
              },
            ],
          },
        ],
      });
      await readToEnd(first);
      // 第二条：后续消息，**不带** workContext（原生契约如此）。
      const second = await api('aiConversations:sendMessages', {
        sessionId,
        aiEmployee: 'synth-analyst',
        messages: [{ role: 'user', content: '[[tools]]' }],
      });
      await readToEnd(second);
      const rows = await history(sessionId);
      const toolIds = rows
        .flatMap((row) => (Array.isArray(row.toolCalls) ? row.toolCalls : []))
        .map((call) => String(call?.args?.toolId ?? ''));
      check(
        '5. 后续 [[tools]] 用本会话已提供的真实 uid 生成工具 id（不是 controlled 默认名）',
        toolIds.length === 3 && toolIds.every((id) => id.startsWith('crewloom:code-workspace:apply_code_change')),
        `toolIds=${JSON.stringify(toolIds)}`,
      );
    }
  } finally {
    server.kill('SIGTERM');
  }
}

await main();
const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
