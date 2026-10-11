import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { toUserMessage } from '../../../api/errors';
import { EmptyState, PageCard, PageHeader, StatusPill } from '../../../components/Card';
import { formatDateTime, formatRelative } from '../../workflow/format';
import { aiTaskStatusLabel, jobStatusLabel, taskTypeLabel } from '../../workflow/labels';
import {
  fetchAiTasks,
  fetchAiUnreadCount,
  fetchCcTasks,
  fetchManualTasks,
  fetchTaskStats,
  TASK_PAGE_SIZE,
  type AiTaskRow,
  type CcTaskRow,
  type ManualTaskRow,
  type TaskStatsSummary,
} from '../domain';
import styles from '../tasks.module.css';

/**
 * TD-01 我的待办。
 *
 * 真实行为：
 *  - 三个来源**各自分页**（原生就是三个资源动作，没有跨来源全局分页/排序接口），
 *    页面明确区分"本来源共多少条"与"当前页多少条"，不把两者混成一个数；
 *  - 计数来自 `userWorkflowTaskStats:listMine`（按流程聚合）与
 *    `aiWorkflowTasks:unreadCount`（未读），并如实标注口径；
 *  - 空结果、无权限、读取失败分别呈现；
 *  - 13000 当前账号这三类真实为 0，界面显示空态，不填充演示数据。
 */
type SourceKey = 'manual' | 'cc' | 'ai';

interface SourceMeta {
  key: SourceKey;
  label: string;
  description: string;
}

const SOURCES: SourceMeta[] = [
  { key: 'manual', label: '人工处理', description: '需要你填写表单或选择处理结果的工作流节点。' },
  { key: 'cc', label: '抄送给我', description: '别人抄送给你的流程消息。已读只影响未读标记，不代表流程被推进。' },
  { key: 'ai', label: 'AI 任务', description: '需要你领取或审核的 AI 员工任务。' },
];

export function PendingTasksPage() {
  const [source, setSource] = useState<SourceKey>('manual');
  const [page, setPage] = useState(1);
  const [manual, setManual] = useState<ManualTaskRow[]>([]);
  const [cc, setCc] = useState<CcTaskRow[]>([]);
  const [ai, setAi] = useState<AiTaskRow[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [stats, setStats] = useState<TaskStatsSummary | null>(null);
  const [unread, setUnread] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      if (source === 'manual') {
        const result = await fetchManualTasks({ page, appends: ['node', 'workflow'] });
        setManual(result.rows);
        setTotal(result.total);
      } else if (source === 'cc') {
        const result = await fetchCcTasks({ page });
        setCc(result.rows);
        setTotal(result.total);
      } else {
        const result = await fetchAiTasks({ page });
        setAi(result.rows);
        setTotal(result.total);
      }
    } catch (error) {
      setManual([]);
      setCc([]);
      setAi([]);
      setTotal(null);
      setListError(toUserMessage(error));
    } finally {
      setLoading(false);
    }
  }, [source, page]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setPage(1);
  }, [source]);

  const loadSummary = useCallback(async () => {
    try {
      setStats(await fetchTaskStats());
    } catch {
      setStats(null);
    }
    try {
      setUnread(await fetchAiUnreadCount());
    } catch {
      setUnread(null);
    }
  }, []);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const rows = source === 'manual' ? manual : source === 'cc' ? cc : ai;
  const totalPages = total !== null ? Math.max(1, Math.ceil(total / TASK_PAGE_SIZE)) : null;
  const activeSource = SOURCES.find((item) => item.key === source) as SourceMeta;

  return (
    <div className={styles.stack}>
      <PageHeader
        title="我的待处理"
        description="按来源查看需要你处理的事项。三个来源分别计数与分页，不做跨来源合并。"
        meta={
          <div className={styles.statRow}>
            <div className={styles.statBlock}>
              <span className={styles.statLabel}>本人工作流待处理（按流程汇总）</span>
              <span className={styles.statValue}>{stats ? stats.pendingTotal : '—'}</span>
              <span className={styles.cellHint}>
                {stats
                  ? `来自人工处理与抄送，共涉及 ${stats.workflowCount} 个流程`
                  : '统计暂不可用'}
              </span>
            </div>
            <div className={styles.statBlock}>
              <span className={styles.statLabel}>AI 任务未读</span>
              <span className={styles.statValue}>{unread === null ? '—' : unread}</span>
              <span className={styles.cellHint}>{unread === null ? '未读数暂不可用' : '可进入 AI 任务来源查看'}</span>
            </div>
          </div>
        }
      />

      <PageCard>
        <div className={styles.sourceTabs} role="tablist">
          {SOURCES.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={source === item.key}
              className={item.key === source ? `${styles.sourceTab} ${styles.sourceTabActive}` : styles.sourceTab}
              onClick={() => setSource(item.key)}
            >
              {item.label}
              {item.key === 'ai' && unread !== null ? `（未读 ${unread}）` : ''}
            </button>
          ))}
        </div>

        <p className={styles.cellHint}>{activeSource.description}</p>

        {listError ? (
          <EmptyState tone="warn" title="待办列表暂时读不到" description={listError} />
        ) : loading ? (
          <p className={styles.mutedText}>正在读取待办…</p>
        ) : rows.length === 0 ? (
          <EmptyState
            title={`没有${activeSource.label}的事项`}
            description={
              stats && stats.pendingTotal === 0
                ? '当前账号确实没有待处理事项（后端统计也是 0）。有新的待办时会自动出现在这里。'
                : '这个来源当前没有数据。若你预期有内容，可以稍后刷新。'
            }
          />
        ) : (
          <>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>事项</th>
                    <th>来源</th>
                    <th>状态</th>
                    <th>时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {source === 'manual'
                    ? manual.map((row) => (
                        <tr key={row.id}>
                          <td>
                            <div className={styles.cellTitle}>
                              <span>{row.nodeTitle ?? '人工处理节点'}</span>
                              <span className={styles.cellHint}>{row.workflowTitle ?? '流程已不存在'}</span>
                            </div>
                          </td>
                          <td>{taskTypeLabel('manual')}</td>
                          <td>
                            <StatusPill tone="warn">待处理</StatusPill>
                          </td>
                          <td>{formatDateTime(row.createdAt) ?? '—'}</td>
                          <td>
                            <Link className={styles.linkButton} to={`/tasks/manual?id=${row.id}`}>
                              去处理
                            </Link>
                          </td>
                        </tr>
                      ))
                    : null}
                  {source === 'cc'
                    ? cc.map((row) => (
                        <tr key={row.id}>
                          <td>
                            <div className={styles.cellTitle}>
                              <span>{row.nodeTitle ?? '抄送消息'}</span>
                              <span className={styles.cellHint}>{row.workflowTitle ?? '流程已不存在'}</span>
                            </div>
                          </td>
                          <td>{taskTypeLabel('cc')}</td>
                          <td>
                            {row.status === 1 ? (
                              <StatusPill tone="neutral">已读</StatusPill>
                            ) : (
                              <StatusPill tone="warn">未读</StatusPill>
                            )}
                          </td>
                          <td>{formatRelative(row.createdAt) ?? formatDateTime(row.createdAt) ?? '—'}</td>
                          <td>
                            <Link className={styles.linkButton} to={`/tasks/cc?id=${row.id}`}>
                              查看
                            </Link>
                          </td>
                        </tr>
                      ))
                    : null}
                  {source === 'ai'
                    ? ai.map((row) => {
                        const label = aiTaskStatusLabel(row.status);
                        const job = jobStatusLabel(row.jobStatus);
                        return (
                          <tr key={row.id}>
                            <td>
                              <div className={styles.cellTitle}>
                                <span>{row.read ? 'AI 任务' : 'AI 任务（未读）'}</span>
                                <span className={styles.cellHint}>节点状态：{job.label}</span>
                              </div>
                            </td>
                            <td>AI 员工</td>
                            <td>
                              <StatusPill tone={label.tone}>{label.label}</StatusPill>
                            </td>
                            <td>{formatDateTime(row.createdAt ?? row.updatedAt) ?? '—'}</td>
                            <td>
                              {row.sessionId ? (
                                <Link className={styles.linkButton} to={`/tasks/ai?sessionId=${row.sessionId}`}>
                                  查看任务
                                </Link>
                              ) : (
                                <span className={styles.cellHint}>缺少会话标识，无法打开</span>
                              )}
                            </td>
                          </tr>
                        );
                      })
                    : null}
                </tbody>
              </table>
            </div>

            <div className={styles.pager}>
              <span className={styles.metaText}>
                {total !== null ? `共 ${total} 条` : '总数暂不可用'}
                {totalPages !== null ? ` · 第 ${page} / ${totalPages} 页` : ''}
              </span>
              <button
                type="button"
                className={styles.secondaryButton}
                disabled={page <= 1 || loading}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
              >
                上一页
              </button>
              <button
                type="button"
                className={styles.secondaryButton}
                disabled={totalPages === null || page >= totalPages || loading}
                onClick={() => setPage((value) => value + 1)}
              >
                下一页
              </button>
              <button type="button" className={styles.secondaryButton} onClick={() => void load()}>
                刷新
              </button>
            </div>
          </>
        )}
      </PageCard>
    </div>
  );
}
