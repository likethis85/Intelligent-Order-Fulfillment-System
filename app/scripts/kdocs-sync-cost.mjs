// 从金山文档「新版2026核价表」同步款号→总成本 + 售价区间 到 server/data/hengji-cost.json
// 用法: node scripts/kdocs-sync-cost.mjs
// 前提（二选一）：
//   1) 已用 scripts/kdocs-auth.mjs 登录过一次（~/.kdocs-auth-profile 存在）
//   2) 已用 scripts/kdocs-export-storage.mjs 导出 ~/.kdocs-storage-state.json
//      （适合服务器部署：scp 这个文件过去，体积小、不含无关浏览数据）
// 优先级：storageState 存在就用它；否则回退到 persistent profile
// 机制：打开文档 → 逐个工作表 Ctrl+A/Ctrl+C → pbpaste 拿 TSV → 解析 款号/总成本/售价区间 列
// 注意：会短暂占用系统剪贴板
import { chromium } from 'playwright-core';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = path.join(os.homedir(), '.kdocs-auth-profile');
const STORAGE_STATE = process.env.KDOCS_STORAGE_STATE || path.join(os.homedir(), '.kdocs-storage-state.json');
const LINK = process.env.KDOCS_LINK || 'cknMsjY1zPlI';
const SHEETS = ['9-12月核价明细', '1-8月核价明细'];
const OUT_JSON = path.join(__dirname, '../server/data/hengji-cost.json');

// 极简 TSV 解析（支持引号包裹字段内含换行/制表符；WPS 表头有多行合并单元格）
function parseTsv(tsv) {
  const rows = [];
  let cur = [], field = '', inQ = false;
  for (let i = 0; i < tsv.length; i++) {
    const c = tsv[i];
    if (inQ) {
      if (c === '"') {
        if (tsv[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === '\t') { cur.push(field); field = ''; }
    else if (c === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; }
    else field += c;
  }
  if (field !== '' || cur.length) { cur.push(field); rows.push(cur); }
  return rows;
}

// 启动方式：优先 storageState（轻量、适合服务器）；回退到 persistent profile
let browser = null;
let ctx;
if (fs.existsSync(STORAGE_STATE)) {
  console.log('使用 storageState 登录:', STORAGE_STATE);
  browser = await chromium.launch({ channel: 'chrome', headless: false, viewport: null });
  ctx = await browser.newContext({ storageState: STORAGE_STATE });
} else if (fs.existsSync(PROFILE)) {
  console.log('使用 persistent profile 登录:', PROFILE);
  ctx = await chromium.launchPersistentContext(PROFILE, { channel: 'chrome', headless: false, viewport: null });
} else {
  console.error('❌ 没找到登录态：', STORAGE_STATE, '或', PROFILE);
  console.error('   本机跑：node scripts/kdocs-auth.mjs 登录');
  console.error('   或：node scripts/kdocs-export-storage.mjs 导出 storageState');
  process.exit(1);
}
try {
  const page = ctx.pages()[0] || await ctx.newPage();
  console.log('打开核价表…');
  await page.goto(`https://www.kdocs.cn/l/${LINK}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(12000);

  const byCode = {}; // 款号大写 → 总成本
  const salesPriceByCode = {}; // 款号大写 → 核价表销售价
  let dup = 0, bad = 0, dupSales = 0, badSales = 0;
  for (const sheet of SHEETS) {
    const tab = page.getByText(sheet, { exact: true }).first();
    if (await tab.count() === 0) { console.log('⚠ 没找到工作表:', sheet); continue; }
    await tab.click();
    await page.waitForTimeout(2500);
    await page.mouse.click(500, 300);
    await page.waitForTimeout(400);
    await page.keyboard.press('ControlOrMeta+a');
    await page.waitForTimeout(300);
    await page.keyboard.press('ControlOrMeta+a');
    await page.waitForTimeout(300);
    await page.keyboard.press('ControlOrMeta+c');
    await page.waitForTimeout(1500);

    const tsv = execSync('pbpaste').toString();
    const rows = parseTsv(tsv);
    const hdr = rows[0] || [];
    const iCode = hdr.findIndex((h) => h.replace(/\s/g, '').includes('款号'));
    const iCost = hdr.findIndex((h) => h.replace(/\s/g, '').includes('总成本'));
    const iSales = hdr.findIndex((h) => h.replace(/\s/g, '').includes('售价区间'));
    if (iCode < 0 || iCost < 0) { console.log(`⚠ ${sheet}: 找不到 款号/总成本 列`, hdr.slice(0, 25)); continue; }
    let n = 0;
    for (const r of rows.slice(1)) {
      const code = (r[iCode] || '').trim().toUpperCase();
      if (!code || code === '款号') continue;
      const cost = parseFloat(String(r[iCost] || '').replace(/[,，\s]/g, ''));
      if (!Number.isFinite(cost) || cost <= 0) { bad++; continue; }
      if (code in byCode && byCode[code] !== cost) {
        dup++;
        byCode[code] = Math.max(byCode[code], cost); // 多行取大（保守口径）
      } else if (!(code in byCode)) {
        byCode[code] = cost;
      }
      // 核价表销售价：按表头匹配，允许某个工作表缺失该列
      if (iSales >= 0) {
        const sales = parseFloat(String(r[iSales] || '').replace(/[,，\s]/g, ''));
        if (!Number.isFinite(sales) || sales <= 0) {
          badSales++;
        } else if (code in salesPriceByCode && salesPriceByCode[code] !== sales) {
          dupSales++;
          salesPriceByCode[code] = Math.max(salesPriceByCode[code], sales); // 多行取大
        } else if (!(code in salesPriceByCode)) {
          salesPriceByCode[code] = sales;
        }
      }
      n++;
    }
    console.log(`✓ ${sheet}: ${n} 行有效`);
  }

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify({ updatedAt: new Date().toISOString(), byCode, salesPriceByCode }, null, 2));
  console.log(`完成: ${Object.keys(byCode).length} 个款号 → ${OUT_JSON}（多行取大 ${dup} 次，无效 ${bad} 行）`);
  console.log(`销售价: ${Object.keys(salesPriceByCode).length} 个款号（多行取大 ${dupSales} 次，无效 ${badSales} 行）`);
  if (byCode['ME04FW004']) console.log('校验成本 ME04FW004 =', byCode['ME04FW004']);
  if (salesPriceByCode['ME04FW004']) console.log('校验销售价 ME04FW004 =', salesPriceByCode['ME04FW004']);
} finally {
  await ctx.close();
  if (browser) await browser.close();
}
process.exit(0);
