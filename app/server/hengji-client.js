// 读取钉钉核价表同步结果（server/data/hengji-cost.json）
// 提供款号 → 总成本 / 核价表销售价 的查询接口
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JSON_PATH = path.join(__dirname, 'data', 'hengji-cost.json');

let cache = null;
let cacheMtime = 0;

function load() {
  try {
    const stats = statSync(JSON_PATH);
    if (cache && stats.mtimeMs === cacheMtime) return cache;
    const raw = readFileSync(JSON_PATH, 'utf8');
    cache = JSON.parse(raw);
    cacheMtime = stats.mtimeMs;
    return cache;
  } catch {
    return { byCode: {}, salesPriceByCode: {} };
  }
}

// 兼容旧版 Node 没有 fs.statSync 直接 import 的情况（这里直接 import { statSync }）
import { statSync } from 'node:fs';

function norm(code) {
  return String(code || '').trim().toLowerCase();
}

export function getHengjiCost(code) {
  const data = load();
  const v = data.byCode?.[norm(code).toUpperCase()];
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : undefined;
}

export function getHengjiSalesPrice(code) {
  const data = load();
  const v = data.salesPriceByCode?.[norm(code).toUpperCase()];
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : undefined;
}

// 给 Product/Sample 补核价表销售价兜底；BI/领猫/零售价都没有时才补
export function applyHengjiSalesPriceFallback(product) {
  if (!product.price && !product.priceNum) {
    const salesPrice = getHengjiSalesPrice(product.id);
    if (salesPrice > 0) {
      product.price = String(salesPrice);
      product.priceNum = salesPrice;
      product.priceNote = product.priceNote || '核价表兜底';
    }
  }
  return product;
}

// 给 Product/Sample 补核价表总成本兜底；领猫 SKC 成本 / BI bom商品成本 都没有时才补
export function applyHengjiCostFallback(product) {
  if (!product.costPrice) {
    const cost = getHengjiCost(product.id);
    if (cost && cost > 0) {
      product.costPrice = cost;
      product.costNote = product.costNote || '核价表兜底';
    }
  }
  return product;
}
