import type { AccessControlData } from '../auth/types';
import { MODULES, type ModuleDefinition } from '../modules/registry';
import type { BoardDefinition, ModuleAccessCheck } from '../modules/types';
import { isPermissionAllowed, type PermissionCheck } from './model';
import type { ProbeResults } from './probes';

/**
 * 权限语义层（公共负责人唯一维护）。
 *
 * 职责分工（P0 拆分后）：
 *  - **模块与页面的声明**（有哪些模块、哪些页面、各自需要什么权限）在各组自己的
 *    `src/modules/<id>/index.tsx`，由 `src/modules/registry.ts` 汇总；
 *  - **判定与可见性计算**（声明式语义 + 运行期真实探测 + 三态区分）留在本文件。
 *
 * 判定原则（P1 验收结论，保持不变）：
 *  - `access` 是声明式权限语义（片段、显式资源授权、显式否定、核心资源策略兜底）；
 *  - `probeId` 指向运行期真实只读探测（见 probes.ts），菜单与入口的最终可用性以真实探测为准；
 *  - **不使用 `desktopRoutes` 作为 Crewloom 导航授权来源**：13000 上的原页面路由授权
 *    （`roles/<role>/desktopRoutes`，member 角色 135 条）属于 NocoBase 低代码页面的入口控制，
 *    不能把它的 UID 伪映射成 Crewloom 页面 path；AC-03 页面按原关系真实读取与维护它；
 *  - 后端始终是最终判定者；前端隐藏入口不是安全边界。
 */

export { MODULES, MODULE_BY_ID, WORKBENCH_PATH, findModuleByPath, findBoard, resolveRouteTarget } from '../modules/registry';
export type { BoardDefinition, ModuleDefinition, ModuleAccessCheck } from '../modules/types';

export interface AccessDecision {
  allowed: boolean;
  /**
   * 判定状态：
   *  - `allowed`：后端明确允许（或声明式语义放行）；
   *  - `denied`：后端明确拒绝（403）；
   *  - `unknown`：无法确认（网络/5xx/认证或角色失效）→ 不放行，也不显示为"无权限"。
   */
  status: 'allowed' | 'denied' | 'unknown';
  /** 未通过的权限项，供"如何获得访问"的说明使用。 */
  missing?: ModuleAccessCheck;
  /** 判定依据：运行期真实探测 / 声明式语义。 */
  source: 'probe' | 'declarative';
}

/**
 * 组合判定入口可用性。
 *
 * 探测结果存在时以后端实际回答为准；探测为 `unknown` 时保持未知（不放行），
 * 由界面提供重试；探测缺失时才退回声明式语义（用于单元测试与离线分析）。
 */
export function decideAccess(
  access: AccessControlData | null | undefined,
  check: ModuleAccessCheck,
  probeId: string | undefined,
  probes: ProbeResults | null,
): AccessDecision {
  const probeResult = probeId && probes ? probes[probeId] : undefined;
  if (probeResult) {
    if (probeResult.status === 'allowed') {
      return { allowed: true, status: 'allowed', source: 'probe' };
    }
    if (probeResult.status === 'unknown') {
      return { allowed: false, status: 'unknown', missing: check, source: 'probe' };
    }
    return { allowed: false, status: 'denied', missing: check, source: 'probe' };
  }
  return isPermissionAllowed(access, check as PermissionCheck)
    ? { allowed: true, status: 'allowed', source: 'declarative' }
    : { allowed: false, status: 'denied', missing: check, source: 'declarative' };
}

export interface ModuleVisibility {
  module: ModuleDefinition;
  decision: AccessDecision;
}

export function resolveModuleVisibility(
  access: AccessControlData | null | undefined,
  probes: ProbeResults | null = null,
): ModuleVisibility[] {
  return MODULES.map((module) => ({
    module,
    decision: decideAccess(access, module.access, module.probeId, probes),
  }));
}

export function resolveBoardVisibility(
  access: AccessControlData | null | undefined,
  module: ModuleDefinition,
  probes: ProbeResults | null = null,
): Array<{ board: BoardDefinition; decision: AccessDecision }> {
  return module.boards.map((board) => ({
    board,
    decision: decideAccess(access, board.access, board.probeId ?? module.probeId, probes),
  }));
}

export function filterVisibleModules(visibility: ModuleVisibility[]): ModuleDefinition[] {
  return visibility.filter((item) => item.decision.allowed).map((item) => item.module);
}

/** 被后端明确拒绝的模块入口，用于在界面上诚实说明边界（不含"无法确认"）。 */
export function listDeniedModules(
  access: AccessControlData | null | undefined,
  probes: ProbeResults | null,
): ModuleDefinition[] {
  return resolveModuleVisibility(access, probes)
    .filter((item) => item.decision.status === 'denied')
    .map((item) => item.module);
}

/** 暂时无法确认的模块入口：可重试，不显示为无权限，也不放行。 */
export function listUnknownModules(
  access: AccessControlData | null | undefined,
  probes: ProbeResults | null,
): ModuleDefinition[] {
  return resolveModuleVisibility(access, probes)
    .filter((item) => item.decision.status === 'unknown')
    .map((item) => item.module);
}
