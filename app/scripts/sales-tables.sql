-- =====================================================
-- 货盘导出三张表（计划翻单量 / 不可翻单 / 款号明细）
-- 用于把 TraysPage 导出 Excel 的三 sheet 持久化到 Supabase
-- 在 Supabase SQL Editor 中执行此脚本（一次性）
-- =====================================================

-- 1. 计划翻单量（每批次一行）
-- 主键：(tray_id, pdt_code, skc, pieces, days)
--   tray_id = 货盘 id（前端 nanoid 字符串）
--   pdt_code = 款号（小写存储）
--   skc = SKU 编码（小写；区分不同颜色的批次）
--   pieces / days 联合区分同款不同批
CREATE TABLE IF NOT EXISTS restock_planned (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tray_id VARCHAR(64) NOT NULL,
  pdt_code VARCHAR(50) NOT NULL,
  skc VARCHAR(50) NOT NULL,
  pieces INTEGER NOT NULL DEFAULT 0,
  days INTEGER NOT NULL DEFAULT 0,
  color VARCHAR(100),
  cycle VARCHAR(50),                              -- 翻单周期文本（如 "25天之内"）
  live_date DATE,                                -- 货盘直播日期
  registered_at TIMESTAMPTZ,                     -- 登记时间（tray.updatedAt ?? createdAt）
  source VARCHAR(20) DEFAULT 'sales-sync',       -- sales-sync（sales.html 同步）/ bi-fallback / tray-level
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tray_id, pdt_code, skc, pieces, days)
);
CREATE INDEX IF NOT EXISTS idx_restock_planned_tray ON restock_planned(tray_id);
CREATE INDEX IF NOT EXISTS idx_restock_planned_pdt ON restock_planned(pdt_code);

-- 2. 不可翻单（每个 SKC 一行）
CREATE TABLE IF NOT EXISTS no_restock (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tray_id VARCHAR(64) NOT NULL,
  pdt_code VARCHAR(50) NOT NULL,
  skc VARCHAR(50) NOT NULL,
  color VARCHAR(100),
  fabric VARCHAR(500),                            -- 面料信息（fabric_no_restock 文案）
  section VARCHAR(50),                            -- 版块（主推 / 搭配 / ...）
  look_idx INTEGER,                               -- 坑位 1-based
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tray_id, pdt_code, skc)
);
CREATE INDEX IF NOT EXISTS idx_no_restock_tray ON no_restock(tray_id);

-- 3. 款号明细（每坑位每款一行；导出 Excel 「一行一坑位」口径）
CREATE TABLE IF NOT EXISTS sku_detail (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tray_id VARCHAR(64) NOT NULL,
  pdt_code VARCHAR(50) NOT NULL,
  skc VARCHAR(50),                                -- 该坑位该款的 SKC（无则空）
  section VARCHAR(50),
  look_idx INTEGER,                               -- 坑位 1-based
  name VARCHAR(255),
  color VARCHAR(200),
  price NUMERIC(10,2),
  stock_main INTEGER,
  in_transit INTEGER,
  restock VARCHAR(50),
  planned_qty INTEGER,
  ordered_qty INTEGER,
  goods_value NUMERIC(12,2),
  live_date DATE,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tray_id, section, look_idx, pdt_code)
);
CREATE INDEX IF NOT EXISTS idx_sku_detail_tray ON sku_detail(tray_id);
CREATE INDEX IF NOT EXISTS idx_sku_detail_pdt ON sku_detail(pdt_code);

-- =====================================================
-- RLS：service_role 绕过；anon 仅授权读（暂不开放读，因为不在前端直接用）
-- =====================================================
ALTER TABLE restock_planned ENABLE ROW LEVEL SECURITY;
ALTER TABLE no_restock ENABLE ROW LEVEL SECURITY;
ALTER TABLE sku_detail ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service role full access on restock_planned" ON restock_planned;
CREATE POLICY "service role full access on restock_planned" ON restock_planned
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service role full access on no_restock" ON no_restock;
CREATE POLICY "service role full access on no_restock" ON no_restock
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service role full access on sku_detail" ON sku_detail;
CREATE POLICY "service role full access on sku_detail" ON sku_detail
  FOR ALL TO service_role USING (true) WITH CHECK (true);
