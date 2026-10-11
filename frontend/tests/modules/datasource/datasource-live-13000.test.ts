// @vitest-environment node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { APIClient } from '@nocobase/sdk';
import { describe, expect, it } from 'vitest';
import { PRODUCT_BACKEND_ORIGIN } from '../../../src/api/policy';
import { installTransportGuard, type TransportLogEntry } from '../../../src/api/transportGuard';

/**
 * 组 B · DS-01…DS-05 对 **13000（2.2.20）** 的真实**严格只读**核对。
 *
 * 只读范围：数据源与集合/字段元数据、业务集合抽样记录、角色资源授权与记录范围。
 * `dataSources:readTables` / `loadTables` / `testConnection` / `mainDataSource:*` 与任何记录写入
 * 都不在允许清单内 —— 自动验证一律拦截，不会对 13000 外呼或写数据。
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
  const target = resolve(
    process.cwd(),
    '../docs/acceptance/full-pages-13000/group-b-evidence/live-readonly-13000-datasource.json',
  );
  writeFileSync(target, `${JSON.stringify(sanitizeEvidence(evidence), null, 2)}\n`);
}

suite('DS 真实严格只读核对（13000 / 2.2.20）', () => {
  it('只读读取数据源/集合/字段/记录/授权，并证明没有外呼与写入', async () => {
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

    async function read(path: string, note: string, params?: Record<string, unknown>): Promise<unknown> {
      const response = await client.axios.get(path, { params });
      const body = response.data as { data?: unknown; meta?: { count?: number } };
      const data = body?.data;
      evidence.probes.push({
        path,
        status: response.status,
        count: body?.meta?.count ?? (Array.isArray(data) ? data.length : null),
        keys: data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data) : null,
        note,
      });
      expect(response.status).toBe(200);
      return data;
    }

    // --- DS-01 数据源 ---
    const dataSources = (await read('/dataSources:list', 'data-sources', { pageSize: 50 })) as Array<{
      key: string;
      type?: string;
      enabled?: boolean;
      status?: string;
    }>;
    expect(dataSources.length).toBeGreaterThan(0);
    expect(dataSources.some((item) => item.type === 'main')).toBe(true);

    const enabledDataSources = (await read('/dataSources:listEnabled', 'data-sources-enabled')) as unknown[];
    // 13000 实测为 0：主数据源是内建固定的，不在 listEnabled 里。
    evidence.probes[evidence.probes.length - 1].note = `data-sources-enabled(len=${enabledDataSources.length})`;

    await read('/dataSources:get', 'data-source-detail', { filterByTk: 'main' });

    // --- DS-03 集合与字段 ---
    const collections = (await read('/collections:list', 'collections', { pageSize: 300, sort: ['name'] })) as Array<{
      name: string;
    }>;
    expect(collections.length).toBeGreaterThan(0);
    const sample = collections.find((item) => item.name === 'customers') ?? collections[0];
    const collection = (await read('/collections:get', 'collection-detail', {
      filterByTk: sample.name,
      appends: ['fields'],
    })) as { fields?: unknown[] };
    expect(Array.isArray(collection.fields)).toBe(true);

    const fields = (await read(`/collections/${sample.name}/fields:list`, 'collection-fields', { pageSize: 300 })) as Array<{
      name?: string;
      type?: string;
      interface?: string | null;
    }>;
    expect(fields.length).toBeGreaterThan(0);
    const namedField = fields.find((field) => field.name === 'name') ?? fields[0];
    if (namedField?.name) {
      await read(`/collections/${sample.name}/fields:get`, 'collection-field-detail', { filterByTk: namedField.name });
    }

    // --- DS-04 业务集合抽样记录（只读） ---
    for (const collectionName of ['customers', 'items', 'suppliers', 'sales_orders', 'production_orders']) {
      const rows = (await read(`/${collectionName}:list`, `records:${collectionName}`, { pageSize: 3 })) as unknown[];
      expect(Array.isArray(rows)).toBe(true);
    }

    // --- DS-05 访问配置（角色侧资源授权） ---
    const roles = (await read('/roles:list', 'roles', { pageSize: 50 })) as Array<{ name: string }>;
    const sampleRole = roles.map((role) => role.name).find((name) => name.startsWith('r_')) ?? 'member';
    await read(`/roles/${sampleRole}/resources:list`, 'role-resources', { pageSize: 5 });
    await read('/dataSourcesRolesResourcesScopes:list', 'scopes', { pageSize: 5 });

    // 已核实的实现约束：mainDataSource:get 在当前实例返回 5xx（如实记录，不当作版本差异）。
    let mainStatus: number | null = null;
    try {
      const response = await client.axios.get('/mainDataSource:get');
      mainStatus = response.status;
    } catch (error) {
      mainStatus = (error as { response?: { status?: number } }).response?.status ?? null;
    }
    evidence.probes.push({ path: '/mainDataSource:get', status: mainStatus, note: 'known-500' });
    expect(mainStatus).toBe(500);

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

    expect(counts.blocked).toBe(0);
    expect(evidence.posts.sort()).toEqual(['auth:signIn', 'auth:signOut']);
    // 明确核对：没有任何外呼/写动作被尝试（readTables/loadTables/testConnection/syncFields 等）。
    const attempted = log.map((entry) => entry.action ?? '');
    for (const forbidden of [
      'dataSources:readTables',
      'dataSources:loadTables',
      'dataSources:testConnection',
      'mainDataSource:syncFields',
      'mainDataSource:refresh',
    ]) {
      expect(attempted).not.toContain(forbidden);
    }

    for (const probe of evidence.probes) {
      if (probe.status !== 200 && probe.note !== 'known-500') {
        evidence.problems.push(`${probe.path} -> ${probe.status}`);
      }
    }
    writeEvidence();
    expect(evidence.problems).toEqual([]);
  });
});

if (!enabled) {
  evidence.problems.push(secretPath ? 'backend-unreachable' : 'secret-file-not-found');
  writeEvidence();
}
