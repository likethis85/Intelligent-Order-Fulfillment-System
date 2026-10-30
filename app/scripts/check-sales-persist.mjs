// 自检：往 Supabase 的三张表写一条测试 tray，再删掉。
// 用来确认 RLS / 唯一索引 / on_conflict 这套东西在线上真的通了。
//
//   node scripts/check-sales-persist.mjs
//
// 读 server/.env（SUPABASE_URL / SUPABASE_KEY / SUPABASE_SERVICE_KEY）。
// 用固定 tray_id=__rls_selftest__，跑完会自己删除，不留数据。

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envFile = join(__dirname, '..', 'server', '.env');
if (existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(envFile); } catch { /* 用外部环境变量 */ }
}

const { persistTray, removeTray } = await import('../server/sales-persist.js');
const { supabaseConfigured, usingServiceKey } = await import('../server/supabase-client.js');

const TRAY_ID = '__rls_selftest__';

if (!supabaseConfigured) {
  console.error('✗ Supabase 未配置：server/.env 缺 SUPABASE_URL / SUPABASE_KEY');
  process.exit(1);
}
console.log(`Supabase 已配置，写库使用 ${usingServiceKey ? 'service_role key（可绕过 RLS）' : 'anon key（受 RLS 约束）'}`);

const tray = {
  id: TRAY_ID,
  date: '2026-01-01',
  updatedAt: new Date().toISOString(),
  sections: [{ label: '自检', looks: [{ pids: ['__selftest_pid__'] }] }],
  plannedRestockItems: [{ pdt: '__selftest_pid__', skc: '__selftest_skc__', pieces: 1, days: 1 }],
  sampleRestockItems: [],
  noRestockItems: [{ pid: '__selftest_pid__', skc: '__selftest_skc__', color: '自检' }],
};

const result = await persistTray(tray);
console.log('写入结果:', result);

let ok = !result.skipped && result.sku > 0;
if (!ok) {
  console.error('✗ 写入失败' + (result.skipped ? `（skipped=${result.skipped}）` : ''));
  console.error('  若日志是 42501：服务端没有 service_role key，或没执行 scripts/sales-tables-rls.sql');
}

await removeTray(TRAY_ID);
console.log('已清理测试数据');
if (!ok) process.exit(1);
console.log('✓ 三张表写入 + 清理都正常');
