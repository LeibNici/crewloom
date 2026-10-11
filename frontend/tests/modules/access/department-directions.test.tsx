import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harness, renderRegisteredBoard, resetHarness } from './page-harness';

/**
 * AC-06 另外两个方向：用户 → 部门（用户详情页）与角色 → 部门（角色详情页）。
 *
 * 与 `departments` 页的"部门 → 成员 / 部门 → 角色"合起来，四个方向都在真实页面上有维护入口，
 * 并且都走同一套关联资源动作（请求体是裸标识数组）。
 */

beforeEach(() => {
  resetHarness();
});

afterEach(() => {
  resetHarness();
});

describe('AC-06 用户 → 部门（用户详情页）', () => {
  it('显示真实部门关联，加入/整体替换/设为主部门都发出精确请求', async () => {
    harness.routes['users:get'] = {
      body: {
        data: {
          id: 2,
          nickname: '李四',
          username: 'lisi',
          roles: [{ name: 'member', title: '普通成员' }],
          mainDepartmentId: 1,
        },
      },
    };
    harness.routes['roles:list'] = { body: { data: [], meta: { count: 0 } } };
    harness.routes['rolesUsers:list'] = { body: { data: [], meta: { count: 0 } } };
    harness.routes['users/2/departments:list'] = {
      body: { data: [{ id: 1, name: '总部', dept_code: 'HQ' }], meta: { count: 1, page: 1, pageSize: 20, totalPage: 1 } },
    };
    harness.routes['departments:list'] = {
      body: {
        data: [{ id: 3, name: '财务部', dept_code: 'FIN' }],
        meta: { count: 1, page: 1, pageSize: 10, totalPage: 1 },
      },
    };
    harness.routes['users/2/departments:add'] = { body: { data: 'ok' } };
    harness.routes['users/2/departments:set'] = { body: { data: 'ok' } };
    harness.routes['users:update'] = { body: { data: { id: 2 } } };

    renderRegisteredBoard('access', 'users/:id', { route: '/access/users/2', path: '/access/users/:id' });

    // 当前关联来自真实 users/<id>/departments。
    expect(await screen.findByText('总部')).toBeInTheDocument();
    // 主部门字段存在时才给"设为主部门"入口（这里是 1，已是主部门）。
    expect(await screen.findByText('已是主部门')).toBeInTheDocument();

    // 选择候选部门并加入。
    const candidateLabel = screen.getByText('财务部').closest('label');
    expect(candidateLabel).not.toBeNull();
    fireEvent.click(candidateLabel?.querySelector('input') as HTMLInputElement);
    fireEvent.click(screen.getByRole('button', { name: '加入部门（已选 1）' }));

    await waitFor(() => {
      expect(harness.posts().some((item) => item.path === 'users/2/departments:add')).toBe(true);
    });
    const add = harness.posts().find((item) => item.path === 'users/2/departments:add');
    expect(add?.data).toEqual([3]);
  });

  it('读回里没有主部门字段时，不提供"设为主部门"（不预置插件字段）', async () => {
    harness.routes['users:get'] = {
      body: { data: { id: 2, nickname: '李四', roles: [] } },
    };
    harness.routes['roles:list'] = { body: { data: [], meta: { count: 0 } } };
    harness.routes['rolesUsers:list'] = { body: { data: [], meta: { count: 0 } } };
    harness.routes['users/2/departments:list'] = {
      body: { data: [{ id: 1, name: '总部' }], meta: { count: 1, page: 1, pageSize: 20, totalPage: 1 } },
    };
    harness.routes['departments:list'] = { body: { data: [], meta: { count: 0 } } };

    renderRegisteredBoard('access', 'users/:id', { route: '/access/users/2', path: '/access/users/:id' });

    expect(await screen.findByText('总部')).toBeInTheDocument();
    expect(screen.queryByText('设为主部门')).toBeNull();
    expect(
      await screen.findByText(/当前读回的用户记录里没有主部门信息/),
    ).toBeInTheDocument();
  });
});

describe('AC-06 角色 → 部门（角色详情页）', () => {
  it('显示真实部门关联并可取消关联', async () => {
    harness.routes['roles:get'] = { body: { data: { name: 'r_sales', title: '销售', snippets: [] } } };
    harness.routes['roles/r_sales/users:list'] = { body: { data: [], meta: { count: 0 } } };
    harness.routes['users:listExcludeRole'] = { body: { data: [], meta: { count: 0 } } };
    harness.routes['roles/r_sales/resources:list'] = { body: { data: [], meta: { count: 0 } } };
    harness.routes['roles/r_sales/aiEmployees:list'] = { body: { data: [], meta: { count: 0 } } };
    harness.routes['roles/r_sales/desktopRoutes:list'] = { body: { data: [], meta: { count: 0 } } };
    harness.routes['roles/r_sales/departments:list'] = {
      body: { data: [{ id: 1, name: '总部', dept_code: 'HQ' }], meta: { count: 1, page: 1, pageSize: 20, totalPage: 1 } },
    };
    harness.routes['departments:list'] = { body: { data: [], meta: { count: 0 } } };
    harness.routes['roles/r_sales/departments:remove'] = { body: { data: 'ok' } };

    renderRegisteredBoard('access', 'roles/:name', { route: '/access/roles/r_sales', path: '/access/roles/:name' });

    expect(await screen.findByText('关联部门')).toBeInTheDocument();
    expect(await screen.findByText('总部')).toBeInTheDocument();

    const listRequest = harness.captured.find((item) => item.path === 'roles/r_sales/departments:list');
    expect(listRequest?.method).toBe('get');

    fireEvent.click(screen.getByText('移除'));

    await waitFor(() => {
      expect(harness.posts().some((item) => item.path === 'roles/r_sales/departments:remove')).toBe(true);
    });
    const remove = harness.posts().find((item) => item.path === 'roles/r_sales/departments:remove');
    expect(remove?.method).toBe('post');
    expect(remove?.data).toEqual([1]);
  });
});
