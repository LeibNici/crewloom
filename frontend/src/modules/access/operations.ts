import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api, associatedAction, resourceAction, resourceList } from '../../api/client';
import { CrewloomError, toUserMessage } from '../../api/errors';
import type { ResourceState } from '../../api/hooks';
import type { ApiListMeta, ListParams } from '../../api/types';
import type {
  AiEmployeeRecord,
  AvailableAction,
  DepartmentRecord,
  DesktopRouteRow,
  OrganizationRecord,
  RoleCollectionConfigRow,
  RoleRecord,
  RolesResourceActionRow,
  RolesResourceRow,
  RolesResourceScopeRow,
  RolesUserRow,
  UserRecord,
} from './types';

/**
 * 组 B 的权限类请求（**只在既有请求管线上做类型化包装**）。
 *
 * 约束（与 02-foundation §6 一致）：
 *  - 全部走 `src/api/client.ts` 的 `resourceAction` / `associatedAction` / `api.request`；
 *  - 不新建请求通道、不自造 ACL 规则引擎；后端始终是最终判定者；
 *  - 写入函数只被**用户主动操作**调用；Agent 自动验证在 strict 模式下会先被传输层拦截。
 *
 * 关联资源路径按 02-foundation 与十页契约的实测形状：
 *  - `roles/<roleName>/users:add|remove`，请求体 = 用户 id 裸数组；
 *  - `roles/<roleName>/resources:update`（中间件自动补 `updateAssociationValues:['actions']`）；
 *  - `roles:applyDataPermissions`，`values={dataSourceKey,resources:[{name,usingActionsConfig,actions:[…]}]}`。
 */

function readOnlyPath<T>(path: string, params?: ListParams): Promise<{ data: T; meta?: ApiListMeta }> {
  return api.request<T>({ url: path, method: 'get', params });
}

// --- 用户（AC-01） --------------------------------------------------------

export function listUsers(params: ListParams) {
  return resourceAction<UserRecord[]>('users', 'list', { params });
}

export function listUsersExcludeRole(params: ListParams) {
  // 原生动作是 GET（`users:listExcludeRole`）；`url.ts` 的只读动作集合不含它，
  // 因此显式指定 GET，仍走同一条 SDK 管线。
  return readOnlyPath<UserRecord[]>('/users:listExcludeRole', params);
}

/** 角色候选成员列表（`users:listExcludeRole?roleName=`），同六态语义。 */
export function useUsersExcludeRole(
  roleName: string,
  options: { page?: number; pageSize?: number; filter?: Record<string, unknown>; enabled?: boolean } = {},
): AssociatedListResult<UserRecord> {
  const { page = 1, pageSize = 10, filter, enabled = true } = options;
  return useResourceActionList<UserRecord>(
    ['users', 'listExcludeRole', roleName, page, pageSize, filter ?? null],
    () => listUsersExcludeRole({ roleName, page, pageSize, filter }),
    { enabled: enabled && roleName !== '' },
  );
}

export function getUser(id: number | string, params?: ListParams) {
  return resourceAction<UserRecord>('users', 'get', { params: { ...params, filterByTk: id } });
}

/** 新建用户：`roles` 是**引用语义**（角色名数组），一次请求完成。 */
export function createUser(values: Record<string, unknown>) {
  return resourceAction<UserRecord>('users', 'create', { values });
}

/**
 * 更新用户。
 *
 * AC-01 契约：用户表单里的 `roles` 是**顶层关联字段 + 目标主键数组**（引用语义），
 * **不需要** `updateAssociationValues`；一次 `users:update` 在单事务内完成，
 * 因此不能用多次 `roles:add/remove` 替代（会失去原原子性）。
 */
export function updateUser(id: number | string, values: Record<string, unknown>) {
  return resourceAction<UserRecord>('users', 'update', { params: { filterByTk: id }, values });
}

/** 只改角色绑定：保持原用户表单语义（引用数组、单请求、不覆盖其它未知字段）。 */
export function updateUserRoles(id: number | string, roleNames: string[]) {
  return updateUser(id, { roles: roleNames });
}

export function destroyUser(id: number | string) {
  return resourceAction<unknown>('users', 'destroy', { params: { filterByTk: id } });
}

/** 用户默认角色：`users:setDefaultRole` 只能改**当前登录用户自己**（原生 handler 行为）。 */
export function setMyDefaultRole(roleName: string) {
  return resourceAction<unknown>('users', 'setDefaultRole', { values: { roleName } });
}

/** 本人改密：`auth:changePassword`，载荷 `{oldPassword,newPassword,confirmPassword}`。 */
export function changeMyPassword(values: { oldPassword: string; newPassword: string; confirmPassword: string }) {
  return resourceAction<unknown>('auth', 'changePassword', { values });
}

/** 管理员为用户改密：`users:changePassword`（原生 ChangeUserPasswordDrawer 使用的动作）。 */
export function changeUserPassword(id: number | string, values: Record<string, unknown>) {
  return resourceAction<unknown>('users', 'changePassword', { params: { filterByTk: id }, values });
}

export function listRolesUsers(params: ListParams) {
  return resourceAction<RolesUserRow[]>('rolesUsers', 'list', { params });
}

// --- 角色与成员（AC-02） --------------------------------------------------

export function listRoles(params: ListParams) {
  return resourceAction<RoleRecord[]>('roles', 'list', { params });
}

export function getRole(name: string) {
  return resourceAction<RoleRecord>('roles', 'get', { params: { filterByTk: name } });
}

export function createRole(values: Record<string, unknown>) {
  return resourceAction<RoleRecord>('roles', 'create', { values });
}

export function updateRole(name: string, values: Record<string, unknown>) {
  return resourceAction<RoleRecord>('roles', 'update', { params: { filterByTk: name }, values });
}

export function destroyRole(name: string) {
  return resourceAction<unknown>('roles', 'destroy', { params: { filterByTk: name } });
}

/** 多角色模式：`values.roleMode` ∈ default / allow-use-union / only-use-union。 */
export function setSystemRoleMode(roleMode: string) {
  return resourceAction<unknown>('roles', 'setSystemRoleMode', { values: { roleMode } });
}

export function listRoleMembers(roleName: string, params: ListParams) {
  return associatedAction<UserRecord[]>('roles', roleName, 'users', 'list', { params });
}

/** 增成员：父标识=角色名，请求体=用户 id 裸数组。 */
export function addRoleMembers(roleName: string, userIds: Array<number | string>) {
  return associatedAction<unknown>('roles', roleName, 'users', 'add', { values: userIds });
}

export function removeRoleMembers(roleName: string, userIds: Array<number | string>) {
  return associatedAction<unknown>('roles', roleName, 'users', 'remove', { values: userIds });
}

// --- 功能与入口权限（AC-03） ---------------------------------------------

export function listAvailableActions() {
  return resourceAction<AvailableAction[]>('availableActions', 'list');
}

export function listRoleCollections(roleName: string, params: ListParams) {
  return associatedAction<RoleCollectionConfigRow[]>('roles', roleName, 'collections', 'list', { params });
}

export function listDesktopRoutes(params: ListParams) {
  return resourceAction<DesktopRouteRow[]>('desktopRoutes', 'list', { params });
}

export function listRoleDesktopRoutes(roleName: string, params: ListParams) {
  return associatedAction<DesktopRouteRow[]>('roles', roleName, 'desktopRoutes', 'list', { params });
}

export function addRoleDesktopRoutes(roleName: string, routeIds: Array<number | string>) {
  return associatedAction<unknown>('roles', roleName, 'desktopRoutes', 'add', { values: routeIds });
}

export function removeRoleDesktopRoutes(roleName: string, routeIds: Array<number | string>) {
  return associatedAction<unknown>('roles', roleName, 'desktopRoutes', 'remove', { values: routeIds });
}

export function listRoleMenuUiSchemas(roleName: string, params: ListParams) {
  return associatedAction<Array<Record<string, unknown>>>('roles', roleName, 'menuUiSchemas', 'list', { params });
}

export function addRoleMenuUiSchemas(roleName: string, uids: Array<string | number>) {
  return associatedAction<unknown>('roles', roleName, 'menuUiSchemas', 'add', { values: uids });
}

export function removeRoleMenuUiSchemas(roleName: string, uids: Array<string | number>) {
  return associatedAction<unknown>('roles', roleName, 'menuUiSchemas', 'remove', { values: uids });
}

// --- 数据权限（AC-04） ----------------------------------------------------

export function listRoleResources(roleName: string, params: ListParams) {
  return associatedAction<RolesResourceRow[]>('roles', roleName, 'resources', 'list', { params });
}

export function updateRoleResource(
  roleName: string,
  resourceName: string,
  values: Record<string, unknown>,
) {
  return associatedAction<unknown>('roles', roleName, 'resources', 'update', {
    params: { filterByTk: resourceName },
    values,
  });
}

export function listRoleResourceActions(params: ListParams) {
  return resourceAction<RolesResourceActionRow[]>('dataSourcesRolesResourcesActions', 'list', { params });
}

export function listRoleResourceScopes(params: ListParams) {
  return resourceAction<RolesResourceScopeRow[]>('dataSourcesRolesResourcesScopes', 'list', { params });
}

export function createRoleResourceScope(values: Record<string, unknown>) {
  return resourceAction<RolesResourceScopeRow>('dataSourcesRolesResourcesScopes', 'create', { values });
}

/**
 * 批量保存数据权限（原生事务动作）。
 *
 * `values={dataSourceKey, resources:[{name, usingActionsConfig, actions:[{name, fields?, scopeId?|scopeKey?}]}]}`
 * 由 `roles:applyDataPermissions` 在事务内 upsert；无 `scopeId` 时默认 `null`＝全部记录。
 */
export function applyDataPermissions(roleName: string, values: Record<string, unknown>) {
  return resourceAction<unknown>('roles', 'applyDataPermissions', { params: { filterByTk: roleName }, values });
}

// --- 员工与工具权限（AC-05） ---------------------------------------------

export function listRoleAiEmployees(roleName: string, params: ListParams) {
  return associatedAction<AiEmployeeRecord[]>('roles', roleName, 'aiEmployees', 'list', { params });
}

export function addRoleAiEmployees(roleName: string, usernames: string[]) {
  return associatedAction<unknown>('roles', roleName, 'aiEmployees', 'add', { values: usernames });
}

export function removeRoleAiEmployees(roleName: string, usernames: string[]) {
  return associatedAction<unknown>('roles', roleName, 'aiEmployees', 'remove', { values: usernames });
}

export function listAiEmployees(params: ListParams) {
  return resourceAction<AiEmployeeRecord[]>('aiEmployees', 'list', { params });
}

export function listAiEmployeesByUser(params: ListParams) {
  return resourceAction<AiEmployeeRecord[]>('aiEmployees', 'listByUser', { params });
}

export function getAiEmployee(username: string) {
  return resourceAction<AiEmployeeRecord>('aiEmployees', 'get', { params: { filterByTk: username } });
}

/** 当前登录账号实际可用的员工（`aiEmployees:listByUser`），与角色配置分开取。 */
export function useAiEmployeesByUser(
  options: { pageSize?: number; enabled?: boolean } = {},
): AssociatedListResult<AiEmployeeRecord> {
  const { pageSize = 200, enabled = true } = options;
  return useResourceActionList<AiEmployeeRecord>(
    ['aiEmployees', 'listByUser', pageSize],
    () => listAiEmployeesByUser({ pageSize, sort: ['username'] }),
    { enabled },
  );
}

// --- 部门与组织（AC-06） --------------------------------------------------

export function listDepartments(params: ListParams) {
  return resourceAction<DepartmentRecord[]>('departments', 'list', { params });
}

export function getDepartment(id: number | string) {
  return resourceAction<DepartmentRecord>('departments', 'get', { params: { filterByTk: id } });
}

export function createDepartment(values: Record<string, unknown>) {
  return resourceAction<DepartmentRecord>('departments', 'create', { values });
}

export function updateDepartment(id: number | string, values: Record<string, unknown>) {
  return resourceAction<DepartmentRecord>('departments', 'update', { params: { filterByTk: id }, values });
}

export function destroyDepartment(id: number | string) {
  return resourceAction<unknown>('departments', 'destroy', { params: { filterByTk: id } });
}

export function listOrganizations(params: ListParams) {
  return resourceAction<OrganizationRecord[]>('organizations', 'list', { params });
}

export function listDepartmentMembers(id: number | string, params: ListParams) {
  return associatedAction<UserRecord[]>('departments', id, 'members', 'list', { params });
}

export function listDepartmentRoles(id: number | string, params: ListParams) {
  return associatedAction<RoleRecord[]>('departments', id, 'roles', 'list', { params });
}

/**
 * 部门 ↔ 成员 / 部门 ↔ 角色 / 用户 ↔ 部门 / 角色 ↔ 部门 四个方向的写动作。
 *
 * 契约（**真实 2.2.20 发布产物**，不是自造）：
 *  - 动作名与父资源斜杠形式取自 `@nocobase/plugin-departments` 的
 *    `dist/server/middlewares/reset-user-departments-cache.js`（原文里
 *    `associatedName/resourceName` 组合与 `add|remove|set` 三个动作，见
 *    `patches/nocobase-2.2.20-departments/tools/verify-2.2.20-departments.mjs` 的锚点）；
 *  - 请求体 = **裸标识数组**（成员方向是用户 id 数组，角色方向是角色名数组，部门方向是部门 id 数组），
 *    与 `tests/.../app-http-chain.mjs` 里逐条真实 HTTP 调用的 body 一致；
 *  - `set` 是"整体替换"，`add`/`remove` 是增量；不把三种语义混用。
 *
 * 插件未启用时这些路径不存在（后端 500/404），由 `associationAvailability()` 归因，
 * 页面据此显示"能力未开通"而不是"空数据"。
 */
export function addDepartmentMembers(departmentId: number | string, userIds: Array<number | string>) {
  return associatedAction<unknown>('departments', departmentId, 'members', 'add', { values: userIds });
}

export function removeDepartmentMembers(departmentId: number | string, userIds: Array<number | string>) {
  return associatedAction<unknown>('departments', departmentId, 'members', 'remove', { values: userIds });
}

export function setDepartmentMembers(departmentId: number | string, userIds: Array<number | string>) {
  return associatedAction<unknown>('departments', departmentId, 'members', 'set', { values: userIds });
}

export function addDepartmentRoles(departmentId: number | string, roleNames: string[]) {
  return associatedAction<unknown>('departments', departmentId, 'roles', 'add', { values: roleNames });
}

export function removeDepartmentRoles(departmentId: number | string, roleNames: string[]) {
  return associatedAction<unknown>('departments', departmentId, 'roles', 'remove', { values: roleNames });
}

export function setDepartmentRoles(departmentId: number | string, roleNames: string[]) {
  return associatedAction<unknown>('departments', departmentId, 'roles', 'set', { values: roleNames });
}

export function listUserDepartments(userId: number | string, params: ListParams) {
  return associatedAction<DepartmentRecord[]>('users', userId, 'departments', 'list', { params });
}

export function addUserDepartments(userId: number | string, departmentIds: Array<number | string>) {
  return associatedAction<unknown>('users', userId, 'departments', 'add', { values: departmentIds });
}

export function removeUserDepartments(userId: number | string, departmentIds: Array<number | string>) {
  return associatedAction<unknown>('users', userId, 'departments', 'remove', { values: departmentIds });
}

export function setUserDepartments(userId: number | string, departmentIds: Array<number | string>) {
  return associatedAction<unknown>('users', userId, 'departments', 'set', { values: departmentIds });
}

export function listRoleDepartments(roleName: string, params: ListParams) {
  return associatedAction<DepartmentRecord[]>('roles', roleName, 'departments', 'list', { params });
}

export function addRoleDepartments(roleName: string, departmentIds: Array<number | string>) {
  return associatedAction<unknown>('roles', roleName, 'departments', 'add', { values: departmentIds });
}

export function removeRoleDepartments(roleName: string, departmentIds: Array<number | string>) {
  return associatedAction<unknown>('roles', roleName, 'departments', 'remove', { values: departmentIds });
}

export function setRoleDepartments(roleName: string, departmentIds: Array<number | string>) {
  return associatedAction<unknown>('roles', roleName, 'departments', 'set', { values: departmentIds });
}

/**
 * 主部门（`users.mainDepartmentId`）。
 *
 * 这是 `plugin-departments` 启用后才注册到 `users` 上的真实字段（13000 安装前不存在，
 * 见 25 §6 物理层前检）。因此只在**读回里确实出现该字段**时才提供写入入口——
 * 不预置字段、不伪造能力、也不写插件里已废弃的 through `isMain` 标记
 * （2.2.22 固定源码注释：`departmentsUsers{isOwner, deprecated isMain}`）。
 */
export function updateUserMainDepartment(userId: number | string, departmentId: number | string | null) {
  return updateUser(userId, { mainDepartmentId: departmentId });
}

// --- 用户头像字段能力（AC-01 附件宿主） -----------------------------------

/**
 * `users` 集合是否真的有 `avatar` 字段。
 *
 * 为什么要探测：`AttachmentControl` 的宿主链（上传 → 保存引用 → 显示）**只在字段真实存在时成立**。
 * 真实 13000（2.2.20）的 `users` 集合字段元数据里**没有** `avatar`（实测字段清单见
 * `group-b-evidence/live-readonly-13000-access.json` 的 `users-collection-fields`），
 * 此时上传按钮即使点了也不会让头像出现。因此这里按**真实集合元数据**判断，
 * 而不是一律渲染一个永远不生效的上传控件，也不是永久写死"未开通"。
 *
 * 字段一旦在实例上存在（同一环境装上该字段），宿主链立即按真实接口可用。
 */
export interface UsersAvatarFieldCapability {
  state: 'loading' | 'available' | 'missing' | 'error';
  present: boolean;
  message: string | null;
}

export function useUsersAvatarField(): UsersAvatarFieldCapability {
  const query = useQuery({
    queryKey: ['access', 'users-collection', 'avatar-field'],
    staleTime: 5 * 60 * 1000,
    retry: false,
    queryFn: async () => {
      const result = await resourceAction<{ fields?: Array<{ name?: string }> }>('collections', 'get', {
        params: { filterByTk: 'users', appends: ['fields'] },
      });
      const fields = Array.isArray(result.data?.fields) ? result.data.fields : [];
      return fields.some((field) => field?.name === 'avatar');
    },
  });

  const error = asCrewloomError(query.error);
  if (query.isLoading) return { state: 'loading', present: false, message: null };
  if (error) return { state: 'error', present: false, message: toUserMessage(error) };
  const present = query.data === true;
  return { state: present ? 'available' : 'missing', present, message: null };
}

// --- 关联能力归因 ---------------------------------------------------------

/**
 * 部门关联能力（`departments.members` / `departments.roles` 等）是否已在本实例开通。
 *
 * 判定依据是**真实的集合字段元数据**：`@nocobase/plugin-departments` 启用后会给
 * `departments` 增加 `members` / `roles`（以及 `owners` / `title` / `isLeaf`）字段；
 * 未启用时这些字段不存在（13000 实测：`departments` 只有自定义列）。
 *
 * 为什么不直接看关联接口的 500：**500 既可能是"插件没启用、路由没注册"，
 * 也可能是"已开通但这次读取真的失败了"**，两者含义不同、文案也不同。
 * 只有把"能力是否存在"和"这次读取是否成功"分开，才能既不吞普通错误、
 * 也不把已开通实例的读取故障一律说成"未开通"。
 */
export type DepartmentsAssociationCapability = 'loading' | 'enabled' | 'disabled' | 'unknown';

export function useDepartmentsAssociationCapability(): DepartmentsAssociationCapability {
  const query = useQuery({
    queryKey: ['access', 'departments-collection', 'association-fields'],
    staleTime: 5 * 60 * 1000,
    retry: false,
    queryFn: async () => {
      const result = await resourceAction<{ fields?: Array<{ name?: string }> }>('collections', 'get', {
        params: { filterByTk: 'departments', appends: ['fields'] },
      });
      const fields = Array.isArray(result.data?.fields) ? result.data.fields : [];
      return fields.some((field) => field?.name === 'members') && fields.some((field) => field?.name === 'roles');
    },
  });

  const error = asCrewloomError(query.error);
  if (query.isLoading) return 'loading';
  if (error) return error.kind === 'not-found' ? 'disabled' : 'unknown';
  return query.data === true ? 'enabled' : 'disabled';
}

/** 关联接口当前的呈现状态（每一种都有独立文案，不互相冒充）。 */
export type AssociationAvailability =
  | 'checking' // 关联列表或能力探测还在进行
  | 'available' // 列表读到了（含空结果）
  | 'unavailable' // 能力确实未开通（字段元数据里没有关联字段）
  | 'read-error' // 能力已开通，但这次关联读取失败（应可重试）
  | 'denied' // 没有读取该关联的权限（403）
  | 'indeterminate' // 读取失败且无法确认能力是否开通
  | 'error'; // 未登录 / 角色失效 / 其它

/**
 * 把"关联列表的六态"与"能力是否开通"合起来归因。
 *
 * 规则：
 *  - 列表成功 → `available`（含空数据，空数据不是"未开通"）；
 *  - 403 → `denied`；未登录/角色失效 → `error`；
 *  - 500/404 这类失败：能力探测说 **disabled** → `unavailable`；
 *    说 **enabled** → `read-error`（这是**真实读取失败**，页面给"可重试"）；
 *    能力探测还没回来 → `checking`；探测本身也失败（unknown）→ `indeterminate`。
 */
export function associationAvailability(
  result: AssociatedListResult<unknown>,
  capability: DepartmentsAssociationCapability = 'unknown',
): AssociationAvailability {
  if (result.state === 'loading') return 'checking';
  if (!result.error) return 'available';
  if (result.error.kind === 'forbidden') return 'denied';
  if (result.error.kind === 'unauthenticated' || result.error.kind === 'role-invalid') return 'error';
  if (result.error.kind === 'backend-unavailable' || result.error.kind === 'not-found') {
    if (capability === 'disabled') return 'unavailable';
    if (capability === 'enabled') return 'read-error';
    if (capability === 'loading') return 'checking';
    return 'indeterminate';
  }
  return 'error';
}

/**
 * 部门/用户/角色关联维护用的通用候选列表。
 *
 * 候选来自**真实 `users:list` / `roles:list` / `departments:list`**，只在本地拼装
 * 原生过滤条件（关键词 `$includes`、已关联项 `$notIn`），不调用未在 2.2.20 生成物里
 * 逐条核对过的专用动作（例如 `users:listExcludeDept` 的参数名没有本仓库证据，故不使用）。
 */
export function useCandidateList<T>(
  resource: 'users' | 'roles' | 'departments',
  options: {
    keyword?: string;
    excludeIds?: Array<number | string>;
    page?: number;
    pageSize?: number;
    enabled?: boolean;
  } = {},
): AssociatedListResult<T> {
  const { keyword = '', excludeIds = [], page = 1, pageSize = 10, enabled = true } = options;
  const trimmed = keyword.trim();
  const filter = useMemo(() => {
    const clauses: Record<string, unknown>[] = [];
    if (trimmed !== '') {
      const like = { $includes: trimmed };
      if (resource === 'users') clauses.push({ $or: [{ nickname: like }, { username: like }, { email: like }] });
      else if (resource === 'roles') clauses.push({ $or: [{ name: like }, { title: like }] });
      else clauses.push({ $or: [{ name: like }, { dept_code: like }] });
    }
    // 排除已关联项必须用**该资源的真实主键**：`users` / `departments` 是 `id`，
    // `roles` 的主键是 `name`。统一写 `id` 会让角色的排除条件打在并不存在的主键上
    // （合成环境实测请求为 `filter={"id":{"$notIn":["r_sales"]}}`），已关联的角色因此仍出现在候选里。
    if (excludeIds.length > 0) clauses.push({ [filterKeyOf(resource)]: { $notIn: excludeIds } });
    if (clauses.length === 0) return undefined;
    if (clauses.length === 1) return clauses[0];
    return { $and: clauses };
  }, [resource, trimmed, excludeIds]);

  const sort = resource === 'users' ? ['id'] : resource === 'roles' ? ['name'] : ['id'];
  return useResourceActionList<T>(
    ['candidates', resource, page, pageSize, trimmed, excludeIds.join(','), sort.join(',')],
    () => resourceList<T>(resource, { page, pageSize, sort, filter }),
    { enabled },
  );
}

/** 候选排除条件要用的**真实主键**字段名（`roles` 的主键是 `name`，其余是 `id`）。 */
function filterKeyOf(resource: 'users' | 'roles' | 'departments'): string {
  return resource === 'roles' ? 'name' : 'id';
}

/** 候选人（部门成员方向）。 */
export function useUserCandidates(options: {
  keyword?: string;
  excludeIds?: Array<number | string>;
  page?: number;
  pageSize?: number;
  enabled?: boolean;
}) {
  return useCandidateList<UserRecord>('users', options);
}

/** 候选角色（部门角色方向）。 */
export function useRoleCandidates(options: {
  keyword?: string;
  excludeIds?: Array<number | string>;
  page?: number;
  pageSize?: number;
  enabled?: boolean;
}) {
  return useCandidateList<RoleRecord>('roles', options);
}

/** 候选部门（用户/角色方向的部门）。 */
export function useDepartmentCandidates(options: {
  keyword?: string;
  excludeIds?: Array<number | string>;
  page?: number;
  pageSize?: number;
  enabled?: boolean;
}) {
  return useCandidateList<DepartmentRecord>('departments', options);
}

// --- 条件编辑器 -----------------------------------------------------------

export type ConditionOperator = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'notIn' | 'contains' | 'notContains';

export interface ConditionClause {
  id: string;
  field: string;
  operator: ConditionOperator;
  value: string;
}

const OPERATOR_KEYS: Record<ConditionOperator, string | null> = {
  eq: null,
  ne: '$ne',
  gt: '$gt',
  gte: '$gte',
  lt: '$lt',
  lte: '$lte',
  in: '$in',
  notIn: '$notIn',
  contains: '$includes',
  notContains: '$notIncludes',
};

export const CONDITION_OPERATOR_LABELS: Array<{ value: ConditionOperator; label: string }> = [
  { value: 'eq', label: '等于' },
  { value: 'ne', label: '不等于' },
  { value: 'gt', label: '大于' },
  { value: 'gte', label: '大于等于' },
  { value: 'lt', label: '小于' },
  { value: 'lte', label: '小于等于' },
  { value: 'in', label: '属于（逗号分隔）' },
  { value: 'notIn', label: '不属于（逗号分隔）' },
  { value: 'contains', label: '包含' },
  { value: 'notContains', label: '不包含' },
];

function parseLiteral(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  const numeric = Number(trimmed);
  if (!Number.isNaN(numeric) && /^-?\d+(\.\d+)?$/.test(trimmed)) return numeric;
  return trimmed;
}

/**
 * 把条件行编译为原生过滤条件（`parseFilter` 语义的 JSON 对象）。
 *
 * 只做"字段 + 操作符 + 值"的直接映射，不发明新的表达式语法；
 * 多个条件之间是 **AND**（与 NocoBase 默认 `andMerge` 一致）。
 */
export function buildScope(clauses: ConditionClause[]): Record<string, unknown> | null {
  const scope: Record<string, unknown> = {};
  for (const clause of clauses) {
    const field = clause.field.trim();
    if (!field) return null;
    const key = OPERATOR_KEYS[clause.operator];
    let value: unknown;
    if (clause.operator === 'in' || clause.operator === 'notIn') {
      value = clause.value
        .split(',')
        .map((item) => parseLiteral(item))
        .filter((item) => item !== '');
    } else {
      value = parseLiteral(clause.value);
    }
    if (key === null) {
      scope[field] = value;
    } else {
      const existing = scope[field];
      const operatorObject =
        existing && typeof existing === 'object' && !Array.isArray(existing)
          ? (existing as Record<string, unknown>)
          : {};
      operatorObject[key] = value;
      scope[field] = operatorObject;
    }
  }
  return Object.keys(scope).length === 0 ? {} : scope;
}

// --- 关联列表取数钩子（同六态、同管线） ----------------------------------

export interface AssociatedListResult<T> {
  state: ResourceState;
  rows: T[];
  meta: ApiListMeta;
  total: number | null;
  error: CrewloomError | null;
  message: string | null;
  isFetching: boolean;
  refetch: () => void;
}

function asCrewloomError(error: unknown): CrewloomError | null {
  if (!error) return null;
  if (error instanceof CrewloomError) return error;
  return new CrewloomError({
    kind: 'unexpected',
    userMessage: toUserMessage(error),
    detail: error instanceof Error ? error.message : String(error),
  });
}

function classify(error: CrewloomError | null, isEmpty: boolean): ResourceState {
  if (!error) return isEmpty ? 'empty' : 'ready';
  if (error.kind === 'forbidden') return 'denied';
  if (error.kind === 'unauthenticated' || error.kind === 'role-invalid') return 'unauthorized';
  return 'error';
}

/**
 * 通用"资源动作列表"取数（同六态、同管线）。
 *
 * 只为**非 `<resource>:list` 的只读列表动作**（如 `users:listExcludeRole`、
 * `aiEmployees:listByUser`、`dataSources:listEnabled`）提供统一的六态归因，
 * 避免每个动作各写一份。它不接收任意 URL：`queryFn` 必须是本文件（或组内
 * operations）已声明的类型化请求函数。
 */
export function useResourceActionList<T>(
  queryKey: readonly unknown[],
  queryFn: () => Promise<{ data: T[]; meta?: ApiListMeta }>,
  options: { enabled?: boolean } = {},
): AssociatedListResult<T> {
  const { enabled = true } = options;
  const query = useQuery({ queryKey, queryFn, enabled });

  const error = asCrewloomError(query.error);
  const rows = useMemo(() => (query.data?.data ?? []) as T[], [query.data]);
  const meta = (query.data?.meta ?? {}) as ApiListMeta;

  return {
    state: query.isLoading ? 'loading' : classify(error, rows.length === 0),
    rows,
    meta,
    total: typeof meta.count === 'number' ? meta.count : null,
    error,
    message: error ? toUserMessage(error) : null,
    isFetching: query.isFetching,
    refetch: () => void query.refetch(),
  };
}

/**
 * 关联资源列表（如 `roles/<role>/users`）。
 *
 * `useResourceList` 只处理 `<resource>:list`，关联路径需要父记录标识，
 * 因此这里用**同一个客户端与同六态语义**补一个薄钩子；没有第二条请求路径。
 */
export function useAssociatedList<T>(
  parent: string,
  parentId: string | number | null | undefined,
  child: string,
  options: { params?: ListParams; enabled?: boolean; keySuffix?: unknown } = {},
): AssociatedListResult<T> {
  const { params, enabled = true, keySuffix } = options;
  return useResourceActionList<T>(
    ['associated', parent, parentId ?? null, child, 'list', params ?? null, keySuffix ?? null],
    () => associatedAction<T[]>(parent, parentId as string | number, child, 'list', { params }),
    { enabled: enabled && parentId !== null && parentId !== undefined },
  );
}

/** 关联列表一次读取的条数；服务端支持 `page`/`pageSize`，因此按页循环读到读完为止。 */
export const ASSOCIATION_FETCH_PAGE_SIZE = 50;

export interface CompleteAssociatedListResult<T> extends AssociatedListResult<T> {
  /**
   * `rows` 是否**已经是该方向关联记录的完整集合**。
   *
   * 只有为真时才允许做「整体替换 / 清空」这类需要完整名单的操作，
   * 避免用只加载了一部分的集合算出目标名单而误删记录。
   */
  complete: boolean;
}

/**
 * 关联资源列表（**完整集合**）。
 *
 * 与 `useAssociatedList` 的区别：后者只读一页。部门成员/角色、用户部门、角色部门这些方向
 * 需要"当前到底关联了谁"的完整名单（候选排除、整体替换、清空都依赖它），
 * 因此这里按**原生关联 list 的分页参数**逐页读取，直到最后一页为止：
 *  - 每页请求都走同一条 SDK 关联管线（`associatedAction` → `<parent>/<id>/<child>:list`）；
 *  - 使用 `meta.count` / `meta.totalPage` 判断是否读完，短页或空页也会终止；
 *  - 透传 TanStack Query 的 `abortSignal`：组件卸载、key 变化或角色切换清缓存时，
 *    未完成的后续分页请求会被中断，不会把旧角色的结果写进新上下文；
 *  - 读取失败时 `complete=false`，页面据此禁用需要完整名单的写操作。
 */
export function useCompleteAssociatedList<T>(
  parent: string,
  parentId: string | number | null | undefined,
  child: string,
  options: { enabled?: boolean; pageSize?: number; keySuffix?: unknown } = {},
): CompleteAssociatedListResult<T> {
  const { enabled = true, pageSize = ASSOCIATION_FETCH_PAGE_SIZE, keySuffix } = options;
  const query = useQuery({
    queryKey: ['associated-complete', parent, parentId ?? null, child, pageSize, keySuffix ?? null],
    enabled: enabled && parentId !== null && parentId !== undefined,
    queryFn: async ({ signal }): Promise<{ data: T[]; meta?: ApiListMeta }> => {
      const rows: T[] = [];
      let page = 1;
      for (;;) {
        const result = await associatedAction<T[]>(
          parent,
          parentId as string | number,
          child,
          'list',
          { params: { page, pageSize } },
          { signal },
        );
        const batch = Array.isArray(result.data) ? result.data : [];
        rows.push(...batch);
        const meta = result.meta ?? {};
        const totalPage = typeof meta.totalPage === 'number' ? meta.totalPage : null;
        const count = typeof meta.count === 'number' ? meta.count : null;
        const reachedEnd =
          batch.length === 0 ||
          batch.length < pageSize ||
          (totalPage !== null && page >= totalPage) ||
          (count !== null && rows.length >= count);
        if (reachedEnd) break;
        page += 1;
        // 防御：服务端若不推进分页也不会无限循环。
        if (page > 200) break;
      }
      return { data: rows, meta: { count: rows.length } };
    },
  });

  const error = asCrewloomError(query.error);
  const rows = useMemo(() => (query.data?.data ?? []) as T[], [query.data]);

  return {
    state: query.isLoading ? 'loading' : classify(error, rows.length === 0),
    rows,
    meta: (query.data?.meta ?? {}) as ApiListMeta,
    total: rows.length,
    error,
    message: error ? toUserMessage(error) : null,
    isFetching: query.isFetching,
    refetch: () => void query.refetch(),
    complete: !query.isLoading && !error,
  };
}
