import { CrewloomError, classifyFailure } from '../api/errors';
import { api } from '../api/client';

/**
 * 运行期权限探测。
 *
 * 为什么需要它：NocoBase 的 ACL 不是"仅凭角色名/片段就能完全推导"的模型。
 * 250 新实例实测（证据见 docs/acceptance/p1-native-capability-audit.md）显示：
 *  - 只配置 snippets（如内置 Admin 的 `pm` / `pm.*` / `ui.*`）的角色，可以对
 *    插件资源（dataSources / workflows / aiEmployees / llmServices …）通过；
 *  - 只配置 strategy.actions（如 `view`）的角色，对上述插件资源仍返回 403，
 *    仅对 users / roles / collections 等核心资源放行，并受 `allowAll` 影响。
 * 因此菜单与入口的可用性以**真实只读请求的返回**为准。
 *
 * 结果必须按三类分开（不能合并）：
 *  - `allowed`：后端明确允许；
 *  - `denied`：403 等明确拒绝 → 不显示入口，深链说明无权限；
 *  - `unknown`：401（认证/角色失效）、网络、超时、5xx → 保持未知，可重试，
 *    **不放行**，也不当作"无权限"。认证/角色失效由请求层的状态机另行处理。
 */

export interface ProbeDefinition {
  id: string;
  label: string;
  /** 真实资源动作，用于展示与核对映射。 */
  resource: string;
  action: string;
  /** 相对 API 基路径的地址（SDK 的 baseURL 会补上 /api）。 */
  path: string;
}

export const ACCESS_PROBES: ProbeDefinition[] = [
  { id: 'workbench.read', label: '进入工作台', resource: 'auth', action: 'check', path: '/auth:check' },
  { id: 'ai.use', label: '查看可使用员工', resource: 'aiEmployees', action: 'listByUser', path: '/aiEmployees:listByUser?pageSize=1' },
  { id: 'tasks.read', label: '查看待办', resource: 'userWorkflowTaskStats', action: 'listMine', path: '/userWorkflowTaskStats:listMine' },
  { id: 'workflow.read', label: '查看工作流', resource: 'workflows', action: 'list', path: '/workflows:list?pageSize=1' },
  { id: 'datasource.read', label: '查看数据源', resource: 'dataSources', action: 'list', path: '/dataSources:list' },
  { id: 'model.read', label: '查看模型配置', resource: 'llmServices', action: 'list', path: '/llmServices:list?pageSize=1' },
  { id: 'access.read', label: '查看用户与权限', resource: 'roles', action: 'list', path: '/roles:list?pageSize=1' },
  { id: 'access.users', label: '查看用户', resource: 'users', action: 'list', path: '/users:list?pageSize=1' },
  { id: 'ai.directory', label: '查看员工目录', resource: 'aiEmployees', action: 'list', path: '/aiEmployees:list?pageSize=1' },
  { id: 'ai.conversations', label: '查看会话', resource: 'aiConversations', action: 'list', path: '/aiConversations:list?pageSize=1' },
];

export type ProbeStatus = 'allowed' | 'denied' | 'unknown';

export interface ProbeResult {
  status: ProbeStatus;
  /** 技术原因，仅用于日志与验收，不直接展示给用户。 */
  reason?: string;
}

export type ProbeResults = Record<string, ProbeResult>;

export const PROBE_BY_ID: Record<string, ProbeDefinition> = Object.fromEntries(
  ACCESS_PROBES.map((probe) => [probe.id, probe]),
);

export function probeLabel(id: string): string {
  return PROBE_BY_ID[id]?.label ?? id;
}

/** 依次探测（顺序执行，避免瞬时并发打满后端），单个失败不影响其余。 */
export async function runAccessProbes(signal?: AbortSignal): Promise<ProbeResults> {
  const results: ProbeResults = {};
  for (const probe of ACCESS_PROBES) {
    results[probe.id] = await runProbe(probe, signal);
  }
  return results;
}

async function runProbe(probe: ProbeDefinition, signal?: AbortSignal): Promise<ProbeResult> {
  try {
    await api.request({ url: probe.path, method: 'get', signal });
    return { status: 'allowed' };
  } catch (error) {
    const failure = classifyFailure(error);
    const reason = error instanceof CrewloomError ? error.kind : 'unknown';
    if (failure === 'denied') return { status: 'denied', reason };
    // 认证/角色失效与网络/5xx 都保持未知：不放行，也不冒充"无权限"。
    return { status: 'unknown', reason };
  }
}

/** 是否存在"无法确认"的探测项（界面据此提供重试，而不是显示无权限）。 */
export function hasUnknownProbe(results: ProbeResults | null): boolean {
  if (!results) return true;
  return Object.values(results).some((item) => item.status === 'unknown');
}

/** 是否所有探测项都拿到了明确结论。 */
export function isProbeSetDefinitive(results: ProbeResults | null): boolean {
  if (!results) return false;
  return Object.values(results).every((item) => item.status !== 'unknown');
}
