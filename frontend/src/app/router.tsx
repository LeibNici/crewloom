import { createElement, type ReactElement } from 'react';
import { Navigate, createBrowserRouter, useLocation } from 'react-router';
import { useSessionStore } from '../auth/store';
import { AppLayout } from './AppLayout';
import { RequireAuth } from './guards/RequireAuth';
import { RequireModuleAccess } from './guards/RequireModuleAccess';
import { LoginScreen } from '../screens/LoginScreen';
import { ChangePasswordScreen } from '../screens/ChangePasswordScreen';
import { ModuleBoardScreen } from '../screens/ModuleBoardScreen';
import { NoAccessScreen, NotFoundScreen } from '../screens/AccessDeniedScreen';
import { MODULES } from '../modules/registry';
import { defaultLandingPath } from './landing';

/**
 * 路由由**模块注册表**驱动（`src/modules/registry.ts` → 各模块 `index.tsx`）。
 *
 * 公共负责人唯一维护本文件；三组只在自己的模块文件里增删页面条目：
 *  - `boards[].path` 是相对片段，**可以带参数**（如 `conversations/:sessionId`）；
 *  - 条目提供 `Component` 时用它渲染，否则回退到公共占位页（诚实说明"尚未开放"）；
 *  - 模块根路径用 `IndexComponent`（目前只有工作台需要）。
 */

function IndexRedirect(): ReactElement {
  const access = useSessionStore((state) => state.access);
  const probes = useSessionStore((state) => state.probes);
  const location = useLocation();
  return createElement(Navigate, {
    to: defaultLandingPath(access, location.search, probes),
    replace: true,
  });
}

const moduleRoutes = MODULES.map((module) => ({
  path: module.path.replace(/^\//, ''),
  element: createElement(RequireModuleAccess, { module }),
  children: [
    {
      index: true,
      element: module.IndexComponent
        ? createElement(module.IndexComponent, { module })
        : createElement(ModuleBoardScreen, { moduleId: module.id }),
    },
    ...module.boards.map((board) => ({
      path: board.path,
      element: board.Component
        ? createElement(board.Component, { module, board })
        : createElement(ModuleBoardScreen, { moduleId: module.id, boardPath: board.path }),
    })),
  ],
}));

export function createAppRouter() {
  return createBrowserRouter([
    { path: '/login', element: createElement(LoginScreen) },
    {
      path: '/',
      element: createElement(RequireAuth),
      children: [
        {
          element: createElement(AppLayout),
          children: [
            { index: true, element: createElement(IndexRedirect) },
            { path: 'no-access', element: createElement(NoAccessScreen) },
            // 账号公共页（PUB-01）：修改密码。放在登录保护与统一布局内，深链可直达。
            { path: 'account/password', element: createElement(ChangePasswordScreen) },
            ...moduleRoutes,
            { path: '*', element: createElement(NotFoundScreen) },
          ],
        },
      ],
    },
    { path: '*', element: createElement(Navigate, { to: '/', replace: true }) },
  ]);
}
