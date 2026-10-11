import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router';
import { useSessionStore } from '../../../auth/store';
import { isResourceActionAllowed } from '../../../permissions/model';
import { PageCard, PageHeader, StatusPill } from '../../../components/Card';
import { CrewloomError } from '../../../api/errors';
import {
  createService,
  getServiceRaw,
  listProviders,
  listProviderModels,
  listServiceModels,
  mergeServiceOptions,
  resourceMessageOf,
  resourceStateOf,
  updateService,
} from '../resources';
import type { LlmProviderRow, LlmServiceRow } from '../types';
import { normalizeEnabledModels, toEnabledModelsPayload } from '../types';
import type { EnabledModel } from '../types';
import { providerDefinition, providerTitle } from '../providers';
import { optionFieldsToState, patchFromModelParameters, type ModelParameterState } from '../model-parameters';
import { Checkbox, Field, Notice, Select, StateBlock, TextInput, formatTime } from '../../ai/ui';
import styles from '../../ai/group-a.module.css';

/**
 * LM-02 服务配置（`/model/services/new` 与 `/model/services/:name`）。
 *
 * 关键契约（十页契约附录 D1）：
 *  - `llmServices.options` 的更新是**整体替换**：省略 `options` 才保留原值，传部分键会丢掉未传键。
 *    因此保存时以**当前已读到的最新完整 options** 为基准，在内存里打补丁后整体回传。
 *  - 表单里的配置始终跟随**最近一次读取到的记录**：保存成功后回读的新值会直接反映到表单，
 *    不依赖"离开页面再进入"；保存期间输入控件禁用，回读不会覆盖用户刚提交的内容。
 *  - 明文 `options`（含 `apiKey`）只在管理编辑里读取，**不渲染到 DOM**：
 *    已保存的密钥用一个空密码框表示"已配置，留空即不修改"，绝不把掩码字符串写回后端。
 *  - `ai:listProviderModels` / `ai:listModels` 会**外呼模型提供方**：
 *    只在真实用户点击时调用；严格自动验证模式在传输层拦截。
 */

export function ServiceConfigPage() {
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const access = useSessionStore((state) => state.access);
  const canManage = isResourceActionAllowed(access, 'llmServices', 'update');
  const isNew = !name || name === 'new';

  const detail = useQuery({
    queryKey: ['model', 'service', 'raw', isNew ? '__new__' : name],
    queryFn: () => getServiceRaw(name as string),
    enabled: canManage && !isNew,
    retry: false,
  });

  if (!canManage) {
    return (
      <div className={styles.stack}>
        <PageHeader
          title="服务配置"
          actions={
            <button type="button" className={styles.button} onClick={() => navigate('/model/services')}>
              返回列表
            </button>
          }
        />
        <PageCard title="没有编辑权限">
          <StateBlock
            state="denied"
            deniedDescription="编辑模型服务需要模型服务管理权限。你可以在服务列表里查看可用服务，但不能修改连接配置或密钥。"
          />
        </PageCard>
      </div>
    );
  }

  const state = isNew ? 'ready' : detail.isLoading ? 'loading' : resourceStateOf(detail.error, detail.data === null);

  return (
    <div className={styles.stack}>
      <PageHeader
        title={isNew ? '新建模型服务' : `服务配置：${detail.data?.title || name}`}
        description="这里填写连接模型服务所需的信息；密钥只在保存时提交，界面不会回显已保存的密钥，留空即沿用原值。"
        actions={
          <button type="button" className={styles.button} onClick={() => navigate('/model/services')}>
            返回列表
          </button>
        }
      />
      <StateBlock
        state={state}
        message={resourceMessageOf(detail.error)}
        onRetry={() => void detail.refetch()}
        deniedDescription="你的角色没有读取这条服务配置的权限。"
      />
      {state === 'ready' && detail.data ? (
        <ServiceForm
          key={detail.data.name}
          record={detail.data}
          onSaved={() => void detail.refetch()}
          onCreated={() => navigate('/model/services')}
        />
      ) : null}
      {state === 'ready' && isNew ? (
        <ServiceForm key="__new__" record={null} onSaved={() => undefined} onCreated={() => navigate('/model/services')} />
      ) : null}
    </div>
  );
}

function ServiceForm({
  record,
  onSaved,
  onCreated,
}: {
  record: LlmServiceRow | null;
  onSaved: () => void;
  onCreated: () => void;
}) {
  const isEdit = record !== null;
  const queryClient = useQueryClient();
  const providers = useQuery({
    queryKey: ['model', 'providers'],
    queryFn: listProviders,
    staleTime: 5 * 60_000,
  });

  /**
   * 已加载的完整 options 以**最近一次读取到的记录**为准：保存成功后回读的新值会立即成为
   * 表单与下次合并的基准，不会停在打开页面时的旧值。它**绝不**参与渲染，明文密钥不进 DOM。
   */
  const loadedOptions = useMemo<Record<string, unknown>>(() => record?.options ?? {}, [record]);

  const [name, setName] = useState(record?.name ?? '');
  const [title, setTitle] = useState(record?.title ?? '');
  const [provider, setProvider] = useState(record?.provider ?? '');
  const [enabled, setEnabled] = useState(record?.enabled !== false);
  const [apiKeyReplacement, setApiKeyReplacement] = useState('');
  const [settingValues, setSettingValues] = useState<Record<string, string>>({});
  // 历史字符串数组（非空）等价于"只使用这些模型"，与真实插件归一后的语义一致；
  // 空数组 / 缺失才按"使用推荐模型"处理。这样显式模型清单既不会被吞掉，也不会被悄悄改写。
  const initialEnabledModels = normalizeEnabledModels(record?.enabledModels);
  const [enabledModelsMode, setEnabledModelsMode] = useState<'recommended' | 'custom'>(
    initialEnabledModels.mode === 'custom' ||
      (initialEnabledModels.mode === 'legacy-array' && initialEnabledModels.models.length > 0)
      ? 'custom'
      : 'recommended',
  );
  const [customModels, setCustomModels] = useState<EnabledModel[]>(initialEnabledModels.models);
  const [newModelId, setNewModelId] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: 'info' | 'warn' | 'danger'; text: string } | null>(null);
  const [discovered, setDiscovered] = useState<Array<{ id: string }> | null>(null);
  const [discovering, setDiscovering] = useState(false);

  const definition = providerDefinition(provider);
  const providerOptions = useMemo(
    () =>
      (providers.data ?? []).map((row: LlmProviderRow) => ({
        value: row.name,
        label: providerTitle(row.name, row.title),
      })),
    [providers.data],
  );
  const providerLabel = useMemo(
    () => providerOptions.find((item) => item.value === provider)?.label ?? providerTitle(provider),
    [provider, providerOptions],
  );

  // 切换服务商时初始化连接字段与参数字段（用当前记录的 options 或默认值）。
  useEffect(() => {
    const fields = definition?.settings ?? [];
    const next: Record<string, string> = {};
    for (const field of fields) {
      if (field.secret) continue; // 密钥从不回显
      const value = loadedOptions[field.name];
      next[field.name] = value === undefined || value === null ? '' : typeof value === 'string' ? value : String(value);
    }
    setSettingValues(next);
    setDiscovered(null);
  }, [definition, loadedOptions]);

  const modelOptionState = useMemo(
    () => optionFieldsToState(definition?.modelOptions ?? [], loadedOptions),
    [definition, loadedOptions],
  );
  const [modelParameters, setModelParameters] = useState<ModelParameterState>(modelOptionState);
  useEffect(() => {
    setModelParameters(modelOptionState);
  }, [modelOptionState]);

  /** 组装提交给后端的 options：在最新读取到的完整 options 上打补丁，再叠加用户输入。 */
  const buildOptions = useCallback((): Record<string, unknown> => {
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(settingValues)) {
      patch[key] = value.trim().length > 0 ? value.trim() : undefined;
    }
    if (apiKeyReplacement.trim().length > 0) patch.apiKey = apiKeyReplacement.trim();
    Object.assign(patch, patchFromModelParameters(definition?.modelOptions ?? [], modelParameters));
    return mergeServiceOptions(loadedOptions, patch);
  }, [apiKeyReplacement, definition, loadedOptions, modelParameters, settingValues]);

  const submit = async () => {
    if (name.trim().length === 0) {
      setMessage({ tone: 'danger', text: '请填写服务标识（name）。' });
      return;
    }
    if (provider.trim().length === 0) {
      setMessage({ tone: 'danger', text: '请选择服务商。' });
      return;
    }
    if (enabledModelsMode === 'custom' && customModels.length === 0) {
      setMessage({ tone: 'danger', text: '选择了自定义模型，但一个模型都没有填。请至少添加一个模型 id。' });
      return;
    }
    const previous = normalizeEnabledModels(record?.enabledModels);
    const values: Record<string, unknown> = {
      title: title.trim(),
      provider: provider.trim(),
      enabled,
      options: buildOptions(),
      enabledModels: toEnabledModelsPayload(enabledModelsMode, customModels, previous),
    };
    if (!isEdit) values.name = name.trim();

    setPending(true);
    setMessage(null);
    try {
      if (isEdit) {
        const saved = await updateService(record!.name, values);
        // 更新响应就是保存后的最新记录：直接写回查询缓存，表单在保存完成的同一批更新里
        // 就显示最新配置（含刚保存的选项），不必等第二次 GET，也不会回退到打开时的旧值。
        if (saved?.options) {
          queryClient.setQueryData(['model', 'service', 'raw', record!.name], saved);
        }
        setMessage({ tone: 'info', text: '已保存。' });
        setApiKeyReplacement('');
        onSaved();
      } else {
        await createService(values);
        onCreated();
      }
    } catch (caught) {
      setMessage({
        tone: 'danger',
        text:
          caught instanceof CrewloomError
            ? caught.userMessage
            : '保存失败，请稍后重试。',
      });
    } finally {
      setPending(false);
    }
  };

  /** 未保存配置的试连（只有用户主动点击才执行；会外呼提供方）。 */
  const discover = async () => {
    setDiscovering(true);
    setMessage(null);
    try {
      const options = buildOptions();
      const result = isEdit
        ? await listServiceModels({ llmService: record!.name })
        : await listProviderModels({ provider, options });
      setDiscovered(
        result
          .map((item) => ({ id: String(item.id ?? '') }))
          .filter((item) => item.id.length > 0),
      );
    } catch (caught) {
      setDiscovered([]);
      setMessage({
        tone: 'warn',
        text: `没有取到模型清单（这不影响保存）：${
          caught instanceof CrewloomError ? caught.userMessage : '请稍后重试。'
        }`,
      });
    } finally {
      setDiscovering(false);
    }
  };

  return (
    <>
      <PageCard title="基本信息">
        <div className={styles.fieldRow}>
          <Field label="服务标识" required hint="唯一标识，创建后不可更改。">
            <TextInput value={name} disabled={isEdit || pending} onChange={setName} placeholder="例如 deepseek-main" />
          </Field>
          <Field label="显示名称">
            <TextInput value={title} disabled={pending} onChange={setTitle} placeholder="例如 DeepSeek 主服务" />
          </Field>
          <Field
            label="服务商"
            required={!isEdit}
            hint={isEdit ? '服务商在创建后不能更改；需要更换服务商时请新建一个服务。' : '从可选服务商中选择。'}
          >
            {isEdit ? (
              <span className={styles.rowTitle} data-testid="service-provider-readonly">
                {providerLabel}
              </span>
            ) : (
              <Select
                value={provider}
                disabled={pending}
                onChange={setProvider}
                options={providerOptions}
                placeholder={providers.isLoading ? '正在读取服务商…' : '请选择服务商'}
              />
            )}
          </Field>
          <Field label="状态">
            <Checkbox label="启用这个服务" checked={enabled} disabled={pending} onChange={setEnabled} />
          </Field>
        </div>
        {providers.error ? <Notice tone="warn">服务商清单读取失败：{resourceMessageOf(providers.error)}</Notice> : null}
        {provider && !definition && providers.data ? (
          <Notice tone="warn">
            这个服务商在当前界面没有可编辑的连接字段。保存时会保留它已有的配置，不会新增或删除字段。
          </Notice>
        ) : null}
        {record ? (
          <p className={styles.rowHint}>
            创建于 {formatTime(record.createdAt)}　更新于 {formatTime(record.updatedAt)}
          </p>
        ) : null}
      </PageCard>

      <PageCard title="连接与密钥" description="密钥不回显：留空表示沿用已保存的值。">
        {!definition ? (
          <Notice tone="warn">请先选择服务商，才能填写连接字段。</Notice>
        ) : (
          <div className={styles.fieldRow}>
            {definition.settings.map((field) =>
              field.secret ? (
                <Field
                  key={field.name}
                  label={field.title}
                  required={field.required && !isEdit}
                  hint={
                    isEdit
                      ? '已保存的密钥不会显示；留空表示不修改，填写则用新密钥替换。'
                      : '新建服务必须填写。'
                  }
                >
                  <input
                    className={styles.input}
                    type="password"
                    autoComplete="new-password"
                    value={apiKeyReplacement}
                    disabled={pending}
                    placeholder={isEdit ? '已配置（留空表示不修改）' : '请输入密钥'}
                    aria-label={field.title}
                    onChange={(event) => setApiKeyReplacement(event.target.value)}
                  />
                </Field>
              ) : (
                <Field key={field.name} label={field.title} hint={field.hint}>
                  <TextInput
                    value={settingValues[field.name] ?? ''}
                    disabled={pending}
                    onChange={(next) => setSettingValues((prev) => ({ ...prev, [field.name]: next }))}
                  />
                </Field>
              ),
            )}
          </div>
        )}
        <Notice>
          保存时会保留这条服务已有的其它配置，没有填写的项不会被清空。
        </Notice>
      </PageCard>

      <PageCard
        title="可用模型"
        description="可以沿用服务商推荐模型，也可以只列出指定模型。"
      >
        <div className={styles.fieldRow}>
          <Field label="模型范围">
            <Select
              value={enabledModelsMode}
              disabled={pending}
              onChange={(next) => setEnabledModelsMode(next === 'custom' ? 'custom' : 'recommended')}
              options={[
                { value: 'recommended', label: '使用服务商推荐模型' },
                { value: 'custom', label: '只使用我指定的模型' },
              ]}
            />
          </Field>
        </div>

        {enabledModelsMode === 'custom' ? (
          <>
            <div className={styles.rowList}>
              {customModels.map((item, index) => (
                <div key={`${item.value}-${index}`} className={styles.rowCard}>
                  <div className={styles.rowMain}>
                    <span className={styles.rowTitle}>{item.label || item.value}</span>
                    <span className={styles.rowHint}>模型 id：{item.value}</span>
                  </div>
                  <div className={styles.rowActions}>
                    <button
                      type="button"
                      className={`${styles.button} ${styles.buttonSmall} ${styles.buttonDanger}`}
                      disabled={pending}
                      onClick={() => setCustomModels((prev) => prev.filter((_, i) => i !== index))}
                    >
                      移除
                    </button>
                  </div>
                </div>
              ))}
              {customModels.length === 0 ? <span className={styles.rowHint}>还没有添加模型。</span> : null}
            </div>
            <div className={styles.fieldRow} style={{ marginTop: 12 }}>
              <Field label="模型 id">
                <TextInput value={newModelId} disabled={pending} onChange={setNewModelId} placeholder="例如 deepseek-chat" />
              </Field>
              <div className={styles.field}>
                <span className={styles.fieldLabel}>&nbsp;</span>
                <button
                  type="button"
                  className={styles.button}
                  disabled={pending || newModelId.trim().length === 0}
                  onClick={() => {
                    const value = newModelId.trim();
                    setCustomModels((prev) =>
                      prev.some((item) => item.value === value) ? prev : [...prev, { label: value, value }],
                    );
                    setNewModelId('');
                  }}
                >
                  添加模型
                </button>
              </div>
            </div>
          </>
        ) : (
          <Notice>
            保存的是"使用推荐模型"这一选择；具体用哪些模型由服务商决定。需要确切清单时，
            可以在下面主动向服务商查询（会真实外呼）。
          </Notice>
        )}

        <div className={styles.toolbar} style={{ marginTop: 12 }}>
          <button type="button" className={styles.button} disabled={discovering || pending || !provider} onClick={() => void discover()}>
            {discovering ? '正在向服务商查询…' : '向服务商查询模型清单'}
          </button>
          <span className={styles.rowHint}>
            {isEdit ? '按已保存的配置查询。' : '按当前未保存的配置查询（不会保存）。'}
            该操作会连接模型提供方，可能产生调用记录。
          </span>
        </div>
        {discovered ? (
          discovered.length > 0 ? (
            <div className={styles.chipRow}>
              {discovered.slice(0, 80).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={styles.chip}
                  disabled={pending}
                  onClick={() => {
                    setEnabledModelsMode('custom');
                    setCustomModels((prev) =>
                      prev.some((entry) => entry.value === item.id) ? prev : [...prev, { label: item.id, value: item.id }],
                    );
                  }}
                >
                  + {item.id}
                </button>
              ))}
            </div>
          ) : (
            <Notice tone="warn">服务商没有返回模型清单（你仍然可以手动填写模型 id）。</Notice>
          )
        ) : null}
      </PageCard>

      <PageCard title="模型调用参数" description="这些参数随服务一起保存；没有改动的其它配置会被保留。">
        {definition ? (
          <div className={styles.fieldRow}>
            {definition.modelOptions.map((field) => (
              <Field key={field.name} label={field.title} hint={field.hint}>
                {field.kind === 'select' ? (
                  <Select
                    value={modelParameters[field.name] ?? String(field.defaultValue ?? '')}
                    disabled={pending}
                    onChange={(next) => setModelParameters((prev) => ({ ...prev, [field.name]: next }))}
                    options={field.options ?? []}
                  />
                ) : (
                  <TextInput
                    type="number"
                    value={modelParameters[field.name] ?? ''}
                    disabled={pending}
                    onChange={(next) => setModelParameters((prev) => ({ ...prev, [field.name]: next }))}
                  />
                )}
              </Field>
            ))}
          </div>
        ) : (
          <Notice tone="warn">请先选择服务商。</Notice>
        )}
      </PageCard>

      <PageCard title="保存">
        {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
        <div className={styles.toolbar} style={{ marginBottom: 0 }}>
          <button type="button" className={`${styles.button} ${styles.buttonPrimary}`} disabled={pending} onClick={() => void submit()}>
            {pending ? '正在保存…' : isEdit ? '保存配置' : '创建服务'}
          </button>
          {isEdit ? <StatusPill tone="neutral">保存不会自动调用模型</StatusPill> : null}
        </div>
      </PageCard>
    </>
  );
}
