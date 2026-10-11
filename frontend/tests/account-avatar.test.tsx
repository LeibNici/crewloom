import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { getHttpClient, setApiBase, setAuthContext, resetAuthContext } from '../src/api/client';

/**
 * PUB-04 附件宿主的受控验证（jsdom + 受控 adapter，不发真实请求）。
 *
 * 验证的是**真实集成行为**，不是组件快照：
 *  - 账号菜单挂载 AttachmentControl 后，读取当前用户时用 `users:get` 且带 `avatar` 关联；
 *  - 用户选择文件后，上传请求是 `POST attachments:upload` 的 multipart，且带
 *    `attachmentField=users.avatar`（字段决定存储，不能省）；
 *  - 保存走 `users:update`，body 里是 `{ avatar: { id } }`（belongsTo 关联语义），
 *    权限由后端 ACL 判定，前端不伪造成败。
 *
 * 真实上传与真实读取不在自动验证范围（strict 模式拦截 upload）。
 */

vi.mock('../src/api/systemSettings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/systemSettings')>();
  return {
    ...actual,
    useSystemSettings: () => ({ data: null, isLoading: false, isError: false }),
    useBackendInfo: () => ({ data: null, isLoading: false, isError: false }),
  };
});

import { AccountMenu } from '../src/app/AccountMenu';
import { useSessionStore } from '../src/auth/store';

interface CapturedRequest {
  url?: string;
  method?: string;
  data?: unknown;
  params?: unknown;
}

function installAdapter(captured: CapturedRequest[]) {
  const client = getHttpClient();
  client.defaults.adapter = async (config) => {
    captured.push({
      url: config.url,
      method: config.method,
      data: config.data,
      params: config.params,
    });
    if (config.url === 'users:get') {
      return {
        data: { data: { id: 1, nickname: '测试账号', avatar: { id: 9, url: '/files/main/main/attachments/9.png' } } },
        status: 200,
        statusText: '200',
        headers: {},
        config,
      };
    }
    if (config.url === 'collections:get') {
      // 账号菜单现在按真实字段元数据决定是否渲染头像控件。
      return {
        data: { data: { name: 'users', fields: [{ name: 'id' }, { name: 'nickname' }, { name: 'avatar' }] } },
        status: 200,
        statusText: '200',
        headers: {},
        config,
      };
    }
    if (config.url === 'attachments:upload') {
      return {
        data: { data: { id: 12, filename: 'a.png', url: '/files/main/main/attachments/12.png' } },
        status: 200,
        statusText: '200',
        headers: {},
        config,
      };
    }
    return { data: { data: {} }, status: 200, statusText: '200', headers: {}, config };
  };
}

function renderMenu() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AccountMenu />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('账号菜单中的用户头像（PUB-04 附件宿主）', () => {
  it('读取当前用户头像使用 users:get + avatar 关联', async () => {
    const captured: CapturedRequest[] = [];
    setApiBase('/api');
    resetAuthContext();
    setAuthContext({ token: 'token-avatar', role: null, authenticator: 'basic' });
    useSessionStore.setState({
      user: { id: 1, nickname: '测试账号', email: 'avatar@example.test' },
      status: 'authenticated',
    });
    installAdapter(captured);

    renderMenu();

    await waitFor(() => {
      expect(captured.some((entry) => entry.url === 'users:get')).toBe(true);
    });
    // 先确认头像字段存在，控件才会出现（能力判定在本机 adapter 下也是真实请求）。
    await waitFor(() => {
      expect(document.querySelector('input[type="file"]')).not.toBeNull();
    });
    const get = captured.find((entry) => entry.url === 'users:get');
    expect(get?.method).toBe('get');
    expect((get?.params as Record<string, unknown>).appends).toEqual(['avatar']);
    expect((get?.params as Record<string, unknown>).filterByTk).toBe(1);
  });

  it('用户主动选择文件后：multipart 上传带 users.avatar，随后 users:update 写关联 id', async () => {
    const captured: CapturedRequest[] = [];
    setApiBase('/api');
    resetAuthContext();
    setAuthContext({ token: 'token-avatar2', role: null, authenticator: 'basic' });
    useSessionStore.setState({
      user: { id: 1, nickname: '测试账号', email: 'avatar@example.test' },
      status: 'authenticated',
    });
    installAdapter(captured);

    renderMenu();
    await waitFor(() => expect(captured.some((entry) => entry.url === 'users:get')).toBe(true));

    const input = document.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    const file = new File(['avatar-bytes'], 'a.png', { type: 'image/png' });
    await userEvent.upload(input as HTMLInputElement, file);

    await waitFor(() => expect(captured.some((entry) => entry.url === 'attachments:upload')).toBe(true));
    const upload = captured.find((entry) => entry.url === 'attachments:upload');
    expect(upload?.method).toBe('post');
    expect(upload?.data).toBeInstanceOf(FormData);
    expect((upload?.data as FormData).get('file')).toBe(file);
    expect((upload?.params as Record<string, unknown>).attachmentField).toBe('users.avatar');

    await waitFor(() => expect(captured.some((entry) => entry.url === 'users:update')).toBe(true));
    const update = captured.find((entry) => entry.url === 'users:update');
    expect(update?.method).toBe('post');
    expect((update?.params as Record<string, unknown>).filterByTk).toBe(1);
    const body = typeof update?.data === 'string' ? JSON.parse(update.data) : update?.data;
    expect(body).toEqual({ avatar: { id: 12 } });
  });

  it('上传失败时给出中文提示，不伪造成成功', async () => {
    const captured: CapturedRequest[] = [];
    setApiBase('/api');
    resetAuthContext();
    setAuthContext({ token: 'token-avatar3', role: null, authenticator: 'basic' });
    useSessionStore.setState({
      user: { id: 1, nickname: '测试账号', email: 'avatar@example.test' },
      status: 'authenticated',
    });
    const client = getHttpClient();
    client.defaults.adapter = async (config) => {
      captured.push({ url: config.url, method: config.method, data: config.data, params: config.params });
      if (config.url === 'collections:get') {
        return {
          data: { data: { name: 'users', fields: [{ name: 'id' }, { name: 'avatar' }] } },
          status: 200,
          statusText: '200',
          headers: {},
          config,
        };
      }
      if (config.url === 'users:get') {
        return { data: { data: { id: 1, avatar: null } }, status: 200, statusText: '200', headers: {}, config };
      }
      const error = new Error('Request failed with status code 403');
      (error as unknown as { response: unknown }).response = {
        status: 403,
        data: { errors: [{ message: 'No permissions' }] },
        headers: {},
        config,
      };
      throw error;
    };

    renderMenu();
    await waitFor(() => expect(captured.some((entry) => entry.url === 'users:get')).toBe(true));

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, new File(['x'], 'a.png', { type: 'image/png' }));

    const alerts = await screen.findAllByRole('alert');
    const text = alerts.map((node) => node.textContent ?? '').join(' ');
    // 用户看到的是中文说明，不出现状态码、英文后端信息或内部动作名。
    expect(text).not.toMatch(/403|No permissions|attachments|users:update/i);
    expect(text.length).toBeGreaterThan(0);
  });
});

describe('账号菜单头像：实例没有该字段时', () => {
  it('按真实字段元数据判定为不可用，隐藏上传入口并给出普通中文说明', async () => {
    const captured: CapturedRequest[] = [];
    setApiBase('/api');
    resetAuthContext();
    setAuthContext({ token: 'token-avatar4', role: null, authenticator: 'basic' });
    useSessionStore.setState({
      user: { id: 1, nickname: '测试账号', email: 'avatar@example.test' },
      status: 'authenticated',
    });
    const client = getHttpClient();
    client.defaults.adapter = async (config) => {
      captured.push({ url: config.url, method: config.method, data: config.data, params: config.params });
      if (config.url === 'collections:get') {
        return {
          data: { data: { name: 'users', fields: [{ name: 'id' }, { name: 'nickname' }, { name: 'roles' }] } },
          status: 200,
          statusText: '200',
          headers: {},
          config,
        };
      }
      return { data: { data: { id: 1, nickname: '测试账号' } }, status: 200, statusText: '200', headers: {}, config };
    };

    renderMenu();

    await waitFor(() => {
      expect(screen.getByText(/本系统还没有开启用户头像功能/)).toBeInTheDocument();
    });
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(captured.some((entry) => entry.url === 'attachments:upload')).toBe(false);
    // 账号菜单的其它内容仍然可用。
    expect(screen.getByText('修改密码')).toBeInTheDocument();
  });
});
