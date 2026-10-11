import { describe, expect, it } from 'vitest';
import {
  aiTaskStatusLabel,
  executionStatusFilterValue,
  executionStatusLabel,
  jobStatusLabel,
  TRIGGER_TYPE_LABELS,
  triggerTypeLabel,
} from '../../../src/modules/workflow/labels';
import { toExecutionRow, toFlowNodeRow, toWorkflowRow } from '../../../src/modules/workflow/domain';
import { asRecord, readId, readString } from '../../../src/modules/workflow/format';
import { toManualTaskRow } from '../../../src/modules/tasks/domain';

/**
 * 状态映射与行形状的定向测试。
 *
 * 取值对照固定 2.2.22 源码（`executionStatus.ts` / `server/constants.ts`），
 * 目的不是复制实现，而是锁住"数字枚举 → 中文 + 未知值不冒充"的行为。
 */
describe('工作流状态映射', () => {
  it('执行状态按源码枚举映射，未知值如实显示', () => {
    expect(executionStatusLabel(null).label).toBe('排队中');
    expect(executionStatusLabel(0).label).toBe('进行中');
    expect(executionStatusLabel(1).label).toBe('已完成');
    expect(executionStatusLabel(-1).label).toBe('执行失败');
    expect(executionStatusLabel(-2).label).toBe('出错');
    expect(executionStatusLabel(-3).label).toBe('已中止');
    expect(executionStatusLabel(-4).label).toBe('已取消');
    expect(executionStatusLabel(-5).label).toBe('已否决');
    expect(executionStatusLabel(-6).label).toBe('需要重试');
    expect(executionStatusLabel(99).label).toBe('未知状态');
  });

  it('作业状态 0 是等待处理，与执行状态 0 的语义不同', () => {
    expect(jobStatusLabel(0).label).toBe('等待处理');
    expect(jobStatusLabel(1).label).toBe('已完成');
    expect(jobStatusLabel(-2).label).toBe('出错');
    expect(jobStatusLabel('weird').label).toBe('未知状态');
  });

  it('筛选值把 queueing 翻回真实的 null，而不是 0', () => {
    expect(executionStatusFilterValue('queueing')).toBeNull();
    expect(executionStatusFilterValue('1')).toBe(1);
    expect(executionStatusFilterValue('-4')).toBe(-4);
  });

  it('触发器与 AI 任务状态：已知类型给中文，未知类型保留原值', () => {
    expect(triggerTypeLabel('collection')).toBe('数据表事件');
    expect(triggerTypeLabel('schedule')).toBe('定时任务');
    expect(triggerTypeLabel('action')).toBe('自定义操作事件');
    expect(triggerTypeLabel('request-interception')).toBe('请求拦截');
    // AI 员工触发器是 plugin-ai 注册的真实类型，界面必须显示中文题名而不是 `ai-employee`。
    expect(triggerTypeLabel('ai-employee')).toBe('AI 员工事件');
    // 已确认的触发器类型都不允许把内部标识直接显示给用户。
    for (const [type, label] of Object.entries(TRIGGER_TYPE_LABELS)) {
      expect(label, type).not.toBe(type);
      expect(label).not.toMatch(/[a-z]-[a-z]/);
    }
    expect(triggerTypeLabel('some-new-trigger')).toBe('some-new-trigger');
    expect(triggerTypeLabel(null)).toBe('未设置触发器');
    expect(aiTaskStatusLabel('pending_acceptance').label).toBe('待领取');
    expect(aiTaskStatusLabel('pending_approval').label).toBe('待审核');
    expect(aiTaskStatusLabel('approved').label).toBe('已批准');
    expect(aiTaskStatusLabel('nope').label).toBe('未知状态');
  });
});

describe('后端行形状判读', () => {
  it('流程行区分 current 与 enabled，并读取按版本的执行次数', () => {
    const row = toWorkflowRow({
      id: '172',
      title: '订单同步',
      key: 'abc',
      current: true,
      enabled: false,
      sync: true,
      type: 'collection',
      versionStats: { executed: 3 },
      stats: { executed: 9 },
      categories: [{ id: '1', title: '业务' }],
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(row.id).toBe('172');
    expect(row.current).toBe(true);
    expect(row.enabled).toBe(false);
    expect(row.versionExecuted).toBe(3);
    expect(row.categories).toEqual([{ id: '1', title: '业务' }]);
    // 跨版本统计是另一个字段，不能拿它当"本版本已执行"。
    expect(row.raw.stats).toEqual({ executed: 9 });
  });

  it('执行行从关联里读流程标题，缺失时为 null 而不是空字符串', () => {
    const row = toExecutionRow({
      id: '1895',
      workflowId: 172,
      status: -1,
      reason: 'timeout',
      workflow: { id: 172, title: '订单同步', key: 'abc' },
    });
    expect(row.workflowId).toBe('172');
    expect(row.workflowTitle).toBe('订单同步');
    expect(row.workflowKey).toBe('abc');
    expect(toExecutionRow({ id: 1 }).workflowTitle).toBeNull();
  });

  it('节点行保留原始 config（未知类型也不能被丢掉）', () => {
    const row = toFlowNodeRow({
      id: '2410',
      type: 'some-unknown-node',
      title: '未来节点',
      config: { custom: { nested: [1, 2, 3] } },
      branchIndex: 1,
    });
    expect(row.type).toBe('some-unknown-node');
    expect(row.config).toEqual({ custom: { nested: [1, 2, 3] } });
    expect(row.branchIndex).toBe(1);
  });

  it('人工待办行把流程与节点标题摊平，便于列表展示', () => {
    const row = toManualTaskRow({
      id: '7',
      status: 0,
      workflow: { id: 172, title: '报销审批' },
      node: { id: 2410, title: '填写报销单', type: 'manual' },
    });
    expect(row.workflowTitle).toBe('报销审批');
    expect(row.nodeTitle).toBe('填写报销单');
    expect(row.status).toBe(0);
  });
});


describe('字段读取的边界（回归）', () => {
  it('readId 处理数字与字符串主键，readString 只返回字符串', () => {
    // 真实后端大量主键是数字或数字字符串，必须都能读成字符串 ID。
    expect(readId({ id: 3 })).toBe('3');
    expect(readId({ id: '3' })).toBe('3');
    expect(readId({ acceptedUserId: 3 }, 'acceptedUserId')).toBe('3');
    expect(readId({ id: null })).toBeNull();
    expect(readId({ id: '  ' })).toBe('  ');
    // readString 的契约是"仅字符串"：调用方不得用它读数字 ID（须用 readId）。
    expect(readString({ acceptedUserId: 3 }, 'acceptedUserId')).toBeNull();
    expect(readString({ title: 'x' }, 'title')).toBe('x');
    expect(asRecord(3)).toBeNull();
  });
});
