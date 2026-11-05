// 按货盘布局导出 Excel 时，行高不能写死：一坑多款 / 多色库存的单元格是多行文本，
// 固定行高会把最后几行裁掉（最明显的是「款号」行最后一个款号看不见）。
// 这里锁住：导出行统一走 fitExcelRowHeight 按内容撑高，且支持 richText 与显式换行。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.resolve(__dirname, '../src/sections/TraysPage.tsx'), 'utf8');

test('导出布局的每一行都按内容自适应行高', () => {
  assert.ok(code.includes('function fitExcelRowHeight(row: ExcelJS.Row, minHeight: number): void {'), '需要行高估算函数');
  assert.ok(code.includes('fitExcelRowHeight(r, f.height ?? 35);'), '主推/搭配每个字段行都要调用');
  assert.ok(code.includes('row.height = Math.min(409, height);'), '尊重 Excel 409 磅的行高上限');
});

test('行高估算覆盖多行文本与富文本单元格', () => {
  assert.ok(code.includes('function cellPlainText(value: ExcelJS.CellValue): string {'), '单元格取值要兼容类型');
  assert.ok(code.includes("'richText' in value"), '商品名称是 richText，必须拼出全文');
  assert.ok(code.includes("text.split('\\n')"), '款号/售价/库存用 \\n 分行，要按显式换行计数');
  assert.ok(code.includes('excelTextWidth(seg)'), '中文按双宽估算折行，避免少算');
  assert.ok(code.includes('cell.font?.size'), '字号越大行越高（款号 14 号、标签 20 号）');
});

test('行高估算不会再回退到固定高度赋值', () => {
  assert.ok(!code.includes('r.height = f.height ?? 35;'), '旧的固定行高写法要去掉');
});
