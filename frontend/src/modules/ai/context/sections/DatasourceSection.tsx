/**
 * 「数据范围」工作区：`aiContextDatasources` 定义的完整 CRUD + 受权限约束预览 + 选择为会话内容。
 *
 * 契约要点（报告 10 §3.1）：
 *  - 列表/详情走 `list` / `get`；预览走 `preview`，**POST + `values`**；
 *  - 记录里的 `filter` 是结构化筛选（存储形态），预览直接传它，消息内容才转服务端形态；
 *  - 服务端在预览与解析时都会按 `ctx.state.currentRoles` 再叠加 ACL：
 *    **无权限返回空结果而不是 403**，因此"空"和"无权限"在界面上分开表达。
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { isResourceActionAllowed } from '../../../../permissions/model';
import { useSessionStore } from '../../../../auth/store';
import { PageCard, StatusPill } from '../../../../components/Card';
import { CrewloomError } from '../../../../api/errors';
import {
  createContextDatasource,
  destroyContextDatasource,
  listContextDatasources,
  previewContextDatasource,
  resourceMessageOf,
  resourceStateOf,
  updateContextDatasource,
} from '../../resources';
import type { AiContextDatasourceRow } from '../../types';
import { getCollectionSchema, listCollectionOptions, listDataSourceKeys } from '../schema';
import { toEditableFilter, describeFilter, isUiFilter } from '../filter';
import { requestChatHandoff, upsertSelection, removeSelection, useContextStoreSnapshot } from '../store';
import type { DatasourceSelection, UiFilterGroup } from '../types';
import { FilterEditor } from '../FilterEditor';
import { Checkbox, Field, ListPager, Notice, Select, StateBlock, TextArea, TextInput, formatTime, orDash } from '../../ui';
import { cellText, formatFields, safeJson, truncate } from '../format';
import styles from '../../group-a.module.css';

const PAGE_SIZE = 20;

export function DatasourceSection() {
  const access = useSessionStore((state) => state.access);
  const canWrite = isResourceActionAllowed(access, 'aiContextDatasources', 'create');
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const list = useQuery({
    queryKey: ['ai', 'context-datasources', page],
    queryFn: () => listContextDatasources({ page, pageSize: PAGE_SIZE, sort: ['-createdAt'] }),
  });

  const rows = list.data?.rows ?? [];
  const state = list.isLoading ? 'loading' : resourceStateOf(list.error, rows.length === 0);

  useEffect(() => {
    if (!selectedId && rows.length > 0) setSelectedId(rows[0].id);
  }, [rows, selectedId]);

  const selected = useMemo(() => rows.find((row) => row.id === selectedId) ?? null, [rows, selectedId]);
  const refresh = () => void list.refetch();

  return (
    <div className={styles.stack}>
      {creating ? (
        <ContextForm
          mode="create"
          canWrite={canWrite}
          onCancel={() => setCreating(false)}
          onSaved={(id) => {
            setCreating(false);
            setSelectedId(id);
            refresh();
          }}
        />
      ) : null}

      <div className={styles.twoColumn}>
        <PageCard
          title="已保存的数据范围"
          description="选中后在右侧查看、预览，并可以选择为本次会话的内容。"
          actions={
            <button
              type="button"
              className={`${styles.button} ${styles.buttonPrimary}`}
              disabled={!canWrite || creating}
              onClick={() => setCreating(true)}
              data-testid="context-datasource-create"
            >
              新建数据范围
            </button>
          }
        >
          <StateBlock
            state={state}
            message={resourceMessageOf(list.error)}
            onRetry={refresh}
            emptyTitle="还没有数据范围"
            emptyDescription={
              canWrite
                ? '点击右上角「新建数据范围」创建第一条：选择数据表、字段与筛选条件即可。'
                : '当前没有任何记录；你的角色没有新建权限，如需使用请联系管理员。'
            }
            deniedDescription="你的角色没有查看数据范围的权限。"
          />
          {rows.length > 0 ? (
            <div className={styles.rowList}>
              {rows.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  className={row.id === selectedId ? `${styles.rowCard} ${styles.rowCardActive}` : styles.rowCard}
                  style={{ textAlign: 'left', cursor: 'pointer' }}
                  onClick={() => setSelectedId(row.id)}
                  data-testid="context-datasource-row"
                >
                  <span className={styles.rowMain}>
                    <span className={styles.rowTitle}>{row.title || '未命名'}</span>
                    <span className={styles.rowHint}>
                      {row.datasource}:{row.collectionName}　上限 {orDash(row.limit)}
                    </span>
                    <span className={styles.chipRow}>
                      {row.enabled === false ? <StatusPill tone="warn">已停用</StatusPill> : <StatusPill tone="ok">已启用</StatusPill>}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          ) : null}
          <ListPager
            meta={(list.data?.meta ?? {}) as { count?: number; hasNext?: boolean }}
            page={page}
            pageSize={PAGE_SIZE}
            isFetching={list.isFetching}
            onChange={setPage}
          />
        </PageCard>

        <div className={styles.stack}>
          {selected ? (
            <ContextDetail
              key={selected.id}
              record={selected}
              canWrite={canWrite}
              onChanged={refresh}
              onRemoved={() => {
                setSelectedId(null);
                refresh();
              }}
            />
          ) : (
            <PageCard title="数据范围详情">
              <StateBlock
                state="empty"
                emptyTitle="还没有选中数据范围"
                emptyDescription="从左侧选择一条，查看它的配置并做受权限约束的预览。"
              />
            </PageCard>
          )}
        </div>
      </div>
    </div>
  );
}

function ContextDetail({
  record,
  canWrite,
  onChanged,
  onRemoved,
}: {
  record: AiContextDatasourceRow;
  canWrite: boolean;
  onChanged: () => void;
  onRemoved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const snapshot = useContextStoreSnapshot();
  const isSelected = snapshot.selections.some((item) => item.kind === 'datasource' && item.uid === record.id);

  if (editing) {
    return (
      <ContextForm
        mode="edit"
        record={record}
        canWrite={canWrite}
        onCancel={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          onChanged();
        }}
      />
    );
  }

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await destroyContextDatasource(record.id);
      removeSelection('datasource');
      onRemoved();
    } catch (caught) {
      setError(caught instanceof CrewloomError ? caught.userMessage : '删除失败，请稍后重试。');
    } finally {
      setBusy(false);
    }
  };

  const select = () => {
    const selection: DatasourceSelection = {
      kind: 'datasource',
      uid: record.id,
      title: record.title,
      datasource: record.datasource,
      collectionName: record.collectionName,
      fields: Array.isArray(record.fields) ? (record.fields.filter((item) => typeof item === 'string') as string[]) : null,
      filter: record.filter,
      sort: Array.isArray(record.sort) ? record.sort : null,
      limit: typeof record.limit === 'number' ? record.limit : null,
    };
    upsertSelection(selection);
    requestChatHandoff();
  };

  return (
    <>
      <PageCard
        title={record.title || '数据范围'}
        description={record.description || '没有填写说明。'}
        actions={
          <div className={styles.rowActions}>
            <button
              type="button"
              className={`${styles.button} ${styles.buttonPrimary}`}
              onClick={select}
              data-testid="context-datasource-select"
            >
              {isSelected ? '已选择为会话内容' : '选择为会话内容'}
            </button>
            <button type="button" className={styles.button} disabled={!canWrite} onClick={() => setEditing(true)}>
              编辑
            </button>
            <button
              type="button"
              className={`${styles.button} ${styles.buttonDanger}`}
              disabled={!canWrite || busy}
              onClick={() => void remove()}
            >
              删除
            </button>
          </div>
        }
      >
        <div className={styles.fieldRow}>
          <Field label="数据源">
            <span className={styles.mono}>{orDash(record.datasource)}</span>
          </Field>
          <Field label="数据表">
            <span className={styles.mono}>{orDash(record.collectionName)}</span>
          </Field>
          <Field label="字段">
            <span className={styles.mono}>{formatFields(record.fields)}</span>
          </Field>
          <Field label="条数上限">
            <span>{orDash(record.limit)}</span>
          </Field>
        </div>
        <Field label="筛选条件">
          <span>
            {isUiFilter(record.filter) || isEmptyStoredFilter(record.filter)
              ? describeFilter(record.filter)
              : '旧格式筛选（编辑后可预览）'}
          </span>
        </Field>
        <Field label="排序">
          <span className={styles.mono}>{formatFields(record.sort)}</span>
        </Field>
        <div className={styles.rowHint}>创建于 {formatTime(record.createdAt)}　更新于 {formatTime(record.updatedAt)}</div>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {!canWrite ? <Notice tone="warn">你的角色没有修改数据范围的权限。</Notice> : null}
      </PageCard>

      <ContextPreview record={record} />
    </>
  );
}

function ContextPreview({ record }: { record: AiContextDatasourceRow }) {
  const [requested, setRequested] = useState(false);
  const preview = useQuery({
    queryKey: ['ai', 'context-datasources', 'preview', record.id, record.updatedAt],
    queryFn: () =>
      previewContextDatasource({
        datasource: record.datasource,
        collectionName: record.collectionName,
        fields: record.fields ?? null,
        filter: record.filter ?? null,
        sort: record.sort ?? null,
        limit: record.limit ?? 20,
      }),
    enabled: requested,
  });

  const rows = preview.data?.rows ?? [];
  const state = !requested ? 'empty' : preview.isLoading ? 'loading' : resourceStateOf(preview.error, rows.length === 0);

  return (
    <PageCard title="预览数据" description="按你当前的权限读取一小段符合条件的记录，不会修改任何数据。">
      <div className={styles.toolbar}>
        <button
          type="button"
          className={styles.button}
          disabled={preview.isFetching}
          onClick={() => {
            setRequested(true);
            if (requested) void preview.refetch();
          }}
          data-testid="context-datasource-preview"
        >
          {preview.isFetching ? '正在读取…' : '预览数据'}
        </button>
        <span className={styles.rowHint}>预览只读取数据，不会修改任何记录。</span>
      </div>

      {!requested ? (
        <Notice>还没有读取预览。点击上面的按钮会按你当前的权限范围取一小段数据。</Notice>
      ) : (
        <>
          <StateBlock
            state={state}
            message={resourceMessageOf(preview.error)}
            onRetry={() => void preview.refetch()}
            emptyTitle="预览没有返回记录"
            emptyDescription="当前没有符合条件的数据。如果这不是你预期的结果，可以调整筛选条件，或联系管理员确认你的权限范围。"
          />
          {rows.length > 0 ? (
            <div className={styles.tableWrap}>
              <table className={styles.table} data-testid="context-datasource-preview-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>记录内容</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr key={index}>
                      <td>{index + 1}</td>
                      <td>
                        <span className={styles.mono}>
                          {Array.isArray(row)
                            ? truncate(
                                row
                                  .map((cell) => `${(cell as { name?: string }).name ?? ''}=${cellText(cell)}`)
                                  .join('，'),
                                320,
                              )
                            : cellText(row)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {preview.data ? <p className={styles.rowHint}>范围内的记录总数：{preview.data.total}</p> : null}
        </>
      )}
    </PageCard>
  );
}

export function ContextForm({
  mode,
  record,
  canWrite,
  onCancel,
  onSaved,
}: {
  mode: 'create' | 'edit';
  record?: AiContextDatasourceRow;
  canWrite: boolean;
  onCancel: () => void;
  onSaved: (id: string) => void;
}) {
  const [title, setTitle] = useState(record?.title ?? '');
  const [description, setDescription] = useState(record?.description ?? '');
  const [datasource, setDatasource] = useState(record?.datasource ?? 'main');
  const [collectionName, setCollectionName] = useState(record?.collectionName ?? '');
  const [fields, setFields] = useState(formatFields(record?.fields) === '—' ? '' : formatFields(record?.fields));
  const [filter, setFilter] = useState<UiFilterGroup>(toEditableFilter(record?.filter));
  const [sortText, setSortText] = useState(record?.sort ? safeJson(record.sort) : '');
  const [limit, setLimit] = useState(String(record?.limit ?? 1000));
  const [enabled, setEnabled] = useState(record?.enabled !== false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const legacyFilter = record?.filter != null && !isUiFilter(record.filter);

  const dataSources = useQuery({
    queryKey: ['ai', 'context', 'data-sources'],
    queryFn: listDataSourceKeys,
    retry: false,
    staleTime: 60_000,
  });

  const collections = useQuery({
    queryKey: ['ai', 'context', 'collections'],
    queryFn: () => listCollectionOptions(),
    retry: false,
    staleTime: 60_000,
  });

  const schema = useQuery({
    queryKey: ['ai', 'context', 'schema', collectionName],
    queryFn: () => getCollectionSchema(collectionName),
    enabled: collectionName.length > 0,
    retry: false,
    staleTime: 60_000,
  });

  const schemaFields = schema.data?.fields ?? [];

  const submit = async () => {
    if (title.trim().length === 0) {
      setError('请填写标题。');
      return;
    }
    if (collectionName.trim().length === 0) {
      setError('请选择或填写数据表名。');
      return;
    }
    let sort: unknown;
    try {
      sort = sortText.trim().length > 0 ? JSON.parse(sortText) : null;
    } catch {
      setError('排序需要是合法的 JSON 数组，例如 ["-createdAt"]。');
      return;
    }
    const values = {
      title: title.trim(),
      description: description.trim(),
      datasource: datasource.trim() || 'main',
      collectionName: collectionName.trim(),
      fields: fields.trim().length > 0 ? fields.split(',').map((item) => item.trim()).filter(Boolean) : null,
      filter: filter.items.length > 0 ? filter : null,
      sort,
      limit: Number(limit) || 1000,
      enabled,
    };
    setPending(true);
    setError(null);
    try {
      if (mode === 'create') {
        const created = await createContextDatasource(values);
        onSaved(created?.id ?? '');
      } else if (record) {
        await updateContextDatasource(record.id, values);
        onSaved(record.id);
      }
    } catch (caught) {
      setError(caught instanceof CrewloomError ? caught.userMessage : '保存失败，请稍后重试。');
    } finally {
      setPending(false);
    }
  };

  const disabled = !canWrite || pending;

  return (
    <PageCard title={mode === 'create' ? '新建数据范围' : '编辑数据范围'}>
      {!canWrite ? <Notice tone="warn">你的角色没有保存数据范围的权限。</Notice> : null}
      {legacyFilter ? (
        <Notice tone="warn">
          这条记录用的是旧版纯 JSON 筛选，预览需要结构化筛选。保存一次即可转为结构化条件（旧条件不会自动猜测转换）。
        </Notice>
      ) : null}
      <div className={styles.fieldRow}>
        <Field label="标题" required>
          <TextInput value={title} disabled={disabled} onChange={setTitle} testId="context-datasource-title" />
        </Field>
        <Field label="数据源" hint={dataSources.error ? '数据源清单读取失败，可手动填写。' : '选择这批数据所在的数据源。'}>
          {dataSources.data && dataSources.data.length > 0 ? (
            <Select
              value={datasource}
              disabled={disabled}
              onChange={setDatasource}
              options={dataSources.data.map((key) => ({ value: key, label: key }))}
            />
          ) : (
            <TextInput value={datasource} disabled={disabled} onChange={setDatasource} />
          )}
        </Field>
        <Field label="数据表" required hint={collections.error ? '数据表清单读取失败，可手动填写。' : '选择要读取的数据表。'}>
          <input
            className={styles.input}
            list="crewloom-context-collections"
            value={collectionName}
            disabled={disabled}
            onChange={(event) => setCollectionName(event.target.value)}
            data-testid="context-datasource-collection"
          />
          <datalist id="crewloom-context-collections">
            {(collections.data ?? []).map((item) => (
              <option key={item.name} value={item.name}>
                {item.title ?? item.name}
              </option>
            ))}
          </datalist>
        </Field>
        <Field label="字段" hint="逗号分隔；留空表示全部可读字段。">
          <input
            className={styles.input}
            list="crewloom-context-fields"
            value={fields}
            disabled={disabled}
            onChange={(event) => setFields(event.target.value)}
          />
          <datalist id="crewloom-context-fields">
            {schemaFields.map((field) => (
              <option key={field.name} value={field.name} />
            ))}
          </datalist>
        </Field>
      </div>

      <Field label="说明">
        <TextArea value={description} rows={2} disabled={disabled} onChange={setDescription} />
      </Field>

      <Field label="筛选条件" hint="只读取符合条件的数据；预览和发送时都会按你的权限范围生效。">
        <FilterEditor value={filter} onChange={setFilter} fields={schemaFields} disabled={disabled} />
      </Field>

      <div className={styles.fieldRow}>
        <Field label="排序" hint='按字段排序；示例 ["-createdAt"]（前面加 - 表示倒序）'>
          <TextArea value={sortText} rows={3} disabled={disabled} onChange={setSortText} />
        </Field>
        <Field label="条数上限">
          <TextInput type="number" value={limit} disabled={disabled} onChange={setLimit} />
        </Field>
        <Field label="状态">
          <Checkbox label="启用这条数据范围" checked={enabled} disabled={disabled} onChange={setEnabled} />
        </Field>
      </div>

      {error ? <Notice tone="danger">{error}</Notice> : null}

      <div className={styles.toolbar} style={{ marginBottom: 0 }}>
        <button
          type="button"
          className={`${styles.button} ${styles.buttonPrimary}`}
          disabled={disabled}
          onClick={() => void submit()}
          data-testid="context-datasource-save"
        >
          {pending ? '正在保存…' : '保存'}
        </button>
        <button type="button" className={styles.button} disabled={pending} onClick={onCancel}>
          取消
        </button>
      </div>
    </PageCard>
  );
}

/**
 * 存储态筛选是否为空（无筛选）。
 *
 * 真实 2.2.20 的 `aiContextDatasources` 记录在"不做筛选"时 `filter` 为 `null`
 * （Main 在 5327 新建"主浏览器工单范围"时 `filter: null`）。此前 `null` 落到
 * `isUiFilter` 的 false 分支，被判成"旧格式筛选"，与实际语义不符；
 * 空筛选应显示 `describeFilter` 给出的"全部记录"。
 */
function isEmptyStoredFilter(filter: unknown): boolean {
  if (filter === null || filter === undefined || filter === '') return true;
  if (Array.isArray(filter)) return filter.length === 0;
  if (typeof filter === 'object') return Object.keys(filter as Record<string, unknown>).length === 0;
  return false;
}
