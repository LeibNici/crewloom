import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../../../api/client';
import { EmptyState, PageCard, PageHeader, StatTile } from '../../../components/Card';
import { asRecord, readId, readNumber, readString } from '../../workflow/format';
import { taskTypeLabel } from '../../workflow/labels';
import { fetchTaskStats, type TaskStatsSummary } from '../domain';
import styles from '../tasks.module.css';

interface TaskTypeRow {
  id: string;
  type: string | null;
  pending: number;
  all: number;
}

/**
 * TD-01 附带的"已处理"视图（保留既有 `/tasks/processed` 入口）。
 *
 * 真实能力边界（如实说明，不造列表）：
 *  - 本版本原生只提供**按任务类型的物化合计**（`userWorkflowTasks:listMine`，行内只有
 *    `{ id, userId, type, stats }`，没有标题/状态字段），**没有**"已处理记录列表"接口；
 *  - 因此本页展示每个来源的累计与待处理数量，并提供进入对应真实列表的入口，
 *    不伪造"历史已处理明细"。
 */
export function ProcessedTasksPage() {
  const [rows, setRows] = useState<TaskTypeRow[]>([]);
  const [stats, setStats] = useState<TaskStatsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const [types, summary] = await Promise.all([
          api.resourceAction<unknown[]>('userWorkflowTasks', 'listMine', { params: { pageSize: 50 } }),
          fetchTaskStats(),
        ]);
        if (!alive) return;
        setRows(
          (Array.isArray(types.data) ? types.data : []).map((entry) => {
            const record = asRecord(entry) ?? {};
            const statsRecord = asRecord(record.stats);
            return {
              id: readId(record) ?? '',
              type: readString(record, 'type'),
              pending: readNumber(statsRecord, 'pending') ?? 0,
              all: readNumber(statsRecord, 'all') ?? 0,
            };
          }),
        );
        setStats(summary);
      } catch (error) {
        if (!alive) return;
        setRows([]);
        setStats(null);
        setLoadError('已处理统计暂时读不到，请稍后重试。');
        void error;
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const processedTotal = rows.reduce((total, row) => Math.max(total, row.all - row.pending), 0);

  return (
    <div className={styles.stack}>
      <PageHeader
        title="已处理"
        description="按来源查看累计数量。当前版本后端没有提供逐条历史记录接口，因此这里展示汇总数量与入口。"
        actions={
          <Link className={styles.secondaryButton} to="/tasks/pending">
            去处理待办
          </Link>
        }
      />

      <PageCard>
        {loadError ? (
          <EmptyState tone="warn" title="统计暂时读不到" description={loadError} />
        ) : loading ? (
          <p className={styles.mutedText}>正在读取统计…</p>
        ) : rows.length === 0 ? (
          <EmptyState
            title="还没有可统计的处理记录"
            description="当你的账号处理过人工待办或收到过抄送后，这里会显示每个来源的累计数量。"
          />
        ) : (
          <>
            <div className={styles.statRow}>
              {rows.map((row) => (
                <StatTile
                  key={row.id || row.type || 'unknown'}
                  label={taskTypeLabel(row.type)}
                  value={row.all}
                  hint={`其中待处理 ${row.pending} 条`}
                />
              ))}
              {stats ? <StatTile label="待处理合计（按流程汇总）" value={stats.pendingTotal} hint={`涉及 ${stats.workflowCount} 个流程`} /> : null}
            </div>
            <p className={styles.cellHint}>
              累计口径说明：同一个流程可能同时包含已完成与待处理的任务，这里的数字是按来源物化统计的结果，
              不是"已处理明细条数"。当前已处理明细约为 {processedTotal} 条，仅供大致参考。
            </p>
          </>
        )}
      </PageCard>

      <PageCard title="查看明细" description="按来源进入真实列表页。">
        <div className={styles.formActions}>
          <Link className={styles.secondaryButton} to="/tasks/pending">
            人工处理待办
          </Link>
          <Link className={styles.secondaryButton} to="/tasks/cc-list">
            抄送消息
          </Link>
          <Link className={styles.secondaryButton} to="/tasks/pending">
            AI 任务
          </Link>
        </div>
      </PageCard>
    </div>
  );
}
