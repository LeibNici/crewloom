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
 * TD-02 人工处理页的真实请求管线测试（受控 adapter）。
 *
 * 走的是产品实际链路：`src/api/client.ts` → `@nocobase/sdk` 的 `APIClient`，
 * 只在 axios adapter 处替换成受控应答。因此断言的 URL、方法、查询串与请求体
 * 就是产品会真正发给后端的形状（不是另写一套替身实现）。
 *
 * 关键契约（十页闭环 §B1）：
 *  - 详情经 `workflowManualTasks:get`，带 `appends` 一次取回渲染布局；
 *  - `formKey` = schema 顶层属性名；
 *  - 提交 `workflowManualTasks:submit?filterByTk=<id>`，体为
 *    `{ result: { [formKey]: values, _: actionKey } }`，`_` 与 formKey 同级。
 */

interface Captured {
  method?: string;
  url?: string;
  baseURL?: string;
  params?: Record<string, unknown>;
  data?: unknown;
}

const taskDetail = {
  id: 7,
  status: 0,
  userId: 3,
  createdAt: '2026-10-11T01:00:00.000Z',
  job: { id: 99, status: 0 },
  execution: { id: 55, status: 0 },
  workflow: { id: 172, title: '报销审批', current: true },
  node: {
    id: 2410,
    title: '填写报销单',
    type: 'manual',
    config: {
      mode: 0,
      forms: {
        form1: {
          type: 'create',
          collection: 'expenses',
          actions: [
            { key: 'approve', status: 1, title: '通过' },
            { key: 'reject', status: -5, title: '否决' },
          ],
        },
      },
      schema: {
        type: 'void',
        properties: {
          form1: {
            'x-decorator': 'FormBlockProvider',
            'x-component': 'Form',
            properties: {
              amount: { type: 'number', title: '报销金额', 'x-component': 'InputNumber', required: true },
              reason: { type: 'string', title: '事由', 'x-component': 'Input' },
            },
          },
        },
      },
    },
  },
};

let captured: Captured[] = [];

function installAdapter(): void {
  const client = getHttpClient();
  client.defaults.adapter = async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
    captured.push({
      method: config.method,
      url: config.url,
      baseURL: config.baseURL,
      params: config.params as Record<string, unknown> | undefined,
      data: config.data,
    });
    const url = String(config.url ?? '');
    if (url.includes('workflowManualTasks:get')) {
      return { data: { data: taskDetail }, status: 200, statusText: '200', headers: {}, config };
    }
    if (url.includes('workflowManualTasks:submit')) {
      return { data: { data: { id: 7, status: 1 } }, status: 200, statusText: '200', headers: {}, config };
    }
    return { data: { data: [] }, status: 200, statusText: '200', headers: {}, config };
  };
}

function renderPage() {
  const router = createMemoryRouter(
    [{ path: '/tasks/manual', element: <ManualTaskPage /> }],
    { initialEntries: ['/tasks/manual?id=7'] },
  );
  return render(<RouterProvider router={router} />);
}

function parseBody(data: unknown): unknown {
  if (typeof data === 'string') {
    try {
      return JSON.parse(data);
    } catch {
      return data;
    }
  }
  return data;
}

beforeEach(() => {
  captured = [];
  setAuthContext({ token: 'test-token', role: null });
  useSessionStore.setState({ user: null });
  installAdapter();
});

describe('TD-02 人工处理详情', () => {
  it('按 appends 读取详情，并渲染 schema 里的字段', async () => {
    renderPage();
    expect(await screen.findByText('报销金额')).toBeTruthy();
    expect(screen.getByText('事由')).toBeTruthy();
    expect(screen.getByText('报销审批')).toBeTruthy();

    const detail = captured.find((entry) => String(entry.url).includes('workflowManualTasks:get'));
    expect(detail).toBeTruthy();
    expect(detail?.method).toBe('get');
    expect(detail?.params).toMatchObject({ filterByTk: '7' });
    expect(detail?.params?.appends).toEqual([
      'node',
      'job',
      'workflow',
      'workflow.nodes',
      'execution',
      'execution.jobs',
      'user',
    ]);
  });

  it('必填未填写时不发请求，并给出字段级提示', async () => {
    renderPage();
    await screen.findByText('报销金额');
    await userEvent.click(screen.getByRole('button', { name: '通过' }));
    expect(await screen.findByText('请填写「报销金额」')).toBeTruthy();
    expect(captured.some((entry) => String(entry.url).includes(':submit'))).toBe(false);
  });

  it('提交体是 { result: { form1: values, _: actionKey } }，且 _ 与 formKey 同级', async () => {
    renderPage();
    await screen.findByText('报销金额');

    const numberInput = screen.getByRole('spinbutton');
    await userEvent.type(numberInput, '120');
    const textInputs = screen.getAllByRole('textbox');
    await userEvent.type(textInputs[0], '出差');
    await userEvent.click(screen.getByRole('button', { name: '通过' }));

    await waitFor(() => {
      expect(captured.some((entry) => String(entry.url).includes('workflowManualTasks:submit'))).toBe(true);
    });

    const submit = captured.find((entry) => String(entry.url).includes('workflowManualTasks:submit'));
    expect(submit?.method).toBe('post');
    expect(submit?.params).toMatchObject({ filterByTk: '7' });
    const body = parseBody(submit?.data) as { result?: Record<string, unknown> };
    expect(body.result).toBeTruthy();
    expect(body.result?._).toBe('approve');
    expect(body.result?.form1).toMatchObject({ amount: 120, reason: '出差' });
    // 线上体没有 `values` 外层。
    expect(Object.keys(body).sort()).toEqual(['result']);
    expect(await screen.findByText(/已提交处理结果/)).toBeTruthy();
  });
});

describe('TD-02 非空受控交互（回显 / 只读 / 并发冲突 / 关联字段）', () => {
  /** 可变任务详情的受控 adapter：支持"处理后回显"和"并发冲突"。 */
  function installScenario(options: {
    task: Record<string, unknown>;
    submit: () => { status: number; body: unknown };
  }): void {
    const client = getHttpClient();
    client.defaults.adapter = async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
      captured.push({
        method: config.method,
        url: config.url,
        baseURL: config.baseURL,
        params: config.params as Record<string, unknown> | undefined,
        data: config.data,
      });
      const url = String(config.url ?? '');
      if (url.includes('workflowManualTasks:get')) {
        return { data: { data: options.task }, status: 200, statusText: '200', headers: {}, config };
      }
      if (url.includes('workflowManualTasks:submit')) {
        const reply = options.submit();
        const response: AxiosResponse = {
          data: reply.body,
          status: reply.status,
          statusText: String(reply.status),
          headers: {},
          config,
        };
        if (reply.status >= 400) {
          throw new AxiosError(`Request failed with status code ${reply.status}`, 'ERR_BAD_REQUEST', config, undefined, response);
        }
        return response;
      }
      return { data: { data: [] }, status: 200, statusText: '200', headers: {}, config };
    };
  }

  function nodeWith(config: Record<string, unknown>, schema: Record<string, unknown>): Record<string, unknown> {
    return {
      id: 2410,
      title: '填写表单',
      type: 'manual',
      config: { mode: 0, forms: { form1: { type: 'create', actions: [{ key: 'approve', status: 1, title: '通过' }] } }, schema, ...config },
    };
  }

  it('处理完成后回显 result[formKey] 并进入只读，不再提供提交', async () => {
    installScenario({
      task: {
        id: 8,
        status: 1,
        job: { id: 100, status: 1 },
        execution: { id: 56, status: 1 },
        workflow: { id: 172, title: '报销审批', current: true },
        result: { form1: { amount: 88, reason: '已处理的事由' }, _: 'approve' },
        node: nodeWith({}, {
          type: 'void',
          properties: {
            form1: {
              'x-decorator': 'FormBlockProvider',
              properties: {
                amount: { type: 'number', title: '报销金额', 'x-component': 'InputNumber', required: true },
                reason: { type: 'string', title: '事由', 'x-component': 'Input' },
              },
            },
          },
        }),
      },
      submit: () => ({ status: 200, body: { data: {} } }),
    });

    renderPage();
    expect(await screen.findByText(/这条待办已经处理过/)).toBeTruthy();
    expect(screen.getByDisplayValue('88')).toBeDisabled();
    expect(screen.getByDisplayValue('已处理的事由')).toBeDisabled();
    expect(screen.queryByRole('button', { name: '通过' })).toBeNull();
  });

  it('并发冲突（409）保留未提交的输入，只给提示与显式刷新入口，不谎报成功', async () => {
    installScenario({
      task: {
        id: 9,
        status: 0,
        job: { id: 101, status: 0 },
        execution: { id: 57, status: 0 },
        workflow: { id: 172, title: '报销审批', current: true },
        result: null,
        node: nodeWith({}, {
          type: 'void',
          properties: {
            form1: {
              'x-decorator': 'FormBlockProvider',
              properties: { reason: { type: 'string', title: '事由', 'x-component': 'Input' } },
            },
          },
        }),
      },
      submit: () => ({
        status: 409,
        body: { errors: [{ message: 'lock conflict', code: 'LOCKED' }] },
      }),
    });

    renderPage();
    await screen.findByText('事由');
    await userEvent.type(screen.getByRole('textbox', { name: '事由' }), '并发提交');
    await userEvent.click(screen.getByRole('button', { name: '通过' }));

    expect(await screen.findByText(/可能正在被其他人处理，或已经处理完成/)).toBeTruthy();
    expect(screen.queryByText(/已提交处理结果/)).toBeNull();
    // 关键回归：冲突**不**清空刚填的内容，也**不**自动重新读取详情
    // （自动 load 会用服务端初始值重建表单，把用户输入清掉）。
    expect(screen.getByDisplayValue('并发提交')).toBeTruthy();
    expect(captured.filter((entry) => String(entry.url).includes('workflowManualTasks:get')).length).toBe(1);
    // 只有用户显式点"刷新查看最新状态"时才重新读取。
    await userEvent.click(screen.getByRole('button', { name: '刷新查看最新状态' }));
    await waitFor(() =>
      expect(captured.filter((entry) => String(entry.url).includes('workflowManualTasks:get')).length).toBe(2),
    );
  });

  it('关联/多值字段按数组提交（不是被拼成字符串）', async () => {
    installScenario({
      task: {
        id: 10,
        status: 0,
        job: { id: 102, status: 0 },
        execution: { id: 58, status: 0 },
        workflow: { id: 172, title: '报销审批', current: true },
        result: null,
        node: nodeWith({}, {
          type: 'void',
          properties: {
            form1: {
              'x-decorator': 'FormBlockProvider',
              properties: {
                reviewers: {
                  type: 'array',
                  title: '会签人',
                  'x-component': 'AssociationField',
                  enum: [
                    { label: '张三', value: 3 },
                    { label: '李四', value: 7 },
                  ],
                },
              },
            },
          },
        }),
      },
      submit: () => ({ status: 200, body: { data: {} } }),
    });

    renderPage();
    await screen.findByText('会签人');
    await userEvent.click(screen.getByRole('combobox', { name: '会签人' }));
    await userEvent.click(await screen.findByTitle('张三'));
    await userEvent.click(screen.getByRole('combobox', { name: '会签人' }));
    await userEvent.click(await screen.findByTitle('李四'));
    await userEvent.click(screen.getByRole('button', { name: '通过' }));

    await waitFor(() => expect(captured.some((entry) => String(entry.url).includes('workflowManualTasks:submit'))).toBe(true));
    const submit = captured.find((entry) => String(entry.url).includes('workflowManualTasks:submit'));
    const body = parseBody(submit?.data) as { result?: Record<string, unknown> };
    expect(body.result?._).toBe('approve');
    expect(body.result?.form1).toEqual({ reviewers: [3, 7] });
  });
});

/**
 * 受理人展示必须与真实权限判定同源：`workflowManualTasks.userId` + `appends=user`。
 *
 * 回归背景：之前页面读 `node.config.assignees`（节点配置的候选列表），合成任务没有该字段时
 * 一律显示"未指定（按节点配置）"，连确实有 `userId` 的待办也被说成没人负责；而非受理人
 * 仍然看到"请填写"的说明。
 */
describe('TD-02 受理人展示与处理权限一致', () => {
  const manualSchema = {
    type: 'void',
    properties: {
      form1: {
        'x-decorator': 'FormBlockProvider',
        properties: { reason: { type: 'string', title: '事由', 'x-component': 'Input' } },
      },
    },
  };

  function taskFixture(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
      id: 7,
      status: 0,
      userId: 3,
      job: { id: 99, status: 0, userId: 3 },
      execution: { id: 55, status: 0 },
      workflow: { id: 172, title: '报销审批', current: true },
      node: {
        id: 2410,
        title: '填写报销单',
        type: 'manual',
        config: {
          mode: 0,
          forms: { form1: { type: 'create', actions: [{ key: 'approve', status: 1, title: '通过' }] } },
          schema: manualSchema,
        },
      },
      ...overrides,
    };
  }

  function installTask(task: Record<string, unknown>): void {
    const client = getHttpClient();
    client.defaults.adapter = async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
      captured.push({
        method: config.method,
        url: config.url,
        params: config.params as Record<string, unknown> | undefined,
        data: config.data,
      });
      const url = String(config.url ?? '');
      if (url.includes('workflowManualTasks:get')) {
        return { data: { data: task }, status: 200, statusText: '200', headers: {}, config };
      }
      if (url.includes('workflowManualTasks:submit')) {
        return { data: { data: { id: 7, status: 1 } }, status: 200, statusText: '200', headers: {}, config };
      }
      return { data: { data: [] }, status: 200, statusText: '200', headers: {}, config };
    };
  }

  it('受理人按 userId / appends=user 的真实名称展示，不再显示"未指定（按节点配置）"', async () => {
    useSessionStore.setState({ user: { id: 3, nickname: '张三' } });
    installTask(taskFixture({ user: { id: 3, nickname: '张三' } }));

    renderPage();
    expect(await screen.findByText('张三（#3）·本人')).toBeTruthy();
    expect(screen.queryByText(/未指定（按节点配置）/)).toBeNull();
    expect(screen.getByRole('button', { name: '通过' })).toBeTruthy();
  });

  it('有 userId 但取不到姓名时如实标注，不说成"未指定"', async () => {
    useSessionStore.setState({ user: { id: 3, nickname: '张三' } });
    installTask(taskFixture({ user: null }));

    renderPage();
    expect(await screen.findByText('#3（名称暂不可用）')).toBeTruthy();
    expect(screen.queryByText(/未指定/)).toBeNull();
  });

  it('非受理人：明确说明由其他人处理，字段只读且没有处理动作', async () => {
    useSessionStore.setState({ user: { id: 3, nickname: '张三' } });
    installTask(taskFixture({ id: 107, userId: 99, user: null, job: { id: 99, status: 0, userId: 99 } }));

    renderPage();
    expect(await screen.findByText('这条待办由其他人处理')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '通过' })).toBeNull();
    expect(screen.getByRole('textbox', { name: '事由' })).toBeDisabled();
    expect(screen.getByText('#99（名称暂不可用）')).toBeTruthy();
    expect(screen.queryByText(/未指定/)).toBeNull();
  });

  /**
   * 契约核对（2.2.20 与 2.2.22 发布源码一致）：
   * 受理人只来自 `workflowManualTasks.userId`（+ `appends=user`）；
   * 任务关联的 `jobs` 集合**没有** `userId` 字段，任何 handler 都不会把受理人写进作业。
   * 因此即便夹具/响应里出现 `job.userId`，也不能拿它顶替任务的受理人。
   */
  it('作业 userId 不是受理人来源：任务没有 userId 时如实显示"未指定受理人"', async () => {
    useSessionStore.setState({ user: { id: 3, nickname: '张三' } });
    installTask(taskFixture({ userId: null, user: null, job: { id: 99, status: 0, userId: 3 } }));

    renderPage();
    expect(await screen.findByText('未指定受理人')).toBeTruthy();
    expect(screen.queryByText(/#3（名称暂不可用）/)).toBeNull();
  });

  it('受理人 id 按字符串归一比较：bigint 序列化成字符串也不会被误判成"他人"', async () => {
    useSessionStore.setState({ user: { id: 3, nickname: '张三' } });
    // 真实后端 bigint 主键经 JSON 序列化后是字符串；这里任务侧返回 '3'。
    installTask(taskFixture({ userId: '3', user: { id: '3', nickname: '张三' } }));

    renderPage();
    expect(await screen.findByText('张三（#3）·本人')).toBeTruthy();
    expect(screen.getByRole('button', { name: '通过' })).toBeTruthy();
    expect(screen.queryByText('这条待办由其他人处理')).toBeNull();
  });
});
