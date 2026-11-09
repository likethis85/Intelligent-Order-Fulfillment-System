// 库存单元格口径：占单小于 15 件视为噪音，不写「占单X」。
// 用户反馈：现货47 占单1、现货11 在途60 占单10 这类占单没有决策价值，显示出来反而干扰。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pageCode = fs.readFileSync(path.resolve(__dirname, '../src/sections/TraysPage.tsx'), 'utf8');
const { stockCellPartsList } = await import('../src/lib/stockLines.ts');

test('库存：占单低于 15 不显示', () => {
  assert.ok(pageCode.includes('const ORDER_BOOK_MIN_DISPLAY = 15;'), '阈值要有单一常量');
  // 页面单元格 + Excel 导出两处都把阈值传给同一个渲染函数，避免两处口径分叉
  const uses = pageCode.match(/stockCellPartsList\(entries\.map\(\(\[, v\]\) => v\), \{ orderBookMinDisplay: ORDER_BOOK_MIN_DISPLAY \}\)/g) || [];
  assert.equal(uses.length, 2, '占单有两处渲染（货盘单元格、Excel/打印文本）');
  const row = (v) => stockCellPartsList([{ eta: null, stock: 0, inTransit: 0, ...v }], { orderBookMinDisplay: 15 })[0];
  assert.deepEqual(
    row({ stock: 47, orderBook: 1 }),
    ['47'],
    '小占单既不该显示，也不该让这行平白多出「现货」两字',
  );
  assert.deepEqual(row({ stock: 11, inTransit: 60, orderBook: 10 }), ['现货11', '在途60']);
});
