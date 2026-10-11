/**
 * 用户与权限模块（组 B）的类型。
 *
 * 字段名来自 **13000（2.2.20）真实只读响应**，见
 * `docs/acceptance/full-pages-13000/group-b-evidence/live-metadata-discovery-13000.json`
 * 与 `live-metadata-discovery2-13000.json`。这里不做字段推断，也不从响应键猜表结构：
 * 集合/字段的真实元数据由 `collections` / `fields` 接口返回（见 datasource 模块）。
 */

export interface RoleRef {
  name: string;
  title?: string | null;
  description?: string | null;
  default?: boolean;
  hidden?: boolean;
  allowConfigure?: boolean | null;
  allowNewAiEmployee?: boolean | null;
  /** `through` 表 `rolesUsers` 的附加信息（`appends[]=roles` 时出现）。 */
  rolesUsers?: { default?: boolean | null } | null;
}

export interface UserRecord {
  id: number;
  nickname?: string | null;
  username?: string | null;
  email?: string | null;
  phone?: string | null;
  appLang?: string | null;
  passwordChangeTz?: string | null;
  createdAt?: string;
  updatedAt?: string;
  roles?: RoleRef[] | null;
  /** `users.avatar`：文件字段（belongsTo `attachments`），不是字符串。 */
  avatar?: { id?: number | string | null; url?: string | null; preview?: string | null; title?: string | null } | null;
  /**
   * `users.mainDepartmentId`：`plugin-departments` 启用后才注册的字段。
   * 安装前后端不返回该键；页面据此判断"主部门"能力是否已开通，不预置默认值。
   */
  mainDepartmentId?: number | null;
}

export interface RoleRecord {
  name: string;
  title?: string | null;
  description?: string | null;
  strategy?: unknown;
  default?: boolean;
  hidden?: boolean;
  allowConfigure?: boolean;
  allowNewMenu?: boolean;
  allowNewMobileMenu?: boolean;
  allowNewAiEmployee?: boolean;
  snippets?: string[] | null;
  createdAt?: string;
  updatedAt?: string;
}

export type RoleModeValue = 'default' | 'allow-use-union' | 'only-use-union';

/** `rolesUsers`（m2m through，主键非 id）。 */
export interface RolesUserRow {
  roleName: string;
  userId: number;
  default?: boolean | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface AvailableAction {
  name: string;
  displayName?: string | null;
  type?: string | null;
  aliases?: string[] | null;
  allowConfigureFields?: boolean;
  onNewRecord?: boolean;
}

/** `dataSourcesRolesResources`（现行权限存储；不是 legacy `rolesResources`）。 */
export interface RolesResourceRow {
  id: number;
  dataSourceKey: string;
  roleName: string;
  name: string;
  usingActionsConfig?: boolean;
}

export interface RolesResourceActionRow {
  id: number;
  name: string;
  fields?: string[] | null;
  scopeId?: number | null;
  rolesResourceId: number;
  scope?: RolesResourceScopeRow | null;
}

export interface RolesResourceScopeRow {
  id: number;
  key: string;
  dataSourceKey: string;
  name: string;
  resourceName: string;
  /** 原生过滤条件对象（`parseFilter` 语义）。空对象代表"全部记录"。 */
  scope?: Record<string, unknown> | null;
}

/** `roles/<role>/collections:list` 的行（角色在集合维度的配置状态）。 */
export interface RoleCollectionConfigRow {
  type?: string;
  name: string;
  collectionName?: string;
  title?: string | null;
  roleName?: string;
  usingConfig?: string | null;
  exists?: boolean;
}

/** 原低代码页面路由（`desktopRoutes`）。 */
export interface DesktopRouteRow {
  id: number;
  parentId?: number | null;
  title?: string | null;
  type?: string | null;
  icon?: string | null;
  schemaUid?: string | null;
  menuSchemaUid?: string | null;
  tabSchemaName?: string | null;
  sort?: number | null;
  hideInMenu?: boolean | null;
  hidden?: boolean | null;
  /** `roles/<role>/desktopRoutes:list` 的关联标记。 */
  rolesDesktopRoutes?: unknown;
  _pivot_?: unknown;
}

/** `departments`（插件在 13000 为 disabled；字段是自定义的）。 */
export interface DepartmentRecord {
  id: number;
  parentId?: number | null;
  name?: string | null;
  dept_code?: string | null;
  organization_id?: number | null;
  status?: string | null;
  notes?: string | null;
  /** 插件启用后才出现的字段（`title`/`isLeaf`）；安装前不返回。 */
  title?: string | null;
  isLeaf?: boolean | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface OrganizationRecord {
  id: number;
  name?: string | null;
  org_code?: string | null;
  status?: string | null;
  notes?: string | null;
}

export interface AiEmployeeToolSetting {
  name: string;
  autoCall?: boolean;
  [key: string]: unknown;
}

export interface AiEmployeeRecord {
  username: string;
  nickname?: string | null;
  position?: string | null;
  enabled?: boolean;
  builtIn?: boolean;
  deprecated?: boolean | null;
  category?: string | null;
  skillSettings?: { tools?: AiEmployeeToolSetting[]; toolsVersion?: unknown } | null;
  modelSettings?: { models?: Array<{ model?: string; llmService?: string }>; enabled?: boolean } | null;
  rolesAiEmployees?: unknown;
  _pivot_?: unknown;
}
