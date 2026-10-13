// 建立 et 会话 → 带 session 信息重试导出
import { chromium } from 'playwright-core';

const PROFILE = process.env.HOME + '/.kdocs-auth-profile';
const LINK = 'cknMsjY1zPlI';
const FID = '507803393419';

const ctx = await chromium.launchPersistentContext(PROFILE, { channel: 'chrome', headless: true });
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto(`https://www.kdocs.cn/l/${LINK}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(6000);

// 1) 建会话
const sres = await page.request.get(`https://www.kdocs.cn/api/v3/office/session/${LINK}/et?first`);
const sjson = await sres.json().catch(() => ({}));
console.log('session:', sres.status(), JSON.stringify(sjson).slice(0, 200));
const sessId = sjson.sessionId;   // "edit/507803393419"
const sessToken = sjson.token;

const base = { 'Content-Type': 'application/json' };
const variants = [
  ['headers x-session-id', { ...base, 'x-session-id': sessId }],
  ['headers x-ks-session', { ...base, 'x-ks-session': sessToken }],
  ['headers Authorization', { ...base, Authorization: `Bearer ${sessToken}` }],
  ['query session_id', null, `&session_id=${encodeURIComponent(sessId)}`],
  ['query token', null, `&token=${sessToken}`],
];
for (const [name, headers, extra] of variants) {
  const url = `https://www.kdocs.cn/api/v3/office/file/${LINK}/export${extra || ''}`;
  try {
    const res = await page.request.post(url, { headers: headers || base, data: { type: 'xlsx' } });
    const text = await res.text();
    console.log(name, '→', res.status(), text.slice(0, 250));
  } catch (e) { console.log(name, '→ ERROR', e.message); }
}
await ctx.close();
process.exit(0);
