// 探针 2：真实 Application install/start + 真实 HTTP。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve, dirname } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const cache = join(root, '.cache/npm');
const lab = join(root, '.work/applab');
const modules = join(lab, 'node_modules');
const depsRoot = '/Users/chenming/IdeaProjects/crewloom/frontend/node_modules/.pnpm';
const closure = JSON.parse(readFileSync(join(cache, 'closure.json'), 'utf8'));
const PORT = 15440;
const DB = 'crewloom_app_lab';
const PG = { host: '/tmp/clpg', port: 15439, username: 'crewloom_lab' };

function resolvePkg(name) {
  const hoisted = join(depsRoot, 'node_modules', name);
  if (existsSync(hoisted)) return hoisted;
  const flat = name.replace('/', '+');
  for (const entry of readdirSync(depsRoot)) {
    if (!entry.startsWith(`${flat}@`)) continue;
    const candidate = join(depsRoot, entry, 'node_modules', name);
    if (existsSync(candidate)) return candidate;
  }
  const direct = join('/Users/chenming/IdeaProjects/crewloom/frontend/node_modules', name);
  return existsSync(direct) ? direct : null;
}

async function fetchUrl(url, options = {}) {
  return fetch(url, options);
}

async function main() {
  mkdirSync(lab, { recursive: true });
  process.chdir(lab);
  process.env.NODE_MODULES_PATH = modules;
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';
  mkdirSync(join(modules, '@nocobase'), { recursive: true });
  const builtins = new Set(['fs', 'path', 'crypto', 'events', 'util', 'os', 'stream', 'http', 'https', 'zlib', 'url', 'assert', 'buffer', 'child_process', 'tty', 'net', 'tls', 'dns', 'string_decoder', 'querystring', 'timers', 'worker_threads', 'perf_hooks', 'async_hooks', 'v8', 'vm', 'readline', 'repl', 'cluster', 'dgram', 'module', 'process', 'constants', 'domain', 'punycode', 'sys', 'inspector', 'diagnostics_channel', 'console']);
  const missing = [];
  for (const pkg of closure.packages) {
    const short = pkg.name.replace('@nocobase/', '');
    const dest = join(modules, '@nocobase', short);
    if (!existsSync(dest)) {
      mkdirSync(dest, { recursive: true });
      execFileSync('tar', ['-xzf', join(cache, `${short}-2.2.20.tgz`), '-C', dest, '--strip-components=1']);
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
      if (builtins.has(name) || name.startsWith('@nocobase/')) continue;
      const target = join(modules, name);
      if (existsSync(target)) continue;
      const real = resolvePkg(name);
      if (!real) { missing.push(name); continue; }
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(real, target);
    }
  }
  if (missing.length) console.log('MISSING', [...new Set(missing)].join(','));
  // 依赖版本 pin：@nocobase/resourcer@2.2.20 要求 path-to-regexp@^6.3.0，
  // 但本机 pnpm store 里同名包有 v3/v6/v8，盲目取第一个会拿到 v8（路由语法不兼容）。
  for (const [name, storeEntry] of Object.entries({ 'path-to-regexp': 'path-to-regexp@6.3.0' })) {
    const dest = join(modules, name);
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    const real = join(depsRoot, storeEntry, 'node_modules', name);
    if (existsSync(real)) symlinkSync(real, dest);
    else console.log('PIN_MISSING', name, storeEntry);
  }

  const requireFromLab = createRequire(join(lab, 'entry.cjs'));
  const { Application } = requireFromLab('@nocobase/server');
  const pluginNames = ['plugin-error-handler', 'plugin-auth', 'plugin-field-sort', 'plugin-field-sequence', 'plugin-field-formula', 'plugin-data-source-manager', 'plugin-data-source-main', 'plugin-acl', 'plugin-users', 'plugin-user-data-sync', 'plugin-ui-schema-storage', 'plugin-departments'];
  // 用**包名字符串**传入：PluginManager.parseName 才能解析 packageName，getPluginBasePath 才能定位 server/collections
  const plugins = pluginNames.map((name) => `@nocobase/${name}`);
  console.log('plugins requested:', plugins.length);

  // 干净库
  execFileSync('/opt/homebrew/bin/psql', ['-h', PG.host, '-p', String(PG.port), '-U', PG.username, '-d', 'postgres', '-tAc', `DROP DATABASE IF EXISTS ${DB}`]);
  execFileSync('/opt/homebrew/bin/psql', ['-h', PG.host, '-p', String(PG.port), '-U', PG.username, '-d', 'postgres', '-tAc', `CREATE DATABASE ${DB}`]);

  // 关键：resourcer 前缀必须用真实启动代码里的 API_BASE_PATH
  // （@nocobase/server/lib/app-supervisor/app-options-factory.js:77 `resourcer:{prefix:process.env.API_BASE_PATH}`；
  //   gateway/index.js:204 `normalizeBasePath(process.env.API_BASE_PATH || '/api')`）。
  const API_BASE_PATH = process.env.API_BASE_PATH || '/api';
  process.env.API_BASE_PATH = API_BASE_PATH;
  console.log('API_BASE_PATH =', API_BASE_PATH);
  const app = new Application({
    name: 'main',
    skipSupervisor: true,
    database: { dialect: 'postgres', host: PG.host, port: PG.port, database: DB, username: PG.username, logging: false, underscored: true },
    plugins,
    resourcer: { prefix: API_BASE_PATH },
    acl: { },
  });

  // 真实实例的 pluginAliases（短名 → 实例）来自 applicationPlugins 记录；手工初始化时要显式补上，
  // 否则 pm.get('error-handler') 这类短名查不到（这正是之前的阻塞点）。
  await app.pm.initPlugins();
  for (const instance of app.pm.getPlugins().values()) {
    const pkg = instance.options?.packageName;
    if (!pkg) continue;
    const short = pkg.replace(/^(@nocobase\/)?plugin-/, '');
    app.pm.pluginAliases.set(short, instance);
  }
  console.log('aliases seeded:', [...app.pm.pluginAliases.keys()].join(','));
  try {
    await app.load();
    console.log('app.load ok');
  } catch (error) {
    console.log('LOAD_THREW', error.name, String(error.message).slice(0, 300));
    console.log(String(error.stack).split('\n').slice(0, 8).join('\n'));
    return;
  }
  try {
    await app.db.sync();
    console.log('db.sync ok');
  } catch (error) {
    console.log('SYNC_THREW', String(error.message).slice(0, 300));
  }
  try {
    await app.install({ users: { rootEmail: 'lab@example.invalid', rootPassword: 'lab-password-123', rootNickname: 'Lab', rootUsername: 'labroot' } });
    console.log('app.install ok');
  } catch (error) {
    console.log('INSTALL_THREW', error.name, String(error.message).slice(0, 400));
    console.log(String(error.stack).split('\n').slice(0, 8).join('\n'));
    return;
  }
  try {
    await app.start();
    console.log('app.start ok');
  } catch (error) {
    console.log('START_THREW', String(error.message).slice(0, 300));
    return;
  }

  const http = requireFromLab('node:http');
  const server = http.createServer(app.callback());
  await new Promise((resolvePromise) => server.listen(PORT, '127.0.0.1', resolvePromise));
  console.log('http listening', PORT);
  const base = `http://127.0.0.1:${PORT}`;
  const results = [];
  const call = async (label, path, { method = 'GET', body } = {}) => {
    const res = await fetchUrl(`${base}${API_BASE_PATH}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let parsed = null; try { parsed = JSON.parse(text); } catch { parsed = { _raw: text.slice(0, 120) }; }
    results.push({ label, method, path, status: res.status, body: parsed });
    return { status: res.status, body: parsed };
  };
  let headers = { 'Content-Type': 'application/json' };
  try {
    const authList = await fetchUrl(`${base}${API_BASE_PATH}/authenticators:publicList`);
    const authBody = await authList.json();
    const authenticator = authBody?.data?.[0]?.name ?? 'basic';
    console.log('authenticators:publicList', authList.status, 'authenticator=', authenticator);
    const signIn = await fetchUrl(`${base}${API_BASE_PATH}/auth:signIn`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Authenticator': authenticator }, body: JSON.stringify({ email: 'lab@example.invalid', password: 'lab-password-123' }) });
    const signInBody = await signIn.json();
    console.log('auth:signIn', signIn.status, 'token?', Boolean(signInBody?.data?.token));
    headers = { 'Content-Type': 'application/json', 'X-Authenticator': authenticator, Authorization: `Bearer ${signInBody?.data?.token}` };
    const created = await call('departments:create', '/departments:create', { method: 'POST', body: { name: 'LAB-DEPT-HTTP', dept_code: 'LAB-H1', status: 'active' } });
    const deptId = created.body?.data?.id;
    console.log('departments:create', created.status, 'deptId?', Boolean(deptId));
    const users = await call('users:list', '/users:list?pageSize=1');
    const userId = users.body?.data?.[0]?.id;
    console.log('users:list', users.status, 'userId?', Boolean(userId));
    const roles = await call('roles:list', '/roles:list?pageSize=1');
    const roleName = roles.body?.data?.[0]?.name;
    console.log('roles:list', roles.status, 'roleName?', Boolean(roleName));
    if (deptId) {
      const g1 = await call('members:list(before)', `/departments/${deptId}/members:list?pageSize=5`);
      const g2 = await call('roles:list(before)', `/departments/${deptId}/roles:list?pageSize=5`);
      const g3 = await call('roles/<role>/departments:list', `/roles/${roleName}/departments:list?pageSize=5`);
      const g4 = await call('users/<id>/departments:list', `/users/${userId}/departments:list?pageSize=5`);
      console.log('4 关联 GET:', g1.status, g2.status, g3.status, g4.status);
      if (userId) {
        await call('members:add', `/departments/${deptId}/members:add`, { method: 'POST', body: { values: [userId] } });
        const after = await call('members:list(after add)', `/departments/${deptId}/members:list?pageSize=5`);
        await call('members:remove', `/departments/${deptId}/members:remove`, { method: 'POST', body: { values: [userId] } });
        const afterRemove = await call('members:list(after remove)', `/departments/${deptId}/members:list?pageSize=5`);
        console.log('members add/remove readback:', after.body?.meta?.count, afterRemove.body?.meta?.count);
      }
      if (roleName) {
        await call('roles:add', `/departments/${deptId}/roles:add`, { method: 'POST', body: { values: [roleName] } });
        const afterRole = await call('roles:list(after add)', `/departments/${deptId}/roles:list?pageSize=5`);
        await call('roles:remove', `/departments/${deptId}/roles:remove`, { method: 'POST', body: { values: [roleName] } });
        const afterRoleRemove = await call('roles:list(after remove)', `/departments/${deptId}/roles:list?pageSize=5`);
        console.log('roles add/remove readback:', afterRole.body?.meta?.count, afterRoleRemove.body?.meta?.count);
      }
      await call('departments:destroy', `/departments:destroy?filterByTk=${deptId}`, { method: 'POST' });
    }
  } catch (error) {
    console.log('HTTP_THREW', String(error.message).slice(0, 300));
  }
  writeFileSync(join(root, '.work/app-http-results.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), apiBasePath: API_BASE_PATH, results: results.map((r) => ({ label: r.label, method: r.method, path: r.path, status: r.status })) }, null, 2)}\n`);
  server.close();
  if (process.env.CL_KEEP_APP_PG !== '1') {
    try { execFileSync('/opt/homebrew/bin/pg_ctl', ['-D', join(root, '.work/pgapp/data'), 'stop', '-m', 'fast'], { stdio: 'ignore' }); } catch { /* already stopped */ }
  }
  await app.stop?.();
  await app.db.close();
}

await main();
