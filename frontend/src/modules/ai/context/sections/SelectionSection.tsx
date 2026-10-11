/**
 * 「会话内容」：本次将要带入会话的上下文汇总。
 *
 * 展示的是**人话摘要**（不展示 type / uid / JSON）；用户可逐项修改或取消。
 * 具体会话项由 `../payload.ts` 按真实 consumer 构造，工具 manifest 来自真实注册表取回的结果，
 * 因此这里看到的"带上的工具"就是宿主真正能执行的工具。
 */
import { Link } from 'react-router';
import { PageCard, StatusPill } from '../../../../components/Card';
import { describeSelection } from '../payload';
import { prepareChatBoxContextItems } from '../native';
import { requestChatHandoff, removeSelection, useContextStoreSnapshot } from '../store';
import type { ContextKind } from '../types';
import { EmptyState } from '../../../../components/Card';
import styles from '../../group-a.module.css';

const KIND_LABEL: Record<ContextKind, string> = {
  datasource: '数据范围',
  record: '指定记录',
  code: '代码工作内容',
  chart: '图表工作内容',
};

/**
 * 面向用户说明"员工拿到这份内容后能做什么"。
 *
 * 这里刻意不出现工具名/注册表/权限枚举等实现词：修改类能力统一表述为
 * "给出建议，需要你确认后才会生效"（对应 manifest 的 `permission: 'ASK'`）。
 */
function capabilityText(names: string[]): string | null {
  if (names.length === 0) return null;
  if (names.some((name) => name.startsWith('apply_'))) {
    return '员工可以读取这份内容并给出修改建议；是否应用由你确认。';
  }
  return '员工可以按这份内容读取数据。';
}

export function SelectionSection({ onEdit }: { onEdit: (kind: ContextKind) => void }) {
  const snapshot = useContextStoreSnapshot();
  const items = prepareChatBoxContextItems(snapshot.selections);

  if (snapshot.selections.length === 0) {
    return (
      <PageCard title="会话内容" description="这里汇总这次要带给员工的内容。">
        <EmptyState
          title="还没有选择任何上下文"
          description="在「数据范围」「指定记录」「代码工作内容」「图表工作内容」里选择后，会在这里汇总。"
        />
      </PageCard>
    );
  }

  return (
    <PageCard
      title="会话内容"
      description="这些内容会随你发送的第一条消息一起带给员工。"
      actions={
        <Link
          className={styles.button}
          to="/ai/conversations"
          data-testid="context-goto-conversations"
          onClick={requestChatHandoff}
        >
          到会话中使用
        </Link>
      }
    >
      <div className={styles.rowList} data-testid="context-selection-list" data-payload={JSON.stringify(items)}>
        {snapshot.selections.map((selection) => {
          const item = items.find((candidate) =>
            selection.kind === 'record'
              ? candidate.uid.startsWith('crewloom:record:')
              : selection.kind === 'code'
                ? candidate.type === 'code-editor'
                : selection.kind === 'chart'
                  ? candidate.type === 'chart-config'
                  : candidate.uid === selection.uid,
          );
          const tools = item?.frontendTools ?? [];
          const capability = capabilityText(tools.map((tool) => tool.name));
          return (
            <div key={`${selection.kind}:${selection.uid}`} className={styles.rowCard} data-testid="context-selection-item">
              <span className={styles.rowMain}>
                <span className={styles.chipRow}>
                  <span className={styles.rowTitle}>{selection.title}</span>
                  <StatusPill tone="brand">{KIND_LABEL[selection.kind]}</StatusPill>
                </span>
                <span className={styles.rowHint}>{describeSelection(selection)}</span>
                {capability ? <span className={styles.rowHint}>{capability}</span> : null}
              </span>
              <span className={styles.rowActions}>
                <button
                  type="button"
                  className={styles.button}
                  onClick={() => onEdit(selection.kind)}
                  data-testid="context-selection-edit"
                >
                  修改
                </button>
                <button
                  type="button"
                  className={`${styles.button} ${styles.buttonDanger}`}
                  onClick={() => removeSelection(selection.kind)}
                  data-testid="context-selection-remove"
                >
                  取消
                </button>
              </span>
            </div>
          );
        })}
      </div>
      <p className={styles.rowHint}>这些内容会一起发送；发送前会按最新保存的设置重新读取数据范围。</p>
    </PageCard>
  );
}
