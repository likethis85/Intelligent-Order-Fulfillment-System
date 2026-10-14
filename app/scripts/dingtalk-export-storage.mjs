// 把钉钉文档登录态从本地 Chrome profile 导出成 storageState JSON
// 用法: node scripts/dingtalk-export-storage.mjs
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = path.join(os.homedir(), '.dingtalk-auth-profile');
const OUT = process.env.DINGTALK_STORAGE_STATE || path.join(os.homedir(), '.dingtalk-storage-state.json');
const SERVER_OUT = path.join(__dirname, '..', 'server', 'data', 'dingtalk-storage-state.json');

const DEFAULT_URL = 'https://alidocs.dingtalk.com/i/nodes/20eMKjyp81pMKDNaSr0ZG5RBJxAZB1Gv?corpId=ding63eff9039ed59ecb35c2f4657eb6378f&utm_medium=im_card&iframeQuery=sheet_range%3Ds2_0_2_0_1%26utm_medium%3Dim_card%26utm_source%3Dim&utm_scene=person_space&utm_source=im';
const url = process.argv[2] || process.env.DINGTALK_COST_URL || DEFAULT_URL;

if (!fs.existsSync(PROFILE)) {
  console.error('❌ 没找到 profile 目录:', PROFILE);
  console.error('   先跑一次 node scripts/dingtalk-auth.mjs 登录');
  process.exit(1);
}

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome',
  headless: false,
  viewport: null,
});
try {
  const page = ctx.pages()[0] || await ctx.newPage();
  console.log('打开钉钉文档:', url);
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(6000);

  const finalUrl = page.url();
  if (/login|challenge|passport/i.test(finalUrl)) {
    console.error('❌ 当前未登录（URL:', finalUrl, '）');
    console.error('   先跑 node scripts/dingtalk-auth.mjs 登录一次');
    process.exit(2);
  }

  const state = await ctx.storageState({ path: OUT });
  try {
    fs.mkdirSync(path.dirname(SERVER_OUT), { recursive: true });
    fs.copyFileSync(OUT, SERVER_OUT);
  } catch {}

  const cookieCount = state.cookies.length;
  const originCount = state.origins.length;
  const sizeKB = (fs.statSync(OUT).size / 1024).toFixed(1);
  console.log(`✓ 已导出到: ${OUT}`);
  console.log(`  cookies: ${cookieCount} 个`);
  console.log(`  origins: ${originCount} 个`);
  console.log(`  大小: ${sizeKB} KB`);
  console.log(`\n提示：该文件已自动同步到 server/data/dingtalk-storage-state.json，部署时将一并打包同步到服务器。`);
} finally {
  await ctx.close();
}
process.exit(0);
