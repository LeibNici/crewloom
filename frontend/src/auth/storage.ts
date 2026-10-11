/**
 * 浏览器侧的会话存储。
 *
 * 由 `@nocobase/sdk` 的 `Auth` 通过自定义 storageAdapter 读写，键名保持项目既有约定，
 * 因此令牌、角色、认证方式与语言都落在同一组 `crewloom.session.*` 键上：
 *  - `crewloom.session.token` —— 令牌（Bearer）；
 *  - `crewloom.session.role`  —— 显式选择的角色（X-Role），未选择时不写入；
 *  - `crewloom.session.auth`  —— 认证方式（X-Authenticator，来自 authenticators:publicList）；
 *  - `crewloom.session.locale` —— 界面语言（X-Locale）。
 *
 * 约束：令牌只用于本地会话恢复，绝不写入源码、示例、构建变量、日志或截图。
 * 该模块刻意不导出任何把令牌写入控制台的方法。
 */

export const SESSION_STORAGE_KEYS = {
  token: 'crewloom.session.token',
  role: 'crewloom.session.role',
  auth: 'crewloom.session.auth',
  locale: 'crewloom.session.locale',
} as const;

export type SessionStorageKey = keyof typeof SESSION_STORAGE_KEYS;

function storage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function read(key: SessionStorageKey): string | null {
  try {
    const value = storage()?.getItem(SESSION_STORAGE_KEYS[key]);
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function write(key: SessionStorageKey, value: string): void {
  try {
    storage()?.setItem(SESSION_STORAGE_KEYS[key], value);
  } catch {
    /* 存储不可用时保持内存会话 */
  }
}

function remove(key: SessionStorageKey): void {
  try {
    storage()?.removeItem(SESSION_STORAGE_KEYS[key]);
  } catch {
    /* 忽略 */
  }
}

export function readStoredToken(): string | null {
  return read('token');
}

export function writeStoredToken(token: string): void {
  write('token', token);
}

export function clearStoredToken(): void {
  remove('token');
}

export function readStoredRole(): string | null {
  return read('role');
}

export function writeStoredRole(role: string): void {
  write('role', role);
}

export function clearStoredRole(): void {
  remove('role');
}

export function readStoredAuthenticator(): string | null {
  return read('auth');
}

export function clearStoredAuthenticator(): void {
  remove('auth');
}

export function clearStoredSession(): void {
  clearStoredToken();
  clearStoredRole();
  clearStoredAuthenticator();
  remove('locale');
}

/**
 * 交给 `@nocobase/sdk` 的 `APIClient({ storageClass })`。
 *
 * SDK 只要求 getItem / setItem / removeItem / clear；键名是 SDK 内部的
 * `token` / `role` / `auth` / `locale`，这里映射到项目既有键名，
 * 从而让 SDK 承担持久化，且不引入第二套存储。
 */
export class CrewloomSessionStorage {
  getItem(key: string): string | null {
    const known = lookupSessionKey(key);
    return known ? read(known) : null;
  }

  setItem(key: string, value: string): void {
    const known = lookupSessionKey(key);
    if (!known) return;
    // SDK 用空字符串表示"清除"；这里直接删除键，避免 localStorage 留下空值。
    if (!value) remove(known);
    else write(known, value);
  }

  removeItem(key: string): void {
    const known = lookupSessionKey(key);
    if (known) remove(known);
  }

  clear(): void {
    clearStoredSession();
  }
}

/** SDK 未声明的键既不读也不写，避免把未知内容写进 localStorage。 */
function lookupSessionKey(key: string): SessionStorageKey | undefined {
  return key === 'token' || key === 'role' || key === 'auth' || key === 'locale' ? key : undefined;
}
