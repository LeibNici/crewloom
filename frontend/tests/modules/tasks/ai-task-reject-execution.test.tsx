// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getHttpClient, setAuthContext } from '../../../src/api/client';
import { AiTaskPage } from '../../../src/modules/tasks/pages/AiTaskPage';
import { resolveNativeToolRegistry } from '../../../src/modules/tasks/toolBridge';

/**
 * TD-03：**被拒绝的前端工具绝不执行、也绝不出现在 `toolCallResults` 里**。
 *
 * 真实契约（本机控制原始记录 + 2.2.20 发布包 `ai-employees/ai-conversations.js` 的
 * `parseMessageRow`）：`aiConversations:getMessages` 只回填
 * `invokeStatus/auto/status/content/execution/willInterrupt/defaultPermission`，
 * **不回填 `userDecision`**；决定只出现在 `aiConversations:updateUserDecision` 的返回
 * `{ updated, toolCalls }` 里。原生 `useToolCallActions.ts:56-79` 正是用这个返回决定
 * "哪些工具要执行"（`decision?.type !== 'reject'`）。
 *
 * jsdom 不能加载固定源码的原生闭包（见 `vitest.config.ts`），所以这里只替换"取真实注册表"
 * 这一步：`runSelectedFrontendTools` 仍是产品实现，执行桩记录每次 `execute` 调用，
 * 用于断言被拒绝的那条**一次都没有被调用**。真实消费者（真 CodeConsumer 改工作区）的
 * 浏览器证据在 `scripts/check-main-ai-task-execution.mjs`。
 */
vi.mock('../../../src/modules/tasks/toolBridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/modules/tasks/toolBridge')>();
  return {
    ...actual,
    ensureSharedNativeRuntime: vi.fn(async () => false),
    resolveNativeToolRegistry: vi.fn(() => null),
  };
});

const UID = 'crewloom:code-workspace';
const CALLS = [
  { id: 'call-1', code: '// approved one\n' },
  { id: 'call-2', code: '// rejected two\n' },
  { id: 'call-3', code: '' },
];

interface Captured {
  method?: string;
  url?: string;
  data?: unknown;
}

let captured: Captured[] = [];
let decisions: Record<string, unknown> = {};
let executedCodes: string[] = [];
/** 模拟"页面重新加载后服务端已决定（waiting）、但本页没有决定内容"的状态。 */
let forceWaiting = false;

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

/** 真实 `getMessages` 形状：工具调用**没有** `userDecision`。 */
function messageRows(): unknown[] {
  return [
    {
      messageId: '900',
      toolCalls: CALLS.map((call) => ({
        id: call.id,
        name: 'executeFrontendTool',
        invokeStatus: decisions[call.id] || forceWaiting ? 'waiting' : 'interrupted',
        execution: 'frontend',
        willInterrupt: true,
        args: { toolId: `${UID}:apply_code_change`, args: { code: call.code } },
      })),
    },
  ];
}

/** `updateUserDecision` 的返回：`{ updated, toolCalls }`，其中已决定项带 `userDecision`。 */
function decisionResponse(): unknown {
  return {
    data: {
      updated: 1,
      toolCalls: CALLS.map((call) => ({
        id: call.id,
        name: 'executeFrontendTool',
        invokeStatus: decisions[call.id] ? 'waiting' : 'interrupted',
        args: { toolId: `${UID}:apply_code_change`, args: { code: call.code } },
        ...(decisions[call.id] ? { userDecision: decisions[call.id] } : {}),
      })),
    },
  };
}

function install(): void {
  const client = getHttpClient();
  client.defaults.adapter = async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
    captured.push({ method: config.method, url: config.url, data: config.data });
    const url = String(config.url ?? '');
    let body: unknown;
    if (url.includes('getBySession')) {
      body = {
        data: {
          id: 41,
          status: 'pending_approval',
          sessionId: 'sess-1',
          acceptedUserId: 3,
          readonly: false,
          jobStatus: 0,
          createdAt: '2026-10-11T00:00:00.000Z',
        },
      };
    } else if (url.includes('getMessages')) {
      body = { data: { rows: messageRows() } };
    } else if (url.includes('updateUserDecision')) {
      const values = parse(config.data);
      decisions[String(values.toolCallId)] = values.userDecision;
      body = decisionResponse();
    } else {
      body = { data: { resumed: true } };
    }
    return { data: body, status: 200, statusText: '200', headers: {}, config };
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
  decisions = {};
  executedCodes = [];
  forceWaiting = false;
  const execute = vi.fn(async (_toolId: string, args: unknown) => {
    const code = (args as { code?: unknown }).code;
    if (typeof code !== 'string' || code.length === 0) {
      throw new Error('apply_code_change 需要一个非空的 code 字符串。');
    }
    executedCodes.push(code);
    return { status: 'success', content: { applied: true } };
  });
  const getManifest = vi.fn(async () => ({ id: `${UID}:apply_code_change` }));
  vi.mocked(resolveNativeToolRegistry).mockReturnValue({ execute, getManifest });
  setAuthContext({ token: 'test-token', role: null });
  install();
});

describe('TD-03 被拒绝的前端工具不执行', () => {
  it('批准1/拒绝2/批准空code3：execute 只被调用两次，结果集不含被拒绝的 2', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: '批准 应用代码修改' })).toHaveLength(3),
    );

    // 第 1 条：批准。
    await userEvent.click(screen.getAllByRole('button', { name: '批准 应用代码修改' })[0]!);
    await waitFor(() =>
      expect(captured.filter((entry) => String(entry.url).includes('updateUserDecision'))).toHaveLength(1),
    );
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: '批准 应用代码修改' })).toHaveLength(2),
    );

    // 第 2 条：拒绝（带说明）。
    await userEvent.click(screen.getAllByRole('button', { name: '否决 应用代码修改' })[0]!);
    await waitFor(() =>
      expect(captured.filter((entry) => String(entry.url).includes('updateUserDecision'))).toHaveLength(2),
    );
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: '批准 应用代码修改' })).toHaveLength(1),
    );

    // 第 3 条：批准（参数是空 code，真实消费者会返回错误）。
    await userEvent.click(screen.getAllByRole('button', { name: '批准 应用代码修改' })[0]!);
    await waitFor(() =>
      expect(captured.filter((entry) => String(entry.url).includes('updateUserDecision'))).toHaveLength(3),
    );

    // 全部 waiting → 可以继续；继续前需要二次确认。
    const resumeButton = await screen.findByRole('button', { name: '继续执行' });
    await waitFor(() => expect(resumeButton).not.toBeDisabled());
    await userEvent.click(resumeButton);
    await userEvent.click(await screen.findByRole('button', { name: '确认继续' }));

    await waitFor(() => expect(captured.some((entry) => String(entry.url).includes('resumeToolCall'))).toBe(true));
    const resumeBody = parse(captured.find((entry) => String(entry.url).includes('resumeToolCall'))?.data);

    // 三条 toolCallId 都要回传（原生语义），但结果只承载"确实执行过"的前端工具。
    expect(resumeBody.toolCallIds).toEqual(['call-1', 'call-2', 'call-3']);
    const results = resumeBody.toolCallResults as Array<{ id: string; result: unknown }>;
    expect(results.map((entry) => entry.id)).toEqual(['call-1', 'call-3']);

    // 被拒绝的 call-2 **一次都没有执行**。
    expect(executedCodes).toEqual(['// approved one\n']);
    expect(executedCodes).not.toContain('// rejected two\n');

    // 批准项成功、空 code 项是真实错误（不是伪造成功）。
    expect(results[0]?.result).toMatchObject({ status: 'success' });
    expect(results[1]?.result).toMatchObject({ status: 'error' });
    expect(String((results[1]?.result as { content?: unknown }).content)).toContain('非空');
  });

  it('历史没有决定记录时停止继续执行（不冒险执行可能是 rejected 的调用）', async () => {
    // 服务端已把三条都置为 waiting（2.2.20 updateUserDecision 命中后就是这样），
    // 但本页没有任何决定内容 —— 这正是"重新加载后只剩 invokeStatus"的状态。
    forceWaiting = true;

    renderPage();
    const resumeButton = await screen.findByRole('button', { name: '继续执行' });
    await waitFor(() => expect(resumeButton).not.toBeDisabled());
    await userEvent.click(resumeButton);
    await userEvent.click(await screen.findByRole('button', { name: '确认继续' }));

    expect(await screen.findByText(/读不到它们的决定内容/)).toBeTruthy();
    await waitFor(() => expect(captured.some((entry) => String(entry.url).includes('resumeToolCall'))).toBe(false));
    expect(executedCodes).toEqual([]);
  });
});
