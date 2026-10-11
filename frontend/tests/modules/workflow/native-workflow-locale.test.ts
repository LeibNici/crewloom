import { describe, expect, it } from 'vitest';
import aiZhCN from '@nocobase/plugin-ai/dist/locale/zh-CN.json';
import clientZhCN from '@nocobase/client/lib/locale/zh-CN.json';
import workflowZhCN from '@nocobase/plugin-workflow/dist/locale/zh-CN.json';
import {
  NATIVE_WORKFLOW_LOCALES,
  installNativeWorkflowI18n,
} from '../../../src/modules/workflow/native/nativeWorkflowI18n';

/**
 * WF 原生画布 / 节点面板的中文来源。
 *
 * 背景（Main 实测）：44 只给 AI 会话注册了官方 zh-CN，WF 宿主没有注册，于是 i18next 无 key 命中，
 * 画布与抽屉原样显示英文 key（`Test run` / `Submit` / `Cancel`、节点题名 `Calculation`…）。
 * 这里断言装配函数注册的是**固定版本官方资源**、命名空间与源码 `NAMESPACE` 一致、并切到中文，
 * 而不是手写一份译文。
 */
describe('WF 原生中文资源装配', () => {
  it('把官方 zh-CN 按真实命名空间注册进本实例 i18n，并切到 zh-CN', () => {
    const calls: Array<{ lng: string; ns: string; resources: Record<string, unknown>; deep?: boolean; overwrite?: boolean }> =
      [];
    let changedTo: string | null = null;
    const app = {
      i18n: {
        language: 'en-US',
        changeLanguage: async (language: string) => {
          changedTo = language;
          return undefined;
        },
        addResourceBundle: (
          lng: string,
          ns: string,
          resources: Record<string, unknown>,
          deep?: boolean,
          overwrite?: boolean,
        ) => {
          calls.push({ lng, ns, resources, deep, overwrite });
        },
      },
    };

    installNativeWorkflowI18n(app);

    // 语言初始化（flowEngine.context.i18n 与 app.i18n 是同一个实例）。
    expect(changedTo).toBe('zh-CN');
    expect(calls.every((call) => call.lng === 'zh-CN')).toBe(true);
    // 覆盖式写入：必须在 `app.load()`（LocalePlugin.afterAdd）之后生效。
    expect(calls.every((call) => call.deep === true && call.overwrite === true)).toBe(true);

    const byNs = new Map(calls.map((call) => [call.ns, call.resources]));
    // 三处关键来源：通用 client、工作流 workflow、AI 员工节点 ai-employee 的题名。
    expect(byNs.get('client')).toBe(clientZhCN);
    expect(byNs.get('workflow')).toBe(workflowZhCN);
    expect(byNs.get('@nocobase/plugin-ai')).toBe(aiZhCN);
    // known 27 类型里其它插件也各有自己的 namespace。
    expect(byNs.has('workflow-javascript')).toBe(true);
    expect(byNs.has('workflow-manual')).toBe(true);
    expect(byNs.has('@nocobase/plugin-workflow-manual')).toBe(true);
    expect(byNs.has('notification-manager')).toBe(true);

    // 每个注册项都对应一个真实有内容的官方资源包，且没有把同一个 namespace 铺两遍。
    const registered = calls.map((call) => call.ns);
    expect(new Set(registered).size).toBe(registered.length);
    expect(NATIVE_WORKFLOW_LOCALES.every((entry) => Object.keys(entry.resources).length > 0)).toBe(true);
  });

  it('关键面板/按钮文案确实来自官方固定包（不手写译文）', () => {
    // 画布与节点抽屉：来自 plugin-workflow。
    expect(workflowZhCN['Test run']).toBe('测试执行');
    expect(workflowZhCN['Copy']).toBe('复制');
    expect(workflowZhCN['Paste']).toBe('粘贴');
    expect(workflowZhCN['Calculation']).toBe('计算');
    // 通用按钮：来自 client（flow-engine 的默认命名空间）。
    expect(clientZhCN['Submit']).toBe('提交');
    expect(clientZhCN['Cancel']).toBe('取消');
    // Main 看到的 `ai-employee` 原始名：官方题名走 plugin-ai 的命名空间。
    expect(aiZhCN['AI employee']).toBe('AI 员工');
  });
});
