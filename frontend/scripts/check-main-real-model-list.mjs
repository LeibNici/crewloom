#!/usr/bin/env node
/**
 * A 项真实只读验证：strict 预览下原生会话的模型列表（13000 真实目标）。
 *
 * 背景（Main 在 5333 实测）：真实员工有专用 `xinhao-maas/deepseek-v4.1-flash`、LM 服务 1 个，
 * 但原生 ChatBox 显示“无可用模型” / “暂无已启用的 LLM 服务”。根因是 strict 传输策略没有放行
 * `ai:listAllEnabledModels`（原生 AIConfigRepository 用 POST 触发），请求在浏览器侧就被拦；
 * 本脚本验证放行后模型列表来自真实后端。
 *
 * 真实边界：
 *  - 只做一次真实登录 + 只读模型配置读取，**不发送消息、不调用模型、不写任何数据**；
 *  - 凭据只从 0600 文件读进内存，不打印、不写日志；
 *  - strict 模式下写动作仍被拦（脚本会断言 users:create 仍是 403）。
 *
 * 用法：node scripts/check-main-real-model-list.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  launchBrowser,
  goto,
  evaluate,
  typeInto,
  mouseClickSelector,
  sleep,
  waitFor,
} from './lib/cdp-browser.mjs';

const APP_URL = (process.env.CREWLOOM_APP_URL ?? 'http://127.0.0.1:5341').replace(/\/$/, '');
const SECRETS_PATH =
  process.env.CREWLOOM_REAL_SECRETS ?? '/Users/chenming/IdeaProjects/crewloom/.secrets/full-pages-13000-20261011.json';
const AUDIT_PATH = fileURLToPath(
  new URL('../../docs/acceptance/full-pages-13000/evidence/transport-audit.jsonl', import.meta.url),
);
const FRAME = '[data-testid="native-chatbox-frame"]';

const results = [];
function check(name, ok, note = '') {
  results.push({ name, ok: Boolean(ok), note });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? ` — ${note}` : ''}`);
}
const reason = (error) => String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 200);

function auditEntries() {
  try {
    return readFileSync(AUDIT_PATH, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function main() {
  const secrets = JSON.parse(readFileSync(SECRETS_PATH, 'utf8'));
  const baselineAudit = auditEntries().length;

  let browser = null;
  try {
    browser = await launchBrowser({ debugPort: 9444, width: 1440, height: 1000 });
  } catch (error) {
    check('0. headless Chrome 启动', false, reason(error));
    return;
  }
  const { cdp } = browser;
  try {
    // strict 写动作仍然被拦（不是放宽了严格模式）。
    const blocked = await fetch(`${APP_URL}/api/users:create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    check('1. strict 仍拦截写动作（users:create 403）', blocked.status === 403, `status=${blocked.status}`);

    await goto(cdp, `${APP_URL}/login`, 2500);
    const shown = await waitFor(cdp, `Boolean(document.querySelector('input[name="crewloom-account"]'))`, {
      timeoutMs: 25000,
    });
    if (!shown) throw new Error('登录页没有出现账号输入框');
    await sleep(400);
    await typeInto(cdp, 'input[name="crewloom-account"]', secrets.email);
    await typeInto(cdp, 'input[name="crewloom-secret"]', secrets.password);
    await mouseClickSelector(cdp, 'button[type="submit"]');
    const arrived = await waitFor(cdp, `location.pathname === '/workbench'`, { timeoutMs: 30000 });
    check('2. 真实 13000 正常登录进入工作台', arrived, `path=${await evaluate(cdp, 'location.pathname')}`);
    if (!arrived) return;

    await goto(cdp, `${APP_URL}/ai/conversations`, 5000);
    const mounted = await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(FRAME)}))`, { timeoutMs: 30000 });
    check('3. 原生 ChatBox 挂载', mounted);
    if (!mounted) return;
    // 给真实后端的模型列表请求一点时间。
    await sleep(6000);

    const text = await evaluate(cdp, `document.querySelector(${JSON.stringify(FRAME)}).innerText || ''`);
    check(
      '4a. 不再显示“暂无已启用的 LLM 服务 / No model available”',
      !text.includes('暂无已启用的 LLM 服务') && !text.includes('No model available'),
      text.replace(/\n/g, ' | ').slice(0, 200),
    );
    check(
      '4b. 界面出现真实专用模型（deepseek-v4.1-flash）',
      /deepseek-v4\.1-flash/i.test(text),
      text.replace(/\n/g, ' | ').slice(0, 200),
    );

    const appended = auditEntries().slice(baselineAudit);
    const modelReads = appended.filter((entry) => entry.action === 'ai:listAllEnabledModels');
    check(
      '5. 传输审计：strict 下 ai:listAllEnabledModels 被放行（不再 action-not-allowlisted）',
      modelReads.length > 0 && modelReads.every((entry) => entry.decision === 'allowed'),
      JSON.stringify(modelReads.slice(-2)),
    );
  } catch (error) {
    check('运行异常', false, reason(error));
  } finally {
    browser.close();
  }
}

await main();
const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
