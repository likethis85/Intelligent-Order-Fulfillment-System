// 货盘多人实时协同：WebSocket 广播 + 操作日志
// 客户端消息：hello / tray-update / ping
// 服务端消息：tray-updated / users / pong
import { WebSocketServer } from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveTrays } from './trays-store.js';
import { persistTray } from './sales-persist.js';

const LOG_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '.cache', 'trays-log.json');
const LOG_CAP = 500;

let opsLog = [];
try {
  opsLog = JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8')) || [];
} catch { opsLog = []; }

function appendLog(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return;
  const stamped = entries.map((e) => ({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    ...e,
  }));
  opsLog.push(...stamped);
  if (opsLog.length > LOG_CAP) opsLog = opsLog.slice(-LOG_CAP);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.writeFileSync(LOG_FILE, JSON.stringify(opsLog, null, 1));
  } catch (err) {
    console.warn('[ws-trays] 写操作日志失败:', err.message);
  }
}

function readLog({ trayId, limit = 200 } = {}) {
  let list = opsLog;
  if (trayId) list = list.filter((e) => e.trayId === trayId);
  return list.slice(-limit).reverse();
}

let activeWss = null;

export function broadcastToAll(msg) {
  if (!activeWss) return;
  const data = JSON.stringify(msg);
  for (const ws of activeWss.clients) {
    if (ws.readyState === 1) {
      try { ws.send(data); } catch { /* ignore */ }
    }
  }
}

export { appendLog, readLog };

export function attachTrayWs(server, auth, accessControl = null) {
  const wss = new WebSocketServer({
    server, path: '/ws/trays',
    verifyClient: ({ req, origin }, done) => {
      const session = auth.getSession(req);
      if (!session) return done(false, 401, 'Authentication required');
      if (!auth.isAllowedOrigin(origin)) return done(false, 403, 'Invalid origin');
      req.auth = session;
      done(true);
    },
  });
  activeWss = wss;
  const unsubscribe = auth.onRevoke((key) => {
    for (const ws of wss.clients) if (ws._sessionKey === key) ws.close(1008, 'Session ended');
  });
  // roomKey = trayId（null 表示大厅/未选货盘）
  const rooms = new Map(); // trayId → Set<ws>

  function joinRoom(ws, trayId) {
    if (ws._room && rooms.get(ws._room)) rooms.get(ws._room).delete(ws);
    ws._room = trayId;
    if (!rooms.has(trayId)) rooms.set(trayId, new Set());
    rooms.get(trayId).add(ws);
  }

  function broadcast(trayId, msg, exceptWs = null) {
    const set = rooms.get(trayId);
    if (!set) return;
    const data = JSON.stringify(msg);
    for (const ws of set) {
      if (!auth.getSession(ws._authRequest)) { ws.close(1008, 'Session ended'); continue; }
      if (ws !== exceptWs && ws.readyState === 1) ws.send(data);
    }
  }

  function roomUsers(trayId) {
    const set = rooms.get(trayId);
    if (!set) return [];
    return [...set].map((w) => w._user).filter(Boolean);
  }

  wss.on('connection', (ws, req) => {
    ws._authRequest = req;
    ws._sessionKey = req.auth.key;
    ws._user = req.auth.user.displayName.slice(0, 30);
    ws._room = null;
    // 只读账号仍可接收广播，但不能通过 WS 写货盘
    try {
      ws._canEdit = accessControl ? accessControl.accessFor(req.auth.user).canEditTray : true;
    } catch {
      ws._canEdit = false;
    }
    ws.on('message', (raw) => {
      if (!auth.getSession(req)) { ws.close(1008, 'Session ended'); return; }
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'hello') {
        joinRoom(ws, msg.trayId || null);
        broadcast(ws._room, { type: 'users', users: roomUsers(ws._room) }, ws);
        ws.send(JSON.stringify({ type: 'users', users: roomUsers(ws._room), canEdit: ws._canEdit }));
      } else if (msg.type === 'tray-update') {
        if (!ws._canEdit) {
          ws.send(JSON.stringify({ type: 'error', code: 'edit_forbidden', message: '当前账号只有查看权限，不能修改货盘内容' }));
          return;
        }
        const tray = msg.tray;
        if (!tray || !tray.id) return;
        // 本次真正改动的字段（接收方只应用这些字段，避免整盘覆盖对方刚改的其它字段）
        const changed = Array.isArray(msg.changed) ? msg.changed.filter((k) => typeof k === 'string') : undefined;
        // 保存（沿用现有 store，自动留快照）。带上改动字段 → 服务端按字段合并；
        // 没有字段清单的旧消息才走「比服务端旧就丢弃」的守卫。
        saveTrays([tray], [], changed && changed.length > 0 ? { [tray.id]: changed } : undefined)
          .then((r) => {
            const stale = (r.rejected || []).some((x) => x.id === tray.id);
            // 实际落盘的版本：按字段合并后可能和客户端发来的不一样，广播和落库都要用它
            const saved = (r.trays || []).find((x) => x.id === tray.id) || tray;
            if (stale) {
              console.warn(`[ws-trays] ${ws._user || '匿名'} 提交的货盘「${tray.name || tray.id}」比服务端旧，已丢弃`);
              // 把服务端版本回推给发送方，让它自己纠正过来（否则要等 15 秒轮询）
              if (ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'tray-updated', tray: saved, ops: [], changed: [], user: '服务端', at: new Date().toISOString() }));
              }
              return;
            }
            persistTray(saved).catch((e) => console.warn('[ws-trays] persistTray 失败:', e.message));
            appendLog(
              (msg.ops || []).map((op) => ({
                user: ws._user || '匿名',
                trayId: tray.id,
                trayName: saved.name || '',
                action: op.action || '修改',
                detail: op.detail || '',
                change: op.change || '',
              })),
            );
            broadcast(tray.id, {
              type: 'tray-updated',
              tray: saved,
              ops: msg.ops || [],
              changed,
              user: ws._user || '匿名',
              at: new Date().toISOString(),
            }, ws);
          })
          .catch((e) => console.warn('[ws-trays] saveTrays 失败:', e.message));
      } else if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    });
    ws.on('close', () => {
      const room = ws._room;
      if (room && rooms.get(room)) {
        rooms.get(room).delete(ws);
        broadcast(room, { type: 'users', users: roomUsers(room) });
      }
    });
  });

  // 心跳：30s ping，清理死连接
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.readyState !== 1) continue;
      if (!auth.getSession(ws._authRequest)) { ws.close(1008, 'Session ended'); continue; }
      try { ws.ping(); } catch { /* closed */ }
    }
  }, 30_000);
  wss.on('close', () => { clearInterval(heartbeat); unsubscribe(); });

  console.log('[ws-trays] WebSocket 就绪: /ws/trays');
  return wss;
}
