import { QueryClient } from '@tanstack/react-query';

/**
 * React Query 的键定义。
 *
 * 账号、角色或会话变化时统一清空缓存（见 App.tsx 的 subscribe 与
 * `resetQueryCache`），避免旧权限数据把之前的权限状态恢复回来。
 */
export const queryKeys = {
  accessControl: (role: string | null) => ['acl', 'check', role ?? '__effective__'] as const,
  myPendingTaskStats: ['workbench', 'pendingTaskStats'] as const,
  myTaskTypes: ['workbench', 'taskTypes'] as const,
  myConversations: ['workbench', 'conversations'] as const,
  myEmployees: ['workbench', 'employees'] as const,
  workbench: ['workbench'] as const,
};

/** 账号、角色或会话变化时清空查询缓存。 */
export function resetQueryCache(client: QueryClient): void {
  client.clear();
}
