import { accessModule } from './access';
import { aiModule } from './ai';
import { datasourceModule } from './datasource';
import { modelModule } from './model';
import { tasksModule } from './tasks';
import type { BoardDefinition, ModuleDefinition } from './types';
import { workflowModule } from './workflow';
import { workbenchModule } from './workbench';

export type { BoardDefinition, ModuleDefinition, ModulePageDefinition, ModulePageProps } from './types';

/**
 * 模块注册聚合器（**公共负责人唯一维护**）。
 *
 * 三组并行方式：每个模块的定义与页面组件放**自己的目录** `src/modules/<id>/`，
 * 本文件只做汇总。组内新增页面时改自己的模块文件即可，不需要动这里。
 *
 * ⚠️ 初始化顺序约定（重要）：
 *   本聚合器 → 模块文件 → 页面组件 → `permissions/modules.ts` 是一条单向链路，
 *   而 `permissions/modules.ts` 又会（为了兼容 P1 的导入路径）重新导出本文件。
 *   因此**任何页面组件在模块顶层都不要读取本文件或 permissions/modules 的导出值**，
 *   只能在组件函数体内使用（函数声明会在初始化完成后再被调用）。
 */

export const MODULES: ModuleDefinition[] = [
  workbenchModule,
  aiModule,
  tasksModule,
  workflowModule,
  datasourceModule,
  modelModule,
  accessModule,
];

export const MODULE_BY_ID: Record<string, ModuleDefinition> = Object.fromEntries(
  MODULES.map((module) => [module.id, module]),
);

export const WORKBENCH_PATH = '/workbench';

export function findModuleByPath(pathname: string): ModuleDefinition | undefined {
  return MODULES.find(
    (module) => pathname === module.path || pathname.startsWith(`${module.path}/`),
  );
}

export function findBoard(module: ModuleDefinition, boardPath: string): BoardDefinition | undefined {
  return module.boards.find((board) => board.path === boardPath);
}

/**
 * 把一条站内绝对路径解析成"模块 + 页面"（页面路径可带参数，如 `conversations/:sessionId`）。
 *
 * 用途：跨模块入口（工作台 → 其它模块的详情页）必须先确认目标页面**在注册表里存在**，
 * 不能硬编码一条可能还没实现的链接让用户点进 404。找不到时返回 `undefined`，
 * 调用方改为显示"该入口当前不可用"。
 *
 * 处理规则：
 *  - **查询串与 hash 不参与匹配**（`/tasks/manual?id=5` 与 `/tasks/manual` 是同一个页面）；
 *  - `:param` 段匹配任意一段（不校验参数值，值由页面自己解析）。
 */
export function resolveRouteTarget(
  target: string,
): { module: ModuleDefinition; board?: BoardDefinition } | undefined {
  const pathname = target.split(/[?#]/)[0];
  const module = findModuleByPath(pathname);
  if (!module) return undefined;
  const rest = pathname.slice(module.path.length).replace(/^\/+|\/+$/g, '');
  if (!rest) return { module };
  const segments = rest.split('/');
  const board = module.boards.find((candidate) => {
    const parts = candidate.path.split('/');
    if (parts.length !== segments.length) return false;
    return parts.every((part, index) => part.startsWith(':') || part === segments[index]);
  });
  return board ? { module, board } : undefined;
}

/** 校验注册表自身的一致性（被单测与启动期检查使用）。 */
export function validateModuleRegistry(modules: ModuleDefinition[] = MODULES): string[] {
  const problems: string[] = [];
  const moduleIds = new Set<string>();
  for (const module of modules) {
    if (moduleIds.has(module.id)) problems.push(`重复的模块 id：${module.id}`);
    moduleIds.add(module.id);
    if (!module.path.startsWith('/')) problems.push(`模块 ${module.id} 的 path 必须以 / 开头`);
    const boardPaths = new Set<string>();
    for (const board of module.boards) {
      if (!board.path) problems.push(`模块 ${module.id} 存在空页面路径`);
      if (boardPaths.has(board.path)) problems.push(`模块 ${module.id} 重复页面路径：${board.path}`);
      boardPaths.add(board.path);
      if (board.path.startsWith('/') || board.path.endsWith('/')) {
        problems.push(`模块 ${module.id} 的页面路径应为相对片段：${board.path}`);
      }
      if (!board.title) problems.push(`模块 ${module.id} 的页面 ${board.path} 缺少标题`);
      if (!board.access?.id) problems.push(`模块 ${module.id} 的页面 ${board.path} 缺少权限项`);
    }
  }
  return problems;
}
