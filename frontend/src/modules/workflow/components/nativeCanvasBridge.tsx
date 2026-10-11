import { useEffect, useState } from 'react';
import { PageCard, StatusPill } from '../../../components/Card';
import { getApiBase, getAuthContext, request, resourceList } from '../../../api/client';
import styles from '../workflow.module.css';

/**
 * 原生工作流画布的**宿主桥接契约**（组 C 独占文件）。
 *
 * 背景（为什么不是一个"假装能跑"的组件）：官方画布是
 * `@nocobase/plugin-workflow/client-v2` 的运行时（`PluginWorkflowClientV2` +
 * `Application` + Instruction registry + `WorkflowCanvas`）。它需要：
 *   1. 一整套 v2 客户端运行时依赖（`@nocobase/client-v2`、`@nocobase/flow-engine`、`antd`、Formily…）；
 *   2. `vite.config.ts` 的 5 处宿主适配（源码 alias、裸包解析、内联 tsconfigRaw、process 垫片、wasm/cytoscape alias）；
 *   3. 一个 `Application` 实例（自带 router / dataSourceManager / i18n / 主题）。
 *
 * 这些都属于**公共负责人**维护的 `frontend/package.json`、`pnpm-lock.yaml`、`vite.config.ts`、`vendor/`。
 * 本组不擅自安装依赖、不改公共配置，因此这里提供的是**精确的宿主接口 + 一个可注入的挂载点**：
 *  - 依赖就绪时，公共负责人只需在 `frontend/` 里提供一个实现该接口的模块（见 `NativeCanvasModule`），
 *    本组页面即可挂载真正原生画布；
 *  - 依赖未就绪时，页面明确显示"原生画布运行时未接入"，并**不**用顺序列表冒充原生画布。
 *
 * 认证 / 角色 / 请求桥接（最小要求）：
 *  - 认证：原生 `Application` 的 `apiClient` 必须指向产品的 `/api`，并注入**当前会话令牌**
 *    （`crewloom.session.token` 由 SDK 管理）与角色头 `X-Role`；**不得**另建第二套登录态。
 *  - 角色：角色切换必须沿用产品 `auth/store.ts` 的当前角色；原生侧不得自行改写全局角色，
 *    否则会破坏 P1 的"角色失效广播 + 会话世代"隔离。
 *  - 请求：所有出站必须经过产品 `src/api/client.ts` 的策略（product/strict 两档）与错误分类；
 *    原生 `Client` 的 axios 实例要安装同一个 transport guard，禁止绕过。
 *  - 数据：画布读流程/节点用本模块 `domain.ts` 的已实测读法（`flow_nodes:list?filter={"workflowId":N}`），
 *    保存仍走 `flow_nodes:*` / `workflows/<id>/nodes:create` 等原生动作。
 */

/** 画布宿主需要的运行时能力（由公共负责人在产品内提供）。 */
export interface NativeCanvasModule {
  /** 挂载原生画布；返回可卸载句柄。 */
  mount(options: NativeCanvasMountOptions): NativeCanvasHandle;
  /** 该实现的来源说明（例如源码入口 commit），用于页面与证据展示。 */
  readonly origin: string;
}

export interface NativeCanvasMountOptions {
  /** 画布容器。 */
  container: HTMLElement;
  /** 当前流程版本 id（= `flow_nodes.workflowId`）。 */
  workflowId: string;
  /** API 基地址（产品 `/api`）。 */
  apiBase: string;
  /** 当前会话令牌；由产品 SDK 提供，原生侧不得另行持久化。 */
  token: string | null;
  /** 当前角色（X-Role）；未显式选择时为 null。 */
  role: string | null;
  /** 认证方式（X-Authenticator）。 */
  authenticator: string | null;
  /** 受控请求出口：原生侧必须用它发请求，从而共享 product/strict 策略与错误分类。 */
  request: typeof request;
  /** 读取某流程的节点（已实测的读法）。 */
  listNodes: typeof resourceList;
  /** 节点保存等动作完成后回调，让页面刷新自己的顺序列表。 */
  onChanged?: () => void;
  /** 面向用户的中文提示出口。 */
  onNotice?: (message: string) => void;
}

export interface NativeCanvasHandle {
  unmount(): void;
}

/** 宿主模块的注入方式：产品侧提供一个 loader，避免本组直接依赖未声明的包。 */
export type NativeCanvasLoader = () => Promise<NativeCanvasModule | null>;

let injectedLoader: NativeCanvasLoader | null = null;

/**
 * 注册原生画布宿主模块（由 `frontend/` 的公共装配代码调用一次）。
 *
 * 这是本组与公共侧之间的**唯一接口**：本组不 import 任何未声明的包，
 * 公共侧依赖就绪后调用本函数，画布页就会渲染真正的原生画布。
 */
export function registerNativeCanvasModule(loader: NativeCanvasLoader): void {
  injectedLoader = loader;
}

export function hasNativeCanvasModule(): boolean {
  return injectedLoader !== null;
}

export interface NativeCanvasHostProps {
  workflowId: string;
  /** 节点列表刷新（原生画布内保存后触发）。 */
  onChanged?: () => void;
}

type HostState =
  | { kind: 'unavailable' }
  | { kind: 'loading' }
  | { kind: 'ready'; origin: string }
  | { kind: 'failed'; message: string };

/**
 * 原生画布宿主。
 *
 * 依赖未注册时**不渲染任何伪造画布**，只显示状态与接入说明；
 * 注册后按 `NativeCanvasMountOptions` 传入产品认证/角色/请求出口并挂载。
 */
export function NativeCanvasHost({ workflowId, onChanged }: NativeCanvasHostProps) {
  const [state, setState] = useState<HostState>(() => (injectedLoader ? { kind: 'loading' } : { kind: 'unavailable' }));
  const [container, setContainer] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!injectedLoader) {
      setState({ kind: 'unavailable' });
      return;
    }
    let alive = true;
    let handle: NativeCanvasHandle | null = null;
    (async () => {
      try {
        const module = await injectedLoader();
        if (!alive) return;
        if (!module || !container) {
          setState({ kind: 'unavailable' });
          return;
        }
        const auth = getAuthContext();
        handle = module.mount({
          container,
          workflowId,
          apiBase: getApiBase(),
          token: auth.token,
          role: auth.role,
          authenticator: auth.authenticator ?? null,
          request,
          listNodes: resourceList,
          onChanged,
          onNotice: () => undefined,
        });
        setState({ kind: 'ready', origin: module.origin });
      } catch (error) {
        if (alive) setState({ kind: 'failed', message: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => {
      alive = false;
      try {
        handle?.unmount();
      } catch {
        /* 卸载失败不影响页面 */
      }
    };
  }, [container, workflowId, onChanged]);

  if (state.kind === 'unavailable') {
    return (
      <>
        {/* 挂载容器常驻：注入发生在首次渲染之后，容器必须先存在，挂载点才可用。 */}
        <div ref={setContainer} className={styles.canvasMountHidden} data-testid="native-canvas-mount" />
        <PageCard
          title="原生画布运行时未接入"
          description="官方画布需要公共依赖（v2 客户端运行时与 Vite 适配）到位后才能挂载。"
        >
          <p className={styles.bodyText}>
            本页当前提供的是**基于真实节点数据的顺序编排**（复制、删除、移动、改接上游、新增节点、节点配置）。
            官方原生画布（拖拽画布 + 原生 Instruction 面板 + 原生连线）尚未接入，
            页面不会用静态卡片或顺序列表冒充它。
          </p>
          <p className={styles.cellHint}>
            接入所需的最小宿主接口见 <code>src/modules/workflow/components/nativeCanvasBridge.tsx</code>：
            公共侧提供一个实现 <code>NativeCanvasModule</code> 的模块并调用
            <code> registerNativeCanvasModule()</code>，本组件即会以产品的认证、角色与请求出口挂载原生画布。
          </p>
        </PageCard>
      </>
    );
  }

  if (state.kind === 'loading') {
    return (
      <>
        <div ref={setContainer} className={styles.canvasMountHidden} data-testid="native-canvas-mount" />
        <PageCard title="原生画布">
          <p className={styles.mutedText}>正在加载原生画布运行时…</p>
        </PageCard>
      </>
    );
  }

  if (state.kind === 'failed') {
    return (
      <>
        <div ref={setContainer} className={styles.canvasMountHidden} data-testid="native-canvas-mount" />
        <PageCard tone="muted" title="原生画布加载失败">
          <p className={styles.warnText}>
            原生画布运行时已注册但加载失败，已保留下面的顺序编排作为兜底。可以刷新页面重试；
            若持续失败，请联系管理员核对该运行时版本。
          </p>
        </PageCard>
      </>
    );
  }

  return (
    <PageCard
      title="原生画布"
      description={`运行时来源：${state.origin}`}
      actions={<StatusPill tone="ok">已接入</StatusPill>}
    >
      <div ref={setContainer} className={styles.canvasMount} data-testid="native-canvas-mount" />
    </PageCard>
  );
}

/** 供页面显式展示"当前是否接入原生画布"。 */
export function nativeCanvasStatus(): 'available' | 'unavailable' {
  return injectedLoader ? 'available' : 'unavailable';
}
