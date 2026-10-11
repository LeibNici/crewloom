import { SolutionOutlined } from '@ant-design/icons';
import type { Application } from '@nocobase/client-v2';
import { Instruction } from '@nocobase/plugin-workflow/client-v2';

/**
 * `manual`（人工处理）节点的**宿主适配器**：把"人工处理"接进原生 v2 画布的 instruction registry。
 *
 * 为什么需要适配器（上游事实，逐条可核）：
 *  1. NocoBase **2.2.22**（本仓库固定源码，commit `a4eac04d…`）的
 *     `@nocobase/plugin-workflow-manual/src/client-v2/plugin.tsx` `load()` 只调用
 *     `workflow.registerTaskType(TASK_TYPE_MANUAL, manualTaskType)`，**不注册 instruction**；
 *  2. `@nocobase/plugin-workflow/src/client-v2/plugin.tsx::registerBuiltinInstructions()`
 *     只注册 `calculation / condition / multi-conditions / end / output / query / create / update / destroy`
 *     九个核心节点；它注册了 `manual` 这个 **instruction group**，但没有同名的 instruction；
 *  3. 唯一真实存在的 `manual` instruction 在 **v1**：
 *     `plugin-workflow-manual/src/client/index.tsx:39` `workflow.registerInstruction('manual', Manual)`，
 *     其实现 `client/instruction/index.tsx` 依赖 `@nocobase/client`（Formily v1）的渲染面，
 *     不能直接渲染进 v2 画布；
 *  4. 用 npm 发布产物复核：目标 **2.2.20** 与本仓库 **2.2.22** 的
 *     `dist/client-v2/` 都只有 `collections / index / locale / plugin / tasks`，**没有 `nodes/manual`**。
 *
 * 结论：v2 画布上"人工处理"面板在上游 2.x 里不存在，且 2.2.22 是 2.2 线最新版本（无更新版本可升级）。
 * 按"不发明面板、不搞同名假类"的要求，这里做的是**显式命名的宿主适配器**：
 *  - 继承**真正的上游** v2 `Instruction` 基类（`@nocobase/plugin-workflow/client-v2`）；
 *  - 标题/描述沿用**上游 i18n 键**（`workflow-manual` 命名空间的 `Manual` 等）；
 *  - 配置字段遵循**上游 server 契约** `ManualConfig` 与 v1 `fieldset`；
 *  - 面板复用产品已有的真实字段引擎（`manualFieldset.tsx` → `NodeConfigForm`）。
 *
 * 该适配器只影响本产品挂载的原生画布；不改上游源码、不改服务端行为。
 */
export class CrewloomManualInstructionAdapter extends Instruction {
  /**
   * 稳定标记：生产构建会压缩类名，所以"这条 `manual` 是不是宿主适配器注册的"用属性判定，
   * 而不是用 `constructor.name`（dev 能过、build 会失效——实测）。
   */
  readonly crewloomHostAdapter = 'manual';

  type = 'manual';
  group = 'manual';
  title = '{{t("Manual", { ns: "workflow-manual" })}}';
  description =
    '{{t("Could be used for manually submitting data, and determine whether to continue or exit. Workflow will generate a todo item for assigned user when it reaches a manual node, and continue processing after user submits the form.", { ns: "workflow-manual" })}}';
  icon = <SolutionOutlined />;
  FieldsetLoader = () => import('./manualFieldset').then((module) => ({ default: module.ManualFieldset }));

  /**
   * 新节点的初始 config：与上游 v1 `fieldset` 的默认值一致
   * （`assignees` 默认 `[]`、`mode` 默认 `1`、`schema` 上游默认 `null`、`forms` 默认 `{}`）。
   * `title` 上游默认是 `{{useNodeContext().title}}` 模板，v2 侧留空由节点标题兜底（服务端
   * `run()` 在 `config.title` 为空时使用 `node.title`）。
   */
  createDefaultConfig() {
    return {
      assignees: [],
      mode: 1,
      schema: { type: 'void', properties: {} },
      forms: {},
    };
  }
}

type WorkflowPluginRegistryLike = {
  /** 上游 v2 插件公开方法：注册一个节点类型的 v2 instruction（接受类或实例）。 */
  registerInstruction?: (type: string, instruction: Instruction) => void;
  /** 上游 v2 插件公开方法：按类型取回已注册的 instruction。 */
  getInstruction?: (type: string) => Instruction | undefined;
};

/**
 * 把人工处理适配器注册进原生画布宿主。
 *
 * 必须在 `await app.load()` **之后**调用：`load()` 里各插件的注册已完成，registry 可写。
 * 上游 `Registry.register` 不允许覆盖同名键（`does not allow to override existing keys`），
 * 因此先探测是否已存在；已存在就跳过——**未来上游补齐 v2 manual instruction 时本适配器自动让位**，
 * 不会覆盖上游实现。
 *
 * @returns `true` 表示由本适配器注册；`false` 表示上游已提供（或宿主未就绪）。
 */
export function registerManualInstructionAdapter(app: Application): boolean {
  const workflow = (app.pm as unknown as { get: (name: string) => unknown }).get('workflow') as
    | WorkflowPluginRegistryLike
    | undefined;
  if (!workflow?.registerInstruction) return false;
  if (typeof workflow.getInstruction === 'function' && workflow.getInstruction('manual')) return false;
  workflow.registerInstruction('manual', new CrewloomManualInstructionAdapter());
  return true;
}
