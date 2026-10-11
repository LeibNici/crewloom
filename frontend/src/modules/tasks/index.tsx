import { accessCheck, defineModule } from '../types';
import { AiTaskPage } from './pages/AiTaskPage';
import { ApprovalUnavailablePage } from './pages/ApprovalUnavailablePage';
import { CcListPage, CcTaskPage } from './pages/CcTaskPage';
import { ManualTaskPage } from './pages/ManualTaskPage';
import { PendingTasksPage } from './pages/PendingTasksPage';
import { ProcessedTasksPage } from './pages/ProcessedTasksPage';
import { TasksIndex } from './TasksIndex';

/**
 * 任务与待办模块（TD-01 … TD-05）——**组 C（WF + TD）独占文件**。
 *
 * 13000 实测约束：
 *  - 当前登录账号的待办/抄送/AI 任务计数**真实为 0**（`workflowManualTasks`、`workflowCcTasks`、
 *    `aiWorkflowTasks`、`userWorkflowTasks` 均为 0）→ 真实非空验收受样本限制，**但不限制受控实现**：
 *    页面与提交链路要完整实现，空态如实呈现。
 *
 * 已确认契约（十页闭环，勿再写成"未闭环/只做骨架"）：
 *  - **TD-02 人工处理表单**：完整渲染布局内联在 `node.config.schema`（Formily 结构），
 *    详情一次请求即可拿到它与处理配置：
 *    `GET workflowManualTasks:get?filterByTk=<id>&appends=node,job,workflow,workflow.nodes,execution,execution.jobs`。
 *    `node.config.forms[formKey]` 只是动作/处理配置（`actions[].key/status`、`type`、`dataSource`）；
 *    `formKey` = schema 顶层属性名；提交
 *    `POST workflowManualTasks:submit?filterByTk=<id>`，body `{ result: { "<formKey>": {...}, "_": "<actionKey>" } }`
 *    （`_` 与 `formKey` 同级）。处理资格：task/job=PENDING 且 execution=STARTED，否则 400；锁冲突 409。
 *  - **TD-03 AI 任务审核**走**两步协议**：先
 *    `POST aiConversations:updateUserDecision { sessionId, messageId, toolCallId, userDecision }`
 *    （决策取值 `approve|edit|reject`，`edit` 带 `editedAction`），等全部工具进入 `waiting` 后
 *    `POST aiConversations:resumeToolCall { sessionId, messageId, toolCallIds, toolCallResults, model, webSearch }`。
 *    `toolCallResults` **只承载前端工具**的结果（后端工具由服务端执行）。
 *    任务层另有 `aiWorkflowTasks:accept`（认领，`pending_acceptance`→`pending_approval`）与
 *    `aiWorkflowTasks:reject`（终止，需 `status=pending_approval` 且 `acceptedUserId=userId`）；
 *    详情 `GET aiWorkflowTasks:getBySession?sessionId=` 返回 `readonly`。
 *    **accept=认领、reject=终止，批准/修改走会话决策**，三者不要混。
 *  - TD-04 抄送：`workflowCcTasks:read|readAll|unread`；**已读不等于流程推进**，文案要保持。
 *  - TD-05 专业审批：13000 上审批插件确实不存在 → 按能力未开通如实呈现。
 */
export const tasksModule = defineModule({
  id: 'tasks',
  title: '任务与待办',
  path: '/tasks',
  subtitle: '待办、已处理与抄送',
  access: accessCheck('tasks.read', '查看待办', 'userWorkflowTaskStats', 'listMine'),
  probeId: 'tasks.read',
  IndexComponent: TasksIndex,
  boards: [
    {
      path: 'pending',
      title: '我的待处理',
      description: '按来源查看人工待办、AI 任务与抄送。',
      access: accessCheck('tasks.pending', '查看待处理', 'userWorkflowTasks', 'listMine'),
      probeId: 'tasks.read',
      endpoints: [
        'workflowManualTasks:listMine',
        'workflowCcTasks:listMine',
        'aiWorkflowTasks:list',
        'userWorkflowTaskStats:listMine',
        'aiWorkflowTasks:unreadCount',
      ],
      Component: PendingTasksPage,
    },
    {
      path: 'processed',
      title: '已处理',
      description: '查看各来源的累计与待处理数量，状态与可执行动作遵循各来源原有规则。',
      access: accessCheck('tasks.processed', '查看已处理', 'userWorkflowTasks', 'listMine'),
      probeId: 'tasks.read',
      endpoints: ['userWorkflowTasks:listMine', 'userWorkflowTaskStats:listMine'],
      Component: ProcessedTasksPage,
    },
    {
      path: 'cc-list',
      title: '抄送我的',
      description: '查看抄送消息列表，可标记已读或未读。抄送已读不等于流程被批准或继续执行。',
      access: accessCheck('tasks.cc', '查看抄送', 'userWorkflowTasks', 'listMine'),
      probeId: 'tasks.read',
      endpoints: ['workflowCcTasks:listMine', 'workflowCcTasks:readAll'],
      Component: CcListPage,
    },
    {
      path: 'cc',
      title: '抄送详情',
      description: '查看单条抄送消息与关联流程，维护自己的已读状态。',
      access: accessCheck('tasks.ccDetail', '查看抄送详情', 'workflowCcTasks', 'get'),
      probeId: 'tasks.read',
      endpoints: ['workflowCcTasks:get', 'workflowCcTasks:read', 'workflowCcTasks:readAll', 'workflowCcTasks:unread'],
      Component: CcTaskPage,
    },
    {
      path: 'manual',
      title: '人工处理',
      description: '按节点配置的表单填写并提交处理结果。',
      access: accessCheck('tasks.manual', '处理人工待办', 'workflowManualTasks', 'get'),
      probeId: 'tasks.read',
      endpoints: ['workflowManualTasks:get', 'workflowManualTasks:submit'],
      Component: ManualTaskPage,
    },
    {
      path: 'ai',
      title: 'AI 任务',
      description: '领取、审核或终止 AI 员工任务；批准与修改走会话工具决策。',
      access: accessCheck('tasks.ai', '处理 AI 任务', 'aiWorkflowTasks', 'getBySession'),
      probeId: 'tasks.read',
      endpoints: [
        'aiWorkflowTasks:getBySession',
        'aiWorkflowTasks:accept',
        'aiWorkflowTasks:reject',
        'aiConversations:updateUserDecision',
        'aiConversations:resumeToolCall',
      ],
      Component: AiTaskPage,
    },
    {
      path: 'approval',
      title: '专业审批',
      description: '当前后端没有安装审批能力，本页如实说明原因。',
      access: accessCheck('tasks.approval', '查看审批', 'availableActions', 'list'),
      probeId: 'tasks.read',
      endpoints: ['availableActions:list'],
      Component: ApprovalUnavailablePage,
    },
  ],
});
