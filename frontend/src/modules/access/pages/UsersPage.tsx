import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { PageCard, StatusPill } from '../../../components/Card';
import { useResourceList } from '../../../api/hooks';
import { resolveFileUrl } from '../../../api/attachments';
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
  TextInput,
  formatCell,
  useAsyncAction,
  localStyles as styles,
  type Column,
} from '../ui';
import { createUser, useUsersAvatarField } from '../operations';
import type { RoleRecord, UserRecord } from '../types';
import { roleLabel } from '../display';

/**
 * AC-01 用户列表（`/access/users`）。
 *
 * 真实数据：`GET users:list`（13000 实测 356 条），角色列来自 `appends[]=roles`。
 * 新建用户时 `roles` 按**引用语义**（角色名数组）随 `users:create` 一次提交，
 * 不改成 `rolesUsers` 关联集合的直接改写。
 */
export function UsersPage({ module, board }: ModulePageProps) {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [keywordInput, setKeywordInput] = useState('');
  const [keyword, setKeyword] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({
    nickname: '',
    username: '',
    email: '',
    phone: '',
    password: '',
    roleNames: [] as string[],
  });
  const action = useAsyncAction();

  const filter = useMemo(() => {
    if (!keyword.trim()) return undefined;
    const like = { $includes: keyword.trim() };
    return { $or: [{ nickname: like }, { username: like }, { email: like }] };
  }, [keyword]);

  /**
   * 头像列只在 `users` 集合真的有 `avatar` 字段时出现（否则列里永远只会显示"未设置"，
   * 而且会平白多读一个不存在的关联）。判断依据是真实集合字段元数据。
   */
  const avatarField = useUsersAvatarField();

  const list = useResourceList<UserRecord>('users', {
    params: {
      page,
      pageSize,
      sort: ['-createdAt'],
      appends: avatarField.present ? ['roles', 'avatar'] : ['roles'],
      filter,
    },
    keySuffix: `${keyword}#${avatarField.present ? 'avatar' : 'no-avatar'}`,
  });
  const roles = useResourceList<RoleRecord>('roles', { params: { pageSize: 200, sort: ['name'] } });

  const columns: Array<Column<UserRecord>> = [
    ...(avatarField.present
      ? [
          {
            key: 'avatar',
            title: '头像',
            width: 64,
            render: (row: UserRecord) => {
              const url = resolveFileUrl(row.avatar);
              const name = row.nickname || row.username || `用户 ${row.id}`;
              return url ? (
                <img
                  className={styles.avatarThumb}
                  src={url}
                  alt={`${name}的头像`}
                  width={32}
                  height={32}
                  loading="lazy"
                />
              ) : (
                <span className={styles.cellMuted}>未设置</span>
              );
            },
          },
        ]
      : []),
    {
      key: 'nickname',
      title: '昵称 / 用户名',
      render: (row) => (
        <span>
          <strong>{row.nickname || row.username || `用户 ${row.id}`}</strong>
          <br />
          <span className={styles.cellMuted}>{row.username ?? '—'}</span>
        </span>
      ),
    },
    { key: 'email', title: '邮箱', render: (row) => formatCell(row.email) },
    { key: 'phone', title: '手机', render: (row) => formatCell(row.phone) },
    {
      key: 'roles',
      title: '所属角色',
      render: (row) => {
        const items = row.roles ?? [];
        if (items.length === 0) return <span className={styles.cellMuted}>未分配</span>;
        return (
          <span className={styles.chips}>
            {items.map((role) => (
              <StatusPill key={role.name} tone="neutral">
                {roleLabel(role)}
              </StatusPill>
            ))}
          </span>
        );
      },
    },
    { key: 'appLang', title: '界面语言', render: (row) => formatCell(row.appLang) },
  ];

  async function submitCreate() {
    const ok = await action.run(
      () =>
        createUser({
          nickname: form.nickname.trim(),
          username: form.username.trim(),
          email: form.email.trim(),
          phone: form.phone.trim() || undefined,
          ...(form.password.trim() ? { password: form.password } : {}),
          ...(form.roleNames.length > 0 ? { roles: form.roleNames } : {}),
        }),
      '用户已创建。',
    );
    if (ok) {
      setCreateOpen(false);
      setForm({ nickname: '', username: '', email: '', phone: '', password: '', roleNames: [] });
      list.refetch();
    }
  }

  const canSubmit = form.nickname.trim() !== '' && form.email.trim() !== '' && !action.pending;

  return (
    <BoardPage
      module={module}
      board={board}
      headerMeta={`共 ${list.total ?? '—'} 个用户`}
      headerActions={
        <button type="button" className={`${styles.button} ${styles.buttonPrimary}`} onClick={() => setCreateOpen(true)}>
          新建用户
        </button>
      }
    >
      <PageCard title="用户列表" description="按昵称、用户名或邮箱搜索；点开一行查看详情并维护角色。">
        <div className={styles.toolbar}>
          <div className={styles.toolbarGrow}>
            <SearchBox
              value={keywordInput}
              onChange={setKeywordInput}
              placeholder="昵称、用户名或邮箱"
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
          emptyTitle="没有找到用户"
          emptyDescription="换一个搜索条件，或新建用户。"
        />
        {list.state !== 'loading' && list.rows.length > 0 ? (
          <>
            <DataTable
              columns={columns}
              rows={list.rows}
              rowKey={(row) => row.id}
              onRowClick={(row) => navigate(`/access/users/${row.id}`)}
            />
            <Pagination
              page={page}
              pageSize={pageSize}
              total={list.total}
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
        open={createOpen}
        title="新建用户"
        description="角色按引用方式一次性随用户提交；密码留空表示不由这里设置。"
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <button type="button" className={styles.button} onClick={() => setCreateOpen(false)}>
              取消
            </button>
            <button
              type="button"
              className={`${styles.button} ${styles.buttonPrimary}`}
              disabled={!canSubmit}
              onClick={() => void submitCreate()}
            >
              {action.pending ? '提交中…' : '创建'}
            </button>
          </>
        }
      >
        <ActionBanner action={action} />
        <div className={styles.formGrid} style={{ marginTop: 12 }}>
          <Field label="昵称" required>
            <TextInput value={form.nickname} onChange={(nickname) => setForm({ ...form, nickname })} />
          </Field>
          <Field label="用户名" hint="登录标识之一；可与邮箱二选一。">
            <TextInput value={form.username} onChange={(username) => setForm({ ...form, username })} />
          </Field>
          <Field label="邮箱" required>
            <TextInput type="email" value={form.email} onChange={(email) => setForm({ ...form, email })} />
          </Field>
          <Field label="手机">
            <TextInput value={form.phone} onChange={(phone) => setForm({ ...form, phone })} />
          </Field>
          <Field label="初始密码" hint="留空表示不设置。">
            <TextInput type="password" value={form.password} onChange={(password) => setForm({ ...form, password })} />
          </Field>
          <div className={`${styles.field} ${styles.formGridFull}`}>
            <span className={styles.label}>所属角色</span>
            <StateView state={roles.state} message={roles.message} onRetry={roles.refetch} />
            {roles.rows.length > 0 ? (
              <div className={styles.chips}>
                {roles.rows.map((role) => (
                  <label key={role.name} className={styles.checkboxRow}>
                    <input
                      type="checkbox"
                      checked={form.roleNames.includes(role.name)}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          roleNames: event.target.checked
                            ? [...form.roleNames, role.name]
                            : form.roleNames.filter((name) => name !== role.name),
                        })
                      }
                    />
                    <span>{roleLabel(role)}</span>
                  </label>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </Modal>
    </BoardPage>
  );
}
