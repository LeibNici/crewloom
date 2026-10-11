import { useCallback, useState } from 'react';
import { CrewloomError, toUserMessage } from '../../api/errors';

/**
 * 轻量写操作状态机（组 C 独占，工作流与待办共用一个实现）。
 *
 * 公共地基没有提供 `useResourceMutation`（02-foundation §10 第 5 条明确"未做"），
 * 三组各自直接调用 `src/api/client.ts`。这里只统一四件真实共性：
 *  - 提交中禁用重复点击；
 *  - 成功 / 失败都有明确结果，失败只给中文用户文案；
 *  - 失败时保留原始 `CrewloomError` 供页面按需展示可执行的处理建议；
 *  - 成功后由调用方决定刷新范围（不在这里猜测该刷新哪个缓存）。
 */
export interface MutationState {
  isSubmitting: boolean;
  error: CrewloomError | null;
  message: string | null;
  /** 上一次提交是否成功（用于展示成功提示）。 */
  succeeded: boolean;
}

export interface UseMutationResult extends MutationState {
  run: <T>(task: () => Promise<T>) => Promise<T | null>;
  reset: () => void;
}

export function useMutation(): UseMutationResult {
  const [state, setState] = useState<MutationState>({
    isSubmitting: false,
    error: null,
    message: null,
    succeeded: false,
  });

  const run = useCallback(async <T,>(task: () => Promise<T>): Promise<T | null> => {
    setState({ isSubmitting: true, error: null, message: null, succeeded: false });
    try {
      const result = await task();
      setState({ isSubmitting: false, error: null, message: null, succeeded: true });
      return result;
    } catch (error) {
      const crewloom = error instanceof CrewloomError ? error : null;
      setState({
        isSubmitting: false,
        error: crewloom,
        message: toUserMessage(error),
        succeeded: false,
      });
      return null;
    }
  }, []);

  const reset = useCallback(() => {
    setState({ isSubmitting: false, error: null, message: null, succeeded: false });
  }, []);

  return { ...state, run, reset };
}
