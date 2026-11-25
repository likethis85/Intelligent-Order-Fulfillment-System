// 货盘库存单元格多一项「云仓N」：聚水潭虚拟仓（运营云仓）的订单占有数。
// 位置固定在 在途/交期 之后、占单 之前，0 时不显示；只有云仓的颜色也要能单独成行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStockLine, stockCellPartsList } from '../src/lib/stockLines.ts';

test('云仓：库存行文本能解析出云仓数', () => {
  const e = parseStockLine('针织衫 藏青：现货8 在途150 12/5交 云仓20 占单3', ['藏青']);
  assert.equal(e.color, '藏青');
  assert.equal(e.stock, 8);
  assert.equal(e.inTransit, 150);
  assert.equal(e.eta, '12/5');
  assert.equal(e.cloud, 20);
  assert.equal(e.orderBook, 3, '云仓不能把占单吞掉');
});

test('云仓：渲染顺序 现货 → 在途 → 交期 → 云仓 → 占单', () => {
  const parts = stockCellPartsList(
    [{ stock: 8, inTransit: 150, eta: '12/5', cloud: 20, orderBook: 30 }],
    { orderBookMinDisplay: 15 },
  )[0];
  assert.deepEqual(parts, ['现货8', '在途150', '12/5交', '云仓20', '占单30']);
});

test('云仓：为 0 时不写，且不影响「只有现货就省标签」的规则', () => {
  const parts = stockCellPartsList([{ stock: 47, inTransit: 0, eta: null, cloud: 0, orderBook: 0 }])[0];
  assert.deepEqual(parts, ['47']);
});

test('云仓：只有云仓的颜色也出这一项', () => {
  const parts = stockCellPartsList([{ stock: 0, inTransit: 0, eta: null, cloud: 6, orderBook: 0 }])[0];
  assert.deepEqual(parts, ['云仓6']);
});
