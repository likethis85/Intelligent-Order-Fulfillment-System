import test from 'node:test';
import assert from 'node:assert/strict';
import {
  signJushuitanParams,
  getJushuitanConfig,
  isJushuitanConfigured,
  parseColorAndSizeFromProps,
  getItemsByPids,
  getInventoryByPids,
  summarizeVirtualStock,
} from '../server/jushuitan-client.js';

test('jushuitan-client: official signature algorithm test vector', () => {
  // Official test vector from Jushuitan OpenAPI documentation
  const secret = 'e9c5ca33fecb404b8e6cdbd0ef4a6d25';
  const params = {
    app_key: '5b53060f23d84ddf9703056e84fa5a2d',
    access_token: 'd7b01bf0842a4742a9450e21ffd95f60',
    timestamp: '1639128407',
    version: '2',
    charset: 'utf-8',
    biz: '{"page_index":"1","page_size":"100","nicks":["老板"]}',
  };

  const sign = signJushuitanParams(params, secret);
  assert.equal(sign, '395f5a78b446be465ac03a02491296c7');
});

test('jushuitan-client: configuration detection', () => {
  const cfg = getJushuitanConfig();
  assert.equal(typeof cfg, 'object');
  assert.equal(typeof cfg.baseUrl, 'string');
  assert.equal(typeof cfg.appKey, 'string');
  assert.equal(typeof cfg.appSecret, 'string');
  assert.equal(isJushuitanConfigured(), true);
});

test('jushuitan-client: parseColorAndSizeFromProps parses spec attributes', () => {
  assert.deepEqual(parseColorAndSizeFromProps('藏青;155/62A(XS)'), { color: '藏青', size: '155/62A(XS)' });
  assert.deepEqual(parseColorAndSizeFromProps('乌木色;160/66A(S)'), { color: '乌木色', size: '160/66A(S)' });
  assert.deepEqual(parseColorAndSizeFromProps('黑色;均码'), { color: '黑色', size: '均码' });
  assert.deepEqual(parseColorAndSizeFromProps('咖啡色'), { color: '咖啡色', size: '' });
  assert.deepEqual(parseColorAndSizeFromProps('165/88A'), { color: '', size: '165/88A' });
  assert.deepEqual(parseColorAndSizeFromProps(''), { color: '', size: '' });
  assert.deepEqual(parseColorAndSizeFromProps(null), { color: '', size: '' });
});

test('jushuitan-client: getItemsByPids and getInventoryByPids handle empty input safely', async () => {
  const itemsRes = await getItemsByPids([]);
  assert.deepEqual(itemsRes, { items: [], byPid: {} });

  const invRes = await getInventoryByPids([]);
  assert.deepEqual(invRes, { byPid: {}, items: [] });
});

test('jushuitan-client: 虚拟仓库存只汇总名字带「云仓」的虚拟仓', () => {
  const rows = [
    {
      sku_id: 'S1',
      stocks: [
        { lwh_id: 11, name: '天猫运营云仓', qty: 5, order_lock: 7, pick_lock: 1 },
        { lwh_id: 12, name: '京东运营云仓', qty: 2, order_lock: 3, pick_lock: 0 },
        { lwh_id: 13, name: '线下虚拟仓', qty: 9, order_lock: 4, pick_lock: 2 },
      ],
    },
  ];
  const r = summarizeVirtualStock(rows);
  assert.deepEqual(r.cloudNames, ['11', '12'].map(Number));
  assert.equal(r.bySku.S1.orderLock, 10, '天猫云仓 7 + 京东云仓 3，线下虚拟仓不计');
  assert.equal(r.bySku.S1.qty, 7);
  assert.equal(r.sawWarehouse, true);
});

test('jushuitan-client: 没有云仓命名的虚拟仓时退回汇总全部', () => {
  const rows = [{ sku_id: 'S2', stocks: [{ lwh_id: 21, name: 'A仓', qty: 1, order_lock: 2 }, { lwh_id: 22, name: 'B仓', qty: 3, order_lock: 4 }] }];
  const r = summarizeVirtualStock(rows);
  assert.deepEqual(r.cloudNames, []);
  assert.equal(r.bySku.S2.orderLock, 6);
});

test('jushuitan-client: 虚拟仓库存兼容 camelCase 字段', () => {
  const rows = [{ skuId: 'S3', stocks: [{ lwhId: 31, name: '运营云仓', orderLock: 5, pickLock: 2, qty: 1 }] }];
  const r = summarizeVirtualStock(rows);
  assert.equal(r.bySku.S3.orderLock, 5);
  assert.equal(r.bySku.S3.pickLock, 2);
});
