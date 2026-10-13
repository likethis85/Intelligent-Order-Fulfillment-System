// 启动带持久化 profile 的 Chrome 打开金山文档，供用户手动登录
// 用法: node scripts/kdocs-auth.mjs [url]
import { chromium } from 'playwright-core';
import path from 'path';
import os from 'os';

const PROFILE = path.join(os.homedir(), '.kdocs-auth-profile');
const url = process.argv[2] || 'https://www.kdocs.cn/l/cknMsjY1zPlI';

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome',
  headless: false,
  viewport: null,
});
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto(url);

console.log('浏览器已打开:', url);
console.log('登录完成后请回这里按回车继续（或直接关掉窗口结束）');

process.stdin.resume();
process.stdin.once('data', async () => {
  // 打印当前 URL 和 cookie 概况，供后续脚本判断登录态
  console.log('当前页面:', page.url());
  const cookies = await ctx.cookies('https://www.kdocs.cn');
  console.log('kdocs cookies:', cookies.map((c) => c.name).join(', '));
  await ctx.close();
  process.exit(0);
});
