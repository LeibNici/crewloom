import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSessionStore } from '../../../auth/store';
import { isResourceActionAllowed } from '../../../permissions/model';
import { PageCard, PageHeader, StatusPill } from '../../../components/Card';
import { CrewloomError } from '../../../api/errors';
import {
  getServiceRaw,
  listProviders,
  listServicesMasked,
  resourceMessageOf,
  testFlight,
} from '../resources';
import type { TestFlightResult } from '../types';
import { providerDefinition, providerTitle } from '../providers';
import { Checkbox, Field, Notice, Select, TextInput } from '../../ai/ui';
import styles from '../../ai/group-a.module.css';

/**
 * LM-05 配置验证入口（服务"试飞"）。
 *
 * 契约（32 页矩阵 LM-05）：`POST /api/ai:testFlight`，入参
 * `values.{provider, options, model}`，**未保存的配置也可以验证**；
 * 它会构造提供方客户端并**真实调用模型**（`provider.ts:398-412` 的 `chatModel.invoke('hello')`），
 * 因此**会产生费用**。
 *
 * 因此本页：
 *  - 只在真实用户**主动点击**时调用，绝不自动触发；
 *  - 严格自动验证模式会在传输层拦截（`ai:testFlight` 在 `strictDenyActions` 里）；
 *  - 只展示可读的中文结论，不把内部错误码或原始报错抛给用户。
 */

export function VerifyPage() {
  const access = useSessionStore((state) => state.access);
  const canManage = isResourceActionAllowed(access, 'llmServices', 'update');

  const providers = useQuery({ queryKey: ['model', 'providers'], queryFn: listProviders, staleTime: 5 * 60_000 });
  const services = useQuery({
    queryKey: ['model', 'services', 'masked', 'verify'],
    queryFn: () => listServicesMasked({ pageSize: 100, sort: ['sort'] }),
  });

  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseURL, setBaseURL] = useState('');
  const [loadFrom, setLoadFrom] = useState('');
  const [loadedNotice, setLoadedNotice] = useState<string | null>(null);
  const [confirmCost, setConfirmCost] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<TestFlightResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadPending, setLoadPending] = useState(false);

  /** 从已保存服务载入配置：只放在内存里，不回显密钥。 */
  const loadedOptionsRef = useMemo(() => ({ current: {} as Record<string, unknown> }), []);

  const definition = providerDefinition(provider);

  const loadService = async (name: string) => {
    setLoadFrom(name);
    setLoadedNotice(null);
    if (!name) {
      loadedOptionsRef.current = {};
      return;
    }
    setLoadPending(true);
    try {
      const service = await getServiceRaw(name);
      if (!service) {
        setLoadedNotice('没有读到这条服务配置。');
        return;
      }
      loadedOptionsRef.current = service.options ?? {};
      setProvider(service.provider ?? '');
      const models = service.enabledModels;
      const firstModel = Array.isArray(models)
        ? typeof models[0] === 'string'
          ? models[0]
          : ''
        : models && typeof models === 'object' && Array.isArray((models as { models?: unknown[] }).models)
          ? String(((models as { models: Array<{ value?: unknown }> }).models[0]?.value as string) ?? '')
          : '';
      setModel(firstModel);
      setLoadedNotice(
        '已载入这条服务的已保存配置（密钥不会回显）。如果在这里不填写新的密钥，验证会沿用已保存的密钥。',
      );
    } catch (caught) {
      setLoadedNotice(
        caught instanceof CrewloomError ? caught.userMessage : '读取服务配置失败，请稍后重试。',
      );
    } finally {
      setLoadPending(false);
    }
  };

  const run = async () => {
    setPending(true);
    setResult(null);
    setError(null);
    try {
      const options: Record<string, unknown> = { ...loadedOptionsRef.current };
      if (apiKey.trim().length > 0) options.apiKey = apiKey.trim();
      if (baseURL.trim().length > 0) options.baseURL = baseURL.trim();
      const response = await testFlight({ provider, options, model: model.trim() });
      setResult(response);
    } catch (caught) {
      setError(
        caught instanceof CrewloomError
          ? caught.userMessage
          : '验证没有完成，请稍后重试；如果一直失败，请检查服务配置。',
      );
    } finally {
      setPending(false);
    }
  };

  const disabled = pending || !provider || model.trim().length === 0 || !confirmCost;

  return (
    <div className={styles.stack}>
      <PageHeader
        title="配置验证"
        description="用一份配置真实调用一次模型，确认密钥、服务地址与模型名可用。"
      />

      <PageCard title="费用与安全提示">
        <Notice tone="warn">
          验证会真实调用模型服务并产生费用，且响应内容可能计入服务商账单。它只在你自己点击时执行，
          Crewloom 的自动检查不会调用它，也不会替你保存这里的配置。
        </Notice>
      </PageCard>

      <PageCard title="验证配置" description="可以验证尚未保存的配置，也可以载入已保存服务的配置。">
        {!canManage ? (
          <Notice tone="warn">
            你的角色没有模型服务管理权限；通常也无法使用验证入口。如果仍然需要，请联系管理员。
          </Notice>
        ) : null}

        <div className={styles.fieldRow}>
          <Field label="载入已保存服务（可选）" hint="载入后仍可修改，不会自动保存。">
            <Select
              value={loadFrom}
              disabled={loadPending || pending}
              onChange={(next) => void loadService(next)}
              options={(services.data?.rows ?? []).map((row) => ({
                value: row.name,
                label: `${row.title || row.name}（${providerTitle(row.provider)}）`,
              }))}
              placeholder="不载入，手动填写"
            />
          </Field>
          <Field label="服务商" required>
            <Select
              value={provider}
              disabled={pending}
              onChange={setProvider}
              options={(providers.data ?? []).map((row) => ({
                value: row.name,
                label: providerTitle(row.name, row.title),
              }))}
              placeholder={providers.isLoading ? '正在读取服务商…' : '请选择服务商'}
            />
          </Field>
          <Field label="模型 id" required>
            <TextInput value={model} disabled={pending} onChange={setModel} placeholder="例如 deepseek-chat" />
          </Field>
        </div>

        {providers.error ? <Notice tone="warn">服务商清单读取失败：{resourceMessageOf(providers.error)}</Notice> : null}
        {services.error ? <Notice tone="warn">服务列表读取失败：{resourceMessageOf(services.error)}</Notice> : null}
        {loadedNotice ? <Notice>{loadedNotice}</Notice> : null}

        <div className={styles.fieldRow}>
          <Field
            label="API Key"
            required={!loadFrom}
            hint={loadFrom ? '留空表示沿用已载入服务里保存的密钥。' : '尚未保存的配置需要在这里填写。'}
          >
            <input
              className={styles.input}
              type="password"
              autoComplete="new-password"
              value={apiKey}
              disabled={pending}
              placeholder={loadFrom ? '沿用已保存的密钥' : '请输入密钥'}
              aria-label="API Key"
              onChange={(event) => setApiKey(event.target.value)}
            />
          </Field>
          {!definition || definition.settings.some((field) => field.name === 'baseURL') ? (
            <Field label="服务地址（可选）" hint="留空表示使用服务商默认地址。">
              <TextInput value={baseURL} disabled={pending} onChange={setBaseURL} />
            </Field>
          ) : null}
        </div>

        <Checkbox
          label="我确认这次验证会真实调用模型并可能产生费用"
          checked={confirmCost}
          disabled={pending}
          onChange={setConfirmCost}
        />

        <div className={styles.toolbar} style={{ marginTop: 12, marginBottom: 0 }}>
          <button
            type="button"
            className={`${styles.button} ${styles.buttonPrimary}`}
            disabled={disabled}
            onClick={() => void run()}
          >
            {pending ? '正在验证…' : '开始验证'}
          </button>
          <span className={styles.rowHint}>自动检查不会触发这个按钮。</span>
        </div>
      </PageCard>

      {result || error ? (
        <PageCard title="验证结果">
          {error ? <Notice tone="danger">{error}</Notice> : null}
          {result ? (
            result.status === 'success' ? (
              <Notice>
                <StatusPill tone="ok">验证通过</StatusPill>
                <span style={{ marginLeft: 8 }}>模型成功返回了内容，说明这份配置可以正常使用。</span>
              </Notice>
            ) : (
              <Notice tone="warn">
                <StatusPill tone="warn">验证失败</StatusPill>
                <span style={{ marginLeft: 8 }}>
                  模型没有返回正常内容。请依次检查：密钥是否有效、服务地址是否正确、模型 id 是否被该服务商支持。
                </span>
              </Notice>
            )
          ) : null}
        </PageCard>
      ) : null}
    </div>
  );
}
