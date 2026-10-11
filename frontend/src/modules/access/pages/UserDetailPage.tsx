import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { PageCard, StatusPill } from '../../../components/Card';
import { AttachmentControl, type AttachmentValue } from '../../../components/AttachmentControl';
import { useResourceGet, useResourceList } from '../../../api/hooks';
import { useSessionStore } from '../../../auth/store';
import { isResourceActionAllowed } from '../../../permissions/model';
import type { ModulePageProps } from '../../types';
import {
  ActionBanner,
  Banner,
  BoardPage,
  CapabilityNotice,
  Field,
  KeyValueTable,
  MetaGrid,
  StateView,
  TextInput,
  formatCell,
  localStyles as styles,
  useAsyncAction,
} from '../ui';
import { RoleCheckboxList, SaveRow } from '../components';
import { RelationEditor } from '../relations';
import {
  addUserDepartments,
  associationAvailability,
  changeMyPassword,
  removeUserDepartments,
  setMyDefaultRole,
  setUserDepartments,
  updateUser,
  updateUserMainDepartment,
  updateUserRoles,
  useCompleteAssociatedList,
  useDepartmentCandidates,
  useDepartmentsAssociationCapability,
  useUsersAvatarField,
} from '../operations';
import type { DepartmentRecord, RoleRecord, RolesUserRow, UserRecord } from '../types';
import { roleLabel } from '../display';

/**
 * AC-01 用户详情（`/access/users/:id`）。
 *
 * 关键契约（十页闭环 §E1）：
 *  - 用户侧角色是**顶层关联字段 + 角色名数组**（引用语义），一次 `users:update` 单事务完成；
 *    不用多次 `roles:add/remove` 替代（会失去原原子性）；
 *  - 用户默认角色（`rolesUsers.default`）与全局默认角色（`roles.default`）是两个概念；
 *  - `users:setDefaultRole` **只能设置当前登录用户自己**，因此对他人只做只读说明。
 */
export function UserDetailPage({ module, board }: ModulePageProps) {
  const params = useParams();
  const id = params.id ?? '';
  const me = useSessionStore((state) => state.user);
  const access = useSessionStore((state) => state.access);

  /**
   * 头像字段能力：`users` 集合没有 `avatar` 时**不**渲染上传控件（见 `useUsersAvatarField` 的说明）。
   * `appends` 也随之变化，避免对不存在的字段发无意义的关联读取。
   */
  const avatarField = useUsersAvatarField();
  const detail = useResourceGet<UserRecord>('users', id, {
    params: { appends: avatarField.present ? ['roles', 'avatar'] : ['roles'] },
  });
  const roles = useResourceList<RoleRecord>('roles', { params: { pageSize: 200, sort: ['name'] } });
  const pivots = useResourceList<RolesUserRow>('rolesUsers', {
    params: { pageSize: 50, filter: { userId: id } },
    enabled: id !== '',
  });

  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [profileForm, setProfileForm] = useState({ nickname: '', username: '', email: '', phone: '' });
  const [passwordForm, setPasswordForm] = useState({ oldPassword: '', newPassword: '', confirmPassword: '' });
  const [adminReset, setAdminReset] = useState({ password: '' });
  const [resetOpen, setResetOpen] = useState(false);
  const [departmentKeyword, setDepartmentKeyword] = useState('');
  const [departmentPage, setDepartmentPage] = useState(1);
  const roleAction = useAsyncAction();
  const profileAction = useAsyncAction();
  const passwordAction = useAsyncAction();
  const defaultRoleAction = useAsyncAction();
  const departmentAction = useAsyncAction();
  const avatarAction = useAsyncAction();

  /**
   * 头像保存：`users.avatar` 是 belongsTo attachments 的**文件字段**，
   * 保存走既有 `users:update`，body 是 `{ avatar: { id } }`（移除时 `null`）。
   * 上传由 `AttachmentControl` 在用户点击时发出（multipart `attachments:upload`），
   * 页面不预置、不自动上传。
   */
  async function saveAvatar(next: AttachmentValue | null): Promise<void> {
    await avatarAction.run(
      () => updateUser(id, { avatar: next && next.id != null ? { id: next.id } : null }),
      next ? '头像已保存。' : '头像已移除。',
    );
    detail.refetch();
  }

  const userDepartments = useCompleteAssociatedList<DepartmentRecord>('users', id, 'departments');
  const departmentCandidates = useDepartmentCandidates({
    keyword: departmentKeyword,
    excludeIds: userDepartments.rows.map((row) => row.id),
    page: departmentPage,
    pageSize: 10,
    enabled: id !== '',
  });
  const associationCapability = useDepartmentsAssociationCapability();
  const departmentAvailability = associationAvailability(userDepartments, associationCapability);

  /**
   * 主部门能力探测：`users.mainDepartmentId` 只在部门插件启用后才注册到 users 集合。
   * 安装前后端根本不返回该键，因此这里按**读回里是否存在该字段**判断，不预置默认值。
   */
  const mainDepartmentSupported =
    detail.data !== null && Object.prototype.hasOwnProperty.call(detail.data, 'mainDepartmentId');

  async function runDepartmentAction(
    task: () => Promise<unknown>,
    successMessage: string,
  ): Promise<void> {
    await departmentAction.run(task, successMessage);
    userDepartments.refetch();
    departmentCandidates.refetch();
    // 主部门是该用户记录上的字段：设置主部门、或移除某个部门（服务端会清掉指向它的主部门）之后，
    // 必须重新读取用户详情，让行上的「已是主部门 / 设为主部门」按服务端现值更新，
    // 而不是停留在保存前读到的旧值。
    detail.refetch();
  }

  const isSelf = Boolean(me && String(me.id) === String(id));

  useEffect(() => {
    if (!detail.data) return;
    setSelectedRoles((detail.data.roles ?? []).map((role) => role.name));
    setProfileForm({
      nickname: detail.data.nickname ?? '',
      username: detail.data.username ?? '',
      email: detail.data.email ?? '',
      phone: detail.data.phone ?? '',
    });
  }, [detail.data]);

  const currentRoleNames = useMemo(
    () => (detail.data?.roles ?? []).map((role) => role.name),
    [detail.data],
  );
  const rolesChanged =
    selectedRoles.length !== currentRoleNames.length ||
    selectedRoles.some((name) => !currentRoleNames.includes(name));

  const defaultRoleName = useMemo(() => {
    const row = pivots.rows.find((item) => item.default === true);
    return row?.roleName ?? null;
  }, [pivots.rows]);

  const globalDefault = useMemo(() => roles.rows.find((role) => role.default === true) ?? null, [roles.rows]);

  async function saveRoles() {
    await roleAction.run(() => updateUserRoles(id, selectedRoles), '角色已保存。');
    detail.refetch();
  }

  /** 只提交本次真正改动过的资料字段，未改动的字段不覆盖（不猜、不重置其它值）。 */
  function buildProfileChanges(): Record<string, unknown> {
    const current = detail.data;
    if (!current) return {};
    const changes: Record<string, unknown> = {};
    if (profileForm.nickname !== (current.nickname ?? '')) changes.nickname = profileForm.nickname.trim();
    if (profileForm.username !== (current.username ?? '')) changes.username = profileForm.username.trim() || null;
    if (profileForm.email !== (current.email ?? '')) changes.email = profileForm.email.trim() || null;
    if (profileForm.phone !== (current.phone ?? '')) changes.phone = profileForm.phone.trim() || null;
    return changes;
  }

  const profileChanges = buildProfileChanges();
  const profileChanged = Object.keys(profileChanges).length > 0;

  function resetProfileForm() {
    const current = detail.data;
    if (!current) return;
    setProfileForm({
      nickname: current.nickname ?? '',
      username: current.username ?? '',
      email: current.email ?? '',
      phone: current.phone ?? '',
    });
  }

  async function saveProfile() {
    if (!detail.data) return;
    const changes = buildProfileChanges();
    if (Object.keys(changes).length === 0) return;
    await profileAction.run(() => updateUser(id, changes), '资料已保存。');
    detail.refetch();
  }

  async function submitMyPassword() {
    const ok = await passwordAction.run(
      () =>
        changeMyPassword({
          oldPassword: passwordForm.oldPassword,
          newPassword: passwordForm.newPassword,
          confirmPassword: passwordForm.confirmPassword,
        }),
      '密码已更新。',
    );
    if (ok) setPasswordForm({ oldPassword: '', newPassword: '', confirmPassword: '' });
  }

  async function submitAdminReset() {
    const ok = await passwordAction.run(
      () => updateUser(id, { password: adminReset.password }),
      '已提交新的登录密码。',
    );
    if (ok) {
      setAdminReset({ password: '' });
      setResetOpen(false);
    }
  }

  async function makeDefault(roleName: string) {
    await defaultRoleAction.run(() => setMyDefaultRole(roleName), `已把「${roleName}」设为你登录后的默认角色。`);
    pivots.refetch();
  }

  return (
    <BoardPage
      module={module}
      board={board}
      headerActions={
        <Link className={styles.button} to="/access/users">
          返回用户列表
        </Link>
      }
    >
      <StateView
        state={detail.state}
        message={detail.message}
        onRetry={detail.refetch}
        emptyTitle="没有找到这个用户"
        emptyDescription="用户可能已被删除，或链接已失效。"
      />

      {detail.data ? (
        <>
          <PageCard
            title={detail.data.nickname || detail.data.username || `用户 ${detail.data.id}`}
            description="这个账号的资料、角色、所属部门与登录密码。"
          >
            <MetaGrid
              rows={[
                { term: '用户 ID', value: detail.data.id },
                { term: '界面语言', value: formatCell(detail.data.appLang) },
                { term: '上次改密时间', value: formatCell(detail.data.passwordChangeTz) },
              ]}
            />
          </PageCard>

          <PageCard
            title="用户资料"
            description="修改昵称、用户名、邮箱与手机号；保存后立即生效。"
          >
            <ActionBanner action={profileAction} />
            <div className={styles.formGrid} style={{ marginTop: 12 }}>
              <Field label="昵称" required>
                <TextInput
                  value={profileForm.nickname}
                  onChange={(nickname) => setProfileForm({ ...profileForm, nickname })}
                />
              </Field>
              <Field label="用户名" hint="登录标识之一，可与邮箱二选一。">
                <TextInput
                  value={profileForm.username}
                  onChange={(username) => setProfileForm({ ...profileForm, username })}
                />
              </Field>
              <Field label="邮箱">
                <TextInput
                  type="email"
                  value={profileForm.email}
                  onChange={(email) => setProfileForm({ ...profileForm, email })}
                />
              </Field>
              <Field label="手机">
                <TextInput
                  value={profileForm.phone}
                  onChange={(phone) => setProfileForm({ ...profileForm, phone })}
                />
              </Field>
            </div>
            <SaveRow
              label="保存资料"
              disabled={!profileChanged || profileForm.nickname.trim() === ''}
              pending={profileAction.pending}
              onSave={() => void saveProfile()}
              onReset={resetProfileForm}
            />
          </PageCard>

          <PageCard
            title="头像"
            description="上传后立即作为该用户的头像显示；移除只会清空头像，不影响其它资料。"
          >
            <ActionBanner action={avatarAction} />
            {avatarField.state === 'available' ? (
              <div data-testid="user-avatar-host">
                <AttachmentControl
                  value={(detail.data.avatar ?? null) as AttachmentValue | null}
                  editable={isResourceActionAllowed(access, 'users', 'update')}
                  attachmentField="users.avatar"
                  variant="avatar"
                  label="用户头像"
                  onChange={(next) => void saveAvatar(next)}
                />
              </div>
            ) : avatarField.state === 'loading' ? (
              <p className={styles.notice}>正在确认头像能力…</p>
            ) : avatarField.state === 'error' ? (
              <Banner tone="warn">暂时无法确认当前实例是否支持用户头像，请稍后重试；这不影响其它资料。</Banner>
            ) : (
              <CapabilityNotice
                title="本系统还没有开启用户头像功能"
                reason="这里暂时不能上传或更换头像。你仍然可以编辑昵称、手机号、角色和所属部门；如果需要头像，请联系管理员开通。"
                details={
                  <Banner tone="info">
                    可以继续使用的操作：编辑上面列出的资料、分配角色、维护所属部门与主部门。头像功能开通后，本页会自动出现上传/更换/移除入口。
                  </Banner>
                }
              />
            )}
          </PageCard>

          <PageCard
            title="角色分配"
            description="勾选该用户的角色后保存；保存后立即生效。"
          >
            <ActionBanner action={roleAction} />
            <StateView state={roles.state} message={roles.message} onRetry={roles.refetch} />
            {roles.rows.length > 0 ? (
              <RoleCheckboxList
                roles={roles.rows}
                selected={selectedRoles}
                disabled={roleAction.pending}
                onChange={setSelectedRoles}
              />
            ) : null}
            <SaveRow
              label="保存角色"
              disabled={!rolesChanged || selectedRoles.length === 0}
              pending={roleAction.pending}
              onSave={() => void saveRoles()}
              onReset={() => setSelectedRoles(currentRoleNames)}
            />
            <p className={styles.notice}>
              说明：至少保留一个角色，避免账号失去全部权限；实际生效范围以后端判定为准。
            </p>
          </PageCard>

          <PageCard
            title="所属部门"
            description="维护该用户属于哪些部门，并可以指定其中一个为主部门。"
          >
            <RelationEditor<DepartmentRecord, DepartmentRecord>
              current={userDepartments}
              renderCurrent={(row) => ({
                key: row.id,
                title: row.name ?? `部门 #${row.id}`,
                meta: row.dept_code ?? undefined,
              })}
              candidates={departmentCandidates}
              renderCandidate={(row) => ({
                key: row.id,
                title: row.name ?? `部门 #${row.id}`,
                meta: row.dept_code ?? undefined,
              })}
              candidateKeyword={departmentKeyword}
              onCandidateKeyword={(next) => {
                setDepartmentKeyword(next);
                setDepartmentPage(1);
              }}
              candidatePage={departmentPage}
              onCandidatePage={setDepartmentPage}
              onAdd={(ids) =>
                runDepartmentAction(() => addUserDepartments(id, ids), '已把该用户加入所选部门。')
              }
              onRemove={(ids) =>
                runDepartmentAction(() => removeUserDepartments(id, ids), '已把该用户移出所选部门。')
              }
              onSet={(ids) =>
                runDepartmentAction(() => setUserDepartments(id, ids), '已把该用户的部门整体替换为所选部门。')
              }
              addLabel="加入部门"
              setLabel="整体替换部门"
              emptyCurrentText="该用户暂未归属任何部门"
              deniedText="当前角色没有维护用户部门的权限；需要调整时请联系管理员。"
              unavailable={{
                title: '当前实例未开通用户部门关联',
                reason:
                  '本实例暂时不能维护该用户的部门（服务端没有提供这项能力）。这不是权限不足，也不是「该用户没有部门」。用户的资料与角色仍可以正常维护。',
                details: (
                  <Banner tone="info">
                    这项能力在本实例开通后，本页会直接显示该用户的部门列表与维护入口，不需要改前端。
                  </Banner>
                ),
              }}
              availability={departmentAvailability}
              editable
              pending={departmentAction.pending}
              action={departmentAction}
              hint="候选里已经排除了当前已关联的部门；整体替换会打开完整名单，可在名单里取消已有部门或只保留所选。"
              testId="user-departments-editor"
              renderRowExtra={(row) =>
                mainDepartmentSupported ? (
                  <button
                    type="button"
                    className={styles.button}
                    disabled={departmentAction.pending || detail.data?.mainDepartmentId === row.id}
                    onClick={() =>
                      void runDepartmentAction(
                        () => updateUserMainDepartment(id, row.id),
                        `已把「${row.name ?? row.id}」设为该用户的主部门。`,
                      )
                    }
                  >
                    {detail.data?.mainDepartmentId === row.id ? '已是主部门' : '设为主部门'}
                  </button>
                ) : null
              }
            />
            {!mainDepartmentSupported && departmentAvailability === 'available' ? (
              <Banner tone="info">
                当前读回的用户记录里没有主部门信息，因此这里不提供「设为主部门」；这不影响所属部门的维护。
              </Banner>
            ) : null}
          </PageCard>

          <PageCard
            title="默认角色"
            description="「该用户默认角色」是这个人登录后默认使用的角色；「全局默认角色」是新用户创建时自动获得的角色，两者不同。"
          >
            <ActionBanner action={defaultRoleAction} />
            {pivots.state === 'denied' ? (
              <Banner tone="warn">当前角色无权读取角色关系记录，默认角色暂不可见；这不代表该用户没有角色。</Banner>
            ) : (
              <MetaGrid
                rows={[
                  { term: '该用户默认角色', value: defaultRoleName ? <StatusPill tone="brand">{defaultRoleName}</StatusPill> : <span className={styles.cellMuted}>未单独设置</span> },
                  { term: '全局默认角色', value: globalDefault ? <StatusPill tone="neutral">{roleLabel(globalDefault)}</StatusPill> : <span className={styles.cellMuted}>未设置</span> },
                ]}
              />
            )}
            {isSelf ? (
              <div className={styles.toolbar} style={{ marginTop: 10 }}>
                {currentRoleNames.map((name) => (
                  <button
                    key={name}
                    type="button"
                    className={styles.button}
                    disabled={defaultRoleAction.pending || defaultRoleName === name}
                    onClick={() => void makeDefault(name)}
                  >
                    {defaultRoleName === name ? `已是默认：${name}` : `设为我的默认角色：${name}`}
                  </button>
                ))}
              </div>
            ) : (
              <Banner tone="info">
                只能由账号本人设置自己的默认角色（当前登录账号可以修改自己的默认角色）。管理员可改为调整角色分配。
              </Banner>
            )}
          </PageCard>

          <PageCard title="密码" description="本人可以在这里修改自己的密码；管理员可以为账号设置新的登录密码。">
            <ActionBanner action={passwordAction} />
            {isSelf ? (
              <div className={styles.formGrid}>
                <Field label="当前密码" required>
                  <TextInput
                    type="password"
                    value={passwordForm.oldPassword}
                    onChange={(oldPassword) => setPasswordForm({ ...passwordForm, oldPassword })}
                  />
                </Field>
                <Field label="新密码" required>
                  <TextInput
                    type="password"
                    value={passwordForm.newPassword}
                    onChange={(newPassword) => setPasswordForm({ ...passwordForm, newPassword })}
                  />
                </Field>
                <Field label="确认新密码" required>
                  <TextInput
                    type="password"
                    value={passwordForm.confirmPassword}
                    onChange={(confirmPassword) => setPasswordForm({ ...passwordForm, confirmPassword })}
                  />
                </Field>
                <div className={styles.formGridFull}>
                  <SaveRow
                    label="更新我的密码"
                    pending={passwordAction.pending}
                    disabled={
                      passwordForm.oldPassword === '' ||
                      passwordForm.newPassword === '' ||
                      passwordForm.newPassword !== passwordForm.confirmPassword
                    }
                    onSave={() => void submitMyPassword()}
                  />
                  {passwordForm.newPassword !== '' && passwordForm.newPassword !== passwordForm.confirmPassword ? (
                    <p className={styles.notice}>两次输入的新密码不一致。</p>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className={styles.formGrid}>
                <Field label="为该用户设置新的登录密码" hint="提交后用户需用新密码登录。">
                  <TextInput
                    type="password"
                    value={adminReset.password}
                    onChange={(password) => setAdminReset({ password })}
                  />
                </Field>
                <div className={styles.formGridFull}>
                  <SaveRow
                    label="提交重置"
                    pending={passwordAction.pending}
                    disabled={adminReset.password === ''}
                    onSave={() => void submitAdminReset()}
                    extra={
                      <button type="button" className={styles.button} onClick={() => setResetOpen((prev) => !prev)}>
                        {resetOpen ? '收起说明' : '重置方式说明'}
                      </button>
                    }
                  />
                  {resetOpen ? (
                    <Banner tone="info">
                      提交后，该账号下次登录需要使用新密码。这里只修改登录密码，不会改动对方的角色与所属部门。
                    </Banner>
                  ) : null}
                </div>
              </div>
            )}
          </PageCard>

          <PageCard title="记录信息" description="该账号的创建与更新时间。">
            <KeyValueTable
              rows={[
                { key: 'createdAt', label: '创建时间', value: formatCell(detail.data.createdAt) },
                { key: 'updatedAt', label: '更新时间', value: formatCell(detail.data.updatedAt) },
                {
                  key: 'roles',
                  label: '当前角色',
                  value:
                    currentRoleNames.length > 0 ? (
                      <span className={styles.chips}>
                        {currentRoleNames.map((name) => (
                          <StatusPill key={name} tone="neutral">
                            {roleLabel(roles.rows.find((role) => role.name === name) ?? { name })}
                          </StatusPill>
                        ))}
                      </span>
                    ) : (
                      <span className={styles.cellMuted}>未分配</span>
                    ),
                },
              ]}
            />
          </PageCard>
        </>
      ) : null}
    </BoardPage>
  );
}
