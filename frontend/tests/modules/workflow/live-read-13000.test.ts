// @vitest-environment node
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { APIClient } from '@nocobase/sdk';
import { describe, expect, it } from 'vitest';
import { installTransportGuard } from '../../../src/api/transportGuard';
import { PRODUCT_BACKEND_ORIGIN } from '../../../src/api/policy';

/**
 * 组 C（WF + TD）对 13000 的**真实只读联调**。
 *
 * 目的：证明组 C 的 10 个页面所依赖的读路径在真实 2.2.20 上确实可用，
 * 并留下可用于报告脱敏汇总的证据。
 *
 * 严格边界（与用户约定一致）：
 *  - 只读 GET，且只允许登录/退出两个正常 POST；
 *  - `strict` 传输模式默认拒绝：组 C 的写动作（flow_nodes:*、workflows:*、
 *    workflowManualTasks:submit、workflowCcTasks:read、aiWorkflowTasks:accept/reject、
 *    aiConversations:*）一律在发出前拦截，本文件不尝试任何写入；
 *  - 凭据只在进程内从主工作区 `.secrets/full-pages-13000-20261011.json`（0600）读取，
 *    不打印、不写入 argv/环境变量/证据文件；
 *  - 证据只写端点名、HTTP 状态、行数与 meta.count，**不写业务标题或响应正文**
 *    （真实业务数据不提交）。
 *
 * 后端不可达或缺凭据时整体跳过（与既有 live 套件一致）。
 */

// 凭据只存在于主工作区（本工作树没有 .secrets）；用绝对路径只读，不复制。
const SECRET_PATH = '/Users/chenming/IdeaProjects/crewloom/.secrets/full-pages-13000-20261011.json';
const EVIDENCE_PATH = resolve(process.cwd(), '../docs/acceptance/full-pages-13000/group-c-evidence/live-read-13000.json');

interface SecretFile {
  apiBaseURL: string;
  email: string;
  password: string;
}

let secrets: SecretFile | null = null;
try {
  secrets = JSON.parse(readFileSync(SECRET_PATH, 'utf8')) as SecretFile;
} catch {
  secrets = null;
}

const ORIGIN = (() => {
  if (!secrets) return PRODUCT_BACKEND_ORIGIN;
  const raw = String(secrets.apiBaseURL).replace(/\/+$/, '');
  return raw.endsWith('/api') ? raw.slice(0, -'/api'.length) : raw;
})();

interface ProbeResult {
  endpoint: string;
  resource: string;
  action: string;
  status: number | 'error' | 'blocked';
  rows?: number;
  count?: number | null;
  note?: string;
}

async function reachable(): Promise<boolean> {
  try {
    const response = await fetch(`${ORIGIN}/api/authenticators:publicList`, {
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const enabled = secrets !== null && (await reachable());
const suite = enabled ? describe : describe.skip;

suite('组 C 对 13000 的真实只读核对（strict）', () => {
  it('登录后只读核对 WF/TD 依赖的端点，并写出脱敏证据', async () => {
    const client = new APIClient({ baseURL: `${ORIGIN}/api` });
    const guard = installTransportGuard(client.axios, {
      baseURL: `${ORIGIN}/api`,
      originBase: '',
      allowedOrigins: [ORIGIN],
      mode: 'strict',
    });

    const signIn = await client.request({
      url: 'auth:signIn',
      method: 'post',
      data: { email: secrets!.email, password: secrets!.password },
    });
    expect(signIn.status).toBe(200);
    const token = (signIn.data as { data?: { token?: string } })?.data?.token;
    expect(typeof token).toBe('string');
    client.auth.setToken(token as string);

    const probes: ProbeResult[] = [];
    const record = async (
      resource: string,
      action: string,
      params: Record<string, unknown>,
      note?: string,
    ) => {
      const endpoint = `${resource}:${action}`;
      const before = guard.counts().blocked;
      try {
        // 组 C 的读动作里 `listMine` / `unreadCount` 不在 SDK 的「get|list」GET 白名单内，
        // 因此必须显式指定 GET（产品侧由 `src/api/url.ts` 的 isReadAction 统一处理）。
        const response = await client.resource(resource)[action](params, { method: 'get' } as never);
        const body = response.data as { data?: unknown; meta?: { count?: number } };
        const rows = Array.isArray(body?.data) ? body.data.length : undefined;
        probes.push({
          endpoint,
          resource,
          action,
          status: response.status,
          rows,
          count: typeof body?.meta?.count === 'number' ? body.meta.count : null,
          note,
        });
        return body;
      } catch (error) {
        const blockedNow = guard.counts().blocked > before;
        const status =
          typeof (error as { response?: { status?: number } })?.response?.status === 'number'
            ? (error as { response: { status: number } }).response.status
            : 'error';
        probes.push({ endpoint, resource, action, status: blockedNow ? 'blocked' : status, note });
        return null;
      }
    };

    const workflows = (await record('workflows', 'list', {
      pageSize: 3,
      sort: ['-id'],
      appends: ['versionStats', 'categories'],
    })) as { data?: Array<Record<string, unknown>> } | null;
    await record('workflowCategories', 'list', { pageSize: 1 });
    await record('executions', 'list', { pageSize: 3, sort: ['-id'], appends: ['workflow'] });
    await record('jobs', 'list', { pageSize: 1, sort: ['-id'] });
    await record('workflowManualTasks', 'listMine', { pageSize: 3 });
    await record('workflowCcTasks', 'listMine', { pageSize: 3 });
    await record('aiWorkflowTasks', 'list', { pageSize: 3 });
    await record('aiWorkflowTasks', 'unreadCount', {});
    await record('userWorkflowTasks', 'listMine', { pageSize: 10 });
    await record('userWorkflowTaskStats', 'listMine', { page: 1, pageSize: 10 });
    await record('availableActions', 'list', {}, 'TD-05 审批能力探测');

    // 用真实流程 id 复核 2.2.20 的可用读法：flow_nodes:list + filter={"workflowId":N}。
    const firstWorkflowId = workflows?.data?.[0]?.id;
    let nodesEndpointNote: string | undefined;
    if (firstWorkflowId !== undefined && firstWorkflowId !== null) {
      const nodes = (await record(
        'flow_nodes',
        'list',
        { filter: { workflowId: firstWorkflowId }, pageSize: 5 },
        '2.2.20 实测可用读法',
      )) as { data?: Array<Record<string, unknown>> } | null;
      const firstNodeId = nodes?.data?.[0]?.id;
      if (firstNodeId !== undefined && firstNodeId !== null) {
        await record('flow_nodes', 'get', { filterByTk: firstNodeId });
      }
      // 对照：workflows/<id>/flow_nodes:list 在 2.2.20 返回 500，这里只记录状态，不作为读路径。
      const associationEndpoint = `workflows/${String(firstWorkflowId)}/flow_nodes:list`;
      const before = guard.counts().blocked;
      try {
        const response = await client.resource('workflows.flow_nodes', firstWorkflowId)['list']({ pageSize: 1 });
        probes.push({
          endpoint: associationEndpoint,
          resource: 'workflows.flow_nodes',
          action: 'list',
          status: response.status,
          note: '对照：实测 500，不作为实现读路径',
        });
      } catch (error) {
        const status =
          typeof (error as { response?: { status?: number } })?.response?.status === 'number'
            ? (error as { response: { status: number } }).response.status
            : 'error';
        probes.push({
          endpoint: associationEndpoint,
          resource: 'workflows.flow_nodes',
          action: 'list',
          status: guard.counts().blocked > before ? 'blocked' : status,
          note: '对照：实测 500，不作为实现读路径',
        });
      }
      nodesEndpointNote = 'flow_nodes:list?filter={"workflowId":N}';
    }

    const signOut = await client.request({ url: 'auth:signOut', method: 'post', data: {} });
    expect(signOut.status).toBe(200);

    // 只看**本次核对自身**被拦截的请求：guard 日志是同进程共享的，
    // 其它套件留下的历史条目不能算到本次只读核对头上。
    const blockedByThisRun = probes.filter((probe) => probe.status === 'blocked');
    const blocked = blockedByThisRun.length;
    // 严格模式下本次不允许有任何请求被拦截（组 C 只发只读 GET 与登录/退出）。
    expect(blocked, `被拦截的请求：${blockedByThisRun.map((item) => item.endpoint).join(', ')}`).toBe(0);

    const successful = probes.filter((probe) => probe.status === 200);
    const failed = probes.filter((probe) => probe.status !== 200);
    expect(successful.length).toBeGreaterThan(0);

    const evidence = {
      generatedAt: new Date().toISOString(),
      target: ORIGIN,
      mode: 'strict',
      transportBlocked: blocked,
      blockedEndpoints: blockedByThisRun.map((probe) => probe.endpoint),
      nodesReadPath: nodesEndpointNote ?? null,
      summary: {
        total: probes.length,
        ok: successful.length,
        failed: failed.length,
      },
      probes,
      note:
        '仅记录端点、HTTP 状态、行数与 meta.count；不含业务标题、凭据、令牌或响应正文。' +
        '未执行任何写入动作（严格模式拦截计数为 0 表示本次没有尝试写入）。',
    };
    mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
    writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

    // 组 C 依赖的关键端点必须真实可用。
    const mustPass = [
      'workflows:list',
      'executions:list',
      'flow_nodes:list',
      'workflowManualTasks:listMine',
      'workflowCcTasks:listMine',
      'aiWorkflowTasks:list',
      'aiWorkflowTasks:unreadCount',
      'userWorkflowTaskStats:listMine',
    ];
    for (const endpoint of mustPass) {
      const probe = probes.find((item) => item.endpoint === endpoint);
      expect(probe?.status, endpoint).toBe(200);
    }
  });
});
