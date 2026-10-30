-- =====================================================
-- 修正 restock_planned / no_restock / sku_detail 的 RLS 与唯一约束
-- 在 Supabase（api.marius.vip）的 SQL Editor 里执行，可重复执行（幂等）
--
-- 背景（线上日志 21731 次失败）：
--   [sales-persist] no_restock upsert 失败: status=401 | code=42501
--   "new row violates row-level security policy for table ..."
--   三张表只给 service_role 开了策略，但后端用的是 anon key（SUPABASE_KEY），
--   所以写入 100% 被 RLS 拒绝；面料模块的 fabric_data 有 anon 策略，所以那边正常。
--
-- 两条路，二选一：
--   方案 A（推荐）：后端改用 service_role key —— 在 server/.env 增加
--                   SUPABASE_SERVICE_KEY=<service_role key> 后重启；anon 继续保持无权限。
--                   本文件第 1~4 步对方案 A 是全部需要执行的部分。
--   方案 B（不想加 key 时）：给 anon 开读写策略，见第 5 步（默认被注释掉）。
--                   注意：anon key 是公开的（/api/app-config 会下发给浏览器），
--                   Supabase 的 upsert 走 ON CONFLICT DO UPDATE，必须有 SELECT 策略才能命中已有行，
--                   所以开了写策略就必然连带开读权限 —— 等于任何拿到 anon key 的人都能读/改/删这三张表。
--
-- 已在 PostgreSQL 17 上验证（建表 → 本脚本 → 连跑两遍无报错）：
--   anon 只有 service_role 策略时 insert → 42501 "new row violates row-level security policy"（与线上一致）
--   service_role（BYPASSRLS）→ 写入成功
--   方案 B 只给 INSERT/UPDATE/DELETE 不加 SELECT 时，ON CONFLICT DO UPDATE 同样报 42501
--   方案 B 补上 SELECT 后 upsert 正常覆盖（重复保存不会多出行）
--
-- 前置：三张表的建表脚本见 scripts/sales-tables.sql
-- =====================================================

-- 0) 先看现状（执行前跑一次，执行后再跑一次对比）
select tablename, policyname, roles, cmd, qual, with_check
from pg_policies
where tablename in ('restock_planned', 'no_restock', 'sku_detail')
order by tablename, policyname;

-- 1) 保持 RLS 开启（幂等；Supabase 新建表默认也建议开）
alter table public.restock_planned enable row level security;
alter table public.no_restock enable row level security;
alter table public.sku_detail enable row level security;

-- 2) service_role 全权（Supabase 的 service_role 自带 BYPASSRLS，这里显式声明一遍，
--    自托管/自建 JWT 时也能保证行为一致）
drop policy if exists "service role full access on restock_planned" on public.restock_planned;
create policy "service role full access on restock_planned" on public.restock_planned
  for all to service_role using (true) with check (true);

drop policy if exists "service role full access on no_restock" on public.no_restock;
create policy "service role full access on no_restock" on public.no_restock
  for all to service_role using (true) with check (true);

drop policy if exists "service role full access on sku_detail" on public.sku_detail;
create policy "service role full access on sku_detail" on public.sku_detail
  for all to service_role using (true) with check (true);

-- 3) 业务唯一键：后端 upsert 现在显式带 on_conflict=...，必须存在对应唯一索引，
--    否则 PostgREST 会报 "there is no unique or exclusion constraint matching ..."
create unique index if not exists uniq_restock_planned
  on public.restock_planned (tray_id, pdt_code, skc, pieces, days);
create unique index if not exists uniq_no_restock
  on public.no_restock (tray_id, pdt_code, skc);
-- sku_detail 的 section 原来允许 NULL，而唯一约束对 NULL 不生效 → 同一坑位每次保存都会多插一行。
-- 先把历史 NULL 统一成空串，再建唯一索引（后端现在也固定写空串）
update public.sku_detail set section = '' where section is null;
alter table public.sku_detail alter column section set default '';
create unique index if not exists uniq_sku_detail
  on public.sku_detail (tray_id, section, look_idx, pdt_code);

-- 4) updated_at 自动刷新（原建表脚本只有 DEFAULT NOW()，update 不会变）
create or replace function public.sales_tables_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_restock_planned_touch on public.restock_planned;
create trigger trg_restock_planned_touch before update on public.restock_planned
  for each row execute function public.sales_tables_touch_updated_at();

drop trigger if exists trg_no_restock_touch on public.no_restock;
create trigger trg_no_restock_touch before update on public.no_restock
  for each row execute function public.sales_tables_touch_updated_at();

drop trigger if exists trg_sku_detail_touch on public.sku_detail;
create trigger trg_sku_detail_touch before update on public.sku_detail
  for each row execute function public.sales_tables_touch_updated_at();

-- 5) 【方案 B，可选】仍然用 anon key 写入时，给 anon 开策略
--    必须包含 SELECT：PostgREST 的 upsert 是 ON CONFLICT DO UPDATE，
--    要命中已有行就得看得见它，只给 INSERT/UPDATE 依然会 42501（已实测）。
--    代价：anon key 是公开的 → 任何人可读写这三张表的全部数据。
--    决定用方案 A（SUPABASE_SERVICE_KEY）就不要执行这一段。
--
-- create policy "anon read restock_planned" on public.restock_planned
--   for select to anon using (true);
-- create policy "anon write restock_planned" on public.restock_planned
--   for insert to anon with check (true);
-- create policy "anon update restock_planned" on public.restock_planned
--   for update to anon using (true) with check (true);
-- create policy "anon delete restock_planned" on public.restock_planned
--   for delete to anon using (true);
--
-- create policy "anon read no_restock" on public.no_restock
--   for select to anon using (true);
-- create policy "anon write no_restock" on public.no_restock
--   for insert to anon with check (true);
-- create policy "anon update no_restock" on public.no_restock
--   for update to anon using (true) with check (true);
-- create policy "anon delete no_restock" on public.no_restock
--   for delete to anon using (true);
--
-- create policy "anon read sku_detail" on public.sku_detail
--   for select to anon using (true);
-- create policy "anon write sku_detail" on public.sku_detail
--   for insert to anon with check (true);
-- create policy "anon update sku_detail" on public.sku_detail
--   for update to anon using (true) with check (true);
-- create policy "anon delete sku_detail" on public.sku_detail
--   for delete to anon using (true);

-- 6) 验证：三段都应看到对应的唯一索引 / 触发器 / 策略
select indexname, indexdef from pg_indexes
where tablename in ('restock_planned', 'no_restock', 'sku_detail')
order by tablename, indexname;

select tgname, tgrelid::regclass as tbl from pg_trigger
where tgname like 'trg_%_touch'
order by 2;

select tablename, policyname, roles, cmd from pg_policies
where tablename in ('restock_planned', 'no_restock', 'sku_detail')
order by tablename, policyname;
