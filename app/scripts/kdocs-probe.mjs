// 用已登录的 profile 打开核价表，抓取页面与其 API 响应，分析数据结构
import { chromium } from 'playwright-core';
import fs from 'fs';

const PROFILE = process.env.HOME + '/.kdocs-auth-profile';
const url = process.argv[2] || 'https://www.kdocs.cn/l/cknMsjY1zPlI';
const OUT = process.argv[3] || '/Users/laolin/.claude/jobs/56bed02d/tmp/kdocs-dump';

fs.mkdirSync(OUT, { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome',
  headless: true,
});
const page = ctx.pages()[0] || await ctx.newPage();

let apiCount = 0;
page.on('response', async (res) => {
  const u = res.url();
  if (!/kdocs|wps|ksos|wss|kingsoft/i.test(u)) return;
  if (/\.(js|css|png|jpg|svg|woff|gif)(\?|$)/.test(u)) return;
  const ct = res.headers()['content-type'] || '';
  if (!/json/.test(ct)) return;
  try {
    const body = await res.text();
    if (body.length < 10) return;
    const name = `api-${String(++apiCount).padStart(3, '0')}.json`;
    fs.writeFileSync(`${OUT}/${name}`, `URL: ${u}\n\n${body.slice(0, 200000)}`);
    console.log('saved', name, u.slice(0, 120), body.length, 'bytes');
  } catch {}
});

console.log('打开:', url);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => console.log('goto:', e.message));
await page.waitForTimeout(12000); // 等表格渲染 + API 稳定

console.log('最终 URL:', page.url());
console.log('标题:', await page.title().catch(() => '?'));
fs.writeFileSync(`${OUT}/page.html`, await page.content());
const text = await page.evaluate(() => document.body.innerText.slice(0, 3000)).catch(() => '');
fs.writeFileSync(`${OUT}/page-text.txt`, text);
console.log('页面正文前 500 字:\n', text.slice(0, 500));
await ctx.close();
process.exit(0);
