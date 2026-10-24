import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const traysPagePath = path.resolve(__dirname, '../src/sections/TraysPage.tsx');

test('TraysPage: un-aired sessions hide live day sales and cumulative sales rows', async (t) => {
  const code = fs.readFileSync(traysPagePath, 'utf8');

  await t.test('todayStr calculates local calendar date to avoid UTC day boundary mismatch', () => {
    assert.match(code, /const todayStr = useMemo\(\(\) => \{[\s\S]*?getFullYear\(\)[\s\S]*?getMonth\(\)[\s\S]*?getDate\(\)/);
  });

  await t.test('isAired is defined and checks date < todayStr plus real sales data', () => {
    assert.match(code, /const isAired = useMemo\(\(\) => \{/);
    assert.match(code, /if \(!tray\?\.date \|\| tray\.date >= todayStr\) return false;/);
    assert.match(code, /const slot = salesByDate\[tray\.date\];/);
    assert.match(code, /hasDaily \|\| hasCumu/);
  });

  await t.test('visibleFields filters out 直播当天销量 and 累计销量 when isAired is false', () => {
    assert.match(code, /const visibleFields = FIELDS\.filter\(\(f\) => \{[\s\S]*?f\.label === '直播当天销量' \|\| f\.label === '累计销量'[\s\S]*?return isAired;/);
  });

  await t.test('exportTrayLayoutExcel also checks isAired before splicing sales rows into Excel', () => {
    assert.match(code, /const isAired = Boolean\(t\.date && t\.date < todayStr && hasSales\);/);
    assert.match(code, /if \(isAired\) \{[\s\S]*?mainRows\.splice\(9, 0,/);
  });
});
