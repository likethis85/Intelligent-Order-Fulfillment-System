// 货盘 REST API：GET 拉云端备份，PUT 增量写
// 失败兜底由前端决定（localStorage 还有一份）
import { Router } from 'express';
import { loadTrays, saveTrays, listSnapshots } from '../trays-store.js';
import { persistTray, removeTray } from '../sales-persist.js';
import { appendLog, readLog } from '../ws-trays.js';

const router = Router();

// GET /api/trays → 返回云端存的货盘（首次可能为空数组）
router.get('/', async (_req, res) => {
  try {
    const { trays, at } = await loadTrays();
    res.json({ ok: true, trays, updatedAt: at, count: trays.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PUT /api/trays → 增量写云端（同时自动留快照）
//   body.trays: 当前所有 tray（已删除的不在里面）
//   body.deletedTrayIds: 这次提交相对上一次被删除的 tray.id 列表（同步清 supabase 三张表的对应行）
// 落盘后异步把每个 tray 的「计划翻单量 / 不可翻单 / 款号明细」单条 upsert 到 Supabase（不影响主响应）
router.put('/', async (req, res) => {
  const trays = req.body?.trays;
  if (!Array.isArray(trays)) {
    return res.status(400).json({ ok: false, error: 'body.trays 必须是数组' });
  }
  const deletedIds = Array.isArray(req.body?.deletedTrayIds)
    ? req.body.deletedTrayIds.filter((s) => typeof s === 'string' && s.trim())
    : [];
  try {
    const r = await saveTrays(trays);
    // 异步：被删的 tray 清三张表；其余的 tray 做单条 upsert
    (async () => {
      const results = [];
      for (const id of deletedIds) {
        try {
          await removeTray(id);
          results.push({ trayId: id, action: 'removed' });
        } catch (e) {
          results.push({ trayId: id, action: 'remove-failed', error: e.message });
        }
      }
      for (const t of trays) {
        try {
          const c = await persistTray(t);
          results.push({ trayId: t?.id, action: 'upserted', ...c });
        } catch (e) {
          results.push({ trayId: t?.id, action: 'upsert-failed', error: e.message });
        }
      }
      const upserted = results.filter((r) => r.action === 'upserted').length;
      const removed = results.filter((r) => r.action === 'removed').length;
      if (upserted + removed > 0) {
        console.log(`[supabase] 增量更新：upsert ${upserted} 个 tray${removed ? ` / remove ${removed} 个 tray` : ''}`);
      }
    })().catch((e) => console.warn('[supabase] persist 异常:', e.message));
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/trays/snapshots → 列出历史快照文件（运维/恢复用）
router.get('/snapshots', async (_req, res) => {
  try {
    const files = await listSnapshots();
    res.json({ ok: true, files });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/trays/log?trayId=&limit=200 → 操作记录（倒序）
router.get('/log', (req, res) => {
  const trayId = String(req.query.trayId || '') || undefined;
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  res.json({ ok: true, entries: readLog({ trayId, limit }) });
});

// POST /api/trays/log → 兜底写操作记录（WS 断了也能记）
router.post('/log', (req, res) => {
  const trayId = String(req.body?.trayId || '');
  const user = req.auth.user.displayName.slice(0, 30);
  const ops = Array.isArray(req.body?.ops) ? req.body.ops : [];
  if (!trayId || ops.length === 0) {
    return res.status(400).json({ ok: false, error: '需要 trayId 和非空 ops' });
  }
  appendLog(
    ops.map((op) => ({
      user,
      trayId,
      trayName: String(req.body?.trayName || ''),
      action: op.action || '修改',
      detail: op.detail || '',
      change: op.change || '',
    })),
  );
  res.json({ ok: true });
});

export default router;
