// 销量 REST API：直播当天销量 + 累计总销量（同一数据源 e106807e，但走两个查询）
// 注意：前端只在 tray.date < 今天 时才调用（tray_past_only）
import { Router } from 'express';
import { getDailySales, getCumulativeSales } from '../daysales-client.js';

const router = Router();

const pidList = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

// 合并：一次调用同时拿当日 + 累计（节省前端两次 fetch）
router.get('/summary', async (req, res) => {
  const date = String(req.query.date || '').trim();
  const pids = pidList(req.query.pids);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'bad_date', message: 'date 须 YYYY-MM-DD' });
  }
  if (pids.length === 0) return res.json({ date, daily: {}, cumulative: {} });
  try {
    const [dailyRes, cumuRes] = await Promise.all([
      getDailySales(pids, date),
      getCumulativeSales(pids),
    ]);
    res.json({ date, daily: dailyRes, cumulative: cumuRes, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.warn('[sales/summary]', err.message);
    res.status(503).json({ error: 'fetch_failed', message: err.message, daily: {}, cumulative: {} });
  }
});

// GET /api/sales/daily?date=YYYY-MM-DD&pids=...
router.get('/daily', async (req, res) => {
  const date = String(req.query.date || '').trim();
  const pids = pidList(req.query.pids);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'bad_date', message: 'date 须 YYYY-MM-DD' });
  }
  if (pids.length === 0) return res.json({ date, byPid: {} });
  try {
    const byPid = await getDailySales(pids, date);
    res.json({ date, byPid, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.warn('[sales/daily]', err.message);
    res.status(503).json({ error: 'fetch_failed', message: err.message, byPid: {} });
  }
});

// GET /api/sales/cumulative?pids=...
router.get('/cumulative', async (req, res) => {
  const pids = pidList(req.query.pids);
  if (pids.length === 0) return res.json({ byPid: {} });
  try {
    const byPid = await getCumulativeSales(pids);
    res.json({ byPid, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.warn('[sales/cumulative]', err.message);
    res.status(503).json({ error: 'fetch_failed', message: err.message, byPid: {} });
  }
});

export default router;
