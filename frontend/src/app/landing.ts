import type { AccessControlData } from '../auth/types';
import type { ProbeResults } from '../permissions/probes';
import { filterVisibleModules, resolveModuleVisibility } from '../permissions/modules';

/**
 * 登录后或访问根路径时的落点：优先工作台，否则第一个可见模块。
 *
 * 权限"暂时无法确认"时不去 `/no-access`（那会写成"没有可进入的模块"，与事实不符），
 * 而是回到工作台，由工作台显示可重试的未知状态。
 */
export function defaultLandingPath(
  access: AccessControlData | null,
  search = '',
  probes: ProbeResults | null = null,
): string {
  const visibility = resolveModuleVisibility(access ?? undefined, probes);
  const visible = filterVisibleModules(visibility);
  const workbenchAllowed = visibility.some(
    (item) => item.module.id === 'workbench' && item.decision.status === 'allowed',
  );
  if (workbenchAllowed) return `/workbench${search}`;
  if (visible[0]) return `${visible[0].path}${search}`;
  if (visibility.some((item) => item.decision.status === 'unknown')) return `/workbench${search}`;
  return '/no-access';
}

/** 仅允许站内相对路径作为登录后的返回地址。 */
export function sanitizeReturnTo(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value.startsWith('/')) return null;
  if (value.startsWith('//')) return null;
  if (value.startsWith('/login')) return null;
  return value;
}
