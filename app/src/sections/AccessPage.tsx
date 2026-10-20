// 权限管理后台（仅管理员可见）
//   部门权限：商品部 / 供应链默认可编辑，其余部门默认只读
//   账号权限：可为某个人单独放宽或收紧（优先级高于部门）
//   管理员组：加入后拥有全部权限（管理后台 + 编辑货盘 + 同步 + 规则）
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Building2, Plus, RefreshCw, Save, ShieldCheck, Trash2, UserCog, Users } from 'lucide-react';
import {
  fetchAccessConfig, fetchDingTalkStatus, saveAccessConfig, syncDingTalkOrg,
} from '@/data/api';
import type { AccessConfig, AccessMe, AccessRole, KnownUser } from '@/data/api';

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
const REASON_LABEL: Record<string, string> = {
  admin_group: '来自管理员组',
  env_admin: '来自环境变量白名单',
  account_override: '来自账号单独授权',
  department: '来自所属部门',
  default: '未匹配部门，按默认角色',
  anonymous: '未登录',
};

export default function AccessPage({ me, onChanged }: { me: AccessMe | null; onChanged: () => void }) {
  const [draft, setDraft] = useState<AccessConfig | null>(null);
  const [users, setUsers] = useState<KnownUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [newDept, setNewDept] = useState('');
  const [dtStatus, setDtStatus] = useState<{ configured: boolean; appKey: string | null; hint: string | null } | null>(null);
  const [syncing, setSyncing] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetchAccessConfig();
      setDraft(res.config);
      setUsers(res.users || []);
      setDirty(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载权限配置失败');
    } finally {
      setLoading(false);
    }
    fetchDingTalkStatus().then(setDtStatus).catch(() => setDtStatus(null));
  };

  useEffect(() => { void load(); }, []);

  const patch = (next: Partial<AccessConfig>) => {
    setDraft((d) => (d ? { ...d, ...next } : d));
    setDirty(true);
  };

  // 已知用户 + 配置里已授权但未登录过的人，合并成一张可授权名单
  const roster = useMemo(() => {
    const map = new Map<string, { id: string; name: string; email: string | null }>();
    for (const u of users) map.set(u.id, { id: u.id, name: u.name, email: u.email });
    for (const m of draft?.members || []) if (!map.has(m.userId)) map.set(m.userId, { id: m.userId, name: m.name, email: m.email });
    for (const o of draft?.overrides || []) if (!map.has(o.userId)) map.set(o.userId, { id: o.userId, name: o.name, email: null });
    for (const a of draft?.admins || []) if (!map.has(a.userId)) map.set(a.userId, { id: a.userId, name: a.name, email: null });
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }, [users, draft]);

  const deptName = (id: string) => draft?.departments.find((d) => d.id === id)?.name || id;
  const memberOf = (userId: string) => draft?.members.find((m) => m.userId === userId);
  const overrideOf = (userId: string) => draft?.overrides.find((o) => o.userId === userId);
  const isAdmin = (userId: string) => Boolean(draft?.admins.some((a) => a.userId === userId));

  // 该账号当前实际生效的角色（前端预览，最终以服务端为准）
  const effectiveRole = (userId: string): AccessRole => {
    if (isAdmin(userId)) return 'admin';
    const o = overrideOf(userId);
    if (o) return o.role;
    const m = memberOf(userId);
    const roles = (m?.deptIds || []).map((id) => draft?.departments.find((d) => d.id === id)?.role).filter(Boolean) as AccessRole[];
    if (roles.length) return roles.includes('admin') ? 'admin' : roles.includes('edit') ? 'edit' : 'view';
    return draft?.settings.defaultRole || 'view';
  };

  const setDeptRole = (id: string, role: AccessRole) => {
    patch({ departments: (draft?.departments || []).map((d) => (d.id === id ? { ...d, role } : d)) });
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
    patch({
      departments: (draft?.departments || []).filter((d) => d.id !== id),
      members: (draft?.members || []).map((m) => ({ ...m, deptIds: m.deptIds.filter((x) => x !== id) })),
    });
  };

  const setMemberDept = (userId: string, name: string, deptId: string) => {
    const members = [...(draft?.members || [])];
    const idx = members.findIndex((m) => m.userId === userId);
    if (!deptId) {
      if (idx >= 0) members.splice(idx, 1);
    } else if (idx >= 0) {
      members[idx] = { ...members[idx], deptIds: [deptId] };
    } else {
      members.push({ userId, name, email: null, deptIds: [deptId], source: 'manual' });
    }
    patch({ members });
  };

  const setOverride = (userId: string, name: string, role: AccessRole | '') => {
    const overrides = (draft?.overrides || []).filter((o) => o.userId !== userId);
    if (role) overrides.push({ userId, name, role, note: '' });
    patch({ overrides });
  };

  const toggleAdmin = (userId: string, name: string) => {
    const has = isAdmin(userId);
    patch({
      admins: has
        ? (draft?.admins || []).filter((a) => a.userId !== userId)
        : [...(draft?.admins || []), { userId, name }],
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
      });
      setDraft(res.config);
      setDirty(false);
      toast.success('权限已保存，最迟下次刷新页面生效');
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const runDingTalkSync = async () => {
    setSyncing(true);
    try {
      const res = await syncDingTalkOrg();
      toast.success(`已同步 ${res.departments} 个部门、${res.members} 名成员`);
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
        <button
          onClick={() => { void save(); }}
          disabled={!dirty || saving}
          className="flex items-center gap-1.5 rounded-md bg-action-primary px-4 py-2 text-[12px] text-surface-card hover:opacity-90 disabled:opacity-40"
        >
          <Save size={13} /> {saving ? '保存中…' : dirty ? '保存权限' : '已保存'}
        </button>
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

      {/* 部门权限 */}
      <section className="mt-10">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-widest text-ink-muted">
            <Building2 size={13} /> 部门权限
          </div>
          <div className="flex items-center gap-2">
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
        <div className="mt-3 overflow-hidden border border-edge">
          <table className="w-full text-[12.5px]">
            <thead className="bg-surface-subtle text-left text-ink-muted">
              <tr>
                <th className="px-3 py-2 font-medium">部门</th>
                <th className="px-3 py-2 font-medium">来源</th>
                <th className="px-3 py-2 font-medium">货盘权限</th>
                <th className="px-3 py-2 font-medium">成员数</th>
                <th className="px-3 py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {draft.departments.map((d) => (
                <tr key={d.id} className="border-t border-edge">
                  <td className="px-3 py-2">{d.name}</td>
                  <td className="px-3 py-2 text-ink-muted">{d.source === 'dingtalk' ? '钉钉通讯录' : '手动添加'}</td>
                  <td className="px-3 py-2">
                    <select
                      value={d.role}
                      onChange={(e) => setDeptRole(d.id, e.target.value as AccessRole)}
                      className="rounded border border-edge-strong bg-surface-card px-2 py-1 text-[12px] outline-none focus:border-edge"
                    >
                      <option value="view">仅查看</option>
                      <option value="edit">可编辑货盘</option>
                      <option value="admin">管理员</option>
                    </select>
                  </td>
                  <td className="px-3 py-2 text-ink-muted">{draft.members.filter((m) => m.deptIds.includes(d.id)).length}</td>
                  <td className="px-3 py-2">
                    <button
                      onClick={() => removeDepartment(d.id)}
                      title="删除部门（不会删除已登录账号）"
                      className="flex items-center gap-1 text-ink-muted hover:text-stage-return-fg"
                    >
                      <Trash2 size={12} /> 删除
                    </button>
                  </td>
                </tr>
              ))}
              {draft.departments.length === 0 && (
                <tr><td colSpan={5} className="px-3 py-6 text-center text-ink-muted">还没有部门，先添加一个</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11.5px] leading-5 text-ink-faint">
          默认口径：商品部、供应链可编辑货盘，其余部门仅查看。部门角色相同时取最高权限；员工在多个部门时按最高权限生效。
        </p>
      </section>

      {/* 账号权限 */}
      <section className="mt-10">
        <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-widest text-ink-muted">
          <Users size={13} /> 账号权限（{roster.length} 人）
        </div>
        <div className="mt-3 overflow-x-auto border border-edge">
          <table className="w-full min-w-[760px] text-[12.5px]">
            <thead className="bg-surface-subtle text-left text-ink-muted">
              <tr>
                <th className="px-3 py-2 font-medium">姓名</th>
                <th className="px-3 py-2 font-medium">所属部门</th>
                <th className="px-3 py-2 font-medium">账号单独设置</th>
                <th className="px-3 py-2 font-medium">生效角色</th>
                <th className="px-3 py-2 font-medium">管理员组</th>
              </tr>
            </thead>
            <tbody>
              {roster.map((u) => {
                const deptId = memberOf(u.id)?.deptIds[0] || '';
                const override = overrideOf(u.id);
                const role = effectiveRole(u.id);
                return (
                  <tr key={u.id} className="border-t border-edge">
                    <td className="px-3 py-2">
                      <div className="font-medium">{u.name}</div>
                      <div className="text-[11px] text-ink-faint">{u.email || u.id}</div>
                    </td>
                    <td className="px-3 py-2">
                      <select
                        value={deptId}
                        onChange={(e) => setMemberDept(u.id, u.name, e.target.value)}
                        className="max-w-[180px] rounded border border-edge-strong bg-surface-card px-2 py-1 text-[12px] outline-none focus:border-edge"
                      >
                        <option value="">未分配</option>
                        {draft.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                      </select>
                      {memberOf(u.id)?.deptIds.length ? (
                        <div className="mt-1 text-[11px] text-ink-faint">{memberOf(u.id)!.deptIds.map(deptName).join('、')}</div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">
                      <select
                        value={override?.role || ''}
                        onChange={(e) => setOverride(u.id, u.name, e.target.value as AccessRole | '')}
                        className="rounded border border-edge-strong bg-surface-card px-2 py-1 text-[12px] outline-none focus:border-edge"
                      >
                        <option value="">跟随部门</option>
                        <option value="edit">强制可编辑</option>
                        <option value="view">强制仅查看</option>
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      <span className={`rounded border px-2 py-0.5 text-[11.5px] ${ROLE_BADGE[role]}`}>{ROLE_LABEL[role]}</span>
                    </td>
                    <td className="px-3 py-2">
                      <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-ink-secondary">
                        <input
                          type="checkbox"
                          checked={isAdmin(u.id)}
                          onChange={() => toggleAdmin(u.id, u.name)}
                          className="h-3.5 w-3.5"
                        />
                        加入管理员组
                      </label>
                    </td>
                  </tr>
                );
              })}
              {roster.length === 0 && (
                <tr><td colSpan={5} className="px-3 py-6 text-center text-ink-muted">还没有登录过的账号，等同事登录一次就会出现</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11.5px] leading-5 text-ink-faint">
          优先级：管理员组 &gt; 账号单独设置 &gt; 所属部门 &gt; 全局默认（{ROLE_LABEL[draft.settings.defaultRole]}）。
          账号单独设置只对「货盘编辑」生效，管理员组另开一列。
        </p>
      </section>

      {/* 钉钉通讯录同步 */}
      <section className="mt-10 border border-edge bg-surface-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-1.5 text-[13px] font-semibold">
              <RefreshCw size={13} /> 钉钉通讯录同步
              {dtStatus?.configured
                ? <span className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[11px] text-emerald-700">已配置 {dtStatus.appKey}</span>
                : <span className="rounded border border-edge bg-surface-subtle px-1.5 py-0.5 text-[11px] text-ink-secondary">未配置</span>}
            </div>
            <p className="mt-1.5 text-[12px] leading-5 text-ink-muted">
              {dtStatus?.configured
                ? '从钉钉企业通讯录拉取全部部门与成员，已有部门权限保持不变；新部门默认仅查看。'
                : (dtStatus?.hint || '在 server/.env 配置 DINGTALK_APP_KEY / DINGTALK_APP_SECRET（企业内部应用，需通讯录只读权限）后可自动同步。')}
            </p>
          </div>
          <button
            onClick={() => { void runDingTalkSync(); }}
            disabled={!dtStatus?.configured || syncing}
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
    </div>
  );
}
