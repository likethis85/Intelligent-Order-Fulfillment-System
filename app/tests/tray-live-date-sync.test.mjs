// 改货盘直播日期后，Supabase 里该货盘的历史行（已移出货盘的残留行）也要同步新日期，
// 否则 BI 里同一个 tray_id 会同时出现新旧两个 live_date。
// 只在日期变化时才做统一刷新，避免每次保存都多打 2 个 UPDATE；进程重启后首次保存也会刷一次。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.resolve(__dirname, '../server/sales-persist.js'), 'utf8');

test('直播日期变化检测按 tray_id 记录上一次写入值', () => {
  assert.ok(code.includes('const lastLiveDateByTray = new Map();'), '需要进程内缓存');
  assert.ok(code.includes('const prevLiveDate = lastLiveDateByTray.get(trayId);'), '取出上次日期');
  assert.ok(code.includes('lastLiveDateByTray.set(trayId, liveDate);'), '写入本次日期');
  assert.ok(code.includes('const liveDateChanged = prevLiveDate !== liveDate;'), '按值比较判断是否变更');
});

test('日期变化时刷新 restock_planned 和 sku_detail 的全部行', () => {
  const start = code.indexOf('if (liveDateChanged) {');
  assert.ok(start > 0, '需要 dateChanged 分支');
  const body = code.slice(start, code.indexOf('if (deletedAt) {', start));
  assert.ok(body.includes("['restock_planned', 'sku_detail']"), '只有这两张表有 live_date 列');
  assert.ok(body.includes(".update({ live_date: liveDate }).eq('tray_id', trayId)"), '按 tray_id 统一刷新');
});
