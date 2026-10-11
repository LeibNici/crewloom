import { api, serializeFilter } from '../../api/client';
import type { ApiResult, ListParams, RequestOptions } from '../../api/types';

/**
 * 显式 GET 的只读资源动作调用（组 A 独占，**不是**第二条请求通道）。
 *
 * 为什么需要它：`src/api/client.ts` 的 `resourceAction` 用 `src/api/url.ts` 的
 * `isReadAction()` 决定 GET/POST，而该名单只包含 `get/list/check/publicList/listAccessible/
 * getAccessible/listMine/listByUser`。本组这些**真实的只读自定义动作**不在名单里：
 *
 *  - `ai:listLLMServices`（后端已脱敏的服务列表，32 页矩阵 LM-01 指定入口）
 *  - `ai:listLLMProviders`（服务商清单）
 *  - `aiContextDatasources:preview`（受权限约束预览）
 *  - `aiTools:listBinding` / `aiSkills:listBinding`（员工能力绑定）
 *
 * 若用 `resourceAction` 调用它们会被当成 POST：严格只读验证会按
 * `read-action-must-be-get` 拦下，与"只读动作必须 GET"的约定冲突。
 * 这里因此用**同一个** `api.request`（同一条 SDK 管线、同一套认证/角色/续期/传输策略）
 * 显式声明 `method: 'get'`，并且复用公共的 `serializeFilter` 序列化 `filter`。
 *
 * 公共需求（已写入本组报告）：把上述动作名加入 `src/api/url.ts` 的 `READ_ACTIONS`，
 * 之后就可以统一改用 `resourceAction`；组内不修改公共文件。
 */
export async function readAction<T>(
  resource: string,
  action: string,
  params?: ListParams,
  options?: RequestOptions,
): Promise<ApiResult<T>> {
  const { filter, ...rest } = params ?? {};
  const query: Record<string, unknown> = { ...rest };
  const serialized = serializeFilter(filter);
  if (serialized !== undefined) query.filter = serialized;
  return api.request<T>({
    url: `${resource}:${action}`,
    method: 'get',
    params: query,
    headers: { 'X-Data-Source': options?.dataSource ?? 'main', ...(options?.headers ?? {}) },
    signal: options?.signal,
  });
}
