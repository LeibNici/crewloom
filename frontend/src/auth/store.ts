import { create } from 'zustand';
import {
  checkSession,
  fetchAccessControl,
  fetchPublicAuthenticators,
  readOwnRoles,
  signIn as signInRequest,
  signOut as signOutRequest,
} from './api';
import type { AccessControlData, AuthenticatorPublic, CurrentUser, UserRoleSummary } from './types';
import { CrewloomError, UNKNOWN_PERMISSION_MESSAGE, signInErrorMessage, toUserMessage } from '../api/errors';
import { getAuthContext, setAuthContext } from '../api/client';
import {
  isUnionAllowed,
  mustUseUnion,
  normalizeRoleMode,
  UNION_ROLE,
  type RoleModeKind,
} from '../permissions/model';
import { clearStoredRole, readStoredAuthenticator, readStoredToken, readStoredRole } from './storage';
import { runAccessProbes, type ProbeResults } from '../permissions/probes';

export type SessionStatus = 'idle' | 'booting' | 'unavailable' | 'anonymous' | 'authenticated';

/**
 * 认证操作序号（operation id）。
 *
 * 登录/退出/会话失效都会自增；异步操作在**每个 await 之后**重新比对自己的序号，
 * 一旦被更新的操作取代，就放弃写入会话状态与存储。
 *
 * 为什么需要它：`Auth.signIn/signOut` 之类的异步流程在响应回来之后才写存储，
 * 而"退出请求还在途中时发生真正会话失效、随后又登录了另一个账号"是实际可达的顺序
 * （见 tests/auth-async-isolation.test.ts 场景 A）。仅靠 UI 按钮串行化不是保护机制。
 */
let authOpSeq = 0;

export interface SessionNotice {
  kind: 'info' | 'warning';
  message: string;
}

interface SessionState {
  status: SessionStatus;
  /** 当前令牌：真实身份以请求层（SDK Auth）为准，这里只是镜像，绝不进入日志。 */
  token: string | null;
  user: CurrentUser | null;
  /** 候选角色：唯一来源是 `auth:check.data.roles`。 */
  roles: UserRoleSummary[];
  access: AccessControlData | null;
  /**
   * 显式选择的角色（X-Role 值）。
   * null 表示"未显式选择"，由服务端决定当前生效角色（access.role）。
   */
  activeRole: string | null;
  roleMode: RoleModeKind;
  /** 权限上下文是否已确认；`unknown` 表示网络/5xx 等导致无法确认，界面可重试且不放行。 */
  accessState: 'ready' | 'unknown';
  /** 运行期权限探测结果；null 表示尚未就绪（此时菜单不渲染，避免先显示后收回）。 */
  probes: ProbeResults | null;
  /** `authenticators:publicList` 的可用登录方式（P1 只用当前 Email/Password 一条）。 */
  authenticators: AuthenticatorPublic[];
  authenticatorState: 'idle' | 'loading' | 'ready' | 'error';
  notice: SessionNotice | null;
  error: string | null;
  /** 会话恢复时用于展示的说明（技术细节，不直接给用户）。 */
  bootDetail: string | null;

  loadAuthenticators: () => Promise<void>;
  bootstrap: () => Promise<void>;
  retryBootstrap: () => Promise<void>;
  signIn: (payload: { email: string; password: string }) => Promise<boolean>;
  signOut: () => Promise<void>;
  switchRole: (role: string) => Promise<boolean>;
  /** 运行期权限探测：会话就绪或角色切换后执行。 */
  refreshProbes: () => Promise<void>;
  /** 重新确认权限上下文（"无法确认"状态下的重试）。 */
  refreshAccess: () => Promise<void>;
  handleSessionExpired: (message?: string) => void;
  /** 角色失效（ROLE_NOT_FOUND_*）：清本地选择、保留令牌、重新读本人角色与权限。 */
  handleRoleInvalid: () => Promise<void>;
  clearNotice: () => void;
}

function errorMessage(error: unknown): { message: string; detail: string } {
  if (error instanceof CrewloomError) {
    return {
      message: error.userMessage,
      detail: `${error.kind}${error.status ? `/${error.status}` : ''}: ${error.detail ?? ''}`,
    };
  }
  return {
    message: toUserMessage(error),
    detail: error instanceof Error ? error.message : String(error),
  };
}

function isRoleInvalid(error: unknown): boolean {
  return error instanceof CrewloomError && error.isRoleInvalid;
}

function isSessionInvalid(error: unknown): boolean {
  return error instanceof CrewloomError && error.isUnauthenticated;
}

interface ResolvedAccess {
  access: AccessControlData;
  roleMode: RoleModeKind;
  activeRole: string | null;
}

/**
 * 读取权限上下文。
 *
 * `preferredRole` 为 `null` 表示不显式指定角色（由服务端决定）；为 `__union__` 时
 * 仅在 `allow-use-union` / `only-use-union` 下才会请求。服务端若回落（例如
 * `default` 模式不接受 `__union__`），本地不再保留无效的显式选择。
 */
async function loadAccessContext(preferredRole: string | null): Promise<ResolvedAccess> {
  setAuthContext({ role: preferredRole });
  let access = await fetchAccessControl();
  let roleMode = normalizeRoleMode(access.roleMode);
  if (mustUseUnion(access.roleMode)) {
    // only-use-union：服务端强制合并，本地按合并身份工作（与原生一致）。
    setAuthContext({ role: UNION_ROLE });
    access = await fetchAccessControl();
    roleMode = normalizeRoleMode(access.roleMode);
    return { access, roleMode, activeRole: UNION_ROLE };
  }
  if (preferredRole && access.role !== preferredRole) {
    // 服务端没有接受我们请求的角色：放弃显式选择，回到服务端生效角色。
    setAuthContext({ role: null });
    return { access, roleMode, activeRole: null };
  }
  return { access, roleMode, activeRole: preferredRole };
}

/**
 * 登录态存储。
 *
 * 安全边界：
 *  - 令牌只由请求层的 SDK 存储持有（浏览器 localStorage，刷新恢复用），从不写入源码、
 *    示例、构建变量或日志；报告与截图均不含令牌。
 *  - 角色切换、退出、会话失效都会清空上一个角色的权限上下文与查询缓存，
 *    避免把旧权限状态恢复回来。
 */
export const useSessionStore = create<SessionState>((set, get) => ({
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

  /**
   * 读取可用登录方式（GET authenticators:publicList，匿名可读）。
   * 失败时保持 `error` 状态并让登录页提供重试，不硬编码认证方式。
   */
  async loadAuthenticators() {
    if (get().authenticatorState === 'loading' || get().authenticatorState === 'ready') return;
    set({ authenticatorState: 'loading' });
    try {
      const list = await fetchPublicAuthenticators();
      set({ authenticators: list, authenticatorState: 'ready' });
    } catch {
      set({ authenticators: [], authenticatorState: 'error' });
    }
  },

  async bootstrap() {
    // React StrictMode 会 mount → unmount → mount；重复调用直接复用第一次的结果，
    // 避免两次会话恢复互相覆盖、重复打后端。
    if (get().status === 'booting') return;
    const token = readStoredToken();
    if (!token) {
      set({ status: 'anonymous', token: null, user: null, roles: [], access: null, activeRole: null, probes: null });
      return;
    }
    set({ status: 'booting', token, error: null, probes: null, accessState: 'unknown' });
    try {
      // 恢复会话时若本地还没有认证方式（升级/首次恢复），按原生元数据补一次；
      // 失败不阻塞（服务端有默认认证方式），也不写死 'basic'。
      if (!readStoredAuthenticator()) {
        await get().loadAuthenticators();
        const name = resolveAuthenticator(get().authenticators);
        if (name) setAuthContext({ authenticator: name });
      }
      const user = await checkSessionWithRoleRecovery();
      const preferred = readStoredRole();
      const roles = readOwnRoles(user);
      const wanted = preferred && (preferred === UNION_ROLE || roles.some((role) => role.name === preferred)) ? preferred : null;
      const resolved = await loadAccessContext(wanted);
      set({
        status: 'authenticated',
        token: getAuthContext().token,
        user,
        roles,
        access: resolved.access,
        activeRole: resolved.activeRole,
        roleMode: resolved.roleMode,
        accessState: 'ready',
        error: null,
      });
      void get().refreshProbes();
    } catch (error) {
      let finalError: unknown = error;
      if (isSessionInvalid(error)) {
        clearStoredRole();
        setAuthContext({ token: null, role: null });
        set({
          status: 'anonymous',
          token: null,
          user: null,
          roles: [],
          access: null,
          activeRole: null,
          probes: null,
          error: null,
          bootDetail: '会话已失效，需要重新登录',
        });
        return;
      }
      if (isRoleInvalid(error)) {
        // 服务端仍报角色错误：清掉本地角色选择后再试一次（保留令牌）。
        clearStoredRole();
        setAuthContext({ role: null });
        try {
          const user = await checkSession();
          const resolved = await loadAccessContext(null);
          set({
            status: 'authenticated',
            token: getAuthContext().token,
            user,
            roles: readOwnRoles(user),
            access: resolved.access,
            activeRole: resolved.activeRole,
            roleMode: resolved.roleMode,
            accessState: 'ready',
            error: null,
            notice: { kind: 'warning', message: '原来的角色已不可用，已回到账号当前可用的角色。' },
          });
          void get().refreshProbes();
          return;
        } catch (retryError) {
          finalError = isRoleInvalid(retryError)
            ? new CrewloomError({
                kind: 'role-invalid',
                userMessage: '账号当前没有可用的角色，请联系管理员。',
                detail: 'role-recovery-failed',
              })
            : retryError;
        }
      }
      const { message, detail } = errorMessage(finalError);
      if (isSessionInvalid(finalError)) {
        clearStoredRole();
        setAuthContext({ token: null, role: null });
        set({
          status: 'anonymous',
          token: null,
          user: null,
          roles: [],
          access: null,
          activeRole: null,
          probes: null,
          error: null,
          bootDetail: detail,
        });
        return;
      }
      // 网络/5xx：保留令牌，进入可重试的"无法确认"状态，绝不伪装成未登录或无权访问。
      set({
        status: 'unavailable',
        token,
        user: null,
        roles: [],
        access: null,
        activeRole: null,
        probes: null,
        accessState: 'unknown',
        error: message,
        bootDetail: detail,
        notice: { kind: 'warning', message: UNKNOWN_PERMISSION_MESSAGE },
      });
    }
  },

  async retryBootstrap() {
    set({ status: 'idle', error: null, notice: null });
    await get().bootstrap();
  },

  async signIn({ email, password }) {
    const opId = ++authOpSeq;
    set({ error: null, notice: null });
    try {
      // 新登录先清掉上一个账号/会话可能残留的显式角色选择。
      clearStoredRole();
      setAuthContext({ role: null });
      const authenticator = resolveAuthenticator(get().authenticators);
      const result = await signInRequest({ email, password }, authenticator);
      if (opId !== authOpSeq) return false;
      // 登录请求本身不在 SDK Auth 层写存储；由这里在操作 ID 校验之后写入令牌与认证方式，
      // 保证"下一实际请求"的身份来自当前这次登录。
      setAuthContext({ token: result.token, authenticator: authenticator ?? null });
      const user = await checkSessionWithRoleRecovery();
      if (opId !== authOpSeq) return false;
      const resolved = await loadAccessContext(null);
      if (opId !== authOpSeq) return false;
      set({
        status: 'authenticated',
        token: getAuthContext().token,
        user,
        roles: readOwnRoles(user),
        access: resolved.access,
        activeRole: resolved.activeRole,
        roleMode: resolved.roleMode,
        accessState: 'ready',
        error: null,
      });
      void get().refreshProbes();
      return true;
    } catch (error) {
      // 已被更新的认证操作取代：旧失败不得覆盖新会话。
      if (opId !== authOpSeq) return false;
      const { detail } = errorMessage(error);
      clearStoredRole();
      setAuthContext({ token: null, role: null, authenticator: null });
      set({
        status: 'anonymous',
        token: null,
        user: null,
        roles: [],
        access: null,
        activeRole: null,
        probes: null,
        error: signInErrorMessage(error),
        bootDetail: detail,
      });
      return false;
    }
  },

  async signOut() {
    const opId = ++authOpSeq;
    const tokenAtStart = getAuthContext().token;
    try {
      // 只发退出请求；本地会话由下面的操作 ID / 身份校验之后清理，
      // 避免 SDK Auth 便捷方法在 await 之后自动清掉已经换号的新会话。
      await signOutRequest();
    } catch {
      // 退出接口失败不阻塞本地清理：本地必须回到未登录状态。
    }
    // 期间发生了更新的认证操作（会话失效、重新登录）或身份已变 → 旧退出不得再动会话。
    if (opId !== authOpSeq) return;
    if (getAuthContext().token !== tokenAtStart) return;
    setAuthContext({ token: null, role: null, authenticator: null });
    clearStoredRole();
    set({
      status: 'anonymous',
      token: null,
      user: null,
      roles: [],
      access: null,
      activeRole: null,
      roleMode: 'default',
      accessState: 'unknown',
      probes: null,
      error: null,
      notice: { kind: 'info', message: '已退出登录。' },
    });
  },

  async switchRole(role) {
    const state = get();
    if (state.status !== 'authenticated') return false;
    const unionAvailable = isUnionAllowed(state.access?.roleMode);
    if (role === UNION_ROLE && !unionAvailable) {
      set({ error: '当前账号不能使用合并角色，请选择其中一个角色。' });
      return false;
    }
    if (role !== UNION_ROLE && !state.roles.some((item) => item.name === role)) {
      set({ error: '这个角色不属于当前账号，无法切换。' });
      return false;
    }
    const previousRole = state.activeRole;
    // 切换期间先清空探测结果：旧角色的入口状态不能在新角色下复用。
    set({ error: null, probes: null, accessState: 'unknown' });
    try {
      const resolved = await loadAccessContext(role);
      set({
        access: resolved.access,
        activeRole: resolved.activeRole,
        roleMode: resolved.roleMode,
        accessState: 'ready',
        error: null,
      });
      void get().refreshProbes();
      return true;
    } catch (error) {
      // 角色切换失败：先回到原角色，再按错误类别处理。
      setAuthContext({ role: previousRole });
      if (isRoleInvalid(error)) {
        await get().handleRoleInvalid();
        return false;
      }
      if (isSessionInvalid(error)) {
        // 会话失效由请求层事件处理（清会话并回到登录页）。
        return false;
      }
      const { message, detail } = errorMessage(error);
      set({ error: message, bootDetail: detail, probes: null, accessState: 'unknown' });
      return false;
    }
  },

  async refreshProbes() {
    const state = get();
    if (state.status !== 'authenticated') return;
    const roleAtStart = state.activeRole;
    const tokenAtStart = getAuthContext().token;
    const results = await runAccessProbes();
    const current = get();
    // 角色/账号已变化时丢弃过期结果，避免把旧权限状态写回。
    if (current.activeRole !== roleAtStart || getAuthContext().token !== tokenAtStart) return;
    set({ probes: results });
  },

  async refreshAccess() {
    const state = get();
    if (state.status !== 'authenticated' || !state.user) return;
    setAuthContext({ role: state.activeRole });
    set({ error: null });
    try {
      const resolved = await loadAccessContext(state.activeRole);
      set({
        access: resolved.access,
        activeRole: resolved.activeRole,
        roleMode: resolved.roleMode,
        accessState: 'ready',
        error: null,
        notice: null,
        probes: null,
      });
      void get().refreshProbes();
    } catch (error) {
      if (isSessionInvalid(error)) {
        get().handleSessionExpired();
        return;
      }
      if (isRoleInvalid(error)) {
        await get().handleRoleInvalid();
        return;
      }
      const { message, detail } = errorMessage(error);
      set({
        accessState: 'unknown',
        access: null,
        probes: null,
        error: message,
        bootDetail: detail,
        notice: { kind: 'warning', message: UNKNOWN_PERMISSION_MESSAGE },
      });
    }
  },

  handleSessionExpired(message) {
    // 这是会改变身份的操作：让仍在途中的登录/退出作废。
    authOpSeq += 1;
    clearStoredRole();
    setAuthContext({ token: null, role: null });
    set({
      status: 'anonymous',
      token: null,
      user: null,
      roles: [],
      access: null,
      activeRole: null,
      roleMode: 'default',
      accessState: 'unknown',
      probes: null,
      error: null,
      notice: { kind: 'warning', message: message ?? '登录状态已失效，请重新登录后继续。' },
    });
  },

  async handleRoleInvalid() {
    const state = get();
    if (state.status !== 'authenticated') return;
    const tokenAtStart = getAuthContext().token;
    // 角色失效：清本地选择与旧权限，**保留令牌**。
    clearStoredRole();
    setAuthContext({ role: null });
    set({
      access: null,
      accessState: 'unknown',
      probes: null,
      notice: { kind: 'warning', message: '原来的角色已不可用，正在重新读取你当前的权限…' },
    });
    try {
      const user = await checkSession();
      if (getAuthContext().token !== tokenAtStart) return;
      const resolved = await loadAccessContext(null);
      if (getAuthContext().token !== tokenAtStart) return;
      set({
        user,
        roles: readOwnRoles(user),
        access: resolved.access,
        activeRole: resolved.activeRole,
        roleMode: resolved.roleMode,
        accessState: 'ready',
        error: null,
        notice: { kind: 'warning', message: '原来的角色已不可用，已回到账号当前可用的角色。' },
      });
      void get().refreshProbes();
    } catch (error) {
      if (isSessionInvalid(error)) {
        get().handleSessionExpired();
        return;
      }
      const { message, detail } = errorMessage(error);
      set({
        accessState: 'unknown',
        access: null,
        probes: null,
        error: message,
        bootDetail: detail,
        notice: { kind: 'warning', message: UNKNOWN_PERMISSION_MESSAGE },
      });
    }
  },

  clearNotice() {
    set({ notice: null, error: null });
  },
}));

/** 优先选择邮件/用户名密码认证方式；多认证方式的界面选择不在 P1 范围。 */
export function resolveAuthenticator(list: AuthenticatorPublic[]): string | undefined {
  if (!Array.isArray(list) || list.length === 0) return undefined;
  const emailLike = list.find((item) => {
    const type = String(item.authType ?? '').toLowerCase();
    const name = String(item.name ?? '').toLowerCase();
    return type === 'email' || type === 'basic' || name === 'basic' || name === 'email';
  });
  return (emailLike ?? list[0]).name;
}

async function checkSessionWithRoleRecovery(): Promise<CurrentUser> {
  try {
    return await checkSession();
  } catch (error) {
    if (isRoleInvalid(error)) {
      // 本地角色选择已失效：清掉它（保留令牌）后重新读取本人角色。
      clearStoredRole();
      setAuthContext({ role: null });
      return await checkSession();
    }
    throw error;
  }
}
