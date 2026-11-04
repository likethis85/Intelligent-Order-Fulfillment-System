// Local usage analytics for 智慧货盘.
//
// This deliberately uses one small JSON file instead of adding a native SQLite
// dependency to a project that must run on Windows and Linux without a build
// toolchain. Writes are atomic and events are kept in memory between flushes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const MAX_VIEWS = 100_000;
const RETENTION_DAYS = 180;
const ONLINE_WINDOW_MS = 10 * 60_000;
const MAX_ACTIVE_GAP_MS = 2 * 60_000;

const now = () => Date.now();
const clean = (value, max = 160) => String(value ?? '').trim().slice(0, max);
const userKey = (user) => String(user?.id || user?.email || user?.displayName || '');

function emptyState() {
  return { sessions: {}, views: [] };
}

function readState(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object') return emptyState();
    return {
      sessions: raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {},
      views: Array.isArray(raw.views) ? raw.views : [],
    };
  } catch {
    return emptyState();
  }
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
  fs.renameSync(tmp, file);
}

export function createUsageStats(options = {}) {
  const file = options.file
    ? path.resolve(options.file)
    : process.env.USAGE_STATS_FILE
      ? path.resolve(process.env.USAGE_STATS_FILE)
      : path.join(DATA_DIR, 'usage-stats.json');
  const state = readState(file);
  let saveTimer = null;
  let dirty = false;

  function prune() {
    const cutoff = now() - RETENTION_DAYS * 86_400_000;
    state.views = state.views.filter((view) => Number(view.at) >= cutoff).slice(-MAX_VIEWS);
    for (const [key, session] of Object.entries(state.sessions)) {
      if (Number(session.lastSeenAt || session.startedAt || 0) < cutoff) delete state.sessions[key];
    }
  }

  function flush() {
    if (!dirty) return;
    dirty = false;
    prune();
    try { writeState(file, state); } catch (err) { console.warn('[usage] 保存统计失败:', err.message); }
  }

  function scheduleSave() {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      flush();
    }, 400);
    if (typeof saveTimer.unref === 'function') saveTimer.unref();
  }

  function ensureSession(key, user, telemetrySessionId) {
    const id = String(key || '');
    if (!id || !user?.id) return null;
    let session = state.sessions[id];
    const current = now();
    if (!session) {
      session = {
        id,
        userId: String(user.id),
        unionId: user.externalId || null,
        email: user.email || null,
        provider: user.provider || 'sso',
        name: clean(user.displayName || user.email || user.id, 80),
        startedAt: current,
        lastSeenAt: current,
        endedAt: null,
        activeMs: 0,
        lastPath: null,
        telemetrySessionId: telemetrySessionId || null,
      };
      state.sessions[id] = session;
      scheduleSave();
    } else {
      if (telemetrySessionId) session.telemetrySessionId = telemetrySessionId;
      if (user.displayName) session.name = clean(user.displayName, 80);
      if (user.email) session.email = user.email;
      if (user.externalId) session.unionId = user.externalId;
    }
    return session;
  }

  function startSession({ key, user, telemetrySessionId } = {}) {
    const session = ensureSession(key, user, telemetrySessionId);
    if (!session) return null;
    session.lastSeenAt = Math.max(Number(session.lastSeenAt || 0), now());
    scheduleSave();
    return session;
  }

  function recordEvent({ key, user, kind, path: pagePath = null, title = null } = {}) {
    const session = ensureSession(key, user, null);
    if (!session || !['session_start', 'page_view', 'heartbeat', 'session_end'].includes(kind)) return false;
    if (session.endedAt) return false;
    const at = now();
    const last = Number(session.lastSeenAt || at);
    const elapsed = Math.min(Math.max(0, at - last), MAX_ACTIVE_GAP_MS);
    session.activeMs = Number(session.activeMs || 0) + elapsed;
    session.lastSeenAt = Math.max(last, at);
    if (kind === 'session_end') session.endedAt = at;
    if (kind === 'page_view' && pagePath) {
      session.lastPath = clean(pagePath, 300);
      state.views.push({
        sessionId: session.id,
        userId: session.userId,
        unionId: session.unionId,
        email: session.email,
        provider: session.provider,
        name: session.name,
        path: clean(pagePath, 300),
        title: clean(title || pagePath, 160),
        at,
      });
    }
    scheduleSave();
    return true;
  }

  function endSession(key) {
    const session = state.sessions[String(key || '')];
    if (!session || session.endedAt) return false;
    const at = now();
    session.activeMs = Number(session.activeMs || 0) + Math.min(Math.max(0, at - Number(session.lastSeenAt || at)), MAX_ACTIVE_GAP_MS);
    session.lastSeenAt = at;
    session.endedAt = at;
    scheduleSave();
    return true;
  }

  const normalizeDays = (days) => Math.max(1, Math.min(365, Number(days) || 30));

  function overview(days = 30) {
    days = normalizeDays(days);
    const at = now();
    const since = at - days * 86_400_000;
    const sessions = Object.values(state.sessions).filter((s) => Number(s.startedAt) >= since);
    const views = state.views.filter((v) => Number(v.at) >= since);
    const userIds = new Set(sessions.map((s) => s.userId));
    const online = new Set(
      sessions.filter((s) => !s.endedAt && Number(s.lastSeenAt) >= at - ONLINE_WINDOW_MS).map((s) => s.userId),
    );
    const activeMs = sessions.reduce((sum, s) => {
      const live = !s.endedAt && Number(s.lastSeenAt) >= at - ONLINE_WINDOW_MS
        ? Math.min(MAX_ACTIVE_GAP_MS, Math.max(0, at - Number(s.lastSeenAt)))
        : 0;
      return sum + Number(s.activeMs || 0) + live;
    }, 0);
    const providers = {};
    for (const view of views) {
      const key = view.provider || 'sso';
      providers[key] ||= { provider: key, pv: 0, uv: new Set() };
      providers[key].pv += 1;
      providers[key].uv.add(view.userId);
    }
    return {
      days,
      logins: sessions.length,
      online: online.size,
      pv: views.length,
      uv: new Set(views.map((v) => v.userId)).size,
      userCount: userIds.size,
      pageCount: new Set(views.map((v) => v.path)).size,
      activeMs,
      providers: Object.values(providers).map((p) => ({ provider: p.provider, pv: p.pv, uv: p.uv.size })),
      generatedAt: at,
    };
  }

  function pages(days = 30) {
    days = normalizeDays(days);
    const since = now() - days * 86_400_000;
    const map = new Map();
    for (const view of state.views) {
      if (Number(view.at) < since) continue;
      const item = map.get(view.path) || { path: view.path, title: view.title || view.path, pv: 0, users: new Set() };
      item.pv += 1;
      item.title = view.title || item.title;
      item.users.add(view.userId);
      map.set(view.path, item);
    }
    return [...map.values()]
      .map((x) => ({ path: x.path, title: x.title, pv: x.pv, uv: x.users.size }))
      .sort((a, b) => b.pv - a.pv || a.path.localeCompare(b.path));
  }

  function users(days = 30, limit = 200) {
    days = normalizeDays(days);
    const since = now() - days * 86_400_000;
    const at = now();
    const onlineUsers = new Set(
      Object.values(state.sessions)
        .filter((s) => !s.endedAt && Number(s.lastSeenAt) >= at - ONLINE_WINDOW_MS)
        .map((s) => s.userId),
    );
    const map = new Map();
    for (const session of Object.values(state.sessions)) {
      if (Number(session.startedAt) < since) continue;
      const key = session.userId;
      const item = map.get(key) || {
        userId: key,
        unionId: session.unionId,
        email: session.email,
        name: session.name,
        provider: session.provider,
        loginCount: 0,
        activeMs: 0,
        firstVisitAt: Number(session.startedAt),
        lastActiveAt: Number(session.lastSeenAt),
        pages: new Set(),
        pv: 0,
      };
      item.loginCount += 1;
      item.activeMs += Number(session.activeMs || 0);
      item.firstVisitAt = Math.min(item.firstVisitAt, Number(session.startedAt));
      item.lastActiveAt = Math.max(item.lastActiveAt, Number(session.lastSeenAt));
      if (session.name) item.name = session.name;
      if (session.email) item.email = session.email;
      if (session.unionId) item.unionId = session.unionId;
      if (session.provider) item.provider = session.provider;
      map.set(key, item);
    }
    for (const view of state.views) {
      if (Number(view.at) < since) continue;
      const item = map.get(view.userId);
      if (!item) continue;
      item.pv += 1;
      item.pages.add(view.path);
      item.lastActiveAt = Math.max(item.lastActiveAt, Number(view.at));
    }
    return [...map.values()]
      .map((x) => ({
        userId: x.userId,
        unionId: x.unionId,
        email: x.email,
        name: x.name,
        provider: x.provider,
        loginCount: x.loginCount,
        loginsPerDay: Number((x.loginCount / days).toFixed(2)),
        pv: x.pv,
        pageCount: x.pages.size,
        activeMs: x.activeMs,
        firstVisitAt: x.firstVisitAt,
        lastActiveAt: x.lastActiveAt,
        online: onlineUsers.has(x.userId),
      }))
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      .slice(0, Math.max(1, Math.min(500, Number(limit) || 200)));
  }

  return { file, startSession, recordEvent, endSession, overview, pages, users, flush };
}
