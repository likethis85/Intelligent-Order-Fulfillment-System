// Supabase 客户端（自托管 api.marius.vip，复用 fabric_Q 的项目）
// 凭证从 server/.env 读：SUPABASE_URL / SUPABASE_KEY（anon）/ SUPABASE_SERVICE_KEY（可选，服务端专用）
// 任一缺失时返回 null，调用方必须短路返回 503「未配置」
//
// 为什么分两把 key：
//   SUPABASE_KEY 是 anon key，/api/app-config 会把它下发给浏览器（fabric-public 页面用它初始化
//   Supabase Auth），所以它必须是公开的 anon key。
//   服务端的写库（sales-persist / fabric 等）需要绕过 RLS，用 SUPABASE_SERVICE_KEY；
//   service_role key 绝不能下发给浏览器，也绝不能填进 SUPABASE_KEY。

import { createClient } from '@supabase/supabase-js';

const url = String(process.env.SUPABASE_URL || '').trim();
const anonKey = String(process.env.SUPABASE_KEY || '').trim();
const serviceKey = String(process.env.SUPABASE_SERVICE_KEY || '').trim();
const key = serviceKey || anonKey;

export const supabaseConfigured = Boolean(url && key);

// 服务端是否真的在用能绕过 RLS 的 key（没配 SUPABASE_SERVICE_KEY 就是 false）
export const usingServiceKey = Boolean(url && serviceKey);

// 未配置时为 null，调用方须短路并提示用户「在 .env 填 SUPABASE_URL / SUPABASE_KEY」
export const supabase = supabaseConfigured
  ? createClient(url, key, { global: { fetch } })
  : null;

/**
 * 若未配置，返回 false；上层应跳过 supabase 写但继续本地写文件
 *   true  → 真实写入
 *   false → 走短路（日志 warn 一次）
 */
export function isSupabaseReady() {
  if (!supabaseConfigured) {
    console.warn('[supabase] 未配置 SUPABASE_URL / SUPABASE_KEY，跳过持久化写入。检查 server/.env');
    return false;
  }
  return true;
}

/**
 * 写库被 RLS 拒绝时的一次性提示（42501 = insufficient_privilege / RLS violation）
 * 只在日志里点明原因，不改变调用方行为
 */
let rlsHinted = false;
export function warnIfRlsDenied(table, error) {
  if (rlsHinted) return;
  if (error?.code !== '42501') return;
  rlsHinted = true;
  console.warn(
    `[supabase] 写 ${table} 触发 RLS 拒绝（42501）。` +
      '服务端需要绕过 RLS 的 key：在 server/.env 增加 SUPABASE_SERVICE_KEY=<service_role key> 后重启；' +
      '或在 Supabase 执行 scripts/sales-tables-rls.sql 里的「方案 B」给 anon 开写策略。',
  );
}
