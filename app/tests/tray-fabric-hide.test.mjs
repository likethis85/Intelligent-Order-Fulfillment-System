// 面料情况里手动隐藏某一行（库存 0 米的颜色最常见）：
// 界面 / 导出 / 协同合并 / 恢复 四处都要认这份「隐藏行」清单，漏一处就会出现
// 「界面藏了、Excel 又冒出来」或「藏了以后找不回来」。
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

test('Tray 类型有 fabricHiddenLines', () => {
  assert.match(products, /fabricHiddenLines\?: Record<string, string\[\]>;/);
});

test('协同：前后端合并都按 pid 认这份隐藏清单，修改记录也有它', () => {
  assert.ok(trayMerge.includes("'fabricHiddenLines'"), '前端字段级合并要认，否则别人的隐藏会被整段覆盖');
  assert.ok(serverMerge.includes("'fabricHiddenLines'"), '服务端合并同样要认，否则保存会被丢掉');
  assert.ok(traySync.includes("put('面料隐藏行',"), '修改记录要能看出来改的是面料隐藏行');
});

test('隐藏是按整行文本匹配：库存变了这行就自动回来', () => {
  const start = page.indexOf('function applyHiddenFabricLines(');
  assert.ok(start > 0, '要有统一的隐藏行过滤函数');
  const fn = page.slice(start, start + 700);
  assert.ok(fn.includes('hidden.map((s) => s.trim())'), '记录时去掉首尾空白');
  assert.ok(fn.includes('!gone.has(line.trim())'), '按整行文本精确匹配，不是按颜色关键字（否则颜色永远不显示）');
});

test('界面：每行都能点 ✕ 隐藏，隐藏后有恢复入口', () => {
  assert.ok(page.includes('onHideFabricLine?.(pid, line)'), '单行隐藏按钮要调保存函数');
  assert.ok(page.includes('ctx.onRestoreFabricLines?.(pid)'), '要有恢复入口，否则藏了就找不回来');
  // 整格都被隐藏时这一行文本为空，若按 text 过滤就连「恢复」按钮一起消失
  assert.ok(page.includes('filter((r) => r.text || r.hiddenCount > 0)'), '有隐藏的行必须留在界面上');
});

test('界面：单款和多款号两个上下文都透传隐藏清单与保存函数', () => {
  const wiring = (page.match(/onHideFabricLine: hideFabricLine,/g) || []).length;
  assert.ok(wiring >= 2, `两个渲染上下文都要传（当前 ${wiring} 处）`);
  assert.ok(page.includes('fabricHiddenLines: tray.fabricHiddenLines,'), '要把清单传进渲染上下文');
});

test('保存：重复隐藏同一行不重复记，恢复时把该款号整份清掉', () => {
  const hideStart = page.indexOf('const hideFabricLine = ');
  const hideFn = page.slice(hideStart, hideStart + 700);
  assert.ok(hideFn.includes('if (prevHidden.includes(key)) return t;'), '同一行不重复记');
  const restoreStart = page.indexOf('const restoreFabricLines = ');
  const restoreFn = page.slice(restoreStart, restoreStart + 500);
  assert.ok(restoreFn.includes('delete next[pid]'), '恢复 = 清掉这个款号的隐藏清单');
});

test('0 米行判定：只认 0 米，不误伤 178米 / 10米', () => {
  const start = page.indexOf('function isZeroFabricLine(');
  assert.ok(start > 0, '要有 0 米行判定函数');
  const m = page.slice(start, start + 400).match(/return (\/.*?\/)\.test\(line\)/);
  assert.ok(m, `要能取到判定用的正则（当前片段：${page.slice(start, start + 200)}）`);
  const re = new RegExp(m[1].slice(1, m[1].lastIndexOf('/')));
  assert.equal(re.test('卡其灰0米面料仓'), true);
  assert.equal(re.test('咖棕0.0米面料仓'), true);
  assert.equal(re.test('藏蓝178米面料仓'), false);
  assert.equal(re.test('米白10米面料仓'), false);
});

test('一键隐藏 0 米：一次写完，不能逐个 upd 互相覆盖', () => {
  // upd 是 fn(本次渲染的 tray 快照)：连写两次时后一次会把前一次盖掉，
  // 表现就是「点了隐藏，只有一个款号生效 / 整个没反应」
  assert.ok(!page.includes('pids.forEach((p) => ctx.onClearFabric?.(p))'), '「隐藏面料信息」不能再逐个 pid 调 upd');
  assert.ok(page.includes('ctx.onClearFabricAll?.(pids)'), '整个坑位要一次性清掉');
  assert.ok(page.includes('ctx.onHideFabricLines?.(zeroLines)'), '0 米行要一次性写进隐藏清单');
  const start = page.indexOf('const hideFabricLines = ');
  const fn = page.slice(start, start + 900);
  assert.ok(fn.includes('for (const { pid, line } of items)'), '批量隐藏在一个 upd 里循环写入');
  assert.equal((fn.match(/upd\(/g) || []).length, 1, '批量隐藏只允许一次 upd');
});

test('导出：Excel 的面料情况同样不出现隐藏行', () => {
  const start = page.indexOf('function fabricCellText(');
  const fn = page.slice(start, start + 2600);
  assert.ok(fn.includes('applyHiddenFabricLines(base, t.fabricHiddenLines?.[pid])'), '导出要和界面同一口径');
});
