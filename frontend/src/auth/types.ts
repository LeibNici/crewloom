/** 当前用户、角色与 ACL 上下文的类型定义。 */

/**
 * 一条"用户所属角色"。
 *
 * 来源是原生 `GET /api/auth:check` 的 `data.roles`（该用户**全部所属角色**，含 `name`/`title`），
 * 不需要 `roles:view`；原生角色切换 UI（client-v2 SwitchRoleItemModel、v1 SwitchRole）用的就是它。
 */
export interface UserRoleSummary {
  name: string;
  title?: string | null;
  default?: boolean;
  hidden?: boolean;
  allowConfigure?: boolean | null;
  allowNewAiEmployee?: boolean | null;
}

export interface CurrentUser {
  id: number;
  nickname?: string | null;
  username?: string | null;
  email?: string | null;
  phone?: string | null;
  appLang?: string | null;
  /** `auth:check` 直接返回的全部所属角色（候选的唯一来源）。 */
  roles?: UserRoleSummary[] | null;
}

/** `GET /api/authenticators:publicList` 的一条记录（原生登录页据此渲染登录方式）。 */
export interface AuthenticatorPublic {
  name: string;
  authType?: string | null;
  title?: string | null;
  options?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export type RoleMode = 'default' | 'allow-use-union' | 'only-use-union' | string;

export type RoleStrategy = string | { actions?: string[] } | null;

/** roles:check 的响应体（证据：plugin-acl/src/server/actions/role-check.ts）。 */
export interface AccessControlData {
  /** 当前生效角色：角色名、`__union__` 或 `anonymous`。 */
  role: string;
  roleMode: RoleMode;
  /** 该角色允许的动作名列表（默认资源层面的策略）。 */
  strategy: RoleStrategy;
  /** 已明确配置的资源权限：`"<resource>:<action>" -> 参数`；`!` 前缀表示否定。 */
  actions: Record<string, unknown>;
  /** 已明确配置的资源名列表。 */
  resources: string[];
  snippets: string[];
  /** 是否 root（后端 allowAll 旁路）。 */
  allowAll: boolean;
  allowConfigure: boolean;
  allowAnonymous: boolean;
  allowMenuItemIds: Array<string | number>;
  uiButtonSchemasBlacklist: Array<string | number>;
  availableActions: string[];
  /** 动作别名：如 list → view、move → update。 */
  actionAlias: Record<string, string>;
  /**
   * **当前生效**的角色集合（切到某角色后通常只有它自己，union 模式为全部所属角色）。
   * **不是**该用户全部所属角色；全部所属角色来自 `auth:check.data.roles`。
   */
  roles: string[];
}

export interface SignInPayload {
  email: string;
  password: string;
}

export interface SignInResult {
  user: CurrentUser;
  token: string;
}
