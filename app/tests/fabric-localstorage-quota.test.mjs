// 面料查询页 localStorage 配额：之前「读出来合并再写回」会把历史款号越攒越多，
// 攒满 5MB 后 setItem 抛 QuotaExceededError，整个查询直接断掉。
// 现在统一走 saveFabricData：按体积逐级瘦身，存不下也不报错（数据还在服务器上）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.resolve(__dirname, '../server/fabric-public/index.html'), 'utf8');

// 只统计直接写补充数据的调用（helper 内部那一次除外）
const directWrites = [...html.matchAll(/localStorage\.setItem\(FABRIC_DATA_KEY/g)].length;

test('补充数据统一走 saveFabricData，不再裸写 localStorage', () => {
  assert.ok(html.includes('function saveFabricData(data, keepKeys)'), '有安全写入函数');
  assert.equal(directWrites, 2, '只有 helper 和瘦身函数里各写一次，业务代码不再直接 setItem');
  assert.ok(html.includes('saveFabricData(data, currentRowKeys());'), '编辑格子后的保存走安全写入');
  assert.ok(html.includes('saveFabricData(saved, currentRowKeys());'), '合并写回走安全写入');
  assert.ok(!html.includes('localStorage.setItem(FABRIC_DATA_KEY, JSON.stringify(saved))'), '旧的合并裸写已清掉');
  assert.ok(!html.includes('localStorage.setItem(FABRIC_DATA_KEY, JSON.stringify(data))'), '旧的整份裸写已清掉');
});

test('配额不够时逐级瘦身：去空行 → 只留本次查询 → 放弃本地缓存', () => {
  assert.ok(html.includes('function isEmptyExtra(extra)'), '空行判定');
  assert.ok(html.includes('function currentRowKeys()'), '本次查询涉及的行 key');
  assert.ok(html.includes('const nonEmpty = helpers.pruneEmpty(data);'), '先去掉没有内容的行');
  assert.ok(html.includes('if (keepKeys.has(k)) current[k] = v;'), '再只留本次查询的行');
  assert.ok(html.includes('console.warn(\'[面料查询] 本地存储空间不足'), '全存不下时只告警，不打断查询');
  assert.ok(html.includes('return false;'), '写失败有明确的返回值');
});

test('空白格不再写进 localStorage', () => {
  assert.ok(
    html.includes('if (item._extra && !isEmptyExtra(item._extra)) {'),
    '一次查几百个款号时，空值行占的体积比真正填过的还大',
  );
});

test('读取加内存缓存，避免每行都整份 JSON.parse', () => {
  assert.ok(html.includes('let savedDataCache = null;'), '有缓存变量');
  assert.ok(html.includes('if (savedDataCache) return savedDataCache;'), '命中缓存直接返回');
  assert.ok(html.includes("if (!e.key || e.key === FABRIC_DATA_KEY) savedDataCache = null;"), '其它标签页改过就失效');
  assert.ok(html.includes('savedDataCache = attempt;'), '写成功后同步缓存');
});

test('老版本攒下的超大 blob 在页面加载时先瘦身', () => {
  assert.ok(html.includes('function shrinkSavedData()'), '有瘦身函数');
  assert.ok(html.includes('const SAVED_DATA_MAX_ROWS = 2000;'), '最多留 2000 行');
  assert.ok(html.includes('const SAVED_DATA_MAX_CHARS = 1000000;'), '超过约 2MB 才触发');
  assert.ok(html.includes('entries.slice(-SAVED_DATA_MAX_ROWS)'), '只留最近写入的部分');
  const initAt = html.indexOf('function initPage()');
  const shrinkCallAt = html.indexOf('shrinkSavedData();', initAt);
  const loadConfigAt = html.indexOf('loadConfig();', initAt);
  assert.ok(shrinkCallAt > initAt && shrinkCallAt < loadConfigAt, '加载页面时先瘦身再拉配置');
});

test('同域的小数据（采购覆盖、无面料标记）写不进也不会报错', () => {
  const poSave = html.slice(html.indexOf('function savePoOverrides()'), html.indexOf('function savePoOverrides()') + 400);
  assert.ok(poSave.includes('try {') && poSave.includes("console.warn('[面料查询] 采购明细覆盖数据存不下"), '采购覆盖写入有兜底');

  const noRestockSave = html.slice(
    html.indexOf('function saveNoRestockKeys()'),
    html.indexOf('function saveNoRestockKeys()') + 400,
  );
  assert.ok(noRestockSave.includes('try {') && noRestockSave.includes('无面料不翻单标记存不下'), '无面料标记写入有兜底');
});
