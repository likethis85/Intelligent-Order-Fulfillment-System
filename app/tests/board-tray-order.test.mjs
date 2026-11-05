// 选款看板顶部的「目标货盘」按直播日期倒序，最新场次排最前，与货盘列表页同一口径。
// 只在渲染时排副本：trays 是 App 的 state，原地 sort 会触发多余的云端写盘。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.resolve(__dirname, '../src/sections/BoardPage.tsx'), 'utf8');

test('目标货盘按直播日期倒序渲染', () => {
  assert.ok(code.includes('() => [...trays].sort((a, b) => {'), '排序必须基于 trays 的副本');
  assert.ok(
    code.includes("const byDate = String(b.date || '').localeCompare(String(a.date || ''));"),
    'date 是 YYYY-MM-DD，字符串倒序即最新在最前',
  );
  assert.ok(
    code.includes("return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));"),
    '同一天多场用创建时间兜底，顺序稳定',
  );
  assert.ok(code.includes('{sortedTrays.map((t) => ('), 'chip 列表渲染排序后的副本');
  assert.ok(!code.includes('{trays.map((t) => ('), '不能直接渲染未排序的 trays');
});
