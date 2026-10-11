import { describe, expect, it } from 'vitest';
import {
  findBoard,
  findModuleByPath,
  MODULE_BY_ID,
  MODULES,
  validateModuleRegistry,
  WORKBENCH_PATH,
} from '../src/modules/registry';

/**
 * 模块注册表一致性测试。
 *
 * 三组并行时各组只改自己的模块文件；这些断言保证"聚合结果"始终是可路由的：
 * 模块 id / 路径唯一、页面路径是相对片段、权限项与标题齐全。
 */
describe('模块注册表', () => {
  it('注册表自身一致（无重复 id / 路径，页面路径为相对片段）', () => {
    expect(validateModuleRegistry()).toEqual([]);
  });

  it('包含工作台与六个业务模块，顺序固定', () => {
    expect(MODULES.map((module) => module.id)).toEqual([
      'workbench',
      'ai',
      'tasks',
      'workflow',
      'datasource',
      'model',
      'access',
    ]);
    expect(MODULES.map((module) => module.path)).toEqual([
      '/workbench',
      '/ai',
      '/tasks',
      '/workflow',
      '/datasource',
      '/model',
      '/access',
    ]);
  });

  it('每个模块都有页面定义与真实权限探测项', () => {
    for (const module of MODULES) {
      expect(module.boards.length, module.id).toBeGreaterThan(0);
      expect(module.probeId, module.id).toBeTruthy();
      expect(module.access.id, module.id).toBeTruthy();
    }
  });

  it('MODULE_BY_ID 与 MODULES 一一对应', () => {
    expect(Object.keys(MODULE_BY_ID).sort()).toEqual(MODULES.map((m) => m.id).sort());
    expect(MODULE_BY_ID.workbench.path).toBe(WORKBENCH_PATH);
  });

  it('路径查找支持模块根路径与子页面', () => {
    expect(findModuleByPath('/ai/conversations')?.id).toBe('ai');
    expect(findModuleByPath('/workflow/executions')?.id).toBe('workflow');
    expect(findModuleByPath('/unknown')).toBeUndefined();
  });

  it('页面路径允许参数片段，静态页面仍可按路径查回', () => {
    const workflow = MODULE_BY_ID.workflow;
    expect(findBoard(workflow, 'list')?.title).toBeTruthy();
    expect(findBoard(workflow, 'list/:id/canvas')).toBeUndefined();

    // 参数片段不应在聚合时被规范化掉：组内声明的原样保留。
    const declared = MODULES.flatMap((module) => module.boards.map((board) => board.path));
    for (const path of declared) {
      expect(path.startsWith('/'), path).toBe(false);
      expect(path.endsWith('/'), path).toBe(false);
    }
  });

  it('工作台提供模块落点组件，业务模块当前用公共占位页', () => {
    expect(MODULE_BY_ID.workbench.IndexComponent).toBeTypeOf('function');
    // 业务模块的页面在 P0 阶段没有组内组件时回退到占位页，这是允许的。
    for (const id of ['ai', 'tasks', 'workflow', 'datasource', 'model', 'access']) {
      for (const board of MODULE_BY_ID[id].boards) {
        expect(board.endpoints.length, `${id}/${board.path}`).toBeGreaterThan(0);
      }
    }
  });
});
