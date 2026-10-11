import { WorkbenchScreen } from '../../screens/WorkbenchScreen';
import { accessCheck, defineModule, pageCheck, type ModulePageProps } from '../types';

/**
 * 工作台（公共负责人维护，三组不改本文件）。
 *
 * 数据来源：`src/api/workbench.ts` 的只读接口（待办统计 / 本人会话 / 可用员工），
 * 全部走后端真实接口，不做假统计。
 */
function WorkbenchIndex() {
  return <WorkbenchScreen />;
}

function WorkbenchBoard({ board }: ModulePageProps) {
  return <WorkbenchScreen boardPath={board.path} />;
}

export const workbenchModule = defineModule({
  id: 'workbench',
  title: '工作台',
  path: '/workbench',
  subtitle: '当前账号的待办、会话与可用员工入口',
  access: pageCheck('workbench.read', '进入工作台'),
  probeId: 'workbench.read',
  IndexComponent: WorkbenchIndex,
  boards: [
    {
      path: 'overview',
      title: '概览',
      description: '查看当前账号与所用角色，以及待办、最近会话和可用员工的概览。',
      access: pageCheck('workbench.read', '查看工作台'),
      probeId: 'workbench.read',
      endpoints: [
        'roles:check',
        'userWorkflowTaskStats:listMine',
        'aiConversations:list',
        'aiEmployees:listByUser',
      ],
      Component: WorkbenchBoard,
    },
    {
      path: 'my-tasks',
      title: '我的待办',
      description: '汇总属于你的待办：待处理数量、涉及流程与按类型汇总，并可进入任务与待办模块处理。',
      access: accessCheck('workbench.tasks', '查看我的待办', 'userWorkflowTaskStats', 'listMine'),
      probeId: 'tasks.read',
      endpoints: ['userWorkflowTasks:listMine', 'userWorkflowTaskStats:listMine'],
      Component: WorkbenchBoard,
    },
    {
      path: 'recent-sessions',
      title: '最近会话',
      description: '列出属于你的会话，并可进入数字员工模块查看会话内容。',
      access: accessCheck('workbench.sessions', '查看最近会话', 'aiConversations', 'list'),
      probeId: 'ai.conversations',
      endpoints: ['aiConversations:list'],
      Component: WorkbenchBoard,
    },
    {
      path: 'available-employees',
      title: '可用员工',
      description: '列出你可以使用的数字员工，并可进入员工目录查看详情。',
      access: accessCheck('workbench.employees', '查看可用员工', 'aiEmployees', 'listByUser'),
      probeId: 'ai.use',
      endpoints: ['aiEmployees:listByUser'],
      Component: WorkbenchBoard,
    },
  ],
});
