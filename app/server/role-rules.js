// 直播角色（引流/利润/库存）判定规则：默认口径 + 配置后台可改（server/data/role-rules.json）
// 规则由配置后台（GET/PUT /api/config/role-rules）维护，商品映射时 deriveRoles 实时读取
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_FILE = path.join(__dirname, 'data', 'role-rules.json');

export const DEFAULT_ROLE_RULES = {
  // 引流 = 价格带 ∈ priceBands，或转化率 ≥ minConversion（%）
  traffic: { minConversion: 6, priceBands: ['低'] },
  // 利润 = 价格带 ∈ priceBands；excludeSlow = true 时滞销款不标利润（归库存）
  profit: { priceBands: ['高'], excludeSlow: true },
  // 库存 = 滞销：
  //   requireBoth = true：周转前缀 ∈ slowTurnover 且 售罄率 ∈ lowSellTags
  //   requireBoth = false：两者任一满足即可
  //   noSales30d = true 时，「30天无动销」直接判滞销
  stock: {
    slowTurnover: ['无周转', '周转>60天'],
    lowSellTags: ['低销售', '低售罄'],
    requireBoth: true,
    noSales30d: true,
  },
};

let cache = null;
let cacheMtime = 0;

function mergeWithDefaults(saved) {
  const d = DEFAULT_ROLE_RULES;
  const s = saved && typeof saved === 'object' ? saved : {};
  return {
    traffic: {
      minConversion: Number(s.traffic?.minConversion ?? d.traffic.minConversion),
      priceBands: Array.isArray(s.traffic?.priceBands) ? s.traffic.priceBands : [...d.traffic.priceBands],
    },
    profit: {
      priceBands: Array.isArray(s.profit?.priceBands) ? s.profit.priceBands : [...d.profit.priceBands],
      excludeSlow: s.profit?.excludeSlow ?? d.profit.excludeSlow,
    },
    stock: {
      slowTurnover: Array.isArray(s.stock?.slowTurnover) ? s.stock.slowTurnover : [...d.stock.slowTurnover],
      lowSellTags: Array.isArray(s.stock?.lowSellTags) ? s.stock.lowSellTags : [...d.stock.lowSellTags],
      requireBoth: s.stock?.requireBoth ?? d.stock.requireBoth,
      noSales30d: s.stock?.noSales30d ?? d.stock.noSales30d,
    },
  };
}

// 读取规则（按文件 mtime 缓存；文件不存在/损坏时用默认口径）
export function getRoleRules() {
  try {
    const st = fs.statSync(RULES_FILE);
    if (cache && st.mtimeMs === cacheMtime) return cache;
    const saved = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
    cache = mergeWithDefaults(saved);
    cacheMtime = st.mtimeMs;
    return cache;
  } catch {
    return DEFAULT_ROLE_RULES;
  }
}

// 保存规则（简单校验 + 原子写入）；返回合并后的完整规则
export function saveRoleRules(rules) {
  const merged = mergeWithDefaults(rules);
  if (!(merged.traffic.minConversion >= 0)) {
    throw new Error('引流转化率阈值必须是 ≥ 0 的数字');
  }
  fs.mkdirSync(path.dirname(RULES_FILE), { recursive: true });
  const tmp = RULES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8');
  fs.renameSync(tmp, RULES_FILE);
  cache = merged;
  cacheMtime = fs.statSync(RULES_FILE).mtimeMs;
  return merged;
}

// 由 BI 打标/指标推导直播角色（引流/利润/库存），供排品策略分桶使用
export function deriveRoles(p) {
  const rules = getRoleRules();
  const turnover = String(p.stockTurnover || '');
  const slowTurn = rules.stock.slowTurnover.some((prefix) => prefix && turnover.startsWith(prefix));
  const lowSell = rules.stock.lowSellTags.includes(p.tagSoldOut);
  const slow =
    (rules.stock.requireBoth ? slowTurn && lowSell : slowTurn || lowSell) ||
    (rules.stock.noSales30d && p.tagSales30d === '30天无动销');
  const roles = [];
  if (slow) roles.push('库存');
  if (rules.traffic.priceBands.includes(p.priceBand) || (Number(p.conversion) || 0) * 100 >= rules.traffic.minConversion) {
    roles.push('引流');
  }
  if (rules.profit.priceBands.includes(p.priceBand) && !(rules.profit.excludeSlow && slow)) roles.push('利润');
  return roles;
}
