import { api } from '../api/client';
import { CrewloomError } from '../api/errors';
import type {
  AccessControlData,
  AuthenticatorPublic,
  CurrentUser,
  SignInPayload,
  SignInResult,
  UserRoleSummary,
} from './types';

/** 认证与权限相关接口的薄封装，集中记录真实资源动作与参数。 */

/**
 * 登录。
 *
 * 走 SDK 的**请求管线**（`api.request` → SDK 的 axios 实例）而不是 `Auth.signIn` 便捷方法：
 * 后者会在 `await` 之后自行写当前存储（`setAuthenticator`/`setToken`），
 * 一旦响应晚于换号返回，就会把旧令牌写进新会话。这里只发请求，登录结果由
 * `auth/store.ts` 在**操作 ID 校验之后**写入存储。
 *
 * `authenticator` 来自 `authenticators:publicList`，不硬编码 `basic`。
 * 登录失败的 401 是"账号或口令不正确"，不是会话失效，因此不广播全局副作用。
 */
export async function signIn(payload: SignInPayload, authenticator?: string): Promise<SignInResult> {
  const headers: Record<string, string> = {};
  if (authenticator) headers['X-Authenticator'] = authenticator;
  const result = await api.request<SignInResult>(
    {
      method: 'post',
      url: 'auth:signIn',
      data: { email: payload.email, password: payload.password },
      headers,
    },
    { broadcast: false },
  );
  const data = result.data;
  if (!data || typeof data.token !== 'string' || !data.user) {
    throw new CrewloomError({
      kind: 'unexpected',
      userMessage: '登录未能完成，请重试；如持续出现，请联系管理员。',
      detail: 'sign-in response missing token or user',
    });
  }
  return data;
}

/**
 * 退出。
 *
 * 同样走 SDK 请求管线（POST `auth:signOut`），不在 SDK 层自动清存储：
 * 本地令牌/角色/认证方式由 `auth/store.ts` 在操作 ID 校验之后清理，
 * 避免"旧退出响应晚于换号返回"时清掉新账号的会话。
 */
export async function signOut(): Promise<void> {
  await api.request({ method: 'post', url: 'auth:signOut' }, { broadcast: false });
}

/** GET /api/auth:check —— 当前用户（含全部所属角色 `roles`）。 */
export async function checkSession(): Promise<CurrentUser> {
  const result = await api.resourceAction<CurrentUser>('auth', 'check');
  return result.data;
}

/**
 * GET /api/authenticators:publicList —— 可用的登录方式（登录页据此渲染）。
 *
 * 这一步是原生登录页的来源（`plugin-auth/src/client-v2/.../AuthenticatorsContextProvider.tsx`
 * 调 `resource('authenticators').publicList()`）。本轮**只用**它来取得当前唯一
 * Email/Password 认证方式的 `name`，不据此扩展 OIDC/短信等其它登录方式。
 */
export async function fetchPublicAuthenticators(): Promise<AuthenticatorPublic[]> {
  const result = await api.resourceAction<AuthenticatorPublic[]>('authenticators', 'publicList');
  return Array.isArray(result.data) ? result.data : [];
}

/** GET /api/roles:check —— 当前生效角色的合并权限上下文（角色由 SDK 的 X-Role 决定）。 */
export async function fetchAccessControl(): Promise<AccessControlData> {
  const result = await api.resourceAction<AccessControlData>('roles', 'check');
  return result.data;
}

export interface ChangePasswordPayload {
  oldPassword: string;
  newPassword: string;
  confirmPassword: string;
}

/**
 * 修改自己的密码（`POST auth:changePassword`，需登录）。
 *
 * 依据 plugin-auth `actions/auth.ts`：
 *  - 请求体就是 `values`（本层 `resourceAction` 会把 `values` 展开成请求体），
 *    服务端校验 `newPassword === confirmPassword`，并用 `oldPassword` 校验本人身份；
 *  - 后端系统设置里 `enableChangePassword === false` 时返回 403（能力未开通）；
 *  - 旧密码不正确返回 401。这里**不区分**"账号/口令错误"的文案，避免误导用户以为会话失效。
 *
 * `broadcast: false` 是必须的：这个动作的 401 表示"旧密码不正确"，
 * 如果按会话失效广播，用户输错一次旧密码就会被登出。
 */
export async function changePassword(payload: ChangePasswordPayload): Promise<void> {
  await api.resourceAction('auth', 'changePassword', { values: { ...payload } }, { broadcast: false });
}

/** 修改密码失败的用户文案（区分"旧密码不对"和"后台不允许改密"）。 */
export function changePasswordErrorMessage(error: unknown): string {
  if (error instanceof CrewloomError) {
    if (error.status === 401) return '原密码不正确，请重新输入。';
    if (error.status === 403) return '当前后台未允许自助修改密码，请联系管理员协助。';
    if (error.status === 400) return '新密码不符合要求，或两次输入不一致，请重新填写。';
    return error.userMessage;
  }
  return '密码未能修改，请重试；如持续出现，请联系管理员。';
}

/**
 * 申请重置密码（`POST auth:lostPassword`，匿名可调用）。
 *
 * 该动作会让后端**真实发送重置邮件**，因此只允许真实用户在登录页主动提交；
 * 自动验证一律不调用。`X-Authenticator` 必须显式带上（服务端缺该头会 400），
 * 登录页尚未建立会话时 SDK 里也可能还没有这个值。
 */
export async function requestPasswordReset(email: string, authenticator: string): Promise<void> {
  await api.request(
    {
      method: 'post',
      url: 'auth:lostPassword',
      data: { email, baseURL: typeof window === 'undefined' ? undefined : window.location.origin },
      headers: { 'X-Authenticator': authenticator },
    },
    { broadcast: false },
  );
}

/**
 * 自助找回密码的能力判断。
 *
 * 依据 plugin-auth `basic-auth.ts` 的 `lostPassword()`：服务端要求
 *  - 认证方式的公开选项里 `enableResetPassword === true`（否则 403「Not allowed to reset password」）；
 *  - 并配置了可用的通知渠道（13000 上 `notification-email` 未启用，因此即使打开开关也发不出信）。
 *
 * 前端只能读到公开选项这一层，所以：
 *  - `enableResetPassword === true` → 显示"找回密码"入口；
 *  - 否则 → 显示"当前未开通自助找回，请联系管理员"，**不显示假入口**。
 */
export function describePasswordRecovery(
  authenticators: AuthenticatorPublic[],
  authenticatorName?: string,
): { available: boolean; authenticator: string | null; reason: string | null } {
  const target =
    (authenticatorName && authenticators.find((item) => item.name === authenticatorName)) ?? authenticators[0];
  if (!target) {
    return { available: false, authenticator: null, reason: '暂时无法确认可用的登录方式，请稍后重试。' };
  }
  const enabled = target.options?.enableResetPassword === true;
  return {
    available: enabled,
    authenticator: target.name,
    reason: enabled ? null : '当前未开通自助找回密码，请联系管理员协助重置。',
  };
}

/**
 * 当前用户的全部所属角色，唯一来源是 `auth:check` 返回的 `data.roles`。
 *
 * 不读取 `users/<id>/roles:list`、`roles:view` 或"换默认角色再查询"这类回退：
 * 那些路径需要额外资源权限，且不是原生角色切换 UI 的来源。
 */
export function readOwnRoles(user: CurrentUser | null | undefined): UserRoleSummary[] {
  const roles = user?.roles;
  if (!Array.isArray(roles)) return [];
  return roles
    .filter((role): role is UserRoleSummary => !!role && typeof role.name === 'string' && role.name.length > 0)
    .map((role) => ({
      name: role.name,
      title: typeof role.title === 'string' ? role.title : role.title ?? null,
      hidden: role.hidden,
      default: role.default,
    }));
}
