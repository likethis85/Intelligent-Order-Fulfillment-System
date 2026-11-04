// 库存单元格口径：占单小于 15 件视为噪音，不写「占单X」。
// 用户反馈：现货47 占单1、现货11 在途60 占单10 这类占单没有决策价值，显示出来反而干扰。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pageCode = fs.readFileSync(path.resolve(__dirname, '../src/sections/TraysPage.tsx'), 'utf8');

test('库存：占单低于 15 不显示', () => {
  assert.ok(pageCode.includes('const ORDER_BOOK_MIN_DISPLAY = 15;'), '阈值要有单一常量');
  // 页面单元格 + Excel 导出两处都必须用同一个阈值
  const pushes = pageCode.match(/if \(v\.orderBook [^)]*\) parts\.push\(`占单\$\{v\.orderBook\}`\);/g) || [];
  assert.equal(pushes.length, 2, '占单有两处渲染（货盘单元格、Excel/打印文本）');
  for (const p of pushes) {
    assert.ok(p.includes('v.orderBook >= ORDER_BOOK_MIN_DISPLAY'), `占单显示必须按阈值过滤：${p}`);
  }
  assert.ok(!pageCode.includes('if (v.orderBook > 0) parts.push(`占单${v.orderBook}`);'), '不能再无条件显示占单');
});
