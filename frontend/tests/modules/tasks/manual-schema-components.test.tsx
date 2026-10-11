// @vitest-environment jsdom
import { useFieldSchema } from '@formily/react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { getHttpClient, setAuthContext } from '../../../src/api/client';
import { useSessionStore } from '../../../src/auth/store';
import { registerManualSchemaComponents } from '../../../src/modules/tasks/components/manualSchemaHost';
import { ManualTaskPage } from '../../../src/modules/tasks/pages/ManualTaskPage';

/**
 * TD-02 的 **schema 组件注册桥接**（保留既有路径，断言已升级为真实 Formily）。
 *
 * 已确认契约：`node.config.schema` 里的 `x-component` 指向 NocoBase 注册的组件名
 * （`FormBlockProvider` / `InputNumber` / `AssociationField` …）。正确做法是"按名字注册组件"，
 * 而不是把 schema 当成一套自有格式解释。
 *
 * 本文件**不再使用**旧版"注册一个测试替身只断言它被调用"的弱断言，而是要求：
 *  1. 注册的组件必须由**真实 Formily**渲染（`createSchemaField` 按 `x-component` 解析到它，
 *     并替换掉内置字段组件）；
 *  2. 注册组件能通过 `useFieldSchema()` 读到**服务端 schema 里那个字段节点**（`x-component`/`type` 原样保留）；
 *  3. 注册组件回填的值仍然按契约进入真实提交体 `{ result: { [formKey]: values, _: actionKey } }`。
 *
 * 依赖（`@nocobase/client` 的 `SchemaComponent`）由公共负责人统一引入后，注册真实原生组件即可切换，
 * 页面与测试断言都不需要改。
 */

interface Captured {
  method?: string;
  url?: string;
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

/** 真实形状：`node.config.schema` 是顶层属性表，块是 FormBlockProvider，内层 FormV2 + Grid + ActionBar。 */
const SCHEMA = {
  block1: {
    type: 'void',
    'x-decorator': 'FormBlockProvider',
    'x-component': 'CardItem',
    properties: {
      formA: {
        type: 'void',
        'x-component': 'FormV2',
        'x-use-component-props': 'useFormBlockProps',
        properties: {
          grid: {
            type: 'void',
            'x-component': 'Grid',
            properties: {
              row1: {
                type: 'void',
                'x-component': 'Grid.Row',
                properties: {
                  amount: {
                    type: 'void',
                    'x-component': 'Grid.Col',
                    properties: {
                      amount: {
                        name: 'amount',
                        type: 'number',
                        title: '报销金额',
                        'x-decorator': 'FormItem',
                        'x-component': 'InputNumber',
                        required: true,
                      },
                    },
                  },
                },
              },
            },
          },
          actions: {
            type: 'void',
            'x-decorator': 'ActionBarProvider',
            'x-component': 'ActionBar',
            properties: {
              approve: {
                type: 'void',
                name: 'approve',
                title: '通过',
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

const TASK = {
  id: 7,
  status: 0,
  userId: 3,
  createdAt: '2026-10-11T01:00:00.000Z',
  result: null,
  job: { id: 99, status: 0, userId: 3 },
  execution: { id: 55, status: 0 },
  workflow: { id: 172, title: '报销审批', current: true },
  node: {
    id: 2410,
    title: '填写报销单',
    type: 'manual',
    config: {
      mode: 0,
      forms: { formA: { type: 'create', actions: [{ key: 'approve', status: 1, title: '通过' }] } },
      schema: SCHEMA,
    },
  },
};

function install(): void {
  const client = getHttpClient();
  client.defaults.adapter = async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
    captured.push({ method: config.method, url: config.url, data: config.data });
    const url = String(config.url ?? '');
    const respond = (status: number, body: unknown): AxiosResponse => {
      const response: AxiosResponse = { data: body, status, statusText: String(status), headers: {}, config };
      if (status >= 400) {
        throw new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', config, undefined, response);
      }
      return response;
    };
    if (url.includes('workflowManualTasks:get')) return respond(200, { data: TASK });
    if (url.includes('workflowManualTasks:submit')) return respond(200, { data: { id: 7, status: 1 } });
    return respond(200, { data: [] });
  };
}

beforeEach(() => {
  captured = [];
  setAuthContext({ token: 'test-token', role: null });
  useSessionStore.setState({ user: { id: 3, nickname: '测试用户' } });
});

describe('TD-02 schema 组件注册桥接（真实 Formily）', () => {
  it('注册组件由 Formily 渲染、能读到自己的 schema 节点，值进入 result[formKey]', async () => {
    const seen: Array<Record<string, unknown>> = [];
    registerManualSchemaComponents({
      InputNumber: (props: Record<string, unknown>) => {
        const schema = useFieldSchema() as unknown as Record<string, unknown>;
        seen.push(schema);
        return (
          <input
            aria-label="注册的金额输入"
            type="number"
            value={String(props.value ?? '')}
            onChange={(event) =>
              (props.onChange as (value: unknown) => void)?.(event.target.value === '' ? null : Number(event.target.value))
            }
          />
        );
      },
    });

    install();
    const router = createMemoryRouter([{ path: '/tasks/manual', element: <ManualTaskPage /> }], {
      initialEntries: ['/tasks/manual?id=7'],
    });
    render(<RouterProvider router={router} />);

    // 1) 注册组件被真实 Formily 渲染，且**替换掉**内置 antd InputNumber。
    const input = await screen.findByRole('spinbutton', { name: '注册的金额输入' });
    expect(document.querySelector('.ant-input-number-input')).toBeNull();

    // 2) 注册组件通过 useFieldSchema() 拿到的是服务端 schema 的字段节点（约定原样保留）。
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen[0]?.['x-component']).toBe('InputNumber');
    expect(seen[0]?.type).toBe('number');
    expect(seen[0]?.title).toBe('报销金额');

    // 3) 回填的值进入真实提交体 `{ result: { [formKey]: values, _: actionKey } }`。
    await userEvent.type(input, '256');
    await userEvent.click(screen.getByRole('button', { name: '通过' }));
    await waitFor(() =>
      expect(captured.some((entry) => String(entry.url).includes('workflowManualTasks:submit'))).toBe(true),
    );
    const submit = captured.find((entry) => String(entry.url).includes('workflowManualTasks:submit'));
    expect(submit?.method).toBe('post');
    expect(parseBody(submit?.data)).toEqual({ result: { formA: { amount: 256 }, _: 'approve' } });
  });
});
