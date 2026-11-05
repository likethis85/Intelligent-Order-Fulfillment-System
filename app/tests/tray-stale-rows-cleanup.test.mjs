// 货盘里删坑位 / 删款号 / 改翻单批次后，Supabase 里对应的旧行必须跟着删，
// 否则反复「加坑位再删坑位」会在三张表里堆积大量无用数据。
// 约束：只对账删除该 tray_id 的行；键集合没变时不做额外请求。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.resolve(__dirname, '../server/sales-persist.js'), 'utf8');

test('残留行对账按 tray_id 隔离，且按业务唯一键判断是否还有效', () => {
  assert.ok(code.includes('const lastKeysByTray = new Map();'), '需要进程内缓存判断键集合是否变化');
  assert.ok(
    code.includes("supabase.from(table).select(STALE_SELECT[table]).eq('tray_id', trayId)"),
    '只查当前 tray 的行',
  );
  assert.ok(
    code.includes('(data || []).filter((row) => !desiredKeys.has(keyOf(row)))'),
    '业务键不在当前 payload 里的行就是残留行',
  );
  assert.ok(code.includes("supabase.from(table).delete().in('id', ids)"), '按主键批量删除');
  assert.ok(code.includes('i += 100'), '主键列表分批，避免 URL 过长');
});

test('三张表的业务键与 ON_CONFLICT 一致', () => {
  assert.ok(code.includes('`${r.pdt_code}|${r.skc}|${r.pieces}|${r.days}`'), 'restock_planned 键含批次');
  assert.ok(code.includes('`${r.pdt_code}|${r.skc}`'), 'no_restock 键为 pid+skc');
  assert.ok(code.includes('`${r.section}|${r.look_idx}|${r.pdt_code}`'), 'sku_detail 键为 section+坑位+pid');
  for (const table of ['restock_planned', 'no_restock', 'sku_detail']) {
    assert.ok(code.includes(`  ${table}: 'id,`), `${table} 需要查出对账所需列`);
  }
});

test('只在键集合变化（或进程重启后首次保存）时对账，避免每次保存都扫表', () => {
  assert.ok(code.includes('const keySets = rowKeySets({ restockRows, noRestockRows, skuRows });'), '用本次 payload 算键集合');
  assert.ok(code.includes('if (lastKeysByTray.get(trayId) !== fingerprint) {'), '键集合没变就跳过');
  const start = code.indexOf('if (lastKeysByTray.get(trayId) !== fingerprint) {');
  const body = code.slice(start, code.indexOf('return { restock: restockN', start));
  for (const table of ['restock_planned', 'no_restock', 'sku_detail']) {
    assert.ok(body.includes(`deleteStaleRows(table, trayId, keySets[table])`) || body.includes("['restock_planned', 'no_restock', 'sku_detail']"), '三张表都要对账');
  }
});

test('对账失败只告警，不影响货盘保存', () => {
  assert.ok(code.includes('残留行查询失败 tray='));
  assert.ok(code.includes('残留行删除失败 tray='));
  const start = code.indexOf('async function deleteStaleRows');
  const body = code.slice(start, code.indexOf('export async function persistTray'));
  assert.ok(body.includes('return 0;'), '出错返回 0，不抛异常');
});
