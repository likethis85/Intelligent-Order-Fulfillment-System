// 货盘库存取数优先级：聚水潭实时库存（全仓）优先，观远 BI SKC 卡（主仓）兜底。
// 聚水潭没这个款 → 回 BI 兜底；聚水潭明确返回 0 库存 → 以 0 为准，不能继续显示 BI 旧值。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { applyJushuitanPriority, formatStockUpdatedAt } = await import('../src/lib/stockLines.ts');

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
    updatedAt: '2026-11-10T02:30:00.000Z',
  });
  assert.deepEqual(next.stock, ['藏青：现货40 在途11']);
  assert.equal(next.stockMain, 40);
  assert.equal(next.inTransit, 11);
  assert.equal(next.stockSource, 'jushuitan');
  assert.equal(next.stockUpdatedAt, '2026-11-10T02:30:00.000Z');
  assert.equal(next.stockStale, false);
  assert.deepEqual(next.colors, ['藏青'], '其它字段原样保留');
});

test('聚水潭没这个款：保留 BI 兜底值', () => {
  assert.deepEqual(applyJushuitanPriority(biProduct, undefined), biProduct);
  assert.deepEqual(applyJushuitanPriority(biProduct, null), biProduct);
});

test('聚水潭明确返回 0 库存：覆盖 BI，显示 —，不能挂 BI 旧库存', () => {
  const next = applyJushuitanPriority(biProduct, { stock: [], stockMain: 0, inTransit: 0 });
  assert.deepEqual(next.stock, []);
  assert.equal(next.stockMain, 0);
  assert.equal(next.inTransit, 0);
  assert.equal(next.stockSource, 'jushuitan', '0 库存也是聚水潭的权威结果');
});

test('刷新失败沿用旧缓存：带 stale 标记，页面据此提示可能过期', () => {
  const next = applyJushuitanPriority(biProduct, {
    stock: ['藏青：现货40'],
    stockMain: 40,
    inTransit: 0,
    updatedAt: '2026-11-10T01:00:00.000Z',
    stale: true,
  });
  assert.equal(next.stockStale, true);
  assert.equal(next.stockUpdatedAt, '2026-11-10T01:00:00.000Z');
});

test('更新时间：当天只显示 HH:mm，跨天带上 MM-DD', () => {
  const now = new Date(2026, 10, 10, 18, 0);
  assert.equal(formatStockUpdatedAt(new Date(2026, 10, 10, 9, 5).toISOString(), now), '09:05');
  assert.equal(formatStockUpdatedAt(new Date(2026, 10, 9, 9, 5).toISOString(), now), '11-09 09:05');
  assert.equal(formatStockUpdatedAt(undefined, now), '');
  assert.equal(formatStockUpdatedAt('not-a-date', now), '');
});

test('页面：当前货盘所有款号都查聚水潭，缺失款删除旧值而不是永久沿用', () => {
  const pageCode = fs.readFileSync(path.resolve(__dirname, '../src/sections/TraysPage.tsx'), 'utf8');
  assert.ok(
    pageCode.includes("authenticatedFetch(`${API_BASE}/products/stock/by-ids?ids=${encodeURIComponent(ids.join(','))}`)"),
    '把当前货盘全部款号发给聚水潭，而不是只补 BI 缺的款',
  );
  assert.ok(!pageCode.includes('biSkcUsable'), '不再用 BI 可用性决定是否取聚水潭');
  assert.ok(pageCode.includes('applyJushuitanPriority(next, jstStockByCode[id.toLowerCase()])'));
  // 成功响应里没有的款号必须删掉，否则会一直显示上一次的聚水潭库存
  assert.ok(pageCode.includes('delete next[key]'), '缺失款号要清掉旧聚水潭值');
  assert.ok(pageCode.includes('聚水潭库存更新于'), '取数时间显示在页面顶部');
  assert.ok(pageCode.includes('数据可能已过期'), '刷新失败要在顶部提示');
  assert.ok(!pageCode.includes('聚水潭·全仓${jstUpdatedAt'), '库存单元格里不再拼取数时间');
});
