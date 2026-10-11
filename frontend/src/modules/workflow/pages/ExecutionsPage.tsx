import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { toUserMessage } from '../../../api/errors';
import { EmptyState, PageCard, PageHeader, StatusPill } from '../../../components/Card';
import { formatDateTime, formatDuration } from '../format';
import {
  executionStatusFilterValue,
  executionStatusLabel,
  EXECUTION_STATUS_FILTERS,
  EXECUTION_REASON_LABELS,
} from '../labels';
import { fetchExecutions, fetchWorkflowOptions, PAGE_SIZE, type ExecutionRow, type WorkflowRow } from '../domain';
import styles from '../workflow.module.css';

/**
 * WF-04 执行记录。
 *
 * 真实分页 + 流程/状态/时间范围筛选，状态按原生数字枚举映射成中文；
 * 执行绑定的是**具体流程版本 id**，因此列表同时展示版本标题与版本标识，
 * 让"同一流程的不同版本"在界面上可区分。
 * 本页只读，不提供任何改变执行状态的按钮（取消在详情页）。
 */
export function ExecutionsPage() {
  const [page, setPage] = useState(1);
  const [workflowId, setWorkflowId] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [rows, setRows] = useState<ExecutionRow[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowRow[]>([]);

  const filter = useMemo(() => {
    const conditions: Record<string, unknown> = {};
    if (workflowId) conditions.workflowId = workflowId;
    if (status !== '') {
      const value = executionStatusFilterValue(status);
      conditions.status = value === null ? { $eq: null } : value;
    }
    const createdAt: Record<string, string> = {};
    if (from) createdAt.$gte = new Date(`${from}T00:00:00`).toISOString();
    if (to) createdAt.$lte = new Date(`${to}T23:59:59.999`).toISOString();
    if (Object.keys(createdAt).length > 0) conditions.createdAt = createdAt;
    return conditions;
  }, [workflowId, status, from, to]);

  const load = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const result = await fetchExecutions({ page, filter });
      setRows(result.rows);
      setTotal(result.total);
    } catch (error) {
      setRows([]);
      setTotal(null);
      setListError(toUserMessage(error));
    } finally {
      setLoading(false);
    }
  }, [page, filter]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setPage(1);
  }, [workflowId, status, from, to]);

  useEffect(() => {
    let alive = true;
    fetchWorkflowOptions()
      .then((items) => {
        if (alive) setWorkflows(items);
      })
      .catch(() => {
        if (alive) setWorkflows([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  const totalPages = total !== null ? Math.max(1, Math.ceil(total / PAGE_SIZE)) : null;

  return (
    <div className={styles.stack}>
      <PageHeader
        title="执行记录"
        description="按流程版本、执行状态与时间范围查询历史执行。执行记录绑定的是当时运行的流程版本。"
        meta={
          <span className={styles.metaText}>
            {total !== null ? `共 ${total} 条执行记录` : loading ? '正在读取…' : '总数暂不可用'}
          </span>
        }
      />

      <PageCard>
        <div className={styles.filterBar}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>流程版本</span>
            <select className={styles.select} value={workflowId} onChange={(event) => setWorkflowId(event.target.value)}>
              <option value="">全部流程</option>
              {workflows.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                  {item.current ? '（当前生效版本）' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>执行状态</span>
            <select className={styles.select} value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">全部状态</option>
              {EXECUTION_STATUS_FILTERS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>开始时间从</span>
            <input className={styles.input} type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>到</span>
            <input className={styles.input} type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </label>
          <button type="button" className={styles.secondaryButton} onClick={() => void load()}>
            刷新
          </button>
        </div>

        {listError ? (
          <EmptyState tone="warn" title="执行记录暂时读不到" description={listError} />
        ) : loading ? (
          <p className={styles.mutedText}>正在读取执行记录…</p>
        ) : rows.length === 0 ? (
          <EmptyState
            title="没有符合条件的执行记录"
            description="可以放宽状态或时间范围。若流程从未触发过，这里为空是正常的。"
          />
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>执行</th>
                  <th>流程版本</th>
                  <th>状态</th>
                  <th>触发时间</th>
                  <th>耗时</th>
                  <th>结束原因</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const label = executionStatusLabel(row.status);
                  return (
                    <tr key={row.id}>
                      <td>
                        <Link className={styles.rowLink} to={`/workflow/execution?id=${row.id}`}>
                          #{row.id}
                        </Link>
                      </td>
                      <td>
                        <div className={styles.cellTitle}>
                          <span>{row.workflowTitle ?? '（流程已不存在）'}</span>
                          <span className={styles.cellHint}>版本 #{row.workflowId ?? '—'}</span>
                        </div>
                      </td>
                      <td>
                        <StatusPill tone={label.tone}>{label.label}</StatusPill>
                      </td>
                      <td>{formatDateTime(row.createdAt ?? row.startedAt) ?? '—'}</td>
                      <td>{formatDuration(row.startedAt, row.finishedAt) ?? '—'}</td>
                      <td>{row.reason ? EXECUTION_REASON_LABELS[row.reason] ?? row.reason : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {totalPages !== null && totalPages > 1 ? (
          <div className={styles.pager}>
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={page <= 1 || loading}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >
              上一页
            </button>
            <span className={styles.metaText}>
              第 {page} / {totalPages} 页
            </span>
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={page >= totalPages || loading}
              onClick={() => setPage((value) => value + 1)}
            >
              下一页
            </button>
          </div>
        ) : null}
      </PageCard>
    </div>
  );
}
