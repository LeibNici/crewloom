import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../../../api/client';
import { toUserMessage } from '../../../api/errors';
import { DefinitionRow, EmptyState, PageCard, PageHeader, StatusPill } from '../../../components/Card';
import { formatDateTime } from '../../workflow/format';
import { taskTypeLabel } from '../../workflow/labels';
import { useMutation } from '../../workflow/useMutation';
import { fetchCcTask, fetchCcTasks, TASK_PAGE_SIZE, type CcTaskRow } from '../domain';
import type { ModulePageProps } from '../../types';
import styles from '../tasks.module.css';

/**
 * TD-04 抄送详情。
 *
 * 契约（32 页矩阵 §TD-04）：
 *  - `workflowCcTasks:get` 由服务端强制 `userId=当前用户`；
 *  - `read` 只把 `status=0` 的记录置为已读并写 `readAt`；`unread` 反向；
 *  - **抄送已读不代表流程被批准或继续推进**，文案必须保持这一点。
 */
/**
 * 允许注入详情读取实现，便于受控验证与后续公共装配（默认真实后端）。
 * 注入只影响"从哪读"，写入与状态机仍走产品真实请求管线。
 */
export interface CcTaskPageDeps {
  fetchDetail?: (id: string) => Promise<CcTaskRow | null>;
}

export function CcTaskPage({ deps }: ModulePageProps & { deps?: CcTaskPageDeps }) {
  const [params] = useSearchParams();
  const id = params.get('id') ?? '';
  const fetchDetail = deps?.fetchDetail ?? fetchCcTask;
  const [task, setTask] = useState<CcTaskRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mutation = useMutation();

  const load = useCallback(async () => {
    if (!id) {
      setLoading(false);
      setLoadError('没有指定要查看的抄送消息。');
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const detail = await fetchDetail(id);
      setTask(detail);
      if (!detail) setLoadError('这条抄送消息不存在，或不属于当前账号。');
    } catch (error) {
      setTask(null);
      setLoadError(toUserMessage(error));
    } finally {
      setLoading(false);
    }
  }, [id, fetchDetail]);

  useEffect(() => {
    void load();
  }, [load]);

  const markRead = async () => {
    setNotice(null);
    const result = await mutation.run(() =>
      api.resourceAction('workflowCcTasks', 'read', { params: { filterByTk: id } }),
    );
    if (result !== null) {
      setNotice('已标记为已读。注意：这不会推进流程。');
      await load();
    }
  };

  const markUnread = async () => {
    setNotice(null);
    const result = await mutation.run(() =>
      api.resourceAction('workflowCcTasks', 'unread', { params: { filterByTk: id } }),
    );
    if (result !== null) {
      setNotice('已标记为未读。');
      await load();
    }
  };

  const markAllRead = async () => {
    setNotice(null);
    const result = await mutation.run(() => api.resourceAction('workflowCcTasks', 'readAll', {}));
    if (result !== null) {
      setNotice('已把当前账号的全部抄送标记为已读。这不会推进任何流程。');
      await load();
    }
  };

  if (loading) {
    return (
      <PageCard title="抄送详情">
        <p className={styles.mutedText}>正在读取抄送详情…</p>
      </PageCard>
    );
  }

  if (loadError || !task) {
    return (
      <div className={styles.stack}>
        <PageHeader title="抄送详情" description="查看抄送消息与关联流程。" />
        <EmptyState tone="warn" title="抄送详情暂时读不到" description={loadError ?? '没有找到这条抄送消息。'} />
        <Link className={styles.secondaryButton} to="/tasks/cc-list">
          返回抄送列表
        </Link>
      </div>
    );
  }

  const status = task.status;

  return (
    <div className={styles.stack}>
      <PageHeader
        title="抄送详情"
        description="抄送只是把流程消息通知给你；标记已读不会让流程继续，也不会改变流程的审批结果。"
        meta={
          <div className={styles.tagRow}>
            {status === 1 ? <StatusPill tone="neutral">已读</StatusPill> : <StatusPill tone="warn">未读</StatusPill>}
            <StatusPill tone="neutral">{taskTypeLabel('cc')}</StatusPill>
          </div>
        }
        actions={
          <Link className={styles.secondaryButton} to="/tasks/cc-list">
            返回抄送列表
          </Link>
        }
      />

      <PageCard title="消息内容">
        <DefinitionRow term="来自流程">{task.workflowTitle ?? '流程已不存在'}</DefinitionRow>
        <DefinitionRow term="来自节点">{task.nodeTitle ?? '—'}</DefinitionRow>
        <DefinitionRow term="收到时间">{formatDateTime(task.createdAt) ?? '—'}</DefinitionRow>
        <DefinitionRow term="阅读时间">{task.readAt ? formatDateTime(task.readAt) : '尚未阅读'}</DefinitionRow>
        {task.nodeId ? <DefinitionRow term="节点编号">#{task.nodeId}</DefinitionRow> : null}
      </PageCard>

      <PageCard title="阅读状态" description="这些操作只影响你自己的未读标记。">
        <div className={styles.formActions}>
          {status === 1 ? (
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={mutation.isSubmitting}
              onClick={() => void markUnread()}
            >
              标记为未读
            </button>
          ) : (
            <button
              type="button"
              className={styles.primaryButton}
              disabled={mutation.isSubmitting}
              onClick={() => void markRead()}
            >
              标记为已读
            </button>
          )}
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={mutation.isSubmitting}
            onClick={() => void markAllRead()}
          >
            全部标为已读
          </button>
        </div>
      </PageCard>

      {notice ? <p className={styles.successText}>{notice}</p> : null}
      {mutation.message ? <p className={styles.errorText}>{mutation.message}</p> : null}
    </div>
  );
}

/**
 * TD-04 抄送列表。
 *
 * 展示当前账号的全部抄送消息（分页），并支持一次把全部标为已读。
 */
export function CcListPage() {
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<CcTaskRow[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mutation = useMutation();

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await fetchCcTasks({ page });
      setRows(result.rows);
      setTotal(result.total);
    } catch (error) {
      setRows([]);
      setTotal(null);
      setLoadError(toUserMessage(error));
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    void load();
  }, [load]);

  const markAllRead = async () => {
    setNotice(null);
    const result = await mutation.run(() => api.resourceAction('workflowCcTasks', 'readAll', {}));
    if (result !== null) {
      setNotice('已把当前账号的全部抄送标记为已读。这不会推进任何流程。');
      await load();
    }
  };

  const totalPages = total !== null ? Math.max(1, Math.ceil(total / TASK_PAGE_SIZE)) : null;

  return (
    <div className={styles.stack}>
      <PageHeader
        title="抄送我的"
        description="抄送消息只是通知，标记已读不会让流程继续。"
        meta={
          <span className={styles.metaText}>
            {total !== null ? `共 ${total} 条` : loading ? '正在读取…' : '总数暂不可用'}
          </span>
        }
        actions={
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={mutation.isSubmitting}
            onClick={() => void markAllRead()}
          >
            全部标为已读
          </button>
        }
      />

      <PageCard>
        {loadError ? (
          <EmptyState tone="warn" title="抄送列表暂时读不到" description={loadError} />
        ) : loading ? (
          <p className={styles.mutedText}>正在读取抄送…</p>
        ) : rows.length === 0 ? (
          <EmptyState title="暂无抄送消息" description="当前账号没有收到任何抄送。有新消息时会出现在这里。" />
        ) : (
          <>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>消息</th>
                    <th>状态</th>
                    <th>时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <div className={styles.cellTitle}>
                          <span>{row.workflowTitle ?? '流程已不存在'}</span>
                          <span className={styles.cellHint}>{row.nodeTitle ?? '—'}</span>
                        </div>
                      </td>
                      <td>
                        {row.status === 1 ? (
                          <StatusPill tone="neutral">已读</StatusPill>
                        ) : (
                          <StatusPill tone="warn">未读</StatusPill>
                        )}
                      </td>
                      <td>{formatDateTime(row.createdAt) ?? '—'}</td>
                      <td>
                        <Link className={styles.linkButton} to={`/tasks/cc?id=${row.id}`}>
                          查看
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className={styles.pager}>
              <button
                type="button"
                className={styles.secondaryButton}
                disabled={page <= 1 || loading}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
              >
                上一页
              </button>
              <span className={styles.metaText}>{totalPages !== null ? `第 ${page} / ${totalPages} 页` : ''}</span>
              <button
                type="button"
                className={styles.secondaryButton}
                disabled={totalPages === null || page >= totalPages || loading}
                onClick={() => setPage((value) => value + 1)}
              >
                下一页
              </button>
            </div>
          </>
        )}
        {notice ? <p className={styles.successText}>{notice}</p> : null}
        {mutation.message ? <p className={styles.errorText}>{mutation.message}</p> : null}
      </PageCard>
    </div>
  );
}
