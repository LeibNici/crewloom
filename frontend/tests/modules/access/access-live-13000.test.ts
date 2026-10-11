// @vitest-environment node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { APIClient } from '@nocobase/sdk';
import { describe, expect, it } from 'vitest';
import { PRODUCT_BACKEND_ORIGIN } from '../../../src/api/policy';
import { installTransportGuard, type TransportLogEntry } from '../../../src/api/transportGuard';

/**
 * 组 B · AC-01…AC-06 对 **13000（2.2.20）** 的真实**严格只读**核对。
 *
 * 边界（与 02-foundation §3 一致）：
 *  - 传输层强制 `strict`：默认拒绝，只放行允许清单内的只读 GET 与**正常登录/退出**两个 POST；
 *  - 凭据只在进程内从主工作区的 `.secrets/full-pages-13000-20261011.json`（0600）读取，不打印、不写入证据；
 *  - 证据只记录路径、状态码、`meta.count` 与字段名，**不含任何真实业务记录值**；
 *  - 缺凭据或后端不可达时整体跳过（不伪装成通过）。
 *
 * 本文件与 discovery 脚本的区别：这里用**产品同源的传输策略**发请求，能证明"自动验证不会写 13000"。
 */

function findSecretPath(): string | null {
  let dir = process.cwd();
  for (let index = 0; index < 10; index += 1) {
    const candidate = resolve(dir, '.secrets/full-pages-13000-20261011.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

interface SecretFile {
  apiBaseURL: string;
  email: string;
  password: string;
}

const secretPath = findSecretPath();
let secrets: SecretFile | null = null;
try {
  secrets = secretPath ? (JSON.parse(readFileSync(secretPath, 'utf8')) as SecretFile) : null;
} catch {
  secrets = null;
}

const ORIGIN = (() => {
  if (!secrets) return PRODUCT_BACKEND_ORIGIN;
  const raw = String(secrets.apiBaseURL).replace(/\/+$/, '');
  return raw.endsWith('/api') ? raw.slice(0, -'/api'.length) : raw;
})();

async function reachable(): Promise<boolean> {
  try {
    const response = await fetch(`${ORIGIN}/api/authenticators:publicList`, { signal: AbortSignal.timeout(5000) });
    return response.ok;
  } catch {
    return false;
  }
}

const enabled = secrets !== null && (await reachable());
const suite = enabled ? describe : describe.skip;

interface ProbeRecord {
  path: string;
  status: number | null;
  count?: number | null;
  keys?: string[] | null;
  /** 列表响应首行的字段名（只记字段名，不含业务值）。 */
  rowKeys?: string[] | null;
  note?: string;
}

const evidence: {
  generatedAt: string;
  origin: string;
  signIn: number | null;
  probes: ProbeRecord[];
  signOut: number | null;
  afterSignOut: number | null;
  blocked: number;
  posts: string[];
  problems: string[];
  avatarField?: { name?: string; type?: string; interface?: string } | null;
} = {
  generatedAt: new Date().toISOString(),
  origin: ORIGIN,
  signIn: null,
  probes: [],
  signOut: null,
  afterSignOut: null,
  blocked: 0,
  posts: [],
  problems: [],
};


/** 证据脱敏：真实主键与业务角色标识不进仓库。 */
function sanitizeEvidence(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\b\d{10,}\b/g, '<id>').replace(/\br_[a-z_]+\b/g, '<role>');
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeEvidence(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, sanitizeEvidence(item)]));
  }
  return value;
}

function writeEvidence(): void {
  const target = resolve(process.cwd(), '../docs/acceptance/full-pages-13000/group-b-evidence/live-readonly-13000-access.json');
  writeFileSync(target, `${JSON.stringify(sanitizeEvidence(evidence), null, 2)}\n`);
}

suite('AC 真实严格只读核对（13000 / 2.2.20）', () => {
  it('只读读取用户/角色/成员/入口/数据/员工/部门，并证明没有写入', async () => {
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
    evidence.signIn = signIn.status;
    expect(signIn.status).toBe(200);
    const token = (signIn.data as { data?: { token?: string } })?.data?.token;
    expect(typeof token).toBe('string');
    client.auth.setToken(token as string);

    const authCheck = await client.request({ url: 'auth:check', method: 'get' });
    expect(authCheck.status).toBe(200);
    expect((authCheck.data as { data?: { id?: number } })?.data?.id).toBeTruthy();

    async function read(path: string, key: string, params?: Record<string, unknown>): Promise<unknown> {
      const response = await client.axios.get(path, { params });
      const body = response.data as { data?: unknown; meta?: { count?: number } };
      const data = body?.data;
      evidence.probes.push({
        path,
        status: response.status,
        count: body?.meta?.count ?? (Array.isArray(data) ? data.length : null),
        // 只记录字段名（不含任何业务记录值）；列表记录首行的字段名，便于核对 appends 是否生效。
        keys: data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data) : null,
        rowKeys:
          Array.isArray(data) && data.length > 0 && data[0] && typeof data[0] === 'object'
            ? Object.keys(data[0] as Record<string, unknown>)
            : null,
        note: key,
      });
      expect(response.status).toBe(200);
      return data;
    }

    // --- AC-01 用户 ---
    const users = (await read('/users:list', 'users', { pageSize: 3, appends: ['roles'] })) as unknown[];
    expect(Array.isArray(users)).toBe(true);
    expect(users.length).toBeGreaterThan(0);
    const user = (await read('/users:get', 'user-detail', { filterByTk: 1, appends: ['roles'] })) as {
      roles?: unknown[];
    };
    expect(Array.isArray(user.roles)).toBe(true);

    /*
     * AC-01 头像宿主新增的读法（本轮实现）：
     * `users.avatar` 是 belongsTo attachments 的文件字段，页面按 `appends[]=avatar` 读取。
     * 这里对真实 2.2.20 逐条核对"加上 avatar 之后 list/get 仍 200，且返回里确实有该字段"，
     * 而不是只靠"appends 是通用能力"推断。
     */
    const usersWithAvatar = (await read('/users:list', 'users-avatar-appends', {
      pageSize: 3,
      appends: ['roles', 'avatar'],
    })) as Array<Record<string, unknown>>;
    expect(Array.isArray(usersWithAvatar)).toBe(true);
    expect(usersWithAvatar.length).toBeGreaterThan(0);
    // 列表 appends 里 `roles` 一定回；`avatar` 是 belongsTo，**值为 null 时该键可能整个不返回**，
    // 因此这里只断言"列表读法被真实接受且 roles 仍生效"，avatar 的字段存在性由 users:get 侧核对。
    expect(Object.keys(usersWithAvatar[0] ?? {})).toContain('roles');
    const userWithAvatar = (await read('/users:get', 'user-detail-avatar', {
      filterByTk: 1,
      appends: ['roles', 'avatar'],
    })) as Record<string, unknown>;
    // 详情读法必须被真实接受；`avatar` 字段本身的存在性用集合字段元数据另行核对。
    expect(Array.isArray(userWithAvatar.roles)).toBe(true);
    const usersCollection = (await read('/collections:get', 'users-collection-fields', {
      filterByTk: 'users',
      appends: ['fields'],
    })) as { fields?: Array<{ name?: string; type?: string; interface?: string }> };
    const userFields = Array.isArray(usersCollection.fields) ? usersCollection.fields : [];
    const avatarField = userFields.find((field) => field.name === 'avatar') ?? null;
    evidence.avatarField = avatarField ? { name: avatarField.name, type: avatarField.type, interface: avatarField.interface } : null;
    /*
     * 不假定该实例一定有 `avatar` 字段（真实 2.2.20 的 users 集合实测**没有**）。
     * 断言的是**一致性**：字段存在则 appends 能读到它；字段不存在则读回里也不会凭空出现——
     * 这正是前端"按真实字段决定是否渲染头像宿主"的依据。
     */
    expect('avatar' in userWithAvatar).toBe(Boolean(avatarField));
    await read('/users:listExcludeRole', 'users-exclude-role', { roleName: 'member', pageSize: 2 });
    await read('/rolesUsers:list', 'roles-users', { pageSize: 2 });

    // --- AC-02 角色与成员 ---
    const roles = (await read('/roles:list', 'roles', { pageSize: 50 })) as Array<{ name: string }>;
    expect(roles.length).toBeGreaterThan(0);
    const roleNames = roles.map((role) => role.name);
    const sampleRole = roleNames.find((name) => name.startsWith('r_')) ?? 'member';
    const member = (await read('/roles:get', 'role-get', { filterByTk: 'member' })) as { snippets?: unknown };
    expect('snippets' in member).toBe(true);
    await read('/roles/member/users:list', 'role-members', { pageSize: 2 });

    // --- AC-03 功能与入口授权 ---
    const availableActions = (await read('/availableActions:list', 'available-actions')) as unknown[];
    expect(availableActions.length).toBeGreaterThan(0);
    await read('/desktopRoutes:list', 'desktop-routes', { pageSize: 3 });
    await read('/roles/member/desktopRoutes:list', 'role-desktop-routes', { pageSize: 200 });
    await read('/roles/member/menuUiSchemas:list', 'role-menu-ui-schemas', { pageSize: 3 });
    await read(`/roles/${sampleRole}/collections:list`, 'role-collections', { pageSize: 3, dataSourceKey: 'main' });

    // --- AC-04 数据授权 ---
    await read(`/roles/${sampleRole}/resources:list`, 'role-resources', { pageSize: 5 });
    await read('/dataSourcesRolesResourcesScopes:list', 'scopes', { pageSize: 5 });
    await read('/dataSourcesRolesResourcesActions:list', 'resource-actions', { pageSize: 2, appends: ['scope'] });

    // --- AC-05 员工与工具权限 ---
    await read('/roles/member/aiEmployees:list', 'role-employees', { pageSize: 3 });
    await read('/aiEmployees:list', 'employees', { pageSize: 3 });
    await read('/aiEmployees:listByUser', 'employees-by-user', { pageSize: 3 });
    const employee = (await read('/aiEmployees:list', 'employee-pick', { pageSize: 1 })) as Array<{ username?: string }>;
    if (employee[0]?.username) {
      await read('/aiEmployees:get', 'employee-detail', { filterByTk: employee[0].username });
    }

    // --- AC-06 部门与组织 ---
    const departments = (await read('/departments:list', 'departments', { pageSize: 200 })) as Array<{ id: number }>;
    expect(departments.length).toBeGreaterThan(0);
    await read('/organizations:list', 'organizations', { pageSize: 50 });

    // 部门成员/部门角色关联：插件停用 → 服务端错误（如实记录，不当作"空数据"）。
    for (const path of [
      `/departments/${departments[0].id}/members:list`,
      `/departments/${departments[0].id}/roles:list`,
      '/roles/member/departments:list',
    ]) {
      let status: number | null = null;
      try {
        const response = await client.axios.get(path, { params: { pageSize: 2 } });
        status = response.status;
      } catch (error) {
        status = (error as { response?: { status?: number } }).response?.status ?? null;
      }
      // 现契约（2026-10-11 实测）：用户批准的副作用修复后，这三个部门关联读接口已可正常应答，
      // 不再是"插件停用→500"。这里按**当前真实行为**断言：必须真的发出去（非传输层拦截），
      // 且返回可用的列表载荷；不再断言 500。
      evidence.probes.push({ path, status, note: 'departments-relation-read' });
      expect(status, `关联接口未被真实请求：${path}`).not.toBeNull();
      expect(status).toBe(200);
    }

    const signOut = await client.request({ url: 'auth:signOut', method: 'post', data: {} });
    evidence.signOut = signOut.status;
    expect(signOut.status).toBe(200);
    await expect(client.request({ url: 'auth:check', method: 'get' })).rejects.toMatchObject({
      response: { status: 401 },
    });
    evidence.afterSignOut = 401;

    const log: TransportLogEntry[] = guard.getLog();
    const counts = guard.counts();
    evidence.blocked = counts.blocked;
    evidence.posts = log.filter((entry) => entry.method === 'post').map((entry) => entry.action ?? entry.path);

    // 严格模式下没有任何请求被拦截（说明只用了允许清单内的只读动作），
    // 且没有产品写入被尝试。
    expect(counts.blocked).toBe(0);
    expect(evidence.posts.sort()).toEqual(['auth:signIn', 'auth:signOut']);
    expect(log.some((entry) => entry.mode === 'real')).toBe(true);

    for (const probe of evidence.probes) {
      if (probe.status !== 200 && probe.note !== 'departments-plugin-disabled') {
        evidence.problems.push(`${probe.path} -> ${probe.status}`);
      }
    }
    writeEvidence();
    expect(evidence.problems).toEqual([]);
  });
});

if (!enabled) {
  // 明确记录跳过原因，避免把"跳过"当成"通过"。
  evidence.problems.push(secretPath ? 'backend-unreachable' : 'secret-file-not-found');
  writeEvidence();
}
