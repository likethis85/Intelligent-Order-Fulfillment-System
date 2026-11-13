// 剩余库存推荐整页「暂无」的回归：BI 冷缓存时后端 503，前端一次失败就永久空 map。
// 现在后端先用过期磁盘缓存顶着、后台只跑一轮刷新；前端失败/空结果自动重试并区分状态。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const client = fs.readFileSync(path.resolve(__dirname, '../server/remaining-inventory-client.js'), 'utf8');
const board = fs.readFileSync(path.resolve(__dirname, '../src/sections/BoardPage.tsx'), 'utf8');
const tray = fs.readFileSync(path.resolve(__dirname, '../src/sections/TraysPage.tsx'), 'utf8');

test('磁盘缓存过期也先用它顶着，不再直接丢弃', () => {
  const fn = client.slice(client.indexOf('async function loadFromDisk'), client.indexOf('function isDiskFresh'));
  assert.ok(!fn.includes('DISK_TTL_MS'), '读盘时不再做 TTL 判断');
  assert.ok(fn.includes('j.groups.length > 0'), '有数据的缓存才返回');
  assert.ok(client.includes('function isDiskFresh'), '新鲜度单独判断');
});

test('过期缓存不阻塞请求：先返回旧数据，后台刷新', () => {
  const fn = client.slice(client.indexOf('async function loadAll'), client.indexOf('export async function listRemainingInventory'));
  assert.ok(fn.includes('refreshFromBi().catch'), '后台刷新失败不影响这次响应');
  assert.ok(!/await refreshFromBi\(\),\s*$/.test(fn), '过期分支不 await 刷新');
  assert.ok(fn.includes('if (!isDiskFresh(fromDisk.at))'), '只有过期才触发刷新');
});

test('同一时刻只跑一轮 BI 分区拉取（并发请求共用同一个 promise）', () => {
  assert.ok(client.includes('let refreshing = null'), '模块级 in-flight 标记');
  assert.ok(client.includes('if (refreshing) return refreshing'), '并发请求复用');
  assert.ok(client.includes('.finally(() => {\n    refreshing = null;'), '结束后释放');
  assert.ok(client.includes('timeoutMs: 120_000'), '单分区超时放宽到 120s');
});

test('看板：加载失败/空结果自动重试，卡片区分加载中、失败、真无数据', () => {
  assert.ok(board.includes("useState<'loading' | 'ready' | 'failed'>('loading')"), '三态');
  assert.ok(board.includes('if (tries < 4)'), '最多重试');
  assert.ok(board.includes('setTimeout(load, tries * 15000)'), '退避重试');
  assert.ok(board.includes('剩余库存推荐加载中…'), '加载中文案');
  assert.ok(board.includes('剩余库存推荐加载失败 · 点此重试'), '失败可手动重试');
  assert.ok(board.includes('暂无剩余库存推荐 · BI 卡片未覆盖此款'), '真正无数据时才是这句');
});

test('货盘页同样重试，不再一次失败就空手', () => {
  const block = tray.slice(tray.indexOf('预估剩余库存（BI 剩余库存卡片'));
  assert.ok(block.includes('const load = async () =>'), '封装重试');
  assert.ok(block.includes('timer = setTimeout(load, tries * 15000)'), '退避重试');
});
