// 货盘库存单元格里的「云仓」：聚水潭虚拟仓（运营云仓）的库存数。
// 云仓只在算可售量时扣掉，本身不单独显示（用户要求：库存情况里不再出现「云仓N」）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStockLine, sellableQty, stockCellPartsList } from '../src/lib/stockLines.ts';

test('云仓：库存行文本能解析出云仓数', () => {
  const e = parseStockLine('针织衫 藏青：现货8 在途150 12/5交 云仓20 占单3', ['藏青']);
  assert.equal(e.color, '藏青');
  assert.equal(e.stock, 8);
  assert.equal(e.inTransit, 150);
  assert.equal(e.eta, '12/5');
  assert.equal(e.cloud, 20);
  assert.equal(e.orderBook, 3, '云仓不能把占单吞掉');
});

test('云仓：单元格里不显示「云仓N」，只留可售量', () => {
  const parts = stockCellPartsList(
    [{ stock: 8, inTransit: 150, eta: '12/5', cloud: 20, orderBook: 30 }],
    { orderBookMinDisplay: 15 },
  )[0];
  assert.deepEqual(parts, ['现货8', '在途150', '12/5交', '占单30', '可售138']);
  assert.ok(!parts.some((p) => p.includes('云仓')));
});

test('云仓：为 0 时不写，且不影响「只有现货就省标签」的规则', () => {
  const parts = stockCellPartsList([{ stock: 47, inTransit: 0, eta: null, cloud: 0, orderBook: 0 }])[0];
  assert.deepEqual(parts, ['47']);
});

test('云仓：只有云仓的颜色不显示云仓，可售量兜底为 0', () => {
  const parts = stockCellPartsList([{ stock: 0, inTransit: 0, eta: null, cloud: 6, orderBook: 0 }])[0];
  assert.deepEqual(parts, ['可售0']);
});

test('可售量：现货+在途-云仓，负数按 0', () => {
  assert.equal(sellableQty(8, 150, 20), 138);
  assert.equal(sellableQty(5, 0, 20), 0);
  assert.equal(sellableQty(0, 0, 0), 0);
});

test('可售量：没有云仓就不出现', () => {
  const parts = stockCellPartsList([{ stock: 8, inTransit: 150, eta: null, cloud: 0, orderBook: 0 }])[0];
  assert.deepEqual(parts, ['现货8', '在途150']);
});

test('可售量：手动改过的值优先于自动算', () => {
  const [manual, auto] = stockCellPartsList([
    { stock: 8, inTransit: 150, eta: null, cloud: 20, orderBook: 0, sellable: '99' },
    { stock: 8, inTransit: 150, eta: null, cloud: 20, orderBook: 0, sellable: '' },
  ]);
  assert.deepEqual(manual, ['现货8', '在途150', '可售99']);
  assert.deepEqual(auto, ['现货8', '在途150', '可售138']);
});

test('可售量：页面自己渲染编辑器时（includeSellable:false）文本里不带可售', () => {
  const parts = stockCellPartsList(
    [{ stock: 8, inTransit: 150, eta: null, cloud: 20, orderBook: 0 }],
    { includeSellable: false },
  )[0];
  assert.deepEqual(parts, ['现货8', '在途150']);
});
