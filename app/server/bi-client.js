// 观远 BI 客户端：通过 guancli card preview 拉「商品全表数据(SKC)」——按 SKC 聚合（色/尺码级别）
// 用 SKC 而不是款级别，是因为「按色到仓的库存」需要按色拆分
//
// 卡片 id：df3a2f4fdcfda4e09801fcb4（商品全表数据(SKC)）
// 路径：根目录 > 商品看板 > 商品全表
//
// 双层缓存：
//   内存 60s（避免并发重读盘）+ 磁盘 12h（BI 重拉一次 86s+，能省就省）

import { previewGuancliCard } from './guancli.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { getEtaForCode, loadEtaMap } from './eta-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CACHE_DIR = join(__dirname, '.cache');
const CACHE_FILE = join(CACHE_DIR, 'bi_card.csv');
const PRODUCT_CACHE_FILE = join(CACHE_DIR, 'bi_product_card.csv');

// 两张 BI 卡：
//   - SKC 卡：df3a2f4fdcfda4e09801fcb4（按色拆分的库存/在途/占单）
//   - 款式卡：a6169c0395f884ed6a3d64f2（款级：小名/产品名称/销售价/价格定位/图片）
// 样式卡字段权威；颜色维度库存走 SKC 卡
const SKC_CARD_ID = 'df3a2f4fdcfda4e09801fcb4';
const PRODUCT_CARD_ID = 'a6169c0395f884ed6a3d64f2';

const MEM_TTL_MS = 60_000;
const DISK_TTL_MS = 12 * 60 * 60 * 1000; // 12h
let cache = { at: 0, byCode: new Map(), totalRows: 0 };
let productCache = { at: 0, byPdtCode: new Map(), totalRows: 0 };

function runGuancliCardPreview(cardId) {
  return previewGuancliCard(cardId, { limit: 100000 });
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].split(',').map((s) => s.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    if (cells.length !== header.length) continue;
    const row = {};
    for (let j = 0; j < header.length; j++) row[header[j]] = cells[j];
    rows.push(row);
  }
  return rows;
}

function rowsToMap(rows) {
  // SKC 卡片：按 pdtCode 聚合，每款下挂一组 SKC（色/尺码级）
  // 字段名约定：颜色/标准颜色 → 取「颜色」短色名；主仓实际库存 → 当前色库存；采购在途数 → 在途
  const m = new Map();
  const isMissing = (v) => v === undefined || v === null || v === '' || v === '0' || v === '0.0';
  const num = (v) => {
    if (isMissing(v)) return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  for (const r of rows) {
    const code = String(r['款式编码'] || '').trim();
    if (!code) continue;
    const key = code.toLowerCase();
    const color = String(r['颜色'] || r['标准颜色'] || '').trim();
    const stockMain = num(r['主仓实际库存']);
    const inTransit = num(r['采购在途数']);
    const totalStock = num(r['总库存(含在途)']);
    const orderBook = num(r['订单占有数']);
    // 虚拟云仓库存要从「采购在途数」中扣除：实际在途 = 采购在途数 - 虚拟云仓库存
    const virtualCloud = num(r['虚拟云仓库存']);
    const skc = String(r['SKC'] || '').trim();
    const entry = m.get(key) || { pdtCode: code, skcs: [], other: {} };
    entry.skcs.push({ color, skc, stockMain, inTransit, virtualCloud, totalStock, orderBook, raw: r });
    m.set(key, entry);
  }
  return m;
}

export async function loadBiProducts() {
  // 1) 内存
  if (cache.byCode.size && Date.now() - cache.at < MEM_TTL_MS) {
    // 内存命中也要确保 ETA 已加载（避免首次磁盘命中后 ETA 内存空）
    await loadEtaMap().catch((err) => console.warn('[bi] eta 卡加载失败:', err.message));
    return cache;
  }
  // 2) 磁盘（每次 miss 都重读；磁盘 ~1ms，远快于 86s 网拉）
  const fromDisk = await loadBiFromDisk();
  if (fromDisk) {
    cache = fromDisk;
    // 磁盘命中也要加载 ETA
    await loadEtaMap().catch((err) => console.warn('[bi] eta 卡加载失败:', err.message));
    return cache;
  }
  // 3) 都没有 → guancli 拉
  const csv = await runGuancliCardPreview(SKC_CARD_ID);
  const rows = parseCsv(csv);
  const byCode = rowsToMap(rows);
  cache = { at: Date.now(), byCode, totalRows: rows.length };
  // 同步加载 ETA（disk 命中 ~1ms；首次拉取 ~80s，缓存后可复用）
  await loadEtaMap().catch((err) => console.warn('[bi] eta 卡加载失败:', err.message));
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[bi] SKC card loaded ${rows.length} rows, ${byCode.size} distinct codes`);
  }
  saveToDisk(cache).catch((err) => console.warn('[bi] 写盘失败:', err.message));
  return cache;
}

// 款式级 BI 卡（a6169c0395f884ed6a3d64f2）：按 款号 聚合，每款只取首行（同一款号的多个行
// 仅在「售罄率打标」等切片维度上不同，款级权威字段相同；后续需要再按指标聚合时可扩展）
// 权威字段：小名/产品名称/销售价/价格定位/价格段/图片/面料/波段/产品分类
export async function loadBiProductMaster() {
  if (productCache.byPdtCode.size && Date.now() - productCache.at < MEM_TTL_MS) {
    return productCache;
  }
  const fromDisk = await loadProductMasterFromDisk();
  if (fromDisk) {
    productCache = fromDisk;
    return productCache;
  }
  const csv = await runGuancliCardPreview(PRODUCT_CARD_ID);
  const rows = parseCsv(csv);
  const byPdtCode = new Map();
  for (const r of rows) {
    const code = String(r['款号'] || '').trim();
    if (!code) continue;
    const key = code.toLowerCase();
    if (!byPdtCode.has(key)) byPdtCode.set(key, { pdtCode: code, raw: r });
  }
  productCache = { at: Date.now(), byPdtCode, totalRows: rows.length };
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[bi] 款式 card loaded ${rows.length} rows, ${byPdtCode.size} distinct codes`);
  }
  saveProductMasterToDisk(productCache).catch((err) => console.warn('[bi/product] 写盘失败:', err.message));
  return productCache;
}

// 按款号聚合 SKC 列表（颜色 + SKC 编码 + 计划翻单量）供面料 noRestock 标记和翻单清单导出用
export function getSkcsForCode(code) {
  if (!code) return [];
  const k = String(code).trim().toLowerCase();
  const entry = cache.byCode.get(k);
  if (!entry) return [];
  const num = (v) => {
    if (v === undefined || v === null || v === '' || v === '0' || v === '0.0') return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  return entry.skcs
    .map((s) => ({
      code: s.skc || '',
      color: s.color || '',
      plannedRestockQty: num(s.raw?.['翻单量']),
    }))
    .filter((x) => x.code);
}

export function clearBiCache() {
  cache = { at: 0, byCode: new Map(), totalRows: 0 };
  productCache = { at: 0, byPdtCode: new Map(), totalRows: 0 };
  unlink(CACHE_FILE).catch(() => {});
  unlink(PRODUCT_CACHE_FILE).catch(() => {});
}

// 只清 SKC 卡（库存/在途/占单），保留款式卡（名称/小名/售价）
// 用途：「同步库存」按钮 — 库存变更不影响基础资料
export function clearBiSkcCache() {
  cache = { at: 0, byCode: new Map(), totalRows: 0 };
  unlink(CACHE_FILE).catch(() => {});
}

async function loadBiFromDisk() {
  try {
    const text = await readFile(CACHE_FILE, 'utf8');
    const j = JSON.parse(text);
    if (j && j.at && Date.now() - j.at < DISK_TTL_MS && j.byCode) {
      return {
        at: Date.now(),
        byCode: new Map(j.byCode),
        totalRows: j.totalRows,
      };
    }
  } catch { /* */ }
  return null;
}

async function loadProductMasterFromDisk() {
  try {
    const text = await readFile(PRODUCT_CACHE_FILE, 'utf8');
    const j = JSON.parse(text);
    if (j && j.at && Date.now() - j.at < DISK_TTL_MS && j.byPdtCode) {
      return {
        at: Date.now(),
        byPdtCode: new Map(j.byPdtCode),
        totalRows: j.totalRows,
      };
    }
  } catch { /* */ }
  return null;
}

async function saveToDisk({ byCode, totalRows }) {
  await mkdir(CACHE_DIR, { recursive: true });
  const tmp = `${CACHE_FILE}.tmp`;
  const serializable = { at: Date.now(), totalRows, byCode: Array.from(byCode.entries()) };
  await writeFile(tmp, JSON.stringify(serializable), 'utf8');
  const { rename } = await import('node:fs/promises');
  await rename(tmp, CACHE_FILE);
}

async function saveProductMasterToDisk({ byPdtCode, totalRows }) {
  await mkdir(CACHE_DIR, { recursive: true });
  const tmp = `${PRODUCT_CACHE_FILE}.tmp`;
  const serializable = { at: Date.now(), totalRows, byPdtCode: Array.from(byPdtCode.entries()) };
  await writeFile(tmp, JSON.stringify(serializable), 'utf8');
  const { rename } = await import('node:fs/promises');
  await rename(tmp, PRODUCT_CACHE_FILE);
}

// 把 BI 行映射回我们的 Product 字段（BI 权威覆盖）
// row 是按 pdtCode 聚合的 SKC 组：{ pdtCode, skcs: [{color, skc, stockMain, inTransit, totalStock, raw}], other }
export function biOverrides(row) {
  if (!row || !row.skcs || row.skcs.length === 0) return null;
  const first = row.skcs[0].raw || {};
  const num = (s) => {
    if (s === undefined || s === null || s === '' || s === '0' || s === '0.0') return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  };
  const str = (s) => (s && String(s).trim()) || undefined;
  const pct = (s) => {
    const n = num(s);
    return n !== undefined ? n : undefined; // BI 已是小数比率（0.3 表示 30%），不要再 /100
  };

  const out = {};
  const price = num(first['销售价']);
  if (price !== undefined) {
    out.price = String(price);
    out.priceNum = price;
  }
  const fabric = str(first['面料']);
  // BI 的「面料」字段里有不少「面料_其他」占位值，对货盘无意义，直接过滤
  if (fabric && !/^面料_其他$/i.test(fabric)) out.fabric = fabric;
  const wave = str(first['波段(到SKC)'] || first['波段(到款式)']);
  if (wave) out.wave = wave;
  const category = str(first['产品分类(到SKC)'] || first['产品分类(到款式)']);
  if (category) out.category = category;
  // 款维度图片：优先用 BI 的「图片(到SKC)」http 网址（"0"/空 视为缺失，保留领猫图）
  const img = str(first['图片(到SKC)'] || first['图片(到款式)']);
  if (img && /^https?:\/\//i.test(img)) {
    out.img = img;
    out.imgSource = 'BI';
  }
  // 按色聚合 stock 数组：每色一行 "品类名 色：现货X 在途Y [交期] 占单Z"
  // 在途数 = 采购在途数 - 虚拟云仓库存（用户要求：虚拟云仓不算在途）
  // 品类前缀：让多款号坑位里不同款同色能区分（针织衫 深藏青：... vs 休闲裤 深藏青：...）
  const lines = [];
  let totalMain = 0;
  let totalTransit = 0;
  for (const s of row.skcs) {
    const c = s.color || '';
    const m = Number(s.stockMain) || 0;
    const rawTransit = Number(s.inTransit) || 0;
    const v = Number(s.virtualCloud) || 0;
    const t = Math.max(0, rawTransit - v);
    const o = Number(s.orderBook) || 0;
    const cat = String(s.raw?.['产品分类(到SKC)'] || s.raw?.['产品分类(到款式)'] || '').trim();
    totalMain += m;
    totalTransit += t;
    if (m > 0 || t > 0 || o > 0) {
      const head = (cat ? `${cat} ${c}` : (c || '其他'));
      const parts = [];
      if (m > 0) parts.push(`现货${m}`);
      if (t > 0) parts.push(`在途${t}`);
      if (o > 0) parts.push(`占单${o}`);
      lines.push(`${head}：${parts.join(' ')}`);
    }
  }
  // 交期：按款号查「最早待收货」的协议到货日期，注入到「在途」之后（只注有 在途 的行）
  const eta = getEtaForCode(row.pdtCode);
  if (eta) {
    for (let i = 0; i < lines.length; i++) {
      lines[i] = lines[i].replace(/(在途\d+)/, `$1 ${eta}交`);
    }
  }
  if (lines.length > 0) out.stock = lines;
  if (totalMain > 0) out.stockMain = totalMain;
  if (totalTransit > 0) out.inTransit = totalTransit;

  // 指标字段（取首条 SKC 的款级数据）
  const netSales = num(first['净销量']);
  if (netSales !== undefined) out.netSales = netSales;
  const newBuyer = pct(first['新买家占比(款)']);
  if (newBuyer !== undefined) out.newBuyer = newBuyer;
  const priceBand = str(first['价格定位']);
  if (priceBand) out.priceBand = priceBand;
  const forecastNetSales = num(first['预计总净销量']);
  if (forecastNetSales !== undefined) out.forecastNetSales = forecastNetSales;
  const forecastPostShipReturn = num(first['预计发货后退货数']);
  if (forecastPostShipReturn !== undefined) out.forecastPostShipReturn = forecastPostShipReturn;
  const returnRate = num(first['总退货率']);
  if (returnRate !== undefined) out.returnRate = returnRate;
  const conversion = pct(first['转化率']);
  if (conversion !== undefined) out.conversion = conversion;
  const cartRate = pct(first['加购率']);
  if (cartRate !== undefined) out.cartRate = cartRate;

  // BI 商品全表数据(款式) a6169 的打标 / 分类字段（每个 SKC 行里都重复了款级数据）
  const tagValid = str(first['有效款打标']);
  if (tagValid) out.tagValid = tagValid;
  const tagReturnPostShip = str(first['发货后退货率打标']);
  if (tagReturnPostShip) out.tagReturnPostShip = tagReturnPostShip;
  const tagReturn15d = str(first['15天退货率监控']);
  if (tagReturn15d) out.tagReturn15d = tagReturn15d;
  const tagSales30d = str(first['30天有无动销判定']);
  if (tagSales30d) out.tagSales30d = tagSales30d;
  const tagSoldOut = str(first['售罄率打标']);
  if (tagSoldOut) out.tagSoldOut = tagSoldOut;
  const tagGreenLight = str(first['是否绿灯款']);
  if (tagGreenLight) out.tagGreenLight = tagGreenLight;
  const tagRedBlack = str(first['红黑榜']);
  if (tagRedBlack) out.tagRedBlack = tagRedBlack;
  const season = str(first['季节(到款式)']);
  if (season) out.season = season;
  const fit = str(first['版型']);
  if (fit) out.fit = fit;
  const material = str(first['物料小类']);
  if (material) out.material = material;
  const stockBand = str(first['款库存区间']);
  if (stockBand) out.stockBand = stockBand;
  const stockTurnover = str(first['款库存判定']);
  if (stockTurnover) out.stockTurnover = stockTurnover;

  // 上新时间：同一款不同 SKC 可能分批上新，款级取最早一批；9999-12-31 是占位值
  let launchDate;
  for (const s of row.skcs) {
    const v = String(s.raw?.['上新时间(到SKC)'] || '').trim();
    if (!v || v === '0' || v.startsWith('9999')) continue;
    if (!launchDate || v < launchDate) launchDate = v;
  }
  if (launchDate) out.launchDate = launchDate;

  return out;
}

// 款式级 BI 卡（a6169c0395f884ed6a3d64f2）的字段覆盖——款级权威：名称/小名/售价/价格定位/图片/面料/波段/产品分类
// productRow: { pdtCode, raw: {款号, 小名, 产品名称, 销售价, 价格定位, 图片(到款式), 面料, 波段(到款式), 产品分类(到款式), ...} }
export function biProductOverrides(productRow) {
  if (!productRow || !productRow.raw) return null;
  const r = productRow.raw;
  const num = (s) => {
    if (s === undefined || s === null || s === '' || s === '0' || s === '0.0') return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  };
  const str = (s) => (s && String(s).trim()) || undefined;
  const pct = (s) => {
    const n = num(s);
    return n !== undefined ? n : undefined; // BI 已是小数比率（0.3 表示 30%），不要再 /100
  };
  const out = {};
  const sub = str(r['小名']);
  if (sub) out.sub = sub;
  const name = str(r['产品名称']);
  if (name) out.name = name;
  const price = num(r['销售价']);
  if (price !== undefined) {
    out.price = String(price);
    out.priceNum = price;
  }
  const priceBand = str(r['价格定位']);
  if (priceBand) out.priceBand = priceBand;
  const fabric = str(r['面料']);
  // BI 的「面料」字段里有不少「面料_其他」占位值，对货盘无意义，直接过滤
  if (fabric && !/^面料_其他$/i.test(fabric)) out.fabric = fabric;
  const wave = str(r['波段(到款式)']);
  if (wave) out.wave = wave;
  const category = str(r['产品分类(到款式)']);
  if (category) out.category = category;
  const img = str(r['图片(到款式)']);
  if (img && /^https?:\/\//i.test(img)) {
    out.img = img;
    out.imgSource = 'BI';
  }
  // 款级指标（款式卡也有，比 SKC 卡更权威）
  const netSales = num(r['净销量']);
  if (netSales !== undefined) out.netSales = netSales;
  const newBuyer = pct(r['新买家占比(款)']);
  if (newBuyer !== undefined) out.newBuyer = newBuyer;
  const forecastNetSales = num(r['预计总净销量']);
  if (forecastNetSales !== undefined) out.forecastNetSales = forecastNetSales;
  const forecastPostShipReturn = num(r['预计发货后退货数']);
  if (forecastPostShipReturn !== undefined) out.forecastPostShipReturn = forecastPostShipReturn;
  const returnRate = num(r['总退货率']);
  if (returnRate !== undefined) out.returnRate = returnRate;
  const conversion = pct(r['转化率']);
  if (conversion !== undefined) out.conversion = conversion;
  const cartRate = pct(r['加购率']);
  if (cartRate !== undefined) out.cartRate = cartRate;
  // 款级库存（款式卡的款级汇总，没有按色拆分；SKC 卡优先，款式卡作为兜底）
  const stockMain = num(r['主仓实际库存']);
  if (stockMain !== undefined && stockMain > 0) out.stockMain = stockMain;
  const inTransit = num(r['采购在途数']);
  if (inTransit !== undefined && inTransit > 0) out.inTransit = inTransit;
  const orderBook = num(r['订单占有数']);
  if (orderBook !== undefined && orderBook > 0) out.orderBook = orderBook;

  // 打标 / 分类字段
  const tagValid = str(r['有效款打标']);
  if (tagValid) out.tagValid = tagValid;
  const tagReturnPostShip = str(r['发货后退货率打标']);
  if (tagReturnPostShip) out.tagReturnPostShip = tagReturnPostShip;
  const tagReturn15d = str(r['15天退货率监控']);
  if (tagReturn15d) out.tagReturn15d = tagReturn15d;
  const tagSales30d = str(r['30天有无动销判定']);
  if (tagSales30d) out.tagSales30d = tagSales30d;
  const tagSoldOut = str(r['售罄率打标']);
  if (tagSoldOut) out.tagSoldOut = tagSoldOut;
  const tagGreenLight = str(r['是否绿灯款']);
  if (tagGreenLight) out.tagGreenLight = tagGreenLight;
  const tagRedBlack = str(r['红黑榜']);
  if (tagRedBlack) out.tagRedBlack = tagRedBlack;
  const season = str(r['季节(到款式)']);
  if (season) out.season = season;
  const fit = str(r['版型']);
  if (fit) out.fit = fit;
  const material = str(r['物料小类']);
  if (material) out.material = material;
  const stockBand = str(r['款库存区间']);
  if (stockBand) out.stockBand = stockBand;
  const stockTurnover = str(r['款库存判定']);
  if (stockTurnover) out.stockTurnover = stockTurnover;

  return out;
}

// 把一行 BI 卡片记录合成一条 Product（用于 BI 独有款号——领猫没建基础资料的情况）
// 业务字段走 BI 覆盖；基础资料（名称/图/类目/波段/面料）也走 BI；颜色维度走 SKC 聚合
// 价格严格走 BI，BI 没有就空（不能拿领猫 tagPrice 兜底）
// productMasterRow：款式卡的 row（用于覆盖款级权威字段，biRow 来自 SKC 卡可能没有名称/小名）
export function biOnlyProduct(row, productMasterRow) {
  if (!row || !row.skcs || row.skcs.length === 0) return null;
  const first = row.skcs[0].raw || {};
  const code = row.pdtCode || String(first['款式编码'] || '').trim();
  if (!code) return null;
  const id = code.toLowerCase();
  const isMissing = (v) => v === undefined || v === null || v === '' || v === '0' || v === '0.0' || v === '-';
  const str = (v) => (isMissing(v) ? undefined : String(v).trim());
  const num = (v) => {
    if (isMissing(v)) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const ov = biOverrides(row) || {};
  // 款式卡覆盖（款级权威）优先级最高
  const pmOv = productMasterRow ? biProductOverrides(productMasterRow) : null;
  const name = (pmOv && pmOv.name) || str(first['产品名称']) || str(first['小名']) || code;
  const sub = (pmOv && pmOv.sub) || str(first['小名']) || '';
  const imgRaw = (pmOv && pmOv.img) || str(first['图片(到SKC)'] || first['图片(到款式)']);
  // BI 有 http(s) URL 用 BI 图；否则保持空字符串（前端 SafeImg fallback 显示款号首字母占位，避免 404 请求 products/${id}.png）
  const img = imgRaw && /^https?:\/\//i.test(imgRaw) ? imgRaw : '';
  // 颜色：从 SKC 行里抽取所有非空 color
  const colorList = [...new Set(row.skcs.map((s) => s.color).filter(Boolean))];
  // 合并 SKU 卡的 ov 和款式卡的 pmOv，款式卡优先
  const merged = { ...ov, ...(pmOv || {}) };
  return {
    id,
    rawCode: code,
    name,
    sub,
    img,
    imgSource: 'BI',
    colors: colorList,
    fabric: merged.fabric ?? str(first['面料']) ?? null,
    category: merged.category || '',
    wave: merged.wave || '',
    // 业务字段按 /api/query(已填的映射)
    price: merged.price ?? '',
    priceNum: merged.priceNum ?? 0,
    priceBand: merged.priceBand ?? '',
    stockMain: merged.stockMain ?? 0,
    inTransit: merged.inTransit ?? 0,
    stock: merged.stock ?? [],
    netSales: merged.netSales ?? 0,
    conversion: merged.conversion ?? 0,
    returnRate: merged.returnRate ?? 0,
    newBuyer: merged.newBuyer ?? 0,
    cartRate: merged.cartRate ?? 0,
    forecastNetSales: merged.forecastNetSales ?? null,
    forecastPostShipReturn: merged.forecastPostShipReturn ?? null,
    // 领猫侧维度：领猫没建资料，留空/0
    plannedQty: 0,
    orderedQty: 0,
    tempBand: '',
    roles: [],
    ai: null,
    aiReason: null,
    restock: null,
    mprice: null,
    priceNote: null,
    skuCount: row.skcs.length,
    colorCount: colorList.length,
    costPrice: 0,
    // BI 打标 / 分类字段（从 ov / pmOv 合并透传）
    tagValid: merged.tagValid ?? null,
    tagReturnPostShip: merged.tagReturnPostShip ?? null,
    tagReturn15d: merged.tagReturn15d ?? null,
    tagSales30d: merged.tagSales30d ?? null,
    tagSoldOut: merged.tagSoldOut ?? null,
    tagGreenLight: merged.tagGreenLight ?? null,
    tagRedBlack: merged.tagRedBlack ?? null,
    season: merged.season ?? null,
    fit: merged.fit ?? null,
    material: merged.material ?? null,
    stockBand: merged.stockBand ?? null,
    stockTurnover: merged.stockTurnover ?? null,
    launchDate: merged.launchDate ?? null,
    modifyTime: null,
    // 标记位：BI 独有款号（领猫侧无基础资料），前端可据此灰显
    biMatched: true,
    biOnly: true,
  };
}

// 款式卡独有款号（领猫没有、SKC 卡也没有）——用款式卡合成 product
// 没有颜色维度的现货/在途（SKC 卡才有），所以 stock 留空
export function biOnlyProductFromMaster(productMasterRow) {
  if (!productMasterRow || !productMasterRow.raw) return null;
  const r = productMasterRow.raw;
  const code = productMasterRow.pdtCode || String(r['款号'] || '').trim();
  if (!code) return null;
  const id = code.toLowerCase();
  const isMissing = (v) => v === undefined || v === null || v === '' || v === '0' || v === '0.0' || v === '-';
  const str = (v) => (isMissing(v) ? undefined : String(v).trim());
  const num = (v) => {
    if (isMissing(v)) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const ov = biProductOverrides(productMasterRow) || {};
  const name = ov.name || str(r['产品名称']) || str(r['小名']) || code;
  const sub = ov.sub || str(r['小名']) || '';
  const imgRaw = ov.img || str(r['图片(到款式)']);
  const img = imgRaw && /^https?:\/\//i.test(imgRaw) ? imgRaw : '';
  // 颜色：款式卡没有按色拆分，颜色列表只能从「颜色」字段取（款式卡里这列通常为空）
  const colorList = [];
  return {
    id,
    rawCode: code,
    name,
    sub,
    img,
    imgSource: 'BI',
    colors: colorList,
    fabric: ov.fabric ?? str(r['面料']) ?? null,
    category: ov.category || '',
    wave: ov.wave || '',
    price: ov.price ?? '',
    priceNum: ov.priceNum ?? 0,
    priceBand: ov.priceBand ?? '',
    stockMain: 0,
    inTransit: 0,
    stock: [],
    netSales: ov.netSales ?? 0,
    conversion: ov.conversion ?? 0,
    returnRate: ov.returnRate ?? 0,
    newBuyer: ov.newBuyer ?? 0,
    cartRate: ov.cartRate ?? 0,
    forecastNetSales: ov.forecastNetSales ?? null,
    forecastPostShipReturn: ov.forecastPostShipReturn ?? null,
    plannedQty: 0,
    orderedQty: 0,
    tempBand: '',
    roles: [],
    ai: null,
    aiReason: null,
    restock: null,
    mprice: null,
    priceNote: null,
    skuCount: 0,
    colorCount: 0,
    costPrice: 0,
    modifyTime: null,
    biMatched: true,
    biOnly: true,
    productOnly: true, // 区分款式卡独有 vs SKC 卡独有
    // BI 打标 / 分类字段
    tagValid: ov.tagValid ?? null,
    tagReturnPostShip: ov.tagReturnPostShip ?? null,
    tagReturn15d: ov.tagReturn15d ?? null,
    tagSales30d: ov.tagSales30d ?? null,
    tagSoldOut: ov.tagSoldOut ?? null,
    tagGreenLight: ov.tagGreenLight ?? null,
    tagRedBlack: ov.tagRedBlack ?? null,
    season: ov.season ?? null,
    fit: ov.fit ?? null,
    material: ov.material ?? null,
    stockBand: ov.stockBand ?? null,
    stockTurnover: ov.stockTurnover ?? null,
  };
}
