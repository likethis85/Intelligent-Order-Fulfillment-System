// 线上症状：货盘打开「翻单计划」时，坑位里有领猫查不到的款（如 ME21DF030 / 92211111），
// 「查不到此款或该款没有SKU数据」弹窗无限循环，只能强杀页面。
//
// 原因：toggleGroup 发现该款没有面料记录 → forceAddPdtCode → 失败 alert → 返回后
// toggleGroup 又跑一遍 → 又强制添加 …… 失败状态没有被记住。
// 修复：失败过的款号记进 forceAddFailed，勾选流程不再重试；失败时也不再递归 toggleGroup。
//
// sales.html / sales-mobile.html 是纯静态页，用静态断言锁住修复点。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const files = ['sales.html', 'sales-mobile.html'].map((name) => ({
  name,
  html: fs.readFileSync(path.join(__dirname, '..', 'server', 'fabric-public', name), 'utf8'),
}));

for (const { name, html } of files) {
  test(`${name}: 强制添加失败要记住，不能反复重试`, () => {
    assert.ok(html.includes('const forceAddFailed = new Set();'), '要有失败款号的集合');
    const failIdx = html.indexOf('forceAddFailed.add(code);');
    assert.ok(failIdx > 0, '失败分支要记录款号');
    assert.ok(html.includes('forceAddFailed.delete(code);'), '成功后再把失败标记清掉（重新添加可恢复）');
    const toggleStart = html.indexOf('if (pdtItems.length === 0');
    const guard = html.slice(toggleStart, toggleStart + 260);
    assert.ok(guard.includes('!forceAddFailed.has(pdtCode)'), '失败过的款号不再自动强制添加');
    assert.ok(guard.includes('if (ok)'), '强制添加失败时不再递归 toggleGroup（否则就是死循环）');
  });
}
