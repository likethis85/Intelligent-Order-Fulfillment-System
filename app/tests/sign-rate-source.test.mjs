// 签收率的数据来源：必须是「款级」SUM(退货数量)/SUM(销售数量)。
// 曾经的问题：SKC 卡只带第一个颜色那一行，把款式卡的款级 总退货率 覆盖掉，
// 于是整款 2483/3686 = 67.4%（签收 33%）被单色 60/142 = 42.3%（签收 58%）顶替。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const biClientPath = path.resolve(__dirname, '../server/bi-client.js');
const productsRoutePath = path.resolve(__dirname, '../server/routes/products.js');

const { biOverrides } = await import('../server/bi-client.js');

const skc = (color, sales, returns, rate) => ({
  color,
  skc: color,
  stockMain: 0,
  inTransit: 0,
  totalStock: 0,
  raw: { 销售数量: String(sales), 退货数量: String(returns), 总退货率: String(rate), 净销量: String(sales - returns) },
});

test('biOverrides 的销量/退货量按 SKC 颜色行相加，退货率用数量口径', () => {
  const ov = biOverrides({
    pdtCode: 'MD09FW033',
    skcs: [skc('焦糖橘', 142, 60, 0.4225), skc('雪花黑', 300, 200, 0.6667), skc('浅花驼', 58, 40, 0.6897)],
  });
  assert.equal(ov.salesQty, 500, '销售数量跨色相加');
  assert.equal(ov.returnQty, 300, '退货数量跨色相加');
  assert.ok(Math.abs(ov.returnRate - 300 / 500) < 1e-12, '退货率 = Σ退货/Σ销售，不是第一个颜色的 42.25%');
});

test('biOverrides 没有数量列时退回第一个 SKC 的总退货率', () => {
  const ov = biOverrides({
    pdtCode: 'X1',
    skcs: [{ color: '黑', skc: 'X1', stockMain: 0, inTransit: 0, totalStock: 0, raw: { 总退货率: '0.42' } }],
  });
  assert.equal(ov.returnRate, 0.42);
});

test('领猫款合并时，SKC 卡不能覆盖款式卡已有的款级退货/销量指标', () => {
  const src = fs.readFileSync(productsRoutePath, 'utf8');
  const block = src.slice(src.indexOf('SKC 卡覆盖'), src.indexOf('product.biMatched'));
  assert.ok(
    block.includes("['returnRate', 'returnQty', 'salesQty', 'netSales', 'afterShipReturnQty', 'shippedQty'].includes(k)"),
    '款级指标在 SKC 覆盖前先看款式卡有没有值',
  );
  assert.ok(block.includes('if (Number.isFinite(cur) && cur > 0) continue;'), '款式卡有值就跳过 SKC 覆盖');
  assert.ok(!block.includes("['name', 'sub', 'price', 'priceNum', 'priceBand', 'fabric', 'wave', 'category']\n          .includes(k)"));

  const bi = fs.readFileSync(biClientPath, 'utf8');
  const fn = bi.slice(bi.indexOf('export function biOverrides'), bi.indexOf('export function biProductOverrides'));
  assert.ok(fn.includes('for (const s of row.skcs)'), '按 SKC 行累加');
  assert.ok(fn.includes('out.returnRate = sumReturnQty / sumSalesQty'), '款级数量口径');
});
