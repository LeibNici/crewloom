import { Form } from 'antd';
import { NodeConfigForm } from '../components/NodeConfigForm';
import { nodeTypeSpec, validateNodeConfig } from '../nodeTypes';
import styles from '../workflow.module.css';

/**
 * 人工处理（`manual`）节点在**原生画布配置抽屉**里的表单。
 *
 * 背景（必须先说的上游事实，见报告 20 §3.7）：
 *  - NocoBase 2.2.20（目标实例）与 2.2.22（本仓库固定源码）的
 *    `@nocobase/plugin-workflow-manual` **client-v2 入口只注册任务类型**
 *    （`src/client-v2/plugin.tsx` 的 `load()` 只有 `registerTaskType(TASK_TYPE_MANUAL, …)`），
 *    **没有 v2 的 Manual instruction**；
 *  - `@nocobase/plugin-workflow` 的 v2 `registerBuiltinInstructions()` 只注册 9 个核心节点；
 *  - 唯一存在的 `manual` instruction 是 **v1**（`plugin-workflow-manual/src/client/instruction/index.tsx`），
 *    它依赖 `@nocobase/client` 的 Formily v1 渲染面，不能直接放进 v2 画布。
 *  已用 npm 发布产物核对：2.2.20 与 2.2.22 的 `dist/client-v2/` 都没有 `nodes/manual`。
 *
 * 因此这是一个**宿主适配器**（host adapter），不是上游同名类、也不是静态假面板：
 *  - 字段语义来自**上游 server 的 `ManualConfig`**（`{ schema, forms, assignees?, mode?, title? }`，
 *    见 `plugin-workflow-manual/src/server/ManualInstruction.ts`）与 v1 `fieldset`
 *    （`assignees` 必填、`mode` 默认 1、`title`、`schema`、`forms`）；
 *  - 控件复用产品已有的**真实字段引擎** `NodeConfigForm`（`nodeTypes.ts` 的字段规格同样来自上游契约）；
 *  - 只做"把受控值接到抽屉的 antd Form"这一层桥接（`config` ↔ `['config']`）。
 */
/**
 * 让抽屉的 antd Form **登记** `config` 这个字段。
 *
 * 原生的配置抽屉提交时用 `form.validateFields()` 取值，而 rc-field-form **只返回登记过的字段**
 * （没有 `Form.Item name="config"` 时就是空对象——实测保存出来是 `{"config":{}}`）。
 * 这里用一个不渲染任何 DOM 的载体组件把 `config` 登记进 Form store；
 * 字段值仍然由下面的 `NodeConfigForm` 通过 `form.setFieldValue('config', next)` 写入。
 */
function ConfigFieldCarrier() {
  return null;
}

export function ManualFieldset() {
  const form = Form.useFormInstance();
  // 抽屉的 antd Form 以 `['config', ...]` 存放；这里读写整棵 config 对象。
  const config = (Form.useWatch('config', form) ?? {}) as Record<string, unknown>;
  const spec = nodeTypeSpec('manual');
  return (
    <div data-testid="manual-native-fieldset">
      <Form.Item name="config" noStyle>
        <ConfigFieldCarrier />
      </Form.Item>
      <p className={styles.cellHint}>
        到这一步流程会停下来，等负责人处理后再继续。请确认负责人、处理方式与要填写的表单。
      </p>
      <NodeConfigForm
        fields={spec?.fields ?? []}
        config={config}
        /* 产品侧体检（不拦截原生抽屉的提交，只把问题显示在字段下方，用户能看懂缺什么）。 */
        errors={validateNodeConfig('manual', config)}
        onChange={(next) => {
          form.setFieldValue('config', next);
        }}
      />
    </div>
  );
}

export default ManualFieldset;
