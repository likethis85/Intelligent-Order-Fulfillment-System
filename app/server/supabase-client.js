// Supabase 客户端（自托管 api.marius.vip，复用 fabric_Q 的项目）
// 凭证从 server/.env 读：SUPABASE_URL / SUPABASE_KEY
// 任一缺失时返回 null，调用方必须短路返回 503「未配置」

import { createClient } from '@supabase/supabase-js';

const url = String(process.env.SUPABASE_URL || '').trim();
const key = String(process.env.SUPABASE_KEY || '').trim();

export const supabaseConfigured = Boolean(url && key);

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
