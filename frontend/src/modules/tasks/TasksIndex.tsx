import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { ModuleDefinition } from '../types';
import { EmptyState, PageCard, PageHeader, StatusPill } from '../../components/Card';
import { fetchAiUnreadCount, fetchTaskStats, type TaskStatsSummary } from './domain';
import styles from './tasks.module.css';

/**
 * 任务与待办模块首页。
 *
 * 只做真实读取：本人工作流待处理统计（按流程汇总）与 AI 未读数，
 * 再给出三个来源的真实入口。读取失败或未配置时如实显示，不用 0 冒充。
 */
export function TasksIndex({ module }: { module: ModuleDefinition }) {
  const [stats, setStats] = useState<TaskStatsSummary | null>(null);
  const [unread, setUnread] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setFailed(false);
      try {
        const summary = await fetchTaskStats();
        if (alive) setStats(summary);
      } catch {
        if (alive) {
          setStats(null);
          setFailed(true);
        }
      }
      try {
        const count = await fetchAiUnreadCount();
        if (alive) setUnread(count);
      } catch {
        if (alive) setUnread(null);
      }
      if (alive) setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className={styles.stack}>
      <PageHeader title={module.title} description={module.subtitle} />
      <PageCard title="当前待处理" description="数据来自后端实时查询，不显示内置示例数据。">
        {loading ? (
          <p className={styles.mutedText}>正在读取待处理统计…</p>
        ) : failed && stats === null ? (
          <EmptyState
            tone="warn"
            title="暂时读不到待处理统计"
            description="可能是网络或权限问题。可以稍后重试，或直接进入下面的待办列表。"
          />
        ) : (
          <div className={styles.statRow}>
            <div className={styles.statBlock}>
              <span className={styles.statLabel}>本人工作流待处理（人工处理 + 抄送，按流程汇总）</span>
              <span className={styles.statValue}>{stats ? stats.pendingTotal : 0}</span>
              <span className={styles.cellHint}>
                {stats ? `共涉及 ${stats.workflowCount} 个流程` : '统计暂不可用'}
              </span>
            </div>
            <div className={styles.statBlock}>
              <span className={styles.statLabel}>AI 任务未读</span>
              <span className={styles.statValue}>{unread ?? 0}</span>
              <span className={styles.cellHint}>{unread === null ? '未读数暂不可用' : '来自 AI 员工任务'}</span>
            </div>
          </div>
        )}
      </PageCard>

      <PageCard title="进入各来源" description="三个来源分别分页，互不混合。">
        <div className={styles.boardList}>
          <div className={styles.boardRow}>
            <div className={styles.boardRowText}>
              <span className={styles.boardRowTitle}>我的待处理</span>
              <span className={styles.boardRowDescription}>人工处理、抄送与 AI 任务三个来源。</span>
            </div>
            <Link className={styles.secondaryButton} to="/tasks/pending">
              进入
            </Link>
          </div>
          <div className={styles.boardRow}>
            <div className={styles.boardRowText}>
              <span className={styles.boardRowTitle}>抄送我的</span>
              <span className={styles.boardRowDescription}>
                查看收到的抄送消息。标记已读不会推进流程。
              </span>
            </div>
            <Link className={styles.secondaryButton} to="/tasks/cc-list">
              进入
            </Link>
          </div>
          <div className={styles.boardRow}>
            <div className={styles.boardRowText}>
              <span className={styles.boardRowTitle}>已处理</span>
              <span className={styles.boardRowDescription}>
                按来源查看累计数量与待处理数量。
              </span>
            </div>
            <Link className={styles.secondaryButton} to="/tasks/processed">
              进入
            </Link>
          </div>
          <div className={styles.boardRow}>
            <div className={styles.boardRowText}>
              <span className={styles.boardRowTitle}>专业审批</span>
              <span className={styles.boardRowDescription}>当前后端未提供审批能力。</span>
            </div>
            <StatusPill tone="warn">能力未开通</StatusPill>
          </div>
        </div>
      </PageCard>
    </div>
  );
}
