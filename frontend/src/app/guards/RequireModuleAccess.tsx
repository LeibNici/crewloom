import { createElement } from 'react';
import { Outlet } from 'react-router';
import { useSessionStore } from '../../auth/store';
import { decideAccess, type ModuleDefinition } from '../../permissions/modules';
import { AccessDeniedScreen, UnknownAccessScreen } from '../../screens/AccessDeniedScreen';
import { BootScreen } from '../../screens/BootScreen';

interface RequireModuleAccessProps {
  module: ModuleDefinition;
}

/**
 * 模块级放行。
 *
 * 这只是产品层的可用性判断：直接输入地址访问未授权模块时给出明确说明，
 * 而不是把页面渲染成"可用"。真正的权限边界始终由后端接口决定。
 *
 * 三种结果严格区分：
 *  - `denied`（后端明确拒绝）→ 无权限页；
 *  - `unknown`（网络/5xx/认证或角色失效）→ 可重试的"暂时无法确认"，**不放行**；
 *  - 探测尚未就绪 → 加载态（不先放行，也不误报无权限）。
 */
export function RequireModuleAccess({ module }: RequireModuleAccessProps) {
  const access = useSessionStore((state) => state.access);
  const probes = useSessionStore((state) => state.probes);
  const accessState = useSessionStore((state) => state.accessState);

  if (accessState === 'unknown') {
    return createElement(UnknownAccessScreen, { moduleId: module.id });
  }
  if (probes === null) {
    return createElement(BootScreen, { compact: true });
  }
  const decision = decideAccess(access, module.access, module.probeId, probes);
  if (decision.status === 'unknown') {
    return createElement(UnknownAccessScreen, { moduleId: module.id });
  }
  if (!decision.allowed) {
    return createElement(AccessDeniedScreen, { moduleId: module.id });
  }
  return createElement(Outlet);
}
