// 权限管理后台（仅管理员可见）
//   部门权限：商品部 / 供应链默认可编辑，其余部门默认只读
//   账号权限：可为某个人单独放宽或收紧（优先级高于部门）
//   管理员组：加入后拥有全部权限（管理后台 + 编辑货盘 + 同步 + 规则）
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Building2, ChevronDown, ChevronRight, History, Plus, RefreshCw, RotateCcw, Save, Search, ShieldCheck, Trash2, UserCog, Users, X } from 'lucide-react';
import {
  fetchAccessAudit, fetchAccessConfig, fetchAccessOrgStatus, saveAccessConfig, syncAccessOrg,
} from '@/data/api';
import type { AccessAuditEntry, AccessConfig, AccessDepartment, AccessMember, AccessMe, AccessRole, KnownUser } from '@/data/api';

const ROLE_LABEL: Record<AccessRole, string> = { admin: '管理员', edit: '可编辑', view: '仅查看' };
const ROLE_HINT: Record<AccessRole, string> = {
  admin: '全部权限：后台 + 编辑货盘 + 数据同步 + 规则',
  edit: '可编辑货盘内容（增删改、排品、面料数据）',
  view: '只能查看与导出，不能修改',
};
const ROLE_BADGE: Record<AccessRole, string> = {
  admin: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  edit: 'bg-sky-50 text-sky-700 border-sky-200',
  view: 'bg-surface-subtle text-ink-secondary border-edge',
};
// 账号来源徽标：钉钉账号 / 邮箱账号。邮箱账号同样可以加管理员或单独授权。
function ProviderTag({ provider }: { provider: string | null }) {
  if (!provider) return null;
  if (provider === 'dingtalk') {
    return <span className="ml-1.5 rounded border border-sky-200 bg-sky-50 px-1 text-[10px] text-sky-700">钉钉</span>;
  }
  return <span className="ml-1.5 rounded border border-violet-200 bg-violet-50 px-1 text-[10px] text-violet-700">邮箱</span>;
}

const REASON_LABEL: Record<string, string> = {
  admin_group: '来自管理员组',
  env_admin: '来自环境变量白名单',
  account_override: '来自账号单独授权',
  department: '来自所属部门',
  default: '未匹配部门，按默认角色',
  anonymous: '未登录',
};

export default function AccessPage({ me, onChanged, onDirtyChange }: {
  me: AccessMe | null;
  onChanged: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState<AccessConfig | null>(null);
  // 上一次从服务端读到的版本，用于「重置」和乐观锁
  const [savedSnapshot, setSavedSnapshot] = useState<AccessConfig | null>(null);
  const [users, setUsers] = useState<KnownUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [newDept, setNewDept] = useState('');
  const [orgStatus, setOrgStatus] = useState<{
    configured: boolean; baseUrl: string | null; clientId: string | null;
    lastSyncedAt: string | null; departments: number; members: number; hint: string | null; error: string | null;
  } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [deptQuery, setDeptQuery] = useState('');
  const [deptRoleFilter, setDeptRoleFilter] = useState<'all' | 'set' | 'inherit'>('all');
  const [deptSourceFilter, setDeptSourceFilter] = useState<'all' | 'dingtalk' | 'manual'>('all');
  const [onlyWithMembers, setOnlyWithMembers] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [adminDeptId, setAdminDeptId] = useState('');
  const [adminQuery, setAdminQuery] = useState('');
  // 某一行是否展开；没记录的按层级给默认值（默认只展开到「中心」这一层）
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});
  // 批量改权限时选中的部门
  const [checkedDepts, setCheckedDepts] = useState<Set<string>>(new Set());
  const [batchRole, setBatchRole] = useState<AccessRole | ''>('');
  // 成员名单弹窗
  const [memberModal, setMemberModal] = useState<AccessDepartment | null>(null);
  // 权限检查器
  const [checkQuery, setCheckQuery] = useState('');
  const [checkKey, setCheckKey] = useState<string | null>(null);
  // 变更记录
  const [audit, setAudit] = useState<AccessAuditEntry[] | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetchAccessConfig();
      setDraft(res.config);
      setSavedSnapshot(res.config);
      setUsers(res.users || []);
      setDirty(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载权限配置失败');
    } finally {
      setLoading(false);
    }
    fetchAccessOrgStatus().then(setOrgStatus).catch(() => setOrgStatus(null));
  };

  useEffect(() => { void load(); }, []);

  // 未保存状态同步给外层，切换页面时据此确认
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  // 刷新或关标签页时拦一下
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const patch = (next: Partial<AccessConfig>) => {
    setDraft((d) => (d ? { ...d, ...next } : d));
    setDirty(true);
  };

  // 可授权名单：通讯录全员（含还没登录过的人）+ 登录过但不在通讯录的人 + 已有授权条目
  const roster = useMemo(() => {
    type Row = {
      key: string; userId: string; unionId: string | null;
      name: string; email: string | null; deptIds: string[];
      loggedIn: boolean;
      // 账号来源：dingtalk = 钉钉账号，其余（supabase/邮箱）= 邮箱账号
      provider: string | null;
    };
    const rows = new Map<string, Row>();
    const knownByUnion = new Map<string, KnownUser>();
    for (const u of users) if (u.externalId) knownByUnion.set(u.externalId, u);
    const knownById = new Map(users.map((u) => [u.id, u]));

    for (const m of draft?.members || []) {
      const key = m.unionId || m.userId;
      if (!key || rows.has(key)) continue;
      const known = m.unionId ? knownByUnion.get(m.unionId) : knownById.get(m.userId);
      rows.set(key, {
        key,
        // 钉钉 userid 不是登录身份，只有确认登录过才填 userId
        userId: known?.id || (m.source === 'manual' ? m.userId : ''),
        unionId: m.unionId || null,
        name: known?.name || m.name,
        email: known?.email || m.email,
        deptIds: m.deptIds,
        loggedIn: Boolean(known),
        provider: known?.provider || 'dingtalk',
      });
    }
    for (const u of users) {
      const key = u.externalId || u.id;
      if (rows.has(key) || rows.has(u.id)) continue;
      const own = (draft?.members || []).find((m) => m.userId === u.id);
      rows.set(key, {
        key, userId: u.id, unionId: u.externalId || null,
        name: u.name, email: u.email, deptIds: own?.deptIds || [], loggedIn: true,
        provider: u.provider,
      });
    }
    // 已有行里出现过的身份键：授权条目若指向同一个人，就不再单独占一行。
    // （首次登录自动生成的管理员条目只带 userId，通讯录那行按 unionId 建行，
    //  不比对这两套 id 的话同一个人会显示成两行）
    const seenUserIds = new Set([...rows.values()].map((r) => r.userId).filter(Boolean));
    const seenUnionIds = new Set([...rows.values()].map((r) => r.unionId).filter(Boolean) as string[]);
    for (const entry of [...(draft?.overrides || []), ...(draft?.admins || [])]) {
      const key = entry.unionId || entry.userId;
      if (!key || rows.has(key)) continue;
      if ((entry.userId && seenUserIds.has(entry.userId))
        || (entry.unionId && seenUnionIds.has(entry.unionId))) continue;
      rows.set(key, {
        key, userId: entry.userId || '', unionId: entry.unionId || null,
        name: entry.name, email: null, deptIds: [], loggedIn: false,
        // 只有 unionId 说明来自通讯录，必然钉钉；否则来源未知
        provider: entry.unionId && !entry.userId ? 'dingtalk' : null,
      });
    }
    // 同一个人可能有两套身份键：登录账号（u_xxx）和钉钉 unionId 各占一行。
    // 只要名字相同、且两边各自只出现一次，就合并成一行，避免列表出现两条。
    const byName = new Map<string, Row[]>();
    for (const row of rows.values()) {
      const list = byName.get(row.name) || [];
      list.push(row);
      byName.set(row.name, list);
    }
    for (const list of byName.values()) {
      if (list.length !== 2) continue;
      const withUser = list.find((r) => r.userId && !r.unionId);
      const withUnion = list.find((r) => r.unionId && !r.userId);
      if (!withUser || !withUnion) continue;
      rows.delete(withUser.key);
      rows.set(withUnion.key, {
        ...withUnion,
        userId: withUser.userId,
        email: withUnion.email || withUser.email,
        loggedIn: true,
        provider: withUser.provider || withUnion.provider,
      });
    }
    return [...rows.values()].sort((a, b) => {
      if (a.loggedIn !== b.loggedIn) return a.loggedIn ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-CN');
    });
  }, [users, draft]);

  type RosterRow = (typeof roster)[number];

  // 搜索匹配：姓名、邮箱、账号 id 都算，且忽略大小写
  // （邮箱登录的人显示名可能只是邮箱前缀，只按姓名搜很容易搜不到）
  const matchesQuery = (row: RosterRow, query: string) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return row.name.toLowerCase().includes(q)
      || (row.email || '').toLowerCase().includes(q)
      || row.userId.toLowerCase().includes(q);
  };

  // 登录身份和通讯录成员是两套 id：优先用钉钉 unionId 关联，其次退回 userId
  const memberFor = (row: RosterRow): AccessMember | undefined => {
    if (row.unionId) {
      const linked = draft?.members.find((m) => m.unionId && m.unionId === row.unionId);
      if (linked) return linked;
    }
    return row.userId ? draft?.members.find((m) => m.userId === row.userId) : undefined;
  };

  const deptName = (id: string) => draft?.departments.find((d) => d.id === id)?.name || id;
  // 授权条目同样按 unionId 优先匹配，这样没登录过的人也能先设好
  const sameEntry = (entry: { userId?: string; unionId?: string | null }, row: RosterRow) =>
    Boolean((row.unionId && entry.unionId && entry.unionId === row.unionId)
      || (row.userId && entry.userId && entry.userId === row.userId));

  const overrideOf = (row: RosterRow) => draft?.overrides.find((o) => sameEntry(o, row));
  const isAdmin = (row: RosterRow) => Boolean(draft?.admins.some((a) => sameEntry(a, row)));

  // 部门 -> {自己 + 所有上级}，用来判断某人在不在指定部门的子树里
  const ancestorMap = useMemo(() => {
    const out = new Map<string, Set<string>>();
    const byId = new Map((draft?.departments || []).map((d) => [d.id, d]));
    for (const d of draft?.departments || []) {
      const set = new Set<string>();
      let cur: AccessDepartment | undefined = d;
      let guard = 0;
      while (cur && guard++ < 32) {
        set.add(cur.id);
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
      out.set(d.id, set);
    }
    return out;
  }, [draft]);
  const ancestorsOf = (id: string) => ancestorMap.get(id) || new Set<string>();

  // 已配置授权的人：管理员组 + 单独授权，只列这些，不分页
  const configuredRows = useMemo(
    () => roster.filter((r) => isAdmin(r) || Boolean(overrideOf(r))),
    [roster, draft],
  );

  // 候选池：按部门或姓名筛过才出结果，默认不列人
  const candidateRows = useMemo(() => {
    const query = adminQuery.trim();
    if (!adminDeptId && !query) return [];
    let list = roster.filter((r) => !isAdmin(r) && !overrideOf(r));
    if (adminDeptId) {
      list = list.filter((r) => (memberFor(r)?.deptIds || []).some((id) => ancestorsOf(id).has(adminDeptId)));
    }
    if (query) list = list.filter((r) => matchesQuery(r, query));
    return list.slice(0, 40);
  }, [roster, adminDeptId, adminQuery, draft]);

  // 部门角色沿 parentId 向上继承，null 表示一直往上找，找不到用全局默认
  const deptRoleMap = useMemo(() => {
    const out = new Map<string, AccessRole | null>();
    if (!draft) return out;
    const byId = new Map(draft.departments.map((d) => [d.id, d]));
    const resolve = (id: string, guard = 0): AccessRole | null => {
      if (out.has(id)) return out.get(id)!;
      const dept = byId.get(id);
      if (!dept || guard > 32) return null;
      const role = dept.role || (dept.parentId ? resolve(dept.parentId, guard + 1) : null);
      out.set(id, role);
      return role;
    };
    for (const d of draft.departments) resolve(d.id);
    return out;
  }, [draft]);

  // 成员数含子部门：部里的人算进上级部门
  const memberCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (!draft) return counts;
    const byId = new Map(draft.departments.map((d) => [d.id, d]));
    const buckets = new Map<string, Set<string>>();
    for (const m of draft.members) {
      for (const deptId of m.deptIds) {
        let cur = byId.get(deptId);
        let guard = 0;
        while (cur && guard++ < 32) {
          if (!buckets.has(cur.id)) buckets.set(cur.id, new Set());
          buckets.get(cur.id)!.add(m.userId);
          cur = cur.parentId ? byId.get(cur.parentId) : undefined;
        }
      }
    }
    for (const [key, set] of buckets) counts.set(key, set.size);
    return counts;
  }, [draft]);

  // 按父子关系排成树序，方便一眼看出层级
  const orderedDepartments = useMemo(() => {
    const list = draft?.departments || [];
    const byParent = new Map<string, AccessDepartment[]>();
    for (const d of list) {
      const key = d.parentId || '';
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key)!.push(d);
    }
    const out: AccessDepartment[] = [];
    const seen = new Set<string>();
    const walk = (parent: string) => {
      for (const d of byParent.get(parent) || []) {
        if (seen.has(d.id)) continue;
        seen.add(d.id);
        out.push(d);
        walk(d.id);
      }
    };
    walk('');
    for (const d of list) if (!seen.has(d.id)) out.push(d);
    return out;
  }, [draft]);

  const deptDepth = useMemo(() => {
    const out = new Map<string, number>();
    const byId = new Map((draft?.departments || []).map((d) => [d.id, d]));
    for (const d of draft?.departments || []) {
      let depth = 0;
      let cur: AccessDepartment | undefined = d;
      while (cur?.parentId && depth < 16) {
        cur = byId.get(cur.parentId);
        if (!cur) break;
        depth += 1;
      }
      out.set(d.id, depth);
    }
    return out;
  }, [draft]);

  const hasChildren = useMemo(() => {
    const set = new Set<string>();
    for (const d of draft?.departments || []) if (d.parentId) set.add(d.parentId);
    return set;
  }, [draft]);

  // 搜索时全部展开，否则折叠可能把命中的部门藏起来
  const searching = Boolean(deptQuery.trim());
  const isOpen = (d: AccessDepartment) => (searching ? true : (openMap[d.id] ?? (deptDepth.get(d.id) || 0) <= 1));

  // 只保留「所有上级都展开」的行
  const visibleTree = useMemo(() => {
    const byId = new Map(orderedDepartments.map((d) => [d.id, d]));
    return orderedDepartments.filter((d) => {
      let cur = d.parentId ? byId.get(d.parentId) : undefined;
      let guard = 0;
      while (cur && guard++ < 32) {
        if (!isOpen(cur)) return false;
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
      return true;
    });
  }, [orderedDepartments, openMap, deptDepth, searching]);

  const filteredDepartments = useMemo(() => {
    const query = deptQuery.trim();
    return visibleTree.filter((d) => {
      if (query && !d.name.includes(query)) return false;
      if (deptRoleFilter === 'set' && !d.role) return false;
      if (deptRoleFilter === 'inherit' && d.role) return false;
      if (deptSourceFilter !== 'all' && d.source !== deptSourceFilter) return false;
      if (onlyWithMembers && !(memberCounts.get(d.id) || 0)) return false;
      return true;
    });
  }, [visibleTree, deptQuery, deptRoleFilter, deptSourceFilter, onlyWithMembers, memberCounts]);

  const totalPages = Math.max(1, Math.ceil(filteredDepartments.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageDepartments = filteredDepartments.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  // 条件一变就回到第一页，避免停在超出范围的页码上
  useEffect(() => { setPage(1); }, [deptQuery, deptRoleFilter, deptSourceFilter, onlyWithMembers, pageSize]);

  // 该账号当前实际生效的角色（前端预览，最终以服务端为准）
  const effectiveRole = (row: RosterRow): AccessRole => {
    if (isAdmin(row)) return 'admin';
    const o = overrideOf(row);
    if (o) return o.role;
    const roles = (memberFor(row)?.deptIds || [])
      .map((id) => deptRoleMap.get(id))
      .filter(Boolean) as AccessRole[];
    if (roles.length) return roles.includes('admin') ? 'admin' : roles.includes('edit') ? 'edit' : 'view';
    return draft?.settings.defaultRole || 'view';
  };

  const ROLE_RANK: Record<AccessRole, number> = { view: 0, edit: 1, admin: 2 };

  // 权限检查器：给出最终角色，并把「为什么」这条链路摊开
  const explainRole = (row: RosterRow): { role: AccessRole; chain: string[] } => {
    if (isAdmin(row)) return { role: 'admin', chain: ['管理员组'] };
    const override = overrideOf(row);
    if (override) return { role: override.role, chain: ['账号单独授权'] };
    const byId = new Map((draft?.departments || []).map((d) => [d.id, d]));
    let best: { role: AccessRole; chain: string[] } | null = null;
    for (const deptId of memberFor(row)?.deptIds || []) {
      const chain: string[] = [];
      let cur = byId.get(deptId);
      let guard = 0;
      while (cur && guard++ < 32) {
        chain.push(cur.role ? `${cur.name}（${ROLE_LABEL[cur.role]}）` : cur.name);
        if (cur.role) {
          if (!best || ROLE_RANK[cur.role] > ROLE_RANK[best.role]) best = { role: cur.role, chain: [...chain] };
          break;
        }
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
    }
    if (best) return best;
    return { role: draft?.settings.defaultRole || 'view', chain: ['未匹配到部门，按全局默认'] };
  };

  // 与上次保存的版本比，哪些部门被改过
  const changedDeptIds = useMemo(() => {
    const out = new Set<string>();
    if (!draft || !savedSnapshot) return out;
    const old = new Map(savedSnapshot.departments.map((d) => [d.id, d]));
    for (const d of draft.departments) {
      const prev = old.get(d.id);
      if (!prev || (prev.role || null) !== (d.role || null)) out.add(d.id);
    }
    return out;
  }, [draft, savedSnapshot]);

  const checkMatches = useMemo(() => {
    const query = checkQuery.trim();
    if (!query) return [];
    return roster.filter((r) => matchesQuery(r, query)).slice(0, 8);
  }, [roster, checkQuery]);
  const checkedPerson = roster.find((r) => r.key === checkKey) || null;

  const loggedUnions = useMemo(
    () => new Set(roster.filter((r) => r.loggedIn && r.unionId).map((r) => r.unionId as string)),
    [roster],
  );

  const modalMembers = useMemo(
    () => (memberModal
      ? (draft?.members || []).filter((m) => m.deptIds.some((id) => ancestorsOf(id).has(memberModal.id)))
      : []),
    [memberModal, draft, ancestorMap],
  );

  const toggleChecked = (id: string) => {
    setCheckedDepts((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const togglePageChecked = (on: boolean) => {
    setCheckedDepts((prev) => {
      const next = new Set(prev);
      for (const d of pageDepartments) {
        if (on) next.add(d.id);
        else next.delete(d.id);
      }
      return next;
    });
  };

  const applyBatchRole = () => {
    if (!checkedDepts.size) return;
    patch({
      departments: (draft?.departments || []).map((d) => (checkedDepts.has(d.id) ? { ...d, role: batchRole || null } : d)),
    });
    setCheckedDepts(new Set());
  };

  const loadAudit = async () => {
    setAuditLoading(true);
    try {
      const res = await fetchAccessAudit();
      setAudit(res.entries || []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '读取改动记录失败');
    } finally {
      setAuditLoading(false);
    }
  };

  const setDeptRole = (id: string, role: AccessRole | '') => {
    patch({ departments: (draft?.departments || []).map((d) => (d.id === id ? { ...d, role: role || null } : d)) });
  };

  const addDepartment = () => {
    const name = newDept.trim();
    if (!name) return;
    if (draft?.departments.some((d) => d.name === name)) { toast.error('部门名已存在'); return; }
    const id = `dept-${Date.now().toString(36)}`;
    patch({ departments: [...(draft?.departments || []), { id, name, role: 'view', source: 'manual', note: '' }] });
    setNewDept('');
  };

  const removeDepartment = (id: string) => {
    const name = draft?.departments.find((d) => d.id === id)?.name || id;
    if (!window.confirm(`删除部门「${name}」？\n归属该部门的人不会删除，只是不再有它的权限。`)) return;
    patch({
      departments: (draft?.departments || []).filter((d) => d.id !== id),
      members: (draft?.members || []).map((m) => ({ ...m, deptIds: m.deptIds.filter((x) => x !== id) })),
    });
  };

  const resetDraft = () => {
    if (!savedSnapshot) return;
    if (!window.confirm('放弃本次所有未保存的修改，恢复到上次保存的状态？')) return;
    setDraft(savedSnapshot);
    setDirty(false);
  };

  const setOverride = (row: RosterRow, role: AccessRole | '') => {
    const overrides = (draft?.overrides || []).filter((o) => !sameEntry(o, row));
    if (role) overrides.push({ userId: row.userId, unionId: row.unionId, name: row.name, role, note: '' });
    patch({ overrides });
  };

  const toggleAdmin = (row: RosterRow) => {
    const has = isAdmin(row);
    patch({
      admins: has
        ? (draft?.admins || []).filter((a) => !sameEntry(a, row))
        // 加入前先去掉同一个人可能存在的另一条记录，避免重复
        : [...(draft?.admins || []).filter((a) => !sameEntry(a, row)), { userId: row.userId, unionId: row.unionId, name: row.name }],
    });
  };

  const save = async () => {
    if (!draft) return;
    if (draft.admins.length === 0) { toast.error('至少保留一名管理员'); return; }
    setSaving(true);
    try {
      const res = await saveAccessConfig({
        departments: draft.departments,
        members: draft.members,
        overrides: draft.overrides,
        admins: draft.admins,
        settings: draft.settings,
      }, draft.updatedAt);
      setDraft(res.config);
      setSavedSnapshot(res.config);
      setDirty(false);
      toast.success('权限已保存，最迟下次刷新页面生效');
      onChanged();
    } catch (e) {
      if ((e as { status?: number }).status === 409) {
        toast.error('权限配置已被其他人修改，你的改动没有保存', {
          action: { label: '加载最新', onClick: () => { void load(); } },
        });
      } else {
        toast.error(e instanceof Error ? e.message : '保存失败');
      }
    } finally {
      setSaving(false);
    }
  };

  const runOrgSync = async () => {
    setSyncing(true);
    try {
      const res = await syncAccessOrg();
      const migrated = res.migrated ? `，已迁移 ${res.migrated} 个旧部门权限` : '';
      toast.success(`已同步 ${res.departments} 个部门、${res.members} 名成员${migrated}`);
      await load();
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '同步失败');
    } finally {
      setSyncing(false);
    }
  };

  if (loading) {
    return <div className="responsive-page px-10 py-8 text-[13px] text-ink-muted">正在加载权限配置…</div>;
  }
  if (!draft) {
    return <div className="responsive-page px-10 py-8 text-[13px] text-ink-muted">权限配置读取失败，请确认后端已启动。</div>;
  }

  return (
    <div className="responsive-page access-page mx-auto w-full max-w-[1440px] px-6 py-8 lg:px-10">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-edge pb-6">
        <div>
          <div className="text-[12px] font-light tracking-[0.3em] text-ink-faint">07 /</div>
          <h1 className="mt-2 flex items-center gap-2 text-[28px] font-bold leading-none">
            <ShieldCheck size={24} className="text-ink-secondary" /> 权限管理
          </h1>
          <p className="mt-3 text-[13px] text-ink-muted">
            按钉钉部门授权，也可为单个账号单独设置；管理员组拥有全部权限
          </p>
        </div>
        <div className="flex items-center gap-2">
          {dirty && (
            <button
              onClick={resetDraft}
              className="flex items-center gap-1.5 rounded-md border border-edge-strong px-3 py-2 text-[12px] text-ink-secondary hover:border-edge"
            >
              <RotateCcw size={13} /> 重置
            </button>
          )}
          <button
            onClick={() => { void save(); }}
            disabled={!dirty || saving}
            className="flex items-center gap-1.5 rounded-md bg-action-primary px-4 py-2 text-[12px] text-surface-card hover:opacity-90 disabled:opacity-40"
          >
            <Save size={13} /> {saving ? '保存中…' : dirty ? '保存权限' : '已保存'}
          </button>
        </div>
      </div>

      {/* 当前登录人的权限 */}
      <section className="mt-8 border border-edge bg-surface-card p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[11px] font-medium tracking-widest text-ink-muted">我的权限</span>
          <span className={`rounded border px-2 py-0.5 text-[11.5px] font-medium ${ROLE_BADGE[me?.role || 'view']}`}>
            {ROLE_LABEL[me?.role || 'view']}
          </span>
          <span className="text-[12px] text-ink-muted">{REASON_LABEL[me?.reason || 'default']}</span>
          {me?.deptNames?.length ? <span className="text-[12px] text-ink-muted">部门：{me.deptNames.join('、')}</span> : null}
        </div>
        <p className="mt-2 text-[12px] leading-5 text-ink-muted">
          {ROLE_HINT[me?.role || 'view']}
        </p>
      </section>

      {/* 权限检查器 */}
      <section className="mt-6 border border-edge bg-surface-card p-5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-widest text-ink-muted">
            <Search size={13} /> 权限检查器
          </div>
          <input
            value={checkQuery}
            onChange={(e) => { setCheckQuery(e.target.value); setCheckKey(null); }}
            placeholder="输入姓名，看这个人最终是什么权限"
            className="h-8 w-64 rounded border border-edge-strong bg-surface-card px-2 text-[12px] outline-none focus:border-edge"
          />
          {checkedPerson && (
            <button onClick={() => { setCheckQuery(''); setCheckKey(null); }} className="text-[12px] text-ink-muted underline-offset-2 hover:underline">
              清空
            </button>
          )}
        </div>

        {checkMatches.length > 0 && !checkedPerson && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {checkMatches.map((r) => (
              <button
                key={r.key}
                onClick={() => { setCheckKey(r.key); setCheckQuery(r.name); }}
                className="rounded border border-edge-strong bg-surface-card px-2 py-1 text-[12px] hover:border-edge"
              >
                {r.name}{r.loggedIn ? '' : '（未登录）'}
              </button>
            ))}
          </div>
        )}

        {checkedPerson && (() => {
          const info = explainRole(checkedPerson);
          return (
            <div className="mt-3 rounded border border-edge bg-surface-subtle px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                <span className="font-medium">{checkedPerson.name}</span>
                <ProviderTag provider={checkedPerson.provider} />
                <span className={`rounded border px-2 py-0.5 text-[11.5px] ${ROLE_BADGE[info.role]}`}>{ROLE_LABEL[info.role]}</span>
                <span className="text-ink-muted">判定链路：</span>
                <span className="text-ink-secondary">{info.chain.join(' → ')}</span>
              </div>
              <div className="mt-1 text-[11.5px] text-ink-faint">
                所属部门：{(memberFor(checkedPerson)?.deptIds || []).map(deptName).join('、') || '未分配'}
                {checkedPerson.loggedIn ? '' : ' · 该员工还没登录过，按钉钉身份预判'}
              </div>
            </div>
          );
        })()}
      </section>

      {/* 部门权限 */}
      <section className="mt-10">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-widest text-ink-muted">
            <Building2 size={13} /> 部门权限
            <span className="font-normal tracking-normal text-ink-faint">
              共 {orderedDepartments.length} 个，当前显示 {filteredDepartments.length} 个
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setOpenMap(Object.fromEntries(orderedDepartments.map((d) => [d.id, true])))}
              className="text-[12px] text-ink-muted underline-offset-2 hover:underline"
            >
              展开全部
            </button>
            <span className="text-ink-faint">/</span>
            <button
              onClick={() => setOpenMap(Object.fromEntries(orderedDepartments.map((d) => [d.id, false])))}
              className="text-[12px] text-ink-muted underline-offset-2 hover:underline"
            >
              收起全部
            </button>
            <input
              value={newDept}
              onChange={(e) => setNewDept(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addDepartment(); }}
              placeholder="新增部门名称"
              className="h-8 w-40 rounded border border-edge-strong bg-surface-card px-2 text-[12px] outline-none focus:border-edge"
            />
            <button onClick={addDepartment} className="flex items-center gap-1 rounded border border-edge-strong px-2.5 py-1.5 text-[12px] hover:border-edge">
              <Plus size={12} /> 添加
            </button>
          </div>
        </div>

        {/* 过滤条件 */}
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded border border-edge bg-surface-subtle px-3 py-2">
          <input
            value={deptQuery}
            onChange={(e) => setDeptQuery(e.target.value)}
            placeholder="搜索部门名称"
            className="h-7 w-36 rounded border border-edge-strong bg-surface-card px-2 text-[12px] outline-none focus:border-edge"
          />
          <select
            value={deptRoleFilter}
            onChange={(e) => setDeptRoleFilter(e.target.value as typeof deptRoleFilter)}
            className="h-7 rounded border border-edge-strong bg-surface-card px-1.5 text-[12px] outline-none focus:border-edge"
          >
            <option value="all">全部权限</option>
            <option value="set">已单独设置</option>
            <option value="inherit">跟随上级</option>
          </select>
          <select
            value={deptSourceFilter}
            onChange={(e) => setDeptSourceFilter(e.target.value as typeof deptSourceFilter)}
            className="h-7 rounded border border-edge-strong bg-surface-card px-1.5 text-[12px] outline-none focus:border-edge"
          >
            <option value="all">全部来源</option>
            <option value="dingtalk">钉钉通讯录</option>
            <option value="manual">手动添加</option>
          </select>
          <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-ink-secondary">
            <input type="checkbox" checked={onlyWithMembers} onChange={(e) => setOnlyWithMembers(e.target.checked)} className="h-3.5 w-3.5" />
            只看有成员
          </label>
          {(deptQuery || deptRoleFilter !== 'all' || deptSourceFilter !== 'all' || onlyWithMembers) && (
            <button
              onClick={() => { setDeptQuery(''); setDeptRoleFilter('all'); setDeptSourceFilter('all'); setOnlyWithMembers(false); }}
              className="text-[12px] text-ink-muted underline-offset-2 hover:underline"
            >
              清空条件
            </button>
          )}
        </div>

        {checkedDepts.size > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded border border-sky-200 bg-sky-50 px-3 py-2 text-[12px]">
            <span className="text-sky-800">已选 {checkedDepts.size} 个部门</span>
            <select
              value={batchRole}
              onChange={(e) => setBatchRole(e.target.value as AccessRole | '')}
              className="h-7 rounded border border-sky-200 bg-surface-card px-1.5 text-[12px] outline-none"
            >
              <option value="">继承上级</option>
              <option value="view">仅查看</option>
              <option value="edit">可编辑货盘</option>
              <option value="admin">管理员</option>
            </select>
            <button onClick={applyBatchRole} className="rounded bg-action-primary px-2.5 py-1 text-[12px] text-surface-card hover:opacity-90">
              应用到所选
            </button>
            <button onClick={() => setCheckedDepts(new Set())} className="text-[12px] text-ink-muted underline-offset-2 hover:underline">
              清空选择
            </button>
          </div>
        )}

        <div className="mt-2 overflow-x-auto border border-edge">
          <table className="w-full text-[12.5px]">
            <thead className="bg-surface-subtle text-left text-ink-muted">
              <tr>
                <th className="w-8 px-2 py-2 font-medium">
                  <input
                    type="checkbox"
                    title="选中本页全部"
                    checked={pageDepartments.length > 0 && pageDepartments.every((d) => checkedDepts.has(d.id))}
                    onChange={(e) => togglePageChecked(e.target.checked)}
                    className="h-3.5 w-3.5"
                  />
                </th>
                <th className="px-3 py-2 font-medium">部门</th>
                <th className="px-3 py-2 font-medium">来源</th>
                <th className="px-3 py-2 font-medium">货盘权限</th>
                <th className="px-3 py-2 font-medium">成员数</th>
                <th className="px-3 py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {pageDepartments.map((d, rowIndex) => {
                const depth = deptDepth.get(d.id) || 0;
                const inherited = deptRoleMap.get(d.id) || null;
                const count = memberCounts.get(d.id) || 0;
                const open = isOpen(d);
                // 层级用字号/字重/颜色三档区分：公司 > 中心 > 部门 > 小组
                const nameClass = depth === 0
                  ? 'text-[13.5px] font-semibold text-ink-primary'
                  : depth === 1
                    ? 'text-[13px] font-medium text-ink-primary'
                    : depth === 2
                      ? 'text-[12.5px] font-normal text-ink-primary'
                      : 'text-[12.5px] font-normal text-ink-secondary';
                const rowBg = depth === 0
                  ? 'bg-surface-subtle'
                  : rowIndex % 2 === 1 ? 'bg-surface-subtle/40' : '';
                return (
                  <tr key={d.id} className={`border-t border-edge ${rowBg}`}>
                    <td className="px-2 py-2">
                      <input
                        type="checkbox"
                        checked={checkedDepts.has(d.id)}
                        onChange={() => toggleChecked(d.id)}
                        className="h-3.5 w-3.5"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center">
                        {Array.from({ length: Math.min(depth, 5) }).map((_, i) => (
                          <span key={i} className="mr-4 h-4 w-px shrink-0 bg-edge" />
                        ))}
                        {depth > 0 && <span className="mr-1.5 h-px w-2 shrink-0 bg-edge" />}
                        {hasChildren.has(d.id) && !searching ? (
                          <button
                            onClick={() => setOpenMap((m) => ({ ...m, [d.id]: !open }))}
                            title={open ? '收起' : '展开'}
                            className="mr-1 flex h-4 w-4 shrink-0 items-center justify-center rounded text-ink-muted hover:bg-surface-muted hover:text-ink-primary"
                          >
                            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                          </button>
                        ) : (
                          <span className="mr-1 h-4 w-4 shrink-0" />
                        )}
                        {d.role && (
                          <span
                            title={d.role === 'admin' ? '已单独设为管理员' : d.role === 'edit' ? '已单独设为可编辑' : '已单独设为仅查看'}
                            className={`mr-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${d.role === 'admin' ? 'bg-emerald-500' : d.role === 'edit' ? 'bg-sky-500' : 'bg-amber-500'}`}
                          />
                        )}
                        <span className={nameClass}>{d.name}</span>
                        {changedDeptIds.has(d.id) && (
                          <span
                            title="与上次保存的版本不同"
                            className="ml-1.5 rounded border border-amber-300 bg-amber-50 px-1 text-[10px] leading-4 text-amber-700"
                          >
                            改动
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {d.source === 'dingtalk'
                        ? <span className="text-[11.5px] text-ink-faint">钉钉</span>
                        : <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-700">手动</span>}
                    </td>
                    <td className="px-3 py-2">
                      <select
                        value={d.role || ''}
                        onChange={(e) => setDeptRole(d.id, e.target.value as AccessRole | '')}
                        className={`rounded border px-2 py-1 text-[12px] outline-none focus:border-edge ${d.role ? 'border-edge-strong bg-surface-card' : 'border-edge bg-surface-subtle text-ink-muted'}`}
                      >
                        <option value="">
                          {inherited ? `继承上级（${ROLE_LABEL[inherited]}）` : `跟随默认（${ROLE_LABEL[draft.settings.defaultRole]}）`}
                        </option>
                        <option value="view">仅查看</option>
                        <option value="edit">可编辑货盘</option>
                        <option value="admin">管理员</option>
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      {count > 0 ? (
                        <button
                          onClick={() => setMemberModal(d)}
                          title="查看这个部门的人员名单（含下级）"
                          className="inline-block min-w-[26px] rounded border border-edge bg-surface-card px-1.5 py-0.5 text-center text-[11.5px] tabular-nums text-ink-secondary hover:border-edge-strong hover:text-ink-primary"
                        >
                          {count}
                        </button>
                      ) : <span className="text-ink-faint">—</span>}
                    </td>
                    <td className="px-3 py-2">
                      {d.source === 'manual' ? (
                        <button
                          onClick={() => removeDepartment(d.id)}
                          title="删除部门（不会删除已登录账号）"
                          className="flex items-center gap-1 text-ink-muted hover:text-stage-return-fg"
                        >
                          <Trash2 size={12} /> 删除
                        </button>
                      ) : <span className="text-ink-faint">—</span>}
                    </td>
                  </tr>
                );
              })}
              {pageDepartments.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-6 text-center text-ink-muted">
                  {orderedDepartments.length === 0 ? '还没有部门，点击下方同步通讯录' : '没有符合筛选条件的部门'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* 分页 */}
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[12px] text-ink-muted">
          <span>第 {currentPage} / {totalPages} 页，共 {filteredDepartments.length} 个部门</span>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setPage(Math.max(1, currentPage - 1))}
              disabled={currentPage <= 1}
              className="rounded border border-edge-strong px-2.5 py-1 hover:border-edge disabled:opacity-40"
            >
              上一页
            </button>
            <button
              onClick={() => setPage(Math.min(totalPages, currentPage + 1))}
              disabled={currentPage >= totalPages}
              className="rounded border border-edge-strong px-2.5 py-1 hover:border-edge disabled:opacity-40"
            >
              下一页
            </button>
            <select
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
              className="h-7 rounded border border-edge-strong bg-surface-card px-1.5 text-[12px] outline-none focus:border-edge"
            >
              <option value={10}>10 条/页</option>
              <option value={20}>20 条/页</option>
              <option value={50}>50 条/页</option>
            </select>
          </div>
        </div>

        <p className="mt-2 text-[11.5px] leading-5 text-ink-faint">
          默认口径：商品部、供应链可编辑货盘，其余部门仅查看。子部门未单独设置时跟随上级，员工在多个部门时按最高权限生效；
          成员数含下级部门。
        </p>
      </section>

      {/* 管理员与单独授权 */}
      <section className="mt-10">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-widest text-ink-muted">
            <ShieldCheck size={13} /> 管理员与单独授权
            <span className="font-normal tracking-normal text-ink-faint">已配置 {configuredRows.length} 人</span>
          </div>
        </div>

        {/* 加人：先按部门筛，或直接搜姓名 */}
        <div className="mt-3 border border-edge bg-surface-subtle p-3">
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={adminDeptId}
              onChange={(e) => setAdminDeptId(e.target.value)}
              className="h-8 max-w-[220px] rounded border border-edge-strong bg-surface-card px-2 text-[12px] outline-none focus:border-edge"
            >
              <option value="">按部门筛选…</option>
              {orderedDepartments.map((d) => (
                <option key={d.id} value={d.id}>
                  {'　'.repeat(Math.min(deptDepth.get(d.id) || 0, 3))}{d.name}
                </option>
              ))}
            </select>
            <input
              value={adminQuery}
              onChange={(e) => setAdminQuery(e.target.value)}
              placeholder="或输入姓名"
              className="h-8 w-36 rounded border border-edge-strong bg-surface-card px-2 text-[12px] outline-none focus:border-edge"
            />
            {(adminDeptId || adminQuery) && (
              <button
                onClick={() => { setAdminDeptId(''); setAdminQuery(''); }}
                className="text-[12px] text-ink-muted underline-offset-2 hover:underline"
              >
                清空
              </button>
            )}
            <span className="text-[11.5px] text-ink-faint">
              {!adminDeptId && !adminQuery
                ? '选择部门或输入姓名后再列出人员，不默认展示全部员工'
                : `找到 ${candidateRows.length} 人${candidateRows.length >= 40 ? '（仅显示前 40）' : ''}`}
            </span>
            {dirty && <span className="text-[11.5px] text-amber-700">改动未保存，记得点右上角「保存权限」</span>}
          </div>

          {candidateRows.length > 0 && (
            <div className="mt-2 max-h-[240px] overflow-auto border border-edge bg-surface-card">
              <table className="w-full text-[12.5px]">
                <tbody>
                  {candidateRows.map((u) => (
                    <tr key={u.key} className="border-b border-edge last:border-0">
                      <td className="px-3 py-1.5">
                        <span className="font-medium">{u.name}</span>
                        <ProviderTag provider={u.provider} />
                        {!u.loggedIn && (
                          <span className="ml-1.5 rounded border border-edge bg-surface-subtle px-1 text-[10px] text-ink-faint">未登录</span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-ink-muted">
                        {(memberFor(u)?.deptIds || []).map(deptName).join('、') || '未分配'}
                        {(u.email || u.userId) && (
                          <div className="text-[10.5px] text-ink-faint">{u.email || u.userId}</div>
                        )}
                      </td>
                      <td className="px-3 py-1.5">
                        <div className="flex justify-end gap-1">
                          <button onClick={() => toggleAdmin(u)} className="rounded border border-edge-strong px-2 py-0.5 text-[11.5px] hover:border-edge">
                            加为管理员
                          </button>
                          <button onClick={() => setOverride(u, 'edit')} className="rounded border border-edge-strong px-2 py-0.5 text-[11.5px] hover:border-edge">
                            强制可编辑
                          </button>
                          <button onClick={() => setOverride(u, 'view')} className="rounded border border-edge-strong px-2 py-0.5 text-[11.5px] hover:border-edge">
                            强制仅查看
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* 已配置的人 */}
        <div className="mt-3 overflow-x-auto border border-edge">
          <table className="w-full min-w-[680px] text-[12.5px]">
            <thead className="bg-surface-subtle text-left text-ink-muted">
              <tr>
                <th className="px-3 py-2 font-medium"><Users size={12} className="inline" /> 姓名</th>
                <th className="px-3 py-2 font-medium">所属部门</th>
                <th className="px-3 py-2 font-medium">授权方式</th>
                <th className="px-3 py-2 font-medium">生效角色</th>
                <th className="px-3 py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {configuredRows.map((u) => {
                const admin = isAdmin(u);
                const override = overrideOf(u);
                const role = effectiveRole(u);
                return (
                  <tr key={u.key} className="border-t border-edge">
                    <td className="px-3 py-2">
                      <span className="font-medium">{u.name}</span>
                      <ProviderTag provider={u.provider} />
                      {!u.loggedIn && (
                        <span className="ml-1.5 rounded border border-edge bg-surface-subtle px-1 text-[10px] text-ink-faint">未登录</span>
                      )}
                      {u.loggedIn && u.userId && !u.unionId && u.provider === 'dingtalk' && (
                        <span
                          title="该账号没关联到钉钉身份，按部门分配的权限对它不生效，只能用管理员组或单独授权"
                          className="ml-1.5 rounded border border-amber-300 bg-amber-50 px-1 text-[10px] text-amber-700"
                        >
                          未关联钉钉
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-ink-muted">
                      {(memberFor(u)?.deptIds || []).map(deptName).join('、') || '未分配'}
                    </td>
                    <td className="px-3 py-2">
                      {admin && <span className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[11px] text-emerald-700">管理员组</span>}
                      {override && (
                        <span className="ml-1 rounded border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[11px] text-sky-700">
                          单独{override.role === 'edit' ? '可编辑' : '仅查看'}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`rounded border px-2 py-0.5 text-[11.5px] ${ROLE_BADGE[role]}`}>{ROLE_LABEL[role]}</span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex gap-2 text-ink-muted">
                        {admin && (
                          <button onClick={() => toggleAdmin(u)} className="flex items-center gap-1 hover:text-stage-return-fg">
                            <Trash2 size={12} /> 移出管理员
                          </button>
                        )}
                        {override && (
                          <button onClick={() => setOverride(u, '')} className="flex items-center gap-1 hover:text-stage-return-fg">
                            <Trash2 size={12} /> 取消单独授权
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {configuredRows.length === 0 && (
                <tr><td colSpan={5} className="px-3 py-6 text-center text-ink-muted">还没有单独授权的人，所有人按部门规则生效</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="mt-2 text-[11.5px] leading-5 text-ink-faint">
          优先级：管理员组 &gt; 账号单独设置 &gt; 所属部门 &gt; 全局默认（{ROLE_LABEL[draft.settings.defaultRole]}）。
          通讯录里的人即使还没登录过，也可以先加进管理员组或单独授权，登录后按钉钉身份自动生效。
          邮箱账号不在钉钉通讯录里、没有部门归属，只能靠管理员组或单独授权赋权。
        </p>
      </section>

      {/* 组织架构同步 */}
      <section className="mt-10 border border-edge bg-surface-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-1.5 text-[13px] font-semibold">
              <RefreshCw size={13} /> 组织架构同步
              {orgStatus?.configured
                ? <span className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[11px] text-emerald-700">已连接 {orgStatus.clientId}</span>
                : <span className="rounded border border-edge bg-surface-subtle px-1.5 py-0.5 text-[11px] text-ink-secondary">未连接</span>}
            </div>
            <p className="mt-1.5 text-[12px] leading-5 text-ink-muted">
              {orgStatus?.configured
                ? `部门与成员来自统一登录服务（${orgStatus.baseUrl}），不直连钉钉。已同步 ${orgStatus.departments} 个部门、${orgStatus.members} 名成员${orgStatus.lastSyncedAt ? `，上次同步 ${new Date(orgStatus.lastSyncedAt).toLocaleString('zh-CN')}` : ''}。已有部门权限保持不变，新部门跟随上级。`
                : (orgStatus?.error || orgStatus?.hint || '统一登录服务未配置 client 凭证，暂时只能手动维护部门与成员。')}
            </p>
          </div>
          <button
            onClick={() => { void runOrgSync(); }}
            disabled={!orgStatus?.configured || syncing}
            className="flex items-center gap-1.5 rounded border border-edge-strong px-3 py-2 text-[12px] hover:border-edge disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RefreshCw size={12} className={syncing ? 'animate-spin' : ''} /> {syncing ? '同步中…' : '同步通讯录'}
          </button>
        </div>
      </section>

      <section className="mt-8 border border-edge bg-surface-subtle p-5 text-[12px] leading-6 text-ink-secondary">
        <div className="flex items-center gap-1.5 font-semibold text-ink-primary"><UserCog size={13} /> 权限是怎么生效的</div>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>服务端每个写接口都会校验，只读账号即使绕过页面也改不了数据（含 WebSocket 协同编辑）。</li>
          <li>数据同步与规则配置仅管理员可执行；查看权限的用户可以正常浏览、筛选、导出。</li>
          <li>首次部署时，第一个登录的账号会自动成为管理员，可在上方管理员组里调整。</li>
          <li>保存后新权限对下一次请求立即生效，页面上的按钮状态在刷新后更新。</li>
        </ul>
      </section>

      {/* 变更记录 */}
      <section className="mt-6 border border-edge bg-surface-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-[13px] font-semibold">
            <History size={13} /> 最近改动
          </div>
          <button
            onClick={() => { void loadAudit(); }}
            disabled={auditLoading}
            className="rounded border border-edge-strong px-3 py-1.5 text-[12px] hover:border-edge disabled:opacity-40"
          >
            {auditLoading ? '读取中…' : audit ? '刷新' : '查看'}
          </button>
        </div>
        {audit && (
          <div className="mt-3 space-y-2">
            {audit.length === 0 && <p className="text-[12px] text-ink-muted">还没有改动记录，保存一次权限后就会出现。</p>}
            {audit.map((entry, i) => (
              <div key={`${entry.at}-${i}`} className="rounded border border-edge bg-surface-subtle px-3 py-2">
                <div className="text-[11.5px] text-ink-muted">
                  {new Date(entry.at).toLocaleString('zh-CN')} · {entry.actor}
                </div>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[12px] text-ink-secondary">
                  {entry.changes.map((c, j) => <li key={j}>{c}</li>)}
                  {entry.total > entry.changes.length && <li>…另有 {entry.total - entry.changes.length} 项</li>}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 部门人员名单 */}
      {memberModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
          onClick={() => setMemberModal(null)}
        >
          <div
            className="max-h-[72vh] w-full max-w-lg overflow-hidden rounded-lg border border-edge bg-surface-card"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-edge px-4 py-3">
              <div className="text-[13px] font-semibold">
                {memberModal.name}
                <span className="ml-2 text-[12px] font-normal text-ink-muted">{modalMembers.length} 人</span>
              </div>
              <button onClick={() => setMemberModal(null)} className="text-ink-muted hover:text-ink-primary" aria-label="关闭">
                <X size={15} />
              </button>
            </div>
            <p className="px-4 pt-2 text-[11.5px] text-ink-faint">含下级部门，与表格里的成员数一致</p>
            <div className="max-h-[56vh] overflow-auto px-4 pb-3">
              {modalMembers.map((m) => (
                <div key={m.userId} className="flex items-start justify-between gap-3 border-b border-edge py-1.5 last:border-0">
                  <span className="text-[12.5px]">
                    {m.name}
                    {m.unionId && loggedUnions.has(m.unionId) ? null : (
                      <span className="ml-1.5 rounded border border-edge bg-surface-subtle px-1 text-[10px] text-ink-faint">未登录</span>
                    )}
                  </span>
                  <span className="shrink-0 text-right text-[11px] text-ink-faint">
                    {m.deptIds.filter((id) => ancestorsOf(id).has(memberModal.id)).map(deptName).join('、')}
                  </span>
                </div>
              ))}
              {modalMembers.length === 0 && (
                <div className="py-8 text-center text-[12px] text-ink-muted">这个部门还没有人</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
