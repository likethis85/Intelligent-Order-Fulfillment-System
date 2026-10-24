import { Router } from 'express';
import {
  isJushuitanConfigured,
  getJushuitanStatus,
  getItemsByPids,
  getInventoryByPids,
  requestJushuitan,
} from '../jushuitan-client.js';

const router = Router();

// GET /api/jushuitan/status — 查询聚水潭对接状态与授权有效期
router.get('/status', async (_req, res) => {
  try {
    const status = await getJushuitanStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/jushuitan/items — 按款号查询商品资料与 SKU 列表
// Query: ?pids=ME05FW039,ME15FW033
router.get('/items', async (req, res) => {
  if (!isJushuitanConfigured()) {
    return res.status(503).json({ ok: false, error: '聚水潭凭证未配置' });
  }

  const pidsParam = req.query.pids || req.query.ids || '';
  const pids = typeof pidsParam === 'string'
    ? pidsParam.split(',').map((s) => s.trim()).filter(Boolean)
    : Array.isArray(pidsParam)
      ? pidsParam.map((s) => String(s).trim()).filter(Boolean)
      : [];

  if (pids.length === 0) {
    return res.status(400).json({ ok: false, error: '缺少 pids 参数' });
  }

  try {
    const { items, byPid } = await getItemsByPids(pids);
    res.json({ ok: true, count: items.length, items, byPid });
  } catch (err) {
    console.error('[routes/jushuitan] 拉取商品失败:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/jushuitan/inventory — 按款号查询实时库存 (含现存、可用、锁库、在途数)
// Query: ?pids=ME05FW039,ME15FW033
router.get('/inventory', async (req, res) => {
  if (!isJushuitanConfigured()) {
    return res.status(503).json({ ok: false, error: '聚水潭凭证未配置' });
  }

  const pidsParam = req.query.pids || req.query.ids || '';
  const pids = typeof pidsParam === 'string'
    ? pidsParam.split(',').map((s) => s.trim()).filter(Boolean)
    : Array.isArray(pidsParam)
      ? pidsParam.map((s) => String(s).trim()).filter(Boolean)
      : [];

  if (pids.length === 0) {
    return res.status(400).json({ ok: false, error: '缺少 pids 参数' });
  }

  try {
    const result = await getInventoryByPids(pids);
    res.json({ ok: true, byPid: result.byPid, items: result.items });
  } catch (err) {
    console.error('[routes/jushuitan] 查询实时库存失败:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/jushuitan/query — 通用透传查询（仅管理员或内部运维调用）
// Body: { path: '/open/sku/query', biz: { ... } }
router.post('/query', async (req, res) => {
  if (!isJushuitanConfigured()) {
    return res.status(503).json({ ok: false, error: '聚水潭凭证未配置' });
  }

  const { path: apiPath, biz } = req.body || {};
  if (!apiPath || typeof apiPath !== 'string') {
    return res.status(400).json({ ok: false, error: '缺少 path 参数' });
  }

  try {
    const data = await requestJushuitan(apiPath, biz || {});
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
