#!/usr/bin/env node
/**
 * 证据脱敏：把含**真实业务标识**的原始证据留在本机 `raw/`（git 忽略），
 * 生成可提交的脱敏版到 `final-native-workflow-evidence/<同名>`。
 *
 * 为什么需要：`instruction-matrix-13000.json` 的 `typesByWorkflow` 带真实流程 id，
 * 真实只读画布证据的 `canvasHref` / `probe.hostText` 带真实流程 id 与流程/节点名称，
 * WF-05 证据带真实执行 id。这些属于真实业务数据，按项目约定不入库。
 *
 * 规则（结构化 + 兜底扫描）：
 *  - 结构化：按字段逐项替换/删除，并写 `redaction` 说明改了什么；
 *  - 兜底：把 15 位、以 `3907` 开头的流程 id 与以 `3911` 开头的执行 id 统一替换为占位符；
 *  - 脱敏后**再自检一次**：命中真实标识就报错退出（避免漏网）。
 *
 * 幂等：原始文件首次运行时被复制到 `raw/`；之后重复运行从 `raw/` 读取，不会二次脱敏。
 *
 * 用法：`node scripts/redact-native-workflow-evidence.mjs`
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const DIR = resolve(repoRoot, 'docs/acceptance/full-pages-13000/final-native-workflow-evidence');
const RAW_DIR = join(DIR, 'raw');

const REAL_WORKFLOW_ID = /3907\d{11}/g;
const REAL_EXECUTION_ID = /3911\d{11}/g;
const WORKFLOW_PLACEHOLDER = '<real-workflow-id>';
const EXECUTION_PLACEHOLDER = '<real-execution-id>';

const FILES = [
  'instruction-matrix-13000.json',
  'native-canvas-registry-5311.json',
  'native-canvas-registry-5312.json',
  'native-canvas-registry-5315.json',
  'wf05-jobs-attribution.json',
  'controlled-ids-absent-on-real.json',
];

function sweep(value) {
  if (typeof value === 'string') {
    return value.replace(REAL_WORKFLOW_ID, WORKFLOW_PLACEHOLDER).replace(REAL_EXECUTION_ID, EXECUTION_PLACEHOLDER);
  }
  if (Array.isArray(value)) return value.map(sweep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sweep(item)]));
  }
  return value;
}

function redactInstructionMatrix(raw) {
  const out = { ...raw };
  const perWorkflow = out.typesByWorkflow ?? {};
  delete out.typesByWorkflow;
  out.typesByWorkflowSummary = {
    workflowVersionsWithNodes: Object.keys(perWorkflow).length,
    distinctTypeSets: new Set(Object.values(perWorkflow).map((types) => JSON.stringify([...types].sort()))).size,
  };
  out.redaction = {
    removed: ['typesByWorkflow（真实流程 id → 节点类型 的逐版本映射）'],
    replaced: ['15 位真实流程/执行 id → 占位符'],
    rawLocalOnly: 'raw/instruction-matrix-13000.json（本机保留，不入库）',
    kept: ['流程/节点总数、类型分布、插件 enabled 清单、请求计数（均为聚合统计，不含业务记录正文）'],
  };
  return out;
}

function redactRegistry(raw, name) {
  const out = { ...raw };
  out.canvasHref = '/workflow/canvas?workflowId=<real-workflow-id>';
  if (out.probe && typeof out.probe === 'object') {
    out.probe = {
      hasHost: out.probe.hasHost ?? null,
      hasCanvas: out.probe.hasCanvas ?? null,
      nodeCount: out.probe.nodeCount ?? null,
      addButtonCount: out.probe.addButtonCount ?? null,
      canvasNodePresent: out.probe.canvasNodePresent ?? null,
      failedText: null,
      hostTextRedacted: true,
      note: '真实画布文本（流程名/节点名）已删除；仅保留计数与结构布尔值。',
    };
  }
  out.redaction = {
    removed: ['canvasHref 中的真实流程 id', 'probe.hostText（真实流程名/节点名）'],
    kept: ['原生 registry 的 instruction/trigger 类型清单、计数、截图路径（本机 .shots，不入库）'],
    rawLocalOnly: `raw/${name}（本机保留，不入库）`,
  };
  return out;
}

function redactWf05(raw) {
  const out = { ...raw };
  if (out.realReadonly) {
    const executions = (out.realReadonly.executions ?? []).map((item, index) => ({
      execution: `execution-${index + 1}`,
      filterCount: item.filterCount,
      status: item.status,
      filter: { executionId: '<real-execution-id>' },
      note: '真实执行 id 已脱敏；只保留该执行的 job 计数。',
    }));
    out.realReadonly = {
      ...out.realReadonly,
      executions,
      globalUnfiltered: out.realReadonly.globalUnfiltered
        ? { ...out.realReadonly.globalUnfiltered, note: out.realReadonly.globalUnfiltered.note }
        : null,
    };
  }
  out.redaction = {
    replaced: ['真实执行 id → execution-1/2 与占位符'],
    kept: ['全局 job 计数、按执行过滤的计数、受控隔离结果、源码口径'],
    rawLocalOnly: 'raw/wf05-jobs-attribution.json（本机保留，不入库）',
  };
  return out;
}

function redactControlledIds(raw) {
  const out = { ...raw };
  out.redaction = {
    replaced: ['对照用真实流程 id → 占位符（该请求只用于证明受控 id 在真实实例上不存在）'],
    kept: ['受控 id 的状态码与 data=null 结论'],
    rawLocalOnly: 'raw/controlled-ids-absent-on-real.json（本机保留，不入库）',
  };
  return out;
}

function main() {
  mkdirSync(RAW_DIR, { recursive: true });
  // raw/ 目录入库一个 .gitignore（`*` 忽略目录内全部文件，`!.gitignore` 让规则本身可提交），
  // 保证原始证据永远不被提交，同时规则随仓库存在。
  writeFileSync(join(RAW_DIR, '.gitignore'), '*\n!.gitignore\n');

  for (const name of FILES) {
    const canonical = join(DIR, name);
    const rawPath = join(RAW_DIR, name);
    // 原始副本缺失、或规范路径上是**新写入的原始证据**（没有 redaction 标记）→ 复制到 raw/。
    // 这样重跑核对脚本后会重新脱敏，而不是一直用第一次的旧副本。
    let canonicalIsRedacted = false;
    if (existsSync(canonical)) {
      try {
        canonicalIsRedacted = Boolean(JSON.parse(readFileSync(canonical, 'utf8')).redaction);
      } catch {
        canonicalIsRedacted = false;
      }
    }
    if (!existsSync(rawPath) || !canonicalIsRedacted) {
      if (!existsSync(canonical)) {
        console.error(`缺少原始证据：${canonical}`);
        process.exitCode = 2;
        return;
      }
      copyFileSync(canonical, rawPath);
    }
    const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
    let redacted;
    if (name.startsWith('instruction-matrix')) redacted = redactInstructionMatrix(raw);
    else if (name.startsWith('native-canvas-registry')) redacted = redactRegistry(raw, name);
    else if (name.startsWith('wf05')) redacted = redactWf05(raw);
    else redacted = redactControlledIds(raw);

    const text = JSON.stringify(sweep(redacted), null, 2);
    if (REAL_WORKFLOW_ID.test(text) || REAL_EXECUTION_ID.test(text)) {
      console.error(`脱敏后仍命中真实标识：${name}`);
      process.exitCode = 1;
      return;
    }
    writeFileSync(canonical, `${text}\n`);
    console.log(`脱敏完成：${name} → 原始保留在 raw/${name}`);
  }
}

main();
