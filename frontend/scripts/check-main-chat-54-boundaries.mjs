#!/usr/bin/env node
/**
 * 54 边界判别测试（纯本机，不起浏览器、不外呼）。
 *
 *  1. cacheMissing 真实终态：`[[nocache]]` 连接断开后服务端仍在后台生成；
 *     `resumeStream` 在生成中返回 `chunks_cache_missing`（带 llmActiveState），
 *     后台完成后状态变 idle、内容落库、再续流不再报缓存缺失。
 *     —— 不是"永远不可恢复"，也不是伪造错误。
 *  2. AI 任务非本人只读：`aiWorkflowTasks:getBySession.readonly` 按**真实 actor** 计算
 *     （真实 2.2.20：`readonly = status !== pending_approval || acceptedUserId !== userId`）；
 *     非受理人 reject 被真实拒绝，受理人正常。
 *
 * 用法：node scripts/check-main-chat-54-boundaries.mjs   退出码 0 = 全部通过。
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CREWLOOM_BOUNDARY_PORT ?? 5468);
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

async function api(url, { method = 'GET', body, token, stream = false } = {}) {
  const response = await fetch(`${BASE}/api/${url}`, {
    method,
    headers: {
      accept: stream ? 'text/event-stream' : 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (stream) {
    // `[[nocache]]` 会在写完第一段后真 `res.destroy()`：读流会以 socket 错误结束，
    // 这里按"已收到的内容"处理，不把真断线当成脚本失败。
    let text = '';
    try {
      text = await response.text();
    } catch {
      /* 真断线：保留空/部分文本 */
    }
    return { status: response.status, text };
  }
  const payload = await response.json().catch(() => null);
  return { status: response.status, body: payload };
}

async function signIn(email) {
  const response = await api('auth:signIn', { method: 'POST', body: { email, password: 'fixture' } });
  return response.body?.data?.token ?? null;
}

/** 控制页端点（`/control/**`，不带 `/api` 前缀）。 */
async function control(path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return response.json().catch(() => null);
}

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

    // ---------- 1. cacheMissing 真实终态 ----------
    const created = await api('aiConversations:create', {
      method: 'POST',
      body: { aiEmployee: { username: 'synth-analyst' } },
    });
    const sessionId = created.body?.data?.sessionId;
    const sent = await api('aiConversations:sendMessages', {
      method: 'POST',
      stream: true,
      body: { sessionId, aiEmployee: 'synth-analyst', messages: [{ role: 'user', content: '[[nocache]]' }] },
    });
    check('1a. [[nocache]] 先流出一段再真断开', sent.status === 200, `status=${sent.status}`);

    await sleep(300);
    const stateResp = await api(`aiConversations:get?filterByTk=${encodeURIComponent(JSON.stringify({ sessionId }))}`);
    const activeWhileGenerating = stateResp.body?.data?.llmActiveState;
    check('1b. 断开后服务端仍在生成（streaming）', activeWhileGenerating === 'streaming', `state=${activeWhileGenerating}`);

    const resumeWhile = await api('aiConversations:resumeStream', { method: 'POST', body: { sessionId }, stream: true });
    const cacheMissingFrame = resumeWhile.text.includes('chunks_cache_missing');
    check(
      '1c. 生成中续流返回 chunks_cache_missing（真实不可回放，不是空跑）',
      cacheMissingFrame,
      resumeWhile.text.slice(0, 120),
    );
    check(
      '1d. cacheMissing 帧带真实 llmActiveState=streaming（真实 2.2.20 帧体）',
      resumeWhile.text.includes('"llmActiveState":"streaming"'),
    );

    let entry = null;
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const control = await (await fetch(`${BASE}/control/state`)).json();
      entry = (control.streams ?? []).find((item) => item.sessionId === sessionId) ?? null;
      if (entry?.llmActiveState === 'idle' && entry?.done === true) break;
      await sleep(300);
    }
    check(
      '1e. 后台生成完成后真实终态：idle + done（可轮询到，不永远 streaming）',
      entry?.llmActiveState === 'idle' && entry?.done === true,
      JSON.stringify(entry ?? null),
    );

    const resumeAfter = await api('aiConversations:resumeStream', { method: 'POST', body: { sessionId }, stream: true });
    check(
      '1f. 完成后续流不再报 chunks_cache_missing（真实服务端 idle 时直接结束）',
      !resumeAfter.text.includes('chunks_cache_missing'),
      resumeAfter.text.slice(0, 80),
    );

    const history = await api(`aiConversations:getMessages?sessionId=${encodeURIComponent(sessionId)}&updateRead=false`);
    const assistant = (history.body?.data ?? []).filter((row) => row.role !== 'user').map((row) => String(row.content?.content ?? ''));
    check(
      '1g. 完整内容已落库（后台三段）',
      assistant.length === 1 && assistant[0].includes('后台生成已经完成'),
      JSON.stringify(assistant),
    );

    // ---------- 2. AI 任务非本人只读 ----------
    const seeded = await control('/control/td03/seed', {});
    void seeded;
    const reset = await control('/control/td03/reset', { status: 'pending_approval' });
    const task = reset?.td03 ?? {};
    const taskSession = task.sessionId;
    const taskId = task.taskId;
    check(
      '2a. 夹具准备：任务已领取（acceptedUserId=3，pending_approval）',
      task.status === 'pending_approval' && Number(task.acceptedUserId) === 3,
      `status=${task.status} accepted=${task.acceptedUserId} session=${taskSession}`,
    );

    const zhangsan = await signIn('zhangsan@fixture.local');
    const lisi = await signIn('lisi@fixture.local');
    check('2b. 两个合成账号都能登录（actor 由令牌解析）', Boolean(zhangsan) && Boolean(lisi));

    const asOwner = await api(`aiWorkflowTasks:getBySession?sessionId=${encodeURIComponent(taskSession)}`, {
      method: 'POST',
      token: zhangsan,
      body: { sessionId: taskSession },
    });
    const asOther = await api(`aiWorkflowTasks:getBySession?sessionId=${encodeURIComponent(taskSession)}`, {
      method: 'POST',
      token: lisi,
      body: { sessionId: taskSession },
    });
    check(
      '2c. 受理人（张三 3）读到 readonly=false',
      asOwner.status === 200 && asOwner.body?.data?.readonly === false,
      `status=${asOwner.status} readonly=${asOwner.body?.data?.readonly}`,
    );
    check(
      '2d. 非受理人（李四 7）按真实契约读到 readonly=true（不是 fixture 固定按 3 算）',
      asOther.status === 200 && asOther.body?.data?.readonly === true,
      `status=${asOther.status} readonly=${asOther.body?.data?.readonly}`,
    );

    const rejectAsOther = await api('aiWorkflowTasks:reject', {
      method: 'POST',
      token: lisi,
      body: { id: taskId, result: { decision: 'reject' } },
    });
    check(
      '2e. 非受理人的决定请求被真实拒绝（403，不执行）',
      rejectAsOther.status === 403 && rejectAsOther.body?.errors?.[0]?.code === 'AI_TASK_NOT_REJECTABLE',
      `status=${rejectAsOther.status} code=${rejectAsOther.body?.errors?.[0]?.code}`,
    );

    const rejectAsOwner = await api('aiWorkflowTasks:reject', {
      method: 'POST',
      token: zhangsan,
      body: { id: taskId, result: { decision: 'reject' } },
    });
    check(
      '2f. 受理人可以正常终止（对照，证明 2e 不是一律拒绝）',
      rejectAsOwner.status === 200 && rejectAsOwner.body?.data?.rejected === true,
      `status=${rejectAsOwner.status} rejected=${rejectAsOwner.body?.data?.rejected}`,
    );
  } finally {
    server.kill('SIGTERM');
  }
}

await main();
const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
