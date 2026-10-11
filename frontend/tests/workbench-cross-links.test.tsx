import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harness, renderRegisteredBoard, resetHarness } from './modules/access/page-harness';
import { resolveRouteTarget } from '../src/permissions/modules';

/**
 * 工作台的跨模块入口（jsdom + 受控 adapter）。
 *
 * 要求：工作台给出的员工、会话、待办（含抄送）入口必须是**注册表里真实存在的页面**，
 * 既不能是死链，也不能因为目标页面还没实现就退回一句"尚未开放"。
 * 这里逐条断言 href，并用 `resolveRouteTarget` 复核每个目标都能解析到具体页面。
 */

beforeEach(() => {
  resetHarness();
  harness.routes['systemSettings:get'] = { body: { data: { title: '受控后台' } } };
  harness.routes['userWorkflowTaskStats:listMine'] = {
    body: {
      data: [{ workflowKey: 'wf-1', title: '报销审批', stats: { pending: 2, all: 5 } }],
      meta: { page: 1, pageSize: 200, hasNext: false },
    },
  };
  harness.routes['userWorkflowTasks:listMine'] = {
    body: {
      data: [
        { id: 1, type: 'manual', stats: { pending: 2, all: 5 } },
        { id: 2, type: 'cc', stats: { pending: 1, all: 3 } },
      ],
      meta: { count: 2, page: 1, pageSize: 50, totalPage: 1 },
    },
  };
  harness.routes['aiConversations:list'] = {
    body: {
      data: [{ sessionId: 'session-1', title: '会话一', updatedAt: '2026-10-11T09:00:00.000Z', aiEmployeeUsername: 'employee-a' }],
      meta: { count: 1 },
    },
  };
  harness.routes['aiEmployees:listByUser'] = {
    body: { data: [{ username: 'employee-a', nickname: '员工甲', position: '助理' }], meta: { count: 1 } },
  };
  harness.routes['workflowManualTasks:listMine'] = {
    body: {
      data: [{ id: '501', node: { title: '填写报销单', type: 'manual' }, workflow: { title: '报销审批' } }],
      meta: { count: 1, page: 1, pageSize: 5, totalPage: 1 },
    },
  };
  harness.routes['workflowCcTasks:listMine'] = {
    body: {
      data: [{ id: '601', node: { title: '抄送通知', type: 'cc' }, workflow: { title: '报销审批' } }],
      meta: { count: 1, page: 1, pageSize: 5, totalPage: 1 },
    },
  };
});

afterEach(() => {
  resetHarness();
});

function hrefs(): string[] {
  return Array.from(document.querySelectorAll('a')).map((anchor) => anchor.getAttribute('href') ?? '');
}

describe('工作台跨模块入口', () => {
  it('员工/会话/待办（含抄送）入口都指向注册表里真实存在的页面', async () => {
    renderRegisteredBoard('workbench', 'overview');

    expect(await screen.findByText('会话一')).toBeInTheDocument();
    expect(await screen.findByText('员工甲')).toBeInTheDocument();
    expect(await screen.findByText('填写报销单')).toBeInTheDocument();
    expect(await screen.findByText('抄送通知')).toBeInTheDocument();

    const links = hrefs();
    const expected = [
      '/ai/conversations/session-1',
      '/ai/directory/employee-a',
      '/tasks/manual?id=501',
      '/tasks/cc?id=601',
      '/tasks/pending',
      '/tasks/cc-list',
      '/ai/conversations',
      '/ai/directory',
    ];
    for (const target of expected) {
      expect(links).toContain(target);
      // 目标必须能解析到具体页面（不是模块根、也不是不存在）；
      // 带查询串的详情入口（/tasks/manual?id=501）同样要能解析。
      expect(resolveRouteTarget(target)?.board).toBeTruthy();
    }
  });

  it('入口可用时不出现"尚未开放"之类的降级文案', async () => {
    renderRegisteredBoard('workbench', 'overview');
    await screen.findByText('会话一');
    expect(document.body.textContent ?? '').not.toContain('尚未开放');
    expect(document.body.textContent ?? '').not.toContain('暂时无法打开');
  });

  it('待办列表读取的是真实本人待办接口', async () => {
    renderRegisteredBoard('workbench', 'overview');
    await screen.findByText('填写报销单');
    expect(harness.captured.some((item) => item.path === 'workflowManualTasks:listMine')).toBe(true);
    expect(harness.captured.some((item) => item.path === 'workflowCcTasks:listMine')).toBe(true);
  });
});
