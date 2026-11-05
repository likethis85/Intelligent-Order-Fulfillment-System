// 回收站删除标记：货盘进回收站后，Supabase 三张表要能看出它已删除，BI 统计时排除。
// 语义：deleted_at = 进回收站的时间；恢复写回 NULL；彻底删除仍由 removeTray 删行。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const persistCode = fs.readFileSync(path.resolve(__dirname, '../server/sales-persist.js'), 'utf8');
const tablesSql = fs.readFileSync(path.resolve(__dirname, '../scripts/sales-tables.sql'), 'utf8');
const viewsSql = fs.readFileSync(path.resolve(__dirname, '../scripts/bi-views.sql'), 'utf8');

test('sales-persist：三张表都写入 trashedAt 作为 deleted_at', () => {
  assert.ok(persistCode.includes('const deletedAt = tray.trashedAt || null;'), '标记来源必须是 tray.trashedAt');
  const writes = persistCode.match(/deleted_at: deletedAt,/g) || [];
  // restock_planned 1 处 + no_restock 1 处 + sku_detail 2 处（products.json 命中/未命中两个分支）
  assert.equal(writes.length, 4, '每张表写入的每一行都要带 deleted_at');
});

test('sales-persist：迁移未执行时降级写入，不影响货盘保存', () => {
  assert.ok(persistCode.includes("String(error.message || '').includes('deleted_at')"), '识别缺列错误');
  assert.ok(persistCode.includes('const { deleted_at: _omit, ...rest } = row;'), '去掉 deleted_at 后重试一次');
  assert.ok(persistCode.includes('warnDeletedAtMissing(table)'), '只提示一次，不刷日志');
});

test('sales-persist：回收站货盘按 tray_id 统一打标，覆盖历史残留行', () => {
  assert.ok(
    persistCode.includes('supabase.from(table).update({ deleted_at: deletedAt }).eq(\'tray_id\', trayId)'),
    'upsert 之外的旧行（改过坑位/SKC）也要标记',
  );
  // 只在回收站状态才做统一 UPDATE，正常货盘每次保存不额外打 3 个请求
  assert.ok(persistCode.includes('if (deletedAt) {'), '正常货盘不做多余的统一 UPDATE');
});

test('建表脚本：三张表都有 deleted_at，且老库可幂等补列', () => {
  for (const table of ['restock_planned', 'no_restock', 'sku_detail']) {
    assert.ok(
      tablesSql.includes(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;`),
      `${table} 需要幂等 ALTER`,
    );
  }
  const cols = tablesSql.match(/deleted_at TIMESTAMPTZ,?\s+--/g) || [];
  assert.ok(cols.length >= 3, 'CREATE TABLE 里也要有 deleted_at 列');
});

test('BI 视图：三个 view 都过滤 deleted_at IS NULL', () => {
  const filters = viewsSql.match(/WHERE deleted_at IS NULL/g) || [];
  assert.equal(filters.length, 3, 'v_plan_summary / v_no_restock_summary / v_sku_summary 都要过滤');
});
