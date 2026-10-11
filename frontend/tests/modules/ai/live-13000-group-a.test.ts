import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  api,
  getHttpClient,
  getTransportCounts,
  setApiBase,
  setAuthContext,
} from '../../../src/api/client';
import { getTransportLog, installTransportGuard } from '../../../src/api/transportGuard';
import {
  getAiSettings,
  listProviders,
  listServicesMasked,
} from '../../../src/modules/model/resources';
import { getServiceRaw } from '../../../src/modules/model/resources';
import { normalizeEnabledModels } from '../../../src/modules/model/types';
import { PROVIDERS } from '../../../src/modules/model/providers';
import {
  getConversation,
  getEmployee,
  listContextDatasources,
  listConversations,
  listEmployees,
  listMcpClients,
  listSkills,
  listTools,
  listUsableEmployees,
  loadConversationMessages,
  previewContextDatasource,
  resolveAllowedModels,
} from '../../../src/modules/ai/resources';
import { readAction } from '../../../src/modules/ai/read-action';
import { CrewloomError } from '../../../src/api/errors';

/**
 * 组 A 对 **13000（NocoBase 2.2.20）** 的真实只读联调。
 *
 * 边界（严格遵守本任务的外部写限制）：
 *  - 只调用只读动作（GET）；写动作只有正常登录 / 退出（POST auth:signIn / auth:signOut）；
 *  - **不**调用任何会外呼或产生费用的动作：
 *    `ai:listModels` / `ai:listProviderModels` / `ai:testFlight` /
 *    `aiMcpClients:testConnection|listTools|rebuildClient|updateToolPermission` /
 *    `aiConversations:sendMessages|resendMessages|resumeStream|abort|resumeToolCall`；
 *  - `aiConversations:getMessages` **一律显式传 `updateRead=false`**：服务端只有收到 `'true'`/`true`
 *    才会把会话标记为已读（`server/resource/aiConversations.ts:284`），显式 false 不依赖默认值；
 *    同时测试内装一道请求拦截器，缺参数或 `true` 的 `getMessages` 直接拦下、不发真实请求；
 *  - 不创建 / 修改 / 删除任何记录，不发空体或非法写探针，不 SSH、不装插件；
 *  - 传输层用 strict 模式：即使将来误加了写动作，也会在发出前被拦下并计数。
 *
 * 凭据只在进程内存里从主工作区的 `.secrets/full-pages-13000-20261011.json`（0600）读取，
 * **不拷贝、不打印**。可用 `CREWLOOM_13000_SECRET` 显式指定路径。
 * 缺少凭据或后端不可达时整体跳过。
 */

const SECRET_CANDIDATES = [
  process.env.CREWLOOM_13000_SECRET,
  // 主工作区直接运行：<repo>/frontend → ../.secrets
  resolve(process.cwd(), '../.secrets/full-pages-13000-20261011.json'),
  // 本任务在 `<repo>/.worktrees/<name>/frontend` 下运行：主工作区的 .secrets 在 `<repo>/.secrets`。
  resolve(process.cwd(), '../../../.secrets/full-pages-13000-20261011.json'),
].filter((item): item is string => typeof item === 'string' && item.length > 0);

interface SecretFile {
  apiBaseURL: string;
  email: string;
  password: string;
}

function readSecret(): SecretFile | null {
  for (const candidate of SECRET_CANDIDATES) {
    if (!existsSync(candidate)) continue;
    try {
      return JSON.parse(readFileSync(candidate, 'utf8')) as SecretFile;
    } catch {
      return null;
    }
  }
  return null;
}

const secrets = readSecret();
const ORIGIN = (() => {
  const raw = String(secrets?.apiBaseURL ?? 'http://172.16.88.250:13000/api').replace(/\/+$/, '');
  return raw.endsWith('/api') ? raw.slice(0, -'/api'.length) : raw;
})();

async function reachable(): Promise<boolean> {
  try {
    const response = await fetch(`${ORIGIN}/api/authenticators:publicList`, { signal: AbortSignal.timeout(5000) });
    return response.ok;
  } catch {
    return false;
  }
}

const enabled = secrets !== null && (await reachable());
const suite = enabled ? describe : describe.skip;

/**
 * 把产品请求层指向 13000，并安装严格模式 + 只允许该来源的守卫。
 *
 * `adapter: 'http'`：测试跑在 jsdom 下（需要它的 localStorage 让 SDK 的
 * `CrewloomSessionStorage` 正常读写令牌），但 jsdom 的 XHR 会按规范补上
 * `Origin: http://localhost:3000`，后端会以"不可信登录来源"拒绝正常登录。
 * 因此这里显式改用 axios 的 Node http adapter——请求仍走同一条 SDK 管线
 * （Auth 头、传输策略、续期拦截器全部生效），只是传输实现不带浏览器 Origin。
 * 真实产品在浏览器里走 Vite 代理，由代理移除 Origin（见 vite.config.ts）。
 */
/**
 * `getMessages` 参数审计（本轮只读边界的第二道守卫）。
 *
 * 只记录 `updateRead` 的取值 —— **不记录** sessionId、消息体、响应正文或任何账号信息。
 * 取值不是字符串 `'false'`（即缺参数或 `true`）时直接拦下，请求不会发出。
 */
const messageReadParams: unknown[] = [];
let blockedMessageReadRequests = 0;

/** 真实历史响应结构（只记结构：是否数组、顶层键、rows 条数），以及归一化后的条数。 */
let historyShape: { payloadIsArray: boolean; payloadKeys: string[]; rowsLength: number; nestedDataIsArray: boolean } | null =
  null;
let historyMessageCount = 0;
let firstMessageKeys: string[] = [];
let firstContentKeys: string[] = [];
let previewDenied = false;
let previewRowCount = 0;

function installGetMessagesAudit(): () => void {
  const id = getHttpClient().interceptors.request.use((config) => {
    if (String(config.url ?? '').includes('aiConversations:getMessages')) {
      const params = (config.params ?? {}) as Record<string, unknown>;
      messageReadParams.push(params.updateRead);
      if (params.updateRead !== 'false') {
        blockedMessageReadRequests += 1;
        const error = new Error('getMessages 必须显式 updateRead=false');
        (error as unknown as { code: string }).code = 'TRANSPORT_BLOCKED';
        throw error;
      }
    }
    return config;
  });
  return () => getHttpClient().interceptors.request.eject(id);
}

function setupStrictClient(): void {
  setApiBase(`${ORIGIN}/api`);
  installTransportGuard(getHttpClient(), {
    baseURL: `${ORIGIN}/api`,
    originBase: ORIGIN,
    allowedOrigins: [ORIGIN],
    mode: 'strict',
  });
  getHttpClient().defaults.adapter = 'http';
}

suite('组 A · 13000 真实只读联调（strict 传输层）', () => {
  it('登录 → AI/LM 全部只读契约 → 退出撤销；全程零拦截、零写入', async () => {
    setupStrictClient();
    const ejectGetMessagesAudit = installGetMessagesAudit();

    const signIn = await api.request<{ token?: string }>({
      url: 'auth:signIn',
      method: 'post',
      data: { email: secrets!.email, password: secrets!.password },
    });
    const token = (signIn.data as { token?: string } | null)?.token;
    expect(typeof token).toBe('string');
    setAuthContext({ token: token as string, role: null, authenticator: 'basic' });

    /* ---------------- AI-01 员工目录：可使用 / 可管理 两条列表 + 详情 ---------------- */
    const usable = await listUsableEmployees({ page: 1, pageSize: 5 });
    expect(usable.rows.length).toBeGreaterThan(0);
    const managed = await listEmployees({ page: 1, pageSize: 5 });
    expect(managed.rows.length).toBeGreaterThan(0);
    const username = String(usable.rows[0].username);
    const employee = await getEmployee(username);
    expect(employee?.username).toBe(username);
    // 专用模型允许集解析（AI-02 / LM-04 共用语义）。
    const allowed = resolveAllowedModels(employee);
    expect(typeof allowed.enforced).toBe('boolean');

    /* ---------------- AI-01 两条列表的筛选/分页能力差异（实测，不假设） ---------------- */
    // (a) `listByUser` 是**自定义动作**：忽略 page/pageSize/filter，整体返回。
    //     界面因此对「可使用」页签用本地过滤，并且不显示会骗人的分页控件。
    const usablePaged = await listUsableEmployees({ page: 1, pageSize: 1 });
    expect(usablePaged.rows.length).toBe(usable.rows.length);
    const usableFiltered = await listUsableEmployees({ page: 1, pageSize: 5, filter: { username: { $eq: '__no_such_employee__' } } });
    expect(usableFiltered.rows.length).toBe(usable.rows.length);

    // (b) `aiEmployees:list` 是标准集合 list 动作：page/pageSize/filter 都由后端生效。
    const keyword = String(usable.rows[0].username).slice(0, 2);
    const filteredManaged = await listEmployees({
      page: 1,
      pageSize: 3,
      filter: {
        $or: [
          { username: { $includes: keyword } },
          { nickname: { $includes: keyword } },
          { position: { $includes: keyword } },
        ],
      },
    });
    expect(filteredManaged.rows.length).toBeLessThanOrEqual(3);
    // 命中的行必须真的包含关键词（避免"过滤参数被忽略"的假通过）。
    for (const row of filteredManaged.rows) {
      const text = `${row.username ?? ''} ${row.nickname ?? ''} ${row.position ?? ''}`.toLowerCase();
      expect(text).toContain(keyword.toLowerCase());
    }

    /* ---------------- AI-05 工具 / 技能 / 员工绑定 ---------------- */
    const tools = await listTools({});
    expect(tools.rows.length).toBeGreaterThan(0);
    const skills = await listSkills({});
    expect(Array.isArray(skills.rows)).toBe(true);
    const binding = await readAction<Array<Record<string, unknown>>>('aiTools', 'listBinding', { username });
    expect(Array.isArray(binding.data)).toBe(true);

    /* ---------------- AI-03 会话：列表 / 详情 / 历史（一律显式 updateRead=false） ---------------- */
    const conversations = await listConversations({ page: 1, pageSize: 5, sort: ['-updatedAt'] });
    for (const row of conversations.rows) {
      // D1：列表项没有 id，标识是 sessionId。
      expect(typeof row.sessionId).toBe('string');
      expect((row as Record<string, unknown>).id).toBeUndefined();
    }
    if (conversations.rows.length > 0) {
      const sessionId = conversations.rows[0].sessionId;
      const conversation = await getConversation(sessionId);
      expect(conversation?.sessionId).toBe(sessionId);
      // 真实响应形态（只记录结构，不记录消息内容）：服务端 manager 返回 `{rows, hasMore, cursor}`，
      // 而原生 v2 客户端按"data 是消息数组"读取。这里把两种形态都记下来，避免"只认 rows" 的假设。
      const raw = await readAction<unknown>('aiConversations', 'getMessages', {
        sessionId,
        paginate: 'false',
        updateRead: 'false',
      });
      const rawPayload = raw.data as Record<string, unknown> | undefined;
      historyShape = {
        payloadIsArray: Array.isArray(rawPayload),
        payloadKeys: rawPayload && !Array.isArray(rawPayload) ? Object.keys(rawPayload) : [],
        rowsLength: Array.isArray((rawPayload as { rows?: unknown[] } | undefined)?.rows)
          ? ((rawPayload as { rows: unknown[] }).rows.length as number)
          : 0,
        nestedDataIsArray: Array.isArray((rawPayload as { data?: unknown } | undefined)?.data),
      };
      const history = await loadConversationMessages(sessionId, { paginate: false });
      historyMessageCount = history.rows.length;
      for (const message of history.rows) {
        // 真实历史项是 provider 解析后的消息对象：`role` + `content`（messageId 在 content 里），
        // 不是裸的数据库行。这里记录结构，避免再次用错误的字段假设。
        expect(typeof (message as { role?: unknown }).role).toBe('string');
        const content = (message as { content?: Record<string, unknown> }).content;
        if (content && typeof content === 'object') {
          firstMessageKeys = Object.keys(message as Record<string, unknown>);
          firstContentKeys = Object.keys(content);
        }
      }
      // 会话列表的标题筛选（页面里用的是同一个形状）：只读 GET，必须 200 且返回数组。
      const title = String(conversations.rows[0].title ?? '').slice(0, 2);
      if (title.length > 0) {
        const filteredConversations = await listConversations({
          page: 1,
          pageSize: 5,
          filter: { title: { $includes: title } },
        });
        expect(Array.isArray(filteredConversations.rows)).toBe(true);
        for (const row of filteredConversations.rows) {
          expect(String(row.title ?? '')).toContain(title);
        }
      }
    }

    /* ---------------- AI-04 上下文数据源：列表（strict 只读） ---------------- */
    const contexts = await listContextDatasources({ pageSize: 5 });
    expect(Array.isArray(contexts.rows)).toBe(true);

    /*
     * AI-04 预览的真实契约是 **POST + 查询体**：服务端动作读 `ctx.action.params.values`
     * （`server/resource/aiContextDatasources.ts`），而 core/resourcer 只在**请求体**里填 `values`
     * （GET 得到 `{}` → 静默返回空预览）。本轮把 `aiContextDatasources:preview` 登记为
     * `readPostActions`，并加了"查询体校验"（`src/api/policy.ts:validatePreviewQueryBody`）：
     * 只有 `datasource`/`collectionName` 等查询字段、且没有 update/destroy 之类键的 POST 才放行。
     *
     * 因此这里断言两件事：
     *  (a) 合法查询体在 strict 下**真实发出**（POST，不再被 action-not-allowlisted 拦下），
     *      且结果形状可区分"服务器没有数据"与"权限不足"（空结果/403 分别分类，不伪装成 []）；
     *  (b) 非法查询体（缺 collectionName）在发出前被拦下 —— 这条 HTTP 请求不会产生任何流量。
     */
    let previewResult: Awaited<ReturnType<typeof previewContextDatasource>> | null = null;
    let previewError: unknown = null;
    try {
      previewResult = await previewContextDatasource({
        datasource: 'main',
        collectionName: '__strict_probe__',
        filter: null,
      });
    } catch (error) {
      previewError = error;
    }
    const previewLog = getTransportLog().filter((entry) => entry.action === 'aiContextDatasources:preview');
    expect(previewLog.length).toBe(1);
    expect(previewLog[0]).toMatchObject({ method: 'post', decision: 'allowed' });
    if (previewError) {
      // 403/无权限时如实分类为 denied，不把"没有权限"当成"服务器返回空数组"。
      expect(previewError).toBeInstanceOf(CrewloomError);
      expect((previewError as CrewloomError).kind).toBe('forbidden');
      previewDenied = true;
    } else {
      expect(previewResult).not.toBeNull();
      expect(Array.isArray(previewResult?.rows)).toBe(true);
      previewRowCount = previewResult?.rows.length ?? 0;
    }

    // 非法查询体：strict 在**请求发出前**拦下（不会真的 POST 到真实后端）。
    const invalidPreviewError = await api
      .resourceAction('aiContextDatasources', 'preview', { values: { datasource: 'main' } })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(invalidPreviewError).not.toBeNull();
    expect(getTransportLog().some((entry) => entry.action === 'aiContextDatasources:preview' && entry.decision === 'blocked')).toBe(
      true,
    );

    /* ---------------- AI-05 MCP：列表（当前可能为空 = 配置为空，不是功能缺失） ---------------- */
    const mcp = await listMcpClients({ pageSize: 5 });
    expect(Array.isArray(mcp.rows)).toBe(true);

    /* ---------------- LM-01 脱敏服务列表：不含 options ---------------- */
    const masked = await listServicesMasked({ pageSize: 20 });
    expect(masked.rows.length).toBeGreaterThan(0);
    for (const row of masked.rows) {
      // 后端脱敏入口必须剔除 options（否则不得用于普通用户展示）。
      expect(Object.keys(row)).not.toContain('options');
    }

    /* ---------------- LM-02 管理编辑读取明文 options（只断言存在，不打印） ---------------- */
    const serviceName = String(masked.rows[0].name);
    const raw = await getServiceRaw(serviceName);
    expect(raw?.name).toBe(serviceName);
    expect(raw?.options === null || typeof raw?.options === 'object').toBe(true);
    // enabledModels 形状兼容（对象 / 数组都能归一）。
    const normalized = normalizeEnabledModels(raw?.enabledModels);
    expect(['recommended', 'custom', 'legacy-array', 'unset']).toContain(normalized.mode);

    /* ---------------- LM-02 13 个服务提供方 ---------------- */
    const providers = await listProviders();
    const providerNames = providers.map((provider) => String(provider.name)).sort();
    expect(providerNames).toContain('deepseek');
    // 固定源码注册的 13 个提供方应全部在后端注册表中（不按名字硬编码数量，但断言集合覆盖）。
    for (const provider of PROVIDERS) {
      expect(providerNames).toContain(provider.name);
    }

    /* ---------------- LM-04 默认设置（当前为 null：只说明现在未配置） ---------------- */
    const settings = await getAiSettings();
    expect(settings).toHaveProperty('defaultLLMService');
    expect(settings).toHaveProperty('defaultModel');

    /* ---------------- AI-06 知识库能力核实：本实例没有相关集合 ---------------- */
    const collections = await readAction<Array<Record<string, unknown>>>('collections', 'list', { pageSize: 400 });
    const names = (Array.isArray(collections.data) ? collections.data : [])
      .map((row) => String(row.name ?? '').toLowerCase())
      .filter((name) => name.length > 0);
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => name.includes('knowledge'))).toHaveLength(0);

    /* ---------------- 退出并确认令牌已撤销 ---------------- */
    await api.request({ url: 'auth:signOut', method: 'post', data: {} });
    setAuthContext({ token: null, role: null, authenticator: null });
    await expect(api.request({ url: 'auth:check', method: 'get' })).rejects.toBeInstanceOf(CrewloomError);

    // strict 模式下**唯一**被拦截的请求必须是上面那条故意触发的非法预览探针：
    // 它证明"查询体校验"真的在请求发出前生效（而不是放行任意 POST）。
    const counts = getTransportCounts();
    const log = getTransportLog();
    const blockedEntries = log.filter((entry) => entry.decision === 'blocked');
    expect(blockedEntries).toHaveLength(1);
    expect(blockedEntries[0]).toMatchObject({
      action: 'aiContextDatasources:preview',
      reason: 'preview-body-missing-collection',
      method: 'post',
      mode: 'mock',
    });
    expect(counts.blocked).toBe(1);
    expect(counts.total).toBeGreaterThan(1);

    // 逐条审计：除正常登录/退出外，所有**真实**请求都必须是只读 GET；
    // 唯一允许的 POST 是 `aiContextDatasources:preview`（只读但契约要求 POST + 查询体）。
    const authActions = new Set(['auth:signIn', 'auth:signOut']);
    const allowedReadPost = new Set(['aiContextDatasources:preview']);
    for (const entry of log) {
      if (entry.decision === 'blocked') continue;
      expect(entry.mode).toBe('real');
      if (authActions.has(String(entry.action))) continue;
      if (allowedReadPost.has(String(entry.action))) {
        expect(entry.method).toBe('post');
        continue;
      }
      expect(entry.method).toBe('get');
    }

    // `getMessages` 参数审计：本轮真实调用的次数与 `updateRead` 取值（只有布尔/计数，无业务内容）。
    expect(blockedMessageReadRequests).toBe(0);
    expect(messageReadParams.length).toBeGreaterThan(0);
    const messageReadSummary = {
      calls: messageReadParams.length,
      explicitFalse: messageReadParams.filter((value) => value === 'false').length,
      explicitTrue: messageReadParams.filter((value) => value === 'true' || value === true).length,
      missing: messageReadParams.filter((value) => value === undefined || value === null || value === '').length,
    };
    expect(messageReadSummary.explicitFalse).toBe(messageReadSummary.calls);
    expect(messageReadSummary.explicitTrue).toBe(0);
    expect(messageReadSummary.missing).toBe(0);
    ejectGetMessagesAudit();

    // 把真实读取到的**数量**（不含任何凭据、配置值或业务内容）写进验证日志，作为联调证据。
    // eslint-disable-next-line no-console
    console.log(
      `[group-a live 13000] ${JSON.stringify({
        usableEmployees: usable.rows.length,
        managedEmployees: managed.rows.length,
        usableIgnoresPaging: usablePaged.rows.length === usable.rows.length,
        managedFilterWorks: filteredManaged.rows.length <= 3,
        tools: tools.rows.length,
        skills: skills.rows.length,
        conversations: conversations.rows.length,
        contextDatasources: contexts.rows.length,
        mcpClients: mcp.rows.length,
        llmServices: masked.rows.length,
        providers: providers.length,
        collections: names.length,
        knowledgeCollections: names.filter((name) => name.includes('knowledge')).length,
        defaultLLMServiceConfigured: Boolean(settings.defaultLLMService),
        defaultModelConfigured: Boolean(settings.defaultModel),
        requests: counts.total,
        blocked: counts.blocked,
        getMessagesCalls: messageReadSummary.calls,
        getMessagesUpdateReadFalse: messageReadSummary.explicitFalse,
        getMessagesUpdateReadTrue: messageReadSummary.explicitTrue,
        getMessagesUpdateReadMissing: messageReadSummary.missing,
        historyShape,
        historyMessageCount,
        previewDenied,
        previewRowCount,
        firstMessageKeys,
        firstContentKeys,
        readOnlyMethods: log
          .filter((entry) => entry.decision === 'allowed' && !authActions.has(String(entry.action)))
          .every((entry) => entry.method === 'get' || allowedReadPost.has(String(entry.action))),
      })}`,
    );
  });
});
