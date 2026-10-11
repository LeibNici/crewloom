/**
 * `scripts/lib/controlled-ai-middleware.mjs` 的类型声明。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export declare function createControlledAiMiddleware(): (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) => void | Promise<void>;
