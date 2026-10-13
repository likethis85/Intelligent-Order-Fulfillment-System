-- =====================================================
-- BI 友好的三个 view（让 BI 直接 select 简单报表）
-- 适用于：BI 后台用 PostgreSQL 数据源直连此 supabase 实例
--   或 BI 后台创建 HTTP API / ETL 节点拉 api.marius.vip/rest/v1
-- =====================================================

-- ① 计划翻单量聚合（按 tray_id + pdt_code 聚合批次，BI 可直接 sum 报表）
-- 一个货盘同一款号会聚合成一行
CREATE OR REPLACE VIEW v_plan_summary AS
SELECT
  tray_id,
  pdt_code,
  -- 取直播日期的最大值（同一 tray 多个 sku 取同一天）
  MAX(live_date) AS live_date,
  -- 取登记时间的最大值
  MAX(registered_at) AS registered_at,
  -- 计划翻单总量（所有 SKU/批次 pieces 求和）
  SUM(pieces) AS total_pieces,
  -- 该款号下的所有 SKC 数组
  ARRAY_AGG(DISTINCT skc ORDER BY skc) FILTER (WHERE skc IS NOT NULL) AS skcs,
  -- 按 (skc, pieces, days) 还原所有批次
  JSONB_AGG(
    JSONB_BUILD_OBJECT(
      'skc', skc, 'pieces', pieces, 'days', days, 'color', color
    ) ORDER BY skc, days
  ) AS batches
FROM restock_planned
GROUP BY tray_id, pdt_code;

-- ② 不可翻单聚合（按 tray_id + pdt_code 汇总所有无面料 SKC 的原因）
CREATE OR REPLACE VIEW v_no_restock_summary AS
SELECT
  tray_id,
  pdt_code,
  ARRAY_AGG(DISTINCT skc ORDER BY skc) FILTER (WHERE skc IS NOT NULL) AS skcs,
  ARRAY_AGG(DISTINCT fabric ORDER BY fabric) FILTER (WHERE fabric IS NOT NULL) AS fabrics,
  ARRAY_AGG(DISTINCT color ORDER BY color) FILTER (WHERE color IS NOT NULL) AS colors,
  JSONB_AGG(
    JSONB_BUILD_OBJECT(
      'skc', skc, 'fabric', fabric, 'color', color, 'section', section, 'look_idx', look_idx
    ) ORDER BY skc
  ) AS items
FROM no_restock
GROUP BY tray_id, pdt_code;

-- ③ 款号明细聚合（按 tray 聚合款数 / 坑位数 / 价格合计）
CREATE OR REPLACE VIEW v_sku_summary AS
SELECT
  tray_id,
  COUNT(*) AS pid_count,                              -- 该货盘涉及的款号数（一坑位多 pid 会重复计入）
  COUNT(DISTINCT pdt_code) AS unique_pdt_count,      -- 不同款号去重数
  MAX(live_date) AS live_date,
  SUM(price * (COALESCE(planned_qty, 0) + COALESCE(ordered_qty, 0))) AS total_goods_value,
  SUM(COALESCE(stock_main, 0)) AS total_stock,
  SUM(COALESCE(in_transit, 0)) AS total_in_transit
FROM sku_detail
GROUP BY tray_id;

-- 启用 RLS：admin 通过 service_role 可以读这些 view
GRANT SELECT ON v_plan_summary TO service_role;
GRANT SELECT ON v_no_restock_summary TO service_role;
GRANT SELECT ON v_sku_summary TO service_role;

-- 如果 BI 用 anon key 直读，需要再加：
-- GRANT SELECT ON v_plan_summary TO anon;
-- 但当前 BI 直连会用 service_role（你给的），所以不需要这一步
