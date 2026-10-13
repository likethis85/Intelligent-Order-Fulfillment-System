// 检查金山文档登录态是否还有效（不复制表格，只验证能打开 + 工作表可见）
// 用法: node scripts/kdocs-check-status.mjs
// 输出到 stdout（一行 JSON）：
//   { ok: true, loggedIn: true,  finalUrl, sheets }
//   { ok: true, loggedIn: false, reason: 'no_credentials' | 'redirected_to_login' | 'sheets_not_found', finalUrl }
//   { ok: false, error: '...' }
import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';
import os from 'os';

const PROFILE = path.join(os.homedir(), '.kdocs-auth-profile');
const STORAGE_STATE = process.env.KDOCS_STORAGE_STATE || path.join(os.homedir(), '.kdocs-storage-state.json');
const LINK = process.env.KDOCS_LINK || 'cknMsjY1zPlI';
const url = `https://www.kdocs.cn/l/${LINK}`;

const emit = (obj) => process.stdout.write(JSON.stringify(obj));

if (!fs.existsSync(STORAGE_STATE) && !fs.existsSync(PROFILE)) {
  emit({ ok: true, loggedIn: false, reason: 'no_credentials' });
  process.exit(0);
}

let browser = null;
let ctx = null;
try {
  if (fs.existsSync(STORAGE_STATE)) {
    // 用系统 Chrome（channel: 'chrome'），无需额外装 playwright headless shell
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    ctx = await browser.newContext({ storageState: STORAGE_STATE });
  } else {
    ctx = await chromium.launchPersistentContext(PROFILE, { channel: 'chrome', headless: true });
  }
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  // 表格 + 工作表 tab 渲染需要时间
  await page.waitForTimeout(6000);
  const finalUrl = page.url();
  // 看到任一工作表 tab 就算登录成功
  const sheetCount = await page.getByText(/9-12月核价明细|1-8月核价明细/).count();
  if (/login|passport/i.test(finalUrl)) {
    emit({ ok: true, loggedIn: false, reason: 'redirected_to_login', finalUrl });
  } else if (sheetCount === 0) {
    emit({ ok: true, loggedIn: false, reason: 'sheets_not_found', finalUrl });
  } else {
    emit({ ok: true, loggedIn: true, finalUrl, sheets: sheetCount });
  }
} catch (err) {
  emit({ ok: false, error: err.message });
} finally {
  try { if (ctx) await ctx.close(); } catch {}
  try { if (browser) await browser.close(); } catch {}
}
process.exit(0);
