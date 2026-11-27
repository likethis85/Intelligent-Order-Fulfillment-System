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
const fabricQ = fs.readFileSync(path.resolve(__dirname, '../server/fabric-public/index.html'), 'utf8');

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

// ── 按 SKC 色号过滤（BI 面料列原文以 SKC 开头，颜色名是面料色，对不上商品颜色）──

const SKUS = [
  { code: 'ME15FF037', color: '藏青' },
  { code: 'ME15FF038', color: '深灰夹花' },
  { code: 'ME15FF039', color: '灰色' },
];

test('面料文本：按 SKC 色号过滤，只留勾选色对应的色号段', () => {
  const text = 'ME15FF037流沙色1036米面料仓；ME15FF038深灰夹花354米面料仓';
  assert.equal(
    filterFabricTextByColors(text, ['藏青'], [], SKUS),
    'ME15FF037流沙色1036米面料仓',
  );
  assert.equal(
    filterFabricTextByColors(text, ['深灰夹花'], [], SKUS),
    'ME15FF038深灰夹花354米面料仓',
  );
});

test('面料文本：SKC 色号优先于颜色名（面料色名认不出也照选）', () => {
  // 段里的「流沙色」不在已知颜色里，但它带着勾选色的色号 → 保留
  const text = 'ME15FF037流沙色1036米面料仓\n里料定染10天';
  assert.equal(
    filterFabricTextByColors(text, ['藏青'], [], SKUS),
    'ME15FF037流沙色1036米面料仓\n里料定染10天',
  );
});

test('面料文本：多个 SKC 段的行只留选中色号', () => {
  const text = 'ME15FF037流沙色1036米面料仓；ME15FF039灰色80米面料仓；ME15FF038深灰夹花354米面料仓';
  assert.equal(
    filterFabricTextByColors(text, ['灰色'], [], SKUS),
    'ME15FF039灰色80米面料仓',
  );
});

test('面料文本：颜色名带款号/面料前缀时也能匹配（全羊绒：黑色）', () => {
  const text = '全羊绒：黑色151米面料仓；全羊绒：米灰色200米面料仓';
  const known = ['全羊绒：黑色', '全羊绒：米灰色'];
  assert.equal(
    filterFabricTextByColors(text, ['全羊绒：黑色'], known),
    '全羊绒：黑色151米面料仓',
  );
});

test('页面接线：面料情况单元格与 Excel 都按勾选颜色 + SKC 过滤', () => {
  assert.ok(page.includes('filterFabricTextByColors(r.base, fabricVisibleColors, known, skus)'), '单元格过滤带色号');
  assert.ok(page.includes('filterFabricTextByColors(base, visibleColors, knownColors, skus)'), 'Excel 导出同口径');
  assert.ok(page.includes('fabricCellText(p, prod, t, visibleColors'), '导出时把可见颜色传进去');
  assert.ok(page.includes('ctx.skcsByCode?.[r.pid.toLowerCase()]'), '单元格里要取到该款的 SKC 列表');
  assert.ok(page.includes('skcsByPid?.[p.toLowerCase()] || skcsByPid?.[p]'), 'Excel 导出同样按 SKC 过滤');
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

test('「查询面料」弹窗（fabric_Q index.html）同样按勾选颜色过滤', () => {
  // 货盘点面料情况打开的就是 fabric_Q 的 iframe，之前没传 colors，整张表都是全色
  assert.ok(page.includes('const fpColorsParam'), '父页面要拼 colors 参数');
  assert.ok(page.includes('index.html?codes=${fpPids.map((p) => p.toUpperCase()).join(\',\')}${fpColorsParam}'),
    'iframe 地址带上 colors');
  assert.ok(fabricQ.includes("new URLSearchParams(location.search).get('colors')"), 'index.html 读 colors');
  assert.ok(fabricQ.includes('function rowsForAllowedColors('), '有统一过滤函数');
  assert.ok(fabricQ.includes('rowsForAllowedColors(Array.from(seenKeys.values()))'), '渲染前按成衣颜色过滤');
  assert.ok(fabricQ.includes('return kept.length > 0 ? kept : rows;'), '一个都匹配不上时退回全量，别清空整页');
});
