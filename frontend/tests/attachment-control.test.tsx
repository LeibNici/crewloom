import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getHttpClient, resetAuthContext, setApiBase, setAuthContext } from '../src/api/client';
import { AttachmentControl } from '../src/components/AttachmentControl';

/**
 * 附件控件（PUB-04）渲染测试。
 *
 * 用真实组件 + 受控 adapter：
 *  - 只读时给出可下载的附件地址；
 *  - 可编辑时以后端存储能力为准：`storages:getBasicInfo` 404（没有可用存储）
 *    必须显示为"没有可用存储"并禁用上传，而不是让用户点了才报错。
 */

function installAdapter(status: number, body: unknown): void {
  const client = getHttpClient();
  client.defaults.adapter = async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
    const response: AxiosResponse = { data: body, status, statusText: String(status), headers: {}, config };
    if (status >= 400) {
      throw new AxiosError('Request failed', 'ERR_BAD_REQUEST', config, undefined, response);
    }
    return response;
  };
}

function renderControl(props: React.ComponentProps<typeof AttachmentControl>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AttachmentControl {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  setApiBase('/api');
  resetAuthContext();
  setAuthContext({ authenticator: 'basic', token: 'test-token' });
});

afterEach(() => {
  resetAuthContext();
});

describe('附件控件', () => {
  it('只读时提供附件下载地址（永久访问路径原样使用）', () => {
    installAdapter(200, { data: {} });
    renderControl({
      value: { id: 4, filename: 'logo.png', url: '/files/main/main/attachments/4.png', size: 2048 },
    });

    const link = screen.getByRole('link', { name: 'logo.png' });
    expect(link).toHaveAttribute('href', '/files/main/main/attachments/4.png');
    expect(screen.getByText('2.0 KB')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '替换' })).not.toBeInTheDocument();
  });

  it('可编辑但没有可用存储时，明确说明并禁用上传', async () => {
    installAdapter(404, { errors: [{ message: 'not found' }] });
    renderControl({ value: null, editable: true });

    await waitFor(() => {
      expect(screen.getByText(/当前后台还没有可用的文件存储/)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: '上传' })).toBeDisabled();
  });

  it('可编辑且有可用存储时，上传按钮可用', async () => {
    installAdapter(200, { data: { id: 1, name: 'local', type: 'local', title: 'Local storage', rules: { size: 1024 } } });
    renderControl({ value: null, editable: true });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '上传' })).toBeEnabled();
    });
  });
});
