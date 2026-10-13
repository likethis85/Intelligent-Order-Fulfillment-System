// 在已登录会话里尝试 kdocs 导出接口，拿到 xlsx 下载地址
import { chromium } from 'playwright-core';

const PROFILE = process.env.HOME + '/.kdocs-auth-profile';
const LINK = 'cknMsjY1zPlI';
const FID = '507803393419';

const ctx = await chromium.launchPersistentContext(PROFILE, { channel: 'chrome', headless: true });
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto(`https://www.kdocs.cn/l/${LINK}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(5000);

const tries = [
  ['POST', `https://www.kdocs.cn/api/v3/office/file/${LINK}/export`, { type: 'xlsx' }],
  ['POST', `https://www.kdocs.cn/api/v3/office/file/${FID}/export`, { type: 'xlsx' }],
  ['POST', `https://www.kdocs.cn/api/v3/office/file/${LINK}/export`, { format: 'xlsx' }],
  ['GET', `https://www.kdocs.cn/api/v3/office/file/${LINK}/export?type=xlsx`, null],
  ['GET', `https://www.kdocs.cn/api/v3/office/file/${FID}/export?type=xlsx`, null],
];

for (const [method, url, body] of tries) {
  try {
    const res = await page.request.fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      data: body || undefined,
    });
    const text = await res.text();
    console.log(method, url.replace('https://www.kdocs.cn', ''), '→', res.status(), text.slice(0, 300));
  } catch (e) {
    console.log(method, url, '→ ERROR', e.message);
  }
}
await ctx.close();
process.exit(0);
