// 货盘页面一个版块超过 8 个坑位会换到下一块（band）继续排；
// 导出 Excel 必须同样分块，否则第 9 个坑位起（备用版块常有二三十个坑位）的款号、售价、
// 库存等信息会整块丢失——看起来就是「最后换行那几块的款号信息没了」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.resolve(__dirname, '../src/sections/TraysPage.tsx'), 'utf8');

test('导出按 8 个坑位分块，延续块不再丢坑位', () => {
  assert.ok(code.includes('const lookBands: (typeof s.looks)[] = [];'), '需要把所有坑位切成 band');
  assert.ok(code.includes('for (let i = 0; i < s.looks.length; i += SLOT_DATA_COLS)'), '每 8 个坑位一块');
  assert.ok(code.includes('if (lookBands.length === 0) lookBands.push([]);'), '空版块仍保留表头与空行');
  assert.ok(code.includes('const band = lookBands[bi];'), '逐块输出');
  assert.ok(code.includes('const look = band[i];'), '数据列取当前 band 的坑位，而不是固定取 s.looks[i]');
});

test('续块标题带（续），避免多块同名分不清', () => {
  assert.ok(code.includes('cell.value = bi === 0 ? s.label : `${s.label}（续）`;'));
});
