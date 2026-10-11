import { accessCheck, defineModule } from '../types';
import { DataPermissionsPage } from './pages/DataPermissionsPage';
import { DepartmentsPage } from './pages/DepartmentsPage';
import { EmployeesPermissionPage } from './pages/EmployeesPermissionPage';
import { FeaturesPage } from './pages/FeaturesPage';
import { RoleDetailPage } from './pages/RoleDetailPage';
import { RolesPage } from './pages/RolesPage';
import { UserDetailPage } from './pages/UserDetailPage';
import { UsersPage } from './pages/UsersPage';

/**
 * 用户与权限模块（AC-01 … AC-06）——**组 B（DS + AC）独占文件**。
 *
 * 权限产品判断（02-foundation §7 冻结，不在组内另立一套）：
 *  - Crewloom 管理模块的入口与操作，按对应原生后端资源/动作/snippet 与记录、字段权限判定；
 *    入口可用性以运行期真实只读探测为准（`src/permissions/probes.ts`），后端始终是最终判定者；
 *  - **不把 13000 上的原低代码 `desktopRoutes` UID 伪映射成 Crewloom 页面 path**，也不改旧授权数据：
 *    AC-03 按**原关系**真实读取并在产品内允许合法保存（`roles/<role>/desktopRoutes`、`menuUiSchemas`）；
 *  - 403（明确无权限）/ 未知（网络、5xx、认证或角色失效）/ 空数据 三种结果不得混同。
 *
 * 13000 实测约束（见 group-b-evidence/live-metadata-discovery*.json）：
 *  - `users` 356、`roles` 16（主键 `name`）、`departments` 50、`rolesUsers` 358、`organizations` 1；
 *  - 关联集合名是 **`rolesUsers`**（`usersRoles:list` → 404）；
 *  - `users:get?appends[]=roles` 可用；`users:setDefaultRole` 只能改当前登录用户自己；
 *  - `dataSourcesRolesResourcesActions` 3109 条、`dataSourcesRolesResourcesScopes` 2 条；
 *  - `departments` 插件 disabled：数据与 CRUD 字段可读，但成员/部门角色关联接口返回 500（未开通）。
 */
export const accessModule = defineModule({
  id: 'access',
  title: '用户与权限',
  path: '/access',
  subtitle: '用户、角色与授权管理',
  access: accessCheck('access.read', '查看用户与权限', 'roles', 'list'),
  probeId: 'access.read',
  boards: [
    {
      path: 'users',
      title: '用户',
      description: '查看与搜索用户；点开某个用户后可维护资料、角色、所属部门与密码。',
      access: accessCheck('access.users', '查看用户', 'users', 'list'),
      probeId: 'access.users',
      endpoints: ['users:list', 'users:create', 'users:update', 'users:setDefaultRole', 'rolesUsers:list'],
      Component: UsersPage,
    },
    {
      path: 'users/:id',
      title: '用户详情',
      description: '单个用户的资料、角色绑定、默认角色与密码。',
      access: accessCheck('access.users.detail', '查看用户详情', 'users', 'get'),
      probeId: 'access.users',
      endpoints: [
        'users:get',
        'users:update',
        'users:setDefaultRole',
        'auth:changePassword',
        'users/<id>/departments:list',
        'users/<id>/departments:add',
        'users/<id>/departments:remove',
        'users/<id>/departments:set',
      ],
      Component: UserDetailPage,
    },
    {
      path: 'roles',
      title: '角色与成员',
      description: '查看与维护角色，设置多角色模式与全局默认角色。',
      access: accessCheck('access.roles', '查看角色', 'roles', 'list'),
      probeId: 'access.read',
      endpoints: ['roles:list', 'roles:create', 'roles:update', 'roles:destroy', 'roles:setSystemRoleMode'],
      Component: RolesPage,
    },
    {
      path: 'roles/:name',
      title: '角色成员',
      description: '某个角色的成员、关联部门与授权规模；从角色列表选择一个角色进入。',
      access: accessCheck('access.roles.detail', '查看角色成员', 'roles', 'get'),
      probeId: 'access.read',
      endpoints: [
        'roles:get',
        'roles/<roleName>/users:list',
        'roles/<roleName>/users:add',
        'roles/<roleName>/users:remove',
        'users:listExcludeRole',
        'roles/<roleName>/departments:list',
        'roles/<roleName>/departments:add',
        'roles/<roleName>/departments:remove',
        'roles/<roleName>/departments:set',
      ],
      Component: RoleDetailPage,
    },
    {
      path: 'features',
      title: '功能与入口授权',
      description:
        '设置这个角色可以进入哪些页面、看到哪些菜单；页面里具体能查看或修改哪些数据，在「数据授权」里统一设置。',
      access: accessCheck('access.features', '查看功能授权', 'availableActions', 'list'),
      probeId: 'access.read',
      endpoints: [
        'availableActions:list',
        'roles/<roleName>/collections:list',
        'roles/<roleName>/desktopRoutes:list',
        'roles/<roleName>/menuUiSchemas:list',
      ],
      Component: FeaturesPage,
    },
    {
      path: 'data',
      title: '数据授权',
      description: '设置每个角色能查看或修改哪些数据：可以执行哪些操作、能看到哪些字段，以及范围是全部还是仅本人；筛选条件在页面上的条件编辑器里填写。',
      access: accessCheck('access.data', '查看数据授权', 'roles', 'list'),
      probeId: 'access.read',
      endpoints: [
        'roles/<roleName>/resources:list',
        'dataSourcesRolesResourcesActions:list',
        'dataSourcesRolesResourcesScopes:list',
        'roles:applyDataPermissions',
      ],
      Component: DataPermissionsPage,
    },
    {
      path: 'employees',
      title: '员工与工具权限',
      description: '角色可用员工、建员工资格，以及员工工具是否需要确认。',
      access: accessCheck('access.employees', '查看员工授权', 'roles', 'list'),
      probeId: 'access.read',
      endpoints: [
        'roles/<roleName>/aiEmployees:list',
        'aiEmployees:list',
        'aiEmployees:listByUser',
        'aiEmployees:get',
      ],
      Component: EmployeesPermissionPage,
    },
    {
      path: 'departments',
      title: '部门与组织结构',
      description: '查看与维护部门树和组织结构，并管理每个部门的成员与关联角色。',
      access: accessCheck('access.departments', '查看部门', 'departments', 'list'),
      probeId: 'access.read',
      endpoints: [
        'departments:list',
        'departments:create',
        'departments:update',
        'departments:destroy',
        'organizations:list',
        'departments/<id>/members:list',
        'departments/<id>/members:add',
        'departments/<id>/members:remove',
        'departments/<id>/members:set',
        'departments/<id>/roles:list',
        'departments/<id>/roles:add',
        'departments/<id>/roles:remove',
        'departments/<id>/roles:set',
      ],
      Component: DepartmentsPage,
    },
  ],
});
