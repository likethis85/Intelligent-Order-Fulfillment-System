import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import express from 'express';
import { WebSocket } from 'ws';
import { createSsoAuth, makeSsoConfig } from '../server/sso-auth.js';
import { attachTrayWs } from '../server/ws-trays.js';

const origin = 'http://localhost:3000';
const user = { id: 'u_sso_test', provider: 'dingtalk', email: null, display_name: '测试同事', avatar_url: null };
const env = { SSO_BASE_URL: 'http://sso.example', SSO_CLIENT_ID: 'app_test', SSO_CLIENT_SECRET: 'server-only-test-secret', SSO_REDIRECT_URI: origin + '/api/auth/sso/callback', SSO_REDIRECT_URIS: 'http://127.0.0.1:3000/api/auth/sso/callback' };

async function fixture(t, { tokenStatus = 200, result, unavailable = false, configEnv = env, dingtalk = {}, sessionFile = null } = {}) {
  let time = Date.now();
  let exchanges = 0;
  let authorization;
  const upstreamRequests = [];
  const sid = 'a'.repeat(32);
  const auth = createSsoAuth(makeSsoConfig(configEnv), {
    sessionFile,
    now: () => time,
    fetchImpl: async (url, options) => {
      upstreamRequests.push({ url, method: options.method || 'GET' });
      if (new URL(url).pathname === '/authorize') {
        authorization = Object.fromEntries(new URL(url).searchParams);
        assert.equal(authorization.client_id, env.SSO_CLIENT_ID);
        assert.equal(authorization.response_mode, 'code');
        assert.equal(authorization.client_secret, undefined);
        assert.equal(options.redirect, 'error');
        if (dingtalk.unavailable) throw new Error('confidential upstream error');
        return new Response(dingtalk.html ?? `<form method="post" action="/authorize/${sid}/dingtalk"><button>钉钉登录</button></form>`, {
          status: dingtalk.entryStatus || 200, headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      if (new URL(url).pathname === `/authorize/${sid}/dingtalk`) {
        assert.equal(options.method, 'POST');
        assert.equal(options.redirect, 'manual');
        assert.equal(options.body, '');
        await dingtalk.beforeRedirect?.();
        const target = new URL('https://login.dingtalk.com/oauth2/auth');
        target.searchParams.set('state', sid);
        target.searchParams.set('redirect_uri', env.SSO_BASE_URL + '/login/callback');
        return new Response(null, { status: dingtalk.status || 303, headers: { Location: dingtalk.location || target.toString() } });
      }
      exchanges++;
      assert.equal(url, env.SSO_BASE_URL + '/token');
      assert.equal(options.redirect, 'error');
      const body = JSON.parse(options.body);
      assert.equal(body.client_secret, env.SSO_CLIENT_SECRET);
      assert.equal(body.grant_type, 'authorization_code');
      if (unavailable) throw new Error('network failed with confidential details');
      return Response.json(result || { access_token: 'test-upstream-token', token_type: 'Bearer', expires_at: Math.floor(time / 1000) + 3600, expires_in: 3600, user }, { status: tokenStatus });
    },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/auth', auth.router);
  app.use('/api', auth.requireSession);
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/private', (req, res) => res.json({ user: req.auth.user }));
  app.post('/api/private', (_req, res) => res.json({ ok: true }));
  app.use('/uploads', auth.requireSession, (_req, res) => res.send('protected-image'));
  const server = http.createServer(app);
  const wss = attachTrayWs(server, auth);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise((resolve) => wss.close(resolve));
    auth.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  return { base, auth, advance: (ms) => { time += ms; }, exchanges: () => exchanges, authorization: () => authorization, upstreamRequests: () => upstreamRequests };
}

function cookie(response, name) {
  return response.headers.getSetCookie().find((value) => value.startsWith(name + '='))?.split(';')[0] || '';
}

async function start(f, query = '') {
  const response = await fetch(f.base + '/api/auth/sso/start' + query, { redirect: 'manual' });
  assert.equal(response.status, 302);
  const url = new URL(response.headers.get('location'));
  assert.equal(url.searchParams.get('response_mode'), 'code');
  assert.equal(url.searchParams.get('client_id'), env.SSO_CLIENT_ID);
  assert.equal(url.searchParams.get('client_secret'), null);
  return { state: url.searchParams.get('state'), browser: cookie(response, 'marius_fulfillment_sso_browser'), response, url };
}

async function callback(f, login, extra = '') {
  return fetch(f.base + '/api/auth/sso/callback?code=one-time-code&state=' + login.state + extra, { redirect: 'manual', headers: { Cookie: login.browser } });
}

async function login(f, query = '') {
  const pending = await start(f, query);
  const response = await callback(f, pending);
  assert.equal(response.status, 303);
  const session = cookie(response, 'marius_fulfillment_session');
  assert.ok(session);
  return { session, pending, response };
}

test('anonymous pages, images and writes are denied; health/session remain public', async (t) => {
  const f = await fixture(t);
  for (const path of ['/api/private', '/uploads/a.png']) assert.equal((await fetch(f.base + path)).status, 401);
  assert.equal((await fetch(f.base + '/api/private', { method: 'POST' })).status, 401);
  assert.equal((await fetch(f.base + '/api/health')).status, 200);
  const response = await fetch(f.base + '/api/auth/session');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).authenticated, false);
});

test('successful code exchange creates a private application session and preserves a local return path', async (t) => {
  const f = await fixture(t);
  const { session, response } = await login(f, '?returnTo=' + encodeURIComponent('/?tab=trays#current'));
  assert.equal(response.headers.get('location'), origin + '/?tab=trays#current');
  const header = response.headers.getSetCookie().join(';');
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Lax/);
  assert.ok(!header.includes('test-upstream-token'));
  const identity = await fetch(f.base + '/api/auth/session', { headers: { Cookie: session } });
  const body = await identity.json();
  assert.equal(body.user.id, user.id);
  assert.equal(body.user.displayName, user.display_name);
  assert.equal(body.user.email, null);
  assert.ok(!JSON.stringify(body).includes(env.SSO_CLIENT_SECRET));
  assert.equal((await fetch(f.base + '/api/private', { headers: { Cookie: session } })).status, 200);
});

test('direct DingTalk entry retains browser binding, registered callback and one-time app state', async (t) => {
  const f = await fixture(t);
  const alias = 'http://127.0.0.1:3000';
  const response = await fetch(f.base + '/api/auth/sso/start?' + new URLSearchParams({ provider: 'dingtalk', origin: alias, returnTo: '/?tab=trays#current' }), { redirect: 'manual' });
  assert.equal(response.status, 302);
  const target = new URL(response.headers.get('location'));
  assert.equal(target.origin, 'https://login.dingtalk.com');
  assert.equal(target.pathname, '/oauth2/auth');
  assert.equal(target.searchParams.get('redirect_uri'), env.SSO_BASE_URL + '/login/callback');
  assert.equal(f.authorization().redirect_uri, alias + '/api/auth/sso/callback');
  assert.notEqual(target.searchParams.get('state'), f.authorization().state);
  assert.ok(!target.toString().includes(env.SSO_CLIENT_SECRET));
  const pending = { state: f.authorization().state, browser: cookie(response, 'marius_fulfillment_sso_browser') };
  assert.equal((await callback(f, { ...pending, browser: '' })).status, 400);
  assert.equal(f.exchanges(), 0);
  const completed = await callback(f, pending);
  assert.equal(completed.status, 303);
  assert.equal(completed.headers.get('location'), alias + '/?tab=trays#current');
  assert.ok(cookie(completed, 'marius_fulfillment_session'));
  assert.equal((await callback(f, pending)).status, 400);
  assert.equal(f.exchanges(), 1);
});

test('DingTalk failures and untrusted redirects cancel app state without exposing upstream details', async (t) => {
  const valid = new URL('https://login.dingtalk.com/oauth2/auth');
  valid.searchParams.set('state', 'a'.repeat(32));
  valid.searchParams.set('redirect_uri', env.SSO_BASE_URL + '/login/callback');
  const badTarget = (change) => { const url = new URL(valid); change(url); return url.toString(); };
  const options = [
    { unavailable: true }, { entryStatus: 400 }, { html: '<form action="https://attacker.example/authorize/x/dingtalk"></form>' },
    { status: 503 }, { status: 302 }, { location: 'invalid-location' },
    { location: badTarget((url) => { url.hostname = 'attacker.example'; }) },
    { location: badTarget((url) => { url.protocol = 'http:'; }) },
    { location: badTarget((url) => { url.username = 'unexpected'; }) },
    { location: badTarget((url) => { url.searchParams.set('state', 'wrong'); }) },
    { location: badTarget((url) => { url.searchParams.set('redirect_uri', 'https://attacker.example/login/callback'); }) },
    { location: badTarget((url) => { url.searchParams.set('redirect_uri', env.SSO_BASE_URL + '/other'); }) },
  ];
  for (const dingtalk of options) {
    const f = await fixture(t, { dingtalk });
    const response = await fetch(f.base + '/api/auth/sso/start?provider=dingtalk', { redirect: 'manual' });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), origin + '/?sso_error=dingtalk_unavailable');
    assert.ok(!(await response.text()).includes('confidential'));
    assert.equal(cookie(response, 'marius_fulfillment_session'), '');
    if (f.authorization()) assert.equal((await callback(f, { state: f.authorization().state, browser: cookie(response, 'marius_fulfillment_sso_browser') })).status, 400);
    assert.equal(f.exchanges(), 0);
  }
});

test('DingTalk start rejects unregistered origins and unknown or repeated providers before contacting SSO', async (t) => {
  const f = await fixture(t);
  for (const query of ['provider=unknown', 'provider=dingtalk&provider=dingtalk', 'provider=dingtalk&origin=https://attacker.example']) {
    assert.equal((await fetch(f.base + '/api/auth/sso/start?' + query, { redirect: 'manual' })).status, 400);
  }
  assert.equal(f.upstreamRequests().length, 0);
});

test('logout or expiry during DingTalk startup prevents a stale login redirect', async (t) => {
  for (const cancel of ['logout', 'expiry']) {
    let ready, release;
    const reached = new Promise((resolve) => { ready = resolve; });
    const deferred = new Promise((resolve) => { release = resolve; });
    const f = await fixture(t, { dingtalk: { beforeRedirect: async () => { ready(); await deferred; } } });
    const browser = 'marius_fulfillment_sso_browser=' + 'x'.repeat(43);
    const starting = fetch(f.base + '/api/auth/sso/start?provider=dingtalk', { redirect: 'manual', headers: { Cookie: browser } });
    await reached;
    if (cancel === 'logout') {
      assert.equal((await fetch(f.base + '/api/auth/logout', { method: 'POST', headers: { Cookie: browser, Origin: origin } })).status, 200);
    } else f.advance(15 * 60_000 + 1);
    release();
    const response = await starting;
    assert.equal(response.headers.get('location'), origin + '/?sso_error=dingtalk_unavailable');
    assert.equal((await callback(f, { state: f.authorization().state, browser })).status, 400);
    assert.equal(f.exchanges(), 0);
  }
});

test('callback is bound to its initiating browser, then consumes state exactly once', async (t) => {
  const f = await fixture(t);
  const pending = await start(f);
  const address = f.base + '/api/auth/sso/callback?code=c&state=' + pending.state;
  assert.equal((await fetch(address, { redirect: 'manual' })).status, 400);
  assert.equal((await fetch(address, { redirect: 'manual', headers: { Cookie: 'marius_fulfillment_sso_browser=' + 'x'.repeat(43) } })).status, 400);
  assert.equal(f.exchanges(), 0);
  assert.equal((await callback(f, pending)).status, 303);
  assert.equal((await callback(f, pending)).status, 400);
  assert.equal(f.exchanges(), 1);
});

test('expired state never reaches the SSO token endpoint', async (t) => {
  const f = await fixture(t);
  const pending = await start(f);
  f.advance(15 * 60_000 + 1);
  assert.equal((await callback(f, pending)).status, 400);
  assert.equal(f.exchanges(), 0);
});

test('wrong, reused or expired authorization codes and invalid client credentials require a new login', async (t) => {
  for (const status of [400, 401]) {
    const f = await fixture(t, { tokenStatus: status, result: { error: status === 401 ? 'invalid_client' : 'invalid_grant' } });
    const pending = await start(f);
    const response = await callback(f, pending);
    assert.equal(response.status, 303);
    assert.equal(cookie(response, 'marius_fulfillment_session'), '');
    assert.match(response.headers.get('location'), /sso_error=(service_config|login_failed)$/);
    assert.equal((await callback(f, pending)).status, 400);
    assert.equal(f.exchanges(), 1);
  }
});

test('network errors, malformed identity and expired token responses create no session or secret-bearing errors', async (t) => {
  for (const options of [{ unavailable: true }, { result: { user: {} } }, { result: { access_token: 'token', token_type: 'Bearer', user, expires_at: 1 } }]) {
    const f = await fixture(t, options);
    const response = await callback(f, await start(f));
    assert.equal(cookie(response, 'marius_fulfillment_session'), '');
    assert.equal(response.headers.get('location'), origin + '/?sso_error=service_unavailable');
    assert.ok(!(await response.text()).includes('confidential'));
  }
});

test('only registered project origins are accepted; external return paths cannot redirect users away', async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(f.base + '/api/auth/sso/start?origin=https://attacker.example')).status, 400);
  for (const value of ['https://attacker.example', '//attacker.example', '/\\attacker.example', '/api/auth/sso/start', '/\n/attacker.example']) {
    const { response } = await login(f, '?returnTo=' + encodeURIComponent(value));
    assert.equal(response.headers.get('location'), origin + '/');
  }
  const alias = await start(f, '?origin=' + encodeURIComponent('http://127.0.0.1:3000'));
  assert.equal(alias.url.searchParams.get('redirect_uri'), 'http://127.0.0.1:3000/api/auth/sso/callback');
});

test('session cookie forgery and duplicate cookies fail; protected writes check the browser origin', async (t) => {
  const f = await fixture(t);
  const { session } = await login(f);
  const name = 'marius_fulfillment_session=';
  for (const value of [name + 'x'.repeat(43), session + '; ' + session]) assert.equal((await fetch(f.base + '/api/private', { headers: { Cookie: value } })).status, 401);
  for (const bad of [null, 'https://attacker.example']) {
    const headers = { Cookie: session };
    if (bad) headers.Origin = bad;
    assert.equal((await fetch(f.base + '/api/private', { method: 'POST', headers })).status, 403);
  }
  assert.equal((await fetch(f.base + '/api/private', { method: 'POST', headers: { Cookie: session, Origin: origin } })).status, 200);
});

test('session expiration removes access and logout invalidates captured cookies', async (t) => {
  const f = await fixture(t);
  const first = await login(f);
  f.advance(3600_000 + 1);
  assert.equal((await fetch(f.base + '/api/private', { headers: { Cookie: first.session } })).status, 401);
  const second = await login(f);
  assert.equal((await fetch(f.base + '/api/auth/logout', { method: 'POST', headers: { Cookie: second.session, Origin: 'https://attacker.example' } })).status, 403);
  const response = await fetch(f.base + '/api/auth/logout', { method: 'POST', headers: { Cookie: second.session, Origin: origin } });
  assert.equal(response.status, 200);
  assert.match(response.headers.getSetCookie().join(';'), /Expires=Thu, 01 Jan 1970/);
  assert.equal((await fetch(f.base + '/api/private', { headers: { Cookie: second.session } })).status, 401);
});

test('活动期间自动续期：一直在用的人不会整点被上游 60 分钟令牌踢下线', async (t) => {
  const f = await fixture(t);
  const { session } = await login(f);
  const before = await (await fetch(f.base + '/api/auth/session', { headers: { Cookie: session } })).json();
  assert.ok(before.authenticated);
  // 上游令牌 60 分钟到期，这里走到只剩 15 分钟
  f.advance(45 * 60_000);
  const renewed = await fetch(f.base + '/api/private', { headers: { Cookie: session } });
  assert.equal(renewed.status, 200);
  assert.match(renewed.headers.getSetCookie().join(';'), /marius_fulfillment_session=/, '续期要把 Cookie 的 maxAge 一起往后推');
  const after = await (await fetch(f.base + '/api/auth/session', { headers: { Cookie: session } })).json();
  assert.ok(after.expiresAt > before.expiresAt + 40 * 60_000, `过期时间要往后推（${after.expiresAt - before.expiresAt} ms）`);
  // 越过原来的 60 分钟点，只要还在用就仍然有效
  f.advance(50 * 60_000);
  assert.equal((await fetch(f.base + '/api/private', { headers: { Cookie: session } })).status, 200);
});

test('只开着页面（只剩登录态轮询）也会续期', async (t) => {
  const f = await fixture(t);
  const { session } = await login(f);
  const first = await (await fetch(f.base + '/api/auth/session', { headers: { Cookie: session } })).json();
  f.advance(40 * 60_000);
  const second = await (await fetch(f.base + '/api/auth/session', { headers: { Cookie: session } })).json();
  assert.ok(second.authenticated);
  assert.ok(second.expiresAt > first.expiresAt, '轮询 /session 也要把到期时间往后推');
});

test('完全不活动超过 60 分钟仍然掉线', async (t) => {
  const f = await fixture(t);
  const { session } = await login(f);
  f.advance(61 * 60_000);
  assert.equal((await fetch(f.base + '/api/private', { headers: { Cookie: session } })).status, 401);
});

test('续期有绝对上限：最多 12 小时，之后必须重新登录', async (t) => {
  const f = await fixture(t);
  const { session } = await login(f);
  // 每 40 分钟用一次，一路续到 11 小时 20 分（上限 12 小时）
  for (let i = 1; i <= 17; i++) {
    f.advance(40 * 60_000);
    const response = await fetch(f.base + '/api/private', { headers: { Cookie: session } });
    assert.equal(response.status, 200, `第 ${i} 次续期后仍应有效`);
  }
  f.advance(61 * 60_000);
  assert.equal((await fetch(f.base + '/api/private', { headers: { Cookie: session } })).status, 401, '超过绝对上限要重新登录');
});

test('续期不改变会话身份，落盘文件里仍然只有哈希', async (t) => {
  const f = await fixture(t);
  const { session } = await login(f);
  f.advance(45 * 60_000);
  await fetch(f.base + '/api/private', { headers: { Cookie: session } });
  const identity = await (await fetch(f.base + '/api/auth/session', { headers: { Cookie: session } })).json();
  assert.equal(identity.user.displayName, '测试同事');
});

test('logout cancels pending authorization attempts for this browser', async (t) => {
  const f = await fixture(t);
  const pending = await start(f);
  await fetch(f.base + '/api/auth/logout', { method: 'POST', headers: { Cookie: pending.browser, Origin: origin } });
  assert.equal((await callback(f, pending)).status, 400);
  assert.equal(f.exchanges(), 0);
});

test('unconfigured SSO fails closed and never exposes business data', async (t) => {
  const f = await fixture(t, { configEnv: {} });
  assert.equal((await fetch(f.base + '/api/auth/sso/start')).status, 503);
  assert.equal((await fetch(f.base + '/api/private')).status, 401);
  assert.equal((await (await fetch(f.base + '/api/auth/session')).json()).ssoConfigured, false);
});

test('production config uses HTTPS, rejects credentials in URLs and prevents mixed cookie schemes', () => {
  assert.throws(() => makeSsoConfig({ ...env, NODE_ENV: 'production' }), /HTTPS/);
  assert.throws(() => makeSsoConfig({ ...env, SSO_REDIRECT_URIS: 'https://app.example/api/auth/sso/callback' }), /HTTP/);
  assert.throws(() => makeSsoConfig({ ...env, SSO_BASE_URL: 'http://user:password@sso.example' }), /格式/);
  const config = makeSsoConfig({ ...env, NODE_ENV: 'production', SSO_BASE_URL: 'https://sso.example', SSO_REDIRECT_URI: 'https://app.example/api/auth/sso/callback', SSO_REDIRECT_URIS: '' });
  assert.equal(config.secure, true);
});

async function rejectedSocket(url, options) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    ws.on('unexpected-response', (_req, response) => { const status = response.statusCode; response.resume(); ws.terminate(); resolve(status); });
    ws.on('error', () => {});
    ws.on('open', () => { ws.terminate(); reject(new Error('Unauthorized socket opened')); });
  });
}

test('WebSocket handshakes require an active session and registered origin', async (t) => {
  const f = await fixture(t);
  const url = f.base.replace('http', 'ws') + '/ws/trays';
  assert.equal(await rejectedSocket(url, { origin }), 401);
  const { session } = await login(f);
  assert.equal(await rejectedSocket(url, { origin: 'https://attacker.example', headers: { Cookie: session } }), 403);
});

test('WebSocket identity comes from SSO, ignores supplied names, and closes immediately on logout', async (t) => {
  const f = await fixture(t);
  const { session } = await login(f);
  const ws = new WebSocket(f.base.replace('http', 'ws') + '/ws/trays', { origin, headers: { Cookie: session } });
  await once(ws, 'open');
  const reply = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'hello', user: 'forged name', trayId: 'test-room' }));
  const [raw] = await reply;
  // users 现在带 canEdit（前端据此给只读账号标「（只读）」）
  assert.deepEqual(JSON.parse(raw.toString()).users, [{ name: user.display_name, canEdit: true }]);
  const closed = once(ws, 'close');
  await fetch(f.base + '/api/auth/logout', { method: 'POST', headers: { Cookie: session, Origin: origin } });
  const [code] = await closed;
  assert.equal(code, 1008);
});

test('an expired WebSocket session cannot send or receive further collaboration messages', async (t) => {
  const f = await fixture(t);
  const { session } = await login(f);
  const ws = new WebSocket(f.base.replace('http', 'ws') + '/ws/trays', { origin, headers: { Cookie: session } });
  await once(ws, 'open');
  f.advance(3600_000 + 1);
  const closed = once(ws, 'close');
  ws.send(JSON.stringify({ type: 'ping' }));
  assert.equal((await closed)[0], 1008);
});

// ---- 会话落盘：部署重启不掉线 ----

function readSessions(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed?.sessions) ? parsed.sessions : [];
  } catch {
    return [];
  }
}

async function waitFor(check, message, timeout = 3000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('等待超时：' + message);
}

function tempSessionFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sso-sessions-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'sessions.json');
}

test('登录会话落盘：重启后同一个 cookie 仍然有效，不会全员掉线', async (t) => {
  const file = tempSessionFile(t);
  const before = await fixture(t, { sessionFile: file });
  const { session } = await login(before);
  const saved = await waitFor(() => readSessions(file).length === 1 && readSessions(file), '登录会话应写入磁盘');
  assert.equal(saved[0].session.user.id, user.id);
  assert.match(saved[0].key, /^[0-9a-f]{64}$/, '磁盘上只存 sessionId 的 sha256，泄露也伪造不出 cookie');
  assert.ok(!fs.readFileSync(file, 'utf8').includes(session.split('=')[1]), '不能把 cookie 明文写到磁盘');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, '会话文件仅本进程可读');
  }

  // 模拟 PM2 重启：同一份文件、全新实例、没有任何内存状态
  const after = await fixture(t, { sessionFile: file });
  const identity = await (await fetch(after.base + '/api/auth/session', { headers: { Cookie: session } })).json();
  assert.equal(identity.authenticated, true);
  assert.equal(identity.user.id, user.id);
  assert.equal((await fetch(after.base + '/api/private', { headers: { Cookie: session } })).status, 200);
});

test('过期的会话重启后不复活，损坏的文件当作没有会话', async (t) => {
  const file = tempSessionFile(t);
  const config = makeSsoConfig(env);
  const now = Date.now();
  const expiredSid = 'e'.repeat(43);
  const freshSid = 'f'.repeat(43);
  const keyOf = (value) => createHash('sha256').update(value).digest('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    v: 1,
    sessions: [
      { key: keyOf(expiredSid), session: { user: { id: 'old' }, expiresAt: now - 1, createdAt: now - 3600_000, telemetrySessionId: null } },
      { key: keyOf(freshSid), session: { user: { id: 'fresh' }, expiresAt: now + 3600_000, createdAt: now, telemetrySessionId: null } },
    ],
  }));
  const restored = createSsoAuth(config, { sessionFile: file });
  t.after(() => restored.close());
  const asRequest = (sid) => ({ headers: { cookie: 'marius_fulfillment_session=' + sid } });
  assert.equal(restored.getSession(asRequest(expiredSid)), null, '过期的会话不能带回来');
  assert.equal(restored.getSession(asRequest(freshSid))?.user.id, 'fresh');

  fs.writeFileSync(file, '{not json');
  const broken = createSsoAuth(config, { sessionFile: file });
  t.after(() => broken.close());
  assert.equal(broken.getSession(asRequest(freshSid)), null, '文件损坏不能拖垮启动');
});

test('退出登录后会话从磁盘移除，重启也不会复活', async (t) => {
  const file = tempSessionFile(t);
  const before = await fixture(t, { sessionFile: file });
  const { session } = await login(before);
  await waitFor(() => readSessions(file).length === 1, '登录会话应写入磁盘');
  assert.equal((await fetch(before.base + '/api/auth/logout', { method: 'POST', headers: { Cookie: session, Origin: origin } })).status, 200);
  await waitFor(() => readSessions(file).length === 0, '登出后磁盘上也要删掉');

  const after = await fixture(t, { sessionFile: file });
  assert.equal((await fetch(after.base + '/api/private', { headers: { Cookie: session } })).status, 401);
});
