import { Router } from 'express';
import {
  getSkuProfile,
  listSkuProfileCodes,
  getStoreProfile,
  listStoreProfiles,
  listAnchors,
  getAnchorHot,
  getAnchorTotals,
  getAnchorAudience,
} from '../profile-client.js';

const router = Router();

// GET /api/profiles/sku-codes — 有单款画像数据的款号清单（BI 单款人群画像共覆盖 240 款）
router.get('/sku-codes', async (_req, res) => {
  try {
    const codes = await listSkuProfileCodes();
    res.json({ codes, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[profiles/sku-codes] 拉取失败:', err.message);
    res.status(503).json({ error: 'fetch_failed', message: err.message, codes: [] });
  }
});

// GET /api/profiles/sku/:code?platform=淘宝|抖音 — 单款人群画像；platform 缺省合并两平台
router.get('/sku/:code', async (req, res) => {
  const code = String(req.params.code || '');
  const platform = req.query.platform ? String(req.query.platform) : '';
  if (!/^(淘宝|抖音)$/.test(platform) && platform) {
    return res.status(400).json({ error: 'bad_platform', message: "platform 只能是 '淘宝' 或 '抖音'" });
  }
  try {
    const { profile, availablePlatforms } = await getSkuProfile(code, platform);
    res.json({ pdtCode: code, platform, profile, availablePlatforms, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[profiles/sku] 拉取失败:', err.message);
    res.status(503).json({ error: 'fetch_failed', message: err.message, profile: null, availablePlatforms: [] });
  }
});

// GET /api/profiles/stores — 有画像数据的店铺清单（含各自最新数据月份）
router.get('/stores', async (_req, res) => {
  try {
    const stores = await listStoreProfiles();
    res.json({ stores, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[profiles/stores] 拉取失败:', err.message);
    res.status(503).json({ error: 'fetch_failed', message: err.message, stores: [] });
  }
});

// GET /api/profiles/store/:store?platform=&scope=month|all&month=2026-08 — 店铺人群画像（默认最新月份；scope=all 全部月份累计）
router.get('/store/:store', async (req, res) => {
  const store = String(req.params.store || '');
  const platform = req.query.platform ? String(req.query.platform) : '';
  const scope = req.query.scope === 'all' ? 'all' : 'month';
  const month = req.query.month ? String(req.query.month) : '';
  try {
    const profile = await getStoreProfile(store, platform, { scope, month });
    res.json({ store, platform, scope, month, profile, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[profiles/store] 拉取失败:', err.message);
    res.status(503).json({ error: 'fetch_failed', message: err.message, profile: null });
  }
});

// GET /api/anchors — 主播清单（按近一年购买数量倒序）
router.get('/anchors', async (_req, res) => {
  try {
    const anchors = await listAnchors();
    res.json({ anchors, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[anchors] 拉取失败:', err.message);
    res.status(503).json({ error: 'fetch_failed', message: err.message, anchors: [] });
  }
});

// GET /api/anchors/hot?name=xxx&topN=5 — 某主播热卖款 TOP N（真实款号）
router.get('/anchors/hot', async (req, res) => {
  const name = String(req.query.name || '');
  const topN = Math.min(Math.max(Number(req.query.topN) || 5, 1), 20);
  if (!name) return res.status(400).json({ error: 'bad_param', message: '缺少 name' });
  try {
    const hot = await getAnchorHot(name, topN);
    res.json({ name, hot, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[anchors/hot] 拉取失败:', err.message);
    res.status(503).json({ error: 'fetch_failed', message: err.message, hot: [] });
  }
});

// GET /api/anchors/by-code/:code — 某款号在哪些主播直播间热卖（近一年）
router.get('/anchors/by-code/:code', async (req, res) => {
  const code = String(req.params.code || '').trim().toLowerCase();
  try {
    const { byCode } = await getAnchorTotals();
    const rows = (byCode.get(code) || []).slice().sort((a, b) => b.qty - a.qty);
    res.json({ pdtCode: code, rows, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[anchors/by-code] 拉取失败:', err.message);
    res.status(503).json({ error: 'fetch_failed', message: err.message, rows: [] });
  }
});

// GET /api/anchors/audience?name=xxx&topN=20 — 主播 TopN 热卖款的受众画像加权聚合
router.get('/anchors/audience', async (req, res) => {
  const name = String(req.query.name || '');
  const topN = Math.min(Math.max(Number(req.query.topN) || 20, 1), 50);
  if (!name) return res.status(400).json({ error: 'bad_param', message: '缺少 name' });
  try {
    const { profile, used, missing } = await getAnchorAudience(name, topN);
    res.json({ name, topN, profile, used, missing, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[anchors/audience] 拉取失败:', err.message);
    res.status(503).json({ error: 'fetch_failed', message: err.message, profile: null, used: [], missing: [] });
  }
});

export default router;
