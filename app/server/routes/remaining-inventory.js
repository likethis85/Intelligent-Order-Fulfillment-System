import { Router } from 'express';
import { listRemainingInventory, listLaunchYears, clearRemainingInventoryCache } from '../remaining-inventory-client.js';

const router = Router();

// GET /api/remaining-inventory?tag=尽快推|补单到仓后推|退货到仓后推|all&search=xxx&sort=estimate-desc&limit=50
router.get('/', async (req, res) => {
  const tag = String(req.query.tag || '');
  const search = String(req.query.search || '');
  const sort = String(req.query.sort || 'estimate-desc');
  const limit = Number(req.query.limit) || 50;
  try {
    const items = await listRemainingInventory({ tag, search, sort, limit });
    res.json({ items, count: items.length, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[remaining-inventory] 拉取失败:', err.message);
    res.status(503).json({ error: 'fetch_failed', message: err.message, items: [] });
  }
});

// POST /api/remaining-inventory/refresh — 清缓存，下次请求重拉
router.post('/refresh', (_req, res) => {
  clearRemainingInventoryCache();
  res.json({ ok: true });
});

// GET /api/remaining-inventory/launch-years — 所有 group 里的上新年份（去重，9999 排除）
router.get('/launch-years', async (_req, res) => {
  try {
    const years = await listLaunchYears();
    res.json({ years });
  } catch (err) {
    console.error('[remaining-inventory/launch-years]', err.message);
    res.status(503).json({ error: 'fetch_failed', message: err.message, years: [] });
  }
});

export default router;
