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
import { fetchSsoOrg, ssoOrgStatus } from './sso-org.js';

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
      // role 为 null 表示继承父部门的角色，一直往上找，找不到用全局默认
      role: isRole(d?.role) ? d.role : null,
      source: d?.source === 'dingtalk' ? 'dingtalk' : 'manual',
      parentId: d?.parentId ? text(d.parentId, 80) : null,
      note: text(d?.note, 120),
    }))
    .filter((d) => d.id && d.name && !seenDept.has(d.id) && seenDept.add(d.id));

  const seenMember = new Set();
  const members = (Array.isArray(raw.members) ? raw.members : [])
    .map((m) => ({
      userId: text(m?.userId, 120),
      // 钉钉 unionId，与 SSO 登录返回的 external_id 对应，重名也不会认错人
      unionId: m?.unionId ? text(m.unionId, 120) : null,
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
      // 还没登录过的人只有钉钉 unionId，先按 unionId 记下来，登录后自动生效
      unionId: o?.unionId ? text(o.unionId, 120) : null,
      name: text(o?.name, 40),
      role: isRole(o?.role) ? o.role : 'view',
      note: text(o?.note, 120),
    }))
    .filter((o) => {
      const key = o.userId || o.unionId;
      if (!key || seenOverride.has(key)) return false;
      seenOverride.add(key);
      return true;
    });

  const seenAdmin = new Set();
  const admins = (Array.isArray(raw.admins) ? raw.admins : [])
    .map((a) => ({
      userId: text(a?.userId, 120),
      unionId: a?.unionId ? text(a.unionId, 120) : null,
      name: text(a?.name, 40),
    }))
    .filter((a) => {
      const key = a.userId || a.unionId;
      if (!key || seenAdmin.has(key)) return false;
      seenAdmin.add(key);
      return true;
    });

  return {
    version: 1,
    updatedAt: raw.updatedAt ?? null,
    bootstrappedAt: raw.bootstrappedAt ?? null,
    orgSyncedAt: raw.orgSyncedAt ?? null,
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

// 登录身份 → 通讯录成员：优先用钉钉 unionId，退回归属的 SSO 用户 id
export function findMember(user, config = getConfig()) {
  if (!user) return null;
  if (user.externalId) {
    const byUnion = config.members.find((m) => m.unionId && m.unionId === user.externalId);
    if (byUnion) return byUnion;
  }
  return config.members.find((m) => m.userId === user.id) || null;
}

// 部门角色沿 parentId 向上继承：子部门没单独设置时跟随父部门
function inheritedRole(deptId, byId, depth = 0) {
  const dept = byId.get(deptId);
  if (!dept || depth > 32) return null;
  if (dept.role) return dept.role;
  return dept.parentId ? inheritedRole(dept.parentId, byId, depth + 1) : null;
}

// 授权条目可能只记了 unionId（对方还没登录过），登录后按 unionId 认人
function samePerson(entry, user) {
  if (!entry || !user) return false;
  if (entry.userId && entry.userId === user.id) return true;
  return Boolean(entry.unionId && user.externalId && entry.unionId === user.externalId);
}

export function resolveRole(user, config = getConfig()) {
  if (!user?.id) return { role: 'view', reason: 'anonymous', deptNames: [] };
  if (matchesKey(user, envAdminKeys())) return { role: 'admin', reason: 'env_admin', deptNames: [] };
  if (config.admins.some((a) => samePerson(a, user))) return { role: 'admin', reason: 'admin_group', deptNames: [] };

  const override = config.overrides.find((o) => samePerson(o, user));
  if (override) return { role: override.role, reason: 'account_override', deptNames: [] };

  const member = findMember(user, config);
  const deptIds = member?.deptIds || [];
  const byId = new Map(config.departments.map((d) => [d.id, d]));
  let best = null;
  const deptNames = [];
  for (const deptId of deptIds) {
    const dept = byId.get(deptId);
    if (dept) deptNames.push(dept.name);
    const role = inheritedRole(deptId, byId);
    if (role && (!best || ROLE_RANK[role] > ROLE_RANK[best])) best = role;
  }
  // 员工可能同时在多个部门：取权限最高的那个
  if (best) return { role: best, reason: 'department', deptNames };
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
    // 钉钉 unionId，用来把登录账号和通讯录成员对上
    externalId: user.externalId || prev?.externalId || null,
    firstSeenAt: prev?.firstSeenAt || new Date(now).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
    loginCount: (prev?.loginCount || 0) + 0,
  };
  // 6 小时内的重复访问不写盘，避免每个请求都落文件
  if (prev && now - new Date(prev.lastSeenAt || 0).getTime() < 6 * 3600_000 && prev.name === next.name && prev.email === next.email && prev.externalId === next.externalId) return;
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

// ── 组织架构同步（数据来自统一登录服务，不直连钉钉）────────────────────────
// 老版本用代码预置了两个空壳部门，第一次同步时把它们的角色迁移到同名钉钉部门
const LEGACY_DEPARTMENT_MAP = { 'dept-goods': '商品部', 'dept-supply': '供应链中心' };

export async function syncSsoOrg() {
  const { departments, members, syncedAt, truncated } = await fetchSsoOrg();
  const config = getConfig();
  const previous = new Map(config.departments.map((d) => [d.id, d]));

  const syncedDepartments = [];
  const nameToId = new Map();
  for (const item of departments) {
    const rawId = text(item?.id, 40);
    if (!rawId) continue;
    const id = `dt-${rawId}`;
    const name = text(item?.name, 40) || `部门${rawId}`;
    const parent = item?.parent_id == null || item.parent_id === '' ? null : `dt-${text(item.parent_id, 40)}`;
    const old = previous.get(id);
    syncedDepartments.push({
      id,
      name,
      parentId: parent,
      role: old?.role ?? null,
      source: 'dingtalk',
      note: old?.note || '',
    });
    // 同名部门取第一个，用于老空壳部门的角色迁移
    if (!nameToId.has(name)) nameToId.set(name, id);
  }

  const manualDepartments = config.departments.filter((d) => d.source !== 'dingtalk');
  const manualMembers = config.members.filter((m) => m.source !== 'dingtalk');
  const keptManualDepartments = [];
  let migrated = 0;
  for (const dept of manualDepartments) {
    const targetId = nameToId.get(LEGACY_DEPARTMENT_MAP[dept.id]);
    const target = targetId ? syncedDepartments.find((d) => d.id === targetId) : null;
    // 空壳部门只在还没被单独配置过角色时迁移，避免覆盖用户后面的调整
    if (target && dept.role && !target.role) {
      target.role = dept.role;
      migrated += 1;
      continue;
    }
    keptManualDepartments.push(dept);
  }

  const seen = new Set();
  const syncedMembers = [];
  for (const person of members) {
    const userId = text(person?.userid, 120);
    if (!userId || seen.has(userId)) continue;
    seen.add(userId);
    syncedMembers.push({
      userId,
      unionId: person?.union_id ? text(person.union_id, 120) : null,
      name: text(person?.name, 40) || userId,
      email: person?.email ? text(person.email, 120) : null,
      deptIds: [...new Set((Array.isArray(person?.dept_ids) ? person.dept_ids : []).map((id) => `dt-${text(id, 40)}`))],
      source: 'dingtalk',
    });
  }

  const saved = saveConfig({
    ...config,
    departments: [...keptManualDepartments, ...syncedDepartments],
    members: [...manualMembers, ...syncedMembers],
    orgSyncedAt: new Date().toISOString(),
  });

  return {
    departments: saved.departments.filter((d) => d.source === 'dingtalk').length,
    members: syncedMembers.length,
    migrated,
    syncedAt,
    truncated,
  };
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
    const member = findMember(req.auth?.user, config);
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

  router.get('/org/status', requireAdmin, (_req, res) => {
    const status = ssoOrgStatus();
    const config = getConfig();
    res.json({
      ok: true,
      ...status,
      lastSyncedAt: config.orgSyncedAt || null,
      departments: config.departments.filter((d) => d.source === 'dingtalk').length,
      members: config.members.filter((m) => m.source === 'dingtalk').length,
      hint: status.configured ? null : '统一登录服务未配置 client 凭证，暂时只能手动维护部门与成员',
    });
  });

  router.post('/sync-org', requireAdmin, async (_req, res) => {
    if (!ssoOrgStatus().configured) {
      return res.status(400).json({ ok: false, error: 'not_configured', message: '统一登录服务未配置 client 凭证，无法读取通讯录' });
    }
    try {
      const stats = await syncSsoOrg();
      res.json({ ok: true, ...stats });
    } catch (err) {
      res.status(502).json({ ok: false, error: 'sync_failed', message: err.message });
    }
  });

  return { router, attach, requireAdmin, guardWrites, guardAdminWrites, getConfig, saveConfig, accessFor };
}
