// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthContext } from '../../../src/api/client';
import {
  NativeCanvasHost,
  hasNativeCanvasModule,
  registerNativeCanvasModule,
  type NativeCanvasMountOptions,
  type NativeCanvasModule,
} from '../../../src/modules/workflow/components/nativeCanvasBridge';

/**
 * 原生画布宿主桥接的契约测试。
 *
 * 目的：证明"公共依赖未到位时不伪造画布、依赖到位时按产品认证/角色/请求出口挂载"这条路径
 * 是**真实可执行的接口**，而不是报告里的一句话。
 *
 * 不依赖任何未声明的包：这里注入一个测试实现，断言传给它的宿主参数。
 */
beforeEach(() => {
  setAuthContext({ token: 'token-123', role: 'admin' });
});

describe('原生画布宿主桥接', () => {
  it('未注册宿主模块时不渲染画布容器，明确说明未接入', () => {
    expect(hasNativeCanvasModule()).toBe(false);
    render(<NativeCanvasHost workflowId="172" />);
    expect(screen.getByText('原生画布运行时未接入')).toBeTruthy();
    // 挂载容器必须存在（注入可能发生在首次渲染之后），但未接入时不可见。
    const mount = screen.getByTestId('native-canvas-mount');
    expect(mount.className).toContain('canvasMountHidden');
    expect(screen.queryByText(/运行时来源：/)).toBeNull();
    expect(screen.getByText(/不会用静态卡片或顺序列表冒充它/)).toBeTruthy();
  });

  it('注册宿主模块后按产品认证/角色/API 基地址与请求出口挂载', async () => {
    const mount = vi.fn((_options: NativeCanvasMountOptions) => ({ unmount: vi.fn() }));
    const module: NativeCanvasModule = { mount, origin: 'test-runtime@2.2.22' };
    registerNativeCanvasModule(async () => module);
    expect(hasNativeCanvasModule()).toBe(true);

    render(<NativeCanvasHost workflowId="172" />);

    await waitFor(() => expect(mount).toHaveBeenCalledTimes(1));
    const options = mount.mock.calls[0]?.[0] as NativeCanvasMountOptions | undefined;
    expect(options?.workflowId).toBe('172');
    expect(options?.apiBase).toBe('/api');
    expect(options?.token).toBe('token-123');
    expect(options?.role).toBe('admin');
    // 请求出口必须是产品的受控出口（同一套 product/strict 策略与错误分类）。
    expect(typeof options?.request).toBe('function');
    expect(typeof options?.listNodes).toBe('function');
    expect(await screen.findByText(/运行时来源：test-runtime@2.2.22/)).toBeTruthy();
  });
});
