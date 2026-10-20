// 检查钉钉文档登录态是否有效（headless，快速检查）
// 用法: node scripts/dingtalk-check-status.mjs
// 输出到 stdout（单行 JSON）：
//   { ok: true, loggedIn: true, finalUrl }
//   { ok: true, loggedIn: false, reason: 'no_credentials' | 'redirected_to_login', finalUrl }
//   { ok: false, error: '...' }
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = path.join(os.homedir(), '.dingtalk-auth-profile');
const USER_STORAGE_STATE = path.join(os.homedir(), '.dingtalk-storage-state.json');
const SERVER_STORAGE_STATE = path.join(__dirname, '..', 'server', 'data', 'dingtalk-storage-state.json');

const STORAGE_STATE = process.env.DINGTALK_STORAGE_STATE
  || (fs.existsSync(USER_STORAGE_STATE) ? USER_STORAGE_STATE : (fs.existsSync(SERVER_STORAGE_STATE) ? SERVER_STORAGE_STATE : USER_STORAGE_STATE));

const DEFAULT_URL = 'https://alidocs.dingtalk.com/i/nodes/20eMKjyp81pMKDNaSr0ZG5RBJxAZB1Gv?corpId=ding63eff9039ed59ecb35c2f4657eb6378f&utm_medium=im_card&iframeQuery=sheet_range%3Ds2_0_2_0_1%26utm_medium%3Dim_card%26utm_source%3Dim&utm_scene=person_space&utm_source=im';
const url = process.env.DINGTALK_COST_URL || DEFAULT_URL;

const emit = (obj) => process.stdout.write(JSON.stringify(obj));

// 优先检查 dws (dingtalk-workspace-cli) 是否已登录（毫秒级返回）
try {
  const rawDws = execSync('dws auth status -f json', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 2000 });
  const parsedDws = JSON.parse(rawDws);
  if (parsedDws && parsedDws.authenticated) {
    emit({ ok: true, loggedIn: true, engine: 'dws', profile: parsedDws.profile || null });
    process.exit(0);
  }
} catch {}

const hasStorage = fs.existsSync(STORAGE_STATE);
const hasProfile = fs.existsSync(PROFILE);

if (!hasStorage && !hasProfile) {
  emit({ ok: true, loggedIn: false, reason: 'no_credentials' });
  process.exit(0);
}

const isLinux = process.platform === 'linux';
const baseArgs = [
  '--disable-blink-features=AutomationControlled',
  ...(isLinux ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] : []),
];

// 探测一次；系统代理常把钉钉文档拦成白屏/超时，失败时再用 --no-proxy-server 直连重试
async function probe(useDirect) {
  const args = [...baseArgs, ...(useDirect ? ['--no-proxy-server'] : [])];
  let browser = null;
  let ctx = null;
  try {
    if (hasStorage) {
      browser = await chromium.launch({ channel: 'chrome', headless: true, args });
      ctx = await browser.newContext({ storageState: STORAGE_STATE });
    } else {
      ctx = await chromium.launchPersistentContext(PROFILE, { channel: 'chrome', headless: true, args });
    }
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(6000);
    const finalUrl = page.url();
    const body = await page.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '');
    const loaded = !!body.trim() && !/无法访问此网站|ERR_|响应时间过长/.test(body);
    return { finalUrl, body, loaded };
  } catch (err) {
    return { error: err.message, loaded: false };
  } finally {
    try { if (ctx) await ctx.close(); } catch {}
    try { if (browser) await browser.close(); } catch {}
  }
}

try {
  const forced = process.env.DINGTALK_PROXY;
  let r = await probe(forced === 'direct');
  if (!r.loaded && forced !== 'system') r = await probe(true);

  if (r.error) {
    emit({ ok: false, error: r.error });
  } else if (!r.loaded) {
    emit({ ok: true, loggedIn: false, reason: 'page_load_failed', finalUrl: r.finalUrl });
  } else if (/login|challenge|passport/i.test(r.finalUrl)) {
    emit({ ok: true, loggedIn: false, reason: 'redirected_to_login', finalUrl: r.finalUrl });
  } else if (/暂无权限|无权限访问|申请权限/.test(r.body)) {
    emit({ ok: true, loggedIn: true, noPermission: true, finalUrl: r.finalUrl });
  } else if (r.finalUrl.includes('alidocs.dingtalk.com/i/nodes/')) {
    emit({ ok: true, loggedIn: true, finalUrl: r.finalUrl });
  } else {
    emit({ ok: true, loggedIn: false, reason: 'unknown_page', finalUrl: r.finalUrl });
  }
} catch (err) {
  emit({ ok: false, error: err.message });
}
process.exit(0);
