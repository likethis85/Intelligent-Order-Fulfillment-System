// 从钉钉文档「核价表」同步款号→总成本 + 销售价 到 server/data/hengji-cost.json
// 用法: node scripts/dingtalk-sync-cost.mjs
// 前提（二选一）：
//   1) 已用 scripts/dingtalk-auth.mjs 登录过一次（~/.dingtalk-auth-profile 存在）
//   2) 已用 scripts/dingtalk-export-storage.mjs 导出 ~/.dingtalk-storage-state.json
//      （适合服务器部署：自动同步此文件，免去图形界面依赖）
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
const DINGTALK_URL = process.env.DINGTALK_COST_URL || DEFAULT_URL;
const OUT_JSON = path.join(__dirname, '..', 'server', 'data', 'hengji-cost.json');

// 优先检查 dingtalk-workspace-cli (dws) 认证状态；若已登录，走原生 API 秒级同步
try {
  const dwsStatusRaw = execSync('dws auth status -f json', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 2000 });
  const dwsStatus = JSON.parse(dwsStatusRaw);
  if (dwsStatus && dwsStatus.authenticated) {
    console.log('⚡ 检测到 dingtalk-workspace-cli (dws) 已认证，启用原生 API 极速同步...');
    const dwsScript = path.join(__dirname, 'dws-sync-cost.mjs');
    execSync(`node "${dwsScript}"`, { stdio: 'inherit', env: process.env });
    process.exit(0);
  }
} catch {
  // dws 未安装或未登录，平滑进入 Playwright 无头同步
}

// 跨平台系统剪贴板读取辅助
function getSystemClipboard() {
  try {
    if (process.platform === 'win32') {
      return execSync('powershell.exe -NoProfile -Command "Get-Clipboard"', { encoding: 'utf8', timeout: 5000 }).toString();
    }
    if (process.platform === 'darwin') {
      return execSync('pbpaste', { encoding: 'utf8', timeout: 5000 }).toString();
    }
    return execSync('xclip -selection clipboard -o 2>/dev/null || xsel -b -o 2>/dev/null', { encoding: 'utf8', timeout: 5000 }).toString();
  } catch {
    return '';
  }
}

// 极简 TSV 解析（支持引号包裹字段内含换行/制表符；表头有多行合并单元格）
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

const hasStorage = fs.existsSync(STORAGE_STATE);
const hasProfile = fs.existsSync(PROFILE);

if (!hasStorage && !hasProfile) {
  console.error('❌ 没找到钉钉登录凭证：', STORAGE_STATE, '或', PROFILE);
  console.error('   请先运行：npm run dingtalk:auth 登录并保存凭证');
  process.exit(1);
}

const isLinux = process.platform === 'linux';
const isHeadless = isLinux || process.env.HEADLESS === 'true';
const launchArgs = [
  '--disable-blink-features=AutomationControlled',
  ...(isLinux ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] : []),
];

let browser = null;
let ctx;
if (hasStorage) {
  console.log('使用 storageState 登录:', STORAGE_STATE, `(headless: ${isHeadless})`);
  browser = await chromium.launch({
    channel: 'chrome',
    headless: isHeadless,
    args: launchArgs,
  });
  ctx = await browser.newContext({
    storageState: STORAGE_STATE,
    viewport: isHeadless ? { width: 1440, height: 900 } : null,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
} else {
  console.log('使用 persistent profile 登录:', PROFILE, `(headless: ${isHeadless})`);
  ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome',
    headless: isHeadless,
    args: launchArgs,
    viewport: isHeadless ? { width: 1440, height: 900 } : null,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
}

try {
  const page = ctx.pages()[0] || await ctx.newPage();
  console.log('打开钉钉核价表…', DINGTALK_URL);
  await page.goto(DINGTALK_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(10000);

  const finalUrl = page.url();
  if (/login|challenge|passport/i.test(finalUrl)) {
    console.error('❌ 钉钉登录态已失效（URL:', finalUrl, '）');
    console.error('   请重新运行：npm run dingtalk:auth 重新扫码登录');
    process.exit(2);
  }

  const byCode = {};
  const salesPriceByCode = {};
  let dup = 0, bad = 0, dupSales = 0, badSales = 0;

  // 尝试在页面底部查找所有工作表 Tab
  const sheetTabLocators = page.locator('[role="tab"], .sheet-tab-item, .ding-sheet-tab, [class*="tab-item"], [class*="sheetTab"], [class*="tab_item"]');
  const tabCount = await sheetTabLocators.count();
  const sheetsToProcess = [];

  if (tabCount > 0) {
    for (let i = 0; i < tabCount; i++) {
      const text = (await sheetTabLocators.nth(i).innerText().catch(() => '')).trim();
      if (text) sheetsToProcess.push({ index: i, name: text, locator: sheetTabLocators.nth(i) });
    }
  }

  // 如果没有找到特定 Tab 或仅 1 个 Tab，至少处理当前工作表
  if (sheetsToProcess.length === 0) {
    sheetsToProcess.push({ index: 0, name: '当前工作表', locator: null });
  }

  console.log(`发现 ${sheetsToProcess.length} 个工作表:`, sheetsToProcess.map(s => s.name).join(', '));

  for (const sheet of sheetsToProcess) {
    if (sheet.locator) {
      await sheet.locator.click().catch(() => {});
      await page.waitForTimeout(2000);
    }

    // 点击表格数据区
    await page.mouse.click(500, 300);
    await page.waitForTimeout(400);

    // 全选并复制整个工作表
    await page.keyboard.press('ControlOrMeta+a');
    await page.waitForTimeout(300);
    await page.keyboard.press('ControlOrMeta+a');
    await page.waitForTimeout(300);
    await page.keyboard.press('ControlOrMeta+c');
    await page.waitForTimeout(1500);

    // 优先从浏览器剪贴板读取，备用系统剪贴板命令
    let tsv = '';
    try {
      tsv = await page.evaluate(async () => {
        try { return await navigator.clipboard.readText(); } catch { return ''; }
      });
    } catch {}

    if (!tsv || !tsv.trim()) {
      tsv = getSystemClipboard();
    }

    if (!tsv || !tsv.trim()) {
      console.log(`⚠ ${sheet.name}: 剪贴板未读到内容，跳过`);
      continue;
    }

    const rows = parseTsv(tsv);
    if (rows.length < 2) {
      console.log(`⚠ ${sheet.name}: 行数不足，跳过`);
      continue;
    }

    // 在前 5 行中寻找包含 款号、总成本、售价 的表头
    let iCode = -1, iCost = -1, iSales = -1, headerRowIndex = 0;
    for (let rIdx = 0; rIdx < Math.min(5, rows.length); rIdx++) {
      const hdr = rows[rIdx] || [];
      const testCode = hdr.findIndex(h => {
        const s = String(h || '').trim().replace(/\s/g, '');
        return s === '款号' || s === '商品编码' || s === '样衣款号';
      });

      // 严格定位总成本列：
      // 1) 优先精确匹配 '总成本' / '核价成本' / '最终成本'
      // 2) 其次精确匹配 '成本'（1-8月表头为“成本”，其值为面料+辅料+加工+其他之和）
      // 3) 排除“辅料成本”、“面料成本”、“成本区间”、“成本备注”
      let testCost = hdr.findIndex(h => {
        const s = String(h || '').trim().replace(/\s/g, '');
        return s === '总成本' || s === '核价成本' || s === '最终成本';
      });
      if (testCost < 0) {
        testCost = hdr.findIndex(h => {
          const s = String(h || '').trim().replace(/\s/g, '');
          return s === '成本';
        });
      }
      if (testCost < 0) {
        testCost = hdr.findIndex(h => {
          const s = String(h || '').trim().replace(/\s/g, '');
          return s.includes('总成本') && !s.includes('区间') && !s.includes('备注');
        });
      }
      if (testCost < 0) {
        testCost = hdr.findIndex(h => {
          const s = String(h || '').trim().replace(/\s/g, '');
          return s.includes('成本') && !s.includes('辅料') && !s.includes('面料') && !s.includes('加工') && !s.includes('区间') && !s.includes('备注');
        });
      }

      // 售价定位
      let testSales = hdr.findIndex(h => {
        const s = String(h || '').trim().replace(/\s/g, '');
        return s === '售价' || s === '销售价';
      });
      if (testSales < 0) {
        testSales = hdr.findIndex(h => {
          const s = String(h || '').trim().replace(/\s/g, '');
          return s.includes('售价区间') || s.includes('销售价区间');
        });
      }
      if (testSales < 0) {
        testSales = hdr.findIndex(h => {
          const s = String(h || '').trim().replace(/\s/g, '');
          return s.includes('售价') || s.includes('销售价') || s.includes('一口价');
        });
      }
      if (testSales < 0) {
        testSales = hdr.findIndex(h => {
          const s = String(h || '').trim().replace(/\s/g, '');
          return s.includes('吊牌');
        });
      }

      if (testCode >= 0 && testCost >= 0) {
        iCode = testCode;
        iCost = testCost;
        iSales = testSales;
        headerRowIndex = rIdx;
        break;
      }
    }

    if (iCode < 0 || iCost < 0) {
      console.log(`⚠ ${sheet.name}: 找不到 款号/总成本 列`, rows[0]?.slice(0, 20));
      continue;
    }

    let n = 0;
    for (const r of rows.slice(headerRowIndex + 1)) {
      const code = (r[iCode] || '').trim().toUpperCase();
      if (!code || code === '款号' || code === '商品编码') continue;
      const cost = parseFloat(String(r[iCost] || '').replace(/[,，\s]/g, ''));
      if (!Number.isFinite(cost) || cost <= 0) { bad++; continue; }
      if (code in byCode && byCode[code] !== cost) {
        dup++;
        byCode[code] = Math.max(byCode[code], cost); // 多行取大（保守口径）
      } else if (!(code in byCode)) {
        byCode[code] = cost;
      }

      // 核价表销售价
      if (iSales >= 0) {
        const sales = parseFloat(String(r[iSales] || '').replace(/[,，\s]/g, ''));
        if (!Number.isFinite(sales) || sales <= 0) {
          badSales++;
        } else if (code in salesPriceByCode && salesPriceByCode[code] !== sales) {
          dupSales++;
          salesPriceByCode[code] = Math.max(salesPriceByCode[code], sales);
        } else if (!(code in salesPriceByCode)) {
          salesPriceByCode[code] = sales;
        }
      }
      n++;
    }
    console.log(`✓ ${sheet.name}: ${n} 行有效`);
  }

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify({
    updatedAt: new Date().toISOString(),
    source: DINGTALK_URL,
    byCode,
    salesPriceByCode
  }, null, 2));

  console.log(`完成: ${Object.keys(byCode).length} 个款号 → ${OUT_JSON}（多行取大 ${dup} 次，无效 ${bad} 行）`);
  console.log(`销售价: ${Object.keys(salesPriceByCode).length} 个款号（多行取大 ${dupSales} 次，无效 ${badSales} 行）`);
} finally {
  try { if (ctx) await ctx.close(); } catch {}
  try { if (browser) await browser.close(); } catch {}
}
process.exit(0);
