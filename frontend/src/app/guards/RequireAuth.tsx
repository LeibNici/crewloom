import { createElement } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { useSessionStore } from '../../auth/store';
import { BootScreen, UnavailableScreen } from '../../screens/BootScreen';

/**
 * 受保护路由：未登录一律跳转登录页，并把站内返回路径带过去。
 * 返回路径只接受站内相对地址（见 sanitizeReturnTo）。
 *
 * 无法确认登录状态（网络/5xx）时不跳登录页，而是显示可重试的说明：保留令牌，
 * 不把暂时故障伪装成"未登录"。
 */
export function RequireAuth() {
  const status = useSessionStore((state) => state.status);
  const location = useLocation();

  if (status === 'idle' || status === 'booting') {
    return createElement(BootScreen, { compact: true });
  }

  if (status === 'unavailable') {
    return createElement(UnavailableScreen);
  }

  if (status !== 'authenticated') {
    const params = new URLSearchParams();
    const returnTo = `${location.pathname}${location.search}`;
    if (returnTo && returnTo !== '/') params.set('returnTo', returnTo);
    const query = params.toString();
    return createElement(Navigate, {
      to: query ? `/login?${query}` : '/login',
      replace: true,
    });
  }

  return createElement(Outlet);
}
