import { roleLabel } from '../../access/display';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { PageCard, StatusPill } from '../../../components/Card';
import { useResourceList } from '../../../api/hooks';
import { resolveRouteTarget } from '../../../permissions/modules';
import type { ModulePageProps } from '../../types';
import {
  Banner,
  BoardPage,
  DataTable,
  Field,
  SelectInput,
  StateView,
  formatCell,
  localStyles as styles,
  type Column,
} from '../../access/ui';
import { useAssociatedList } from '../../access/operations';
import type { RoleRecord } from '../../access/types';

interface RoleResourceRow {
  id: number;
  dataSourceKey?: string;
  roleName?: string;
  name?: string;
  usingActionsConfig?: boolean;
}

/**
 * DS-05 数据源访问配置入口（`/datasource/access`）。
 *
 * 与 AC-04 使用**同一份** `dataSourcesRolesResources*` 数据，不建第二套规则：
 * 本页只做数据源维度的只读视图与跳转，维护统一在「数据授权」页。
 *
 * 13000 实测：`roles/<role>/resources:list` 可用；`dataSources/main/roles:list` 返回 500
 * （父资源斜杠形式在该实例不可用），因此统一走角色侧路径，并在界面如实说明。
 */
export function AccessPage({ module, board }: ModulePageProps) {
  const roles = useResourceList<RoleRecord>('roles', { params: { pageSize: 200, sort: ['name'] } });
  const [roleName, setRoleName] = useState('');

  useEffect(() => {
    if (!roleName && roles.rows.length > 0) {
      const preferred = roles.rows.find((role) => role.name.startsWith('r_')) ?? roles.rows[0];
      setRoleName(preferred.name);
    }
  }, [roles.rows, roleName]);

  const resources = useAssociatedList<RoleResourceRow>('roles', roleName || null, 'resources', {
    params: { pageSize: 300, sort: ['name'] },
  });
  const scopes = useResourceList<{ id: number; name?: string; key?: string }>(
    'dataSourcesRolesResourcesScopes',
    { params: { pageSize: 1 } },
  );
  const actions = useResourceList<{ id: number }>('dataSourcesRolesResourcesActions', { params: { pageSize: 1 } });

  const mainResources = useMemo(
    () => resources.rows.filter((row) => !row.dataSourceKey || row.dataSourceKey === 'main'),
    [resources.rows],
  );

  const columns: Array<Column<RoleResourceRow>> = [
    { key: 'name', title: '集合', render: (row) => <span className={styles.cellMono}>{formatCell(row.name)}</span> },
    {
      key: 'dataSourceKey',
      title: '数据源',
      render: (row) => (row.dataSourceKey === 'main' ? <StatusPill tone="brand">主数据源</StatusPill> : formatCell(row.dataSourceKey)),
    },
    {
      key: 'usingActionsConfig',
      title: '动作配置',
      render: (row) => (row.usingActionsConfig ? <StatusPill tone="ok">自定义</StatusPill> : <span className={styles.cellMuted}>按策略</span>),
    },
  ];

  return (
    <BoardPage module={module} board={board}>
      <PageCard
        title="数据源维度的访问配置"
        description="选择角色查看它在数据源/集合上的授权规模；维护入口统一在用户与权限的数据授权页。"
      >
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
              <StatusPill tone="neutral">{`资源授权 ${resources.total ?? '—'}`}</StatusPill>
              <StatusPill tone="neutral">{`记录范围 ${scopes.total ?? '—'}`}</StatusPill>
              <StatusPill tone="neutral">{`动作配置 ${actions.total ?? '—'}`}</StatusPill>
            </span>
          </div>
        ) : null}
      </PageCard>

      <PageCard
        title="该角色的资源授权"
        description="这个角色当前被授权访问的集合与动作配置。"
        actions={<CrossModuleLink to={dataPermissionLink(roleName)}>前往数据授权维护</CrossModuleLink>}
      >
        <StateView
          state={resources.state}
          message={resources.message}
          onRetry={resources.refetch}
          emptyTitle="该角色还没有数据源资源授权"
          emptyDescription="没有独立资源记录不代表不能访问：核心资源可能走角色默认策略，最终以后端判定为准。"
        />
        {mainResources.length > 0 ? (
          <DataTable columns={columns} rows={mainResources} rowKey={(row) => row.id} />
        ) : null}
        <Banner tone="info">
          这里的权限（哪些集合动作可用、哪些字段可见可写、记录范围）与「用户与权限 → 数据授权」是同一份设置，
          不会出现两套规则；请在数据授权页按角色维护，本页只作为入口。
        </Banner>
      </PageCard>

      <PageCard title="相关入口">
        <div className={styles.toolbar}>
          <Link className={styles.button} to="/datasource/tables">
            数据表与字段
          </Link>
          <Link className={styles.button} to="/datasource/preview">
            数据预览
          </Link>
          <CrossModuleLink to={dataPermissionLink(roleName)}>数据授权</CrossModuleLink>
        </div>
      </PageCard>
    </BoardPage>
  );
}

/**
 * 跨模块入口（DS-05 → AC-04）。
 *
 * 目标页面存在才渲染链接：先查注册表（`resolveRouteTarget`），
 * 找不到就不给一个可能 404 的链接，而显示一条诚实的说明。
 * 这和使用者所在的模块无关，因此这里不硬编码页面是否存在。
 *
 * 选中的角色随链接一起带上（`?role=<角色名>`）：进入数据授权页后仍停在同一个角色，
 * 不需要用户再选一次。没有选中角色时保持页面自身的默认行为。
 */
function dataPermissionLink(roleName: string): string {
  return roleName ? `/access/data?role=${encodeURIComponent(roleName)}` : '/access/data';
}

function CrossModuleLink({ to, children }: { to: string; children: ReactNode }) {
  const target = resolveRouteTarget(to);
  if (!target?.board) {
    return <span className={styles.cellMuted}>该维护入口在当前版本不可用，请从左侧导航进入「用户与权限 → 数据授权」。</span>;
  }
  return (
    <Link className={styles.button} to={to}>
      {children}
    </Link>
  );
}
