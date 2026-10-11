import { displayTitle } from '../../access/display';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { PageCard, StatusPill } from '../../../components/Card';
import { useResourceList } from '../../../api/hooks';
import type { ModulePageProps } from '../../types';
import {
  ActionBanner,
  Banner,
  BoardPage,
  CheckboxInput,
  DataTable,
  Field,
  Modal,
  Pagination,
  SearchBox,
  SelectInput,
  StateView,
  TextArea,
  TextInput,
  formatCell,
  localStyles as styles,
  useAsyncAction,
  type Column,
} from '../../access/ui';
import { buildScope, CONDITION_OPERATOR_LABELS, useAssociatedList, type ConditionClause } from '../../access/operations';
import {
  aggregateCollectionRecords,
  createCollectionRecord,
  destroyCollectionRecord,
  updateCollectionRecord,
} from '../operations';
import type { CollectionFieldRecord, CollectionRecord, CollectionRecordData } from '../types';

const NUMBER_TYPES = new Set(['integer', 'bigInt', 'float', 'double', 'decimal', 'number']);
const JSON_TYPES = new Set(['json', 'jsonb', 'array']);
const READONLY_TYPES = new Set(['belongsTo', 'hasMany', 'hasOne', 'belongsToMany']);
const READONLY_NAMES = new Set(['id', 'createdAt', 'updatedAt', 'createdById', 'updatedById']);

/**
 * DS-04 数据预览（`/datasource/preview`）——集合选择入口。
 */
export function PreviewPage({ module, board }: ModulePageProps) {
  const navigate = useNavigate();
  const collections = useResourceList<CollectionRecord>('collections', { params: { pageSize: 300, sort: ['name'] } });
  const [keywordInput, setKeywordInput] = useState('');
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 20;

  const filtered = useMemo(() => {
    if (!keyword.trim()) return collections.rows;
    const needle = keyword.trim().toLowerCase();
    return collections.rows.filter(
      (row) => row.name.toLowerCase().includes(needle) || (row.title ?? '').toLowerCase().includes(needle),
    );
  }, [collections.rows, keyword]);

  const paged = filtered.slice((page - 1) * pageSize, page * pageSize);

  const columns: Array<Column<CollectionRecord>> = [
    { key: 'title', title: '集合', render: (row) => displayTitle(row.title, row.name) },
    { key: 'name', title: '标识', render: (row) => <span className={styles.cellMono}>{row.name}</span> },
    { key: 'description', title: '说明', render: (row) => <span className={styles.ellipsis}>{formatCell(row.description)}</span> },
  ];

  return (
    <BoardPage module={module} board={board}>
      <PageCard
        title="选择集合"
        description="选择一个业务集合查看记录；是否能查询、修改或删除由你的权限决定。"
      >
        <div className={styles.toolbar}>
          <div className={styles.toolbarGrow}>
            <SearchBox
              value={keywordInput}
              onChange={setKeywordInput}
              placeholder="集合名称或标识"
              onSubmit={() => {
                setKeyword(keywordInput);
                setPage(1);
              }}
            />
          </div>
        </div>
        <StateView state={collections.state} message={collections.message} onRetry={collections.refetch} />
        {paged.length > 0 ? (
          <>
            <DataTable
              columns={columns}
              rows={paged}
              rowKey={(row) => row.name}
              onRowClick={(row) => navigate(`/datasource/preview/${encodeURIComponent(row.name)}`)}
            />
            <Pagination page={page} pageSize={pageSize} total={filtered.length} onPageChange={setPage} />
          </>
        ) : null}
      </PageCard>
    </BoardPage>
  );
}

interface RecordFormState {
  values: Record<string, string>;
  touched: Record<string, boolean>;
}

/**
 * DS-04 记录预览与操作（`/datasource/preview/:collectionName`）。
 *
 * 真实数据：`GET <collection>:list`（+ `X-Data-Source: main`）。
 * 真实客户/物料/供应商等记录在本阶段**只读**；写入只在本机受控服务验证，
 * 但产品里的真实用户仍可主动保存（页面不是永久只读）。
 * 更新只提交被用户改动过的字段，避免覆盖未知字段。
 */
export function CollectionRecordsPage({ module, board }: ModulePageProps) {
  const params = useParams();
  const collectionName = params.collectionName ?? '';
  const fieldsMeta = useAssociatedList<CollectionFieldRecord>('collections', collectionName || null, 'fields', {
    params: { pageSize: 300, sort: ['sort'] },
  });

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [sortField, setSortField] = useState('');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [clauses, setClauses] = useState<ConditionClause[]>([{ id: 'f1', field: '', operator: 'eq', value: '' }]);
  const [appliedFilter, setAppliedFilter] = useState<Record<string, unknown> | undefined>(undefined);
  const [visibleFields, setVisibleFields] = useState<string[]>([]);
  const [fieldPickerOpen, setFieldPickerOpen] = useState(false);
  const [detailRow, setDetailRow] = useState<CollectionRecordData | null>(null);
  const [editingRow, setEditingRow] = useState<CollectionRecordData | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<RecordFormState>({ values: {}, touched: {} });
  const [deleteRow, setDeleteRow] = useState<CollectionRecordData | null>(null);
  const [aggregate, setAggregate] = useState({ dimension: '', measure: '', aggregation: 'count' });
  const [aggregateRows, setAggregateRows] = useState<CollectionRecordData[] | null>(null);
  const action = useAsyncAction();

  const editableFields = useMemo(
    () =>
      fieldsMeta.rows.filter(
        (field) => !READONLY_TYPES.has(field.type) && !READONLY_NAMES.has(field.name),
      ),
    [fieldsMeta.rows],
  );

  const sortValue = sortField ? `${sortDirection === 'desc' ? '-' : ''}${sortField}` : undefined;

  const records = useResourceList<CollectionRecordData>(collectionName, {
    params: {
      page,
      pageSize,
      ...(sortValue ? { sort: [sortValue] } : {}),
      ...(appliedFilter && Object.keys(appliedFilter).length > 0 ? { filter: appliedFilter } : {}),
    },
    enabled: collectionName !== '',
    keySuffix: { page, pageSize, sortValue, appliedFilter },
    dataSource: 'main',
  });

  useEffect(() => {
    if (visibleFields.length > 0 || fieldsMeta.rows.length === 0) return;
    setVisibleFields(fieldsMeta.rows.slice(0, 8).map((field) => field.name));
  }, [fieldsMeta.rows, visibleFields.length]);

  const columns: Array<Column<CollectionRecordData>> = useMemo(() => {
    const names = visibleFields.length > 0 ? visibleFields : fieldsMeta.rows.slice(0, 6).map((field) => field.name);
    const list: Array<Column<CollectionRecordData>> = names.map((name) => ({
      key: name,
      title: name,
      render: (row) => formatCell(row[name]),
    }));
    list.push({
      key: '__actions',
      title: '操作',
      render: (row) => (
        <span className={styles.actionsCell}>
          <button
            type="button"
            className={`${styles.button} ${styles.buttonLink}`}
            onClick={(event) => {
              event.stopPropagation();
              setEditingRow(row);
              const next: RecordFormState = { values: {}, touched: {} };
              for (const field of editableFields) {
                const value = row[field.name];
                next.values[field.name] = value === null || value === undefined ? '' : JSON_TYPES.has(field.type) ? JSON.stringify(value) : String(value);
              }
              setForm(next);
              setFormOpen(true);
            }}
          >
            编辑
          </button>
          <button
            type="button"
            className={`${styles.button} ${styles.buttonLink}`}
            onClick={(event) => {
              event.stopPropagation();
              setDeleteRow(row);
            }}
          >
            删除
          </button>
        </span>
      ),
    });
    return list;
  }, [visibleFields, fieldsMeta.rows, editableFields]);

  function applyFilter() {
    setPage(1);
    // buildScope 使用与原生 parseFilter 一致的对象语义；条件为空则不带 filter。
    const built = buildScope(clauses);
    setAppliedFilter(built && Object.keys(built).length > 0 ? built : undefined);
  }

  async function submitForm() {
    const values: Record<string, unknown> = {};
    for (const field of editableFields) {
      if (!form.touched[field.name]) continue;
      const raw = form.values[field.name] ?? '';
      if (JSON_TYPES.has(field.type)) {
        if (raw.trim() === '') values[field.name] = null;
        else {
          try {
            values[field.name] = JSON.parse(raw);
          } catch {
            values[field.name] = raw;
          }
        }
      } else if (NUMBER_TYPES.has(field.type)) {
        values[field.name] = raw.trim() === '' ? null : Number(raw);
      } else if (field.type === 'boolean') {
        values[field.name] = raw === 'true' ? true : raw === 'false' ? false : null;
      } else {
        values[field.name] = raw === '' ? null : raw;
      }
    }
    const ok = editingRow
      ? await action.run(
          () => updateCollectionRecord(collectionName, String(editingRow['id']), values),
          '记录已保存（只提交你改动过的字段）。',
        )
      : await action.run(() => createCollectionRecord(collectionName, values), '记录已创建。');
    if (ok) {
      setFormOpen(false);
      setEditingRow(null);
      records.refetch();
    }
  }

  async function confirmDelete() {
    if (!deleteRow) return;
    const ok = await action.run(
      () => destroyCollectionRecord(collectionName, String(deleteRow['id'])),
      '记录已删除。',
    );
    if (ok) setDeleteRow(null);
    records.refetch();
  }

  async function runAggregate() {
    const values: Record<string, unknown> = {
      measures: [{ field: aggregate.measure || undefined, aggregation: aggregate.aggregation }],
      ...(aggregate.dimension ? { dimensions: [aggregate.dimension] } : {}),
      ...(appliedFilter && Object.keys(appliedFilter).length > 0 ? { filter: appliedFilter } : {}),
    };
    const ok = await action.run(async () => {
      const response = await aggregateCollectionRecords(collectionName, values);
      setAggregateRows(response.data ?? []);
    }, '聚合查询已完成。');
    if (!ok) setAggregateRows(null);
  }

  const dimensionOptions = [
    { value: '', label: '（不分组）' },
    ...fieldsMeta.rows.map((field) => ({ value: field.name, label: field.name })),
  ];
  const measureOptions = fieldsMeta.rows.map((field) => ({ value: field.name, label: field.name }));

  return (
    <BoardPage
      module={module}
      board={board}
      headerActions={
        <Link className={styles.button} to="/datasource/preview">
          返回集合选择
        </Link>
      }
    >
      <PageCard
        title={`记录：${collectionName}`}
        description="筛选、排序、分页与字段显示都按当前数据读取；写入动作按你的权限判定。"
        actions={
          <>
            <button type="button" className={styles.button} onClick={() => setFieldPickerOpen(true)}>
              显示字段
            </button>
            <button
              type="button"
              className={`${styles.button} ${styles.buttonPrimary}`}
              onClick={() => {
                setEditingRow(null);
                setForm({ values: {}, touched: {} });
                setFormOpen(true);
              }}
            >
              新增记录
            </button>
          </>
        }
      >
        <ActionBanner action={action} />
        <StateView state={fieldsMeta.state} message={fieldsMeta.message} onRetry={fieldsMeta.refetch} />

        <div className={styles.conditionRow}>
          <TextInput
            value={clauses[0]?.field ?? ''}
            placeholder="筛选字段"
            onChange={(field) => setClauses([{ ...(clauses[0] ?? { id: 'f1', operator: 'eq', value: '' }), field }])}
          />
          <SelectInput
            value={clauses[0]?.operator ?? 'eq'}
            options={CONDITION_OPERATOR_LABELS}
            onChange={(operator) => setClauses([{ ...(clauses[0] ?? { id: 'f1', field: '', value: '' }), operator: operator as ConditionClause['operator'] }])}
          />
          <TextInput
            value={clauses[0]?.value ?? ''}
            placeholder="筛选值"
            onChange={(value) => setClauses([{ ...(clauses[0] ?? { id: 'f1', field: '', operator: 'eq' }), value }])}
          />
          <button type="button" className={styles.button} onClick={applyFilter}>
            应用筛选
          </button>
        </div>

        <div className={styles.toolbar} style={{ marginTop: 8 }}>
          <Field label="排序字段">
            <SelectInput
              value={sortField}
              options={[{ value: '', label: '（默认）' }, ...fieldsMeta.rows.map((field) => ({ value: field.name, label: field.name }))]}
              onChange={(next) => {
                setSortField(String(next));
                setPage(1);
              }}
            />
          </Field>
          <Field label="方向">
            <SelectInput
              value={sortDirection}
              options={[
                { value: 'desc', label: '倒序' },
                { value: 'asc', label: '正序' },
              ]}
              onChange={(next) => {
                setSortDirection(next === 'asc' ? 'asc' : 'desc');
                setPage(1);
              }}
            />
          </Field>
          <button type="button" className={styles.button} onClick={() => records.refetch()}>
            刷新
          </button>
        </div>

        <StateView
          state={records.state}
          message={records.message}
          onRetry={records.refetch}
          emptyTitle="这个集合当前没有记录"
          emptyDescription="空记录是后端的真实结果；不等于没有权限。"
          deniedDescription="当前账号没有查看这个集合记录的权限。如确需使用，请联系管理员调整角色或权限。"
        />
        {records.rows.length > 0 ? (
          <>
            <DataTable
              columns={columns}
              rows={records.rows}
              rowKey={(row, index) => String(row['id'] ?? index)}
              onRowClick={(row) => setDetailRow(row)}
            />
            <Pagination
              page={page}
              pageSize={pageSize}
              total={records.total}
              onPageChange={setPage}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(1);
              }}
            />
          </>
        ) : null}
      </PageCard>

      <PageCard
        title="聚合查询"
        description="按至少一个度量或分组汇总记录；结果按当前权限返回。"
      >
        <div className={styles.toolbar}>
          <Field label="分组字段">
            <SelectInput
              value={aggregate.dimension}
              options={dimensionOptions}
              onChange={(next) => setAggregate({ ...aggregate, dimension: String(next) })}
            />
          </Field>
          <Field label="度量字段">
            <SelectInput
              value={aggregate.measure}
              options={[{ value: '', label: '（计数）' }, ...measureOptions]}
              onChange={(next) => setAggregate({ ...aggregate, measure: String(next) })}
            />
          </Field>
          <Field label="聚合方式">
            <SelectInput
              value={aggregate.aggregation}
              options={[
                { value: 'count', label: '计数' },
                { value: 'sum', label: '求和' },
                { value: 'avg', label: '平均' },
                { value: 'max', label: '最大' },
                { value: 'min', label: '最小' },
              ]}
              onChange={(next) => setAggregate({ ...aggregate, aggregation: String(next) })}
            />
          </Field>
          <button type="button" className={`${styles.button} ${styles.buttonPrimary}`} disabled={action.pending} onClick={() => void runAggregate()}>
            执行聚合
          </button>
        </div>
        {aggregateRows === null ? (
          <p className={styles.notice}>聚合只在你点击后执行。</p>
        ) : aggregateRows.length === 0 ? (
          <Banner tone="info">聚合返回空结果；这可能是筛选条件没有匹配记录，或字段被权限裁剪。</Banner>
        ) : (
          <DataTable
            columns={Object.keys(aggregateRows[0] ?? {}).map((key) => ({
              key,
              title: key,
              render: (row: CollectionRecordData) => formatCell(row[key]),
            }))}
            rows={aggregateRows}
            rowKey={(row, index) => String(row['id'] ?? index)}
          />
        )}
      </PageCard>

      <Modal
        open={detailRow !== null}
        title="记录详情"
        description="显示该记录的完整字段（不改动数据）。"
        onClose={() => setDetailRow(null)}
        wide
        footer={
          <button type="button" className={styles.button} onClick={() => setDetailRow(null)}>
            关闭
          </button>
        }
      >
        {detailRow ? (
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <tbody>
                {Object.entries(detailRow).map(([key, value]) => (
                  <tr key={key}>
                    <th scope="row" style={{ width: 220 }}>
                      {key}
                    </th>
                    <td>{formatCell(value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={formOpen}
        title={editingRow ? `编辑记录 #${String(editingRow['id'])}` : '新增记录'}
        description="只提交你改动过的字段；未改动的字段（含未知字段）保持原值。"
        onClose={() => {
          setFormOpen(false);
          setEditingRow(null);
        }}
        wide
        footer={
          <>
            <button
              type="button"
              className={styles.button}
              onClick={() => {
                setFormOpen(false);
                setEditingRow(null);
              }}
            >
              取消
            </button>
            <button
              type="button"
              className={`${styles.button} ${styles.buttonPrimary}`}
              disabled={action.pending}
              onClick={() => void submitForm()}
            >
              {action.pending ? '保存中…' : '保存'}
            </button>
          </>
        }
      >
        <ActionBanner action={action} />
        <StateView state={fieldsMeta.state} message={fieldsMeta.message} onRetry={fieldsMeta.refetch} />
        {fieldsMeta.state === 'ready' ? (
          <div className={styles.formGrid} style={{ marginTop: 12 }}>
            {editableFields.length === 0 ? (
              <p className={styles.notice}>该集合没有可直接编辑的字段（可能都是关联或只读字段）。</p>
            ) : null}
            {editableFields.map((field) => {
              const value = form.values[field.name] ?? '';
              const isBoolean = field.type === 'boolean';
              return (
                <Field
                  key={field.name}
                  label={`${field.name}${field.interface ? `（${field.interface}）` : ''}`}
                >
                  {isBoolean ? (
                    <SelectInput
                      value={value}
                      options={[
                        { value: '', label: '（空）' },
                        { value: 'true', label: '是' },
                        { value: 'false', label: '否' },
                      ]}
                      allowEmpty
                      onChange={(next) =>
                        setForm({
                          values: { ...form.values, [field.name]: String(next) },
                          touched: { ...form.touched, [field.name]: true },
                        })
                      }
                    />
                  ) : JSON_TYPES.has(field.type) || field.type === 'text' ? (
                    <TextArea
                      value={value}
                      onChange={(next) =>
                        setForm({
                          values: { ...form.values, [field.name]: next },
                          touched: { ...form.touched, [field.name]: true },
                        })
                      }
                    />
                  ) : (
                    <TextInput
                      type={NUMBER_TYPES.has(field.type) ? 'number' : 'text'}
                      value={value}
                      onChange={(next) =>
                        setForm({
                          values: { ...form.values, [field.name]: next },
                          touched: { ...form.touched, [field.name]: true },
                        })
                      }
                    />
                  )}
                </Field>
              );
            })}
          </div>
        ) : null}
      </Modal>

      <Modal
        open={fieldPickerOpen}
        title="显示字段"
        description="只影响本页显示，不改变数据；字段来自这个集合的字段定义。"
        onClose={() => setFieldPickerOpen(false)}
        wide
        footer={
          <button type="button" className={styles.button} onClick={() => setFieldPickerOpen(false)}>
            完成
          </button>
        }
      >
        <StateView state={fieldsMeta.state} message={fieldsMeta.message} onRetry={fieldsMeta.refetch} />
        <div className={styles.chips} style={{ marginTop: 10 }}>
          {fieldsMeta.rows.map((field) => (
            <label key={field.name} className={styles.checkboxRow}>
              <input
                type="checkbox"
                checked={visibleFields.includes(field.name)}
                onChange={(event) =>
                  setVisibleFields(
                    event.target.checked
                      ? [...visibleFields, field.name]
                      : visibleFields.filter((name) => name !== field.name),
                  )
                }
              />
              <span className={styles.cellMono}>{field.name}</span>
            </label>
          ))}
        </div>
        <CheckboxInput
          checked={visibleFields.length === 0}
          onChange={() => setVisibleFields([])}
          label="不单独选择时显示默认字段"
        />
      </Modal>

      <Modal
        open={deleteRow !== null}
        title={`删除记录 #${String(deleteRow?.['id'] ?? '')}`}
        description="删除后不可恢复；关联数据可能受影响。"
        onClose={() => setDeleteRow(null)}
        footer={
          <>
            <button type="button" className={styles.button} onClick={() => setDeleteRow(null)}>
              取消
            </button>
            <button
              type="button"
              className={`${styles.button} ${styles.buttonDanger}`}
              disabled={action.pending}
              onClick={() => void confirmDelete()}
            >
              {action.pending ? '删除中…' : '确认删除'}
            </button>
          </>
        }
      >
        <ActionBanner action={action} />
      </Modal>

      <p className={styles.notice}>
        字段与集合定义见 <Link to={`/datasource/tables/${encodeURIComponent(collectionName)}`}>数据表与字段</Link>。
        <StatusPill tone="neutral">当前记录数 {records.total ?? '—'}</StatusPill>
      </p>
    </BoardPage>
  );
}
