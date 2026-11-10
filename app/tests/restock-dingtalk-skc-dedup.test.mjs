// 翻单同步回归：同一 SKC 有多条面料行时，只能按编辑区展示的主面料行写钉钉。
//
// 线上症状：ME14DF069 确认翻单后，钉钉「计划翻单量」同一个 SKC 出现两行：
//   ME14DF06901 252 / 35天（兄弟面料行里的旧计划）
//   ME14DF06901 57  / 35天（用户这次填的）
// 原因：generateText 组装 syncItems 时遍历了 selectedFabrics 的每一行，
// 而编辑区按 款号→SKC 只展示/编辑主面料那一行。
//
// 修复：按 pdt→skc 分组后用 getSkuInfoSegments 取出主面料行，再读它的 sales_batches。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pageCode = fs.readFileSync(path.resolve(__dirname, '../server/fabric-public/sales.html'), 'utf8');

const start = pageCode.indexOf('const syncItems = [];');
const end = pageCode.indexOf('[generateText] syncItems:');
const syncBlock = start >= 0 && end > start ? pageCode.slice(start, end) : '';

test('翻单同步：syncItems 按 款号→SKC 分组，只读主面料行', () => {
  assert.ok(syncBlock, '能找到 syncItems 组装代码');
  assert.ok(syncBlock.includes('syncGroups'), '先按 pdt/skc 分组');
  assert.ok(syncBlock.includes('getSkuInfoSegments'), '主面料行与编辑区/文案同口径');
  assert.ok(syncBlock.includes('source.sales_batches'), '只读主面料行的批次');
});

test('翻单同步：不能再逐条面料行收集批次（会把兄弟行的旧计划写进钉钉）', () => {
  assert.ok(!syncBlock.includes('let batches = Array.isArray(fab.sales_batches)'), '不允许直接读每一条 fabric 行的批次');
  assert.ok(!syncBlock.includes('_source: fab._source'), '同步项的来源必须是分组后的主面料行');
});
