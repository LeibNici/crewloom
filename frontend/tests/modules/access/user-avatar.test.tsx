import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harness, renderRegisteredBoard, resetHarness } from './page-harness';

/**
 * AC-01 用户头像宿主（jsdom + 受控 adapter）：PUB-04 附件控件的真实接入链。
 *
 * 证明的不是"控件能渲染"，而是 AC-01 页面确实完成了整条宿主链：
 *  1. 读：`users:get` 带 `appends=avatar`，并把真实附件地址显示成头像；
 *  2. 上传：用户选择文件 → `POST attachments:upload`（multipart，带本地文件与
 *     `attachmentField=users.avatar`，字段决定存储）；
 *  3. 保存：`users:update`，body 是 `{ avatar: { id } }`（belongsTo 关联语义）；
 *  4. 移除：`users:update`，body 是 `{ avatar: null }`。
 *
 * 真实上传与真实读取不在自动验证范围（strict 下 upload 被拦截）。
 */

const USERS_COLLECTION_WITH_AVATAR = {
  data: { name: 'users', fields: [{ name: 'id' }, { name: 'nickname' }, { name: 'avatar' }] },
};

/** 真实 13000 的 users 字段清单里**没有** avatar（本次只读核对），用它验证"能力缺失"的诚实状态。 */
const USERS_COLLECTION_WITHOUT_AVATAR = {
  data: { name: 'users', fields: [{ name: 'id' }, { name: 'nickname' }, { name: 'roles' }] },
};

beforeEach(() => {
  resetHarness();
  harness.routes['collections:get'] = { body: USERS_COLLECTION_WITH_AVATAR };
  harness.routes['roles:list'] = { body: { data: [], meta: { count: 0 } } };
  harness.routes['rolesUsers:list'] = { body: { data: [], meta: { count: 0 } } };
  harness.routes['users/2/departments:list'] = { body: { data: [], meta: { count: 0 } } };
  harness.routes['storages:getBasicInfo'] = {
    body: { data: { id: 1, name: 'local', type: 'local', title: '本地存储', public: null, rules: { size: 20971520 } } },
  };
  harness.routes['attachments:upload'] = {
    body: { data: { id: 12, filename: 'avatar.png', url: '/files/main/main/attachments/12.png' } },
  };
  harness.routes['users:update'] = { body: { data: { id: 2 } } };
});

afterEach(() => {
  resetHarness();
});

function renderUserDetail() {
  return renderRegisteredBoard('access', 'users/:id', {
    route: '/access/users/2',
    path: '/access/users/:id',
  });
}

describe('AC-01 用户头像', () => {
  it('显示真实头像地址，并在用户主动选文件后上传 + 保存引用', async () => {
    harness.routes['users:get'] = {
      body: {
        data: {
          id: 2,
          nickname: '李四',
          username: 'lisi',
          avatar: { id: 9, url: '/files/main/main/attachments/9.png' },
          roles: [],
        },
      },
    };

    const { container } = renderUserDetail();
    await screen.findByText('头像');

    await waitFor(() => {
      expect(
        harness.captured.some(
          (item) => item.path === 'users:get' && (item.params.appends as string[] | undefined)?.includes('avatar'),
        ),
      ).toBe(true);
    });
    const getRequest = [...harness.captured].reverse().find((item) => item.path === 'users:get');
    expect(getRequest?.params.appends).toEqual(['roles', 'avatar']);

    // 1) 显示：真实附件地址。
    await waitFor(() => {
      expect(container.querySelector('img')?.getAttribute('src')).toBe('/files/main/main/attachments/9.png');
    });

    // 2) 上传：真实 multipart 请求，带本地文件与关联字段。
    const file = new File(['avatar-bytes'], 'avatar.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('选择用户头像'), { target: { files: [file] } });

    await waitFor(() => {
      expect(harness.captured.some((item) => item.path === 'attachments:upload')).toBe(true);
    });
    const upload = harness.captured.find((item) => item.path === 'attachments:upload');
    expect(upload?.method).toBe('post');
    expect(upload?.params.attachmentField).toBe('users.avatar');
    expect(upload?.data).toBeInstanceOf(FormData);
    const uploaded = (upload?.data as FormData).get('file') as File;
    expect(uploaded).toBeInstanceOf(File);
    expect(uploaded.name).toBe('avatar.png');

    // 3) 保存：users:update 写的是附件记录引用。
    await waitFor(() => {
      expect(harness.captured.some((item) => item.path === 'users:update')).toBe(true);
    });
    const update = harness.captured.find((item) => item.path === 'users:update');
    expect(update?.method).toBe('post');
    expect(update?.params.filterByTk).toBe('2');
    expect(update?.data).toEqual({ avatar: { id: 12 } });
  });

  it('移除头像只把该字段置空，不删除附件记录', async () => {
    harness.routes['users:get'] = {
      body: {
        data: { id: 2, nickname: '李四', avatar: { id: 9, url: '/files/main/main/attachments/9.png' }, roles: [] },
      },
    };

    renderUserDetail();
    await screen.findByText('头像');
    fireEvent.click(await screen.findByText('移除'));

    await waitFor(() => {
      const update = harness.captured.find((item) => item.path === 'users:update');
      expect(update?.data).toEqual({ avatar: null });
    });
    // 控件不替调用方删除后端记录：没有 destroy 类请求。
    expect(harness.captured.some((item) => /destroy/.test(item.path))).toBe(false);
  });
});

describe('AC-01 用户头像：实例没有该字段时', () => {
  it('按真实字段元数据判定为能力缺失，不渲染上传入口也不发关联读', async () => {
    harness.routes['collections:get'] = { body: USERS_COLLECTION_WITHOUT_AVATAR };
    harness.routes['users:get'] = {
      body: { data: { id: 2, nickname: '李四', username: 'lisi', roles: [] } },
    };

    renderUserDetail();
    expect(await screen.findByText('本系统还没有开启用户头像功能')).toBeInTheDocument();
    expect(screen.queryByLabelText('选择用户头像')).toBeNull();
    expect(screen.queryByText('上传')).toBeNull();

    const getRequest = harness.captured.find((item) => item.path === 'users:get');
    expect(getRequest?.params.appends).toEqual(['roles']);
    expect(harness.captured.some((item) => item.path === 'attachments:upload')).toBe(false);
  });
});
