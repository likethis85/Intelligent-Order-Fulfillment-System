const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const direct = isLocalhost && (location.port === '3700' || location.port === '3000' || location.port === '5173');
export const API_ORIGIN = direct ? `${location.protocol}//${location.hostname}:3737` : location.origin;
export const API_BASE = API_ORIGIN + '/api';
export const AUTH_REQUIRED_EVENT = 'marius:auth-required';

export async function authenticatedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  // 本地 Vite 在 3700，API 直连 3737；虽然跨端口，但仍是同一个应用后端。
  // 必须始终带上 HttpOnly 会话 Cookie，否则回调登录成功后下一次 /auth/session 会 401。
  const credentials = init?.credentials ?? 'include';
  const response = await fetch(input, { ...init, credentials });
  if (response.status === 401) window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
  return response;
}

export interface AuthUser {
  id: string;
  provider: string;
  email: string | null;
  displayName: string;
  avatarUrl: string | null;
}

export interface AuthSession {
  authenticated: boolean;
  ssoConfigured: boolean;
  user: AuthUser | null;
  expiresAt: number | null;
}
