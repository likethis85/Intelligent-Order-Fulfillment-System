import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getToken } from './vscm-client.js';

const BASE = process.env.VSCM_BASE_URL || 'https://open.scm321.com';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// 允许测试把缓存文件指到临时目录（FABRIC_CACHE_FILE），避免碰到线上 data 目录
const FABRIC_CACHE_FILE = process.env.FABRIC_CACHE_FILE || path.join(__dirname, 'data', 'fabric-query-cache.json');

// 款号级面料结果缓存（内存 + 磁盘持久化，4 小时 TTL）
// 查过的款号秒回（< 5ms），大幅减轻领猫 SCM API 压力与限流
const fabricQueryCache = new Map(); // key (uppercase) -> { time: number, data: any[], ttl?: number }
const FABRIC_CACHE_TTL_MS = 4 * 60 * 60 * 1000;
// 物料基础信息（规格名称 / 颜色）没查到的结果别锁 4 小时：
// 上游一次限流或超时会让整批行都是 "-"，再缓存 4 小时等于让人一直看不到数据。
// 这种结果只缓存 2 分钟，下次打开就会重试。
const FABRIC_CACHE_RETRY_MS = 2 * 60 * 1000;

function cacheItemFresh(item, now = Date.now()) {
  if (!item || !item.time || !item.data) return false;
  return now - item.time < (item.ttl || FABRIC_CACHE_TTL_MS);
}

// 升级前写进缓存的「失败结果」：整片没有规格名/颜色，却没有 verified 标记。
// 这种条目不作数，重新查一次（线上 ME14DW013 / ME14FF036 就是被它锁到现在的）。
function isLegacyFailedRows(item) {
  if (!item || item.verified !== undefined) return false;
  const rows = Array.isArray(item.data) ? item.data : [];
  if (rows.length === 0) return false;
  return rows.every((r) => (!r?.mtSpecName || r.mtSpecName === '-') && (!r?.colorName || r.colorName === '-'));
}

function loadFabricCacheFromDisk() {
  try {
    if (fs.existsSync(FABRIC_CACHE_FILE)) {
      const raw = fs.readFileSync(FABRIC_CACHE_FILE, 'utf-8');
      const json = JSON.parse(raw);
      const now = Date.now();
      let count = 0;
      for (const [code, item] of Object.entries(json)) {
        if (item && Array.isArray(item.data) && cacheItemFresh(item, now)) {
          fabricQueryCache.set(code.toUpperCase(), item);
          count++;
        }
      }
      if (count > 0) {
        console.log(`[fabric-cache] 已从磁盘载入 ${count} 个款号的面料缓存`);
      }
    }
  } catch (err) {
    console.warn('[fabric-cache] 载入磁盘缓存失败:', err.message);
  }
}

let saveCacheTimer = null;
function saveFabricCacheToDiskDebounced() {
  if (saveCacheTimer) return;
  saveCacheTimer = setTimeout(() => {
    saveCacheTimer = null;
    try {
      const dir = path.dirname(FABRIC_CACHE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const obj = {};
      const now = Date.now();
      for (const [k, v] of fabricQueryCache.entries()) {
        if (cacheItemFresh(v, now)) {
          obj[k] = v;
        }
      }
      fs.writeFileSync(FABRIC_CACHE_FILE, JSON.stringify(obj, null, 2), 'utf-8');
    } catch (err) {
      console.error('[fabric-cache] 写入磁盘失败:', err.message);
    }
  }, 2000);
}

// 启动时载入持久化缓存
loadFabricCacheFromDisk();

// 采购查询结果内存缓存（在途/交期按天级变化，60分钟内复用）
const purchaseBillsCache = new Map(); // key -> { time, data }
const PO_CACHE_TTL_MS = 60 * 60 * 1000;

function isFabricMaterial(mtType) {
  if (!mtType) return false;
  return mtType === '面料' || mtType === '里料';
}

function isYarnMaterial(mtCode, mtName) {
  return /纱线|毛线/.test(`${mtCode || ''}${mtName || ''}`);
}

async function scmPost(path, body) {
  const token = await getToken();
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) {
    throw new Error(`${path} HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * 获取款式的 SKU 列表（用于强制添加时创建空白记录）
 */
export async function getProductSkus(pdtCode) {
  const result = await scmPost('/v1/product/getproducts', {
    pageSize: 0,
    pageIndex: 0,
    modifiedBegin: '',
    modifiedEnd: '',
    codes: pdtCode,
  });

  if (result.code === 258 || String(result.code) === '258' || (result.msg && result.msg.includes('258'))) {
    return [];
  }
  if (result.code !== 200 && result.code !== 0) {
    throw new Error(`查询SKU列表失败: ${result.msg}`);
  }

  const products = result.data?.datas || [];
  const allSkus = [];
  const seen = new Set();
  for (const product of products) {
    const pdtName = product.pdtName || '';
    const skuArr = Array.isArray(product.skus) ? product.skus : [];
    for (const sku of skuArr) {
      const skuCode = (sku.skuCode || '').trim();
      if (!skuCode || seen.has(skuCode)) continue;
      seen.add(skuCode);
      const cfgValue = (sku.color?.cfgValue || '').trim();
      const colorName = (sku.colorName || '').trim();
      allSkus.push({
        skuCode,
        skuName: pdtName || '',
        skuCorlorName: colorName || cfgValue,
      });
    }
  }
  return allSkus;
}

/**
 * 样衣款号（未转大货）在样衣接口查询 SKU
 */
export async function getSampleSkus(pdtCode) {
  const result = await scmPost('/v1/research/getsampleclothings', {
    pageIndex: 1,
    pageSize: 100,
    smCodes: pdtCode,
  });

  if (result.code === 258 || String(result.code) === '258' || (result.msg && result.msg.includes('258'))) {
    return [];
  }
  if (result.code !== 200 && result.code !== 0) {
    return [];
  }

  const items = result.data?.datas || [];
  const allSkus = [];
  const seen = new Set();
  for (const item of items) {
    const smName = item.smName || '';
    const skuArr = Array.isArray(item.skus) ? item.skus : [];
    for (const sku of skuArr) {
      const skuCode = (sku.smSkuCode || '').trim();
      if (!skuCode || seen.has(skuCode)) continue;
      seen.add(skuCode);
      allSkus.push({
        skuCode,
        skuName: smName,
        skuCorlorName: (sku.colorName || '').trim(),
      });
    }
  }
  return allSkus;
}

async function getMaterialBaseInfoForSample(mtCodes) {
  const typeMap = new Map();
  const specMap = new Map();
  const supplierMap = new Map();
  if (!mtCodes) return { typeMap, specMap, supplierMap, ok: true };
  // ok=false：上游失败，规格/颜色只能留空 —— 调用方据此缩短缓存，别把空结果锁几小时
  let ok = false;

  let pageIndex = 1;
  while (true) {
    const result = await scmPost('/v1/BaseInfo/Getmaterials', {
      codes: mtCodes,
      pageIndex,
      pageSize: 100,
    });
    if (result.code !== 200 && result.code !== 0) {
      console.warn(`[fabric] 面料基础信息返回 code=${result.code} ${result.msg || ''}（${mtCodes}），规格/颜色先留空`);
      break;
    }
    const data = result.data || {};
    const items = data.datas || [];
    if (items.length === 0) break;
    ok = true;

    for (const item of items) {
      const mtCode = (item.mtCode || '').trim();
      const mtType = String(item.mtType || '').trim();
      if (mtCode && mtType) typeMap.set(mtCode, mtType);

      const supplierName = (item.supplierName || '').trim();
      if (mtCode && supplierName) supplierMap.set(mtCode, supplierName);

      const subs = Array.isArray(item.subs) ? item.subs : [];
      for (const sub of subs) {
        const mtSubCode = (sub.mtSubCode || '').trim();
        if (!mtSubCode) continue;
        specMap.set(mtSubCode, {
          colorCode: (sub.colorCode || '').trim(),
          colorName: (sub.colorName || '').trim(),
          spColorName: (sub.spColorName || '').trim(),
        });
      }
    }
    const total = data.total || 0;
    if (pageIndex * 100 >= total) break;
    pageIndex++;
  }
  return { typeMap, specMap, supplierMap, ok };
}

async function getSampleDevMaterials(smCode) {
  const upperCode = smCode.toUpperCase();
  const now = new Date();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const WINDOW_DAYS = 7;
  const windows = [];
  for (let i = 0; i < 5; i++) {
    const end = new Date(now.getTime() - i * WINDOW_DAYS * DAY_MS);
    const begin = new Date(end.getTime() - WINDOW_DAYS * DAY_MS + 3600 * 1000);
    windows.push({ begin, end });
  }

  async function fetchWindowPage(win, pageIndex, devCodes) {
    const body = {
      modifiedBegin: win.begin.toISOString(),
      modifiedEnd: win.end.toISOString(),
      pageIndex,
      pageSize: 100,
    };
    if (devCodes && devCodes.length > 0) body.devCodes = devCodes;
    return scmPost('/v1/Research/GetSampleDevMaterialBomList', body);
  }

  let smDevCode;
  for (const win of windows) {
    const result = await fetchWindowPage(win, 1);
    if (result.code !== 200 && result.code !== 0) continue;
    const datas = result.data?.datas || [];
    const match = datas.find((it) => (it.smCode || '').toUpperCase() === upperCode);
    if (match?.smDevCode) {
      smDevCode = String(match.smDevCode).trim();
      break;
    }
  }

  const allDatas = [];
  for (const win of windows) {
    let pageIndex = 1;
    while (pageIndex <= 20) {
      const result = await fetchWindowPage(win, pageIndex, smDevCode ? [smDevCode] : undefined);
      if (result.code !== 200 && result.code !== 0) break;
      const datas = result.data?.datas || [];
      allDatas.push(...datas);
      if (!result.data?.hasNext || datas.length === 0) break;
      pageIndex++;
    }
  }

  const materialCodes = [...new Set(allDatas
    .filter((it) => (it.smCode || '').toUpperCase() === upperCode)
    .map((it) => (it.materialCode || '').trim()))].sort().join(',');
  const { typeMap: mtTypeMap, specMap: mtSpecMap, supplierMap: mtSupplierMap, ok: baseInfoOk } = await getMaterialBaseInfoForSample(materialCodes);
  // 样衣 BOM 同样要查真实库存：以前这里把 stock 写死 0，导致样衣款（没有大货标准 BOM）
  // 在面料查询里永远显示 0 库存。库存接口按物料规格码（materialSubCode）匹配，和标准 BOM 同一口径。
  const stockQueryCodes = [...new Set(allDatas
    .filter((it) => (it.smCode || '').toUpperCase() === upperCode)
    .filter((it) => {
      const code = (it.materialCode || '').trim();
      return isFabricMaterial(mtTypeMap.get(code) || '') || isYarnMaterial(code, (it.materialName || '').trim());
    })
    .map((it) => (it.materialCode || '').trim()))].sort().join(',');
  const stockMap = stockQueryCodes
    ? await getFabricStock(stockQueryCodes).catch(() => new Map())
    : new Map();

  const seen = new Set();
  const results = [];
  for (const item of allDatas) {
    if ((item.smCode || '').toUpperCase() !== upperCode) continue;
    const materialCode = (item.materialCode || '').trim();
    const realMtType = mtTypeMap.get(materialCode) || '';
    const yarnLike = isYarnMaterial(materialCode, (item.materialName || '').trim());
    if (!isFabricMaterial(realMtType) && !yarnLike) continue;

    const subs = Array.isArray(item.subs) ? item.subs : [];
    for (const sub of subs) {
      const skuCodeRaw = (sub.skuCode || '').trim();
      const skuCode = skuCodeRaw.slice(0, -1);
      const subMaterialSubCode = (sub.materialSubCode || '').trim();
      const key = `${skuCode}__${materialCode}__${subMaterialSubCode}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const mtType = isFabricMaterial(realMtType) ? realMtType : (yarnLike ? '纱线' : ((item.usePart || '').trim() || (item.materialName || '').trim() || '其他'));
      const specInfo = mtSpecMap.get(subMaterialSubCode);
      let mtSpecName = (sub.materialSubSpec || '').trim();
      if (specInfo && (specInfo.colorCode || specInfo.colorName || specInfo.spColorName)) {
        mtSpecName = specInfo.spColorName
          ? `[${specInfo.colorCode}]${specInfo.colorName}-${specInfo.spColorName};`
          : `[${specInfo.colorCode}]${specInfo.colorName};`;
      }
      const useAmt = Number(sub.useAmount) || 0;
      const resultBase = {
        pdtCode: upperCode,
        skuCode: skuCode || '-',
        pdtColorName: (sub.smColorName || '').trim() || '-',
        // 样衣 BOM 自己没带颜色时，用物料基础信息里的颜色兜底（否则整列 "-"）
        colorName: (sub.materialSubColorName || '').trim() || (specInfo?.colorName || '').trim() || '-',
        mtCode: materialCode || '-',
        mtName: (item.materialName || '').trim() || '-',
        mtType,
        supplierName: mtSupplierMap.get(materialCode) || (item.supplierName || '').trim() || '-',
        mtSpecName: mtSpecName || '-',
        useAmt,
      };
      // 库存按物料规格码展开：与标准 BOM 路径一致（有库存的仓各出一行；都凑不到就回落到面料仓/首仓）
      const matchedStocks = [];
      for (const [stockKey, value] of stockMap.entries()) {
        const [mtSpecCode, warehouseCode, warehouseName] = stockKey.split('|');
        if (mtSpecCode === subMaterialSubCode) {
          matchedStocks.push({ warehouseCode, warehouseName, stock: value.stock });
        }
      }
      const stocksWithQty = matchedStocks.filter((s) => s.stock > 0);
      if (stocksWithQty.length > 0) {
        for (const { warehouseName, stock } of stocksWithQty) {
          results.push({
            ...resultBase,
            warehouse: warehouseName,
            stock,
            canProduce: useAmt > 0 ? Math.floor(stock / useAmt) : 0,
          });
        }
      } else if (matchedStocks.length > 0) {
        const fabricWarehouse = matchedStocks.find((s) => s.warehouseCode === 'M01');
        const selected = fabricWarehouse || matchedStocks[0];
        results.push({ ...resultBase, warehouse: selected.warehouseName, stock: 0, canProduce: 0 });
      } else {
        results.push({ ...resultBase, warehouse: '-', stock: 0, canProduce: 0 });
      }
    }
  }
  return { rows: results, baseInfoOk };
}

async function getFabricMaterials(pdtCode) {
  const result = await scmPost('/v1/product/standardbom/getmaterials', { pdtCodes: pdtCode });
  if (result.code === 258 || String(result.code) === '258' || (result.msg && result.msg.includes('258'))) {
    return [];
  }
  if (result.code !== 200 && result.code !== 0) {
    throw new Error(`查询工艺库失败: ${result.msg}`);
  }

  const materials = result.data?.datas || [];
  const fabrics = [];
  const subCodeSeen = new Set();
  for (const item of materials) {
    const yarnLike = isYarnMaterial((item.mtCode || '').trim(), (item.mtName || '').trim());
    if (item.mtType === '面料' || yarnLike) {
      const skuCodeRaw = (item.skuCode || '').trim();
      if (!skuCodeRaw) continue;
      const mtSubCode = (item.mtSubCode || '').trim();
      if (mtSubCode && subCodeSeen.has(mtSubCode)) continue;
      if (mtSubCode) subCodeSeen.add(mtSubCode);

      const pdtColorName = (item.skuCorlorName || '').trim() || '-';
      const skuCode = skuCodeRaw.slice(0, -1);
      fabrics.push({
        mtCode: (item.mtCode || '').trim(),
        mtSubCode,
        skuCode,
        mtName: (item.mtName || '').trim(),
        mtType: item.mtType === '面料' ? item.mtType : (yarnLike ? '纱线' : (item.mtType || '').trim()),
        supplierName: (item.supplierName || '').trim(),
        useAmt: item.useAmt || 0,
        colorCode: (item.colorCode || '').trim(),
        colorName: (item.colorName || '').trim(),
        pdtCode: (item.pdtCode || '').trim(),
        pdtColorName,
        skuSpec: (item.skuSpec || '').trim(),
        mtPrice: parseFloat(item.mtPrice) || 0,
        mtSellPrice: parseFloat(item.mtSellPrice) || 0,
      });
    }
  }
  return fabrics;
}

async function getFabricStock(mtCodes) {
  const stockMap = new Map();
  let pageIndex = 1;
  while (true) {
    const result = await scmPost('/v1/material/getstores', {
      codes: mtCodes,
      pageIndex,
      pageSize: 100,
    });
    if (result.code !== 200 && result.code !== 0) {
      throw new Error(`查询库存失败: ${result.msg}`);
    }
    const data = result.data || {};
    const items = data.datas || [];
    if (items.length === 0) break;

    for (const item of items) {
      const warehouseCode = (item.warehouseCode || '').trim();
      const warehouseName = item.warehouseName || '';
      if (warehouseCode === 'F05') continue;
      const wname = String(warehouseName);
      if (wname.includes('恒隆') || wname.includes('工厂物料')) continue;

      const mtSpecCode = (item.mtSpecCode || '').trim();
      const mtSpecName = (item.mtSpecName || '').trim();
      const key = `${mtSpecCode}|${warehouseCode}|${warehouseName}`;
      const existing = stockMap.get(key);
      if (existing) {
        existing.stock += (item.realQty || 0);
      } else {
        stockMap.set(key, { stock: item.realQty || 0, mtSpecName });
      }
    }
    if (!data.hasNext) break;
    pageIndex++;
  }
  return stockMap;
}

async function getMaterialBaseInfo(mtCodes) {
  const subCodeMap = new Map();
  // ok=false：上游没给数据（失败/限流/空响应）。以前这里静默 break，调用方分不清
  // 「查了但没有」和「没查到」，于是把整批 "-" 当正常结果缓存 4 小时。
  let ok = false;
  let pageIndex = 1;
  while (true) {
    const result = await scmPost('/v1/BaseInfo/Getmaterials', {
      codes: mtCodes,
      pageIndex,
      pageSize: 100,
    });
    if (result.code !== 200 && result.code !== 0) {
      console.warn(`[fabric] 面料基础信息返回 code=${result.code} ${result.msg || ''}（${mtCodes}），规格/颜色先留空`);
      break;
    }
    const data = result.data || {};
    const items = data.datas || [];
    if (items.length === 0) break;
    ok = true;

    for (const item of items) {
      const mtPrice = parseFloat(item.price) || 0;
      const mtCategory = String(item.mtCtg || '').trim();
      const subs = item.subs || [];
      for (const sub of subs) {
        const mtSubCode = (sub.mtSubCode || '').trim();
        if (mtSubCode) {
          subCodeMap.set(mtSubCode, {
            colorCode: (sub.colorCode || '').trim(),
            colorName: (sub.colorName || '').trim(),
            spColorName: (sub.spColorName || '').trim(),
            mtPrice,
            mtCategory,
          });
        }
      }
    }
    const total = data.total || 0;
    if (pageIndex * 100 >= total) break;
    pageIndex++;
  }
  return { subCodeMap, ok };
}

async function fetchPurchaseWindow(mtCodes, modifiedBegin, modifiedEnd, acc, seenBills) {
  let windowTotal = 0;
  let pageIndex = 1;
  while (true) {
    const result = await scmPost('/v1/mtpurchase/getbills', {
      pageIndex,
      pageSize: 100,
      mtCodes,
      modifiedBegin,
      modifiedEnd,
    });
    if (result.code !== 200 && result.code !== 0) return null;
    const data = result.data || {};
    const items = data.datas || [];
    if (pageIndex === 1) windowTotal = data.totalCount || 0;
    if (items.length === 0) break;

    for (const bill of items) {
      const billCode = String(bill.code || '').trim();
      if (billCode) {
        if (seenBills.has(billCode)) continue;
        seenBills.add(billCode);
      }
      if (Number(bill.statuz) !== 1) continue;
      if (String(bill.createUser || '').trim() !== '薛莉莉') continue;
      const subs = bill.subs || [];
      for (const sub of subs) {
        const spec = String(sub.mtSpecCode || '').trim();
        if (!spec) continue;
        const qty = Number(sub.qty) || 0;
        const inQty = Number(sub.inQty) || 0;
        const remaining = Math.max(0, qty - inQty);
        if (qty <= 0 || remaining / qty < 0.2) continue;
        const dDate = sub.deliverDate ? String(sub.deliverDate).slice(0, 10) : '';
        if (dDate && dDate < '2026-03-01') continue;

        const poDetail = {
          poCode: billCode,
          qty,
          inQty,
          remaining,
          deliverDate: dDate,
        };
        const prev = acc.get(spec);
        if (prev) prev.details.push(poDetail);
        else acc.set(spec, { details: [poDetail] });
      }
    }
    if (!data.hasNext) break;
    pageIndex++;
  }
  return windowTotal;
}

async function getPurchaseBills(mtCodes) {
  if (!purchaseBillsCache.has(mtCodes)) purchaseBillsCache.set(mtCodes, {});
  const cached = purchaseBillsCache.get(mtCodes);
  if (cached.time && Date.now() - cached.time < PO_CACHE_TTL_MS && cached.data) {
    return cached.data;
  }

  const acc = new Map();
  const seenBills = new Set();
  const LOOKBACK_WEEKS = 3; // 缩减到 3 周（消除长达 9 周的连续发包阻塞）
  const EARLY_EXIT_AFTER_WEEKS = 2;
  const EARLY_EXIT_IDLE_WEEKS = 1;
  const fmtDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let idleWeeks = 0;
    for (let w = 0; w < LOOKBACK_WEEKS; w++) {
      const end = new Date(today.getTime() - w * 7 * 86400000);
      const beg = new Date(end.getTime() - 6 * 86400000);
      const windowTotal = await fetchPurchaseWindow(mtCodes, fmtDate(beg), fmtDate(end), acc, seenBills);
      if (windowTotal === null) return null;
      if (w + 1 >= EARLY_EXIT_AFTER_WEEKS) {
        idleWeeks = windowTotal === 0 ? idleWeeks + 1 : 0;
        if (idleWeeks >= EARLY_EXIT_IDLE_WEEKS) break;
      }
    }
  } catch {
    return null;
  }

  const resultMap = new Map();
  acc.forEach((v, k) => {
    const sorted = [...v.details].sort((a, b) => (a.deliverDate || '').localeCompare(b.deliverDate || ''));
    const totalInTransit = Math.round(sorted.reduce((sum, d) => sum + d.remaining, 0));
    let best = null;
    for (const d of sorted) {
      if (!best || d.remaining > best.remaining) best = d;
    }
    resultMap.set(k, {
      totalInTransit,
      nearestDate: best?.deliverDate || null,
      details: sorted,
    });
  });
  purchaseBillsCache.set(mtCodes, { time: Date.now(), data: resultMap });
  return resultMap;
}

export async function queryFabricInfo(pdtCode, forceRefresh = false) {
  const normCode = String(pdtCode || '').trim().toUpperCase();
  if (!normCode) return [];

  if (!forceRefresh) {
    const cached = fabricQueryCache.get(normCode);
    if (cacheItemFresh(cached) && !isLegacyFailedRows(cached)) {
      return cached.data;
    }
  }

  const fabrics = await getFabricMaterials(normCode);
  if (fabrics.length === 0) {
    const sample = await getSampleDevMaterials(normCode);
    if (sample.rows.length > 0) {
      fabricQueryCache.set(normCode, {
        time: Date.now(),
        data: sample.rows,
        ttl: sample.baseInfoOk ? undefined : FABRIC_CACHE_RETRY_MS,
        verified: sample.baseInfoOk,
      });
      saveFabricCacheToDiskDebounced();
      return sample.rows;
    }
    return [];
  }

  const mtCodes = [...new Set(fabrics.map((f) => f.mtCode))].sort().join(',');
  const [stockMap, baseInfoResult] = await Promise.all([
    getFabricStock(mtCodes),
    getMaterialBaseInfo(mtCodes),
  ]);
  const subCodeMap = baseInfoResult.subCodeMap;

  async function fetchPOWithRetry() {
    const poPromise = getPurchaseBills(mtCodes);
    const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(null), 3000)); // 3秒超时，不再死等 12s
    return Promise.race([poPromise, timeoutPromise]);
  }
  const billingMap = await fetchPOWithRetry();

  const results = [];
  for (const fabric of fabrics) {
    const useAmt = fabric.useAmt || 0;
    // 规格/颜色以物料基础信息为准，查不到就退回 BOM 行自带的色号/颜色名
    // （BOM 里一直有 colorCode/colorName，上游抽风时也不至于整列 "-"）
    const bomColorCode = (fabric.colorCode || '').trim();
    const bomColorName = (fabric.colorName || '').trim();
    const baseInfo = subCodeMap.get(fabric.mtSubCode);
    const specColorCode = baseInfo?.colorCode || bomColorCode;
    const specColorName = baseInfo?.colorName || bomColorName;
    const specSpColorName = baseInfo?.spColorName || '';
    let mtSpecNameFromBase = '-';
    if (specColorCode || specColorName) {
      mtSpecNameFromBase = specSpColorName
        ? `[${specColorCode}]${specColorName}-${specSpColorName};`
        : `[${specColorCode}]${specColorName};`;
    }
    const colorNameFromBase = specColorName || '-';
    const mtPrice = fabric.mtPrice || (baseInfo ? baseInfo.mtPrice : 0) || 0;
    const mtCategory = (baseInfo ? baseInfo.mtCategory : '') || '';

    let autoInTransit;
    let autoDeliverDate;
    let purchaseOrders;
    if (billingMap) {
      const bil = billingMap.get(fabric.mtSubCode);
      autoInTransit = bil ? bil.totalInTransit : 0;
      autoDeliverDate = bil && bil.nearestDate ? bil.nearestDate : undefined;
      purchaseOrders = bil ? bil.details : [];
    }

    const resultBase = {
      pdtCode: fabric.pdtCode,
      skuCode: fabric.skuCode || '-',
      pdtColorName: fabric.pdtColorName || '-',
      colorName: colorNameFromBase,
      mtCode: fabric.mtCode,
      mtName: fabric.mtName,
      mtType: fabric.mtType || '-',
      supplierName: fabric.supplierName || '-',
      mtSpecName: mtSpecNameFromBase,
      useAmt,
      mtPrice,
      mtCategory,
      inTransitQty: autoInTransit,
      deliverDate: autoDeliverDate,
      purchaseOrders,
    };

    const matchedStocks = [];
    for (const [key, value] of stockMap.entries()) {
      const [mtSpecCode, warehouseCode, warehouseName] = key.split('|');
      if (mtSpecCode === fabric.mtSubCode) {
        matchedStocks.push({ warehouseCode, warehouseName, stock: value.stock });
      }
    }

    const stocksWithQty = matchedStocks.filter((s) => s.stock > 0);
    if (stocksWithQty.length > 0) {
      for (const { warehouseName, stock } of stocksWithQty) {
        const canProduce = useAmt > 0 ? Math.floor(stock / useAmt) : 0;
        results.push({ ...resultBase, warehouse: warehouseName, stock, canProduce });
      }
    } else if (matchedStocks.length > 0) {
      const fabricWarehouse = matchedStocks.find((s) => s.warehouseCode === 'M01');
      const selected = fabricWarehouse || matchedStocks[0];
      results.push({ ...resultBase, warehouse: selected.warehouseName, stock: 0, canProduce: 0 });
    } else {
      results.push({ ...resultBase, warehouse: '-', stock: 0, canProduce: 0 });
    }
  }

  // 存入款号级缓存并异步刷盘。
  // 基础信息没查到时只缓 2 分钟：否则一次上游抖动会让人 4 小时都看到 "-"
  if (results && results.length > 0) {
    fabricQueryCache.set(normCode, {
      time: Date.now(),
      data: results,
      ttl: baseInfoResult.ok ? undefined : FABRIC_CACHE_RETRY_MS,
      verified: baseInfoResult.ok,
    });
    saveFabricCacheToDiskDebounced();
  }

  return results;
}

export async function queryFabricInfoMulti(pdtCodes, concurrency = 3, forceRefresh = false) {
  const trimmedCodes = pdtCodes.map((c) => String(c || '').trim()).filter(Boolean);
  if (trimmedCodes.length === 0) return [];

  const results = new Array(trimmedCodes.length);
  const toFetchIndices = [];

  for (let i = 0; i < trimmedCodes.length; i++) {
    const code = trimmedCodes[i].toUpperCase();
    if (!forceRefresh) {
      const cached = fabricQueryCache.get(code);
      if (cacheItemFresh(cached) && !isLegacyFailedRows(cached)) {
        results[i] = cached.data;
        continue;
      }
    }
    toFetchIndices.push(i);
  }

  // 全部命中缓存：直接返回（0~5ms 秒开）
  if (toFetchIndices.length === 0) {
    return results.flat();
  }

  let next = 0;
  async function runner() {
    while (true) {
      const idx = next++;
      if (idx >= toFetchIndices.length) break;
      const i = toFetchIndices[idx];
      const code = trimmedCodes[i];
      try {
        const rows = await queryFabricInfo(code, forceRefresh);
        if (rows.length === 0) {
          results[i] = [{
            pdtCode: code,
            skuCode: '-',
            pdtColorName: '-',
            colorName: '-',
            mtCode: '-',
            mtName: '无此款',
            mtType: '-',
            supplierName: '-',
            mtSpecName: '-',
            warehouse: '-',
            useAmt: 0,
            stock: 0,
            canProduce: 0,
          }];
        } else {
          results[i] = rows;
        }
      } catch (err) {
        throw new Error(err.message || `查询 ${code} 失败`);
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, toFetchIndices.length) }, runner);
  await Promise.all(workers);
  return results.flat();
}
