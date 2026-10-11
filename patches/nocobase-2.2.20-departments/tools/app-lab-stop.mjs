#!/usr/bin/env node
/**
 * 收尾本组自建的本机受控环境：停止 `app-http-chain.mjs` 预览进程与本组临时 PostgreSQL。
 * 只结束**本组**启动的进程（PID 来自 `final-backend-http-evidence/preview.json`），
 * 不碰其他工作树/旧预览。真实 13000/13080 不涉及。
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { APP_PORT, PG_PORT, WORK, evidenceDir, pgIsRunning, pgStop } from './app-lab.mjs';

const previewFile = join(evidenceDir(), 'preview.json');
let preview = null;
if (existsSync(previewFile)) {
  preview = JSON.parse(readFileSync(previewFile, 'utf8'));
  const pid = Number(preview.pid);
  if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`[app-lab-stop] 已请求停止预览进程 PID=${pid}`);
    } catch (error) {
      console.log(`[app-lab-stop] 预览进程 PID=${pid} 不可停止（可能已退出）：${error.code}`);
    }
  }
  rmSync(previewFile, { force: true });
} else {
  console.log('[app-lab-stop] 未找到 preview.json，跳过预览进程');
}

const wasRunning = pgIsRunning();
const stopped = pgStop();
console.log(`[app-lab-stop] PostgreSQL ${PG_PORT} 原运行=${wasRunning} 本次停止=${stopped}`);

// 端口复查
const { execFileSync } = await import('node:child_process');
for (const port of [APP_PORT, PG_PORT]) {
  try {
    const out = execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
    console.log(`[app-lab-stop] 端口 ${port} 仍在监听：\n${out.trim()}`);
  } catch {
    console.log(`[app-lab-stop] 端口 ${port} 已无监听`);
  }
}
