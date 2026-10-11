import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearStoredSession, readStoredToken, writeStoredToken } from '../src/auth/storage';

/**
 * 登录态存储的定向测试：验证刷新恢复、角色来源、角色失效与会话失效分开、
 * 三种角色模式、旧请求隔离与退出清理。
 *
 * 本文件使用受控的模块替身（mock），只验证前端状态机；真实后端结果由
 * tests/live-backend.test.ts 单独验证，两者在验收报告中分开记录。
 */

const mocks = vi.hoisted(() => ({
  signIn: vi.fn(),
  signOut: vi.fn(),
  checkSession: vi.fn(),
  fetchAccessControl: vi.fn(),
  fetchPublicAuthenticators: vi.fn(),
  runAccessProbes: vi.fn(),
}));

const signInMock = mocks.signIn;
const signOutMock = mocks.signOut;
const checkSessionMock = mocks.checkSession;
const fetchAccessControlMock = mocks.fetchAccessControl;
const fetchPublicAuthenticatorsMock = mocks.fetchPublicAuthenticators;
const probeMock = mocks.runAccessProbes;

vi.mock('../src/permissions/probes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/permissions/probes')>();
  return { ...actual, runAccessProbes: (...args: unknown[]) => mocks.runAccessProbes(...args) };
});

vi.mock('../src/auth/api', () => ({
  signIn: (...args: unknown[]) => signInMock(...args),
  signOut: (...args: unknown[]) => signOutMock(...args),
  checkSession: (...args: unknown[]) => checkSessionMock(...args),
  fetchAccessControl: (...args: unknown[]) => fetchAccessControlMock(...args),
  fetchPublicAuthenticators: (...args: unknown[]) => fetchPublicAuthenticatorsMock(...args),
  readOwnRoles: (user: { roles?: Array<{ name: string; title?: string | null }> } | null | undefined) =>
    Array.isArray(user?.roles)
      ? user!.roles
          .filter((role) => role && typeof role.name === 'string' && role.name.length > 0)
          .map((role) => ({ name: role.name, title: role.title ?? null }))
      : [],
}));

import { resolveAuthenticator, useSessionStore } from '../src/auth/store';
import { getAuthContext, resetAuthContext } from '../src/api/client';
import type { AccessControlData, CurrentUser } from '../src/auth/types';
import { CrewloomError } from '../src/api/errors';
import { UNION_ROLE } from '../src/permissions/model';

const USER: CurrentUser = {
  id: 13,
  nickname: 'Crewloom P1 Multi',
  username: 'crewloom_p1_multi',
  email: 'crewloom-fixture-admin@example.invalid',
  roles: [
    { name: 'crewloom_p1_admin', title: 'Crewloom 配置权限' },
    { name: 'crewloom_p1_limited', title: 'Crewloom 受限用户' },
  ],
};

const LIMITED_USER: CurrentUser = {
  id: 3,
  nickname: 'Crewloom P1 Limited',
  email: 'crewloom-fixture-admin@example.invalid',
  roles: [{ name: 'crewloom_p1_limited', title: 'Crewloom 受限用户' }],
};

function accessData(partial: Partial<AccessControlData> = {}): AccessControlData {
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
    availableActions: ['create', 'view', 'update', 'destroy'],
    actionAlias: { list: 'view' },
    roles: ['crewloom_p1_admin'],
    ...partial,
  };
}

function resetStore() {
  useSessionStore.setState({
    status: 'idle',
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

beforeEach(() => {
  signInMock.mockReset();
  signOutMock.mockReset();
  checkSessionMock.mockReset();
  fetchAccessControlMock.mockReset();
  fetchPublicAuthenticatorsMock.mockReset();
  fetchPublicAuthenticatorsMock.mockResolvedValue([{ name: 'basic', authType: 'email', title: '邮箱/密码' }]);
  probeMock.mockReset();
  probeMock.mockResolvedValue({});
  clearStoredSession();
  resetAuthContext();
  resetStore();
});

describe('本人角色候选的唯一来源', () => {
  it('登录成功后角色候选来自 auth:check 的 data.roles', async () => {
    signInMock.mockResolvedValue({ user: USER, token: 'test-token-value' });
    checkSessionMock.mockResolvedValue(USER);
    fetchAccessControlMock.mockResolvedValue(accessData());

    const ok = await useSessionStore.getState().signIn({ email: USER.email!, password: 'secret' });

    expect(ok).toBe(true);
    const state = useSessionStore.getState();
    expect(state.status).toBe('authenticated');
    expect(state.roles.map((role) => role.name)).toEqual(['crewloom_p1_admin', 'crewloom_p1_limited']);
    expect(state.roles.map((role) => role.title)).toEqual(['Crewloom 配置权限', 'Crewloom 受限用户']);
    expect(state.access?.role).toBe('crewloom_p1_admin');
    expect(readStoredToken()).toBe('test-token-value');
  });

  it('受限单角色账号也能拿到角色中文标题（不需要额外资源权限）', async () => {
    signInMock.mockResolvedValue({ user: LIMITED_USER, token: 'limited-token' });
    checkSessionMock.mockResolvedValue(LIMITED_USER);
    fetchAccessControlMock.mockResolvedValue(
      accessData({ role: 'crewloom_p1_limited', snippets: [], strategy: null, roles: ['crewloom_p1_limited'] }),
    );

    await useSessionStore.getState().signIn({ email: LIMITED_USER.email!, password: 'secret' });

    const state = useSessionStore.getState();
    expect(state.roles).toEqual([{ name: 'crewloom_p1_limited', title: 'Crewloom 受限用户' }]);
  });

  it('auth:check 没带 roles 时候选为空，不退回其它接口', async () => {
    signInMock.mockResolvedValue({ user: { id: 9, email: 'x@y.test' }, token: 'no-roles' });
    checkSessionMock.mockResolvedValue({ id: 9, email: 'x@y.test' });
    fetchAccessControlMock.mockResolvedValue(accessData({ role: 'anonymous', roles: [] }));

    await useSessionStore.getState().signIn({ email: 'x@y.test', password: 'secret' });

    expect(useSessionStore.getState().roles).toEqual([]);
    expect(useSessionStore.getState().status).toBe('authenticated');
  });

  it('登录失败时不写入令牌并给出中文提示', async () => {
    signInMock.mockRejectedValue(
      new CrewloomError({
        kind: 'unauthenticated',
        userMessage: '登录状态已失效',
        status: 401,
        code: 'INVALID_TOKEN',
        detail: 'Invalid password',
      }),
    );

    const ok = await useSessionStore.getState().signIn({ email: USER.email!, password: 'bad' });

    expect(ok).toBe(false);
    const state = useSessionStore.getState();
    expect(state.status).toBe('anonymous');
    expect(state.user).toBeNull();
    expect(readStoredToken()).toBeNull();
    expect(state.error).toContain('邮箱、用户名或密码不正确');
  });
});

describe('刷新恢复会话', () => {
  it('有令牌时恢复用户、本人角色与权限', async () => {
    writeStoredToken('restored-token');
    checkSessionMock.mockResolvedValue(USER);
    fetchAccessControlMock.mockResolvedValue(accessData());

    await useSessionStore.getState().bootstrap();

    const state = useSessionStore.getState();
    expect(state.status).toBe('authenticated');
    expect(state.user?.email).toBe(USER.email);
    expect(state.roles.map((role) => role.name)).toEqual(['crewloom_p1_admin', 'crewloom_p1_limited']);
    expect(state.accessState).toBe('ready');
  });

  it('恢复时记住上次显式选择的角色', async () => {
    writeStoredToken('restored-token');
    window.localStorage.setItem('crewloom.session.role', 'crewloom_p1_limited');
    checkSessionMock.mockResolvedValue(USER);
    fetchAccessControlMock.mockResolvedValue(
      accessData({ role: 'crewloom_p1_limited', snippets: [], strategy: { actions: ['view'] } }),
    );

    await useSessionStore.getState().bootstrap();

    const state = useSessionStore.getState();
    expect(state.activeRole).toBe('crewloom_p1_limited');
    expect(state.access?.role).toBe('crewloom_p1_limited');
  });

  it('令牌真正失效时回到未登录并清空权限上下文', async () => {
    writeStoredToken('expired-token');
    checkSessionMock.mockRejectedValue(
      new CrewloomError({
        kind: 'unauthenticated',
        userMessage: '登录状态已失效，请重新登录后继续。',
        status: 401,
        code: 'EXPIRED_SESSION',
        detail: 'EXPIRED_SESSION',
      }),
    );

    await useSessionStore.getState().bootstrap();

    const state = useSessionStore.getState();
    expect(state.status).toBe('anonymous');
    expect(state.access).toBeNull();
    expect(state.roles).toEqual([]);
    expect(readStoredToken()).toBeNull();
  });

  it('角色已被撤销（auth:check 返回角色错误）时清本地选择、保留令牌并重新读取', async () => {
    writeStoredToken('role-gone-token');
    window.localStorage.setItem('crewloom.session.role', 'crewloom_p1_limited');
    checkSessionMock
      .mockRejectedValueOnce(
        new CrewloomError({
          kind: 'role-invalid',
          userMessage: '角色已不可用',
          status: 401,
          code: 'ROLE_NOT_FOUND_FOR_USER',
          detail: 'The role does not belong to the user',
        }),
      )
      .mockResolvedValueOnce(USER);
    fetchAccessControlMock.mockResolvedValue(accessData({ role: 'crewloom_p1_admin' }));

    await useSessionStore.getState().bootstrap();

    const state = useSessionStore.getState();
    expect(state.status).toBe('authenticated');
    expect(state.activeRole).toBeNull();
    expect(state.access?.role).toBe('crewloom_p1_admin');
    // 令牌保留，没有被强制登出。
    expect(getAuthContext().token).toBe('role-gone-token');
    expect(readStoredToken()).toBe('role-gone-token');
  });

  it('网络/5xx 导致无法确认会话时保留令牌并进入可重试状态（不伪装成未登录）', async () => {
    writeStoredToken('network-token');
    checkSessionMock.mockRejectedValue(
      new CrewloomError({ kind: 'network', userMessage: '无法连接到服务，请检查网络后重试。', detail: 'ECONNREFUSED' }),
    );

    await useSessionStore.getState().bootstrap();

    const state = useSessionStore.getState();
    expect(state.status).toBe('unavailable');
    expect(state.access).toBeNull();
    expect(state.accessState).toBe('unknown');
    expect(readStoredToken()).toBe('network-token');
  });

  it('权限上下文读取失败（5xx）时保持未知，不放行', async () => {
    writeStoredToken('access-token');
    checkSessionMock.mockResolvedValue(USER);
    fetchAccessControlMock.mockRejectedValue(
      new CrewloomError({ kind: 'backend-unavailable', userMessage: '服务暂时不可用', status: 503, detail: '503' }),
    );

    await useSessionStore.getState().bootstrap();

    const state = useSessionStore.getState();
    expect(state.status).toBe('unavailable');
    expect(state.accessState).toBe('unknown');
    expect(state.access).toBeNull();
    expect(readStoredToken()).toBe('access-token');
  });
});

describe('角色切换', () => {
  async function signInAsMultiRole() {
    signInMock.mockResolvedValue({ user: USER, token: 'multi-token' });
    checkSessionMock.mockResolvedValue(USER);
    fetchAccessControlMock.mockResolvedValue(accessData());
    await useSessionStore.getState().signIn({ email: USER.email!, password: 'secret' });
  }

  it('切换到拥有的角色后重新获取权限', async () => {
    await signInAsMultiRole();
    fetchAccessControlMock.mockResolvedValueOnce(
      accessData({ role: 'crewloom_p1_limited', snippets: [], strategy: { actions: ['view'] } }),
    );

    const ok = await useSessionStore.getState().switchRole('crewloom_p1_limited');

    expect(ok).toBe(true);
    const state = useSessionStore.getState();
    expect(state.activeRole).toBe('crewloom_p1_limited');
    expect(state.access?.role).toBe('crewloom_p1_limited');
    expect(window.localStorage.getItem('crewloom.session.role')).toBe('crewloom_p1_limited');
  });

  it('切换到不属于自己的角色被拒绝，且不发出请求', async () => {
    await signInAsMultiRole();
    const before = useSessionStore.getState().access;
    const calls = fetchAccessControlMock.mock.calls.length;

    const ok = await useSessionStore.getState().switchRole('root');

    expect(ok).toBe(false);
    const state = useSessionStore.getState();
    expect(state.activeRole).toBeNull();
    expect(state.access).toBe(before);
    expect(state.error).toContain('不属于当前账号');
    expect(fetchAccessControlMock.mock.calls.length).toBe(calls);
  });

  it('后端拒绝角色切换时保留原角色并给出提示', async () => {
    await signInAsMultiRole();
    fetchAccessControlMock.mockRejectedValueOnce(
      new CrewloomError({
        kind: 'unauthenticated',
        userMessage: '登录状态已失效',
        status: 401,
        code: 'EXPIRED_SESSION',
        detail: 'EXPIRED_SESSION',
      }),
    );

    const ok = await useSessionStore.getState().switchRole('crewloom_p1_limited');

    expect(ok).toBe(false);
    expect(useSessionStore.getState().activeRole).toBeNull();
  });

  it('default 模式下不提供合并全部角色', async () => {
    await signInAsMultiRole();
    const ok = await useSessionStore.getState().switchRole(UNION_ROLE);
    expect(ok).toBe(false);
    expect(useSessionStore.getState().error).toContain('不能使用合并角色');
  });

  it('allow-use-union 模式下可切到合并角色', async () => {
    await signInAsMultiRole();
    useSessionStore.setState({ access: accessData({ roleMode: 'allow-use-union' }) });
    fetchAccessControlMock.mockResolvedValueOnce(
      accessData({ role: UNION_ROLE, roleMode: 'allow-use-union' }),
    );

    const ok = await useSessionStore.getState().switchRole(UNION_ROLE);

    expect(ok).toBe(true);
    expect(useSessionStore.getState().activeRole).toBe(UNION_ROLE);
  });
});

describe('only-use-union / allow-use-union 模式', () => {
  it('only-use-union：会话恢复时自动使用合并角色', async () => {
    writeStoredToken('restored-token');
    checkSessionMock.mockResolvedValue(USER);
    fetchAccessControlMock
      .mockResolvedValueOnce(accessData({ roleMode: 'only-use-union' }))
      .mockResolvedValueOnce(accessData({ role: UNION_ROLE, roleMode: 'only-use-union' }));

    await useSessionStore.getState().bootstrap();

    const state = useSessionStore.getState();
    expect(state.activeRole).toBe(UNION_ROLE);
    expect(state.access?.role).toBe(UNION_ROLE);
    expect(state.roleMode).toBe('only-use-union');
  });

  it('allow-use-union：会话恢复时不强制合并角色，仍按服务端生效角色', async () => {
    writeStoredToken('restored-token');
    checkSessionMock.mockResolvedValue(USER);
    fetchAccessControlMock.mockResolvedValue(accessData({ roleMode: 'allow-use-union' }));

    await useSessionStore.getState().bootstrap();

    const state = useSessionStore.getState();
    expect(state.activeRole).toBeNull();
    expect(state.access?.role).toBe('crewloom_p1_admin');
    expect(state.roleMode).toBe('allow-use-union');
  });

  it('非空但未识别的 roleMode 保持 unknown：不当作 default，也不提供合并角色', async () => {
    writeStoredToken('restored-token');
    checkSessionMock.mockResolvedValue(USER);
    fetchAccessControlMock.mockResolvedValue(accessData({ roleMode: 'something-new' }));

    await useSessionStore.getState().bootstrap();

    const state = useSessionStore.getState();
    // 权限上下文本身读取成功（不是 accessState unknown）……
    expect(state.accessState).toBe('ready');
    // ……但角色模式未被悄悄赋成 default。
    expect(state.roleMode).toBe('unknown');
    // 未识别模式下不提供合并角色：切换会被拒绝，且不会发请求。
    const calls = fetchAccessControlMock.mock.calls.length;
    const ok = await state.switchRole(UNION_ROLE);
    expect(ok).toBe(false);
    expect(fetchAccessControlMock.mock.calls.length).toBe(calls);
    expect(useSessionStore.getState().error).toContain('不能使用合并角色');
  });

  it('roleMode 缺失（falsy）按原生缺省 default 处理', async () => {
    writeStoredToken('restored-token');
    checkSessionMock.mockResolvedValue(USER);
    fetchAccessControlMock.mockResolvedValue(accessData({ roleMode: undefined as unknown as string }));

    await useSessionStore.getState().bootstrap();

    expect(useSessionStore.getState().roleMode).toBe('default');
  });
});

describe('角色失效与会话失效的状态机', () => {
  async function signInAsMultiRole() {
    signInMock.mockResolvedValue({ user: USER, token: 'multi-token' });
    checkSessionMock.mockResolvedValue(USER);
    fetchAccessControlMock.mockResolvedValue(accessData());
    await useSessionStore.getState().signIn({ email: USER.email!, password: 'secret' });
  }

  it('角色失效：清本地选择与旧权限，保留令牌，重新读本人角色与权限', async () => {
    await signInAsMultiRole();
    expect(useSessionStore.getState().access).not.toBeNull();

    checkSessionMock.mockResolvedValue(USER);
    fetchAccessControlMock.mockResolvedValue(accessData({ role: 'crewloom_p1_admin' }));

    await useSessionStore.getState().handleRoleInvalid();

    const state = useSessionStore.getState();
    expect(state.status).toBe('authenticated');
    expect(state.activeRole).toBeNull();
    expect(window.localStorage.getItem('crewloom.session.role')).toBeNull();
    expect(state.access?.role).toBe('crewloom_p1_admin');
    expect(state.accessState).toBe('ready');
    expect(state.notice?.kind).toBe('warning');
    expect(getAuthContext().token).toBe('multi-token');
  });

  it('角色失效恢复过程中旧权限不被保留（先清空再读取）', async () => {
    await signInAsMultiRole();
    let observedAccessDuringRecovery: unknown = 'unset';
    checkSessionMock.mockImplementation(async () => {
      observedAccessDuringRecovery = useSessionStore.getState().access;
      return USER;
    });
    fetchAccessControlMock.mockResolvedValue(accessData({ role: 'crewloom_p1_admin' }));

    await useSessionStore.getState().handleRoleInvalid();

    expect(observedAccessDuringRecovery).toBeNull();
  });

  it('会话失效：清令牌、角色与权限，回到未登录', async () => {
    await signInAsMultiRole();

    useSessionStore.getState().handleSessionExpired();

    const state = useSessionStore.getState();
    expect(state.status).toBe('anonymous');
    expect(state.access).toBeNull();
    expect(state.roles).toEqual([]);
    expect(readStoredToken()).toBeNull();
    expect(state.notice?.kind).toBe('warning');
  });

  it('权限未知时 refreshAccess 重试成功后可恢复为 ready', async () => {
    await signInAsMultiRole();
    useSessionStore.setState({ access: null, accessState: 'unknown', probes: null });
    fetchAccessControlMock.mockResolvedValue(accessData());

    await useSessionStore.getState().refreshAccess();

    expect(useSessionStore.getState().accessState).toBe('ready');
    expect(useSessionStore.getState().access?.role).toBe('crewloom_p1_admin');
  });

  it('权限未知时 refreshAccess 再次失败仍是 unknown（不默认放行）', async () => {
    await signInAsMultiRole();
    useSessionStore.setState({ access: null, accessState: 'unknown', probes: null });
    fetchAccessControlMock.mockRejectedValue(
      new CrewloomError({ kind: 'network', userMessage: '无法连接到服务，请检查网络后重试。', detail: 'ECONNREFUSED' }),
    );

    await useSessionStore.getState().refreshAccess();

    expect(useSessionStore.getState().accessState).toBe('unknown');
    expect(useSessionStore.getState().access).toBeNull();
  });
});

describe('旧请求不能覆盖新角色状态', () => {
  it('角色切换期间返回的过期探测结果被丢弃', async () => {
    signInMock.mockResolvedValue({ user: USER, token: 'multi-token' });
    checkSessionMock.mockResolvedValue(USER);
    fetchAccessControlMock.mockResolvedValue(accessData());
    await useSessionStore.getState().signIn({ email: USER.email!, password: 'secret' });

    let releaseFirstProbe: ((value: Record<string, { status: 'allowed' | 'denied' | 'unknown' }>) => void) | undefined;
    let callCount = 0;
    probeMock.mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return new Promise((res) => {
          releaseFirstProbe = res as typeof releaseFirstProbe;
        });
      }
      return Promise.resolve({ 'workbench.read': { status: 'allowed' } });
    });

    const staleProbe = useSessionStore.getState().refreshProbes();
    fetchAccessControlMock.mockResolvedValueOnce(
      accessData({ role: 'crewloom_p1_limited', snippets: [], strategy: null }),
    );
    const switched = await useSessionStore.getState().switchRole('crewloom_p1_limited');
    expect(switched).toBe(true);

    releaseFirstProbe?.({ 'ai.directory': { status: 'allowed' } });
    await staleProbe;

    const state = useSessionStore.getState();
    expect(state.activeRole).toBe('crewloom_p1_limited');
    expect(state.probes).not.toHaveProperty('ai.directory');
    expect(state.probes?.['workbench.read']).toEqual({ status: 'allowed' });
  });
});

describe('退出与会话清理', () => {
  it('退出会调用后端并清空本地状态与令牌', async () => {
    signInMock.mockResolvedValue({ user: USER, token: 'logout-token' });
    checkSessionMock.mockResolvedValue(USER);
    fetchAccessControlMock.mockResolvedValue(accessData());
    await useSessionStore.getState().signIn({ email: USER.email!, password: 'secret' });
    signOutMock.mockResolvedValue(undefined);

    await useSessionStore.getState().signOut();

    const state = useSessionStore.getState();
    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(state.status).toBe('anonymous');
    expect(state.user).toBeNull();
    expect(state.access).toBeNull();
    expect(state.activeRole).toBeNull();
    expect(readStoredToken()).toBeNull();
  });

  it('退出接口失败也要清空本地状态', async () => {
    signInMock.mockResolvedValue({ user: USER, token: 'logout-token' });
    checkSessionMock.mockResolvedValue(USER);
    fetchAccessControlMock.mockResolvedValue(accessData());
    await useSessionStore.getState().signIn({ email: USER.email!, password: 'secret' });
    signOutMock.mockRejectedValue(new Error('network down'));

    await useSessionStore.getState().signOut();

    expect(useSessionStore.getState().status).toBe('anonymous');
    expect(readStoredToken()).toBeNull();
  });
});

describe('登录方式来自 authenticators:publicList', () => {
  it('加载失败时进入 error 状态并保留重试入口', async () => {
    fetchPublicAuthenticatorsMock.mockRejectedValue(new Error('offline'));
    await useSessionStore.getState().loadAuthenticators();
    expect(useSessionStore.getState().authenticatorState).toBe('error');
    expect(useSessionStore.getState().authenticators).toEqual([]);
  });

  it('加载成功后选择邮件/密码认证方式', async () => {
    fetchPublicAuthenticatorsMock.mockResolvedValue([
      { name: 'oidc', authType: 'oidc' },
      { name: 'basic', authType: 'email' },
    ]);
    await useSessionStore.getState().loadAuthenticators();
    expect(useSessionStore.getState().authenticatorState).toBe('ready');
    expect(resolveAuthenticator(useSessionStore.getState().authenticators)).toBe('basic');
  });

  it('没有列表时返回 undefined（不硬编码认证方式）', () => {
    expect(resolveAuthenticator([])).toBeUndefined();
  });
});
