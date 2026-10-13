// 天气选款规则（从 weather 项目移植：app/server/data/weather-recommendation-rules.json）
// 包含：温度档分类、降雨叠加、节气叠加、品牌映射
// 可在 ConfigPage 改后保存（覆盖整个 JSON；schema 与 weather 项目保持一致）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_FILE = path.join(__dirname, 'data', 'weather-recommendation-rules.json');

export const DEFAULT_WEATHER_RULES = {
  brand_mapping: { brands: { marius: { sku_prefixes: [] } }, default_brand: 'marius' },
  product_role_thresholds: {
    profit_retail_to_cost_ratio_min: 2.8,
    traffic_min_net_sales_qty: 1000,
    traffic_min_main_warehouse_stock: 200,
    traffic_min_conversion_rate: 0.05,
    traffic_price_positions: ['低'],
    inventory_min_main_warehouse_stock: 200,
    roles_min_available_stock: 100,
    inventory_require_zero_procurement_inbound: true,
  },
  rain_overlay_categories: ['大衣', '短外套', '风衣'],
  solar_term_overlays: [],
  temperature_rules: [],
  weather_recommendation_framework: { inputs: [], outputs: [], review_dimensions: [], rules: [] },
};

let cache = null;
let cacheMtime = 0;

function mergeWithDefaults(saved) {
  const d = DEFAULT_WEATHER_RULES;
  const s = saved && typeof saved === 'object' ? saved : {};
  return {
    brand_mapping: s.brand_mapping || d.brand_mapping,
    product_role_thresholds: { ...d.product_role_thresholds, ...(s.product_role_thresholds || {}) },
    rain_overlay_categories: Array.isArray(s.rain_overlay_categories) ? s.rain_overlay_categories : d.rain_overlay_categories,
    solar_term_overlays: Array.isArray(s.solar_term_overlays) ? s.solar_term_overlays : [],
    temperature_rules: Array.isArray(s.temperature_rules) ? s.temperature_rules : [],
    weather_recommendation_framework: s.weather_recommendation_framework || d.weather_recommendation_framework,
  };
}

export function getWeatherRules() {
  try {
    const st = fs.statSync(RULES_FILE);
    if (cache && st.mtimeMs === cacheMtime) return cache;
    const saved = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
    cache = mergeWithDefaults(saved);
    cacheMtime = st.mtimeMs;
    return cache;
  } catch {
    return DEFAULT_WEATHER_RULES;
  }
}

export function saveWeatherRules(rules) {
  const merged = mergeWithDefaults(rules);
  fs.mkdirSync(path.dirname(RULES_FILE), { recursive: true });
  fs.writeFileSync(RULES_FILE, JSON.stringify(merged, null, 2));
  cache = null;
  cacheMtime = 0;
  return merged;
}
