import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { RouterProvider } from 'react-router';
import { onRoleInvalid, onSessionExpired, setApiBase } from './api/client';
import { resolveApiBase } from './api/url';
import { useSessionStore } from './auth/store';
import { createAppRouter } from './app/router';

/**
 * 应用装配：
 *  - 创建独立的 QueryClient，并在会话/角色/账号变化时清空缓存，
 *    确保旧权限数据不会把之前的权限状态恢复回来；
 *  - 令牌与角色由 auth store 通过请求层的 SDK Auth 直接读写
 *    （见 auth/store.ts 与 api/client.ts），App 不再重复同步身份，
 *    避免在启动时把已持久化的令牌误清空；
 *  - 会话失效与角色失效分别接回 auth store。
 */
export function App() {
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            refetchOnWindowFocus: false,
            staleTime: 15_000,
          },
        },
      }),
    [],
  );

  useEffect(() => {
    setApiBase(resolveApiBase());

    const unsubscribeExpired = onSessionExpired(() => {
      queryClient.clear();
      useSessionStore.getState().handleSessionExpired();
    });

    const unsubscribeRoleInvalid = onRoleInvalid(() => {
      queryClient.clear();
      void useSessionStore.getState().handleRoleInvalid();
    });

    const unsubscribeStore = useSessionStore.subscribe((state, previous) => {
      if (state.user?.id !== previous.user?.id || state.activeRole !== previous.activeRole) {
        // 账号或角色变化：连同查询缓存一起失效，避免串号或沿用旧权限数据。
        queryClient.clear();
      }
    });

    void useSessionStore.getState().bootstrap();

    return () => {
      unsubscribeExpired();
      unsubscribeRoleInvalid();
      unsubscribeStore();
      // 只解除监听，不清理已持久化的会话：React StrictMode 会 mount → unmount → mount，
      // 在 cleanup 里清令牌会把刚恢复的会话删掉。
    };
  }, [queryClient]);

  const router = useMemo(() => createAppRouter(), []);

  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
