import type { ComponentType } from 'react';
import type { PermissionCheck } from '../permissions/model';

/**
 * 模块与页面的公共类型（公共负责人唯一维护）。
 *
 * 三组并行约定：
 *  - 每个模块的定义放**自己的目录** `src/modules/<module>/index.tsx`；
 *  - 组只改自己模块目录内的文件，不改本文件、`registry.ts`、`router.tsx`；
 *  - 页面组件可以延后提供：`Component` 缺省时路由回退到公共占位页（诚实说明"尚未开放"），
 *    这样某组没实现完的页面不会让其它组或整体构建失败。
 *
 * 命名沿用 P1 既有类型：一个 `boards` 条目就是一个页面（页面 = board）。
 */

/** 页面组件的统一入参。 */
export interface ModulePageProps {
  module: ModuleDefinition;
  board: BoardDefinition;
}

export interface ModuleAccessCheck extends PermissionCheck {
  id: string;
}

export interface BoardDefinition {
  /** 路由路径片段（相对模块根路径），可含参数，例如 `conversations/:sessionId`。 */
  path: string;
  title: string;
  /** 页面说明：写清该页是什么、当前提供到什么程度。 */
  description: string;
  /** 进入该页所需的真实权限。 */
  access: ModuleAccessCheck;
  /** 运行期探测项 id（见 permissions/probes.ts）；缺省时沿用所属模块的探测项。 */
  probeId?: string;
  /** 该页对接的真实后端资源动作；仅作为映射与核对信息，不在界面展示。 */
  endpoints: string[];
  /** 组内实现；缺省时路由回退到公共占位页。 */
  Component?: ComponentType<ModulePageProps>;
}

/** 语义别名：新代码可读作"页面"。 */
export type ModulePageDefinition = BoardDefinition;

export interface ModuleDefinition {
  /** 模块标识。 */
  id: string;
  /** 侧栏与页面标题。 */
  title: string;
  /** 模块根路径。 */
  path: string;
  /** 模块一句话说明。 */
  subtitle: string;
  /** 进入模块所需的真实权限。 */
  access: ModuleAccessCheck;
  /** 运行期探测项 id。 */
  probeId: string;
  boards: BoardDefinition[];
  /**
   * 模块根路径（`/<module>`）的落点组件。缺省时回退到公共占位页（列出本模块页面）。
   * 目前只有工作台需要自定义落点。
   */
  IndexComponent?: ComponentType<{ module: ModuleDefinition }>;
}

/** 身份函数：给模块定义提供类型检查，不做任何运行时加工。 */
export function defineModule(definition: ModuleDefinition): ModuleDefinition {
  return definition;
}

/** 声明式权限项的小工具，避免各模块重复写对象字面量。 */
export function accessCheck(
  id: string,
  label: string,
  resource: string,
  action: string,
): ModuleAccessCheck {
  return { id, label, resource, action };
}

/** 无资源/动作的纯前端入口（如工作台首页）。 */
export function pageCheck(id: string, label: string): ModuleAccessCheck {
  return { id, label };
}
