/**
 * `scripts/lib/controlled-workflow-middleware.mjs` 的类型声明。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface ControlledWorkflowNode {
  id: string;
  key: string;
  title: string;
  type: string;
  config: Record<string, unknown>;
  upstreamId: string | null;
  downstreamId: string | null;
  branchIndex: number | null;
  workflowId: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ControlledWorkflowStore {
  versions: Record<string, unknown>;
  executions: Record<string, unknown>;
  journal: Array<Record<string, unknown>>;
  testScenario: string;
}

export declare function createControlledWorkflowMiddleware(options?: {
  store?: ControlledWorkflowStore;
}): (req: IncomingMessage, res: ServerResponse, next: () => void) => void | Promise<void>;

/**
 * 独立的本机合成后端（`scripts/main-browser-workflow-server.mjs`）复用同一套状态机：
 * 由它创建 store、传给中间件，并在中间件之外处理列表/分页/创建/复制/启停/执行详情等动作。
 */
export declare function createControlledWorkflowStore(): ControlledWorkflowStore;

export declare function makeNode(partial: Partial<ControlledWorkflowNode>): ControlledWorkflowNode;

export declare function readAppends(searchParams: URLSearchParams): string[];

export declare function versionPayload(
  version: Record<string, unknown>,
  searchParams: URLSearchParams,
): Record<string, unknown>;

export declare const CONTROLLED_WORKFLOW_IDS: {
  DRAFT_ID: string;
  EXECUTED_ID: string;
  OTHER_ID: string;
  DRAFT2_ID: string;
  WIDE_ID: string;
  CONTROLLED_KEY: string;
  CONTROLLED_KEY_ALT: string;
};
