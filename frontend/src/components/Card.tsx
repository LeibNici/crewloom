import type { ReactNode } from 'react';
import styles from './Card.module.css';

interface PageCardProps {
  title?: ReactNode;
  description?: ReactNode;
  /** 右上角操作区。 */
  actions?: ReactNode;
  children?: ReactNode;
  tone?: 'default' | 'muted';
}

export function PageCard({ title, description, actions, children, tone = 'default' }: PageCardProps) {
  return (
    <section className={tone === 'muted' ? `${styles.card} ${styles.cardMuted}` : styles.card}>
      {title || actions ? (
        <header className={styles.cardHeader}>
          <div className={styles.cardHeading}>
            {title ? <h2 className={styles.cardTitle}>{title}</h2> : null}
            {description ? <p className={styles.cardDescription}>{description}</p> : null}
          </div>
          {actions ? <div className={styles.cardActions}>{actions}</div> : null}
        </header>
      ) : null}
      <div className={styles.cardBody}>{children}</div>
    </section>
  );
}

interface PageHeaderProps {
  title: string;
  description?: ReactNode;
  /** 附加说明，例如"该能力在后续阶段提供"。 */
  meta?: ReactNode;
  actions?: ReactNode;
}

export function PageHeader({ title, description, meta, actions }: PageHeaderProps) {
  return (
    <div className={styles.pageHeader}>
      <div>
        <h2 className={styles.pageTitle}>{title}</h2>
        {description ? <p className={styles.pageDescription}>{description}</p> : null}
        {meta ? <div className={styles.pageMeta}>{meta}</div> : null}
      </div>
      {actions ? <div className={styles.pageActions}>{actions}</div> : null}
    </div>
  );
}

interface StatusPillProps {
  tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'brand';
  children: ReactNode;
}

export function StatusPill({ tone = 'neutral', children }: StatusPillProps) {
  return <span className={`${styles.pill} ${styles[`pill_${tone}`]}`}>{children}</span>;
}

export function RoleBadge({ role, label }: { role: string; label?: string }) {
  return <StatusPill tone="brand">{label ?? role}</StatusPill>;
}

interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  /**
   * `neutral` 空数据；`warn` 需要注意（如权限/失败）；`info` 能力未开通（不是错误，也不是空数据）。
   */
  tone?: 'neutral' | 'warn' | 'info';
}

export function EmptyState({ title, description, actions, tone = 'neutral' }: EmptyStateProps) {
  const toneClass = tone === 'warn' ? styles.emptyWarn : tone === 'info' ? styles.emptyInfo : '';
  return (
    <div className={toneClass ? `${styles.empty} ${toneClass}` : styles.empty}>
      <h3 className={styles.emptyTitle}>{title}</h3>
      {description ? <div className={styles.emptyText}>{description}</div> : null}
      {actions ? <div className={styles.emptyActions}>{actions}</div> : null}
    </div>
  );
}

interface UnavailableStateProps {
  /** 能力名称，例如"知识库"。 */
  title: string;
  /** 给非技术用户看的说明：为什么用不了、可以怎么办。 */
  reason: ReactNode;
  /** 可选补充（例如"这一项与'暂时没有数据'不同"）。 */
  hint?: ReactNode;
  actions?: ReactNode;
}

/**
 * "能力未开通"独立态（PUB-05）。
 *
 * 与空数据、无权限、请求失败三种状态并列且样式不同：
 * 空数据是"有权限但暂时没有记录"，无权限是"你的角色看不到"，
 * 请求失败是"这次没读成功，可以重试"，而这里是**后端确实没有这项能力**，
 * 重试也不会变化。三个模块（知识库 / 专业审批 / 外部连接器）用它统一呈现。
 */
export function UnavailableState({ title, reason, hint, actions }: UnavailableStateProps) {
  return (
    <EmptyState
      tone="info"
      title={`${title}暂未开通`}
      description={
        <>
          <p>{reason}</p>
          {hint ? <p className={styles.emptyHint}>{hint}</p> : null}
        </>
      }
      actions={actions}
    />
  );
}

export function AccessDeniedNotice({ reason }: { reason?: ReactNode }) {
  return (
    <div className={styles.notice}>
      <p className={styles.noticeText}>{reason}</p>
    </div>
  );
}

interface StatTileProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}

export function StatTile({ label, value, hint }: StatTileProps) {
  return (
    <div className={styles.stat}>
      <span className={styles.statLabel}>{label}</span>
      <strong className={styles.statValue}>{value}</strong>
      {hint ? <span className={styles.statHint}>{hint}</span> : null}
    </div>
  );
}

export function DefinitionRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className={styles.definitionRow}>
      <span className={styles.definitionTerm}>{term}</span>
      <span className={styles.definitionValue}>{children}</span>
    </div>
  );
}
