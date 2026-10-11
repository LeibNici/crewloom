#!/usr/bin/env node
/**
 * P1 测试夹具准备脚本（只在 250 新实例 http://172.16.88.250:13080 上创建本任务专用内容）。
 *
 * ⚠️ 本脚本会向后端写入角色与用户。
 * P1 修复轮（docs/acceptance/p1-repair.md）明确禁止创建/恢复/修理夹具与任何业务写入，
 * 因此脚本默认**拒绝运行**：必须显式设置 CREWLOOM_ALLOW_FIXTURE_WRITE=1 才会继续。
 * 本轮的验证不依赖它（夹具已存在，只做只读联调）。
 *
 * 创建内容（全部使用 crewloom_p1_* 命名，便于识别与回收）：
 *  - 角色 crewloom_p1_admin：标题「Crewloom P1 配置权限」，snippets 与内置 Admin 相同
 *    （pm / pm.* / ui.*），用于验证"配置权限用户"路径；
 *  - 角色 crewloom_p1_limited：标题「Crewloom P1 受限用户」，无 snippet，strategy 仅 view，
 *    用于验证"受限用户"路径；
 *  - 用户 crewloom-fixture-admin@example.invalid 与 crewloom-fixture-admin@example.invalid，
 *    随机口令，仅绑定上面的角色。
 *
 * 边界：
 *  - 不修改内置角色（admin / member / root）的定义；
 *  - 不修改其他用户或既有记录；
 *  - 不删除任何既有内容；重复执行只补齐缺失项；
 *  - 口令只写入 .secrets/crewloom-p1-fixtures.json（600，已被 .gitignore 排除）。
 */

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const ENV_PATH = process.env.CREWLOOM_ENV_FILE ?? resolve(repoRoot, '.secrets/250-crewloom-dev.env');
const FIXTURE_PATH = resolve(repoRoot, '.secrets/crewloom-p1-fixtures.json');
const API = `${process.env.CREWLOOM_BACKEND_ORIGIN ?? 'http://172.16.88.250:13080'}/api`;

// 传输层硬约束：本脚本会写后端，因此默认禁用；显式开关才会执行。
if (process.env.CREWLOOM_ALLOW_FIXTURE_WRITE !== '1') {
  console.error(
    [
      '已阻止运行：P1 修复轮不允许创建/恢复夹具或任何业务写入。',
      '本脚本会调用 roles:create / users:create 等写入动作。',
      '如确需在后续阶段执行，请显式设置 CREWLOOM_ALLOW_FIXTURE_WRITE=1。',
      '本轮只读联调请使用：pnpm run verify:backend（只发允许清单内的只读 GET 与正常登录/退出）。',
    ].join('\n'),
  );
  process.exit(3);
}

const PASSWORD_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomPassword(length = 20) {
  const bytes = randomBytes(length);
  let out = '';
  for (const byte of bytes) out += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length];
  return out;
}

function parseEnvFile(path) {
  const out = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

async function call(path, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Authenticator': 'basic' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* 文本响应 */
  }
  return { status: response.status, body: parsed };
}

const ROLE_SPECS = [
  {
    name: 'crewloom_p1_admin',
    title: 'Crewloom 配置权限',
    description: 'P1 前端验收专用：与内置 Admin 相同的权限片段，用于验证配置权限用户的模块可见性。',
    snippets: ['pm', 'pm.*', 'ui.*'],
    strategy: { actions: ['create', 'view', 'update', 'destroy', 'export', 'importXlsx'] },
  },
  {
    name: 'crewloom_p1_limited',
    title: 'Crewloom 受限用户',
    description:
      'P1 前端验收专用：无权限片段、无默认策略、无显式资源授权，仅保留登录态自身能力（auth:check、自己的会话/待办与可用员工）。用于验证受限用户的入口可见性、后端拒绝行为，以及角色信息不可读时的界面降级。',
    snippets: [],
    strategy: null,
  },
];

const USER_SPECS = [
  {
    key: 'crewloom_p1_admin',
    email: 'crewloom-fixture-admin@example.invalid',
    roles: ['crewloom_p1_admin'],
    nickname: 'Crewloom 配置权限账号',
  },
  {
    key: 'crewloom_p1_limited',
    email: 'crewloom-fixture-admin@example.invalid',
    roles: ['crewloom_p1_limited'],
    nickname: 'Crewloom 受限账号',
  },
  {
    key: 'crewloom_p1_multi',
    email: 'crewloom-fixture-admin@example.invalid',
    roles: ['crewloom_p1_admin', 'crewloom_p1_limited'],
    nickname: 'Crewloom 多角色账号',
  },
];

async function main() {
  if (!existsSync(ENV_PATH)) {
    console.error(`未找到环境文件：${ENV_PATH}`);
    process.exitCode = 2;
    return;
  }
  const env = parseEnvFile(ENV_PATH);
  const signIn = await call('/auth:signIn', {
    method: 'POST',
    body: { email: env.INIT_ROOT_EMAIL, password: env.INIT_ROOT_PASSWORD },
  });
  const token = signIn.body?.data?.token;
  if (!token) {
    console.error(`管理员登录失败：HTTP ${signIn.status}`);
    process.exitCode = 1;
    return;
  }
  console.log('管理员登录成功，开始准备夹具。');

  const fixtures = existsSync(FIXTURE_PATH)
    ? JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))
    : { generatedAt: new Date().toISOString(), api: API, users: {} };
  fixtures.api = API;
  fixtures.roles = fixtures.roles ?? {};

  for (const spec of ROLE_SPECS) {
    const existing = await call(`/roles:list?filter=${encodeURIComponent(JSON.stringify({ name: spec.name }))}`, {
      token,
    });
    const found = Array.isArray(existing.body?.data) ? existing.body.data[0] : undefined;
    if (found) {
      fixtures.roles[spec.name] = { name: spec.name, title: found.title, created: false };
      console.log(`角色已存在：${spec.name}`);
      continue;
    }
    const created = await call('/roles:create', {
      method: 'POST',
      token,
      body: { name: spec.name, title: spec.title, description: spec.description, snippets: spec.snippets, strategy: spec.strategy },
    });
    if (created.status >= 400) {
      console.error(`角色创建失败：${spec.name} HTTP ${created.status}`);
      process.exitCode = 1;
      continue;
    }
    fixtures.roles[spec.name] = { name: spec.name, title: spec.title, created: true };
    console.log(`角色已创建：${spec.name}`);
  }

  for (const spec of USER_SPECS) {
    const existing = await call(
      `/users:list?filter=${encodeURIComponent(JSON.stringify({ email: spec.email }))}`,
      { token },
    );
    const found = Array.isArray(existing.body?.data) ? existing.body.data[0] : undefined;
    const password = fixtures.users?.[spec.key]?.password ?? randomPassword();
    if (found) {
      fixtures.users[spec.key] = {
        ...(fixtures.users?.[spec.key] ?? {}),
        id: found.id,
        email: spec.email,
        password,
        roles: spec.roles,
      };
      console.log(`用户已存在：${spec.email}（id ${found.id}）`);
      continue;
    }
    const created = await call('/users:create', {
      method: 'POST',
      token,
      body: {
        email: spec.email,
        nickname: spec.nickname,
        username: spec.key,
        password,
        roles: spec.roles,
      },
    });
    if (created.status >= 400) {
      console.error(`用户创建失败：${spec.email} HTTP ${created.status}`);
      process.exitCode = 1;
      continue;
    }
    fixtures.users[spec.key] = { id: created.body.data.id, email: spec.email, password, roles: spec.roles };
    console.log(`用户已创建：${spec.email}（id ${created.body.data.id}）`);
  }

  // 受限角色保持"无权限片段、无默认策略、无显式资源授权"的干净基线：
  // 它的作用就是验证"低权限/读不到角色信息"时前端是否友好降级，
  // 因此**不**为它补任何权限（否则等于用扩大权限来掩盖界面问题）。
  fixtures.limitedRoleGrants = [];
  console.log('受限角色保持干净基线：不补任何权限片段或资源授权。');

  fixtures.generatedAt = new Date().toISOString();
  writeFileSync(FIXTURE_PATH, JSON.stringify(fixtures, null, 2), { mode: 0o600 });
  chmodSync(FIXTURE_PATH, 0o600);
  console.log(`夹具信息已写入（600，不含任何内置账号凭据）：${FIXTURE_PATH}`);
  console.log('下一步：node scripts/verify-backend.mjs（会刷新夹具令牌并输出对接证据）。');
}

await main();
