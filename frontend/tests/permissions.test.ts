import { describe, expect, it } from 'vitest';
import type { AccessControlData } from '../src/auth/types';
import {
  buildRoleChoices,
  isPermissionAllowed,
  isResourceActionAllowed,
  isUnionAllowed,
  mustUseUnion,
  normalizeRoleMode,
  resolveCanonicalAction,
  shouldShowRoleSwitcher,
  UNION_ROLE,
} from '../src/permissions/model';
import {
  decideAccess,
  filterVisibleModules,
  listDeniedModules,
  listUnknownModules,
  resolveModuleVisibility,
  MODULE_BY_ID,
} from '../src/permissions/modules';
import type { ProbeResults } from '../src/permissions/probes';

/**
 * 权限判定单测。
 *
 * 期望值全部来自 250 新实例（NocoBase 2.2.22）的真实接口观测，
 * 证据记录见 docs/acceptance/p1-repair.md：
 *  - root（allowAll）全量放行；
 *  - snippet 含 pm.* 的配置角色可读员工/流程/数据源/模型配置；
 *  - 无 snippet、strategy 仅 view 的受限角色对上述资源 403；
 *  - 显式 `resource:!action` 否定优先；
 *  - 探测结果按 allowed / denied / unknown 三分类，unknown 不放行也不当作拒绝。
 */

function access(partial: Partial<AccessControlData>): AccessControlData {
  return {
    role: 'test',
    roleMode: 'default',
    strategy: null,
    actions: {},
    resources: [],
    snippets: [],
    allowAll: false,
    allowConfigure: false,
    allowAnonymous: false,
    allowMenuItemIds: [],
    uiButtonSchemasBlacklist: [],
    availableActions: ['create', 'view', 'update', 'destroy', 'export', 'importXlsx'],
    actionAlias: {
      create: 'create',
      get: 'view',
      list: 'view',
      query: 'view',
      update: 'update',
      move: 'update',
      destroy: 'destroy',
      export: 'export',
    },
    roles: ['test'],
    ...partial,
  };
}

describe('角色模式语义', () => {
  it('保留三种角色模式的原文语义', () => {
    expect(normalizeRoleMode('default')).toBe('default');
    expect(normalizeRoleMode('allow-use-union')).toBe('allow-use-union');
    expect(normalizeRoleMode('only-use-union')).toBe('only-use-union');
  });

  it('缺省/空值按原生 || SystemRoleMode.default 落到 default', () => {
    // 原生证据：role-check.ts:71 与 setCurrentRole.ts:125 的 `roleMode || SystemRoleMode.default`
    expect(normalizeRoleMode(undefined)).toBe('default');
    expect(normalizeRoleMode(null)).toBe('default');
    expect(normalizeRoleMode('')).toBe('default');
  });

  it('非空但不在原生枚举内 → unknown（不悄悄当作 default）', () => {
    // 原生只有三个合法取值，唯一写入入口 setSystemRoleMode 也校验；
    // 未识别取值没有契约化合并语义，前端保持 unknown。
    expect(normalizeRoleMode('something-new')).toBe('unknown');
    expect(isUnionAllowed('something-new')).toBe(false);
    expect(mustUseUnion('something-new')).toBe(false);
  });

  it('只有 allow-use-union / only-use-union 允许合并角色', () => {
    expect(isUnionAllowed('default')).toBe(false);
    expect(isUnionAllowed('allow-use-union')).toBe(true);
    expect(isUnionAllowed('only-use-union')).toBe(true);
  });

  it('only-use-union 必须使用合并角色', () => {
    expect(mustUseUnion('only-use-union')).toBe(true);
    expect(mustUseUnion('allow-use-union')).toBe(false);
    expect(mustUseUnion('default')).toBe(false);
  });

  it('切换控件的显示遵循原生判定（only-use-union 隐藏）', () => {
    // 原生：options.length > 1 && roleMode !== 'only-use-union'
    expect(shouldShowRoleSwitcher('default', 2, false)).toBe(true);
    expect(shouldShowRoleSwitcher('default', 1, false)).toBe(false);
    expect(shouldShowRoleSwitcher('allow-use-union', 1, true)).toBe(true);
    expect(shouldShowRoleSwitcher('only-use-union', 2, true)).toBe(false);
    expect(shouldShowRoleSwitcher(undefined, 2, false)).toBe(true);
    expect(shouldShowRoleSwitcher('default', 0, false)).toBe(false);
    // unknown：显示规则与原生一致（只排除 only-use-union），但不提供合并角色。
    expect(shouldShowRoleSwitcher('something-new', 2, false)).toBe(true);
    expect(shouldShowRoleSwitcher('something-new', 1, false)).toBe(false);
  });
});

describe('资源动作判定', () => {
  it('root（allowAll）放行全部', () => {
    const ctx = access({ allowAll: true, snippets: ['pm', 'pm.*', 'ui.*'] });
    expect(isResourceActionAllowed(ctx, 'llmServices', 'list')).toBe(true);
    expect(isResourceActionAllowed(ctx, 'roles', 'list')).toBe(true);
  });

  it('pm.* 片段放行 pm 域资源', () => {
    const ctx = access({ snippets: ['pm', 'pm.*', 'ui.*'] });
    expect(isResourceActionAllowed(ctx, 'aiEmployees', 'list')).toBe(true);
    expect(isResourceActionAllowed(ctx, 'workflows', 'list')).toBe(true);
    expect(isResourceActionAllowed(ctx, 'dataSources', 'list')).toBe(true);
    expect(isResourceActionAllowed(ctx, 'llmServices', 'list')).toBe(true);
  });

  it('无片段时仅核心资源由 strategy 兜底（实测口径）', () => {
    const ctx = access({ snippets: [], strategy: { actions: ['view'] } });
    expect(isResourceActionAllowed(ctx, 'users', 'list')).toBe(true);
    expect(isResourceActionAllowed(ctx, 'users', 'get')).toBe(true);
    expect(isResourceActionAllowed(ctx, 'users', 'create')).toBe(false);
    expect(isResourceActionAllowed(ctx, 'roles', 'list')).toBe(true);
    expect(isResourceActionAllowed(ctx, 'dataSources', 'list')).toBe(false);
    expect(isResourceActionAllowed(ctx, 'workflows', 'list')).toBe(false);
    expect(isResourceActionAllowed(ctx, 'aiEmployees', 'list')).toBe(false);
    expect(isResourceActionAllowed(ctx, 'llmServices', 'list')).toBe(false);
  });

  it('默认策略为 null 时拒绝未显式授权的资源', () => {
    const ctx = access({ snippets: [], strategy: null });
    expect(isResourceActionAllowed(ctx, 'users', 'list')).toBe(false);
    expect(isResourceActionAllowed(ctx, 'workflows', 'list')).toBe(false);
  });

  it('内置 member 的 !pm.* 否定片段拒绝 pm 域', () => {
    const ctx = access({ snippets: ['!pm', '!pm.*', '!ui.*'] });
    expect(isResourceActionAllowed(ctx, 'workflows', 'list')).toBe(false);
    expect(isResourceActionAllowed(ctx, 'aiEmployees', 'list')).toBe(false);
  });

  it('显式否定优先于片段放行（实测 aiEmployees:!view → 403）', () => {
    const ctx = access({
      snippets: ['pm', 'pm.*', 'ui.*'],
      actions: { 'aiEmployees:!view': { fields: [] } },
      resources: ['aiEmployees'],
    });
    expect(isResourceActionAllowed(ctx, 'aiEmployees', 'list')).toBe(false);
    expect(isResourceActionAllowed(ctx, 'workflows', 'list')).toBe(true);
  });

  it('显式资源授权在无片段时仍然放行', () => {
    const ctx = access({
      snippets: [],
      actions: { 'workflows:view': { appends: [], fields: ['id'] } },
      resources: ['workflows'],
    });
    expect(isResourceActionAllowed(ctx, 'workflows', 'list')).toBe(true);
    expect(isResourceActionAllowed(ctx, 'workflows', 'create')).toBe(false);
    expect(isResourceActionAllowed(ctx, 'users', 'list')).toBe(false);
  });

  it('actionAlias 把 list 归一为 view', () => {
    const ctx = access({ snippets: [], actionAlias: { list: 'view' } });
    expect(resolveCanonicalAction('list', ctx)).toBe('view');
    expect(resolveCanonicalAction('listMine', ctx)).toBe('listMine');
  });

  it('没有权限上下文时一律拒绝', () => {
    expect(isResourceActionAllowed(null, 'users', 'list')).toBe(false);
    expect(isResourceActionAllowed(undefined, 'users', 'list')).toBe(false);
  });
});

describe('入口级判定与模块可见性', () => {
  it('只要求登录的入口对已登录用户放行', () => {
    const ctx = access({ snippets: [] });
    expect(isPermissionAllowed(ctx, { label: 'x' })).toBe(true);
    expect(isPermissionAllowed(null, { label: 'x' })).toBe(false);
  });

  it('配置角色可见数字员工、工作流、数据源与模型配置', () => {
    const ctx = access({ snippets: ['pm', 'pm.*', 'ui.*'] });
    const visible = filterVisibleModules(resolveModuleVisibility(ctx)).map((m) => m.id);
    expect(visible).toEqual(['workbench', 'ai', 'tasks', 'workflow', 'datasource', 'model', 'access']);
  });

  it('受限角色不会默认放开插件模块（声明式初值）', () => {
    const ctx = access({ snippets: [], strategy: { actions: ['view'] } });
    const visible = filterVisibleModules(resolveModuleVisibility(ctx)).map((m) => m.id);
    expect(visible).toEqual(['workbench', 'access']);
    expect(visible).not.toContain('workflow');
    expect(visible).not.toContain('model');
    expect(visible).not.toContain('ai');
  });

  it('运行期探测结果优先于声明式初值（后端拒绝即不可见）', () => {
    const ctx = access({ snippets: [], strategy: { actions: ['view'] } });
    const probes: ProbeResults = {
      'workbench.read': { status: 'allowed' },
      'ai.use': { status: 'denied', reason: 'forbidden' },
      'tasks.read': { status: 'allowed' },
      'workflow.read': { status: 'denied', reason: 'forbidden' },
      'datasource.read': { status: 'denied', reason: 'forbidden' },
      'model.read': { status: 'denied', reason: 'forbidden' },
      'access.read': { status: 'denied', reason: 'forbidden' },
      'access.users': { status: 'denied', reason: 'forbidden' },
    };
    const visible = filterVisibleModules(resolveModuleVisibility(ctx, probes)).map((m) => m.id);
    expect(visible).toEqual(['workbench', 'tasks']);
    expect(listDeniedModules(ctx, probes).map((m) => m.id)).toContain('model');
  });

  it('unknown（网络/5xx/认证或角色失效）不放行，也不显示为无权限', () => {
    const ctx = access({ snippets: ['pm', 'pm.*'] });
    const probes: ProbeResults = {
      'workbench.read': { status: 'allowed' },
      'ai.use': { status: 'unknown', reason: 'backend-unavailable' },
      'tasks.read': { status: 'unknown', reason: 'network' },
      'workflow.read': { status: 'unknown', reason: 'unauthenticated' },
      'datasource.read': { status: 'denied', reason: 'forbidden' },
      'model.read': { status: 'unknown', reason: 'network' },
      'access.read': { status: 'unknown', reason: 'network' },
      'access.users': { status: 'unknown', reason: 'network' },
      'ai.directory': { status: 'unknown', reason: 'network' },
      'ai.conversations': { status: 'unknown', reason: 'network' },
    };
    const visibility = resolveModuleVisibility(ctx, probes);
    const visible = filterVisibleModules(visibility).map((m) => m.id);
    expect(visible).toEqual(['workbench']);
    expect(listUnknownModules(ctx, probes).map((m) => m.id)).toContain('ai');
    expect(listDeniedModules(ctx, probes).map((m) => m.id)).toEqual(['datasource']);

    const workbenchBoard = MODULE_BY_ID.workbench.boards.find((b) => b.path === 'my-tasks')!;
    const decision = decideAccess(ctx, workbenchBoard.access, workbenchBoard.probeId, probes);
    expect(decision.allowed).toBe(false);
    expect(decision.status).toBe('unknown');
  });

  it('工作台的业务子页需要各自权限', () => {
    const ctx = access({ snippets: [], strategy: null });
    const workbench = MODULE_BY_ID.workbench;
    const employeesBoard = workbench.boards.find((board) => board.path === 'available-employees');
    expect(employeesBoard).toBeDefined();
    expect(isPermissionAllowed(ctx, employeesBoard!.access)).toBe(false);
  });
});

describe('角色切换候选项', () => {
  it('只在 roleMode 允许时提供合并角色', () => {
    const roles = [
      { name: 'crewloom_p1_limited', title: '受限用户' },
      { name: 'crewloom_p1_admin', title: '配置权限' },
    ];
    const none = buildRoleChoices(roles, { allowUnion: false });
    expect(none.map((item) => item.value)).toEqual(['crewloom_p1_limited', 'crewloom_p1_admin']);

    const withUnion = buildRoleChoices(roles, { allowUnion: true });
    expect(withUnion.map((item) => item.value)).toContain(UNION_ROLE);
    expect(withUnion[0].label).toBe('受限用户');
  });

  it('不按角色名硬编码：自定义角色名同样出现在候选中', () => {
    const choices = buildRoleChoices([{ name: 'crewloom_p1_admin' }]);
    expect(choices).toEqual([{ value: 'crewloom_p1_admin', label: 'crewloom_p1_admin' }]);
  });
});
