import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { PageCard, StatusPill } from '../../../components/Card';
import { useResourceList } from '../../../api/hooks';
import { useSessionStore } from '../../../auth/store';
import type { ModulePageProps } from '../../types';
import {
  ActionBanner,
  Banner,
  BoardPage,
  CheckboxInput,
  Chip,
  DataTable,
  Field,
  Modal,
  SelectInput,
  StateView,
  TextArea,
  TextInput,
  formatCell,
  localStyles as styles,
  useAsyncAction,
  type Column,
} from '../ui';
import { createRole, destroyRole, setSystemRoleMode, updateRole } from '../operations';
import type { RoleRecord } from '../types';
import { roleLabel } from '../display';

const ROLE_MODE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'default', label: '默认：各自使用单个角色（不提供合并角色）' },
  { value: 'allow-use-union', label: '允许合并：单角色与合并角色都可选' },
  { value: 'only-use-union', label: '强制合并：只按全部角色的合并权限工作' },
];

interface RoleFormState {
  name: string;
  title: string;
  description: string;
  isDefault: boolean;
  allowConfigure: boolean;
  allowNewAiEmployee: boolean;
  snippets: string[];
}

const EMPTY_FORM: RoleFormState = {
  name: '',
  title: '',
  description: '',
  isDefault: false,
  allowConfigure: false,
  allowNewAiEmployee: true,
  snippets: [],
};

/**
 * AC-02 角色与成员（`/access/roles`）。
 *
 * 真实数据：`GET roles:list`（13000 实测 16 个角色，主键是 `name`）。
 * 多角色模式写入 `roles:setSystemRoleMode`；全局默认角色是 `roles.default=true`（全局唯一）。
 */
export function RolesPage({ module, board }: ModulePageProps) {
  const navigate = useNavigate();
  const roleMode = useSessionStore((state) => state.roleMode);
  const list = useResourceList<RoleRecord>('roles', { params: { pageSize: 200, sort: ['name'] } });
  const [editing, setEditing] = useState<RoleRecord | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<RoleFormState>(EMPTY_FORM);
  const [customSnippet, setCustomSnippet] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<RoleRecord | null>(null);
  const action = useAsyncAction();
  const modeAction = useAsyncAction();

  /** 片段候选来自后端真实配置（各角色已保存的 snippets 并集），不凭空编造片段名。 */
  const snippetOptions = useMemo(() => {
    const set = new Set<string>();
    for (const role of list.rows) for (const snippet of role.snippets ?? []) set.add(snippet);
    return [...set].sort();
  }, [list.rows]);

  const columns: Array<Column<RoleRecord>> = [
    {
      key: 'title',
      title: '角色',
      render: (row) => (
        <span>
          <strong>{roleLabel(row)}</strong>
          <br />
          <span className={styles.cellMuted}>{row.name}</span>
        </span>
      ),
    },
    {
      key: 'description',
      title: '说明',
      render: (row) => (
        <span className={styles.ellipsis} title={row.description ?? ''}>
          {formatCell(row.description)}
        </span>
      ),
    },
    {
      key: 'flags',
      title: '标记',
      render: (row) => (
        <span className={styles.chips}>
          {row.default ? <StatusPill tone="brand">全局默认</StatusPill> : null}
          {row.hidden ? <StatusPill tone="neutral">隐藏</StatusPill> : null}
          {row.allowConfigure ? <StatusPill tone="ok">可配置</StatusPill> : null}
          {row.allowNewAiEmployee ? <StatusPill tone="neutral">可建员工</StatusPill> : null}
        </span>
      ),
    },
    {
      key: 'snippets',
      title: '权限片段',
      render: (row) => {
        const items = row.snippets ?? [];
        if (items.length === 0) return <span className={styles.cellMuted}>无</span>;
        return <span className={styles.cellMuted}>{items.join('、')}</span>;
      },
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
              navigate(`/access/roles/${encodeURIComponent(row.name)}`);
            }}
          >
            成员与权限
          </button>
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
          <button
            type="button"
            className={`${styles.button} ${styles.buttonLink}`}
            onClick={(event) => {
              event.stopPropagation();
              setDeleteTarget(row);
            }}
          >
            删除
          </button>
        </span>
      ),
    },
  ];

  function openCreate() {
    setForm(EMPTY_FORM);
    setCreating(true);
    setEditing(null);
    action.reset();
  }

  function openEdit(role: RoleRecord) {
    setForm({
      name: role.name,
      title: role.title ?? '',
      description: role.description ?? '',
      isDefault: role.default === true,
      allowConfigure: role.allowConfigure === true,
      allowNewAiEmployee: role.allowNewAiEmployee !== false,
      snippets: role.snippets ?? [],
    });
    setEditing(role);
    setCreating(false);
    action.reset();
  }

  async function submitForm() {
    const values: Record<string, unknown> = {
      title: form.title.trim(),
      description: form.description.trim() || null,
      default: form.isDefault,
      allowConfigure: form.allowConfigure,
      allowNewAiEmployee: form.allowNewAiEmployee,
      snippets: form.snippets,
    };
    const ok = creating
      ? await action.run(() => createRole({ name: form.name.trim(), ...values }), '角色已创建。')
      : await action.run(() => updateRole(form.name, values), '角色已保存。');
    if (ok) {
      setCreating(false);
      setEditing(null);
      list.refetch();
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const ok = await action.run(() => destroyRole(deleteTarget.name), `角色「${deleteTarget.name}」已删除。`);
    if (ok) setDeleteTarget(null);
    list.refetch();
  }

  async function changeRoleMode(next: string) {
    const ok = await modeAction.run(() => setSystemRoleMode(next), '多角色模式已保存。');
    if (ok) {
      // 角色模式改变会影响当前会话的合并语义：重新读取权限上下文，避免旧响应覆盖新状态。
      await useSessionStore.getState().refreshAccess();
    }
  }

  const modalOpen = creating || editing !== null;
  const canSubmit = form.name.trim() !== '' && form.title.trim() !== '' && !action.pending;

  return (
    <BoardPage
      module={module}
      board={board}
      headerMeta={`共 ${list.total ?? '—'} 个角色`}
      headerActions={
        <button type="button" className={`${styles.button} ${styles.buttonPrimary}`} onClick={openCreate}>
          新建角色
        </button>
      }
    >
      <PageCard title="多角色模式" description="由服务端强制；保存后立即重新读取你当前的权限上下文。">
        <ActionBanner action={modeAction} />
        <div className={styles.toolbar}>
          <div className={styles.toolbarGrow}>
            <Field label="当前模式">
              <SelectInput
                value={ROLE_MODE_OPTIONS.some((option) => option.value === roleMode) ? roleMode : 'default'}
                options={ROLE_MODE_OPTIONS}
                onChange={(next) => {
                  if (next !== '' && next !== roleMode) void changeRoleMode(String(next));
                }}
                disabled={modeAction.pending}
              />
            </Field>
          </div>
        </div>
        {roleMode === 'unknown' ? (
          <Banner tone="warn">
            服务端返回的角色模式不在原生三个取值内（可能来自直接写库或历史数据），这里不按默认值处理，
            也不据此提供合并角色。请先用上面三项之一明确保存。
          </Banner>
        ) : null}
      </PageCard>

      <PageCard title="角色列表" description="点“成员与权限”维护成员、原页面入口授权与数据授权。">
        <StateView
          state={list.state}
          message={list.message}
          onRetry={list.refetch}
          emptyTitle="还没有角色"
          emptyDescription="可以新建第一个角色。"
        />
        {list.rows.length > 0 ? (
          <DataTable
            columns={columns}
            rows={list.rows}
            rowKey={(row) => row.name}
            onRowClick={(row) => navigate(`/access/roles/${encodeURIComponent(row.name)}`)}
          />
        ) : null}
      </PageCard>

      <Modal
        open={modalOpen}
        title={creating ? '新建角色' : `编辑角色：${editing?.name ?? ''}`}
        description="角色名创建后不可修改；内置角色（root/admin/member）删除会被后端拒绝。"
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        wide
        footer={
          <>
            <button
              type="button"
              className={styles.button}
              onClick={() => {
                setCreating(false);
                setEditing(null);
              }}
            >
              取消
            </button>
            <button
              type="button"
              className={`${styles.button} ${styles.buttonPrimary}`}
              disabled={!canSubmit || (!creating && !editing)}
              onClick={() => void submitForm()}
            >
              {action.pending ? '保存中…' : '保存'}
            </button>
          </>
        }
      >
        <ActionBanner action={action} />
        <div className={styles.formGrid} style={{ marginTop: 12 }}>
          <Field label="角色标识 name" required hint="只能用小写字母、数字、下划线或短横线。">
            <TextInput
              value={form.name}
              disabled={!creating}
              onChange={(name) => setForm({ ...form, name })}
            />
          </Field>
          <Field label="角色名称 title" required>
            <TextInput value={form.title} onChange={(title) => setForm({ ...form, title })} />
          </Field>
          <div className={styles.formGridFull}>
            <Field label="说明">
              <TextArea value={form.description} onChange={(description) => setForm({ ...form, description })} />
            </Field>
          </div>
          <div className={styles.formGridFull}>
            <span className={styles.label}>权限片段 snippets</span>
            <div className={styles.chips}>
              {snippetOptions.length === 0 ? <span className={styles.cellMuted}>暂无可选片段</span> : null}
              {snippetOptions.map((snippet) => (
                <label key={snippet} className={styles.checkboxRow}>
                  <input
                    type="checkbox"
                    checked={form.snippets.includes(snippet)}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        snippets: event.target.checked
                          ? [...form.snippets, snippet]
                          : form.snippets.filter((item) => item !== snippet),
                      })
                    }
                  />
                  <span>{snippet}</span>
                </label>
              ))}
            </div>
            <div className={styles.toolbar} style={{ marginTop: 8 }}>
              <div className={styles.toolbarGrow}>
                <TextInput
                  value={customSnippet}
                  placeholder="自定义权限片段名（需与系统已有片段一致）"
                  onChange={setCustomSnippet}
                />
              </div>
              <button
                type="button"
                className={styles.button}
                disabled={customSnippet.trim() === ''}
                onClick={() => {
                  const value = customSnippet.trim();
                  if (value && !form.snippets.includes(value)) setForm({ ...form, snippets: [...form.snippets, value] });
                  setCustomSnippet('');
                }}
              >
                添加片段
              </button>
            </div>
            {form.snippets.length > 0 ? (
              <div className={styles.chips} style={{ marginTop: 8 }}>
                {form.snippets.map((snippet) => (
                  <Chip key={snippet} onRemove={() => setForm({ ...form, snippets: form.snippets.filter((item) => item !== snippet) })}>
                    {snippet}
                  </Chip>
                ))}
              </div>
            ) : null}
          </div>
          <div className={styles.formGridFull}>
            <CheckboxInput
              checked={form.isDefault}
              onChange={(isDefault) => setForm({ ...form, isDefault })}
              label="设为全局默认角色（全局唯一，新用户创建时自动获得）"
            />
            <CheckboxInput
              checked={form.allowConfigure}
              onChange={(allowConfigure) => setForm({ ...form, allowConfigure })}
              label="允许进入系统配置（allowConfigure）"
            />
            <CheckboxInput
              checked={form.allowNewAiEmployee}
              onChange={(allowNewAiEmployee) => setForm({ ...form, allowNewAiEmployee })}
              label="允许创建数字员工（allowNewAiEmployee）"
            />
          </div>
        </div>
      </Modal>

      <Modal
        open={deleteTarget !== null}
        title={`删除角色：${deleteTarget?.name ?? ''}`}
        description="删除后该角色的成员关系与授权会一并移除；此操作不可撤销。"
        onClose={() => setDeleteTarget(null)}
        footer={
          <>
            <button type="button" className={styles.button} onClick={() => setDeleteTarget(null)}>
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
        <p className={styles.notice}>内置角色 root / admin / member 会被后端拒绝删除，前端不额外假设。</p>
      </Modal>

      <p className={styles.notice}>
        角色成员管理见 <Link to="/access/roles">各角色详情</Link>；数据授权见 <Link to="/access/data">数据授权</Link>。
      </p>
    </BoardPage>
  );
}
