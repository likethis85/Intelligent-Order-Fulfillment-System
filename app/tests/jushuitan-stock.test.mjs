import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStockEntry } from '../server/jushuitan-stock.js';

const item = (skus) => ({
  pid: 'ME15FF039',
  name: '测试款',
  category: '针织衫',
  skus,
});

test('jushuitan-stock: 同色多个尺码聚合成一行', () => {
  const inv = {
    totalQty: 12,
    purchaseQty: 4,
    orderLock: 2,
    pickLock: 1,
    skus: {
      A1: { qty: 5, purchaseQty: 2, orderLock: 1, pickLock: 0 },
      A2: { qty: 7, purchaseQty: 2, orderLock: 1, pickLock: 1 },
    },
  };
  const it = item([
    { skuId: 'A1', color: '藏青', size: 'S' },
    { skuId: 'A2', color: '藏青', size: 'M' },
  ]);
  const e = buildStockEntry(inv, it);
  assert.equal(e.stock.length, 1);
  assert.equal(e.stock[0], '针织衫 藏青：现货12 在途4 占单3');
  assert.equal(e.stockMain, 12);
  assert.equal(e.inTransit, 4);
  assert.equal(e.orderBook, 3);
  assert.deepEqual(e.colors, ['藏青']);
  assert.equal(e.source, 'jushuitan');
});

test('jushuitan-stock: 多色分别成行，0 库存的字段不写', () => {
  const inv = {
    skus: {
      B1: { qty: 0, purchaseQty: 8, orderLock: 0, pickLock: 0 },
      B2: { qty: 3, purchaseQty: 0, orderLock: 1, pickLock: 0 },
    },
  };
  const it = item([
    { skuId: 'B1', color: '黑色' },
    { skuId: 'B2', color: '驼色' },
  ]);
  const e = buildStockEntry(inv, it);
  assert.deepEqual(e.stock, [
    '针织衫 黑色：在途8',
    '针织衫 驼色：现货3 占单1',
  ]);
  assert.equal(e.stockMain, 3);
  assert.equal(e.inTransit, 8);
  assert.equal(e.orderBook, 1);
});

test('jushuitan-stock: SKU 颜色缺失时归到「其他」', () => {
  const inv = { skus: { C1: { qty: 2, purchaseQty: 0, orderLock: 0, pickLock: 0 } } };
  const e = buildStockEntry(inv, item([]));
  assert.deepEqual(e.stock, ['针织衫 其他：现货2']);
  assert.deepEqual(e.colors, ['其他']);
});

test('jushuitan-stock: 没有 SKU 明细时退回款级汇总', () => {
  const inv = { totalQty: 9, purchaseQty: 2, orderLock: 1, pickLock: 0, skus: {} };
  const e = buildStockEntry(inv, null);
  assert.deepEqual(e.stock, ['合计：现货9 在途2 占单1']);
  assert.equal(e.stockMain, 9);
});

test('jushuitan-stock: 全 0 与无数据都返回 null（前端保持「—」）', () => {
  const zero = { totalQty: 0, purchaseQty: 0, orderLock: 0, pickLock: 0, skus: { D1: { qty: 0, purchaseQty: 0, orderLock: 0, pickLock: 0 } } };
  assert.equal(buildStockEntry(zero, item([{ skuId: 'D1', color: '黑' }])), null);
  assert.equal(buildStockEntry(null, item([])), null);
});

test('jushuitan-stock: 负数/脏数据不会污染结果', () => {
  const inv = { skus: { E1: { qty: -5, purchaseQty: 'abc', orderLock: null, pickLock: undefined } } };
  const e = buildStockEntry(inv, item([{ skuId: 'E1', color: '黑' }]));
  assert.equal(e, null);
});
