import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { PageCard, StatusPill } from '../../../components/Card';
import { useResourceGet, useResourceList } from '../../../api/hooks';
import type { ModulePageProps } from '../../types';
import {
  ActionBanner,
  Banner,
  BoardPage,
  CapabilityNotice,
  Field,
  JsonView,
  KeyValueTable,
  MetaGrid,
  StateView,
  TextArea,
  formatCell,
  localStyles as styles,
  useAsyncAction,
} from '../../access/ui';
import { testConnection, updateDataSource } from '../operations';
import type { CollectionRecord, DataSourceDetail, DataSourceRecord } from '../types';
import { displayTitle } from '../../access/display';

/**
 * DS-02 数据源详情与连接配置（`/datasource/list/:key`）。
 *
 * 13000 实测：`dataSources:get?filterByTk=main` → `{key, displayName, type, isDBInstance}`。
 * 当前实例**没有外部连接器插件**，因此：
 *  - main：展示内建固定数据源的信息与后续入口，不做假的连接表单；
 *  - 若真的存在外部数据源，则按真实字段展示选项并允许用户主动测试连接（会对外建连，只由用户触发）。
 */
export function DatasourceDetailPage({ module, board }: ModulePageProps) {
  const params = useParams();
  const key = params.key ?? '';
  const detail = useResourceGet<DataSourceDetail>('dataSources', key);
  const list = useResourceList<DataSourceRecord>('dataSources', { params: { pageSize: 50 } });
  const collections = useResourceList<CollectionRecord>('collections', { params: { pageSize: 1 } });
  const [optionsDraft, setOptionsDraft] = useState('');
  const action = useAsyncAction();

  const summary = useMemo(
    () => list.rows.find((row) => row.key === key) ?? null,
    [list.rows, key],
  );

  const isMain = detail.data?.type === 'main' || summary?.type === 'main';
  const knownTypes = useMemo(() => {
    const set = new Set<string>();
    for (const row of list.rows) if (row.type) set.add(row.type);
    return [...set];
  }, [list.rows]);

  async function runTestConnection() {
    await action.run(
      () =>
        testConnection({
          dataSourceKey: key,
          ...(optionsDraft.trim() ? { dbOptions: safeParse(optionsDraft) } : {}),
        }),
      '连接测试已提交，结果由服务端返回；请以数据源状态为准。',
    );
  }

  async function saveOptions() {
    if (optionsDraft.trim() === '') return;
    await action.run(
      () => updateDataSource(key, { options: safeParse(optionsDraft) }),
      '连接配置已保存。',
    );
    detail.refetch();
  }

  return (
    <BoardPage
      module={module}
      board={board}
      headerActions={
        <Link className={styles.button} to="/datasource/list">
          返回数据源列表
        </Link>
      }
    >
      <StateView
        state={detail.state}
        message={detail.message}
        onRetry={detail.refetch}
        emptyTitle="没有找到这个数据源"
        emptyDescription="数据源可能已被移除，或链接已失效。"
      />

      {detail.data ? (
        <>
          <PageCard title={displayTitle(detail.data.displayName, detail.data.key)} description="数据源基本信息。">
            <MetaGrid
              rows={[
                { term: '标识 key', value: detail.data.key },
                { term: '显示名', value: formatCell(displayTitle(detail.data.displayName, detail.data.key)) },
                {
                  term: '类型',
                  value: isMain ? <StatusPill tone="brand">主数据源（内建固定）</StatusPill> : formatCell(detail.data.type),
                },
                { term: '物理库实例', value: formatCell(detail.data.isDBInstance) },
                {
                  term: '启用状态',
                  value: summary?.enabled ? <StatusPill tone="ok">已启用</StatusPill> : <StatusPill tone="warn">未启用</StatusPill>,
                },
                {
                  term: '加载状态',
                  value: summary?.status === 'loaded' ? <StatusPill tone="ok">已加载</StatusPill> : formatCell(summary?.status),
                },
                { term: '集合数量', value: collections.total ?? '—' },
              ]}
            />
          </PageCard>

          {isMain ? (
            <PageCard
              title="主数据源说明"
              description="主数据源是内建且固定的，不能删除；它的连接信息由部署环境提供。"
            >
              <Banner tone="info">
                主数据源由系统内建并已加载，不能删除；业务集合与记录都通过它访问。
              </Banner>
              <div className={styles.toolbar} style={{ marginTop: 10 }}>
                <Link className={styles.button} to="/datasource/tables">
                  管理集合与字段
                </Link>
                <Link className={styles.button} to="/datasource/preview">
                  预览与操作记录
                </Link>
                <Link className={styles.button} to="/datasource/access">
                  访问配置
                </Link>
              </div>
            </PageCard>
          ) : (
            <PageCard
              title="连接配置"
              description="按真实选项维护；测试连接会访问外部数据库，只在点击时执行。"
            >
              <ActionBanner action={action} />
              {summary?.options ? <JsonView value={redactOptions(summary.options)} label="当前选项（已隐去敏感键）" /> : null}
              <div className={styles.formGrid} style={{ marginTop: 10 }}>
                <div className={styles.formGridFull}>
                  <Field label="连接选项（JSON）" hint="只提交这个数据源的选项字段；未知字段不会被界面清空。">
                    <TextArea
                      value={optionsDraft}
                      onChange={setOptionsDraft}
                      placeholder='例如 {"host":"...","port":5432,"database":"..."}'
                    />
                  </Field>
                </div>
              </div>
              <div className={styles.toolbar}>
                <button
                  type="button"
                  className={`${styles.button} ${styles.buttonPrimary}`}
                  disabled={action.pending || optionsDraft.trim() === ''}
                  onClick={() => void saveOptions()}
                >
                  保存连接配置
                </button>
                <button
                  type="button"
                  className={styles.button}
                  disabled={action.pending}
                  onClick={() => void runTestConnection()}
                >
                  测试连接
                </button>
              </div>
              <Banner tone="warn">
                连接测试会真实访问目标库，请确认目标地址与账号后再点击。
              </Banner>
            </PageCard>
          )}

          <PageCard title="可用数据源类型" description="按当前环境可用的类型列出。">
            {knownTypes.filter((type) => type !== 'main').length === 0 ? (
              <CapabilityNotice
                title="没有可用的外部连接类型"
                reason="当前环境未开通外部数据源连接能力，因此不能在这里新建外部连接；这是能力未开通，不是权限问题。"
              />
            ) : (
              <KeyValueTable
                rows={knownTypes.map((type) => ({ key: type, label: type, value: type === 'main' ? '内建主数据源' : '外部连接' }))}
              />
            )}
          </PageCard>
        </>
      ) : null}
    </BoardPage>
  );
}

/** 只解析合法 JSON；不合法时保留原文（提交由后端校验并返回可读错误）。 */
function safeParse(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    return { value: raw };
  }
}

/** 连接选项里可能含口令；界面只显示键名，不显示敏感值。 */
function redactOptions(options: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (/password|secret|token|key/i.test(key)) out[key] = '（已隐藏）';
    else if (value && typeof value === 'object') out[key] = redactOptions(value as Record<string, unknown>);
    else out[key] = value;
  }
  return out;
}
