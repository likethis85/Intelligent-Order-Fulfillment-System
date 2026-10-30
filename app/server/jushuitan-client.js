// 聚水潭 (Jushuitan) ERP OpenAPI 客户端
// 核心能力：
//   1. 统一 MD5 签名生成（ASCII 字典升序 key+val，拼接 app_secret）
//   2. 自动 Token 管理（/openWeb/auth/getInitToken，30 天有效期，磁盘与内存多级缓存）
//   3. 商品/SKU 基础资料拉取（/open/mall/item/query, /open/sku/query）
//   4. 实时库存查询（/open/inventory/query，现存、可用、锁库、在途数）

import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CACHE_DIR = join(__dirname, '.cache');
const TOKEN_CACHE_FILE = join(CACHE_DIR, 'jushuitan_token.json');

// 兜底读取 .env
const envFile = join(__dirname, '.env');
if (existsSync(envFile)) {
  if (typeof process.loadEnvFile === 'function') {
    try { process.loadEnvFile(envFile); } catch {}
  }
  try {
    const raw = readFileSync(envFile, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        const k = trimmed.slice(0, idx).trim();
        const v = trimmed.slice(idx + 1).trim();
        if (k && !process.env[k]) {
          process.env[k] = v;
        }
      }
    }
  } catch {}
}

function getEnvValue(keyName) {
  if (process.env[keyName]) return process.env[keyName];
  const found = Object.keys(process.env).find((k) => k.trim().endsWith(keyName));
  return found ? process.env[found] : '';
}

export function getJushuitanConfig() {
  const baseUrl = (getEnvValue('JUSHUITAN_BASE_URL') || 'https://openapi.jushuitan.com').trim().replace(/\/+$/, '');
  const appKey = getEnvValue('JUSHUITAN_APP_KEY').trim();
  const appSecret = getEnvValue('JUSHUITAN_APP_SECRET').trim();

  return {
    baseUrl,
    appKey,
    appSecret,
    configured: Boolean(appKey && appSecret),
  };
}

export function isJushuitanConfigured() {
  return getJushuitanConfig().configured;
}

// 聚水潭标准 MD5 签名算法：
// 1. 将所有参与请求的参数键值（除 sign 以外）按 ASCII 字典升序排序；
// 2. 依次拼接成 key1value1key2value2... 字符串；
// 3. 将 app_secret 拼接到最前端：app_secret + key1value1...；
// 4. 计算 32 位小写 MD5。
export function signJushuitanParams(params, appSecret) {
  const keys = Object.keys(params).filter((k) => k !== 'sign').sort();
  let str = String(appSecret || '');
  for (const k of keys) {
    str += k + String(params[k] ?? '');
  }
  return crypto.createHash('md5').update(str, 'utf8').digest('hex');
}

// 内存中的 Token 缓存
let memToken = null;

// 获取或刷新 access_token
export async function getAccessToken({ forceRefresh = false } = {}) {
  const cfg = getJushuitanConfig();
  if (!cfg.configured) {
    throw new Error('聚水潭 JUSHUITAN_APP_KEY / JUSHUITAN_APP_SECRET 未配置（看 server/.env）');
  }

  const now = Date.now();

  // 1. 尝试从内存缓存使用
  if (!forceRefresh && memToken && memToken.expiresAt && now < memToken.expiresAt - 10 * 60 * 1000) {
    return memToken.accessToken;
  }

  // 2. 尝试从磁盘缓存装载
  if (!forceRefresh) {
    try {
      if (existsSync(TOKEN_CACHE_FILE)) {
        const text = await readFile(TOKEN_CACHE_FILE, 'utf8');
        const disk = JSON.parse(text);
        if (disk && disk.accessToken && disk.expiresAt && now < disk.expiresAt - 10 * 60 * 1000) {
          memToken = disk;
          return disk.accessToken;
        }
      }
    } catch {}
  }

  // 3. 请求接口获取初始 Token
  await mkdir(CACHE_DIR, { recursive: true });
  const timestamp = Math.floor(now / 1000);
  const params = {
    app_key: cfg.appKey,
    timestamp: String(timestamp),
    grant_type: 'authorization_code',
    charset: 'utf-8',
    code: '123456',
  };
  params.sign = signJushuitanParams(params, cfg.appSecret);

  const url = `${cfg.baseUrl}/openWeb/auth/getInitToken`;
  const body = new URLSearchParams(params).toString();

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`聚水潭 getInitToken HTTP 异常 ${res.status}`);
  }

  const json = await res.json();
  if (json.code !== 0 || !json.data) {
    throw new Error(`聚水潭获取 Token 失败 (code=${json.code}): ${json.msg || '未知错误'}`);
  }

  const d = json.data;
  const expiresInSec = Number(d.expires_in) || 2592000; // 默认 30 天
  const tokenData = {
    accessToken: d.access_token,
    refreshToken: d.refresh_token,
    coid: d.coid,
    wmsCoid: d.wms_coid,
    savedAt: now,
    expiresAt: now + expiresInSec * 1000,
  };

  memToken = tokenData;
  try {
    await writeFile(TOKEN_CACHE_FILE, JSON.stringify(tokenData, null, 2), 'utf8');
  } catch (err) {
    console.warn('[jushuitan] 缓存 Token 磁盘失败:', err.message);
  }

  return tokenData.accessToken;
}

// 基础 HTTP 请求封装
export async function requestJushuitan(path, bizObj = {}, options = {}) {
  const cfg = getJushuitanConfig();
  if (!cfg.configured) {
    throw new Error('聚水潭配置缺失');
  }

  const token = await getAccessToken({ forceRefresh: options.forceRefresh });
  const timestamp = Math.floor(Date.now() / 1000);
  const params = {
    app_key: cfg.appKey,
    access_token: token,
    timestamp: String(timestamp),
    version: '2',
    charset: 'utf-8',
    biz: JSON.stringify(bizObj),
  };
  params.sign = signJushuitanParams(params, cfg.appSecret);

  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  const url = `${cfg.baseUrl}${cleanPath}`;
  const body = new URLSearchParams(params).toString();

  const ctrl = new AbortController();
  const timeoutMs = options.timeoutMs || 25000;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      },
      body,
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      throw new Error(`聚水潭请求 ${cleanPath} HTTP 异常 ${res.status}`);
    }

    const json = await res.json();
    if (json.code !== 0) {
      // 若 Token 过期错误，重试一次强制刷新
      if ((json.code === 104 || json.msg?.includes('token') || json.msg?.includes('令牌')) && !options._retried) {
        console.warn('[jushuitan] Token 可能失效，尝试强制刷新后重试...');
        return requestJushuitan(path, bizObj, { ...options, forceRefresh: true, _retried: true });
      }
      throw new Error(`聚水潭 API 报错 (code=${json.code}): ${json.msg || '未知错误'}`);
    }

    return json.data ?? json;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// 规格属性值解析（将 "藏青;155/62A(XS)" 解析出颜色与尺码）
export function parseColorAndSizeFromProps(propValue) {
  if (!propValue || typeof propValue !== 'string') {
    return { color: '', size: '' };
  }
  const parts = propValue.split(';').map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return { color: parts[0], size: parts[1] };
  }
  if (parts.length === 1) {
    const s = parts[0];
    if (/^(\d{2,3}\/\d{2,3}[A-Z]?|[XSML]{1,4}|均码|F)$/i.test(s)) {
      return { color: '', size: s };
    }
    return { color: s, size: '' };
  }
  return { color: '', size: '' };
}

// 聚水潭查询接口的硬限制：i_ids 一次最多 20 个，且不能重复。
// 超了接口直接报 code=170（实时库存）/ code=130（商品资料），整批失败——
// 所以只要一次请求超过 20 款，这批的库存和商品资料就全拿不到（BI 兜底形同失效）。
export const JST_MAX_IDS = 20;

/** 按接口上限切批：去重、去空、每批不超过 max 个款号 */
export function chunkPidsByMax(pids = [], max = JST_MAX_IDS) {
  const clean = [...new Set(pids.map((p) => String(p).trim()).filter(Boolean))];
  const out = [];
  for (let i = 0; i < clean.length; i += max) out.push(clean.slice(i, i + max));
  return out;
}

// ── 业务接口 1: 按款号列表查询商品资料（SPU 维度 + SKU 列表） ──
export async function getItemsByPids(pids = []) {
  if (!Array.isArray(pids) || pids.length === 0) {
    return { items: [], byPid: {} };
  }

  const items = [];
  const byPid = {};

  for (const chunk of chunkPidsByMax(pids)) {
    try {
      const data = await requestJushuitan('/open/mall/item/query', {
        i_ids: chunk,
        page_index: 1,
        page_size: JST_MAX_IDS,
      });

      const rawItems = Array.isArray(data?.datas) ? data.datas : [];
      for (const raw of rawItems) {
        const pid = raw.i_id;
        const skus = (raw.skus || []).map((s) => {
          const parsed = parseColorAndSizeFromProps(s.properties_value);
          return {
            skuId: s.sku_id,
            pid: s.i_id || pid,
            properties: s.properties_value || '',
            color: s.color || parsed.color,
            size: parsed.size,
            name: s.name || raw.name,
            enabled: Boolean(s.enabled),
            stockDisabled: Boolean(s.stock_disabled),
            salePrice: Number(s.sale_price) || 0,
            marketPrice: Number(s.market_price) || 0,
            costPrice: s.cost_price != null ? Number(s.cost_price) : null,
            pic: s.pic || s.pic_big || raw.pic || raw.pic_big || null,
          };
        });

        const item = {
          pid,
          name: raw.name,
          brand: raw.brand || 'MARIUS',
          category: raw.category || '',
          pic: raw.pic || raw.pic_big || null,
          skus,
        };

        items.push(item);
        byPid[pid] = item;
        byPid[pid.toLowerCase()] = item;
      }
    } catch (err) {
      console.warn(`[jushuitan] 拉取款号 [${chunk.join(',')}] 商品资料失败:`, err.message);
    }
  }

  return { items, byPid };
}

// ── 业务接口 2: 按款号列表查询实时库存 ──
// 可查各仓现存总数 (qty)、可用数 (available = qty - order_lock - pick_lock)、订单锁库 (order_lock)、在途采购数 (purchase_qty)
// 注意：单个款号可能有多个 SKU 行（一色一码一行），20 个款号就能超过单页 100 条，
// 所以必须翻页，否则库存会被静默截断（只统计到前 100 行）。
export async function getInventoryByPids(pids = [], { pageSize = 100, maxPages = 20 } = {}) {
  if (!Array.isArray(pids) || pids.length === 0) {
    return { byPid: {}, items: [] };
  }

  const cleanPids = [...new Set(pids.map((p) => String(p).trim()).filter(Boolean))];
  const byPid = {};
  const allInventories = [];
  const seenRows = new Set();

  for (const chunk of chunkPidsByMax(cleanPids)) {
    try {
      for (let page = 1; page <= maxPages; page++) {
        const data = await requestJushuitan('/open/inventory/query', {
          i_ids: chunk.join(','),
          wms_co_id: 0,
          page_index: page,
          page_size: pageSize,
        });

        const invs = Array.isArray(data?.inventorys) ? data.inventorys : [];
        let fresh = 0;
        for (const inv of invs) {
          // 防重复：若接口忽略 page_index 反复返回同一页，这里直接跳过，避免库存被重复累加
          const rowKey = `${inv.i_id}|${inv.sku_id ?? `${inv.qty}|${inv.order_lock}|${inv.modified}`}`;
          if (seenRows.has(rowKey)) continue;
          seenRows.add(rowKey);
          fresh += 1;

          allInventories.push(inv);
          const pid = inv.i_id;
          const pidLower = pid.toLowerCase();
          if (!byPid[pid]) {
            byPid[pid] = {
              pid,
              name: inv.name,
              totalQty: 0,
              availableQty: 0,
              orderLock: 0,
              pickLock: 0,
              purchaseQty: 0,
              allocateQty: 0,
              defectiveQty: 0,
              skus: {},
            };
            byPid[pidLower] = byPid[pid];
          }

          const qty = Number(inv.qty) || 0;
          const orderLock = Number(inv.order_lock) || 0;
          const pickLock = Number(inv.pick_lock) || 0;
          const purchaseQty = Number(inv.purchase_qty) || 0;
          const allocateQty = Number(inv.allocate_qty) || 0;
          const defectiveQty = Number(inv.defective_qty) || 0;
          const availableQty = Math.max(0, qty - orderLock - pickLock);

          byPid[pid].totalQty += qty;
          byPid[pid].availableQty += availableQty;
          byPid[pid].orderLock += orderLock;
          byPid[pid].pickLock += pickLock;
          byPid[pid].purchaseQty += purchaseQty;
          byPid[pid].allocateQty += allocateQty;
          byPid[pid].defectiveQty += defectiveQty;

          if (inv.sku_id) {
            byPid[pid].skus[inv.sku_id] = {
              skuId: inv.sku_id,
              qty,
              availableQty,
              orderLock,
              pickLock,
              purchaseQty,
              defectiveQty,
              modified: inv.modified,
            };
          }
        }

        // 空页、没满页、或整页都是重复数据 → 结束翻页
        if (invs.length < pageSize || fresh === 0) break;
      }
    } catch (err) {
      console.warn(`[jushuitan] 查询款号 [${chunk.join(',')}] 实时库存失败:`, err.message);
    }
  }

  return { byPid, items: allInventories };
}

// ── 业务接口 3: 聚水潭连通性与授权状态检查 ──
export async function getJushuitanStatus() {
  const cfg = getJushuitanConfig();
  if (!cfg.configured) {
    return { configured: false, error: 'missing_credentials' };
  }
  try {
    const token = await getAccessToken();
    return {
      configured: true,
      ok: true,
      baseUrl: cfg.baseUrl,
      appKey: cfg.appKey,
      coid: memToken?.coid,
      expiresAt: memToken?.expiresAt ? new Date(memToken.expiresAt).toISOString() : null,
      tokenMasked: token ? `${token.slice(0, 6)}...${token.slice(-4)}` : null,
    };
  } catch (err) {
    return {
      configured: true,
      ok: false,
      error: err.message,
    };
  }
}
