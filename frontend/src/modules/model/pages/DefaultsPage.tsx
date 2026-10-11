import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSessionStore } from '../../../auth/store';
import { isResourceActionAllowed } from '../../../permissions/model';
import { PageCard, PageHeader, StatusPill } from '../../../components/Card';
import { CrewloomError } from '../../../api/errors';
import {
  getAiSettings,
  listServicesMasked,
  resourceMessageOf,
  resourceStateOf,
  updateAiSettings,
} from '../resources';
import { listEmployees } from '../../ai/resources';
import { normalizeEnabledModels } from '../types';
import { providerTitle } from '../providers';
import { Field, Notice, Select, StateBlock, orDash } from '../../ai/ui';
import styles from '../../ai/group-a.module.css';

/**
 * LM-04 默认与员工模型。
 *
 * 按**已批准的最终模型选择规则**展示（员工专用规则 → 合法显式选择 → 全局默认 → 未配置默认时的兼容回退）：
 *  1. 员工专用允许集命中 → 用命中的模型；未命中仍启用限制 → 用允许集第一个（原有首选规则，不改员工专用配置）；
 *  2. 员工未启用专用限制时，调用方给出的合法显式选择优先；
 *  3. 否则使用全局默认服务与默认模型（本页保存的两个字段，**都配置且有效**时生效）；
 *  4. 全局默认**未配置**（两个字段都为空）时保留兼容回退：第一个有启用模型的服务的第一启用模型；
 *  5. 全局默认**已配置但不可用**（只配一半 / 服务不存在 / 已禁用 / 模型未启用 / 服务没有启用模型）时**明确失败**，
 *     不静默切换到其它模型。
 *
 * 这里不写源码位置、补丁方案或授权流程——那些属于报告内容，不是产品页面文案。
 * 目标实例当前尚未安装该部署（事实记在验收报告里）；本页按最终批准的运行行为说明。
 */

export function DefaultsPage() {
  const access = useSessionStore((state) => state.access);
  const canWrite = isResourceActionAllowed(access, 'aiSettings', 'update');

  const settings = useQuery({
    queryKey: ['model', 'ai-settings'],
    queryFn: getAiSettings,
    retry: false,
  });

  const services = useQuery({
    queryKey: ['model', 'services', 'masked', 'defaults'],
    queryFn: () => listServicesMasked({ pageSize: 100, sort: ['sort'] }),
  });

  const employees = useQuery({
    queryKey: ['ai', 'employees', 'list', 'defaults'],
    queryFn: () => listEmployees({ pageSize: 200, sort: ['sort'] }),
    retry: false,
  });

  const [defaultService, setDefaultService] = useState('');
  const [defaultModel, setDefaultModel] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: 'info' | 'warn' | 'danger'; text: string } | null>(null);

  useEffect(() => {
    setDefaultService(settings.data?.defaultLLMService ?? '');
    setDefaultModel(settings.data?.defaultModel ?? '');
  }, [settings.data]);

  const state = settings.isLoading ? 'loading' : resourceStateOf(settings.error, settings.data === null);
  const serviceRows = services.data?.rows ?? [];

  const modelOptions = useMemo(() => {
    const service = serviceRows.find((row) => row.name === defaultService);
    const models = normalizeEnabledModels(service?.enabledModels).models;
    return models.map((item) => ({ value: item.value, label: item.label || item.value }));
  }, [serviceRows, defaultService]);

  const save = async () => {
    setPending(true);
    setMessage(null);
    try {
      await updateAiSettings({
        defaultLLMService: defaultService.trim().length > 0 ? defaultService.trim() : null,
        defaultModel: defaultModel.trim().length > 0 ? defaultModel.trim() : null,
      });
      setMessage({
        tone: 'warn',
        text:
          '默认设置已保存。之后新开始的、没有命中员工专用配置的调用会使用它；' +
          '如果只配置了一半、服务不存在或已停用、模型未启用，调用会明确报错，不会静默改用其它模型。',
      });
      void settings.refetch();
    } catch (caught) {
      setMessage({
        tone: 'danger',
        text: caught instanceof CrewloomError ? caught.userMessage : '保存失败，请稍后重试。',
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <div className={styles.stack}>
      <PageHeader
        title="默认与员工模型"
        description="设置全局默认服务与默认模型，并查看每位员工的专用模型配置。"
      />

      <PageCard title="当前配置" description="当前保存的全局默认设置。">
        <StateBlock
          state={state}
          message={resourceMessageOf(settings.error)}
          onRetry={() => void settings.refetch()}
          emptyTitle="读取不到默认设置"
          deniedDescription="你的角色没有查看模型默认设置的权限。"
        />
        {state === 'ready' || settings.data ? (
          <div className={styles.fieldRow}>
            <Field label="当前默认服务">
              <span className={styles.mono}>
                {orDash(settings.data?.defaultLLMService)}
                {settings.data?.defaultLLMService ? null : (
                  <span className={styles.rowHint}>（现在未配置，不代表历史上从未配置过）</span>
                )}
              </span>
            </Field>
            <Field label="当前默认模型">
              <span className={styles.mono}>
                {orDash(settings.data?.defaultModel)}
                {settings.data?.defaultModel ? null : (
                  <span className={styles.rowHint}>（现在未配置）</span>
                )}
              </span>
            </Field>
          </div>
        ) : null}
        {!canWrite ? <Notice tone="warn">你的角色没有修改默认设置的权限，下面是只读展示。</Notice> : null}
      </PageCard>

      <PageCard title="设置默认服务与模型" description="设置全局默认服务与模型；保存后对之后新开始、且没有命中员工专用配置的调用生效。">
        <div className={styles.fieldRow}>
          <Field label="默认服务">
            <Select
              value={defaultService}
              disabled={!canWrite || pending}
              onChange={(next) => {
                setDefaultService(next);
                setDefaultModel('');
              }}
              options={serviceRows.map((row) => ({
                value: row.name,
                label: `${row.title || row.name}（${providerTitle(row.provider)}）`,
              }))}
              placeholder="不设置"
            />
          </Field>
          <Field label="默认模型" hint="只列出所选服务里显式配置的模型；也可以留空。">
            {modelOptions.length > 0 ? (
              <Select
                value={defaultModel}
                disabled={!canWrite || pending}
                onChange={setDefaultModel}
                options={modelOptions}
                placeholder="不设置"
              />
            ) : (
              <input
                className={styles.input}
                value={defaultModel}
                disabled={!canWrite || pending}
                placeholder="模型 id（可留空）"
                aria-label="默认模型"
                onChange={(event) => setDefaultModel(event.target.value)}
              />
            )}
          </Field>
        </div>
        {services.error ? <Notice tone="warn">服务列表读取失败：{resourceMessageOf(services.error)}</Notice> : null}
        {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
        <div className={styles.toolbar} style={{ marginBottom: 0 }}>
          <button
            type="button"
            className={`${styles.button} ${styles.buttonPrimary}`}
            disabled={!canWrite || pending}
            onClick={() => void save()}
          >
            {pending ? '正在保存…' : '保存默认设置'}
          </button>
        </div>
      </PageCard>

      <PageCard title="实际生效顺序" description="从最优先到最终回退依次判断；全局默认排在有员工专用配置的调用之后。">
        <div className={styles.rowList}>
          <OrderRow
            order="1"
            title="员工专用允许集命中"
            description="员工启用了专用模型限制，且请求的模型在允许集内 → 使用该模型。"
          />
          <OrderRow
            order="2"
            title="员工专用允许集未命中"
            description="仍启用专用限制但请求的模型不在允许集内 → 使用允许集里的第一个模型（保留员工专用规则，不越权落到默认）。"
          />
          <OrderRow
            order="3"
            title="员工未启用专用限制，且调用方给了合法显式选择"
            description="使用调用方明确指定的服务与模型；这一层优先于全局默认。"
          />
          <OrderRow
            order="4"
            title="全局默认（本页设置）"
            description="默认服务与默认模型都已配置、且服务存在并启用、模型在该服务的启用模型内 → 使用这个组合。"
          />
          <OrderRow
            order="5"
            title="全局默认未配置时的兼容回退"
            description="两个默认字段都为空时，使用第一个有启用模型的服务里的第一个启用模型（保持旧实例的行为）。"
          />
          <OrderRow
            order="6"
            title="全局默认已配置但不可用"
            description="只配置了一半、服务不存在或已停用、模型未启用、服务没有启用模型 → 明确报错，不静默切换到其它模型。"
          />
          <OrderRow
            order="7"
            title="没有任何可用模型"
            description="员工允许集为空、或全局没有任何启用模型时同样报错，不会编造一个模型。"
          />
        </div>
        <Notice tone="info">
          清空本页两个默认字段（保存为空）会回到第 5 步的兼容回退；只填其中一个字段属于"已配置但不完整"，
          调用会按第 6 步明确失败。
        </Notice>
      </PageCard>

      <PageCard title="员工专用配置" description="每位员工是否限制了模型、允许哪些、首选是哪个。">
        {!canWrite && employees.error ? (
          <Notice tone="warn">读取员工配置需要员工管理权限：{resourceMessageOf(employees.error)}</Notice>
        ) : null}
        <StateBlock
          state={
            employees.isLoading
              ? 'loading'
              : resourceStateOf(employees.error, (employees.data?.rows ?? []).length === 0)
          }
          message={resourceMessageOf(employees.error)}
          onRetry={() => void employees.refetch()}
          emptyTitle="没有员工记录"
          deniedDescription="你的角色没有查看员工配置的权限。"
        />
        {(employees.data?.rows ?? []).length > 0 ? (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>员工</th>
                  <th>是否限制</th>
                  <th>允许的模型</th>
                  <th>首选</th>
                </tr>
              </thead>
              <tbody>
                {(employees.data?.rows ?? []).map((employee) => {
                  const settings_ = employee.modelSettings ?? {};
                  const enforced = settings_.enabled === true;
                  const models = normalizeEmployeeModels(settings_);
                  return (
                    <tr key={employee.username}>
                      <td>{employee.nickname || employee.username}</td>
                      <td>{enforced ? '是' : '否（用全局规则）'}</td>
                      <td>
                        {models.length === 0 ? (
                          enforced ? (
                            <span className={styles.rowHint}>允许集为空：发送会被服务端拒绝</span>
                          ) : (
                            '—'
                          )
                        ) : (
                          <div className={styles.chipRow}>
                            {models.map((item) => (
                              <span key={`${item.llmService}:${item.model}`} className={styles.chip}>
                                {item.model}（{item.llmService}）
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td>{models[0]?.model ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </PageCard>

      <PageCard title="默认不可用时的处理" description="避免把失效配置静默换成别的模型。">
        <div className={styles.rowList}>
          <div className={styles.rowCard}>
            <div className={styles.rowMain}>
              <span className={styles.rowTitle}>配置不完整</span>
              <span className={styles.rowHint}>
                只填了默认服务或只填了默认模型：属于"已配置但不完整"，相关调用会明确失败。
                要么两个都填，要么两个都留空（留空则保留兼容回退）。
              </span>
            </div>
          </div>
          <div className={styles.rowCard}>
            <div className={styles.rowMain}>
              <span className={styles.rowTitle}>配置指向的服务或模型不可用</span>
              <span className={styles.rowHint}>
                服务不存在、已停用、模型不在该服务的启用模型里、或该服务没有任何启用模型时，
                相关调用会明确失败，不会静默改用其它服务或模型。
              </span>
            </div>
          </div>
          <div className={styles.rowCard}>
            <div className={styles.rowMain}>
              <span className={styles.rowTitle}>员工专用配置不受影响</span>
              <span className={styles.rowHint}>
                员工的专用模型规则与首选规则保持不变；全局默认只作用于没有命中员工专用配置的调用。
              </span>
            </div>
          </div>
        </div>
      </PageCard>
    </div>
  );
}

function OrderRow({ order, title, description }: { order: string; title: string; description: string }) {
  return (
    <div className={styles.rowCard}>
      <div className={styles.rowActions}>
        <StatusPill tone="brand">第 {order} 步</StatusPill>
      </div>
      <div className={styles.rowMain}>
        <span className={styles.rowTitle}>{title}</span>
        <span className={styles.rowHint}>{description}</span>
      </div>
    </div>
  );
}

function normalizeEmployeeModels(settings: {
  llmService?: string;
  model?: string;
  models?: Array<{ llmService?: string; model?: string }>;
}): Array<{ llmService: string; model: string }> {
  const list = Array.isArray(settings.models)
    ? settings.models
        .filter(
          (item): item is { llmService: string; model: string } =>
            typeof item?.llmService === 'string' && item.llmService.length > 0 &&
            typeof item?.model === 'string' && item.model.length > 0,
        )
        .map((item) => ({ llmService: item.llmService, model: item.model }))
    : [];
  if (list.length > 0) return list;
  if (
    typeof settings.llmService === 'string' &&
    settings.llmService.length > 0 &&
    typeof settings.model === 'string' &&
    settings.model.length > 0
  ) {
    return [{ llmService: settings.llmService, model: settings.model }];
  }
  return [];
}
