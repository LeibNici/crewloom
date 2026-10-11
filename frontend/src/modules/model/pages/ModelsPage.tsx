import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { useSessionStore } from '../../../auth/store';
import { isResourceActionAllowed } from '../../../permissions/model';
import { PageCard, PageHeader, StatusPill } from '../../../components/Card';
import { CrewloomError } from '../../../api/errors';
import { listServiceModels, listServicesMasked, resourceMessageOf, resourceStateOf } from '../resources';
import { normalizeEnabledModels } from '../types';
import type { LlmServiceRow } from '../types';
import { providerTitle } from '../providers';
import { ModelParametersCard } from '../model-parameters';
import { Field, Notice, Select, StateBlock, TextInput } from '../../ai/ui';
import styles from '../../ai/group-a.module.css';

/**
 * LM-03 可用模型。
 *
 * `enabledModels` 在真实实例上是**对象** `{mode:'recommended'|'custom', models:[{label,value}]}`，
 * 历史数据里也可能是**字符串数组**（报告 02 §8 的 C5/D5）。本页用
 * `normalizeEnabledModels` 同时兼容两种形状，并按用户视角展示"这条服务用了哪些模型"，
 * 不把内部存储形状当作正常页面文案，也不新增强制禁用规则。
 *
 * 「向服务商查询模型清单」会外呼提供方（`ai:listModels`），只在用户点击时执行；
 * 严格自动验证模式在传输层拦截。
 */

export function ModelsPage() {
  const [params, setParams] = useSearchParams();
  const access = useSessionStore((state) => state.access);
  const canManage = isResourceActionAllowed(access, 'llmServices', 'update');
  const [keyword, setKeyword] = useState('');

  const services = useQuery({
    queryKey: ['model', 'services', 'masked', 'all'],
    queryFn: () => listServicesMasked({ pageSize: 100, sort: ['sort'] }),
  });

  const rows = services.data?.rows ?? [];
  const state = services.isLoading ? 'loading' : resourceStateOf(services.error, rows.length === 0);
  const selectedName = params.get('service') ?? '';
  const selected = useMemo(() => rows.find((row) => row.name === selectedName) ?? null, [rows, selectedName]);

  useEffect(() => {
    if (!selectedName && rows.length > 0) {
      const next = new URLSearchParams(params);
      next.set('service', rows[0].name);
      setParams(next, { replace: true });
    }
  }, [rows, selectedName, params, setParams]);

  const filtered = useMemo(() => {
    const text = keyword.trim().toLowerCase();
    if (text.length === 0) return rows;
    return rows.filter((row) => {
      const models = normalizeEnabledModels(row.enabledModels).models.map((item) => item.value).join(' ');
      return `${row.name} ${row.title ?? ''} ${row.provider ?? ''} ${models}`.toLowerCase().includes(text);
    });
  }, [rows, keyword]);

  return (
    <div className={styles.stack}>
      <PageHeader
        title="可用模型"
        description="查看每个服务当前可用的模型，以及模型调用参数。修改后会按这里的选择保存。"
      />

      <PageCard title="筛选">
        <div className={styles.fieldRow}>
          <Field label="选择服务">
            <Select
              value={selectedName}
              onChange={(next) => {
                const params_ = new URLSearchParams(params);
                if (next) params_.set('service', next);
                else params_.delete('service');
                setParams(params_, { replace: true });
              }}
              options={rows.map((row) => ({
                value: row.name,
                label: `${row.title || row.name}（${providerTitle(row.provider)}）`,
              }))}
              placeholder="全部服务"
            />
          </Field>
          <Field label="按模型 id 或服务名搜索">
            <TextInput value={keyword} onChange={setKeyword} placeholder="例如 deepseek-chat" />
          </Field>
        </div>
      </PageCard>

      <PageCard title="服务与模型" description="这里显示每个服务已保存的模型配置；列表不显示服务密钥。">
        <StateBlock
          state={state}
          message={resourceMessageOf(services.error)}
          onRetry={() => void services.refetch()}
          emptyTitle="还没有配置模型服务"
          emptyDescription="后端返回了空列表：当前没有任何模型服务，因此也没有可用模型。"
          deniedDescription="你的角色没有查看模型服务的权限。"
        />
        {filtered.length > 0 ? (
          <div className={styles.rowList}>
            {filtered.map((row) => (
              <ServiceModelRow
                key={row.name}
                service={row}
                active={row.name === selectedName}
                onSelect={() => {
                  const params_ = new URLSearchParams(params);
                  params_.set('service', row.name);
                  setParams(params_, { replace: true });
                }}
              />
            ))}
          </div>
        ) : null}
      </PageCard>

      {selected ? <ServiceModelDetail service={selected} /> : null}
      {selected && canManage ? <ModelParametersCard key={selected.name} name={selected.name} /> : null}
      {selected && !canManage ? (
        <PageCard title="模型调用参数">
          <Notice tone="warn">查看与修改模型参数需要模型服务管理权限。</Notice>
        </PageCard>
      ) : null}
    </div>
  );
}

function ServiceModelRow({
  service,
  active,
  onSelect,
}: {
  service: LlmServiceRow;
  active: boolean;
  onSelect: () => void;
}) {
  const models = normalizeEnabledModels(service.enabledModels);
  return (
    <button
      type="button"
      className={active ? `${styles.rowCard} ${styles.rowCardActive}` : styles.rowCard}
      style={{ textAlign: 'left', cursor: 'pointer' }}
      onClick={onSelect}
    >
      <span className={styles.rowMain}>
        <span className={styles.chipRow}>
          <span className={styles.rowTitle}>{service.title || service.name}</span>
          <StatusPill tone="neutral">{providerTitle(service.provider)}</StatusPill>
          <StatusPill tone={models.mode === 'custom' ? 'brand' : 'ok'}>{modeLabel(models.mode)}</StatusPill>
          {service.enabled === false ? <StatusPill tone="warn">服务已停用</StatusPill> : null}
        </span>
        <span className={styles.rowHint}>
          {models.models.length > 0
            ? models.models.map((item) => item.value).join('、')
            : '没有显式列出的模型（由服务商推荐模型决定）'}
        </span>
      </span>
    </button>
  );
}

function ServiceModelDetail({ service }: { service: LlmServiceRow }) {
  const models = normalizeEnabledModels(service.enabledModels);
  const [discovered, setDiscovered] = useState<string[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const discover = async () => {
    setPending(true);
    setError(null);
    setDiscovered(null);
    try {
      const result = await listServiceModels({ llmService: service.name });
      setDiscovered(
        result
          .map((item) => String(item.id ?? ''))
          .filter((item) => item.length > 0),
      );
    } catch (caught) {
      setError(caught instanceof CrewloomError ? caught.userMessage : '请稍后重试。');
    } finally {
      setPending(false);
    }
  };

  return (
    <PageCard
      title={`模型清单：${service.title || service.name}`}
      description="这条服务当前使用的模型范围。需要调整时点击“修改模型范围”。"
      actions={
        <Link className={styles.button} to={`/model/services/${encodeURIComponent(service.name)}`}>
          修改模型范围
        </Link>
      }
    >
      <div className={styles.fieldRow}>
        <Field label="模型范围">
          <span>{modeLabel(models.mode)}</span>
        </Field>
        <Field label="指定的模型">
          <span>{models.models.length} 个</span>
        </Field>
      </div>

      {models.models.length > 0 ? (
        <div className={styles.chipRow}>
          {models.models.map((item) => (
            <span key={item.value} className={styles.chip}>
              {item.label || item.value}
            </span>
          ))}
        </div>
      ) : (
        <Notice>
          这条服务没有指定模型：将由该服务商提供的推荐模型决定。
        </Notice>
      )}

      <div className={styles.toolbar} style={{ marginTop: 12 }}>
        <button type="button" className={styles.button} disabled={pending} onClick={() => void discover()}>
          {pending ? '正在向服务商查询…' : '向服务商查询模型清单'}
        </button>
        <span className={styles.rowHint}>该操作会连接模型提供方，可能产生调用记录；只在需要时点击。</span>
      </div>

      {error ? <Notice tone="warn">查询失败：{error}</Notice> : null}
      {discovered ? (
        discovered.length > 0 ? (
          <div className={styles.chipRow}>
            {discovered.slice(0, 120).map((id) => (
              <span key={id} className={styles.chip}>
                {id}
              </span>
            ))}
          </div>
        ) : (
          <Notice tone="warn">服务商没有返回模型清单。</Notice>
        )
      ) : null}
    </PageCard>
  );
}

function modeLabel(mode: ReturnType<typeof normalizeEnabledModels>['mode']): string {
  switch (mode) {
    case 'recommended':
      return '推荐模型';
    case 'custom':
      return '自定义模型';
    case 'legacy-array':
      return '指定模型';
    default:
      return '未设置（按推荐处理）';
  }
}
