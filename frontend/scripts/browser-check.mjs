#!/usr/bin/env node
/**
 * 无第三方依赖的真实浏览器验收驱动（Chrome DevTools Protocol）。
 *
 * 为什么用 CDP 直连：本轮只允许在工作区内安装项目依赖，不额外引入
 * Playwright/Puppeteer 这套体积较大的运行时；Node 22 自带 WebSocket 与 fetch，
 * 足以完成真实页面导航、真实输入、截图与断言。
 *
 * 覆盖场景（全部通过 127.0.0.1:5273 的 vite 开发服务器访问真实 250 后端：
 *   1. 登录页（桌面）截图；
 *   2. 未登录访问受保护地址 → 跳转登录页并带站内返回地址；
 *   3. 真实输入错误密码 → 中文错误提示（截取状态文本，不记录密码）；
 *   4. 配置权限用户真实登录 → 工作台与导航截图（桌面）；
 *   5. 直接访问未授权模块 → 明确的"无权限"状态；
 *   6. 受限用户真实登录 → 只有工作台（桌面 + 窄屏各一张）；
 *   7. 刷新后会话恢复（仍在应用内），退出后回到未登录状态。
 *
 * 安全约束：
 *  - 口令只从 .secrets/crewloom-p1-fixtures.json 读取，注入方式为逐字符输入，
 *    不从命令行参数传入，不写入日志；
 *  - 截图前不聚焦密码框；截图中不包含口令或令牌（页面本身也不显示它们）。
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const FIXTURE_PATH = resolve(repoRoot, '.secrets/crewloom-p1-fixtures.json');
const OUT_DIR = process.env.CREWLOOM_SHOT_DIR ?? resolve(repoRoot, 'docs/acceptance/p1/screenshots');
const BASE_URL = process.env.CREWLOOM_PREVIEW_URL ?? 'http://127.0.0.1:5273';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT ?? 9333);

/** 可见文案中的开发字样检查（在 Node 侧执行，规则集中且可读）。 */
const DEVELOPER_COPY_PATTERNS = [
  ['阶段编号', /\bP[0-9]\b/],
  ['角色模式字样', /roleMode|角色模式/],
  ['内部角色标识', /crewloom_p1_[a-z]+/],
  ['接口路径', /\/api\/|[a-z]+:[a-zA-Z]+\?/],
  ['探测/后端返回字样', /探测|后端返回/],
  ['阶段字样', /后续阶段|本阶段|P1 阶段/],
  ['原始错误码', /HTTP|无权限\(|No permissions|401|403/],
];

function findDeveloperCopy(text) {
  const hits = [];
  for (const [name, pattern] of DEVELOPER_COPY_PATTERNS) {
    const match = text.match(pattern);
    if (match) hits.push(`${name}:${match[0]}`);
  }
  return hits;
}

const results = [];
function record(name, ok, note) {
  results.push({ name, ok, note });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? ` — ${note}` : ''}`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.sessionId = null;
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`));
        else res(msg.result);
      }
    });
  }

  send(method, params = {}, sessionId = this.sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((res, reject) => {
      this.pending.set(id, { resolve: res, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 30000);
    });
  }
}

async function waitForDevtools(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return await response.json();
    } catch {
      /* 继续等待 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Chrome 调试端口未就绪');
}

async function main() {
  if (!existsSync(FIXTURE_PATH)) {
    console.error(`缺少夹具文件：${FIXTURE_PATH}`);
    process.exitCode = 2;
    return;
  }
  const fixtures = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
  const adminPassword = fixtures.users.crewloom_p1_admin.password;
  const adminEmail = fixtures.users.crewloom_p1_admin.email;
  const limitedPassword = fixtures.users.crewloom_p1_limited.password;
  const limitedEmail = fixtures.users.crewloom_p1_limited.email;
  const multiEmail = fixtures.users.crewloom_p1_multi.email;
  const multiPassword = fixtures.users.crewloom_p1_multi.password;

  mkdirSync(OUT_DIR, { recursive: true });
  const profileDir = mkdtempSync(join(tmpdir(), 'crewloom-cdp-'));

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      // Chrome 111+ 会拒绝未在白名单内的 WebSocket 调试来源；本地脚本显式放行。
      '--remote-allow-origins=*',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      // 受限沙箱环境下 Chrome 的 crashpad/sandbox 初始化会失败，关闭后仍可正常渲染。
      '--disable-crash-reporter',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-gpu',
      '--hide-scrollbars',
      '--window-size=1440,900',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  chrome.stderr.on('data', () => {});

  let cdp;
  /** 记录浏览器侧传输层证据（真实请求数、拦截数、路径），供 summary/证据文件使用。 */
  let browserTransport = { counts: null, paths: [] };
  try {
    const versionInfo = await waitForDevtools(DEBUG_PORT);
    const wsUrl = versionInfo.webSocketDebuggerUrl ?? `ws://127.0.0.1:${DEBUG_PORT}/devtools/browser`;
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('CDP WebSocket 连接超时')), 20000);
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          res();
        },
        { once: true },
      );
      ws.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          rej(new Error('CDP WebSocket 连接失败'));
        },
        { once: true },
      );
    });
    cdp = new Cdp(ws);

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    cdp.sessionId = sessionId;
    await cdp.send('Page.enable');
    await cdp.send('DOM.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const helpers = createHelpers(cdp, { baseUrl: BASE_URL, outDir: OUT_DIR });

    // 1. 登录页
    await helpers.goto('/login');
    record('登录页可访问', (await helpers.text('h1')).includes('登录'), await helpers.text('h1'));
    await helpers.shot('01-login-desktop.png');

    // 2. 未登录访问受保护 URL
    await helpers.goto('/workflow/list');
    await helpers.sleep(500);
    const redirectUrl = await helpers.eval('location.pathname + location.search');
    record(
      '未登录访问受保护地址跳转登录页并保留站内返回地址',
      redirectUrl.startsWith('/login') && redirectUrl.includes('returnTo'),
      redirectUrl,
    );

    // 3. 错误密码
    await helpers.goto('/login');
    await helpers.typeInto('input[name="crewloom-account"]', adminEmail);
    await helpers.typeInto('input[name="crewloom-secret"]', 'wrong-password-for-check');
    await helpers.click('button[type="submit"]');
    await helpers.waitFor(() => document.querySelector('[role="alert"]')?.textContent ?? '', (t) => t.length > 0);
    const alertText = await helpers.eval('document.querySelector(\'[role="alert"]\')?.textContent ?? ""');
    record(
      '错误密码给出中文提示且不含状态码/英文标识',
      /邮箱、用户名或密码不正确/.test(alertText) && !/401|INVALID|Origin/.test(alertText),
      alertText.trim(),
    );
    await helpers.shot('02-login-error.png');

    // 4. 配置权限用户真实登录
    await helpers.login(adminEmail, adminPassword);
    await helpers.waitFor(() => location.pathname, (p) => p.startsWith('/workbench'), 20000);
    record('配置权限用户登录后进入工作台', (await helpers.eval('location.pathname')).startsWith('/workbench'));
    const adminEmailInPage = adminEmail;
    const devCopyHits = findDeveloperCopy(
      (await helpers.visibleText()).split(adminEmailInPage).join('<账号邮箱>'),
    );
    record(
      '界面可见文案不含开发字样（阶段编号/接口名/内部角色标识/角色模式）',
      devCopyHits.length === 0,
      devCopyHits.join(' | ') || '无',
    );
    await helpers.waitFor(
      () => document.querySelectorAll('aside nav a').length,
      (n) => n >= 7,
      20000,
    );
    const adminModules = await helpers.eval(
      'Array.from(document.querySelectorAll("aside nav a")).map((a) => a.textContent.trim()).join("|")',
    );
    record(
      '导航包含七个模块',
      ['工作台', '数字员工', '任务与待办', '工作流', '数据源', '模型配置', '用户与权限'].every((name) =>
        adminModules.includes(name),
      ),
      adminModules,
    );
    await helpers.shot('03-workbench-admin-desktop.png');

    // 工作台真实数据
    await helpers.gotoReady('/workbench/overview');
    const overviewText = await helpers.text('main');
    record('工作台展示真实账号与角色', overviewText.includes(adminEmail), '包含登录邮箱');
    record(
      '工作台待处理任务按原生契约命名，并在空数据下真实显示 0',
      overviewText.includes('本人工作流待处理任务') &&
        overviewText.includes('待处理任务') &&
        overviewText.includes('涉及流程') &&
        /待处理任务\s*0/.test(overviewText.replace(/\s+/g, ' ')),
      overviewText.replace(/\s+/g, ' ').slice(0, 160),
    );
    record(
      '工作台不把流程标题当作任务标题（说明文字明确）',
      overviewText.includes('不是单条任务的标题') || overviewText.includes('按流程汇总'),
      '按流程汇总说明可见',
    );
    await helpers.shot('04-workbench-overview-desktop.png');

    // 4b. 传输层证据：浏览器实际发出的请求全部在允许清单内
    const transport = await helpers.transportCounts();
    record(
      '浏览器实际传输层：全部请求在允许清单内（无拦截、有真实请求）',
      transport.blocked === 0 && transport.total > 0 && transport.real > 0,
      JSON.stringify(transport),
    );
    const transportPaths = await helpers.transportPaths();
    browserTransport = { counts: transport, paths: transportPaths };
    record(
      '传输层记录的路径全部是已知只读/登录动作（不含写入动作）',
      transportPaths.every((path) => /^\/api\/[a-zA-Z]+(:|$)/.test(path)) &&
        !transportPaths.some((path) => /(create|update|destroy|setup|setDefaultRole|setSystemRoleMode)/.test(path)),
      transportPaths.slice(0, 6).join(' | '),
    );

    // 4c. 七菜单深链回归（配置账号应能进入每个模块）
    const moduleDeepLinks = [
      ['/ai/directory', '员工目录'],
      ['/tasks/pending', '我的待处理'],
      ['/workflow/list', '流程列表'],
      ['/datasource/list', '数据源列表'],
      ['/model/services', '服务列表'],
      ['/access/users', '用户'],
    ];
    const deepLinkResults = [];
    for (const [path, title] of moduleDeepLinks) {
      await helpers.gotoReady(path);
      const text = await helpers.text('main');
      deepLinkResults.push({
        path,
        ok: text.includes(title) && !/无法进入|暂时无法确认/.test(text),
      });
    }
    record(
      '配置账号可深链进入各模块（不出现无权限/无法确认状态）',
      deepLinkResults.every((item) => item.ok),
      deepLinkResults.map((item) => `${item.path}:${item.ok ? 'ok' : 'bad'}`).join(' '),
    );

    // 5. 模块页路由与状态
    await helpers.gotoReady('/workflow/list');
    const workflowText = await helpers.text('main');
    const workflowButtons = await helpers.eval('document.querySelectorAll("main button").length');
    record(
      '工作流模块页只说明用途并标注尚未开放，没有可点击的假操作',
      workflowText.includes('尚未开放') &&
        workflowButtons === 0 &&
        (await helpers.eval('location.pathname')) === '/workflow/list',
      `path=${await helpers.eval('location.pathname')} buttons=${workflowButtons}`,
    );
    await helpers.shot('05-module-workflow-desktop.png');

    // 6. 单角色账号没有可切换项：不渲染空下拉，只显示当前角色标题
    const singleRoleState = await helpers.eval(
      `JSON.stringify({
        hasSelect: !!document.querySelector('select[aria-label="切换当前角色"]'),
        badge: document.querySelector('main')?.textContent?.includes('Crewloom 配置权限') ?? false,
      })`,
    );
    record(
      '单角色账号不显示空角色下拉，并显示自己的角色标题',
      /"hasSelect":false/.test(singleRoleState) && /"badge":true/.test(singleRoleState),
      singleRoleState,
    );

    // 7. 多角色账号：真实切换角色并核对权限收敛
    await helpers.login(multiEmail, multiPassword);
    await helpers.waitFor(() => location.pathname, (p) => p.startsWith('/workbench'), 20000);
    await helpers.waitFor(() => document.querySelectorAll('aside nav a').length, (n) => n >= 7, 20000);
    const multiOptions = await helpers.eval(
      'Array.from(document.querySelectorAll(\'select[aria-label="切换当前角色"] option\')).map((o) => o.textContent.trim()).join("|")',
    );
    record(
      '多角色账号列出自己拥有的全部角色',
      multiOptions.includes('Crewloom 配置权限') && multiOptions.includes('Crewloom 受限用户'),
      multiOptions,
    );

    const roleSwitched = await helpers.selectRole('Crewloom 受限用户');
    await helpers.waitForPermissionsReady();
    const limitedMenu = await helpers.eval(
      'Array.from(document.querySelectorAll("aside nav a")).map((a) => a.textContent.trim()).join("|")',
    );
    const switchState = await helpers.eval(
      `JSON.stringify({ value: document.querySelector('select[aria-label="切换当前角色"]')?.value ?? '', alert: document.querySelector('[role="alert"]')?.textContent ?? '' })`,
    );
    record('角色切换在界面上生效且无错误提示', /"value":"crewloom_p1_limited","alert":""/.test(switchState), switchState);
    // 实测边界：受限角色 = 干净基线（无片段/无策略/无显式授权），
    // 只剩登录态自身能力（自己的会话、待办与可用员工），因此可见工作台、数字员工、任务与待办。
    record(
      '角色切换后导航按新角色的真实权限收敛',
      roleSwitched && limitedMenu === '工作台|数字员工|任务与待办',
      limitedMenu,
    );
    const limitedRoleUi = await helpers.eval(
      `JSON.stringify({
        accessEntryVisible: !!document.querySelector('aside nav a[href="/access"]'),
        bodyHasInternalId: document.body.textContent.includes('crewloom_p1_limited'),
      })`,
    );
    record(
      '角色信息不可读时界面友好降级且不暴露内部标识',
      /"accessEntryVisible":false/.test(limitedRoleUi) && /"bodyHasInternalId":false/.test(limitedRoleUi),
      limitedRoleUi,
    );

    // 受限角色直接访问管理 API：请求显式携带当前会话令牌与当前角色，
    // 并核对后端是"权限拒绝"而不是"未认证"。
    const denial = await helpers.fetchDenial('/api/llmServices:list');
    record(
      '受限角色以当前角色直接请求管理接口被后端按权限拒绝',
      denial.status === 403 && denial.denialKind === 'permission',
      `HTTP ${denial.status} kind=${denial.denialKind} message=${JSON.stringify(denial.message)} role=${denial.role} tokenFromSession=${denial.tokenFromSession}`,
    );
    record(
      '拒绝请求确实携带了受限账号令牌与当前角色（不是未认证的 401）',
      denial.role === 'crewloom_p1_limited' && denial.tokenFromSession === true && denial.roleSent === true,
      `role=${denial.role} roleSent=${denial.roleSent} tokenFromSession=${denial.tokenFromSession} status=${denial.status}`,
    );

    // 受限角色直接访问未授权路由
    await helpers.goto('/model/services');
    await helpers.waitForPermissionsReady();
    await helpers.sleep(300);
    const deniedText = await helpers.text('main');
    record(
      '受限角色直达未授权模块显示明确无权限状态',
      /无法进入|没有访问/.test(deniedText),
      deniedText.slice(0, 80).replace(/\s+/g, ' '),
    );
    await helpers.shot('06-module-denied-limited-desktop.png');

    // 受限角色深链：只有真实有权限的模块可进入，其余应为"明确无权限"而不是"暂时无法确认"
    const limitedDeepLinks = [
      { path: '/ai/directory', expect: 'allowed' },
      { path: '/tasks/pending', expect: 'allowed' },
      { path: '/workflow/list', expect: 'denied' },
      { path: '/datasource/list', expect: 'denied' },
      { path: '/model/services', expect: 'denied' },
      { path: '/access/users', expect: 'denied' },
    ];
    const limitedResults = [];
    for (const item of limitedDeepLinks) {
      await helpers.gotoReady(item.path);
      const text = await helpers.text('main');
      const denied = /无法进入|没有访问/.test(text);
      const unknown = /暂时无法确认/.test(text);
      limitedResults.push({
        path: item.path,
        expect: item.expect,
        denied,
        unknown,
        ok: item.expect === 'denied' ? denied && !unknown : !denied && !unknown,
      });
    }
    browserTransport = {
      counts: await helpers.transportCounts(),
      paths: await helpers.transportPaths(),
    };
    record(
      '受限角色深链：授权模块可进入，未授权模块是明确无权限（不是无法确认）',
      limitedResults.every((item) => item.ok),
      limitedResults.map((item) => `${item.path}:${item.ok ? 'ok' : `denied=${item.denied},unknown=${item.unknown}`}`).join(' '),
    );

    // 7b. 关键验收场景：配置角色 → 受限角色 → 刷新 → 仍受限且能切回自己的配置角色
    await helpers.gotoReady('/workbench/overview');
    const beforeReload = await helpers.roleSwitcherState();
    record(
      '切换到受限角色后仍保有自己全部角色的候选',
      beforeReload.value === 'crewloom_p1_limited' && beforeReload.options.length === 2,
      JSON.stringify(beforeReload),
    );

    await helpers.reload();
    await helpers.waitForPermissionsReady();
    const afterReload = await helpers.roleSwitcherState();
    const afterReloadMenu = await helpers.eval(
      'Array.from(document.querySelectorAll("aside nav a")).map((a) => a.textContent.trim()).join("|")',
    );
    record(
      '刷新后仍停留在受限角色（不会自动升权）',
      afterReload.value === 'crewloom_p1_limited' && afterReloadMenu === '工作台|数字员工|任务与待办',
      `value=${afterReload.value} menu=${afterReloadMenu}`,
    );
    record(
      '刷新后角色候选仍然完整（全新的页面加载，不是内存缓存）',
      afterReload.options.length === 2 &&
        afterReload.options.includes('Crewloom 配置权限') &&
        afterReload.options.includes('Crewloom 受限用户'),
      JSON.stringify(afterReload.options),
    );
    await helpers.shot('13-limited-after-reload-desktop.png');

    const switchedBack = await helpers.selectRole('Crewloom 配置权限');
    await helpers.waitFor(
      () => document.querySelectorAll('aside nav a').length,
      (n) => n === 7,
      25000,
    );
    record(
      '刷新后可以从受限角色切回自己的配置角色',
      switchedBack === true && (await helpers.eval('document.querySelectorAll("aside nav a").length')) === 7,
    );
    await helpers.shot('14-switched-back-desktop.png');


    // 8. 退出清理
    await helpers.clickText('button', '退出');
    await helpers.waitFor(() => location.pathname, (p) => p.startsWith('/login'));
    const afterLogout = await helpers.eval('location.pathname');
    const tokenCleared = await helpers.eval(
      'window.localStorage.getItem("crewloom.session.token") === null',
    );
    record('退出后回到登录页并清空本地令牌', afterLogout.startsWith('/login') && tokenCleared === true, afterLogout);

    // 9. 受限用户登录（桌面 + 窄屏）
    await helpers.login(limitedEmail, limitedPassword);
    await helpers.waitFor(() => location.pathname, (p) => p.startsWith('/workbench'), 20000);
    await helpers.waitForPermissionsReady();
    await helpers.sleep(500);
    const limitedLoginMenu = await helpers.eval(
      'Array.from(document.querySelectorAll("aside nav a")).map((a) => a.textContent.trim()).join("|")',
    );
    record(
      '受限用户登录后只显示其真实有权限的模块',
      limitedLoginMenu === '工作台|数字员工|任务与待办',
      limitedLoginMenu,
    );
    await helpers.shot('07-workbench-limited-desktop.png');
    await helpers.gotoReady('/workbench/overview');
    await helpers.shot('08-workbench-limited-overview-desktop.png');

    // 10. 窄屏 390：出现导航开关、抽屉可开可关、无横向溢出
    await helpers.setViewport(390, 844);
    await helpers.gotoReady('/workbench/overview');
    record('窄屏下出现导航开关', await helpers.eval('!!document.querySelector(\'button[aria-label="展开导航"]\')'));
    const overflow390 = await helpers.overflowReport();
    record(
      '390 宽度下页面没有横向溢出',
      overflow390.scrollWidth <= overflow390.innerWidth + 1 && overflow390.widest === null,
      JSON.stringify(overflow390),
    );
    await helpers.shot('09-workbench-limited-narrow.png');

    // 抽屉：显式关闭按钮存在、背景不透明、Escape 关闭并把焦点还给触发按钮
    await helpers.clickText('button', '导航');
    await helpers.sleep(400);
    const drawerState = await helpers.drawerState();
    record(
      '抽屉有显式关闭按钮且背景不透明',
      drawerState.closeButtonVisible === true && drawerState.sidebarBackgroundAlpha >= 0.95,
      JSON.stringify(drawerState),
    );
    await helpers.shot('10-narrow-drawer-open.png');
    const focusedInside = await helpers.eval(
      'document.activeElement?.getAttribute("aria-label") ?? ""',
    );
    record('打开抽屉后焦点进入抽屉内部', focusedInside === '收起导航', focusedInside);

    await helpers.pressKey('Escape', 'Escape', 27);
    await helpers.sleep(400);
    const afterEscape = await helpers.eval(
      `JSON.stringify({
        drawerOpen: !!document.querySelector('aside') && document.querySelector('aside').getBoundingClientRect().left >= 0,
        focusLabel: document.activeElement?.getAttribute('aria-label') ?? '',
      })`,
    );
    record(
      'Escape 关闭抽屉并把焦点交还给导航按钮',
      /"drawerOpen":false/.test(afterEscape) && /"focusLabel":"展开导航"/.test(afterEscape),
      afterEscape,
    );

    // 背景点击关闭
    await helpers.clickText('button', '导航');
    await helpers.sleep(350);
    await helpers.closeDrawerByBackdrop();
    await helpers.sleep(350);
    const afterBackdrop = await helpers.eval(
      `!!document.querySelector('button[aria-label="展开导航"]') && document.querySelector('aside').getBoundingClientRect().left < 0`,
    );
    record('点击抽屉背景可关闭抽屉', afterBackdrop === true);

    // 320 宽度：长内容不溢出
    await helpers.setViewport(320, 720);
    await helpers.gotoReady('/workbench/overview');
    const overflow320 = await helpers.overflowReport();
    record(
      '320 宽度下页面没有横向溢出',
      overflow320.scrollWidth <= overflow320.innerWidth + 1 && overflow320.widest === null,
      JSON.stringify(overflow320),
    );
    await helpers.shot('11-workbench-narrow-320.png');
    await helpers.gotoReady('/workflow/list');
    const overflow320Module = await helpers.overflowReport();
    record(
      '320 宽度下模块页也没有横向溢出',
      overflow320Module.scrollWidth <= overflow320Module.innerWidth + 1 && overflow320Module.widest === null,
      JSON.stringify(overflow320Module),
    );
    await helpers.setViewport(null);

    // 12. 登录页窄屏
    await helpers.clickText('button', '退出');
    await helpers.sleep(600);
    await helpers.setViewport(390, 844);
    await helpers.goto('/login');
    await helpers.sleep(400);
    const overflowLogin = await helpers.overflowReport();
    record(
      '390 宽度下登录页没有横向溢出',
      overflowLogin.scrollWidth <= overflowLogin.innerWidth + 1 && overflowLogin.widest === null,
      JSON.stringify(overflowLogin),
    );
    await helpers.shot('12-login-narrow.png');
    await helpers.setViewport(null);
  } finally {
    try {
      if (cdp) await cdp.send('Browser.close');
    } catch {
      /* 忽略关闭异常 */
    }
    chrome.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      /* 临时目录清理失败不影响结论 */
    }
  }

  const failed = results.filter((item) => !item.ok);
  const summary = {
    baseUrl: BASE_URL,
    outDir: OUT_DIR,
    finishedAt: new Date().toISOString(),
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    browserTransport,
    results,
  };
  writeFileSync(join(OUT_DIR, 'browser-check.json'), JSON.stringify(summary, null, 2));
  console.log(`\n浏览器验收：${summary.passed}/${summary.total} 通过；截图目录 ${OUT_DIR}`);
  if (failed.length > 0) process.exitCode = 1;
}

function createHelpers(cdp, { baseUrl, outDir }) {
  const screenshot = async (name) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(join(outDir, name), Buffer.from(data, 'base64'));
    return name;
  };

  const evaluate = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`页面脚本异常：${result.exceptionDetails.text}`);
    }
    return result.result.value;
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 设置视口；传入 null 清除模拟。 */
  const setViewport = async (width, height, deviceScaleFactor = 2) => {
    if (width === null) {
      await cdp.send('Emulation.clearDeviceMetricsOverride');
      return;
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor,
      mobile: true,
    });
  };

  /** 横向溢出报告：文档宽度、窗口宽度，以及最宽的具体元素（如有）。 */
  const overflowReport = async () =>
    evaluate(`(() => {
      const innerWidth = window.innerWidth;
      const scrollWidth = document.documentElement.scrollWidth;
      let widest = null;
      if (scrollWidth > innerWidth + 1) {
        let worst = innerWidth;
        for (const el of document.querySelectorAll('body *')) {
          const rect = el.getBoundingClientRect();
          if (rect.width > worst) {
            worst = rect.width;
            widest = (el.tagName.toLowerCase() + '.' + (el.className || '')).slice(0, 60);
          }
        }
      }
      return { innerWidth, scrollWidth, widest };
    })()`);

  /** 抽屉状态：关闭按钮是否可见、侧栏背景是否不透明。 */
  const drawerState = async () =>
    evaluate(`(() => {
      const sidebar = document.querySelector('aside');
      const close = document.querySelector('button[aria-label="收起导航"]');
      let alpha = 1;
      if (sidebar) {
        const bg = getComputedStyle(sidebar).backgroundColor;
        const match = bg.match(/rgba?\(([^)]+)\)/);
        if (match) {
          const parts = match[1].split(',').map((v) => Number(v.trim()));
          alpha = parts.length === 4 ? parts[3] : 1;
        }
      }
      return {
        closeButtonVisible: !!close && close.getBoundingClientRect().width > 0,
        sidebarBackgroundAlpha: alpha,
      };
    })()`);

  const closeDrawerByBackdrop = async () => {
    const ok = await evaluate(`(() => {
      const backdrop = document.querySelector('div[aria-hidden="true"]');
      if (!backdrop) return false;
      const rect = backdrop.getBoundingClientRect();
      backdrop.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        clientX: rect.width - 4,
        clientY: rect.height / 2,
      }));
      return true;
    })()`);
    if (!ok) throw new Error('未找到抽屉背景');
  };

  /** 读取角色切换控件状态（当前值 + 候选标签）。 */
  const roleSwitcherState = async () =>
    evaluate(`(() => {
      const select = document.querySelector('select[aria-label="切换当前角色"]');
      return {
        hasSelect: !!select,
        value: select ? select.value : '',
        options: select ? Array.from(select.options).map((o) => o.textContent.trim()) : [],
      };
    })()`);

  /** 可见文案：取回全文，由 Node 侧做模式匹配（避免在页面里塞复杂正则）。 */
  const visibleText = async () => evaluate(`(document.body.innerText || '')`);

  /** 浏览器侧传输层记录（只含 method/path/status/真实或受控，不含凭据）。 */
  const transportCounts = async () =>
    evaluate(`JSON.stringify(window.__CREWLOOM_TRANSPORT__?.counts ?? null)`).then((raw) => JSON.parse(raw));

  const transportPaths = async () =>
    evaluate(
      `JSON.stringify((window.__CREWLOOM_TRANSPORT__?.entries ?? []).map((entry) => entry.path))`,
    ).then((raw) => JSON.parse(raw));

  const goto = async (path) => {
    await cdp.send('Page.navigate', { url: `${baseUrl}${path}` });
    await sleep(500);
    await waitFor(
      () => document.querySelectorAll('#root *').length,
      (n) => n > 0,
      15000,
    );
    await sleep(200);
  };

  const reload = async () => {
    await cdp.send('Page.reload', { ignoreCache: false });
    await sleep(900);
  };

  const waitFor = async (fn, predicate, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = await evaluate(`(${fn.toString()})()`);
      if (predicate(last)) return last;
      await sleep(200);
    }
    throw new Error(`等待条件超时，最后取值：${JSON.stringify(last)}`);
  };

  const selectorLiteral = (selector) => JSON.stringify(selector);

  /** 取得元素中心坐标（用于真实鼠标事件）；元素尚未渲染时短暂重试。 */
  const centerOf = async (selector, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
        const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
        if (nodeId) {
          const { model } = await cdp.send('DOM.getBoxModel', { nodeId });
          if (model?.content) {
            const [x1, y1, , , x2, y2] = model.content;
            return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
          }
        }
      } catch {
        /* 页面切换过程中可能出现瞬时错误，继续重试 */
      }
      await sleep(200);
    }
    return null;
  };

  const mouseClickAt = async ({ x, y }) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };

  const pressKey = async (key, code, vk) => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
  };

  /** 真实聚焦 + 逐字符输入（先按键清空，避免浏览器自动填充残留）。 */
  const typeInto = async (selector, value) => {
    const center = await centerOf(selector);
    if (!center) throw new Error(`未找到输入框：${selector}`);
    await mouseClickAt(center);
    // 关闭自动填充下拉，避免残留在同一个输入框上干扰后续登录。
    await pressKey('Escape', 'Escape', 27);
    const currentLength = await evaluate(
      `document.querySelector(${selectorLiteral(selector)})?.value?.length ?? 0`,
    );
    for (let i = 0; i < currentLength + 2; i += 1) {
      await pressKey('Backspace', 'Backspace', 8);
    }
    for (const char of value) {
      await cdp.send('Input.insertText', { text: char });
    }
    const typed = await evaluate(
      `document.querySelector(${selectorLiteral(selector)})?.value?.length ?? -1`,
    );
    if (typed !== value.length) throw new Error(`输入长度不符：期望 ${value.length}，实际 ${typed}`);
  };

  const click = async (selector) => {
    const center = await centerOf(selector);
    if (center) {
      await mouseClickAt(center);
      return;
    }
    const ok = await evaluate(`(() => {
      const el = document.querySelector(${selectorLiteral(selector)});
      if (!el) return false;
      el.click();
      return true;
    })()`);
    if (!ok) throw new Error(`未找到可点击元素：${selector}`);
  };

  const clickText = async (selector, text) => {
    const located = await evaluate(`(() => {
      const nodes = Array.from(document.querySelectorAll(${selectorLiteral(selector)}));
      const el = nodes.find((n) => (n.textContent ?? '').trim().includes(${JSON.stringify(text)}));
      if (!el) return false;
      el.setAttribute('data-crewloom-test-target', '1');
      return true;
    })()`);
    if (!located) throw new Error(`未找到包含「${text}」的 ${selector}`);
    await click('[data-crewloom-test-target="1"]');
  };

  /** 导航到站内地址并等待应用完成会话恢复与权限确认。 */
  const gotoReady = async (path) => {
    await goto(path);
    await waitForPermissionsReady();
    await sleep(250);
  };

  /** 等待"权限确认完成"（侧栏提示从"正在确认可用模块…"变为稳定文案）。 */
  const waitForPermissionsReady = async (timeoutMs = 25000) => {
    await waitFor(
      () => (document.querySelector('aside')?.textContent ?? ''),
      (value) => value.includes('这里只显示你可以使用的模块'),
      timeoutMs,
    );
  };

  const text = async (selector) =>
    evaluate(`document.querySelector(${selectorLiteral(selector)})?.textContent ?? ""`);

  /**
   * 切换角色。
   *
   * headless Chrome 中 CDP 的鼠标/键盘事件不会真正展开原生 select 弹层，
   * 因此这里分两步：
   *  1. 真实鼠标点击 select 元素，确认它可交互；
   *  2. 通过原生 value setter + input/change 事件触发 React 的 onChange，
   *     这正是浏览器对用户选择项所做的事，等价于用户在下拉里选中该项。
   */
  const selectRole = async (label) => {
    const selector = 'select[aria-label="切换当前角色"]';
    const center = await centerOf(selector);
    if (!center) return false;
    await mouseClickAt(center);

    const result = await evaluate(`(() => {
      const select = document.querySelector(${selectorLiteral(selector)});
      if (!select) return 'no-select';
      const option = Array.from(select.options).find((o) => o.textContent.includes(${JSON.stringify(label)}));
      if (!option) return 'no-option';
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(select, option.value);
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return option.value;
    })()`);
    if (result === 'no-select' || result === 'no-option') return false;
    // 等待 React 应用新值（角色切换请求 + 重渲染），避免读取时机造成假失败。
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const applied = await evaluate(`document.querySelector(${selectorLiteral(selector)})?.value ?? ''`);
      if (applied === result) return true;
      await sleep(150);
    }
    return false;
  };

  /** 模拟全新浏览器会话：清空本地存储后重新加载。 */
  const newBrowserSession = async () => {
    await evaluate('window.localStorage.clear()');
    await reload();
    await goto('/login');
  };

  const login = async (email, password) => {
    await newBrowserSession();
    await typeInto('input[name="crewloom-account"]', email);
    await typeInto('input[name="crewloom-secret"]', password);
    await click('button[type="submit"]');
    await sleep(1200);
  };

  /**
   * 从页面上下文发起请求并区分"未认证"与"无权限"。
   *
   * 请求显式携带：当前界面选择的角色（X-Role）、当前会话令牌（Authorization，取自会话存储）、
   * 认证方式头（X-Authenticator），并回读后端返回的错误码，避免把 401 未认证误当成角色权限拒绝。
   */
  const fetchDenial = async (path) => {
    return evaluate(`(async () => {
      const roleSelect = document.querySelector('select[aria-label="切换当前角色"]');
      const storedRole = window.localStorage.getItem('crewloom.session.role') || '';
      const role = roleSelect ? roleSelect.value : storedRole;
      const token = window.localStorage.getItem('crewloom.session.token') || '';
      const headers = { 'X-Authenticator': 'basic' };
      const roleSent = token.length > 0 && role.length > 0;
      if (role) headers['X-Role'] = role;
      if (token) headers.Authorization = 'Bearer ' + token;
      const response = await fetch(${JSON.stringify(path)}, { headers });
      let body = null;
      try { body = await response.json(); } catch (e) { body = null; }
      const errorEntry = body && Array.isArray(body.errors) ? body.errors[0] : null;
      const code = errorEntry ? (errorEntry.code || errorEntry.message || '') : '';
      const kind = response.status === 403 ? 'permission' : response.status === 401 ? 'unauthenticated' : 'other';
      return {
        status: response.status,
        code,
        denialKind: kind,
        message: errorEntry ? errorEntry.message : '',
        role,
        roleSent,
        tokenFromSession: token.length > 0,
      };
    })()`);
  };

  return {
    shot: screenshot,
    eval: evaluate,
    sleep,
    goto,
    reload,
    waitFor,
    typeInto,
    pressKey,
    click,
    clickText,
    text,
    selectRole,
    login,
    fetchDenial,
    setViewport,
    overflowReport,
    drawerState,
    closeDrawerByBackdrop,
    visibleText,
    transportCounts,
    transportPaths,
    waitForPermissionsReady,
    gotoReady,
    roleSwitcherState,
  };
}

await main();
