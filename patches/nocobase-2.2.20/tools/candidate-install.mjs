#!/usr/bin/env node
/**
 * NocoBase 2.2.20 全局默认模型候选：**安装 / 回退** 工具（本脚本本身不联网、不装包）。
 *
 * 设计要点（对应验收要求）：
 *  - **原始哈希防错**：apply 之前逐个核对三个目标文件的 sha256 必须等于 `patch-manifest.json`
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
 *   node tools/candidate-install.mjs inspect  --target <plugin-ai-dir>
 *   node tools/candidate-install.mjs dry-run  --target <plugin-ai-dir>
 *   node tools/candidate-install.mjs apply    --target <plugin-ai-dir> [--backup-dir <dir>] [--yes]
 *   node tools/candidate-install.mjs rollback --target <plugin-ai-dir> [--backup-dir <dir>]
 *   node tools/candidate-install.mjs verify   --target <plugin-ai-dir> --expect pristine|patched
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
const roundtripTarball = process.env.NB_AI_2_2_20_TARBALL ?? join(patchRoot, '.cache/plugin-ai-2.2.20.tgz');
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

/** 目标是否是 `@nocobase/plugin-ai` 包根（含三个待补文件）。 */
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
  if (!args.target) return fail('inspect 需要 --target <plugin-ai-dir>', 2);
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
  if (pkg.name !== '@nocobase/plugin-ai') fail(`目标包名不是 @nocobase/plugin-ai：${pkg.name}`, 1);
  if (pkg.version !== '2.2.20') {
    info(`注意：包版本是 ${pkg.version}，不是候选针对的 2.2.20；锚点按 2.2.20 发布产物逐字节匹配，请勿据此声称适用。`);
  }
}

function commandVerify(args) {
  const manifest = loadManifest();
  if (!manifest) return;
  if (!args.target) return fail('verify 需要 --target <plugin-ai-dir>', 2);
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
  if (!args.target) return fail('dry-run 需要 --target <plugin-ai-dir>', 2);
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
  if (!args.target) return fail('apply 需要 --target <plugin-ai-dir>', 2);
  if (!checkPatchBinary()) return;
  const target = resolve(args.target);
  const backupDir = resolve(args['backup-dir'] ?? join(target, `.crewloom-default-model-backup-${Date.now()}`));
  const state = classifyFiles(target, manifest);
  const verdict = overallVerdict(state);
  if (verdict !== 'pristine') {
    return fail(
      `apply 前三个目标文件的 sha256 必须全部等于清单里的 pristineSha256，实际 ${verdict}；已中止，未写入任何文件。`,
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
  console.log(`apply OK：三个文件 sha256 全部等于清单里的 patchedSha256。`);
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
  if (!args.target) return fail('rollback 需要 --target <plugin-ai-dir>', 2);
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
  const fixture = join(workDir, 'plugin-ai');
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
  console.log('roundtrip OK：dry-run / apply / rollback 全通过，三文件 sha256 回到 pristine。');
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
  };
  if (!command || !commands[command]) {
    console.error(
      '用法：candidate-install.mjs <inspect|dry-run|apply|rollback|verify|roundtrip> [--target <dir>] [--backup-dir <dir>] [--expect pristine|patched] [--yes]',
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
