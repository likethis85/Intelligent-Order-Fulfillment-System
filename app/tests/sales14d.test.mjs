// 近 14 天销量（经典款判定口径）：窗口按北京时间自然日、缓存带末日失效。
process.env.SALES_WARM_DISABLED = '1'; // 单测不触发 guancli 预热
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, '..', 'server', '.cache');
const SALES14D_CACHE_FILE = join(CACHE_DIR, 'bi_sales14d.json');

const { last14Window, getSales14d, clearSalesCache } = await import('../server/daysales-client.js');

test('近 14 天窗口：含今天，共 14 个自然日（北京时间）', () => {
  const w = last14Window(new Date('2026-11-11T02:00:00Z')); // 北京 10:00
  assert.equal(w.end, '2026-11-11');
  assert.equal(w.start, '2026-10-29');
});

test('窗口按 UTC+8 取日期，跨零点不提前一天', () => {
  const w = last14Window(new Date('2026-11-10T17:30:00Z')); // 北京 11-11 01:30
  assert.equal(w.end, '2026-11-11');
});

test('近14天销量读商品全表 ETL，不再用宽表按日期区间现算', async () => {
  const src = await readFile(new URL('../server/daysales-client.js', import.meta.url), 'utf8');
  assert.ok(src.includes("const PRODUCT_DS_ID = 'g94553b7c10714125a095ea8'"), '商品全表数据集 ID');
  const fn = src.slice(src.indexOf('async function fetchSales14dChunk'));
  assert.ok(fn.includes('PRODUCT_DS_ID'), '近14天销量查询走商品全表');
  assert.ok(!fn.includes('支付日期'), '不再按支付日期区间过滤');
  // 商品全表小（5.8 万行），批量要比宽表的 20 大得多，否则几百个小任务会把 BI 挤到超时
  assert.ok(src.includes('const CHUNK_SIZE_14D = 200'), '近14天批量 200 款/次');
  assert.ok(src.includes('chunkPids(missing, CHUNK_SIZE_14D)'), '预热按 200 分批');
});

test('缓存命中的近 14 天销量直接返回，过期的按未预热处理', async () => {
  await mkdir(CACHE_DIR, { recursive: true });
  const w = last14Window();
  await writeFile(
    SALES14D_CACHE_FILE,
    JSON.stringify({
      me01xx001: { q: 42, at: Date.now(), end: w.end },
      me01xx002: { q: 99, at: Date.now(), end: '2000-01-01' },
    }),
    'utf8',
  );
  const r = await getSales14d(['ME01XX001', 'ME01XX002']);
  assert.equal(r.byPid.ME01XX001, 42, '窗口末日对得上：用缓存值');
  assert.equal(r.byPid.ME01XX002, 0, '窗口已变：旧值不复用');
  assert.equal(r.pending, 1, '过期款号进预热队列');
  assert.equal(r.window.end, w.end);

  await clearSalesCache({ hard: true });
});
