// 领猫 SCM 客户端：管 token 缓存、HTTP 调用、字段映射、本地快照落盘
// 文档：https://scmv3-openapi-portal.scm321.com
//
// 流程：
//   1) POST /auth/token          body { appId, appSecret }   → Bearer token（2h）
//   2) POST /v1/Product/getproducts  + Bearer               → 商品列表
//
// 所有方法在凭证缺失或上游出错时抛 Error；上层决定是否回退 mock。
//
// 本地快照：
//   - server/.cache/vscm_products.json
//   - 跑通一次后写盘；重启后从盘读，避免 ~50s 的全年窗口冷启
//   - TTL：内存 60s；磁盘 24h（足够开发周期，不需要每日刷领猫）

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CACHE_DIR = join(__dirname, '.cache');
const CACHE_FILE = join(CACHE_DIR, 'vscm_products.json');
const DISK_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时

const BASE = process.env.VSCM_BASE_URL || 'https://open.scm321.com';
const APP_ID = process.env.VSCM_APP_ID || '';
const APP_SECRET = process.env.VSCM_APP_SECRET || '';

// 全量爬取窗口长度（默认 30 天 = 5 个 7 天窗口；MVP demo 验证够用，避免撞 500/min 限频）
// 调长只需改这里：360 = 一年期，90 = 一季度
const FULL_LOOKBACK_DAYS = Number(process.env.VSCM_LOOKBACK_DAYS || 30);
const FULL_LOOKBACK_MS = FULL_LOOKBACK_DAYS * 24 * 3600 * 1000;

export function hasCredentials() {
  return Boolean(APP_ID && APP_SECRET);
}

// ── token 缓存 ──
let tokenCache = { token: null, expiresAt: 0 };
export async function getToken() {
  if (!hasCredentials()) {
    throw new Error('VSCM_APP_ID / VSCM_APP_SECRET 未配置（看 server/.env）');
  }
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60_000) {
    return tokenCache.token;
  }
  const res = await fetch(`${BASE}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: APP_ID, appSecret: APP_SECRET }),
  });
  if (!res.ok) throw new Error(`auth/token HTTP ${res.status}`);
  const json = await res.json();
  if (!json.isSuccess) throw new Error(`auth/token 上游返回失败：${json.msg || json.message}`);
  const data = json.data || {};
  tokenCache = {
    token: data.access_token || data.token || data.accessToken,
    expiresAt: Date.now() + (data.expires_in || 7200) * 1000,
  };
  if (!tokenCache.token) throw new Error('auth/token 响应里没找到 access_token');
  return tokenCache.token;
}

// ── 通用调用 ──
export async function call(path, body, { retried = false } = {}) {
  const token = await getToken();
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body || {}),
  });
  if (res.status === 401 && !retried) {
    tokenCache = { token: null, expiresAt: 0 };
    return call(path, body, { retried: true });
  }
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}`);
  const json = await res.json();
  if (!json.isSuccess) throw new Error(`${path} 上游失败：${json.msg || json.message}`);
  return json;
}

// ── 商品列表（自动翻页 + 7 天窗口回溯） ──
// 领猫规则：modifiedBegin/modifiedEnd 必须成对且 < 7 天；要全量就得按窗口回溯
// 取 6 天 23:59:00 = 604_794_000ms，比 7 天整稍小，免被服务器 reject
const WINDOW_MS = 6 * 24 * 3600 * 1000 + 23 * 3600 * 1000 + 59 * 1000;

async function fetchWindow({ pageSize, modifiedBegin, modifiedEnd, maxPages }) {
  const out = [];
  let pageIndex = 1;
  let totalCount = 0;
  while (pageIndex <= maxPages) {
    const body = { pageIndex, pageSize, modifiedBegin, modifiedEnd };
    const json = await call('/v1/Product/getproducts', body);
    const data = json.data || {};
    const items = data.datas || [];
    totalCount = data.totalCount || items.length;
    for (const dto of items) out.push(dto);
    if (!data.hasNext) break;
    pageIndex += 1;
  }
  return { items: out, totalCount };
}

// ── 双层缓存：磁盘（24h TTL）+ 内存（60s，避免并发重读盘） ──
// 关键：内存 TTL 到期后也要回查磁盘，不能直接 fall through 到网络
const MEM_TTL_MS = 60_000;
const cache = { at: 0, payload: null };

async function loadFromDisk() {
  try {
    const text = await readFile(CACHE_FILE, 'utf8');
    const j = JSON.parse(text);
    if (j && j.at && Date.now() - j.at < DISK_TTL_MS && j.payload) return j.payload;
  } catch {
    // 无文件 / 解析失败：忽略
  }
  return null;
}

async function saveToDisk(payload) {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    const tmp = `${CACHE_FILE}.tmp`;
    await writeFile(tmp, JSON.stringify({ at: Date.now(), payload }), 'utf8');
    const { rename } = await import('node:fs/promises');
    await rename(tmp, CACHE_FILE);
  } catch (err) {
    console.warn('[vscm] 写盘失败（不影响内存缓存）:', err.message);
  }
}

export function clearProductsCache({ hard = false } = {}) {
  cache.at = 0;
  cache.payload = null;
  if (hard) unlink(CACHE_FILE).catch(() => {});
}

export async function listProductsCached(opts = {}) {
  // 1) 内存
  if (cache.payload && Date.now() - cache.at < MEM_TTL_MS) {
    return cache.payload;
  }
  // 2) 磁盘（每次内存 miss 都重读，不是一次性 gate；磁盘读 ~1ms 没事）
  const fromDisk = await loadFromDisk();
  if (fromDisk) {
    cache.at = Date.now();
    cache.payload = fromDisk;
    return fromDisk;
  }
  // 3) 都没 → 跑一次领猫
  const data = await listProducts(opts);
  cache.at = Date.now();
  cache.payload = data;
  saveToDisk(data).catch(() => {});
  return data;
}

export async function listProducts({ pageSize = 100, since = null, maxPages = 10 } = {}) {
  // 增量：用 since 作为 modifiedBegin（≤ 7 天）
  if (since) {
    const begin = new Date(since);
    const end = new Date();
    let cursorEnd = end.getTime();
    const collected = [];
    while (cursorEnd > begin.getTime()) {
      let cursorBegin = Math.max(begin.getTime(), cursorEnd - WINDOW_MS);
      const win = await fetchWindow({
        pageSize,
        modifiedBegin: new Date(cursorBegin).toISOString(),
        modifiedEnd: new Date(cursorEnd).toISOString(),
        maxPages,
      });
      collected.push(...win.items);
      if (!win.totalCount) break;
      cursorEnd = cursorBegin - 1;
    }
    return dedupe({ items: collected, totalCount: collected.length });
  }

  // 全量：默认回溯 FULL_LOOKBACK_DAYS 天（30 天 ≈ 5 个窗口），避免撞 500/min 限频
  const now = Date.now();
  const horizon = now - FULL_LOOKBACK_MS;
  const collected = [];
  let cursorEnd = now;
  let safety = 200; // 兜底：最多 200 个窗口（约 3.8 年覆盖）
  while (cursorEnd > horizon && safety-- > 0) {
    const cursorBegin = Math.max(horizon, cursorEnd - WINDOW_MS);
    const win = await fetchWindow({
      pageSize,
      modifiedBegin: new Date(cursorBegin).toISOString(),
      modifiedEnd: new Date(cursorEnd).toISOString(),
      maxPages,
    });
    collected.push(...win.items);
    cursorEnd = cursorBegin - 1; // 前移一个窗口
  }
  return dedupe({ items: collected, totalCount: collected.length });
}

function dedupe({ items, totalCount }) {
  const seen = new Set();
  const out = [];
  for (const x of items) {
    const k = (x.pdtCode || '').toLowerCase() || Math.random().toString(36).slice(2);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return { items: out, totalCount };
}

// ── DTO → 我们内部的 Product 形状（基础资料层——只取领猫权威字段） ──
// 价格/库存/画像/指标等业务字段由 BI 覆盖（在 routes 里完成 JOIN），领猫不填
export function mapProduct(dto) {
  const skus = Array.isArray(dto.skus) ? dto.skus : [];
  // 领猫 SKU 维度的成本：skcCostPrice 才是实际成本，costPrice 经常为 0
  // 优先取主色 SKU；没有标主色时取第一个 skcCostPrice/costPrice 非 0 的 SKU
  const mainSku = skus.find((s) => s.isMainColor)
    || skus.find((s) => Number(s.skcCostPrice) > 0 || Number(s.costPrice) > 0)
    || skus[0]
    || {};
  const colors = [...new Set(skus.map((s) => s.colorName).filter(Boolean))];
  const id = (dto.pdtCode || '').trim();
  const skuCost = Number(mainSku.skcCostPrice) || Number(mainSku.costPrice) || 0;
  return {
    id: id.toLowerCase(),
    rawCode: id,
    name: dto.pdtName || '',
    sub: dto.smName || '',
    img: dto.imgUrl || (dto.imgUrls || [])[0] || '',
    imgSource: '领猫',
    colors,
    // 以下字段领猫不权威——让位给 BI；routes 用 biOverrides 覆盖
    price: '',
    priceNum: 0,
    // 保留领猫零售价：BI/聚水潭缺失时作为兜底（注意：吊牌价 price 不能兜底，零售价为实际售卖价）
    retailPrice: Number(dto.retailPrice) || 0,
    priceBand: '',
    fabric: null,
    category: '',
    wave: '',
    stockMain: 0,
    inTransit: 0,
    costPrice: skuCost,
    skuCount: skus.length,
    colorCount: colors.length,
    skus: skus.map((s) => ({
      skuCode: s.skuCode || '',
      colorName: s.colorName || '',
      sizeName: s.sizeName || '',
      isMainColor: Boolean(s.isMainColor),
      costPrice: Number(s.skcCostPrice) || Number(s.costPrice) || 0,
    })),
    // 指标字段先填兜底（BI 来覆盖）
    conversion: 0,
    returnRate: 0,
    newBuyer: 0,
    netSales: 0,
    plannedQty: 0,
    orderedQty: 0,
    tempBand: '',
    roles: [],
    ai: null,
    aiReason: null,
    restock: null,
    mprice: null,
    priceNote: null,
    stock: [],
    modifyTime: dto.modifyTime || null,
    forecastNetSales: null,
    forecastPostShipReturn: null,
  };
}

// ── 样衣（Research）客户端 ──
// 接口：POST /v1/research/getsampleclothings
// 与 Product 区别：
//   - 字段名驼峰：smCode / smName / skus / imgUrl
//   - 支持 smCodes 精确查（多个逗号分隔，与时间不能同时为空）
//   - 同样 modifiedBegin/modifiedEnd ≤ 7 天的窗口限制
// 用途：样衣创建但未转大货的款号（如 ME15FW015）只在此处能查到

const SAMPLE_CACHE_FILE = join(CACHE_DIR, 'vscm_samples.json');
const SAMPLE_MEM_TTL_MS = 60_000;
const SAMPLE_BYCODE_TTL_MS = 30_000;

const sampleCache = { at: 0, payload: null };
const sampleByCodeCache = new Map(); // key(逗号分隔小写款号) → { at, data }

export function clearSamplesCache({ hard = false } = {}) {
  sampleCache.at = 0;
  sampleCache.payload = null;
  sampleByCodeCache.clear();
  if (hard) unlink(SAMPLE_CACHE_FILE).catch(() => {});
}

async function loadSamplesFromDisk() {
  try {
    const text = await readFile(SAMPLE_CACHE_FILE, 'utf8');
    const j = JSON.parse(text);
    if (j && j.at && Date.now() - j.at < DISK_TTL_MS && j.payload) return j.payload;
  } catch { /* */ }
  return null;
}

async function saveSamplesToDisk(payload) {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    const tmp = `${SAMPLE_CACHE_FILE}.tmp`;
    await writeFile(tmp, JSON.stringify({ at: Date.now(), payload }), 'utf8');
    const { rename } = await import('node:fs/promises');
    await rename(tmp, SAMPLE_CACHE_FILE);
  } catch (err) {
    console.warn('[vscm/samples] 写盘失败（不影响内存缓存）:', err.message);
  }
}

// 全量列表：内存 60s + 磁盘 24h
export async function listSamplesCached(opts = {}) {
  if (sampleCache.payload && Date.now() - sampleCache.at < SAMPLE_MEM_TTL_MS) {
    return sampleCache.payload;
  }
  const fromDisk = await loadSamplesFromDisk();
  if (fromDisk) {
    sampleCache.at = Date.now();
    sampleCache.payload = fromDisk;
    return fromDisk;
  }
  const data = await listSamples(opts);
  sampleCache.at = Date.now();
  sampleCache.payload = data;
  saveSamplesToDisk(data).catch(() => {});
  return data;
}

async function fetchSampleWindow({ pageSize, modifiedBegin, modifiedEnd, maxPages }) {
  const out = [];
  let pageIndex = 1;
  let totalCount = 0;
  while (pageIndex <= maxPages) {
    const body = { pageIndex, pageSize, modifiedBegin, modifiedEnd };
    const json = await call('/v1/research/getsampleclothings', body);
    const data = json.data || {};
    const items = data.datas || [];
    totalCount = data.totalCount || items.length;
    for (const dto of items) out.push(dto);
    if (!data.hasNext) break;
    pageIndex += 1;
  }
  return { items: out, totalCount };
}

function dedupeSamples({ items, totalCount }) {
  const seen = new Set();
  const out = [];
  for (const x of items) {
    const k = (x.smCode || '').toLowerCase() || Math.random().toString(36).slice(2);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return { items: out, totalCount };
}

async function listSamples({ pageSize = 100, since = null, maxPages = 10 } = {}) {
  if (since) {
    const begin = new Date(since);
    const end = new Date();
    let cursorEnd = end.getTime();
    const collected = [];
    while (cursorEnd > begin.getTime()) {
      const cursorBegin = Math.max(begin.getTime(), cursorEnd - WINDOW_MS);
      const win = await fetchSampleWindow({
        pageSize,
        modifiedBegin: new Date(cursorBegin).toISOString(),
        modifiedEnd: new Date(cursorEnd).toISOString(),
        maxPages,
      });
      collected.push(...win.items);
      if (!win.totalCount) break;
      cursorEnd = cursorBegin - 1;
    }
    return dedupeSamples({
      items: collected.map(mapSample),
      totalCount: collected.length,
    });
  }
  const now = Date.now();
  const horizon = now - FULL_LOOKBACK_MS;
  const collected = [];
  let cursorEnd = now;
  let safety = 200;
  while (cursorEnd > horizon && safety-- > 0) {
    const cursorBegin = Math.max(horizon, cursorEnd - WINDOW_MS);
    const win = await fetchSampleWindow({
      pageSize,
      modifiedBegin: new Date(cursorBegin).toISOString(),
      modifiedEnd: new Date(cursorEnd).toISOString(),
      maxPages,
    });
    collected.push(...win.items);
    cursorEnd = cursorBegin - 1;
  }
  return dedupeSamples({
    items: collected.map(mapSample),
    totalCount: collected.length,
  });
}

// 精确查（按 smCodes 逗号分隔）：单次调用，不写盘；30s 内存缓存防抖
export async function listSampleByCodes(codes) {
  if (!Array.isArray(codes) || !codes.length) return { items: [], totalCount: 0 };
  const key = codes.map((c) => String(c).trim().toLowerCase()).sort().join(',');
  const hit = sampleByCodeCache.get(key);
  if (hit && Date.now() - hit.at < SAMPLE_BYCODE_TTL_MS) return hit.data;
  const smCodes = codes.map((c) => String(c).trim()).filter(Boolean).join(',');
  const json = await call('/v1/research/getsampleclothings', {
    pageIndex: 1,
    pageSize: Math.max(25, Math.min(100, codes.length * 2)),
    smCodes,
  });
  const data = json.data || {};
  const items = (data.datas || []).map(mapSample);
  const result = { items, totalCount: items.length };
  sampleByCodeCache.set(key, { at: Date.now(), data: result });
  return result;
}

// DTO → Sample 形状
// - 保留样衣阶段独有字段（planStatusName/designer/brandName/skus/...）
// - 业务字段（价格/库存/计划量）样衣阶段基本无值，留 0/空/[]
// - 同时投影到 Product 同名字段，让 /api/products/:id fallback 能直接复用
export function mapSample(dto) {
  const id = (dto.smCode || '').trim();
  const skus = Array.isArray(dto.skus) ? dto.skus : [];
  const colors = [...new Set(skus.map((s) => s.colorName).filter(Boolean))];
  return {
    id: id.toLowerCase(),
    rawCode: id,
    name: dto.smName || '',
    sub: '',
    img: dto.imgUrl || (dto.imgUrls || [])[0] || '',
    imgSource: '领猫-样衣',
    colors,
    category: dto.ctgName || '',
    wave: [dto.yearName, dto.seasonName].filter(Boolean).join('-'),
    bandCode: dto.bandCode || '',
    bandName: dto.bandName || '',
    fabric: null,
    price: '',
    priceNum: 0,
    priceBand: '',
    costPrice: Number(dto.costPrice) || 0,
    smPrice: Number(dto.smPrice) || 0,
    financePrice: Number(dto.financePrice) || 0,
    retailPrice: Number(dto.retailPrice) || 0,
    skuCount: skus.length,
    colorCount: colors.length,
    stockMain: 0,
    inTransit: 0,
    conversion: 0,
    returnRate: 0,
    newBuyer: 0,
    cartRate: 0,
    netSales: 0,
    plannedQty: 0,
    orderedQty: 0,
    tempBand: '',
    roles: [],
    ai: null,
    aiReason: null,
    restock: null,
    mprice: null,
    priceNote: null,
    stock: [],
    forecastNetSales: null,
    forecastPostShipReturn: null,
    modifyTime: dto.modifyTime || null,
    createTime: dto.createTime || null,
    // 样衣独有字段
    stage: 'sample',
    planStatus: dto.planStatus ?? null,
    planStatusName: dto.planStatusName || '',
    smSrcName: dto.smSrcName || '',
    brandCode: dto.brandCode || '',
    brandName: dto.brandName || '',
    seasonCode: dto.seasonCode || '',
    seasonName: dto.seasonName || '',
    yearCode: dto.yearCode || '',
    yearName: dto.yearName || '',
    designer: dto.designer || '',
    designGroupName: dto.designGroupName || '',
    sizeGroupName: dto.sizeGroupName || '',
    sex: dto.sex || '',
    isPicked: dto.isPicked ?? null,
    isDisable: dto.isDisable ?? null,
    skus: skus.map((s) => ({
      smSkuCode: s.smSkuCode || '',
      colorCode: s.colorCode || '',
      colorName: s.colorName || '',
      sizeCode: s.sizeCode || '',
      sizeName: s.sizeName || '',
    })),
  };
}
