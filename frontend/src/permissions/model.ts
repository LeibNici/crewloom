import type { AccessControlData, RoleMode } from '../auth/types';

/**
 * 权限判定模型。
 *
 * 本文件不复刻 NocoBase 内核，而是给出 **Crewloom 前端可解释的最小语义**，
 * 用于"是否展示某个入口/按钮"这类产品决策。后端始终是最终判定者：
 * 任何前端判定都不能替代后端 ACL，隐藏入口也不构成安全边界。
 *
 * 依据（真实实例 13080 实测 + 内核证据）：
 *  - allowAll 为真（root）时后端直接旁路，前端按全量放行；
 *  - snippets 采用词法：`pm` / `pm.*` / `ui.*` 为放行，`!pm` / `!pm.*` 为否定（内置 member 即 `!pm`）；
 *  - actions 里 `"<resource>:<action>"` 为显式授权，`"<resource>:!<action>"` 为显式否定；
 *  - resources 列出该角色明确配置过的资源名；
 *  - actionAlias 把实际动作名映射为角色策略里的规范动作名（list→view、move→update……）；
 *  - strategy.actions 是该角色的默认资源策略动作集合（未显式配置资源时的兜底）。
 */

export interface PermissionCheck {
  /** 后端资源名；缺省表示只需要"已登录"。 */
  resource?: string;
  /** 后端资源动作名（真实动作，如 list / listMine / check）。 */
  action?: string;
  /** 任一命中即可的后端权限片段（snippet）。 */
  snippets?: string[];
  /** 说明性文字：该判定对应的产品能力。 */
  label: string;
}

export interface ResourceAction {
  resource: string;
  action: string;
}

export type RoleModeKind = 'default' | 'allow-use-union' | 'only-use-union' | 'unknown';

export const UNION_ROLE = '__union__';

/** 覆盖整个 pm 权限域的片段。 */
const GLOBAL_SNIPPET_ALLOWS = ['pm', 'pm.*'];
/** 覆盖整个 pm 权限域的否定片段。 */
const GLOBAL_SNIPPET_DENIES = ['!pm', '!pm.*'];

/**
 * 允许由角色默认策略（strategy.actions）兜底放行的核心资源。
 * 实测：仅有 `view` 策略、无任何权限片段的角色，仍可读 users / roles / collections
 * 与 desktopRoutes，但对插件资源返回 403。
 */
const STRATEGY_FALLBACK_RESOURCES = new Set([
  'users',
  'roles',
  'collections',
  'desktopRoutes',
  'uiLayouts',
  'dataSourcesRolesResources',
  'dataSourcesRolesResourcesScopes',
]);

export function isStrategyFallbackResource(resource: string): boolean {
  return STRATEGY_FALLBACK_RESOURCES.has(resource);
}

/**
 * 归一化 `roles:check.roleMode`。
 *
 * 固定 2.2.22 原生契约（`plugin-acl/src/server/enum.ts:10-17`）只有三个合法取值
 * `default` / `allow-use-union` / `only-use-union`，且唯一写入入口 `setSystemRoleMode`
 * 会用 `SystemRoleMode.validate` 拒绝其它取值（`.../server/actions/union-role.ts:11-16`）。
 * 读取路径 `systemSettings?.roleMode || SystemRoleMode.default`
 * （`.../server/actions/role-check.ts:71`、`.../middlewares/setCurrentRole.ts:125`）说明：
 *  - 缺省 / 空值 → 原生缺省就是 `default`，可以按 `default` 处理；
 *  - 三个合法值 → 原样；
 *  - **非空但不在枚举内**（只能来自直接写库或历史数据）→ 原生没有契约化的语义，
 *    前端保持 `unknown`：不据此提供合并角色，也不把它悄悄当成 `default`。
 */
export function normalizeRoleMode(mode: RoleMode | undefined | null): RoleModeKind {
  if (mode === undefined || mode === null || mode === '') return 'default';
  if (mode === 'default' || mode === 'allow-use-union' || mode === 'only-use-union') return mode;
  return 'unknown';
}

/** 只有这两种模式允许使用"合并全部角色"。 */
export function isUnionAllowed(mode: RoleMode | undefined): boolean {
  const kind = normalizeRoleMode(mode);
  return kind === 'allow-use-union' || kind === 'only-use-union';
}
/** only-use-union 模式下不允许只以单个角色工作。 */
export function mustUseUnion(mode: RoleMode | undefined): boolean {
  return normalizeRoleMode(mode) === 'only-use-union';
}

function readStrategyActions(access: AccessControlData): string[] {
  const strategy = access.strategy;
  if (!strategy || typeof strategy !== 'object') return [];
  const actions = (strategy as { actions?: unknown }).actions;
  if (!Array.isArray(actions)) return [];
  return actions.filter((item): item is string => typeof item === 'string');
}

export function isPositiveSnippet(snippet: string): boolean {
  return !snippet.startsWith('!');
}

export function isNegativeSnippet(snippet: string): boolean {
  return snippet.startsWith('!');
}

/** 片段通配匹配：`pm.*` 命中 `pm.*` 与 `pm`，也命中 `pm.ai`。 */
export function snippetMatches(patterns: string[], wanted: string): boolean {
  return patterns.some((pattern) => {
    if (pattern === wanted) return true;
    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -1); // 保留下 `pm.` 前缀
      const head = pattern.slice(0, -2); // `pm`
      return wanted.startsWith(prefix) || wanted === head;
    }
    return false;
  });
}

/** 是否存在覆盖整个 pm 域的片段（`pm` 或 `pm.*`）。 */
export function hasGlobalPmSnippet(snippets: string[]): boolean {
  return snippets.some((snippet) => GLOBAL_SNIPPET_ALLOWS.includes(snippet));
}

export function hasGlobalPmDenial(snippets: string[]): boolean {
  return snippets.some((snippet) => GLOBAL_SNIPPET_DENIES.includes(snippet));
}

/** 把真实动作名映射为角色策略里的规范动作名（roles:check.actionAlias）。 */
export function resolveCanonicalAction(action: string, access: AccessControlData | null | undefined): string {
  const alias = access?.actionAlias?.[action];
  return typeof alias === 'string' && alias.length > 0 ? alias : action;
}

export type ExplicitGrant = 'allow' | 'deny' | undefined;

/** 查询 `roles:check.actions` 中该资源动作的显式配置（含否定形式）。 */
export function explicitGrant(
  access: AccessControlData,
  resource: string,
  action: string,
): ExplicitGrant {
  const canonical = resolveCanonicalAction(action, access);
  const actionKeys = Array.from(new Set([action, canonical]));
  for (const key of actionKeys) {
    if (Object.prototype.hasOwnProperty.call(access.actions, `${resource}:!${key}`)) return 'deny';
  }
  for (const key of actionKeys) {
    if (Object.prototype.hasOwnProperty.call(access.actions, `${resource}:${key}`)) return 'allow';
  }
  return undefined;
}

/**
 * 判定某个资源动作是否被当前权限上下文允许。
 *
 * 判定顺序（与实测行为对照）：
 *  1. allowAll（root）→ 放行；
 *  2. 显式否定 `resource:!action` → 拒绝；
 *  3. 全局否定片段（`!pm`/`!pm.*`）且无显式资源授权 → 拒绝；
 *  4. 全局放行片段（`pm`/`pm.*`）或针对该资源的片段命中 → 放行；
 *  5. 显式资源动作授权 → 放行；
 *  6. 角色默认策略动作集合（含 actionAlias 规范化）→ **仅核心资源**放行
 *     （实测：strategy 的 view 只对 users / roles / collections 等核心资源生效，
 *      对 dataSources / workflows / aiEmployees / llmServices 等插件资源仍 403；
 *      因此兜底必须限定在已核实的内核资源集合内，避免误显示入口）；
 *  7. 其余 → 拒绝。
 */
export function isResourceActionAllowed(
  access: AccessControlData | null | undefined,
  resource: string,
  action: string,
): boolean {
  if (!access) return false;
  if (access.allowAll) return true;

  if (explicitGrant(access, resource, action) === 'deny') return false;

  const snippets = access.snippets ?? [];
  const globalDenied = hasGlobalPmDenial(snippets);
  const resourceSnippets = snippets.filter((snippet) => !GLOBAL_SNIPPET_ALLOWS.includes(snippet) && !GLOBAL_SNIPPET_DENIES.includes(snippet));
  const resourceSnippetDenied = resourceSnippets.some(
    (snippet) => isNegativeSnippet(snippet) && snippetMatches([snippet.replace(/^!/, '')], resource),
  );

  if ((globalDenied || resourceSnippetDenied) && explicitGrant(access, resource, action) !== 'allow') {
    return false;
  }

  if (hasGlobalPmSnippet(snippets)) return true;
  if (snippetMatches(snippets.filter(isPositiveSnippet), resource)) return true;

  if (explicitGrant(access, resource, action) === 'allow') return true;

  if (isStrategyFallbackResource(resource)) {
    const strategyActions = readStrategyActions(access);
    if (strategyActions.includes(action)) return true;
    const canonical = resolveCanonicalAction(action, access);
    if (strategyActions.includes(canonical)) return true;
  }

  return false;
}

/** 判定一个入口级权限项。 */
export function isPermissionAllowed(
  access: AccessControlData | null | undefined,
  check: PermissionCheck,
): boolean {
  if (!access) return false;
  if (check.resource && check.action) {
    return isResourceActionAllowed(access, check.resource, check.action);
  }
  if (check.snippets && check.snippets.length > 0) {
    if (access.allowAll) return true;
    const snippets = access.snippets ?? [];
    const denied = snippets.filter(isNegativeSnippet);
    if (check.snippets.some((snippet) => denied.includes(`!${snippet}`))) return false;
    return check.snippets.some((snippet) => snippetMatches(snippets, snippet));
  }
  // 只要求"已登录"的入口。
  return true;
}

/** 用户可见的角色切换目标。 */
export interface RoleChoice {
  value: string;
  label: string;
}

/**
 * 角色标题的用户可读化。
 *
 * 13000（2.2.20）实测：`auth:check.data.roles[].title` 可能是**未翻译的 i18n 模板**
 * （例如 `{{t("Root")}}`）。后端把它交给前端 i18n 渲染，而当前实例的 `localization`
 * 插件未启用。原样显示会把内部模板语法暴露给用户，因此这里取模板里的原文（`Root`）
 * 作为展示名；标题为空时返回 null，由界面统一显示"当前角色"。
 */
export function roleTitleLabel(title: string | null | undefined): string | null {
  const trimmed = typeof title === 'string' ? title.trim() : '';
  if (!trimmed) return null;
  const template = trimmed.match(/^\{\{\s*t\(\s*["'`]([^"'`]+)["'`]/);
  if (template) return template[1].trim() || null;
  return trimmed;
}

/**
 * `__union__` 是否可用取自当前 roles:check 的 roleMode，不按角色名硬编码。
 * 只有角色名出现在"该用户拥有的角色"里才是合法切换目标；后端对越权角色会
 * 返回 401 ROLE_NOT_FOUND_FOR_USER（实测）。
 */
export function buildRoleChoices(
  roles: Array<{ name: string; title?: string | null }>,
  options: { allowUnion?: boolean; unionLabel?: string } = {},
): RoleChoice[] {
  const choices = roles.map((role) => ({
    value: role.name,
    label: roleTitleLabel(role.title) ?? role.name,
  }));
  if (options.allowUnion) {
    choices.push({ value: UNION_ROLE, label: options.unionLabel ?? '合并全部角色' });
  }
  return choices;
}

/**
 * 是否渲染角色切换控件。
 *
 * 原生判定（client-v2 `SwitchRoleItemModel.tsx:42`、v1 `SwitchRole.tsx:35`）：
 * `options.length > 1 && roleMode !== 'only-use-union'`，其中 `options` 是"所属角色
 * （+ allow-use-union 时的合并角色）"。因此：
 *  - `only-use-union`：**不显示**切换控件（服务端强制合并，选择单项无效）；
 *  - `default`：不提供合并角色，只有多于一个所属角色时才显示；
 *  - `allow-use-union`：合并角色与已授权单角色都可选；
 *  - `unknown`（非空但不在原生枚举内）：与原生相同的显示规则（只排除 `only-use-union`），
 *    但不提供合并角色——因为该取值的合并语义没有契约依据。
 */
export function shouldShowRoleSwitcher(
  mode: RoleMode | undefined,
  roleCount: number,
  unionAllowed: boolean,
): boolean {
  if (normalizeRoleMode(mode) === 'only-use-union') return false;
  return roleCount + (unionAllowed ? 1 : 0) > 1;
}

