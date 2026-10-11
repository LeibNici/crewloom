import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * 登录页交互测试（jsdom，受控模块替身）。
 *
 * 覆盖：用户必须真实输入、提交中状态、失败提示、成功后进入应用、
 * 登录方式来自 authenticators:publicList（失败时可重试）。
 * 真实后端登录由 tests/live-backend.test.ts 单独验证。
 */

const mocks = vi.hoisted(() => ({
  signIn: vi.fn(),
  signOut: vi.fn(),
  checkSession: vi.fn(),
  fetchAccessControl: vi.fn(),
  fetchPublicAuthenticators: vi.fn(),
  requestPasswordReset: vi.fn(),
  changePassword: vi.fn(),
}));

vi.mock('../src/auth/api', () => ({
  signIn: (...args: unknown[]) => mocks.signIn(...args),
  signOut: (...args: unknown[]) => mocks.signOut(...args),
  checkSession: (...args: unknown[]) => mocks.checkSession(...args),
  fetchAccessControl: (...args: unknown[]) => mocks.fetchAccessControl(...args),
  fetchPublicAuthenticators: (...args: unknown[]) => mocks.fetchPublicAuthenticators(...args),
  changePassword: (...args: unknown[]) => mocks.changePassword(...args),
  requestPasswordReset: (...args: unknown[]) => mocks.requestPasswordReset(...args),
  // 用真实的判定实现：它只读 authenticators 的公开选项，属于被验证的行为本身。
  describePasswordRecovery: (authenticators: Array<{ name: string; options?: Record<string, unknown> }>) => {
    const target = authenticators[0];
    if (!target) return { available: false, authenticator: null, reason: '暂时无法确认可用的登录方式，请稍后重试。' };
    const enabled = target.options?.enableResetPassword === true;
    return {
      available: enabled,
      authenticator: target.name,
      reason: enabled ? null : '当前未开通自助找回密码，请联系管理员协助重置。',
    };
  },
  readOwnRoles: (user: { roles?: Array<{ name: string; title?: string | null }> } | null | undefined) =>
    Array.isArray(user?.roles)
      ? user!.roles.map((role) => ({ name: role.name, title: role.title ?? null }))
      : [],
}));

import { LoginScreen } from '../src/screens/LoginScreen';
import { useSessionStore } from '../src/auth/store';
import { CrewloomError } from '../src/api/errors';
import type { AccessControlData, CurrentUser } from '../src/auth/types';

function accessData(): AccessControlData {
  return {
    role: 'crewloom_p1_admin',
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
    availableActions: [],
    actionAlias: { list: 'view' },
    roles: ['crewloom_p1_admin'],
  };
}

const ADMIN_USER: CurrentUser = {
  id: 2,
  email: 'crewloom-fixture-admin@example.invalid',
  nickname: 'Crewloom P1 Admin',
  roles: [{ name: 'crewloom_p1_admin', title: 'Crewloom P1 配置权限' }],
};

function resetStore() {
  useSessionStore.setState({
    status: 'anonymous',
    token: null,
    user: null,
    roles: [],
    access: null,
    activeRole: null,
    roleMode: 'default',
    accessState: 'unknown',
    probes: null,
    authenticators: [],
    authenticatorState: 'idle',
    notice: null,
    error: null,
    bootDetail: null,
  });
}

function prepare() {
  mocks.signIn.mockReset();
  mocks.checkSession.mockReset();
  mocks.fetchAccessControl.mockReset();
  mocks.fetchPublicAuthenticators.mockReset();
  mocks.requestPasswordReset.mockReset();
  mocks.changePassword.mockReset();
  mocks.fetchPublicAuthenticators.mockResolvedValue([{ name: 'basic', authType: 'email', title: '邮箱/密码' }]);
  resetStore();
}

function renderLogin(initialEntry = '/login') {
  const router = createMemoryRouter(
    [
      { path: '/login', element: <LoginScreen /> },
      { path: '/workbench', element: <div>工作台已打开</div> },
      { path: '/access/users', element: <div>用户页面已打开</div> },
    ],
    { initialEntries: [initialEntry] },
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe('登录页', () => {
  it('不预填任何账号或密码', () => {
    prepare();
    renderLogin();

    expect(screen.getByLabelText('邮箱或用户名')).toHaveValue('');
    expect(screen.getByLabelText('密码')).toHaveValue('');
    // 密码输入框不参与浏览器自动填充。
    expect(screen.getByLabelText('密码')).toHaveAttribute('autocomplete', 'new-password');
  });

  it('缺少输入时给出提示且不发起请求', async () => {
    const user = userEvent.setup();
    prepare();
    renderLogin();

    await user.click(screen.getByRole('button', { name: '登录' }));

    expect(mocks.signIn).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('请填写邮箱或用户名与密码');
  });

  it('登录失败时展示中文提示，且不出现状态码或英文标识', async () => {
    const user = userEvent.setup();
    prepare();
    mocks.signIn.mockRejectedValue(
      new CrewloomError({
        kind: 'unauthenticated',
        userMessage: '登录状态已失效，请重新登录后继续。',
        status: 401,
        code: 'INVALID_TOKEN',
        detail: 'Invalid password',
      }),
    );
    renderLogin();

    await user.type(screen.getByLabelText('邮箱或用户名'), 'crewloom-fixture-admin@example.invalid');
    await user.type(screen.getByLabelText('密码'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: '登录' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('邮箱、用户名或密码不正确');
    expect(alert.textContent).not.toMatch(/401|INVALID_TOKEN|Invalid password/);
    // 提交后密码字段立即清空。
    expect(screen.getByLabelText('密码')).toHaveValue('');
  });

  it('登录成功后进入应用并按权限落点，且使用 publicList 返回的认证方式', async () => {
    const user = userEvent.setup();
    prepare();
    mocks.signIn.mockResolvedValue({ user: ADMIN_USER, token: 'test-token' });
    mocks.checkSession.mockResolvedValue(ADMIN_USER);
    mocks.fetchAccessControl.mockResolvedValue(accessData());

    const router = renderLogin('/login?returnTo=%2Faccess%2Fusers');

    await user.type(screen.getByLabelText('邮箱或用户名'), 'crewloom-fixture-admin@example.invalid');
    await user.type(screen.getByLabelText('密码'), 'correct-password');
    await user.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/access/users');
    });
    expect(screen.getByText('用户页面已打开')).toBeInTheDocument();
    expect(mocks.signIn).toHaveBeenCalledWith(
      {
        email: 'crewloom-fixture-admin@example.invalid',
        password: 'correct-password',
      },
      'basic',
    );
  });

  it('登录方式读取失败时禁用提交并提供重试', async () => {
    prepare();
    mocks.fetchPublicAuthenticators.mockRejectedValue(new Error('offline'));
    renderLogin();

    await waitFor(() => {
      expect(screen.getByText(/暂时无法确认可用的登录方式/)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: '登录' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
  });

  it('后台未开通自助找回时只说明原因，不发起任何重置请求', async () => {
    const user = userEvent.setup();
    prepare();
    renderLogin();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '忘记密码？' })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: '忘记密码？' }));

    expect(screen.getByText(/当前未开通自助找回密码/)).toBeInTheDocument();
    // 没有邮箱输入框，也没有发出请求。
    expect(screen.queryByLabelText('邮箱')).not.toBeInTheDocument();
    expect(mocks.requestPasswordReset).not.toHaveBeenCalled();
  });

  it('后台开通自助找回时提交邮箱并调用重置接口（真实用户主动操作才发信）', async () => {
    const user = userEvent.setup();
    prepare();
    mocks.fetchPublicAuthenticators.mockResolvedValue([
      { name: 'basic', authType: 'email', title: '邮箱/密码', options: { enableResetPassword: true } },
    ]);
    mocks.requestPasswordReset.mockResolvedValue(undefined);
    renderLogin();

    await user.click(screen.getByRole('button', { name: '忘记密码？' }));
    await user.type(screen.getByLabelText('邮箱'), 'someone@crewloom.test');
    await user.click(screen.getByRole('button', { name: '发送重置邮件' }));

    await waitFor(() => {
      expect(mocks.requestPasswordReset).toHaveBeenCalledWith('someone@crewloom.test', 'basic');
    });
    expect(screen.getByText(/重置密码的邮件已经发出/)).toBeInTheDocument();
  });
});
