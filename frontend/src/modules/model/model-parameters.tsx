import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CrewloomError } from '../../api/errors';
import { PageCard } from '../../components/Card';
import { Field, Notice, Select, StateBlock, TextInput } from '../ai/ui';
import { getServiceRaw, mergeServiceOptions, resourceMessageOf, resourceStateOf, updateService } from './resources';
import { providerDefinition } from './providers';
import type { OptionField } from './providers';
import styles from '../ai/group-a.module.css';

/**
 * 模型调用参数（LM-03 使用，LM-02 共用同一套取值/合并逻辑）。
 *
 * 参数写在服务的 `options` 里（原生表单同样把模型参数放在 `options` 下），
 * 而 `llmServices.options` 的更新是**整体替换**，所以这里的保存也是
 * "重新读取完整 options → 打补丁 → 整体回传"。密钥等其它键原样保留。
 */

export type ModelParameterState = Record<string, string>;

export function optionFieldsToState(
  fields: OptionField[],
  options: Record<string, unknown>,
): ModelParameterState {
  const state: ModelParameterState = {};
  for (const field of fields) {
    const value = options[field.name];
    state[field.name] =
      value === undefined || value === null ? '' : typeof value === 'string' ? value : String(value);
  }
  return state;
}

/** 把界面里的参数字符串转成要写回 `options` 的补丁（空值不下发，避免误清空）。 */
export function patchFromModelParameters(
  fields: OptionField[],
  state: ModelParameterState,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = state[field.name];
    if (raw === undefined || raw === null || raw === '') continue;
    if (field.kind === 'number') {
      const parsed = Number(raw);
      if (!Number.isNaN(parsed)) patch[field.name] = parsed;
    } else {
      patch[field.name] = raw;
    }
  }
  return patch;
}

/** 给定提供方，渲染可编辑的模型参数卡片。 */
export function ModelParametersCard({ name }: { name: string }) {
  const service = useQuery({
    queryKey: ['model', 'service', 'raw', name],
    queryFn: () => getServiceRaw(name),
    retry: false,
  });
  const definition = providerDefinition(service.data?.provider);
  const initial = useMemo(
    () => optionFieldsToState(definition?.modelOptions ?? [], service.data?.options ?? {}),
    [definition, service.data],
  );
  const [state, setState] = useState<ModelParameterState>(initial);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);

  useEffect(() => setState(initial), [initial]);

  const state_ = service.isLoading ? 'loading' : resourceStateOf(service.error, service.data === null);

  if (state_ !== 'ready') {
    return (
      <PageCard title="模型调用参数">
        <StateBlock
          state={state_}
          message={resourceMessageOf(service.error)}
          onRetry={() => void service.refetch()}
          deniedDescription="你的角色没有读取这条服务配置的权限。"
        />
      </PageCard>
    );
  }

  if (!definition) {
    return (
      <PageCard title="模型调用参数">
        <Notice tone="warn">
          这条服务的提供方（{service.data?.provider ?? '未知'}）不在当前前端的字段定义里，无法安全地编辑参数；
          请到服务配置页查看原始配置。
        </Notice>
      </PageCard>
    );
  }

  const save = async () => {
    setPending(true);
    setMessage(null);
    try {
      // 重新读取一次，保证基于最新 options 合并（并发下仍会以最后一次提交为准）。
      const latest = await getServiceRaw(name);
      const merged = mergeServiceOptions(
        latest?.options ?? {},
        patchFromModelParameters(definition.modelOptions, state),
      );
      await updateService(name, { options: merged });
      setMessage({ tone: 'info', text: '已保存模型参数。' });
      void service.refetch();
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
    <PageCard title="模型调用参数" description="保存时会在最新配置上修改这些参数，未列出的配置项保持不变。">
      <div className={styles.fieldRow}>
        {definition.modelOptions.map((field) => (
          <Field key={field.name} label={field.title} hint={field.hint}>
            {field.kind === 'select' ? (
              <Select
                value={state[field.name] ?? String(field.defaultValue ?? '')}
                disabled={pending}
                onChange={(next) => setState((prev) => ({ ...prev, [field.name]: next }))}
                options={field.options ?? []}
              />
            ) : (
              <TextInput
                type="number"
                value={state[field.name] ?? ''}
                disabled={pending}
                onChange={(next) => setState((prev) => ({ ...prev, [field.name]: next }))}
              />
            )}
          </Field>
        ))}
      </div>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <div className={styles.toolbar} style={{ marginBottom: 0 }}>
        <button
          type="button"
          className={`${styles.button} ${styles.buttonPrimary}`}
          disabled={pending}
          onClick={() => void save()}
        >
          {pending ? '正在保存…' : '保存模型参数'}
        </button>
      </div>
    </PageCard>
  );
}
