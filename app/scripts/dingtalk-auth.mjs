// 启动带持久化 profile 的 Chrome 打开钉钉核价表，供用户手动登录
// 用法: node scripts/dingtalk-auth.mjs [url]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = path.join(os.homedir(), '.dingtalk-auth-profile');
const STORAGE_STATE = process.env.DINGTALK_STORAGE_STATE || path.join(os.homedir(), '.dingtalk-storage-state.json');
const SERVER_STORAGE_STATE = path.join(__dirname, '..', 'server', 'data', 'dingtalk-storage-state.json');

const DEFAULT_URL = 'https://alidocs.dingtalk.com/i/nodes/20eMKjyp81pMKDNaSr0ZG5RBJxAZB1Gv?corpId=ding63eff9039ed59ecb35c2f4657eb6378f&utm_medium=im_card&iframeQuery=sheet_range%3Ds2_0_2_0_1%26utm_medium%3Dim_card%26utm_source%3Dim&utm_scene=person_space&utm_source=im';
const url = process.argv[2] || process.env.DINGTALK_COST_URL || DEFAULT_URL;

console.log('🚀 正在启动 Chrome 浏览器登录钉钉文档...');
console.log('目标地址:', url);

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome',
  headless: false,
  viewport: null,
  permissions: ['clipboard-read', 'clipboard-write'],
});

const page = ctx.pages()[0] || await ctx.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});

console.log('\n======================================================');
console.log('📱 请在弹出的 Chrome 窗口中完成钉钉登录（扫码或账号登录）。');
console.log('   登录成功并进入表格后，脚本将自动保存登录凭证；');
console.log('   也可随时在控制台按回车键保存并退出。');
console.log('======================================================\n');

// 轮询检查是否已跳转进钉钉文档页面
let finished = false;
async function saveAndFinish(reason = '用户确认') {
  if (finished) return;
  finished = true;
  try {
    const finalUrl = page.url();
    console.log(`\n当前页面: ${finalUrl}`);
    const state = await ctx.storageState({ path: STORAGE_STATE });
    // 同时在 server/data/ 下备一份，方便部署打包
    try {
      fs.mkdirSync(path.dirname(SERVER_STORAGE_STATE), { recursive: true });
      fs.copyFileSync(STORAGE_STATE, SERVER_STORAGE_STATE);
    } catch {}

    const cookieCount = state.cookies?.length || 0;
    console.log(`✓ 登录凭证保存成功！(${reason})`);
    console.log(`  文件路径: ${STORAGE_STATE}`);
    console.log(`  包含 Cookies: ${cookieCount} 个`);
  } catch (err) {
    console.error('保存登录态异常:', err.message);
  } finally {
    try { await ctx.close(); } catch {}
    process.exit(0);
  }
}

// 自动检测成功进入文档（URL 留在 alidocs.dingtalk.com 且不含 login / challenge）
const checkInterval = setInterval(async () => {
  try {
    const cur = page.url();
    if (cur.includes('alidocs.dingtalk.com/i/nodes/') && !cur.includes('login') && !cur.includes('challenge')) {
      // 成功进入文档，稍等 3 秒让 token/cookie 存全
      clearInterval(checkInterval);
      console.log('🎉 检测到已进入钉钉表格页面，正在保存登录凭证...');
      await page.waitForTimeout(3000);
      await saveAndFinish('自动检测到已成功进入表格');
    }
  } catch {}
}, 2000);

if (process.stdin.isTTY) {
  process.stdin.resume();
  process.stdin.once('data', () => {
    clearInterval(checkInterval);
    saveAndFinish('手动按回车');
  });
}
