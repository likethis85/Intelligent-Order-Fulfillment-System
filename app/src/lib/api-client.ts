const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const direct = isLocalhost && (location.port === '3700' || location.port === '3000' || location.port === '5173');
export const API_ORIGIN = direct ? `${location.protocol}//${location.hostname}:3737` : location.origin;
export const API_BASE = API_ORIGIN + '/api';
export const AUTH_REQUIRED_EVENT = 'marius:auth-required';

export async function authenticatedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const urlStr = typeof input === 'string' ? input : (input && 'href' in input) ? (input as URL).href : (input && 'url' in input) ? (input as Request).url : '';
  const isCrossOrigin = Boolean(urlStr && /^https?:\/\//i.test(urlStr) && !urlStr.startsWith(location.origin));
  const credentials = init?.credentials ?? (isCrossOrigin ? 'same-origin' : 'include');
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
