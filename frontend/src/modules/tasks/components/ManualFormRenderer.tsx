import React, { useMemo, Suspense } from 'react';
import { PageCard } from '../../../components/Card';
import { asRecord } from '../../workflow/format';
import { normalizeSchemaRoot, type FormValues, type ManualFormBlock } from '../manualForm';
import {
  getManualSchemaComponents,
  ManualSchemaHost,
  prepareSchemaForFormily,
  registerManualSchemaComponents,
  type ManualFormHostValue,
} from './manualSchemaHost';

/**
 * TD-02 人工处理表单渲染入口。
 *
 * 生产/浏览器走**真实 NocoBase v1 组件链**（`@nocobase/client` 的 `SchemaComponent` +
 * `DetailsBlockProvider` + 字段组件 + 插件级 provider/scope，见 `native/manualNativeChain.tsx`）。
 *
 * 为什么用 `React.lazy` + 动态 import：
 *  - 真实组件链只能在浏览器（Vite 解析器）里加载；本项目 vitest/jsdom 无法解析
 *    `@nocobase/client` 的 ESM 子路径（`vitest.config.ts` 已记录该已知限制），
 *    因此 jsdom 断言留在不依赖原生组件的桥接/契约层，原生 consumer/hook 断言在浏览器核对里；
 *  - 动态 chunk 也让未打开人工处理页的用户不为此付出首屏体积。
 *
 * 本文件只保留页面契约：把任务详情里的 schema / forms / 已有结果 / 动作提交回调接进来，
 * 并在解析不到表单块时明确说明"表单定义无法识别"，不伪造表单。
 */

export { registerManualSchemaComponents, getManualSchemaComponents };
export type { ManualSchemaComponent, ManualSchemaComponentProps } from './manualSchemaHost';

const NativeChain = React.lazy(() =>
  import('./native/manualNativeChain').then((module) => ({ default: module.ManualNativeChain })),
);

/** jsdom 无法解析原生组件；测试环境使用不依赖 `@nocobase/client` 的等价宿主验证页面契约。 */
const USE_NATIVE_CHAIN = import.meta.env.MODE !== 'test';

export interface ManualFormRendererProps {
  /** `node.config.schema` 原始值（Formily UI schema）。 */
  schema: Record<string, unknown> | null;
  blocks: ManualFormBlock[];
  /** `node.config.forms`（提交动作与处理类型配置）。 */
  forms: Record<string, unknown>;
  /** 后端已保存的表单值（`result`）。 */
  storedResult: unknown;
  /** 任务记录（`workflowManualTasks:get` 的响应；原生 `useCollectionRecordData` 需要它）。 */
  record?: Record<string, unknown> | null;
  job?: Record<string, unknown> | null;
  execution?: Record<string, unknown> | null;
  currentUserId?: string | number | null;
  /** 是否只读（例如任务已处理或执行已结束）。 */
  readOnly?: boolean;
  disabled?: boolean;
  submitting?: boolean;
  /** 提交**已组装好的**提交体（原生 `useSubmit` 的组装结果）。 */
  onSubmitPayload?: (payload: Record<string, unknown>) => Promise<void>;
  onSubmit: (block: ManualFormBlock, actionKey: string, values: FormValues) => void;
  loadAssociationOptions?: ManualFormHostValue['loadAssociationOptions'];
}

export function ManualFormRenderer({
  schema,
  blocks,
  forms,
  storedResult,
  record = null,
  job = null,
  execution = null,
  currentUserId = null,
  readOnly = false,
  disabled = false,
  submitting = false,
  onSubmitPayload,
  onSubmit,
  loadAssociationOptions,
}: ManualFormRendererProps) {
  const rootSchema = useMemo(() => normalizeSchemaRoot(schema), [schema]);
  // 同一条归一：缺少 `type` 的节点补 `void`、必填字段补中文校验文案
  // （原生文案由 i18n 编译；这里用 Formily 的 `x-validator` 规则对象承载同一语义）。
  const preparedSchema = useMemo(
    () => (rootSchema ? prepareSchemaForFormily(rootSchema) : null),
    [rootSchema],
  );
  const result = useMemo(() => asRecord(storedResult), [storedResult]);

  if (blocks.length === 0 || !rootSchema || !preparedSchema) {
    return (
      <PageCard tone="muted" title="表单定义无法识别">
        <p>
          这个人工节点没有可识别的表单定义。为避免误提交，页面不会生成替代表单；
          请让流程设计者在节点里配置处理表单后再试。
        </p>
      </PageCard>
    );
  }

  if (USE_NATIVE_CHAIN && record && onSubmitPayload) {
    return (
      <Suspense fallback={<p style={{ color: '#8c8c8c' }}>正在准备表单渲染环境…</p>}>
        <NativeChain
          schema={preparedSchema}
          record={record}
          formKeys={blocks.map((block) => block.formKey)}
          currentUserId={currentUserId}
          submitting={submitting || disabled}
          onSubmit={onSubmitPayload}
        />
      </Suspense>
    );
  }

  return (
    <ManualSchemaHost
      schema={rootSchema}
      blocks={blocks}
      forms={forms}
      storedResult={result}
      job={job}
      execution={execution}
      currentUserId={currentUserId == null ? null : String(currentUserId)}
      readOnly={readOnly}
      disabled={disabled}
      submitting={submitting}
      onSubmit={onSubmit}
      loadAssociationOptions={loadAssociationOptions}
    />
  );
}
