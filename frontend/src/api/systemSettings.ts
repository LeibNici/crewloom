import { useQuery } from '@tanstack/react-query';
import { api } from './client';

/**
 * 应用品牌与账号能力信息（PUB-06 / PUB-01 的能力来源）。
 *
 * 数据来源是真实后端，两个只读动作：
 *  - `GET systemSettings:get` → 后台应用的名称、标志、可用语言、角色模式，
 *    以及"是否允许自助改密"这类账号能力开关；
 *  - `GET app:getInfo` → 后台应用版本与默认语言（用于"关于本系统"里的后台信息）。
 *
 * 边界：
 *  - `systemSettings` 的 `title` 是**后台应用**的名称（13000 上是旧实例自己的名字），
 *    不是 Crewloom 产品名；界面用"后台信息"区展示它，不拿它替换 Crewloom 品牌。
 *  - `options`/`logo` 等字段按需取用，不原样回显整条记录（避免把无关配置带到界面）。
 *  - 读取失败一律按"暂时无法确认"处理，不编造默认品牌名，也不因此挡住已登录页面。
 */

export interface BackendFileRef {
  url?: string | null;
  filename?: string | null;
  mimetype?: string | null;
  size?: number | null;
}

export interface SystemSettingsSnapshot {
  /** 后台应用名称；未设置时为 null（界面显示"未设置"）。 */
  title: string | null;
  /** 标志图片地址（附件 URL）；未设置时为 null。 */
  logoUrl: string | null;
  /** 后台可用的界面语言代码列表。 */
  enabledLanguages: string[];
  /** 后台默认语言代码。 */
  appLang: string | null;
  /** 角色模式（default / allow-use-union / only-use-union）。 */
  roleMode: string | null;
  showLogoOnly: boolean;
  allowSignUp: boolean;
  /**
   * 是否允许用户自助修改密码。
   *
   * 与原生 `ChangePasswordItemModel.prepare()` 一致：**只有后端明确返回 false 才禁止**，
   * 字段缺失（字段在旧版本/未初始化）按允许处理；否则会把所有用户挡在改密之外。
   */
  allowChangePassword: boolean;
}

export interface BackendInfo {
  version: string | null;
  lang: string | null;
  name: string | null;
}

const LANGUAGE_LABELS: Record<string, string> = {
  'zh-CN': '简体中文',
  'en-US': 'English',
  'ja-JP': '日本語',
  'ko-KR': '한국어',
  'de-DE': 'Deutsch',
  'fr-FR': 'Français',
  'es-ES': 'Español',
  'pt-BR': 'Português',
  'ru-RU': 'Русский',
  'tr-TR': 'Türkçe',
  'it-IT': 'Italiano',
};

/** 语言代码 → 用户可读名称；未知代码原样显示（不编造名称）。 */
export function languageLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  return LANGUAGE_LABELS[code] ?? code;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function normalizeSystemSettings(raw: unknown): SystemSettingsSnapshot {
  const data = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const logo = (data.logo && typeof data.logo === 'object' ? data.logo : {}) as BackendFileRef;
  return {
    title: asString(data.title),
    logoUrl: asString(logo.url),
    enabledLanguages: asStringArray(data.enabledLanguages),
    appLang: asString(data.appLang),
    roleMode: asString(data.roleMode),
    showLogoOnly: data.showLogoOnly === true,
    allowSignUp: data.allowSignUp !== false,
    allowChangePassword: data.enableChangePassword !== false,
  };
}

export async function fetchSystemSettings(): Promise<SystemSettingsSnapshot> {
  const result = await api.resourceAction<Record<string, unknown>>('systemSettings', 'get');
  return normalizeSystemSettings(result.data);
}

export async function fetchBackendInfo(): Promise<BackendInfo> {
  const result = await api.resourceAction<Record<string, unknown>>('app', 'getInfo');
  const data = (result.data ?? {}) as Record<string, unknown>;
  return {
    version: asString(data.version),
    lang: asString(data.lang),
    name: asString(data.name),
  };
}

/** 品牌与能力信息；失败时 `data` 为 undefined，界面按"暂时无法确认"处理。 */
export function useSystemSettings() {
  return useQuery({
    queryKey: ['systemSettings', 'get'],
    queryFn: fetchSystemSettings,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

export function useBackendInfo() {
  return useQuery({
    queryKey: ['app', 'getInfo'],
    queryFn: fetchBackendInfo,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}
