import { api } from './client';
import { CrewloomError } from './errors';
import { toUserMessage } from './errors';

/**
 * 附件能力（PUB-04）——公共负责人维护，供各模块复用。
 *
 * 已核对的真实后端行为（13000 = NocoBase 2.2.20 只读核对 + 2.2.22 固定源码）：
 *  - `GET attachments:list` 返回 **404 是设计如此**：`plugin-file-manager` 在
 *    `load()` 里显式 `resourcer.define({ name: 'attachments', actions: { list(ctx){ ctx.throw(404) } } })`，
 *    也就是说该资源**不提供列表**（附件只按记录/字段访问），404 不能推断"没有上传能力"。
 *  - 上传能力来自 ACL：`acl.allow('attachments', ['upload','create'], 'loggedIn')`，
 *    即**任何已登录用户**都可以上传；写路径是 `POST /api/attachments:upload`（multipart）。
 *  - 默认存储由 `GET storages:getBasicInfo` 返回（13000 上是 `local`，带 `rules.size` 上限）；
 *    没有可用存储时该接口 404，此时上传**确实不可用**（这是能力缺失，不是空数据）。
 *  - 文件访问地址是永久路径 `/files/<app>/<dataSource>/<collection>/<id><ext>`，
 *    由 file-manager 的访问中间件按记录授权；记录上的 `url` / `preview` 字段就是它。
 *
 * 边界：本模块只提供读能力描述、URL 归一与用户主动上传；不做批量附件列表，
 * 也不替各模块决定字段。自动验证不得调用真实上传（见 `scripts/probe-public-13000.mjs`）。
 */

export interface AttachmentRecord {
  id: number | string;
  title?: string | null;
  filename?: string | null;
  extname?: string | null;
  size?: number | null;
  mimetype?: string | null;
  /** 永久访问地址（预览时为缩略图地址）。 */
  url?: string | null;
  preview?: string | null;
  [key: string]: unknown;
}

export interface StorageInfo {
  id: number | string | null;
  name: string | null;
  type: string | null;
  title: string | null;
  isPublic: boolean;
  /** 单文件上限（字节）；后端未声明时为 null。 */
  maxSizeBytes: number | null;
}

export interface AttachmentCapability {
  /** 上传是否可用（后端存在默认存储）。 */
  canUpload: boolean;
  storage: StorageInfo | null;
  /** 读取能力信息失败时的用户文案；成功时为 null。 */
  message: string | null;
}

function normalizeStorage(raw: unknown): StorageInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  const rules = (data.rules && typeof data.rules === 'object' ? data.rules : {}) as Record<string, unknown>;
  const size = typeof rules.size === 'number' ? rules.size : null;
  return {
    id: (data.id as number | string | undefined) ?? null,
    name: typeof data.name === 'string' ? data.name : null,
    type: typeof data.type === 'string' ? data.type : null,
    title: typeof data.title === 'string' ? data.title : null,
    isPublic: data.public === true,
    maxSizeBytes: size,
  };
}

/**
 * 默认存储信息。
 *
 * 约定：404 表示"当前没有可用的默认存储"（能力缺失），返回 `null`；
 * 其它失败（网络、5xx、无权限）抛出，由调用方区分"读不到"与"没有"。
 */
export async function fetchDefaultStorage(): Promise<StorageInfo | null> {
  try {
    const result = await api.resourceAction<Record<string, unknown>>('storages', 'getBasicInfo');
    return normalizeStorage(result.data);
  } catch (error) {
    if (error instanceof CrewloomError && error.kind === 'not-found') return null;
    throw error;
  }
}

/** 附件能力：`storages:getBasicInfo` + 已确认的上传 ACL 语义合成。 */
export async function fetchAttachmentCapability(): Promise<AttachmentCapability> {
  try {
    const storage = await fetchDefaultStorage();
    return {
      canUpload: storage !== null,
      storage,
      message: storage ? null : '当前后台还没有可用的文件存储，暂时无法上传附件，请联系管理员。',
    };
  } catch (error) {
    return {
      canUpload: false,
      storage: null,
      message: `暂时无法确认附件能力：${toUserMessage(error)}`,
    };
  }
}

/** 文件体积的可读文案（用户视角，不显示字节数以外的技术信息）。 */
export function formatFileSize(bytes: number | null | undefined): string | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return null;
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? String(value) : value.toFixed(value >= 10 ? 0 : 1);
  return `${rounded} ${units[unit]}`;
}

/**
 * 附件地址归一。
 *
 * 后端返回的 `url` 是站内永久路径（`/files/...`），开发预览通过 Vite 代理转发到同一后端；
 * 已经是完整地址的原样返回。取不到地址时返回 null，界面按"暂不可预览"处理，不拼假地址。
 */
export function resolveFileUrl(value: unknown): string | null {
  const candidate =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object'
        ? ((value as { url?: unknown; preview?: unknown }).url ?? (value as { preview?: unknown }).preview)
        : null;
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('/')) return trimmed;
  return `/${trimmed}`;
}

export interface UploadAttachmentOptions {
  /** 关联字段（例如 `users.avatar`），用于确定该字段配置的存储。 */
  attachmentField?: string;
  signal?: AbortSignal;
}

/**
 * 用户主动上传一个附件。
 *
 * 走 SDK 的请求管线（认证 / 角色 / 续期 / 会话世代都在同一处），
 * 用 multipart 发 `POST /api/attachments:upload`；不设置 `Content-Type`，由浏览器补 boundary。
 * **只有真实用户的主动操作才会调用**；自动验证一律不调用（strict 模式也拦截 upload）。
 */
export async function uploadAttachment(
  file: File,
  options: UploadAttachmentOptions = {},
): Promise<AttachmentRecord> {
  const form = new FormData();
  form.append('file', file);
  const result = await api.request<AttachmentRecord>({
    method: 'post',
    url: 'attachments:upload',
    data: form,
    params: options.attachmentField ? { attachmentField: options.attachmentField } : {},
    signal: options.signal,
  });
  const data = result.data;
  if (!data || typeof data !== 'object') {
    throw new CrewloomError({
      kind: 'unexpected',
      userMessage: '附件上传未能完成，请重试；如持续出现，请联系管理员。',
      detail: 'upload response missing attachment record',
    });
  }
  return data as AttachmentRecord;
}
