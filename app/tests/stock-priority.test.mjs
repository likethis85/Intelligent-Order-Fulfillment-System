// 货盘库存取数优先级：聚水潭实时库存（全仓）优先，观远 BI SKC 卡（主仓）兜底。
// 聚水潭没这个款 / 返回空库存时，必须原样保留 BI 值，不能把库存清空。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { applyJushuitanPriority } = await import('../src/lib/stockLines.ts');

const biProduct = {
  id: 'me01',
  stock: ['藏青：现货10 在途3 占单2'],
  stockMain: 10,
  inTransit: 3,
  colors: ['藏青'],
};

test('聚水潭有数据：覆盖 BI 库存（即使 BI 本来有值）', () => {
  const next = applyJushuitanPriority(biProduct, {
    stock: ['藏青：现货40 在途11'],
    stockMain: 40,
    inTransit: 11,
  });
  assert.deepEqual(next.stock, ['藏青：现货40 在途11']);
  assert.equal(next.stockMain, 40);
  assert.equal(next.inTransit, 11);
  assert.equal(next.stockSource, 'jushuitan');
  assert.deepEqual(next.colors, ['藏青'], '其它字段原样保留');
});

test('聚水潭没这个款：保留 BI 兜底值', () => {
  assert.deepEqual(applyJushuitanPriority(biProduct, undefined), biProduct);
  assert.deepEqual(applyJushuitanPriority(biProduct, null), biProduct);
});

test('聚水潭返回了款但库存行是空：保留 BI 兜底值', () => {
  const next = applyJushuitanPriority(biProduct, { stock: [], stockMain: 0, inTransit: 0 });
  assert.deepEqual(next.stock, biProduct.stock);
  assert.equal(next.stockMain, 10);
  assert.equal(next.stockSource, undefined, '没换成聚水潭就不能打聚水潭标签');
});

test('页面：当前货盘所有款号都查聚水潭，不再按 BI 可用性/缺库存决定', () => {
  const pageCode = fs.readFileSync(path.resolve(__dirname, '../src/sections/TraysPage.tsx'), 'utf8');
  assert.ok(
    pageCode.includes("authenticatedFetch(`${API_BASE}/products/stock/by-ids?ids=${encodeURIComponent(activeTrayPids.join(','))}`)"),
    '把当前货盘全部款号发给聚水潭，而不是只补 BI 缺的款',
  );
  assert.ok(!pageCode.includes('biSkcUsable'), '不再用 BI 可用性决定是否取聚水潭');
  assert.ok(pageCode.includes('applyJushuitanPriority(next, jstStockByCode[id.toLowerCase()])'));
});
