// 聚水潭实时库存（货盘库存主源）
// 用途：货盘「库存情况」优先用聚水潭 ERP 的实时库存；聚水潭查不到的款号，前端回到观远 BI SKC 卡的值兜底。
//
// 数据新鲜度：每条库存带 updatedAt（真正从 ERP 取到的时刻）和 stale 标记。
//   - 本次调用成功、但 ERP 没这个款 → 不返回该键（前端删掉旧的聚水潭值，回 BI 兜底）；
//   - 本次调用失败 → 返回上一次缓存的值，并标 stale=true + 旧的 updatedAt，前端据此提示可能过期。
//
// 口径与 BI 不同（前端会标注「聚水潭·全仓」）：
//   现货 = 各仓现存 qty 合计        （BI 是「主仓实际库存」）
//   占单 = order_lock + pick_lock   （BI 是「订单占有数」）
//   在途 = purchase_qty             （BI 是「采购在途数 - 虚拟云仓库存」）
//
// 缓存：按款号内存缓存（默认 5 分钟），查不到也做短缓存（1 分钟），避免货盘反复请求打爆 ERP。
// SKU 颜色元数据另做 6 小时缓存（尺码/颜色几乎不变），只有库存数走 5 分钟。

import { getInventoryByPids, getItemsByPids, isJushuitanConfigured } from './jushuitan-client.js';

const STOCK_TTL_MS = Number(process.env.JUSHUITAN_STOCK_TTL_MS) || 5 * 60 * 1000;
const ITEM_TTL_MS = 6 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 60 * 1000;
const CHUNK_SIZE = 50;
// 单次请求总预算：超过就返回已拿到的部分，不把前端请求拖死
const DEFAULT_BUDGET_MS = 40 * 1000;

const stockCache = new Map(); // pidLower -> { at, ttl, data | null }
const itemCache = new Map();  // pidLower -> { at, ttl, item | null }
const inFlight = new Map();   // chunkKey -> Promise<Map>

function normPid(pid) {
  return String(pid || '').trim();
}

// 把一条款的实时库存 + SKU 颜色，转成货盘用的库存行
// 行格式与 BI 保持一致：`品类 色：现货X 在途Y 占单Z`（parseStockLine 靠这些关键字取值）
export function buildStockEntry(invEntry, itemEntry) {
  if (!invEntry) return null;

  const category = String(itemEntry?.category || '').trim();
  const skuMeta = new Map();
  for (const s of itemEntry?.skus || []) {
    if (s?.skuId) skuMeta.set(String(s.skuId), s);
  }

  const byColor = new Map();
  for (const [skuId, st] of Object.entries(invEntry.skus || {})) {
    const meta = skuMeta.get(String(skuId));
    const color = String(meta?.color || '').trim() || '其他';
    const cur = byColor.get(color) || { qty: 0, transit: 0, lock: 0 };
    cur.qty += Number(st.qty) || 0;
    cur.transit += Number(st.purchaseQty) || 0;
    cur.lock += (Number(st.orderLock) || 0) + (Number(st.pickLock) || 0);
    byColor.set(color, cur);
  }

  const lines = [];
  let totalQty = 0;
  let totalTransit = 0;
  let totalLock = 0;
  const colors = [];
  for (const [color, v] of byColor) {
    totalQty += v.qty;
    totalTransit += v.transit;
    totalLock += v.lock;
    if (v.qty <= 0 && v.transit <= 0 && v.lock <= 0) continue;
    const head = category ? `${category} ${color}` : color;
    const parts = [];
    if (v.qty > 0) parts.push(`现货${v.qty}`);
    if (v.transit > 0) parts.push(`在途${v.transit}`);
    if (v.lock > 0) parts.push(`占单${v.lock}`);
    lines.push(`${head}：${parts.join(' ')}`);
    colors.push(color);
  }

  // 兜底：库存接口没回 SKU 明细（只有款级汇总）时，仍按款级出 1 行
  if (lines.length === 0) {
    const qty = Number(invEntry.totalQty) || 0;
    const transit = Number(invEntry.purchaseQty) || 0;
    const lock = (Number(invEntry.orderLock) || 0) + (Number(invEntry.pickLock) || 0);
    totalQty = qty;
    totalTransit = transit;
    totalLock = lock;
    if (qty > 0 || transit > 0 || lock > 0) {
      const parts = [];
      if (qty > 0) parts.push(`现货${qty}`);
      if (transit > 0) parts.push(`在途${transit}`);
      if (lock > 0) parts.push(`占单${lock}`);
      lines.push(`${category || '合计'}：${parts.join(' ')}`);
    }
  }

  if (lines.length === 0) return null;

  return {
    stock: lines,
    stockMain: totalQty,
    inTransit: totalTransit,
    orderBook: totalLock,
    colors,
    source: 'jushuitan',
  };
}

// ERP 查到了这个款、但各仓现存/在途/占单都是 0：返回一条空库存。
// 这是「有权威的 0」，必须覆盖 BI 的旧值；和「ERP 根本没这个款」（null）区分开。
function zeroStockEntry() {
  return { stock: [], stockMain: 0, inTransit: 0, orderBook: 0, colors: [], source: 'jushuitan' };
}

export function toStockResult(invEntry, itemEntry) {
  if (!invEntry) return null;
  return buildStockEntry(invEntry, itemEntry) || zeroStockEntry();
}

// 给一条库存盖上数据时刻 + 是否来自失败后的旧缓存
export function withStockMeta(data, atMs, stale = false) {
  if (!data) return null;
  return { ...data, updatedAt: new Date(atMs).toISOString(), stale: Boolean(stale) };
}

async function loadItemsCached(pids) {
  const now = Date.now();
  const need = [];
  const byPid = {};
  for (const raw of pids) {
    const key = raw.toLowerCase();
    const hit = itemCache.get(key);
    if (hit && now - hit.at < hit.ttl) {
      if (hit.item) byPid[key] = hit.item;
    } else {
      need.push(raw);
    }
  }
  if (need.length === 0) return { byPid };

  const { byPid: fetched } = await getItemsByPids(need);
  for (const raw of need) {
    const key = raw.toLowerCase();
    const item = fetched[key] || fetched[raw] || null;
    itemCache.set(key, { at: Date.now(), ttl: item ? ITEM_TTL_MS : NEGATIVE_TTL_MS, item });
    if (item) byPid[key] = item;
  }
  return { byPid };
}

async function fetchChunk(pids) {
  const key = pids.map((p) => p.toLowerCase()).sort().join(',');
  if (inFlight.has(key)) return inFlight.get(key);

  const task = (async () => {
    const inv = await getInventoryByPids(pids);
    // 颜色元数据拉取失败不影响库存本身：退化成不带颜色的「合计」行
    const items = await loadItemsCached(pids).catch((err) => {
      console.warn('[jushuitan-stock] SKU 颜色元数据拉取失败，降级为款级汇总:', err.message);
      return { byPid: {} };
    });
    const result = new Map();
    for (const raw of pids) {
      const lower = raw.toLowerCase();
      const invEntry = inv.byPid[lower] || inv.byPid[raw] || null;
      const itemEntry = items.byPid[lower] || items.byPid[raw] || null;
      result.set(lower, toStockResult(invEntry, itemEntry));
    }
    return result;
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, task);
  return task;
}

// 批量取库存（货盘主源入口）
// 返回 { byCode: { [pidLower]: { stock, stockMain, inTransit, orderBook, colors, source, updatedAt, stale } },
//        failed, failedCodes, missingCodes, at }
//   missingCodes：本次 ERP 正常返回、但没这个款 → 不放进 byCode，前端据此删旧值、回 BI 兜底
//   failedCodes：本批请求失败/超出预算 → 有旧缓存时放进 byCode 并标 stale=true
export async function getStockByCodes(pids = [], { budgetMs = DEFAULT_BUDGET_MS } = {}) {
  const empty = { byCode: {}, failed: false, failedCodes: [], missingCodes: [], at: Date.now() };
  if (!isJushuitanConfigured()) return empty;

  const uniq = [...new Set(pids.map(normPid).filter(Boolean))];
  const out = {};
  const failedCodes = [];
  const missingCodes = [];
  const now = Date.now();
  const stale = [];

  for (const raw of uniq) {
    const key = raw.toLowerCase();
    const hit = stockCache.get(key);
    if (hit && now - hit.at < hit.ttl) {
      if (hit.data) out[key] = withStockMeta(hit.data, hit.at, false);
    } else {
      // 过期条目先留着：本次拉取失败时可以继续用旧值兜底
      stale.push({ raw, key, prev: hit?.data || null, prevAt: hit?.at || 0 });
    }
  }
  if (stale.length === 0) {
    return { ...empty, byCode: out, at: now };
  }

  const deadline = Date.now() + budgetMs;
  for (let i = 0; i < stale.length; i += CHUNK_SIZE) {
    if (Date.now() > deadline) {
      const rest = stale.slice(i);
      console.warn(`[jushuitan-stock] 超出 ${budgetMs}ms 预算，剩余 ${rest.length} 个款号本次跳过`);
      for (const { raw, key, prev, prevAt } of rest) {
        failedCodes.push(raw);
        if (prev) out[key] = withStockMeta(prev, prevAt, true);
      }
      break;
    }
    const chunk = stale.slice(i, i + CHUNK_SIZE);
    try {
      const entries = await fetchChunk(chunk.map((c) => c.raw));
      const fetchedAt = Date.now();
      for (const { raw, key } of chunk) {
        const data = entries.get(key) ?? null;
        stockCache.set(key, { at: fetchedAt, ttl: data ? STOCK_TTL_MS : NEGATIVE_TTL_MS, data });
        if (data) out[key] = withStockMeta(data, fetchedAt, false);
        // 成功拉到但没这个款：旧值作废，交给前端回 BI 兜底
        else missingCodes.push(raw);
      }
    } catch (err) {
      console.warn(`[jushuitan-stock] 款号 [${chunk.slice(0, 3).map((c) => c.raw).join(',')}...] 库存拉取失败:`, err.message);
      // 失败不写缓存，回到上一次的数据并标 stale，让前端提示可能过期
      for (const { raw, key, prev, prevAt } of chunk) {
        failedCodes.push(raw);
        if (prev) out[key] = withStockMeta(prev, prevAt, true);
      }
    }
  }

  return { byCode: out, failed: failedCodes.length > 0, failedCodes, missingCodes, at: Date.now() };
}

// 测试/运维用：清空缓存
export function clearJushuitanStockCache() {
  stockCache.clear();
  itemCache.clear();
  inFlight.clear();
}
