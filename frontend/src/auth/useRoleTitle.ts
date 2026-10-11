import type { UserRoleSummary } from './types';
import { roleTitleLabel, UNION_ROLE } from '../permissions/model';

/**
 * 当前生效角色的展示名称。
 *
 * 角色候选与标题都来自 `auth:check` 的 `data.roles`（含 `name`/`title`），
 * 因此单角色账号也能显示后端给用户看的中文角色名。这里**不再**去读角色资源
 * （`roles:get` 需要额外权限，也不是原生切换 UI 的来源）。
 *
 * 标题缺失时返回 null，界面统一显示"当前角色"，不显示内部角色标识；
 * 后端返回未翻译的 i18n 模板（如 `{{t("Root")}}`）时由 `roleTitleLabel` 取原文。
 */
export function useActiveRoleTitle(
  roleName: string | null | undefined,
  knownRoles: UserRoleSummary[] = [],
): string | null {
  if (!roleName) return null;
  if (roleName === UNION_ROLE) return '合并全部角色';
  return roleTitleLabel(knownRoles.find((role) => role.name === roleName)?.title);
}
