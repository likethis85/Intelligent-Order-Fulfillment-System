// 权限中心：钉钉部门权限 / 账号权限 / 管理员组
//
// 角色只有三档，从高到低：
//   admin（管理员组）→ 全部权限：管理后台 + 编辑货盘 + 数据同步 + 规则配置
//   edit（编辑）    → 可编辑货盘内容（增删改货盘、排品、面料数据）
//   view（查看）    → 只能看，所有写操作被服务端拒绝
//
// 判定优先级：管理员组 > 账号级例外 > 所在部门的最高角色 > 全局默认角色
//
// 配置存 server/data/access-control.json；登录过的用户目录存 server/data/access-users.json
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
// 测试可用 ACCESS_CONFIG_FILE 指向临时文件，避免污染真实权限配置
const CONFIG_FILE = process.env.ACCESS_CONFIG_FILE
  ? path.resolve(process.env.ACCESS_CONFIG_FILE)
  : path.join(DATA_DIR, 'access-control.json');
const USERS_FILE = process.env.ACCESS_USERS_FILE
  ? path.resolve(process.env.ACCESS_USERS_FILE)
  : path.join(DATA_DIR, 'access-users.json');

const ROLES = ['admin', 'edit', 'view'];
const ROLE_RANK = { view: 0, edit: 1, admin: 2 };
const MAX_TEXT = 60;

const DEFAULT_CONFIG = () => ({
  version: 1,
  updatedAt: null,
  settings: { defaultRole: 'view' },
  departments: [
    { id: 'dept-goods', name: '商品部', role: 'edit', source: 'manual', note: '' },
    { id: 'dept-supply', name: '供应链', role: 'edit', source: 'manual', note: '' },
  ],
  members: [],
  overrides: [],
  admins: [],
});

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

const text = (value, max = MAX_TEXT) => String(value ?? '').trim().slice(0, max);
const isRole = (value) => ROLES.includes(value);

// ── 配置读写（按 mtime 热加载，手工改 JSON 也能生效）────────────────────────
let cache = { config: null, mtime: 0 };

export function normalizeConfig(raw) {
  const base = DEFAULT_CONFIG();
  if (!raw || typeof raw !== 'object') return base;
  const settings = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
  const seenDept = new Set();
  const departments = (Array.isArray(raw.departments) ? raw.departments : [])
    .map((d) => ({
      id: text(d?.id, 80),
      name: text(d?.name, 40),
      role: isRole(d?.role) ? d.role : 'view',
      source: d?.source === 'dingtalk' ? 'dingtalk' : 'manual',
      parentId: d?.parentId ? text(d.parentId, 80) : null,
      note: text(d?.note, 120),
    }))
    .filter((d) => d.id && d.name && !seenDept.has(d.id) && seenDept.add(d.id));

  const seenMember = new Set();
  const members = (Array.isArray(raw.members) ? raw.members : [])
    .map((m) => ({
      userId: text(m?.userId, 120),
      name: text(m?.name, 40),
      email: m?.email ? text(m.email, 120) : null,
      deptIds: Array.isArray(m?.deptIds) ? [...new Set(m.deptIds.map((id) => text(id, 80)).filter(Boolean))] : [],
      source: m?.source === 'dingtalk' ? 'dingtalk' : 'manual',
    }))
    .filter((m) => m.userId && !seenMember.has(m.userId) && seenMember.add(m.userId));

  const seenOverride = new Set();
  const overrides = (Array.isArray(raw.overrides) ? raw.overrides : [])
    .map((o) => ({
      userId: text(o?.userId, 120),
      name: text(o?.name, 40),
      role: isRole(o?.role) ? o.role : 'view',
      note: text(o?.note, 120),
    }))
    .filter((o) => o.userId && !seenOverride.has(o.userId) && seenOverride.add(o.userId));

  const seenAdmin = new Set();
  const admins = (Array.isArray(raw.admins) ? raw.admins : [])
    .map((a) => ({ userId: text(a?.userId, 120), name: text(a?.name, 40) }))
    .filter((a) => a.userId && !seenAdmin.has(a.userId) && seenAdmin.add(a.userId));

  return {
    version: 1,
    updatedAt: raw.updatedAt ?? null,
    bootstrappedAt: raw.bootstrappedAt ?? null,
    settings: { defaultRole: isRole(settings.defaultRole) ? settings.defaultRole : 'view' },
    departments,
    members,
    overrides,
    admins,
  };
}

export function getConfig() {
  let mtime = 0;
  try { mtime = fs.statSync(CONFIG_FILE).mtimeMs; } catch { mtime = 0; }
  if (cache.config && cache.mtime === mtime) return cache.config;
  const config = normalizeConfig(mtime ? readJson(CONFIG_FILE, null) : null);
  cache = { config, mtime };
  return config;
}

export function saveConfig(next) {
  const merged = normalizeConfig({ ...getConfig(), ...next, updatedAt: new Date().toISOString() });
  if (merged.admins.length === 0) {
    const err = new Error('至少保留一名管理员，否则将无人能进入权限管理');
    err.code = 'no_admin_left';
    throw err;
  }
  writeJsonAtomic(CONFIG_FILE, merged);
  cache = { config: merged, mtime: fs.statSync(CONFIG_FILE).mtimeMs };
  return merged;
}

// ── 角色推导 ────────────────────────────────────────────────────────────────
function envAdminKeys() {
  return String(process.env.ACCESS_ADMIN_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function matchesKey(user, keys) {
  if (!keys.length) return false;
  const set = new Set(keys.map((k) => k.toLowerCase()));
  return [user.id, user.email, user.displayName].filter(Boolean).some((v) => set.has(String(v).toLowerCase()));
}

export function resolveRole(user, config = getConfig()) {
  if (!user?.id) return { role: 'view', reason: 'anonymous', deptNames: [] };
  if (matchesKey(user, envAdminKeys())) return { role: 'admin', reason: 'env_admin', deptNames: [] };
  if (config.admins.some((a) => a.userId === user.id)) return { role: 'admin', reason: 'admin_group', deptNames: [] };

  const override = config.overrides.find((o) => o.userId === user.id);
  if (override) return { role: override.role, reason: 'account_override', deptNames: [] };

  const member = config.members.find((m) => m.userId === user.id);
  const deptIds = member?.deptIds || [];
  const depts = config.departments.filter((d) => deptIds.includes(d.id));
  if (depts.length > 0) {
    // 员工可能同时在多个部门：取权限最高的那个
    const best = depts.reduce((a, b) => (ROLE_RANK[b.role] > ROLE_RANK[a.role] ? b : a), depts[0]);
    return { role: best.role, reason: 'department', deptNames: depts.map((d) => d.name) };
  }
  return { role: config.settings.defaultRole, reason: 'default', deptNames: [] };
}

export function accessFor(user, config = getConfig()) {
  const { role, reason, deptNames } = resolveRole(user, config);
  return {
    role,
    reason,
    deptNames,
    canEditTray: ROLE_RANK[role] >= ROLE_RANK.edit,
    canManageAccess: role === 'admin',
    canSyncData: role === 'admin',
    canEditRules: role === 'admin',
  };
}

// ── 登录用户目录（供后台挑选账号授权）──────────────────────────────────────
let userCache = null;
let userDirty = false;
let flushTimer = null;

function loadUsers() {
  if (userCache) return userCache;
  const raw = readJson(USERS_FILE, {});
  userCache = raw && typeof raw === 'object' ? raw : {};
  return userCache;
}

function flushUsers() {
  if (!userDirty || !userCache) return;
  userDirty = false;
  try { writeJsonAtomic(USERS_FILE, userCache); } catch (e) { console.warn('[access] 保存用户目录失败:', e.message); }
}

export function recordKnownUser(user) {
  if (!user?.id) return;
  const users = loadUsers();
  const now = Date.now();
  const prev = users[user.id];
  const next = {
    id: user.id,
    name: user.displayName || user.email || user.id,
    email: user.email || null,
    provider: user.provider || 'dingtalk',
    firstSeenAt: prev?.firstSeenAt || new Date(now).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
    loginCount: (prev?.loginCount || 0) + 0,
  };
  // 6 小时内的重复访问不写盘，避免每个请求都落文件
  if (prev && now - new Date(prev.lastSeenAt || 0).getTime() < 6 * 3600_000 && prev.name === next.name && prev.email === next.email) return;
  users[user.id] = next;
  userDirty = true;
  if (!flushTimer) {
    flushTimer = setTimeout(() => { flushTimer = null; flushUsers(); }, 1000);
    flushTimer.unref?.();
  }
}

export function listKnownUsers() {
  const users = loadUsers();
  return Object.values(users).sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)));
}

// 首次部署无人是管理员时，把第一个登录的人设为管理员，否则管理后台永远进不去
function bootstrapIfNeeded(user) {
  if (!user?.id) return;
  const config = getConfig();
  if (config.admins.length > 0 || config.bootstrappedAt) return;
  const next = { ...config, admins: [{ userId: user.id, name: user.displayName || user.id }], bootstrappedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  try {
    writeJsonAtomic(CONFIG_FILE, next);
    cache = { config: next, mtime: fs.statSync(CONFIG_FILE).mtimeMs };
    console.log(`[access] 首次初始化：${user.displayName || user.id} 已成为管理员`);
  } catch (e) {
    console.warn('[access] 初始化管理员失败:', e.message);
  }
}

// ── 钉钉通讯录同步（可选，需要企业应用 AppKey/AppSecret）────────────────────
const DINGTALK_API = 'https://oapi.dingtalk.com';

function dingtalkCreds() {
  const key = process.env.DINGTALK_APP_KEY || process.env.DINGTALK_APPKEY || '';
  const secret = process.env.DINGTALK_APP_SECRET || process.env.DINGTALK_APPSECRET || '';
  return { key, secret, configured: Boolean(key && secret) };
}

async function dingtalkToken() {
  const { key, secret } = dingtalkCreds();
  const url = `${DINGTALK_API}/gettoken?appkey=${encodeURIComponent(key)}&appsecret=${encodeURIComponent(secret)}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const j = await r.json();
  if (!j.access_token) throw new Error(`获取钉钉令牌失败：${j.errmsg || r.status}`);
  return j.access_token;
}

async function dingtalkPost(pathname, token, body) {
  const r = await fetch(`${DINGTALK_API}${pathname}?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const j = await r.json();
  if (j.errcode && j.errcode !== 0) throw new Error(`钉钉接口 ${pathname} 失败：${j.errmsg}（${j.errcode}）`);
  return j.result;
}

export async function syncDingTalkOrg() {
  const token = await dingtalkToken();
  const departments = [];
  const members = new Map();
  const queue = [{ id: 1, parentId: null }];
  const seen = new Set();

  while (queue.length && departments.length < 500) {
    const current = queue.shift();
    if (!current || seen.has(String(current.id))) continue;
    seen.add(String(current.id));
    const subs = await dingtalkPost('/topapi/v2/department/listsub', token, { dept_id: current.id });
    for (const d of Array.isArray(subs) ? subs : []) {
      const id = String(d.dept_id);
      if (seen.has(id)) continue;
      departments.push({ id: `dt-${id}`, name: text(d.name, 40) || `部门${id}`, parentId: current.parentId || (current.id === 1 ? null : `dt-${current.id}`), source: 'dingtalk', role: 'view', note: '' });
      queue.push({ id: d.dept_id, parentId: `dt-${id}` });
    }
    // 同步拉取该部门成员
    let cursor = 0;
    for (let page = 0; page < 20; page++) {
      const res = await dingtalkPost('/topapi/v2/user/list', token, { dept_id: current.id, cursor, size: 100 });
      const list = Array.isArray(res?.list) ? res.list : [];
      for (const u of list) {
        if (!u?.userid) continue;
        const prev = members.get(u.userid) || { userId: u.userid, name: text(u.name, 40) || u.userid, email: u.email || null, deptIds: [], source: 'dingtalk' };
        if (!prev.deptIds.includes(`dt-${current.id}`)) prev.deptIds.push(`dt-${current.id}`);
        members.set(u.userid, prev);
      }
      if (!res?.has_more) break;
      cursor = res.next_cursor ?? 0;
    }
  }

  const config = getConfig();
  const manualDepartments = config.departments.filter((d) => d.source !== 'dingtalk');
  const manualMembers = config.members.filter((m) => m.source !== 'dingtalk');
  const dtDeptMap = new Map(config.departments.filter((d) => d.source === 'dingtalk').map((d) => [d.id, d]));
  // 保留管理员已设过的部门角色，新增部门沿用全局默认（查看）
  const mergedDepartments = [
    ...manualDepartments,
    ...departments.map((d) => ({ ...d, role: dtDeptMap.get(d.id)?.role || 'view', note: dtDeptMap.get(d.id)?.note || '' })),
  ];
  const mergedMembers = [...manualMembers, ...[...members.values()]];
  const next = saveConfig({ ...config, departments: mergedDepartments, members: mergedMembers });
  return { departments: next.departments.filter((d) => d.source === 'dingtalk').length, members: members.size };
}

// ── Express 装配 ────────────────────────────────────────────────────────────
export function createAccessControl() {
  const router = Router();

  const ensure = (req) => {
    if (!req.access) {
      bootstrapIfNeeded(req.auth?.user);
      req.access = accessFor(req.auth?.user);
    }
    return req.access;
  };

  // 所有请求：记录用户目录并挂上权限（/me 之外的路由也可复用）
  const attach = (req, _res, next) => {
    if (req.auth?.user) {
      recordKnownUser(req.auth.user);
      bootstrapIfNeeded(req.auth.user);
      req.access = accessFor(req.auth.user);
    }
    next();
  };

  const requireAdmin = (req, res, next) => {
    if (!ensure(req).canManageAccess) {
      return res.status(403).json({ error: 'admin_required', message: '仅管理员可访问权限管理' });
    }
    next();
  };

  // 写方法需要“编辑”及以上；GET/HEAD 一律放行
  const guardWrites = (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (!ensure(req).canEditTray) {
      return res.status(403).json({ error: 'edit_forbidden', message: '当前账号只有查看权限，不能修改货盘内容' });
    }
    next();
  };

  const guardAdminWrites = (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (!ensure(req).canSyncData) {
      return res.status(403).json({ error: 'admin_required', message: '仅管理员可执行同步或修改规则' });
    }
    next();
  };

  router.get('/me', (req, res) => {
    const config = getConfig();
    const access = ensure(req);
    const member = config.members.find((m) => m.userId === req.auth?.user?.id);
    res.json({
      ...access,
      user: req.auth?.user || null,
      departments: member?.deptIds || [],
      defaultRole: config.settings.defaultRole,
      bootstrapped: Boolean(config.bootstrappedAt),
    });
  });

  router.get('/config', requireAdmin, (_req, res) => {
    res.json({ ok: true, config: getConfig(), users: listKnownUsers() });
  });

  router.put('/config', requireAdmin, (req, res) => {
    try {
      const body = req.body || {};
      const next = saveConfig({
        departments: body.departments,
        members: body.members,
        overrides: body.overrides,
        admins: body.admins,
        settings: body.settings,
      });
      res.json({ ok: true, config: next });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.code || 'invalid_config', message: err.message });
    }
  });

  router.get('/users', requireAdmin, (_req, res) => {
    res.json({ ok: true, users: listKnownUsers() });
  });

  router.get('/dingtalk/status', requireAdmin, (_req, res) => {
    const { key, secret, configured } = dingtalkCreds();
    res.json({ ok: true, configured, appKey: configured ? `${key.slice(0, 4)}****` : null, hint: configured ? null : '未配置 DINGTALK_APP_KEY / DINGTALK_APP_SECRET，可先手动维护部门与成员' });
  });

  router.post('/sync-dingtalk', requireAdmin, async (_req, res) => {
    if (!dingtalkCreds().configured) {
      return res.status(400).json({ ok: false, error: 'not_configured', message: '未配置钉钉企业应用 AppKey/AppSecret，无法同步通讯录' });
    }
    try {
      const stats = await syncDingTalkOrg();
      res.json({ ok: true, ...stats });
    } catch (err) {
      res.status(502).json({ ok: false, error: 'sync_failed', message: err.message });
    }
  });

  return { router, attach, requireAdmin, guardWrites, guardAdminWrites, getConfig, saveConfig, accessFor };
}
