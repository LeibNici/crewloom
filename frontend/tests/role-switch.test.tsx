import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AccessControlData, UserRoleSummary } from '../src/auth/types';

/**
 * 角色切换的受控组件交互验证（jsdom）。
 *
 * 为什么用受控方式验证合并角色模式：`allow-use-union` / `only-use-union` 属于实例级
 * 全局设置，**不能**为了测试去改动真实实例的 roleMode。这里通过替身构造三种模式的
 * 权限上下文，验证界面与状态机行为；真实实例上只读核对当前模式。
 */

const mocks = vi.hoisted(() => ({
  fetchAccessControl: vi.fn(),
  runAccessProbes: vi.fn(),
}));

vi.mock('../src/auth/api', () => ({
  signIn: vi.fn(),
  signOut: vi.fn(),
  checkSession: vi.fn(),
  fetchAccessControl: (...args: unknown[]) => mocks.fetchAccessControl(...args),
  fetchPublicAuthenticators: vi.fn().mockResolvedValue([{ name: 'basic', authType: 'email' }]),
  readOwnRoles: () => [],
}));

vi.mock('../src/permissions/probes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/permissions/probes')>();
  return { ...actual, runAccessProbes: (...args: unknown[]) => mocks.runAccessProbes(...args) };
});

vi.mock('../src/auth/useRoleTitle', () => ({
  useActiveRoleTitle: (role: string | null | undefined) =>
    role === '__union__' ? '合并全部角色' : '测试角色标题',
}));

import { AppLayout } from '../src/app/AppLayout';
import { useSessionStore } from '../src/auth/store';
import { UNION_ROLE } from '../src/permissions/model';
import type { ProbeResults } from '../src/permissions/probes';

const ROLES: UserRoleSummary[] = [
  { name: 'role_admin', title: '配置权限' },
  { name: 'role_limited', title: '受限用户' },
];

function access(partial: Partial<AccessControlData> = {}): AccessControlData {
  return {
    role: 'role_admin',
    roleMode: 'default',
    strategy: null,
    actions: {},
    resources: [],
    snippets: ['pm', 'pm.*', 'ui.*'],
    allowAll: false,
    allowConfigure: false,
    allowAnonymous: false,
    allowMenuItemIds: [],
    uiButtonSchemasBlacklist: [],
    availableActions: ['create', 'view'],
    actionAlias: { list: 'view' },
    roles: ['role_admin'],
    ...partial,
  };
}

const PROBES: ProbeResults = {
  'workbench.read': { status: 'allowed' },
  'ai.use': { status: 'allowed' },
  'tasks.read': { status: 'allowed' },
  'workflow.read': { status: 'allowed' },
  'datasource.read': { status: 'allowed' },
  'model.read': { status: 'allowed' },
  'access.read': { status: 'allowed' },
  'access.users': { status: 'allowed' },
  'ai.directory': { status: 'allowed' },
  'ai.conversations': { status: 'allowed' },
};

function renderLayout() {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: <AppLayout />,
        children: [{ index: true, element: <div>页面内容</div> }],
      },
    ],
    { initialEntries: ['/'] },
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

function setAuthenticated(accessData: AccessControlData, activeRole: string | null = null) {
  useSessionStore.setState({
    status: 'authenticated',
    token: 'component-test-token',
    user: { id: 7, nickname: '测试账号', email: 'tester@crewloom.test' },
    roles: ROLES,
    access: accessData,
    activeRole,
    roleMode: accessData.roleMode as 'default' | 'allow-use-union' | 'only-use-union' | 'unknown',
    accessState: 'ready',
    probes: PROBES,
    authenticators: [{ name: 'basic', authType: 'email' }],
    authenticatorState: 'ready',
    notice: null,
    error: null,
    bootDetail: null,
  });
}

beforeEach(() => {
  mocks.fetchAccessControl.mockReset();
  mocks.runAccessProbes.mockReset();
  mocks.runAccessProbes.mockResolvedValue(PROBES);
});

describe('角色切换（受控）', () => {
  it('allow-use-union：候选包含合并角色，选择后按合并角色重新取权限', async () => {
    const user = userEvent.setup();
    setAuthenticated(access({ roleMode: 'allow-use-union' }));
    mocks.fetchAccessControl.mockResolvedValue(access({ role: UNION_ROLE, roleMode: 'allow-use-union' }));
    renderLayout();

    const select = await screen.findByLabelText('切换当前角色');
    const labels = Array.from((select as HTMLSelectElement).options).map((o) => o.textContent);
    expect(labels).toContain('合并全部角色');
    expect(labels).toContain('配置权限');

    await user.selectOptions(select, UNION_ROLE);

    await waitFor(() => {
      expect(useSessionStore.getState().activeRole).toBe(UNION_ROLE);
    });
    expect(await screen.findByText('正在使用全部角色的合并权限')).toBeInTheDocument();
  });

  it('only-use-union：不渲染角色切换控件，并显示合并身份', async () => {
    setAuthenticated(access({ roleMode: 'only-use-union', role: UNION_ROLE }), UNION_ROLE);
    renderLayout();

    await screen.findByText('页面内容');
    expect(screen.queryByLabelText('切换当前角色')).toBeNull();
    expect(await screen.findByText('正在使用全部角色的合并权限')).toBeInTheDocument();
  });

  it('default：不提供合并角色选项', async () => {
    setAuthenticated(access({ roleMode: 'default' }));
    renderLayout();

    const select = await screen.findByLabelText('切换当前角色');
    const labels = Array.from((select as HTMLSelectElement).options).map((o) => o.textContent);
    expect(labels).toEqual(['配置权限', '受限用户']);
    expect(labels).not.toContain('合并全部角色');
  });

  it('单角色账号不渲染空角色下拉', async () => {
    setAuthenticated(access({ roleMode: 'default' }));
    useSessionStore.setState({ roles: [ROLES[0]] });
    renderLayout();

    await screen.findByText('页面内容');
    expect(screen.queryByLabelText('切换当前角色')).toBeNull();
  });

  it('权限无法确认时不显示模块入口，并提供重试说明', async () => {
    setAuthenticated(access());
    useSessionStore.setState({
      accessState: 'unknown',
      access: null,
      probes: null,
    });
    renderLayout();

    await screen.findByText(/暂时无法确认当前角色的可用范围/);
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
    expect(document.querySelectorAll('aside nav a')).toHaveLength(0);
  });

  it('存在 unknown 探测项时同样提供重试，且不显示该模块入口', async () => {
    setAuthenticated(access());
    useSessionStore.setState({
      probes: {
        ...PROBES,
        'model.read': { status: 'unknown', reason: 'network' },
      },
    });
    renderLayout();

    await screen.findByText(/暂时无法确认当前角色的可用范围/);
    const navText = Array.from(document.querySelectorAll('aside nav a'))
      .map((node) => node.textContent)
      .join('|');
    expect(navText).not.toContain('模型配置');
    expect(navText).toContain('工作台');
  });

  it('切换到不属于自己的角色会被拒绝并给出中文提示', async () => {
    setAuthenticated(access({ roleMode: 'default' }));
    mocks.fetchAccessControl.mockImplementation(() => Promise.resolve(access({ role: 'role_admin' })));
    renderLayout();

    await screen.findByText('页面内容');
    const ok = await useSessionStore.getState().switchRole('role_admin');
    expect(ok).toBe(true);
    const denied = await useSessionStore.getState().switchRole('root');
    expect(denied).toBe(false);
    expect(useSessionStore.getState().error).toContain('不属于当前账号');
  });
});
