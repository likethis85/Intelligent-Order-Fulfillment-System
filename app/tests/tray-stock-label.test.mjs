// 货盘「库存情况」：整款只有现货时，数量已足够表意，省掉「现货」两字；
// 只要同款还出现 在途/交期/占单（哪怕是别的颜色），「现货」标签全部保留，避免数字混读。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { parseStockLine, stockCellPartsList, stockFallbackParts } = await import('../src/lib/stockLines.ts');
const pageCode = fs.readFileSync(path.resolve(__dirname, '../src/sections/TraysPage.tsx'), 'utf8');

// 与页面/导出的聚合方式一致：把每个颜色的字段合成一格要显示的文本
function cellText(lines, productColors = []) {
  const byColor = new Map();
  for (const line of lines) {
    const e = parseStockLine(line, productColors);
    const k = e.color || '其他';
    const cur = byColor.get(k) || { stock: 0, inTransit: 0, eta: null, orderBook: 0 };
    cur.stock = Math.max(cur.stock, e.stock);
    cur.inTransit = Math.max(cur.inTransit, e.inTransit);
    cur.orderBook = Math.max(cur.orderBook, e.orderBook);
    if (e.eta && !cur.eta) cur.eta = e.eta;
    byColor.set(k, cur);
  }
  const entries = [...byColor.entries()];
  const partsList = stockCellPartsList(entries.map(([, v]) => v), { orderBookMinDisplay: 15 });
  return entries.map(([color], i) => `${color}：${partsList[i].join(' ') || '—'}`).join('\n');
}

test('整款只有现货：每个颜色只显示数字', () => {
  const text = cellText(['棕色：现货37', '藏青：现货4', '米色：现货17'], ['棕色', '藏青', '米色']);
  assert.equal(text, '棕色：37\n藏青：4\n米色：17');
  assert.ok(!text.includes('现货'));
});

test('同款同时有现货和在途：所有颜色都保留「现货」标签', () => {
  const text = cellText([
    '米灰：占单31',
    '驼色：现货52 在途121 11/10交 占单316',
    '深灰：现货40 在途11 11/10交 占单138',
    '藏青：现货37 在途16 11/10交 占单115',
    '棕色：现货37',
  ], ['米灰', '驼色', '深灰', '藏青', '棕色']);
  assert.ok(text.includes('驼色：现货52 在途121 11/10交 占单316'));
  assert.ok(text.includes('深灰：现货40 在途11 11/10交 占单138'));
  assert.ok(text.includes('藏青：现货37 在途16 11/10交 占单115'));
  // 即使这一色自己只有现货，同款出现了在途，也照样保留标签
  assert.ok(text.includes('棕色：现货37'), '同款有在途时，只有现货的颜色也要带标签');
});

test('只有现货 + 小占单（不显示）：仍然只写数字；占单够大时保留标签', () => {
  const row = (orderBook) => stockCellPartsList([{ stock: 47, inTransit: 0, eta: null, orderBook }], { orderBookMinDisplay: 15 })[0];
  assert.deepEqual(row(1), ['47']);
  assert.deepEqual(row(31), ['现货47', '占单31']);
});

test('只有现货 + 交期：保留标签，不让「37 11/10交」产生歧义', () => {
  assert.deepEqual(stockCellPartsList([{ stock: 37, inTransit: 0, eta: '11/10', orderBook: 0 }])[0], ['现货37', '11/10交']);
  assert.deepEqual(stockCellPartsList([{ stock: 0, inTransit: 121, eta: '11/10', orderBook: 0 }])[0], ['在途121', '11/10交']);
});

test('同一款里别的颜色带在途，也会让只有现货的颜色保留标签', () => {
  const parts = stockCellPartsList([
    { stock: 37, inTransit: 0, eta: null, orderBook: 0 },
    { stock: 4, inTransit: 121, eta: null, orderBook: 0 },
  ]);
  assert.deepEqual(parts, [['现货37'], ['现货4', '在途121']]);
});

test('没有按色拆分的款级库存也按同一口径', () => {
  assert.deepEqual(stockFallbackParts(37, 0), ['37']);
  assert.deepEqual(stockFallbackParts(52, 121), ['现货52', '在途121']);
  assert.deepEqual(stockFallbackParts(0, 121), ['在途121']);
  assert.deepEqual(stockFallbackParts(0, 0), []);
});

test('页面与 Excel 导出共用同一个措辞函数', () => {
  assert.ok(pageCode.includes("import { parseStockLine, stockCellPartsList, stockFallbackParts } from '@/lib/stockLines';"));
  const uses = pageCode.match(/stockCellPartsList\(entries\.map\(\(\[, v\]\) => v\), \{ orderBookMinDisplay: ORDER_BOOK_MIN_DISPLAY \}\)/g) || [];
  assert.equal(uses.length, 2, '货盘单元格 + Excel/打印文本');
  const fallbackUses = pageCode.match(/stockFallbackParts\(p\.stockMain \?\? 0, p\.inTransit \?\? 0\)/g) || [];
  assert.equal(fallbackUses.length, 2, 'BI 独有款的两处渲染');
  assert.ok(!/parts\.push\(`现货\$\{/.test(pageCode), '不再各自拼「现货」标签');
});
