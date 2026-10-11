import { accessCheck, defineModule } from '../types';
import { ModuleHub } from '../ai/ModuleHub';
import { ServicesPage } from './pages/ServicesPage';
import { ServiceConfigPage } from './pages/ServiceConfigPage';
import { ModelsPage } from './pages/ModelsPage';
import { DefaultsPage } from './pages/DefaultsPage';
import { VerifyPage } from './pages/VerifyPage';

/**
 * 模型配置模块（LM-01 … LM-05）——**组 A（AI + LM）独占文件**。
 *
 * 权限来源（固定源码 `plugin-ai/src/server/plugin.ts:287-290, 305-310`）：
 *  - `aiSettings:publicGet` / `ai:listAllEnabledModels` = `loggedIn`；
 *  - `ai:*`（含 `ai:listLLMServices`、`ai:listLLMProviders`、`ai:listModels`、`ai:listProviderModels`、
 *    `ai:testFlight`）与 `llmServices:*` = 片段 **`pm.ai.llm-services`**；
 *  - `aiSettings:*` = 片段 **`pm.ai.ai-settings`**。
 *
 * 2.2.20 实测实现约束（报告 02 §8）：
 *  - **C5/D5**：`llmServices` 主键是 `name`（无 `id`）；`enabledModels` 在 13000 是**对象**，
 *    旧数据可能是字符串数组 —— 实现同时兼容（见 `types.ts` 的 `normalizeEnabledModels`）；
 *    `llmServices:list|get` 的 `options` 是**明文**，展示一律走 `ai:listLLMServices`；
 *  - **C6/D6**：`aiSettings.defaultLLMService` / `defaultModel` 当前为 `null`（现在未配置）；
 *    后端当前不消费它们，页面如实说明，不冒充后台已统一生效。
 *
 * 外呼类动作（`ai:listModels` / `ai:listProviderModels` / `ai:testFlight`）只在真实用户主动点击时调用，
 * 严格自动验证模式在传输层一律拦截。
 */
export const modelModule = defineModule({
  id: 'model',
  title: '模型配置',
  path: '/model',
  subtitle: '服务、模型与默认设置',
  access: accessCheck('model.read', '查看模型配置', 'llmServices', 'list'),
  probeId: 'model.read',
  IndexComponent: ModuleHub,
  boards: [
    /* ------------------------------- LM-01 服务列表 ------------------------------- */
    {
      path: 'services',
      title: '服务列表',
      description: '查看服务商、服务名称与启用状态；列表不显示服务密钥。',
      access: accessCheck('model.services', '查看服务列表', 'llmServices', 'list'),
      probeId: 'model.read',
      endpoints: ['ai:listLLMServices', 'llmServices:list'],
      Component: ServicesPage,
    },
    /* ------------------------------- LM-02 服务配置 ------------------------------- */
    {
      path: 'services/:name',
      title: '服务配置',
      description: '新建或编辑服务：服务商、密钥、可用模型范围与模型参数。',
      access: accessCheck('model.services.config', '编辑服务配置', 'llmServices', 'update'),
      probeId: 'model.read',
      endpoints: [
        'ai:listLLMProviders',
        'llmServices:get',
        'llmServices:create',
        'llmServices:update',
        'ai:listProviderModels',
        'ai:listModels',
      ],
      Component: ServiceConfigPage,
    },
    /* ------------------------------- LM-03 可用模型 ------------------------------- */
    {
      path: 'models',
      title: '可用模型',
      description: '查看各服务当前可用的模型与模型调用参数。',
      access: accessCheck('model.models', '查看可用模型', 'ai', 'listLLMServices'),
      probeId: 'model.read',
      endpoints: ['ai:listLLMServices', 'llmServices:get', 'llmServices:update', 'ai:listModels'],
      Component: ModelsPage,
    },
    /* ------------------------------- LM-04 默认与员工模型 ------------------------------- */
    {
      path: 'defaults',
      title: '默认与员工模型',
      description: '设置默认服务与默认模型，并查看员工允许使用的模型与真实生效顺序。',
      access: accessCheck('model.defaults', '查看默认设置', 'aiSettings', 'get'),
      probeId: 'model.read',
      endpoints: ['aiSettings:get', 'aiSettings:update', 'aiEmployees:list'],
      Component: DefaultsPage,
    },
    /* ------------------------------- LM-05 配置验证入口 ------------------------------- */
    {
      path: 'verify',
      title: '配置验证',
      description: '用真实调用确认一份模型配置是否可用；会产生费用，只在用户主动操作时执行。',
      access: accessCheck('model.verify', '验证模型配置', 'ai', 'testFlight'),
      probeId: 'model.read',
      endpoints: ['ai:listLLMProviders', 'ai:testFlight'],
      Component: VerifyPage,
    },
  ],
});
