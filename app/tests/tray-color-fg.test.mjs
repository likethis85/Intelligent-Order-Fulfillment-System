// 颜色字色（商品名称下面那行逐条上色）：
//   1) 存的是 lookId → 颜色名 → #rrggbb，多个颜色要各自生效，不能只剩一个
//   2) 只设字色、不动颜色勾选时，colorOverrideByLook 存的是空串（= 自动拼接），
//      字色不能拿它当过滤条件 —— 以前就是这么丢的，表现是「设了一个有效，其他都没生效」
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanColorFg, colorFgOf, colorSegments, pruneColorFg } from '../src/lib/trayColors.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const page = fs.readFileSync(path.resolve(__dirname, '../src/sections/TraysPage.tsx'), 'utf8');

test('多个颜色的字色都能存下来，色值统一成 #rrggbb', () => {
  const clean = cleanColorFg({ 灰色: '#DB2777', 棕色: '2563eb', ' 黑色 ': '#abc' });
  assert.deepEqual(clean, { 灰色: '#db2777', 棕色: '#2563eb', 黑色: '#aabbcc' });
});

test('认不出的色值、空键都丢掉，不影响其它颜色', () => {
  const clean = cleanColorFg({ 灰色: '', 棕色: 'not-a-color', 黑色: '#000000' });
  assert.deepEqual(clean, { 黑色: '#000000' });
});

test('只设字色、不改勾选（override 为空串）时字色照样保留', () => {
  const fgByLook = { 灰色: '#db2777', 棕色: '#2563eb' };
  // 弹窗保存时按勾选裁剪：两个颜色都在勾选里 → 两个都留
  const saved = pruneColorFg(fgByLook, ['灰色', '棕色']);
  assert.deepEqual(cleanColorFg(saved), { 灰色: '#db2777', 棕色: '#2563eb' });
});

test('勾掉的颜色不再保留它的字色', () => {
  const saved = pruneColorFg({ 灰色: '#db2777', 棕色: '#2563eb' }, ['灰色']);
  assert.deepEqual(saved, { 灰色: '#db2777' });
  assert.equal(colorFgOf(saved, '棕色'), '');
});

test('颜色文案按颜色分段，每段用自己的字色', () => {
  const segs = colorSegments('金扣黑带身 / 黑色', { 金扣黑带身: '#db2777', 黑色: '#2563eb' });
  assert.deepEqual(segs, [
    { text: '金扣黑带身', color: '#db2777' },
    { text: '黑色', color: '#2563eb' },
  ]);
});

test('「还原默认」把字色一起清掉', () => {
  const title = page.indexOf('清掉这个坑位的颜色字色');
  assert.ok(title > 0, '还原默认按钮的说明要写清楚会清字色');
  const block = page.slice(Math.max(0, title - 1500), title);
  assert.ok(block.includes('setSelected(splitColorText(defaultText));'), '还原默认先回到按款号自动拼接的颜色');
  assert.ok(block.includes('setFgColors({});'), '还原默认必须清掉这个坑位的颜色字色，否则勾着的颜色还留着旧字色');
  assert.ok(block.includes('setFgEditing(null);'), '顺带把打开着的调色面板关掉');
});

test('保存逻辑不再拿颜色文案当过字色的过滤条件', () => {
  const fnStart = page.indexOf('const setColorOverride = (');
  const fn = page.slice(fnStart, fnStart + 1200);
  assert.ok(fn.includes('const cleanFg = cleanColorFg(fgColors);'), '字色只做规范化，勾选裁剪交给弹窗的 pruneColorFg');
  assert.ok(!fn.includes('keptColors.has(color)'), '不能再按 override 文案过滤：不改勾选时 override 是空串，会把字色全丢掉');
});
