import { describe, expect, it } from 'vitest';
import {
  isWorkflowHomeTarget,
  resolveNativeLinkTarget,
} from '../../../src/modules/workflow/native/nativeLinkTarget';

/**
 * 原生画布宿主链接目标（主模型电脑端实测：面包屑 DOM `href="[object Object]"`、点击无法返回）。
 *
 * 断言的是**与 react-router Link/router 的真实传参契约**：
 *  - `useHref()` 把解析后的路径对象交给 navigator 的 `createHref()`；
 *  - `useNavigate()` / `navigate()` 也传路径对象。
 * 因此解析函数必须同时接受字符串与对象，并且绝不产生 `[object Object]`。
 *
 * 这里只导入纯函数模块，不加载原生运行时（后者在 jsdom 下无法装载）。
 */
describe('原生画布链接目标解析', () => {
  it('字符串目标原样返回', () => {
    expect(resolveNativeLinkTarget('/admin/settings/workflow')).toBe('/admin/settings/workflow');
    expect(resolveNativeLinkTarget('/admin/workflow/workflows/9')).toBe('/admin/workflow/workflows/9');
  });

  it('路径对象拼成真实 URL，而不是 [object Object]', () => {
    expect(
      resolveNativeLinkTarget({ pathname: '/admin/settings/workflow', search: '', hash: '' }),
    ).toBe('/admin/settings/workflow');
    expect(resolveNativeLinkTarget({ pathname: '/admin/settings/workflow' })).toBe('/admin/settings/workflow');
    expect(
      resolveNativeLinkTarget({ pathname: '/admin/workflow/workflows/9', search: '?x=1', hash: '#node' }),
    ).toBe('/admin/workflow/workflows/9?x=1#node');
    expect(resolveNativeLinkTarget({ pathname: '/admin/settings/workflow', search: '?a=1' })).not.toContain('[object');
  });

  it('识别原生「工作流」首页（含 query/hash 与 legacy 前缀）', () => {
    expect(isWorkflowHomeTarget('/admin/settings/workflow')).toBe(true);
    expect(isWorkflowHomeTarget('/admin/workflow')).toBe(true);
    expect(isWorkflowHomeTarget('/admin/settings/workflow?foo=1')).toBe(true);
    expect(isWorkflowHomeTarget({ pathname: '/admin/settings/workflow', search: '', hash: '' })).toBe(true);
    expect(isWorkflowHomeTarget('/admin/settings/workflow/workflows/9')).toBe(false);
    expect(isWorkflowHomeTarget('/admin/workflow/workflows/9')).toBe(false);
  });
});
