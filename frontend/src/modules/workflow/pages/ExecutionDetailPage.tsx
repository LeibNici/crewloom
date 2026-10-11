import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../../../api/client';
import { toUserMessage } from '../../../api/errors';
import { DefinitionRow, EmptyState, PageCard, PageHeader, StatusPill } from '../../../components/Card';
import { useMutation } from '../useMutation';
import { formatDateTime, formatDuration, humanizeType, stringifyJson } from '../format';
import { EXECUTION_REASON_LABELS, executionStatusLabel, jobStatusLabel } from '../labels';
import { fetchExecution, fetchJobs, type ExecutionRow, type JobRow } from '../domain';
import styles from '../workflow.module.css';

/** 原生语义：只有"排队中/进行中"才允许取消（源码 `executions:cancel` 的前置状态）。 */
function isRunning(status: number | null): boolean {
  return status === null || status === 0;
}

/**
 * WF-05 执行详情。
 *
 * - 执行详情 + 本执行的节点级作业（jobs），显示每个节点的输入（meta）与输出（result）；
 * - 关联流程版本：执行绑定的是具体版本（`workflowId`），不是 `key`；
 * - 取消：仅对"排队中/进行中"的执行显示，服务端已有 `executions:cancel`，是真实动作；
 * - 删除记录：`executions:destroy` 存在，但语义是移除执行记录，文案如实说明；
 * - **没有**重试/恢复端点（`workflow:recover` 是应用事件不是资源动作），因此界面不提供"重试"按钮。
 * - 作业列表只取本次执行，不做递归展开。
 */
export function ExecutionDetailPage() {
  const [params] = useSearchParams();
  const id = params.get('id') ?? '';
  const [execution, setExecution] = useState<ExecutionRow | null>(null);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmDestroy, setConfirmDestroy] = useState(false);
  const mutation = useMutation();

  const load = useCallback(async () => {
    if (!id) {
      setLoading(false);
      setLoadError('没有指定要查看的执行记录。');
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const [detail, jobRows] = await Promise.all([fetchExecution(id), fetchJobs(id)]);
      setExecution(detail);
      setJobs(jobRows);
      if (!detail) setLoadError('这条执行记录不存在，可能已被删除。');
    } catch (error) {
      setExecution(null);
      setJobs([]);
      setLoadError(toUserMessage(error));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const cancelExecution = async () => {
    setConfirmCancel(false);
    const result = await mutation.run(() =>
      api.resourceAction('executions', 'cancel', { params: { filterByTk: id } }),
    );
    if (result !== null) {
      setNotice('已请求取消这次执行；等待它真正停止可能需要一点时间，可稍后刷新查看。');
      await load();
    }
  };

  const destroyExecution = async () => {
    setConfirmDestroy(false);
    const result = await mutation.run(() =>
      api.resourceAction('executions', 'destroy', { params: { filterByTk: id } }),
    );
    if (result !== null) {
      setNotice('已删除这条执行记录。');
      await load();
    }
  };

  if (loading) {
    return (
      <PageCard title="执行详情">
        <p className={styles.mutedText}>正在读取执行详情…</p>
      </PageCard>
    );
  }

  if (loadError || !execution) {
    return (
      <div className={styles.stack}>
        <PageHeader title="执行详情" description="查看某次执行的节点级过程。" />
        <EmptyState tone="warn" title="执行详情暂时读不到" description={loadError ?? '没有找到这条执行记录。'} />
        <Link className={styles.secondaryButton} to="/workflow/executions">
          返回执行记录
        </Link>
      </div>
    );
  }

  const statusLabel = executionStatusLabel(execution.status);
  const running = isRunning(execution.status);

  return (
    <div className={styles.stack}>
      <PageHeader
        title={`执行 #${execution.id}`}
        description="本次执行的流程版本、状态与每个节点的处理结果。"
        meta={
          <div className={styles.tagRow}>
            <StatusPill tone={statusLabel.tone}>{statusLabel.label}</StatusPill>
            {execution.reason ? <span className={styles.metaText}>结束原因：{EXECUTION_REASON_LABELS[execution.reason] ?? execution.reason}</span> : null}
          </div>
        }
        actions={
          <Link className={styles.secondaryButton} to="/workflow/executions">
            返回列表
          </Link>
        }
      />

      <PageCard title="基本信息">
        <DefinitionRow term="流程版本">
          {execution.workflowTitle ?? '（流程已不存在）'}
          {execution.workflowId ? ` ／ 版本 #${execution.workflowId}` : ''}
        </DefinitionRow>
        {execution.workflowKey ? <DefinitionRow term="流程标识">{execution.workflowKey}</DefinitionRow> : null}
        <DefinitionRow term="触发时间">{formatDateTime(execution.createdAt) ?? '—'}</DefinitionRow>
        <DefinitionRow term="开始执行">{formatDateTime(execution.startedAt) ?? '—'}</DefinitionRow>
        <DefinitionRow term="结束时间">{formatDateTime(execution.finishedAt) ?? '—'}</DefinitionRow>
        <DefinitionRow term="耗时">{formatDuration(execution.startedAt, execution.finishedAt) ?? '—'}</DefinitionRow>
        <DefinitionRow term="最近更新">{formatDateTime(execution.updatedAt) ?? '—'}</DefinitionRow>
      </PageCard>

      <PageCard
        title="节点处理结果"
        description="按处理顺序列出本次执行的每个节点。输入与输出是保存的原始结构，仅管理员或排障时查看。"
      >
        {jobs.length === 0 ? (
          <EmptyState
            title="这次执行还没有节点记录"
            description="执行可能刚开始，或该流程在触发阶段就结束了。"
          />
        ) : (
          <div className={styles.jobList}>
            {jobs.map((job, index) => {
              const jobLabel = jobStatusLabel(job.status);
              return (
                <div key={job.id} className={styles.jobItem}>
                  <div className={styles.jobHeader}>
                    <span className={styles.jobIndex}>第 {index + 1} 步</span>
                    <span className={styles.jobTitle}>{humanizeType(job.raw.type as string | null)}</span>
                    <StatusPill tone={jobLabel.tone}>{jobLabel.label}</StatusPill>
                    <span className={styles.cellHint}>
                      {formatDateTime(job.startedAt ?? job.updatedAt) ?? '—'}
                    </span>
                  </div>
                  <details className={styles.jsonDetails}>
                    <summary>查看输入数据</summary>
                    <pre className={styles.jsonBlock}>{stringifyJson(job.meta) || '（无）'}</pre>
                  </details>
                  <details className={styles.jsonDetails}>
                    <summary>查看输出结果</summary>
                    <pre className={styles.jsonBlock}>{stringifyJson(job.result) || '（无）'}</pre>
                  </details>
                  {job.log ? (
                    <details className={styles.jsonDetails}>
                      <summary>查看处理日志</summary>
                      <pre className={styles.jsonBlock}>{job.log}</pre>
                    </details>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </PageCard>

      <PageCard title="执行管理" description="取消用于让仍在运行或排队的执行停下来；删除会移除这条执行记录。">
        <div className={styles.formActions}>
          {running ? (
            <button type="button" className={styles.primaryButton} onClick={() => setConfirmCancel(true)}>
              取消这次执行
            </button>
          ) : (
            <span className={styles.metaText}>这次执行已经结束，不能再取消。</span>
          )}
          <button type="button" className={styles.dangerButton} onClick={() => setConfirmDestroy(true)}>
            删除执行记录
          </button>
        </div>
        <p className={styles.cellHint}>
          没有"重试"或"从头恢复"功能：当前版本没有提供这类操作，需要重新执行时请从流程本身再次触发。
        </p>
      </PageCard>

      {confirmCancel ? (
        <PageCard title="确认取消" tone="muted">
          <p className={styles.bodyText}>取消后这次执行会停止，已经完成的节点不会回退。</p>
          <div className={styles.formActions}>
            <button
              type="button"
              className={styles.primaryButton}
              disabled={mutation.isSubmitting}
              onClick={() => void cancelExecution()}
            >
              确认取消
            </button>
            <button type="button" className={styles.secondaryButton} onClick={() => setConfirmCancel(false)}>
              放弃
            </button>
          </div>
        </PageCard>
      ) : null}

      {confirmDestroy ? (
        <PageCard title="确认删除执行记录" tone="muted">
          <p className={styles.bodyText}>删除后这条执行记录与它的节点结果将无法再查看，无法恢复。</p>
          <div className={styles.formActions}>
            <button
              type="button"
              className={styles.dangerButton}
              disabled={mutation.isSubmitting}
              onClick={() => void destroyExecution()}
            >
              确认删除
            </button>
            <button type="button" className={styles.secondaryButton} onClick={() => setConfirmDestroy(false)}>
              放弃
            </button>
          </div>
        </PageCard>
      ) : null}

      {notice ? <p className={styles.successText}>{notice}</p> : null}
      {mutation.message ? <p className={styles.errorText}>{mutation.message}</p> : null}
    </div>
  );
}
