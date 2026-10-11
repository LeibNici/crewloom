import { roleLabel } from '../display';
import { useEffect, useMemo, useState } from 'react';
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
  SelectInput,
  StateView,
  formatCell,
  localStyles as styles,
  useAsyncAction,
  type Column,
} from '../ui';
import { SaveRow } from '../components';
import {
  addRoleAiEmployees,
  getAiEmployee,
  removeRoleAiEmployees,
  updateRole,
  useAiEmployeesByUser,
  useAssociatedList,
} from '../operations';
import type { AiEmployeeRecord, RoleRecord } from '../types';

/**
 * AC-05 员工与工具权限（`/access/employees`）。
 *
 * 区分两件事（不要混为一谈）：
 *  - **管理授权**：`roles/<role>/aiEmployees` 决定该角色可以管理/使用哪些员工；
 *    建员工资格由角色字段 `allowNewAiEmployee` 表达；
 *  - **使用结果**：`aiEmployees:listByUser` 是**当前登录账号**实际可用的员工（root 旁路）。
 *    它不是"该角色"的配置，所以只作为对照展示。
 *
 * 工具是否自动执行由员工自身的 `skillSettings.tools[].autoCall` 表达（ALLOW/ASK 语义），
 * 属于员工配置（AI-02），这里只读呈现，避免跨模块重复一套编辑。
 */
export function EmployeesPermissionPage({ module, board }: ModulePageProps) {
  const roles = useResourceList<RoleRecord>('roles', { params: { pageSize: 200, sort: ['name'] } });
  const [roleName, setRoleName] = useState('');
  const [selectedEmployees, setSelectedEmployees] = useState<string[]>([]);
  const [employeeDetail, setEmployeeDetail] = useState<AiEmployeeRecord | null>(null);
  const [allowNew, setAllowNew] = useState(true);
  const action = useAsyncAction();

  useEffect(() => {
    if (!roleName && roles.rows.length > 0) setRoleName(roles.rows[0].name);
  }, [roles.rows, roleName]);

  const currentRole = useMemo(
    () => roles.rows.find((role) => role.name === roleName) ?? null,
    [roles.rows, roleName],
  );

  useEffect(() => {
    setAllowNew(currentRole?.allowNewAiEmployee !== false);
  }, [currentRole]);

  const roleEmployees = useAssociatedList<AiEmployeeRecord>('roles', roleName || null, 'aiEmployees', {
    params: { pageSize: 200, sort: ['username'] },
  });
  const allEmployees = useResourceList<AiEmployeeRecord>('aiEmployees', {
    params: { pageSize: 200, sort: ['username'] },
  });
  const usableEmployees = useAiEmployeesByUser();

  useEffect(() => {
    setSelectedEmployees(roleEmployees.rows.map((row) => row.username));
  }, [roleEmployees.rows]);

  const candidates = useMemo(
    () => allEmployees.rows.filter((row) => !selectedEmployees.includes(row.username)),
    [allEmployees.rows, selectedEmployees],
  );

  const roleColumns: Array<Column<AiEmployeeRecord>> = [
    {
      key: 'select',
      title: '',
      width: 36,
      render: (row) => (
        <input
          type="checkbox"
          aria-label={`选择员工 ${row.username}`}
          checked={selectedEmployees.includes(row.username)}
          onChange={(event) =>
            setSelectedEmployees(
              event.target.checked
                ? [...selectedEmployees, row.username]
                : selectedEmployees.filter((name) => name !== row.username),
            )
          }
        />
      ),
    },
    {
      key: 'nickname',
      title: '员工',
      render: (row) => (
        <span>
          <strong>{row.nickname || row.username}</strong>
          <br />
          <span className={styles.cellMuted}>{row.position ?? row.username}</span>
        </span>
      ),
    },
    {
      key: 'enabled',
      title: '启用',
      render: (row) => (row.enabled ? <StatusPill tone="ok">已启用</StatusPill> : <StatusPill tone="warn">已停用</StatusPill>),
    },
    {
      key: 'tools',
      title: '工具策略',
      render: (row) => {
        const tools = row.skillSettings?.tools ?? [];
        if (tools.length === 0) return <span className={styles.cellMuted}>未配置工具</span>;
        const ask = tools.filter((tool) => tool.autoCall === false).length;
        return <span className={styles.cellMuted}>{`${tools.length} 个工具，其中 ${ask} 个需确认`}</span>;
      },
    },
    {
      key: 'actions',
      title: '操作',
      render: (row) => (
        <button
          type="button"
          className={`${styles.button} ${styles.buttonLink}`}
          onClick={async (event) => {
            event.stopPropagation();
            const result = await getAiEmployee(row.username);
            setEmployeeDetail(result.data as AiEmployeeRecord);
          }}
        >
          查看工具确认策略
        </button>
      ),
    },
  ];

  async function saveEmployees() {
    const current = roleEmployees.rows.map((row) => row.username);
    const toAdd = selectedEmployees.filter((name) => !current.includes(name));
    const toRemove = current.filter((name) => !selectedEmployees.includes(name));
    if (toAdd.length === 0 && toRemove.length === 0) return;
    const ok = await action.run(async () => {
      if (toAdd.length > 0) await addRoleAiEmployees(roleName, toAdd);
      if (toRemove.length > 0) await removeRoleAiEmployees(roleName, toRemove);
    }, `员工授权已保存（新增 ${toAdd.length}、移除 ${toRemove.length}）。`);
    if (ok) roleEmployees.refetch();
  }

  async function saveAllowNew() {
    if (!currentRole) return;
    const ok = await action.run(
      () => updateRole(currentRole.name, { allowNewAiEmployee: allowNew }),
      '建员工资格已保存。',
    );
    if (ok) roles.refetch();
  }

  const dirty =
    selectedEmployees.length !== roleEmployees.rows.length ||
    selectedEmployees.some((name) => !roleEmployees.rows.some((row) => row.username === name));

  /**
   * 「我可用」列表用的是 `aiEmployees:listByUser`：它**不分页、也不返回 meta 总数**，
   * 一次返回当前账号可用的全部员工。因此这里的口径是**已加载的整个数组**，
   * 不能像分页列表那样用 `meta.count`（那样只会得到"—"），也不改写其它列表的分页口径。
   */
  const usableCount =
    usableEmployees.state === 'ready' || usableEmployees.state === 'empty' ? usableEmployees.rows.length : null;

  return (
    <BoardPage module={module} board={board}>
      <PageCard title="选择角色" description="员工授权按角色维护；使用结果单独对照。">
        <StateView state={roles.state} message={roles.message} onRetry={roles.refetch} />
        {roles.rows.length > 0 ? (
          <div className={styles.toolbar}>
            <div className={styles.toolbarGrow}>
              <Field label="角色">
                <SelectInput
                  value={roleName}
                  options={roles.rows.map((role) => ({ value: role.name, label: `${roleLabel(role)}（${role.name}）` }))}
                  onChange={(next) => setRoleName(String(next))}
                />
              </Field>
            </div>
            <span className={styles.chips}>
              <StatusPill tone="neutral">{`授权员工 ${roleEmployees.total ?? '—'}`}</StatusPill>
              <StatusPill tone="neutral">{`全部员工 ${allEmployees.total ?? '—'}`}</StatusPill>
              <StatusPill tone="brand">{`我可用 ${usableCount ?? '—'}`}</StatusPill>
            </span>
          </div>
        ) : null}
      </PageCard>

      {roleName ? (
        <>
          <PageCard
            title="该角色可用的数字员工"
            description="勾选该角色可以使用的员工后保存；保存时按差异加入或移除。"
          >
            <ActionBanner action={action} />
            <StateView
              state={roleEmployees.state}
              message={roleEmployees.message}
              onRetry={roleEmployees.refetch}
              emptyTitle="该角色还没有可用员工"
              emptyDescription="可以从下方全部员工中添加。"
            />
            {roleEmployees.rows.length > 0 ? (
              <DataTable columns={roleColumns} rows={roleEmployees.rows} rowKey={(row) => row.username} />
            ) : null}
            <SaveRow
              label="保存员工授权"
              pending={action.pending}
              disabled={!dirty}
              onSave={() => void saveEmployees()}
              onReset={() => setSelectedEmployees(roleEmployees.rows.map((row) => row.username))}
            />
          </PageCard>

          <PageCard title="可添加的员工" description="管理员视角的全部员工。">
            <StateView state={allEmployees.state} message={allEmployees.message} onRetry={allEmployees.refetch} />
            {candidates.length > 0 ? (
              <DataTable
                columns={[
                  {
                    key: 'add',
                    title: '',
                    width: 60,
                    render: (row) => (
                      <button
                        type="button"
                        className={`${styles.button} ${styles.buttonLink}`}
                        onClick={() => setSelectedEmployees([...selectedEmployees, row.username])}
                      >
                        加入
                      </button>
                    ),
                  },
                  { key: 'nickname', title: '员工', render: (row) => row.nickname || row.username },
                  { key: 'username', title: '标识', render: (row) => <span className={styles.cellMono}>{row.username}</span> },
                  { key: 'position', title: '岗位', render: (row) => formatCell(row.position) },
                ]}
                rows={candidates}
                rowKey={(row) => row.username}
                emptyText="该角色已包含全部员工。"
              />
            ) : (
              <p className={styles.notice}>该角色已包含全部员工。</p>
            )}
          </PageCard>

          <PageCard
            title="建员工资格"
            description="控制该角色是否可以创建新的数字员工。"
          >
            <CheckboxInput
              checked={allowNew}
              onChange={setAllowNew}
              label="允许该角色创建数字员工"
              disabled={action.pending}
            />
            <SaveRow
              label="保存资格"
              pending={action.pending}
              disabled={!currentRole || currentRole.allowNewAiEmployee === allowNew}
              onSave={() => void saveAllowNew()}
            />
          </PageCard>

          <PageCard
            title="工具确认策略（只读）"
            description="工具是否自动执行由员工自身配置决定（autoCall=true 表示自动执行，false 表示需要确认）。"
          >
            <Banner tone="info">
              这一项属于员工配置（AI-02，由 AI 模块维护），这里只做只读核对，避免出现两套编辑入口。
            </Banner>
            {employeeDetail ? (
              <>
                <p className={styles.notice}>
                  员工：<strong>{employeeDetail.nickname || employeeDetail.username}</strong>
                </p>
                <div className={styles.toolList}>
                  {(employeeDetail.skillSettings?.tools ?? []).map((tool) => (
                    <div className={styles.toolRow} key={tool.name}>
                      <span className={styles.cellMono}>{tool.name}</span>
                      {tool.autoCall === false ? (
                        <StatusPill tone="warn">需要确认</StatusPill>
                      ) : (
                        <StatusPill tone="ok">自动执行</StatusPill>
                      )}
                    </div>
                  ))}
                  {(employeeDetail.skillSettings?.tools ?? []).length === 0 ? (
                    <p className={styles.notice}>该员工还没有配置工具。</p>
                  ) : null}
                </div>
              </>
            ) : (
              <p className={styles.notice}>在上表点「查看工具确认策略」查看某个员工的工具配置。</p>
            )}
          </PageCard>

          <PageCard
            title="使用结果对照"
            description="当前登录账号实际可用的员工；它不是角色配置，仅作对照。"
          >
            <StateView state={usableEmployees.state} message={usableEmployees.message} onRetry={usableEmployees.refetch} />
            {usableEmployees.rows.length > 0 ? (
              <DataTable
                columns={[
                  { key: 'nickname', title: '我可用员工', render: (row) => row.nickname || row.username },
                  { key: 'username', title: '标识', render: (row) => <span className={styles.cellMono}>{row.username}</span> },
                ]}
                rows={usableEmployees.rows}
                rowKey={(row) => row.username}
              />
            ) : null}
            <p className={styles.notice}>
              说明：授权变更后，账号可用的员工由服务端按当前角色实时计算；界面只展示服务端返回的现值。
            </p>
          </PageCard>
        </>
      ) : null}
    </BoardPage>
  );
}
