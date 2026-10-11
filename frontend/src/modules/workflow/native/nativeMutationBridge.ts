/**
 * 原生画布节点变更 → 宿主刷新 的最小联动（**复用已有 SDK 请求管线**，不新建 event bus）。
 *
 * 背景（Main 实测）：原生画布抽屉里保存节点、或新增/复制/移动/删除节点后，原生侧自己会
 * `refresh()` 画布，但产品页「节点处理顺序」用的是**自己的**一次 `flow_nodes:list` 结果
 * （`WorkflowCanvasPage.load()`），没有任何东西通知它——于是外围摘要停在旧值（`1+1`），
 * 必须离开再重进才刷新。
 *
 * 处理方式：原生画布与产品页共用**同一个** `sdk`（`nativeWorkflowCanvas.tsx` 的
 * `createApiClient()` 直接返回产品 SDK 实例），因此这里只在该实例的**响应拦截器**上挂一个
 * 判别函数：请求成功且是节点写动作时通知宿主刷新。
 *
 * 刻意不做的事：
 *  - 不监听读请求（`flow_nodes:list` 等），避免"无变化也整页重拉"的循环；
 *  - 不引入新的全局事件总线/定时轮询：只在写成功后回调一次，由宿主自己决定怎样合并刷新；
 *  - 不碰 vendor 字节：vendor 画布的 `refresh()` 与这里互不影响。
 */

/**
 * 需要联动宿主的写动作（路径去掉 `/api` 前缀后的动作名）。
 *
 * 覆盖原生画布能发出的全部节点变更：配置抽屉保存（`update`）、原生「+」新增
 * （`workflows/<id>/nodes:create`）、拖拽移动（`move`）、复制（`duplicate`）、
 * 删除节点（`destroy`）、删除分支（`destroyBranch`）。
 */
export const NATIVE_NODE_MUTATION_ACTIONS = [
  'flow_nodes:update',
  'flow_nodes:move',
  'flow_nodes:duplicate',
  'flow_nodes:destroy',
  'flow_nodes:destroyBranch',
] as const;

const NODE_MUTATION_ACTION_SET = new Set<string>(NATIVE_NODE_MUTATION_ACTIONS);

/** 从 axios 的 `config.url` 取出动作名（去掉 query、`/api` 前缀与前后斜杠）。 */
export function resolveRequestAction(url: unknown): string | null {
  if (typeof url !== 'string' || !url) return null;
  const path = url.split('?')[0].split('#')[0];
  const trimmed = path.replace(/^\/+/, '').replace(/^api\/+/, '').replace(/\/+$/, '');
  return trimmed || null;
}

/**
 * 一次成功响应是否代表"节点被改动过"。
 *
 * `workflows/<id>/nodes:create` 是关联资源动作（真实路径），单独按正则匹配；
 * 其余是集合级写动作，直接比对动作名。
 */
export function isNativeNodeMutation(config: unknown): boolean {
  const request = (config ?? {}) as { url?: unknown; method?: unknown };
  if (String(request.method ?? '').toLowerCase() !== 'post') return false;
  const action = resolveRequestAction(request.url);
  if (!action) return false;
  if (NODE_MUTATION_ACTION_SET.has(action)) return true;
  return /^workflows\/[^/]+\/nodes:create$/.test(action);
}

/** 只依赖 axios 拦截器的最小接口（便于单元测试注入假实例，不把 SDK 带进 jsdom）。 */
export interface ResponseInterceptorHost<V> {
  interceptors: {
    response: {
      use: (onFulfilled: (response: V) => V) => number;
      eject: (id: number) => void;
    };
  };
}

/**
 * 在给定 axios 实例上挂联动；返回卸载函数。
 *
 * 只在**成功**响应上回调（失败走错误分支，不会误刷新）；返回值原样透传，不改变任何响应。
 * 同一时刻只允许一个拦截器：重复安装前先卸载旧的（React StrictMode 会跑两次 effect）。
 */
export function installNativeNodeMutationBridge<V>(
  host: ResponseInterceptorHost<V>,
  onNodeMutation: () => void,
): () => void {
  const id = host.interceptors.response.use((response: V) => {
    const config = (response as { config?: unknown } | undefined)?.config;
    if (isNativeNodeMutation(config)) onNodeMutation();
    return response;
  });
  return () => host.interceptors.response.eject(id);
}
