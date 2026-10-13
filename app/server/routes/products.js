import { Router } from 'express';
import { hasCredentials, listProductsCached, mapProduct, clearProductsCache, listSampleByCodes } from '../vscm-client.js';
import { loadBiProducts, biOverrides, biOnlyProduct, biOnlyProductFromMaster, loadBiProductMaster, biProductOverrides, getSkcsForCode } from '../bi-client.js';
import { deriveRoles } from '../role-rules.js';
import { loadSizeRange, getSizeRangeForCode } from '../size-client.js';
import { loadBomCost, getBomCostForCode } from '../cost-client.js';
import { getHengjiCost, applyHengjiSalesPriceFallback, applyHengjiCostFallback } from '../hengji-client.js';
import fallback from '../data/products.json' with { type: 'json' };

const router = Router();

// 把领猫基础资料 + BI 业务字段合并到一条 Product（BI 权威）
// 合并顺序：款式卡（款级权威：名称/小名/售价/价格定位/图片/面料/波段/产品分类/指标/款级库存）
//         → SKC 卡（颜色维度：现货/在途/占单/交期 + 兜底指标）
//         → 领猫零售价（BI 两张卡都没价格时最后兜底）
function enrichWithBi(product, biRow, productMasterRow) {
  let matched = false;
  // 1) 款式卡覆盖（款级权威字段）
  let productMasterOv = null;
  if (productMasterRow) {
    matched = true;
    productMasterOv = biProductOverrides(productMasterRow);
    if (productMasterOv) {
      for (const [k, v] of Object.entries(productMasterOv)) {
        if (v !== undefined && v !== null && v !== '') product[k] = v;
      }
    }
  }
  // 2) SKC 卡覆盖（颜色维度库存 + 部分指标兜底）
  let biOv = null;
  if (biRow) {
    matched = true;
    biOv = biOverrides(biRow);
    if (biOv) {
      for (const [k, v] of Object.entries(biOv)) {
        // 名称/小名/售价/价格定位/面料/波段/产品分类以款式卡为准，SKC 不覆盖
        if (['name', 'sub', 'price', 'priceNum', 'priceBand', 'fabric', 'wave', 'category'].includes(k)) continue;
        if (v !== undefined && v !== null && v !== '') product[k] = v;
      }
    }
  }
  product.biMatched = matched;
  // 3) 款式卡款级库存兜底：SKC 卡没给按色库存时，用款式卡的款级汇总生成单行库存
  if ((!product.stock || product.stock.length === 0) && productMasterOv) {
    const m = productMasterOv.stockMain || 0;
    const t = productMasterOv.inTransit || 0;
    const o = productMasterOv.orderBook || 0;
    if (m > 0 || t > 0 || o > 0) {
      const parts = [];
      if (m > 0) parts.push(`现货${m}`);
      if (t > 0) parts.push(`在途${t}`);
      if (o > 0) parts.push(`占单${o}`);
      product.stock = [parts.join(' ')];
      product.stockMain = m;
      product.inTransit = t;
      product.orderBook = o;
    }
  }
  // 4) 领猫零售价兜底：两张 BI 卡都没给价格时使用
  if (!product.price && product.retailPrice > 0) {
    product.price = String(product.retailPrice);
    product.priceNum = product.retailPrice;
  }
  // 5) WPS 核价表销售价兜底：BI/领猫都没有维护销售价时补价
  applyHengjiSalesPriceFallback(product);
  // 5b) WPS 核价表总成本兜底：领猫 SKC 成本 / BI bom商品成本 都没有时补（样衣阶段只走这条）
  applyHengjiCostFallback(product);
  // 6) 由 BI 打标/指标推导直播角色（引流/利润/库存），供排品策略分桶
  product.roles = deriveRoles(product);
  return product;
}

// 把领猫 + BI 一起加载（幂等，cache 复用）
// 集合语义：领猫基础资料 ∪ BI 卡片（去重按 id）——union，不是交集
async function loadAllProducts() {
  const [{ items, totalCount }, bi, productMaster] = await Promise.all([
    listProductsCached(),
    loadBiProducts().catch((err) => {
      console.error('[products] BI SKC 加载失败:', err.message);
      return { byCode: new Map(), totalRows: 0 };
    }),
    loadBiProductMaster().catch((err) => {
      console.error('[products] BI 款式 加载失败:', err.message);
      return { byPdtCode: new Map(), totalRows: 0 };
    }),
  ]);
  // 1) 领猫有的款号：mapProduct + BI 款式覆盖 + BI SKC 覆盖
  const vscmItems = items.map((dto) => {
    const p = mapProduct(dto);
    return enrichWithBi(p, bi.byCode.get(p.id), productMaster.byPdtCode.get(p.id));
  });
  // 2) BI 独有（领猫没有）：用 BI 行合成 product（用款式卡兜底款级字段）
  const vscmIds = new Set(vscmItems.map((p) => p.id));
  const biOnlyItems = [];
  for (const [code, row] of bi.byCode.entries()) {
    if (vscmIds.has(code)) continue;
    const p = biOnlyProduct(row, productMaster.byPdtCode.get(code));
    if (p) biOnlyItems.push(p);
  }
  biOnlyItems.sort((a, b) => a.id.localeCompare(b.id));
  // 3) 款式卡独有（领猫没有、SKC 卡也没有）：用款式卡合成 product（无颜色维度库存）
  const coveredIds = new Set([...vscmIds, ...bi.byCode.keys()]);
  const productOnlyItems = [];
  for (const [code, row] of productMaster.byPdtCode.entries()) {
    if (coveredIds.has(code)) continue;
    const p = biOnlyProductFromMaster(row);
    if (p) productOnlyItems.push(p);
  }
  productOnlyItems.sort((a, b) => a.id.localeCompare(b.id));
  // 4) union：领猫在前，BI-only 在后（按款号排序）
  const all = [...vscmItems, ...biOnlyItems, ...productOnlyItems];
  // BI 独有款没走 enrichWithBi，这里补 WPS 核价表兜底（销售价 + 总成本）
  for (const p of [...biOnlyItems, ...productOnlyItems]) {
    applyHengjiSalesPriceFallback(p);
    applyHengjiCostFallback(p);
  }
  // BI 独有款在合成时 roles 为 []，这里统一按 BI 打标推导
  for (const p of all) p.roles = deriveRoles(p);
  return {
    items: all,
    totalCount,
    vscmCount: vscmItems.length,
    biOnlyCount: biOnlyItems.length + productOnlyItems.length,
    bi,
    productMaster,
  };
}

// GET /api/products
router.get('/', async (req, res) => {
  const useMock = req.query.useMock === 'true' || !hasCredentials();

  if (useMock) {
    return res.json({
      updatedAt: new Date().toISOString(),
      count: fallback.length,
      items: fallback.map((p) => applyHengjiCostFallback(applyHengjiSalesPriceFallback(p))),
      source: 'mock',
    });
  }

  try {
    if (req.query.fresh === 'true') clearProductsCache();
    const { items, totalCount, vscmCount, biOnlyCount, bi } = await loadAllProducts();
    const biHit = items.filter((p) => p.biMatched).length;
    res.json({
      updatedAt: new Date().toISOString(),
      count: items.length,
      totalCount,
      vscmCount,
      biOnlyCount,
      biTotalRows: bi.totalRows,
      biMatched: biHit,
      items,
      source: 'vscm+bi',
    });
  } catch (err) {
    console.error('[products] 拉取失败:', err.message);
    // fresh=true（用户主动要求重拉）失败时不要 mock-fallback：
    //   mock 是 32 个款号，syncProducts 看到 ok:true 会以为同步成功，然后 fetchProducts 拿到这 32 条
    //   会污染前端 React state，让本该有的款号（6480 个）变成「查不到」。
    //   直接返回 503 让前端/sync 路径能看到失败。
    if (req.query.fresh === 'true') {
      return res.status(503).json({
        error: 'fetch_failed',
        message: err.message,
        source: 'fetch-failed',
        items: [],
        count: 0,
      });
    }
    res.status(200).json({
      updatedAt: new Date().toISOString(),
      count: fallback.length,
      items: fallback.map((p) => applyHengjiCostFallback(applyHengjiSalesPriceFallback(p))),
      source: 'mock-fallback',
      error: err.message,
    });
  }
});

// 静态子路由必须放在 :id 之前
router.get('/meta/filters', async (_req, res) => {
  try {
    if (hasCredentials()) {
      const { items, bi } = await loadAllProducts();
      const uniq = (key) => [...new Set(items.map((p) => p[key]).filter(Boolean))];
      return res.json({
        categories: uniq('category'),
        waves: uniq('wave'),
        tempBands: uniq('tempBand'),
        priceBands: uniq('priceBand'),
        roles: [...new Set(items.flatMap((p) => p.roles || []))],
        biMatched: bi.byCode.size,
        source: 'vscm+bi',
      });
    }
  } catch (err) {
    console.warn('[products] filters 拉取失败:', err.message);
  }
  const uniq = (key) => [...new Set(fallback.map((p) => p[key]).filter(Boolean))];
  res.json({
    categories: uniq('category'),
    waves: uniq('wave'),
    tempBands: uniq('tempBand'),
    priceBands: uniq('priceBand'),
    roles: [...new Set(fallback.flatMap((p) => p.roles || []))],
    source: 'mock',
  });
});

router.get('/batch/by-ids', (req, res) => {
  const ids = String(req.query.ids || '').split(',').filter(Boolean);
  res.json(fallback.filter((p) => ids.includes(p.id)));
});

// 成本批量查询：核价表总成本优先 > 领猫 skcCostPrice > BI ETL bom商品成本兜底
router.get('/cost/by-ids', async (req, res) => {
  const ids = String(req.query.ids || '').split(',').filter(Boolean);
  if (!ids.length) return res.json({ byCode: {}, updatedAt: new Date().toISOString() });
  try {
    const { items: products } = await loadAllProducts();
    const vscmCostByCode = new Map();
    for (const p of products) {
      if (p.costPrice > 0) vscmCostByCode.set(p.id, String(p.costPrice));
    }
    // BI BOM 成本兜底
    await loadBomCost(ids);
    const byCode = {};
    for (const id of ids) {
      const key = id.toLowerCase();
      const hengji = getHengjiCost(id);
      byCode[key] = hengji ? String(hengji) : (vscmCostByCode.get(key) ?? getBomCostForCode(id) ?? '');
    }
    res.json({ byCode, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.warn('[products/cost] 加载失败:', err.message);
    res.json({ byCode: {}, error: err.message });
  }
});

// 从领猫 SKU 的 sizeName（如 "160/82A(S)"）提取尺码字母，聚合为 "S~XL"
const SIZE_ORDER = ['XXXS','XXS','XS','S','M','L','XL','XXL','XXXL','XXXXL','均码','FREE','ONE SIZE'];
function sortSizes(arr) {
  const idx = (s) => {
    const up = String(s).trim().toUpperCase();
    const i = SIZE_ORDER.indexOf(up);
    return i >= 0 ? i : 999 + up.localeCompare('a');
  };
  return [...arr].sort((a, b) => idx(a) - idx(b));
}
function extractSizeFromSku(sku) {
  const name = String(sku?.sizeName || '');
  // 服装："160/82A(S)" → "S"
  const letterMatch = name.match(/\(([A-Z]+)\)/i);
  if (letterMatch) return letterMatch[1].trim().toUpperCase();
  // 鞋靴："225(1.5)" → "225"
  const numMatch = name.match(/^(\d+(?:\.\d+)?)/);
  if (numMatch) return numMatch[1];
  return name.trim();
}
function deriveSizeRange(skus) {
  if (!Array.isArray(skus) || skus.length === 0) return '';
  const set = new Set();
  for (const s of skus) {
    const v = extractSizeFromSku(s);
    if (v) set.add(v);
  }
  const arr = sortSizes([...set]);
  if (arr.length === 0) return '';
  if (arr.length === 1) return arr[0];
  return `${arr[0]}~${arr[arr.length - 1]}`;
}

// 尺码范围批量查询：领猫 SKU 优先；领猫没有时 fallback 到 BI ETL
router.get('/sizes/by-ids', async (req, res) => {
  const ids = String(req.query.ids || '').split(',').filter(Boolean);
  if (!ids.length) return res.json({ byCode: {}, updatedAt: new Date().toISOString() });
  try {
    const [{ items: products }] = await Promise.all([
      loadAllProducts().catch(() => ({ items: [] })),
    ]);
    const vscmSizeByCode = new Map();
    for (const p of products) {
      const range = deriveSizeRange(p.skus);
      if (range) vscmSizeByCode.set(p.id, range);
    }
    // 大货里没有的款号，尝试从样衣接口补尺码
    const missingIds = ids.filter((id) => !vscmSizeByCode.has(id.toLowerCase()));
    if (missingIds.length > 0) {
      try {
        const { items: samples } = await listSampleByCodes(missingIds);
        for (const s of samples) {
          const range = deriveSizeRange(s.skus);
          if (range) vscmSizeByCode.set(s.id, range);
        }
      } catch (sampleErr) {
        console.warn('[products/sizes] 样衣 fallback 失败:', sampleErr.message);
      }
    }
    // BI ETL 兜底
    const needBiIds = ids.filter((id) => !vscmSizeByCode.has(id.toLowerCase()));
    if (needBiIds.length > 0) {
      await loadSizeRange(needBiIds);
    }
    const byCode = {};
    for (const id of ids) {
      const key = id.toLowerCase();
      byCode[key] = vscmSizeByCode.get(key) || getSizeRangeForCode(id) || '';
    }
    res.json({ byCode, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.warn('[products/sizes] 加载失败:', err.message);
    res.json({ byCode: {}, error: err.message });
  }
});

// SKC 列表批量查询：BI SKC 卡优先；BI 没有时 fallback 到领猫大货 SKU / 样衣 SKU
router.get('/skcs/by-ids', async (req, res) => {
  const ids = String(req.query.ids || '').split(',').filter(Boolean);
  if (!ids.length) return res.json({ byCode: {}, updatedAt: new Date().toISOString() });
  try {
    const [{ items: products }, _bi] = await Promise.all([
      loadAllProducts().catch(() => ({ items: [] })),
      loadBiProducts(),
    ]);
    const vscmByCode = new Map();
    for (const p of products) {
      if (p.skus && p.skus.length > 0) {
        vscmByCode.set(p.id, p.skus.map((s) => ({
          code: s.skuCode || '',
          color: s.colorName || '',
          plannedRestockQty: 0,
        })));
      }
    }
    // BI 和 大货都没有的款号，尝试从样衣接口补 SKC（颜色/尺码）
    const missingIds = ids.filter((id) => {
      const key = id.toLowerCase();
      return getSkcsForCode(id).length === 0 && !vscmByCode.has(key);
    });
    if (missingIds.length > 0) {
      try {
        const { items: samples } = await listSampleByCodes(missingIds);
        for (const s of samples) {
          if (s.skus && s.skus.length > 0) {
            vscmByCode.set(s.id, s.skus.map((sku) => ({
              code: sku.smSkuCode || sku.skuCode || '',
              color: sku.colorName || '',
              plannedRestockQty: 0,
            })));
          }
        }
      } catch (sampleErr) {
        console.warn('[products/skcs] 样衣 fallback 失败:', sampleErr.message);
      }
    }
    const byCode = {};
    for (const id of ids) {
      const key = id.toLowerCase();
      const biSkcs = getSkcsForCode(id);
      byCode[key] = biSkcs.length > 0 ? biSkcs : (vscmByCode.get(key) ?? []);
    }
    res.json({ byCode, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.warn('[products/skcs] 加载失败:', err.message);
    res.json({ byCode: {}, error: err.message });
  }
});

// GET /api/products/:id — 大货 union miss 时 fallback 到样衣接口
router.get('/:id', async (req, res) => {
  const id = String(req.params.id || '').toLowerCase();
  try {
    if (hasCredentials()) {
      const { items } = await loadAllProducts();
      const found = items.find((p) => p.id === id);
      if (found) return res.json(found);
      // 大货 union miss → 查样衣（样衣阶段只在这里查得到）
      try {
        const { items: samples } = await listSampleByCodes([id]);
        const sample = samples.find((p) => p.id === id);
        if (sample) return res.json(applyHengjiCostFallback(applyHengjiSalesPriceFallback(sample)));
      } catch (sampleErr) {
        console.warn('[products] /:id 样衣 fallback 失败:', sampleErr.message);
      }
      return res.status(404).json({ error: 'not_found', id });
    }
  } catch (err) {
    console.warn('[products] /:id 拉取失败:', err.message);
  }
  const local = fallback.find((p) => p.id.toLowerCase() === id);
  if (!local) return res.status(404).json({ error: 'not_found', id });
  res.json(applyHengjiCostFallback(applyHengjiSalesPriceFallback(local)));
});

export default router;

