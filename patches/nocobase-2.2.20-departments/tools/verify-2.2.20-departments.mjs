#!/usr/bin/env node
/**
 * NocoBase **2.2.20** 部门成员 / 部门角色 / effectiveRole 候选：生成补丁 + 隔离受控核对。
 *
 * 与真实实例的关系：**只读**本目录 `.cache/` 里的 npm 发布包，只写本目录；不连后端、不装插件、
 * 不改数据库、不 SSH、不调用模型。
 *
 * 被测的是 **2.2.20 的真实发布产物**：
 *  - `@nocobase/plugin-departments@2.2.20`
 *      · `dist/server/middlewares/set-departments-roles.js`（写 `ctx.state.attachRoles` + `departments:<uid>` 缓存）
 *      · `dist/server/middlewares/reset-user-departments-cache.js`（成员/用户部门变更后的缓存失效）
 *      · `dist/server/collections/*.js`（departments / departmentsUsers / departmentsRoles / roles / users 定义）
 *  - `@nocobase/plugin-acl@2.2.20`
 *      · `dist/server/middlewares/setCurrentRole.js`（把 `attachRoles` 合并进有效角色 + 角色切换 + 全局角色模式）
 *
 * 框架替身边界（明确区分，见输出 `frameworkStubs`）：
 *  - `@nocobase/database` 的 `defineCollection` / `extendCollection` 只回传定义本身（只为读字段清单）；
 *  - `@nocobase/utils` 只提供 `getAuthCookieName` / `getAuthCookieOptions`（cookie 名与选项，与被测合并逻辑无关）；
 *  - 假 `db` 仓库 / 假 `ctx` / 无 TTL 内存 cache 是**注入端口**；被测函数本身是真实发布产物。
 *
 * 用法：`node patches/nocobase-2.2.20-departments/tools/verify-2.2.20-departments.mjs`
 * 退出码 0 = 哈希一致 + 锚点各命中一次 + 受控运行全部通过。
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const patchRoot = resolve(here, '..');
const workDir = resolve(patchRoot, '.work');
const evidencePath = resolve(
  patchRoot,
  '../../docs/acceptance/full-pages-13000/department-candidate-evidence/live-13000-departments.json',
);
const depsRootCandidates = [
  process.env.NB_DEPS_ROOT,
  resolve(patchRoot, '../../frontend'),
  resolve(patchRoot, '../../../../frontend'),
].filter(Boolean);
const frontendRoot =
  depsRootCandidates.find((root) => existsSync(join(root, 'node_modules/.pnpm'))) ?? depsRootCandidates[0];

const TARBALLS = {
  departments: {
    path: process.env.NB_DEPARTMENTS_2_2_20_TARBALL ?? resolve(patchRoot, '.cache/plugin-departments-2.2.20.tgz'),
    url: 'https://registry.npmjs.org/@nocobase/plugin-departments/-/plugin-departments-2.2.20.tgz',
    sha256: 'd5a0f287f8586601c71c15651f7034f30899d579204f1b268ab3932c240bf31a',
  },
  acl: {
    path: process.env.NB_ACL_2_2_20_TARBALL ?? resolve(patchRoot, '.cache/plugin-acl-2.2.20.tgz'),
    url: 'https://registry.npmjs.org/@nocobase/plugin-acl/-/plugin-acl-2.2.20.tgz',
    sha256: '1ae86e0e0ad18e4f855aaf74d35030b961e8654039d959c1f98e1cf98a0b6622',
  },
  cache: {
    path: resolve(patchRoot, '.cache/cache-2.2.20.tgz'),
    url: 'https://registry.npmjs.org/@nocobase/cache/-/cache-2.2.20.tgz',
    sha256: '830cd389a30b19104eba425d4cf98237faf6ab9da62ec43b875724d651f955fd',
  },
  database: {
    path: resolve(patchRoot, '.cache/database-2.2.20.tgz'),
    url: 'https://registry.npmjs.org/@nocobase/database/-/database-2.2.20.tgz',
    sha256: '123f0c54e6c3f2c887827785ed46ebc59399b9fe1c40dc4dda0b7a0d773f95a2',
  },
  server: {
    path: resolve(patchRoot, '.cache/server-2.2.20.tgz'),
    url: 'https://registry.npmjs.org/@nocobase/server/-/server-2.2.20.tgz',
    sha256: '862c46856facffe01d41da32c5b2fca47ce847f4356b3b704554ba5ee772d19b',
  },
  dataSourceMain: {
    path: resolve(patchRoot, '.cache/ds-main-2.2.20.tgz'),
    url: 'https://registry.npmjs.org/@nocobase/plugin-data-source-main/-/plugin-data-source-main-2.2.20.tgz',
    sha256: '6985d75cbf10f0c7d2a1f6b19e13fdf4558488b07225728c6f0fe9ae126dd774',
  },
};

/** 只有这个文件被打补丁（manifest 只列它，避免"未改动文件"混淆 apply/rollback 判定）。 */
const PATCHED_FILES = {
  cacheMiddleware: 'package/dist/server/middlewares/reset-user-departments-cache.js',
};
/** 只做来源证据、不参与补丁哈希比对的观测文件。 */
const OBSERVED_FILES = {
  setRolesMiddleware: 'package/dist/server/middlewares/set-departments-roles.js',
  plugin: 'package/dist/server/plugin.js',
  departmentsCollection: 'package/dist/server/collections/departments.js',
  departmentsUsersCollection: 'package/dist/server/collections/departmentsUsers.js',
  departmentRolesCollection: 'package/dist/server/collections/departmentRoles.js',
  usersCollection: 'package/dist/server/collections/users.js',
  rolesCollection: 'package/dist/server/collections/roles.js',
};

/**
 * 补丁锚点：**恰好命中一次**。修的是具体故障 ——
 * 原生只在"成员/用户部门"变更时失效 `departments:<uid>`，**部门角色变更不失效**；
 * 而该缓存里 append 了 `roles`，`attachRoles`（有效角色的来源）因此会长期陈旧
 * （默认 memory store 无 TTL）。补丁让"部门↔角色"两个方向的 add/remove/set 也失效相关成员的缓存。
 */
const ANCHORS = [
  {
    id: 'D-roles-cache-invalidation',
    file: PATCHED_FILES.cacheMiddleware,
    find: `const resetUserDepartmentsCache = async (ctx, next) => {
  await next();
  const { associatedName, resourceName, associatedIndex, actionName, values } = ctx.action.params;
  const cache = ctx.app.cache;
  if (associatedName === "departments" && resourceName === "members" && ["add", "remove", "set"].includes(actionName) && (values == null ? void 0 : values.length)) {
    for (const memberId of values) {
      await cache.del(\`departments:\${memberId}\`);
    }
  }
  if (associatedName === "users" && resourceName === "departments" && ["add", "remove", "set"].includes(actionName)) {
    await cache.del(\`departments:\${associatedIndex}\`);
  }
};`,
    replace: `const resetUserDepartmentsCache = async (ctx, next) => {
  const { associatedName, resourceName, associatedIndex, actionName, values } = ctx.action.params;
  const cache = ctx.app.cache;
  const isRoleDepartmentChange = ["add", "remove", "set"].includes(actionName) && (associatedName === "departments" && resourceName === "roles" || associatedName === "roles" && resourceName === "departments");
  let previousRoleDepartmentIds = [];
  if (isRoleDepartmentChange && associatedName === "roles" && actionName === "set") {
    const previousRows = await ctx.db.getRepository("departmentsRoles").find({
      fields: ["departmentId"],
      filter: {
        roleName: associatedIndex
      }
    });
    previousRoleDepartmentIds = previousRows.map((row) => row.get ? row.get("departmentId") : row.departmentId);
  }
  await next();
  if (associatedName === "departments" && resourceName === "members" && ["add", "remove", "set"].includes(actionName) && (values == null ? void 0 : values.length)) {
    for (const memberId of values) {
      await cache.del(\`departments:\${memberId}\`);
    }
  }
  if (associatedName === "users" && resourceName === "departments" && ["add", "remove", "set"].includes(actionName)) {
    await cache.del(\`departments:\${associatedIndex}\`);
  }
  if (isRoleDepartmentChange) {
    const normalizeId = (value) => value && typeof value === "object" ? value.id ?? value.departmentId ?? value : value;
    const departmentIds = associatedName === "departments" ? [associatedIndex] : [...previousRoleDepartmentIds, ...(values || []).map(normalizeId)];
    const uniqueIds = [...new Set(departmentIds.filter((id) => id !== null && id !== void 0))];
    for (const departmentId of uniqueIds) {
      const members = await ctx.db.getRepository("departmentsUsers").find({
        fields: ["userId"],
        filter: {
          departmentId
        }
      });
      for (const member of members) {
        const userId = member.get ? member.get("userId") : member.userId;
        if (userId !== null && userId !== void 0) {
          await cache.del(\`departments:\${userId}\`);
        }
      }
    }
  }
};`,
  },
];

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', ...options });
}

function resolvePnpmPackage(name) {
  const base = join(frontendRoot, 'node_modules/.pnpm');
  const hoisted = join(base, 'node_modules', name);
  if (existsSync(hoisted)) return hoisted;
  const flat = name.replace('/', '+');
  if (existsSync(base)) {
    for (const entry of readdirSync(base)) {
      if (!entry.startsWith(`${flat}@`)) continue;
      const candidate = join(base, entry, 'node_modules', name);
      if (existsSync(candidate)) return candidate;
    }
  }
  const direct = join(frontendRoot, 'node_modules', name);
  return existsSync(direct) ? direct : null;
}

function extractTarball(tarball, dest) {
  mkdirSync(dest, { recursive: true });
  run('tar', ['-xzf', tarball.path, '-C', dest]);
}

function applyAnchors(patchedRoot) {
  const results = [];
  for (const anchor of ANCHORS) {
    const file = join(patchedRoot, anchor.file);
    const text = readFileSync(file, 'utf8');
    const hits = text.split(anchor.find).length - 1;
    if (hits !== 1) {
      results.push({ id: anchor.id, hits, applied: false });
      continue;
    }
    writeFileSync(file, text.replace(anchor.find, anchor.replace));
    results.push({ id: anchor.id, hits, applied: true });
  }
  return results;
}

function diffFor(rel, pristineRoot, patchedRoot) {
  const inner = rel.replace(/^package\//, '');
  try {
    return run('diff', ['-u', '--label', `a/${inner}`, '--label', `b/${inner}`, join(pristineRoot, rel), join(patchedRoot, rel)]);
  } catch (error) {
    if (error.status === 1) return error.stdout;
    throw error;
  }
}

/** 框架替身 + 依赖软链；被测的两份 package 都放在 stub root 内，保证 require 解析一致。 */
function prepareStubs(pristinePackage, patchedPackage, aclPackage) {
  const stubRoot = join(workDir, 'stubs');
  const modules = join(stubRoot, 'node_modules');
  mkdirSync(join(modules, '@nocobase/database'), { recursive: true });
  mkdirSync(join(modules, '@nocobase/utils'), { recursive: true });
  writeFileSync(
    join(modules, '@nocobase/database', 'package.json'),
    `${JSON.stringify({ name: '@nocobase/database', version: '2.2.20-fake', main: 'index.js' }, null, 2)}\n`,
  );
  writeFileSync(
    join(modules, '@nocobase/database', 'index.js'),
    'module.exports = { defineCollection: (options) => options, extendCollection: (options) => options };\n',
  );
  writeFileSync(
    join(modules, '@nocobase/utils', 'package.json'),
    `${JSON.stringify({ name: '@nocobase/utils', version: '2.2.20-fake', main: 'index.js' }, null, 2)}\n`,
  );
  writeFileSync(
    join(modules, '@nocobase/utils', 'index.js'),
    '// cookie 名与选项，与被测的角色合并逻辑无关。\nmodule.exports = { getAuthCookieName: (type, appName) => `${appName || "app"}-${type}`, getAuthCookieOptions: () => ({}) };\n',
  );
  const deps = {};
  for (const name of ['lodash']) {
    const target = resolvePnpmPackage(name);
    if (!target) continue;
    symlinkSync(target, join(modules, name));
    try {
      deps[name] = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).version ?? null;
    } catch {
      deps[name] = null;
    }
  }
  const departmentsRoot = join(stubRoot, 'departments');
  cpSync(pristinePackage, departmentsRoot, { recursive: true });
  const patchedRoot = join(stubRoot, 'departments-patched');
  cpSync(patchedPackage, patchedRoot, { recursive: true });
  const aclRoot = join(stubRoot, 'acl');
  cpSync(aclPackage, aclRoot, { recursive: true });
  return { ok: true, stubRoot, departmentsRoot, patchedRoot, aclRoot, deps, requireFromStub: createRequire(join(stubRoot, 'entry.cjs')) };
}

// ---------------------------------------------------------------------------
// 受控运行：真实中间件 + 注入端口
// ---------------------------------------------------------------------------

function wrapModel(row) {
  return row && typeof row === 'object' ? { ...row, get: (key) => row[key] } : row;
}

/** 受控 cache：默认 memory store 无 TTL（与 `@nocobase/cache@2.2.20` cache-manager 默认一致）。 */
function makeCache() {
  const store = new Map();
  const stats = { gets: 0, sets: 0, hits: 0, dels: 0, wraps: 0 };
  return {
    store,
    stats,
    async get(key) {
      stats.gets += 1;
      if (store.has(key)) {
        stats.hits += 1;
        return store.get(key);
      }
      return undefined;
    },
    async set(key, value) {
      stats.sets += 1;
      store.set(key, value);
    },
    async del(key) {
      stats.dels += 1;
      store.delete(key);
    },
    async wrap(key, fn) {
      stats.wraps += 1;
      if (store.has(key)) {
        stats.hits += 1;
        return store.get(key);
      }
      const value = await fn();
      store.set(key, value);
      return value;
    },
    async wrapWithCondition(key, fn, options) {
      if (options?.useCache === false) return fn();
      const existing = await this.get(key);
      if (existing) return existing;
      const value = await fn();
      const cacheable = options?.isCacheable ? await options.isCacheable(value) : value;
      if (!cacheable) return value;
      await this.set(key, value);
      return value;
    },
    keys() {
      return [...store.keys()].sort();
    },
  };
}

class World {
  constructor({ roleMode = 'default' } = {}) {
    this.departments = [];
    this.users = [];
    this.departmentsUsers = [];
    this.departmentsRoles = [];
    this.roles = [];
    this.rolesUsers = [];
    this.systemSettings = { roleMode };
    this.counts = { userDepartmentsFind: 0, rolesFind: 0, usersRolesFind: 0, rolesUsersFindOne: 0, settingsFind: 0, departmentsUsersFind: 0, departmentsRolesFind: 0 };
  }

  addDepartment(id, name, parentId = null) {
    this.departments.push({ id, name, parentId });
    return this;
  }

  addUser(id, { mainDepartmentId = null } = {}) {
    this.users.push({ id, mainDepartmentId });
    return this;
  }

  addMember(userId, departmentId, isOwner = false) {
    this.departmentsUsers.push({ userId, departmentId, isOwner });
    return this;
  }

  removeMember(userId, departmentId) {
    this.departmentsUsers = this.departmentsUsers.filter((row) => !(row.userId === userId && row.departmentId === departmentId));
    return this;
  }

  addRole(name) {
    if (!this.roles.some((role) => role.name === name)) this.roles.push({ name, title: name });
    return this;
  }

  addUserRole(userId, roleName, isDefault = false) {
    this.rolesUsers.push({ userId, roleName, default: isDefault });
    return this;
  }

  addDepartmentRole(departmentId, roleName) {
    if (!this.departmentsRoles.some((row) => row.departmentId === departmentId && row.roleName === roleName)) {
      this.departmentsRoles.push({ departmentId, roleName });
    }
    return this;
  }

  removeDepartmentRole(departmentId, roleName) {
    this.departmentsRoles = this.departmentsRoles.filter((row) => !(row.departmentId === departmentId && row.roleName === roleName));
    return this;
  }

  db() {
    const world = this;
    return {
      // 事务端口：真实 `setDepartmentOwners` 用 `ctx.db.sequelize.transaction`。
      sequelize: {
        transaction: async (fn) => fn(null),
      },
      getRepository(name, index) {
        if (name === 'departments') {
          return {
            find: async ({ filter } = {}) =>
              world.departments
                .filter((row) => (filter?.parentId === undefined ? true : row.parentId === filter.parentId))
                .map(wrapModel),
            findOne: async ({ filterByTk, filter } = {}) =>
              wrapModel(world.departments.find((row) => row.id === (filterByTk ?? filter?.id)) ?? null),
            count: async ({ filter } = {}) =>
              world.departments.filter((row) => (filter?.parentId === undefined ? true : row.parentId === filter.parentId)).length,
          };
        }
        if (name === 'users.departments') {
          const userId = index;
          return {
            find: async () => {
              world.counts.userDepartmentsFind += 1;
              const departmentIds = world.departmentsUsers.filter((row) => row.userId === userId).map((row) => row.departmentId);
              return world.departments
                .filter((department) => departmentIds.includes(department.id))
                .map((department) => ({
                  ...department,
                  roles: world.departmentsRoles
                    .filter((row) => row.departmentId === department.id)
                    .map((row) => world.roles.find((role) => role.name === row.roleName))
                    .filter(Boolean)
                    .map(wrapModel),
                }));
            },
          };
        }
        if (name === 'users.roles') {
          const userId = index;
          return {
            find: async () => {
              world.counts.usersRolesFind += 1;
              const roleNames = world.rolesUsers.filter((row) => row.userId === userId).map((row) => row.roleName);
              return world.roles.filter((role) => roleNames.includes(role.name)).map(wrapModel);
            },
          };
        }
        if (name === 'roles') {
          return {
            find: async ({ filter } = {}) => {
              world.counts.rolesFind += 1;
              const departmentIds = filter?.['departments.id']?.$in ?? [];
              const roleNames = new Set(
                world.departmentsRoles.filter((row) => departmentIds.includes(row.departmentId)).map((row) => row.roleName),
              );
              return world.roles.filter((role) => roleNames.has(role.name)).map(wrapModel);
            },
          };
        }
        if (name === 'departmentsUsers') {
          return {
            find: async ({ filter } = {}) => {
              world.counts.departmentsUsersFind += 1;
              return world.departmentsUsers
                .filter((row) => (filter?.departmentId === undefined || row.departmentId === filter.departmentId) && (filter?.userId === undefined || row.userId === filter.userId))
                .map(wrapModel);
            },
            count: async ({ filter } = {}) =>
              world.departmentsUsers.filter(
                (row) => (filter?.departmentId === undefined || row.departmentId === filter.departmentId) && (filter?.userId === undefined || row.userId === filter.userId),
              ).length,
            // 端口：实现 filter/update 语义（不是业务规则；业务规则在被测的真实中间件里）。
            update: async ({ filter, values } = {}) => {
              for (const row of world.departmentsUsers) {
                if (filter?.departmentId !== undefined && row.departmentId !== filter.departmentId) continue;
                if (filter?.userId?.$in !== undefined && !filter.userId.$in.includes(row.userId)) continue;
                if (filter?.userId !== undefined && filter.userId?.$in === undefined && row.userId !== filter.userId) continue;
                Object.assign(row, values);
              }
              return [world.departmentsUsers.length];
            },
          };
        }
        if (name === 'departmentsRoles') {
          return {
            find: async ({ filter } = {}) => {
              world.counts.departmentsRolesFind += 1;
              return world.departmentsRoles
                .filter((row) => filter?.roleName === undefined || row.roleName === filter.roleName)
                .map(wrapModel);
            },
          };
        }
        if (name === 'rolesUsers') {
          return {
            findOne: async ({ where } = {}) => {
              world.counts.rolesUsersFindOne += 1;
              const row = world.rolesUsers.find(
                (item) => item.userId === where?.userId && (where?.default === undefined || item.default === where.default),
              );
              return row ? wrapModel(row) : null;
            },
          };
        }
        if (name === 'systemSettings') {
          return {
            findOne: async () => {
              world.counts.settingsFind += 1;
              return world.systemSettings;
            },
          };
        }
        if (name === 'users') {
          return { findOne: async ({ filter } = {}) => wrapModel(world.users.find((user) => user.id === filter?.id) ?? null) };
        }
        return { find: async () => [], findOne: async () => null, count: async () => 0 };
      },
    };
  }
}

function makeCtx({ world, cache, userId, headerRole, cookieRole }) {
  const db = world.db();
  const user = world.users.find((item) => item.id === userId);
  return {
    app: { name: 'crewloom', db, cache },
    db,
    cache,
    state: { currentUser: user ? wrapModel(user) : null },
    headers: {},
    get(name) {
      return String(name).toLowerCase() === 'x-role' ? headerRole ?? undefined : undefined;
    },
    cookies: { get: () => cookieRole ?? undefined, set: () => {} },
    t(key) {
      return typeof key === 'string' ? key : JSON.stringify(key);
    },
    throw(status, payload) {
      const error = new Error(typeof payload === 'string' ? payload : payload?.message ?? 'http-error');
      error.status = status;
      error.payload = payload;
      throw error;
    },
    action: { params: {} },
  };
}

/** 按插件真实注册顺序（auth → setDepartmentsInfo → setCurrentRole）跑一次请求。 */
async function runRequest({ middleware, world, cache, userId, headerRole, cookieRole }) {
  const ctx = makeCtx({ world, cache, userId, headerRole, cookieRole });
  await middleware.setDepartmentsInfo(ctx, async () => {
    await middleware.setCurrentRole(ctx, async () => {});
  });
  return {
    currentRole: ctx.state.currentRole ?? null,
    currentRoles: ctx.state.currentRoles ?? null,
    attachRoles: (ctx.state.attachRoles ?? []).map((role) => role.name),
    departments: (ctx.state.currentUser?.departments ?? []).map((department) => department.id),
    departmentRolePayload: Object.fromEntries(
      (ctx.state.currentUser?.departments ?? []).map((department) => [
        department.id,
        (department.roles ?? []).map((role) => role.name).sort(),
      ]),
    ),
    effectiveRoles: (ctx.state.currentUser?.roles ?? []).map((role) => role.name),
    mainDepartmentResolved: Boolean(ctx.state.currentUser?.mainDeparmtent),
  };
}

/** 跑一次变更动作：真实 `resetUserDepartmentsCache` 包裹"原生资源层写库"。 */
async function runMutation({ middleware, world, cache, params, apply }) {
  const db = world.db();
  const ctx = { app: { db, cache }, db, cache, action: { params } };
  await middleware.resetUserDepartmentsCache(ctx, async () => {
    apply(world);
  });
}

function buildBaseWorld() {
  const world = new World();
  world.addDepartment(1, 'D1').addDepartment(2, 'D2');
  world.addUser(101, { mainDepartmentId: 1 }).addUser(102);
  world.addRole('member').addRole('deptA').addRole('deptB');
  world.addUserRole(101, 'member');
  world.addUserRole(102, 'member');
  world.addMember(101, 1);
  world.addDepartmentRole(1, 'deptA');
  world.addDepartmentRole(2, 'deptB');
  return world;
}

async function runtimeCheck(stubs) {
  const load = (root) => {
    const setRoles = stubs.requireFromStub(join(root, 'dist/server/middlewares/set-departments-roles.js'));
    const cacheMw = stubs.requireFromStub(join(root, 'dist/server/middlewares/reset-user-departments-cache.js'));
    return { setDepartmentsInfo: setRoles.setDepartmentsInfo, resetUserDepartmentsCache: cacheMw.resetUserDepartmentsCache };
  };
  const acl = stubs.requireFromStub(join(stubs.aclRoot, 'dist/server/middlewares/setCurrentRole.js'));
  const pristine = { ...load(stubs.departmentsRoot), setCurrentRole: acl.setCurrentRole };
  const patched = { ...load(stubs.patchedRoot), setCurrentRole: acl.setCurrentRole };

  const results = { effectiveRole: [], cache: [], isolation: [], inheritance: [], memberCrud: [] };
  const push = (group, item) => results[group].push(item);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // ---- E 组：有效角色合并 / 角色切换 / 全局角色模式 -------------------------
  const e1 = await runRequest({ middleware: patched, world: buildBaseWorld(), cache: makeCache(), userId: 101 });
  push('effectiveRole', {
    id: 'E1 自身角色 ∪ 部门角色 → attachRoles 注入并合并去重',
    observed: e1,
    expected: { currentRole: 'deptA', currentRoles: ['deptA'], effectiveRoles: ['deptA', 'member'] },
    ok: e1.currentRole === 'deptA' && same(e1.currentRoles, ['deptA']) && same(e1.effectiveRoles, ['deptA', 'member']),
  });

  const e2 = await runRequest({ middleware: patched, world: buildBaseWorld(), cache: makeCache(), userId: 101, headerRole: 'member' });
  push('effectiveRole', {
    id: 'E2 角色切换：X-Role=member（在合并集合内）→ 生效',
    observed: { currentRole: e2.currentRole, currentRoles: e2.currentRoles },
    expected: { currentRole: 'member', currentRoles: ['member'] },
    ok: e2.currentRole === 'member' && same(e2.currentRoles, ['member']),
  });

  let e3Error = null;
  try {
    await runRequest({ middleware: patched, world: buildBaseWorld(), cache: makeCache(), userId: 101, headerRole: 'deptB' });
  } catch (error) {
    e3Error = { status: error.status, code: error.payload?.code };
  }
  push('effectiveRole', {
    id: 'E3 角色切换：X-Role 不属于该用户 → 401 ROLE_NOT_FOUND_FOR_USER',
    observed: e3Error,
    expected: { status: 401, code: 'ROLE_NOT_FOUND_FOR_USER' },
    ok: e3Error?.status === 401 && e3Error?.code === 'ROLE_NOT_FOUND_FOR_USER',
  });

  const e4World = buildBaseWorld();
  e4World.systemSettings = { roleMode: 'only-use-union' };
  const e4 = await runRequest({ middleware: patched, world: e4World, cache: makeCache(), userId: 101 });
  push('effectiveRole', {
    id: 'E4 全局角色模式 only-use-union → currentRole=union，currentRoles=全部合并角色',
    observed: { currentRole: e4.currentRole, currentRoles: [...(e4.currentRoles ?? [])].sort() },
    expected: { currentRole: '__union__', currentRoles: ['deptA', 'member'] },
    ok: e4.currentRole === '__union__' && same([...(e4.currentRoles ?? [])].sort(), ['deptA', 'member']),
  });

  const e5 = await runRequest({ middleware: patched, world: buildBaseWorld(), cache: makeCache(), userId: 101, headerRole: '__union__' });
  push('effectiveRole', {
    id: 'E5 全局模式 default + X-Role=union → 落到合并集合第一个',
    observed: { currentRole: e5.currentRole, currentRoles: e5.currentRoles },
    expected: { currentRole: 'deptA', currentRoles: ['deptA'] },
    ok: e5.currentRole === 'deptA' && same(e5.currentRoles, ['deptA']),
  });

  const e6World = new World();
  e6World.addDepartment(1, 'D1').addUser(103).addMember(103, 1).addRole('deptOnly').addDepartmentRole(1, 'deptOnly');
  const e6 = await runRequest({ middleware: patched, world: e6World, cache: makeCache(), userId: 103 });
  push('effectiveRole', {
    id: 'E6 用户无自身角色、只有部门角色 → 允许进入（插件停用时这里会 401）',
    observed: { currentRole: e6.currentRole, effectiveRoles: e6.effectiveRoles },
    expected: { currentRole: 'deptOnly', effectiveRoles: ['deptOnly'] },
    ok: e6.currentRole === 'deptOnly' && same(e6.effectiveRoles, ['deptOnly']),
  });

  let e7Error = null;
  try {
    await runRequest({ middleware: patched, world: new World().addUser(104), cache: makeCache(), userId: 104 });
  } catch (error) {
    e7Error = { status: error.status, code: error.payload?.code };
  }
  push('effectiveRole', {
    id: 'E7 用户无任何角色（自身与部门都无）→ 401 USER_HAS_NO_ROLES_ERR',
    observed: e7Error,
    expected: { status: 401, code: 'USER_HAS_NO_ROLES_ERR' },
    ok: e7Error?.status === 401 && e7Error?.code === 'USER_HAS_NO_ROLES_ERR',
  });

  const e8World = new World();
  e8World.addDepartment(1, 'D1').addUser(101).addMember(101, 1);
  e8World.addRole('member').addUserRole(101, 'member').addDepartmentRole(1, 'member');
  const e8 = await runRequest({ middleware: patched, world: e8World, cache: makeCache(), userId: 101 });
  push('effectiveRole', {
    id: 'E8 自身角色与部门角色同名 → 合并去重（只出现一次）',
    observed: { effectiveRoles: [...e8.effectiveRoles].sort(), currentRole: e8.currentRole },
    expected: { effectiveRoles: ['member'], currentRole: 'member' },
    ok: same([...e8.effectiveRoles].sort(), ['member']) && e8.currentRole === 'member',
  });

  // ---- C 组：缓存行为（pristine vs patched）--------------------------------
  // 重要更正（由本 harness 实测得出，不是假设）：
  //  - `attachRoles` / 有效角色用的是**实时** `roles` 查询（filter 用缓存里的 departmentIds），
  //    所以"部门角色变更"本身**不会**让授权角色过期；C0 专门证明这一点。
  //  - 真正被缓存的是 `currentUser.departments` 载荷（含 append 的 `roles`）。部门角色变更不失效它，
  //    导致**该载荷**陈旧（展示/消费者一致性问题），而不是授权问题；C2–C5 证明 pristine 陈旧、候选刷新。
  //  - 缓存的 departmentIds 决定授权角色范围，所以**成员关系**变更必须失效；C7/C8 证明这一点，
  //    并说明原生中间件 + through 表钩子已覆盖成员变更。
  const payloadOf = (result) => result.departmentRolePayload;

  const cacheCase = async (id, { setup, mutation, userId = 101, expectPristine, expectPatched, expectEffective }) => {
    const observe = async (middleware) => {
      const world = setup();
      const cache = makeCache();
      const before = await runRequest({ middleware, world, cache, userId });
      if (mutation) await runMutation({ middleware, world, cache, params: mutation.params, apply: mutation.apply });
      const after = await runRequest({ middleware, world, cache, userId });
      return { before, after, stats: { ...cache.stats } };
    };
    const pristineObserved = await observe(pristine);
    const patchedObserved = await observe(patched);
    const matches = (observed, expected) =>
      same(payloadOf(observed.after), expected.payload) && same([...observed.after.effectiveRoles].sort(), expected.effectiveRoles);
    push('cache', {
      id,
      pristine: { payload: payloadOf(pristineObserved.after), effectiveRoles: [...pristineObserved.after.effectiveRoles].sort(), dels: pristineObserved.stats.dels },
      patched: { payload: payloadOf(patchedObserved.after), effectiveRoles: [...patchedObserved.after.effectiveRoles].sort(), dels: patchedObserved.stats.dels },
      expectedPristine: expectPristine,
      expectedPatched: expectPatched,
      ok: matches(pristineObserved, expectPristine) && matches(patchedObserved, expectPatched),
      expectEffective,
    });
  };

  await cacheCase('C0 部门角色变更本身不会让**授权角色**过期：attachRoles 用实时 roles 查询（pristine 也正确）', {
    setup: buildBaseWorld,
    mutation: { params: { associatedName: 'departments', resourceName: 'roles', associatedIndex: 1, actionName: 'add', values: ['deptB'] }, apply: (world) => world.addDepartmentRole(1, 'deptB') },
    expectPristine: { payload: { 1: ['deptA'] }, effectiveRoles: ['deptA', 'deptB', 'member'] },
    expectPatched: { payload: { 1: ['deptA', 'deptB'] }, effectiveRoles: ['deptA', 'deptB', 'member'] },
    expectEffective: '两次都包含 deptB → 授权不依赖那份被缓存的 payload',
  });

  await cacheCase('C1 同一状态重复请求命中缓存（departments 载荷读取计数不增长）', {
    setup: buildBaseWorld,
    expectPristine: { payload: { 1: ['deptA'] }, effectiveRoles: ['deptA', 'member'] },
    expectPatched: { payload: { 1: ['deptA'] }, effectiveRoles: ['deptA', 'member'] },
  });

  await cacheCase('C2 departments/1/roles:add → 载荷陈旧（pristine）/ 候选刷新', {
    setup: buildBaseWorld,
    mutation: { params: { associatedName: 'departments', resourceName: 'roles', associatedIndex: 1, actionName: 'add', values: ['deptB'] }, apply: (world) => world.addDepartmentRole(1, 'deptB') },
    expectPristine: { payload: { 1: ['deptA'] }, effectiveRoles: ['deptA', 'deptB', 'member'] },
    expectPatched: { payload: { 1: ['deptA', 'deptB'] }, effectiveRoles: ['deptA', 'deptB', 'member'] },
  });

  await cacheCase('C3 departments/1/roles:remove → 载荷陈旧（pristine）/ 候选刷新', {
    setup: buildBaseWorld,
    mutation: { params: { associatedName: 'departments', resourceName: 'roles', associatedIndex: 1, actionName: 'remove', values: ['deptA'] }, apply: (world) => world.removeDepartmentRole(1, 'deptA') },
    expectPristine: { payload: { 1: ['deptA'] }, effectiveRoles: ['member'] },
    expectPatched: { payload: { 1: [] }, effectiveRoles: ['member'] },
  });

  await cacheCase('C4 roles/deptB/departments:add（反方向）→ 载荷陈旧（pristine）/ 候选刷新', {
    setup: buildBaseWorld,
    mutation: { params: { associatedName: 'roles', resourceName: 'departments', associatedIndex: 'deptB', actionName: 'add', values: [1] }, apply: (world) => world.addDepartmentRole(1, 'deptB') },
    expectPristine: { payload: { 1: ['deptA'] }, effectiveRoles: ['deptA', 'deptB', 'member'] },
    expectPatched: { payload: { 1: ['deptA', 'deptB'] }, effectiveRoles: ['deptA', 'deptB', 'member'] },
  });

  await cacheCase('C5 roles/deptA/departments:set（含被移除的旧部门）→ 候选用变更前关系一并失效', {
    setup: () => {
      const world = new World();
      world.addDepartment(1, 'D1').addDepartment(2, 'D2');
      world.addUser(101);
      world.addRole('member').addRole('deptA').addRole('deptB');
      world.addUserRole(101, 'member');
      world.addMember(101, 2);
      world.addDepartmentRole(2, 'deptA');
      world.addDepartmentRole(2, 'deptB');
      return world;
    },
    mutation: {
      params: { associatedName: 'roles', resourceName: 'departments', associatedIndex: 'deptA', actionName: 'set', values: [1] },
      apply: (world) => {
        world.removeDepartmentRole(2, 'deptA');
        world.addDepartmentRole(1, 'deptA');
      },
    },
    expectPristine: { payload: { 2: ['deptA', 'deptB'] }, effectiveRoles: ['deptB', 'member'] },
    expectPatched: { payload: { 2: ['deptB'] }, effectiveRoles: ['deptB', 'member'] },
  });

  {
    // C1b：缓存命中明细（departments 载荷不再重复读；roles 查询按设计每次实时）
    const world = buildBaseWorld();
    const cache = makeCache();
    await runRequest({ middleware: patched, world, cache, userId: 101 });
    const countsAfterFirst = { ...world.counts };
    const second = await runRequest({ middleware: patched, world, cache, userId: 101 });
    const countsAfterSecond = { ...world.counts };
    push('cache', {
      id: 'C1b 缓存命中明细：departments 载荷第二次不重读；roles 查询每次实时（授权不缓存）',
      observed: { countsAfterFirst, countsAfterSecond, secondRoles: [...second.effectiveRoles].sort() },
      expected: { departmentsFindUnchanged: true, rolesFindGrows: true },
      ok:
        countsAfterFirst.userDepartmentsFind === countsAfterSecond.userDepartmentsFind &&
        countsAfterSecond.rolesFind > countsAfterFirst.rolesFind &&
        same([...second.effectiveRoles].sort(), ['deptA', 'member']),
    });
  }

  {
    // C7/C8：缓存的 departmentIds 决定授权范围 —— 成员变更**必须**失效，否则授权角色会陈旧。
    const setup = buildBaseWorld;
    const moveMutation = {
      params: { associatedName: 'departments', resourceName: 'members', associatedIndex: 1, actionName: 'remove', values: [101] },
      apply: (world) => {
        world.removeMember(101, 1);
        world.addMember(101, 2);
      },
    };
    // C7：绕开原生失效（直接改库）→ 授权角色陈旧（pristine/patched 都一样）
    const bypass = async () => {
      const world = setup();
      const cache = makeCache();
      await runRequest({ middleware: patched, world, cache, userId: 101 });
      moveMutation.apply(world);
      return runRequest({ middleware: patched, world, cache, userId: 101 });
    };
    const stale = await bypass();
    push('cache', {
      id: 'C7 成员变更若**绕过**失效（直接改库）→ 授权角色陈旧（证明缓存的 departmentIds 会门控授权）',
      observed: { departments: stale.departments, effectiveRoles: [...stale.effectiveRoles].sort() },
      expected: { departments: [1], effectiveRoles: ['deptA', 'member'] },
      ok: same(stale.departments, [1]) && same([...stale.effectiveRoles].sort(), ['deptA', 'member']),
    });
    // C8：走原生失效中间件 → 授权角色刷新
    const world = setup();
    const cache = makeCache();
    await runRequest({ middleware: patched, world, cache, userId: 101 });
    await runMutation({ middleware: patched, world, cache, params: moveMutation.params, apply: moveMutation.apply });
    const fresh = await runRequest({ middleware: patched, world, cache, userId: 101 });
    push('cache', {
      id: 'C8 成员变更走原生失效中间件 → 授权角色刷新（原生已覆盖成员/用户部门变更）',
      observed: { departments: fresh.departments, effectiveRoles: [...fresh.effectiveRoles].sort() },
      expected: { departments: [2], effectiveRoles: ['deptB', 'member'] },
      ok: same(fresh.departments, [2]) && same([...fresh.effectiveRoles].sort(), ['deptB', 'member']),
    });
  }

  {
    // C6：成员变更（原生已有行为）—— 新成员缓存被清，下次请求重新解析
    const world = buildBaseWorld();
    const cache = makeCache();
    const before102 = await runRequest({ middleware: patched, world, cache, userId: 102 });
    const keysBefore = cache.keys();
    await runMutation({
      middleware: patched,
      world,
      cache,
      params: { associatedName: 'departments', resourceName: 'members', associatedIndex: 1, actionName: 'add', values: [102] },
      apply: (w) => w.addMember(102, 1),
    });
    const afterAdd = await runRequest({ middleware: patched, world, cache, userId: 102 });
    await runMutation({
      middleware: patched,
      world,
      cache,
      params: { associatedName: 'departments', resourceName: 'members', associatedIndex: 1, actionName: 'remove', values: [102] },
      apply: (w) => w.removeMember(102, 1),
    });
    const afterRemove = await runRequest({ middleware: patched, world, cache, userId: 102 });
    push('cache', {
      id: 'C6 成员变更（原生已有行为）：members:add → 新成员下次请求拿到部门角色；remove → 撤销',
      observed: { before102: before102.effectiveRoles, keysBefore, afterAdd: afterAdd.effectiveRoles, afterRemove: afterRemove.effectiveRoles },
      expected: { before102: ['member'], afterAdd: ['deptA', 'member'], afterRemove: ['member'] },
      ok:
        same(before102.effectiveRoles, ['member']) &&
        same([...afterAdd.effectiveRoles].sort(), ['deptA', 'member']) &&
        same(afterRemove.effectiveRoles, ['member']),
    });
  }

  // ---- I 组：用户隔离 -----------------------------------------------------
  {
    const world = new World();
    world.addDepartment(1, 'D1').addUser(101).addUser(102);
    world.addRole('member').addRole('deptA');
    world.addUserRole(101, 'member').addUserRole(102, 'deptA');
    world.addMember(101, 1).addMember(102, 1);
    world.addDepartmentRole(1, 'deptA');
    const cache = makeCache();
    const a = await runRequest({ middleware: patched, world, cache, userId: 101 });
    const b = await runRequest({ middleware: patched, world, cache, userId: 102 });
    push('isolation', {
      id: 'I1 同一部门的两名用户：各自自身角色不同，缓存键与结果不串（无权限扩大）',
      observed: { a: [...a.effectiveRoles].sort(), b: [...b.effectiveRoles].sort(), cacheKeys: cache.keys() },
      expected: { a: ['deptA', 'member'], b: ['deptA'] },
      ok: same([...a.effectiveRoles].sort(), ['deptA', 'member']) && same([...b.effectiveRoles].sort(), ['deptA']) && cache.keys().length >= 4,
    });
  }

  // ---- T 组：父子部门继承（源码证据 + 运行观察）-------------------------
  {
    const world = new World();
    world.addDepartment(1, 'D1').addDepartment(11, 'D1-1', 1).addUser(101);
    world.addRole('parentRole').addRole('childRole');
    world.addMember(101, 11);
    world.addDepartmentRole(1, 'parentRole');
    world.addDepartmentRole(11, 'childRole');
    const result = await runRequest({ middleware: patched, world, cache: makeCache(), userId: 101 });
    push('inheritance', {
      id: 'T1 父部门角色不继承：用户仅在子部门时，attachRoles 只含子部门角色',
      observed: { departments: result.departments, effectiveRoles: result.effectiveRoles },
      expected: { departments: [11], effectiveRoles: ['childRole'] },
      ok: same(result.departments, [11]) && same([...result.effectiveRoles].sort(), ['childRole']),
      note: '源码依据：中间件用 users.departments（直接部门）算 departmentIds；parent(recursively=true) 只 append 到返回载荷，不参与角色合并。',
    });

    const world2 = new World();
    world2.addDepartment(1, 'D1').addDepartment(2, 'D2').addUser(101);
    world2.addRole('roleA').addRole('roleB');
    world2.addMember(101, 1).addMember(101, 2);
    world2.addDepartmentRole(1, 'roleA');
    world2.addDepartmentRole(2, 'roleB');
    const result2 = await runRequest({ middleware: patched, world: world2, cache: makeCache(), userId: 101 });
    push('inheritance', {
      id: 'T2 用户同时在两个部门 → 两个部门的角色都并入',
      observed: { departments: result2.departments, effectiveRoles: result2.effectiveRoles },
      expected: { departments: [1, 2], effectiveRoles: ['roleA', 'roleB'] },
      ok: same([...result2.departments].sort(), [1, 2]) && same([...result2.effectiveRoles].sort(), ['roleA', 'roleB']),
    });
  }

  // ---- M 组：部门成员 / 用户关联（真实原生中间件）-------------------------
  {
    const destroyCheck = stubs.requireFromStub(join(stubs.departmentsRoot, 'dist/server/middlewares/destroy-department-check.js')).destroyDepartmentCheck;
    const setOwners = stubs.requireFromStub(join(stubs.departmentsRoot, 'dist/server/middlewares/set-department-owners.js')).setDepartmentOwners;

    const runDestroy = async (world, departmentId) => {
      const db = world.db();
      const ctx = {
        app: { db },
        db,
        action: { params: { resourceName: 'departments', actionName: 'destroy', filterByTk: departmentId } },
        t: (key) => key,
        throw(status, message) {
          const error = new Error(String(message));
          error.status = status;
          throw error;
        },
      };
      let passed = false;
      await destroyCheck(ctx, async () => {
        passed = true;
      });
      return { passed };
    };

    const worldWithMembers = buildBaseWorld().addMember(102, 1);
    let m1 = null;
    try {
      await runDestroy(worldWithMembers, 1);
      m1 = { passed: true };
    } catch (error) {
      m1 = { passed: false, status: error.status, message: error.message };
    }
    push('memberCrud', {
      id: 'M1 有成员时删除部门 → 原生 destroyDepartmentCheck 拒绝（400）',
      observed: m1,
      expected: { passed: false, status: 400 },
      ok: m1.passed === false && m1.status === 400 && String(m1.message).includes('members'),
    });

    const worldNoMembers = buildBaseWorld();
    worldNoMembers.removeMember(101, 1); // 先撤销成员关系，再删除部门
    let m2 = null;
    try {
      m2 = await runDestroy(worldNoMembers, 1);
    } catch (error) {
      m2 = { passed: false, status: error.status, message: error.message };
    }
    push('memberCrud', {
      id: 'M2 移除成员后删除部门 → 原生检查放行（成员关系已撤销）',
      observed: m2,
      expected: { passed: true },
      ok: m2.passed === true,
    });

    const worldOwners = buildBaseWorld().addMember(102, 1);
    const db = worldOwners.db();
    const ctx = {
      app: { db },
      db,
      action: { params: { resourceName: 'departments', actionName: 'update', filterByTk: 1, values: { owners: [{ id: 102 }] } } },
    };
    let nextValues = null;
    await setOwners(ctx, async () => {
      nextValues = ctx.action.params.values;
    });
    push('memberCrud', {
      id: 'M3 departments:update 带 owners → 原生 setDepartmentOwners 改写 through 表 isOwner 并把 owners 从 values 摘掉',
      observed: {
        throughState: worldOwners.departmentsUsers.map((row) => ({ userId: row.userId, departmentId: row.departmentId, isOwner: row.isOwner })),
        valuesPassedToNext: nextValues,
      },
      expected: {
        throughState: [
          { userId: 101, departmentId: 1, isOwner: false },
          { userId: 102, departmentId: 1, isOwner: true },
        ],
        valuesPassedToNextWithoutOwners: true,
      },
      ok:
        same(
          [...worldOwners.departmentsUsers].sort((a, b) => a.userId - b.userId).map((row) => ({ userId: row.userId, departmentId: row.departmentId, isOwner: row.isOwner })),
          [
            { userId: 101, departmentId: 1, isOwner: false },
            { userId: 102, departmentId: 1, isOwner: true },
          ],
        ) && nextValues !== null && nextValues.owners === undefined,
    });
  }

  const flat = Object.values(results).flat();
  return { ok: flat.every((item) => item.ok), ...results, cases: flat };
}

/** 静态来源证据：真实 13000 schema vs 插件定义；上游发布产物里能证明/不能证明的事实。 */
function collectSourceEvidence(stubs, dataset) {
  const { requireFromStub } = stubs;
  const load = (name) => requireFromStub(join(stubs.departmentsRoot, `dist/server/collections/${name}.js`));
  const departmentsDefinition = load('departments').default;
  const usersDefinition = load('users').default;
  const rolesDefinition = load('roles').default;
  const collectionFields = (collection) =>
    (collection?.fields ?? []).map((field) => ({ name: field.name, type: field.type, primaryKey: field.primaryKey === true, target: field.target ?? null, through: field.through ?? null, foreignKey: field.foreignKey ?? null }));

  const pluginFields = collectionFields(departmentsDefinition);
  const pluginFieldNames = pluginFields.map((field) => field.name);
  const realFieldNames = (dataset?.departmentFields?.fields ?? []).map((field) => field.name);

  return {
    targetVersion: dataset?.version?.version ?? null,
    pluginState: dataset?.pluginState ?? null,
    realSchema: {
      departmentsCollection: dataset?.departmentsCollection ?? null,
      departmentFields: dataset?.departmentFields?.fields ?? null,
      structure: dataset?.departments?.structure ?? null,
      associationProbes: dataset?.associationProbes ?? null,
    },
    pluginSchemaPlan: {
      package: '@nocobase/plugin-departments@2.2.20',
      departmentsCollection: {
        template: departmentsDefinition?.template ?? null,
        tree: departmentsDefinition?.tree ?? null,
        sortable: departmentsDefinition?.sortable ?? null,
        migrationRules: departmentsDefinition?.migrationRules ?? null,
        dumpRules: departmentsDefinition?.dumpRules ?? null,
        model: departmentsDefinition?.model ?? null,
      },
      departmentsFields: pluginFields,
      addedFields: pluginFieldNames.filter((name) => !realFieldNames.includes(name)),
      preservedCustomFields: realFieldNames.filter((name) => !pluginFieldNames.includes(name)),
      usersExtendFields: collectionFields(usersDefinition),
      rolesExtendFields: collectionFields(rolesDefinition),
    },
    upstreamFacts: {
      cacheDefaultStore: '@nocobase/cache@2.2.20 CacheManager 默认 defaultStore="memory"（max 2000）；cache-manager memory 默认 ttl 0 = 不过期',
      collectionSync: '@nocobase/database@2.2.20 Collection.sync() → model.sync({ force:false, alter:{ drop:false } }) —— schema 同步不删额外列',
      migrationRulesInterpretation:
        '发布产物里 migrationRules 只作为 collection 定义元数据随包分发；本轮在 @nocobase/database / @nocobase/server / @nocobase/plugin-data-source-main 的 2.2.20 发布产物中未找到解释它的执行代码 → 列为**需补证据的未知**，安装前必须在隔离实例先试 + 数据库备份。',
    },
  };
}

async function main() {
  const summary = { generatedAt: new Date().toISOString(), steps: {} };
  for (const [key, tarball] of Object.entries(TARBALLS)) {
    if (!existsSync(tarball.path)) {
      console.error(`缺少发布包缓存：${key} → ${tarball.path}\n请从 ${tarball.url} 下载。`);
      process.exitCode = 2;
      return;
    }
  }
  const hashes = {};
  for (const [key, tarball] of Object.entries(TARBALLS)) {
    const hash = sha256(readFileSync(tarball.path));
    hashes[key] = { sha256: hash, expected: tarball.sha256, matches: hash === tarball.sha256, url: tarball.url };
  }
  summary.steps.tarballs = hashes;
  if (!hashes.departments.matches || !hashes.acl.matches) {
    console.error(`发布包哈希不一致：${JSON.stringify(hashes)}`);
    process.exitCode = 1;
    return;
  }
  summary.deps = { depsRoot: frontendRoot };

  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  const pristineDepartments = join(workDir, 'pristine-departments');
  const patchedDepartments = join(workDir, 'patched-departments');
  const pristineAcl = join(workDir, 'pristine-acl');
  const pristineCache = join(workDir, 'pristine-cache');
  const pristineDatabase = join(workDir, 'pristine-database');
  extractTarball(TARBALLS.departments, pristineDepartments);
  extractTarball(TARBALLS.acl, pristineAcl);
  extractTarball(TARBALLS.cache, pristineCache);
  extractTarball(TARBALLS.database, pristineDatabase);
  mkdirSync(patchedDepartments, { recursive: true });
  cpSync(join(pristineDepartments, 'package'), join(patchedDepartments, 'package'), { recursive: true });

  const pristineHashes = {};
  for (const rel of [...Object.values(PATCHED_FILES), ...Object.values(OBSERVED_FILES)]) {
    pristineHashes[rel] = sha256(readFileSync(join(pristineDepartments, rel)));
  }
  summary.steps.pristineSha256 = pristineHashes;

  const anchorResults = applyAnchors(patchedDepartments);
  summary.steps.anchors = anchorResults;
  if (!anchorResults.every((item) => item.applied)) {
    console.error(`锚点未全部命中：${JSON.stringify(anchorResults)}`);
    process.exitCode = 1;
    return;
  }

  const patchText = [...new Set(ANCHORS.map((anchor) => anchor.file))].map((rel) => diffFor(rel, pristineDepartments, patchedDepartments)).join('');
  writeFileSync(join(patchRoot, 'department-compat-2.2.20.patch'), patchText);
  summary.steps.patchBytes = patchText.length;

  const stubs = prepareStubs(join(pristineDepartments, 'package'), join(patchedDepartments, 'package'), join(pristineAcl, 'package'));
  summary.steps.frameworkStubs = {
    '@nocobase/database': 'defineCollection/extendCollection 只回传定义本身（读字段清单用）',
    '@nocobase/utils': 'getAuthCookieName/getAuthCookieOptions（cookie 名与选项，不参与角色合并）',
    'db/cache/ctx': '注入端口（假仓库 + 无 TTL 内存 cache），被测函数为真实发布产物',
    linkedDeps: stubs.deps,
  };

  const runtime = await runtimeCheck(stubs);
  summary.steps.runtime = runtime;

  let dataset = null;
  if (existsSync(evidencePath)) dataset = JSON.parse(readFileSync(evidencePath, 'utf8'));
  summary.steps.sourceEvidence = collectSourceEvidence(stubs, dataset);

  const patchedHashes = {};
  for (const rel of Object.values(PATCHED_FILES)) patchedHashes[rel] = sha256(readFileSync(join(patchedDepartments, rel)));
  const observedHashes = {};
  for (const rel of Object.values(OBSERVED_FILES)) observedHashes[rel] = pristineHashes[rel];
  const manifest = {
    generatedAt: summary.generatedAt,
    package: '@nocobase/plugin-departments@2.2.20',
    tarballUrl: TARBALLS.departments.url,
    tarballSha256: TARBALLS.departments.sha256,
    patchFile: 'department-compat-2.2.20.patch',
    patchSha256: sha256(Buffer.from(patchText, 'utf8')),
    patchBytes: patchText.length,
    files: Object.fromEntries(
      Object.entries(PATCHED_FILES).map(([key, rel]) => [rel, { key, pristineSha256: pristineHashes[rel], patchedSha256: patchedHashes[rel] }]),
    ),
    observedFiles: Object.fromEntries(Object.entries(OBSERVED_FILES).map(([key, rel]) => [rel, { key, pristineSha256: observedHashes[rel], untouched: true }])),
  };
  writeFileSync(join(patchRoot, 'patch-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  summary.steps.manifest = { file: 'patch-manifest.json', patchedSha256: patchedHashes };

  writeFileSync(join(patchRoot, 'department-candidate-check.json'), `${JSON.stringify(summary, null, 2)}\n`);

  console.log('2.2.20 发布包哈希：');
  for (const [key, value] of Object.entries(hashes)) console.log(`  ${key.padEnd(16)} ${value.matches ? '一致' : '不一致'}  ${value.sha256}`);
  console.log(`锚点：${anchorResults.map((item) => `${item.id}=${item.hits}`).join(' ')}`);
  console.log(`补丁：${patchText.length} 字节 → department-compat-2.2.20.patch（sha256 ${manifest.patchSha256.slice(0, 12)}…）`);
  const groups = [
    ['E 有效角色合并 / 角色切换 / 全局角色模式', runtime.effectiveRole],
    ['C 缓存刷新与撤销（原始 vs 候选）', runtime.cache],
    ['I 用户隔离', runtime.isolation],
    ['T 父子部门继承（源码证据 + 运行）', runtime.inheritance],
    ['M 成员关系变更驱动', runtime.memberCrud],
  ];
  for (const [title, items] of groups) {
    console.log(`  ${title}`);
    for (const item of items ?? []) {
      console.log(`    ${item.ok ? 'PASS' : 'FAIL'}  ${item.id}`);
      if (item.observed) console.log(`          observed : ${JSON.stringify(item.observed)}`);
      if (item.pristine !== undefined) {
        console.log(`          pristine : ${JSON.stringify(item.pristine)}`);
        console.log(`          patched  : ${JSON.stringify(item.patched)}`);
      }
    }
  }
  console.log(`来源证据：真实 schema 与插件定义差异 → added=${JSON.stringify(summary.steps.sourceEvidence.pluginSchemaPlan.addedFields)} preserved=${JSON.stringify(summary.steps.sourceEvidence.pluginSchemaPlan.preservedCustomFields)}`);
  process.exitCode = runtime.ok ? 0 : 1;
}

await main();
