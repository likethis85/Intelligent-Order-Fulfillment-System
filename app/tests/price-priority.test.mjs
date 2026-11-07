// 价格口径：
//   1) 售价以领猫零售价（retailPrice）为准，领猫没维护时才用 BI 兜底（款式卡 → SKC 卡 → 钉钉核价表）
//   2) 观远 BI 会改列名（销售价 → 款销售价、产品名称 → 产品名称(到款式) 等），
//      读字段要容忍新旧两种写法，否则卡片一改列就整列读空。
import test from 'node:test';
import assert from 'node:assert/strict';

import { biProductOverrides } from '../server/bi-client.js';
import { enrichWithBi } from '../server/routes/products.js';

const masterRow = (raw) => ({ pdtCode: 'TEST001', raw: { 款号: 'TEST001', ...raw } });
const skcRow = (raw) => ({
  pdtCode: 'TEST001',
  skcs: [{ color: '灰色', skc: 'TEST00114', raw: { 款号: 'TEST001', ...raw } }],
});

// 领猫侧最小商品（mapProduct 的形状）
const lingmao = (retailPrice) => ({ id: 'TEST001', name: '领猫名称', retailPrice, price: '', priceNum: undefined });

test('款式卡新列名（款销售价/款价格定位/产品名称(到款式)/款售罄率打标）能读到', () => {
  const ov = biProductOverrides(masterRow({
    款销售价: '599',
    款价格定位: '低',
    款价格段: '400-599',
    '产品名称(到款式)': 'BI 名称',
    款售罄率打标: '高销售',
  }));
  assert.equal(ov.price, '599');
  assert.equal(ov.priceNum, 599);
  assert.equal(ov.priceBand, '低');
  assert.equal(ov.name, 'BI 名称');
  assert.equal(ov.tagSoldOut, '高销售');
});

test('款式卡老列名仍然读得到（BI 回退列名时不至于又空掉）', () => {
  const ov = biProductOverrides(masterRow({
    销售价: '499',
    价格定位: '中',
    产品名称: 'BI 旧名称',
    售罄率打标: '低销售',
  }));
  assert.equal(ov.price, '499');
  assert.equal(ov.priceBand, '中');
  assert.equal(ov.name, 'BI 旧名称');
  assert.equal(ov.tagSoldOut, '低销售');
});

test('领猫有零售价时，BI 销售价不覆盖', () => {
  const p = enrichWithBi(lingmao(499), skcRow({ 销售价: '599' }), masterRow({ 款销售价: '599' }));
  assert.equal(p.price, '499');
  assert.equal(p.priceNum, 499);
});

test('领猫没有零售价时，用款式卡销售价兜底', () => {
  const p = enrichWithBi(lingmao(0), skcRow({ 销售价: '699' }), masterRow({ 款销售价: '599' }));
  assert.equal(p.price, '599');
  assert.equal(p.priceNum, 599);
});

test('款式卡没有销售价时，退到 SKC 卡销售价', () => {
  const p = enrichWithBi(lingmao(0), skcRow({ 销售价: '699' }), masterRow({ 小名: '星球套' }));
  assert.equal(p.price, '699');
  assert.equal(p.priceNum, 699);
});

test('价格定位只有 BI 有：款式卡没给时用 SKC 卡兜底', () => {
  const p = enrichWithBi(lingmao(499), skcRow({ 销售价: '599', 价格定位: '低' }), masterRow({ 小名: '星球套' }));
  assert.equal(p.priceBand, '低');
  assert.equal(p.price, '499', '价格定位兜底不影响领猫售价优先');
});
