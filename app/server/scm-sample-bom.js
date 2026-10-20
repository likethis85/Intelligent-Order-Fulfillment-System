// 样衣 BOM 代理：照搬 /private/tmp/fabric-Q-check/src/api.ts 的
//   getSampleDevMaterials + getMaterialBaseInfoForSample
// 加 1h 内存 LRU 缓存，限 1000 条 entries（超了淘汰一半防内存爆）
// 复用 vscm-client.js 的 getToken() / call()（已 export）
import { getToken, call, listSampleByCodes } from './vscm-client.js';

// ── 缓存 ──
// 按款号缓存（不是整批 key）：批量查询里某个款号限流失败时不缓存该款，
// 下次请求只补未缓存的款号；否则整批结果会把「限流导致的空」冻 1 小时
// 磁盘持久化（server/data/sample-bom-cache.json）：领猫 500/min 配额紧，
// 进程重启后不用再全量回源；有数据的款号 6h TTL，空结果 1h（BOM 可能后补）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TTL_WITH_DATA_MS = 6 * 60 * 60 * 1000; // 有数据：6 小时
const TTL_EMPTY_MS = 60 * 60 * 1000;         // 空结果：1 小时
const MAX_ENTRIES = 1000;
const CACHE_FILE = join(dirname(fileURLToPath(import.meta.url)), 'data', 'sample-bom-cache.json');
const sampleBomByCodeCache = new Map(); // key: smCode → { at, rows: SampleMaterialRow[] }
const materialBaseInfoCache = new Map(); // key: sortedMtCodesKey → { at, items }

function loadBomCache() {
  try {
    const j = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
    for (const [k, v] of Object.entries(j.byCode || {})) {
      if (v && Number(v.at) && Array.isArray(v.rows)) sampleBomByCodeCache.set(k, v);
    }
    console.log(`[scm-sample-bom] 磁盘缓存载入 ${sampleBomByCodeCache.size} 个款号`);
  } catch { /* 首次运行无文件 */ }
}
let saveTimer = null;
function scheduleBomCacheSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      mkdirSync(dirname(CACHE_FILE), { recursive: true });
      writeFileSync(CACHE_FILE, JSON.stringify({ byCode: Object.fromEntries(sampleBomByCodeCache) }));
    } catch (e) { console.warn('[scm-sample-bom] 缓存落盘失败:', e.message); }
  }, 2000);
}
loadBomCache();

function isFresh(entry) {
  if (!entry) return false;
  const ttl = (entry.rows && entry.rows.length > 0) ? TTL_WITH_DATA_MS : TTL_EMPTY_MS;
  return Date.now() - entry.at < ttl;
}

function evictIfFull(map) {
  if (map.size <= MAX_ENTRIES) return;
  // 按 at 升序删一半（FIFO 近似）
  const sorted = [...map.entries()].sort((a, b) => a[1].at - b[1].at);
  const toRemove = sorted.slice(0, Math.floor(sorted.length / 2));
  for (const [k] of toRemove) map.delete(k);
}

function keyOf(arr) {
  return [...new Set(arr.map((s) => String(s || '').trim().toUpperCase()))]
    .filter(Boolean)
    .sort()
    .join(',');
}

// ── 字段映射（与 fabric_Q 一致） ──

// mtType 为「面料」或「里料」的算主体用料
function isFabricMaterial(mtType) {
  if (!mtType) return false;
  return mtType === '面料' || mtType === '里料';
}

// 部分主数据把纱线类归到辅料，但 BOM 里有「纱线/毛线」字样也按面料处理（保留 fabric_Q 的兼容）
function isYarnLike(mtCode, mtName) {
  return /纱线|毛线/.test(`${mtCode}${mtName}`);
}

// ── 主数据：调 /v1/BaseInfo/Getmaterials，返 mtCode → { mtType, supplierName, subs[].mtSubCode → {colorCode, colorName, spColorName} } ──
async function getMaterialBaseInfoForSample(mtCodes) {
  const upperCodes = [...new Set(mtCodes.map((c) => String(c || '').trim().toUpperCase()))].filter(Boolean);
  if (upperCodes.length === 0) return { typeMap: new Map(), specMap: new Map(), supplierMap: new Map() };

  const key = upperCodes.sort().join(',');
  const cached = materialBaseInfoCache.get(key);
  if (isFresh(cached)) return cached.data;

  const typeMap = new Map();
  const specMap = new Map();
  const supplierMap = new Map();

  // Getmaterials 的 codes 入参只接受前 100 个，超了分批
  const CHUNK = 100;
  for (let i = 0; i < upperCodes.length; i += CHUNK) {
    const chunk = upperCodes.slice(i, i + CHUNK);
    let pageIndex = 1;
    while (true) {
      const json = await call('/v1/BaseInfo/Getmaterials', { codes: chunk.join(','), pageIndex, pageSize: 100 });
      const data = json.data || {};
      const items = data.datas || [];
      if (items.length === 0) break;
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
  }

  const data = { typeMap, specMap, supplierMap };
  materialBaseInfoCache.set(key, { at: Date.now(), data });
  evictIfFull(materialBaseInfoCache);
  return data;
}

// ── 样衣 BOM：调 /v1/Research/GetSampleDevMaterialBomList ──
//   时间窗 ≤ 7 天，5 个窗口覆盖 30 天；用 smDevCode 精确过滤
async function getSampleDevMaterialsForOne(smCode) {
  const upperCode = smCode.toUpperCase();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const LOOKBACK_DAYS = 30;
  const WINDOW_DAYS = 7;
  const now = new Date();
  const windows = [];
  const windowCount = Math.ceil(LOOKBACK_DAYS / WINDOW_DAYS);
  for (let i = 0; i < windowCount; i++) {
    const end = new Date(now.getTime() - i * WINDOW_DAYS * DAY_MS);
    const begin = new Date(end.getTime() - WINDOW_DAYS * DAY_MS + 60 * 60 * 1000);
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
    const json = await call('/v1/Research/GetSampleDevMaterialBomList', body);
    return json;
  }

  // 第一步：找 smDevCode（每个窗口只取第 1 页）
  let smDevCode;
  for (const win of windows) {
    const json = await fetchWindowPage(win, 1);
    if ((json.code !== 200 && json.code !== 0) || !json.data) continue;
    const datas = json.data.datas || [];
    const match = datas.find((it) => (it.smCode || '').toUpperCase() === upperCode);
    if (match?.smDevCode) {
      smDevCode = String(match.smDevCode).trim();
      break;
    }
  }

  // 第二步：拉全窗口
  // 找到 smDevCode：按 devCodes 精确过滤拉全（便宜）；
  // 没找到：无过滤深扫兜底（ME14FF036 的 BOM 记录埋在全公司窗口的第 2 页以后，浅扫会漏）——
  // 调用方已用 getsampleclothings 预筛过样衣款，能走到这里的款号很少，深扫成本可控
  const allDatas = [];
  // 无 smDevCode 的兜底深扫限制每窗 6 页（600 条），平衡命中率与配额消耗
  const maxPages = smDevCode ? 20 : 6;
  for (const win of windows) {
    let pageIndex = 1;
    while (pageIndex <= maxPages) {
      const json = await fetchWindowPage(win, pageIndex, smDevCode ? [smDevCode] : undefined);
      if (json.code !== 200 && json.code !== 0) break;
      const datas = json.data?.datas || [];
      allDatas.push(...datas);
      if (!json.data?.hasNext || datas.length === 0) break;
      pageIndex++;
    }
  }

  // 第三步：查主数据，过滤面料/里料
  const materialCodes = [...new Set(allDatas
    .filter((it) => (it.smCode || '').toUpperCase() === upperCode)
    .map((it) => (it.materialCode || '').trim()))].sort();
  if (materialCodes.length === 0) return [];
  const { typeMap, specMap, supplierMap } = await getMaterialBaseInfoForSample(materialCodes);

  // 过滤 + 按 (skuCode, materialCode) 去重
  const seen = new Set();
  const out = [];
  for (const item of allDatas) {
    if ((item.smCode || '').toUpperCase() !== upperCode) continue;
    const materialCode = (item.materialCode || '').trim();
    const realMtType = typeMap.get(materialCode) || '';
    const yarnLike = isYarnLike(materialCode, (item.materialName || '').trim());
    if (!isFabricMaterial(realMtType) && !yarnLike) continue;

    const subs = Array.isArray(item.subs) ? item.subs : [];
    for (const sub of subs) {
      const skuCodeRaw = (sub.skuCode || '').trim();
      const skuCode = skuCodeRaw.slice(0, -1); // SKU 去尾位 = SKC
      const subMaterialSubCode = (sub.materialSubCode || '').trim();
      const key = `${skuCode}__${materialCode}__${subMaterialSubCode}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const specInfo = specMap.get(subMaterialSubCode);
      let mtSpecName = (sub.materialSubSpec || '').trim();
      if (specInfo && (specInfo.colorCode || specInfo.colorName || specInfo.spColorName)) {
        mtSpecName = specInfo.spColorName
          ? `[${specInfo.colorCode}]${specInfo.colorName}-${specInfo.spColorName};`
          : `[${specInfo.colorCode}]${specInfo.colorName};`;
      }
      const mtType = isFabricMaterial(realMtType)
        ? realMtType
        : yarnLike
          ? '纱线'
          : (item.usePart || '').trim() || (item.materialName || '').trim() || '其他';

      out.push({
        pdtCode: upperCode,
        skuCode: skuCode || '-',
        pdtColorName: (sub.smColorName || '').trim() || '-',
        colorName: (sub.materialSubColorName || '').trim() || '-',
        mtCode: materialCode || '-',
        mtName: (item.materialName || '').trim() || '-',
        mtType,
        supplierName: supplierMap.get(materialCode) || (item.supplierName || '').trim() || '-',
        mtSpecName: mtSpecName || '-',
        useAmt: Number(sub.useAmount) || 0,
      });
    }
  }
  return out;
}

// 单款 items → 按 (smCode, skc) 聚合成行
function aggregateItemsToRows(allItems) {
  const bySkc = new Map();
  for (const it of allItems) {
    const k = `${it.pdtCode}__${it.skuCode}`;
    if (!bySkc.has(k)) {
      bySkc.set(k, {
        smCode: it.pdtCode,
        skc: it.skuCode,
        colorName: it.pdtColorName,
        mtSpecName: it.mtSpecName,
        fabricMt: '',
        liningMt: '',
        supplierShort: '',
        _fabricNames: [],
        _liningNames: [],
        _suppliers: [],
        useAmt: 0,
      });
    }
    const row = bySkc.get(k);
    row.useAmt += it.useAmt;
    if (it.mtType === '面料' && !row._fabricNames.includes(it.mtName)) row._fabricNames.push(it.mtName);
    if (it.mtType === '里料' && !row._liningNames.includes(it.mtName)) row._liningNames.push(it.mtName);
    if (it.supplierName && it.supplierName !== '-' && !row._suppliers.includes(it.supplierName)) row._suppliers.push(it.supplierName);
    // spColorName 取第一个非空（来自 mtSpecName 里的 -spColorName 段；fabric_Q 拼接格式固定）
    if (!row.spColorName && it.mtSpecName) {
      const m = it.mtSpecName.match(/-\s*([^;]+);/);
      if (m) row.spColorName = m[1].trim();
    }
  }
  return [...bySkc.values()].map((r) => ({
    smCode: r.smCode,
    skc: r.skc,
    colorName: r.colorName,
    spColorName: r.spColorName,
    fabricMt: r._fabricNames.join(' / '),
    liningMt: r._liningNames.join(' / '),
    supplierShort: r._suppliers[0] || '',
    mtSpecName: r.mtSpecName,
    useAmt: r.useAmt,
  }));
}

// 单款查询（带按款号缓存）：成功才写缓存（含空结果），失败抛出由调用方决定是否降级
const RATE_LIMITED_TTL_MS = 5 * 60 * 1000; // 限流踩坑：短 TTL 空缓存，防止反复打开页面持续打满配额
// 单飞合并（Inflight deduplication）：并发请求同一个款号时复用同一个 Promise，避免领猫配额被重复打满
const inflightBomByCode = new Map();

async function getSampleMaterialsOne(code) {
  const cached = sampleBomByCodeCache.get(code);
  if (isFresh(cached)) return cached.rows;

  if (inflightBomByCode.has(code)) {
    return inflightBomByCode.get(code);
  }

  const p = (async () => {
    let items;
    try {
      items = await getSampleDevMaterialsForOne(code);
    } catch (err) {
      if (/频率限制|rate/i.test(err?.message || '')) {
        // 限流：缓存空 5 分钟（不改 rows 数据语义，只是暂停回源），配额恢复后自动重试
        sampleBomByCodeCache.set(code, { at: Date.now() - TTL_EMPTY_MS + RATE_LIMITED_TTL_MS, rows: [] });
        scheduleBomCacheSave();
      }
      throw err;
    }
    const rows = aggregateItemsToRows(items);
    sampleBomByCodeCache.set(code, { at: Date.now(), rows });
    evictIfFull(sampleBomByCodeCache);
    scheduleBomCacheSave();
    return rows;
  })();

  inflightBomByCode.set(code, p);
  try {
    return await p;
  } finally {
    inflightBomByCode.delete(code);
  }
}

// ── 公开 API：批量查样衣 BOM，按 (smCode, skc) 聚合 fabricMt / liningMt / supplierShort ──
// 返回形状：[{ smCode, skc, colorName, spColorName, fabricMt, liningMt, supplierShort, mtSpecName, useAmt }, ...]
// 领猫限流 20/s + 500/min：并发限制 4 个款号一批（单款内部 5 个 7 天窗口串行）
export async function getSampleMaterials(codes) {
  const validCodes = [...new Set(codes.map((c) => String(c || '').trim().toUpperCase()))].filter(Boolean);
  if (validCodes.length === 0) return [];

  const result = [];
  const missing = [];
  for (const c of validCodes) {
    const cached = sampleBomByCodeCache.get(c);
    if (isFresh(cached)) result.push(...cached.rows);
    else missing.push(c);
  }

  // 预筛：先用 getsampleclothings（1 次调用，smCodes 精确查）圈出样衣阶段的款号；
  // 纯大货款号直接缓存空结果，不进 BOM 深扫（无过滤翻页一个款号要烧上百次请求，500/min 配额扛不住）
  let bomCodes = [];
  if (missing.length > 0) {
    try {
      const { items } = await listSampleByCodes(missing);
      const sampleSet = new Set(items.map((p) => String(p.id || '').toUpperCase()));
      for (const c of missing) {
        if (sampleSet.has(c)) bomCodes.push(c);
        else {
          // 纯大货：缓存空，1h 内不再回源
          sampleBomByCodeCache.set(c, { at: Date.now(), rows: [] });
        }
      }
      scheduleBomCacheSave();
    } catch (err) {
      // 预筛失败（限流/网络）：全部款号走 BOM 深扫，宁可慢不可漏
      console.warn('[scm-sample-bom] getsampleclothings 预筛失败，全部回源 BOM:', err.message);
      bomCodes = missing;
    }
  }

  const CONCURRENCY = 4;
  for (let i = 0; i < bomCodes.length; i += CONCURRENCY) {
    const batch = bomCodes.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(
      batch.map((c) =>
        getSampleMaterialsOne(c).catch((err) => {
          // 失败不缓存：下次请求会重试该款
          console.error(`[scm-sample-bom] ${c} 查询失败:`, err.message);
          return [];
        }),
      ),
    );
    for (const rows of settled) result.push(...rows);
  }

  return result.sort((a, b) => (a.smCode.localeCompare(b.smCode) || a.skc.localeCompare(b.skc)));
}

// ── 公开 API：批量查物料主数据（passthrough 给 Getmaterials，前端按需用） ──
export async function getMaterialBaseInfo(mtCodes) {
  const validCodes = [...new Set(mtCodes.map((c) => String(c || '').trim().toUpperCase()))].filter(Boolean);
  if (validCodes.length === 0) return { items: [] };
  const key = validCodes.sort().join(',');
  const cached = materialBaseInfoCache.get(key);
  if (isFresh(cached)) {
    return { items: cached.data.typeMap, typeMap: cached.data.typeMap, specMap: cached.data.specMap, supplierMap: cached.data.supplierMap };
  }
  const data = await getMaterialBaseInfoForSample(validCodes);
  // 这里 materialized 到 cache 后返回 typeMap 数组版
  const items = [...data.typeMap.entries()].map(([mtCode, mtType]) => ({ mtCode, mtType }));
  return { items, typeMap: data.typeMap, specMap: data.specMap, supplierMap: data.supplierMap };
}
