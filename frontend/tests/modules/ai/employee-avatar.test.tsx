import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harness, renderRegisteredBoard, resetHarness } from '../access/page-harness';
import { isKnownEmployeeAvatar, renderEmployeeAvatar } from '../../../src/modules/ai/pages/employeeAvatars';

/**
 * AI-02 员工配置的头像宿主（jsdom + 受控 adapter）。
 *
 * 这里证明的是**真实宿主链**，不是孤立控件：
 *  - 头像按后端保存的头像标识真实渲染（与原生组件同一条 `@dicebear/core` +
 *    `@nocobase/ai-employee-avatars` 渲染链，预设来自固定源码的 `avatarsMap`）；
 *  - 点选内置头像后，保存按钮走真实的 `aiEmployees:update`，提交的是头像标识字符串；
 *  - **不上传文件**：`aiEmployees.avatar` 是字符串标识而不是文件字段
 *    （见 07-public-pages §4.3 的证据修正），因此这里没有 `attachments:upload`。
 */

const EMPLOYEE = {
  username: 'employee-a',
  nickname: '数字员工 A',
  position: '助理',
  avatar: 'nocobase-015-male',
  bio: '简介',
  about: '详细介绍',
  greeting: '你好',
  enabled: true,
  builtIn: false,
  category: 'business',
};

beforeEach(() => {
  resetHarness();
  // 该模块页面会读取工具/技能/集合/模型服务清单；这里给空清单，重点在头像宿主。
  harness.routes['aiEmployees:get'] = { body: { data: EMPLOYEE } };
  harness.routes['aiTools:list'] = { body: { data: [], meta: { count: 0 } } };
  harness.routes['aiSkills:list'] = { body: { data: [], meta: { count: 0 } } };
  harness.routes['collections:list'] = { body: { data: [], meta: { count: 0 } } };
  harness.routes['llmServices:list'] = { body: { data: [], meta: { count: 0 } } };
  harness.routes['aiEmployees:update'] = { body: { data: EMPLOYEE } };
});

afterEach(() => {
  resetHarness();
});

describe('AI-02 员工头像宿主', () => {
  it('头像渲染链与固定源码一致（60 个内置标识，当前标识真实渲染）', () => {
    expect(isKnownEmployeeAvatar('nocobase-015-male')).toBe(true);
    expect(isKnownEmployeeAvatar('not-a-real-seed')).toBe(false);
    const uri = renderEmployeeAvatar('nocobase-015-male');
    expect(uri?.startsWith('data:image/svg+xml')).toBe(true);
    // 同一个标识必须渲染出同一张头像（确定性），否则界面每次刷新都会变脸。
    expect(renderEmployeeAvatar('nocobase-015-male')).toBe(uri);
    expect(renderEmployeeAvatar(null)).toBeNull();
  });

  it('页面显示当前头像并可从内置清单点选，保存提交真实头像标识', async () => {
    renderRegisteredBoard('ai', 'employees-config/:username', {
      route: '/ai/employees-config/employee-a',
      path: '/ai/employees-config/:username',
    });

    expect(await screen.findByTestId('employee-avatar-host')).toBeInTheDocument();
    // 当前头像来自后端读回的值。
    expect(screen.getByText('当前头像：nocobase-015-male')).toBeInTheDocument();

    // 打开内置清单并选择另一个内置头像。
    fireEvent.click(screen.getByRole('button', { name: '选择头像' }));
    const option = await screen.findByRole('option', { name: 'nocobase-001-male' });
    fireEvent.click(option);
    expect(screen.getByText('当前头像：nocobase-001-male')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));

    await waitFor(() => {
      expect(harness.captured.some((item) => item.path === 'aiEmployees:update')).toBe(true);
    });
    const update = harness.captured.find((item) => item.path === 'aiEmployees:update');
    expect(update?.method).toBe('post');
    expect((update?.data as Record<string, unknown>).avatar).toBe('nocobase-001-male');

    // 头像字段不是文件字段：整个页面不发出附件上传。
    expect(harness.captured.some((item) => item.path === 'attachments:upload')).toBe(false);
  });
});
