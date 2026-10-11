import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harness, renderRegisteredBoard, resetHarness } from '../access/page-harness';
import { nodeTypeSpec } from '../../../src/modules/workflow/nodeTypes';

/**
 * 工作流模块的**产品可见文案**（jsdom + 受控 adapter）。
 *
 * 要求（本轮任务）：面向用户的位置不再出现实现名与运行方式术语——
 * "原生画布 / 官方运行时 / 原生运行时 / 后端 / 上游 / ModeConfig / Assignees / 用户 ID / Collection"，
 * 改成用户能理解的说法（流程编排 / 处理方式 / 负责人 / 填写要求）。
 *
 * 这里断言的是**页面真实渲染出来的文本**，不是注释；vendor 固定源码与内部注释不在此范围。
 * 原生画布宿主的真实可见文案在本机浏览器的 controlled 脚本里另外核对。
 */

const FORBIDDEN = [
  '原生画布',
  '原生运行时',
  '官方运行时',
  '官方流程画布',
  '后端',
  '上游',
  'ModeConfig',
  'Assignees',
  '用户 ID',
  'Collection',
];

function assertVisibleCopyClean(): void {
  const text = document.body.textContent ?? '';
  for (const term of FORBIDDEN) {
    expect(text, `可见文案不应包含「${term}」`).not.toContain(term);
  }
}

beforeEach(() => {
  resetHarness();
  harness.routes['workflows:get'] = {
    body: {
      data: {
        id: 172,
        key: 'reimburse',
        title: '报销审批',
        type: 'action',
        enabled: true,
        current: true,
        versionExecuted: 0,
        updatedAt: '2026-10-11T09:00:00.000Z',
      },
    },
  };
  harness.routes['flow_nodes:list'] = {
    body: {
      data: [
        { id: 9001, workflowId: 172, type: 'manual', title: '填写报销单', upstreamId: null, branchIndex: null, config: { assignees: [], mode: 1 } },
        { id: 9002, workflowId: 172, type: 'calculation', title: '计算合计', upstreamId: 9001, branchIndex: null, config: { expression: '1+1' } },
      ],
      meta: { count: 2, page: 1, pageSize: 200, totalPage: 1 },
    },
  };
});

afterEach(() => {
  resetHarness();
});

describe('工作流可见文案', () => {
  it('流程编排页不出现实现名，节点顺序按"前序/前后连接"表达', async () => {
    renderRegisteredBoard('workflow', 'canvas', {
      route: '/workflow/canvas?workflowId=172',
      path: '/workflow/canvas',
    });

    expect(await screen.findByText('填写报销单')).toBeInTheDocument();
    expect(screen.getByText(/顺序由节点之间的前后连接决定/)).toBeInTheDocument();
    expect(screen.getAllByText('改接前序').length).toBe(2);
    assertVisibleCopyClean();
  });

  it('节点配置页不出现实现名', async () => {
    harness.routes['flow_nodes:list'] = {
      body: {
        data: [
          {
            id: 9001,
            workflowId: 172,
            type: 'manual',
            title: '填写报销单',
            upstreamId: null,
            branchIndex: null,
            config: { assignees: ['1'], mode: 1, title: '' },
          },
        ],
        meta: { count: 1, page: 1, pageSize: 200, totalPage: 1 },
      },
    };
    renderRegisteredBoard('workflow', 'node', {
      route: '/workflow/node?workflowId=172&nodeId=9001',
      path: '/workflow/node',
    });

    expect(await screen.findByText('前序节点')).toBeInTheDocument();
    assertVisibleCopyClean();
  });

  it('人工处理节点的字段语义是自然中文（处理方式 / 负责人 / 填写要求）', () => {
    const spec = nodeTypeSpec('manual');
    expect(spec).toBeTruthy();
    const labels = (spec?.fields ?? []).map((field) => field.label);
    expect(labels).toContain('任务名称');
    expect(labels).toContain('处理方式');
    expect(labels).toContain('负责人');
    expect(labels).toContain('填写界面（布局结构）');

    const hints = [
      ...(spec?.fields ?? []).map((field) => field.hint ?? ''),
      ...(spec?.fields ?? []).map((field) => field.requiredMessage ?? ''),
    ].join(' ');
    for (const term of FORBIDDEN) {
      expect(hints, `字段说明不应包含「${term}」`).not.toContain(term);
    }
    // 处理方式的取值说明只讲业务差别，不引用上游枚举名。
    expect(hints).toContain('协作处理');
  });
});
