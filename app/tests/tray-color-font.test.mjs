// 颜色字色：商品名称下面那行颜色可以逐条设字体颜色（按颜色名存 #rrggbb）
// 表格和 Excel 导出同口径；没设的颜色保持默认灰字。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const {
  COLOR_FG_PRESETS,
  colorFgOf,
  colorSegments,
  hexToArgb,
  normalizeHexColor,
  pruneColorFg,
} = await import('../src/lib/trayColors.ts');
const { mergeTray, changedFields } = await import('../src/lib/trayMerge.ts');

const pageCode = fs.readFileSync(path.resolve(__dirname, '../src/sections/TraysPage.tsx'), 'utf8');
const productsCode = fs.readFileSync(path.resolve(__dirname, '../src/data/products.ts'), 'utf8');
const mergeCode = fs.readFileSync(path.resolve(__dirname, '../src/lib/trayMerge.ts'), 'utf8');
const serverMerge = fs.readFileSync(path.resolve(__dirname, '../server/trays-field-merge.js'), 'utf8');
const idsCode = fs.readFileSync(path.resolve(__dirname, '../src/lib/trayIds.ts'), 'utf8');
const syncCode = fs.readFileSync(path.resolve(__dirname, '../src/lib/traySync.ts'), 'utf8');

test('色值统一成 #rrggbb，认不出来就当没设', () => {
  assert.equal(normalizeHexColor('#DC2626'), '#dc2626');
  assert.equal(normalizeHexColor('dc2626'), '#dc2626', '不带 # 也能认');
  assert.equal(normalizeHexColor('#abc'), '#aabbcc', '三位缩写补全');
  assert.equal(normalizeHexColor('  #FFF  '), '#ffffff');
  assert.equal(normalizeHexColor(''), '');
  assert.equal(normalizeHexColor('red'), '', '英文色名不收，只认色值');
  assert.equal(normalizeHexColor('#12345'), '', '位数不对就不认');
});

test('预设色都是合法色值', () => {
  assert.ok(COLOR_FG_PRESETS.length >= 6);
  for (const p of COLOR_FG_PRESETS) {
    assert.equal(normalizeHexColor(p.value), p.value, `${p.label} 应该是规范色值`);
  }
});

test('按颜色名取字色，没设过就是空（走默认灰字）', () => {
  const map = { 浅灰色: '#2563eb' };
  assert.equal(colorFgOf(map, '浅灰色'), '#2563eb');
  assert.equal(colorFgOf(map, ' 浅灰色 '), '#2563eb', '两边空格不影响');
  assert.equal(colorFgOf(map, '经典黑'), '');
  assert.equal(colorFgOf(undefined, '浅灰色'), '');
  assert.equal(colorFgOf(map, ''), '');
});

test('保存时只留仍然勾选的颜色', () => {
  const map = { 浅灰色: '#2563eb', 云朵白: '#7c3aed', 经典黑: '#dc2626' };
  assert.deepEqual(pruneColorFg(map, ['浅灰色', '云朵白']), { 浅灰色: '#2563eb', 云朵白: '#7c3aed' });
  assert.deepEqual(pruneColorFg(map, []), {}, '全取消 = 不留任何字色');
  assert.deepEqual(pruneColorFg({ 浅灰色: 'oops' }, ['浅灰色']), {}, '非法色值当没设');
});

test('颜色文案拆成带色值的分段（页面和导出共用）', () => {
  const segs = colorSegments('浅灰色 / 经典黑 / 云朵白', { 浅灰色: '#2563eb', 云朵白: '#7c3aed' });
  assert.deepEqual(segs, [
    { text: '浅灰色', color: '#2563eb' },
    { text: '经典黑', color: '' },
    { text: '云朵白', color: '#7c3aed' },
  ]);
});

test('Excel 用 ARGB', () => {
  assert.equal(hexToArgb('#2563eb'), 'FF2563EB');
  assert.equal(hexToArgb('abc'), 'FFAABBCC');
  assert.equal(hexToArgb(''), '');
});

test('存储字段 + 协同合并 + 坑位改名迁移都带上了颜色字色', () => {
  assert.ok(
    productsCode.includes('colorFgByLook?: Record<string, Record<string, string>>;'),
    '货盘上有存颜色字色的字段',
  );
  assert.ok(mergeCode.includes("'colorFgByLook'"), '客户端协同合并按坑位同步');
  assert.ok(serverMerge.includes("'colorFgByLook'"), '服务端字段级合并口径要跟客户端一致');
  assert.ok(idsCode.includes("'colorFgByLook'"), '坑位 id 修复改名时字色跟着搬');
  assert.ok(syncCode.includes("put('颜色字色',"), '操作日志里能看到改了颜色字色');
});

test('协同合并：两边的字色按坑位各并各的', () => {
  const base = { id: 't1', sections: [], updatedAt: '2026-11-06T10:00:00.000Z' };
  const local = { ...base, colorFgByLook: { 'L-1': { 浅灰色: '#2563eb' } } };
  const remote = { ...base, colorFgByLook: { 'L-2': { 云朵白: '#7c3aed' } } };
  const { tray } = mergeTray(local, remote);
  assert.deepEqual(tray.colorFgByLook, {
    'L-1': { 浅灰色: '#2563eb' },
    'L-2': { 云朵白: '#7c3aed' },
  });
  assert.deepEqual(
    changedFields(local, remote),
    ['colorFgByLook:L-1', 'colorFgByLook:L-2'],
    '字段级 LWW 精确到坑位，别人改另一个坑位不会被冲掉',
  );
});

test('弹窗保存写回 colorFgByLook，表格和导出都按它上色', () => {
  // 弹窗：色点 + 预设色板 + 自定义色值
  assert.ok(pageCode.includes('function FontColorSwatch('), '每个颜色行右侧的色点');
  assert.ok(pageCode.includes('function FontColorPicker('), '点开的色板');
  assert.ok(pageCode.includes('COLOR_FG_PRESETS.map'), '预设色');
  assert.ok(pageCode.includes('placeholder="dc2626 或 #dc2626"'), '自定义色值输入');
  assert.ok(pageCode.includes('fgByLook={tray.colorFgByLook?.[lookColorPicker.lookId]}'), '打开弹窗时带出已存字色');
  assert.ok(
    pageCode.includes('onSave(colorOverrideValue(selected, defaultText), keptCodes, pruneColorFg(fgColors, selected))'),
    '保存时把字色跟文案、色号一起写',
  );
  // 表格：颜色行按分段上色
  assert.ok(pageCode.includes('colorFgByColor: tray.colorFgByLook?.[l.id]'), '表格单元格取到字色');
  assert.ok(pageCode.includes('fgByColor={ctx.colorFgByColor}'), 'ColorLineEditor 接收字色');
  assert.ok(pageCode.includes('colorSegments(value, fgByColor)'), '颜色行逐条上色');
  // Excel 导出：同一套分段
  assert.ok(
    pageCode.includes('nameCellRichText(l.pids.map(byId), t.colorOverrideByLook?.[l.id], sampleColorsByPid, t.colorFgByLook?.[l.id])'),
    '导出商品名称时带上字色',
  );
  assert.ok(pageCode.includes('hexToArgb(seg.color) || baseArgb'), '导出按颜色分段写字体色');
});
