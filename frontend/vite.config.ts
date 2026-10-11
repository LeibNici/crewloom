import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideApiRequest, TRANSPORT_POLICY, type TransportMode } from './src/api/policy';
import { nativeComponentAliases } from './vendor/nocobase-shims/native-aliases.mjs';
import { nativeDynamicImportFix } from './vendor/nocobase-shims/native-dynamic-import.mjs';
import { createControlledAiMiddleware } from './scripts/lib/controlled-ai-middleware.mjs';
import { createControlledWorkflowMiddleware } from './scripts/lib/controlled-workflow-middleware.mjs';
import { nocobaseUtilsResolver } from './vendor/nocobase-shims/native-utils-resolver.mjs';

/**
 * 开发/预览服务器。
 *
 * 目标后端固定为 Crewloom 的默认数据源实例：`http://172.16.88.250:13000`（NocoBase 2.2.20）。
 * 代理只转发到该固定地址，不做任意地址转发，不放宽后端校验。可用
 * `CREWLOOM_BACKEND_ORIGIN` 临时覆盖（仅限本轮目标实例，用于本地受控实验）。
 *
 * 该实例对 auth:signIn 做可信来源校验（Origin 不属于可信列表直接 403）。
 * 本地开发地址（http://127.0.0.1:<port>）不在实例可信来源内，因此代理去掉浏览器发出的
 * Origin 头，让请求按服务端到服务端的方式抵达；未修改 250 上的任何配置。
 *
 * 传输策略分两档（见 src/api/transport-policy.json 与 src/api/policy.ts）：
 *  - `product`（缺省）：正常用户使用，只固定目的地与 /api 前缀，动作由后端认证与 ACL 判定；
 *  - `strict`：Agent 自动验证，默认拒绝并硬拦有外部副作用的动作。
 * 用 `CREWLOOM_TRANSPORT_MODE=strict` 启动即同时收紧**浏览器端**与**服务器中间件**。
 */
const BACKEND_ORIGIN = process.env.CREWLOOM_BACKEND_ORIGIN ?? TRANSPORT_POLICY.backendOrigin;

const TRANSPORT_MODE: TransportMode =
  process.env.CREWLOOM_TRANSPORT_MODE === 'strict' ? 'strict' : 'product';

const EVIDENCE_PATH = fileURLToPath(
  new URL('../docs/acceptance/full-pages-13000/evidence/transport-audit.jsonl', import.meta.url),
);

function record(entry: Record<string, unknown>) {
  try {
    mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
    appendFileSync(
      EVIDENCE_PATH,
      `${JSON.stringify({ at: new Date().toISOString(), mode: TRANSPORT_MODE, ...entry })}\n`,
    );
  } catch {
    /* 证据写入失败不影响服务本身 */
  }
}

/**
 * 服务器侧策略中间件：与浏览器 axios 拦截器、Node 验证脚本共用同一份策略
 * （`src/api/policy.ts`）。每条请求只记录 method / path / action / 结论 / 状态码，
 * 不记录凭据、请求头或响应正文。
 */
function transportGuardPlugin(): Plugin {
  const middleware = (req: { method?: string; url?: string }, res: any, next: () => void) => {
    const url = req.url ?? '';
    const pathname = url.split('?')[0];
    if (!pathname.startsWith(TRANSPORT_POLICY.apiPathPrefix)) return next();
    const method = req.method ?? 'GET';
    // 服务端中间件天然同源，不做来源校验；只判定方法与动作。
    // **必须带上查询串**：像 `aiConversations:getMessages?updateRead=true` 这类动作的写副作用
    // 判定依赖查询参数（见 policy.ts 的同名守卫），丢掉 ? 会让守卫失效。
    const decision = decideApiRequest({ method, url: `http://127.0.0.1${url}`, mode: TRANSPORT_MODE });
    if (decision.decision === 'blocked') {
      record({ ...decision, status: 403 });
      res.statusCode = 403;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(
        JSON.stringify({
          errors: [{ code: 'TRANSPORT_BLOCKED', message: 'blocked by crewloom transport policy' }],
        }),
      );
      return;
    }
    const originalEnd = res.end.bind(res);
    res.end = (...args: unknown[]) => {
      record({ ...decision, status: res.statusCode });
      return originalEnd(...args);
    };
    return next();
  };

  return {
    name: 'crewloom-transport-guard',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

/**
 * `@nocobase/utils` 的按引用方解析（规则与原因见 vendor/nocobase-shims/native-utils-resolver.mjs）：
 *  - `@nocobase/sdk` → 最小适配包（保持 P0 的轻量，实测产品包 249 个模块 / ~600 kB）；
 *  - `vendor/nocobase-2.2.22/**` 的原生源码 → 完整包（需要 `Registry` 等）。
 */
/**
 * 受控 AI 后端中间件（只在 `CREWLOOM_CONTROLLED_AI=1` 时挂载）。
 *
 * 挂在传输守卫**之前**：受控动作在本机直接应答，不落到真实后端，也不被 strict 守卫当作写动作拦截。
 * 其余 `/api` 请求原样交给传输守卫与真实代理（正常登录 + 精准只读）。
 */
function controlledAiPlugin(): Plugin | null {
  if (process.env.CREWLOOM_CONTROLLED_AI !== '1') return null;
  const middleware = createControlledAiMiddleware();
  return {
    name: 'crewloom-controlled-ai',
    configureServer(server) {
      server.middlewares.use(middleware as never);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware as never);
    },
  };
}

/**
 * 受控工作流后端中间件（只在 `CREWLOOM_CONTROLLED_WORKFLOW=1` 时挂载）。
 *
 * 给**真实原生画布 UI** 提供可写的本机后端：`workflows/<版本>/nodes:create` 与
 * `flow_nodes:update|move|duplicate|destroy|destroyBranch|test` 都由 UI 自己发出、在本机应答，
 * 请求不会到达真实 13000（真实实例仍是正常登录 + 精准只读）。
 *
 * 同样挂在传输守卫**之前**：否则 `flow_nodes:test` 会在到达受控中间件前就被 strict 守卫拦掉。
 */
function controlledWorkflowPlugin(): Plugin | null {
  if (process.env.CREWLOOM_CONTROLLED_WORKFLOW !== '1') return null;
  const middleware = createControlledWorkflowMiddleware();
  return {
    name: 'crewloom-controlled-workflow',
    configureServer(server) {
      server.middlewares.use(middleware as never);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware as never);
    },
  };
}

function nocobaseUtils(): Plugin {
  return nocobaseUtilsResolver({
    lightShim: fileURLToPath(new URL('./vendor/nocobase-utils-client/client.js', import.meta.url)),
    nativeShim: fileURLToPath(new URL('./vendor/nocobase-shims/nocobase-utils-native.ts', import.meta.url)),
  });
}

/**
 * 上游真正断开时要结束**浏览器侧**响应。
 *
 * 实测（本机 fixture 复现）：中途 `res.destroy()` 后，直连 fixture 的读流 143ms 内以
 * `TypeError: terminated` 结束；经 Vite 代理（http-proxy）却**永远不结束** —— 页面因此一直停在
 * “正在生成”，既没有断线说明、也不会结算。http-proxy 默认只中止 pipe，不结束客户端响应，
 * 这里把上游的 `aborted` / `error` 显式转成客户端连接关闭，让浏览器拿到真实网络中断
 * （产品侧据此收敛为“连接中断 + 保留已收到内容”）。
 */
function propagateUpstreamAbort(proxy: {
  on: (event: string, handler: (...args: unknown[]) => void) => void;
}): void {
  const closeClient = (res: unknown) => {
    const candidate = res as { destroy?: () => void; writableEnded?: boolean } | undefined;
    if (candidate && typeof candidate.destroy === 'function' && !candidate.writableEnded) candidate.destroy();
  };
  proxy.on('proxyRes', (...args: unknown[]) => {
    const proxyRes = args[0] as { on: (event: string, handler: () => void) => void };
    const res = args[2];
    proxyRes.on('aborted', () => closeClient(res));
    proxyRes.on('error', () => closeClient(res));
  });
  proxy.on('error', (...args: unknown[]) => {
    closeClient(args[2]);
  });
}

const devProxy: Record<string, ProxyOptions> = {
  '/api': {
    target: BACKEND_ORIGIN,
    changeOrigin: false,
    secure: false,
    configure: (proxy) => {
      proxy.on('proxyReq', (proxyReq) => {
        // 去掉来源相关头，避免触发服务端可信来源校验失败（403 Invalid sign-in origin）。
        proxyReq.removeHeader('origin');
        proxyReq.removeHeader('referer');
      });
      propagateUpstreamAbort(proxy as never);
    },
  },
  /**
   * 附件与标志图片的永久访问路径（file-manager 的 `/files/<app>/<dataSource>/<collection>/<id><ext>`）。
   * 它不是 `/api` 前缀，因此必须单独代理；后端对非 GET/HEAD 返回 405，代理不额外放宽。
   * 生产环境前端与后端同源，`/files` 直接由后端提供，不依赖该代理。
   */
  '/files': {
    target: BACKEND_ORIGIN,
    changeOrigin: false,
    secure: false,
    configure: (proxy) => {
      proxy.on('proxyReq', (proxyReq) => {
        proxyReq.removeHeader('origin');
        proxyReq.removeHeader('referer');
      });
    },
  },
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const port = Number(env.VITE_DEV_PORT ?? 5277);
  return {
    plugins: [
      nativeDynamicImportFix(),
      nocobaseUtils(),
      // 固定源码的原生闭包用 **TS 旧式装饰器**（`@largeField()` 等）。`@vitejs/plugin-react`
      // 在 dev 走 Babel，默认不含 decorators 插件，直接把 `.tsx` 解析成 500
      // （`Support for the experimental syntax 'decorators' isn't currently enabled`）。
      // 把 vendor 源码排除出 Babel 管线，交给 Vite 自带的 esbuild 转换
      // （装饰器/JSX 选项见 `vendor/nocobase-2.2.22/tsconfig.json`）。
      react({ exclude: [/\/node_modules\//, /\/vendor\/nocobase-2\.2\.22\//] }),
      // 顺序有意如此：受控动作先在本机应答，再轮到传输策略守卫与真实代理。
      ...(controlledAiPlugin() ? [controlledAiPlugin() as Plugin] : []),
      ...(controlledWorkflowPlugin() ? [controlledWorkflowPlugin() as Plugin] : []),
      transportGuardPlugin(),
    ],
    // 让浏览器端与服务器中间件使用同一个模式判断，避免只收紧一侧。
    define: {
      'import.meta.env.VITE_TRANSPORT_MODE': JSON.stringify(TRANSPORT_MODE),
      'import.meta.env.VITE_CONTROLLED_AI': JSON.stringify(
        process.env.CREWLOOM_CONTROLLED_AI === '1' ? '1' : '0',
      ),
      'import.meta.env.VITE_CONTROLLED_WORKFLOW': JSON.stringify(
        process.env.CREWLOOM_CONTROLLED_WORKFLOW === '1' ? '1' : '0',
      ),
    },
    resolve: {
      dedupe: ['react', 'react-dom', 'react-is'],
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        // 原生组件最小集成所需的两处替换；定义与原因见 vendor/nocobase-shims/native-aliases.mjs。
        ...nativeComponentAliases({
          vendorShimsDir: fileURLToPath(new URL('./vendor/nocobase-shims', import.meta.url)),
          vendorSourceRoot: fileURLToPath(new URL('./vendor/nocobase-2.2.22', import.meta.url)),
        }),
      },
    },
    optimizeDeps: {
      // 六个原生入口现在全部由 `resolve.alias` 指向固定源码（见 native-aliases.mjs），
      // 不再以「裸包名 → 发布产物」的形式出现；预打包只对裸包名生效，因此这里不再需要 exclude。
      // include 仍必要——原生源码闭包里的 CJS 传递依赖要先预打包才有 ESM 互操作
      // （实测：react-is@18.3.1 未预打包时报 `does not provide an export named 'ForwardRef'`）；
      // `.npmrc` 的 public-hoist-pattern=* 让这些包可从仓库根解析。
      include: ['react-is', 'classnames', 'mobx', 'mobx-react-lite', 'use-sync-external-store/shim'],
    },
    server: {
      host: '127.0.0.1',
      port,
      strictPort: true,
      proxy: devProxy,
    },
    preview: {
      host: '127.0.0.1',
      port,
      strictPort: true,
      proxy: devProxy,
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
      commonjsOptions: {
        // 原生客户端闭包里有 rspack 产出的 CJS/ESM 混合文件（含自带 require 运行时），
        // 不打开混合转换时，rollup 侧拿到的是未互操作的 `require('react')` → undefined，
        // 运行时报 `Cannot read properties of undefined (reading 'createContext')`。
        transformMixedEsModules: true,
      },
    },
  };
});
