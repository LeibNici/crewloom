import { useMemo, useState, type ReactNode } from 'react';
import {
  ActionBanner,
  Banner,
  CapabilityNotice,
  Pagination,
  SearchBox,
  StateView,
  localStyles as styles,
  type AsyncActionHandle,
} from './ui';
import type { AssociationAvailability, AssociatedListResult } from './operations';

/**
 * 关联维护编辑器（AC-06 四个方向共用）。
 *
 * 为什么需要它：部门↔成员、部门↔角色、用户↔部门、角色↔部门是**同一形状**的关联资源
 * （父记录标识在路径里、请求体是裸标识数组、`add|remove|set` 三种语义），
 * 四个方向各写一遍表格/候选/分页会出现四份可能漂移的实现。
 *
 * 这里只做展示与交互；请求一律由调用方传入的 `operations.ts` 类型化函数发出，
 * 仍然只走 `src/api/client.ts` 那一条 SDK 管线。
 *
 * 三种写语义（四方向一致，不混用）：
 *  - `add`：只把所选**加入**，不动既有项；
 *  - `remove`：只**移除**所选（或行内单项）；
 *  - `set`：**整体替换**。点击后出现完整名单面板，默认勾选"当前已关联 + 本次所选"，
 *    用户可以取消其中任何一项，提交的就是面板里的最终名单（原生 `set` 语义）；
 *    最终名单为空时按钮变成「确认清空全部」并给出不可撤销提示，另有独立的「清空全部」确认。
 *
 * 因为 `set`/`clear` 需要"当前到底关联了谁"的**完整名单**，页面必须用
 * `useCompleteAssociatedList`（按分页读完）提供 `current`；没读完整时这里禁用全部写操作，
 * 避免用不完整的集合算出目标名单而误删。
 *
 * 能力归因（**不做永久硬编码**）：当前列表或候选列表的失败若属于"关联路由没有注册"
 * （插件停用时的 500/404），显示 `unavailable` 说明；接口一旦真实可用，就直接渲染
 * 可用的关联视图与写操作，不再显示"未开通"。
 */

export interface RelationRowView {
  /** 稳定键（真实主键）。 */
  key: string | number;
  /** 主标题。 */
  title: ReactNode;
  /** 次要说明。 */
  meta?: ReactNode;
}

export interface RelationUnavailableNotice {
  title: string;
  reason: ReactNode;
  details?: ReactNode;
}

export interface RelationEditorProps<T, C> {
  /** 当前已关联记录（含六态与分页信息；`complete` 表示是否已读完整集合）。 */
  current: AssociatedListResult<T> & { complete?: boolean };
  renderCurrent: (row: T) => RelationRowView;
  /** 候选记录（含六态、分页、搜索）。 */
  candidates: AssociatedListResult<C>;
  renderCandidate: (row: C) => RelationRowView;
  candidateKeyword: string;
  onCandidateKeyword: (next: string) => void;
  candidatePage: number;
  onCandidatePage: (next: number) => void;
  candidatePageSize?: number;
  /** 写动作；由调用方给出**精确的**关联路径包装函数。 */
  onAdd: (ids: Array<string | number>) => Promise<void>;
  onRemove: (ids: Array<string | number>) => Promise<void>;
  onSet: (ids: Array<string | number>) => Promise<void>;
  /** 文案。 */
  addLabel: string;
  setLabel: string;
  emptyCurrentText: string;
  deniedText: string;
  unavailable: RelationUnavailableNotice;
  /** 是否允许修改（权限/只读）。 */
  editable?: boolean;
  pending?: boolean;
  action?: AsyncActionHandle;
  /** 单行附加操作（例如"设为主部门"）。 */
  renderRowExtra?: (row: T) => ReactNode;
  hint?: ReactNode;
  /**
   * 关联能力当前归因；由 `associationAvailability()` 得到。
   *
   * 注意 `unavailable`（能力未开通）与 `read-error`（能力已开通但这次读取失败）
   * 是**两件事**，页面文案与操作入口都不同，不能合并。
   */
  availability: AssociationAvailability;
  /**
   * 容器标记（`data-testid`）。
   *
   * 同一页面上会同时出现两个关联编辑器（部门→成员 / 部门→角色），
   * 受控 UI 脚本需要按编辑器定位控件，不能靠"第几个移除按钮"这种脆弱顺序。
   */
  testId?: string;
}

export function RelationEditor<T, C>({  current,
  renderCurrent,
  candidates,
  renderCandidate,
  candidateKeyword,
  onCandidateKeyword,
  candidatePage,
  onCandidatePage,
  candidatePageSize = 10,
  onAdd,
  onRemove,
  onSet,
  addLabel,
  setLabel,
  emptyCurrentText,
  deniedText,
  unavailable,
  editable = true,
  pending = false,
  action,
  renderRowExtra,
  hint,
  availability,
  testId,
}: RelationEditorProps<T, C>) {
  const [selectedCandidates, setSelectedCandidates] = useState<Array<string | number>>([]);
  /**
   * 整体替换 = **一次明确的完整名单选择**，不是固定并集：
   *  - 打开面板时默认勾选「当前已关联」+「本次所选」，但用户可以取消其中任何一项；
   *  - 提交的就是面板里勾选的最终名单（原生 `set` 语义：整体替换为该名单）；
   *  - 清空全部是同一面板的极端情况（最终 0 项），必须再显式确认一次。
   */
  const [confirm, setConfirm] = useState<'set' | 'clear' | null>(null);
  const [setSelection, setSetSelection] = useState<Array<string | number>>([]);
  const [busyRow, setBusyRow] = useState<string | number | null>(null);
  const [keywordDraft, setKeywordDraft] = useState(candidateKeyword);

  const currentViews = useMemo(
    () => current.rows.map((row) => ({ row, view: renderCurrent(row) })),
    [current.rows, renderCurrent],
  );
  const candidateViews = useMemo(
    () => candidates.rows.map((row) => ({ row, view: renderCandidate(row) })),
    [candidates.rows, renderCandidate],
  );

  const currentKeys = useMemo(() => currentViews.map(({ view }) => view.key), [currentViews]);

  /** key → 展示信息；当前已关联项优先，其次是候选里能拿到的展示信息（拿不到时退回标识）。 */
  const viewByKey = useMemo(() => {
    const map = new Map<string, RelationRowView>();
    for (const { view } of candidateViews) map.set(String(view.key), view);
    for (const { view } of currentViews) map.set(String(view.key), view);
    return map;
  }, [candidateViews, currentViews]);

  /** 面板里可勾选的完整名单 = 当前已关联 ∪ 本次所选（顺序稳定，去重）。 */
  const panelKeys = useMemo(() => {
    const keys: Array<string | number> = [...currentKeys];
    for (const key of selectedCandidates) {
      if (!keys.some((item) => String(item) === String(key))) keys.push(key);
    }
    return keys;
  }, [currentKeys, selectedCandidates]);

  const viewOf = (key: string | number): RelationRowView =>
    viewByKey.get(String(key)) ?? { key, title: String(key) };

  /**
   * 写操作是否可用。
   *
   * 需要完整名单的 `set`/`clear` 在关联列表没有完整读到时一律禁用，避免误删：
   * 页面必须先把该方向的关联记录（按分页）读完，`current.complete` 才为真。
   */
  const complete = current.complete !== false;
  const writable = editable && availability === 'available' && complete;

  function toggleCandidate(key: string | number) {
    setSelectedCandidates((prev) => (prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]));
    setConfirm(null);
  }

  async function runAdd() {
    if (selectedCandidates.length === 0) return;
    await onAdd(selectedCandidates);
    setSelectedCandidates([]);
    setConfirm(null);
  }

  function openSetPanel() {
    const initial: Array<string | number> = [...currentKeys];
    for (const key of selectedCandidates) {
      if (!initial.some((item) => String(item) === String(key))) initial.push(key);
    }
    setSetSelection(initial);
    setConfirm('set');
  }

  function toggleSetKey(key: string | number) {
    setSetSelection((prev) =>
      prev.some((item) => String(item) === String(key))
        ? prev.filter((item) => String(item) !== String(key))
        : [...prev, key],
    );
  }

  function isSelectedInSet(key: string | number): boolean {
    return setSelection.some((item) => String(item) === String(key));
  }

  async function runSet() {
    await onSet(setSelection);
    setSelectedCandidates([]);
    setConfirm(null);
  }

  async function runClear() {
    await onSet([]);
    setSelectedCandidates([]);
    setConfirm(null);
  }

  async function runRemoveOne(key: string | number) {
    setBusyRow(key);
    try {
      await onRemove([key]);
    } finally {
      setBusyRow(null);
    }
  }

  if (availability === 'unavailable') {
    return (
      <CapabilityNotice title={unavailable.title} reason={unavailable.reason} details={unavailable.details} />
    );
  }
  if (availability === 'denied') {
    return <Banner tone="warn">{deniedText}</Banner>;
  }
  if (availability === 'indeterminate') {
    return (
      <CapabilityNotice
        title="暂时无法确认该能力是否已开通"
        reason="这次没能读到关联数据，也没能确认本实例是否已开通该能力；可以重试一次，若持续失败请联系管理员。"
        actions={
          <button type="button" className={styles.button} onClick={() => current.refetch()}>
            重试
          </button>
        }
      />
    );
  }

  return (
    <div data-testid={testId}>
      {availability === 'read-error' ? (
        <Banner tone="warn">
          该能力在本实例已开通，但这次关联数据读取失败了；可以点下面的「刷新」重试，这不代表能力未开通。
        </Banner>
      ) : null}
      {action ? <ActionBanner action={action} /> : null}

      <div className={styles.toolbar}>
        <span className={styles.label}>已关联</span>
        <span className={styles.chips}>
          <span className={styles.chip}>{`共 ${current.rows.length} 项`}</span>
        </span>
        <button type="button" className={styles.button} disabled={current.isFetching} onClick={current.refetch}>
          刷新
        </button>
      </div>

      <StateView
        state={current.state}
        message={current.message}
        onRetry={current.refetch}
        emptyTitle={emptyCurrentText}
        emptyDescription={hint}
      />

      {currentViews.length > 0 ? (
        <div className={styles.tableScroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>名称</th>
              <th>说明</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {currentViews.map(({ row, view }) => (
              <tr key={String(view.key)}>
                <td>{view.title}</td>
                <td>{view.meta}</td>
                <td>
                  <div className={styles.toolbar} style={{ gap: 6 }}>
                    {writable ? (
                      <button
                        type="button"
                        className={`${styles.button} ${styles.buttonDanger}`}
                        disabled={pending || busyRow === view.key}
                        onClick={() => void runRemoveOne(view.key)}
                      >
                        {busyRow === view.key ? '移除中…' : '移除'}
                      </button>
                    ) : null}
                    {renderRowExtra ? renderRowExtra(row) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      ) : null}

      {!editable ? (
        <Banner tone="info">当前角色只有查看权限，关联维护按钮已隐藏；需要调整时请联系管理员。</Banner>
      ) : !writable ? (
        availability === 'checking' ? (
          <p className={styles.notice}>正在读取关联数据…</p>
        ) : (
          <Banner tone="warn">
            关联数据没有完整读取到，为避免误改，加入 / 移除 / 整体替换 / 清空暂时不可用；
            请先点上面的「刷新」重试。
          </Banner>
        )
      ) : (
        <>
          <div className={styles.toolbar} style={{ marginTop: 14 }}>
            <div className={styles.toolbarGrow}>
              <SearchBox
                value={keywordDraft}
                onChange={setKeywordDraft}
                placeholder="按名称搜索候选"
                onSubmit={() => {
                  onCandidatePage(1);
                  onCandidateKeyword(keywordDraft);
                }}
              />
            </div>
          </div>

          <StateView
            state={candidates.state}
            message={candidates.message}
            onRetry={candidates.refetch}
            emptyTitle="没有可选对象"
            emptyDescription="换一个搜索条件，或确认服务端是否确实没有可关联的记录。"
          />

          {candidateViews.length > 0 ? (
            <div className={styles.chips}>
              {candidateViews.map(({ view }) => (
                <label key={String(view.key)} className={styles.checkboxRow}>
                  <input
                    type="checkbox"
                    disabled={pending}
                    checked={selectedCandidates.includes(view.key)}
                    onChange={() => toggleCandidate(view.key)}
                  />
                  <span>
                    {view.title}
                    {view.meta ? <span className={styles.cellMuted}>　{view.meta}</span> : null}
                  </span>
                </label>
              ))}
            </div>
          ) : null}

          <Pagination
            page={candidatePage}
            pageSize={candidatePageSize}
            total={candidates.total}
            onPageChange={onCandidatePage}
          />

          {confirm === 'set' ? (
            <div
              data-testid={testId ? `${testId}-set-panel` : undefined}
              style={{ marginTop: 12 }}
            >
              <span className={styles.label}>
                {`最终名单：默认勾选当前已关联项和本次所选；取消勾选即从名单移除。将保存 ${setSelection.length} 项。`}
              </span>
              <div className={styles.chips} style={{ maxHeight: 220, overflow: 'auto', marginTop: 8 }}>
                {panelKeys.map((key) => {
                  const view = viewOf(key);
                  return (
                    <label key={String(key)} className={styles.checkboxRow}>
                      <input
                        type="checkbox"
                        disabled={pending}
                        checked={isSelectedInSet(key)}
                        onChange={() => toggleSetKey(key)}
                      />
                      <span>
                        {view.title}
                        {view.meta ? <span className={styles.cellMuted}>　{view.meta}</span> : null}
                      </span>
                    </label>
                  );
                })}
              </div>
              {setSelection.length === 0 ? (
                <Banner tone="warn">
                  最终名单为空：确认后会清空该方向的全部已关联项，此操作不可撤销。
                </Banner>
              ) : null}
              <div className={styles.modalFooter} style={{ justifyContent: 'flex-start' }}>
                <button
                  type="button"
                  className={`${styles.button} ${setSelection.length === 0 ? styles.buttonDanger : styles.buttonPrimary}`}
                  disabled={pending}
                  onClick={() => void runSet()}
                >
                  {pending
                    ? '提交中…'
                    : setSelection.length === 0
                      ? '确认清空全部'
                      : `确认替换（最终 ${setSelection.length} 项）`}
                </button>
                <button type="button" className={styles.button} onClick={() => setConfirm(null)}>
                  取消
                </button>
              </div>
            </div>
          ) : null}

          {confirm === 'clear' ? (
            <div className={styles.modalFooter} style={{ justifyContent: 'flex-start' }}>
              <span className={styles.notice}>{`确认清空全部 ${currentKeys.length} 项已关联？此操作不可撤销。`}</span>
              <button
                type="button"
                className={`${styles.button} ${styles.buttonDanger}`}
                disabled={pending}
                onClick={() => void runClear()}
              >
                确认清空全部
              </button>
              <button type="button" className={styles.button} onClick={() => setConfirm(null)}>
                取消
              </button>
            </div>
          ) : null}

          {confirm === null ? (
            <div className={styles.modalFooter} style={{ justifyContent: 'flex-start' }}>
              <button
                type="button"
                className={`${styles.button} ${styles.buttonPrimary}`}
                disabled={pending || selectedCandidates.length === 0}
                onClick={() => void runAdd()}
              >
                {pending ? '提交中…' : `${addLabel}（已选 ${selectedCandidates.length}）`}
              </button>
              <button
                type="button"
                className={styles.button}
                disabled={pending || currentKeys.length === 0}
                onClick={openSetPanel}
              >
                {setLabel}
              </button>
              <button
                type="button"
                className={`${styles.button} ${styles.buttonDanger}`}
                disabled={pending || currentKeys.length === 0}
                onClick={() => setConfirm('clear')}
              >
                清空全部
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
