/**
 * 「工具提出的修改」面板：明确应用 / 拒绝。
 *
 * 与原生会话里的两步确认是同一套语义：
 *  - 客户端 `useToolCallActions.ts:28-87` 在用户确认后才执行工具，并把结果交给 `resumeToolCall`；
 *  - 这里工作区里的「应用」按钮走**同一份工具定义**（`runContextTool`），因此
 *    界面与原生 ChatBox 不会出现两套行为；「拒绝」只结算提案，不触碰任何数据。
 */
import { useState } from 'react';
import { getHistory, settleProposal, useContextStoreSnapshot } from './store';
import { rejectProposal, runContextTool } from './tools';
import type { ContextKind } from './types';
import { Notice } from '../ui';
import styles from '../group-a.module.css';

function previewText(preview: unknown): string {
  if (!preview || typeof preview !== 'object') return '已生成一份修改建议。';
  const record = preview as Record<string, unknown>;
  if (typeof record.changed === 'boolean' && record.changed) return '建议的修改与当前内容不同。';
  if (record.changed === false) return '建议内容与当前内容一致。';
  return '已生成一份修改建议。';
}

export function ToolProposals({
  kind,
  uid,
  title,
  onSettled,
}: {
  kind: ContextKind;
  uid: string;
  title: string;
  /** 应用或拒绝之后通知宿主表单重新对齐 store（拒绝时草稿要退回已保存内容）。 */
  onSettled?: () => void;
}) {
  const snapshot = useContextStoreSnapshot();
  const pending = snapshot.proposals.filter((proposal) => proposal.uid === uid && proposal.status === 'pending');
  const history = getHistory().filter((record) => record.uid === uid);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const apply = async (id: string, toolName: string, args: unknown) => {
    setBusy(id);
    setFailed(false);
    setMessage(null);
    const result = await runContextTool(kind, uid, toolName, (args ?? {}) as Record<string, unknown>);
    setBusy(null);
    if (result.status === 'success') {
      settleProposal(id, 'applied');
      setMessage('已按你的确认应用这次修改。');
      onSettled?.();
      return;
    }
    setFailed(true);
    setMessage(typeof result.content === 'string' ? result.content : '这次修改没有应用成功。');
  };

  const reject = (id: string) => {
    setFailed(false);
    rejectProposal(id);
    setMessage('已拒绝这次修改，当前内容保持不变。');
    onSettled?.();
  };

  return (
    <div className={styles.toolCard} data-testid="context-tool-panel">
      <div className={styles.toolCardTitle}>工具提出的修改 · {title}</div>
      {pending.length === 0 ? (
        <p className={styles.rowHint}>当前没有待确认的修改。员工在会话里提出的修改会出现在这里，由你决定应用还是拒绝。</p>
      ) : (
        <div className={styles.rowList}>
          {pending.map((proposal) => (
            <div key={proposal.id} className={styles.rowCard}>
              <span className={styles.rowMain}>
                <span className={styles.rowTitle}>{proposal.toolName === 'apply_code_change' ? '代码修改' : '图表配置修改'}</span>
                <span className={styles.rowHint}>{previewText(proposal.preview)}</span>
              </span>
              <span className={styles.rowActions}>
                <button
                  type="button"
                  className={`${styles.button} ${styles.buttonPrimary}`}
                  disabled={busy === proposal.id}
                  onClick={() => void apply(proposal.id, proposal.toolName, proposal.args)}
                  data-testid="context-tool-apply"
                >
                  {busy === proposal.id ? '正在应用…' : '应用'}
                </button>
                <button
                  type="button"
                  className={styles.button}
                  disabled={busy === proposal.id}
                  onClick={() => reject(proposal.id)}
                  data-testid="context-tool-reject"
                >
                  拒绝
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
      {message ? <Notice tone={failed ? 'danger' : 'info'}>{message}</Notice> : null}
      {history.length > 0 ? (
        <p className={styles.rowHint}>
          最近处理：{history.slice(0, 3).map((record) => `${record.toolName === 'apply_code_change' ? '代码' : '图表'}${record.decision === 'applied' ? '已应用' : record.decision === 'rejected' ? '已拒绝' : '已读取'}`).join('、')}
        </p>
      ) : null}
    </div>
  );
}
