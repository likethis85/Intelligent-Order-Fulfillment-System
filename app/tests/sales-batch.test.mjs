import test from 'node:test';
import assert from 'node:assert/strict';

// 关掉后台预热：这些用例只验证「读缓存 + 返回 pending」的纯逻辑，不碰 BI
process.env.SALES_WARM_DISABLED = '1';

const {
  chunkPids,
  sumRowsByCode,
  getDailySales,
  getCumulativeSales,
  clearSalesCache,
} = await import('../server/daysales-client.js');

test('chunkPids: 去重、转大写、排序后按 20 款分批（同一批集合稳定，便于去重）', () => {
  const pids = ['me01', ' ME02 ', 'ME01', 'me03'];
  assert.deepEqual(chunkPids(pids, 2), [['ME01', 'ME02'], ['ME03']]);
  assert.deepEqual(chunkPids(['b', 'a'], 20), [['A', 'B']]);
  // 100 个款号 → 5 批，每批 20
  const many = Array.from({ length: 100 }, (_, i) => `ME${String(i).padStart(3, '0')}`);
  const chunks = chunkPids(many, 20);
  assert.equal(chunks.length, 5);
  assert.equal(chunks[0].length, 20);
  // 顺序稳定（排序后），多次调用结果一致
  assert.deepEqual(chunkPids(many, 20), chunks);
});

test('sumRowsByCode: 按款号汇总销量，忽略退货负数与非数字', () => {
  const rows = [
    ['ME01', '5'],
    ['ME01', '12'],
    ['me02', '3'],
    ['ME03', '-4'],
    ['ME04', ''],
    ['ME05', 'abc'],
    ['ME06', '0'],
  ];
  const sums = sumRowsByCode(rows, 1);
  assert.equal(sums.get('ME01'), 17);
  assert.equal(sums.get('ME02'), 3);
  assert.equal(sums.has('ME03'), false); // 负数（退货）不计
  assert.equal(sums.has('ME04'), false);
  assert.equal(sums.has('ME05'), false);
  assert.equal(sums.has('ME06'), false); // 0 不入表，交给调用方补 0
});

test('getDailySales: 没有缓存时立即返回 0 占位 + pending，绝不等待 BI', async () => {
  await clearSalesCache({ hard: true });
  const startedAt = Date.now();
  const res = await getDailySales(['me99zz001', 'ME99ZZ002'], '2026-10-18');
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 1000, `应立刻返回，实际 ${elapsed}ms`);
  assert.equal(res.pending, 2);
  assert.equal(res.byPid.ME99ZZ001, 0);
  assert.equal(res.byPid.me99zz001, 0);
  assert.equal(res.byPid.ME99ZZ002, 0);
});

test('getCumulativeSales: 没有缓存时立即返回 0 占位 + pending', async () => {
  const res = await getCumulativeSales(['me99zz003']);
  assert.equal(res.pending, 1);
  assert.equal(res.byPid.ME99ZZ003, 0);
  assert.equal(res.byPid.me99zz003, 0);
});

test('空输入直接返回空结果', async () => {
  assert.deepEqual(await getDailySales([], '2026-10-18'), { byPid: {}, pending: 0 });
  assert.deepEqual(await getCumulativeSales([]), { byPid: {}, pending: 0 });
});
