import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { useSessionStore } from '../../auth/store';
import { PageCard, PageHeader, StatusPill } from '../../components/Card';
import { CrewloomError, toUserMessage } from '../../api/errors';
import type { ResourceState } from '../../api/hooks';
import { decideAccess, resolveBoardVisibility } from '../../permissions/modules';
import type { ModuleDefinition, ModulePageProps } from '../types';
import styles from './ui.module.css';

/**
 * 组 B 组内展示组件（**非公共平台**，不对外导出为通用能力）。
 *
 * 为什么放在 access 目录：DS 与 AC 两个模块同属组 B，共用一套表格/表单/弹层外观，
 * 避免两份实现漂移。这里只有**展示**逻辑；请求一律走 `src/api/client.ts` 的既有管线，
 * 不新建请求通道、不做字段推断、不做代码生成，也不替代既有原生表单/筛选工具。
 */

function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// 状态展示
// ---------------------------------------------------------------------------

export function Banner({
  tone = 'info',
  children,
  actions,
}: {
  tone?: 'info' | 'ok' | 'warn' | 'danger';
  children: ReactNode;
  actions?: ReactNode;
}) {
  const toneClass =
    tone === 'ok'
      ? styles.bannerOk
      : tone === 'warn'
        ? styles.bannerWarn
        : tone === 'danger'
          ? styles.bannerDanger
          : styles.bannerInfo;
  return (
    <div className={cx(styles.banner, toneClass)} role={tone === 'danger' ? 'alert' : 'status'}>
      <div style={{ flex: '1 1 auto' }}>{children}</div>
      {actions}
    </div>
  );
}

const STATE_TITLES: Record<ResourceState, string> = {
  loading: '正在读取',
  ready: '',
  empty: '暂无数据',
  denied: '没有查看权限',
  unauthorized: '登录状态需要重新确认',
  error: '暂时无法读取',
};

export interface StateViewProps {
  state: ResourceState;
  message?: string | null;
  onRetry?: () => void;
  emptyTitle?: string;
  emptyDescription?: ReactNode;
  deniedDescription?: ReactNode;
  errorDescription?: ReactNode;
  loadingText?: string;
}

/**
 * 六态展示：`empty`/`denied`/`unauthorized`/`error` 各自独立文案，绝不混同。
 * 原始报错码与服务端消息一律不展示给用户。
 */
export function StateView({
  state,
  message,
  onRetry,
  emptyTitle,
  emptyDescription,
  deniedDescription,
  errorDescription,
  loadingText,
}: StateViewProps) {
  if (state === 'ready') return null;

  const title = state === 'empty' && emptyTitle ? emptyTitle : STATE_TITLES[state];
  const description =
    state === 'empty'
      ? emptyDescription
      : state === 'denied'
        ? (deniedDescription ?? '当前账号没有查看这部分内容的权限。如确需使用，请联系管理员调整角色或权限。')
        : state === 'error'
          ? (errorDescription ?? message ?? '暂时无法读取，请稍后重试。')
          : state === 'unauthorized'
            ? '登录状态已变化，请重新登录或刷新页面后再试。'
            : loadingText;

  if (state === 'loading') {
    return (
      <p className={styles.notice} role="status">
        {loadingText ?? '正在读取…'}
      </p>
    );
  }

  return (
    <div className={styles.stateBlock}>
      <span className={styles.stateTitle}>{title}</span>
      {description ? <span className={styles.stateText}>{description}</span> : null}
      {onRetry && (state === 'error' || state === 'denied' || state === 'empty') ? (
        <button type="button" className={styles.button} onClick={onRetry}>
          重新读取
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 页面骨架：权限门 + 标题 + 组内页签
// ---------------------------------------------------------------------------

/** 页面级权限门：与公共占位页使用同一套三态判定（allowed / denied / unknown）。 */
export function BoardGate({
  module,
  board,
  children,
}: ModulePageProps & { children: ReactNode }) {
  const access = useSessionStore((state) => state.access);
  const probes = useSessionStore((state) => state.probes);
  const decision = useMemo(
    () => decideAccess(access, board.access, board.probeId ?? module.probeId, probes),
    [access, board, module.probeId, probes],
  );

  if (decision.allowed) return <>{children}</>;

  const unknown = decision.status === 'unknown';
  return (
    <PageCard title={unknown ? '暂时无法确认这个页面的权限' : '当前角色无法打开这个页面'}>
      <p className={styles.stateText}>
        {unknown
          ? '当前未能从服务得到明确的权限结果，可能是网络不稳定或服务正在启动。请稍后重试。'
          : '你可以切换到其他角色，或联系管理员为你的账号补充授权后再试。'}
      </p>
    </PageCard>
  );
}

/**
 * 组内页签：只显示当前角色可用、且**可直接打开**的兄弟页面。
 *
 * 两条硬规则：
 *  - 带参数的详情页（`users/:id`、`roles/:name` 这类）不进页签：它们的路径片段本身就是参数，
 *    渲染成链接会得到 `/access/users/:id` 这种点不动的死链；详情应从列表里选一条记录进入。
 *  - 页签是否"当前"只看路径是否**完全相同**，不再用 `startsWith(target + '/')`：
 *    否则在 `/access/users/2` 详情页上，标题为"用户"的列表页签会被判为当前，
 *    链接被改写成当前地址，点它反而停在详情页而不是回到 `/access/users` 列表。
 */
export function ModuleTabs({ module }: { module: ModuleDefinition }) {
  const access = useSessionStore((state) => state.access);
  const probes = useSessionStore((state) => state.probes);
  const location = useLocation();
  const visible = useMemo(
    () =>
      resolveBoardVisibility(access, module, probes).filter(
        (item) => item.decision.allowed && item.board.Component && !item.board.path.includes(':'),
      ),
    [access, module, probes],
  );
  if (visible.length <= 1) return null;

  const current = location.pathname;
  return (
    <nav className={styles.tabs} aria-label={`${module.title}页面`}>
      {visible.map(({ board }) => {
        const target = `${module.path}/${board.path}`;
        const active = current === target;
        return (
          <Link
            key={board.path}
            to={target}
            className={cx(styles.tab, active && styles.tabActive)}
            aria-current={active ? 'page' : undefined}
          >
            {board.title}
          </Link>
        );
      })}
    </nav>
  );
}

export interface BoardPageProps extends ModulePageProps {
  children: ReactNode;
  headerActions?: ReactNode;
  headerMeta?: ReactNode;
}

/** 组内页面统一外壳：权限门 → 标题与说明 → 页签 → 内容。 */
export function BoardPage({ module, board, children, headerActions, headerMeta }: BoardPageProps) {
  return (
    <BoardGate module={module} board={board}>
      <div className={styles.stack}>
        <PageHeader
          title={board.title}
          description={board.description}
          meta={headerMeta ? <StatusPill tone="brand">{headerMeta}</StatusPill> : undefined}
          actions={headerActions}
        />
        <ModuleTabs module={module} />
        {children}
      </div>
    </BoardGate>
  );
}

// ---------------------------------------------------------------------------
// 表格与分页
// ---------------------------------------------------------------------------

export interface Column<T> {
  key: string;
  title: ReactNode;
  render?: (row: T, index: number) => ReactNode;
  width?: string | number;
  align?: 'left' | 'right';
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  activeKey,
  emptyText = '暂无数据',
  caption,
}: {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T, index: number) => string | number;
  onRowClick?: (row: T) => void;
  activeKey?: string | number | null;
  emptyText?: string;
  caption?: ReactNode;
}) {
  if (rows.length === 0) {
    return <p className={styles.notice}>{emptyText}</p>;
  }
  return (
    <div className={styles.tableScroll}>
      <table className={styles.table}>
        {caption ? <caption className="srOnly">{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} style={{ width: column.width, textAlign: column.align ?? 'left' }}>
                {column.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const key = rowKey(row, index);
            return (
              <tr
                key={key}
                data-clickable={onRowClick ? 'true' : 'false'}
                className={activeKey !== undefined && activeKey === key ? styles.rowActive : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {columns.map((column) => (
                  <td key={column.key} style={{ textAlign: column.align ?? 'left' }}>
                    {column.render ? column.render(row, index) : formatCell(readCell(row, column.key))}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function readCell(row: unknown, key: string): unknown {
  if (!row || typeof row !== 'object') return undefined;
  return (row as Record<string, unknown>)[key];
}

/** 单元格默认渲染：空值、布尔、对象都有可读表达，不显示内部错误码。 */
export function formatCell(value: unknown): ReactNode {
  if (value === null || value === undefined || value === '') return <span className={styles.cellMuted}>—</span>;
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (Array.isArray(value)) return value.length === 0 ? <span className={styles.cellMuted}>—</span> : value.map((item) => formatCell(item)).join('、');
  if (typeof value === 'object') return <span className={styles.cellMono}>{compactJson(value)}</span>;
  return String(value);
}

export function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 20, 50, 100],
}: {
  page: number;
  pageSize: number;
  total: number | null;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  pageSizeOptions?: number[];
}) {
  const totalPages = total !== null && pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : null;
  return (
    <div className={styles.pagination}>
      <span>
        {total === null ? `第 ${page} 页` : `共 ${total} 条，第 ${page} / ${totalPages} 页`}
      </span>
      <button type="button" className={styles.button} disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
        上一页
      </button>
      <button
        type="button"
        className={styles.button}
        disabled={totalPages !== null && page >= totalPages}
        onClick={() => onPageChange(page + 1)}
      >
        下一页
      </button>
      {onPageSizeChange ? (
        <label className={styles.field} style={{ maxWidth: 150 }}>
          <span className={styles.label}>每页条数</span>
          <select
            className={styles.select}
            value={pageSize}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
          >
            {pageSizeOptions.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 表单零件
// ---------------------------------------------------------------------------

export function Field({
  label,
  hint,
  required,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  required?: boolean;
  children: ReactNode;
}) {
  const id = useMemo(() => `f-${Math.random().toString(36).slice(2, 9)}`, []);
  return (
    <label className={styles.field} htmlFor={id}>
      <span className={cx(styles.label, required && styles.required)}>{label}</span>
      {children}
      {hint ? <span className={styles.hint}>{hint}</span> : null}
    </label>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  type = 'text',
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  disabled?: boolean;
}) {
  return (
    <input
      className={styles.input}
      type={type}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export function TextArea({
  value,
  onChange,
  placeholder,
  rows,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <textarea
      className={styles.textarea}
      rows={rows}
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export function SelectInput<T extends string | number>({
  value,
  options,
  onChange,
  disabled,
  placeholder,
  allowEmpty,
}: {
  value: T | '';
  options: Array<{ value: T; label: string }>;
  onChange: (value: T | '') => void;
  disabled?: boolean;
  placeholder?: string;
  allowEmpty?: boolean;
}) {
  return (
    <select
      className={styles.select}
      value={value === '' ? '' : String(value)}
      disabled={disabled}
      onChange={(event) => {
        const raw = event.target.value;
        if (raw === '') {
          onChange('');
          return;
        }
        const match = options.find((option) => String(option.value) === raw);
        onChange(match ? match.value : (raw as T));
      }}
    >
      {allowEmpty ? <option value="">{placeholder ?? '全部'}</option> : null}
      {!allowEmpty && placeholder ? (
        <option value="" disabled>
          {placeholder}
        </option>
      ) : null}
      {options.map((option) => (
        <option key={String(option.value)} value={String(option.value)}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function CheckboxInput({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={styles.checkboxRow}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  wide,
}: {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className={styles.modalBackdrop}
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={cx(styles.modal, wide && styles.modalWide)} role="dialog" aria-modal="true" aria-label={String(title)}>
        <div className={styles.modalHeader}>
          <div>
            <div className={styles.modalTitle}>{title}</div>
            {description ? <div className={styles.modalDescription}>{description}</div> : null}
          </div>
          <button type="button" className={styles.button} onClick={onClose}>
            关闭
          </button>
        </div>
        {children}
        {footer ? <div className={styles.modalFooter}>{footer}</div> : null}
      </div>
    </div>
  );
}

export function MetaGrid({ rows }: { rows: Array<{ term: ReactNode; value: ReactNode }> }) {
  return (
    <div className={styles.metaGrid}>
      {rows.map((row, index) => (
        <div className={styles.metaRow} key={index}>
          <span className={styles.metaTerm}>{row.term}</span>
          <span className={styles.metaValue}>{row.value}</span>
        </div>
      ))}
    </div>
  );
}

export function JsonView({ value, label }: { value: unknown; label?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const text = useMemo(() => {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }, [value]);
  return (
    <div className={styles.stack} style={{ gap: 6 }}>
      <button type="button" className={cx(styles.button, styles.buttonLink)} onClick={() => setOpen((prev) => !prev)}>
        {open ? '收起' : '展开'}
        {label ? ` ${String(label)}` : ''}
      </button>
      {open ? <pre className={styles.codeBlock}>{text}</pre> : null}
    </div>
  );
}

export function Chip({
  children,
  onRemove,
  muted,
}: {
  children: ReactNode;
  onRemove?: () => void;
  muted?: boolean;
}) {
  return (
    <span className={cx(styles.chip, muted && styles.chipMuted)}>
      {children}
      {onRemove ? (
        <button type="button" className={styles.chipRemove} aria-label="移除" onClick={onRemove}>
          ✕
        </button>
      ) : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// 异步动作
// ---------------------------------------------------------------------------

export interface AsyncActionState {
  pending: boolean;
  /** 面向用户的中文提示（成功或失败），不包含内部错误码。 */
  message: string | null;
  tone: 'ok' | 'danger' | null;
  /** 技术细节，仅用于测试与验收断言。 */
  error: CrewloomError | null;
}

export interface AsyncActionHandle extends AsyncActionState {
  run: (task: () => Promise<unknown>, successMessage: string) => Promise<boolean>;
  reset: () => void;
}

export function useAsyncAction(): AsyncActionHandle {
  const [state, setState] = useState<AsyncActionState>({ pending: false, message: null, tone: null, error: null });

  const run = useCallback(async (task: () => Promise<unknown>, successMessage: string) => {
    setState({ pending: true, message: null, tone: null, error: null });
    try {
      await task();
      setState({ pending: false, message: successMessage, tone: 'ok', error: null });
      return true;
    } catch (error) {
      const crewloom = error instanceof CrewloomError ? error : null;
      setState({ pending: false, message: toUserMessage(error), tone: 'danger', error: crewloom });
      return false;
    }
  }, []);

  const reset = useCallback(() => {
    setState({ pending: false, message: null, tone: null, error: null });
  }, []);

  return { ...state, run, reset };
}

/** 动作结果提示条。 */
export function ActionBanner({ action }: { action: AsyncActionHandle }) {
  if (!action.message) return null;
  return <Banner tone={action.tone === 'danger' ? 'danger' : 'ok'}>{action.message}</Banner>;
}

// ---------------------------------------------------------------------------
// 其它
// ---------------------------------------------------------------------------

export function SearchBox({
  value,
  onChange,
  placeholder,
  onSubmit,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  onSubmit?: () => void;
}) {
  return (
    <form
      className={styles.field}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit?.();
      }}
    >
      <span className={styles.label}>搜索</span>
      <span style={{ display: 'flex', gap: 8 }}>
        <input
          className={styles.input}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
        <button type="submit" className={styles.button}>
          查询
        </button>
      </span>
    </form>
  );
}

export { styles as localStyles, cx };

/** 未开通 / 能力缺失的独立表达（与"空数据""无权限"分开）。 */
export function CapabilityNotice({
  title,
  reason,
  details,
  actions,
}: {
  title: string;
  reason: ReactNode;
  details?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className={styles.stateBlock}>
      <span className={styles.stateTitle}>{title}</span>
      <span className={styles.stateText}>{reason}</span>
      {details}
      {actions ? <div className={styles.formGrid}>{actions}</div> : null}
    </div>
  );
}

/** 只读键值表（用于详情页）。 */
export function KeyValueTable({ rows }: { rows: Array<{ key: string; label: ReactNode; value: ReactNode }> }) {
  return (
    <div className={styles.tableScroll}>
      <table className={styles.table}>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row" style={{ width: 200 }}>
                {row.label}
              </th>
              <td>{row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
