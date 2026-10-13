import { Router } from 'express';
import { hasCredentials, listSamplesCached, listSampleByCodes } from '../vscm-client.js';
import { applyHengjiSalesPriceFallback, applyHengjiCostFallback } from '../hengji-client.js';
import { getSampleMaterials, getMaterialBaseInfo } from '../scm-sample-bom.js';

import { getFabricDataRows } from './fabric.js';

const router = Router();

function parseCodes(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// GET /api/samples — 全量列表（默认 30 天回溯，标 stage='sample'）
router.get('/', async (_req, res) => {
  if (!hasCredentials()) {
    return res.status(503).json({
      error: 'vscm_credentials_missing',
      message: 'VSCM_APP_ID / VSCM_APP_SECRET 未配置（看 server/.env）',
    });
  }
  try {
    const { items, totalCount } = await listSamplesCached();
    res.json({
      updatedAt: new Date().toISOString(),
      count: items.length,
      totalCount,
      items: items.map((p) => applyHengjiCostFallback(applyHengjiSalesPriceFallback(p))),
      source: 'vscm-samples',
    });
  } catch (err) {
    console.error('[samples] 全量拉取失败:', err.message);
    res.status(500).json({ error: 'vscm_failed', message: err.message });
  }
});

// 静态子路由必须在 :smCode 之前注册
// GET /api/samples/by-codes?codes=ME15FW015,XX99XX99 — 批量精确查
router.get('/by-codes', async (req, res) => {
  const codes = String(req.query.codes || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!codes.length) {
    return res.status(400).json({ error: 'missing_codes', message: '?codes=ME15FW015,... 至少一个款号' });
  }
  if (!hasCredentials()) {
    return res.status(503).json({ error: 'vscm_credentials_missing' });
  }
  try {
    const { items, totalCount } = await listSampleByCodes(codes);
    const requestedLower = new Set(codes.map((c) => c.toLowerCase()));
    const foundLower = new Set(items.map((p) => p.id));
    const missing = [...requestedLower].filter((c) => !foundLower.has(c));
    res.json({
      updatedAt: new Date().toISOString(),
      requested: codes.length,
      count: items.length,
      totalCount,
      items: items.map((p) => applyHengjiCostFallback(applyHengjiSalesPriceFallback(p))),
      missing,
      source: 'vscm-samples',
    });
  } catch (err) {
    console.error('[samples] by-codes 失败:', err.message);
    res.status(500).json({ error: 'vscm_failed', message: err.message });
  }
});

// GET /api/samples/materials?codes=ME14FF036,ME16FF037 — 代理样衣 BOM（带 1h 缓存）
//   返回: [{ smCode, skc, colorName, spColorName, fabricMt, liningMt, supplierShort, mtSpecName, useAmt }, ...]
router.get('/materials', async (req, res) => {
  const codes = parseCodes(req.query.codes);
  if (!codes.length) return res.json({ updatedAt: new Date().toISOString(), count: 0, items: [] });
  if (!hasCredentials()) return res.status(503).json({ error: 'vscm_credentials_missing' });
  try {
    const items = await getSampleMaterials(codes);
    res.json({ updatedAt: new Date().toISOString(), count: items.length, items, source: 'vscm-sample-bom' });
  } catch (err) {
    console.error('[samples/materials] 失败:', err.message);
    res.status(500).json({ error: 'vscm_failed', message: err.message });
  }
});

// GET /api/samples/materials/base-info?mtCodes=A001,B002 — 代理物料主数据（passthrough）
router.get('/materials/base-info', async (req, res) => {
  const codes = parseCodes(req.query.mtCodes);
  if (!codes.length) return res.json({ updatedAt: new Date().toISOString(), count: 0, items: [] });
  if (!hasCredentials()) return res.status(503).json({ error: 'vscm_credentials_missing' });
  try {
    const data = await getMaterialBaseInfo(codes);
    res.json({ updatedAt: new Date().toISOString(), count: data.items.length, items: data.items, source: 'vscm-material-master' });
  } catch (err) {
    console.error('[samples/materials/base-info] 失败:', err.message);
    res.status(500).json({ error: 'vscm_failed', message: err.message });
  }
});

// GET /api/samples/calc-restock-stock?pids=ME01FF021,ME25FF013&skcs=ME01FF02106,ME01FF02111
// 调 fabric_Q 面料数据，同款面料（同 mt_code+mt_spec_name）的在仓/在途/工厂现货/可订货 米数全加，
// 算每个 SKC 的最大单量 = floor(M / use_amt / 1.05)。
// pids 与 skcs 可同时传（pids 用来扩出全部 SKC 行，skcs 精确指定），也可只传一个。
router.get('/calc-restock-stock', async (req, res) => {
  const pids = parseCodes(req.query.pids).map((s) => s.toUpperCase());
  const skcs = parseCodes(req.query.skcs).map((s) => s.toUpperCase());
  if (!pids.length && !skcs.length) return res.json({ updatedAt: new Date().toISOString(), count: 0, items: [] });
  try {
    let rows = [];
    try {
      rows = await getFabricDataRows();
    } catch {
      const base = process.env.FABRIC_Q_BASE || 'http://127.0.0.1:3721';
      const r = await fetch(`${base}/api/fabric-data`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
      if (r && r.ok) {
        const j = await r.json().catch(() => ({}));
        rows = Array.isArray(j?.data) ? j.data : [];
      }
    }
    // 过滤：pdt_code 命中 pids，或 sku_code 命中 skcs
    const pidSet = new Set(pids);
    const skuSet = new Set(skcs);
    const matched = rows.filter((r) => {
      if (r.pdt_code && pidSet.has(String(r.pdt_code).toUpperCase())) return true;
      if (r.sku_code && skuSet.has(String(r.sku_code).toUpperCase())) return true;
      return false;
    });
    // 按 (mt_code, mt_spec_name, warehouse) 聚合 M（与 fabric_Q 一致：同一卷同一仓只算一次，取 max）
    // fabric_Q 多个 SKC 引用同一卷面料时，每行 面料仓 stock 相同，byWarehouse[w] 取 max 不会重复累加
    const fabricAgg = new Map(); // key: mtCode|mtSpecName → { ..., byWarehouse: { w: { stockAt, factorySpot, inTransit, orderable } }, bySku: { skc: { useAmt, sources: [{ warehouse, M }] } } }
    for (const r of matched) {
      const w = String(r.warehouse || '');
      if (w.includes('恒隆') || w.includes('工厂物料')) continue;
      const key = `${r.mt_code || ''}|${r.mt_spec_name || ''}`;
      const cur = fabricAgg.get(key) || {
        mtCode: r.mt_code,
        mtSpecName: r.mt_spec_name,
        mtName: r.mt_name,
        supplierName: r.supplier_name,
        byWarehouse: {},
        bySku: {},
      };
      // 同一 (面料, 仓) 只算 max（不同 SKC 行可能重复记录同一卷，max 防累加）
      const stock = Number(r.stock) || 0;
      const inTransit = Number(r.in_transit_qty) || 0;
      const orderable = Number(r.orderable_qty) || 0;
      // fabric_Q 的「面料仓」是 stock；「工厂现货」是 factory_spot_qty —— 两者都是这卷料的存量来源
      const wKey = w === '工厂现货' ? '__factorySpot__' : w;
      const stockAt = (cur.byWarehouse[wKey]?.stockAt ?? 0);
      const factorySpot = (cur.byWarehouse[wKey]?.factorySpot ?? 0);
      const tr = (cur.byWarehouse[wKey]?.inTransit ?? 0);
      const ob = (cur.byWarehouse[wKey]?.orderable ?? 0);
      cur.byWarehouse[wKey] = {
        stockAt: Math.max(stockAt, stock),
        factorySpot: Math.max(factorySpot, Number(r.factory_spot_qty) || 0),
        inTransit: Math.max(tr, inTransit),
        orderable: Math.max(ob, orderable),
      };
      const skc = String(r.sku_code || '').toUpperCase();
      if (skc) {
        const curSku = cur.bySku[skc] || { skc, useAmt: 0 };
        curSku.useAmt = Math.max(curSku.useAmt, Number(r.use_amt) || 0);
        cur.bySku[skc] = curSku;
      }
      fabricAgg.set(key, cur);
    }
    // 输出：每卷面料 + 该卷涉及的 SKC + maxPcs
    const items = [];
    for (const fab of fabricAgg.values()) {
      // 同一卷 M = 各仓（面料仓 / 工厂现货 / 在途 / 可订货）的 max 之和
      let stockAt = 0, factorySpot = 0, inTransit = 0, orderable = 0;
      for (const w of Object.keys(fab.byWarehouse)) {
        const v = fab.byWarehouse[w];
        stockAt = Math.max(stockAt, v.stockAt);
        factorySpot = Math.max(factorySpot, v.factorySpot);
        inTransit = Math.max(inTransit, v.inTransit);
        orderable = Math.max(orderable, v.orderable);
      }
      const M = stockAt + factorySpot + inTransit + orderable;
      if (M <= 0 && Object.values(fab.bySku).every((s) => !s.useAmt)) continue;
      const skcResults = [];
      for (const skc of Object.keys(fab.bySku)) {
        const { useAmt } = fab.bySku[skc];
        const maxPcs = useAmt > 0 ? Math.floor(M / useAmt / 1.05) : 0;
        skcResults.push({ skc, useAmt, maxPcs, stockAt, factorySpot, inTransit, orderable });
      }
      items.push({
        mtCode: fab.mtCode,
        mtName: fab.mtName,
        mtSpecName: fab.mtSpecName,
        supplierName: fab.supplierName,
        M,
        skcs: skcResults,
      });
    }
    // 按 M 降序
    items.sort((a, b) => b.M - a.M);
    res.json({ updatedAt: new Date().toISOString(), count: items.length, items, source: 'fabric-q' });
  } catch (err) {
    console.warn('[samples/calc-restock-stock] 获取面料库存降级:', err.message);
    res.json({ updatedAt: new Date().toISOString(), count: 0, items: [], error: err.message });
  }
});

// GET /api/samples/:smCode — 单点精确查
router.get('/:smCode', async (req, res) => {
  const code = String(req.params.smCode || '').trim();
  if (!code) return res.status(400).json({ error: 'missing_smCode' });
  if (!hasCredentials()) {
    return res.status(503).json({ error: 'vscm_credentials_missing' });
  }
  try {
    const { items } = await listSampleByCodes([code]);
    const found = items.find((p) => p.id === code.toLowerCase());
    if (!found) return res.status(404).json({ error: 'not_found', smCode: code });
    res.json(applyHengjiCostFallback(applyHengjiSalesPriceFallback(found)));
  } catch (err) {
    console.error('[samples] /:smCode 失败:', err.message);
    res.status(500).json({ error: 'vscm_failed', message: err.message });
  }
});

export default router;