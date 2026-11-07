// 成本/倍率 注脚：和售价注脚同一套机制（pid → 后缀文案），
// 要求出现在 类型 / 合并 / diff / 界面（单款 + 多款）/ 导出 五处，漏一处就会「界面能设、导出没有」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
const page = read('src/sections/TraysPage.tsx');
const products = read('src/data/products.ts');
const traySync = read('src/lib/traySync.ts');
const trayMerge = read('src/lib/trayMerge.ts');
const serverMerge = read('server/trays-field-merge.js');

test('Tray 类型有 costSuffixOverrides', () => {
  assert.match(products, /costSuffixOverrides\?: Record<string, string>;/);
});

test('协同合并：前后端 KEYED_FIELDS 都认成本注脚', () => {
  assert.ok(trayMerge.includes("'costSuffixOverrides'"), '前端按 pid 合并，否则别人改了会整段覆盖');
  assert.ok(serverMerge.includes("'costSuffixOverrides'"), '服务端字段级合并同样要认，否则保存会被丢掉');
  assert.ok(traySync.includes("put('成本注脚',"), '修改记录要能看出来改的是成本注脚');
});

test('界面：单款和多款号都能设成本注脚', () => {
  assert.ok(page.includes('function CostSuffixEditor('), '要有独立的成本注脚编辑组件');
  // 导出用的行定义也叫「成本/倍率」，取最后一个（FIELDS 里的界面渲染定义）
  const fieldStart = page.lastIndexOf("label: '成本/倍率'");
  const field = page.slice(fieldStart, fieldStart + 9000);
  assert.ok(field.includes('CostSuffixEditor'), '成本/倍率 行要渲染注脚入口');
  const renderCount = (field.match(/<CostSuffixEditor/g) || []).length;
  assert.ok(renderCount >= 2, `单款 render 和多款 aggregateRender 都要有（当前 ${renderCount} 处）`);
});

test('保存：空字符串 = 清除 override', () => {
  const start = page.indexOf('const saveCostSuffix = ');
  const fn = page.slice(start, start + 900);
  assert.ok(fn.includes("if (v === '')"), '空串要当清除处理');
  assert.ok(fn.includes('delete next[pid]'), '清除时把该款号从表里删掉，而不是留一个空值');
  assert.ok(page.includes('onSaveCostSuffix: saveCostSuffix'), '行上下文要把保存函数透传下去');
});

test('行上下文：aggregate 分支也要透传保存函数（否则只能显示、存不进去）', () => {
  // 成本/倍率 带 aggregate: true，表格里永远走 aggregateRender；
  // 少传 onSaveCostSuffix 时注脚框会显示，但点保存是空操作（线上就是这个表现）
  const aggStart = page.indexOf('f.aggregateRender(ps');
  const renderStart = page.indexOf('f.render(fullByIdWithCost(pid)');
  assert.ok(aggStart > 0 && renderStart > aggStart, '要能找到 aggregate 与单款两个渲染入口');
  const aggCtx = page.slice(aggStart, renderStart);
  assert.ok(aggCtx.includes('costSuffixOverrides: tray.costSuffixOverrides,'), '多款号上下文要带 override 表');
  assert.ok(aggCtx.includes('onSaveCostSuffix: saveCostSuffix,'), '多款号上下文要带保存函数');
});

test('导出：成本/倍率文本带上注脚', () => {
  const start = page.indexOf('function costRatioText(');
  const fn = page.slice(start, start + 700);
  assert.ok(fn.includes('t.costSuffixOverrides?.[pid]'), '截图里的注脚要能进 Excel');
  assert.ok(fn.includes('`${body} ${suffix}`'), '注脚跟在「成本/倍率」后面，和售价注脚一样用空格分隔');
});
