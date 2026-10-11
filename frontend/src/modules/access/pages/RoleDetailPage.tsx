import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { PageCard, StatusPill } from '../../../components/Card';
import { useResourceGet } from '../../../api/hooks';
import type { ModulePageProps } from '../../types';
import {
  ActionBanner,
  Banner,
  BoardPage,
  Chip,
  DataTable,
  MetaGrid,
  Pagination,
  SearchBox,
  StateView,
  formatCell,
  localStyles as styles,
  useAsyncAction,
  type Column,
} from '../ui';
import {
  addRoleDepartments,
  addRoleMembers,
  associationAvailability,
  removeRoleDepartments,
  removeRoleMembers,
  setRoleDepartments,
  useAssociatedList,
  useCompleteAssociatedList,
  useDepartmentCandidates,
  useDepartmentsAssociationCapability,
  useUsersExcludeRole,
} from '../operations';
import { RelationEditor } from '../relations';
import type {
  AiEmployeeRecord,
  DepartmentRecord,
  DesktopRouteRow,
  RoleRecord,
  RolesResourceRow,
  UserRecord,
} from '../types';
import { displayTitle } from '../display';

/**
 * AC-02 角色详情（`/access/roles/:name`）。
 *
 * 成员管理按已核实的原生调用（十页闭环 §E2）：
 *  - `GET/POST /api/roles/<roleName>/users:list|add|remove`，父标识 = 角色名；
 *  - 请求体是**用户 id 裸数组**；
 *  - 候选用户走 `users:listExcludeRole?roleName=`。
 */
export function RoleDetailPage({ module, board }: ModulePageProps) {
  const params = useParams();
  const roleName = params.name ?? '';
  const detail = useResourceGet<RoleRecord>('roles', roleName);
  const [memberPage, setMemberPage] = useState(1);
  const [candidatePage, setCandidatePage] = useState(1);
  const [candidateKeyword, setCandidateKeyword] = useState('');
  const [candidateQuery, setCandidateQuery] = useState('');
  const [selectedMembers, setSelectedMembers] = useState<Array<number | string>>([]);
  const [selectedCandidates, setSelectedCandidates] = useState<Array<number | string>>([]);
  const action = useAsyncAction();

  const members = useAssociatedList<UserRecord>('roles', roleName, 'users', {
    params: { page: memberPage, pageSize: 10, sort: ['-createdAt'] },
  });
  const candidates = useRoleCandidates(roleName, candidatePage, candidateQuery);
  const resources = useAssociatedList<RolesResourceRow>('roles', roleName, 'resources', {
    params: { pageSize: 200 },
  });
  const employees = useAssociatedList<AiEmployeeRecord>('roles', roleName, 'aiEmployees', {
    params: { pageSize: 200 },
  });
  const routes = useAssociatedList<DesktopRouteRow>('roles', roleName, 'desktopRoutes', {
    params: { pageSize: 1 },
  });

  const [departmentKeyword, setDepartmentKeyword] = useState('');
  const [departmentPage, setDepartmentPage] = useState(1);
  const departmentAction = useAsyncAction();
  const roleDepartments = useCompleteAssociatedList<DepartmentRecord>('roles', roleName, 'departments');
  const departmentCandidates = useDepartmentCandidates({
    keyword: departmentKeyword,
    excludeIds: roleDepartments.rows.map((row) => row.id),
    page: departmentPage,
    pageSize: 10,
    enabled: roleName !== '',
  });
  const associationCapability = useDepartmentsAssociationCapability();
  const departmentAvailability = associationAvailability(roleDepartments, associationCapability);

  async function runDepartmentAction(task: () => Promise<unknown>, successMessage: string): Promise<void> {
    await departmentAction.run(task, successMessage);
    roleDepartments.refetch();
    departmentCandidates.refetch();
  }
  const memberColumns: Array<Column<UserRecord>> = [
    {
      key: 'select',
      title: '',
      width: 36,
      render: (row) => (
        <input
          type="checkbox"
          aria-label={`选择成员 ${row.id}`}
          checked={selectedMembers.includes(row.id)}
          onChange={(event) =>
            setSelectedMembers(
              event.target.checked
                ? [...selectedMembers, row.id]
                : selectedMembers.filter((id) => id !== row.id),
            )
          }
        />
      ),
    },
    {
      key: 'nickname',
      title: '成员',
      render: (row) => (
        <span>
          <strong>{row.nickname || row.username || `用户 ${row.id}`}</strong>
          <br />
          <span className={styles.cellMuted}>{row.email ?? row.username ?? '—'}</span>
        </span>
      ),
    },
    { key: 'id', title: '用户 ID', render: (row) => row.id },
  ];

  const candidateColumns: Array<Column<UserRecord>> = [
    {
      key: 'select',
      title: '',
      width: 36,
      render: (row) => (
        <input
          type="checkbox"
          aria-label={`选择候选 ${row.id}`}
          checked={selectedCandidates.includes(row.id)}
          onChange={(event) =>
            setSelectedCandidates(
              event.target.checked
                ? [...selectedCandidates, row.id]
                : selectedCandidates.filter((id) => id !== row.id),
            )
          }
        />
      ),
    },
    {
      key: 'nickname',
      title: '候选用户（尚未属于该角色）',
      render: (row) => (
        <span>
          <strong>{row.nickname || row.username || `用户 ${row.id}`}</strong>
          <br />
          <span className={styles.cellMuted}>{row.email ?? row.username ?? '—'}</span>
        </span>
      ),
    },
    { key: 'id', title: '用户 ID', render: (row) => row.id },
  ];

  const summaryRows = useMemo(() => {
    if (!detail.data) return [];
    return [
      { term: '角色标识', value: detail.data.name },
      { term: '角色名称', value: formatCell(displayTitle(detail.data.title, detail.data.name)) },
      { term: '说明', value: formatCell(detail.data.description) },
      {
        term: '全局默认',
        value: detail.data.default ? <StatusPill tone="brand">是</StatusPill> : <span className={styles.cellMuted}>否</span>,
      },
      {
        term: '可配置系统',
        value: detail.data.allowConfigure ? <StatusPill tone="ok">是</StatusPill> : <span className={styles.cellMuted}>否</span>,
      },
      {
        term: '可建数字员工',
        value:
          detail.data.allowNewAiEmployee !== false ? (
            <StatusPill tone="neutral">是</StatusPill>
          ) : (
            <span className={styles.cellMuted}>否</span>
          ),
      },
      { term: '成员数', value: members.total ?? '—' },
      { term: '数据资源授权数', value: resources.total ?? '—' },
      { term: '可用员工数', value: employees.total ?? '—' },
      { term: '页面入口授权数', value: routes.total ?? '—' },
    ];
  }, [detail.data, members.total, resources.total, employees.total, routes.total]);

  async function addSelected() {
    if (selectedCandidates.length === 0) return;
    const ok = await action.run(() => addRoleMembers(roleName, selectedCandidates), '成员已添加。');
    if (ok) {
      setSelectedCandidates([]);
      members.refetch();
      candidates.refetch();
    }
  }

  async function removeSelected() {
    if (selectedMembers.length === 0) return;
    const ok = await action.run(() => removeRoleMembers(roleName, selectedMembers), '成员已移除。');
    if (ok) {
      setSelectedMembers([]);
      members.refetch();
      candidates.refetch();
    }
  }

  return (
    <BoardPage
      module={module}
      board={board}
      headerActions={
        <Link className={styles.button} to="/access/roles">
          返回角色列表
        </Link>
      }
    >
      <StateView
        state={detail.state}
        message={detail.message}
        onRetry={detail.refetch}
        emptyTitle="没有找到这个角色"
        emptyDescription="角色可能已被删除，或链接已失效。"
      />

      {detail.data ? (
        <>
          <PageCard title={`角色：${displayTitle(detail.data.title, detail.data.name)}`} description="角色信息与授权规模。">
            <MetaGrid rows={summaryRows} />
            {(detail.data.snippets ?? []).length > 0 ? (
              <div className={styles.chips} style={{ marginTop: 10 }}>
                {(detail.data.snippets ?? []).map((snippet) => (
                  <Chip key={snippet}>{snippet}</Chip>
                ))}
              </div>
            ) : null}
            <div className={styles.toolbar} style={{ marginTop: 10 }}>
              <Link className={styles.button} to="/access/features">
                功能与入口授权
              </Link>
              <Link className={styles.button} to="/access/data">
                数据授权
              </Link>
              <Link className={styles.button} to="/access/employees">
                员工与工具权限
              </Link>
            </div>
          </PageCard>

          <PageCard title="成员" description="该角色的成员；可以逐个移除，也可以在下方按名字搜索后添加。">
            <ActionBanner action={action} />
            <StateView
              state={members.state}
              message={members.message}
              onRetry={members.refetch}
              emptyTitle="该角色还没有成员"
              emptyDescription="可以从下方候选用户中添加。"
            />
            {members.rows.length > 0 ? (
              <>
                <DataTable columns={memberColumns} rows={members.rows} rowKey={(row) => row.id} />
                <Pagination page={memberPage} pageSize={10} total={members.total} onPageChange={setMemberPage} />
              </>
            ) : null}
            <div className={styles.toolbar}>
              <button
                type="button"
                className={`${styles.button} ${styles.buttonDanger}`}
                disabled={selectedMembers.length === 0 || action.pending}
                onClick={() => void removeSelected()}
              >
                移除所选成员（{selectedMembers.length}）
              </button>
            </div>
          </PageCard>

          <PageCard title="添加成员" description="候选里只显示还不属于该角色的用户。">
            <div className={styles.toolbar}>
              <div className={styles.toolbarGrow}>
                <SearchBox
                  value={candidateKeyword}
                  onChange={setCandidateKeyword}
                  placeholder="昵称、用户名或邮箱"
                  onSubmit={() => {
                    setCandidateQuery(candidateKeyword);
                    setCandidatePage(1);
                  }}
                />
              </div>
            </div>
            <StateView
              state={candidates.state}
              message={candidates.message}
              onRetry={candidates.refetch}
              emptyTitle="没有可添加的用户"
              emptyDescription="所有匹配的用户都已经属于该角色。"
            />
            {candidates.rows.length > 0 ? (
              <>
                <DataTable columns={candidateColumns} rows={candidates.rows} rowKey={(row) => row.id} />
                <Pagination page={candidatePage} pageSize={10} total={candidates.total} onPageChange={setCandidatePage} />
              </>
            ) : null}
            <div className={styles.toolbar}>
              <button
                type="button"
                className={`${styles.button} ${styles.buttonPrimary}`}
                disabled={selectedCandidates.length === 0 || action.pending}
                onClick={() => void addSelected()}
              >
                添加所选用户（{selectedCandidates.length}）
              </button>
            </div>
          </PageCard>

          <PageCard
            title="关联部门"
            description="该角色关联的部门；这些部门的成员会获得该角色。"
          >
            <RelationEditor<DepartmentRecord, DepartmentRecord>
              current={roleDepartments}
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
                runDepartmentAction(() => addRoleDepartments(roleName, ids), '已把该角色关联到所选部门。')
              }
              onRemove={(ids) =>
                runDepartmentAction(() => removeRoleDepartments(roleName, ids), '已取消该角色与所选部门的关联。')
              }
              onSet={(ids) =>
                runDepartmentAction(() => setRoleDepartments(roleName, ids), '已把该角色的部门整体替换为所选部门。')
              }
              addLabel="关联部门"
              setLabel="整体替换部门"
              emptyCurrentText="该角色暂未关联任何部门"
              deniedText="当前角色没有维护角色部门关联的权限；需要调整时请联系管理员。"
              unavailable={{
                title: '当前实例未开通角色部门关联',
                reason:
                  '本实例暂时不能维护该角色关联的部门（服务端没有提供这项能力）。这不是权限不足，也不是「该角色没有关联部门」。',
                details: (
                  <Banner tone="info">
                    这项能力在本实例开通后，本页会直接显示该角色的部门列表与维护入口，不需要改前端。
                  </Banner>
                ),
              }}
              availability={departmentAvailability}
              editable
              pending={departmentAction.pending}
              action={departmentAction}
              hint="候选里已经排除了当前已关联的部门；整体替换会打开完整名单，可在名单里取消已有部门或只保留所选。"
              testId="role-departments-editor"
            />
          </PageCard>
        </>
      ) : null}
    </BoardPage>
  );
}

/** 候选用户列表：命中 `users:listExcludeRole?roleName=`，只显示不属于该角色的用户。 */
function useRoleCandidates(roleName: string, page: number, keyword: string) {
  const filter = useMemo(() => {
    if (!keyword.trim()) return undefined;
    const like = { $includes: keyword.trim() };
    return { $or: [{ nickname: like }, { username: like }, { email: like }] };
  }, [keyword]);
  return useUsersExcludeRole(roleName, { page, pageSize: 10, filter: filter ?? undefined });
}
