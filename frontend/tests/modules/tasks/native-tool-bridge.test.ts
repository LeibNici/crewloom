// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sdk } from '../../../src/api/client';
import {
  EXECUTE_FRONTEND_TOOL_NAME,
  LOAD_FRONTEND_TOOL_NAME,
  ensureSharedNativeRuntime,
  resolveNativeToolRegistry,
  runSelectedFrontendTools,
  type NativeFrontendToolRegistry,
} from '../../../src/modules/tasks/toolBridge';

/**
 * TD-03 工具执行桥的**消费端契约**（jsdom）。
 *
 * 真实 `FrontendToolRegistry` 属于 `@nocobase/plugin-ai` 的 client-v2 闭包，
 * 在本项目 vitest/jsdom 里无法解析（`vitest.config.ts` 已记录该限制），
 * 因此这里只断言 tasks 消费端按原生 `useToolCallActions` 的语义调用注册表：
 * 传什么 toolId/args、异常怎么包、哪些调用不该执行。
 * 真实注册表的执行证据在浏览器核对与 `bridge-needs.md` 记录。
 */
describe('TD-03 前端工具执行桥（消费端契约）', () => {
  beforeEach(() => {
    delete (sdk as unknown as { app?: unknown }).app;
  });

  it('没有原生宿主时不伪造注册表', () => {
    expect(resolveNativeToolRegistry()).toBeNull();
  });

  it('从已存在的宿主入口取真实注册表', () => {
    const registry: NativeFrontendToolRegistry = { execute: vi.fn() };
    (sdk as unknown as { app?: unknown }).app = { pm: { get: () => ({ aiManager: { frontendTools: registry } }) } };
    expect(resolveNativeToolRegistry()).toBe(registry);
  });

  it('executeFrontendTool 用 toolId/args 调注册表，并回传 {id,result}', async () => {
    const execute = vi.fn(async (toolId: string, args: unknown) => ({ toolId, args, ok: true }));
    const registry: NativeFrontendToolRegistry = { execute };
    const outcome = await runSelectedFrontendTools(
      [
        {
          toolCallId: 'call-1',
          name: EXECUTE_FRONTEND_TOOL_NAME,
          args: { toolId: 'ctx-1:preview_datasource_records', args: { limit: 3 } },
          execution: 'frontend',
        },
      ],
      registry,
    );

    expect(execute).toHaveBeenCalledWith('ctx-1:preview_datasource_records', { limit: 3 });
    expect(outcome.toolCallIds).toEqual(['call-1']);
    expect(outcome.executed).toBe(1);
    expect(outcome.toolCallResults).toEqual([
      { id: 'call-1', result: { toolId: 'ctx-1:preview_datasource_records', args: { limit: 3 }, ok: true } },
    ]);
  });

  it('loadFrontendTool 取 manifest；执行异常按原生形状包成 error 结果', async () => {
    const registry: NativeFrontendToolRegistry = {
      execute: vi.fn(async () => {
        throw new Error('Frontend tool "x:y" is unavailable');
      }),
      getManifest: vi.fn((toolId: string) => ({ id: toolId })),
    };
    const outcome = await runSelectedFrontendTools(
      [
        { toolCallId: 'call-1', name: LOAD_FRONTEND_TOOL_NAME, args: { toolId: 'x:y' }, execution: 'frontend' },
        { toolCallId: 'call-2', name: EXECUTE_FRONTEND_TOOL_NAME, args: { toolId: 'x:y', args: {} }, execution: 'frontend' },
      ],
      registry,
    );

    expect(outcome.toolCallResults[0]).toEqual({ id: 'call-1', result: { id: 'x:y' } });
    expect(outcome.toolCallResults[1]).toEqual({
      id: 'call-2',
      result: { status: 'error', content: 'Frontend tool "x:y" is unavailable' },
    });
    expect(outcome.executed).toBe(1);
    expect(outcome.failed).toBe(1);
  });

  it('非前端工具与已否决的调用只进 toolCallIds，不执行', async () => {
    const execute = vi.fn(async () => 'never');
    const outcome = await runSelectedFrontendTools(
      [
        { toolCallId: 'backend-1', name: 'someBackendTool', args: {}, execution: 'backend' },
        {
          toolCallId: 'rejected-1',
          name: EXECUTE_FRONTEND_TOOL_NAME,
          args: { toolId: 'x:y', args: {} },
          execution: 'frontend',
          userDecision: { type: 'reject', message: '不执行' },
        },
      ],
      { execute },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(outcome.toolCallIds).toEqual(['backend-1', 'rejected-1']);
    expect(outcome.toolCallResults).toEqual([]);
  });

  it('没有注册表时不执行、不伪造，但保留 toolCallIds 以便原生协议继续', async () => {
    const outcome = await runSelectedFrontendTools(
      [{ toolCallId: 'call-1', name: EXECUTE_FRONTEND_TOOL_NAME, args: { toolId: 'x:y', args: {} }, execution: 'frontend' }],
      null,
    );
    expect(outcome.toolCallResults).toEqual([]);
    expect(outcome.unresolved).toEqual(['call-1']);
    expect(outcome.toolCallIds).toEqual(['call-1']);
  });

  it('已经装配过共享运行上下文时直接复用，不重复构造', async () => {
    const registry: NativeFrontendToolRegistry = { execute: vi.fn() };
    (sdk as unknown as { app?: unknown }).app = { pm: { get: () => ({ aiManager: { frontendTools: registry } }) } };
    await expect(ensureSharedNativeRuntime()).resolves.toBe(true);
    expect(resolveNativeToolRegistry()).toBe(registry);
  });
});
