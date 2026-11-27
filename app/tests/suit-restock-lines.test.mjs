// 套装坑位（针织裤 + 开衫）的翻单周期：两个款号各回一份同样的「颜色 件数 天数」记录，
// 用户要求合并成一份，只显示颜色 + 翻单信息，不带商品前缀。
import test from 'node:test';
import assert from 'node:assert/strict';
import { suitRestockLines } from '../src/lib/restockLines.ts';

const pants = {
  id: 'me01fw001',
  restock: '沙丘驼 200件25天\n蜜金棕 200件25天\n深藏青 200件25天\n大象灰 200件25天',
};
const cardigan = {
  id: 'me02fw002',
  restock: '沙丘驼 200件25天\n蜜金棕 200件25天\n深藏青 200件25天\n大象灰 200件25天',
};

test('套装：两件同色同量 → 合并成 4 条，不带前缀', () => {
  const lines = suitRestockLines([pants, cardigan]);
  assert.deepEqual(lines, ['沙丘驼 200件25天', '蜜金棕 200件25天', '深藏青 200件25天', '大象灰 200件25天']);
});

test('套装：颜色有差异时保留各自的记录，重复的只留一条', () => {
  const lines = suitRestockLines([
    { id: 'a', restock: '沙丘驼 200件25天\n黑色 100件20天' },
    { id: 'b', restock: '沙丘驼 200件25天\n灰色 150件20天' },
  ]);
  assert.deepEqual(lines, ['沙丘驼 200件25天', '黑色 100件20天', '灰色 150件20天']);
});

test('套装：手动改过的翻单文案优先于原值', () => {
  const lines = suitRestockLines(
    [{ id: 'a', restock: '沙丘驼 200件25天' }, { id: 'b', restock: '沙丘驼 200件25天' }],
    { a: '沙丘驼 260件30天' },
  );
  assert.deepEqual(lines, ['沙丘驼 260件30天', '沙丘驼 200件25天']);
});

test('套装：空行和空文案不出行', () => {
  assert.deepEqual(suitRestockLines([{ id: 'a', restock: '' }, { id: 'b', restock: '  \n黑色 10件5天\n' }]), ['黑色 10件5天']);
  assert.deepEqual(suitRestockLines([]), []);
});
