// 面料查询匹配到面料、但库存为 0 时，同步到货盘的「面料信息」不能是空串。
// 空串会让货盘走 fabric-selected-empty，单元格退回 BI 的「面料」字段——
// 而 BI 那里常存的是物料小类（如「辅料_其他」），根本不是面料名称。
// 用户口径：匹配到面料就写「<颜色>0米」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexHtml = fs.readFileSync(path.resolve(__dirname, '../server/fabric-public/index.html'), 'utf8');
const traysPage = fs.readFileSync(path.resolve(__dirname, '../src/sections/TraysPage.tsx'), 'utf8');

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start > 0, `index.html 里应有 ${name}`);
  const end = src.indexOf('\n    }', start);
  assert.ok(end > start, `${name} 应有闭合`);
  return src.slice(start, end + '\n    }'.length);
}

test('zeroStockFabricLine：颜色 + 0米，仓库为 - 时不拼', () => {
  const fn = extractFunction(indexHtml, 'zeroStockFabricLine');
  const zeroStockFabricLine = new Function(`${fn}; return zeroStockFabricLine;`)();
  assert.equal(zeroStockFabricLine('米色', '-'), '米色0米');
  assert.equal(zeroStockFabricLine('米色', ''), '米色0米');
  assert.equal(zeroStockFabricLine('米色', '面料仓'), '米色0米面料仓');
});

test('buildFabricInfoLine：零库存不再返回空串，两处主面料分支都兜底', () => {
  const start = indexHtml.indexOf('function buildFabricInfoLine(');
  const end = indexHtml.indexOf('// 生成提交到 Supabase 的记录', start);
  assert.ok(start > 0 && end > start);
  const body = indexHtml.slice(start, end);
  // 无 PO 明细分支的最终 else
  assert.ok(body.includes('[buildFabricInfoLine] 匹配到面料但无库存/在途/可订货'), '无库存时应输出兜底文案');
  // 有 PO 但 PO 数量都为 0
  assert.ok(body.includes('if (parts.length === 0) return zeroStockFabricLine(colorDesc, warehouse);'), 'PO 全为 0 也要兜底');
  // 里料库存为 0
  assert.ok(body.includes('} else if (stock === 0) {'), '里料零库存也要兜底');
});

test('货盘：BI「面料」字段是物料小类（辅料_其他）时按噪音隐藏', () => {
  assert.ok(traysPage.includes('FABRIC_CATEGORY_NOISE'), '需要识别物料小类噪音');
  assert.ok(traysPage.includes('/^\\S+_其他$/'), '面料_其他 / 辅料_其他 都应视为噪音');
  const start = traysPage.indexOf('function isFabricNoise(');
  const end = traysPage.indexOf('}', start);
  const body = traysPage.slice(start, end);
  assert.ok(body.includes('FABRIC_CATEGORY_NOISE.test(s)'), '逐段判断也要覆盖物料小类');
});
