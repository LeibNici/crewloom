import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../../../api/client';
import { toUserMessage } from '../../../api/errors';
import { EmptyState, PageCard, PageHeader, StatusPill } from '../../../components/Card';
import { useMutation } from '../useMutation';
import { formatDateTime, readString, truncate } from '../format';
import { triggerTypeLabel } from '../labels';
import {
  fetchWorkflowCategories,
  fetchWorkflows,
  PAGE_SIZE,
  type WorkflowCategory,
  type WorkflowRow,
} from '../domain';
import styles from '../workflow.module.css';

/**
 * WF-01 流程列表。
 *
 * 真实行为（不是"占位骨架"）：
 *  - 真实分页/排序/分类与关键字筛选，读取 13000 现网数据；
 *  - 版本识别按原生 `key` + `current`：`current` 只表示"当前生效版本"，
 *    不是"只能看这一版"，历史版本与历史任务都不因此被排除；
 *  - 启停走 `workflows:update { enabled }`，由服务端 `onBeforeSave` 维护 `current`
 *    （**没有** publish 动作，界面不虚构"发布"按钮）；
 *  - 删除当前生效版本会连带删除同一 `key` 的全部版本，确认框中如实告知；
 *  - "为同一流程新建版本"与"复制为独立流程"是两个操作：前者必须带
 *    `filter.key`，后者只传 `values`，两者不可互换；
 *  - 已产生执行记录的版本受原生约束不能再改节点配置，界面给出引导而不是静默失败。
 */
export function WorkflowListPage() {
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [enabledOnly, setEnabledOnly] = useState(false);
  const [rows, setRows] = useState<WorkflowRow[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [categories, setCategories] = useState<WorkflowCategory[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<WorkflowRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [renaming, setRenaming] = useState<WorkflowRow | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [actionId, setActionId] = useState<string | null>(null);

  const mutation = useMutation();

  const filter = useMemo(() => {
    const conditions: Record<string, unknown> = {};
    if (keyword.trim()) conditions.title = { $includes: keyword.trim() };
    if (enabledOnly) conditions.enabled = true;
    if (categoryId) conditions['categories.id'] = { $eq: categoryId };
    return conditions;
  }, [keyword, enabledOnly, categoryId]);

  const load = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const result = await fetchWorkflows({ page, filter });
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
    let alive = true;
    fetchWorkflowCategories()
      .then((items) => {
        if (alive) setCategories(items);
      })
      .catch(() => {
        // 分类读不到不应阻断流程列表：筛选器缺省即可，不冒充"没有分类"。
        if (alive) setCategories([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    setPage(1);
  }, [keyword, categoryId, enabledOnly]);

  const totalPages = total !== null ? Math.max(1, Math.ceil(total / PAGE_SIZE)) : null;

  const runRowAction = async (row: WorkflowRow, task: () => Promise<unknown>, successText: string) => {
    setActionId(row.id);
    setNotice(null);
    const result = await mutation.run(task);
    setActionId(null);
    if (result !== null) {
      setNotice(successText);
      await load();
    }
  };

  const toggleEnabled = (row: WorkflowRow) =>
    runRowAction(
      row,
      () => api.resourceAction('workflows', 'update', { values: { enabled: !row.enabled }, params: { filterByTk: row.id } }),
      row.enabled ? `已停用「${row.title}」。` : `已启用「${row.title}」，服务端会把它置为当前生效版本。`,
    );

  const removeWorkflow = (row: WorkflowRow) =>
    runRowAction(
      row,
      () => api.resourceAction('workflows', 'destroy', { params: { filterByTk: row.id } }),
      `已删除「${row.title}」。`,
    );

  const duplicateAsNewWorkflow = (row: WorkflowRow) =>
    runRowAction(
      row,
      () =>
        api.resourceAction('workflows', 'revision', {
          params: { filterByTk: row.id },
          values: { title: `${row.title} 副本` },
        }),
      `已复制为独立流程「${row.title} 副本」。`,
    );

  const copyToNewVersion = (row: WorkflowRow) =>
    runRowAction(
      row,
      () =>
        api.resourceAction('workflows', 'revision', {
          // 同组新版本的必要条件：filter 里带 key（不是放进 values）。
          params: { filterByTk: row.id, filter: JSON.stringify({ key: row.key ?? '' }) },
        }),
      `已为「${row.title}」新建同一流程的新版本。`,
    );

  const submitCreate = async () => {
    const title = newTitle.trim();
    if (!title) return;
    const result = await mutation.run(() =>
      api.resourceAction('workflows', 'create', { values: { title, type: 'collection', enabled: false } }),
    );
    if (result !== null) {
      setNewTitle('');
      setCreating(false);
      setNotice(`已创建流程「${title}」。`);
      await load();
    }
  };

  const submitRename = async () => {
    if (!renaming) return;
    const title = renameTitle.trim();
    if (!title) return;
    const target = renaming;
    const result = await mutation.run(() =>
      api.resourceAction('workflows', 'update', { values: { title }, params: { filterByTk: target.id } }),
    );
    if (result !== null) {
      setRenaming(null);
      setNotice(`已重命名流程为「${title}」。`);
      await load();
    }
  };

  return (
    <div className={styles.stack}>
      <PageHeader
        title="流程列表"
        description="查看、创建、筛选与启停工作流。启用某个版本会让它成为当前生效版本，历史版本与历史执行记录不受影响。"
        meta={
          <span className={styles.metaText}>
            {total !== null ? `共 ${total} 个流程版本` : loading ? '正在读取…' : '总数暂不可用'}
          </span>
        }
        actions={
          <button type="button" className={styles.primaryButton} onClick={() => setCreating((value) => !value)}>
            新建流程
          </button>
        }
      />

      {creating ? (
        <PageCard title="新建流程" description="创建后默认是停用状态，需要在列表中启用才会生效。">
          <div className={styles.formRow}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>流程名称</span>
              <input
                className={styles.input}
                value={newTitle}
                onChange={(event) => setNewTitle(event.target.value)}
                placeholder="例如：订单同步"
              />
            </label>
            <div className={styles.formActions}>
              <button
                type="button"
                className={styles.primaryButton}
                disabled={mutation.isSubmitting || newTitle.trim().length === 0}
                onClick={() => void submitCreate()}
              >
                创建
              </button>
              <button type="button" className={styles.secondaryButton} onClick={() => setCreating(false)}>
                取消
              </button>
            </div>
          </div>
        </PageCard>
      ) : null}

      <PageCard>
        <div className={styles.filterBar}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>流程名称包含</span>
            <input
              className={styles.input}
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="输入关键字"
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>分类</span>
            <select
              className={styles.select}
              value={categoryId}
              onChange={(event) => setCategoryId(event.target.value)}
            >
              <option value="">全部分类</option>
              {categories.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title || `分类 ${item.id}`}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.checkboxField}>
            <input
              type="checkbox"
              checked={enabledOnly}
              onChange={(event) => setEnabledOnly(event.target.checked)}
            />
            <span>只看已启用</span>
          </label>
          <button type="button" className={styles.secondaryButton} onClick={() => void load()}>
            刷新
          </button>
        </div>

        {listError ? (
          <EmptyState tone="warn" title="流程列表暂时读不到" description={listError} />
        ) : loading ? (
          <p className={styles.mutedText}>正在读取流程列表…</p>
        ) : rows.length === 0 ? (
          <EmptyState
            title="没有符合条件的流程"
            description="可以调整筛选条件，或新建一个流程。若刚刚清空过筛选仍然为空，说明当前数据源里确实还没有流程。"
          />
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>流程</th>
                  <th>版本</th>
                  <th>触发方式</th>
                  <th>状态</th>
                  <th>执行次数</th>
                  <th>更新时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const executed = row.versionExecuted ?? 0;
                  const busy = actionId === row.id;
                  return (
                    <tr key={row.id}>
                      <td>
                        <div className={styles.cellTitle}>
                          <Link className={styles.rowLink} to={`/workflow/canvas?workflowId=${row.id}`}>
                            {row.title}
                          </Link>
                          {row.categories.length > 0 ? (
                            <span className={styles.cellHint}>
                              {row.categories.map((category) => category.title).filter(Boolean).join('、')}
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td>
                        {row.current ? (
                          <StatusPill tone="brand">当前生效版本</StatusPill>
                        ) : (
                          <StatusPill tone="neutral">历史版本</StatusPill>
                        )}
                      </td>
                      <td>{triggerTypeLabel(row.type)}</td>
                      <td>
                        {row.enabled ? (
                          <StatusPill tone="ok">已启用</StatusPill>
                        ) : (
                          <StatusPill tone="neutral">已停用</StatusPill>
                        )}
                      </td>
                      <td>{executed}</td>
                      <td>{formatDateTime(row.updatedAt ?? row.createdAt) ?? '—'}</td>
                      <td>
                        <div className={styles.rowActions}>
                          <button
                            type="button"
                            className={styles.linkButton}
                            disabled={busy || mutation.isSubmitting}
                            onClick={() => void toggleEnabled(row)}
                          >
                            {row.enabled ? '停用' : '启用'}
                          </button>
                          <Link className={styles.linkButton} to={`/workflow/canvas?workflowId=${row.id}`}>
                            编排
                          </Link>
                          <button
                            type="button"
                            className={styles.linkButton}
                            disabled={busy || mutation.isSubmitting}
                            onClick={() => {
                              setRenaming(row);
                              setRenameTitle(row.title);
                            }}
                          >
                            重命名
                          </button>
                          <button
                            type="button"
                            className={styles.linkButton}
                            disabled={busy || mutation.isSubmitting}
                            onClick={() => void copyToNewVersion(row)}
                          >
                            新建版本
                          </button>
                          <button
                            type="button"
                            className={styles.linkButton}
                            disabled={busy || mutation.isSubmitting}
                            onClick={() => void duplicateAsNewWorkflow(row)}
                          >
                            复制为独立流程
                          </button>
                          <button
                            type="button"
                            className={styles.dangerLinkButton}
                            disabled={busy || mutation.isSubmitting}
                            onClick={() => setConfirming(row)}
                          >
                            删除
                          </button>
                        </div>
                        {executed > 0 ? (
                          <span className={styles.cellHint}>
                            该版本已执行 {executed} 次，按原生规则不能修改流程配置与节点，需要改配置时请新建版本。
                          </span>
                        ) : null}
                      </td>
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

      {renaming ? (
        <PageCard title={`重命名「${renaming.title}」`}>
          <div className={styles.formRow}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>新的流程名称</span>
              <input
                className={styles.input}
                value={renameTitle}
                onChange={(event) => setRenameTitle(event.target.value)}
              />
            </label>
            <div className={styles.formActions}>
              <button
                type="button"
                className={styles.primaryButton}
                disabled={mutation.isSubmitting || renameTitle.trim().length === 0}
                onClick={() => void submitRename()}
              >
                保存
              </button>
              <button type="button" className={styles.secondaryButton} onClick={() => setRenaming(null)}>
                取消
              </button>
            </div>
          </div>
        </PageCard>
      ) : null}

      {confirming ? (
        <PageCard title={`删除「${confirming.title}」`} tone="muted">
          <p className={styles.bodyText}>
            {confirming.current
              ? '这是当前生效版本。按原生规则，删除它会同时删除同一流程的全部分支版本，删除后无法恢复。'
              : '这是历史版本，删除只影响这一条版本记录，当前生效版本不受影响。'}
          </p>
          <div className={styles.formActions}>
            <button
              type="button"
              className={styles.dangerButton}
              disabled={mutation.isSubmitting}
              onClick={() => {
                const target = confirming;
                setConfirming(null);
                void removeWorkflow(target);
              }}
            >
              确认删除
            </button>
            <button type="button" className={styles.secondaryButton} onClick={() => setConfirming(null)}>
              取消
            </button>
          </div>
        </PageCard>
      ) : null}

      {notice ? <p className={styles.successText}>{notice}</p> : null}
      {mutation.message ? <p className={styles.errorText}>{mutation.message}</p> : null}
    </div>
  );
}

/** 供画布页复用的当前流程摘要（避免重复实现取值逻辑）。 */
export function workflowSummary(row: WorkflowRow | null): string {
  if (!row) return '';
  return truncate(readString(row.raw, 'description') ?? '', 120);
}
