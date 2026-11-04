import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, Clock3, Eye, LogIn, MousePointerClick, RefreshCw, Users,
} from 'lucide-react';
import {
  fetchUsageOverview, fetchUsagePages, fetchUsageUsers,
  type UsageOverview, type UsagePageRow, type UsageUserRow,
} from '@/data/api';

const PAGE_LABELS: Record<string, string> = {
  '/trays': '货盘',
  '/sequence': '直播排品',
  '/board': '选款看板',
  '/profile': '画像卡片',
  '/weather': '天气面板',
  '/config': '配置后台',
  '/access': '权限管理',
  '/usage': '访问统计',
};

const PROVIDER_LABELS: Record<string, string> = {
  dingtalk: '钉钉',
  supabase: '邮箱',
  sso: 'SSO',
};

const RANGES = [7, 30, 90] as const;

function pageLabel(row: UsagePageRow) {
  return PAGE_LABELS[row.path] || row.title || row.path;
}

function providerLabel(provider: string) {
  return PROVIDER_LABELS[provider] || provider || '未知';
}

function fmtDuration(ms: number) {
  if (!ms || ms < 1000) return '0 分钟';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

function fmtTime(ms: number) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function MetricCard({ label, value, hint, icon: Icon, tone, compact = false }: {
  label: string; value: string; hint?: string; icon: typeof Activity; tone: string; compact?: boolean;
}) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-edge bg-white p-4 shadow-sm">
      <span className={`absolute inset-x-0 top-0 h-[3px] ${tone}`} />
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[11px] font-medium text-ink-muted">{label}</div>
          <div className={`mt-1.5 font-semibold leading-none tracking-tight text-ink-primary ${compact ? 'whitespace-nowrap text-[20px]' : 'text-[26px]'}`}>{value}</div>
          {hint && <div className="mt-1.5 text-[11px] text-ink-muted">{hint}</div>}
        </div>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-subtle text-ink-secondary">
          <Icon size={16} strokeWidth={1.8} />
        </span>
      </div>
    </div>
  );
}

export default function UsagePage() {
  const [days, setDays] = useState<number>(30);
  const [overview, setOverview] = useState<UsageOverview | null>(null);
  const [pages, setPages] = useState<UsagePageRow[]>([]);
  const [users, setUsers] = useState<UsageUserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (range: number) => {
    setLoading(true);
    setError(null);
    try {
      const [o, p, u] = await Promise.all([
        fetchUsageOverview(range),
        fetchUsagePages(range),
        fetchUsageUsers(range),
      ]);
      setOverview(o);
      setPages(p.items);
      setUsers(u.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(days); }, [days, load]);

  const providerRows = useMemo(() => overview?.providers || [], [overview]);
  const totalProviderPv = providerRows.reduce((sum, p) => sum + p.pv, 0);

  return (
    <section className="mx-auto w-full max-w-[1240px] px-4 pb-16 pt-7 sm:px-6">
      <div className="mb-5 flex flex-wrap items-end gap-4">
        <div>
          <div className="mb-1 text-[11px] font-bold tracking-[0.16em] text-action-link">MARIUS · ANALYTICS</div>
          <h1 className="text-[26px] font-semibold tracking-tight">访问统计</h1>
          <p className="mt-1 text-[13px] text-ink-muted">智慧货盘的 SSO 登录、页面访问与在线活跃情况</p>
        </div>
        <div className="ml-auto flex items-center gap-1 rounded-lg border border-edge bg-white p-1 shadow-sm">
          {RANGES.map((range) => (
            <button
              key={range}
              type="button"
              onClick={() => setDays(range)}
              className={`rounded-md px-3 py-1.5 text-[12px] transition-colors ${days === range ? 'bg-action-primary font-semibold text-white' : 'text-ink-secondary hover:bg-surface-subtle'}`}
            >
              近 {range} 天
            </button>
          ))}
          <button
            type="button"
            onClick={() => { void load(days); }}
            disabled={loading}
            className="ml-1 flex h-8 w-8 items-center justify-center rounded-md text-ink-muted hover:bg-surface-subtle disabled:opacity-50"
            aria-label="刷新统计"
            title="刷新统计"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-stage-return-fg/20 bg-stage-return-bg px-4 py-3 text-[12.5px] text-stage-return-fg">
          统计加载失败：{error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <MetricCard label="当前在线" value={String(overview?.online ?? 0)} hint="最近 10 分钟有活跃" icon={Activity} tone="bg-emerald-500" />
        <MetricCard label="登录次数" value={String(overview?.logins ?? 0)} hint={`近 ${days} 天`} icon={LogIn} tone="bg-blue-500" />
        <MetricCard label="访客 UV" value={String(overview?.uv ?? 0)} hint="访问过页面的用户" icon={Users} tone="bg-violet-500" />
        <MetricCard label="页面 PV" value={String(overview?.pv ?? 0)} hint={`${overview?.pageCount ?? 0} 个页面`} icon={MousePointerClick} tone="bg-orange-500" />
        <MetricCard label="用户数" value={String(overview?.userCount ?? 0)} hint="登录过货盘的用户" icon={Eye} tone="bg-cyan-500" />
        <MetricCard label="累计活跃时长" value={fmtDuration(overview?.activeMs ?? 0)} hint="按心跳累计" icon={Clock3} tone="bg-teal-500" compact />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-edge bg-white px-4 py-3 text-[12px]">
        <span className="font-medium text-ink-secondary">登录来源</span>
        {providerRows.length === 0 && <span className="text-ink-muted">暂无数据</span>}
        {providerRows.map((p) => (
          <span key={p.provider} className="inline-flex items-center gap-2 rounded-full bg-surface-subtle px-3 py-1 text-ink-secondary">
            {providerLabel(p.provider)} <b className="font-semibold text-ink-primary">{p.pv}</b>
            <span className="text-ink-muted">PV</span>
            <span className="text-ink-muted">·</span>
            <span className="text-ink-muted">{p.uv} UV</span>
          </span>
        ))}
        {providerRows.length > 0 && (
          <span className="ml-auto text-[11px] text-ink-muted">合计 {totalProviderPv} PV</span>
        )}
      </div>

      <div className="mt-4 overflow-hidden rounded-xl border border-edge bg-white shadow-sm">
        <div className="flex items-center gap-2 border-b border-edge px-5 py-3.5">
          <h2 className="text-[13.5px] font-semibold">页面访问排行</h2>
          <span className="text-[11px] text-ink-muted">{pages.length} 个页面</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[620px] border-collapse text-[12.5px]">
            <thead>
              <tr className="bg-surface-subtle text-left text-[11px] text-ink-muted">
                <th className="px-5 py-2.5 font-medium">页面</th>
                <th className="px-3 py-2.5 font-medium">路径</th>
                <th className="px-3 py-2.5 text-right font-medium">PV</th>
                <th className="px-5 py-2.5 text-right font-medium">UV</th>
              </tr>
            </thead>
            <tbody>
              {pages.map((row) => (
                <tr key={row.path} className="border-t border-edge/60 hover:bg-surface-subtle/60">
                  <td className="px-5 py-3 font-medium">{pageLabel(row)}</td>
                  <td className="px-3 py-3 font-mono text-[11px] text-ink-muted">{row.path}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{row.pv}</td>
                  <td className="px-5 py-3 text-right tabular-nums">{row.uv}</td>
                </tr>
              ))}
              {!loading && pages.length === 0 && (
                <tr><td colSpan={4} className="px-5 py-10 text-center text-[12px] text-ink-muted">还没有页面访问数据</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-4 overflow-hidden rounded-xl border border-edge bg-white shadow-sm">
        <div className="flex items-center gap-2 border-b border-edge px-5 py-3.5">
          <h2 className="text-[13.5px] font-semibold">用户活动</h2>
          <span className="text-[11px] text-ink-muted">{users.length} 位用户</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] border-collapse text-[12px]">
            <thead>
              <tr className="bg-surface-subtle text-left text-[11px] text-ink-muted">
                <th className="px-5 py-2.5 font-medium">用户</th>
                <th className="px-3 py-2.5 font-medium">来源</th>
                <th className="px-3 py-2.5 font-medium">钉钉账号</th>
                <th className="px-3 py-2.5 font-medium">所属部门</th>
                <th className="px-3 py-2.5 font-medium">状态</th>
                <th className="px-3 py-2.5 text-right font-medium">登录次数</th>
                <th className="px-3 py-2.5 text-right font-medium">PV</th>
                <th className="px-3 py-2.5 text-right font-medium">页面数</th>
                <th className="px-3 py-2.5 text-right font-medium">活跃时长</th>
                <th className="px-3 py-2.5 font-medium">首次访问</th>
                <th className="px-3 py-2.5 font-medium">最近活动</th>
                <th className="px-5 py-2.5 text-right font-medium">登录频次</th>
              </tr>
            </thead>
            <tbody>
              {users.map((row) => (
                <tr key={row.userId} className="border-t border-edge/60 hover:bg-surface-subtle/60">
                  <td className="px-5 py-3">
                    <div className="font-medium">{row.name || row.email || row.userId}</div>
                    {row.email && <div className="mt-0.5 text-[10.5px] text-ink-muted">{row.email}</div>}
                  </td>
                  <td className="px-3 py-3">{providerLabel(row.provider)}</td>
                  <td className="px-3 py-3 font-mono text-[10.5px] text-ink-muted">{row.unionId || '—'}</td>
                  <td className="px-3 py-3 text-ink-secondary">{row.departments.length ? row.departments.join('、') : '—'}</td>
                  <td className="px-3 py-3">
                    <span className={`inline-flex items-center gap-1.5 text-[11px] ${row.online ? 'text-emerald-600' : 'text-ink-muted'}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${row.online ? 'bg-emerald-500' : 'bg-ink-muted/50'}`} />
                      {row.online ? '在线' : '离线'}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">{row.loginCount}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{row.pv}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{row.pageCount}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{fmtDuration(row.activeMs)}</td>
                  <td className="px-3 py-3 text-[11px] text-ink-muted">{fmtTime(row.firstVisitAt)}</td>
                  <td className="px-3 py-3 text-[11px] text-ink-muted">{fmtTime(row.lastActiveAt)}</td>
                  <td className="px-5 py-3 text-right tabular-nums">{row.loginsPerDay.toFixed(2)} 次/天</td>
                </tr>
              ))}
              {!loading && users.length === 0 && (
                <tr><td colSpan={12} className="px-5 py-10 text-center text-[12px] text-ink-muted">还没有用户访问数据</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
