import type { FlowNodeRow } from './domain';
import { asRecord } from './format';

/**
 * 「节点处理顺序」里各个动作的**纯决策**（组 C 独占，工作流模块内）。
 *
 * 这里只按真实 `flow_nodes` 契约判断「这个动作能不能安全成立、落点在哪里」，
 * 不发请求、不碰 React。页面按结果渲染按钮的 `disabled` 与确认面板，
 * 单元测试直接断言这些计划。
 *
 * 关键原则：**只按真实 2.2.20 的数据结构拒绝动作**，不因为本机 fixture 的表示能力
 * 而禁用真实后端允许的操作。所有用户可见的说明都在页面层，且是业务语言。
 *
 * 上移 / 下移在**同一条顺序清单**内做相邻交换：主序列上的相邻交换，以及某一条**处理路径内**
 * 的相邻交换（保留该路径挂靠的条件与序号）。只有真正跨路径、以及路径首末步才拒绝——
 * 见 `planAdjacentSwap` 的文档注释。
 */

/** 某个节点的直接下游（`upstreamId` 指向它的节点）。 */
export function childrenOf(nodes: FlowNodeRow[], parentId: string): FlowNodeRow[] {
  return nodes.filter((node) => node.upstreamId === parentId);
}

/**
 * 是否是**分支父节点**：有 `branchIndex != null` 的直接子节点。
 *
 * 真实 `flow_nodes` 里同一父节点既能挂分支头（`branchIndex` 有值），也能挂一个线性下游
 * （`branchIndex = null`）。分支头属于该节点的处理路径，不参与主序列的相邻交换。
 */
export function isBranchParent(nodes: FlowNodeRow[], node: FlowNodeRow): boolean {
  return childrenOf(nodes, node.id).some((child) => child.branchIndex !== null);
}

/** 某个节点的**线性子节点**（`branchIndex == null`）——真实 `downstreamId` 指向的那一个。 */
export function linearChildrenOf(nodes: FlowNodeRow[], parentId: string): FlowNodeRow[] {
  return childrenOf(nodes, parentId).filter((child) => child.branchIndex === null);
}

/**
 * 从某个「路径起点」出发，沿**唯一的线性子节点**展开的完整顺序。
 *
 * 真实服务端的 `downstreamId` 只在"唯一的 `branchIndex == null` 子节点"上维护
 * （`server/actions/nodes.ts` 的 `create`/`duplicate`/`move`），分支头（`branchIndex != null`）
 * 不进 `downstreamId`；原生画布 `canvas/Branch.tsx:68` 也是沿 `downstream` 渲染到分支之后的续行。
 *
 * 从**流程入口**出发得到的是主序列；从**某个分支头**出发得到的是那一条处理路径。
 */
export function linearChainFrom(nodes: FlowNodeRow[], head: FlowNodeRow | undefined): FlowNodeRow[] {
  const chain: FlowNodeRow[] = [];
  const seen = new Set<string>();
  for (let cursor: FlowNodeRow | undefined = head; cursor && !seen.has(String(cursor.id)); ) {
    seen.add(String(cursor.id));
    chain.push(cursor);
    const linear = linearChildrenOf(nodes, cursor.id);
    cursor = linear.length === 1 ? linear[0] : undefined;
  }
  return chain;
}

/**
 * 主序列（真实执行顺序的主干）：从入口开始，每次走**唯一的线性子节点**。
 *
 * 分支头（`branchIndex != null`）及其子树不在主序列上：它们属于某条处理路径。
 * 只读 `upstreamId`（产品本来就依赖的字段），不依赖 `downstreamId` 是否随读接口返回。
 */
export function linearSkeleton(nodes: FlowNodeRow[]): FlowNodeRow[] {
  const byId = new Map(nodes.map((node) => [String(node.id), node]));
  const heads = nodes.filter((node) => !node.upstreamId || !byId.has(String(node.upstreamId)));
  // 入口是主序列上没有上游的那一个；malformed 数据里退化为第一个无上游节点。
  const head = heads.find((node) => node.branchIndex === null) ?? heads[0];
  return linearChainFrom(nodes, head);
}

/** 某一步所在的顺序清单：主序列，或者它所属的那一条处理路径。 */
export interface PathContext {
  /** 这一步所在清单的完整顺序。 */
  items: FlowNodeRow[];
  /** 这一步在其中的位置。 */
  index: number;
  /** `true` = 某条处理路径（分支头及其线性续行）；`false` = 主序列。 */
  inBranch: boolean;
}

/**
 * 找到某一步所在的**顺序清单**（主序列，或它所属的那条处理路径）与它在其中的位置。
 *
 * 处理路径 = 从分支头（`branchIndex != null`）沿唯一线性子节点展开的链，也就是真实画布里
 * 一条处理路径的渲染顺序。判定方法只读 `upstreamId` / `branchIndex`：
 * 从这一步向上走，最近的一个"分支头祖先"就是这条路径的起点；若一路走到没有上游的入口，
 * 它就是主序列上的一步。
 *
 * 返回 `null` 只在数据畸形、这一步接不到任何已知顺序上时（调用方据此禁用按钮）。
 */
export function pathContext(
  nodes: FlowNodeRow[],
  skeleton: FlowNodeRow[],
  nodeId: string,
): PathContext | null {
  const index = skeleton.findIndex((item) => item.id === nodeId);
  if (index >= 0) return { items: skeleton, index, inBranch: false };
  const byId = new Map(nodes.map((node) => [String(node.id), node]));
  let cursor = byId.get(String(nodeId));
  if (!cursor) return null;
  const guard = new Set<string>();
  while (cursor.branchIndex === null && cursor.upstreamId && !guard.has(String(cursor.id))) {
    guard.add(String(cursor.id));
    const parent = byId.get(String(cursor.upstreamId));
    if (!parent) break;
    cursor = parent;
  }
  if (cursor.branchIndex === null) return null;
  const items = linearChainFrom(nodes, cursor);
  const at = items.findIndex((item) => item.id === nodeId);
  if (at < 0) return null;
  return { items, index: at, inBranch: true };
}

export type MoveDirection = 'up' | 'down';

export interface NodeMovePlan {
  /** 真正被 `flow_nodes:move` 移动的节点（相邻两步里靠后的那一个）。 */
  nodeId: string;
  /** 目标位置：移动后紧跟在这个节点之后（`null` = 流程起点）。 */
  upstreamId: string | null;
  /**
   * 目标位置的路径序号。相邻两步里靠前的那一步是**处理路径首位**时，
   * 后一步承接它的 `branchIndex`（这一步就落进同一条处理路径的首位）；
   * 主序列与路径内部都是 `null`。
   */
  branchIndex: number | null;
  /** 与它互换位置的相邻步骤（证据用）。 */
  neighborId: string;
}

/**
 * 「上移 / 下移」= 在**同一条顺序清单**里与相邻步骤交换一次位置。
 *
 * 清单有两种，都是真实结构：
 *  1. **主序列**（`linearSkeleton`，入口沿线性子节点）；
 *  2. 某一步所属的**处理路径**（`pathContext`，分支头沿线性子节点）。
 * 两者都只读 `upstreamId` / `branchIndex`，不依赖读接口是否回传 `downstreamId`。
 *
 * 只发**一次** `flow_nodes:move`：总是把相邻两步里**靠后**的那一步移到靠前那一步的位置，
 * 用 `upstreamId` + `branchIndex` 表达落点。真实 `move`（固定源码
 * `packages/plugins/@nocobase/plugin-workflow/src/server/actions/nodes.ts` 的 `move`，
 * 本机 fixture 的 `flow_nodes:move` 逐支对齐）会先把该节点从旧位置摘出来、把它的旧下游
 * 接回旧上游，再插到目标位置——正好等于相邻交换，**路径归属与其它路径都不受影响**：
 *
 *  - 靠前那一步在路径内部（`branchIndex == null`）→ 落点 `{ upstreamId: 前一步的 upstreamId,
 *    branchIndex: null }`，就是插回前一步原来的位置；
 *  - 靠前那一步是**处理路径首位**（`branchIndex != null`，挂在上一步下的分支头）→ 落点
 *    `{ upstreamId: 前一步的 upstreamId, branchIndex: 前一步的 branchIndex }`：真实 `move`
 *    会把该序号上原来的分支头改成新节点的下游，于是新节点接管这个序号，
 *    这条路径的序号与它挂靠的条件都不变。**跨路径换位不会发生**，因为交换只在同一条清单内。
 *
 * 返回 `null` 只有**真实结构**原因：这一步是所在清单的第一步（上移）/ 最后一步（下移），
 * 或者数据畸形（相邻两步没有父子关系、同一父节点有多个线性子节点）。
 * 调用方据此禁用按钮，不允许「点了没反应却当成功」。
 */
export function planAdjacentSwap(
  nodes: FlowNodeRow[],
  skeleton: FlowNodeRow[],
  nodeId: string,
  direction: MoveDirection,
): NodeMovePlan | null {
  const context = pathContext(nodes, skeleton, nodeId);
  if (!context) return null;
  const { items, index } = context;
  const neighborIndex = direction === 'up' ? index - 1 : index + 1;
  if (neighborIndex < 0 || neighborIndex >= items.length) return null;
  const node = items[index];
  const neighbor = items[neighborIndex];
  const earlier = direction === 'up' ? neighbor : node;
  const later = direction === 'up' ? node : neighbor;
  // 相邻两步必然是"父 / 线性子"关系；再核对一次，防住 malformed 数据。
  if (later.branchIndex !== null) return null;
  if (later.upstreamId !== earlier.id) return null;
  if (linearChildrenOf(nodes, earlier.id).length !== 1) return null;
  return {
    nodeId: later.id,
    upstreamId: earlier.upstreamId,
    branchIndex: earlier.branchIndex,
    neighborId: neighbor.id,
  };
}

export type BranchDeletePlan =
  | {
      supported: true;
      /** `filterByTk`：该处理路径挂靠的**上一步**（真实 `destroyBranch` 的入参，不是路径首节点自己）。 */
      upstreamId: string;
      /** 该处理路径在该上一步下的序号。 */
      branchIndex: number;
      /** 删除后要写回的完整配置（真实 `flow_nodes:update` 是整体替换语义）。 */
      nextConfig: Record<string, unknown>;
    }
  | { supported: false; reason: string };

/**
 * 「删除处理路径」的真实契约（逐条核对固定 2.2.22 源码，不猜）：
 *
 *  - 只有 `multi-conditions` 的原生画布提供路径删除
 *    （`client-v2/nodes/components/multi-conditions.tsx` 的 `onRemoveConfirm`，是固定源码里
 *    **唯一**调用 `flow_nodes:destroyBranch` 的地方）；条件是 `conditions.length > 1`，
 *    并且先弹原生二次确认（`Delete` / `Are you sure you want to delete it?`）。
 *  - 它的路径序号是 **0 = Otherwise（否则）+ 1..N = conditions[i-1]**
 *    （`multiConditionsShared.ts:13-14` 与 `multi-conditions.tsx:348`）。删除第 i 条是
 *    `destroyBranch({ filterByTk: 上一步 id, branchIndex: i, shift: 1 })`，**并且**把
 *    `config.conditions` 里对应项删掉——两步都做，否则画布与配置不一致。
 *  - `condition` 的路径含义**固定**（0=否 / 1=是，`condition.tsx:28-30`），原生没有删除入口；
 *    带 `shift=1` 删除会把剩下的路径改号（"是"变成"否"），正是 Main 报的问题。
 *  - `parallel` 画布上的"删除路径"只改本地未持久化的临时槽位，`loop` 只有一条固定路径
 *    （两者都不调用 `destroyBranch`，见 `plugin-workflow-parallel/.../parallel.tsx:130-160`、
 *    `plugin-workflow-loop/.../loop.tsx:265-278`）。
 *
 * 因此：只支持确证的 `multi-conditions`，其余类型明确说明不支持，不改变剩余路径含义。
 *
 * 注意：能删什么由**上游节点的类型**决定——路径首节点自己可以是任意节点类型
 * （Main 现场里条件的"是 / 否"路径首节点就是流程输出节点）。
 *
 * `reason` 是**用户可见**的说明，只写业务语言，不出现类型名、序号、原生术语。
 */
export function planBranchDelete(nodes: FlowNodeRow[], node: FlowNodeRow): BranchDeletePlan {
  if (node.branchIndex === null) return { supported: false, reason: '这个步骤不属于任何处理路径。' };
  const upstreamId = node.upstreamId;
  if (!upstreamId) return { supported: false, reason: '这个步骤没有可挂靠的上一步，不能删除路径。' };
  const parent = nodes.find((item) => item.id === upstreamId);
  if (!parent) return { supported: false, reason: '找不到这个步骤挂靠的上一步，暂时不能删除路径。' };
  if (parent.type !== 'multi-conditions') {
    if (parent.type === 'condition') {
      return {
        supported: false,
        reason: '该条件的“否 / 是”两条处理路径需要保留；可以删除路径内的步骤。',
      };
    }
    return { supported: false, reason: '这个步骤的处理路径需要保留；可以删除路径内的步骤。' };
  }
  const branchIndex = node.branchIndex;
  if (branchIndex < 1) return { supported: false, reason: '“否则”这条处理路径需要保留。' };
  const config = asRecord(parent.config);
  const conditions = config && Array.isArray(config.conditions) ? config.conditions : null;
  if (!conditions) return { supported: false, reason: '暂时读不到这个步骤的处理路径设置，不能删除。' };
  if (conditions.length <= 1) return { supported: false, reason: '至少要保留一条条件路径。' };
  if (branchIndex > conditions.length) {
    return { supported: false, reason: '这条处理路径的位置已经变化，请刷新后再试。' };
  }
  const nextConditions = conditions.filter((_, index) => index !== branchIndex - 1);
  return {
    supported: true,
    upstreamId,
    branchIndex,
    nextConfig: { ...(config ?? {}), conditions: nextConditions },
  };
}
