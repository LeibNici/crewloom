/**
 * AI-04 上下文选择的进程内状态。
 *
 * 为什么放在模块级而不是页面里：用户的产品路径是「在上下文工作区选择 → 到会话里使用」，
 * 两个路由（`/ai/context` 与 `/ai/conversations`）之间必须共享同一份选择；原生 ChatBox
 * 的宿主钩子在会话页运行时也要读到它。
 *
 * **世代隔离**：选择里可能包含真实业务数据（记录主键、代码、图表配置），因此存储绑定
 * 「会话世代 + 生效角色 + 当前用户」三者组成的 key（`src/api/client.ts` 的
 * `getSessionEpoch()` 在令牌/会话变化时自增）。key 变化时立即清空全部选择与提案，
 * 避免切换角色或重新登录后把上一个身份的内容带进新会话。
 */
import { useSyncExternalStore } from 'react';
import { getSessionEpoch } from '../../../api/client';
import { useSessionStore } from '../../../auth/store';
import type { ContextKind, ContextSelection } from './types';

export interface ToolProposal {
  id: string;
  uid: string;
  toolName: string;
  args: unknown;
  /** 预览结果（原样保留，供「应用 / 拒绝」时展示）。 */
  preview: unknown;
  at: string;
  status: 'pending' | 'applied' | 'rejected';
}

export interface ToolRunRecord {
  uid: string;
  toolName: string;
  decision: 'applied' | 'rejected' | 'read';
  at: string;
}

export interface ContextStoreSnapshot {
  selections: ContextSelection[];
  proposals: ToolProposal[];
  history: ToolRunRecord[];
}

function generationKey(): string {
  const state = useSessionStore.getState();
  const user = state.user as { id?: unknown } | null;
  return `${getSessionEpoch()}|${state.activeRole ?? ''}|${user?.id == null ? '' : String(user.id)}`;
}

let snapshot: ContextStoreSnapshot = { selections: [], proposals: [], history: [] };
let generation = generationKey();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* 监听器异常不影响状态机 */
    }
  }
}

/** 每次读写前调用：身份世代变化则整体作废，并通知订阅者。 */
export function ensureGeneration(): void {
  if (resetIfGenerationChanged()) emit();
}

/**
 * 订阅会话/角色状态：切换角色或重新登录时**主动**作废并通知界面。
 *
 * 只靠渲染期比较 key 不够：产品路由里的页面组件在同一路由下可能不重渲染，
 * 于是旧身份的选择会继续留在屏幕上。这里在会话状态变化时立刻清空。
 */
useSessionStore.subscribe(() => {
  ensureGeneration();
});

/** 渲染期使用的变体：只作废，不在渲染中同步通知订阅者。 */
function ensureGenerationSilently(): void {
  resetIfGenerationChanged();
}

function resetIfGenerationChanged(): boolean {
  const current = generationKey();
  if (current === generation) return false;
  generation = current;
  snapshot = { selections: [], proposals: [], history: [] };
  // 身份世代变化：未消费的交接请求也随之作废（不能把旧身份的显式请求带到新身份）。
  handoffRequested = false;
  return true;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSnapshot(): ContextStoreSnapshot {
  ensureGenerationSilently();
  return snapshot;
}

/** React 订阅入口（`useSyncExternalStore`）。 */
export function useContextStoreSnapshot(): ContextStoreSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function update(next: Partial<ContextStoreSnapshot>): void {
  ensureGeneration();
  snapshot = { ...snapshot, ...next };
  emit();
}

export function getSelections(): ContextSelection[] {
  return getSnapshot().selections;
}

/**
 * 用户**显式**动作标记（`保存为会话内容` / `到会话中使用`）。
 *
 * 交接层用签名去重来避免"宿主重新挂载时把同一份选择重复注入，导致第二条消息又带 workContext"；
 * 但用户明确再次保存/使用同一份选择时，应该能在新的第一条消息里重新带上内容（不需要靠新标签）。
 * 这里用一个一次性标记表达"这是用户显式请求的交接"，与自动重挂载区分开。
 * 工具执行（`apply_code_change`）自己调 `upsertSelection` 时不置该标记。
 */
let handoffRequested = false;

export function requestChatHandoff(): void {
  handoffRequested = true;
}

/** 读取并清除一次性交接请求。 */
export function consumeChatHandoffRequest(): boolean {
  const value = handoffRequested;
  handoffRequested = false;
  return value;
}

export function upsertSelection(selection: ContextSelection): void {
  ensureGeneration();
  const key = (item: ContextSelection) =>
    item.kind === selection.kind && item.uid === selection.uid;
  const rest = snapshot.selections.filter((item) => !key(item));
  update({ selections: [...rest, selection] });
}

export function removeSelection(kind: ContextKind): void {
  ensureGeneration();
  update({ selections: snapshot.selections.filter((item) => item.kind !== kind) });
}

export function clearSelections(): void {
  update({ selections: [], proposals: snapshot.proposals, history: snapshot.history });
}

export function clearAll(): void {
  update({ selections: [], proposals: [], history: [] });
}

export function getProposals(): ToolProposal[] {
  return getSnapshot().proposals.filter((proposal) => proposal.status === 'pending');
}

export function recordProposal(proposal: ToolProposal): void {
  ensureGeneration();
  update({ proposals: [proposal, ...snapshot.proposals].slice(0, 20) });
}

export function settleProposal(id: string, status: 'applied' | 'rejected'): ToolProposal | null {
  ensureGeneration();
  const target = snapshot.proposals.find((proposal) => proposal.id === id && proposal.status === 'pending');
  if (!target) return null;
  const settled: ToolProposal = { ...target, status };
  update({
    proposals: snapshot.proposals.map((proposal) => (proposal.id === id ? settled : proposal)),
    history: [
      { uid: settled.uid, toolName: settled.toolName, decision: status, at: new Date().toISOString() },
      ...snapshot.history,
    ].slice(0, 20),
  });
  return settled;
}

export function recordRun(record: ToolRunRecord): void {
  ensureGeneration();
  update({ history: [record, ...snapshot.history].slice(0, 20) });
}

export function getHistory(): ToolRunRecord[] {
  return getSnapshot().history;
}

/** 仅测试用：把存储重置到确定状态（不改世代 key）。 */
export function __resetForTests(): void {
  snapshot = { selections: [], proposals: [], history: [] };
  generation = generationKey();
  handoffRequested = false;
  emit();
}
