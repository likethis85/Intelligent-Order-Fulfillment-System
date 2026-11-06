// 色号与库存对齐：颜色行里没勾的颜色，库存不再显示；
// 勾上的颜色（包括后来加回来的色号）在「同步库存」拉到数据后照常显示。
// BI 的颜色名可能更细（颜色行写「深灰」，BI 行是「深灰千鸟」），所以双向包含即命中。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { colorMatchesSelection, pickEntriesByColors } = await import('../src/lib/trayColors.ts');
const { parseStockLine } = await import('../src/lib/stockLines.ts');
const pageCode = fs.readFileSync(path.resolve(__dirname, '../src/sections/TraysPage.tsx'), 'utf8');

test('BI 库存行：颜色、现货、在途、交期、占单都能拆出来', () => {
  const e = parseStockLine('深灰千鸟：现货40 在途179 11/10交 占单320', ['深灰']);
  assert.equal(e.color, '深灰', '领猫颜色表里有「深灰」就按它归类');
  assert.equal(e.stock, 40);
  assert.equal(e.inTransit, 179);
  assert.equal(e.eta, '11/10');
  assert.equal(e.orderBook, 320);
});

test('领猫颜色表里没有的色号，用 BI 行头部的颜色名单独成行', () => {
  const e = parseStockLine('米灰：现货5 在途0', ['深灰', '藏青']);
  assert.equal(e.color, '米灰', '后来补加的色号也能拿到自己的库存');
  assert.equal(e.stock, 5);
});

test('没有冒号的 mock 行不会把整句当成颜色名', () => {
  const e = parseStockLine('白占单180在途100', ['白']);
  assert.equal(e.color, '白');
  const unknown = parseStockLine('白占单180在途100', []);
  assert.equal(unknown.color, '', '没有颜色线索就归到「其他」，不瞎猜');
});

const entries = [
  { color: '深灰' },
  { color: '藏青' },
  { color: '驼色' },
  { color: '米灰' },
];

test('勾掉的颜色不再出现在库存里', () => {
  const kept = pickEntriesByColors(entries, ['驼色', '藏青', '深灰']);
  assert.deepEqual(kept.map((e) => e.color), ['深灰', '藏青', '驼色'], '米灰被隐藏，其它保留');
});

test('BI 颜色比颜色行更细时也能对上（深灰 ↔ 深灰千鸟）', () => {
  assert.equal(colorMatchesSelection('深灰千鸟', ['深灰']), true);
  assert.equal(colorMatchesSelection('深灰', ['深灰千鸟']), true);
  assert.equal(colorMatchesSelection('藏青', ['深灰']), false);
});

test('没解析出颜色的行保留，明确没勾的照样隐藏', () => {
  const kept = pickEntriesByColors([{ color: '' }, { color: '藏青' }], ['深灰']);
  assert.deepEqual(kept.map((e) => e.color), [''], '不可归类的行保留，藏青没勾所以隐藏');
});

test('一个颜色都没勾（或没设颜色覆盖）时不过滤', () => {
  assert.equal(pickEntriesByColors(entries, undefined).length, 4);
  assert.equal(pickEntriesByColors(entries, []).length, 4);
});

test('勾选的颜色系统里没有时退回全量，避免整列库存变空', () => {
  const kept = pickEntriesByColors(entries, ['金扣黑带身']);
  assert.equal(kept.length, 4, '全部不匹配 → 保留全部');
});

test('页面接线：库存单元格和 Excel 导出都按颜色行过滤', () => {
  assert.ok(
    pageCode.includes('const visibleColors = ctx.colorOverride ? splitColorText(ctx.colorOverride) : undefined;'),
    '库存单元格取颜色行的勾选结果',
  );
  assert.ok(pageCode.includes('renderStockForProduct(ps[0], undefined, undefined, visibleColors)'), '单款也要过滤');
  assert.ok(pageCode.includes('renderStockForProduct(p, short, shortNode, visibleColors)'), '多款同样过滤');
  assert.ok(
    pageCode.includes('const visibleColors = t.colorOverrideByLook?.[l.id] ? splitColorText(t.colorOverrideByLook[l.id]) : undefined;'),
    '导出库存列用同一个颜色覆盖',
  );
  assert.ok(pageCode.includes('stockCellText(p, shortNames.get(p.id), visibleColors)'), '导出时把可见颜色传进去');
});
