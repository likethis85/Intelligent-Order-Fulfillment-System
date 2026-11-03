// 翻单弹窗「已自动搜索并勾选」回归：一坑多款时每个款都必须出现在右侧编辑区。
//
// 线上症状：三个款号打开弹窗，左侧三个都打了勾，右侧只有其中一个；
// 手动取消再勾选那个款才会补上。
// 原因在 sales.html：自动勾选走的是普通 toggleGroup，第 2 个款一撞「共用面料」
// 就把提示弹窗顶出来并 return，款没进选区；pendingToggle 又只有一个槽，
// 后面的款一来就把前一个覆盖掉，于是连续丢款。
//
// 这里用静态断言锁住修复点（sales.html 是纯静态页，没有可注入的模块边界）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, '..', 'server', 'fabric-public', 'sales.html'), 'utf8');

test('sales.html: 自动勾选走 bulk 模式，不逐款弹共用面料提示', () => {
  assert.ok(
    html.includes('toggleGroup(code, true, { bulk: true })'),
    'URL pids 自动勾选必须传 bulk 标记，否则撞到共用面料就少一个款',
  );
  // bulk 分支必须直接加进选区，且排在共用面料判定之前
  const bulkIdx = html.indexOf('if (opts.bulk)');
  const sharedIdx = html.indexOf('detectSharedFabrics(selectedItems, pdtItems)');
  assert.ok(bulkIdx > 0, 'toggleGroup 必须有 bulk 分支');
  assert.ok(bulkIdx < sharedIdx, 'bulk 分支必须在共用面料弹窗之前，不能先 return');
});

test('sales.html: 重复勾选同一款号是幂等的', () => {
  assert.ok(
    html.includes('pdtItems.every(it => selectedFabrics[fabricItemId(it)])'),
    '已经全选过的款要直接返回，否则重复进入会把「自己和自己」判成共用面料',
  );
  // 选区 key 必须只有一处实现，避免幂等判断和实际写入用两套口径
  assert.equal(
    (html.match(/\$\{item\.pdt_code\}_\$\{item\.sku_code \|\| ''\}_\$\{item\.mt_code\}_\$\{item\.warehouse\}/g) || []).length,
    1,
    '面料行选区 key 只应保留在 fabricItemId() 里',
  );
});

test('sales.html: 自动勾选只有一处入口', () => {
  // 以前 init() 的有序循环和 loadFabrics() 里的 setTimeout 各勾一遍，同一个款被 toggle 两次
  assert.ok(!html.includes("if (cb && !cb.checked) toggleGroup(code, true)"),
    'loadFabrics 里的重复自动勾选必须删掉，统一由 init() 负责');
});

test('sales.html: 样衣 BOM 合并回调沿用同一套勾选参数', () => {
  assert.ok(html.includes('if (added) toggleGroup(pdtCode, true, opts);'),
    '合并回调丢了 bulk 标记会把弹窗又顶出来');
  assert.ok(/forceAddPdtCode\(pdtCode\)\.then\(\(\) => \{\s*toggleGroup\(pdtCode, true, opts\);/.test(html),
    '强制添加回调同理');
});
