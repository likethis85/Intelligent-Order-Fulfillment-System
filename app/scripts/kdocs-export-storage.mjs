// 把金山文档登录态从本地 Chrome profile 导出成 storageState JSON
// 用法: node scripts/kdocs-export-storage.mjs
// 前提: 之前已用 scripts/kdocs-auth.mjs 登录过一次（~/.kdocs-auth-profile 存在）
// 输出: ~/.kdocs-storage-state.json（几 KB，含 cookies + localStorage + sessionStorage）
//       把这个文件 scp 到服务器，scripts/kdocs-sync-cost.mjs 会自动用它登录
import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';
import os from 'os';

const PROFILE = path.join(os.homedir(), '.kdocs-auth-profile');
const OUT = path.join(os.homedir(), '.kdocs-storage-state.json');
const url = process.argv[2] || 'https://www.kdocs.cn/l/cknMsjY1zPlI';

if (!fs.existsSync(PROFILE)) {
  console.error('❌ 没找到 profile:', PROFILE);
  console.error('   先跑一次 node scripts/kdocs-auth.mjs 登录');
  process.exit(1);
}

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome',
  headless: false,
  viewport: null,
});
try {
  const page = ctx.pages()[0] || await ctx.newPage();
  console.log('打开金山文档:', url);
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(8000);

  const finalUrl = page.url();
  // 简单判断：登录页通常包含 login/passport；未登录会被重定向
  if (/login|passport/i.test(finalUrl)) {
    console.error('❌ 当前未登录（URL:', finalUrl, '）');
    console.error('   先跑 node scripts/kdocs-auth.mjs 登录一次');
    process.exit(2);
  }

  const state = await ctx.storageState({ path: OUT });
  const cookieCount = state.cookies.length;
  const originCount = state.origins.length;
  const sizeKB = (fs.statSync(OUT).size / 1024).toFixed(1);
  console.log(`✓ 已导出到: ${OUT}`);
  console.log(`  cookies: ${cookieCount} 个`);
  console.log(`  origins (localStorage/sessionStorage): ${originCount} 个`);
  console.log(`  大小: ${sizeKB} KB`);
  console.log(`\n下一步：scp ${OUT} user@server:~/`);
} finally {
  await ctx.close();
}
process.exit(0);
