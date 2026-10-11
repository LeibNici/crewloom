import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api, associatedAction } from '../../../api/client';
import { toUserMessage } from '../../../api/errors';
import { DefinitionRow, EmptyState, PageCard, PageHeader, StatusPill } from '../../../components/Card';
import { useMutation } from '../useMutation';
import { asRecord, formatDateTime, humanizeType, readNumber, readString, truncate } from '../format';
import { triggerTypeLabel } from '../labels';
import { fetchFlowNodes, fetchWorkflow, type FlowNodeRow, type WorkflowRow } from '../domain';
import { CREATABLE_NODE_TYPES, EXTRA_TYPE_LABELS, defaultConfigFor, nodeTypeLabel, nodeTypeSpec } from '../nodeTypes';
import {
  linearSkeleton,
  pathContext,
  planAdjacentSwap,
  planBranchDelete,
  type MoveDirection,
} from '../nodeActions';
import styles from '../workflow.module.css';

/**
 * 原生画布宿主**懒加载**，并且不在单元测试环境加载。
 *
 * 原因：宿主会拉进 `@nocobase/client-v2` / `@nocobase/flow-engine` 固定源码闭包（含 antd ESM），
 * 而 jsdom + Node ESM 解析对 `antd/es/version` 这类**目录导入**会直接抛错（见 vitest.config.ts
 * 的已知限制）。原生组件的交互验证走真实浏览器；jsdom 里只需要页面其余部分可用。
 */
const NativeWorkflowCanvas = import.meta.env.MODE === 'test'
  ? null
  : lazy(async () => ({ default: (await import('../native/nativeWorkflowCanvas')).NativeWorkflowCanvas }));

/**
 * WF-02 流程编排。
 *
 * 画布分两层，**主视图是原生**：
 *  - 上方 `NativeWorkflowCanvas`：`@nocobase/plugin-workflow/client-v2` 固定源码入口的真实画布
 *    （原生 Instruction registry、节点卡片、分支、连线、配置抽屉、原生 `+` 新增入口），
 *    宿主只负责装配 `Application`/`FlowEngineProvider` 与注入产品 SDK 客户端；
 *  - 下方「节点处理顺序」：同一份真实 `flow_nodes` 数据的**辅助清单**，在画布不可用或需要
 *    逐条核对上游关系时使用；它不再被当作"原生画布"。
 *
 * 所有编排数据 100% 来自真实 `flow_nodes:list?filter={"workflowId":N}`（13000 实测可用的读法），
 * 节点增删改移与分支删除走真实原生动作：`flow_nodes:update`（含 `branchIndex`+`upstream`）、
 * `flow_nodes:destroy`、`flow_nodes:duplicate`、`flow_nodes:destroyBranch`。
 * 已产生执行记录的版本受原生约束（服务端 400），界面在动作前就把这一限制说明清楚。
 */
/**
 * 新增节点时的类型清单（**回退用**）：原生宿主就绪后会换成 registry 的真实清单。
 * 这里只列本文件 `NODE_TYPE_SPECS` 有字段语义定义的类型，避免在原生 runtime 不可用时
 * 假装支持没有面板的类型。
 */
const NODE_TYPE_OPTIONS = CREATABLE_NODE_TYPES.map((spec) => ({
  value: spec.type,
  label: spec.label,
  defaultConfig: spec.defaults as Record<string, unknown>,
}));

export function WorkflowCanvasPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const workflowId = params.get('workflowId') ?? '';
  const [workflow, setWorkflow] = useState<WorkflowRow | null>(null);
  const [nodes, setNodes] = useState<FlowNodeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 动作被契约拒绝时的说明（例如"条件判断的分支不能删"），用警告样式展示，不伪装成成功。 */
  const [actionHint, setActionHint] = useState<string | null>(null);
  /** 原生画布触发的**后台**刷新失败时的提示；不清空当前视图，避免把正在编辑的原生抽屉卸载掉。 */
  const [refreshError, setRefreshError] = useState<string | null>(null);
  /**
   * 宿主自己发起的节点变更次数（顺序列表里的新增/复制/移动/删除）。
   * 原生画布的数据是它自己的快照，只有画布内变更会自动刷新；宿主变更靠这个 token 让画布重新取数。
   */
  const [canvasResync, setCanvasResync] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState<FlowNodeRow | null>(null);
  const [confirmBranch, setConfirmBranch] = useState<FlowNodeRow | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newNodeType, setNewNodeType] = useState('calculation');
  const [newNodeTitle, setNewNodeTitle] = useState('');
  const [newNodeUpstream, setNewNodeUpstream] = useState('');
  const [connectNode, setConnectNode] = useState<FlowNodeRow | null>(null);
  const [connectUpstream, setConnectUpstream] = useState('');
  /** 原生 registry 的真实类型清单；为空时用上面的回退清单。 */
  const [nativeTypeOptions, setNativeTypeOptions] = useState(NODE_TYPE_OPTIONS);
  /**
   * 类型显示名：优先用**原生 registry 的官方题名**（宿主就绪后由 `onReady` 覆盖，
   * 已按注册的官方 zh-CN 资源翻好，例如 `ai-employee` → 「AI 员工」），
   * 拿不到时才回退产品侧写死的标签。显示名不改变真实 `type` 值。
   */
  const nativeLabelByType = useMemo(
    () => new Map(nativeTypeOptions.map((option) => [option.value, option.label])),
    [nativeTypeOptions],
  );
  const typeLabel = useCallback(
    (type: string | null | undefined) => (type ? nativeLabelByType.get(type) ?? nodeTypeLabel(type) : nodeTypeLabel(type)),
    [nativeLabelByType],
  );

  const mutation = useMutation();

  /**
   * 读取流程与节点。
   *
   * `quiet` = 由**原生画布里的节点变更**触发的后台刷新：
   *  - 不打开整页 `loading`（那会把原生画布整块替换成"正在读取…"，等于卸载宿主，
   *    正在编辑的原生抽屉会被关掉、用户草稿丢失）；
   *  - 失败时保留当前视图，只给出提示，不把页面切到错误页。
   */
  const load = useCallback(
    async (options?: { quiet?: boolean }) => {
      const quiet = options?.quiet === true;
      if (!workflowId) {
        setLoading(false);
        setLoadError('没有指定要编排的流程。');
        return;
      }
      if (!quiet) setLoading(true);
      setLoadError(null);
      if (!quiet) setRefreshError(null);
      try {
        const [detail, nodeRows] = await Promise.all([fetchWorkflow(workflowId), fetchFlowNodes(workflowId)]);
        setWorkflow(detail);
        if (!detail) {
          setLoadError('这个流程版本不存在，可能已被删除。');
        }
        setNodes(nodeRows);
        setRefreshError(null);
      } catch (error) {
        if (quiet) {
          setRefreshError(toUserMessage(error));
        } else {
          setWorkflow(null);
          setNodes([]);
          setLoadError(toUserMessage(error));
        }
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [workflowId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 合并刷新：原生画布的写成功回调与页面自己的动作可能在同一瞬间各触发一次，
   * 用一次 0ms 定时把它们合并成**一次** `flow_nodes:list`，不做无变化的重复整页拉取。
   */
  const reloadTimer = useRef<number | null>(null);
  const requestReload = useCallback(() => {
    if (reloadTimer.current !== null) return;
    reloadTimer.current = window.setTimeout(() => {
      reloadTimer.current = null;
      void load({ quiet: true });
    }, 0);
  }, [load]);

  useEffect(
    () => () => {
      if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current);
    },
    [],
  );

  /**
   * 按上游关系排出**展示顺序**；找不到上游的节点按原顺序放在前面（不丢节点）。
   *
   * 同一个父节点的子节点里，分支头（`branchIndex` 有值）按序号在前，**线性续行
   * （`branchIndex == null`，即分支之后的汇合点）排在最后**——这与真实执行顺序一致
   * （分支跑完再走续行），也与原生画布沿 `downstream` 渲染的顺序一致。
   */
  const ordered = useMemo(() => {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const children = new Map<string, FlowNodeRow[]>();
    for (const node of nodes) {
      const parent = node.upstreamId;
      if (!parent) continue;
      const list = children.get(parent) ?? [];
      list.push(node);
      children.set(parent, list);
    }
    const heads = nodes.filter((node) => !node.upstreamId || !byId.has(node.upstreamId));
    const visited = new Set<string>();
    const result: FlowNodeRow[] = [];
    const walk = (node: FlowNodeRow) => {
      if (visited.has(node.id)) return;
      visited.add(node.id);
      result.push(node);
      const next = (children.get(node.id) ?? [])
        .slice()
        .sort((a, b) => {
          if (a.branchIndex === null && b.branchIndex === null) return 0;
          if (a.branchIndex === null) return 1;
          if (b.branchIndex === null) return -1;
          return a.branchIndex - b.branchIndex;
        });
      for (const child of next) walk(child);
    };
    for (const head of heads) walk(head);
    for (const node of nodes) walk(node);
    return result;
  }, [nodes]);

  /**
   * **主序列**：真实执行顺序的主干（每次走唯一的线性子节点，分支子树不在其中）。
   * 「上移 / 下移」先按它判断相邻关系，与真实 `downstreamId` 语义一致。
   */
  const skeleton = useMemo(() => linearSkeleton(nodes), [nodes]);
  /**
   * 不该出现的兜底说明（数据畸形、接不到任何顺序上时才会用到）。
   * 正常的分支内步骤现在可以在**同一条处理路径内**上下移，不再落到这条文案。
   */
  const unmovableStepHint = '这个步骤当前不能在顺序清单里上移或下移；可用「改接前序」调整它接在哪一步之后。';

  const executed = workflow?.versionExecuted ?? 0;
  /**
   * 已执行版本是**只读**的：真实服务端对所有节点写动作返回 400，界面在动作前就把边界说清楚，
   * 并把「新增 / 改接 / 上移 / 下移 / 复制 / 删除节点 / 删除分支」**全部**禁用，
   * 不留下"点了必然无效"的入口。
   */
  const writable = executed === 0;
  const readOnlyHint = '该版本已有执行记录，不能再修改；需要调整时请在流程列表里“新建版本”。';

  /**
   * 切换版本（产品页里改 `?workflowId=`，以及原生 header 版本下拉触发的同一跳转）时，
   * 清掉**上一个版本**残留的成功提示、操作错误与打开中的确认面板：它们属于旧版本的操作结果，
   * 留在新版本页面上会误导用户（Main 报的"旧提示/旧 mutation 错误"）。
   * 只清宿主自己的提示状态，不碰原生画布的抽屉与未提交草稿（原生画布随版本重挂载是既有行为）。
   */
  useEffect(() => {
    setNotice(null);
    setActionHint(null);
    setRefreshError(null);
    setConfirmDelete(null);
    setConfirmBranch(null);
    setConnectNode(null);
    setAdding(false);
    mutation.reset();
    // `mutation.reset` 每次渲染都是同一个函数（`useCallback []`）；只在版本变化时执行。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowId]);

  const runNodeAction = async (
    node: FlowNodeRow,
    task: () => Promise<unknown>,
    successText: string,
  ): Promise<void> => {
    setBusyId(node.id);
    setNotice(null);
    setActionHint(null);
    const result = await mutation.run(task);
    setBusyId(null);
    if (result !== null) {
      setNotice(successText);
      // 与原生画布的写成功回调走同一个合并刷新：两次触发只发一次 `flow_nodes:list`。
      requestReload();
      // 宿主发起的变更不会让原生画布自动 refresh，这里让它重新取一次数（不卸载宿主外层/抽屉）。
      setCanvasResync((value) => value + 1);
    }
  };

  /** 原生移动动作：`flow_nodes:move` 接收 `values.upstreamId` + `values.branchIndex`。 */
  const moveNodeTo = (nodeId: string, upstreamId: string | null, branchIndex: number | null) =>
    api.resourceAction('flow_nodes', 'move', {
      params: { filterByTk: nodeId },
      values: { upstreamId, branchIndex },
    });

  /**
   * 相邻交换（上移 / 下移）：落点由 `planAdjacentSwap` 按**真实结构**算出（主序列，
   * 或这一步所属的那条处理路径），只发**一次** `move`；落在处理路径首位时承接该路径的序号。
   *
   * 真正不可交换（路径首末步 / 跨路径 / malformed）时按钮已经禁用；
   * 这里再兜一层——拿不到计划就只给业务说明，绝不把 no-op 当成功提示。
   */
  const applyAdjacentMove = (node: FlowNodeRow, direction: MoveDirection) => {
    const plan = planAdjacentSwap(nodes, skeleton, node.id, direction);
    if (!plan) {
      setNotice(null);
      setActionHint('这个步骤不能移到所选位置。');
      return;
    }
    void runNodeAction(
      node,
      () => moveNodeTo(plan.nodeId, plan.upstreamId, plan.branchIndex),
      '已调整节点顺序。',
    );
  };

  /**
   * 复制节点。
   *
   * 真实 2.2.20 `flow_nodes:duplicate` 的位置**只**由 `values.upstreamId`/`values.branchIndex` 决定
   * （`server/actions/nodes.ts:172-198`）：只带 `filterByTk` 时服务端按 `upstreamId=null` 把副本
   * **插到流程最前**，原下游会被改接到副本上，链路看起来"只剩一个节点"。
   * 这里显式把副本放在被复制节点之后（`upstreamId = node.id`），与"复制节点"的语义一致，
   * 也让 `downstreamId` 单一、画布可从入口整条遍历。
   */
  const duplicate = (node: FlowNodeRow) =>
    runNodeAction(
      node,
      () =>
        api.resourceAction('flow_nodes', 'duplicate', {
          params: { filterByTk: node.id },
          values: { upstreamId: node.id, branchIndex: null },
        }),
      '已复制该节点。',
    );

  const removeNode = (node: FlowNodeRow) =>
    runNodeAction(
      node,
      () => api.resourceAction('flow_nodes', 'destroy', { params: { filterByTk: node.id } }),
      '已删除该节点。',
    );

  /**
   * 删除分支（真实契约见 `planBranchDelete` 的文档注释）。
   *
   * 只有确证支持的原生类型（当前是 `multi-conditions`）才发请求；调用方在渲染时已经按
   * 计划禁用不支持/只读的入口，这里再兜一层，绝不发"必然无效"的写。
   */
  const removeBranch = (node: FlowNodeRow) => {
    const plan = planBranchDelete(nodes, node);
    if (!plan.supported) {
      setNotice(null);
      setActionHint(`不能删除这个分支：${plan.reason}`);
      return;
    }
    void runNodeAction(
      node,
      async () => {
        await api.resourceAction('flow_nodes', 'destroyBranch', {
          params: { filterByTk: plan.upstreamId, branchIndex: plan.branchIndex, shift: 1 },
        });
        // 与原生 `multi-conditions` 的 `onRemoveConfirm` 一致：同步删掉 `config.conditions`
        // 里对应的条件，否则画布渲染的条件数会比真实分支数多。
        await api.resourceAction('flow_nodes', 'update', {
          params: { filterByTk: plan.upstreamId },
          values: { config: plan.nextConfig },
        });
      },
      '已删除该分支。',
    );
  };

  /** 改接上游：`flow_nodes:move` 直接把该节点接到另一个节点之后（或流程起点）。 */
  const reconnect = async () => {
    if (!connectNode) return;
    const target = connectNode;
    const upstreamId = connectUpstream === '' ? null : connectUpstream;
    setConnectNode(null);
    await runNodeAction(
      target,
      () => moveNodeTo(target.id, upstreamId, null),
      upstreamId ? '已更新该节点的前序连接。' : '已把该节点接到流程起点。',
    );
  };

  /**
   * 新增节点。
   *
   * `flow_nodes` **没有 create 动作**：原生新增走
   * `POST /api/workflows/<workflowId>/nodes:create`，就是 `associatedAction` 的形状。
   * 可选"接在某个节点之后"（`upstreamId`），否则作为分支挂在流程起点之后由服务端按原逻辑处理。
   */
  const addNode = async () => {
    setNotice(null);
    const option = nativeTypeOptions.find((item) => item.value === newNodeType);
    const spec = nodeTypeSpec(newNodeType);
    const values: Record<string, unknown> = {
      type: newNodeType,
      title: newNodeTitle.trim() || option?.label || spec?.label || humanizeType(newNodeType),
      // 新节点的初始 config：优先用**该类型源码** `createDefaultConfig()` 的真实初值
      // （原生 registry 提供），回退到本文件的类型初值，避免建出"空配置"节点。
      config: option?.defaultConfig ?? defaultConfigFor(newNodeType),
    };
    if (newNodeUpstream) values.upstreamId = newNodeUpstream;
    const result = await mutation.run(() =>
      associatedAction('workflows', workflowId, 'nodes', 'create', { values }),
    );
    if (result !== null) {
      setNotice(`已新增节点「${String(values.title)}」。`);
      setNewNodeTitle('');
      setAdding(false);
      requestReload();
      setCanvasResync((value) => value + 1);
    }
  };

  if (loading) {
    return (
      <PageCard title="流程编排">
        <p className={styles.mutedText}>正在读取流程与节点…</p>
      </PageCard>
    );
  }

  if (loadError || !workflow) {
    return (
      <div className={styles.stack}>
        <PageHeader title="流程编排" description="查看并调整流程的处理节点。" />
        <EmptyState tone="warn" title="暂时读不到流程编排" description={loadError ?? '没有找到这个流程。'} />
        <Link className={styles.secondaryButton} to="/workflow/list">
          返回流程列表
        </Link>
      </div>
    );
  }

  return (
    <div className={styles.stack}>
      <PageHeader
        title={`${workflow.title} · 流程编排`}
        description="按处理顺序展示该版本的节点。每一步都可以查看和修改配置；修改会立即保存。"
        meta={
          <div className={styles.tagRow}>
            {workflow.current ? <StatusPill tone="brand">当前生效版本</StatusPill> : <StatusPill tone="neutral">历史版本</StatusPill>}
            <StatusPill tone={workflow.enabled ? 'ok' : 'neutral'}>{workflow.enabled ? '已启用' : '已停用'}</StatusPill>
            <span className={styles.metaText}>触发方式：{triggerTypeLabel(workflow.type)}</span>
            <span className={styles.metaText}>节点 {nodes.length} 个</span>
          </div>
        }
        actions={
          <Link className={styles.secondaryButton} to="/workflow/list">
            返回列表
          </Link>
        }
      />

      <PageCard title="版本信息">
        <DefinitionRow term="版本标识">#{workflow.id}</DefinitionRow>
        {workflow.key ? <DefinitionRow term="流程标识">{workflow.key}</DefinitionRow> : null}
        <DefinitionRow term="本版本已执行">{executed} 次</DefinitionRow>
        <DefinitionRow term="更新时间">{formatDateTime(workflow.updatedAt) ?? '—'}</DefinitionRow>
        {executed > 0 ? (
          <p className={styles.warnText}>
            这个版本已经有执行记录。已执行版本的流程配置与节点不能再修改，相关操作会失败；需要调整时请在流程列表里"新建版本"。
          </p>
        ) : null}
      </PageCard>

      <PageCard
        title="新增节点"
        description="选择节点类型并填写标题即可创建；创建后可以继续在下面的画布里调整位置、连接和详细配置。"
        actions={
          <button
            type="button"
            className={styles.primaryButton}
            disabled={!writable}
            onClick={() => setAdding((value) => !value)}
          >
            添加节点
          </button>
        }
      >
        {executed > 0 ? (
          <p className={styles.cellHint}>该版本已执行，不能再新增节点；需要调整时请新建版本。</p>
        ) : adding ? (
          <div className={styles.formRow}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>节点类型</span>
              <select
                className={styles.select}
                value={newNodeType}
                onChange={(event) => setNewNodeType(event.target.value)}
              >
                {nativeTypeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>节点标题（可留空）</span>
              <input
                className={styles.input}
                value={newNodeTitle}
                onChange={(event) => setNewNodeTitle(event.target.value)}
                placeholder={humanizeType(newNodeType)}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>接在哪个节点之后</span>
              <select
                className={styles.select}
                value={newNodeUpstream}
                onChange={(event) => setNewNodeUpstream(event.target.value)}
              >
                <option value="">按默认规则处理（由系统决定位置）</option>
                {nodes.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.title ?? humanizeType(node.type)}
                  </option>
                ))}
              </select>
            </label>
            <div className={styles.formActions}>
              <button
                type="button"
                className={styles.primaryButton}
                disabled={!writable || mutation.isSubmitting}
                onClick={() => void addNode()}
              >
                确认添加
              </button>
              <button type="button" className={styles.secondaryButton} onClick={() => setAdding(false)}>
                取消
              </button>
            </div>
          </div>
        ) : (
          <p className={styles.cellHint}>
            这里的可选类型与上面画布实际能配置的类型一致。打开画布里的节点卡片可以逐项配置；保存后立即生效。
          </p>
        )}
      </PageCard>

      {NativeWorkflowCanvas ? (
        <Suspense
          fallback={
            <PageCard title="流程编排">
              <p className={styles.mutedText}>正在加载流程编排…</p>
            </PageCard>
          }
        >
          <NativeWorkflowCanvas
            workflowId={workflowId}
            onChanged={requestReload}
            resyncToken={canvasResync}
            onReady={(options) => {
              if (options.length > 0) setNativeTypeOptions(options);
            }}
            onVersionChange={(nextId) => {
              // 原生 header 切了版本：产品页的版本卡片与顺序列表跟着切到同一个版本。
              if (nextId && nextId !== workflowId) setParams({ workflowId: nextId }, { replace: true });
            }}
            onOpenList={() => navigate('/workflow/list')}
          />
        </Suspense>
      ) : null}

      <PageCard
        title="节点处理顺序"
        description="顺序由节点之间的前后连接决定。复制与删除是真实动作；调整顺序会改写相邻节点的前后连接。"
      >
        {ordered.length === 0 ? (
          <EmptyState
            title="这个版本还没有节点"
            description="流程刚创建时还没有节点。可以在上面的「新增节点」里选择类型创建第一个节点。"
          />
        ) : (
          <div className={styles.canvasList}>
            {ordered.map((node, index) => {
              const config = asRecord(node.config) ?? {};
              const preview = truncate(
                readString(config, 'expression') ??
                  readString(config, 'collection') ??
                  (Array.isArray(config.conditions) ? `${config.conditions.length} 条条件` : ''),
                60,
              );
              // 每一行动作的可行性都在渲染前算清：不可能成功的入口直接禁用，
              // 不留给用户"点了没有任何反应、还被当成功"的按钮。
              const upPlan = planAdjacentSwap(nodes, skeleton, node.id, 'up');
              const downPlan = planAdjacentSwap(nodes, skeleton, node.id, 'down');
              // 不在主序列上时，这一步所属的**处理路径**就是它的顺序清单（路径内相邻交换可用）。
              const context = pathContext(nodes, skeleton, node.id);
              const atPathStart = context ? context.index === 0 : false;
              const atPathEnd = context ? context.index === context.items.length - 1 : false;
              const startHint = context?.inBranch ? '它已经是这条处理路径的第一步了。' : '它已经是第一步了。';
              const endHint = context?.inBranch ? '它已经是这条处理路径的最后一步了。' : '它已经是最后一步了。';
              const branchPlan = node.branchIndex !== null ? planBranchDelete(nodes, node) : null;
              const moveUpTitle = !writable
                ? readOnlyHint
                : upPlan
                  ? '与上一步交换处理顺序'
                  : atPathStart
                    ? startHint
                    : unmovableStepHint;
              const moveDownTitle = !writable
                ? readOnlyHint
                : downPlan
                  ? '与下一步交换处理顺序'
                  : atPathEnd
                    ? endHint
                    : unmovableStepHint;
              return (
                <div key={node.id} className={styles.canvasNode}>
                  <div className={styles.canvasNodeIndex}>{index + 1}</div>
                  <div className={styles.canvasNodeBody}>
                    <div className={styles.canvasNodeHeader}>
                      <span className={styles.canvasNodeTitle}>{node.title ?? typeLabel(node.type)}</span>
                      <StatusPill
                        tone={
                          nodeTypeSpec(node.type) ||
                          EXTRA_TYPE_LABELS[node.type ?? ''] ||
                          nativeLabelByType.has(node.type ?? '')
                            ? 'neutral'
                            : 'warn'
                        }
                      >
                        {typeLabel(node.type)}
                      </StatusPill>
                      {node.branchIndex !== null ? (
                        <span className={styles.cellHint}>分支序号 {node.branchIndex}</span>
                      ) : null}
                    </div>
                    {preview ? <span className={styles.cellHint}>配置摘要：{preview}</span> : null}
                    {branchPlan && !branchPlan.supported ? (
                      <span className={styles.cellHint}>删除分支：{branchPlan.reason}</span>
                    ) : null}
                    <div className={styles.rowActions}>
                      <Link className={styles.linkButton} to={`/workflow/node?workflowId=${workflow.id}&nodeId=${node.id}`}>
                        配置
                      </Link>
                      <button
                        type="button"
                        className={styles.linkButton}
                        disabled={!writable || busyId === node.id || mutation.isSubmitting || !upPlan}
                        title={moveUpTitle}
                        onClick={() => applyAdjacentMove(node, 'up')}
                      >
                        上移
                      </button>
                      <button
                        type="button"
                        className={styles.linkButton}
                        disabled={!writable || busyId === node.id || mutation.isSubmitting || !downPlan}
                        title={moveDownTitle}
                        onClick={() => applyAdjacentMove(node, 'down')}
                      >
                        下移
                      </button>
                      <button
                        type="button"
                        className={styles.linkButton}
                        disabled={!writable || busyId === node.id || mutation.isSubmitting}
                        title={!writable ? readOnlyHint : undefined}
                        onClick={() => {
                          setConnectUpstream(node.upstreamId ?? '');
                          setConnectNode(node);
                        }}
                      >
                        改接前序
                      </button>
                      <button
                        type="button"
                        className={styles.linkButton}
                        disabled={!writable || busyId === node.id || mutation.isSubmitting}
                        title={!writable ? readOnlyHint : undefined}
                        onClick={() => void duplicate(node)}
                      >
                        复制节点
                      </button>
                      {node.branchIndex !== null ? (
                        <button
                          type="button"
                          className={styles.linkButton}
                          disabled={!writable || busyId === node.id || mutation.isSubmitting || !branchPlan?.supported}
                          title={
                            !writable
                              ? readOnlyHint
                              : branchPlan?.supported
                                ? '删除这条分支（会先确认）'
                                : branchPlan?.reason
                          }
                          onClick={() => {
                            if (branchPlan?.supported) setConfirmBranch(node);
                          }}
                        >
                          删除分支
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className={styles.dangerLinkButton}
                        disabled={!writable || busyId === node.id || mutation.isSubmitting}
                        title={!writable ? readOnlyHint : undefined}
                        onClick={() => setConfirmDelete(node)}
                      >
                        删除节点
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </PageCard>

      <PageCard title="节点自测" description="在画布里打开节点卡片，可以用「试运行」单独跑一次这个节点。">
        <p className={styles.cellHint}>
          支持试运行的节点，会在卡片的配置面板里显示「试运行」入口；它会按节点当前配置真实执行一次，
          因此请在使用真实数据前先确认配置与变量取值。试运行不影响流程本身，失败时会给出状态与日志。
        </p>
      </PageCard>

      {connectNode ? (
        <PageCard title={`改接「${connectNode.title ?? humanizeType(connectNode.type)}」的前序节点`} tone="muted">
          <p className={styles.bodyText}>
            选择这个节点应该接在哪个节点之后；选择"流程起点"表示它作为起始节点。
            系统会同时维护相邻节点的前后连接。
          </p>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>接到</span>
            <select className={styles.select} value={connectUpstream} onChange={(event) => setConnectUpstream(event.target.value)}>
              <option value="">流程起点</option>
              {nodes
                .filter((item) => item.id !== connectNode.id)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title ?? humanizeType(item.type)}
                  </option>
                ))}
            </select>
          </label>
          <div className={styles.formActions}>
            <button type="button" className={styles.primaryButton} disabled={!writable || mutation.isSubmitting} onClick={() => void reconnect()}>
              确认改接
            </button>
            <button type="button" className={styles.secondaryButton} onClick={() => setConnectNode(null)}>
              取消
            </button>
          </div>
        </PageCard>
      ) : null}

      {confirmDelete ? (
        <PageCard title={`删除节点「${confirmDelete.title ?? humanizeType(confirmDelete.type)}」`} tone="muted">
          <p className={styles.bodyText}>
            删除后该节点从流程中移除，它后面的节点会接到它的前序节点。删除无法撤销。
          </p>
          <div className={styles.formActions}>
            <button
              type="button"
              className={styles.dangerButton}
              disabled={!writable || mutation.isSubmitting}
              onClick={() => {
                const target = confirmDelete;
                setConfirmDelete(null);
                void removeNode(target);
              }}
            >
              确认删除
            </button>
            <button type="button" className={styles.secondaryButton} onClick={() => setConfirmDelete(null)}>
              取消
            </button>
          </div>
        </PageCard>
      ) : null}

      {confirmBranch ? (
        <PageCard title={`删除分支「${confirmBranch.title ?? humanizeType(confirmBranch.type)}」`} tone="muted">
          <p className={styles.bodyText}>
            删除后这条分支里的步骤会一起删除，其余分支保持不变。删除无法撤销。
          </p>
          <div className={styles.formActions}>
            <button
              type="button"
              className={styles.dangerButton}
              disabled={!writable || mutation.isSubmitting}
              onClick={() => {
                const target = confirmBranch;
                setConfirmBranch(null);
                void removeBranch(target);
              }}
            >
              确认删除
            </button>
            <button type="button" className={styles.secondaryButton} onClick={() => setConfirmBranch(null)}>
              取消
            </button>
          </div>
        </PageCard>
      ) : null}

      {notice ? <p className={styles.successText}>{notice}</p> : null}
      {actionHint ? <p className={styles.warnText}>{actionHint}</p> : null}
      {refreshError ? <p className={styles.errorText}>节点列表刷新失败：{refreshError}</p> : null}
      {mutation.message ? <p className={styles.errorText}>{mutation.message}</p> : null}
    </div>
  );
}

/** 供节点配置页复用的分支序号读取。 */
export function nodeBranchIndex(node: FlowNodeRow): number | null {
  return readNumber(asRecord(node.raw), 'branchIndex');
}
