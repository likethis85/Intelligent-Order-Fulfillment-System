// 面料查询结果表的「成衣颜色 / 物料颜色」两列以前只有 52–66px，
// 长颜色名（深灰千鸟、米白/浅灰）被 text-overflow: ellipsis 截成省略号，
// 看起来就是「面料颜色显示不全」。现在两列按内容放宽，并挂 title 兜底看全称。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.resolve(__dirname, '../server/fabric-public/index.html'), 'utf8');

// 取某列的宽度规则（桌面端 th:nth-child(N) / td:nth-child(N)）
function columnRule(n) {
  const m = html.match(new RegExp(`th:nth-child\\(${n}\\), td:nth-child\\(${n}\\) \\{([^}]*)\\}`));
  return m ? m[1] : '';
}
function widthOf(rule, name) {
  const m = rule.match(new RegExp(`${name}:\\s*(\\d+)px`));
  return m ? Number(m[1]) : 0;
}

test('成衣颜色列放得下长颜色名', () => {
  const rule = columnRule(3);
  assert.ok(rule, '第 3 列（成衣颜色）有宽度规则');
  assert.ok(widthOf(rule, 'max-width') >= 110, `成衣颜色列上限 ${widthOf(rule, 'max-width')}px 太窄，会在 66px 处截断`);
  assert.ok(widthOf(rule, 'min-width') >= 58, '最小宽度别比表头还窄');
});

test('物料颜色列（面料颜色）放得下长颜色名', () => {
  const rule = columnRule(9);
  assert.ok(rule, '第 9 列（物料颜色）有宽度规则');
  assert.ok(widthOf(rule, 'max-width') >= 130, `物料颜色列上限 ${widthOf(rule, 'max-width')}px 不够，颜色会被截断`);
  assert.ok(widthOf(rule, 'min-width') >= 58, '最小宽度别比表头还窄');
});

test('手机上成衣颜色列也放宽', () => {
  const m = html.match(/成衣颜色列宽（手机上也要能看清完整颜色，不再截断）[\s\S]{0,220}?max-width:\s*(\d+)px/);
  assert.ok(m, '移动端成衣颜色有独立的宽度规则');
  assert.ok(Number(m[1]) >= 100, `移动端上限 ${m?.[1]}px 仍然会截断`);
});

test('颜色格子挂 title，万一还被截断也能悬停看全称', () => {
  assert.ok(
    html.includes('<td class="freeze-col" title="${showDash ? \'\' : String(item.pdtColorName || \'\').replace(/"/g, \'&quot;\')}">'),
    '成衣颜色格子带 title',
  );
  assert.ok(
    html.includes('<td title="${showDash ? \'\' : String(item.colorName || \'\').replace(/"/g, \'&quot;\')}">'),
    '物料颜色格子带 title',
  );
});
