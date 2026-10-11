import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { getHttpClient, setApiBase, setAuthContext, api } from '../../../src/api/client';
import { installTransportGuard } from '../../../src/api/transportGuard';
import { useSessionStore } from '../../../src/auth/store';
import { EmployeeDirectoryPage } from '../../../src/modules/ai/pages/EmployeeDirectoryPage';
import { ToolsPage } from '../../../src/modules/ai/pages/ToolsPage';
import { KnowledgePage } from '../../../src/modules/ai/pages/KnowledgePage';
import { ContextPage } from '../../../src/modules/ai/pages/ContextPage';
import { ServicesPage } from '../../../src/modules/model/pages/ServicesPage';
import { DefaultsPage } from '../../../src/modules/model/pages/DefaultsPage';
import { ModelsPage } from '../../../src/modules/model/pages/ModelsPage';

/**
 * 组 A 页面级真实数据渲染验证（jsdom + 真实 13000 只读）。
 *
 * 为什么需要它：本机 DSH 沙箱无法启动 Chrome（见 `browser-group-a.mjs` 的说明），
 * 因此这里用 jsdom 渲染**真实页面组件**，让它们通过产品请求管线去打真实的 13000，
 * 断言页面上出现真实数据、并且不出现内部错误码或明文密钥。
 *
 * 严格只读：只调用只读动作（GET）+ 正常登录/退出；不点任何保存/发送/测试按钮。
 * 凭据只从主工作区 `.secrets` 读取，不打印。
 */

const SECRET_CANDIDATES = [
  process.env.CREWLOOM_13000_SECRET,
  resolve(process.cwd(), '../.secrets/full-pages-13000-20261011.json'),
  resolve(process.cwd(), '../../../.secrets/full-pages-13000-20261011.json'),
].filter((item): item is string => typeof item === 'string' && item.length > 0);

function readSecret(): { apiBaseURL: string; email: string; password: string } | null {
  for (const candidate of SECRET_CANDIDATES) {
    if (!existsSync(candidate)) continue;
    try {
      return JSON.parse(readFileSync(candidate, 'utf8'));
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

async function signInAndPrepare(): Promise<void> {
  setApiBase(`${ORIGIN}/api`);
  installTransportGuard(getHttpClient(), {
    baseURL: `${ORIGIN}/api`,
    originBase: ORIGIN,
    allowedOrigins: [ORIGIN],
    mode: 'strict',
  });
  // 传送到真实后端：用 Node http adapter（jsdom 的 XHR 会带 localhost Origin，被后端拒绝）。
  getHttpClient().defaults.adapter = 'http';
  const signIn = await api.request<{ token?: string }>({
    url: 'auth:signIn',
    method: 'post',
    data: { email: secrets!.email, password: secrets!.password },
  });
  const token = (signIn.data as { token?: string } | null)?.token as string;
  setAuthContext({ token, role: null, authenticator: 'basic' });
  // 页面的按钮可用性依赖权限上下文；真实管理员账号 allowAll=true（后端仍是最终判定者）。
  useSessionStore.setState({
    status: 'authenticated',
    access: { allowAll: true, role: 'root', snippets: [], actions: {}, resources: [], strategies: [] } as never,
    probes: null,
  });
}

/** jsdom 没有实现 `innerText`；统一用 `textContent` 读取页面可见文本。 */
function bodyText(): string {
  return document.body.textContent ?? '';
}

function renderPage(node: React.ReactElement, path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

suite('组 A · 13000 页面级真实数据渲染（严格只读）', () => {
  it('AI-01 员工目录：渲染真实员工与分页信息，无内部错误码', async () => {
    await signInAndPrepare();
    renderPage(<EmployeeDirectoryPage />, '/ai/directory');

    await waitFor(() => expect(screen.getByText('员工目录')).toBeInTheDocument(), { timeout: 15000 });
    // 真实后端返回员工后，列表里会出现「查看详情」入口。
    await waitFor(() => expect(screen.getAllByText('查看详情').length).toBeGreaterThan(0), { timeout: 15000 });

    const body = bodyText();
    expect(body).not.toMatch(/TRANSPORT_BLOCKED|EMPTY_TOKEN|ROLE_NOT_FOUND|Invalid SQL/);
    // 真实员工记录（当前 13 位）应至少渲染出一位员工的“查看详情”。
    expect(screen.getAllByText('查看详情').length).toBeGreaterThan(0);
    expect(body).toContain('我可以使用的员工');
    // 「可使用」页签：一次列出当前角色的全部可用员工（不发假分页），且不出现工程说明。
    expect(body).toContain('已一次性全部列出');
    expect(body).not.toContain('后端一次返回');
    expect(body).not.toContain('分页总数未提供');
  }, 30000);

  it('AI-05 工具与技能：渲染后端注册的真实工具数量', async () => {
    await signInAndPrepare();
    renderPage(<ToolsPage />, '/ai/tools');

    // 先等真实数据到达（初始渲染时数量是 0）。
    await waitFor(() => expect(bodyText()).toMatch(/共 [1-9]\d* 个工具/), { timeout: 15000 });
    expect(bodyText()).toContain('工具清单');
    expect(bodyText()).toContain('技能清单');
    expect(bodyText()).not.toMatch(/TRANSPORT_BLOCKED|EMPTY_TOKEN/);
  }, 30000);

  it('AI-04 上下文：空配置也渲染完整交互（不是“未开放”）', async () => {
    await signInAndPrepare();
    renderPage(<ContextPage />, '/ai/context');

    await waitFor(() => expect(screen.getByText('任务与数据上下文')).toBeInTheDocument(), { timeout: 15000 });
    // 四类上下文都直接是页签入口（没有"实现方式待设计"占位，也没有实现说明卡片）。
    expect(screen.getByTestId('context-tab-datasource')).toBeInTheDocument();
    expect(screen.getByTestId('context-tab-record')).toBeInTheDocument();
    expect(screen.getByTestId('context-tab-code')).toBeInTheDocument();
    expect(screen.getByTestId('context-tab-chart')).toBeInTheDocument();
    expect(screen.getByTestId('context-tab-selection')).toBeInTheDocument();
    expect(bodyText()).not.toContain('实现方式待设计');
    expect(bodyText()).not.toContain('每一项都对应后端与原生客户端真实支持的解析来源');
    // 空配置时的交互入口必须还在（刷新会触发一次真实的只读 list）。
    await waitFor(() => expect(screen.getByRole('button', { name: '新建数据范围' })).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('context-tab-record'));
    expect(screen.getByText('指定记录的工作内容')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('context-tab-code'));
    expect(screen.getByTestId('context-code-input')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('context-tab-chart'));
    expect(screen.getByTestId('context-chart-collection')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('context-tab-selection'));
    expect(screen.getByText('还没有选择任何上下文')).toBeInTheDocument();
    expect(bodyText()).not.toContain('上下文未开放');
  }, 30000);

  it('AI-06 知识库：如实呈现“能力未开通”，不出现假数据', async () => {
    await signInAndPrepare();
    renderPage(<KnowledgePage />, '/ai/knowledge');

    await waitFor(() => expect(screen.getByText('知识库')).toBeInTheDocument(), { timeout: 15000 });
    await waitFor(() => expect(screen.getByText('能力未开通')).toBeInTheDocument(), { timeout: 15000 });
    expect(bodyText()).toContain('没有开通知识库能力');
    // 不暴露插件/集合/接口等内部实现说明。
    expect(bodyText()).not.toContain('插件');
    // 不提供无法工作的入口：没有检索/上传文档之类的按钮。
    expect(screen.queryByRole('button', { name: /检索|上传文档|新建知识库/ })).toBeNull();
    expect(bodyText()).toContain('这是能力本身缺失');
  }, 30000);

  it('LM-01 服务列表：渲染真实服务，且 DOM 中没有 apiKey / baseURL 明文', async () => {
    await signInAndPrepare();
    renderPage(<ServicesPage />, '/model/services');

    await waitFor(() => expect(screen.getByText('模型服务')).toBeInTheDocument(), { timeout: 15000 });
    await waitFor(() => expect(screen.getByText('服务列表')).toBeInTheDocument(), { timeout: 15000 });
    await waitFor(() => expect(screen.getAllByText('查看模型').length).toBeGreaterThan(0), { timeout: 15000 });

    const body = bodyText();
    // 脱敏入口（ai:listLLMServices）不返回 options，因此页面上不应出现密钥字段名或密钥值。
    expect(body).not.toContain('apiKey');
    expect(body).not.toContain('baseURL');
    expect(body).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
    expect(body).not.toMatch(/TRANSPORT_BLOCKED|EMPTY_TOKEN/);
  }, 30000);

  it('LM-03 可用模型：渲染 enabledModels 现值（用户视角文案，不暴露内部存储形状）', async () => {
    await signInAndPrepare();
    renderPage(<ModelsPage />, '/model/models');

    await waitFor(() => expect(screen.getByText('可用模型')).toBeInTheDocument(), { timeout: 15000 });
    await waitFor(() => expect(screen.getByText('服务与模型')).toBeInTheDocument(), { timeout: 15000 });
    // 47 之后：页面按用户视角描述"这条服务当前使用的模型范围"，不再显示内部存储形状。
    await waitFor(() => expect(screen.getByText(/这条服务当前使用的模型范围/)).toBeInTheDocument(), {
      timeout: 15000,
    });
    expect(bodyText()).not.toContain('后端记录的形状');
  }, 30000);

  it('LM-04 默认与员工模型：渲染真实默认设置与员工允许集，并按批准的生效顺序说明', async () => {
    await signInAndPrepare();
    renderPage(<DefaultsPage />, '/model/defaults');

    await waitFor(() => expect(screen.getByText('默认与员工模型')).toBeInTheDocument(), { timeout: 15000 });
    await waitFor(() => expect(screen.getByText('当前默认服务')).toBeInTheDocument(), { timeout: 15000 });
    expect(bodyText()).toContain('现在未配置');
    expect(bodyText()).toContain('不代表历史上从未配置过');
    // 页面按已批准的生效顺序说明（员工专用 → 显式选择 → 全局默认 → 未配置时的兼容回退 → 失效明确失败），
    // 不再展示源码位置/未授权方案等工程内容。
    expect(bodyText()).toContain('实际生效顺序');
    expect(bodyText()).toContain('默认不可用时的处理');
    expect(bodyText()).not.toContain('后端差距');
  }, 30000);
});
