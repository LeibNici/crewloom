// 2.2.20 本机受控 Application 实验台（backend 组独占路径）。
//
// 目的：在**隔离临时 PostgreSQL + 固定 2.2.20 npm 发布包闭包**上，用真实
// `@nocobase/server` 的 `Application`/PluginManager/CLI 生命周期与真实 Koa HTTP 链，
// 验证 auth → resourcer → ACL → departments 中间件 → ORM → PG 的完整行为。
//
// 本文件只做环境准备（解包闭包、依赖软链、临时 PG 生命周期），不含业务断言。
// 不访问真实 13000/13080，不读任何凭据。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..');
export const CACHE = join(ROOT, '.cache/npm');
export const WORK = join(ROOT, '.work');
export const MODULES = join(WORK, 'applab/node_modules');

export const PG_PORT = 15439;
export const PG_USER = 'crewloom_lab';
export const PG_HOST = '127.0.0.1';
export const APP_PORT = 15441;
const PSQL = '/opt/homebrew/bin/psql';
const PG_CTL = '/opt/homebrew/bin/pg_ctl';
export const PGDATA = join(WORK, 'pgdata');
export const PGLOG = join(WORK, 'pg.log');

// 依赖农场：复用项目根已锁定的 pnpm store（只读），不新增/升级任何锁文件。
const DEPS_ROOT = '/Users/chenming/IdeaProjects/crewloom/frontend/node_modules/.pnpm';
const BUILTINS = new Set([
  'fs', 'path', 'crypto', 'events', 'util', 'os', 'stream', 'http', 'https', 'zlib', 'url', 'assert', 'buffer',
  'child_process', 'tty', 'net', 'tls', 'dns', 'string_decoder', 'querystring', 'timers', 'worker_threads',
  'perf_hooks', 'async_hooks', 'v8', 'vm', 'readline', 'repl', 'cluster', 'dgram', 'module', 'process',
  'constants', 'domain', 'punycode', 'sys', 'inspector', 'diagnostics_channel', 'console', 'node:fs',
]);

export function log(msg) {
  console.log(`[app-lab] ${msg}`);
}

export function evidenceDir() {
  const dir = resolve(import.meta.dirname, '../../..', 'docs/acceptance/full-pages-13000/final-backend-http-evidence');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeEvidence(name, data) {
  const dir = evidenceDir();
  const file = join(dir, name);
  writeFileSync(file, typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`);
  return file;
}

function resolveFarmPackage(name) {
  const hoisted = join(DEPS_ROOT, 'node_modules', name);
  if (existsSync(hoisted)) return hoisted;
  const flat = name.replace('/', '+');
  for (const entry of readdirSync(DEPS_ROOT)) {
    if (!entry.startsWith(`${flat}@`)) continue;
    const candidate = join(DEPS_ROOT, entry, 'node_modules', name);
    if (existsSync(candidate)) return candidate;
  }
  const direct = join('/Users/chenming/IdeaProjects/crewloom/frontend/node_modules', name);
  return existsSync(direct) ? direct : null;
}

/**
 * 解包 2.2.20 npm 闭包到本组自己的 .work/applab/node_modules，并把每个包的
 * 非 @nocobase 三方依赖软链到项目根 pnpm store（只读复用，不安装、不改锁）。
 * 返回 { packages, missingDeps }。
 */
export function prepareClosure() {
  mkdirSync(join(MODULES, '@nocobase'), { recursive: true });
  const closure = JSON.parse(readFileSync(join(CACHE, 'closure.json'), 'utf8'));
  const missing = new Set();
  for (const pkg of closure.packages) {
    const short = pkg.name.replace('@nocobase/', '');
    const dest = join(MODULES, '@nocobase', short);
    if (!existsSync(dest)) {
      mkdirSync(dest, { recursive: true });
      const tgz = join(CACHE, `${short}-2.2.20.tgz`);
      if (!existsSync(tgz)) throw new Error(`missing tarball for ${pkg.name}: ${tgz}`);
      execFileSync('tar', ['-xzf', tgz, '-C', dest, '--strip-components=1']);
    }
    const specs = new Set();
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.js')) continue;
        const text = readFileSync(full, 'utf8');
        for (const m of text.matchAll(/require\("([^"]+)"\)/g)) {
          const spec = m[1];
          if (!spec.startsWith('.') && !spec.startsWith('node:')) specs.add(spec);
        }
      }
    };
    walk(dest);
    for (const spec of specs) {
      const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (BUILTINS.has(name) || name.startsWith('@nocobase/')) continue;
      const target = join(MODULES, name);
      if (existsSync(target)) continue;
      const real = resolveFarmPackage(name);
      if (!real) { missing.add(name); continue; }
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(real, target);
    }
  }
  // 依赖版本 pin：@nocobase/resourcer@2.2.20 要求 path-to-regexp@^6.3.0；
  // pnpm store 里同时存在 v3/v6/v8，盲目取第一个会拿到 v8（路由语法不兼容）。
  const pinned = { 'path-to-regexp': 'path-to-regexp@6.3.0' };
  for (const [name, storeEntry] of Object.entries(pinned)) {
    const dest = join(MODULES, name);
    const real = join(DEPS_ROOT, storeEntry, 'node_modules', name);
    if (!existsSync(real)) throw new Error(`pinned dependency missing: ${storeEntry}`);
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    symlinkSync(real, dest);
  }
  return { packages: closure.packages.map((p) => `${p.name}@${closure.version}`), missingDeps: [...missing] };
}

export function requireFromLab(id) {
  return createRequire(join(WORK, 'applab/entry.cjs'))(id);
}

export function psql(db, sql, { tuple = true } = {}) {
  const args = ['-h', PG_HOST, '-p', String(PG_PORT), '-U', PG_USER, '-d', db];
  if (tuple) args.push('-tAc', sql);
  else args.push('-c', sql);
  return execFileSync(PSQL, args, { encoding: 'utf8' });
}

export function pgIsRunning() {
  try {
    execFileSync(PG_CTL, ['-D', PGDATA, 'status'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function pgStart() {
  if (pgIsRunning()) return false;
  if (!existsSync(join(PGDATA, 'PG_VERSION'))) {
    mkdirSync(PGDATA, { recursive: true });
    execFileSync('/opt/homebrew/bin/initdb', ['-D', PGDATA, '-U', PG_USER, '--auth=trust', '-E', 'UTF8'], { stdio: 'ignore' });
  }
  execFileSync(PG_CTL, [
    '-D', PGDATA,
    '-o', `-p ${PG_PORT} -c listen_addresses=${PG_HOST} -c unix_socket_directories=''`,
    '-l', PGLOG,
    '-w', 'start',
  ], { stdio: 'ignore' });
  return true;
}

export function pgStop() {
  if (!pgIsRunning()) return false;
  try {
    execFileSync(PG_CTL, ['-D', PGDATA, 'stop', '-m', 'fast', '-w'], { stdio: 'ignore' });
  } catch {
    return false;
  }
  return true;
}

export function recreateDatabase(name) {
  psql('postgres', `DROP DATABASE IF EXISTS ${name}`);
  psql('postgres', `CREATE DATABASE ${name}`);
}

export function databaseConfig(name) {
  return {
    dialect: 'postgres',
    host: PG_HOST,
    port: PG_PORT,
    database: name,
    username: PG_USER,
    logging: false,
    underscored: true,
  };
}

export function fileSha256(file) {
  const { createHash } = requireFromLab('node:crypto');
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}
