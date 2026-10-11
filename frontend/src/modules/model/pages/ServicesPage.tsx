import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useSessionStore } from '../../../auth/store';
import { isResourceActionAllowed } from '../../../permissions/model';
import { PageCard, PageHeader, StatusPill } from '../../../components/Card';
import { listServicesMasked, resourceMessageOf, resourceStateOf } from '../resources';
import { normalizeEnabledModels } from '../types';
import type { LlmServiceRow } from '../types';
import { providerTitle } from '../providers';
import { ListPager, Notice, Select, StateBlock, formatTime } from '../../ai/ui';
import styles from '../../ai/group-a.module.css';

/**
 * LM-01 服务列表。
 *
 * 展示一律走 `ai:listLLMServices`：这是**后端已剔除 `options`** 的入口
 * （源码 `server/resource/ai.ts:44-48`）。因此卡片、DOM 与日志里都不会出现
 * `options.apiKey` / `options.baseURL`，普通用户看到的就是脱敏结果。
 *
 * "可管理"与"可查看"分开：没有管理权限时列表仍然可读，但不提供编辑入口；
 * 后端始终是最终判定者。
 */

const PAGE_SIZE = 12;

export function ServicesPage() {
  const access = useSessionStore((state) => state.access);
  const canManage = isResourceActionAllowed(access, 'llmServices', 'update');
  const [page, setPage] = useState(1);
  const [providerFilter, setProviderFilter] = useState('');

  const services = useQuery({
    queryKey: ['model', 'services', 'masked', page],
    queryFn: () => listServicesMasked({ page, pageSize: PAGE_SIZE, sort: ['sort'] }),
  });

  const rows = services.data?.rows ?? [];
  const state = services.isLoading ? 'loading' : resourceStateOf(services.error, rows.length === 0);
  const serverMeta = (services.data?.meta ?? {}) as { count?: number; hasNext?: boolean };
  const totalCount = typeof serverMeta.count === 'number' ? serverMeta.count : rows.length;
  const providerOptions = useMemo(
    () =>
      Array.from(new Set(rows.map((row) => String(row.provider ?? '')).filter((item) => item.length > 0))).map(
        (item) => ({ value: item, label: providerTitle(item) }),
      ),
    [rows],
  );
  // 服务商筛选是**本页内**的客户端筛选：筛选时显示当前结果与全部条数，不把结果数冒充后端总数。
  const filterActive = providerFilter.length > 0;
  const filtered = filterActive ? rows.filter((row) => row.provider === providerFilter) : rows;

  return (
    <div className={styles.stack}>
      <PageHeader
        title="模型服务"
        description="查看当前可用的模型服务。列表不显示服务密钥。"
        actions={
          canManage ? (
            <Link className={styles.button} to="/model/services/new">
              新建服务
            </Link>
          ) : null
        }
      />

      <PageCard title="服务列表" description="这里显示你已保存的模型服务。">
        <div className={styles.toolbar}>
          <div style={{ minWidth: 220 }}>
            <Select
              value={providerFilter}
              onChange={setProviderFilter}
              options={providerOptions}
              placeholder="全部服务商"
              ariaLabel="按服务商筛选"
            />
          </div>
          <span className={styles.toolbarSpacer} />
          {filterActive ? (
            <span className={styles.rowHint} role="status">
              已按服务商筛选：显示 {filtered.length} 条（本页 {rows.length} 条 / 全部 {totalCount} 条）
            </span>
          ) : null}
          <button type="button" className={styles.button} onClick={() => void services.refetch()}>
            刷新
          </button>
        </div>

        <StateBlock
          state={state}
          message={resourceMessageOf(services.error)}
          onRetry={() => void services.refetch()}
          emptyTitle="还没有配置模型服务"
          emptyDescription="后端返回了空列表：当前没有任何模型服务记录。"
          deniedDescription="你的角色没有查看模型服务的权限。"
        />

        {filtered.length > 0 ? (
          <div className={styles.rowList}>
            {filtered.map((row) => (
              <ServiceRow key={row.name} service={row} canManage={canManage} />
            ))}
          </div>
        ) : null}

        <ListPager
          // 筛选时隐藏分页条里的"共 N 条"（那是未筛选的后端总数，会与当前结果数矛盾）；
          // 结果数与全部条数由上方筛选说明分别给出，翻页仍按后端分页。
          meta={filterActive ? { ...serverMeta, count: undefined } : serverMeta}
          page={page}
          pageSize={PAGE_SIZE}
          isFetching={services.isFetching}
          onChange={setPage}
        />
      </PageCard>

      <PageCard title="关于密钥" description="为什么这里看不到密钥。">
        <Notice>
          服务密钥只保存在服务端，列表与详情都不会显示它；编辑时留空即沿用已保存的密钥，
          界面始终以掩码方式处理。
        </Notice>
      </PageCard>
    </div>
  );
}

function ServiceRow({ service, canManage }: { service: LlmServiceRow; canManage: boolean }) {
  const enabledModels = normalizeEnabledModels(service.enabledModels);
  const modelSummary =
    enabledModels.mode === 'custom'
      ? `${enabledModels.models.length} 个自定义模型`
      : enabledModels.mode === 'legacy-array' && enabledModels.models.length > 0
        ? `${enabledModels.models.length} 个指定模型`
        : '使用服务商推荐模型';

  return (
    <div className={styles.rowCard}>
      <div className={styles.rowMain}>
        <div className={styles.chipRow}>
          <span className={styles.rowTitle}>{service.title || service.name}</span>
          {service.enabled === false ? <StatusPill tone="warn">已停用</StatusPill> : <StatusPill tone="ok">已启用</StatusPill>}
        </div>
        <span className={styles.rowHint}>
          {providerTitle(service.provider)}　标识：{service.name}
        </span>
        <span className={styles.rowHint}>
          {modelSummary}　更新于 {formatTime(service.updatedAt)}
        </span>
      </div>
      <div className={styles.rowActions}>
        <Link className={styles.button} to={`/model/models?service=${encodeURIComponent(service.name)}`}>
          查看模型
        </Link>
        {canManage ? (
          <Link className={styles.button} to={`/model/services/${encodeURIComponent(service.name)}`}>
            编辑配置
          </Link>
        ) : null}
      </div>
    </div>
  );
}
