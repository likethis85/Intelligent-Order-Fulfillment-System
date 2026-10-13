// Isolated authentication acceptance: simulated identity provider and in-memory business data.
// The deployed SSO is used only for read-only checks of its real login entry.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createSsoAuth, makeSsoConfig, readSsoConfig } from '../../app/server/sso-auth.js';
import { getRoleRules } from '../../app/server/role-rules.js';
import { getSceneRules } from '../../app/server/scene-rules.js';
import { getStrategyRules } from '../../app/server/strategy-rules.js';
import { getWeatherRules } from '../../app/server/weather-rules.js';

const require = createRequire(new URL('../../app/package.json', import.meta.url));
const express = require('express');
const { chromium } = require('playwright-core');
const out = path.dirname(fileURLToPath(import.meta.url));
const mobileSource = await fs.readFile(new URL('../mobile/browser-check.mjs', import.meta.url), 'utf8');
const fixtureSource = mobileSource.slice(mobileSource.indexOf('const garment ='), mobileSource.indexOf('const ruleFixtures ='));
const { products, sampleTrays, profile, cities, ids } = runInNewContext(fixtureSource + '\n({products,sampleTrays,profile,cities,ids})', { encodeURIComponent });
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=', 'base64');
sampleTrays[0].sections[0].looks[0].userImg = '/uploads/auth-fixture.png';
products[1].img = 'https://img.alicdn.com/sso-fixture.png';
const rules = { 'role-rules': getRoleRules(), 'scene-rules': getSceneRules(), 'strategy-rules': getStrategyRules(), 'weather-rules': getWeatherRules() };
const reports = [], errors = [];
let simulatedWrites = 0, exchanges = 0, protectedImageReads = 0, tokenFails = false, dingtalkFails = false, sessionUnavailable = false, timeOffset = 0;
const now = () => Date.now() + timeOffset;
const codes = new Map();
const dingTalkSessions = new Map();
const sso = express();
sso.use(express.urlencoded({ extended: false }));
sso.use(express.json());
sso.get('/authorize', (req, res) => {
  const sid = crypto.randomUUID().replaceAll('-', '');
  dingTalkSessions.set(sid, { redirect_uri: req.query.redirect_uri, state: req.query.state });
  const action = '/verify?' + new URLSearchParams({ redirect_uri: req.query.redirect_uri, state: req.query.state });
  res.send(`<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><title>验收身份源</title><body><h1>模拟身份验证</h1><form action="${action.replaceAll('&', '&amp;')}" method="post"><button>以验收同事登录</button></form><form action="/authorize/${sid}/dingtalk" method="post"><button>模拟钉钉登录</button></form></body></html>`);
});
sso.post('/authorize/:sid/dingtalk', (req, res) => {
  if (dingtalkFails) return res.sendStatus(503);
  assert.ok(dingTalkSessions.has(req.params.sid));
  const target = new URL('https://login.dingtalk.com/oauth2/auth');
  target.searchParams.set('state', req.params.sid);
  target.searchParams.set('redirect_uri', 'http://127.0.0.1:' + ssoServer.address().port + '/login/callback');
  res.redirect(303, target.toString());
});
sso.post('/verify', (req, res) => {
  const code = crypto.randomUUID();
  codes.set(code, true);
  const url = new URL(req.query.redirect_uri);
  url.searchParams.set('code', code);
  url.searchParams.set('state', req.query.state);
  res.redirect(303, url.toString());
});
sso.post('/token', (req, res) => {
  exchanges++;
  assert.equal(req.body.client_secret, 'fixture-server-secret');
  if (tokenFails || !codes.delete(req.body.code)) return res.status(400).json({ error: 'invalid_grant' });
  res.json({ access_token: 'fixture-upstream-token', token_type: 'Bearer', expires_in: 3600, expires_at: Math.floor(now() / 1000) + 3600, user: { id: 'u_browser_test', provider: 'dingtalk', email: null, display_name: '验收同事', avatar_url: null } });
});
const ssoServer = http.createServer(sso).listen(0, '127.0.0.1');
await once(ssoServer, 'listening');
const app = express();
const server = http.createServer(app).listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = 'http://127.0.0.1:' + server.address().port;
const config = makeSsoConfig({ SSO_BASE_URL: 'http://127.0.0.1:' + ssoServer.address().port, SSO_CLIENT_ID: 'app_browser_test', SSO_CLIENT_SECRET: 'fixture-server-secret', SSO_REDIRECT_URI: origin + '/api/auth/sso/callback' });
const auth = createSsoAuth(config, { now });
app.use(express.json());
app.use('/api/auth', auth.router);
app.use('/api', auth.requireSession);
app.use('/api', (req, res) => {
  const p = req.path;
  let data = {};
  if (p === '/image-proxy') { protectedImageReads++; return res.type('png').send(image); }
  if (req.method !== 'GET') { simulatedWrites++; data = { ok: true, message: '验收内存响应' }; }
  else if (p === '/products') data = { items: products, source: 'sso-browser-fixture', updatedAt: new Date().toISOString() };
  else if (p === '/products/meta/filters') data = { categories: ['大衣', '西装', '裤装', '针织'], waves: ['10A'], tempBands: ['0~12°C'], priceBands: ['低', '中', '高'], roles: ['引流', '利润'], launchYears: [2026] };
  else if (p === '/trays') data = { trays: sampleTrays, updatedAt: Date.now() };
  else if (p === '/trays/log') data = { entries: [] };
  else if (p.startsWith('/config/')) data = { rules: rules[p.split('/').at(-1)] };
  else if (p === '/weather') data = { cities, failed: [], updateTime: new Date().toISOString(), cachedSecondsAgo: 0 };
  else if (p === '/profiles/stores') data = { stores: [{ store: profile.store, month: '2026-09', months: [202609] }] };
  else if (p.startsWith('/profiles/store/')) data = { profile };
  else if (p === '/profiles/sku-codes') data = { codes: ids };
  else if (p.startsWith('/profiles/sku/')) data = { profile, availablePlatforms: ['淘宝', '抖音'] };
  else if (p === '/profiles/anchors') data = { anchors: [{ name: '验收主播', totalQty: 12680 }] };
  else if (p === '/profiles/anchors/hot') data = { hot: ids.map((pdtCode, i) => ({ pdtCode, qty: 1200 - i * 80, ratio: 12 - i })) };
  else if (p === '/profiles/anchors/audience') data = { profile, used: ids.map((pdtCode) => ({ pdtCode, qty: 1000 })), missing: [], topN: 20, name: req.query.name, updatedAt: new Date().toISOString() };
  else if (p.includes('hengji') && p.includes('status')) data = { loggedIn: true };
  else data = { items: [], count: 0, years: [2026] };
  res.json(data);
});
app.use('/uploads', auth.requireSession, (_req, res) => { protectedImageReads++; res.type('png').send(image); });
app.use(express.static(fileURLToPath(new URL('../../app/dist/', import.meta.url))));

const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
let activePage;
function record(name, detail = {}) { reports.push({ name, passed: true, ...detail }); }
async function measure(page, name, width) {
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(scrollWidth <= width + 1, `${name}: viewport ${width}, document ${scrollWidth}`);
  record(name, { width, scrollWidth });
}
async function signIn(page, dingtalk = false) {
  await page.getByRole('link', { name: dingtalk ? '钉钉登录' : '统一账号登录', exact: true }).click();
  await page.getByRole('button', { name: '以验收同事登录' }).click();
  await page.getByRole('heading', { name: '货盘', exact: true }).waitFor();
}
try {
  for (const width of [320, 390, 768, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: width < 768, isMobile: width < 768 });
    await context.route(origin + '/api/auth/session', (route) => sessionUnavailable
      ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"isolated_connection_failure"}' })
      : route.continue());
    await context.route('https://img.alicdn.com/sso-fixture.png', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: image }));
    // Playwright routes only the first request in a redirect chain. Capture the
    // real app start response and simulate the external QR page without leaving
    // the isolated fixture; preserve its browser-binding Set-Cookie header.
    await context.route(origin + '/api/auth/sso/start**', async (route) => {
      if (new URL(route.request().url()).searchParams.get('provider') !== 'dingtalk') return route.continue();
      const response = await route.fetch({ maxRedirects: 0 });
      if (response.status() !== 302) return route.fulfill({ response });
      const target = new URL(response.headers().location);
      assert.equal(target.origin, 'https://login.dingtalk.com');
      const pending = dingTalkSessions.get(target.searchParams.get('state'));
      assert.ok(pending);
      const action = config.baseUrl + '/verify?' + new URLSearchParams(pending);
      const headers = { ...response.headers(), 'content-type': 'text/html; charset=utf-8' };
      delete headers.location;
      delete headers['content-length'];
      return route.fulfill({ response, status: 200, headers, body: `<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><title>模拟钉钉扫码</title><body><h1>模拟钉钉扫码</h1><form method="post" action="${action.replaceAll('&', '&amp;')}"><button>以验收同事登录</button></form></body></html>` });
    });
    context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
    const page = await context.newPage();
    activePage = page;
    const businessRequests = [];
    page.on('request', (request) => { if (new URL(request.url()).pathname.startsWith('/api/') && !new URL(request.url()).pathname.startsWith('/api/auth/')) businessRequests.push(request.url()); });
    page.on('dialog', async (dialog) => { errors.push('Unexpected name prompt: ' + dialog.message()); await dialog.dismiss(); });
    await context.addInitScript(() => {
      window.WebSocket = class { constructor() { this.readyState = 0; } close() { this.readyState = 3; } send() {} };
    });
    await page.goto(origin + '/?tab=retained');
    await page.getByRole('heading', { name: '登录工作台' }).waitFor();
    assert.equal(businessRequests.length, 0);
    record('登录前不挂载业务页面或请求业务接口', { width });
    await measure(page, '登录页宽度', width);
    await page.getByRole('link', { name: '钉钉登录', exact: true }).waitFor();
    await page.getByRole('link', { name: '统一账号登录', exact: true }).waitFor();
    record('登录页同时提供钉钉与统一账号入口', { width });
    await signIn(page, width === 390 || width === 1440);
    assert.equal(new URL(page.url()).searchParams.get('tab'), 'retained');
    record('SSO 回调进入货盘并保留原页面参数', { width, provider: width === 390 || width === 1440 ? '模拟钉钉' : '模拟统一账号' });
    const sessionCookie = (await context.cookies()).find((cookie) => cookie.name === 'marius_fulfillment_session');
    assert.equal(sessionCookie.httpOnly, true);
    assert.equal(sessionCookie.sameSite, 'Lax');
    assert.ok(!(await page.evaluate(() => document.cookie)).includes('marius_fulfillment_session'));
    const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    assert.ok(!storage.includes('fixture-upstream-token') && !storage.includes('fixture-server-secret'));
    record('身份凭证与应用会话不暴露给前端脚本或本地存储', { width });
    await page.getByRole('button', { name: '退出登录（验收同事）' }).waitFor();
    await measure(page, '登录后货盘宽度', width);
    if (width === 390) {
      await page.locator('.tray-card').filter({ hasText: '马总场' }).first().click();
      await page.getByRole('heading', { name: '马总场', exact: true }).waitFor();
      await measure(page, '登录后货盘编辑宽度', width);
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: '导出 Excel', exact: true }).click();
      await page.getByRole('button', { name: '货盘布局（同款盘格式）', exact: true }).click();
      const workbookPath = path.join(process.env.TEMP, 'marius-sso-export-check.xlsx');
      await (await download).saveAs(workbookPath);
      const { Workbook } = require('exceljs');
      const workbook = new Workbook();
      await workbook.xlsx.readFile(workbookPath);
      const images = workbook.worksheets.reduce((count, sheet) => count + sheet.getImages().length, 0);
      assert.ok(images >= 2 && protectedImageReads >= 2);
      record('登录后导出 Excel 成功且包含受保护的上传图与代理图', { embeddedImages: images });
      await page.getByRole('button', { name: '返回清单', exact: true }).click();
    }
    for (const label of ['直播排品', '画像卡片', '天气面板', '配置后台', '货盘']) {
      await page.locator('nav:visible').getByRole('button', { name: label, exact: true }).click();
      await page.waitForTimeout(180);
      await measure(page, '登录后页面：' + label, width);
    }
    await page.reload();
    await page.getByRole('heading', { name: '货盘', exact: true }).waitFor();
    record('刷新后恢复登录态', { width });
    if (width === 390 || width === 1440) await page.screenshot({ path: path.join(out, `authenticated-${width}.png`), fullPage: false });
    await page.getByRole('button', { name: '退出登录（验收同事）' }).click();
    await page.getByRole('heading', { name: '登录工作台' }).waitFor();
    assert.equal((await context.request.get(origin + '/api/trays')).status(), 401);
    record('退出后业务页面隐藏且接口拒绝访问', { width });
    if (width === 390) {
      sessionUnavailable = true;
      await page.reload();
      await page.getByRole('button', { name: '重新检查', exact: true }).waitFor();
      await page.getByText('暂时无法连接系统，请稍后重试。', { exact: true }).waitFor();
      sessionUnavailable = false;
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await page.getByRole('link', { name: '钉钉登录', exact: true }).waitFor();
      await page.getByText('暂时无法连接系统，请稍后重试。', { exact: true }).waitFor({ state: 'hidden' });
      record('后端连接恢复后自动恢复登录按钮并清除旧连接失败提示');
      await signIn(page);
      timeOffset += 3600_001;
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await page.getByRole('heading', { name: '登录工作台' }).waitFor();
      assert.equal((await context.request.get(origin + '/api/trays')).status(), 401);
      record('后台会话到期后返回登录页');
      timeOffset = 0;
      tokenFails = true;
      await page.getByRole('link', { name: '统一账号登录', exact: true }).click();
      await page.getByRole('button', { name: '以验收同事登录' }).click();
      await page.getByText('这次登录未完成或已超时，请重新登录。', { exact: true }).waitFor();
      assert.ok(!page.url().includes('sso_error') && !page.url().includes('code='));
      record('授权码失败展示可重试提示并清理回调参数');
      tokenFails = false;
      dingtalkFails = true;
      await page.getByRole('link', { name: '钉钉登录', exact: true }).click();
      await page.getByText('暂时无法打开钉钉登录，请重试或使用统一账号登录。', { exact: true }).waitFor();
      assert.ok(!page.url().includes('sso_error'));
      dingtalkFails = false;
      await signIn(page);
      record('钉钉入口不可用时提示重试，统一账号登录仍可用');
    }
    await context.close();
  }

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  activePage = page;
  page.on('pageerror', (error) => errors.push(error.message));
  const requests = [];
  page.on('request', (request) => { const p = new URL(request.url()).pathname; if (p.startsWith('/api/') && !p.startsWith('/api/auth/')) requests.push(p); });
  await page.goto('http://127.0.0.1:3000');
  await page.getByRole('heading', { name: '登录工作台' }).waitFor();
  assert.equal(requests.length, 0);
  await page.screenshot({ path: path.join(out, 'login-390.png'), fullPage: false });
  record('实际开发项目的登录页可用且无匿名业务请求');
  await page.getByRole('link', { name: '统一账号登录', exact: true }).click();
  const actualSsoOrigin = new URL(readSsoConfig().baseUrl).origin;
  await page.waitForURL((url) => url.origin === actualSsoOrigin && url.pathname === '/authorize');
  await page.getByText('智慧货盘选款系统', { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('redirect_uri'), 'http://127.0.0.1:3000/api/auth/sso/callback');
  assert.equal(new URL(page.url()).searchParams.get('client_secret'), null);
  await page.screenshot({ path: path.join(out, 'sso-entry-390.png'), fullPage: false });
  record('真实 SSO 登录入口显示登记应用，回调匹配且不携带客户端密钥');
  assert.equal((await context.request.get('http://127.0.0.1:3737/api/trays')).status(), 401);
  assert.equal((await context.request.get('http://127.0.0.1:3737/uploads/nonexistent.png')).status(), 401);
  record('实际后端的业务与上传资源均需要登录');
  await page.goto('http://127.0.0.1:3000');
  let dingTalkUrl;
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === 'https://login.dingtalk.com' && url.pathname === '/oauth2/auth') dingTalkUrl = url;
  });
  await page.getByRole('link', { name: '钉钉登录', exact: true }).click();
  await page.waitForURL((url) => url.origin === 'https://login.dingtalk.com', { waitUntil: 'domcontentloaded' });
  assert.ok(dingTalkUrl);
  assert.equal(dingTalkUrl.searchParams.get('redirect_uri'), actualSsoOrigin + '/login/callback');
  assert.equal(dingTalkUrl.searchParams.get('client_secret'), null);
  await page.getByRole('tab', { name: '扫码登录', exact: true }).click();
  await page.locator('.app-page-curr').getByText('使用钉钉扫码', { exact: true }).waitFor();
  const qr = page.locator('.app-page-curr canvas').first();
  await qr.waitFor();
  await page.waitForFunction(() => {
    const canvas = document.querySelector('.app-page-curr canvas');
    if (!canvas || canvas.width < 100 || canvas.height < 100) return false;
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    return pixels.some((value, i) => i % 4 === 0 && value < 100 && pixels[i + 3] > 0);
  });
  await page.screenshot({ path: path.join(out, 'dingtalk-entry-390.png'), fullPage: false });
  record('真实项目钉钉按钮直达官方扫码页面，回调使用新 HTTPS 域名');
  await page.goto('http://127.0.0.1:3000');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('link', { name: '钉钉登录', exact: true }).waitFor();
  await page.screenshot({ path: path.join(out, 'login-1440.png'), fullPage: false });
  await context.close();
  assert.equal(errors.length, 0, JSON.stringify(errors));
  await fs.writeFile(path.join(out, 'browser-results.json'), JSON.stringify({ checks: reports.length, simulatedTokenExchanges: exchanges, interceptedInMemoryWrites: simulatedWrites, protectedImageReads, realBusinessWrites: 0, reports, errors, realUserLoginCompleted: false }, null, 2) + '\n');
  console.log(JSON.stringify({ checks: reports.length, errors, realBusinessWrites: 0, realUserLoginCompleted: false }));
} catch (error) {
  if (activePage && !activePage.isClosed()) await activePage.screenshot({ path: path.join(process.env.TEMP, 'marius-sso-browser-failure.png'), fullPage: false }).catch(() => {});
  console.error(JSON.stringify({ reports: reports.slice(-8), errors, error: error.message }));
  throw error;
} finally {
  await browser.close(); auth.close();
  await Promise.all([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => ssoServer.close(resolve))]);
}
