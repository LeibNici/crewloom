/**
 * 工作流模块的状态/枚举中文映射（组 C 独占）。
 *
 * 取值不是前端自创：`EXECUTION_STATUS` / `JOB_STATUS` 直接对应固定 2.2.22 源码
 * （`plugin-workflow/src/common/executionStatus.ts`、`src/server/constants.ts`）。
 * 后端返回数字枚举，界面必须映射；映射覆盖不到的值如实显示"未知状态"，不猜。
 */

export type PillTone = 'neutral' | 'ok' | 'warn' | 'danger' | 'brand';

export interface StatusLabel {
  label: string;
  tone: PillTone;
  description?: string;
}

/** 源码 EXECUTION_STATUS：QUEUEING=null，STARTED=0，RESOLVED=1，FAILED=-1，ERROR=-2，ABORTED=-3，CANCELED=-4，REJECTED=-5，RETRY_NEEDED=-6。 */
export const EXECUTION_STATUS_MAP: Record<string, StatusLabel> = {
  queueing: { label: '排队中', tone: 'warn', description: '已触发，正在等待执行。' },
  '0': { label: '进行中', tone: 'warn', description: '已经开始，可能正在等待人工处理或异步回调。' },
  '1': { label: '已完成', tone: 'ok', description: '流程执行成功结束。' },
  '-1': { label: '执行失败', tone: 'danger', description: '节点配置未通过校验，流程没有正常完成。' },
  '-2': { label: '出错', tone: 'danger', description: '某个节点执行时出错。' },
  '-3': { label: '已中止', tone: 'neutral', description: '某个节点按流程逻辑中止了后续执行。' },
  '-4': { label: '已取消', tone: 'neutral', description: '等待期间被手动取消。' },
  '-5': { label: '已否决', tone: 'neutral', description: '人工处理时被否决。' },
  '-6': { label: '需要重试', tone: 'danger', description: '执行未成功，但按设计可以再次尝试。' },
};

/** 源码 JOB_STATUS：PENDING=0，其余与执行状态同值域（1/-1/-2/-3/-4/-5/-6）。 */
export const JOB_STATUS_MAP: Record<string, StatusLabel> = {
  '0': { label: '等待处理', tone: 'warn', description: '该节点任务尚未完成。' },
  '1': { label: '已完成', tone: 'ok' },
  '-1': { label: '失败', tone: 'danger' },
  '-2': { label: '出错', tone: 'danger' },
  '-3': { label: '已中止', tone: 'neutral' },
  '-4': { label: '已取消', tone: 'neutral' },
  '-5': { label: '已否决', tone: 'neutral' },
  '-6': { label: '需要重试', tone: 'danger' },
};

/** 执行结束原因（源码 EXECUTION_REASON）。 */
export const EXECUTION_REASON_LABELS: Record<string, string> = {
  timeout: '超时',
  manual_cancel: '手动取消',
  parent_aborted: '随父流程中止',
};

function lookup(map: Record<string, StatusLabel>, value: unknown): StatusLabel {
  if (value === null || value === undefined) return map.queueing;
  const key = typeof value === 'number' ? String(value) : String(value);
  return map[key] ?? { label: '未知状态', tone: 'neutral' };
}

export function executionStatusLabel(value: unknown): StatusLabel {
  return lookup(EXECUTION_STATUS_MAP, value);
}

export function jobStatusLabel(value: unknown): StatusLabel {
  return lookup(JOB_STATUS_MAP, value);
}

/**
 * 执行状态筛选下拉的取值。
 *
 * `null` 是合法取值（排队中按源码就是 null），因此用字符串 `queueing` 表达，
 * 由构造筛选条件的地方显式翻译，避免把"没有筛选"和"排队中"混为一谈。
 */
export const EXECUTION_STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: 'queueing', label: '排队中' },
  { value: '0', label: '进行中' },
  { value: '1', label: '已完成' },
  { value: '-1', label: '执行失败' },
  { value: '-2', label: '出错' },
  { value: '-3', label: '已中止' },
  { value: '-4', label: '已取消' },
  { value: '-5', label: '已否决' },
  { value: '-6', label: '需要重试' },
];

/** 把筛选值翻成真实后端枚举值（`queueing` → null）。 */
export function executionStatusFilterValue(raw: string): number | null {
  return raw === 'queueing' ? null : Number(raw);
}

/**
 * 触发器类型展示名。
 *
 * 已确认的类型来自固定 2.2.22 的客户端注册表（`registerTrigger`）：
 *  - `plugin-workflow/src/client-v2/plugin.tsx`：`collection`、`schedule`
 *  - `plugin-workflow-action-trigger`：`action`
 *  - `plugin-workflow-request-interceptor`：`request-interception`
 *  - `plugin-ai/src/client-v2/workflow/register.ts`：`ai-employee`
 *    （触发器 title = `AI employee event`）
 * 未注册的类型按后端原值显示（**不猜**一个可能错误的中文名，也不把内部标识伪装成业务名称）。
 */
export const TRIGGER_TYPE_LABELS: Record<string, string> = {
  collection: '数据表事件',
  schedule: '定时任务',
  action: '自定义操作事件',
  'custom-action': '自定义操作事件',
  'request-interception': '请求拦截',
  'ai-employee': 'AI 员工事件',
};

export function triggerTypeLabel(type: string | null): string {
  if (!type) return '未设置触发器';
  return TRIGGER_TYPE_LABELS[type] ?? type;
}

/** 人工处理节点模式（源码 ManualInstruction mode）。 */
export function manualModeLabel(mode: unknown): string {
  if (mode === 0) return '单一处理';
  if (mode === -1) return '多人处理（任一通过即可）';
  if (mode === 1) return '多人处理（需全部通过）';
  return '未设置';
}

export const TASK_TYPE_LABELS: Record<string, string> = {
  manual: '人工处理',
  cc: '抄送',
};

export function taskTypeLabel(type: unknown): string {
  if (typeof type !== 'string' || type.length === 0) return '未知来源';
  return TASK_TYPE_LABELS[type] ?? type;
}

/** AI 工作流任务状态（源码 workflow/nodes/employee/constants.ts）。 */
export const AI_TASK_STATUS_MAP: Record<string, StatusLabel> = {
  processing: { label: '处理中', tone: 'warn' },
  pending_acceptance: { label: '待领取', tone: 'warn', description: '等待受理人领取后才能审核。' },
  pending_approval: { label: '待审核', tone: 'brand', description: '已领取，等待批准、要求修改或终止。' },
  approved: { label: '已批准', tone: 'ok' },
  rejected: { label: '已终止', tone: 'neutral' },
  aborted: { label: '已中止', tone: 'neutral' },
};

export function aiTaskStatusLabel(value: unknown): StatusLabel {
  if (typeof value !== 'string') return { label: '未知状态', tone: 'neutral' };
  return AI_TASK_STATUS_MAP[value] ?? { label: '未知状态', tone: 'neutral' };
}

/** 工具调用中断状态（源码 ai-message.type.ts invokeStatus）。 */
export const INVOKE_STATUS_LABELS: Record<string, string> = {
  init: '未开始',
  interrupted: '等待你的决定',
  waiting: '决定已记录',
  pending: '处理中',
  done: '已完成',
  confirmed: '已确认',
};

export function invokeStatusLabel(value: unknown): string {
  if (typeof value !== 'string') return '未知';
  return INVOKE_STATUS_LABELS[value] ?? value;
}
