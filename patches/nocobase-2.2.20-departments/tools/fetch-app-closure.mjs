#!/usr/bin/env node
/**
 * 为"最小真实 NocoBase 2.2.20 应用"实验，拉取**同版 2.2.20** `@nocobase/*` 依赖闭包到本候选目录 `.cache/npm/`。
 * 只下载 `dependencies` 里的 `@nocobase/*`（按各包 package.json 递归）+ 显式列出的插件种子；
 * 不装全局、不改系统、不碰其它目录。第三方依赖从**本机已装** pnpm store 软链（见 dept-app-lab.mjs）。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const cache = join(root, '.cache/npm');
mkdirSync(cache, { recursive: true });
const VERSION = '2.2.20';
const SEEDS = [
  '@nocobase/server',
  '@nocobase/database',
  '@nocobase/acl',
  '@nocobase/utils',
  '@nocobase/cache',
  '@nocobase/logger',
  '@nocobase/actions',
  '@nocobase/resourcer',
  '@nocobase/sdk',
  '@nocobase/telemetry',
  '@nocobase/evaluators',
  '@nocobase/auth',
  '@nocobase/data-source-manager',
  '@nocobase/plugin-data-source-main',
  '@nocobase/plugin-acl',
  '@nocobase/plugin-users',
  '@nocobase/plugin-departments',
  '@nocobase/plugin-error-handler',
  '@nocobase/plugin-auth',
  '@nocobase/plugin-user-data-sync',
  '@nocobase/plugin-ui-schema-storage',
  '@nocobase/plugin-data-source-manager',
  '@nocobase/plugin-field-sort',
  '@nocobase/plugin-field-sequence',
  '@nocobase/plugin-field-formula',
];

const registryUrl = 'https://registry.npmjs.org';
const manifestCache = new Map();
function fetchManifest(name) {
  if (manifestCache.has(name)) return manifestCache.get(name);
  const json = execFileSync('curl', ['-sS', '-m', '30', `${registryUrl}/${name}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const parsed = JSON.parse(json);
  manifestCache.set(name, parsed);
  return parsed;
}

const seen = new Set();
const queue = [...SEEDS];
const downloaded = [];
const missingVersion = [];
while (queue.length) {
  const name = queue.shift();
  if (seen.has(name)) continue;
  seen.add(name);
  const manifest = fetchManifest(name);
  const version = manifest.versions[VERSION];
  if (!version) {
    missingVersion.push(name);
    continue;
  }
  const file = join(cache, `${name.replace('@nocobase/', '').replace('/', '_')}-${VERSION}.tgz`);
  if (!existsSync(file)) {
    execFileSync('curl', ['-sSL', '-m', '120', '-o', file, version.dist.tarball], { stdio: 'ignore' });
  }
  downloaded.push({ name, version: VERSION, file, deps: Object.keys(version.dependencies ?? {}) });
  for (const dep of Object.keys(version.dependencies ?? {})) {
    if (dep.startsWith('@nocobase/') && !seen.has(dep)) queue.push(dep);
  }
}

writeFileSync(
  join(cache, 'closure.json'),
  `${JSON.stringify({ version: VERSION, generatedAt: new Date().toISOString(), packages: downloaded.map((p) => ({ name: p.name, deps: p.deps })), missingVersion }, null, 2)}\n`,
);
console.log(`downloaded=${downloaded.length} missingVersion=${missingVersion.join(',') || '(none)'}`);
console.log(downloaded.map((p) => p.name.replace('@nocobase/', '')).join(' '));
