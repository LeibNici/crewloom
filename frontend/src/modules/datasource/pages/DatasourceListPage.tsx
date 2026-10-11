import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router';
import { PageCard, StatusPill } from '../../../components/Card';
import { useResourceList } from '../../../api/hooks';
import type { ModulePageProps } from '../../types';
import {
  Banner,
  BoardPage,
  CapabilityNotice,
  DataTable,
  formatCell,
  localStyles as styles,
  StateView,
  type Column,
} from '../../access/ui';
import { useEnabledDataSources } from '../operations';
import type { DataSourceRecord } from '../types';
import { displayTitle } from '../../access/display';

/**
 * DS-01 数据源列表（`/datasource/list`）。
 *
 * 13000 实测：`dataSources:list` 只有 1 条（`main`，`type=main`、`enabled=true`、`status=loaded`）；
 * `dataSources:listEnabled` 返回 **0 条**。两者都是真实结果：
 *  - main 即使不在 listEnabled 里也不是"不可用"，它是内建固定数据源；
 *  - 当前实例没有安装外部连接器插件，因此外部数据源确实无法创建（能力未开通，不是空数据）。
 */
export function DatasourceListPage({ module, board }: ModulePageProps) {
  const navigate = useNavigate();
  const list = useResourceList<DataSourceRecord>('dataSources', { params: { pageSize: 50, sort: ['key'] } });
  const enabled = useEnabledDataSources();

  const columns: Array<Column<DataSourceRecord>> = [
    {
      key: 'displayName',
      title: '数据源',
      render: (row) => (
        <span>
          <strong>{displayTitle(row.displayName, row.key)}</strong>
          <br />
          <span className={styles.cellMuted}>{row.key}</span>
        </span>
      ),
    },
    {
      key: 'type',
      title: '类型',
      render: (row) => (row.type === 'main' ? <StatusPill tone="brand">主数据源</StatusPill> : formatCell(row.type)),
    },
    {
      key: 'enabled',
      title: '启用',
      render: (row) => (row.enabled ? <StatusPill tone="ok">已启用</StatusPill> : <StatusPill tone="warn">未启用</StatusPill>),
    },
    {
      key: 'status',
      title: '加载状态',
      render: (row) => {
        const status = row.status ?? '';
        if (status === 'loaded') return <StatusPill tone="ok">已加载</StatusPill>;
        if (status === 'loading') return <StatusPill tone="neutral">加载中</StatusPill>;
        if (status === 'error') return <StatusPill tone="danger">加载失败</StatusPill>;
        return formatCell(status);
      },
    },
    {
      key: 'fixed',
      title: '内建',
      render: (row) => (row.fixed ? '是' : '否'),
    },
  ];

  const typeInventory = useMemo(() => {
    const set = new Set<string>();
    for (const row of list.rows) if (row.type) set.add(row.type);
    return [...set];
  }, [list.rows]);

  const externalTypes = typeInventory.filter((type) => type !== 'main');

  return (
    <BoardPage module={module} board={board} headerMeta={`共 ${list.total ?? '—'} 个数据源`}>
      <PageCard title="数据源" description="点开一行查看详情、集合与字段管理入口。">
        <StateView
          state={list.state}
          message={list.message}
          onRetry={list.refetch}
          emptyTitle="没有可用的数据源"
          emptyDescription="当前账号可能没有查看数据源的权限，或实例还没有加载数据源。"
        />
        {list.rows.length > 0 ? (
          <DataTable
            columns={columns}
            rows={list.rows}
            rowKey={(row) => row.key}
            onRowClick={(row) => navigate(`/datasource/list/${encodeURIComponent(row.key)}`)}
          />
        ) : null}
      </PageCard>

      <PageCard
        title="已启用的外部数据源"
        description="外部连接的启用与加载状态；主数据源由系统内建，不在这个列表里。"
      >
        <StateView
          state={enabled.state}
          message={enabled.message}
          onRetry={enabled.refetch}
          emptyTitle="当前没有启用的外部数据源"
          emptyDescription="这是真实结果，不是加载失败。当前环境只有内建主数据源。"
        />
        {enabled.rows.length > 0 ? (
          <DataTable
            columns={columns}
            rows={enabled.rows}
            rowKey={(row) => row.key}
            onRowClick={(row) => navigate(`/datasource/list/${encodeURIComponent(row.key)}`)}
          />
        ) : null}
      </PageCard>

      <PageCard title="外部连接能力" description="按当前环境可用的数据源类型判断。">
        {list.state === 'denied' || list.state === 'unauthorized' || list.state === 'error' ? (
          <Banner tone="warn">
            暂时无法读取可用数据源类型，因此不能判断外部连接能力是否已开通。请先解决上面的读取问题后重试；
            这里不会把它当成"未开通"。
          </Banner>
        ) : externalTypes.length === 0 ? (
          <CapabilityNotice
            title="外部数据库连接未开通"
            reason="当前环境未开通外部数据源连接能力，可用类型里只有内建主数据源，因此无法在这里新建 MySQL/PostgreSQL 等外部连接。这是能力未开通，不是权限不足或数据为空。"
            details={
              <Banner tone="info">
                当前环境只有内建主数据源，没有可用的外部连接器。
              </Banner>
            }
          />
        ) : (
          <DataTable
            columns={[{ key: 'type', title: '可用类型', render: (row: { type: string }) => row.type }]}
            rows={externalTypes.map((type) => ({ type }))}
            rowKey={(row) => row.type}
          />
        )}
      </PageCard>

      <p className={styles.notice}>
        数据源维度权限见 <Link to="/datasource/access">访问配置</Link>；集合与字段管理见{' '}
        <Link to="/datasource/tables">数据表与字段</Link>。
      </p>
    </BoardPage>
  );
}
