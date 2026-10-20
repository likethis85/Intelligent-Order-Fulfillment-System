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
const baseArgs = [
  '--disable-blink-features=AutomationControlled',
  ...(isLinux ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] : []),
];

// 打开浏览器会话。useDirect=true 时加 --no-proxy-server 绕过系统代理：
// 本机常见情况是系统代理（Clash 等）把钉钉文档拦成 ERR_TIMED_OUT，而直连正常。
async function openSession(useDirect) {
  const args = [...baseArgs, ...(useDirect ? ['--no-proxy-server'] : [])];
  if (hasStorage) {
    const b = await chromium.launch({ channel: 'chrome', headless: isHeadless, args });
    const c = await b.newContext({
      storageState: STORAGE_STATE,
      viewport: isHeadless ? { width: 1440, height: 900 } : null,
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    return { ctx: c, close: async () => { try { await c.close(); } catch {} try { await b.close(); } catch {} } };
  }
  const c = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome',
    headless: isHeadless,
    args,
    viewport: isHeadless ? { width: 1440, height: 900 } : null,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  return { ctx: c, close: async () => { try { await c.close(); } catch {} } };
}

async function loadSheet(useDirect) {
  const s = await openSession(useDirect);
  const p = s.ctx.pages()[0] || await s.ctx.newPage();
  console.log(`打开钉钉核价表…（${useDirect ? '直连，绕过系统代理' : '跟随系统代理'}）`);
  await p.goto(DINGTALK_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await p.waitForTimeout(useDirect ? 9000 : 10000);
  const body = await p.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '');
  const failed = !body.trim() || /无法访问此网站|ERR_|响应时间过长|检查代理服务器/.test(body);
  return { ...s, page: p, body, ok: !failed };
}

let session = null;
try {
  // DINGTALK_PROXY=system 强制走系统代理；=direct 强制直连；默认先系统代理、失败自动改直连
  const forced = process.env.DINGTALK_PROXY;
  session = await loadSheet(forced === 'direct');
  if (forced !== 'system' && !session.ok) {
    console.log('⚠ 系统代理下页面未加载成功，改用直连重试…');
    await session.close();
    session = await loadSheet(true);
  }
  const page = session.page;

  if (!session.ok) {
    console.error('❌ 钉钉文档页面加载失败（网络/代理问题），当前地址:', page.url().slice(0, 120));
    console.error('   可试：DINGTALK_PROXY=direct npm run sync:hengji');
    process.exit(4);
  }

  const finalUrl = page.url();
  if (/login|challenge|passport/i.test(finalUrl)) {
    console.error('❌ 钉钉登录态已失效（URL:', finalUrl, '）');
    console.error('   请重新运行：npm run dingtalk:auth 重新扫码登录');
    process.exit(2);
  }

  // 登录了但没有文档权限时，页面会是「暂无权限访问」申请页，此时绝不能继续写盘
  if (/暂无权限|无权限访问|申请权限|切换账号/.test(session.body)) {
    const who = (session.body.match(/当前账号[:：]\s*([^\n]+)/) || [])[1] || '未知';
    console.error('❌ 当前登录账号没有该核价表的访问权限');
    console.error('   账号:', who);
    console.error('   解决：让文档所有者开通权限，或换有权限的账号重跑 npm run dingtalk:auth');
    process.exit(5);
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
      // 系统剪贴板兜底：只接受看起来像表格的内容，避免把上一份无关文本当成表格数据
      const sys = getSystemClipboard();
      if (sys && (/款号|商品编码|样衣款号/.test(sys) || sys.includes('\t'))) {
        tsv = sys;
      } else {
        if (sys && sys.trim()) console.log(`⚠ ${sheet.name}: 页面未复制到内容，系统剪贴板不像表格，已忽略`);
      }
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
      const roundedCost = Math.round(cost * 10) / 10;
      if (code in byCode && byCode[code] !== roundedCost) {
        dup++;
        byCode[code] = Math.max(byCode[code], roundedCost); // 多行取大（保守口径）
      } else if (!(code in byCode)) {
        byCode[code] = roundedCost;
      }

      // 核价表销售价
      if (iSales >= 0) {
        const sales = parseFloat(String(r[iSales] || '').replace(/[,，\s]/g, ''));
        if (!Number.isFinite(sales) || sales <= 0) {
          badSales++;
        } else {
          const roundedSales = Math.round(sales * 10) / 10;
          if (code in salesPriceByCode && salesPriceByCode[code] !== roundedSales) {
            dupSales++;
            salesPriceByCode[code] = Math.max(salesPriceByCode[code], roundedSales);
          } else if (!(code in salesPriceByCode)) {
            salesPriceByCode[code] = roundedSales;
          }
        }
      }
      n++;
    }
    console.log(`✓ ${sheet.name}: ${n} 行有效`);
  }

  // 空结果保护：一个款号都没解析出来时绝不覆盖原文件，避免把线上数据清空
  if (Object.keys(byCode).length === 0) {
    console.error('❌ 未解析到任何款号，已中止写盘，原 hengji-cost.json 保持不变');
    process.exit(3);
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
  try { if (session) await session.close(); } catch {}
}
process.exit(0);
