// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { getHttpClient, setAuthContext } from '../../../src/api/client';
import { useSessionStore } from '../../../src/auth/store';
import { ManualTaskPage } from '../../../src/modules/tasks/pages/ManualTaskPage';

/**
 * TD-02：`node.config.schema` **真实 Formily 渲染与受控交互**。
 *
 * 走产品真实链路：`src/api/client.ts`（`@nocobase/sdk` APIClient + 传输策略 + 会话世代）
 * → 页面 → `ManualSchemaHost`（`@formily/react` 的 `createSchemaField`）。只在 axios adapter
 * 处替换成受控应答，断言的是真实渲染出来的 DOM（antd + Formily）与真实请求体。
 *
 * schema 用**服务端真实形状**（manualForm.ts `normalizeSchemaRoot` 的迁移脚本证据）：
 * `node.config.schema` 是顶层属性表，块是 `FormBlockProvider`，内层 `FormV2` + `Grid` + `ActionBar`。
 */

interface Captured {
  method?: string;
  url?: string;
  params?: Record<string, unknown>;
  data?: unknown;
}

let captured: Captured[] = [];

function parseBody(data: unknown): Record<string, unknown> {
  if (typeof data === 'string') {
    try {
      return JSON.parse(data) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return (data as Record<string, unknown>) ?? {};
}

function submitBodies(): Array<Record<string, unknown>> {
  return captured
    .filter((entry) => String(entry.url).includes('workflowManualTasks:submit'))
    .map((entry) => parseBody(entry.data));
}

interface AdapterOptions {
  detail: (id: string) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;
  submit?: () => { status: number; body: unknown };
  users?: unknown[];
}

function install(options: AdapterOptions): void {
  const client = getHttpClient();
  client.defaults.adapter = async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
    captured.push({
      method: config.method,
      url: config.url,
      params: config.params as Record<string, unknown> | undefined,
      data: config.data,
    });
    const url = String(config.url ?? '');
    const params = (config.params ?? {}) as Record<string, unknown>;

    const respond = (status: number, body: unknown): AxiosResponse => {
      const response: AxiosResponse = { data: body, status, statusText: String(status), headers: {}, config };
      if (status >= 400) {
        throw new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', config, undefined, response);
      }
      return response;
    };

    if (url.includes('workflowManualTasks:get')) {
      const reply = await options.detail(String(params.filterByTk ?? ''));
      return respond(reply.status, reply.body);
    }
    if (url.includes('workflowManualTasks:submit')) {
      const reply = options.submit?.() ?? { status: 200, body: { data: {} } };
      return respond(reply.status, reply.body);
    }
    if (url.includes('users:list')) {
      return respond(200, { data: options.users ?? [], meta: {} });
    }
    return respond(200, { data: [] });
  };
}

/* ------------------------------------------------------------------ *
 * 真实形状的 schema 工厂
 * ------------------------------------------------------------------ */

type FieldSpec = Record<string, unknown>;

/** 一行的字段（`Grid.Row` 的 properties）。 */
function row(entries: Record<string, FieldSpec>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(entries)) {
    properties[name] = {
      type: 'void',
      'x-component': 'Grid.Col',
      properties: { [name]: { name, 'x-decorator': 'FormItem', ...spec } },
    };
  }
  return properties;
}

/** `node.config.schema`（属性表）：块 → FormV2 → Grid + ActionBar。 */
function schemaOf(blockKey: string, formKey: string, rowProperties: Record<string, unknown>): Record<string, unknown> {
  return {
    [blockKey]: {
      type: 'void',
      'x-decorator': 'FormBlockProvider',
      'x-component': 'CardItem',
      'x-component-props': { title: '处理表单' },
      properties: {
        [formKey]: {
          type: 'void',
          'x-component': 'FormV2',
          'x-use-component-props': 'useFormBlockProps',
          properties: {
            grid: { type: 'void', 'x-component': 'Grid', properties: { row1: { type: 'void', 'x-component': 'Grid.Row', properties: rowProperties } } },
            actions: {
              type: 'void',
              'x-decorator': 'ActionBarProvider',
              'x-component': 'ActionBar',
              properties: {
                approve: {
                  type: 'void',
                  title: '通过',
                  name: 'approve',
                  'x-decorator': 'ManualActionStatusProvider',
                  'x-decorator-props': { value: 1 },
                  'x-component': 'Action',
                  'x-component-props': { type: 'primary' },
                },
              },
            },
          },
        },
      },
    },
  };
}

function formsOf(formKey: string): Record<string, unknown> {
  return { [formKey]: { type: 'create', actions: [{ key: 'approve', status: 1, title: '通过' }] } };
}

function taskOf(options: {
  id: string;
  schema: Record<string, unknown>;
  forms: Record<string, unknown>;
  result?: unknown;
  status?: number;
  jobStatus?: number;
  executionStatus?: number;
}): Record<string, unknown> {
  return {
    id: options.id,
    status: options.status ?? 0,
    userId: 3,
    createdAt: '2026-10-11T01:00:00.000Z',
    result: options.result ?? null,
    job: { id: 99, status: options.jobStatus ?? 0, userId: 3 },
    execution: { id: 55, status: options.executionStatus ?? 0 },
    workflow: { id: 172, title: '报销审批', current: true },
    node: { id: 2410, title: '填写报销单', type: 'manual', config: { mode: 0, forms: options.forms, schema: options.schema } },
  };
}

function renderPage(id: string) {
  const router = createMemoryRouter([{ path: '/tasks/manual', element: <ManualTaskPage /> }], {
    initialEntries: [`/tasks/manual?id=${id}`],
  });
  return { router, ...render(<RouterProvider router={router} />) };
}

beforeEach(() => {
  captured = [];
  setAuthContext({ token: 'test-token', role: null });
  useSessionStore.setState({ user: { id: 3, nickname: '测试用户' } });
});

/* ------------------------------------------------------------------ *
 * 1. 嵌套 schema 真实渲染
 * ------------------------------------------------------------------ */

describe('TD-02 真实 Formily 渲染', () => {
  it('按 node.config.schema 的嵌套布局渲染真实字段组件与 schema 动作', async () => {
    const schema = schemaOf('block1', 'formA', row({
      amount: { type: 'number', title: '报销金额', 'x-component': 'InputNumber', required: true },
      reason: { type: 'string', title: '事由', 'x-component': 'Input' },
    }));
    install({
      detail: () => ({ status: 200, body: { data: taskOf({ id: '7', schema, forms: formsOf('formA') }) } }),
    });

    renderPage('7');
    expect(await screen.findByText('报销金额')).toBeTruthy();
    expect(screen.getByText('事由')).toBeTruthy();
    // 真实 antd 组件（不是手写 input 冒充 Formily）：数字字段是 InputNumber 的 spinbutton。
    expect(screen.getByRole('spinbutton', { name: '报销金额' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: '事由' })).toBeTruthy();
    // schema 的 ActionBar/Action 渲染成按钮（不是 forms 兜底）。
    expect(screen.getByRole('button', { name: '通过' })).toBeTruthy();
    expect(screen.queryByTestId('schema-fallback-actions')).toBeNull();
    // 带点号的 `x-component`（Grid.Row / Grid.Col）必须解析成注册组件，而不是被当成未知自定义标签。
    const customTags = [...document.querySelectorAll('*')]
      .map((el) => el.tagName)
      .filter((tag) => tag.includes('.'));
    expect(customTags).toEqual([]);
    const detail = captured.find((entry) => String(entry.url).includes('workflowManualTasks:get'));
    expect(detail?.params?.appends).toEqual(['node', 'job', 'workflow', 'workflow.nodes', 'execution', 'execution.jobs', 'user']);
  });
});

/* ------------------------------------------------------------------ *
 * 2. 必填 / 数字 / 日期类型
 * ------------------------------------------------------------------ */

describe('TD-02 必填与字段类型', () => {
  it('必填未填时 Formily 拦住提交并给出字段级中文提示', async () => {
    const schema = schemaOf('block1', 'formA', row({
      amount: { type: 'number', title: '报销金额', 'x-component': 'InputNumber', required: true },
    }));
    install({ detail: () => ({ status: 200, body: { data: taskOf({ id: '7', schema, forms: formsOf('formA') }) } }) });
    renderPage('7');
    await screen.findByText('报销金额');
    await userEvent.click(screen.getByRole('button', { name: '通过' }));
    expect(await screen.findByText('请填写「报销金额」')).toBeTruthy();
    expect(submitBodies()).toHaveLength(0);
  });

  it('数字与日期按 schema 类型提交（number / YYYY-MM-DD）', async () => {
    const schema = schemaOf('block1', 'formA', row({
      amount: { type: 'number', title: '报销金额', 'x-component': 'InputNumber', required: true },
      spentAt: { type: 'string', title: '发生日期', 'x-component': 'DatePicker' },
    }));
    install({ detail: () => ({ status: 200, body: { data: taskOf({ id: '7', schema, forms: formsOf('formA') }) } }) });
    renderPage('7');
    await userEvent.type(await screen.findByRole('spinbutton', { name: '报销金额' }), '256');
    const date = screen.getByLabelText('发生日期') as HTMLInputElement;
    expect(date.type).toBe('date');
    await userEvent.type(date, '2026-10-11');
    await userEvent.click(screen.getByRole('button', { name: '通过' }));

    await waitFor(() => expect(submitBodies()).toHaveLength(1));
    expect(submitBodies()[0]).toEqual({ result: { formA: { amount: 256, spentAt: '2026-10-11' }, _: 'approve' } });
  });
});

/* ------------------------------------------------------------------ *
 * 3. x-reactions
 * ------------------------------------------------------------------ */

describe('TD-02 x-reactions（真实 Formily 联动）', () => {
  const reactiveSchema = schemaOf('block1', 'formA', row({
    urgent: { type: 'boolean', title: '是否加急', 'x-component': 'Checkbox' },
    reason: {
      type: 'string',
      title: '加急原因',
      'x-component': 'Input',
      'x-reactions': { dependencies: ['.urgent'], fulfill: { state: { visible: '{{$deps[0] === true}}' } } },
    },
    category: {
      type: 'string',
      title: '类别',
      'x-component': 'Select',
      enum: [
        { label: '差旅', value: 'travel' },
        { label: '餐费', value: 'meal' },
      ],
    },
    code: {
      type: 'string',
      title: '报销编号',
      'x-component': 'Input',
      'x-reactions': { dependencies: ['.category'], fulfill: { state: { value: '{{$deps[0] === "travel" ? "T-100" : ""}}' } } },
    },
  }));

  function renderReactive() {
    install({ detail: () => ({ status: 200, body: { data: taskOf({ id: '7', schema: reactiveSchema, forms: formsOf('formA') }) } }) });
    renderPage('7');
  }

  it('fulfill.state.visible 按依赖字段动态显隐', async () => {
    renderReactive();
    await screen.findByText('是否加急');
    expect(screen.queryByText('加急原因')).toBeNull();

    await userEvent.click(screen.getByRole('checkbox', { name: '是否加急' }));
    expect(await screen.findByText('加急原因')).toBeTruthy();

    await userEvent.click(screen.getByRole('checkbox', { name: '是否加急' }));
    await waitFor(() => expect(screen.queryByText('加急原因')).toBeNull());
  });

  it('fulfill.state.value 按依赖字段联动赋值并进入提交体', async () => {
    renderReactive();
    await screen.findByText('类别');
    await userEvent.click(screen.getByRole('combobox', { name: '类别' }));
    await userEvent.click(await screen.findByTitle('差旅'));

    await waitFor(() => expect((screen.getByRole('textbox', { name: '报销编号' }) as HTMLInputElement).value).toBe('T-100'));

    await userEvent.click(screen.getByRole('button', { name: '通过' }));
    await waitFor(() => expect(submitBodies()).toHaveLength(1));
    expect(submitBodies()[0]).toEqual({ result: { formA: { category: 'travel', code: 'T-100' }, _: 'approve' } });
  });
});

/* ------------------------------------------------------------------ *
 * 4. 关联字段：候选值走 SDK 管线 + 回显
 * ------------------------------------------------------------------ */

describe('TD-02 关联字段（同 SDK 管线 + 回显）', () => {
  const associationSchema = schemaOf('block1', 'formA', row({
    reviewers: {
      type: 'array',
      title: '会签人',
      'x-component': 'AssociationField',
      'x-collection-field': 'expenses.reviewers',
      'x-component-props': { multiple: true, target: 'users', fieldNames: { label: 'nickname', value: 'id' } },
    },
  }));

  it('候选值经 users:list 读取（同一 SDK 请求管线），选择后按数组提交', async () => {
    install({
      users: [
        { id: 3, nickname: '张三' },
        { id: 7, nickname: '李四' },
      ],
      detail: () => ({ status: 200, body: { data: taskOf({ id: '7', schema: associationSchema, forms: formsOf('formA') }) } }),
    });
    renderPage('7');
    await userEvent.click(await screen.findByRole('combobox', { name: '会签人' }));
    expect(await screen.findByTitle('张三')).toBeTruthy();
    expect(screen.getByTitle('李四')).toBeTruthy();
    expect(captured.find((entry) => String(entry.url).includes('users:list'))?.method).toBe('get');

    await userEvent.click(screen.getByTitle('张三'));
    await userEvent.click(screen.getByRole('button', { name: '通过' }));
    await waitFor(() => expect(submitBodies()).toHaveLength(1));
    expect((submitBodies()[0].result as Record<string, unknown>).formA).toEqual({ reviewers: [3] });
  });

  it('回显已保存的关联值（候选里没有的值也保留，不静默丢数据）', async () => {
    install({
      users: [{ id: 7, nickname: '李四' }],
      detail: () => ({
        status: 200,
        body: {
          data: taskOf({
            id: '8',
            schema: associationSchema,
            forms: formsOf('formA'),
            result: { formA: { reviewers: [7, 99] } },
            status: 1,
            jobStatus: 1,
            executionStatus: 1,
          }),
        },
      }),
    });
    renderPage('8');
    await screen.findByText('会签人');
    await waitFor(() => expect(screen.getByTitle('李四')).toBeTruthy());
    expect(screen.getByTitle('99')).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ *
 * 5. 提交形状 + 读回 + 409
 * ------------------------------------------------------------------ */

describe('TD-02 提交与读回', () => {
  it('提交 {result:{formKey,_}}；处理完成后回读并进入只读', async () => {
    let result: unknown = null;
    const schema = schemaOf('block1', 'formA', row({
      amount: { type: 'number', title: '报销金额', 'x-component': 'InputNumber', required: true },
    }));
    install({
      detail: () => ({
        status: 200,
        body: {
          data: taskOf({
            id: '7',
            schema,
            forms: formsOf('formA'),
            result,
            status: result ? 1 : 0,
            jobStatus: result ? 1 : 0,
            executionStatus: result ? 1 : 0,
          }),
        },
      }),
      submit: () => {
        result = { formA: { amount: 120 }, _: 'approve' };
        return { status: 200, body: { data: { id: 7, status: 1 } } };
      },
    });
    renderPage('7');
    await userEvent.type(await screen.findByRole('spinbutton', { name: '报销金额' }), '120');
    await userEvent.click(screen.getByRole('button', { name: '通过' }));

    await waitFor(() => expect(submitBodies()).toHaveLength(1));
    expect(submitBodies()[0]).toEqual({ result: { formA: { amount: 120 }, _: 'approve' } });
    expect(Object.keys(submitBodies()[0])).toEqual(['result']);
    expect(await screen.findByText(/这条待办已经处理过/)).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: '报销金额' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '通过' })).toBeNull();
  });

  it('409 冲突保留未提交内容，只提示 + 显式刷新，不谎报成功', async () => {
    const schema = schemaOf('block1', 'formA', row({ reason: { type: 'string', title: '事由', 'x-component': 'Input' } }));
    install({
      detail: () => ({ status: 200, body: { data: taskOf({ id: '9', schema, forms: formsOf('formA') }) } }),
      submit: () => ({ status: 409, body: { errors: [{ message: 'lock conflict', code: 'LOCKED' }] } }),
    });
    renderPage('9');
    await userEvent.type(await screen.findByRole('textbox', { name: '事由' }), '并发提交');
    await userEvent.click(screen.getByRole('button', { name: '通过' }));

    expect(await screen.findByText(/可能正在被其他人处理，或已经处理完成/)).toBeTruthy();
    expect(screen.queryByText(/已提交处理结果/)).toBeNull();
    // 未提交的输入被保留；冲突不再自动重新读取（自动 load 会重建表单清空输入）。
    expect(screen.getByDisplayValue('并发提交')).toBeTruthy();
    expect(captured.filter((entry) => String(entry.url).includes('workflowManualTasks:get')).length).toBe(1);
    await userEvent.click(screen.getByRole('button', { name: '刷新查看最新状态' }));
    await waitFor(() =>
      expect(captured.filter((entry) => String(entry.url).includes('workflowManualTasks:get')).length).toBe(2),
    );
  });

  /**
   * Main 反馈（37 复验）：刷新已经确认"已处理"后，页面底部仍残留旧 409 文案
   * 「该内容已被处理或正在被其他人处理，请刷新后查看最新状态」。
   * 根因是 `useMutation` 的 `message` 在显式刷新时没有被清掉（`conflict` 一置 false 它就露出来了）。
   */
  it('409 后显式刷新确认已处理：清除陈旧 409 提示，只显示只读结果', async () => {
    const schema = schemaOf('block1', 'formA', row({ reason: { type: 'string', title: '事由', 'x-component': 'Input' } }));
    let resolved = false;
    install({
      detail: () =>
        resolved
          ? {
              status: 200,
              body: {
                data: taskOf({
                  id: '9',
                  schema,
                  forms: formsOf('formA'),
                  result: { formA: { reason: '别处已处理' }, _: 'approve' },
                  status: 1,
                  jobStatus: 1,
                  executionStatus: 1,
                }),
              },
            }
          : { status: 200, body: { data: taskOf({ id: '9', schema, forms: formsOf('formA') }) } },
      submit: () => ({ status: 409, body: { errors: [{ message: 'lock conflict', code: 'LOCKED' }] } }),
    });
    renderPage('9');
    await userEvent.type(await screen.findByRole('textbox', { name: '事由' }), '我的草稿');
    await userEvent.click(screen.getByRole('button', { name: '通过' }));
    expect(await screen.findByText(/提交没有成功/)).toBeTruthy();

    // 这条待办已被别处处理完成；用户点显式刷新后应看到最终只读结果。
    resolved = true;
    await userEvent.click(screen.getByRole('button', { name: '刷新查看最新状态' }));
    expect(await screen.findByText(/这条待办已经处理过/)).toBeTruthy();
    expect(screen.getByDisplayValue('别处已处理')).toBeDisabled();
    // 关键回归：旧 409 的通用错误文案不能再出现（刷新已经确认了最新状态）。
    expect(screen.queryByText(/该内容已被处理或正在被其他人处理/)).toBeNull();
    expect(screen.queryByText(/提交没有成功/)).toBeNull();
  });

  /** 同页只换 `?id=` 时，上一条待办的冲突卡片不能挂到新任务上。 */
  it('切换任务时不继承上一条待办的冲突提示', async () => {
    const schema = schemaOf('block1', 'formA', row({ reason: { type: 'string', title: '事由', 'x-component': 'Input' } }));
    install({
      detail: (id) => ({ status: 200, body: { data: taskOf({ id, schema, forms: formsOf('formA') }) } }),
      submit: () => ({ status: 409, body: { errors: [{ message: 'lock conflict', code: 'LOCKED' }] } }),
    });
    const { router } = renderPage('9');
    await userEvent.type(await screen.findByRole('textbox', { name: '事由' }), '并发提交');
    await userEvent.click(screen.getByRole('button', { name: '通过' }));
    expect(await screen.findByText(/提交没有成功/)).toBeTruthy();

    await router.navigate('/tasks/manual?id=7');
    await waitFor(() => expect(screen.queryByText(/提交没有成功/)).toBeNull());
    expect(screen.queryByText(/该内容已被处理或正在被其他人处理/)).toBeNull();
    expect(await screen.findByRole('button', { name: '通过' })).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ *
 * 6. 无权限 / 已处理
 * ------------------------------------------------------------------ */

describe('TD-02 只读与无权限', () => {
  it('详情被后端拒绝（403）时如实提示，不渲染表单也不假成功', async () => {
    install({ detail: () => ({ status: 403, body: { errors: [{ message: 'Forbidden', code: 'FORBIDDEN' }] } }) });
    renderPage('12');
    expect(await screen.findByText(/待办详情暂时读不到/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '通过' })).toBeNull();
    expect(screen.queryByText('报销金额')).toBeNull();
  });

  it('已处理时字段禁用且不展示任何动作', async () => {
    const schema = schemaOf('block1', 'formA', row({ reason: { type: 'string', title: '事由', 'x-component': 'Input' } }));
    install({
      detail: () => ({
        status: 200,
        body: {
          data: taskOf({
            id: '8',
            schema,
            forms: formsOf('formA'),
            result: { formA: { reason: '已处理' }, _: 'approve' },
            status: 1,
            jobStatus: 1,
            executionStatus: 1,
          }),
        },
      }),
    });
    renderPage('8');
    expect(await screen.findByText(/这条待办已经处理过/)).toBeTruthy();
    expect(screen.getByRole('textbox', { name: '事由' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '通过' })).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 7. 异步切换任务：旧结果隔离
 * ------------------------------------------------------------------ */

describe('TD-02 异步切换任务隔离', () => {
  it('切到新任务后，旧任务的迟到响应不得覆盖界面', async () => {
    const gate: { release: () => void } = { release: () => undefined };
    const firstGate = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    const schemaA = schemaOf('block1', 'formA', row({ reasonA: { type: 'string', title: '旧任务字段', 'x-component': 'Input' } }));
    const schemaB = schemaOf('block1', 'formB', row({ reasonB: { type: 'string', title: '新任务字段', 'x-component': 'Input' } }));

    install({
      detail: async (id) => {
        if (id === '1') {
          await firstGate;
          return { status: 200, body: { data: taskOf({ id: '1', schema: schemaA, forms: formsOf('formA') }) } };
        }
        return { status: 200, body: { data: taskOf({ id: '2', schema: schemaB, forms: formsOf('formB') }) } };
      },
    });

    const { router } = renderPage('1');
    await router.navigate('/tasks/manual?id=2');
    expect(await screen.findByText('新任务字段')).toBeTruthy();

    gate.release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByText('旧任务字段')).toBeNull();
    expect(screen.getByText('新任务字段')).toBeTruthy();
  });
});
