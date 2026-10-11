import { accessCheck, defineModule } from '../types';
import { ExecutionDetailPage } from './pages/ExecutionDetailPage';
import { ExecutionsPage } from './pages/ExecutionsPage';
import { NodeConfigPage } from './pages/NodeConfigPage';
import { WorkflowCanvasPage } from './pages/WorkflowCanvasPage';
import { WorkflowListPage } from './pages/WorkflowListPage';

/**
 * 工作流模块（WF-01 … WF-05）——**组 C（WF + TD）独占文件**。
 *
 * 13000 实测约束（2.2.20）：
 *  - 流程 172、节点 2410、执行 1895；`workflowCategories` 真实为空（0）；
 *  - **读取某流程的节点**用 `flow_nodes:list?filter={"workflowId":N}` 或
 *    `workflows/<id>/nodes:list`（两者 200）；`/api/workflows/<id>/flow_nodes:list` 在 2.2.20 返回
 *    **500**，不要用；
 *  - 版本模型是 `key` + `current`（布尔）+ 同 key 多条，**没有 publish 动作**；已执行版本有编辑限制；
 *  - 执行状态是数字枚举，前端映射见 `labels.ts`；**没有重试/恢复端点**，不做该按钮；
 *  - 节点类型与配置面板是**客户端代码注册表**，服务端只存 `type` + `config`，没有枚举 API；
 *    未知类型必须保留原始 `config`，不能静默丢弃；
 *  - `flow_nodes:test` 会真实执行节点、`executions:cancel|destroy` 会改变运行状态：严格验证模式一律拦截。
 *
 * 原生复用边界（如实登记）：固定 2.2.22 **源码入口**的画布核心已在本机隔离实验验证 14/14
 * （节点渲染、配置编辑、原生添加连接、保存请求捕获），发布版 UMD 入口加载失败。
 * 但把该源码入口接进产品需要 `@nocobase/client-v2` / `@nocobase/flow-engine` / `antd` 等
 * v2 客户端运行时与 `vite.config.ts` 的 5 处适配，属于公共负责人维护的工程配置。
 * 本组已把精确需求写入 `docs/acceptance/full-pages-13000/05-group-c.md`；
 * 在公共地基接入前，WF-02/WF-03 提供基于真实 `flow_nodes` 数据的编排与配置能力，
 * **不放置静态卡片假画布，也不声称已经复用原生画布**。
 */
export const workflowModule = defineModule({
  id: 'workflow',
  title: '工作流',
  path: '/workflow',
  subtitle: '流程、编排与执行记录',
  access: accessCheck('workflow.read', '查看工作流', 'workflows', 'list'),
  probeId: 'workflow.read',
  boards: [
    {
      path: 'list',
      title: '流程列表',
      description: '查看、创建、分类与启停流程，并识别当前生效版本与历史版本。',
      access: accessCheck('workflow.list', '查看流程列表', 'workflows', 'list'),
      probeId: 'workflow.read',
      endpoints: [
        'workflows:list',
        'workflows:get',
        'workflows:create',
        'workflows:update',
        'workflows:destroy',
        'workflows:revision',
        'workflowCategories:list',
      ],
      Component: WorkflowListPage,
    },
    {
      path: 'executions',
      title: '执行记录',
      description: '按流程版本、状态与时间范围查询历史执行。',
      access: accessCheck('workflow.executions', '查看执行记录', 'executions', 'list'),
      probeId: 'workflow.read',
      endpoints: ['executions:list'],
      Component: ExecutionsPage,
    },
    {
      // 参数化子页：路由由公共注册表按 `路径片段` 展开，页面从查询串读取 workflowId。
      // 使用查询串而不是嵌套路径，是因为公共路由把页面直接挂在 `/<module>/` 下，
      // 嵌套路径会与同级页面冲突（已实测），这属于公共路由约定，不改公共文件。
      path: 'canvas',
      title: '流程编排',
      description: '按前后连接查看流程节点，复制/删除/移动节点并进入节点配置。',
      access: accessCheck('workflow.canvas', '编排流程', 'flow_nodes', 'list'),
      probeId: 'workflow.read',
      endpoints: [
        'workflows:get',
        'flow_nodes:list',
        'flow_nodes:update',
        'flow_nodes:move',
        'flow_nodes:destroy',
        'flow_nodes:duplicate',
        'flow_nodes:destroyBranch',
      ],
      Component: WorkflowCanvasPage,
    },
    {
      path: 'node',
      title: '节点配置',
      description: '查看并修改某个节点的标题与原始配置内容。',
      access: accessCheck('workflow.node', '配置流程节点', 'flow_nodes', 'list'),
      probeId: 'workflow.read',
      endpoints: ['flow_nodes:list', 'flow_nodes:update', 'flow_nodes:test'],
      Component: NodeConfigPage,
    },
    {
      path: 'execution',
      title: '执行详情',
      description: '查看某次执行的节点级输入输出，并在需要时取消或删除该执行。',
      access: accessCheck('workflow.execution', '查看执行详情', 'executions', 'get'),
      probeId: 'workflow.read',
      endpoints: ['executions:get', 'jobs:list', 'executions:cancel', 'executions:destroy'],
      Component: ExecutionDetailPage,
    },
  ],
});
