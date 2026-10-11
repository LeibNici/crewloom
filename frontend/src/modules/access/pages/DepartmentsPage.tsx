import { useEffect, useMemo, useState } from 'react';
import { PageCard, StatusPill } from '../../../components/Card';
import { useResourceList } from '../../../api/hooks';
import { useSessionStore } from '../../../auth/store';
import { isResourceActionAllowed } from '../../../permissions/model';
import type { ModulePageProps } from '../../types';
import {
  ActionBanner,
  Banner,
  BoardPage,
  Field,
  KeyValueTable,
  MetaGrid,
  Modal,
  SelectInput,
  StateView,
  TextArea,
  TextInput,
  formatCell,
  localStyles as styles,
  useAsyncAction,
} from '../ui';
import { roleLabel } from '../display';
import {
  addDepartmentMembers,
  addDepartmentRoles,
  associationAvailability,
  createDepartment,
  destroyDepartment,
  removeDepartmentMembers,
  removeDepartmentRoles,
  setDepartmentMembers,
  setDepartmentRoles,
  updateDepartment,
  useCompleteAssociatedList,
  useDepartmentsAssociationCapability,
  useRoleCandidates,
  useUserCandidates,
} from '../operations';
import { RelationEditor } from '../relations';
import type { DepartmentRecord, OrganizationRecord, RoleRecord, UserRecord } from '../types';

interface DepartmentFormState {
  name: string;
  dept_code: string;
  parentId: string;
  organization_id: string;
  status: string;
  notes: string;
}

const EMPTY_FORM: DepartmentFormState = {
  name: '',
  dept_code: '',
  parentId: '',
  organization_id: '',
  status: 'active',
  notes: '',
};

/**
 * AC-06 部门与组织结构（`/access/departments`）。
 *
 * 数据事实：
 *  - `departments` 集合与 REST 在 13000 可直接使用（50 条），字段是自定义的
 *    `name` / `dept_code` / `organization_id` / `parentId` / `status` / `notes`；
 *  - **部门关联能力**（成员 / 部门角色）由 `@nocobase/plugin-departments` 提供：
 *    插件未启用时 `departments/<id>/members:list`、`departments/<id>/roles:list`、
 *    `users/<id>/departments:list`、`roles/<role>/departments:list` 返回 **500**
 *    （关联路由未注册，本仓库 22 §5 f3 实测）。
 *
 * 本页因此**不把"未开通"写死**：
 *  - 关联列表的失败若是"接口不可用"，显示能力未开通说明（与"空数据""无权限"分开）；
 *  - 关联接口一旦真实可用，就直接渲染真实成员/角色视图，并提供
 *    `add|remove|set` 三个真实关联动作（请求体是裸标识数组，见 operations.ts 的契约注释）。
 *
 * 前端不重写"部门角色并入有效角色"的服务端规则，只维护关联关系。
 */
export function DepartmentsPage({ module, board }: ModulePageProps) {
  const access = useSessionStore((state) => state.access);
  const departments = useResourceList<DepartmentRecord>('departments', {
    params: { pageSize: 200, sort: ['id'] },
  });
  const organizations = useResourceList<OrganizationRecord>('organizations', {
    params: { pageSize: 100, sort: ['id'] },
  });

  const [form, setForm] = useState<DepartmentFormState>(EMPTY_FORM);
  const [editing, setEditing] = useState<DepartmentRecord | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DepartmentRecord | null>(null);
  const [selected, setSelected] = useState<DepartmentRecord | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const action = useAsyncAction();

  useEffect(() => {
    if (!selected && departments.rows.length > 0) setSelected(departments.rows[0]);
  }, [departments.rows, selected]);

  useEffect(() => {
    if (selected) setExpanded((prev) => new Set(prev).add(selected.id));
  }, [selected]);

  const tree = useMemo(() => buildTree(departments.rows), [departments.rows]);

  /**
   * 上级部门 / 所属组织显示的是**当前已经读到的记录名称**。
   *
   * 读不到对应记录时退回原始标识（`#1`），既不丢原值，也不编造一个默认名称。
   */
  const departmentNameById = useMemo(
    () => new Map(departments.rows.map((row) => [row.id, row.name ?? `部门 #${row.id}`])),
    [departments.rows],
  );
  const organizationNameById = useMemo(
    () => new Map(organizations.rows.map((row) => [row.id, row.name ?? `组织 #${row.id}`])),
    [organizations.rows],
  );

  /** 该部门下是否还有下级部门（用于删除前的真实提示，不改变服务端行为）。 */
  const hasChildren = (id: number) => departments.rows.some((row) => row.parentId === id);

  const [memberKeyword, setMemberKeyword] = useState('');
  const [memberPage, setMemberPage] = useState(1);
  const [roleKeyword, setRoleKeyword] = useState('');
  const [rolePage, setRolePage] = useState(1);

  const members = useCompleteAssociatedList<UserRecord>('departments', selected?.id ?? null, 'members');
  const departmentRoles = useCompleteAssociatedList<RoleRecord>('departments', selected?.id ?? null, 'roles');

  /**
   * 候选列表来自真实 `users:list` / `roles:list`，排除已关联项。
   * 不使用 `users:listExcludeDept`：该动作的参数名在本仓库没有逐条证据，不猜。
   */
  const memberCandidates = useUserCandidates({
    keyword: memberKeyword,
    excludeIds: members.rows.map((row) => row.id),
    page: memberPage,
    pageSize: 10,
    enabled: selected !== null,
  });
  const roleCandidates = useRoleCandidates({
    keyword: roleKeyword,
    excludeIds: departmentRoles.rows.map((row) => row.name),
    page: rolePage,
    pageSize: 10,
    enabled: selected !== null,
  });

  /**
   * 能力判定与"这次读取是否成功"分开：
   *  - 字段元数据里没有 `members`/`roles` → 未开通（诚实缺失态）；
   *  - 字段元数据里有、但这次关联读取失败 → **真实读取失败**（可重试），不说成未开通。
   */
  const associationCapability = useDepartmentsAssociationCapability();
  const membersAvailability = associationAvailability(members, associationCapability);
  const rolesAvailability = associationAvailability(departmentRoles, associationCapability);
  const membersAction = useAsyncAction();
  const rolesAction = useAsyncAction();
  const canEditRelations = isResourceActionAllowed(access, 'departments', 'update');

  function openCreate(parent?: DepartmentRecord) {
    setForm({ ...EMPTY_FORM, parentId: parent ? String(parent.id) : '' });
    setCreating(true);
    setEditing(null);
    action.reset();
  }

  function openEdit(record: DepartmentRecord) {
    setForm({
      name: record.name ?? '',
      dept_code: record.dept_code ?? '',
      parentId: record.parentId ? String(record.parentId) : '',
      organization_id: record.organization_id ? String(record.organization_id) : '',
      status: record.status ?? 'active',
      notes: record.notes ?? '',
    });
    setEditing(record);
    setCreating(false);
    action.reset();
  }

  async function submitForm() {
    const values: Record<string, unknown> = {
      name: form.name.trim(),
      dept_code: form.dept_code.trim() || null,
      parentId: form.parentId ? Number(form.parentId) : null,
      organization_id: form.organization_id ? Number(form.organization_id) : null,
      status: form.status,
      notes: form.notes.trim() || null,
    };
    const ok = creating
      ? await action.run(() => createDepartment(values), '部门已创建。')
      : await action.run(() => updateDepartment(editing?.id ?? '', values), '部门已保存。');
    if (ok) {
      setCreating(false);
      setEditing(null);
      departments.refetch();
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const ok = await action.run(() => destroyDepartment(deleteTarget.id), '部门已删除。');
    if (ok) {
      if (selected?.id === deleteTarget.id) setSelected(null);
      setDeleteTarget(null);
    }
    departments.refetch();
  }

  const modalOpen = creating || editing !== null;
  const canSubmit = form.name.trim() !== '' && !action.pending;

  const departmentOptions = departments.rows
    .filter((row) => row.id !== editing?.id)
    .map((row) => ({ value: String(row.id), label: `${row.name ?? row.id}（#${row.id}）` }));

  const organizationOptions = organizations.rows.map((row) => ({
    value: String(row.id),
    label: row.name ?? `组织 #${row.id}`,
  }));

  /** 关联写动作的统一执行：真实动作 → 结果提示 → 读回列表与候选。 */
  async function runRelation(
    actionHandle: ReturnType<typeof useAsyncAction>,
    task: () => Promise<unknown>,
    successMessage: string,
    refreshers: Array<() => void>,
  ): Promise<void> {
    await actionHandle.run(task, successMessage);
    for (const refresh of refreshers) refresh();
  }

  /**
   * 关联能力状态（**按真实接口归因，不写死"未开通"**）。
   *
   * 插件开通后这里会显示"关联接口可用"，页面也会直接渲染成员/角色视图；
   * 接口不可用时才显示"未开通"，并把原因说清楚。
   */
  const relationStates = [membersAvailability, rolesAvailability];
  const relationCapabilityPill =
    relationStates.includes('read-error') ? (
      <StatusPill tone="warn">关联能力已开通，但本次读取失败（可重试）</StatusPill>
    ) : relationStates.includes('indeterminate') ? (
      <StatusPill tone="warn">暂时无法确认（读取失败，可重试）</StatusPill>
    ) : relationStates.every((state) => state === 'available') ? (
      <StatusPill tone="ok">关联能力已开通（成员与部门角色可用）</StatusPill>
    ) : relationStates.includes('unavailable') ? (
      <StatusPill tone="warn">该能力在本实例未开通</StatusPill>
    ) : relationStates.includes('denied') ? (
      <StatusPill tone="warn">无法确认（当前角色没有读取关联的权限）</StatusPill>
    ) : relationStates.includes('error') ? (
      <StatusPill tone="warn">暂时无法确认（读取失败，可重试）</StatusPill>
    ) : (
      <StatusPill tone="neutral">正在确认关联能力…</StatusPill>
    );

  const memberUnavailable = {
    title: '当前实例未开通部门成员关联',
    reason:
      '本实例暂时不能维护部门的成员（服务端没有提供这项能力）。这不是权限不足，也不代表「这个部门没有成员」。部门本身的数据仍可以正常查看和维护。',
    details: (
      <Banner tone="info">
        这项能力在本实例开通后，本页会直接显示成员列表与维护入口，不需要改前端。
      </Banner>
    ),
  };

  const roleUnavailable = {
    title: '当前实例未开通部门角色关联',
    reason:
      '本实例暂时不能维护部门关联的角色（服务端没有提供这项能力）。这与「该部门没有角色」是两回事。部门本身的数据仍可以正常查看和维护。',
    details: (
      <Banner tone="info">
        这项能力在本实例开通后，本页会直接显示部门角色列表与维护入口，不需要改前端。
      </Banner>
    ),
  };

  return (
    <BoardPage module={module} board={board} headerActions={
      <button type="button" className={`${styles.button} ${styles.buttonPrimary}`} onClick={() => openCreate()}>
        新建部门
      </button>
    }>
      <PageCard
        title="概览"
        description="这里显示本实例当前的部门与组织数据；成员和部门角色能不能维护，取决于本实例有没有开通对应能力。"
      >
        <StateView state={departments.state} message={departments.message} onRetry={departments.refetch} />
        <MetaGrid
          rows={[
            { term: '部门数量', value: departments.total ?? '—' },
            { term: '组织数量', value: organizations.total ?? '—' },
            { term: '成员与角色关联', value: relationCapabilityPill },
          ]}
        />
      </PageCard>

      <div className={styles.splitLayout}>
        <PageCard title="部门树" description="按上下级关系排列；点一个部门可以在右侧查看和维护。">
          <StateView state={departments.state} message={departments.message} onRetry={departments.refetch} />
          <div className={styles.tree}>
            {tree.map((node) => (
              <DepartmentTreeRow
                key={node.record.id}
                node={node}
                depth={0}
                expanded={expanded}
                selectedId={selected?.id ?? null}
                onToggle={(id) =>
                  setExpanded((prev) => {
                    const next = new Set(prev);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  })
                }
                onSelect={setSelected}
                onEdit={openEdit}
                onDelete={setDeleteTarget}
                onCreateChild={openCreate}
              />
            ))}
          </div>
          {departments.state === 'ready' && departments.rows.length === 0 ? (
            <p className={styles.notice}>当前实例没有部门记录。</p>
          ) : null}
        </PageCard>

        <div className={styles.stack}>
          {selected ? (
            <PageCard
              title={`部门详情：${selected.name ?? selected.id}`}
              description="在这里维护该部门的资料；如果它下面还有下级部门，需要先处理下级部门。"
            >
              <ActionBanner action={action} />
              <KeyValueTable
                rows={[
                  { key: 'id', label: 'ID', value: selected.id },
                  { key: 'name', label: '名称', value: formatCell(selected.name) },
                  { key: 'code', label: '部门编码', value: formatCell(selected.dept_code) },
                  {
                    key: 'parent',
                    label: '上级部门',
                    value:
                      selected.parentId !== null && selected.parentId !== undefined ? (
                        <span>{departmentNameById.get(selected.parentId) ?? `#${selected.parentId}`}</span>
                      ) : (
                        <span className={styles.cellMuted}>顶级部门</span>
                      ),
                  },
                  {
                    key: 'org',
                    label: '所属组织',
                    value:
                      selected.organization_id !== null && selected.organization_id !== undefined ? (
                        <span>{organizationNameById.get(selected.organization_id) ?? `#${selected.organization_id}`}</span>
                      ) : (
                        <span className={styles.cellMuted}>未指定</span>
                      ),
                  },
                  {
                    key: 'status',
                    label: '状态',
                    value:
                      departmentStatusLabel(selected.status) ?? <span className={styles.cellMuted}>—</span>,
                  },
                  { key: 'notes', label: '备注', value: formatCell(selected.notes) },
                ]}
              />
              <div className={styles.toolbar} style={{ marginTop: 10 }}>
                <button type="button" className={styles.button} onClick={() => openEdit(selected)}>
                  编辑
                </button>
                <button type="button" className={styles.button} onClick={() => openCreate(selected)}>
                  新增下级部门
                </button>
                <button
                  type="button"
                  className={`${styles.button} ${styles.buttonDanger}`}
                  onClick={() => setDeleteTarget(selected)}
                >
                  删除
                </button>
              </div>
            </PageCard>
          ) : (
            <PageCard title="部门详情" description="从左侧选择一个部门。">
              <p className={styles.notice}>选择后可以编辑资料、查看成员与角色关联情况。</p>
            </PageCard>
          )}

          <PageCard
            title="部门成员"
            description="维护该部门的成员；成员会随之获得这个部门关联的角色。"
          >
            {selected ? (
              <RelationEditor<UserRecord, UserRecord>
                current={members}
                renderCurrent={(row) => ({
                  key: row.id,
                  title: row.nickname || row.username || `用户 ${row.id}`,
                  meta: row.email ?? row.phone ?? undefined,
                })}
                candidates={memberCandidates}
                renderCandidate={(row) => ({
                  key: row.id,
                  title: row.nickname || row.username || `用户 ${row.id}`,
                  meta: row.email ?? undefined,
                })}
                candidateKeyword={memberKeyword}
                onCandidateKeyword={(next) => {
                  setMemberKeyword(next);
                  setMemberPage(1);
                }}
                candidatePage={memberPage}
                onCandidatePage={setMemberPage}
                onAdd={(ids) =>
                  runRelation(membersAction, () => addDepartmentMembers(selected.id, ids), '已把所选用户加入该部门。', [
                    members.refetch,
                    memberCandidates.refetch,
                  ])
                }
                onRemove={(ids) =>
                  runRelation(membersAction, () => removeDepartmentMembers(selected.id, ids), '已把所选用户移出该部门。', [
                    members.refetch,
                    memberCandidates.refetch,
                  ])
                }
                onSet={(ids) =>
                  runRelation(membersAction, () => setDepartmentMembers(selected.id, ids), '已把该部门成员整体替换为所选用户。', [
                    members.refetch,
                    memberCandidates.refetch,
                  ])
                }
                addLabel="加入成员"
                setLabel="整体替换成员"
                emptyCurrentText="该部门暂无成员"
                deniedText="当前角色没有维护部门成员的权限；需要调整时请联系管理员。"
                unavailable={memberUnavailable}
                availability={membersAvailability}
                editable={canEditRelations}
                pending={membersAction.pending}
                action={membersAction}
                hint="候选里已经排除了当前已加入的成员；整体替换会打开完整名单，可在名单里取消已有成员或只保留所选。"
                testId="department-members-editor"
              />
            ) : (
              <p className={styles.notice}>先从左侧选择一个部门。</p>
            )}
          </PageCard>

          <PageCard
            title="部门角色"
            description="维护该部门关联的角色；关联后，部门成员会获得这个角色。"
          >
            {selected ? (
              <RelationEditor<RoleRecord, RoleRecord>
                current={departmentRoles}
                renderCurrent={(row) => ({ key: row.name, title: roleLabel(row), meta: row.description ?? undefined })}
                candidates={roleCandidates}
                renderCandidate={(row) => ({ key: row.name, title: roleLabel(row), meta: row.description ?? undefined })}
                candidateKeyword={roleKeyword}
                onCandidateKeyword={(next) => {
                  setRoleKeyword(next);
                  setRolePage(1);
                }}
                candidatePage={rolePage}
                onCandidatePage={setRolePage}
                onAdd={(names) =>
                  runRelation(rolesAction, () => addDepartmentRoles(selected.id, names.map(String)), '已把所选角色关联到该部门。', [
                    departmentRoles.refetch,
                    roleCandidates.refetch,
                  ])
                }
                onRemove={(names) =>
                  runRelation(rolesAction, () => removeDepartmentRoles(selected.id, names.map(String)), '已取消所选角色与该部门的关联。', [
                    departmentRoles.refetch,
                    roleCandidates.refetch,
                  ])
                }
                onSet={(names) =>
                  runRelation(rolesAction, () => setDepartmentRoles(selected.id, names.map(String)), '已把该部门角色整体替换为所选角色。', [
                    departmentRoles.refetch,
                    roleCandidates.refetch,
                  ])
                }
                addLabel="关联角色"
                setLabel="整体替换角色"
                emptyCurrentText="该部门暂未关联角色"
                deniedText="当前角色没有维护部门角色的权限；需要调整时请联系管理员。"
                unavailable={roleUnavailable}
                availability={rolesAvailability}
                editable={canEditRelations}
                pending={rolesAction.pending}
                action={rolesAction}
                hint="候选里已经排除了当前已关联的角色；整体替换会打开完整名单，可在名单里取消已有角色或只保留所选。"
                testId="department-roles-editor"
              />
            ) : (
              <p className={styles.notice}>先从左侧选择一个部门。</p>
            )}
          </PageCard>

          <PageCard
            title="有效角色说明"
            description="成员加入部门后，会同时拥有自己账号的角色和这个部门关联的角色；下面说明当前实例的实际生效方式。"
          >
            {rolesAvailability === 'available' ? (
              <Banner tone="info">
                本实例已开通部门角色：成员登录后的有效角色，是<strong>账号自身角色加上所属部门关联的角色</strong>，
                重复的会自动合并。调整部门角色后会立即按新的结果生效，不需要再给账号重新分配角色。
              </Banner>
            ) : rolesAvailability === 'unavailable' ? (
              <Banner tone="warn">
                本实例没有开通部门角色，所以成员的<strong>有效角色只有账号自身的角色</strong>，不包含部门关联的角色。
                这里不会把读不到的结果当成默认值；功能开通后，本页会直接显示部门角色。
              </Banner>
            ) : rolesAvailability === 'denied' ? (
              <Banner tone="warn">
                当前角色看不到部门角色的数据，所以这里无法确认本实例的生效方式；这不代表部门角色没有生效。
              </Banner>
            ) : rolesAvailability === 'read-error' ? (
              <Banner tone="warn">
                本实例已开通部门角色，但<strong>这次没能读到关联数据</strong>，所以暂时看不到合并后的结果。
                这不代表功能没有生效，也不代表没有开通；可以点上面的「刷新」重试。
              </Banner>
            ) : (
              <Banner tone="info">
                正在确认本实例的部门角色功能，结果出来前这里不下结论；可以点上面的「刷新」重试。
              </Banner>
            )}
            <p className={styles.notice}>
              一个账号可以属于多个部门，其中一个是它的「主部门」。归属与主部门在
              「用户与权限 → 用户详情」里维护；用户自己的部门关联也可以在同一页核对。
            </p>
          </PageCard>

          <PageCard title="组织" description="本实例的组织结构、编码与状态。">
            <StateView state={organizations.state} message={organizations.message} onRetry={organizations.refetch} />
            {organizations.rows.length > 0 ? (
              <KeyValueTable
                rows={organizations.rows.map((row) => ({
                  key: String(row.id),
                  label: row.name ?? `组织 #${row.id}`,
                  value: (
                    <span className={styles.cellMuted}>
                      {`编码 ${row.org_code ?? '—'}；状态 ${departmentStatusLabel(row.status) ?? '—'}`}
                    </span>
                  ),
                }))}
              />
            ) : null}
          </PageCard>
        </div>
      </div>

      <Modal
        open={modalOpen}
        title={creating ? '新建部门' : `编辑部门：${editing?.name ?? ''}`}
        description="填写部门名称、编码与状态；上级部门、所属组织从当前已有的部门和组织里选择。"
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
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
          <Field label="部门名称" required>
            <TextInput value={form.name} onChange={(name) => setForm({ ...form, name })} />
          </Field>
          <Field label="部门编码" hint="用于区分部门，例如 HQ、FIN。">
            <TextInput value={form.dept_code} onChange={(dept_code) => setForm({ ...form, dept_code })} />
          </Field>
          <Field label="上级部门">
            <SelectInput
              value={form.parentId}
              options={departmentOptions}
              allowEmpty
              placeholder="（顶级部门）"
              onChange={(parentId) => setForm({ ...form, parentId: String(parentId) })}
            />
          </Field>
          <Field label="所属组织">
            <SelectInput
              value={form.organization_id}
              options={organizationOptions}
              allowEmpty
              placeholder="（未指定）"
              onChange={(organization_id) => setForm({ ...form, organization_id: String(organization_id) })}
            />
          </Field>
          <Field label="状态">
            <SelectInput
              value={form.status}
              options={[
                { value: 'active', label: '启用' },
                { value: 'inactive', label: '停用' },
              ]}
              onChange={(status) => setForm({ ...form, status: String(status) })}
            />
          </Field>
          <div className={styles.formGridFull}>
            <Field label="备注">
              <TextArea value={form.notes} onChange={(notes) => setForm({ ...form, notes })} />
            </Field>
          </div>
        </div>
      </Modal>

      <Modal
        open={deleteTarget !== null}
        title={`删除部门：${deleteTarget?.name ?? ''}`}
        description="删除不可撤销。如果这个部门下面还有下级部门、或者仍有关联的成员/角色，服务端会拒绝删除；请先处理下级部门与关联，再回来删除。"
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
        {deleteTarget && hasChildren(deleteTarget.id) ? (
          <Banner tone="warn">
            该部门下面还有下级部门，服务端会拒绝这次删除；请先删除或移走下级部门。
          </Banner>
        ) : null}
      </Modal>
    </BoardPage>
  );
}

interface TreeNode {
  record: DepartmentRecord;
  children: TreeNode[];
}

/** 部门状态的自然中文表达；未知取值原样保留，便于核对而不丢原值。 */
const DEPARTMENT_STATUS_LABELS: Record<string, string> = {
  active: '启用',
  inactive: '停用',
};

function departmentStatusLabel(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  return DEPARTMENT_STATUS_LABELS[value] ?? value;
}

function buildTree(rows: DepartmentRecord[]): TreeNode[] {
  const nodes = new Map<number, TreeNode>();
  for (const record of rows) nodes.set(record.id, { record, children: [] });
  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    const parentId = node.record.parentId;
    const parent = parentId !== null && parentId !== undefined ? nodes.get(parentId) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

function DepartmentTreeRow({
  node,
  depth,
  expanded,
  selectedId,
  onToggle,
  onSelect,
  onEdit,
  onDelete,
  onCreateChild,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<number>;
  selectedId: number | null;
  onToggle: (id: number) => void;
  onSelect: (record: DepartmentRecord) => void;
  onEdit: (record: DepartmentRecord) => void;
  onDelete: (record: DepartmentRecord) => void;
  onCreateChild: (parent: DepartmentRecord) => void;
}) {
  const isOpen = expanded.has(node.record.id);
  /** 状态的自然中文表达；未知取值原样显示，未填写时不显示，不按默认值当成停用。 */
  const statusLabel = departmentStatusLabel(node.record.status);
  return (
    <div className={styles.stack} style={{ gap: 2 }}>
      <div
        className={styles.treeRow}
        style={{ paddingLeft: 8 + depth * 16, background: selectedId === node.record.id ? 'var(--brand-soft)' : undefined }}
      >
        {node.children.length > 0 ? (
          <button
            type="button"
            className={styles.treeToggle}
            aria-label={isOpen ? '折叠' : '展开'}
            onClick={() => onToggle(node.record.id)}
          >
            {isOpen ? '▾' : '▸'}
          </button>
        ) : (
          <span className={styles.treeToggle} aria-hidden>
            ·
          </span>
        )}
        <button
          type="button"
          className={styles.treeTitle}
          style={{ border: 'none', background: 'none', textAlign: 'left', cursor: 'pointer', padding: 0 }}
          onClick={() => onSelect(node.record)}
        >
          {node.record.name ?? `部门 #${node.record.id}`}
        </button>
        <span className={styles.treeMeta}>
          {node.record.dept_code ? node.record.dept_code : ''}
          {statusLabel && statusLabel !== '启用' ? `（${statusLabel}）` : ''}
        </span>
        <span className={styles.treeActions}>
          <button type="button" className={`${styles.button} ${styles.buttonLink}`} onClick={() => onCreateChild(node.record)}>
            加下级
          </button>
          <button type="button" className={`${styles.button} ${styles.buttonLink}`} onClick={() => onEdit(node.record)}>
            编辑
          </button>
          <button type="button" className={`${styles.button} ${styles.buttonLink}`} onClick={() => onDelete(node.record)}>
            删除
          </button>
        </span>
      </div>
      {isOpen
        ? node.children.map((child) => (
            <DepartmentTreeRow
              key={child.record.id}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              selectedId={selectedId}
              onToggle={onToggle}
              onSelect={onSelect}
              onEdit={onEdit}
              onDelete={onDelete}
              onCreateChild={onCreateChild}
            />
          ))
        : null}
    </div>
  );
}
