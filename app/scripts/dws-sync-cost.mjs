#!/usr/bin/env node
/**
 * 通过 dingtalk-workspace-cli (dws) 原生 API 同步钉钉核价表
 * 
 * 优势：
 *   - 纯 API / CLI 调用，无需无头浏览器渲染，秒级完成
 *   - 原生支持 --format json 与 export-csv 规范导出
 *   - 与钉钉组织权限体系深度打通
 * 
 * 用法：
 *   node scripts/dws-sync-cost.mjs
 *   或 npm run sync:dws
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DINGTALK_URL = process.env.DINGTALK_DOC_URL ||
  'https://alidocs.dingtalk.com/i/nodes/20eMKjyp81pMKDNaSr0ZG5RBJxAZB1Gv?corpId=ding63eff9039ed59ecb35c2f4657eb6378f&utm_medium=im_card&iframeQuery=sheet_range%3Ds2_0_2_0_1%26utm_medium%3Dim_card%26utm_source%3Dim&utm_scene=person_space&utm_source=im';

const OUT_JSON = process.env.COST_OUT_JSON || path.join(__dirname, '..', 'server', 'data', 'hengji-cost.json');

// 简单健壮的 RFC4180 CSV 解析器
function parseCsv(text) {
  const lines = [];
  let row = [];
  let inQuotes = false;
  let cur = '';

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (c === '"') {
      if (inQuotes && next === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === ',' && !inQuotes) {
      row.push(cur);
      cur = '';
    } else if ((c === '\r' || c === '\n') && !inQuotes) {
      if (c === '\r' && next === '\n') i++;
      row.push(cur);
      if (row.length > 0 && row.some(cell => cell.trim() !== '')) {
        lines.push(row);
      }
      row = [];
      cur = '';
    } else {
      cur += c;
    }
  }

  if (cur.length > 0 || row.length > 0) {
    row.push(cur);
    if (row.some(cell => cell.trim() !== '')) {
      lines.push(row);
    }
  }
  return lines;
}

console.log('🔍 [dws-sync] 检查 dws (dingtalk-workspace-cli) 状态...');
let authStatus;
try {
  const rawStatus = execSync('dws auth status -f json', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  authStatus = JSON.parse(rawStatus);
} catch (err) {
  console.error('❌ 未检测到 dws 可用命令或执行失败:', err.message);
  console.error('   请确认服务器已安装: npm install -g dingtalk-workspace-cli');
  process.exit(1);
}

if (!authStatus.authenticated) {
  console.error('❌ dws 当前未登录钉钉账号');
  console.error('   请在终端运行: npm run dws:login 进行扫码/设备授权认证');
  process.exit(2);
}

console.log('✓ dws 认证正常，正在读取钉钉工作簿结构...');

// 尝试列出所有工作表
let sheetList = [];
try {
  const rawSheets = execSync(`dws sheet list --node "${DINGTALK_URL}" -f json`, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const parsed = JSON.parse(rawSheets);
  if (Array.isArray(parsed)) {
    sheetList = parsed;
  } else if (Array.isArray(parsed.sheets)) {
    sheetList = parsed.sheets;
  } else if (Array.isArray(parsed.data)) {
    sheetList = parsed.data;
  }
} catch (err) {
  console.warn('⚠ dws sheet list 获取失败，回退到整表单导出:', err.message);
}

if (sheetList.length === 0) {
  sheetList.push({ id: '', name: '整表/首个工作表' });
}

console.log(`发现 ${sheetList.length} 个工作表:`, sheetList.map(s => s.name || s.id || '默认').join(', '));

const byCode = {};
const salesPriceByCode = {};
let dupCost = 0, badCost = 0, dupSales = 0, badSales = 0;

for (const sheet of sheetList) {
  const sheetIdentifier = sheet.sheetId || sheet.id || sheet.name || '';
  const sheetParam = sheetIdentifier ? `--sheet-id "${sheetIdentifier}"` : '';
  console.log(`\n▶ 正在处理工作表: ${sheet.name || sheet.id || '默认'}...`);

  // 1. 获取工作表非空行数，决定分块策略
  let totalRows = 500;
  try {
    const rawInfo = execSync(`dws sheet info --node "${DINGTALK_URL}" ${sheetParam} -f json`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const info = JSON.parse(rawInfo);
    totalRows = info.nonEmptyRange?.lastRow || info.rowCount || 500;
    console.log(`  工作表行数: ${totalRows}`);
  } catch {
    console.log(`  无法获取行数，使用默认 500 行分块导出`);
  }

  let iCode = -1, iCost = -1, iSales = -1;
  const CHUNK_SIZE = 500;
  let validInSheet = 0;

  for (let startRow = 1; startRow <= totalRows; startRow += CHUNK_SIZE) {
    const endRow = Math.min(startRow + CHUNK_SIZE - 1, totalRows + 10);
    const rangeParam = `--range "A${startRow}:AF${endRow}"`;

    let csvContent = '';
    try {
      csvContent = execSync(`dws sheet export-csv --node "${DINGTALK_URL}" ${sheetParam} ${rangeParam} --value-render-option formatted_value --allow-truncated`, {
        encoding: 'utf8',
        maxBuffer: 25 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      console.error(`  ❌ 分块导出失败 (${rangeParam}):`, err.message);
      break;
    }

    if (!csvContent || !csvContent.trim()) {
      break;
    }

    const rows = parseCsv(csvContent);
    if (rows.length === 0) break;

    let dataStartIndex = 0;
    // 首次分块需解析表头
    if (startRow === 1) {
      for (let rIdx = 0; rIdx < Math.min(6, rows.length); rIdx++) {
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
          dataStartIndex = rIdx + 1;
          console.log(`  ✓ 找到表头: 款号列=${iCode}(${hdr[iCode]}), 总成本列=${iCost}(${hdr[iCost]}), 售价列=${iSales}(${hdr[iSales] || '无'})`);
          break;
        }
      }
    }

    if (iCode < 0 || iCost < 0) {
      console.log(`  ⚠ 找不到 款号/总成本 列，跳过此工作表`);
      break;
    }

    for (let r = dataStartIndex; r < rows.length; r++) {
      const row = rows[r];
      const code = (row[iCode] || '').trim().toUpperCase();
      if (!code || code === '款号' || code === '商品编码') continue;

      const rawCost = String(row[iCost] || '').replace(/[,，\s¥￥]/g, '');
      const cost = parseFloat(rawCost);
      if (!Number.isFinite(cost) || cost <= 0) {
        badCost++;
        continue;
      }

      if (code in byCode && byCode[code] !== cost) {
        dupCost++;
        byCode[code] = Math.max(byCode[code], cost); // 多行取大
      } else if (!(code in byCode)) {
        byCode[code] = cost;
      }

      if (iSales >= 0) {
        const rawSales = String(row[iSales] || '').replace(/[,，\s¥￥]/g, '');
        const sales = parseFloat(rawSales);
        if (!Number.isFinite(sales) || sales <= 0) {
          badSales++;
        } else if (code in salesPriceByCode && salesPriceByCode[code] !== sales) {
          dupSales++;
          salesPriceByCode[code] = Math.max(salesPriceByCode[code], sales);
        } else if (!(code in salesPriceByCode)) {
          salesPriceByCode[code] = sales;
        }
      }
      validInSheet++;
    }
  }
  console.log(`  ✓ ${sheet.name || sheet.id}: 成功解析 ${validInSheet} 条记录`);
}

const totalCosts = Object.keys(byCode).length;
const totalSales = Object.keys(salesPriceByCode).length;

if (totalCosts === 0) {
  console.error('\n❌ 未能从钉钉表格中解析出任何有效款号成本数据');
  process.exit(3);
}

fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
fs.writeFileSync(OUT_JSON, JSON.stringify({
  updatedAt: new Date().toISOString(),
  engine: 'dingtalk-workspace-cli',
  source: DINGTALK_URL,
  byCode,
  salesPriceByCode
}, null, 2));

console.log(`\n🎉 [dws 同步完成]`);
console.log(`   总成本数据: ${totalCosts} 款号 (多行取大 ${dupCost} 次, 无效/过滤 ${badCost} 行)`);
console.log(`   销售价格: ${totalSales} 款号 (多行取大 ${dupSales} 次, 无效/过滤 ${badSales} 行)`);
console.log(`   已写入: ${OUT_JSON}`);
process.exit(0);
