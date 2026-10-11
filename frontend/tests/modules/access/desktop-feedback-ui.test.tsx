import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ModuleBoardScreen } from '../../../src/screens/ModuleBoardScreen';
import { displayTitle, templateLabel } from '../../../src/modules/access/display';
import { DefaultsPage } from '../../../src/modules/model/pages/DefaultsPage';
import { harness, renderPage, renderRegisteredBoard, resetHarness } from './page-harness';

/**
 * 桌面端反馈（主模型电脑端实测）对应的**定向行为检查**。
 *
 * 断言的是页面/请求的**真实行为**（渲染出的文字、发出的请求载荷、链接地址），
 * 不是内部实现细节：
 *  - 模块首页必须列出现在可用的页面，且不出现字面 `:id` / `:name` 死链；
 *  - 子页导航的列表页签必须真的指回列表，而不是停在详情地址；
 *  - 候选排除必须命中**真实主键**（角色是 `name`，用户/部门是 `id`）；
 *  - 「整体替换」必须保留既有已关联项，清空必须经过明示确认；
 *  - 关联读取失败不能被写成"合并规则不运行"。
 */

const rolesResponse = {
  data: [
    { name: 'r_sales', title: '销售', snippets: [] },
    { name: 'r_audit', title: '审计', snippets: [] },
  ],
  meta: { count: 2, page: 1, pageSize: 10, totalPage: 1 },
};

function seedDepartments(routes: Record<string, unknown> = {}) {
  harness.routes['departments:list'] = {
    body: {
      data: [{ id: 1, parentId: null, name: '总部', dept_code: 'HQ', status: 'active', organization_id: 1 }],
      meta: { count: 1, page: 1, pageSize: 200, totalPage: 1 },
    },
  };
  harness.routes['organizations:list'] = { body: { data: [], meta: { count: 0 } } };
  harness.routes['departments/1/members:list'] = {
    body: { data: [{ id: 101, nickname: '成员甲' }], meta: { count: 1, page: 1, pageSize: 20, totalPage: 1 } },
  };
  harness.routes['departments/1/roles:list'] = {
    body: { data: [{ name: 'r_sales', title: '销售' }], meta: { count: 1, page: 1, pageSize: 50, totalPage: 1 } },
  };
  harness.routes['users:list'] = {
    body: { data: [{ id: 102, nickname: '成员乙' }], meta: { count: 1, page: 1, pageSize: 10, totalPage: 1 } },
  };
  harness.routes['roles:list'] = { body: rolesResponse };
  harness.routes['departments/1/members:set'] = { body: { data: 'ok' } };
  Object.assign(harness.routes, routes);
}

beforeEach(() => {
  resetHarness();
});

afterEach(() => {
  resetHarness();
});

describe('模块首页与子页导航（电脑端反馈 1）', () => {
  it('模块首页列出当前可用页面，不再显示"功能尚未开放"，也不出现字面 :param 链接', () => {
    renderPage(createElement(ModuleBoardScreen, { moduleId: 'access' }), {
      route: '/access',
      path: '/access',
    });

    expect(screen.queryByText(/功能尚未开放/)).toBeNull();
    expect(screen.queryByText(/具体功能会在后续版本提供/)).toBeNull();

    const hrefs = screen
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'))
      .filter((href): href is string => Boolean(href));
    expect(hrefs).toContain('/access/users');
    expect(hrefs).toContain('/access/roles');
    expect(hrefs).toContain('/access/departments');
    expect(hrefs.some((href) => href.includes(':id') || href.includes(':name'))).toBe(false);
  });

  it('用户详情页的"用户"页签指回 /access/users，而不是停在详情地址', async () => {
    harness.routes['users:get'] = {
      body: { data: { id: 2, nickname: '李四', roles: [{ name: 'r_sales', title: '销售' }] } },
    };
    harness.routes['rolesUsers:list'] = { body: { data: [], meta: { count: 0 } } };
    harness.routes['users/2/departments:list'] = { body: { data: [], meta: { count: 0 } } };
    harness.routes['departments:list'] = { body: { data: [], meta: { count: 0 } } };

    renderRegisteredBoard('access', 'users/:id', { route: '/access/users/2', path: '/access/users/:id' });

    expect(await screen.findByText('李四')).toBeInTheDocument();
    const userTab = screen.getAllByRole('link').find((link) => link.textContent === '用户');
    expect(userTab?.getAttribute('href')).toBe('/access/users');
    expect(
      screen.getAllByRole('link').some((link) => (link.getAttribute('href') ?? '').includes(':id')),
    ).toBe(false);
  });
});

/** 取出请求里的过滤条件文本（SDK 可能已把它序列化成 JSON 字符串）。 */
function filterText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? null);
}

describe('候选排除必须用真实主键（电脑端反馈 5）', () => {
  it('部门角色候选按 name 排除已关联角色；成员候选按 id 排除已关联成员', async () => {
    seedDepartments();
    renderRegisteredBoard('access', 'departments');

    expect(await screen.findByText('成员甲')).toBeInTheDocument();

    const memberRequest = [...harness.captured].reverse().find((item) => item.path === 'users:list');
    const memberFilter = filterText(memberRequest?.params.filter);
    expect(memberFilter).toContain('"id"');
    expect(memberFilter).toContain('101');

    const roleRequest = [...harness.captured]
      .reverse()
      .find((item) => item.path === 'roles:list' && filterText(item.params.filter).includes('notIn'));
    const roleFilter = filterText(roleRequest?.params.filter);
    // 角色主键是 name：排除条件必须打在 name 上，不能写成 id。
    expect(roleFilter).toContain('"name"');
    expect(roleFilter).toContain('r_sales');
    expect(roleFilter).not.toContain('"id"');
  });
});

describe('整体替换 = 明确选择完整名单（电脑端反馈 6）', () => {
  it('默认勾选「已关联 + 所选」，可以取消已有项，提交的就是面板里的最终名单', async () => {
    seedDepartments();
    renderRegisteredBoard('access', 'departments');

    expect(await screen.findByText('成员甲')).toBeInTheDocument();
    const editor = within(screen.getByTestId('department-members-editor'));

    // 选中一个候选成员。
    const candidate = screen.getByText('成员乙').closest('label');
    expect(candidate).not.toBeNull();
    fireEvent.click(candidate?.querySelector('input') as HTMLInputElement);

    // 打开整体替换面板：默认勾选已关联的 101 和所选的 102。
    fireEvent.click(editor.getByRole('button', { name: '整体替换成员' }));
    const panel = await screen.findByTestId('department-members-editor-set-panel');
    expect(within(panel).getByText(/默认勾选当前已关联项和本次所选/)).toBeInTheDocument();
    expect(within(panel).getByText(/将保存 2 项/)).toBeInTheDocument();

    // 取消勾选已有的「成员甲」：最终名单只剩所选的新成员。
    const existing = within(panel).getByText('成员甲').closest('label');
    expect(existing).not.toBeNull();
    fireEvent.click(existing?.querySelector('input') as HTMLInputElement);
    expect(within(panel).getByText(/将保存 1 项/)).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole('button', { name: /确认替换/ }));

    await waitFor(() => {
      expect(harness.posts().some((item) => item.path === 'departments/1/members:set')).toBe(true);
    });
    const setRequest = harness.posts().find((item) => item.path === 'departments/1/members:set');
    // 提交的是面板里的最终名单：101 被用户显式取消，不再固定并集。
    expect(setRequest?.data).toEqual([102]);
  });

  it('不改动已有项时，默认名单是「已关联 + 所选」', async () => {
    seedDepartments();
    renderRegisteredBoard('access', 'departments');

    expect(await screen.findByText('成员甲')).toBeInTheDocument();
    const editor = within(screen.getByTestId('department-members-editor'));
    const candidate = screen.getByText('成员乙').closest('label');
    fireEvent.click(candidate?.querySelector('input') as HTMLInputElement);

    fireEvent.click(editor.getByRole('button', { name: '整体替换成员' }));
    const panel = await screen.findByTestId('department-members-editor-set-panel');
    fireEvent.click(within(panel).getByRole('button', { name: /确认替换/ }));

    await waitFor(() => {
      expect(harness.posts().some((item) => item.path === 'departments/1/members:set')).toBe(true);
    });
    expect(harness.posts().find((item) => item.path === 'departments/1/members:set')?.data).toEqual([101, 102]);
  });

  it('清空全部需要显式确认，确认后提交空集合', async () => {
    seedDepartments();
    renderRegisteredBoard('access', 'departments');

    expect(await screen.findByText('成员甲')).toBeInTheDocument();
    const editor = within(screen.getByTestId('department-members-editor'));

    fireEvent.click(editor.getByRole('button', { name: '清空全部' }));
    expect(await screen.findByText(/确认清空全部 1 项已关联/)).toBeInTheDocument();
    fireEvent.click(editor.getByRole('button', { name: '确认清空全部' }));

    await waitFor(() => {
      expect(
        harness
          .posts()
          .some((item) => item.path === 'departments/1/members:set' && JSON.stringify(item.data) === '[]'),
      ).toBe(true);
    });
  });

  it('超过一页的已关联集合会分页读完；候选排除带完整主键；面板列出全部', async () => {
    const members = Array.from({ length: 120 }, (_, index) => ({
      id: 1001 + index,
      nickname: `批量成员${index + 1}`,
    }));
    const pageSize = 50; // ASSOCIATION_FETCH_PAGE_SIZE
    harness.respond((request) => {
      if (request.path === 'departments:list') {
        return {
          body: {
            data: [{ id: 1, parentId: null, name: '总部', dept_code: 'HQ', status: 'active' }],
            meta: { count: 1, page: 1, pageSize: 200, totalPage: 1 },
          },
        };
      }
      if (request.path === 'organizations:list') return { body: { data: [], meta: { count: 0 } } };
      if (request.path === 'departments/1/members:list') {
        const page = Number(request.params.page ?? 1);
        const start = (page - 1) * pageSize;
        return {
          body: {
            data: members.slice(start, start + pageSize),
            meta: { count: members.length, page, pageSize, totalPage: Math.ceil(members.length / pageSize) },
          },
        };
      }
      if (request.path === 'departments/1/roles:list') {
        return { body: { data: [], meta: { count: 0, page: 1, pageSize, totalPage: 1 } } };
      }
      if (request.path === 'users:list') {
        return { body: { data: [{ id: 2, nickname: '候选用户' }], meta: { count: 1, page: 1, pageSize: 10, totalPage: 1 } } };
      }
      return { body: { data: [], meta: { count: 0 } } };
    });

    renderRegisteredBoard('access', 'departments');
    expect(await screen.findByText('总部')).toBeInTheDocument();

    // 关联列表按分页逐页读完（120 项 / 每页 50 → 3 页）。
    await waitFor(() => {
      const pages = harness.captured
        .filter((item) => item.path === 'departments/1/members:list')
        .map((item) => Number(item.params.page ?? 1));
      expect(pages).toEqual([1, 2, 3]);
    });

    // 候选排除用的是**完整已关联主键**（1001..1120），不是只排除当前页。
    const candidateRequest = [...harness.captured].reverse().find((item) => item.path === 'users:list');
    const candidateFilter = filterText(candidateRequest?.params.filter);
    expect(candidateFilter).toContain('1001');
    expect(candidateFilter).toContain('1120');
    expect(candidateFilter).not.toContain('1121');

    expect(await screen.findByText('共 120 项')).toBeInTheDocument();

    // 整体替换面板列出完整 120 项，不因超过一页而被停用。
    fireEvent.click(within(screen.getByTestId('department-members-editor')).getByRole('button', { name: '整体替换成员' }));
    const panel = await screen.findByTestId('department-members-editor-set-panel');
    expect(within(panel).getByText(/将保存 120 项/)).toBeInTheDocument();
  });
});

describe('用户主部门保存后标记按读回更新（电脑端反馈 6）', () => {
  it('设为主部门成功后，列表标记跟着服务端现值更新，而不是停在保存前的旧值', async () => {
    let mainDepartmentId = 1;
    harness.respond((request) => {
      if (request.path === 'users:get') {
        return {
          body: {
            data: {
              id: 2,
              nickname: '李四',
              username: 'lisi',
              roles: [{ name: 'r_sales', title: '销售' }],
              mainDepartmentId,
            },
          },
        };
      }
      if (request.path === 'users/2/departments:list') {
        return {
          body: {
            data: [
              { id: 1, name: '总部' },
              { id: 2, name: '财务部' },
            ],
            meta: { count: 2, page: 1, pageSize: 50, totalPage: 1 },
          },
        };
      }
      if (request.path === 'users:update') {
        const values = (request.data ?? {}) as Record<string, unknown>;
        if ('mainDepartmentId' in values) mainDepartmentId = Number(values.mainDepartmentId);
        return { body: { data: { id: 2, ...values } } };
      }
      return { body: { data: [], meta: { count: 0 } } };
    });

    renderRegisteredBoard('access', 'users/:id', { route: '/access/users/2', path: '/access/users/:id' });

    expect(await screen.findByText('总部')).toBeInTheDocument();
    const rowOf = (name: string) => screen.getByText(name).closest('tr') as HTMLTableRowElement;
    expect(within(rowOf('总部')).getByText('已是主部门')).toBeInTheDocument();

    fireEvent.click(within(rowOf('财务部')).getByRole('button', { name: '设为主部门' }));

    // 保存成功后必须重新读取用户详情：财务部变成"已是主部门"，总部回到"设为主部门"。
    await waitFor(() => {
      expect(within(rowOf('财务部')).getByText('已是主部门')).toBeInTheDocument();
    });
    expect(within(rowOf('总部')).getByText('设为主部门')).toBeInTheDocument();
    expect(harness.posts().some((item) => item.path === 'users:update')).toBe(true);
  });
});

describe('读取失败不等于能力未开通（电脑端反馈 7）', () => {
  it('能力已开通但这次读取失败时，说明不写成"合并规则不运行"', async () => {
    seedDepartments();
    harness.routes['collections:get'] = {
      body: { data: { name: 'departments', fields: [{ name: 'id' }, { name: 'members' }, { name: 'roles' }] } },
    };
    harness.routes['departments/1/members:list'] = { status: 500, body: { errors: [{ message: 'boom' }] } };
    harness.routes['departments/1/roles:list'] = { status: 500, body: { errors: [{ message: 'boom' }] } };

    renderRegisteredBoard('access', 'departments');

    // 顶部仍按"已开通但本次读取失败"归因。
    expect(await screen.findByText(/关联能力已开通，但本次读取失败/)).toBeInTheDocument();
    // 有效角色说明里明确"这次没读到"，并且不出现"能力未开通"的结论。
    expect(await screen.findByText(/这次没能读到关联数据/)).toBeInTheDocument();
    expect(screen.queryByText(/有效角色只包含账号自身角色/)).toBeNull();
    expect(screen.queryByText(/当前实例未开通部门角色关联/)).toBeNull();
  });
});

describe('用户资料可编辑（电脑端反馈 10）', () => {
  it('用户详情有昵称/用户名/邮箱/手机的编辑入口，保存只提交改动过的字段', async () => {
    harness.routes['users:get'] = {
      body: {
        data: {
          id: 2,
          nickname: '李四',
          username: 'lisi',
          email: 'l@example.test',
          phone: '13800000000',
          roles: [],
        },
      },
    };
    harness.routes['roles:list'] = { body: { data: [], meta: { count: 0 } } };
    harness.routes['rolesUsers:list'] = { body: { data: [], meta: { count: 0 } } };
    harness.routes['users/2/departments:list'] = { body: { data: [], meta: { count: 0 } } };
    harness.routes['departments:list'] = { body: { data: [], meta: { count: 0 } } };
    harness.routes['users:update'] = { body: { data: { id: 2 } } };

    renderRegisteredBoard('access', 'users/:id', { route: '/access/users/2', path: '/access/users/:id' });

    const nickname = await screen.findByDisplayValue('李四');
    expect((nickname as HTMLInputElement).tagName).toBe('INPUT');
    expect((nickname as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByDisplayValue('lisi')).toBeInTheDocument();
    expect(screen.getByDisplayValue('l@example.test')).toBeInTheDocument();
    expect(screen.getByDisplayValue('13800000000')).toBeInTheDocument();

    fireEvent.change(nickname, { target: { value: '李四改' } });
    fireEvent.click(screen.getByRole('button', { name: '保存资料' }));

    await waitFor(() => {
      expect(harness.posts().some((item) => item.path === 'users:update')).toBe(true);
    });
    const update = harness.posts().find((item) => item.path === 'users:update');
    // 只提交本次改动的字段，未改动的用户名/邮箱/手机不覆盖。
    expect(update?.data).toEqual({ nickname: '李四改' });
    expect(update?.params.filterByTk).toBe('2');
  });
});

describe('后台标题/范围模板按可读名称显示（电脑端反馈 7/8）', () => {
  it('模板取可读名称；系统项用固定中文名；普通字符串不改名', () => {
    expect(templateLabel('{{t("Main")}}')).toBe('主数据源');
    expect(templateLabel('{{t("All records")}}')).toBe('全部记录');
    expect(templateLabel('{{t("Own records")}}')).toBe('仅本人记录');
    expect(templateLabel('{{t("Something else")}}')).toBe('Something else');
    expect(templateLabel('客户')).toBeNull();
    expect(displayTitle('{{t("Main")}}', 'main')).toBe('主数据源');
    expect(displayTitle('', 'fallback')).toBe('fallback');
    expect(displayTitle('自定义名称', 'fallback')).toBe('自定义名称');
  });

  it('AC-04 记录范围显示可读名称，不出现 {{t(...)}} 或 （null），保存值仍是真实范围 id', async () => {
    harness.routes['roles:list'] = {
      body: { data: [{ name: 'r_sales', title: '销售' }], meta: { count: 1 } },
    };
    harness.routes['roles/r_sales/resources:list'] = {
      body: { data: [{ id: 9001, name: 'customers', usingActionsConfig: true }], meta: { count: 1 } },
    };
    harness.routes['availableActions:list'] = { body: { data: [{ name: 'view', displayName: '查看' }] } };
    harness.routes['dataSourcesRolesResourcesScopes:list'] = {
      body: {
        data: [
          { id: 389922132131841, key: 'all', name: '{{t("All records")}}', resourceName: null, dataSourceKey: 'main' },
          { id: 2, key: 'own', name: '{{t("Own records")}}', resourceName: null, dataSourceKey: 'main' },
        ],
        meta: { count: 2 },
      },
    };
    harness.routes['dataSourcesRolesResourcesActions:list'] = { body: { data: [], meta: { count: 0 } } };

    renderRegisteredBoard('access', 'data');
    expect(await screen.findByText('customers')).toBeInTheDocument();
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByText('customers'));

    const optionAll = await screen.findByRole('option', { name: '全部记录' });
    expect((optionAll as HTMLOptionElement).value).toBe('389922132131841');
    const optionOwn = screen.getByRole('option', { name: '仅本人记录' });
    expect((optionOwn as HTMLOptionElement).value).toBe('2');
    expect(screen.queryByText(/{{t\(/)).toBeNull();
    expect(screen.queryByText(/（null）/)).toBeNull();
  });

  it('AC-05「我可用」用非分页接口的整数组口径，不显示 —', async () => {
    harness.routes['roles:list'] = {
      body: { data: [{ name: 'root', title: 'Root', allowNewAiEmployee: true }], meta: { count: 1 } },
    };
    harness.routes['roles/root/aiEmployees:list'] = { body: { data: [], meta: { count: 0 } } };
    harness.routes['aiEmployees:list'] = { body: { data: [], meta: { count: 13 } } };
    // `aiEmployees:listByUser` 不分页、没有 meta：界面按已加载的整个数组计数。
    harness.routes['aiEmployees:listByUser'] = {
      body: {
        data: Array.from({ length: 13 }, (_, index) => ({
          username: `employee-${index}`,
          nickname: `员工${index}`,
        })),
      },
    };

    renderRegisteredBoard('access', 'employees');
    expect(await screen.findByText('我可用 13')).toBeInTheDocument();
    expect(screen.queryByText('我可用 —')).toBeNull();
  });
});

describe('LM-04 按批准的生效顺序说明（电脑端反馈 7/8）', () => {
  it('不展示源码位置/未授权方案等工程内容，按员工专用 → 显式 → 全局默认 → 兼容回退 → 失效失败说明', async () => {
    harness.routes['aiSettings:get'] = {
      body: { data: { defaultLLMService: null, defaultModel: null } },
    };
    harness.routes['llmServices:list'] = { body: { data: [], meta: { count: 0 } } };
    harness.routes['aiEmployees:list'] = { body: { data: [], meta: { count: 0 } } };

    renderPage(createElement(DefaultsPage));

    expect(await screen.findByText('实际生效顺序')).toBeInTheDocument();
    expect(screen.getByText('全局默认（本页设置）')).toBeInTheDocument();
    expect(screen.getByText('默认不可用时的处理')).toBeInTheDocument();
    expect(screen.queryByText(/后端差距/)).toBeNull();
    expect(document.body.textContent ?? '').not.toContain('plugin-ai');
    expect(document.body.textContent ?? '').not.toContain('源码位置');
  });
});
