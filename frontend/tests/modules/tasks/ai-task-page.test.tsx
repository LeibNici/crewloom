// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getHttpClient, setAuthContext } from '../../../src/api/client';
import { useSessionStore } from '../../../src/auth/store';
import { AiTaskPage } from '../../../src/modules/tasks/pages/AiTaskPage';

/**
 * jsdom 无法加载固定源码的原生闭包（见 `vitest.config.ts` 的已知限制），
 * 因此把"冷启动装配共享原生运行上下文"固定为"不可用"，本文件只验证消费端语义；
 * 真实注册表的执行证据在浏览器核对里（`verify-native-chat-controlled.mjs`）。
 */
vi.mock('../../../src/modules/tasks/toolBridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/modules/tasks/toolBridge')>();
  return { ...actual, ensureSharedNativeRuntime: vi.fn(async () => false) };
});

/**
 * TD-03 AI 任务的**非空受控交互**（受控 adapter，走产品真实请求管线）。
 *
 * 覆盖评审要求：
 *  - `accept`（领取）与 `reject`（终止）的真实请求形状；
 *  - 两步协议：先逐条 `updateUserDecision`（approve / edit / reject），
 *    **全部工具都进入 waiting 之后**才能 `resumeToolCall`；
 *  - `resumeToolCall` 的载荷形状（`toolCallResults` 只承载前端工具结果）与二次确认；
 *  - 只读（`readonly`）时不应提供会产生真实模型调用的动作。
 */

interface Captured {
  method?: string;
  url?: string;
  params?: Record<string, unknown>;
  data?: unknown;
}

let captured: Captured[] = [];

function parse(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return (value as Record<string, unknown>) ?? {};
}

interface Scenario {
  /** 每次 GET 详情时返回的数据（可以随交互变化）。 */
  detail: () => Record<string, unknown>;
  /** `aiConversations:getMessages` 返回的消息行（工具调用来自这里，与 AI03 同一数据来源）。 */
  messages?: () => unknown[];
  /** 非 200 时抛 axios 错误，用于并发/资格场景。 */
  reply?: () => { status: number; body: unknown };
}

function install(scenario: Scenario): void {
  const client = getHttpClient();
  client.defaults.adapter = async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
    captured.push({ method: config.method, url: config.url, params: config.params, data: config.data });
    const url = String(config.url ?? '');
    const reply = scenario.reply?.() ?? { status: 200, body: { data: {} } };
    const isDetail = url.includes('getBySession');
    const isMessages = url.includes('getMessages');
    const response: AxiosResponse = {
      data: isDetail ? { data: scenario.detail() } : isMessages ? { data: { rows: scenario.messages?.() ?? [] } } : reply.body,
      status: isDetail || isMessages ? 200 : reply.status,
      statusText: '200',
      headers: {},
      config,
    };
    if (response.status >= 400) {
      throw new AxiosError(`Request failed with status code ${response.status}`, 'ERR_BAD_REQUEST', config, undefined, response);
    }
    return response;
  };
}

function toolTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 41,
    status: 'pending_approval',
    sessionId: 'sess-1',
    // 服务端用 acceptedUserId 判定"是否已领取"，终止动作要求它是当前用户。
    acceptedUserId: 3,
    readonly: false,
    jobStatus: 0,
    createdAt: '2026-10-11T00:00:00.000Z',
    aiToolMessages: [
      { id: 900, toolCalls: [{ id: 'call-1', name: 'writeOrder', invokeStatus: 'interrupted', args: { id: 7 } }] },
      { id: 901, toolCalls: [{ id: 'call-2', name: 'notifyUser', invokeStatus: 'interrupted', args: {} }] },
    ],
    ...overrides,
  };
}

function renderPage() {
  const router = createMemoryRouter([{ path: '/tasks/ai', element: <AiTaskPage /> }], {
    initialEntries: ['/tasks/ai?sessionId=sess-1'],
  });
  return render(<RouterProvider router={router} />);
}

beforeEach(() => {
  captured = [];
  setAuthContext({ token: 'test-token', role: null });
  // 当前登录用户默认为空（本文件多数用例只验证消费端语义）；
  // 需要按受理人契约断言的用例自己注入真实用户 id。
  useSessionStore.setState({ user: null });
});

describe('TD-03 AI 任务非空受控交互', () => {
  it('领取任务发出 accept（sessionId），并提示领取≠批准', async () => {
    let status = 'pending_acceptance';
    install({ detail: () => toolTask({ status, acceptedUserId: null }) });
    renderPage();
    expect((await screen.findAllByText('待领取')).length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole('button', { name: '领取任务' }));
    await waitFor(() => expect(captured.some((entry) => String(entry.url).includes('aiWorkflowTasks:accept'))).toBe(true));
    const accept = captured.find((entry) => String(entry.url).includes('aiWorkflowTasks:accept'));
    expect(accept?.method).toBe('post');
    expect(parse(accept?.data)).toEqual({ sessionId: 'sess-1' });
    expect(await screen.findByText(/领取只是认领/)).toBeTruthy();
    status = 'pending_approval';
  });

  it('终止任务需要确认，并发出 reject（含终止结果）', async () => {
    install({ detail: () => toolTask() });
    renderPage();
    await screen.findAllByText('待审核');

    const rejectButton = screen.getByRole('button', { name: '终止任务' });
    expect(rejectButton).not.toBeDisabled();
    await userEvent.click(rejectButton);
    await userEvent.click(await screen.findByRole('button', { name: '确认终止任务' }));
    await waitFor(() => expect(captured.some((entry) => String(entry.url).includes('aiWorkflowTasks:reject'))).toBe(true));
    const reject = captured.find((entry) => String(entry.url).includes('aiWorkflowTasks:reject'));
    const body = parse(reject?.data);
    // 2.2.20/2.2.22 的 reject 契约：`values: { id: <任务 id>, result: <终止结果> }`。
    // 任务 id 按项目约定统一按字符串处理（雪花 ID 可能超出安全整数）。
    expect(body.id).toBe('41');
    expect(typeof body.result).toBe('string');
    expect(await screen.findByText(/已终止该任务/)).toBeTruthy();
  });

  it('两步协议：全部工具进入 waiting 之前不能 resume；记录决定后才可继续', async () => {
    let decisions = 0;
    const detail = () => {
      const base = toolTask();
      const messages = [
        {
          id: 900,
          toolCalls: [
            { id: 'call-1', name: 'writeOrder', invokeStatus: decisions >= 1 ? 'waiting' : 'interrupted', args: { id: 7 } },
          ],
        },
        {
          id: 901,
          toolCalls: [
            { id: 'call-2', name: 'notifyUser', invokeStatus: decisions >= 2 ? 'waiting' : 'interrupted', args: {} },
          ],
        },
      ];
      return { ...base, aiToolMessages: messages };
    };
    install({ detail });
    renderPage();
    await screen.findByText('writeOrder');

    const resume = screen.getByRole('button', { name: '继续执行' });
    expect(resume).toBeDisabled();
    expect(screen.getByText(/仍有 2 条工具调用没有做出决定/)).toBeTruthy();

    // 第一条：否决（带说明）
    await userEvent.type(screen.getAllByRole('textbox', { name: /否决说明/ })[0]!, '参数不合规');
    decisions = 1;
    await userEvent.click(screen.getByRole('button', { name: '否决 writeOrder' }));
    await waitFor(() => expect(captured.some((entry) => String(entry.url).includes('aiConversations:updateUserDecision'))).toBe(true));
    const first = captured.find((entry) => String(entry.url).includes('aiConversations:updateUserDecision'));
    const firstBody = parse(first?.data);
    // messageId / toolCallId 按字符串读取（雪花 ID 可能超过安全整数）。
    expect(firstBody).toMatchObject({ sessionId: 'sess-1', messageId: '900', toolCallId: 'call-1' });
    expect(firstBody.userDecision).toMatchObject({ type: 'reject', message: '参数不合规' });

    // 第二条：批准
    decisions = 2;
    await userEvent.click(await screen.findByRole('button', { name: '批准 notifyUser' }));
    await waitFor(() =>
      expect(captured.filter((entry) => String(entry.url).includes('aiConversations:updateUserDecision')).length).toBe(2),
    );
    const second = captured.filter((entry) => String(entry.url).includes('aiConversations:updateUserDecision'))[1];
    expect(parse(second?.data).userDecision).toEqual({ type: 'approve' });

    // 全部 waiting → 可以继续；继续前需要二次确认（会产生真实模型调用）。
    await waitFor(() => expect(screen.getByRole('button', { name: '继续执行' })).not.toBeDisabled());
    await userEvent.click(screen.getByRole('button', { name: '继续执行' }));
    expect(await screen.findByText(/会触发一次真实的模型调用/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '确认继续' }));

    await waitFor(() => expect(captured.some((entry) => String(entry.url).includes('aiConversations:resumeToolCall'))).toBe(true));
    const resumeCall = captured.find((entry) => String(entry.url).includes('aiConversations:resumeToolCall'));
    const resumeBody = parse(resumeCall?.data);
    expect(resumeBody.sessionId).toBe('sess-1');
    expect(resumeBody.toolCallIds).toEqual(['call-1', 'call-2']);
    // 本页没有前端本地工具：结果数组必须为空（后端工具由服务端执行）。
    expect(resumeBody.toolCallResults).toEqual([]);
    expect(resumeBody.webSearch).toBe(false);
  });

  it('修改参数后批准：edit 决策携带 editedAction（工具名 + 参数）', async () => {
    install({ detail: () => toolTask() });
    renderPage();
    await screen.findByText('writeOrder');

    await userEvent.click(screen.getByRole('button', { name: '修改参数后批准 writeOrder' }));
    await waitFor(() => expect(captured.some((entry) => String(entry.url).includes('aiConversations:updateUserDecision'))).toBe(true));
    const call = captured.find((entry) => String(entry.url).includes('aiConversations:updateUserDecision'));
    const body = parse(call?.data);
    expect(body.userDecision).toMatchObject({ type: 'edit', editedAction: { name: 'writeOrder' } });
    expect((body.userDecision as { editedAction?: { args?: unknown } }).editedAction?.args).toEqual({ id: 7 });
  });

  it('只读任务不提供会产生真实模型调用的动作', async () => {
    install({ detail: () => toolTask({ readonly: true, status: 'approved', aiToolMessages: [] }) });
    renderPage();
    expect(await screen.findByText('当前只读')).toBeTruthy();
    expect(screen.getByRole('button', { name: '继续执行' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '领取任务' })).toBeDisabled();
  });

  /**
   * 非受理人的终止隔离（Main 54 反馈）。
   *
   * 真实 2.2.20 契约：`reject` 要求 `status = pending_approval` 且 `acceptedUserId = 当前用户`，
   * 否则 403 `AI_TASK_NOT_REJECTABLE`；`getBySession` 用同一个条件给出 `readonly`。
   * 因此非受理人看到的是「当前只读」+ 禁用，不能出现可点的「终止任务」。
   * 待领取（`pending_acceptance`）时 `readonly` 本来就是 true，**领取**不能被它一刀切禁掉。
   */
  it('非受理人：终止任务禁用且提示说明由其他人领取', async () => {
    useSessionStore.setState({ user: { id: 7, nickname: '李四' } });
    install({
      detail: () => toolTask({ status: 'pending_approval', acceptedUserId: 3, readonly: true }),
    });
    renderPage();

    expect(await screen.findByText('当前只读')).toBeTruthy();
    expect(screen.getByRole('button', { name: '终止任务' })).toBeDisabled();
    expect(screen.getByText(/已由其他人领取/)).toBeTruthy();
    expect(screen.getByText(/只有领取人本人才能终止/)).toBeTruthy();
    // 没有误报"已由你领取，接着做决定"。
    expect(screen.queryByText(/任务已由你领取/)).toBeNull();
    // 只读下也不会发出决定/续跑请求。
    expect(captured.some((entry) => String(entry.url).includes('aiWorkflowTasks:reject'))).toBe(false);
  });

  it('待领取时领取动作仍可用（readonly 不能一刀切禁掉正确领取）', async () => {
    useSessionStore.setState({ user: { id: 7, nickname: '李四' } });
    install({ detail: () => toolTask({ status: 'pending_acceptance', acceptedUserId: null, readonly: true }) });
    renderPage();

    const acceptButton = await screen.findByRole('button', { name: '领取任务' });
    expect(acceptButton).toBeEnabled();
  });

  it('受理人本人：终止任务可用，二次确认后发出真实 reject', async () => {
    useSessionStore.setState({ user: { id: 3, nickname: '张三' } });
    install({ detail: () => toolTask({ status: 'pending_approval', acceptedUserId: 3, readonly: false }) });
    renderPage();

    const rejectButton = await screen.findByRole('button', { name: '终止任务' });
    expect(rejectButton).toBeEnabled();
    expect(screen.getByText(/任务已由你领取/)).toBeTruthy();
  });
});

/**
 * TD-03 与 AI03 同一数据来源 / 前端工具结果集一致性。
 *
 * 服务端证据（`plugin-ai/dist/server/ai-employees/ai-conversations.js`）：
 *  - `aiWorkflowTasks:getBySession` **不返回**工具消息；
 *  - 工具调用由 `aiConversations:getMessages` 回填 `invokeStatus/execution/willInterrupt/content`
 *    （`updateRead=true` 会把会话标已读，因此本页必须显式 `updateRead=false`）；
 *  - `resumeToolCall` 的前端工具结果形状是 `{ id: toolCallId, result }`
 *    （`frontend-tools.js` 的 `readFrontendToolResult`）。
 */
describe('TD-03 工具调用来源与前端工具结果一致性', () => {
  function messagesWith(execution: string, withResult: boolean): unknown[] {
    return [
      {
        messageId: '900',
        toolCalls: [
          {
            id: 'call-1',
            name: 'frontendAction',
            invokeStatus: 'waiting',
            execution,
            willInterrupt: execution === 'frontend',
            userDecision: { type: 'approve' },
            args: { id: 7 },
            ...(withResult ? { content: { ok: true } } : {}),
          },
        ],
      },
    ];
  }

  it('工具调用从 getMessages 读取且显式 updateRead=false（绝不由本页标已读）', async () => {
    install({
      detail: () => toolTask({ aiToolMessages: [] }),
      messages: () => messagesWith('backend', false),
    });
    renderPage();
    expect(await screen.findByText('frontendAction')).toBeTruthy();

    const messages = captured.find((entry) => String(entry.url).includes('getMessages'));
    expect(messages?.method).toBe('get');
    expect(messages?.params).toMatchObject({ sessionId: 'sess-1', updateRead: false });
  });

  it('前端工具已有结果时，结果集按服务端 {id,result} 形状回传', async () => {
    install({
      detail: () => toolTask({ aiToolMessages: [] }),
      messages: () => messagesWith('frontend', true),
    });
    renderPage();
    await screen.findByText('frontendAction');

    await userEvent.click(screen.getByRole('button', { name: '继续执行' }));
    await userEvent.click(await screen.findByRole('button', { name: '确认继续' }));
    await waitFor(() => expect(captured.some((entry) => String(entry.url).includes('resumeToolCall'))).toBe(true));

    const resume = captured.find((entry) => String(entry.url).includes('resumeToolCall'));
    const body = parse(resume?.data);
    expect(body.toolCallIds).toEqual(['call-1']);
    expect(body.toolCallResults).toEqual([{ id: 'call-1', result: { ok: true } }]);
    expect(body.webSearch).toBe(false);
  });

  it('前端工具需要在页面执行、但没有真实注册表时停止继续执行（不回传空结果触发模型调用）', async () => {
    install({
      detail: () => toolTask({ aiToolMessages: [] }),
      messages: () => messagesWith('frontend', false),
    });
    renderPage();
    await screen.findByText('frontendAction');

    expect(await screen.findByText(/需要在这里执行/)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: '继续执行' }));
    await userEvent.click(await screen.findByRole('button', { name: '确认继续' }));
    // 没有真实注册表时**不**发 resumeToolCall：空结果会让服务端以为前端工具已执行并真的外呼模型。
    expect(await screen.findByText(/工作区工具环境暂时不可用/)).toBeTruthy();
    await waitFor(() => expect(captured.some((entry) => String(entry.url).includes('resumeToolCall'))).toBe(false));
  });

  it('服务端返回全部已决定时提示可以继续（界面状态与服务端一致）', async () => {
    install({
      detail: () => toolTask({ aiToolMessages: [] }),
      messages: () => [
        { messageId: '900', toolCalls: [{ id: 'call-1', name: 'writeOrder', invokeStatus: 'interrupted', args: {} }] },
      ],
      reply: () => ({
        status: 200,
        body: { data: { updated: 1, toolCalls: [{ id: 'call-1', userDecision: { type: 'approve' } }] } },
      }),
    });
    renderPage();
    await screen.findByText('writeOrder');
    await userEvent.click(screen.getByRole('button', { name: '批准 writeOrder' }));
    expect(await screen.findByText(/所有工具调用都已决定/)).toBeTruthy();
  });
  it('getMessages 不回填 userDecision 时，waiting 即视为已决定（2.2.20/2.2.22 实测契约）', async () => {
    install({
      detail: () => toolTask({ aiToolMessages: [] }),
      // 发布实现 `parseMessageRow` 只回填 invokeStatus/execution/willInterrupt 等，不含 userDecision。
      messages: () => [
        {
          messageId: '900',
          toolCalls: [{ id: 'call-1', name: 'writeOrder', invokeStatus: 'waiting', execution: 'backend', args: {} }],
        },
      ],
    });
    renderPage();
    await screen.findByText('writeOrder');
    expect(await screen.findByText('已有决定')).toBeTruthy();

    const resume = screen.getByRole('button', { name: '继续执行' });
    expect(resume).not.toBeDisabled();
    await userEvent.click(resume);
    await userEvent.click(await screen.findByRole('button', { name: '确认继续' }));
    await waitFor(() => expect(captured.some((entry) => String(entry.url).includes('resumeToolCall'))).toBe(true));
    const body = parse(captured.find((entry) => String(entry.url).includes('resumeToolCall'))?.data);
    expect(body.toolCallIds).toEqual(['call-1']);
    // 后端工具没有前端结果，结果集必须为空（不伪造）。
    expect(body.toolCallResults).toEqual([]);
  });
});
