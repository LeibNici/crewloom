/**
 * 把 Crewloom 的上下文与前端工具接进**真实**的原生 ChatBox 宿主。
 *
 * 为什么必须在这里补注册（不是可选的封装）：
 *  - 原生 v2 插件的 `load()` 只注册了 3 个上下文类型：`flow-model` / `code-editor` /
 *    `chart-config`（`plugin.tsx:133-135`）；`datasource` 只在旧的
 *    `client/index.tsx:153` 注册过。也就是说 2.2.22 的 v2 原生宿主里
 *    `aiManager.getWorkContext('datasource')` 返回空 → `parseWorkContext` 不会解析内容，
 *    也不会挂 `frontendTools`。本模块补上这个真实缺口。
 *  - `Registry.register` 默认不允许覆盖（`@nocobase/utils` `lib/registry.js`），
 *    因此只能新增 `datasource`，不能重注册上游已有的 `code-editor` / `chart-config`；
 *    这两类的工具 manifest 由本模块在构造 `ContextItem` 时直接用真实注册表
 *    `frontendTools.list(uid)` 取回（`parseWorkContext` 会保留已有的 `frontendTools`）。
 *
 * 对外只暴露三个动作：注册 / 取首条消息的 `workContext` / 把已准备内容交给会话。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { toServerFilter } from './filter';
import { attachFrontendTools, buildWorkContext } from './payload';
import { getContextDatasource, listContextDatasources } from '../resources';
import { consumeChatHandoffRequest, getSelections } from './store';
import { contextToolManifests, registerContextTools, type FrontendToolRegistryLike } from './tools';
import type { ContextKind, ContextSelection, WorkContextItem } from './types';
import { Field, Notice, Select, StateBlock } from '../ui';
import styles from '../group-a.module.css';

interface AiManagerLike {
  registerWorkContext: (name: string, options: unknown) => void;
  getWorkContext: (name: string) => unknown;
  frontendTools?: FrontendToolRegistryLike;
}

interface AppLike {
  pm: { get: (key: unknown) => unknown };
}

interface PluginLike {
  aiManager?: AiManagerLike;
}

/** 原生宿主里的 `ai` 插件（宿主自己的 `pm.get('ai')` 已经指向它）。 */
export function getAiManager(app: unknown): AiManagerLike | null {
  const manager = (app as AppLike | undefined)?.pm?.get?.('ai') as PluginLike | undefined;
  return manager?.aiManager ?? null;
}

/** 一个 `ContextItem` 属于哪类产品上下文（工具注册要靠它选定义）。 */
export function contextKindOfItem(item: WorkContextItem): ContextKind {
  if (item.type === 'code-editor') return 'code';
  if (item.type === 'chart-config') return 'chart';
  if (item.type === 'datasource') {
    return item.uid.startsWith('crewloom:record:') ? 'record' : 'datasource';
  }
  return 'datasource';
}

/**
 * 工具 manifest 缓存：`prepareChatBoxContextItems` 本身不依赖 app 实例，
 * 因此由注册步骤把「真实注册表取回的 manifest」记下来，二者不会各写一份定义。
 */
const registeredToolCache = new Map<string, NonNullable<WorkContextItem['frontendTools']>>();

function cacheManifests(aiManager: AiManagerLike, uid: string): void {
  if (!aiManager.frontendTools?.list) return;
  registeredToolCache.set(uid, (aiManager.frontendTools.list(uid) ?? []) as never);
}

/**
 * 补注册 `datasource` 上下文（`getContent` 与 `getFrontendTools` 都走真实链路）。
 *
 * `getContent` 与上游 v1 `context/datasource.tsx:80-98` 同语义：
 * 有 `content` 就原样用；否则按 uid 回查已保存记录，并把**存储形态**的结构化筛选
 * 转成服务端筛选形态（服务端的 `datasource` 策略不会再 transform 一次）。
 * 回查成功后顺手注册这一项的前端工具，紧接着的 `getFrontendTools` 才能取到 manifest
 * （`parseWorkContext` 里两者是同一个循环里按顺序 await 的）。
 */
function ensureDatasourceContext(aiManager: AiManagerLike): boolean {
  if (aiManager.getWorkContext('datasource')) return false;
  aiManager.registerWorkContext('datasource', {
    name: 'datasource',
    menu: {
      Component: () => <span>数据与工作内容</span>,
      onClick: (props: {
        ctx?: DialogContextLike;
        contextItems?: WorkContextItem[];
        onAdd?: (item: Omit<WorkContextItem, 'type'>) => void;
      }) => openDatasourcePicker(props),
    },
    tag: {
      Component: ({ item }: { item: WorkContextItem }) => <span>{item.title || '数据范围'}</span>,
    },
    getContent: async (_app: unknown, item: WorkContextItem) => {
      if (item.content) return item.content;
      const record = await getContextDatasource(item.uid);
      if (!record) return {};
      if (aiManager.frontendTools) {
        registerContextTools(aiManager.frontendTools, 'datasource', item.uid);
        cacheManifests(aiManager, item.uid);
      }
      return {
        datasource: record.datasource,
        collectionName: record.collectionName,
        fields: record.fields ?? null,
        filter: toServerFilter(record.filter) ?? null,
        sort: record.sort ?? null,
        limit: record.limit ?? null,
      };
    },
    getFrontendTools: async (_app: unknown, item: WorkContextItem) => {
      return aiManager.frontendTools?.list?.(item.uid) ?? [];
    },
  });
  return true;
}

/**
 * 注册全部 Crewloom 上下文：`datasource` 类型（若缺失）+ 当前已准备项的工具体。
 * 返回注册摘要，供核对脚本/测试断言，不返回任何业务内容。
 */
export function registerCrewloomNativeContexts(app: unknown): {
  ok: boolean;
  registeredDatasource: boolean;
  registeredTools: Array<{ uid: string; kind: ContextKind; names: string[] }>;
  itemCount: number;
} {
  const aiManager = getAiManager(app);
  if (!aiManager || !aiManager.frontendTools) {
    return { ok: false, registeredDatasource: false, registeredTools: [], itemCount: 0 };
  }
  const registeredDatasource = ensureDatasourceContext(aiManager);
  const items = buildWorkContext(getSelections());
  const registeredTools: Array<{ uid: string; kind: ContextKind; names: string[] }> = [];
  for (const item of items) {
    const kind = contextKindOfItem(item);
    registerContextTools(aiManager.frontendTools, kind, item.uid);
    cacheManifests(aiManager, item.uid);
    const names = (aiManager.frontendTools.list?.(item.uid) ?? []).map((manifest) => manifest.name);
    registeredTools.push({ uid: item.uid, kind, names });
  }
  return { ok: true, registeredDatasource, registeredTools, itemCount: items.length };
}

/**
 * 当前选择的会话项（内容 + 工具体）。
 *
 * 工具 manifest 优先用原生宿主从**真实注册表**取回的结果（`registeredToolCache`）；
 * 在还没有宿主实例的产品页（AI-04 工作区）里，则用同一份工具定义推出的 manifest，
 * 两者由测试断言完全一致。
 */
export function prepareChatBoxContextItems(selections: ContextSelection[] = getSelections()): WorkContextItem[] {
  const items = buildWorkContext(selections);
  const kinds = new Map(items.map((item) => [item.uid, contextKindOfItem(item)]));
  return attachFrontendTools(items, (uid) => {
    const cached = registeredToolCache.get(uid);
    if (cached) return cached;
    return contextToolManifests(kinds.get(uid) ?? 'datasource', uid);
  });
}

/** 仅测试用：清空 manifest 缓存。 */
export function __clearToolCacheForTests(): void {
  registeredToolCache.clear();
}

interface ChatSenderLike {
  addContextItems?: (items: WorkContextItem | WorkContextItem[]) => void;
  setContextItems?: (items: WorkContextItem[]) => void;
}

/**
 * 原生会话的内容项存在**会话级**状态里（`chat-messages.ts` 的 `contextItems`，
 * key 由 `getChatSessionKey(sessionId)` 决定；草稿会话是 `__draft__`）。
 * `ChatSenderModel.contextItems` 那个全局字段不被 Sender 读取——只写它会出现
 * "交接成功但输入区没有内容、首条消息 workContext 为空" 的假成功。
 */
interface ChatMessageModelLike {
  addSessionContextItems?: (sessionId: string | undefined, items: WorkContextItem | WorkContextItem[]) => void;
  setSessionContextItems?: (
    sessionId: string | undefined,
    items: WorkContextItem[] | ((prev: WorkContextItem[]) => WorkContextItem[]),
  ) => void;
}

interface RuntimeLike {
  chatSenderModel?: ChatSenderLike;
  chatMessageModel?: ChatMessageModelLike;
  chatConversationModel?: { currentConversation?: string | undefined };
}

/**
 * 把已准备内容交给会话输入区（用户在产品页选好之后「到会话中使用」）。
 *
 * 只写入原生 ChatBox 自己的会话级 `contextItems`（`chat-messages.ts` 的
 * `addSessionContextItems`，Sender 读的就是它），不代替用户发送，也不绕过发送时的
 * `parseWorkContext`。返回实际写入的条数，宿主/核对脚本可据此判断是否真的交接成功。
 */
export interface NativeHandoffState {
  /** 最近一次交接尝试：store 里的选择条数 / 实际写入条数 / 写入通道。 */
  selections: number;
  handedOff: number;
  channel: 'session' | 'session-set' | 'sender' | 'sender-set' | 'none';
  sessionId: string | null;
}

let lastHandoff: NativeHandoffState = { selections: 0, handedOff: 0, channel: 'none', sessionId: null };

/**
 * 最近一次"已交接"的选择签名（`type:uid` 排序拼接）。
 *
 * 为什么必须记住：宿主在路由来回切换（上下文工作区 ↔ 会话页）时会被卸载再挂载，
 * 每次挂载都重新注入同一个选择，就会让**第二条及以后的消息重复带 `workContext`**。
 * 产品语义是"选好的内容随下一条消息发一次"；只有选择集合真的变了（或世代变化导致清空）才重新注入。
 */
let lastHandoffSignature: string | null = null;

function handoffSignatureOf(items: WorkContextItem[]): string {
  return items
    .map((item) => `${item.type}:${item.uid}`)
    .sort()
    .join('|');
}

/** 只读诊断：核对脚本可据此判断"交接是否真的写进了 Sender 读的那份状态"。 */
export function getLastHandoffState(): NativeHandoffState {
  return lastHandoff;
}

export function handoffPreparedItemsToChatBox(runtime: unknown, options?: { force?: boolean }): number {
  const host = runtime as RuntimeLike | undefined;
  const items = prepareChatBoxContextItems();
  const sessionId = host?.chatConversationModel?.currentConversation;
  // 用户显式保存/使用（一次性标记）与调用方 force 等价：签名未变也要重新交接。
  const requested = options?.force === true || consumeChatHandoffRequest();
  const done = (handedOff: number, channel: NativeHandoffState['channel']): number => {
    lastHandoff = { selections: items.length, handedOff, channel, sessionId: sessionId ?? null };
    return handedOff;
  };
  if (items.length === 0) {
    // 选择被清空（发送后 / 世代变化）：下一次重新选择要允许再交接。
    lastHandoffSignature = null;
    return done(0, 'none');
  }
  const signature = handoffSignatureOf(items);
  if (!requested && signature === lastHandoffSignature) {
    // 同一份选择已经交给过输入区：不再重复注入。
    return done(0, 'none');
  }
  const messageModel = host?.chatMessageModel;
  if (messageModel?.addSessionContextItems) {
    messageModel.addSessionContextItems(sessionId, items);
    lastHandoffSignature = signature;
    return done(items.length, 'session');
  }
  if (messageModel?.setSessionContextItems) {
    messageModel.setSessionContextItems(sessionId, items);
    lastHandoffSignature = signature;
    return done(items.length, 'session-set');
  }
  // 兜底：老宿主只暴露全局 sender 模型（不保证被 Sender 读取）。
  const sender = host?.chatSenderModel;
  if (typeof sender?.addContextItems === 'function') {
    sender.addContextItems(items);
    lastHandoffSignature = signature;
    return done(items.length, 'sender');
  }
  if (typeof sender?.setContextItems === 'function') {
    sender.setContextItems(items);
    lastHandoffSignature = signature;
    return done(items.length, 'sender-set');
  }
  return done(0, 'none');
}

/** 仅测试用：忘记"已交接"签名。 */
export function __resetHandoffForTests(): void {
  lastHandoffSignature = null;
  lastHandoff = { selections: 0, handedOff: 0, channel: 'none', sessionId: null };
}

/* ------------------------------ 会话里的数据源选择器 ------------------------------ */

interface DialogContextLike {
  viewer?: {
    dialog?: (options: {
      width?: string | number;
      title?: ReactNode;
      content?: (view: { close?: () => Promise<unknown> | unknown }) => ReactNode;
    }) => void;
  };
}

/**
 * 在原生 ChatBox 的「添加上下文」菜单里选择一条已保存的数据范围。
 *
 * 这里只把 `{uid, title}` 交给会话（与上游 v1 一致）：真正的 `content` 由上面注册的
 * `getContent` 在发送时按 uid 回查，因此用户改过的定义会被重新读取，不会用到旧快照。
 */
export function openDatasourcePicker(props: {
  ctx?: DialogContextLike;
  contextItems?: WorkContextItem[];
  onAdd?: (item: Omit<WorkContextItem, 'type'>) => void;
}): void {
  const dialog = props.ctx?.viewer?.dialog;
  if (typeof dialog !== 'function' || typeof props.onAdd !== 'function') {
    // 没拿到 flow 上下文的宿主里不假装成功：原因只进 console，界面不弹空壳。
    console.warn('[crewloom] 会话里暂时无法打开数据范围选择器（缺少 flow 上下文）。');
    return;
  }
  dialog({
    width: 520,
    title: '选择要带入会话的数据范围',
    content: (view) => (
      <DatasourcePicker
        onPicked={(record) => {
          props.onAdd?.({ uid: record.id, title: record.title });
          void view?.close?.();
        }}
      />
    ),
  });
}

function DatasourcePicker({ onPicked }: { onPicked: (record: { id: string; title: string }) => void }) {
  const [rows, setRows] = useState<Array<{ id: string; title: string; collectionName: string }>>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [selected, setSelected] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    listContextDatasources({ pageSize: 50, sort: ['-createdAt'] })
      .then((result) => {
        if (cancelled) return;
        setRows(result.rows.map((row) => ({ id: row.id, title: row.title, collectionName: row.collectionName })));
        setState(result.rows.length > 0 ? 'ready' : 'empty');
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const current = rows.find((row) => row.id === selected) ?? null;
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  return (
    <div className={styles.stack}>
      <StateBlock
        state={state}
        onRetry={retry}
        emptyTitle="还没有可用的数据范围"
        emptyDescription="先到「任务与数据上下文」里新建一条数据范围，再回到会话使用。"
        deniedDescription="你的角色没有查看数据范围的权限。"
      />
      {state === 'ready' ? (
        <Field label="数据范围">
          <Select
            value={selected}
            onChange={setSelected}
            options={rows.map((row) => ({ value: row.id, label: `${row.title}（${row.collectionName}）` }))}
          />
        </Field>
      ) : null}
      <Notice>选中的范围会随消息一起发送；服务端仍会按你当前的权限再过滤一次。</Notice>
      <button
        type="button"
        className={`${styles.button} ${styles.buttonPrimary}`}
        disabled={!current}
        onClick={() => current && onPicked({ id: current.id, title: current.title })}
      >
        使用这条范围
      </button>
    </div>
  );
}
