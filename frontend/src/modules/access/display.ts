/**
 * 组 B 的展示辅助（access + datasource 共用的小函数）。
 *
 * 背景：NocoBase 的角色 / 菜单标题常以 i18n 占位符形式存储，
 * 例如 `{{t("Admin")}}`、`{{t("Root")}}`。原生客户端会用 i18n 包翻译；
 * Crewloom 当前没有加载这些语言包，若原样显示会给非技术用户看到 `{{t("Admin")}}` 这类文本。
 *
 * 这里只做**最小、可解释**的降级：占位符取其中的可读键名；其它情况原样返回。
 * 不是翻译系统，也不猜测语言；未识别的形状保持原文，便于核对。
 */

import aiLocaleZhCN from '@nocobase/plugin-ai/dist/locale/zh-CN.json';

export interface HasTitle {
  name?: string | null;
  title?: string | null;
}

/**
 * 后台 i18n 模板里少数需要固定中文展示名的 key。
 *
 * 只用于**展示**，不改任何保存值，也不参与权限/范围判定：
 * 数据源的标题、内置记录范围的名称在后台是 `{{t("Main")}}` / `{{t("All records")}}` / `{{t("Own records")}}`，
 * 当前实例没有加载本地化包，取 key 原文会显示英文。这里给这几个系统项一个稳定的中文名；
 * 其它 key 仍按原文显示，便于核对而不是猜翻译。
 */
const BACKEND_TITLE_LABELS: Record<string, string> = {
  Main: '主数据源',
  'All records': '全部记录',
  'Own records': '仅本人记录',
};

/**
 * 内置技能标题的**最小**补充译名。
 *
 * 优先顺序：固定官方中文资源（`@nocobase/plugin-ai@2.2.22` 的 `dist/locale/zh-CN.json`）→
 * 下面这张表 → 原样返回 key。官方资源里存在 `ai.skills.documentSearch.title`（文档检索）、
 * `ai.skills.frontendDeveloper.title`（前端开发）、`ai.skills.businessAnalysisReport.title`（业务分析报告）；
 * 另外 3 个内置技能在 2.2.22 的官方资源里**没有**对应键，这里按内置技能的官方称呼补最小显示名，
 * **只用于展示**，不改 `skill.name` / 保存值，也不动用户自定义标题（未命中模板形态时原文返回）。
 */
const BUILTIN_SKILL_TITLE_FALLBACK: Record<string, string> = {
  'ai.skills.dataQuery.title': '数据查询',
  'ai.skills.dataMetadata.title': '数据结构信息',
  'ai.skills.dataModeling.title': '数据建模',
};

/** 后台 i18n key → 展示名：官方中文资源优先，其次固定表，最后原样返回 key。 */
function backendKeyLabel(key: string): string {
  const official = (aiLocaleZhCN as Record<string, string>)[key];
  if (typeof official === 'string' && official.trim() !== '') return official;
  return BACKEND_TITLE_LABELS[key] ?? BUILTIN_SKILL_TITLE_FALLBACK[key] ?? key;
}

/**
 * 取后台标题模板里的可读名称；`{{t("Admin")}}` → `Admin`。
 *
 * 只有**模板形态**才套用固定中文展示名：普通字符串（例如用户给集合起的标题）原样返回，
 * 避免把业务命名误当系统项改名。
 */
export function templateLabel(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const placeholder = /^\{\{\s*t\(\s*["']([^"']+)["']/.exec(raw.trim());
  if (!placeholder || !placeholder[1]) return null;
  const key = placeholder[1].trim();
  return backendKeyLabel(key);
}

/**
 * 内置技能的**明文 key** 形态（`ai.skills.*.title`）。
 *
 * 真实后端可能直接返回 key 原文而不是 `{{t(...)}}` 模板（Main 在 5361 只见 key）。
 * 只对 `ai.skills.` 这一内部命名空间做映射：其它明文（用户自定义标题）原样返回，
 * 避免把业务命名当成系统项改名。未收录的 `ai.skills.*` key 仍原样返回。
 */
function internalSkillKeyLabel(value: string): string | null {
  if (!value.startsWith('ai.skills.')) return null;
  return backendKeyLabel(value);
}

/** 取角色/资源的可读标题；`{{t("Admin")}}` → `Admin`，`ai.skills.*.title` → 内置技能中文名。 */
export function displayTitle(raw: string | null | undefined, fallback: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') return fallback;
  const trimmed = raw.trim();
  return templateLabel(raw) ?? internalSkillKeyLabel(trimmed) ?? trimmed;
}

/** 角色显示名：优先标题，其次角色标识。 */
export function roleLabel(role: HasTitle): string {
  const name = typeof role.name === 'string' && role.name !== '' ? role.name : '未命名角色';
  return displayTitle(role.title, name);
}
