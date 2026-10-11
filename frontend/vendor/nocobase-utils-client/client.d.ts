export type AuthCookieType = 'authToken' | 'authenticator' | 'role' | 'csrfToken';

export declare function getAuthCookieName(type: AuthCookieType, appName?: string): string;

export declare function getAuthCookieValue(type: AuthCookieType, appName?: string): string | undefined;
