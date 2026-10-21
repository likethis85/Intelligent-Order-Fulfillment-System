import { Router } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const SESSION_COOKIE = 'marius_fulfillment_session';
const BROWSER_COOKIE = 'marius_fulfillment_sso_browser';
const STATE_TTL_MS = 15 * 60_000;
const MAX_ENTRIES = 10_000;
const CALLBACK_PATH = '/api/auth/sso/callback';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');

export function readSsoConfig() {
  // Keep existing business .env files intact. Real process variables take precedence.
  const envFile = fileURLToPath(new URL('./.env.sso', import.meta.url));
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  return makeSsoConfig(process.env);
}

export function makeSsoConfig(env = {}) {
  const baseUrl = (env.SSO_BASE_URL || 'https://sso.marius.com.cn').replace(/\/$/, '');
  const primary = env.SSO_REDIRECT_URI || 'http://localhost:3700' + CALLBACK_PATH;
  const redirectUris = [...new Set([primary, ...(env.SSO_REDIRECT_URIS || '').split(',').filter(Boolean)])];
  for (const value of [baseUrl, ...redirectUris]) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
      throw new Error('SSO 地址格式无效，请检查服务端 SSO 配置');
    }
  }
  if (redirectUris.some((value) => new URL(value).pathname !== CALLBACK_PATH)) {
    throw new Error('SSO 回调路径必须为 ' + CALLBACK_PATH);
  }
  const origins = new Set(redirectUris.map((value) => new URL(value).origin));
  const secure = new URL(primary).protocol === 'https:';
  if (redirectUris.some((value) => (new URL(value).protocol === 'https:') !== secure)) {
    throw new Error('请将 HTTP 本机开发与 HTTPS 生产回调配置在各自环境中');
  }
  if (env.NODE_ENV === 'production' && (!secure || new URL(baseUrl).protocol !== 'https:')) {
    throw new Error('生产 SSO 服务与项目回调均须使用 HTTPS');
  }
  return {
    baseUrl, redirectUris, origins, secure,
    clientId: env.SSO_CLIENT_ID || '',
    clientSecret: env.SSO_CLIENT_SECRET || '',
    configured: Boolean(env.SSO_CLIENT_ID && env.SSO_CLIENT_SECRET),
  };
}

function cookie(req, name) {
  const values = String(req.headers.cookie || '').split(';').map((part) => part.trim());
  const matches = values.filter((part) => part.startsWith(name + '='));
  if (matches.length !== 1) return '';
  const value = matches[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : '';
}

function safeReturnTo(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\r\n]/.test(value)) return '/';
  try {
    const url = new URL(value, 'http://application.invalid');
    if (url.origin !== 'http://application.invalid' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) return '/';
    return url.pathname + url.search + url.hash;
  } catch { return '/'; }
}

function normalizeUser(user) {
  if (!user || typeof user.id !== 'string' || !user.id || typeof user.provider !== 'string') {
    throw new Error('invalid_identity');
  }
  const email = typeof user.email === 'string' ? user.email : null;
  return {
    id: user.id, provider: user.provider, email,
    displayName: (typeof user.display_name === 'string' && user.display_name.trim() ? user.display_name.trim() : email || user.id).slice(0, 80),
    avatarUrl: typeof user.avatar_url === 'string' ? user.avatar_url : null,
    // 钉钉 unionId：SSO 用它关联通讯录成员，命中后才知道这个人属于哪个部门
    externalId: typeof user.external_id === 'string' && user.external_id ? user.external_id : null,
  };
}

export function createSsoAuth(config, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const router = Router();
  const states = new Map();
  const sessions = new Map();
  const events = new EventEmitter();
  const cookieOptions = { httpOnly: true, sameSite: 'lax', secure: config.secure, path: '/' };

  function revoke(key) {
    if (sessions.delete(key)) events.emit('revoked', key);
  }

  function cleanup() {
    const time = now();
    for (const [key, entry] of states) if (entry.expiresAt <= time) states.delete(key);
    for (const [key, entry] of sessions) if (entry.expiresAt <= time) revoke(key);
  }

  const timer = setInterval(cleanup, 60_000);
  timer.unref();

  function getSession(req) {
    const value = cookie(req, SESSION_COOKIE);
    if (!value) return null;
    const key = hash(value);
    const session = sessions.get(key);
    if (!session) return null;
    if (session.expiresAt <= now()) { revoke(key); return null; }
    return { ...session, key };
  }

  const isAllowedOrigin = (origin) => typeof origin === 'string' && config.origins.has(origin);
  const requireOrigin = (req, res, next) => {
    let origin = req.headers.origin;
    if (!origin && req.headers.referer) {
      try { origin = new URL(req.headers.referer).origin; } catch {}
    }
    if (!isAllowedOrigin(origin)) {
      return res.status(403).json({ error: 'invalid_origin', message: '请求来源无效，请从项目页面操作' });
    }
    next();
  };

  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  router.get('/session', (req, res) => {
    const session = getSession(req);
    res.json({ authenticated: Boolean(session), ssoConfigured: config.configured, user: session?.user || null, expiresAt: session?.expiresAt || null });
  });

  router.get('/sso/start', async (req, res) => {
    if (!config.configured) return res.status(503).json({ error: 'sso_not_configured', message: '统一登录尚未配置，请联系管理员' });
    const origin = typeof req.query.origin === 'string' ? req.query.origin : new URL(config.redirectUris[0]).origin;
    const redirectUri = config.redirectUris.find((value) => new URL(value).origin === origin);
    if (!redirectUri) return res.status(400).json({ error: 'invalid_origin', message: '此项目地址尚未登记统一登录回调' });
    const provider = req.query.provider;
    if (provider !== undefined && provider !== 'dingtalk') return res.status(400).json({ error: 'invalid_provider', message: '登录方式无效，请返回项目页面重试' });
    cleanup();
    if (states.size >= MAX_ENTRIES) return res.status(503).json({ error: 'busy', message: '登录请求较多，请稍后重试' });
    const browser = cookie(req, BROWSER_COOKIE) || random();
    const state = random();
    states.set(hash(state), { browserHash: hash(browser), expiresAt: now() + STATE_TTL_MS, returnTo: safeReturnTo(req.query.returnTo), origin });
    res.cookie(BROWSER_COOKIE, browser, { ...cookieOptions, path: '/api/auth/sso', maxAge: STATE_TTL_MS });
    const url = new URL(config.baseUrl + '/authorize');
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('response_mode', 'code');
    if (provider !== 'dingtalk') return res.redirect(302, url.toString());
    try {
      // SSO's provider query is currently ignored. Use its documented form flow
      // to reach DingTalk directly, while retaining the same bound app state.
      const signal = AbortSignal.timeout(15_000);
      const entry = await fetchImpl(url.toString(), { redirect: 'error', signal });
      if (entry.status !== 200 || !entry.headers.get('content-type')?.includes('text/html')) throw new Error('invalid_sso_entry');
      const html = await entry.text();
      const actions = [...html.matchAll(/<form\b[^>]*\baction\s*=\s*["'](\/authorize\/([0-9a-f]{32})\/dingtalk)["']/gi)];
      if (html.length > 1_000_000 || actions.length !== 1) throw new Error('dingtalk_unavailable');
      const [, action, sid] = actions[0];
      const upstream = await fetchImpl(config.baseUrl + action, {
        method: 'POST', redirect: 'manual', signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '',
      });
      if (upstream.status !== 303) throw new Error('dingtalk_unavailable');
      const target = new URL(upstream.headers.get('location'));
      const callback = new URL(target.searchParams.get('redirect_uri'));
      if (target.origin !== 'https://login.dingtalk.com' || target.pathname !== '/oauth2/auth' || target.username || target.password || target.hash || target.searchParams.get('state') !== sid
        || callback.origin !== new URL(config.baseUrl).origin || !['/login/callback', '/callback/dingtalk'].includes(callback.pathname) || callback.username || callback.password || callback.hash || callback.search) {
        throw new Error('invalid_dingtalk_redirect');
      }
      const pending = states.get(hash(state));
      if (!pending || pending.expiresAt <= now()) throw new Error('login_cancelled');
      return res.redirect(302, target.toString());
    } catch {
      states.delete(hash(state));
      // Upstream errors can contain login state. Show only a safe retry hint.
      return res.redirect(303, origin + '/?sso_error=dingtalk_unavailable');
    }
  });

  router.get('/sso/callback', async (req, res) => {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const browser = cookie(req, BROWSER_COOKIE);
    const key = hash(state);
    const pending = states.get(key);
    const bound = pending && browser && timingSafeEqual(Buffer.from(pending.browserHash, 'hex'), Buffer.from(hash(browser), 'hex'));
    if (!pending || !bound || pending.expiresAt <= now()) {
      if (pending?.expiresAt <= now()) states.delete(key);
      return res.status(400).type('text/plain').send('登录校验失败或已超时，请返回项目页面重新登录。');
    }
    states.delete(key); // Consume before exchanging the one-time code, including failures.
    const fail = (error) => res.redirect(303, pending.origin + '/?sso_error=' + error);
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!code || code.length > 4096 || req.query.error) return fail('login_failed');
    try {
      const upstream = await fetchImpl(config.baseUrl + '/token', {
        method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_type: 'authorization_code', code, client_id: config.clientId, client_secret: config.clientSecret }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!upstream.ok) return fail(upstream.status === 401 ? 'service_config' : 'login_failed');
      const result = await upstream.json();
      const user = normalizeUser(result.user);
      if (typeof result.access_token !== 'string' || !result.access_token || result.token_type?.toLowerCase() !== 'bearer') throw new Error('invalid_token_response');
      const tokenExpiry = Number(result.expires_at) * 1000;
      const expiresIn = Number(result.expires_in);
      const expiresAt = Math.min(Number.isFinite(tokenExpiry) && tokenExpiry > 0 ? tokenExpiry : now() + expiresIn * 1000, now() + 8 * 3600_000);
      if (!Number.isFinite(expiresAt) || expiresAt <= now()) throw new Error('expired_token_response');
      cleanup();
      if (sessions.size >= MAX_ENTRIES) return fail('service_unavailable');
      const previous = getSession(req);
      if (previous) revoke(previous.key);
      const sessionId = random();
      sessions.set(hash(sessionId), { user, expiresAt });
      res.cookie(SESSION_COOKIE, sessionId, { ...cookieOptions, maxAge: expiresAt - now() });
      // Only the opaque application session cookie reaches the browser.
      res.redirect(303, pending.origin + pending.returnTo);
    } catch {
      // Do not log authorization codes, upstream bodies, tokens or client secrets.
      return fail('service_unavailable');
    }
  });

  router.post('/logout', requireOrigin, (req, res) => {
    const session = getSession(req);
    if (session) revoke(session.key);
    const browser = cookie(req, BROWSER_COOKIE);
    if (browser) for (const [key, pending] of states) if (pending.browserHash === hash(browser)) states.delete(key);
    res.clearCookie(SESSION_COOKIE, cookieOptions);
    res.clearCookie(BROWSER_COOKIE, { ...cookieOptions, path: '/api/auth/sso' });
    res.json({ ok: true });
  });

  function requireSession(req, res, next) {
    const isPublicRead = (req.method === 'GET' && ['/health', '/app-config', '/config', '/fabric-data', '/history'].includes(req.path))
      || (['/query'].includes(req.path) && ['GET', 'POST'].includes(req.method));
    const session = getSession(req);
    if (session) req.auth = session;
    if (isPublicRead) return next();

    res.setHeader('Cache-Control', 'private, no-store');
    if (!session) return res.status(401).json({ error: 'authentication_required', message: '请先登录' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return requireOrigin(req, res, next);
    next();
  }

  return {
    router, requireSession, getSession, isAllowedOrigin,
    onRevoke(handler) { events.on('revoked', handler); return () => events.off('revoked', handler); },
    close() { clearInterval(timer); for (const key of sessions.keys()) revoke(key); states.clear(); },
  };
}
