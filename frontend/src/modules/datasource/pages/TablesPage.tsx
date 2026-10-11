import { displayTitle } from '../../access/display';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { PageCard, StatusPill } from '../../../components/Card';
import { useResourceList } from '../../../api/hooks';
import type { ModulePageProps } from '../../types';
import {
  ActionBanner,
  BoardPage,
  DataTable,
  Field,
  Modal,
  Pagination,
  SearchBox,
  StateView,
  TextArea,
  TextInput,
  CheckboxInput,
  formatCell,
  localStyles as styles,
  useAsyncAction,
  type Column,
} from '../../access/ui';
import { createCollection, updateCollection } from '../operations';
import type { CollectionRecord } from '../types';

/**
 * DS-03 数据表与字段（`/datasource/tables`）——集合清单。
 *
 * 真实数据：`GET collections:list`（13000 实测 157 个业务集合，含 `name/title/hidden/description/
 * autoGenId/titleField/filterTargetKey`）。插件集合不在业务集合管理器里（`collections:get` 返回 null），
 * 这是已核实的实现约束，不是版本故障。
 */
export function TablesPage({ module, board }: ModulePageProps) {
  const navigate = useNavigate();
  const list = useResourceList<CollectionRecord>('collections', { params: { pageSize: 300, sort: ['name'] } });
  const [keywordInput, setKeywordInput] = useState('');
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ name: '', title: '', description: '', autoGenId: true });
  const [editing, setEditing] = useState<CollectionRecord | null>(null);
  const action = useAsyncAction();

  const filtered = useMemo(() => {
    if (!keyword.trim()) return list.rows;
    const needle = keyword.trim().toLowerCase();
    return list.rows.filter(
      (row) =>
        row.name.toLowerCase().includes(needle) || (row.title ?? '').toLowerCase().includes(needle),
    );
  }, [list.rows, keyword]);

  const paged = filtered.slice((page - 1) * pageSize, page * pageSize);

  const columns: Array<Column<CollectionRecord>> = [
    {
      key: 'title',
      title: '集合',
      render: (row) => (
        <span>
          <strong>{displayTitle(row.title, row.name)}</strong>
          <br />
          <span className={styles.cellMono}>{row.name}</span>
        </span>
      ),
    },
    {
      key: 'description',
      title: '说明',
      render: (row) => <span className={styles.ellipsis}>{formatCell(row.description)}</span>,
    },
    {
      key: 'autoGenId',
      title: '自增主键',
      render: (row) => formatCell(row.autoGenId),
    },
    {
      key: 'titleField',
      title: '标题字段',
      render: (row) => <span className={styles.cellMono}>{formatCell(row.titleField)}</span>,
    },
    {
      key: 'hidden',
      title: '状态',
      render: (row) => (row.hidden ? <StatusPill tone="warn">隐藏</StatusPill> : <StatusPill tone="ok">可见</StatusPill>),
    },
    {
      key: 'actions',
      title: '操作',
      render: (row) => (
        <span className={styles.actionsCell}>
          <button
            type="button"
            className={`${styles.button} ${styles.buttonLink}`}
            onClick={(event) => {
              event.stopPropagation();
              openEdit(row);
            }}
          >
            编辑
          </button>
        </span>
      ),
    },
  ];

  function openCreate() {
    setForm({ name: '', title: '', description: '', autoGenId: true });
    setCreateOpen(true);
    setEditing(null);
    action.reset();
  }

  function openEdit(row: CollectionRecord) {
    setForm({
      name: row.name,
      title: row.title ?? '',
      description: row.description ?? '',
      autoGenId: row.autoGenId !== false,
    });
    setEditing(row);
    setCreateOpen(false);
    action.reset();
  }

  async function submitForm() {
    const values = {
      title: form.title.trim(),
      description: form.description.trim() || null,
      autoGenId: form.autoGenId,
    };
    const ok = editing
      ? await action.run(() => updateCollection(editing.name, values), '集合已保存。')
      : await action.run(
          () => createCollection({ name: form.name.trim(), ...values }),
          '集合已创建。',
        );
    if (ok) {
      setCreateOpen(false);
      setEditing(null);
      list.refetch();
    }
  }

  const modalOpen = createOpen || editing !== null;
  const canSubmit = form.name.trim() !== '' && form.title.trim() !== '' && !action.pending;

  return (
    <BoardPage
      module={module}
      board={board}
      headerMeta={`共 ${list.total ?? '—'} 个业务集合`}
      headerActions={
        <button type="button" className={`${styles.button} ${styles.buttonPrimary}`} onClick={openCreate}>
          新建集合
        </button>
      }
    >
      <PageCard
        title="业务集合"
        description="点开一行查看字段与关联；系统内置的集合不在业务集合管理器里。"
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
        <StateView
          state={list.state}
          message={list.message}
          onRetry={list.refetch}
          emptyTitle="没有可管理的集合"
          emptyDescription="当前账号可能没有集合管理权限，或实例还没有加载集合。"
        />
        {paged.length > 0 ? (
          <>
            <DataTable
              columns={columns}
              rows={paged}
              rowKey={(row) => row.name}
              onRowClick={(row) => navigate(`/datasource/tables/${encodeURIComponent(row.name)}`)}
            />
            <Pagination
              page={page}
              pageSize={pageSize}
              total={filtered.length}
              onPageChange={setPage}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(1);
              }}
            />
          </>
        ) : null}
      </PageCard>

      <Modal
        open={modalOpen}
        title={editing ? `编辑集合：${editing.name}` : '新建集合'}
        description="集合标识创建后不可修改；字段在集合详情里维护。"
        onClose={() => {
          setCreateOpen(false);
          setEditing(null);
        }}
        footer={
          <>
            <button
              type="button"
              className={styles.button}
              onClick={() => {
                setCreateOpen(false);
                setEditing(null);
              }}
            >
              取消
            </button>
            <button
              type="button"
              className={`${styles.button} ${styles.buttonPrimary}`}
              disabled={!canSubmit}
              onClick={() => void submitForm()}
            >
              {action.pending ? '保存中…' : '保存'}
            </button>
          </>
        }
      >
        <ActionBanner action={action} />
        <div className={styles.formGrid} style={{ marginTop: 12 }}>
          <Field label="集合标识 name" required hint="小写字母、数字与下划线。">
            <TextInput value={form.name} disabled={editing !== null} onChange={(name) => setForm({ ...form, name })} />
          </Field>
          <Field label="集合标题 title" required>
            <TextInput value={form.title} onChange={(title) => setForm({ ...form, title })} />
          </Field>
          <div className={styles.formGridFull}>
            <Field label="说明">
              <TextArea value={form.description} onChange={(description) => setForm({ ...form, description })} />
            </Field>
          </div>
          <div className={styles.formGridFull}>
            <CheckboxInput
              checked={form.autoGenId}
              onChange={(autoGenId) => setForm({ ...form, autoGenId })}
              label="自动生成主键（autoGenId）"
            />
          </div>
        </div>
      </Modal>
    </BoardPage>
  );
}
