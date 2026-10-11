import { displayTitle } from '../../access/display';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { PageCard } from '../../../components/Card';
import { useResourceGet } from '../../../api/hooks';
import type { ModulePageProps } from '../../types';
import {
  ActionBanner,
  Banner,
  BoardPage,
  DataTable,
  Field,
  JsonView,
  KeyValueTable,
  Modal,
  SelectInput,
  StateView,
  TextArea,
  TextInput,
  CheckboxInput,
  formatCell,
  localStyles as styles,
  useAsyncAction,
  type Column,
} from '../../access/ui';
import { useAssociatedList } from '../../access/operations';
import {
  createCollectionField,
  destroyCollection,
  destroyCollectionField,
  loadTables,
  normalizeReadTables,
  readTables,
  refreshMainDataSource,
  syncMainDataSourceFields,
  updateCollectionField,
} from '../operations';
import type { CollectionFieldRecord, CollectionRecord } from '../types';

const FIELD_TYPE_OPTIONS = [
  { value: 'string', label: '单行文本 string' },
  { value: 'text', label: '多行文本 text' },
  { value: 'integer', label: '整数 integer' },
  { value: 'bigInt', label: '大整数 bigInt' },
  { value: 'float', label: '小数 float' },
  { value: 'double', label: '双精度 double' },
  { value: 'decimal', label: '定点小数 decimal' },
  { value: 'boolean', label: '布尔 boolean' },
  { value: 'date', label: '日期 date' },
  { value: 'datetime', label: '日期时间 datetime' },
  { value: 'json', label: 'JSON' },
  { value: 'jsonb', label: 'JSONB' },
  { value: 'array', label: '数组 array' },
  { value: 'belongsTo', label: '多对一 belongsTo' },
  { value: 'hasMany', label: '一对多 hasMany' },
  { value: 'hasOne', label: '一对一 hasOne' },
  { value: 'belongsToMany', label: '多对多 belongsToMany' },
];

const INTERFACE_OPTIONS = [
  { value: 'input', label: '单行文本' },
  { value: 'textarea', label: '多行文本' },
  { value: 'number', label: '数字' },
  { value: 'integer', label: '整数' },
  { value: 'percent', label: '百分比' },
  { value: 'checkbox', label: '勾选' },
  { value: 'select', label: '下拉选择' },
  { value: 'radioGroup', label: '单选' },
  { value: 'checkboxGroup', label: '多选' },
  { value: 'date', label: '日期' },
  { value: 'datetime', label: '日期时间' },
  { value: 'json', label: 'JSON' },
  { value: 'm2o', label: '多对一' },
  { value: 'o2m', label: '一对多' },
  { value: 'o2o', label: '一对一' },
  { value: 'm2m', label: '多对多' },
  { value: 'createdBy', label: '创建人' },
  { value: 'updatedBy', label: '更新人' },
  { value: 'createdAt', label: '创建时间' },
  { value: 'updatedAt', label: '更新时间' },
];

const RELATION_TYPES = new Set(['belongsTo', 'hasMany', 'hasOne', 'belongsToMany']);

interface FieldFormState {
  name: string;
  type: string;
  interface: string;
  description: string;
  target: string;
  foreignKey: string;
  sourceKey: string;
  targetKey: string;
  onDelete: string;
  required: boolean;
  unique: boolean;
}

const EMPTY_FIELD_FORM: FieldFormState = {
  name: '',
  type: 'string',
  interface: 'input',
  description: '',
  target: '',
  foreignKey: '',
  sourceKey: '',
  targetKey: '',
  onDelete: '',
  required: false,
  unique: false,
};

/**
 * DS-03 集合详情与字段管理（`/datasource/tables/:collectionName`）。
 *
 * 字段清单一律来自真实 schema（`collections/<name>/fields:list`），
 * 不从记录响应的键推断表结构；字段增改删走父资源斜杠形式。
 *
 * 反向同步与表加载（固定 2.2.20 实现，见 scripts/verify-2.2.20-main-data-source-contract.mjs）：
 *  - `mainDataSource:syncFields` → `MainDataSource.syncFieldsFromDatabase`：读物理表结构并按它
 *    重建该集合的字段记录（会删除物理表里没有的字段记录 = 真实写入，用户主动确认后执行）；
 *  - `mainDataSource:refresh` → `plugin.loadCollections()`：只把主数据源插件自带的集合定义文件
 *    重新读入运行中的应用，不扫物理表、不重建字段；界面按这个真实含义呈现，不宣称"刷新数据"；
 *  - `dataSources:readTables` 返回 `[{name}]`（尚未纳管的物理表）；`loadTables` 对 main 会写
 *    `collections` 记录（`from: 'dbsync'`）。
 */
export function CollectionDetailPage({ module, board }: ModulePageProps) {
  const params = useParams();
  const collectionName = params.collectionName ?? '';

  const detail = useResourceGet<CollectionRecord>('collections', collectionName, {
    params: { appends: ['fields'] },
  });
  const fields = useAssociatedList<CollectionFieldRecord>('collections', collectionName || null, 'fields', {
    params: { pageSize: 300, sort: ['sort'] },
  });

  const [fieldForm, setFieldForm] = useState<FieldFormState>(EMPTY_FIELD_FORM);
  const [fieldModalOpen, setFieldModalOpen] = useState(false);
  const [editingField, setEditingField] = useState<CollectionFieldRecord | null>(null);
  const [deleteField, setDeleteField] = useState<CollectionFieldRecord | null>(null);
  const [deleteCollectionOpen, setDeleteCollectionOpen] = useState(false);
  const [readTablesResult, setReadTablesResult] = useState<string[] | null>(null);
  const [selectedTables, setSelectedTables] = useState<string[]>([]);
  const [confirmSync, setConfirmSync] = useState(false);
  const action = useAsyncAction();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const isRelation = RELATION_TYPES.has(fieldForm.type);

  const fieldColumns: Array<Column<CollectionFieldRecord>> = useMemo(
    () => [
      {
        key: 'name',
        title: '字段',
        render: (row) => (
          <span>
            <strong>{row.name}</strong>
            {row.description ? (
              <>
                <br />
                <span className={styles.cellMuted}>{row.description}</span>
              </>
            ) : null}
          </span>
        ),
      },
      {
        key: 'type',
        title: '类型',
        render: (row) => (
          <span>
            <span className={styles.cellMono}>{row.type}</span>
            {row.interface ? <span className={styles.cellMuted}>{` / ${row.interface}`}</span> : null}
          </span>
        ),
      },
      {
        key: 'relation',
        title: '关联',
        render: (row) => {
          if (!row.target) return <span className={styles.cellMuted}>—</span>;
          return (
            <span className={styles.cellMuted}>
              {`${row.target}${row.foreignKey ? ` · ${row.foreignKey}` : ''}${row.targetKey ? ` · ${row.targetKey}` : ''}`}
            </span>
          );
        },
      },
      {
        key: 'onDelete',
        title: '删除策略',
        render: (row) => formatCell(row.onDelete),
      },
      {
        key: 'actions',
        title: '操作',
        render: (row) => (
          <span className={styles.actionsCell}>
            <button
              type="button"
              className={`${styles.button} ${styles.buttonLink}`}
              onClick={() => openEditField(row)}
            >
              编辑
            </button>
            <button
              type="button"
              className={`${styles.button} ${styles.buttonLink}`}
              onClick={() => setDeleteField(row)}
            >
              删除
            </button>
          </span>
        ),
      },
    ],
    [],
  );

  function openCreateField() {
    setFieldForm(EMPTY_FIELD_FORM);
    setEditingField(null);
    setFieldModalOpen(true);
    action.reset();
  }

  function openEditField(row: CollectionFieldRecord) {
    setFieldForm({
      name: row.name,
      type: row.type,
      interface: row.interface ?? '',
      description: row.description ?? '',
      target: row.target ?? '',
      foreignKey: row.foreignKey ?? '',
      sourceKey: row.sourceKey ?? '',
      targetKey: row.targetKey ?? '',
      onDelete: row.onDelete ?? '',
      required: Boolean((row.validation as { required?: boolean } | null)?.required),
      unique: Boolean((row.validation as { unique?: boolean } | null)?.unique),
    });
    setEditingField(row);
    setFieldModalOpen(true);
    action.reset();
  }

  async function submitField() {
    const values: Record<string, unknown> = {
      name: fieldForm.name.trim(),
      type: fieldForm.type,
      interface: fieldForm.interface || null,
      description: fieldForm.description.trim() || null,
      ...(isRelation
        ? {
            target: fieldForm.target.trim() || undefined,
            foreignKey: fieldForm.foreignKey.trim() || undefined,
            sourceKey: fieldForm.sourceKey.trim() || undefined,
            targetKey: fieldForm.targetKey.trim() || undefined,
            onDelete: fieldForm.onDelete || undefined,
          }
        : {}),
      validation: { required: fieldForm.required, unique: fieldForm.unique },
    };
    const ok = editingField
      ? await action.run(
          () => updateCollectionField(collectionName, editingField.name, values),
          '字段已保存。',
        )
      : await action.run(() => createCollectionField(collectionName, values), '字段已创建。');
    if (ok) {
      setFieldModalOpen(false);
      setEditingField(null);
      fields.refetch();
      detail.refetch();
    }
  }

  async function confirmDeleteField() {
    if (!deleteField) return;
    const ok = await action.run(
      () => destroyCollectionField(collectionName, deleteField.name),
      '字段已删除。',
    );
    if (ok) setDeleteField(null);
    fields.refetch();
  }

  async function runSyncFields() {
    // 只同步**当前集合**：请求体必须带 `collections:[collectionName]`。
    // 真实 2.2.20 里 `values.collections` 缺省 = 全部集合，因此这里不传空载荷（见 operations.ts）。
    const ok = await action.run(
      () => syncMainDataSourceFields(collectionName),
      '已触发字段反向同步（按物理表重建字段，可能删除多余字段）。',
    );
    setConfirmSync(false);
    if (ok) {
      fields.refetch();
      detail.refetch();
    }
  }

  async function runReadTables() {
    const result = await action.run(
      async () => {
        const response = await readTables({ dataSourceKey: 'main' });
        const normalized = normalizeReadTables(response.data);
        setReadTablesResult(normalized.tables);
      },
      '已读取尚未纳管的物理表。',
    );
    if (!result) {
      setReadTablesResult(null);
    }
  }

  async function runLoadTables() {
    if (selectedTables.length === 0) return;
    const ok = await action.run(
      () => loadTables({ dataSourceKey: 'main', tables: selectedTables }),
      `已提交加载 ${selectedTables.length} 张表为集合。`,
    );
    if (ok) {
      setSelectedTables([]);
      fields.refetch();
      detail.refetch();
    }
  }

  async function confirmDeleteCollection() {
    const ok = await action.run(() => destroyCollection(collectionName), '集合已删除。');
    if (!ok) return;
    setDeleteCollectionOpen(false);
    /**
     * Main 52 实测缺陷：集合删除成功后，详情 GET 变 404，但 react-query 在错误时**保留旧 data**，
     * 页面继续显示已删除集合的旧标题/字段，且新增/编辑/删除/同步按钮仍可写。
     * 因此成功后清掉该资源的缓存并回到列表；失败路径（`!ok`）保持原内容与错误提示不变。
     */
    queryClient.removeQueries({ queryKey: ['resource', 'collections'] });
    navigate('/datasource/tables');
  }

  return (
    <BoardPage
      module={module}
      board={board}
      headerActions={
        <Link className={styles.button} to="/datasource/tables">
          返回集合列表
        </Link>
      }
    >
      <StateView
        state={detail.state}
        message={detail.message}
        onRetry={detail.refetch}
        emptyTitle="没有找到这个集合"
        emptyDescription="集合可能已被删除；系统内置的集合不在业务集合管理器里，查询会返回空。"
      />

      {detail.data ? (
        <>
          <PageCard
            title={displayTitle(detail.data.title, detail.data.name)}
            description="这个集合的名称、说明与结构选项。"
            actions={
              <button type="button" className={`${styles.button} ${styles.buttonPrimary}`} onClick={openCreateField}>
                新增字段
              </button>
            }
          >
            <KeyValueTable
              rows={[
                { key: 'name', label: '集合标识', value: <span className={styles.cellMono}>{detail.data.name}</span> },
                { key: 'title', label: '标题', value: formatCell(displayTitle(detail.data.title, detail.data.name)) },
                { key: 'description', label: '说明', value: formatCell(detail.data.description) },
                { key: 'autoGenId', label: '自增主键', value: formatCell(detail.data.autoGenId) },
                { key: 'titleField', label: '标题字段', value: formatCell(detail.data.titleField) },
                { key: 'filterTargetKey', label: '筛选主键', value: formatCell(detail.data.filterTargetKey) },
                { key: 'logging', label: '变更日志', value: formatCell(detail.data.logging) },
                { key: 'inherit', label: '继承', value: formatCell(detail.data.inherit) },
                {
                  key: 'unavailableActions',
                  label: '禁用动作',
                  value: (detail.data.unavailableActions ?? []).length > 0 ? (detail.data.unavailableActions ?? []).join('、') : '—',
                },
              ]}
            />
          </PageCard>

          <PageCard title="字段" description="这个集合已有的字段与类型；可以在这里新增字段。">
            <ActionBanner action={action} />
            <StateView
              state={fields.state}
              message={fields.message}
              onRetry={fields.refetch}
              emptyTitle="该集合没有字段"
              emptyDescription="可以从右上角新增字段。"
            />
            {fields.rows.length > 0 ? (
              <DataTable columns={fieldColumns} rows={fields.rows} rowKey={(row) => row.name} />
            ) : null}
          </PageCard>

          <PageCard
            title="主库集合与字段"
            description="按物理表校正这个集合的字段定义；也可以重新加载主库自带的集合定义。"
          >
            <Banner tone="warn">
              反向同步会按物理表重建该集合的字段定义，物理表里没有的字段记录会被删除；请先确认字段清单与业务影响。
            </Banner>
            <div className={styles.toolbar} style={{ marginTop: 10 }}>
              <button
                type="button"
                className={`${styles.button} ${styles.buttonDanger}`}
                disabled={action.pending}
                onClick={() => setConfirmSync(true)}
              >
                反向同步字段
              </button>
              <button
                type="button"
                className={styles.button}
                disabled={action.pending}
                onClick={() => void action.run(() => refreshMainDataSource(), '已重新加载主库集合定义。')}
              >
                重新加载集合定义
              </button>
            </div>
            <p className={styles.notice}>
              说明：「重新加载集合定义」把主数据源自带的集合定义重新读入当前运行的应用，不扫描物理表、也不修改字段或数据，
              一般不需要手动执行；如果字段与物理表不一致，请用「反向同步字段」。
            </p>
          </PageCard>

          <PageCard
            title="从物理表加载为集合"
            description="先读取尚未纳管的物理表，再选择要加载的表；两步都是用户主动操作。"
          >
            <div className={styles.toolbar}>
              <button type="button" className={styles.button} disabled={action.pending} onClick={() => void runReadTables()}>
                读取尚未纳管的物理表
              </button>
              <button
                type="button"
                className={`${styles.button} ${styles.buttonPrimary}`}
                disabled={action.pending || selectedTables.length === 0}
                onClick={() => void runLoadTables()}
              >
                加载所选表为集合（{selectedTables.length}）
              </button>
            </div>
            {readTablesResult === null ? (
              <p className={styles.notice}>
                还没有读取结果。读取本身不会修改数据；「加载为集合」会写入集合记录，需要谨慎确认。
              </p>
            ) : readTablesResult.length === 0 ? (
              <Banner tone="info">没有尚未纳管的物理表。这是真实结果。</Banner>
            ) : (
              <div className={styles.chips} style={{ marginTop: 10 }}>
                {readTablesResult.map((table) => (
                  <label key={table} className={styles.checkboxRow}>
                    <input
                      type="checkbox"
                      checked={selectedTables.includes(table)}
                      onChange={(event) =>
                        setSelectedTables(
                          event.target.checked
                            ? [...selectedTables, table]
                            : selectedTables.filter((item) => item !== table),
                        )
                      }
                    />
                    <span className={styles.cellMono}>{table}</span>
                  </label>
                ))}
              </div>
            )}
          </PageCard>

          <PageCard title="集合操作" description="删除集合会移除其字段定义；此操作不可撤销。">
            <button
              type="button"
              className={`${styles.button} ${styles.buttonDanger}`}
              onClick={() => setDeleteCollectionOpen(true)}
            >
              删除该集合
            </button>
          </PageCard>
        </>
      ) : null}

      <Modal
        open={fieldModalOpen}
        title={editingField ? `编辑字段：${editingField.name}` : '新增字段'}
        description="类型与界面组件按真实定义提交；关联类型需要目标集合与键。"
        onClose={() => {
          setFieldModalOpen(false);
          setEditingField(null);
        }}
        wide
        footer={
          <>
            <button
              type="button"
              className={styles.button}
              onClick={() => {
                setFieldModalOpen(false);
                setEditingField(null);
              }}
            >
              取消
            </button>
            <button
              type="button"
              className={`${styles.button} ${styles.buttonPrimary}`}
              disabled={fieldForm.name.trim() === '' || action.pending}
              onClick={() => void submitField()}
            >
              {action.pending ? '保存中…' : '保存'}
            </button>
          </>
        }
      >
        <ActionBanner action={action} />
        <div className={styles.formGrid} style={{ marginTop: 12 }}>
          <Field label="字段名 name" required>
            <TextInput
              value={fieldForm.name}
              disabled={editingField !== null}
              onChange={(name) => setFieldForm({ ...fieldForm, name })}
            />
          </Field>
          <Field label="数据类型 type" required>
            <SelectInput
              value={fieldForm.type}
              options={FIELD_TYPE_OPTIONS}
              onChange={(type) => setFieldForm({ ...fieldForm, type: String(type) })}
            />
          </Field>
          <Field label="界面组件 interface">
            <SelectInput
              value={fieldForm.interface}
              options={INTERFACE_OPTIONS}
              allowEmpty
              placeholder="（不指定）"
              onChange={(next) => setFieldForm({ ...fieldForm, interface: String(next) })}
            />
          </Field>
          <Field label="删除策略 onDelete" hint="关联字段使用，例如 CASCADE / SET NULL。">
            <TextInput value={fieldForm.onDelete} onChange={(onDelete) => setFieldForm({ ...fieldForm, onDelete })} />
          </Field>
          {isRelation ? (
            <>
              <Field label="目标集合 target" required>
                <TextInput value={fieldForm.target} onChange={(target) => setFieldForm({ ...fieldForm, target })} />
              </Field>
              <Field label="外键 foreignKey">
                <TextInput value={fieldForm.foreignKey} onChange={(foreignKey) => setFieldForm({ ...fieldForm, foreignKey })} />
              </Field>
              <Field label="源键 sourceKey">
                <TextInput value={fieldForm.sourceKey} onChange={(sourceKey) => setFieldForm({ ...fieldForm, sourceKey })} />
              </Field>
              <Field label="目标键 targetKey">
                <TextInput value={fieldForm.targetKey} onChange={(targetKey) => setFieldForm({ ...fieldForm, targetKey })} />
              </Field>
            </>
          ) : null}
          <div className={styles.formGridFull}>
            <Field label="说明">
              <TextArea value={fieldForm.description} onChange={(description) => setFieldForm({ ...fieldForm, description })} />
            </Field>
          </div>
          <div className={styles.formGridFull}>
            <CheckboxInput
              checked={fieldForm.required}
              onChange={(required) => setFieldForm({ ...fieldForm, required })}
              label="必填"
            />
            <CheckboxInput
              checked={fieldForm.unique}
              onChange={(unique) => setFieldForm({ ...fieldForm, unique })}
              label="唯一"
            />
          </div>
          <div className={styles.formGridFull}>
            <JsonView
              value={{
                name: fieldForm.name,
                type: fieldForm.type,
                interface: fieldForm.interface || null,
                ...(isRelation ? { target: fieldForm.target } : {}),
                validation: { required: fieldForm.required, unique: fieldForm.unique },
              }}
              label="将提交的字段定义"
            />
          </div>
        </div>
      </Modal>

      <Modal
        open={deleteField !== null}
        title={`删除字段：${deleteField?.name ?? ''}`}
        description="删除字段可能造成数据丢失；请确认没有业务仍在使用它。"
        onClose={() => setDeleteField(null)}
        footer={
          <>
            <button type="button" className={styles.button} onClick={() => setDeleteField(null)}>
              取消
            </button>
            <button
              type="button"
              className={`${styles.button} ${styles.buttonDanger}`}
              disabled={action.pending}
              onClick={() => void confirmDeleteField()}
            >
              {action.pending ? '删除中…' : '确认删除'}
            </button>
          </>
        }
      >
        <ActionBanner action={action} />
      </Modal>

      <Modal
        open={confirmSync}
        title="反向同步字段"
        description="系统会按物理表重建该集合的字段定义，多余的字段记录会被删除。"
        onClose={() => setConfirmSync(false)}
        footer={
          <>
            <button type="button" className={styles.button} onClick={() => setConfirmSync(false)}>
              取消
            </button>
            <button
              type="button"
              className={`${styles.button} ${styles.buttonDanger}`}
              disabled={action.pending}
              onClick={() => void runSyncFields()}
            >
              {action.pending ? '同步中…' : '确认同步'}
            </button>
          </>
        }
      >
        <ActionBanner action={action} />
      </Modal>

      <Modal
        open={deleteCollectionOpen}
        title={`删除集合：${collectionName}`}
        description="删除集合会移除其字段定义并影响使用该集合的页面；此操作不可撤销。"
        onClose={() => setDeleteCollectionOpen(false)}
        footer={
          <>
            <button type="button" className={styles.button} onClick={() => setDeleteCollectionOpen(false)}>
              取消
            </button>
            <button
              type="button"
              className={`${styles.button} ${styles.buttonDanger}`}
              disabled={action.pending}
              onClick={() => void confirmDeleteCollection()}
            >
              {action.pending ? '删除中…' : '确认删除'}
            </button>
          </>
        }
      >
        <ActionBanner action={action} />
        <p className={styles.notice}>
          这不是数据源级别的删除；只删除该集合的定义。
        </p>
      </Modal>

      {detail.data ? (
        <p className={styles.notice}>
          记录预览与增改删见 <Link to={`/datasource/preview/${encodeURIComponent(collectionName)}`}>数据预览</Link>。
        </p>
      ) : null}
    </BoardPage>
  );
}
