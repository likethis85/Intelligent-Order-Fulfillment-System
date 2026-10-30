// 观远 BI 客户端：通过 guancli card preview 拉「商品全表数据(SKC)」——按 SKC 聚合（色/尺码级别）
// 用 SKC 而不是款级别，是因为「按色到仓的库存」需要按色拆分
//
// 卡片 id：df3a2f4fdcfda4e09801fcb4（商品全表数据(SKC)）
// 路径：根目录 > 商品看板 > 商品全表
//
// 缓存策略（Stale-While-Revalidate）：
//   - 读请求永不等待回源：内存命中直接返回；没有内存就读磁盘（过期也照用）；磁盘也没有就先返回空并后台拉
//   - 回源只走后台车道（guancli background lane），10 分钟超时 + 失败重试 + 冷却，不挤占用户请求
//   - 数据年龄 > 12h 才算「不可信」（getBiCacheStatus().usable=false，货盘切聚水潭实时库存兜底）

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

const DISK_TTL_MS = 12 * 60 * 60 * 1000; // 12h：超过即视为「不可信」，前端货盘切聚水潭实时库存兜底
// 后台回源周期：数据超过这个年龄就发起后台重拉（不阻塞任何 HTTP 请求）
const REFRESH_TTL_MS = Number(process.env.BI_REFRESH_TTL_MS) || 30 * 60 * 1000;
// 内存命中窗口：期间直接返回内存缓存，避免反复解析 50MB+ 的磁盘 JSON
const MEM_TTL_MS = Number(process.env.BI_MEM_TTL_MS) || REFRESH_TTL_MS;
// 全量 SKC 卡实测 5 分钟级（2026-10-30 实测 296s / 15180 行 / 12MB），
// 旧的 30s 超时注定失败。现在回源只走后台车道，超时给足，且绝不阻塞 HTTP 请求。
const REFRESH_TIMEOUT_MS = Number(process.env.BI_REFRESH_TIMEOUT_MS) || 10 * 60 * 1000;
const REFRESH_ATTEMPTS = Number(process.env.BI_REFRESH_ATTEMPTS) || 2;
const RETRY_DELAY_MS = Number(process.env.BI_RETRY_DELAY_MS) || 60 * 1000;
const FAIL_COOLDOWN_MS = Number(process.env.BI_FAIL_COOLDOWN_MS) || 10 * 60 * 1000;

let cache = { at: 0, byCode: new Map(), totalRows: 0 };
let productCache = { at: 0, byPdtCode: new Map(), totalRows: 0 };

// 后台刷新状态（SKC 卡 / 款式卡各一份）
const refreshState = {
  skc: { promise: null, startedAt: null, lastFailureAt: 0, lastError: null, lastSuccessAt: 0 },
  master: { promise: null, startedAt: null, lastFailureAt: 0, lastError: null, lastSuccessAt: 0 },
};

// 刷新成功回调：由 index.js 接入「清衍生缓存 + WebSocket 广播」，避免 bi-client 反向依赖 ws 模块
let onRefreshed = null;
export function setBiRefreshListener(fn) {
  onRefreshed = typeof fn === 'function' ? fn : null;
}
function notifyRefreshed(info) {
  if (!onRefreshed) return;
  try { onRefreshed(info); } catch (err) { console.warn('[bi] 刷新回调异常:', err.message); }
}

// 数据本身的生产时间（at 是「本次装载时间」，不能用来判断数据新不新）
function dataAt(c) {
  return c.sourceAt || c.at || 0;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 是否该发起后台刷新（纯函数，便于单测）
export function shouldStartRefresh({
  hasData,
  dataAt: at,
  now = Date.now(),
  refreshing = false,
  lastFailureAt = 0,
  cooldownMs = FAIL_COOLDOWN_MS,
  ttlMs = REFRESH_TTL_MS,
}) {
  if (refreshing) return false;
  if (hasData && at && now - at < ttlMs) return false;
  if (lastFailureAt && now - lastFailureAt < cooldownMs) return false;
  return true;
}

function maybeRefreshSkc() {
  // 单飞句柄是 stockSyncState.isSyncing（refreshBiSkc 内部维护），这里不重复记账
  if (stockSyncState.isSyncing) return;
  const ok = shouldStartRefresh({
    hasData: cache.byCode.size > 0,
    dataAt: dataAt(cache),
    refreshing: false,
    lastFailureAt: refreshState.skc.lastFailureAt,
  });
  if (!ok) return;
  runRefreshWithRetry('skc');
}

function maybeRefreshMaster() {
  // 单飞句柄是 refreshState.master.promise（refreshBiProductMaster 内部维护）
  if (refreshState.master.promise) return;
  const ok = shouldStartRefresh({
    hasData: productCache.byPdtCode.size > 0,
    dataAt: dataAt(productCache),
    refreshing: false,
    lastFailureAt: refreshState.master.lastFailureAt,
  });
  if (!ok) return;
  runRefreshWithRetry('master');
}

async function runRefreshWithRetry(kind) {
  const st = refreshState[kind];
  for (let attempt = 1; attempt <= REFRESH_ATTEMPTS; attempt++) {
    try {
      const r = kind === 'skc'
        ? await refreshBiSkc({ timeoutMs: REFRESH_TIMEOUT_MS })
        : await refreshBiProductMaster({ timeoutMs: REFRESH_TIMEOUT_MS });
      if (r.status === 'already_running') return;
      await r.promise;
      st.lastFailureAt = 0;
      return;
    } catch (err) {
      st.lastError = err.message;
      console.warn(`[bi] ${kind} 后台刷新第 ${attempt}/${REFRESH_ATTEMPTS} 次失败:`, err.message);
      if (attempt < REFRESH_ATTEMPTS) await sleep(RETRY_DELAY_MS);
    }
  }
  st.lastFailureAt = Date.now();
  console.warn(`[bi] ${kind} 连续失败 ${REFRESH_ATTEMPTS} 次，冷却 ${Math.round(FAIL_COOLDOWN_MS / 60000)} 分钟后再试`);
}

function runGuancliCardPreview(cardId, { background = false, timeoutMs } = {}) {
  return previewGuancliCard(cardId, { limit: 100000, background, timeoutMs });
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
  // 1) 内存新鲜 → 直接返回（ETA 卡不阻塞请求：没有就先不显示交期，后续请求会补上）
  if (cache.byCode.size && Date.now() - cache.at < MEM_TTL_MS) {
    // 内存里可能装的是过期数据（PM2 重启后从磁盘装载），有请求就顺手判断要不要回源，
    // 不必等内存窗口到期
    maybeRefreshSkc();
    loadEtaMap().catch((err) => console.warn('[bi] eta 卡加载失败:', err.message));
    return cache;
  }
  // 2) 磁盘（过期也照用：比整列库存空着强，同时后台刷新）
  if (!cache.byCode.size) {
    const fromDisk = await loadBiFromDiskShared();
    if (fromDisk && !cache.byCode.size) cache = fromDisk;
  }
  if (cache.byCode.size) {
    maybeRefreshSkc();
    loadEtaMap().catch((err) => console.warn('[bi] eta 卡加载失败:', err.message));
    return cache;
  }
  // 3) 一点缓存都没有：不阻塞请求，后台拉，本次返回空（库存由聚水潭兜底）
  maybeRefreshSkc();
  return cache;
}

// 款式级 BI 卡（a6169c0395f884ed6a3d64f2）：按 款号 聚合，每款只取首行（同一款号的多个行
// 仅在「售罄率打标」等切片维度上不同，款级权威字段相同；后续需要再按指标聚合时可扩展）
// 权威字段：小名/产品名称/销售价/价格定位/价格段/图片/面料/波段/产品分类
export async function loadBiProductMaster() {
  if (productCache.byPdtCode.size && Date.now() - productCache.at < MEM_TTL_MS) {
    maybeRefreshMaster();
    return productCache;
  }
  if (!productCache.byPdtCode.size) {
    const fromDisk = await loadProductMasterFromDiskShared();
    if (fromDisk && !productCache.byPdtCode.size) productCache = fromDisk;
  }
  maybeRefreshMaster();
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

let stockSyncState = {
  isSyncing: false,
  startedAt: null,
  lastSyncedAt: null,
  lastError: null,
  lastCount: 0,
};

export function getStockSyncStatus() {
  return { ...stockSyncState };
}

// BI 缓存健康度：给前端判断「BI 库存是否可信」用
// usable=false 时货盘会切到聚水潭实时库存兜底（见 server/jushuitan-stock.js）
export function getBiCacheStatus() {
  const now = Date.now();
  const describe = (c, kind) => {
    const dataAt = c.sourceAt || c.at || 0;
    const ageMs = dataAt ? now - dataAt : null;
    const st = refreshState[kind] || {};
    const exhausting = st.lastFailureAt
      ? Math.max(0, st.lastFailureAt + FAIL_COOLDOWN_MS - now)
      : 0;
    return {
      rows: c.totalRows || 0,
      codes: c.byCode?.size ?? c.byPdtCode?.size ?? 0,
      dataAt: dataAt ? new Date(dataAt).toISOString() : null,
      ageMs,
      // 只有 12h 内的数据才算「可信」；过期数据仍然会被使用（前端会标成旧数据/聚水潭兜底）
      usable: Boolean(dataAt) && ageMs !== null && ageMs < DISK_TTL_MS,
      refreshing: Boolean(st.promise) || (kind === 'skc' && stockSyncState.isSyncing),
      lastSuccessAt: st.lastSuccessAt ? new Date(st.lastSuccessAt).toISOString() : null,
      lastError: kind === 'skc' ? (stockSyncState.lastError || st.lastError || null) : (st.lastError || null),
      retryAfterMs: exhausting || null,
    };
  };
  return {
    skc: describe(cache, 'skc'),
    product: describe(productCache, 'master'),
    diskTtlMs: DISK_TTL_MS,
    refreshTimeoutMs: REFRESH_TIMEOUT_MS,
    sync: { ...stockSyncState },
    checkedAt: new Date(now).toISOString(),
  };
}

// 异步从观远 BI 刷新 SKC 卡（现货/在途/占单/交期），平滑过渡（Stale-While-Revalidate）：
// 拉取期间旧缓存继续生效，新数据下载并校验成功后原子替换磁盘与内存缓存
export async function refreshBiSkc({ timeoutMs = REFRESH_TIMEOUT_MS, trigger = 'auto' } = {}) {
  if (stockSyncState.isSyncing) {
    return { status: 'already_running', startedAt: stockSyncState.startedAt };
  }
  stockSyncState.isSyncing = true;
  stockSyncState.startedAt = new Date().toISOString();
  stockSyncState.lastError = null;

  const promise = (async () => {
    const t0 = Date.now();
    try {
      console.log('[bi] 开始后台刷新观远 BI SKC 库存卡...');
      const csv = await runGuancliCardPreview(SKC_CARD_ID, { background: true, timeoutMs });
      const rows = parseCsv(csv);
      if (!rows || rows.length === 0) {
        throw new Error('观远 BI 返回了空数据');
      }
      const byCode = rowsToMap(rows);
      // 原子替换内存缓存（sourceAt = 数据生产时间，at = 装载时间）
      cache = { at: Date.now(), sourceAt: Date.now(), byCode, totalRows: rows.length };
      // 原子保存磁盘缓存（saveToDisk 先写 .tmp 再 rename）
      await saveToDisk(cache);
      // 联动加载/刷新 ETA 卡
      await loadEtaMap().catch((err) => console.warn('[bi] eta 卡加载失败:', err.message));

      const elapsed = Math.round((Date.now() - t0) / 1000);
      console.log(`[bi] SKC 库存卡后台刷新成功: ${rows.length} 行，${byCode.size} 款，耗时 ${elapsed}s`);

      stockSyncState.lastSyncedAt = new Date().toISOString();
      stockSyncState.lastCount = byCode.size;
      refreshState.skc.lastSuccessAt = Date.now();
      refreshState.skc.lastError = null;
      notifyRefreshed({ card: 'skc', trigger, rows: rows.length, count: byCode.size, elapsed });
      return { success: true, count: byCode.size, rows: rows.length, elapsed };
    } catch (err) {
      console.error('[bi] SKC 库存卡后台刷新失败 (旧缓存仍有效):', err.message);
      stockSyncState.lastError = err.message;
      throw err;
    } finally {
      stockSyncState.isSyncing = false;
    }
  })();

  return { status: 'started', startedAt: stockSyncState.startedAt, promise };
}

// 款式卡独立后台刷新（名称/小名/售价/图片等款级字段）
export async function refreshBiProductMaster({ timeoutMs = REFRESH_TIMEOUT_MS, trigger = 'auto' } = {}) {
  if (refreshState.master.promise) {
    return { status: 'already_running', promise: refreshState.master.promise };
  }

  const promise = (async () => {
    const t0 = Date.now();
    try {
      console.log('[bi] 开始后台刷新观远 BI 款式卡...');
      const csv = await runGuancliCardPreview(PRODUCT_CARD_ID, { background: true, timeoutMs });
      const rows = parseCsv(csv);
      if (!rows || rows.length === 0) {
        throw new Error('观远 BI 返回了空数据');
      }
      const byPdtCode = new Map();
      for (const r of rows) {
        const code = String(r['款号'] || '').trim();
        if (!code) continue;
        const key = code.toLowerCase();
        if (!byPdtCode.has(key)) byPdtCode.set(key, { pdtCode: code, raw: r });
      }
      productCache = { at: Date.now(), sourceAt: Date.now(), byPdtCode, totalRows: rows.length };
      await saveProductMasterToDisk(productCache);

      const elapsed = Math.round((Date.now() - t0) / 1000);
      console.log(`[bi] 款式卡后台刷新成功: ${rows.length} 行，${byPdtCode.size} 款，耗时 ${elapsed}s`);

      refreshState.master.lastSuccessAt = Date.now();
      refreshState.master.lastError = null;
      notifyRefreshed({ card: 'product', trigger, rows: rows.length, count: byPdtCode.size, elapsed });
      return { success: true, count: byPdtCode.size, rows: rows.length, elapsed };
    } catch (err) {
      console.error('[bi] 款式卡后台刷新失败 (旧缓存仍有效):', err.message);
      throw err;
    }
  })();

  refreshState.master.promise = promise;
  refreshState.master.startedAt = new Date().toISOString();
  promise.catch(() => {}).finally(() => { refreshState.master.promise = null; });
  return { status: 'started', startedAt: refreshState.master.startedAt, promise };
}

export function clearBiCache({ hard = false } = {}) {
  cache = { at: 0, byCode: new Map(), totalRows: 0 };
  productCache = { at: 0, byPdtCode: new Map(), totalRows: 0 };
  if (hard) {
    unlink(CACHE_FILE).catch(() => {});
    unlink(PRODUCT_CACHE_FILE).catch(() => {});
  }
}

// 只清 SKC 卡（库存/在途/占单），保留款式卡（名称/小名/售价）
// 用途：「同步库存」按钮 — 默认不清磁盘，确保旧缓存有效
export function clearBiSkcCache({ hard = false } = {}) {
  cache = { at: 0, byCode: new Map(), totalRows: 0 };
  if (hard) {
    unlink(CACHE_FILE).catch(() => {});
  }
}

// 单飞：冷启动时多个请求同时到达，避免并发 JSON.parse 同一个 50MB+ 文件
let skcDiskLoad = null;
let masterDiskLoad = null;
function loadBiFromDiskShared() {
  if (!skcDiskLoad) {
    skcDiskLoad = loadBiFromDisk().finally(() => { skcDiskLoad = null; });
  }
  return skcDiskLoad;
}
function loadProductMasterFromDiskShared() {
  if (!masterDiskLoad) {
    masterDiskLoad = loadProductMasterFromDisk().finally(() => { masterDiskLoad = null; });
  }
  return masterDiskLoad;
}

async function loadBiFromDisk() {
  try {
    const text = await readFile(CACHE_FILE, 'utf8');
    if (!text || !text.trim()) return null;
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) {
      const j = JSON.parse(trimmed);
      if (j && j.at && j.byCode) {
        // 过期也照用（stale-while-revalidate）：数据旧总比整表库存空白强，
        // 是否回源由 maybeRefreshSkc() 判定，不阻塞本次请求。
        return {
          at: Date.now(),
          // 数据本身的生产时间（at 是「本次装载时间」，不能用来判断数据新不新）
          sourceAt: j.at,
          byCode: new Map(j.byCode),
          totalRows: j.totalRows,
        };
      }
    } else {
      // 兼容直接放 CSV 文件的场景
      const rows = parseCsv(trimmed);
      if (rows.length > 0) {
        const byCode = rowsToMap(rows);
        const cacheObj = { at: Date.now(), byCode, totalRows: rows.length };
        saveToDisk(cacheObj).catch(() => {});
        return cacheObj;
      }
    }
  } catch { /* */ }
  return null;
}

async function loadProductMasterFromDisk() {
  try {
    const text = await readFile(PRODUCT_CACHE_FILE, 'utf8');
    if (!text || !text.trim()) return null;
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) {
      const j = JSON.parse(trimmed);
      if (j && j.at && j.byPdtCode) {
        // 过期也照用（stale-while-revalidate），回源由 maybeRefreshMaster() 判定
        return {
          at: Date.now(),
          sourceAt: j.at,
          byPdtCode: new Map(j.byPdtCode),
          totalRows: j.totalRows,
        };
      }
    } else {
      const rows = parseCsv(trimmed);
      if (rows.length > 0) {
        const byPdtCode = new Map();
        for (const r of rows) {
          const code = String(r['款号'] || '').trim();
          if (!code) continue;
          const key = code.toLowerCase();
          if (!byPdtCode.has(key)) byPdtCode.set(key, { pdtCode: code, raw: r });
        }
        const cacheObj = { at: Date.now(), byPdtCode, totalRows: rows.length };
        saveProductMasterToDisk(cacheObj).catch(() => {});
        return cacheObj;
      }
    }
  } catch { /* */ }
  return null;
}

async function saveToDisk({ byCode, totalRows, sourceAt, at }) {
  await mkdir(CACHE_DIR, { recursive: true });
  const tmp = `${CACHE_FILE}.tmp`;
  const serializable = { at: at || Date.now(), sourceAt: sourceAt || at || Date.now(), totalRows, byCode: Array.from(byCode.entries()) };
  await writeFile(tmp, JSON.stringify(serializable), 'utf8');
  const { rename } = await import('node:fs/promises');
  await rename(tmp, CACHE_FILE);
}

async function saveProductMasterToDisk({ byPdtCode, totalRows, sourceAt, at }) {
  await mkdir(CACHE_DIR, { recursive: true });
  const tmp = `${PRODUCT_CACHE_FILE}.tmp`;
  const serializable = { at: at || Date.now(), sourceAt: sourceAt || at || Date.now(), totalRows, byPdtCode: Array.from(byPdtCode.entries()) };
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
