import { describe, expect, it } from 'vitest';
import { displayTitle } from '../../../src/modules/access/display';

/**
 * 真实内置技能标题（Main 在 5361 真实只读看到 ToolsPage 显示内部 i18n key）。
 *
 * 判别力：旧实现只把 `{{t("…")}}` 剥成 key 就返回，下面这些模板输入会得到
 * `ai.skills.*.title`；修复后必须得到可读中文（官方资源优先，缺键的 3 项用最小译名）。
 */
describe('内置技能标题可读（ToolsPage / EmployeeConfigPage 同一入口 displayTitle）', () => {
  const cases: Array<[string, string]> = [
    ['ai.skills.documentSearch.title', '文档检索'],
    ['ai.skills.dataQuery.title', '数据查询'],
    ['ai.skills.dataMetadata.title', '数据结构信息'],
    ['ai.skills.dataModeling.title', '数据建模'],
    ['ai.skills.frontendDeveloper.title', '前端开发'],
    ['ai.skills.businessAnalysisReport.title', '业务分析报告'],
  ];

  it('后端模板形态 → 可读中文，且不再出现内部 key', () => {
    for (const [key, label] of cases) {
      const raw = `{{t("${key}", {"ns":"@nocobase/plugin-ai"})}}`;
      const shown = displayTitle(raw, 'fallback');
      expect(shown, `key=${key}`).toBe(label);
      expect(shown, `key=${key} 不应暴露内部 key`).not.toContain('ai.skills.');
    }
  });

  it('已是 key 明文时也能给出可读中文（同一入口）', () => {
    expect(displayTitle('ai.skills.dataQuery.title', 'fallback')).toBe('数据查询');
  });

  it('用户自定义明文标题原样保留，不因缺少翻译被改写', () => {
    expect(displayTitle('我的自定义技能', 'fallback')).toBe('我的自定义技能');
    expect(displayTitle('{{t("My Custom Skill")}}', 'fallback')).toBe('My Custom Skill');
  });

  it('空标题仍回退到标识（保存标识不改）', () => {
    expect(displayTitle('', 'ai.skills.dataQuery')).toBe('ai.skills.dataQuery');
    expect(displayTitle(null, 'skill-id')).toBe('skill-id');
  });
});
