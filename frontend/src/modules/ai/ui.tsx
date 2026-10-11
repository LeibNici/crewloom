import type { ReactNode } from 'react';
import { EmptyState } from '../../components/Card';
import type { ResourceState } from '../../api/hooks';
import styles from './group-a.module.css';

/**
 * 组 A（AI + LM）页面共用的展示件。
 *
 * 只做本组反复需要的三件小事：统一六态提示、统一分页条、统一表单字段壳。
 * 公共卡片/状态药丸/空态继续来自 `components/Card`，这里不重复实现。
 * 本文件由组 A 独占（放在 `modules/ai/` 下），`modules/model/` 的页面同样引用它。
 */

export interface StateBlockProps {
  state: ResourceState;
  /** 中文用户文案（来自钩子或本地）。 */
  message?: string | null;
  onRetry?: () => void;
  /** 空数据时的补充说明（例如"当前账号没有可使用的员工"）。 */
  emptyTitle?: string;
  emptyDescription?: ReactNode;
  /** 只读权限不足时的补充说明。 */
  deniedDescription?: ReactNode;
  compact?: boolean;
}

/**
 * 六态提示块。
 *
 * 严格区分四类结果，绝不用同一句话糊过去：
 *  - 无权限（403）说明需要授权；
 *  - 未登录/角色失效说明需要重新登录或刷新；
 *  - 空数据说明"有权限，只是没有数据"；
 *  - 读取失败说明可以重试，并给出用户能做的动作。
 */
export function StateBlock({
  state,
  message,
  onRetry,
  emptyTitle,
  emptyDescription,
  deniedDescription,
  compact = false,
}: StateBlockProps) {
  if (state === 'ready') return null;

  if (state === 'loading') {
    return (
      <div className={styles.notice} aria-live="polite">
        正在读取数据，请稍候…
      </div>
    );
  }

  if (state === 'empty') {
    return (
      <EmptyState
        title={emptyTitle ?? '暂无数据'}
        description={emptyDescription ?? '后端返回了空结果：当前没有任何记录。'}
      />
    );
  }

  if (state === 'denied') {
    return (
      <EmptyState
        tone="warn"
        title="当前账号没有权限查看这部分内容"
        description={
          deniedDescription ??
          '你可以切换到其他角色，或联系管理员为你的账号补充授权后再试。'
        }
      />
    );
  }

  if (state === 'unauthorized') {
    return (
      <EmptyState
        tone="warn"
        title="登录状态或角色需要重新确认"
        description={
          <>
            <p>{message ?? '当前登录状态已失效，请重新登录后继续。'}</p>
            {onRetry ? (
              <button type="button" className={styles.button} onClick={onRetry}>
                重新确认
              </button>
            ) : null}
          </>
        }
      />
    );
  }

  return (
    <EmptyState
      tone="warn"
      title={compact ? '暂时无法读取' : '暂时无法读取这部分内容'}
      description={
        <>
          <p>{message ?? '服务可能正在启动或网络不稳定，请稍后重试。'}</p>
          {onRetry ? (
            <button type="button" className={styles.button} onClick={onRetry}>
              重试
            </button>
          ) : null}
        </>
      }
    />
  );
}

/** 后端分页信息（只展示后端真实返回的页数，不前端造总数）。 */
export interface PagerMeta {
  count?: number;
  page?: number;
  pageSize?: number;
  hasNext?: boolean;
}

export interface ListPagerProps {
  meta: PagerMeta;
  page: number;
  pageSize: number;
  isFetching?: boolean;
  onChange: (nextPage: number) => void;
}

/**
 * 分页条。
 *
 * 显示的"共 N 条"直接取后端 `meta.count`；`count` 缺失（部分插件的列表动作不返回）
 * 时只显示当前页与翻页按钮，不推断总数。
 */
export function ListPager({ meta, page, pageSize, isFetching, onChange }: ListPagerProps) {
  const count = typeof meta.count === 'number' ? meta.count : null;
  const totalPages = count !== null ? Math.max(1, Math.ceil(count / pageSize)) : null;
  const hasMore = meta.hasNext === true || (totalPages !== null && page < totalPages);
  const canBack = page > 1;

  return (
    <div className={styles.pager}>
      <span>
        {count !== null ? `共 ${count} 条　` : ''}第 {page} 页
        {totalPages !== null ? ` / ${totalPages}` : ''}
        {isFetching ? '　（刷新中…）' : ''}
      </span>
      <span className={styles.pagerSpacer} />
      <button
        type="button"
        className={styles.button}
        disabled={!canBack || isFetching}
        onClick={() => onChange(page - 1)}
      >
        上一页
      </button>
      <button
        type="button"
        className={styles.button}
        disabled={!hasMore || isFetching}
        onClick={() => onChange(page + 1)}
      >
        下一页
      </button>
    </div>
  );
}

export interface FieldProps {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  children: ReactNode;
}

/** 表单字段壳：标签 + 控件 + 说明/校验提示。 */
export function Field({ label, hint, error, required, children }: FieldProps) {
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </span>
      {children}
      {hint ? <span className={styles.fieldHint}>{hint}</span> : null}
      {error ? <span className={styles.fieldError}>{error}</span> : null}
    </label>
  );
}

export interface NoticeProps {
  tone?: 'info' | 'warn' | 'danger';
  children: ReactNode;
}

export function Notice({ tone = 'info', children }: NoticeProps) {
  const cls =
    tone === 'warn'
      ? `${styles.notice} ${styles.noticeWarn}`
      : tone === 'danger'
        ? `${styles.notice} ${styles.noticeDanger}`
        : styles.notice;
  return <div className={cls}>{children}</div>;
}

/** 文本输入（受控）。 */
export function TextInput({
  value,
  onChange,
  placeholder,
  disabled,
  type = 'text',
  ariaLabel,
  testId,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  disabled?: boolean;
  type?: 'text' | 'password' | 'number';
  ariaLabel?: string;
  /** 受控自动化核对用的定位标记；不展示给用户。 */
  testId?: string;
}) {
  return (
    <input
      className={styles.input}
      type={type}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={ariaLabel}
      data-testid={testId}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/** 多行输入（受控）。 */
export function TextArea({
  value,
  onChange,
  placeholder,
  disabled,
  rows,
  ariaLabel,
  testId,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  disabled?: boolean;
  rows?: number;
  ariaLabel?: string;
  /** 受控自动化核对用的定位标记；不展示给用户。 */
  testId?: string;
}) {
  return (
    <textarea
      className={styles.textarea}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      rows={rows}
      aria-label={ariaLabel}
      data-testid={testId}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/** 复选（受控）。 */
export function Checkbox({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <label className={styles.checkboxRow}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}

/** 下拉选择（受控）。 */
export function Select({
  value,
  onChange,
  options,
  disabled,
  placeholder,
  ariaLabel,
  inline,
  testId,
}: {
  value: string;
  onChange: (next: string) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  inline?: boolean;
  /** 受控自动化核对用的定位标记；不展示给用户。 */
  testId?: string;
}) {
  return (
    <select
      className={inline ? `${styles.select} ${styles.selectInline}` : styles.select}
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      data-testid={testId}
      onChange={(event) => onChange(event.target.value)}
    >
      {placeholder ? <option value="">{placeholder}</option> : null}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** 空值占位（列表里统一显示，不展示 undefined/null）。 */
export function orDash(value: unknown): ReactNode {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value);
}

/** 时间展示：只做本地化，不伪造。 */
export function formatTime(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}
