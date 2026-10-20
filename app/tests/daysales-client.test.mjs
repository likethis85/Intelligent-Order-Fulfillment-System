import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, clearSalesCache } from '../server/daysales-client.js';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CACHE_DIR = join(__dirname, '..', 'server', '.cache');
const DAILY_CACHE_FILE = join(CACHE_DIR, 'bi_daysales.json');
const CUMU_CACHE_FILE = join(CACHE_DIR, 'bi_cumusales.json');

test('parseCsv parses CSV rows and handles headers and metadata lines', () => {
  const dailyCsv = `
[WARN] Some banner notice from guancli
款式编码,支付日期,销售量
ME01XX001,2026-10-18,5
ME01XX001,2026-10-18,12
  `;
  const rows = parseCsv(dailyCsv);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], ['ME01XX001', '2026-10-18', '5']);
  assert.deepEqual(rows[1], ['ME01XX001', '2026-10-18', '12']);

  // SUM daily logic: column 2
  let dailySum = 0;
  for (const r of rows) {
    const q = Number(r[2]);
    if (Number.isFinite(q) && q > 0) dailySum += q;
  }
  assert.equal(dailySum, 17);

  const cumuCsv = `
款式编码,销售量
"ME01XX001","88"
"ME01XX001","12"
  `;
  const cumuRows = parseCsv(cumuCsv);
  assert.equal(cumuRows.length, 2);
  assert.deepEqual(cumuRows[0], ['ME01XX001', '88']);
  assert.deepEqual(cumuRows[1], ['ME01XX001', '12']);

  // SUM cumulative logic: column 1
  let cumuSum = 0;
  for (const r of cumuRows) {
    const q = Number(r[1]);
    if (Number.isFinite(q) && q > 0) cumuSum += q;
  }
  assert.equal(cumuSum, 100);
});

test('clearSalesCache({ hard: true }) unlinks cache files', async () => {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(DAILY_CACHE_FILE, JSON.stringify({ me01xx001: { '2026-10-18': { q: 5, at: Date.now() } } }), 'utf8');
  await writeFile(CUMU_CACHE_FILE, JSON.stringify({ me01xx001: { q: 50, at: Date.now() } }), 'utf8');

  assert.equal(existsSync(DAILY_CACHE_FILE), true);
  assert.equal(existsSync(CUMU_CACHE_FILE), true);

  await clearSalesCache({ hard: true });

  assert.equal(existsSync(DAILY_CACHE_FILE), false);
  assert.equal(existsSync(CUMU_CACHE_FILE), false);
});
