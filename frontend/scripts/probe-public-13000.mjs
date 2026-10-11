#!/usr/bin/env node
/**
 * 公共页面（PUB-01…PUB-06）在真实 13000（NocoBase 2.2.20）上的**只读**能力核对。
 *
 * 与 `verify-13000-readonly.mjs` 的分工：
 *  - `verify:13000` 是模块级只读冒烟（列表/详情可用性）；
 *  - 本脚本只核对公共页面所需的少量能力端点，并把**能力是否开通**与"数据为空"分开记录，
 *    供 PUB-01（改密/找回）、PUB-04（附件）、PUB-06（品牌系统信息）的实现与报告引用。
 *
 * 硬边界（脚本内实现，不靠文字约定）：
 *  - 目的地固定为凭据文件里的 `apiBaseURL` 来源，路径必须在 `/api` 下；
 *  - 强制 `policyMode: 'strict'`：只放行允许清单内的只读 GET 与正常 `auth:signIn` / `auth:signOut`；
 *  - **不调用** `auth:lostPassword` / `auth:resetPassword`（会真实发信）、`attachments:upload`
 *    （会真实写文件）、`ai:listModels` / `ai:testFlight`（会真实外呼或产生费用）；
 *  - 凭据只在进程内存里从 0600 的凭据文件读取：不进 argv、不进环境变量、不写日志、不打屏；
 *  - 证据只写状态码、计数、字段名与**非敏感**标量（如语言列表、开关布尔值），
 *    不写账号、令牌、密钥、记录正文。
 *
 * 用法：
 *   pnpm run verify:public            # 只读能力核对 + 写证据
 *   CREWLOOM_PUBLIC_OUT=<path> pnpm run verify:public
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertNoBlockedRequests,
  getRequestCounts,
  getRequestLog,
  guardedFetch,
} from './lib/transport-policy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
// 凭据固定放在主工作区，分工作树不复制：先看本工作树，再回退到主工作区（本工作树的上一级）。
const SECRET_CANDIDATES = [
  resolve(repoRoot, '.secrets/full-pages-13000-20261011.json'),
  resolve(repoRoot, '..', '..', '.secrets/full-pages-13000-20261011.json'),
];
const SECRET_PATH =
  process.env.CREWLOOM_13000_SECRETS ??
  SECRET_CANDIDATES.find((candidate) => existsSync(candidate)) ??
  SECRET_CANDIDATES[0];
const OUT =
  process.env.CREWLOOM_PUBLIC_OUT ??
  resolve(repoRoot, 'docs/acceptance/full-pages-13000/public-evidence/public-readonly-13000.json');

let ORIGIN = null;
let authenticator = 'basic';

async function request(path, { method = 'GET', token, body, headers: extraHeaders } = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Authenticator': authenticator, ...extraHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await guardedFetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    baseOrigin: ORIGIN,
    allowedOrigins: [ORIGIN],
    policyMode: 'strict',
  });
  const text = await response.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* 非 JSON 响应保留文本，由下面的分类函数处理 */
  }
  return { status: response.status, body: parsed };
}

function classify(status, body) {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'no-permission';
  if (status === 404) return 'route-not-provided';
  if (status >= 500) return 'server-error';
  if (status === 200) {
    if (Array.isArray(body?.data)) return body.data.length === 0 ? 'ok-empty' : 'ok-has-data';
    return 'ok';
  }
  return 'other';
}

function dataKeys(body) {
  const data = body?.data;
  return data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data) : null;
}

/** 系统设置里对公共页面有用、且不含凭据的标量。 */
function systemSettingsSummary(body) {
  const data = body?.data ?? {};
  const logo = data.logo;
  const title = typeof data.title === 'string' ? data.title : null;
  return {
    dataKeys: dataKeys(body),
    // 后台应用名称是真实配置内容，证据里只记录"是否已设置"与长度，不落原文。
    titlePresent: Boolean(title && title.length > 0),
    titleLength: title ? title.length : 0,
    appLang: typeof data.appLang === 'string' ? data.appLang : null,
    enabledLanguages: Array.isArray(data.enabledLanguages) ? data.enabledLanguages : null,
    roleMode: data.roleMode ?? null,
    showLogoOnly: data.showLogoOnly ?? null,
    allowSignUp: data.allowSignUp ?? null,
    smsAuthEnabled: data.smsAuthEnabled ?? null,
    enableEditProfile: data.enableEditProfile ?? null,
    enableChangePassword: data.enableChangePassword ?? null,
    logoId: data.logoId ?? null,
    logoPresent: Boolean(logo),
    logoKeys: logo && typeof logo === 'object' ? Object.keys(logo) : null,
    optionsKeys: data.options && typeof data.options === 'object' ? Object.keys(data.options) : null,
  };
}

/** 登录方式：只保留名称与"是否开放自助找回"这类公开选项，不输出选项里的其它值。 */
function authenticatorsSummary(body) {
  const list = Array.isArray(body?.data) ? body.data : [];
  return {
    count: list.length,
    items: list.map((item) => ({
      name: item?.name ?? null,
      authType: item?.authType ?? null,
      title: item?.title ?? null,
      publicOptionKeys: item?.options && typeof item.options === 'object' ? Object.keys(item.options) : null,
      enableResetPassword: item?.options?.enableResetPassword ?? null,
    })),
  };
}

/** 默认存储：只保留类型/规则/是否公开，不输出路径或密钥。 */
function storageSummary(body) {
  const data = body?.data ?? {};
  return {
    dataKeys: dataKeys(body),
    id: data.id ?? null,
    name: data.name ?? null,
    type: data.type ?? null,
    title: data.title ?? null,
    public: data.public ?? null,
    baseUrlPresent: typeof data.baseUrl === 'string' && data.baseUrl.length > 0,
    rulesKeys: data.rules && typeof data.rules === 'object' ? Object.keys(data.rules) : null,
    /** 单文件上限（字节）；用于界面上给出真实限制。 */
    maxSizeBytes:
      data.rules && typeof data.rules === 'object' && typeof data.rules.size === 'number'
        ? data.rules.size
        : null,
  };
}

function rolesSummary(body) {
  const data = body?.data ?? {};
  return { dataKeys: dataKeys(body), roleMode: data.roleMode ?? null, rolePresent: Boolean(data.role) };
}

function identitySummary(body) {
  const data = body?.data ?? {};
  return {
    authenticated: Boolean(data?.id),
    roleCount: Array.isArray(data?.roles) ? data.roles.length : null,
    hasUsername: typeof data?.username === 'string',
  };
}

/**
 * 期望结果写死在脚本里：任何一项偏离都让脚本以非 0 退出，避免"跑过了"被当成"核对通过"。
 * `attachments:list` 期望 404 是**设计如此**（plugin-file-manager 显式把 list 覆盖成 404），
 * 用于证明"不能拿 404 推断没有上传能力"。
 */
const EXPECTATIONS = [
  { path: '/api/app:getInfo', expect: [200], summarize: (body) => ({ version: body?.data?.version ?? null, lang: body?.data?.lang ?? null }) },
  { path: '/api/authenticators:publicList', expect: [200], summarize: authenticatorsSummary },
  { path: '/api/systemSettings:get', expect: [200], summarize: systemSettingsSummary },
  { path: '/api/storages:getBasicInfo', expect: [200], auth: true, summarize: storageSummary },
  { path: '/api/attachments:list', expect: [404], auth: true, summarize: (body) => ({ errors: Array.isArray(body?.errors) ? body.errors.length : null }) },
  { path: '/api/roles:check', expect: [200], auth: true, summarize: rolesSummary },
];

async function main() {
  const evidence = {
    generatedAt: new Date().toISOString(),
    target: null,
    policyMode: 'strict',
    note:
      'PUB-01/04/06 公共能力只读核对：不调用找回密码发信、不调用上传、不调用模型发现或推理；' +
      '不输出账号、令牌、密钥与记录正文。',
    version: null,
    signInStatus: null,
    identity: null,
    probes: {},
    signOut: null,
    requestCounts: null,
  };

  if (!existsSync(SECRET_PATH)) {
    console.error(`缺少凭据文件：${SECRET_PATH}`);
    process.exitCode = 2;
    return;
  }
  const secrets = JSON.parse(readFileSync(SECRET_PATH, 'utf8'));
  const raw = String(secrets.apiBaseURL).replace(/\/+$/, '');
  ORIGIN = raw.endsWith('/api') ? raw.slice(0, -'/api'.length) : raw;
  evidence.target = ORIGIN;

  const publicList = await request('/api/authenticators:publicList');
  if (Array.isArray(publicList.body?.data) && publicList.body.data[0]?.name) {
    authenticator = publicList.body.data[0].name;
  }

  const signIn = await request('/api/auth:signIn', {
    method: 'POST',
    body: { email: secrets.email, password: secrets.password },
  });
  evidence.signInStatus = signIn.status;
  if (signIn.status !== 200) {
    finish(evidence, 1);
    return;
  }
  const token = signIn.body?.data?.token;

  const authCheck = await request('/api/auth:check', { token });
  evidence.identity = identitySummary(authCheck.body);
  evidence.version = (await request('/api/app:getInfo')).body?.data?.version ?? null;

  let mismatches = 0;
  for (const probe of EXPECTATIONS) {
    const result = await request(probe.path, { token: probe.auth ? token : undefined });
    const outcome = classify(result.status, result.body);
    const ok = probe.expect.includes(result.status);
    if (!ok) mismatches += 1;
    evidence.probes[probe.path] = {
      status: result.status,
      outcome,
      expected: probe.expect,
      matched: ok,
      summary: probe.summarize ? probe.summarize(result.body) : undefined,
    };
  }

  const signOut = await request('/api/auth:signOut', { method: 'POST', token, body: {} });
  const afterSignOut = await request('/api/auth:check', { token });
  evidence.signOut = { status: signOut.status, afterStatus: afterSignOut.status };

  finish(evidence, mismatches === 0 ? 0 : 1);
}

function finish(evidence, exitCode) {
  evidence.finishedAt = new Date().toISOString();
  evidence.requestLog = getRequestLog();
  evidence.requestCounts = getRequestCounts();
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`);
  assertNoBlockedRequests();
  const mismatched = Object.entries(evidence.probes).filter(([, value]) => !value.matched);
  console.log(
    `公共页面只读核对：版本 ${evidence.version ?? '未知'}，探测 ${Object.keys(evidence.probes).length} 项，` +
      `不符合预期 ${mismatched.length} 项；请求 ${evidence.requestCounts.allowed} 条放行 / ${evidence.requestCounts.blocked} 条拦截`,
  );
  for (const [path, value] of Object.entries(evidence.probes)) {
    console.log(`  ${value.matched ? 'OK  ' : 'DIFF'} ${path} → ${value.status} (${value.outcome})`);
  }
  console.log(`证据：${OUT}`);
  process.exitCode = exitCode;
}

await main();
