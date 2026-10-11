import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAuthContext,
  getHttpClient,
  onSessionExpired,
  resetAuthContext,
  setApiBase,
  setAuthContext,
} from '../src/api/client';
import { CrewloomError } from '../src/api/errors';
import {
  changePassword,
  changePasswordErrorMessage,
  describePasswordRecovery,
  readOwnRoles,
} from '../src/auth/api';
import {
  fetchAttachmentCapability,
  fetchDefaultStorage,
  formatFileSize,
  resolveFileUrl,
  uploadAttachment,
} from '../src/api/attachments';
import { languageLabel, normalizeSystemSettings } from '../src/api/systemSettings';
import { UnavailableState } from '../src/components/Card';
import { buildRoleChoices, roleTitleLabel } from '../src/permissions/model';
import { resolveRouteTarget } from '../src/modules/registry';

/**
 * 公共页面（PUB-01 / PUB-04 / PUB-05 / PUB-06）的定向测试。
 *
 * 全部走真实请求管线 + **受控 adapter**：
 *  - 断言真实发出的方法、路径、参数与请求体形状；
 *  - 不访问 13000，不发真实上传、不发真实重置邮件。
 * 真实只读能力核对见 `scripts/probe-public-13000.mjs`（`pnpm run verify:public`）。
 */

interface Captured {
  data?: unknown;
  params?: unknown;
  method?: string;
  url?: string;
}

interface Reply {
  status?: number;
  body: unknown;
}

let captured: Captured[] = [];
let handler: (config: InternalAxiosRequestConfig) => Reply | Promise<Reply> = () => ({ body: { data: {} } });

function installAdapter(): void {
  const client = getHttpClient();
  client.defaults.adapter = async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
    captured.push({
      data: config.data,
      params: config.params,
      method: config.method,
      url: config.url,
    });
    const reply = await handler(config);
    const status = reply.status ?? 200;
    const response: AxiosResponse = {
      data: reply.body,
      status,
      statusText: String(status),
      headers: {},
      config,
    };
    if (status >= 400) {
      throw new AxiosError(
        `Request failed with status code ${status}`,
        'ERR_BAD_REQUEST',
        config,
        undefined,
        response,
      );
    }
    return response;
  };
}

beforeEach(() => {
  window.localStorage.clear();
  setApiBase('/api');
  resetAuthContext();
  setAuthContext({ authenticator: 'basic', token: 'test-token' });
  captured = [];
  handler = () => ({ body: { data: {} } });
  installAdapter();
});

afterEach(() => {
  resetAuthContext();
  window.localStorage.clear();
});

describe('PUB-06 系统设置归一', () => {
  it('只有后端明确 false 才关闭改密能力', () => {
    expect(normalizeSystemSettings({ enableChangePassword: undefined }).allowChangePassword).toBe(true);
    expect(normalizeSystemSettings({ enableChangePassword: true }).allowChangePassword).toBe(true);
    expect(normalizeSystemSettings({ enableChangePassword: false }).allowChangePassword).toBe(false);
  });

  it('品牌字段按需取用，缺少时不编造', () => {
    const snapshot = normalizeSystemSettings({
      title: '某后台应用',
      logo: { url: '/files/main/main/attachments/4.png' },
      enabledLanguages: ['zh-CN', 'en-US'],
      appLang: 'zh-CN',
      roleMode: 'allow-use-union',
    });
    expect(snapshot.title).toBe('某后台应用');
    expect(snapshot.logoUrl).toBe('/files/main/main/attachments/4.png');
    expect(snapshot.enabledLanguages).toEqual(['zh-CN', 'en-US']);

    const empty = normalizeSystemSettings(null);
    expect(empty.title).toBeNull();
    expect(empty.logoUrl).toBeNull();
    expect(empty.enabledLanguages).toEqual([]);
  });

  it('语言代码转用户可读名称，未知代码原样返回', () => {
    expect(languageLabel('zh-CN')).toBe('简体中文');
    expect(languageLabel('en-US')).toBe('English');
    expect(languageLabel('xx-XX')).toBe('xx-XX');
    expect(languageLabel(null)).toBeNull();
  });
});

describe('PUB-01 账号能力', () => {
  it('找回密码只认认证方式公开选项里的 enableResetPassword', () => {
    expect(describePasswordRecovery([{ name: 'basic', options: {} }]).available).toBe(false);
    expect(describePasswordRecovery([{ name: 'basic' }]).available).toBe(false);
    expect(describePasswordRecovery([{ name: 'basic', options: { enableResetPassword: true } }]).available).toBe(
      true,
    );
    expect(describePasswordRecovery([]).available).toBe(false);
  });

  it('修改密码走 POST auth:changePassword，请求体就是三个口令字段', async () => {
    handler = () => ({ body: { data: { id: 1 } } });
    await changePassword({ oldPassword: 'a', newPassword: 'b', confirmPassword: 'b' });

    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe('post');
    expect(captured[0].url).toBe('auth:changePassword');
    // adapter 看到的是 axios 序列化后的请求体：JSON 字符串，内容就是三个口令字段（没有 values 包装）。
    expect(JSON.parse(String(captured[0].data))).toEqual({
      oldPassword: 'a',
      newPassword: 'b',
      confirmPassword: 'b',
    });
  });

  it('旧密码不对（401）不得按会话失效广播，否则用户会被登出', async () => {
    const expired = vi.fn();
    const unsubscribe = onSessionExpired(expired);
    const tokenBefore = getAuthContext().token;
    handler = () => ({ status: 401, body: { errors: [{ message: 'The password is incorrect', code: null }] } });

    await expect(
      changePassword({ oldPassword: 'wrong', newPassword: 'b', confirmPassword: 'b' }),
    ).rejects.toBeInstanceOf(CrewloomError);

    expect(expired).not.toHaveBeenCalled();
    expect(getAuthContext().token).toBe(tokenBefore);
    unsubscribe();
  });

  it('失败文案区分原密码错误与后台关闭改密，且不出现状态码', () => {
    const wrong = changePasswordErrorMessage(
      new CrewloomError({ kind: 'unauthenticated', userMessage: 'x', status: 401 }),
    );
    const disabled = changePasswordErrorMessage(
      new CrewloomError({ kind: 'forbidden', userMessage: 'x', status: 403 }),
    );
    expect(wrong).toContain('原密码不正确');
    expect(disabled).toContain('未允许自助修改密码');
    expect(`${wrong}${disabled}`).not.toMatch(/401|403/);
  });

  it('角色读取仍只认 auth:check 的 roles 字段', () => {
    expect(readOwnRoles({ id: 1, roles: [{ name: 'admin', title: '管理员' }] })).toHaveLength(1);
    expect(readOwnRoles({ id: 1 })).toEqual([]);
  });

  it('未翻译的 i18n 角色标题不原样显示（13000 的 localization 插件未启用）', () => {
    expect(roleTitleLabel('{{t("Root")}}')).toBe('Root');
    expect(roleTitleLabel('{{ t("管理员", {"ns":"x"}) }}')).toBe('管理员');
    expect(roleTitleLabel('超级管理员')).toBe('超级管理员');
    expect(roleTitleLabel('   ')).toBeNull();
    expect(roleTitleLabel(null)).toBeNull();
    expect(buildRoleChoices([{ name: 'root', title: '{{t("Root")}}' }])[0].label).toBe('Root');
    expect(buildRoleChoices([{ name: 'root', title: null }])[0].label).toBe('root');
  });
});

describe('PUB-04 附件能力', () => {
  it('地址归一：完整地址原样、站内路径补斜杠、取不到返回 null', () => {
    expect(resolveFileUrl({ url: '/files/main/main/attachments/4.png' })).toBe(
      '/files/main/main/attachments/4.png',
    );
    expect(resolveFileUrl('https://cdn.test/a.png')).toBe('https://cdn.test/a.png');
    expect(resolveFileUrl('files/main/a.png')).toBe('/files/main/a.png');
    expect(resolveFileUrl(null)).toBeNull();
    expect(resolveFileUrl({})).toBeNull();
  });

  it('体积只给用户可读单位', () => {
    expect(formatFileSize(2048)).toBe('2.0 KB');
    expect(formatFileSize(0)).toBeNull();
    expect(formatFileSize(null)).toBeNull();
  });

  it('storages:getBasicInfo 404 表示"没有可用存储"，不是读取失败', async () => {
    handler = () => ({ status: 404, body: { errors: [{ message: 'not found' }] } });
    expect(await fetchDefaultStorage()).toBeNull();
  });

  it('其它错误仍然抛出，由调用方区分"读不到"与"没有"', async () => {
    handler = () => ({ status: 500, body: { errors: [{ message: 'boom' }] } });
    await expect(fetchDefaultStorage()).rejects.toBeInstanceOf(CrewloomError);
  });

  it('有默认存储时上传可用，并带上存储上限', async () => {
    handler = () => ({
      body: { data: { id: 389922132131840, name: 'local', type: 'local', title: 'Local storage', rules: { size: 10485760 } } },
    });
    const capability = await fetchAttachmentCapability();
    expect(capability.canUpload).toBe(true);
    expect(capability.storage?.maxSizeBytes).toBe(10485760);
    expect(capability.message).toBeNull();
  });

  it('上传走 multipart POST attachments:upload，且只由用户操作触发', async () => {
    handler = () => ({
      body: {
        data: {
          id: 12,
          filename: 'a.txt',
          url: '/files/main/main/attachments/12.txt',
        },
      },
    });
    const file = new File(['hello'], 'a.txt', { type: 'text/plain' });
    const record = await uploadAttachment(file, { attachmentField: 'users.avatar' });

    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe('post');
    expect(captured[0].url).toBe('attachments:upload');
    expect((captured[0].params as Record<string, unknown>).attachmentField).toBe('users.avatar');
    expect(captured[0].data).toBeInstanceOf(FormData);
    expect((captured[0].data as FormData).get('file')).toBe(file);
    expect(record.url).toBe('/files/main/main/attachments/12.txt');
  });

  it('上传响应缺少记录时明确失败，不伪造成功', async () => {
    handler = () => ({ body: { data: null } });
    const file = new File(['hello'], 'a.txt', { type: 'text/plain' });
    await expect(uploadAttachment(file)).rejects.toBeInstanceOf(CrewloomError);
  });
});

describe('跨模块入口解析（工作台 → 各模块详情页）', () => {
  it('已存在的页面能解析（含参数片段）', () => {
    expect(resolveRouteTarget('/tasks/pending')?.board?.path).toBe('pending');
    expect(resolveRouteTarget('/ai/conversations')?.module.id).toBe('ai');
  });

  it('不存在的页面返回 undefined，界面据此显示"尚未开放"而不是死链', () => {
    // 详情页是**参数化路由**，属于已交付功能：应当解析（不是死链，也不是"尚未开放"）。
    // 集成时 A/B 分别交付了 conversations/:sessionId 与 users/:id，这里按真实语义断言。
    expect(resolveRouteTarget('/ai/conversations/some-session')?.board?.path).toBe(
      'conversations/:sessionId',
    );
    expect(resolveRouteTarget('/access/users/7')?.board?.path).toBe('users/:id');
    // 段数不匹配 / 模块不存在 → undefined
    expect(resolveRouteTarget('/ai/conversations/x/y')).toBeUndefined();
    expect(resolveRouteTarget('/tasks/pending/1')).toBeUndefined();
    expect(resolveRouteTarget('/not-a-module/x')).toBeUndefined();
  });

  it('模块根路径可以解析到模块本身', () => {
    expect(resolveRouteTarget('/workbench')?.module.id).toBe('workbench');
    expect(resolveRouteTarget('/workbench')?.board).toBeUndefined();
  });
});

describe('PUB-05 能力未开通是独立状态', () => {
  it('给出"暂未开通"的标题、原因与可选说明，且不出现状态码/英文标识', () => {
    cleanup();
    render(
      createElement(UnavailableState, {
        title: '知识库',
        reason: '当前部署没有安装知识库能力。',
        hint: '这与「暂时没有数据」不同：后台确实没有这项能力。',
      }),
    );
    expect(screen.getByText('知识库暂未开通')).toBeInTheDocument();
    expect(screen.getByText('当前部署没有安装知识库能力。')).toBeInTheDocument();
    expect(screen.getByText(/后台确实没有这项能力/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/404|403|not enabled/i);
  });
});
