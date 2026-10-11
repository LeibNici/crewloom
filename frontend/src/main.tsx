/**
 * 浏览器侧的 `process` 最小垫片。
 *
 * 为什么放在应用入口：固定源码的原生客户端闭包（`vendor/nocobase-2.2.22/**`）会经过
 * 一些 Node 生态包（实测 `picomatch/lib/utils.js`），它们在浏览器里直接读 `process.platform`，
 * 不垫片就抛 `ReferenceError: process is not defined`，原生 ChatBox 无法装载。
 * 只补最小字段，不模拟 Node；已存在时不动。
 */
const globalWithProcess = globalThis as unknown as { process?: Record<string, unknown> };
if (!globalWithProcess.process) {
  globalWithProcess.process = {
    env: {},
    platform: 'browser',
    versions: {},
    nextTick: (callback: (...args: unknown[]) => void, ...args: unknown[]) =>
      setTimeout(() => callback(...args), 0),
  };
}

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/theme.css';
import './styles/app.css';

const container = document.getElementById('root');
if (!container) throw new Error('未找到应用挂载节点 #root');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
