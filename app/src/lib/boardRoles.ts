// 选款看板的商品角色判定（主推 / 经典 / 现金回收 / 利润 / 库存）
//
// 两个关键口径（来自业务方）：
//   1. 签收率 = 1 − 总退货率（含发货前和发货后）。45% 是考核线。
//      不要用「发货后退货率判定值」或「预计发货后退货率（渠道）」——那两列口径更严，
//      会大量误判；公司实际签收率约 18%，45% 已经属于优秀。
//   2. 预估剩余可用数必须逐款把所有 SKC 颜色行相加（剩余库存卡片的 totals.estimate 已是
//      按 SKC 行求和的结果），不能按全量一次估算，否则会低估。
//
// 判定顺序固定：主推 → 经典 → 现金回收 → 利润 → 库存；先命中的维度生效，后面的不覆盖。
// 一个坑位 = 一个套系：套系用「小名」作 key（无小名退回款号），套系内所有件的指标先相加
// 再判定，避免同一套系的不同件被拆到不同维度各挂一次（「卡片重复挂」的根因）。

import type { Product } from '@/data/products';

export type BoardRole = '主推' | '经典' | '现金回收' | '利润' | '库存';
export const BOARD_ROLES: BoardRole[] = ['主推', '经典', '现金回收', '利润', '库存'];
export type GroupRole = BoardRole | '其他';

export interface SuiteGroup {
  key: string;              // 小名（无小名退回款号）
  name: string;             // 展示名：小名 > 产品名 > 款号
  members: Product[];
  role: GroupRole;
  available: number;        // 预估剩余可用数（组内相加）
  sales14d: number;         // 近 14 天销量（组内相加）
  signRate: number | null;  // 签收率 = 1 − 总退货率；组内无退货数据时为 null
  ratio: number;            // 倍率 = 售价 / 成本，取组内最高
  seasonal: boolean;        // 应季：组内任一件季节为秋/冬
  red: boolean;             // 红榜
  cashFlag: boolean;        // 现金回收信号：9AW 老款 / 福利款 / 总退货率 ≥ 85%
}

// 套系 key：小名去空格；没有小名时退回款号
export function suiteKey(p: Product): string {
  return String(p.sub || '').trim() || p.id;
}

// 套系展示名：优先小名，其次产品名，最后款号
export function suiteName(p: Product): string {
  return String(p.sub || '').trim() || p.name || p.id.toUpperCase();
}

// 成本：领猫 SKU 成本优先，其次 BI bomCost
export function costOf(p: Product): number {
  const c = Number(p.costPrice);
  if (Number.isFinite(c) && c > 0) return c;
  const b = Number(p.bomCost);
  return Number.isFinite(b) && b > 0 ? b : 0;
}

// 倍率 = 售价 / 成本；缺数据返回 0
export function ratioOf(p: Product): number {
  const cost = costOf(p);
  const price = Number(p.priceNum);
  if (!cost || !price) return 0;
  return price / cost;
}

export function isSeasonal(p: Product): boolean {
  return /秋|冬/.test(String(p.season || ''));
}

// 9AW 老款：款号以 9AW 开头
export function is9AW(p: Product): boolean {
  return /^9AW/i.test(String(p.id || ''));
}

// 福利款：小名/产品名/波段里带「福利」
export function isWelfare(p: Product): boolean {
  return /福利/.test(`${p.sub || ''} ${p.name || ''} ${p.wave || ''}`);
}

// 预估剩余可用数：优先剩余库存卡片（已按 SKC 颜色行汇总），缺失时退回主仓库存
export function availableOf(p: Product, estimate?: number): number {
  if (Number.isFinite(estimate)) return Number(estimate);
  return Number(p.stockMain) || 0;
}

// 组内总退货率 = SUM(退货数量) / SUM(销售数量)（套系内各件先加数量，再相除，不能先按款算率再平均）
// 数量来源：
//   ① 商品卡里有「退货数量」「销售数量」就直接加这两个数；
//   ② 没有（当前卡没带这两列）就用 总退货率 反推：销售数量 = 净销量 / (1 − 总退货率)，
//      退货数量 = 销售数量 × 总退货率 —— 在 总退货率 = 退货/销售、净销量 = 销售 − 退货 的定义下，
//      Σ退货 / Σ销售 与直接加数量完全一致，权重是「销售数量」而不是「净销量」
// 都拿不到（无销售、无退货率）才返回 null：签收率显示 —，评分按 0 计
function groupReturnRate(members: Product[]): number | null {
  let weighted = 0; // Σ退货数量
  let weight = 0;  // Σ销售数量
  let plain = 0;
  let counted = 0;
  for (const p of members) {
    const r = Number(p.returnRate);
    const rateKnown = Number.isFinite(r) && r > 0;

    const rq = Number(p.returnQty);
    const sq = Number(p.salesQty);
    if (Number.isFinite(rq) && Number.isFinite(sq) && sq > 0 && rq >= 0) {
      weighted += rq;
      weight += sq;
      continue;
    }
    if (!rateKnown) continue;

    // 卡里没有数量列：用 净销量 + 总退货率 反推销售数量（退货率 =1 时无从反推，跳过）
    const net = Number(p.netSales);
    if (!Number.isFinite(net) || net <= 0 || r >= 1) {
      plain += r;
      counted++;
      continue;
    }
    const s = net / (1 - r);
    weighted += s * r;
    weight += s;
    plain += r;
    counted++;
  }
  if (weight > 0) return weighted / weight;
  if (counted > 0) return plain / counted;
  return null;
}

// 按优先级给套系定一个角色。阈值全部来自业务口径，改口径时同步改这里和测试。
export function deriveGroupRole(g: {
  available: number;
  sales14d: number;
  signRate: number | null;
  returnRate: number | null;
  ratio: number;
  seasonal: boolean;
  red: boolean;
  legacy9AW: boolean;
  welfare: boolean;
}): GroupRole {
  const signOk = g.signRate !== null && g.signRate >= 0.45;
  // 主推：预估剩余可用数 ≥150 且 签收 ≥45% 且 应季（秋/冬）
  if (g.available >= 150 && signOk && g.seasonal) return '主推';
  // 经典：红榜且可用 ≥150；或 签收 ≥45% 且近14天销量 ≥30（这一支不看可用数）
  if ((g.red && g.available >= 150) || (signOk && g.sales14d >= 30)) return '经典';
  // 现金回收：(总退货率 ≥85% 或 9AW 老款 或 福利款) 且 可用数 >100
  const cashSignal = (g.returnRate !== null && g.returnRate >= 0.85) || g.legacy9AW || g.welfare;
  if (cashSignal && g.available > 100) return '现金回收';
  // 利润：倍率 ≥3.0 且 应季 且 可用 ≥150
  if (g.ratio >= 3 && g.seasonal && g.available >= 150) return '利润';
  // 库存：可用 ≥150 且未落入以上任一维度
  if (g.available >= 150) return '库存';
  return '其他';
}

// 把候选款按套系聚合 + 判定角色（同一套系只出一个坑位）
export function buildSuiteGroups(
  products: Product[],
  estimateOf: (p: Product) => number | undefined,
  sales14dOf: (p: Product) => number,
): SuiteGroup[] {
  const map = new Map<string, SuiteGroup>();
  for (const p of products) {
    const key = suiteKey(p);
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        name: suiteName(p),
        members: [],
        role: '其他',
        available: 0,
        sales14d: 0,
        signRate: null,
        ratio: 0,
        seasonal: false,
        red: false,
        cashFlag: false,
      };
      map.set(key, g);
    }
    g.members.push(p);
    g.available += availableOf(p, estimateOf(p));
    g.sales14d += sales14dOf(p) || 0;
    g.ratio = Math.max(g.ratio, ratioOf(p));
    g.seasonal = g.seasonal || isSeasonal(p);
    g.red = g.red || String(p.tagRedBlack || '') === '红榜';
    g.cashFlag = g.cashFlag || is9AW(p) || isWelfare(p);
  }
  for (const g of map.values()) {
    const rr = groupReturnRate(g.members);
    g.signRate = rr === null ? null : 1 - rr;
    const legacy9AW = g.members.some(is9AW);
    const welfare = g.members.some(isWelfare);
    g.role = deriveGroupRole({
      available: g.available,
      sales14d: g.sales14d,
      signRate: g.signRate,
      returnRate: rr,
      ratio: g.ratio,
      seasonal: g.seasonal,
      red: g.red,
      legacy9AW,
      welfare,
    });
    g.cashFlag = g.cashFlag || (rr !== null && rr >= 0.85);
  }
  return [...map.values()];
}

export const roleRank = (r: GroupRole): number => {
  const i = BOARD_ROLES.indexOf(r as BoardRole);
  return i < 0 ? BOARD_ROLES.length : i;
};

// ── 选款评分（满分 100，四段）──
//   净签收贡献 50 分：近14天销量 × 签收率 = 净件数，110 件封顶 → min(50, net/110*50)
//   签收健康   20 分：签收率 15% 起算、60% 满分 → min(20, max(0, (签收率-0.15)/0.45*20))
//   应季       15 分：秋/冬 15，其他/空 8，春/夏 0
//   库存       15 分：预估剩余可用 ≥150 得 15，≥100 得 10，其余 5
// 签收率缺失（无退货数据）按 0 计：销量再多也拿不到净签收贡献和签收健康分。
export function scoreGroup(g: { available: number; sales14d: number; signRate: number | null; seasons: string[] }): number {
  const sign = g.signRate ?? 0;
  const netScore = Math.min(50, ((g.sales14d * sign) / 110) * 50);
  const healthScore = Math.min(20, Math.max(0, ((sign - 0.15) / 0.45) * 20));
  const seasonScore = seasonPoints(g.seasons);
  const stockScore = g.available >= 150 ? 15 : g.available >= 100 ? 10 : 5;
  return netScore + healthScore + seasonScore + stockScore;
}

// 应季分段：秋冬优先（组内任一件秋冬即算应季）；只有春夏得 0；没有季节数据/其他得 8
export function seasonPoints(seasons: string[]): number {
  const list = seasons.map((s) => String(s || '')).filter(Boolean);
  if (list.some((s) => /秋|冬/.test(s))) return 15;
  if (list.length === 0) return 8;
  if (list.every((s) => /春|夏/.test(s))) return 0;
  return 8;
}
