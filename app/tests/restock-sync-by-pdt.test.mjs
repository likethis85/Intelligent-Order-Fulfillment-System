// 翻单同步回归：一个坑位里有多个款号时，只有真正填了翻单的款号才能拿到文案。
//
// 线上症状：坑位里两个款（西装 + 裤），只给西装填了「灰色 264件25天」，
// 同步后货盘的翻单周期里裤也显示「灰色 264件25天」；导出的 Excel 是对的。
// 原因在 TraysPage：sales.html 按款号分组的 text_by_pdt 只有西装那一组，
// 裤在 pids 里但没分到文案，旧代码用完整 text 兜底写进了裤的 override。
//
// 修复点：新路径（有 text_by_pdt）下，没分到文案的款号一律清空；
// 只有老版本 fabric_Q（完全没有 text_by_pdt）才允许用完整 text 兜底。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pageCode = fs.readFileSync(path.resolve(__dirname, '../src/sections/TraysPage.tsx'), 'utf8');

test('翻单同步：没分到文案的款号要被清空，不能拿别的款号的文案兜底', () => {
  assert.ok(
    pageCode.includes("for (const pid of pids) nextOverrides[pid] = textByPdt[pid] ?? '';"),
    'text_by_pdt 里没有的款号必须写空串（清空旧文案）',
  );
  assert.ok(
    !pageCode.includes('else if (text) nextOverrides[pid] = text;'),
    '不能再把完整 text 兜底给没分到组的款号',
  );
  // 老版本 fabric_Q 不送 text_by_pdt，仍要能同步
  assert.ok(
    /else if \(text\) \{\s*\/\/ 旧路径/.test(pageCode),
    '没有 text_by_pdt 的老版本仍按完整 text 写入所有款号',
  );
});
