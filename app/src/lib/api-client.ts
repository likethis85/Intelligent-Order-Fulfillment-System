// Keep the existing direct connection for large responses during local Vite development.
// Deployed pages use their own origin so HTTPS and reverse proxies work without fixed ports.
const direct = location.port === '3000' || location.port === '5173';
export const API_ORIGIN = direct ? `${location.protocol}//${location.hostname}:3737` : location.origin;
export const API_BASE = API_ORIGIN + '/api';
export const AUTH_REQUIRED_EVENT = 'marius:auth-required';

export async function authenticatedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, { ...init, credentials: 'include' });
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
