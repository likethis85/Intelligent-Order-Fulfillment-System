// 货盘「商品名称」里勾了部分色号（如只勾 藏青/黑）时，
// 面料情况和翻单计划都只应展示这些颜色（含手动添加的颜色）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { filterFabricTextByColors } from '../src/lib/fabricColors.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const page = fs.readFileSync(path.resolve(__dirname, '../src/sections/TraysPage.tsx'), 'utf8');
const sales = fs.readFileSync(path.resolve(__dirname, '../server/fabric-public/sales.html'), 'utf8');

test('面料文本：只保留勾上的颜色', () => {
  const text = '黑色1105米面料仓；灰色1345米面料仓；藏青500米面料仓';
  assert.equal(
    filterFabricTextByColors(text, ['黑色', '藏青'], ['黑色', '灰色', '藏青']),
    '黑色1105米面料仓；藏青500米面料仓',
  );
});

test('面料文本：没有勾选颜色时原样返回', () => {
  const text = '黑色1105米面料仓；灰色1345米面料仓';
  assert.equal(filterFabricTextByColors(text, [], ['黑色', '灰色']), text);
  assert.equal(filterFabricTextByColors(text, undefined, ['黑色']), text);
});

test('面料文本：看不出颜色的段（里料/备注）保留', () => {
  const text = '灰色1345米面料仓\n里料定染10天';
  assert.equal(filterFabricTextByColors(text, ['黑色'], ['黑色', '灰色']), '里料定染10天');
});

test('面料文本：一行里全部颜色都被筛掉时整行消失', () => {
  const text = '灰色1345米面料仓\n黑色200米面料仓';
  assert.equal(filterFabricTextByColors(text, ['黑色'], ['黑色', '灰色']), '黑色200米面料仓');
});

test('面料文本：无面料不翻单的颜色同样按勾选过滤', () => {
  const text = '黑色无面料不翻单\n灰色无面料不翻单';
  assert.equal(filterFabricTextByColors(text, ['灰色'], ['黑色', '灰色']), '灰色无面料不翻单');
});

test('面料文本：面料颜色名和商品颜色不完全一致也能认出来', () => {
  // 商品里叫「灰」，面料里写「灰色」；商品颜色表里没有「驼色」时用颜色名猜测
  const text = '黑色1105米面料仓；灰色1345米面料仓；驼色500米面料仓';
  assert.equal(
    filterFabricTextByColors(text, ['黑色', '灰'], ['黑色', '灰']),
    '黑色1105米面料仓；灰色1345米面料仓',
  );
});

test('面料文本：颜色写在段中间（「现货：黑色1105米」）也能过滤', () => {
  const text = '面料仓现货：黑色1105米；面料仓现货：灰色1345米';
  assert.equal(
    filterFabricTextByColors(text, ['黑色'], ['黑色', '灰色']),
    '面料仓现货：黑色1105米',
  );
});

test('面料文本：顿号分隔的颜色同样按段过滤', () => {
  const text = '黑色、灰色 1345米面料仓';
  assert.equal(filterFabricTextByColors(text, ['灰色'], ['黑色', '灰色']), '灰色 1345米面料仓');
});

test('页面接线：面料情况单元格与 Excel 都按勾选颜色过滤', () => {
  assert.ok(page.includes('filterFabricTextByColors(r.base, fabricVisibleColors, known)'), '单元格过滤');
  assert.ok(page.includes('filterFabricTextByColors(base, visibleColors, knownColors)'), 'Excel 导出同口径');
  assert.ok(page.includes('fabricCellText(p, prod, t, visibleColors'), '导出时把可见颜色传进去');
});

test('翻单弹窗：URL 带上勾选的颜色', () => {
  assert.ok(page.includes('rpColorsParam'), 'iframe / 新窗口 URL 要带 colors 参数');
  assert.ok(page.includes('&colors='), '参数名与 sales.html 对齐');
  assert.ok(page.includes('<SampleMaterialsPanel pids={rpPids} colors={rpColors} />'), '样衣 SKC 物料面板也要按颜色过滤');
});

test('sales.html：读取 colors 参数并按颜色过滤展示与勾选', () => {
  assert.ok(sales.includes("get('colors')"), '从 URL 读 colors');
  assert.ok(sales.includes('function filterItemsByColors('), '有统一过滤函数');
  assert.ok(sales.includes('const shownItems = filterItemsByColors(items);'), '左侧列表按颜色过滤');
  assert.ok(sales.includes('items = filterItemsByColors(items);'), '勾选进编辑区时按颜色过滤');
});
