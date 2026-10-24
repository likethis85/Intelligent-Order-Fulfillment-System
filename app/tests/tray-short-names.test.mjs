import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const traysPagePath = path.resolve(__dirname, '../src/sections/TraysPage.tsx');

test('TraysPage: product modifier/short name editing support', async (t) => {
  const code = fs.readFileSync(traysPagePath, 'utf8');

  await t.test('defines ShortNameEditor component with click-to-edit', () => {
    assert.match(code, /function ShortNameEditor\(/);
    assert.match(code, /title=\{[^}]*修饰名称/);
    assert.match(code, /className=\{`short-name-editor inline-flex items-center/);
    assert.match(code, /<input[^>]*autoFocus/);
    assert.match(code, /setDraft\(short\)/);
  });

  await t.test('defines getShortOverride helper for case-insensitive lookup', () => {
    assert.match(code, /function getShortOverride\(/);
  });

  await t.test('FieldRenderCtx includes short name update callbacks and readOnly', () => {
    assert.match(code, /onSaveRestockShortName\?: \(pid: string, value: string\) => void;/);
    assert.match(code, /onClearRestockShortName\?: \(pid: string\) => void;/);
    assert.match(code, /readOnly\?: boolean;/);
  });

  await t.test('尺码 row uses ShortNameEditor for multi-product short names', () => {
    assert.match(code, /isShortOverridden = Boolean\(getShortOverride\(ctx\.restockShortNames, p\.id\)\)/);
    assert.ok(code.includes('onSaveRestockShortName?.(p.id, v)'));
  });

  await t.test('售价 row uses ShortNameEditor for multi-product short names', () => {
    assert.ok(code.includes('onSaveRestockShortName?.(p.id, v)'));
  });

  await t.test('成本/倍率 row supports ShortNameEditor as prefix and in mazong cost', () => {
    assert.ok(code.includes('prefix={short ? ('));
    assert.ok(code.includes('CostRatioRow'));
  });

  await t.test('库存情况 row passes shortNode with ShortNameEditor', () => {
    assert.ok(code.includes('renderStockForProduct(p, short, shortNode)'));
  });

  await t.test('翻单周期 row renders ShortNameEditor for matching short prefixes', () => {
    assert.ok(code.includes('matchedShort = s;'));
    assert.ok(code.includes('onSaveRestockShortName?.(matchedPid!, v)'));
  });

  await t.test('setRestockShortName normalizes key and updates look.restockShortNames', () => {
    assert.ok(code.includes('const setRestockShortName = (_sectionId: string, lookId: string, pid: string, value: string) => {'));
    assert.ok(code.includes('const key = pid.toLowerCase().trim();'));
    assert.ok(code.includes('restockShortNames: Object.keys(next).length > 0 ? next : undefined'));
  });
});
