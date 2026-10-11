import { describe, expect, it } from 'vitest';
import type { FlowNodeRow } from '../../../src/modules/workflow/domain';
import {
  childrenOf,
  isBranchParent,
  linearChildrenOf,
  linearSkeleton,
  pathContext,
  planAdjacentSwap,
  planBranchDelete,
} from '../../../src/modules/workflow/nodeActions';

/**
 * 「节点处理顺序」动作的纯决策单测。
 *
 * 固定的是**真实 `flow_nodes` 契约**，不是页面实现细节：
 *  - 主序列 = 每次走唯一线性子节点的那条链（与真实 `downstreamId` 语义一致）；
 *  - 上移/下移是主序列上相邻两步的一次真实交换，落点由 `move` 的 `upstreamId` 表达；
 *  - **分支父节点**（条件等）只要在主序列上就能整体交换，分支归属与续行保持；
 *    只有"不在主序列上"（分支内的步骤）或首末步才拒绝——不因本机 fixture 的表示能力拒绝；
 *  - 删除处理路径只对原生确证支持的 `multi-conditions` 开放，且说明是业务语言。
 */

function node(partial: Partial<FlowNodeRow> & { id: string }): FlowNodeRow {
  return {
    key: `key-${partial.id}`,
    title: null,
    type: 'calculation',
    upstreamId: null,
    downstreamId: null,
    branchIndex: null,
    config: {},
    raw: {},
    ...partial,
  };
}

/**
 * Main 现场的链形：计算 → JavaScript → 条件判断（否 / 是 两分支，条件**没有**线性续行）。
 * `ordered`（展示顺序）= 父节点、再按 branchIndex 展开各分支。
 */
function mainScene() {
  const calc = node({ id: '910743', title: '准备参数', type: 'calculation', upstreamId: null, downstreamId: '910774' });
  const script = node({ id: '910774', title: '检查脚本', type: 'script', upstreamId: '910743', downstreamId: '910744' });
  const condition = node({ id: '910744', title: '是否需要处理', type: 'condition', upstreamId: '910774', config: {} });
  const onFalse = node({
    id: '910745',
    title: '处理结果',
    type: 'output',
    upstreamId: '910744',
    branchIndex: 0,
  });
  const onTrue = node({
    id: '910746',
    title: '跳过处理',
    type: 'output',
    upstreamId: '910744',
    branchIndex: 1,
  });
  const nodes = [calc, script, condition, onFalse, onTrue];
  const ordered = [calc, script, condition, onFalse, onTrue];
  return { calc, script, condition, onFalse, onTrue, nodes, ordered, skeleton: linearSkeleton(nodes) };
}

/**
 * 真实 2.2.20 允许、早期 fixture 无法表达的图：条件**同时**有两条分支头和一条线性续行。
 * `开始 → 准备 → 条件(否 / 是) → 合并 → 收尾`，`downstreamId` 指向「合并」。
 */
function branchFlowScene() {
  const boot = node({ id: 'b0', title: '开始', upstreamId: null, downstreamId: 'b1' });
  const prepare = node({ id: 'b1', title: '准备', upstreamId: 'b0', downstreamId: 'c0' });
  const condition = node({
    id: 'c0',
    title: '是否需要处理',
    type: 'condition',
    upstreamId: 'b1',
    downstreamId: 'm0',
    config: { engine: 'basic' },
  });
  const onFalse = node({ id: 'n0', title: '否侧处理', type: 'output', upstreamId: 'c0', branchIndex: 0 });
  const onTrue = node({ id: 'y0', title: '是侧处理', type: 'output', upstreamId: 'c0', branchIndex: 1 });
  const merge = node({ id: 'm0', title: '合并', type: 'output', upstreamId: 'c0', downstreamId: 't0' });
  const tail = node({ id: 't0', title: '收尾', type: 'output', upstreamId: 'm0' });
  const nodes = [boot, prepare, condition, onFalse, onTrue, merge, tail];
  return { boot, prepare, condition, onFalse, onTrue, merge, tail, nodes, skeleton: linearSkeleton(nodes) };
}

/**
 * Main 现场 000005 的结构：入口 → 多条件（3 路）→ **每条路径各有两个串行步骤**（处理 → 收尾）。
 * 这正是 Main 报的"路径内上移/下移全被禁用，但目标是同一路径内相邻交换"的样本。
 */
function wideBranchScene() {
  const entry = node({ id: 'w0', title: '入口', upstreamId: null, downstreamId: 'wb' });
  const branch = node({
    id: 'wb',
    title: '三路分支',
    type: 'multi-conditions',
    upstreamId: 'w0',
    config: {
      conditions: [
        { uid: 'left', title: '左' },
        { uid: 'middle', title: '中' },
        { uid: 'right', title: '右' },
      ],
    },
  });
  const make = (label: string, branchIndex: number) => {
    const head = node({
      id: `${label}1`,
      title: `${label}路处理`,
      type: 'output',
      upstreamId: 'wb',
      downstreamId: `${label}2`,
      branchIndex,
    });
    const tail = node({ id: `${label}2`, title: `${label}路收尾`, type: 'output', upstreamId: `${label}1` });
    return [head, tail];
  };
  const [leftHead, leftTail] = make('l', 1);
  const [midHead, midTail] = make('m', 2);
  const [rightHead, rightTail] = make('r', 3);
  const nodes = [entry, branch, leftHead, leftTail, midHead, midTail, rightHead, rightTail];
  return {
    entry,
    branch,
    leftHead,
    leftTail,
    midHead,
    midTail,
    rightHead,
    rightTail,
    nodes,
    skeleton: linearSkeleton(nodes),
  };
}

describe('childrenOf / 线性子节点 / 分支结构判读', () => {
  it('linearChildrenOf 只取 branchIndex == null 的子节点（真实 downstreamId 指向的那一个）', () => {
    const { nodes, condition, calc, script } = mainScene();
    expect(childrenOf(nodes, condition.id).map((item) => item.id)).toEqual(['910745', '910746']);
    expect(linearChildrenOf(nodes, condition.id)).toEqual([]);
    expect(linearChildrenOf(nodes, calc.id).map((item) => item.id)).toEqual([script.id]);
    expect(isBranchParent(nodes, condition)).toBe(true);
    expect(isBranchParent(nodes, calc)).toBe(false);
  });

  it('分支父节点带线性续行：linearChildrenOf 能找到续行（真实图上不是"没有子节点"）', () => {
    const { nodes, condition, merge } = branchFlowScene();
    expect(linearChildrenOf(nodes, condition.id).map((item) => item.id)).toEqual([merge.id]);
    expect(isBranchParent(nodes, condition)).toBe(true);
  });
});

describe('linearSkeleton：真实主序列', () => {
  it('分支没有续行时，主序列在分支父节点处结束（分支头不在主序列上）', () => {
    const { skeleton } = mainScene();
    expect(skeleton.map((item) => item.id)).toEqual(['910743', '910774', '910744']);
  });

  it('分支父节点带续行时，主序列穿过分支父节点接到续行与收尾', () => {
    const { skeleton } = branchFlowScene();
    expect(skeleton.map((item) => item.id)).toEqual(['b0', 'b1', 'c0', 'm0', 't0']);
  });
});

describe('planAdjacentSwap：同一条顺序清单内相邻两步的真实交换', () => {
  it('Main 场景 1：第 2 行上移 = 把它移到流程起点（一次 move，upstreamId=null）', () => {
    const { nodes, skeleton, script, calc } = mainScene();
    expect(planAdjacentSwap(nodes, skeleton, script.id, 'up')).toEqual({
      nodeId: '910774',
      upstreamId: null,
      branchIndex: null,
      neighborId: '910743',
    });
    expect(planAdjacentSwap(nodes, skeleton, calc.id, 'down')).toEqual({
      nodeId: '910774',
      upstreamId: null,
      branchIndex: null,
      neighborId: '910774',
    });
  });

  it('Main 场景 2：首项下移 = 把它换回计算节点之后（一次 move）', () => {
    const { script, calc, condition, onFalse, onTrue } = mainScene();
    const afterMove = [
      node({ ...script, upstreamId: null, downstreamId: calc.id }),
      node({ ...calc, upstreamId: script.id, downstreamId: condition.id }),
      node({ ...condition, upstreamId: calc.id }),
      onFalse,
      onTrue,
    ];
    const skeleton = linearSkeleton(afterMove);
    expect(skeleton.map((item) => item.id)).toEqual(['910774', '910743', '910744']);
    expect(planAdjacentSwap(afterMove, skeleton, script.id, 'down')).toEqual({
      nodeId: '910743',
      upstreamId: null,
      branchIndex: null,
      neighborId: '910743',
    });
  });

  it('**分支父节点整体交换**：条件带两条分支 + 线性续行时，上移是真实可表达的动作', () => {
    const { nodes, skeleton, boot, prepare, condition } = branchFlowScene();
    // 上移条件：把它换到「准备」前面（落点 = 准备的 upstreamId = 开始）。
    expect(planAdjacentSwap(nodes, skeleton, condition.id, 'up')).toEqual({
      nodeId: 'c0',
      upstreamId: 'b0',
      branchIndex: null,
      neighborId: 'b1',
    });
    // 同一对相邻步骤从「准备」点下移，产生同一个交换计划。
    expect(planAdjacentSwap(nodes, skeleton, prepare.id, 'down')).toEqual({
      nodeId: 'c0',
      upstreamId: 'b0',
      branchIndex: null,
      neighborId: 'c0',
    });
    expect(boot.id).toBe('b0');
  });

  it('**分支父节点带续行的往返**：交换后主序列仍相邻，可以换回来', () => {
    const { boot, prepare, condition, onFalse, onTrue, merge, tail } = branchFlowScene();
    // 模拟真实 move(condition, prepare.upstreamId = boot) 的重连结果：
    //   boot → condition → prepare → merge → tail，分支头仍挂在 condition 上。
    const afterSwap = [
      node({ ...boot, upstreamId: null, downstreamId: condition.id }),
      node({ ...prepare, upstreamId: condition.id, downstreamId: merge.id }),
      node({ ...condition, upstreamId: boot.id, downstreamId: prepare.id }),
      onFalse,
      onTrue,
      node({ ...merge, upstreamId: prepare.id, downstreamId: tail.id }),
      tail,
    ];
    const skeleton = linearSkeleton(afterSwap);
    expect(skeleton.map((item) => item.id)).toEqual(['b0', 'c0', 'b1', 'm0', 't0']);
    // 分支归属与"否 / 是"含义在交换后不变。
    expect(onFalse.upstreamId).toBe('c0');
    expect(onFalse.branchIndex).toBe(0);
    expect(onTrue.upstreamId).toBe('c0');
    expect(onTrue.branchIndex).toBe(1);
    // 下移条件（= 把「准备」换回它前面）→ 与上一步的交换互逆。
    expect(planAdjacentSwap(afterSwap, skeleton, condition.id, 'down')).toEqual({
      nodeId: 'b1',
      upstreamId: 'b0',
      branchIndex: null,
      neighborId: 'b1',
    });
  });

  it('分支**没有**续行时，分支父节点同样可以整体与上一步交换（不再因 fixture 能力被禁用）', () => {
    const { nodes, skeleton, condition } = mainScene();
    expect(planAdjacentSwap(nodes, skeleton, condition.id, 'up')).toEqual({
      nodeId: '910744',
      upstreamId: '910743',
      branchIndex: null,
      neighborId: '910774',
    });
  });

  it('首/末步返回 null（按钮据此禁用，不产生 no-op）', () => {
    const { nodes, skeleton, calc } = mainScene();
    expect(planAdjacentSwap(nodes, skeleton, calc.id, 'up')).toBeNull();
    const branchFlow = branchFlowScene();
    expect(planAdjacentSwap(branchFlow.nodes, branchFlow.skeleton, branchFlow.boot.id, 'up')).toBeNull();
    expect(planAdjacentSwap(branchFlow.nodes, branchFlow.skeleton, branchFlow.tail.id, 'down')).toBeNull();
  });

  it('普通线性链：中间步骤上移/下移都给出真实落点', () => {
    const a = node({ id: 'a', upstreamId: null, downstreamId: 'b' });
    const b = node({ id: 'b', upstreamId: 'a', downstreamId: 'c' });
    const c = node({ id: 'c', upstreamId: 'b' });
    const nodes = [a, b, c];
    const skeleton = linearSkeleton(nodes);
    expect(planAdjacentSwap(nodes, skeleton, 'c', 'up')).toEqual({
      nodeId: 'c',
      upstreamId: 'a',
      branchIndex: null,
      neighborId: 'b',
    });
    expect(planAdjacentSwap(nodes, skeleton, 'a', 'down')).toEqual({
      nodeId: 'b',
      upstreamId: null,
      branchIndex: null,
      neighborId: 'b',
    });
    expect(planAdjacentSwap(nodes, skeleton, 'b', 'up')).toEqual({
      nodeId: 'b',
      upstreamId: null,
      branchIndex: null,
      neighborId: 'a',
    });
    expect(planAdjacentSwap(nodes, skeleton, 'b', 'down')).toEqual({
      nodeId: 'c',
      upstreamId: 'a',
      branchIndex: null,
      neighborId: 'c',
    });
  });
});

describe('planAdjacentSwap：处理路径内的相邻交换（Main 000005 的窄边界）', () => {
  it('pathContext 把分支内的步骤接到它所属的那条处理路径（不是主序列）', () => {
    const { nodes, skeleton, midHead, midTail, branch, entry } = wideBranchScene();
    expect(skeleton.map((item) => item.id)).toEqual(['w0', 'wb']);
    const headCtx = pathContext(nodes, skeleton, midHead.id);
    expect(headCtx).toEqual({ items: [midHead, midTail], index: 0, inBranch: true });
    const tailCtx = pathContext(nodes, skeleton, midTail.id);
    expect(tailCtx?.index).toBe(1);
    expect(tailCtx?.inBranch).toBe(true);
    expect(pathContext(nodes, skeleton, entry.id)?.inBranch).toBe(false);
    expect(pathContext(nodes, skeleton, branch.id)?.inBranch).toBe(false);
  });

  it('中路第二步「上移」= 落到同一条路径首位并承接该路径序号（一条 move，落点带 branchIndex）', () => {
    const { nodes, skeleton, branch, midHead, midTail } = wideBranchScene();
    expect(planAdjacentSwap(nodes, skeleton, midTail.id, 'up')).toEqual({
      nodeId: midTail.id,
      upstreamId: branch.id,
      branchIndex: 2,
      neighborId: midHead.id,
    });
    // 同一次交换从中路第一步点「下移」，产生同一个计划。
    expect(planAdjacentSwap(nodes, skeleton, midHead.id, 'down')).toEqual({
      nodeId: midTail.id,
      upstreamId: branch.id,
      branchIndex: 2,
      neighborId: midTail.id,
    });
  });

  it('路径首步不能上移出路径、尾步不能下移出路径（按钮据此禁用）', () => {
    const { nodes, skeleton, midHead, midTail, leftHead, leftTail, rightHead, rightTail } = wideBranchScene();
    expect(planAdjacentSwap(nodes, skeleton, midHead.id, 'up')).toBeNull();
    expect(planAdjacentSwap(nodes, skeleton, midTail.id, 'down')).toBeNull();
    for (const [head, tail] of [
      [leftHead, leftTail],
      [rightHead, rightTail],
    ]) {
      expect(planAdjacentSwap(nodes, skeleton, head.id, 'up')).toBeNull();
      expect(planAdjacentSwap(nodes, skeleton, tail.id, 'down')).toBeNull();
    }
  });

  it('中路交换后：路径标题归属与序号不变、左右路径与主序列都不受影响；再下移即可恢复', () => {
    const { entry, branch, leftHead, leftTail, midHead, midTail, rightHead, rightTail } = wideBranchScene();
    // 模拟真实 move(midTail, { upstreamId: branch.id, branchIndex: 2 }) 的重连结果：
    //   midTail 接管路径 2 的首位，midHead 变成它的线性续行；左右两路原样。
    const afterSwap = [
      entry,
      branch,
      leftHead,
      leftTail,
      node({ ...midTail, upstreamId: branch.id, branchIndex: 2, downstreamId: midHead.id }),
      node({ ...midHead, upstreamId: midTail.id, branchIndex: null, downstreamId: null }),
      rightHead,
      rightTail,
    ];
    const skeleton = linearSkeleton(afterSwap);
    expect(skeleton.map((item) => item.id)).toEqual(['w0', 'wb']);
    // 中路仍是一条完整路径，且这一步（收尾）现在在首位。
    expect(pathContext(afterSwap, skeleton, midTail.id)).toEqual({
      items: [afterSwap[4], afterSwap[5]],
      index: 0,
      inBranch: true,
    });
    // 路径序号没变、挂靠的条件没变；左右两路完全没动。
    expect(afterSwap[4].branchIndex).toBe(2);
    expect(afterSwap[4].upstreamId).toBe(branch.id);
    expect(afterSwap[5].branchIndex).toBeNull();
    expect(leftHead.upstreamId).toBe(branch.id);
    expect(leftHead.branchIndex).toBe(1);
    expect(leftTail.upstreamId).toBe(leftHead.id);
    expect(rightHead.upstreamId).toBe(branch.id);
    expect(rightHead.branchIndex).toBe(3);
    expect(rightTail.upstreamId).toBe(rightHead.id);
    // 「下移」这一步 = 把原来的第一步换回首位 → 与上一步的交换互逆（同一个落点）。
    expect(planAdjacentSwap(afterSwap, skeleton, midTail.id, 'down')).toEqual({
      nodeId: midHead.id,
      upstreamId: branch.id,
      branchIndex: 2,
      neighborId: midHead.id,
    });
  });

  it('路径内部的相邻交换（不是首位）：落点是前一步原来的位置，branchIndex 保持 null', () => {
    const { nodes, branch, midHead, midTail } = wideBranchScene();
    const extra = node({ id: 'm3', title: '中路第三', type: 'output', upstreamId: midTail.id });
    const withExtra = nodes.map((item) => (item.id === midTail.id ? node({ ...midTail, downstreamId: extra.id }) : item));
    withExtra.push(extra);
    const skeleton2 = linearSkeleton(withExtra);
    const ctx = pathContext(withExtra, skeleton2, extra.id);
    expect(ctx?.items.map((item) => item.id)).toEqual(['m1', 'm2', 'm3']);
    expect(planAdjacentSwap(withExtra, skeleton2, extra.id, 'up')).toEqual({
      nodeId: 'm3',
      upstreamId: 'm1',
      branchIndex: null,
      neighborId: 'm2',
    });
    expect(planAdjacentSwap(withExtra, skeleton2, midTail.id, 'down')).toEqual({
      nodeId: 'm3',
      upstreamId: 'm1',
      branchIndex: null,
      neighborId: 'm3',
    });
    expect(branch.id).toBe('wb');
    expect(midHead.id).toBe('m1');
  });

  it('嵌套分支按结构判定：外层路径内的步骤可交换，内层分支头是它自己路径的首步', () => {
    // 外层路径 1：outerHead(分支头) → nested(条件, 带内层两条路径) → outerTail。
    const parent = node({ id: 'p0', title: '入口', upstreamId: null, downstreamId: 'h1' });
    const outerHead = node({ id: 'h1', title: '外层处理', type: 'output', upstreamId: 'p0', downstreamId: 'nd', branchIndex: 1 });
    const nested = node({ id: 'nd', title: '内层条件', type: 'condition', upstreamId: 'h1', downstreamId: 'ot', config: {} });
    const innerA = node({ id: 'ia', title: '内层否', type: 'output', upstreamId: 'nd', branchIndex: 0 });
    const innerB = node({ id: 'ib', title: '内层是', type: 'output', upstreamId: 'nd', branchIndex: 1 });
    const outerTail = node({ id: 'ot', title: '外层收尾', type: 'output', upstreamId: 'nd' });
    const nodes = [parent, outerHead, nested, innerA, innerB, outerTail];
    const skeleton = linearSkeleton(nodes);
    // 外层路径 = 外层处理 → 内层条件 → 外层收尾（沿唯一线性子节点）。
    expect(pathContext(nodes, skeleton, nested.id)).toEqual({
      items: [outerHead, nested, outerTail],
      index: 1,
      inBranch: true,
    });
    // 内层分支头是它自己那条路径的首步，不能上移出路径。
    expect(pathContext(nodes, skeleton, innerA.id)).toEqual({ items: [innerA], index: 0, inBranch: true });
    expect(planAdjacentSwap(nodes, skeleton, innerA.id, 'up')).toBeNull();
    expect(planAdjacentSwap(nodes, skeleton, innerA.id, 'down')).toBeNull();
    // 外层路径内部照常可交换：把「外层收尾」换到「内层条件」前面（落点 = 前一步原位置）。
    expect(planAdjacentSwap(nodes, skeleton, outerTail.id, 'up')).toEqual({
      nodeId: 'ot',
      upstreamId: 'h1',
      branchIndex: null,
      neighborId: 'nd',
    });
    // 外层路径首位（＝分支头）不能上移出路径；但可以下移（与内层条件交换）。
    expect(planAdjacentSwap(nodes, skeleton, outerHead.id, 'up')).toBeNull();
    expect(planAdjacentSwap(nodes, skeleton, outerHead.id, 'down')).toEqual({
      nodeId: 'nd',
      upstreamId: 'p0',
      branchIndex: 1,
      neighborId: 'nd',
    });
    // 内层两条路径挂靠的条件与序号都没被这些判定改写。
    expect(innerA.upstreamId).toBe('nd');
    expect(innerA.branchIndex).toBe(0);
    expect(innerB.branchIndex).toBe(1);
  });
});

describe('planBranchDelete：只支持确证类型，说明全部是业务语言', () => {
  const INTERNAL_TERMS = ['branchIndex', 'shift', 'downstream', 'multi-conditions', '原生', '上游节点', 'type'];

  it('condition 的路径不提供删除，理由是业务语言（否 / 是固定）', () => {
    const { nodes, onFalse, onTrue } = mainScene();
    const planFalse = planBranchDelete(nodes, onFalse);
    const planTrue = planBranchDelete(nodes, onTrue);
    expect(planFalse.supported).toBe(false);
    expect(planTrue.supported).toBe(false);
    if (!planFalse.supported) {
      expect(planFalse.reason).toContain('两条处理路径需要保留');
      for (const term of INTERNAL_TERMS) expect(planFalse.reason).not.toContain(term);
    }
  });

  it('multi-conditions：删除第 1 条条件路径 → 上一步 + branchIndex=1 + shift，并同步 config.conditions', () => {
    const parent = node({
      id: 'p',
      title: '多条件',
      type: 'multi-conditions',
      upstreamId: null,
      config: {
        conditions: [
          { uid: 'c1', title: '左' },
          { uid: 'c2', title: '中' },
          { uid: 'c3', title: '右' },
        ],
      },
    });
    const first = node({ id: 'h1', type: 'output', upstreamId: 'p', branchIndex: 1 });
    const otherwise = node({ id: 'h0', type: 'output', upstreamId: 'p', branchIndex: 0 });
    const nodes = [parent, first, otherwise];
    const plan = planBranchDelete(nodes, first);
    expect(plan.supported).toBe(true);
    if (plan.supported) {
      expect(plan.upstreamId).toBe('p');
      expect(plan.branchIndex).toBe(1);
      expect(plan.nextConfig.conditions).toEqual([
        { uid: 'c2', title: '中' },
        { uid: 'c3', title: '右' },
      ]);
    }
    const elsePlan = planBranchDelete(nodes, otherwise);
    expect(elsePlan.supported).toBe(false);
    if (!elsePlan.supported) {
      expect(elsePlan.reason).toContain('否则');
      for (const term of INTERNAL_TERMS) expect(elsePlan.reason).not.toContain(term);
    }
  });

  it('multi-conditions：只剩一条路径、路径序号越界、缺设置都不支持（理由为业务语言）', () => {
    const parent = node({
      id: 'p',
      type: 'multi-conditions',
      config: { conditions: [{ uid: 'c1', title: '唯一' }] },
    });
    const only = node({ id: 'h1', type: 'output', upstreamId: 'p', branchIndex: 1 });
    const outOfRange = node({ id: 'h2', type: 'output', upstreamId: 'p', branchIndex: 2 });
    const noConfig = node({ id: 'p2', type: 'multi-conditions', config: {} });
    const branchNoConfig = node({ id: 'h3', type: 'output', upstreamId: 'p2', branchIndex: 1 });
    const plans = [
      planBranchDelete([parent, only], only),
      planBranchDelete([parent, outOfRange], outOfRange),
      planBranchDelete([noConfig, branchNoConfig], branchNoConfig),
    ];
    for (const plan of plans) {
      expect(plan.supported).toBe(false);
      if (!plan.supported) for (const term of INTERNAL_TERMS) expect(plan.reason).not.toContain(term);
    }
  });

  it('parallel / 其它类型与不在路径上的步骤都不支持删除，且不出现内部术语', () => {
    const parallel = node({ id: 'pp', type: 'parallel', config: {} });
    const head = node({ id: 'ph', type: 'output', upstreamId: 'pp', branchIndex: 0 });
    const loop = node({ id: 'lp', type: 'loop', config: {} });
    const loopHead = node({ id: 'lh', type: 'output', upstreamId: 'lp', branchIndex: 0 });
    const linear = node({ id: 'l1', type: 'calculation', upstreamId: null });
    for (const plan of [
      planBranchDelete([parallel, head], head),
      planBranchDelete([loop, loopHead], loopHead),
      planBranchDelete([linear], linear),
    ]) {
      expect(plan.supported).toBe(false);
      if (!plan.supported) for (const term of INTERNAL_TERMS) expect(plan.reason).not.toContain(term);
    }
  });
});
