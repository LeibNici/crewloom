import { describe, expect, it } from 'vitest';
import aiLocaleZhCN from '@nocobase/plugin-ai/dist/locale/zh-CN.json';
import { installNativeChatI18n } from '../../../src/modules/ai/native/nativeChatI18n';

/**
 * 原生会话的中文资源装配。
 *
 * 背景（Main 实测）：AI-03 页面上 Conversation list / New conversation / AI disclaimer 显示英文，
 * 因为宿主只补过"错误文案"，没有把**插件发布包**里的官方中文资源注册进 Application 的 i18n。
 * 这里断言装配函数确实注册了官方 zh-CN 资源，并且键值与固定包一致（不手写译文）。
 */
describe('原生会话中文资源装配', () => {
  it('把固定包的官方 zh-CN 资源注册进各命名空间，并以中文启动', () => {
    const calls: Array<{ lng: string; ns: string; hasNewConversation: boolean }> = [];
    let changedTo: string | null = null;
    const app = {
      i18n: {
        language: 'en-US',
        changeLanguage: async (language: string) => {
          changedTo = language;
          return undefined;
        },
        addResourceBundle: (lng: string, ns: string, resources: Record<string, unknown>) => {
          calls.push({ lng, ns, hasNewConversation: resources['New conversation'] === aiLocaleZhCN['New conversation'] });
        },
      },
    };

    installNativeChatI18n(app);

    // 三个命名空间 × 两种语言都铺了官方资源
    const namespaces = new Set(calls.map((call) => call.ns));
    expect([...namespaces].sort()).toEqual(['@nocobase/plugin-ai', 'ai', 'client']);
    expect(calls.length).toBeGreaterThanOrEqual(6);
    // 每个命名空间至少有一条官方资源注册（同一命名空间还会再叠一层本产品错误文案）
    for (const ns of namespaces) {
      expect(calls.some((call) => call.ns === ns && call.hasNewConversation)).toBe(true);
    }
    // 中文界面：语言切到 zh-CN
    expect(changedTo).toBe('zh-CN');
    // 与固定包一致（防止有人手写译文替换）
    expect(aiLocaleZhCN['New conversation']).toBe('新建对话');
    expect(aiLocaleZhCN['Conversation list']).toBe('会话列表');
  });

  it('官方 locale 缺失的可见 key 补中文：会话列表的 Conversations / Workflow tasks', () => {
    // 固定 2.2.22 的 `@nocobase/plugin-ai` zh-CN/en-US 都没有这两个 key，
    // 所以 t() 原样显示英文；这里断言宿主确实补上了中文，且不改写官方已有译文。
    const official = aiLocaleZhCN as Record<string, string | undefined>;
    expect(official['Conversations']).toBeUndefined();
    expect(official['Workflow tasks']).toBeUndefined();

    const registered: Record<string, unknown>[] = [];
    const app = {
      i18n: {
        language: 'zh-CN',
        changeLanguage: async () => undefined,
        addResourceBundle: (_lng: string, _ns: string, resources: Record<string, unknown>) => {
          registered.push(resources);
        },
      },
    };
    installNativeChatI18n(app);
    const merged = Object.assign({}, ...registered) as Record<string, unknown>;
    expect(merged['Conversations']).toBe('会话');
    expect(merged['Workflow tasks']).toBe('流程待办');
    expect(merged['Filter by status']).toBe('按状态筛选');
    // 官方已有译文的键保持官方值（补丁只覆盖缺失 key）。
    expect(merged['Conversation list']).toBe(aiLocaleZhCN['Conversation list']);
    expect(merged['New conversation']).toBe(aiLocaleZhCN['New conversation']);
    // 中文错误说明继续生效（44 的修复不回退）。
    expect(merged['network error']).toBeTruthy();
  });
});
