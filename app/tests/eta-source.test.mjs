// 交期（协议到货日期）来源回归：
// 以前读仪表盘卡片「成衣采购单明细」，卡片快照更新滞后——PO 从 12/3 改期到 12/7，
// 数据集 19:34 已更新、卡片仍返回 12/3，货盘交期跟着错。现在直接读数据集「产品交期数据」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rowsToMap } from '../server/eta-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.resolve(__dirname, '../server/eta-client.js'), 'utf8');

test('交期聚合：同款多处待收货取最早的协议到货日期', () => {
  const m = rowsToMap([
    { 款式编码: 'ME15FW034', 协议到货日期: '2026-12-07 23:59:59', 数量: '60', 已入库数: '0.0' },
    { 款式编码: 'ME15FW034', 协议到货日期: '2026-12-03 23:59:59', 数量: '29', 已入库数: '0' },
  ]);
  assert.deepEqual(m.get('me15fw034'), {
    eta: '12/3', etaRaw: '2026-12-03 23:59:59', isPending: true,
  });
});

test('交期聚合：改期后取新日期（同款只有一单未入库）', () => {
  const m = rowsToMap([
    { 款式编码: 'ME15FW034', 协议到货日期: '2026-12-07 23:59:59', 数量: '223', 已入库数: '0' },
  ]);
  assert.equal(m.get('me15fw034').etaRaw, '2026-12-07 23:59:59');
  assert.equal(m.get('me15fw034').isPending, true);
});

test('交期聚合：已收齐的单不压过待收货单', () => {
  const m = rowsToMap([
    { 款式编码: 'ME01FF063', 协议到货日期: '2026-11-20 23:59:59', 数量: '10', 已入库数: '10' },
    { 款式编码: 'ME01FF063', 协议到货日期: '2026-12-15 23:59:59', 数量: '10', 已入库数: '0' },
  ]);
  const e = m.get('me01ff063');
  assert.equal(e.etaRaw, '2026-12-15 23:59:59');
  assert.equal(e.isPending, true);
});

test('交期来源：优先读数据集「产品交期数据」，卡片只做兜底', () => {
  assert.ok(src.includes("const DS_ID = 'j5eecba4b53384a4186c53ba'"), '数据源必须是产品交期数据集');
  assert.ok(src.includes("'--filter', `状态 IN ${PENDING_STATUSES.join(',')}`"), '只拉未完结的采购单');
  const dsIdx = src.indexOf('await runGuancliDsPreview()');
  const cardIdx = src.indexOf('return runGuancliCardPreview();');
  assert.ok(dsIdx > 0 && cardIdx > dsIdx, '数据集失败后才回退卡片');
});
