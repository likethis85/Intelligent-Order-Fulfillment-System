// 坑位选款的直接搜索要支持 款号 / 名称 / 小名（Product.sub，BI 的 smName 小名）。
// 只搜款号和名称时，用户按页面上显示的小名找不到款。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.resolve(__dirname, '../src/sections/TraysPage.tsx'), 'utf8');

test('候选池过滤同时匹配 款号 / 名称 / 小名', () => {
  const start = code.indexOf('款号 / 名称 / 小名搜索');
  assert.ok(start > 0, '搜索逻辑注释要说明支持小名');
  const body = code.slice(start, code.indexOf('// AI 指令（叠加在款号搜索之上）', start));
  assert.ok(body.includes('p.id.toUpperCase().includes(t)'), '款号匹配保留');
  assert.ok(body.includes('p.name.toLowerCase().includes(t)'), '名称匹配保留');
  assert.ok(body.includes("String(p.sub || '').toLowerCase().includes(t)"), '小名（sub）也要能搜到');
});

test('样衣兜底与 AI 指令兜底的款号搜索也带上小名', () => {
  const occurrences = code.match(/String\(p\.sub \|\| ''\)\.toLowerCase\(\)\.includes/g) || [];
  assert.ok(occurrences.length >= 3, '候选池 / 样衣兜底 / AI 指令兜底 三处都要匹配小名');
});

test('搜索框文案提示支持小名', () => {
  assert.ok(code.includes('或按款号 / 名称 / 小名直接搜'), '标题要写清楚');
  assert.ok(code.includes('如 ME01DW020 / 羊毛大衣 / 机场大衣（空格分隔可批量筛）'), '示例换成含小名的说法');
});
