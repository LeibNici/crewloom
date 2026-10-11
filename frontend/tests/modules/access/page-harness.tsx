import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { createElement, type ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { getHttpClient, resetAuthContext, setApiBase, setAuthContext } from '../../../src/api/client';
import { useSessionStore } from '../../../src/auth/store';
import type { AccessControlData } from '../../../src/auth/types';
import { MODULE_BY_ID } from '../../../src/modules/registry';
import type { BoardDefinition, ModuleDefinition, ModulePageProps } from '../../../src/modules/types';

/**
 * 组 B 页面测试脚手架（受控 adapter，不连真实后端）。
 *
 * 关键约定：
 *  - 断言**真实接口路径**（`<resource>:<action>` / `roles/<role>/<child>:<action>`），确保页面确实对接契约；
 *  - 断言挂载后**没有 POST**：页面不得自动触发任何写入或外呼动作（readTables/testConnection/syncFields 等）；
 *  - 六态（空/无权限/未登录/错误）分开断言，避免互相冒充。
 */

export interface CapturedRequest {
  method: string;
  path: string;
  params: Record<string, unknown>;
  data: unknown;
}

export interface Reply {
  status?: number;
  body?: unknown;
}

export interface PageHarness {
  captured: CapturedRequest[];
  /** 设置按路径（`<resource>:<action>`）返回的应答；缺省 `{data: []}`。 */
  routes: Record<string, Reply>;
  serverError: Reply | null;
  /**
   * 可选动态应答器（优先于 `routes`）：用于**按查询参数分页**这类静态路由表达不了的场景
   * （例如同一个关联列表路径对 page=1/2/3 返回不同切片）。与 `controlled-server.ts` 同形。
   */
  handler: ((request: CapturedRequest) => Reply | Promise<Reply>) | null;
  respond: (handler: (request: CapturedRequest) => Reply | Promise<Reply>) => void;
  reset: () => void;
  /** 页面在挂载期间发出的真实请求（不含 OPTIONS 预检）。 */
  posts: () => CapturedRequest[];
}

export const harness: PageHarness = {
  captured: [],
  routes: {},
  serverError: null,
  handler: null,
  reset() {
    this.captured.length = 0;
    this.routes = {};
    this.serverError = null;
    this.handler = null;
  },
  respond(handler) {
    this.handler = handler;
  },
  posts() {
    return this.captured.filter((item) => item.method !== 'get');
  },
};

function parsePath(url: string): string {
  const withoutBase = url.replace(/^\/?api\//, '').replace(/^\/+/, '');
  return withoutBase.split('?')[0];
}

export function installAdapter(): void {
  const client = getHttpClient();
  client.defaults.adapter = async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
    const path = parsePath(config.url ?? '');
    const params = (config.params ?? {}) as Record<string, unknown>;
    let data: unknown = config.data;
    if (typeof data === 'string' && data.length > 0) {
      try {
        data = JSON.parse(data);
      } catch {
        /* 保留原文 */
      }
    }
    harness.captured.push({ method: (config.method ?? 'get').toLowerCase(), path, params, data });

    const request = harness.captured[harness.captured.length - 1];
    const reply = harness.handler
      ? await harness.handler(request)
      : (harness.serverError ?? harness.routes[path] ?? { body: { data: [] } });
    const status = reply.status ?? 200;
    const response: AxiosResponse = {
      data: reply.body === undefined ? { data: [] } : reply.body,
      status,
      statusText: String(status),
      headers: {},
      config,
    };
    if (status >= 400) {
      throw new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', config, undefined, response);
    }
    return response;
  };
}

const ACCESS_ALL: AccessControlData = {
  role: 'root',
  roleMode: 'default',
  strategy: null,
  actions: {},
  resources: [],
  snippets: ['pm', 'pm.*', 'ui.*'],
  allowAll: true,
  allowConfigure: true,
  allowAnonymous: false,
  allowMenuItemIds: [],
  uiButtonSchemasBlacklist: [],
  availableActions: [],
  actionAlias: { list: 'view' },
  roles: ['root'],
};

/** 让页面通过权限门（allowAll），同时保留真实请求路径断言。 */
export function seedSession(): void {
  useSessionStore.setState({
    status: 'authenticated',
    token: 'page-token',
    user: { id: 1, nickname: '受控账号', email: 'page@example.test', roles: [{ name: 'root', title: 'Root' }] },
    roles: [{ name: 'root', title: 'Root' }],
    access: ACCESS_ALL,
    activeRole: 'root',
    roleMode: 'default',
    accessState: 'ready',
    probes: {},
    authenticators: [],
    authenticatorState: 'ready',
    notice: null,
    error: null,
    bootDetail: null,
  });
}

export function resetHarness(): void {
  harness.reset();
  installAdapter();
  setApiBase('/api');
  resetAuthContext();
  setAuthContext({ token: 'page-token', role: null, authenticator: 'basic' });
  seedSession();
}

export function renderPage(element: ReactElement, options: { route?: string; path?: string } = {}): RenderResult {
  const { route = '/', path = '*' } = options;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path={path} element={element} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * 通过**模块注册表**渲染真实页面组件。
 *
 * 这样测试与产品入口（`src/app/router.tsx` → `modules/registry.ts`）的加载顺序一致，
 * 不会出现"模块文件被当作入口"时的再导出环；同时也验证了页面确实注册到了对应模块。
 */
export function renderRegisteredBoard(
  moduleId: string,
  boardPath: string,
  options: { route?: string; path?: string } = {},
): RenderResult {
  const module = MODULE_BY_ID[moduleId] as ModuleDefinition | undefined;
  if (!module) throw new Error(`未注册的模块：${moduleId}`);
  const board = module.boards.find((item) => item.path === boardPath) as BoardDefinition | undefined;
  if (!board) throw new Error(`模块 ${moduleId} 未注册页面：${boardPath}`);
  if (!board.Component) throw new Error(`页面 ${moduleId}/${boardPath} 尚未提供组件`);
  return renderPage(
    createElement(board.Component, { module, board } satisfies ModulePageProps),
    options,
  );
}
