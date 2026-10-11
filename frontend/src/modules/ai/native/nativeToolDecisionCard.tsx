/**
 * 原生 ChatBox 里的前端工具确认卡片（中文、可允许 / 可拒绝）。
 *
 * 为什么需要它（固定源码事实）：
 *  - 前端工具的调用链是"模型调用内置工具 `executeFrontendTool` → 用户在原生会话里确认 →
 *    客户端真的执行 `FrontendToolRegistry.execute` → 结果随 `resumeToolCall` 回传"
 *    （`useToolCallActions.ts:28-87`）。
 *  - 上游默认卡片只提供「Allow use」一个按钮，会**一次批准全部**工具（`ToolCard.tsx:127-160`），
 *    没有"逐条允许 / 拒绝"的入口，用户也就无法表达拒绝。
 *  - 上游的扩展点就是 `aiManager.toolsManager.registerTools(name, { ui: { card } })`
 *    （`DefaultToolsManager.listTools` 会按后端工具名合并前端注册的 UI）。
 *    本卡片因此注册在**同一个真实 toolsManager** 上，拿到的 `decisions` 也是原生那一份
 *    （`getDecisionActions(toolCall)` → `updateUserDecision`），没有第二套决策通道。
 *
 * 文案只讲用户能懂的：谁要做什么、允许后会发生什么、拒绝会怎样。
 */
import { useState } from 'react';
import type { ToolCall } from '@nocobase/client-v2';
import { describeContextTool } from '../context/tools';
import styles from '../group-a.module.css';

interface DecisionCardProps {
  messageId?: string;
  toolCall: ToolCall;
  decisions: {
    approve: () => Promise<void>;
    edit: (args: unknown) => Promise<void>;
    reject: (message?: string) => Promise<void>;
  };
}

function readToolId(toolCall: ToolCall): string | null {
  const args = toolCall.args as { toolId?: unknown } | undefined;
  return typeof args?.toolId === 'string' && args.toolId ? args.toolId : null;
}

function describe(toolId: string | null): string {
  if (!toolId) return '数字员工想执行一步界面操作。';
  const tool = describeContextTool(toolId);
  if (!tool) return '数字员工想执行一步界面操作。';
  return `数字员工想执行「${tool.title}」。`;
}

export function NativeToolDecisionCard({ toolCall, decisions, messageId }: DecisionCardProps) {
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 本地已提交（服务端返回 updated>0）：立即隐藏按钮，避免同一张卡片被重复点击。 */
  const [settled, setSettled] = useState(false);
  const status = String(toolCall.invokeStatus ?? '');
  const toolId = readToolId(toolCall);
  const decided = settled || (status !== 'interrupted' && status !== 'init');
  const tool = toolId ? describeContextTool(toolId) : null;

  const run = async (kind: 'approve' | 'reject') => {
    setBusy(kind);
    setError(null);
    try {
      if (kind === 'approve') await decisions.approve();
      else await decisions.reject();
      setSettled(true);
    } catch (caught) {
      setError('这一步没有完成，请重试；如果一直失败，请联系管理员。');
      console.warn('[crewloom] 工具确认失败', caught);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      data-testid="native-tool-decision-card"
      data-tool-id={toolId ?? ''}
      data-tool-uid={tool?.uid ?? ''}
      data-message-id={messageId ?? ''}
      data-invoke-status={status}
      style={{
        border: '1px solid rgba(5, 5, 5, 0.08)',
        borderRadius: 8,
        padding: '8px 10px',
        marginBottom: 6,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <span style={{ fontSize: 13 }}>{describe(toolId)}</span>
      <span style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>
        {decided
          ? '这一项已经处理过了。'
          : tool?.permission === 'ASK'
            ? '允许后会修改你当前的工作内容；拒绝则保持原样。'
            : '允许后数字员工会读取这份内容；拒绝则跳过。'}
      </span>
      {error ? <span style={{ fontSize: 12, color: '#cf1322' }}>{error}</span> : null}
      {!decided ? (
        <span style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            data-testid="native-tool-approve"
            className={`${styles.button} ${styles.buttonPrimary}`}
            disabled={busy !== null}
            onClick={() => void run('approve')}
          >
            {busy === 'approve' ? '处理中…' : '允许'}
          </button>
          <button
            type="button"
            data-testid="native-tool-reject"
            className={styles.button}
            disabled={busy !== null}
            onClick={() => void run('reject')}
          >
            {busy === 'reject' ? '处理中…' : '拒绝'}
          </button>
        </span>
      ) : null}
    </div>
  );
}
