import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { previewGuancliCard, runGuancli } from '../server/guancli.js';

const appDir = fileURLToPath(new URL('../', import.meta.url));

async function tempWorkspace(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'marius-runtime-test-'));
  t.after(async () => {
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('marius-runtime-test-')) throw new Error('Unexpected cleanup path');
    await rm(resolved, { recursive: true, force: true });
  });
  return root;
}

function useExecutable(t, executable) {
  const previous = process.env.GUANCLI_PATH;
  process.env.GUANCLI_PATH = executable;
  t.after(() => {
    if (previous === undefined) delete process.env.GUANCLI_PATH;
    else process.env.GUANCLI_PATH = previous;
  });
}

test('a missing BI executable rejects the request and leaves the process alive', async (t) => {
  const root = await tempWorkspace(t);
  useExecutable(t, path.join(root, 'missing-guancli.exe'));
  await assert.rejects(runGuancli(['card', 'preview', 'fixture']), { code: 'ENOENT', message: '观远 BI 数据工具 guancli 未安装或不在 PATH 中' });
  assert.equal(process.exitCode, undefined);
});

test('BI execution preserves Unicode/arguments and reports failures, timeouts and excessive output', async (t) => {
  useExecutable(t, process.execPath);
  const filter = '款式编码 = A & B; $(literal)';
  assert.equal(await runGuancli(['-e', 'process.stdout.write(process.argv[1])', filter]), filter);
  await assert.rejects(runGuancli(['-e', 'process.stderr.write("fixture failure"); process.exit(3)']), /exit 3.*fixture failure/);
  await assert.rejects(runGuancli(['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 }), /读取超时/);
  await assert.rejects(runGuancli(['-e', 'process.stdout.write("a".repeat(1024))'], { maxOutputBytes: 128 }), /超出读取限制/);
});

test('card previews use the OS temporary directory and clean up success and failure files', async (t) => {
  const previousCwd = process.cwd();
  t.after(() => process.chdir(previousCwd));
  const root = await tempWorkspace(t);
  process.chdir(root);
  useExecutable(t, process.execPath);
  // Node acts as a small executable fixture named "card"; no shell or real BI.
  await writeFile(path.join(root, 'card'), `
    const fs = require('node:fs');
    const output = process.argv[process.argv.indexOf('-o') + 1];
    fs.writeFileSync('last-output.txt', output);
    fs.writeFileSync(output, '款式编码,数量\\nFIXTURE,3\\n');
    if (process.argv.includes('fail')) process.exit(2);
  `);
  assert.equal(await previewGuancliCard('ok', { limit: 10 }), '款式编码,数量\nFIXTURE,3\n');
  const output = await readFile(path.join(root, 'last-output.txt'), 'utf8');
  assert.equal(path.dirname(output), path.resolve(tmpdir()));
  await assert.rejects(readFile(output), { code: 'ENOENT' });
  await assert.rejects(previewGuancliCard('fail'), /exit 2/);
  await assert.rejects(readFile(await readFile(path.join(root, 'last-output.txt'), 'utf8')), { code: 'ENOENT' });
});

async function isolatedBackend(t) {
  let child, upstreamServer;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
    if (upstreamServer) await new Promise((resolve) => upstreamServer.close(resolve));
  });
  const root = await tempWorkspace(t);
  await cp(path.join(appDir, 'server'), path.join(root, 'server'), {
    recursive: true,
    filter: (source) => !['.env', '.env.sso', '.cache', 'uploads'].includes(path.basename(source)),
  });
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await symlink(path.join(appDir, 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');

  let scmReads = 0;
  const upstream = express();
  upstream.use(express.json());
  upstream.post('/auth/token', (_req, res) => res.json({ isSuccess: true, data: { access_token: 'scm-fixture-token', expires_in: 7200 } }));
  upstream.post('/v1/Product/getproducts', (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer scm-fixture-token');
    scmReads++;
    res.json({ isSuccess: true, data: { datas: [{ pdtCode: 'RUNTIME001', pdtName: '隔离验收商品', retailPrice: 128, skus: [] }], totalCount: 1, hasNext: false } });
  });
  upstream.post('/token', (req, res) => {
    assert.equal(req.body.client_secret, 'sso-fixture-secret');
    res.json({ access_token: 'sso-fixture-token', token_type: 'Bearer', expires_in: 3600, user: { id: 'runtime_test', provider: 'dingtalk', display_name: '隔离验收同事' } });
  });
  upstreamServer = http.createServer(upstream).listen(0, '127.0.0.1');
  await once(upstreamServer, 'listening');
  const upstreamOrigin = 'http://127.0.0.1:' + upstreamServer.address().port;

  const reservation = http.createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const origin = 'http://127.0.0.1:' + port;
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, PORT: String(port), NODE_ENV: 'test',
      GUANCLI_PATH: path.join(root, 'missing-guancli.exe'),
      SUPABASE_URL: '', SUPABASE_KEY: '',
      VSCM_BASE_URL: upstreamOrigin, VSCM_APP_ID: 'fixture', VSCM_APP_SECRET: 'fixture', VSCM_LOOKBACK_DAYS: '1',
      SSO_BASE_URL: upstreamOrigin, SSO_CLIENT_ID: 'app_fixture', SSO_CLIENT_SECRET: 'sso-fixture-secret',
      SSO_REDIRECT_URI: origin + '/api/auth/sso/callback', SSO_REDIRECT_URIS: '',
      // 数据同步类接口现在仅管理员可用，夹具用户需要管理员身份才能覆盖该分支
      ACCESS_ADMIN_IDS: 'runtime_test',
    },
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error('Isolated backend exited: ' + output);
    try { ready = (await fetch(origin + '/api/health')).ok; } catch { /* Wait for the listener. */ }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.ok(ready, 'Isolated backend did not start: ' + output);
  const starting = await fetch(origin + '/api/auth/sso/start', { redirect: 'manual' });
  const state = new URL(starting.headers.get('location')).searchParams.get('state');
  const browserCookie = starting.headers.getSetCookie()[0].split(';')[0];
  const callback = await fetch(origin + '/api/auth/sso/callback?' + new URLSearchParams({ code: 'fixture-code', state }), { redirect: 'manual', headers: { Cookie: browserCookie } });
  assert.equal(callback.status, 303);
  const session = callback.headers.getSetCookie().find((value) => value.startsWith('marius_fulfillment_session=')).split(';')[0];
  return { origin, child, session, root, scmReads: () => scmReads };
}

test('real backend routes survive missing BI after SSO login, retain SCM data and support sync/logout', async (t) => {
  const f = await isolatedBackend(t);
  const headers = { Cookie: f.session };
  const products = await fetch(f.origin + '/api/products', { headers });
  assert.equal(products.status, 200);
  const body = await products.json();
  assert.equal(body.items[0].id, 'runtime001');
  assert.equal(body.items[0].name, '隔离验收商品');
  assert.equal(body.items[0].priceNum, 128);
  for (const [url, status] of [
    ['/api/products/meta/filters', 200], ['/api/products/runtime001', 200],
    ['/api/profiles/stores', 503], ['/api/profiles/sku-codes', 503], ['/api/profiles/anchors', 503],
    ['/api/remaining-inventory', 503], ['/api/sales/daily?date=2026-10-12&pids=RUNTIME001', 503],
    ['/api/sales/cumulative?pids=RUNTIME001', 503],
  ]) {
    const response = await fetch(f.origin + url, { headers });
    assert.equal(response.status, status, url);
    if (status === 503) assert.match((await response.json()).message, /guancli 未安装/);
    assert.equal((await fetch(f.origin + '/api/health')).status, 200);
    assert.equal((await (await fetch(f.origin + '/api/auth/session', { headers })).json()).authenticated, true);
    assert.equal(f.child.exitCode, null);
  }
  for (const cache of ['bi_daysales.json', 'bi_cumusales.json']) await assert.rejects(readFile(path.join(f.root, 'server', '.cache', cache)), { code: 'ENOENT' });
  const reads = f.scmReads();
  const sync = await fetch(f.origin + '/api/sync', { method: 'POST', headers: { ...headers, Origin: f.origin, 'Content-Type': 'application/json' }, body: '{"kind":"商品"}' });
  assert.equal(sync.status, 200);
  assert.equal((await sync.json()).ok, true);
  assert.ok(f.scmReads() > reads);
  assert.equal((await fetch(f.origin + '/api/auth/logout', { method: 'POST', headers: { ...headers, Origin: f.origin } })).status, 200);
  assert.equal((await (await fetch(f.origin + '/api/auth/session', { headers })).json()).authenticated, false);
  assert.equal((await fetch(f.origin + '/api/products', { headers })).status, 401);
  assert.equal((await fetch(f.origin + '/api/health')).status, 200);
});
