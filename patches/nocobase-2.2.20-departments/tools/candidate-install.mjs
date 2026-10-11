#!/usr/bin/env node
/**
 * NocoBase 2.2.20 部门兼容候选：**安装 / 回退** 工具（本脚本本身不联网、不装包）。
 *
 * 设计要点（对应验收要求）：
 *  - **原始哈希防错**：apply 之前逐个核对目标文件的 sha256 必须等于 `patch-manifest.json`
 *    里的 `pristineSha256`；不一致（已是补丁版 / 上游换了产物 / 目标指错）直接拒绝，不写任何文件。
 *  - **自动备份 + 备份完整性校验**：apply 先把原文件复制到备份目录，并写 `backup-manifest.json`
 *    （sha256 + size + mode）。rollback 先校验备份文件哈希与清单一致，再做恢复。
 *  - **恢复后字节级校验**：rollback 后重新计算 sha256，必须等于 `pristineSha256`，否则报失败。
 *  - **不用 `npm --force reinstall` 作为主要回退**：回退是"从本脚本的备份恢复 + 哈希验证"。
 *  - **dry-run / apply / rollback roundtrip 可在纯本机 fixture 副本上跑**（见 `roundtrip`），
 *    证明 byte-hash 还原；`roundtrip` 只写本工作目录，不碰任何真实部署。
 *
 * 该脚本**不会**自动安装到任何真实实例；真实 13000 的安装/启用/重启仍需主 PM 的精确最终批准。
 *
 * 用法：
 *   node tools/candidate-install.mjs inspect  --target <plugin-departments-dir>
 *   node tools/candidate-install.mjs dry-run  --target <plugin-departments-dir>
 *   node tools/candidate-install.mjs apply    --target <plugin-departments-dir> [--backup-dir <dir>] [--yes]
 *   node tools/candidate-install.mjs rollback --target <plugin-departments-dir> [--backup-dir <dir>]
 *   node tools/candidate-install.mjs verify   --target <plugin-departments-dir> --expect pristine|patched
 *   node tools/candidate-install.mjs roundtrip [--work-dir <dir>]
 *
 * 退出码：0 = 成功；1 = 校验/恢复失败；2 = 参数或环境错误（缺 patch 命令、缺清单、缺目标）。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  chmodSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const patchRoot = resolve(here, '..');
const manifestPath = join(patchRoot, 'patch-manifest.json');
const roundtripTarball =
  process.env.NB_DEPARTMENTS_2_2_20_TARBALL ?? join(patchRoot, '.cache/plugin-departments-2.2.20.tgz');
const roundtripWorkDir = join(patchRoot, '.work/roundtrip');

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function fileSha256(path) {
  return sha256(readFileSync(path));
}

function fail(message, code = 1) {
  console.error(`FAIL  ${message}`);
  process.exitCode = code;
}

function info(message) {
  console.log(`  ${message}`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--yes') {
      args.yes = true;
      continue;
    }
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        args[key] = true;
        continue;
      }
      args[key] = value;
      index += 1;
      continue;
    }
    args._.push(token);
  }
  return args;
}

function loadManifest() {
  if (!existsSync(manifestPath)) {
    fail(`缺少补丁清单：${manifestPath}（先运行 tools/verify-2.2.20-candidate.mjs）`, 2);
    return null;
  }
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

function patchFileOf(manifest) {
  return join(patchRoot, manifest.patchFile);
}

/** 目标是否是 `@nocobase/plugin-departments` 包根。 */
function assertTargetShape(target) {
  const pkgJson = join(target, 'package.json');
  if (!existsSync(pkgJson)) {
    fail(`目标目录没有 package.json：${target}`, 2);
    return null;
  }
  const pkg = JSON.parse(readFileSync(pkgJson, 'utf8'));
  return pkg;
}

function classifyFiles(target, manifest) {
  const state = {};
  for (const [rel, entry] of Object.entries(manifest.files)) {
    const path = join(target, rel.replace(/^package\//, ''));
    if (!existsSync(path)) {
      state[rel] = { present: false, sha256: null, verdict: 'missing' };
      continue;
    }
    const hash = fileSha256(path);
    const verdict =
      hash === entry.pristineSha256 ? 'pristine' : hash === entry.patchedSha256 ? 'patched' : 'unknown';
    state[rel] = { present: true, path, sha256: hash, verdict };
  }
  return state;
}

function overallVerdict(state) {
  const verdicts = Object.values(state).map((item) => item.verdict);
  if (verdicts.every((item) => item === 'pristine')) return 'pristine';
  if (verdicts.every((item) => item === 'patched')) return 'patched';
  if (verdicts.includes('missing')) return 'incomplete';
  return 'mixed-or-unknown';
}

function checkPatchBinary() {
  try {
    execFileSync('patch', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    fail('本机缺少 `patch` 命令；本候选的 dry-run/apply/rollback 依赖它（回退不依赖 npm --force）。', 2);
    return false;
  }
}

function runPatch(target, patchFile, extraArgs = []) {
  return execFileSync('patch', ['-p1', '-d', target, ...extraArgs, '-i', patchFile], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function commandInspect(args) {
  const manifest = loadManifest();
  if (!manifest) return;
  const target = resolve(args.target ?? '');
  if (!args.target) return fail('inspect 需要 --target <plugin-departments-dir>', 2);
  const pkg = assertTargetShape(target);
  if (!pkg) return;
  const state = classifyFiles(target, manifest);
  console.log(`目标：${target}`);
  console.log(`包：${pkg.name}@${pkg.version}`);
  console.log(`候选：${manifest.package}（tarball sha256 ${manifest.tarballSha256.slice(0, 12)}…）`);
  for (const [rel, item] of Object.entries(state)) {
    console.log(`  ${item.verdict.padEnd(9)} ${item.sha256 ?? '(缺失)'}  ${rel}`);
  }
  console.log(`整体：${overallVerdict(state)}`);
  if (pkg.name !== '@nocobase/plugin-departments') fail(`目标包名不是 @nocobase/plugin-departments：${pkg.name}`, 1);
  if (pkg.version !== '2.2.20') {
    info(`注意：包版本是 ${pkg.version}，不是候选针对的 2.2.20；锚点按 2.2.20 发布产物逐字节匹配，请勿据此声称适用。`);
  }
}

function commandVerify(args) {
  const manifest = loadManifest();
  if (!manifest) return;
  if (!args.target) return fail('verify 需要 --target <plugin-departments-dir>', 2);
  const expect = args.expect;
  if (expect !== 'pristine' && expect !== 'patched') return fail('verify 需要 --expect pristine|patched', 2);
  const state = classifyFiles(resolve(args.target), manifest);
  const verdict = overallVerdict(state);
  console.log(`verify：期望 ${expect}，实际 ${verdict}`);
  if (verdict !== expect) {
    for (const [rel, item] of Object.entries(state)) console.log(`  ${item.verdict}  ${rel}`);
    return fail(`目标状态不是 ${expect}`, 1);
  }
}

function commandDryRun(args) {
  const manifest = loadManifest();
  if (!manifest) return;
  if (!args.target) return fail('dry-run 需要 --target <plugin-departments-dir>', 2);
  if (!checkPatchBinary()) return;
  const target = resolve(args.target);
  const state = classifyFiles(target, manifest);
  const verdict = overallVerdict(state);
  if (verdict !== 'pristine') {
    return fail(`dry-run 前目标必须是 pristine，实际 ${verdict}（拒绝在已改/未知文件上试补丁）`, 1);
  }
  try {
    const output = runPatch(target, patchFileOf(manifest), ['--dry-run']);
    console.log(`dry-run OK（patch -p1 --dry-run 退出码 0）`);
    for (const line of output.trim().split('\n')) info(line);
  } catch (error) {
    fail(`dry-run 失败（退出码 ${error.status}）：\n${error.stdout ?? ''}${error.stderr ?? ''}`, 1);
  }
}

function commandApply(args) {
  const manifest = loadManifest();
  if (!manifest) return;
  if (!args.target) return fail('apply 需要 --target <plugin-departments-dir>', 2);
  if (!checkPatchBinary()) return;
  const target = resolve(args.target);
  const backupDir = resolve(args['backup-dir'] ?? join(target, `.crewloom-default-model-backup-${Date.now()}`));
  const state = classifyFiles(target, manifest);
  const verdict = overallVerdict(state);
  if (verdict !== 'pristine') {
    return fail(
      `apply 前目标文件的 sha256 必须全部等于清单里的 pristineSha256，实际 ${verdict}；已中止，未写入任何文件。`,
      1,
    );
  }
  if (!args.yes) {
    console.log('apply 需要显式 --yes 才会写入。将要执行：');
    console.log(`  patch -p1 -d ${target} -i ${patchFileOf(manifest)}`);
    console.log(`  备份目录：${backupDir}`);
    return;
  }
  mkdirSync(backupDir, { recursive: true });
  const backup = { generatedAt: new Date().toISOString(), target, patchFile: manifest.patchFile, files: {} };
  for (const [rel, entry] of Object.entries(manifest.files)) {
    const relInner = rel.replace(/^package\//, '');
    const source = join(target, relInner);
    const dest = join(backupDir, relInner);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(source, dest);
    const mode = statSync(source).mode & 0o777;
    chmodSync(dest, mode);
    backup.files[rel] = {
      path: relInner,
      pristineSha256: entry.pristineSha256,
      backupSha256: fileSha256(dest),
      size: statSync(dest).size,
      mode: mode.toString(8),
    };
  }
  writeFileSync(join(backupDir, 'backup-manifest.json'), `${JSON.stringify(backup, null, 2)}\n`);
  console.log(`已备份 ${Object.keys(backup.files).length} 个原文件 → ${backupDir}`);

  try {
    const output = runPatch(target, patchFileOf(manifest));
    for (const line of output.trim().split('\n')) info(line);
  } catch (error) {
    fail(`patch 应用失败（退出码 ${error.status}），立即从备份恢复：\n${error.stdout ?? ''}${error.stderr ?? ''}`, 1);
    return restoreFromBackup(target, backupDir);
  }
  const after = classifyFiles(target, manifest);
  const afterVerdict = overallVerdict(after);
  if (afterVerdict !== 'patched') {
    fail(`应用后哈希校验未通过（实际 ${afterVerdict}），立即从备份恢复。`, 1);
    return restoreFromBackup(target, backupDir);
  }
  console.log(`apply OK：目标文件 sha256 等于清单里的 patchedSha256。`);
  console.log(`回退命令：node tools/candidate-install.mjs rollback --target ${target} --backup-dir ${backupDir}`);
}

function restoreFromBackup(target, backupDir) {
  const manifestFile = join(backupDir, 'backup-manifest.json');
  if (!existsSync(manifestFile)) {
    return fail(`备份清单缺失：${manifestFile}；拒绝用 npm --force reinstall 作为回退。`, 1);
  }
  const backup = JSON.parse(readFileSync(manifestFile, 'utf8'));
  for (const [rel, entry] of Object.entries(backup.files)) {
    const source = join(backupDir, entry.path);
    if (!existsSync(source)) return fail(`备份文件缺失：${source}`, 1);
    const hash = fileSha256(source);
    if (hash !== entry.backupSha256) return fail(`备份文件哈希不一致：${source}`, 1);
    const dest = join(target, entry.path);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(source, dest);
    chmodSync(dest, parseInt(entry.mode, 8));
    const restored = fileSha256(dest);
    if (restored !== entry.pristineSha256) {
      return fail(`恢复后字节校验失败：${dest}（${restored} ≠ ${entry.pristineSha256}）`, 1);
    }
  }
  console.log(`rollback OK：${Object.keys(backup.files).length} 个文件已按备份恢复，sha256 与原始一致。`);
}

function commandRollback(args) {
  const manifest = loadManifest();
  if (!manifest) return;
  if (!args.target) return fail('rollback 需要 --target <plugin-departments-dir>', 2);
  const target = resolve(args.target);
  const backupDir = args['backup-dir']
    ? resolve(args['backup-dir'])
    : null;
  if (!backupDir) {
    return fail(
      'rollback 需要 --backup-dir（apply 时打印的那个目录）。本候选不使用 npm --force reinstall 作为回退。',
      2,
    );
  }
  restoreFromBackup(target, backupDir);
  const state = classifyFiles(target, manifest);
  console.log(`rollback 后整体状态：${overallVerdict(state)}`);
}

/**
 * 纯本机 fixture 往返：解包 → dry-run → apply → 校验 patched → rollback → 校验字节级还原到 pristine。
 * 只写 `--work-dir`（缺省 `<patchRoot>/.work/roundtrip`，已被忽略）。不接触任何真实部署。
 */
function commandRoundtrip(args) {
  const manifest = loadManifest();
  if (!manifest) return;
  if (!checkPatchBinary()) return;
  if (!existsSync(roundtripTarball)) {
    return fail(`缺少 fixture 用发布包：${roundtripTarball}`, 2);
  }
  const tarballHash = fileSha256(roundtripTarball);
  console.log(`fixture 发布包 sha256：${tarballHash}（清单 ${manifest.tarballSha256}）`);
  console.log(`  ${tarballHash === manifest.tarballSha256 ? '一致' : '不一致'}`);
  if (tarballHash !== manifest.tarballSha256) return fail('发布包哈希与清单不一致', 1);

  const workDir = resolve(args['work-dir'] ?? roundtripWorkDir);
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  const fixture = join(workDir, 'plugin-departments');
  mkdirSync(fixture, { recursive: true });
  execFileSync('tar', ['-xzf', roundtripTarball, '-C', fixture], { stdio: 'inherit' });
  const target = join(fixture, 'package');

  const before = classifyFiles(target, manifest);
  console.log(`1) 解包后状态：${overallVerdict(before)}`);
  if (overallVerdict(before) !== 'pristine') return fail('fixture 解包后不是 pristine', 1);

  commandDryRun({ target });
  if (process.exitCode) return;

  const backupDir = join(workDir, 'backup');
  commandApply({ target, 'backup-dir': backupDir, yes: true });
  if (process.exitCode) return;
  if (overallVerdict(classifyFiles(target, manifest)) !== 'patched') return fail('apply 后不是 patched', 1);

  commandRollback({ target, 'backup-dir': backupDir });
  if (process.exitCode) return;
  const after = classifyFiles(target, manifest);
  const restoredByteIdentical = Object.entries(after).every(
    ([rel, item]) => item.sha256 === manifest.files[rel].pristineSha256,
  );
  console.log(`4) rollback 后状态：${overallVerdict(after)}；byte-hash 还原=${restoredByteIdentical}`);
  if (overallVerdict(after) !== 'pristine' || !restoredByteIdentical) {
    return fail('roundtrip 未能字节级还原', 1);
  }
  console.log('roundtrip OK：dry-run / apply / rollback 全通过，目标文件 sha256 回到 pristine。');
}

/**
 * `plan`：打印"安装/启用原生插件 +（可选）应用兼容补丁"的**计划、前置条件与回退步骤**。
 * 纯打印，不写任何东西（真实 13000 的安装/启用/重启仍需主 PM 的精确最终批准）。
 */
function commandPlan() {
  const manifest = loadManifest();
  if (!manifest) return;
  const checkPath = join(patchRoot, 'department-candidate-check.json');
  const check = existsSync(checkPath) ? JSON.parse(readFileSync(checkPath, 'utf8')) : null;
  const source = check?.steps?.sourceEvidence ?? null;
  const pluginState = source?.pluginState ?? null;
  const departmentsPlugin = Array.isArray(pluginState) ? pluginState.find((item) => item.packageName === '@nocobase/plugin-departments') : null;
  const plan = source?.pluginSchemaPlan ?? null;

  console.log('NocoBase 2.2.20 部门候选：安装 / 回退计划（只打印，不执行）');
  console.log('');
  console.log('A. 目标与现状（来自真实 13000 只读核对）');
  console.log(`   目标版本：${source?.targetVersion ?? '(未取到，先运行 tools/live-13000-departments-readonly.mjs)'}`);
  console.log(`   @nocobase/plugin-departments：${departmentsPlugin ? `enabled=${departmentsPlugin.enabled} installed=${departmentsPlugin.installed} isCompatible=${departmentsPlugin.isCompatible}` : '(未取到)'}`);
  console.log(`   现有 departments 集合：${source?.realSchema?.departmentsCollection?.template ?? '?'} / titleField=${source?.realSchema?.departmentsCollection?.titleField ?? '?'} / ${source?.realSchema?.structure?.total ?? '?'} 行（root ${source?.realSchema?.structure?.rootCount ?? '?'}）`);
  console.log(`   关联读取现状：${JSON.stringify((source?.realSchema?.associationProbes ?? []).map((probe) => [probe.label, probe.status]))}`);
  console.log('');
  console.log('B. 计划变更');
  console.log('   B1（必做）：安装并启用原生 @nocobase/plugin-departments@2.2.20');
  console.log(`       · 注册 departments 集合定义：template=${plan?.departmentsCollection?.template} tree=${plan?.departmentsCollection?.tree} sortable=${plan?.departmentsCollection?.sortable}`);
  console.log(`       · 插件新增字段：${JSON.stringify(plan?.addedFields ?? [])}`);
  console.log(`       · 现有自定义字段（插件不会定义，预期保留）：${JSON.stringify(plan?.preservedCustomFields ?? [])}`);
  console.log(`       · users 扩展：${JSON.stringify((plan?.usersExtendFields ?? []).map((field) => field.name))}`);
  console.log(`       · 新增 through 集合：departmentsUsers（isOwner/isMain）、departmentsRoles`);
  console.log('   B2（可选，建议）：应用 department-compat-2.2.20.patch（仅 1 个文件：缓存失效一致性）');
  console.log(`       补丁 sha256=${manifest.patchSha256}，${manifest.patchBytes} 字节`);
  console.log('');
  console.log('C. 安装前置条件（必须逐项核实并写进安装记录）');
  console.log('   1) 数据库备份可用且已校验（pg_dump / 平台备份），并记录备份完成时间与校验方式');
  console.log('   2) 只读 schema 快照：collections/departments/fields + 行数（便于回退后比对）');
  console.log('   3) 隔离实例先试：同版本、同自定义 schema 的实例上跑一遍 enable/disable');
  console.log('   4) migrationRules 语义门禁：发布产物中未找到解释 migrationRules 的执行代码（见 sourceEvidence.upstreamFacts），');
  console.log('      因此**不能**仅凭静态分析宣称"启用一定不覆盖现有字段"；隔离实例试完再评估');
  console.log('   5) 容器内 @nocobase/plugin-departments 包根路径与权限（B2 需要可写）');
  console.log('   6) 应用重启方式与允许窗口');
  console.log('');
  console.log('D. 回退步骤');
  console.log('   D1 B2 补丁：node tools/candidate-install.mjs rollback --target <plugin-departments-dir> --backup-dir <备份目录>，然后重启');
  console.log('   D2 插件启用：disable 插件（回到 enabled=false）；如需彻底回到变更前结构，用 A 的数据库备份恢复');
  console.log('   D3 **禁止**用 `npm i --force` 作为主要回退；它没有备份与哈希校验');
  console.log('');
  console.log('E. 本组不做');
  console.log('   不安装、不启用、不改数据库、不重启、不 SSH；以上均待主 PM 精确最终批准。');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const commands = {
    inspect: commandInspect,
    verify: commandVerify,
    'dry-run': commandDryRun,
    apply: commandApply,
    rollback: commandRollback,
    roundtrip: commandRoundtrip,
    plan: commandPlan,
  };
  if (!command || !commands[command]) {
    console.error(
      '用法：candidate-install.mjs <plan|inspect|dry-run|apply|rollback|verify|roundtrip> [--target <dir>] [--backup-dir <dir>] [--expect pristine|patched] [--yes]',
    );
    process.exitCode = 2;
    return;
  }
  if (command === 'roundtrip') {
    commandRoundtrip(args);
    return;
  }
  commands[command](args);
}

main();
