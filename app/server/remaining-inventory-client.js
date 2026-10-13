// 剩余库存推荐：guancli ds preview wdc1e0bc092f84a0e81d9a13（上新监控，58895 行 / 316 列）
// 之前走 card preview j93dcdbbe10994fc1a708939，但透视卡 preview 只回 ~200 行，大量款覆盖不到；
// 数据集本身 58895 行 < 60000 上限，但整拉会 524 超时，所以按「款上新时间」分年份区拉取再合并。
// 附加采购交期：ds j5eecba4b53384a4186c53ba（产品交期数据；restock 同源；取每款采购日期最近一单的 协议到货日期 + leadDays）
// 缓存：内存 60s + 磁盘 12h（与 bi-client 一致）

import { runGuancli } from './guancli.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CACHE_DIR = join(__dirname, '.cache');
const REMAIN_CACHE_FILE = join(CACHE_DIR, 'bi_remaining_inventory_v2.json');
const PO_CACHE_FILE = join(CACHE_DIR, 'bi_purchase_orders_v3.json');

const DS_ID = 'wdc1e0bc092f84a0e81d9a13';
const PURCHASE_DS = 'j5eecba4b53384a4186c53ba';
const MEM_TTL_MS = 60_000;
const DISK_TTL_MS = 12 * 60 * 60 * 1000;

const COLUMNS = [
  '款式编码', '产品名称', '小名', '产品分类', '款上新时间', '销售价', 'SKC', '颜色',
  '图片(到SKC)', '季节(到SKC)', '下单量', '总库存(含在途)1', '主仓实际库存', '销退仓库存',
  '采购在途数', '销退在途数', '虚拟云仓库存', '订单占有数', '预估剩余可用数（改）', '消耗备注',
].join(',');

let cache = { at: 0, groups: [] };
let purchaseCache = { at: 0, etaByCode: new Map() };

function runGuancliDsPreview(dsId, columns, filter) {
  const args = ['ds', 'preview', dsId, '--limit', '60000', '-f', 'csv'];
  if (columns) args.push('--columns', columns);
  if (filter) args.push('--filter', filter);
  return runGuancli(args);
}

// RFC-4180 CSV 解析（数据集里有带引号的字段：内含逗号 33 行、内含换行 10 行，naive split 会错位）
function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (rows.length < 2) return [];
  const header = rows[0].map((s) => s.trim());
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    if (cells.length !== header.length) continue;
    const obj = {};
    for (let j = 0; j < header.length; j++) obj[header[j]] = cells[j];
    out.push(obj);
  }
  return out;
}

const num = (v) => {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// 推广建议规则（来自 BI 页面文本卡片 t8d302beb728d4826923eb93）
// 尽快推：主仓 - 订单占有 - 虚拟云仓 >= 150
// 补单到仓后推：上述 < 150 且 采购在途 >= 100
// 退货到仓后推：上述 < 150 且 采购在途 < 100 且 销退在途 >= 100
function tagsFor(main, orderBook, virtual, ontheway, returnOnway) {
  const available = main - orderBook - virtual;
  if (available >= 150) return ['尽快推'];
  if (ontheway >= 100) return ['补单到仓后推'];
  if (returnOnway >= 100) return ['退货到仓后推'];
  return [];
}

// 把 rows 按款式编码聚合
function aggregate(rows) {
  const byCode = new Map();
  for (const r of rows) {
    const code = String(r['款式编码'] || '').trim();
    if (!code) continue;
    if (code === '总计' || code === '小计') continue;
    if (String(r['SKC'] || '').trim() === '小计') continue;
    if (!byCode.has(code)) {
      byCode.set(code, {
        styleCode: code,
        productName: String(r['产品名称'] || '').trim(),
        alias: String(r['小名'] || '').trim(),
        category: String(r['产品分类'] || '').trim(),
        launchDate: String(r['款上新时间'] || '').trim(),
        retailPrice: num(r['销售价']),
        skus: [],
        totals: { orderQty: 0, totalStock: 0, mainStock: 0, returnStock: 0, ontheway: 0, returnOnway: 0, virtualStock: 0, orderBook: 0, estimate: 0 },
        tags: new Set(),
        remark: '',
      });
    }
    const g = byCode.get(code);
    const skc = String(r['SKC'] || '').trim();
    if (skc) {
      g.skus.push({
        skc,
        color: String(r['颜色'] || '').trim(),
        img: String(r['图片(到SKC)'] || '').trim(),
        orderQty: num(r['下单量']),
        totalStock: num(r['总库存(含在途)1']),
        mainStock: num(r['主仓实际库存']),
        returnStock: num(r['销退仓库存']),
        ontheway: num(r['采购在途数']),
        returnOnway: num(r['销退在途数']),
        virtualStock: num(r['虚拟云仓库存']),
        orderBook: num(r['订单占有数']),
        estimate: num(r['预估剩余可用数（改）']),
        season: String(r['季节(到SKC)'] || '').trim(),
      });
      g.totals.orderQty += num(r['下单量']);
      g.totals.totalStock += num(r['总库存(含在途)1']);
      g.totals.mainStock += num(r['主仓实际库存']);
      g.totals.returnStock += num(r['销退仓库存']);
      g.totals.ontheway += num(r['采购在途数']);
      g.totals.returnOnway += num(r['销退在途数']);
      g.totals.virtualStock += num(r['虚拟云仓库存']);
      g.totals.orderBook += num(r['订单占有数']);
      g.totals.estimate += num(r['预估剩余可用数（改）']);
    }
    // 推广建议按 SKU 行判断（更细粒度）；收集后取并集
    const tags = tagsFor(num(r['主仓实际库存']), num(r['订单占有数']), num(r['虚拟云仓库存']), num(r['采购在途数']), num(r['销退在途数']));
    tags.forEach((t) => g.tags.add(t));
    const remark = String(r['消耗备注'] || '').trim();
    if (remark) g.remark = remark;
  }
  // 决定主推图：取第一个有图的 SKU；否则用产品分类占位
  const groups = [...byCode.values()].map((g) => {
    const mainImg = g.skus.find((s) => s.img && !/noimg\.jpg/.test(s.img))?.img || g.skus.find((s) => s.img)?.img || '';
    // 排序 SKU：按预估剩余库存降序
    g.skus.sort((a, b) => b.estimate - a.estimate);
    return { ...g, mainImg, tags: [...g.tags] };
  });
  // 排序：预估剩余库存合计降序
  groups.sort((a, b) => b.totals.estimate - a.totals.estimate);
  return groups;
}

// 把采购单 ETA 注入到 groups（restock 思路：每款采购日期最近一单的 协议到货日期）
async function attachPurchaseEtas(groups) {
  const { etaByCode } = await loadPurchaseOrders();
  for (const g of groups) {
    const eta = etaByCode.get(g.styleCode.toLowerCase());
    if (eta && eta.etaDate) {
      g.purchaseEtaDate = eta.etaDate;          // 协议到货日期
      g.purchaseEtaLeadDays = eta.leadDays || 0; // 预计进行天数
    }
  }
}

// 采购单按款号聚合：取每款"采购日期最近一单"的协议到货日期 + leadDays（restock 项目用同源）
function aggregatePurchaseOrders(rows) {
  const byCode = new Map();
  for (const r of rows) {
    const code = String(r['款式编码'] || '').trim();
    if (!code) continue;
    const purchaseDate = String(r['采购日期'] || '').trim();
    if (!purchaseDate) continue;
    // 已完成的单不取交期（restock 仅取在途）
    const status = String(r['状态'] || '').trim();
    if (status === 'Finished' || status === 'Received') continue;
    const key = code.toLowerCase();
    const cur = byCode.get(key);
    if (cur && purchaseDate < cur.purchaseDate) continue;
    // 数据集没有计划/预计到货日期列，实际列是「协议到货日期」（= 采购日期+预计进行天数）；空则回退自算
    const leadDays = num(r['预计进行天数']);
    let etaDate = String(r['协议到货日期'] || '').trim().slice(0, 10);
    if (!etaDate && leadDays > 0) {
      const d = new Date(purchaseDate.replace(' ', 'T'));
      if (!Number.isNaN(d.getTime())) {
        d.setDate(d.getDate() + leadDays);
        etaDate = d.toISOString().slice(0, 10);
      }
    }
    byCode.set(key, { purchaseDate, etaDate, leadDays });
  }
  return byCode;
}

async function loadPurchaseFromDisk() {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    const text = await readFile(PO_CACHE_FILE, 'utf8');
    const j = JSON.parse(text);
    if (j && j.at && Date.now() - j.at < DISK_TTL_MS && j.data) {
      return new Map(Object.entries(j.data));
    }
  } catch {}
  return null;
}

async function loadPurchaseOrders() {
  if (purchaseCache.etaByCode.size && Date.now() - purchaseCache.at < MEM_TTL_MS) return purchaseCache;
  const fromDisk = await loadPurchaseFromDisk();
  if (fromDisk) {
    purchaseCache = { at: purchaseCache.at || Date.now(), etaByCode: fromDisk };
    return purchaseCache;
  }
  // 数据集 98420 行超 preview 上限，但 ETA 只关心最近的在途单：按采购日期开窗一次拉全（近 150 天约 6000 行）
  const since = new Date(Date.now() - 150 * 86_400_000).toISOString().slice(0, 10);
  const csv = await runGuancliDsPreview(
    PURCHASE_DS,
    '款式编码,采购日期,协议到货日期,状态,预计进行天数',
    `采购日期 GE ${since}`,
  );
  const etaByCode = aggregatePurchaseOrders(parseCsv(csv));
  purchaseCache = { at: Date.now(), etaByCode };
  writeFile(PO_CACHE_FILE, JSON.stringify({ at: purchaseCache.at, data: Object.fromEntries(etaByCode) })).catch((err) =>
    console.warn('[remaining-inventory/po] 写盘失败:', err.message),
  );
  return purchaseCache;
}

async function loadFromDisk() {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    const text = await readFile(REMAIN_CACHE_FILE, 'utf8');
    const j = JSON.parse(text);
    if (j && j.at && Date.now() - j.at < DISK_TTL_MS && Array.isArray(j.groups)) return j;
  } catch {}
  return null;
}

// 按「款上新时间」分年拉取（整拉 58895 行会 524 超时；每年 < 16000 行秒回）
// 尾段 GE 明年-01-01 兜住 9999 占位与未来年份
function partitionFilters() {
  const thisYear = new Date().getFullYear();
  const filters = [];
  for (let y = 2019; y <= thisYear; y++) filters.push(`款上新时间 BT ${y}-01-01,${y}-12-31`);
  filters.push(`款上新时间 GE ${thisYear + 1}-01-01`);
  return filters;
}

async function loadAll() {
  if (cache.groups.length && Date.now() - cache.at < MEM_TTL_MS) return cache;
  const fromDisk = await loadFromDisk();
  if (fromDisk) {
    cache = { at: fromDisk.at, groups: fromDisk.groups };
    return cache;
  }
  const t0 = Date.now();
  const allRows = [];
  for (const filter of partitionFilters()) {
    const csv = await runGuancliDsPreview(DS_ID, COLUMNS, filter);
    allRows.push(...parseCsv(csv));
  }
  const groups = aggregate(allRows);
  cache = { at: Date.now(), groups };
  console.log(`[remaining-inventory] ds 分区拉取 ${allRows.length} 行 → ${groups.length} 款，耗时 ${Math.round((Date.now() - t0) / 1000)}s`);
  writeFile(REMAIN_CACHE_FILE, JSON.stringify({ at: cache.at, groups })).catch((err) =>
    console.warn('[remaining-inventory] 写盘失败:', err.message),
  );
  return cache;
}

export async function listRemainingInventory({ tag = '', search = '', sort = 'estimate-desc', limit = 50 } = {}) {
  const { groups } = await loadAll();
  await attachPurchaseEtas(groups);
  const q = String(search || '').trim().toLowerCase();
  let filtered = groups;
  if (tag && tag !== 'all') {
    filtered = filtered.filter((g) => g.tags.includes(tag));
  }
  if (q) {
    filtered = filtered.filter(
      (g) =>
        g.styleCode.toLowerCase().includes(q) ||
        g.productName.toLowerCase().includes(q) ||
        g.alias.toLowerCase().includes(q) ||
        g.skus.some((s) => s.color.toLowerCase().includes(q) || s.skc.toLowerCase().includes(q)),
    );
  }
  // 排序
  const by = String(sort || 'estimate-desc');
  if (by === 'estimate-desc') filtered.sort((a, b) => b.totals.estimate - a.totals.estimate);
  else if (by === 'estimate-asc') filtered.sort((a, b) => a.totals.estimate - b.totals.estimate);
  else if (by === 'totalStock-desc') filtered.sort((a, b) => b.totals.totalStock - a.totals.totalStock);
  else if (by === 'ontheway-desc') filtered.sort((a, b) => b.totals.ontheway - a.totals.ontheway);
  else if (by === 'launchDate-desc') filtered.sort((a, b) => String(b.launchDate).localeCompare(String(a.launchDate)));
  else if (by === 'name-asc') filtered.sort((a, b) => a.productName.localeCompare(b.productName));
  return filtered.slice(0, Math.max(1, Math.min(limit, 10000)));
}

// 上新年份（从 group.launchDate 提取，9999 视为占位）
export async function listLaunchYears() {
  const { groups } = await loadAll();
  const years = new Set();
  for (const g of groups) {
    const s = String(g.launchDate || '');
    const m = s.match(/^(\d{4})/);
    if (!m) continue;
    const y = Number(m[1]);
    if (y >= 2000 && y <= 2100) years.add(y);
  }
  return [...years].sort((a, b) => b - a);
}

export function clearRemainingInventoryCache() {
  cache = { at: 0, groups: [] };
  unlink(REMAIN_CACHE_FILE).catch(() => {});
  unlink(PO_CACHE_FILE).catch(() => {});
}
