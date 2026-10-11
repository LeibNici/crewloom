/**
 * 统一错误模型。
 *
 * 前端不向用户展示原始报错、HTTP 状态码、API 路径或内部英文标识；
 * 用户文案统一由 `toUserMessage()` 从这里的分类生成。
 * 原始技术细节只保留在 `detail` 中，供开发日志与验收文档使用。
 *
 * 401 的细分依据 NocoBase 2.2.22 固定源码（提交 a4eac04d…）：
 *  - 角色失效：`plugin-acl/src/server/middlewares/setCurrentRole.ts` 抛
 *    `ROLE_NOT_FOUND_FOR_USER`（X-Role 不属于该用户）与 `ROLE_NOT_FOUND_ERR`（生效角色集合为空）；
 *    原生客户端 `core/client/src/api-client/APIClient.ts:139-149` 收到这两个码时只清角色并回落默认角色。
 *  - 真正会话失效：`plugin-auth/src/client/interceptors.ts` 的 `AuthErrorCode`
 *    （EMPTY_TOKEN / EXPIRED_TOKEN / INVALID_TOKEN / TOKEN_RENEW_FAILED / BLOCKED_TOKEN /
 *      EXPIRED_SESSION / NOT_EXIST_USER / SKIP_TOKEN_RENEW / USER_HAS_NO_ROLES_ERR）→ 清 token 重新登录。
 * 因此 401 不能一律当成"会话失效"，也不能一律当成"无权限"。
 */

export type CrewloomErrorKind =
  | 'unauthenticated' // 未登录 / 会话失效（AuthErrorCode）
  | 'role-invalid' // 角色失效（ROLE_NOT_FOUND_*）：保留会话，清角色后重新读本人角色
  | 'forbidden' // 已登录但被明确拒绝（403）
  | 'not-found'
  | 'conflict'
  | 'invalid-input'
  | 'rate-limited'
  | 'backend-unavailable' // 5xx：无法确认结果
  | 'network' // 连接失败 / 超时 / 中断：无法确认结果
  | 'unexpected';

/**
 * 权限探测的三分类结果。
 *
 * 关键约束："不隐藏入口"不等于"给未知权限放行"：
 *  - denied：后端明确拒绝（403），不显示入口、深链说明无权限；
 *  - auth-invalid：401 且属会话或角色失效，先按会话/角色状态机处理，不算"无权限"；
 *  - unknown：网络、超时、5xx、其它未判定错误 → 保持未知，可重试，不放行。
 */
export type FailureClass = 'denied' | 'auth-invalid' | 'unknown';

export interface CrewloomErrorOptions {
  kind: CrewloomErrorKind;
  /** 面向用户的自然中文提示（不出现状态码、路径、内部标识）。 */
  userMessage: string;
  /** 技术细节：仅用于开发日志、测试与验收记录。 */
  detail?: string;
  status?: number;
  /** 后端返回的错误码，例如 EMPTY_TOKEN / ROLE_NOT_FOUND_FOR_USER。 */
  code?: string;
}

export class CrewloomError extends Error {
  readonly kind: CrewloomErrorKind;
  readonly userMessage: string;
  readonly detail?: string;
  readonly status?: number;
  readonly code?: string;

  constructor(options: CrewloomErrorOptions) {
    super(options.detail ?? options.userMessage);
    this.name = 'CrewloomError';
    this.kind = options.kind;
    this.userMessage = options.userMessage;
    this.detail = options.detail;
    this.status = options.status;
    this.code = options.code;
  }

  get isUnauthenticated(): boolean {
    return this.kind === 'unauthenticated';
  }

  get isRoleInvalid(): boolean {
    return this.kind === 'role-invalid';
  }

  /** 结论是否"已由后端判定"；未知类错误不能当作拒绝。 */
  get isDefinitive(): boolean {
    return this.kind === 'forbidden' || this.kind === 'not-found';
  }
}

/** 后端会话相关的错误码（证据：core/auth/src/base/auth.ts 与 plugin-auth 的 AuthErrorCode）。 */
export const SESSION_ERROR_CODES = [
  'EMPTY_TOKEN',
  'EXPIRED_TOKEN',
  'INVALID_TOKEN',
  'TOKEN_RENEW_FAILED',
  'BLOCKED_TOKEN',
  'EXPIRED_SESSION',
  'NOT_EXIST_USER',
  'SKIP_TOKEN_RENEW',
  'USER_HAS_NO_ROLES_ERR',
] as const;

/**
 * 角色失效错误码（证据：plugin-acl/src/server/middlewares/setCurrentRole.ts）。
 *
 * 注意：`USER_HAS_NO_ROLES_ERR` 虽然也在 `setCurrentRole` 抛出，但原生 `plugin-auth`
 * 把它列入 `AuthErrorCode` 并按会话失效处理（清 token），因此这里归入会话错误码。
 */
export const ROLE_ERROR_CODES = ['ROLE_NOT_FOUND_FOR_USER', 'ROLE_NOT_FOUND_ERR'] as const;

/** 后端可能以 `TOKEN_INVALID` / `USER_LOCKED` 形式返回的会话失效（core/client APIClient 判定）。 */
export const LEGACY_SESSION_ERROR_CODES = ['TOKEN_INVALID', 'USER_LOCKED'] as const;

export function isSessionErrorCode(code: string | undefined): boolean {
  if (!code) return false;
  return (
    (SESSION_ERROR_CODES as readonly string[]).includes(code) ||
    (LEGACY_SESSION_ERROR_CODES as readonly string[]).includes(code)
  );
}

export function isRoleErrorCode(code: string | undefined): boolean {
  return !!code && (ROLE_ERROR_CODES as readonly string[]).includes(code);
}

/** 后端错误响应体形状：`{ errors: [{ message, code }] }`，少数情况为 `{ error: {...} }`。 */
function firstErrorEntry(body: unknown): Record<string, unknown> | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const record = body as { errors?: unknown; error?: unknown };
  if (Array.isArray(record.errors) && record.errors.length > 0) {
    const first = record.errors[0];
    if (first && typeof first === 'object') return first as Record<string, unknown>;
    if (typeof first === 'string') return { message: first };
  }
  if (record.error && typeof record.error === 'object') {
    return record.error as Record<string, unknown>;
  }
  return undefined;
}

export function extractServerCode(body: unknown): string | undefined {
  const entry = firstErrorEntry(body);
  const code = entry?.code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}

export function extractServerMessage(body: unknown): string | undefined {
  const entry = firstErrorEntry(body);
  const message = entry?.message;
  return typeof message === 'string' && message.length > 0 ? message : undefined;
}

export interface HttpResponseLike {
  status: number;
  data: unknown;
  headers?: Record<string, string>;
}

const ROLE_INVALID_MESSAGE = '你正在使用的角色已不可用，已为你切换回账号当前可用的角色。';

/**
 * 把 axios/HTTP 层的结果映射为 CrewloomError（不修改响应本身）。
 * 401 的角色失效与会话失效区分、403 的明确拒绝都在这里完成。
 */
export function classifyHttpResponse(response: HttpResponseLike): CrewloomError | undefined {
  const { status, data } = response;
  if (status < 400) return undefined;

  const code = extractServerCode(data);
  const serverMessage = extractServerMessage(data);
  const detail = [serverMessage ?? `HTTP ${status}`, code].filter(Boolean).join(' / ');

  if (status === 401) {
    if (isRoleErrorCode(code)) {
      return new CrewloomError({
        kind: 'role-invalid',
        userMessage: ROLE_INVALID_MESSAGE,
        detail,
        status,
        code,
      });
    }
    return new CrewloomError({
      kind: 'unauthenticated',
      userMessage: '登录状态已失效，请重新登录后继续。',
      detail,
      status,
      code,
    });
  }
  if (status === 403) {
    return new CrewloomError({
      kind: 'forbidden',
      userMessage: '当前账号没有执行此操作的权限。如确需使用，请联系管理员调整角色或权限。',
      detail,
      status,
      code,
    });
  }
  if (status === 404) {
    return new CrewloomError({
      kind: 'not-found',
      userMessage: '没有找到对应的内容，它可能已被删除或链接已失效。',
      detail,
      status,
      code,
    });
  }
  if (status === 409) {
    return new CrewloomError({
      kind: 'conflict',
      userMessage: '该内容已被处理或正在被其他人处理，请刷新后查看最新状态。',
      detail,
      status,
      code,
    });
  }
  if (status === 400 || status === 422) {
    return new CrewloomError({
      kind: 'invalid-input',
      userMessage: '提交的内容未通过校验，请检查填写项后重试。',
      detail,
      status,
      code,
    });
  }
  if (status === 429) {
    return new CrewloomError({
      kind: 'rate-limited',
      userMessage: '操作过于频繁，请稍等片刻再试。',
      detail,
      status,
      code,
    });
  }
  if (status >= 500) {
    return new CrewloomError({
      kind: 'backend-unavailable',
      userMessage: '服务暂时不可用，请稍后重试；如持续出现，请联系管理员。',
      detail,
      status,
      code,
    });
  }
  return new CrewloomError({
    kind: 'unexpected',
    userMessage: '操作未能完成，请重试；如持续出现，请联系管理员。',
    detail,
    status,
    code,
  });
}

/** 网络层错误（无法连接、超时、请求被中断）。 */
export function classifyNetworkError(detail: string): CrewloomError {
  return new CrewloomError({
    kind: 'network',
    userMessage: '无法连接到服务，请检查网络后重试。',
    detail,
  });
}

/** 权限结论的三分类：明确拒绝 / 认证或角色失效 / 无法确认。 */
export function classifyFailure(error: unknown): FailureClass {
  if (error instanceof CrewloomError) {
    if (error.kind === 'forbidden') return 'denied';
    if (error.kind === 'unauthenticated' || error.kind === 'role-invalid') return 'auth-invalid';
    return 'unknown';
  }
  return 'unknown';
}

/** 界面上的"暂时无法确认"状态：可重试，但不放行。 */
export function isUnknownFailure(error: unknown): boolean {
  return classifyFailure(error) === 'unknown';
}

/** 可重试的未知状态文案（不出现状态码、路径或内部标识）。 */
export const UNKNOWN_PERMISSION_MESSAGE = '暂时无法确认当前角色的可用范围，请稍后重试。';

export function toUserMessage(error: unknown): string {
  if (error instanceof CrewloomError) return error.userMessage;
  return '操作未能完成，请重试；如持续出现，请联系管理员。';
}

const CJK_PATTERN = /[\u3400-\u9fff]/;

/**
 * 给**原生组件**（不经 `toCrewloomError` 的 SDK 直连调用）用的用户文案。
 *
 * 背景：原生 `plugin-workflow` 的 `TestRunButton`、`NodeConfigDrawer` 等直接读 axios 的
 * `error.message`，不经过本项目的 `toCrewloomError`；实测权限/服务端错误会显示
 * `Request failed with status code 403` 这类原始英文（违反本项目"界面不展示原始报错"的约定）。
 *
 * 规则：
 *  - 后端 errors[0].message 是中文（本项目的后端适配与 NocoBase 业务错误都是中文）→ 用它，保留具体原因；
 *  - 否则用 `classifyHttpResponse` 生成的分类中文文案，绝不把原始英文/状态码交给界面。
 */
export function userFacingHttpMessage(
  status: number,
  data: unknown,
): { userMessage: string; detail?: string; code?: string } | undefined {
  const classified = classifyHttpResponse({ status, data });
  if (!classified) return undefined;
  const serverMessage = extractServerMessage(data);
  const useServerMessage = Boolean(serverMessage) && CJK_PATTERN.test(serverMessage as string);
  return {
    userMessage: useServerMessage ? (serverMessage as string) : classified.userMessage,
    detail: classified.detail,
    code: classified.code,
  };
}

export function toErrorKind(error: unknown): CrewloomErrorKind {
  if (error instanceof CrewloomError) return error.kind;
  return 'unexpected';
}

/**
 * 登录失败的用户提示。
 *
 * 后端对"账号不存在"和"密码错误"都返回 401，前端不区分二者（避免账号枚举），
 * 统一提示为账号或密码不正确。
 */
export function signInErrorMessage(error: unknown): string {
  if (error instanceof CrewloomError) {
    switch (error.kind) {
      case 'unauthenticated':
        return '邮箱、用户名或密码不正确，请重新输入。';
      case 'role-invalid':
        return '账号的角色配置有变化，请联系管理员确认后再试。';
      case 'forbidden':
        return '当前访问来源不被允许登录，请联系管理员确认访问地址。';
      case 'invalid-input':
        return '请输入有效的邮箱或用户名与密码。';
      case 'rate-limited':
        return '尝试次数过多，请稍等片刻再试。';
      case 'backend-unavailable':
        return '服务暂时不可用，请稍后重试；如持续出现，请联系管理员。';
      case 'network':
        return '无法连接到服务，请检查网络后重试。';
      default:
        return '登录未能完成，请重试；如持续出现，请联系管理员。';
    }
  }
  return '登录未能完成，请重试；如持续出现，请联系管理员。';
}
