// 近14天销量：数据来自「商品全表」ETL 的本地快照，每天随 BI 刷新下载一次，
// 用户请求只读快照文件，不再实时查 BI（也不再用宽表按支付日期区间现算）。
process.env.SALES_WARM_DISABLED = '1';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, '..', 'server', '.cache');

const snapMod = await import('../server/product-snapshot.js');
const { SNAPSHOT_FILE, sumByCode, isSnapshotStale, __resetSnapshotForTest } = snapMod;
const { last14Window, getSales14d } = await import('../server/daysales-client.js');

test('同一款多个 SKC 行相加，退货负数不计入', () => {
  const sums = sumByCode([
    ['ME09FW038', 208],
    ['me09fw038', 99],
    ['ME09FW038', -5],
    ['ME21FC002', 28],
    ['ME21FC002', 0],
    ['总计', 999],
  ]);
  assert.equal(sums.get('ME09FW038'), 307);
  assert.equal(sums.get('ME21FC002'), 28);
  assert.equal(sums.size, 2);
});

test('整拉会 524，按款上新时间分年下载', () => {
  const filters = snapMod.partitionFilters(new Date('2026-11-11T00:00:00Z'));
  assert.equal(filters[0], '款上新时间 BT 2019-01-01,2019-12-31');
  assert.ok(filters.includes('款上新时间 BT 2026-01-01,2026-12-31'), '今年单独一段');
  assert.equal(filters[filters.length - 1], '款上新时间 GE 2027-01-01', '尾段兜住 9999/未来年份');
});

test('快照超过 24h 视为过期', () => {
  assert.equal(isSnapshotStale(null), true);
  assert.equal(isSnapshotStale({ at: Date.now() - 25 * 3600_000 }), true);
  assert.equal(isSnapshotStale({ at: Date.now() - 3600_000 }), false);
});

test('查询只读本地快照：返回大写+小写两种键，pending 恒为 0', async () => {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(
    SNAPSHOT_FILE,
    JSON.stringify({ at: Date.now(), date: '2026-11-11', column: '近14天销量', byCode: { ME09FW038: 1554 } }),
    'utf8',
  );
  __resetSnapshotForTest();

  const r = await getSales14d(['ME09FW038', 'ME21FC002']);
  assert.equal(r.byPid.ME09FW038, 1554);
  assert.equal(r.byPid.me09fw038, 1554, '小写键也要有');
  assert.equal(r.pending, 0, '不再有 BI 预热排队');
  assert.equal(r.snapshotDate, '2026-11-11');
  assert.equal(r.window.end, last14Window().end);

  await unlink(SNAPSHOT_FILE).catch(() => {});
});

test('一份快照同时聚合销量 / BOM 成本 / 尺码（尺码跳过未采购未上架）', () => {
  const agg = snapMod.aggregateRows([
    { code: 'ME09FW038', qty: 208, cost: 100.24, size: 'M', year: '2026' },
    { code: 'me09fw038', qty: 99, cost: 120.06, size: 'L', year: '2026' },
    { code: 'ME09FW038', qty: -5, cost: -1, size: 'XL', year: '未采购未上架' },
    { code: 'ME21FC002', qty: 28, cost: 0, size: '', year: '2026' },
  ]);
  const a = agg.get('ME09FW038');
  assert.equal(a.s, 307, '销量只加正数');
  assert.equal(a.c, 120.1, '成本取最大值并保留 1 位小数');
  assert.deepEqual([...a.z].sort(), ['L', 'M'], '未采购未上架的 SKC 不计入尺码');
  const b = agg.get('ME21FC002');
  assert.equal(b.s, 28);
  assert.equal(b.c, 0, '0 保留（可能是录入中）');
});

test('成本 / 尺码客户端先读快照，命中就不打 BI', async () => {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(
    SNAPSHOT_FILE,
    JSON.stringify({
      v: 2,
      at: Date.now(),
      date: '2026-11-11',
      column: '近14天销量',
      byCode: { ME09FW038: { s: 1554, c: 88.6, z: ['M', 'L', 'XL'] } },
    }),
    'utf8',
  );
  __resetSnapshotForTest();
  const costMod = await import('../server/cost-client.js');
  const sizeMod = await import('../server/size-client.js');
  costMod.clearCostCache();
  sizeMod.clearSizeCache();

  await costMod.loadBomCost(['ME09FW038']);
  await sizeMod.loadSizeRange(['ME09FW038']);
  assert.equal(costMod.getBomCostForCode('me09fw038'), '88.6');
  assert.equal(sizeMod.getSizeRangeForCode('ME09FW038'), 'M~XL');

  const costSrc = await readFile(new URL('../server/cost-client.js', import.meta.url), 'utf8');
  const sizeSrc = await readFile(new URL('../server/size-client.js', import.meta.url), 'utf8');
  assert.ok(costSrc.includes('getSnapshotData'), '成本先读快照');
  assert.ok(sizeSrc.includes('getSnapshotData'), '尺码先读快照');

  await unlink(SNAPSHOT_FILE).catch(() => {});
});

test('实时 BI 查询路径已移除，快照随 BI 每日刷新一起下', async () => {
  const src = await readFile(new URL('../server/daysales-client.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export async function getSales14d'));
  assert.ok(fn.includes('getSales14dFromSnapshot'), 'getSales14d 走快照');
  assert.ok(!fn.includes('runGuancli') && !fn.includes('enqueue'), '查询不再发起 BI 请求或入队');

  const sched = await readFile(new URL('../server/bi-schedule.js', import.meta.url), 'utf8');
  assert.ok(sched.includes("['product-snapshot', () => downloadProductSnapshot()]"), '每日定时下载快照');
  const snap = await readFile(new URL('../server/product-snapshot.js', import.meta.url), 'utf8');
  assert.ok(snap.includes("'近14天销量'"), '字段名');
  assert.ok(snap.includes("lane: 'background'"), '走后台车道');
});
