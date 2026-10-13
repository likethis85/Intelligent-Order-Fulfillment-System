import { useEffect, useMemo, useState } from 'react';
import { Check, Search } from 'lucide-react';
import { AGE_LABELS, CROWD_LABELS, STAGE_LABELS, type Product } from '@/data/products';
import { useProducts } from '@/data/ProductsContext';
import {
  fetchAnchorAudience,
  fetchAnchorHot,
  fetchAnchors,
  fetchSkuProfile,
  fetchSkuProfileCodes,
  fetchStoreProfile,
  fetchStoreProfiles,
  readJsonCache,
  writeJsonCache,
  type AnchorInfo,
  type AudienceProfile,
  type Platform,
} from '@/data/api';

const PLATFORMS: Platform[] = ['淘宝', '抖音'];

function Bar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-[10.5px] text-ink-muted">{label}</span>
      <div className="h-[6px] flex-1 overflow-hidden rounded-full bg-surface-muted">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(value * 2, 100)}%` }} />
      </div>
      <span className="w-9 shrink-0 text-right text-[10.5px] font-medium">{value}%</span>
    </div>
  );
}

function PlatformToggle({ value, onChange }: { value: Platform; onChange: (p: Platform) => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-ink-muted">平台：</span>
      {PLATFORMS.map((p) => (
        <button
          key={p}
          onClick={() => onChange(p)}
          className={`rounded-full border px-3 py-1 text-[11.5px] transition-colors ${
            value === p ? 'border-edge bg-action-primary text-white' : 'border-edge-strong bg-surface-card hover:border-edge'
          }`}
        >
          {p}
        </button>
      ))}
    </div>
  );
}

// 动态画像：BI 按平台给不同维度（淘宝：年龄/性别/兴趣爱好/客群；抖音：年龄/性别/8大人群/人生阶段/省份），有什么渲染什么
function ProfileBody({ prof, accent }: { prof: AudienceProfile; accent: string }) {
  const blocks: { key: string; title: string; body: React.ReactNode }[] = [];
  if (prof.ages) {
    blocks.push({
      key: 'ages',
      title: '年龄分布',
      body: (
        <div className="mt-2 space-y-1.5">
          {prof.ages.map((v, i) => <Bar key={i} label={AGE_LABELS[i]} value={v} color={accent} />)}
        </div>
      ),
    });
  }
  if (prof.crowds) {
    blocks.push({
      key: 'crowds',
      title: '8大人群',
      body: (
        <div className="mt-2 space-y-1.5">
          {prof.crowds.map((v, i) => <Bar key={i} label={CROWD_LABELS[i]} value={v} color="bg-chart-bar-1" />)}
        </div>
      ),
    });
  }
  if (prof.interests) {
    blocks.push({
      key: 'interests',
      title: '兴趣爱好 Top10',
      body: (
        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5">
          {prof.interests.map((it) => (
            <Bar key={it.name} label={it.name} value={it.value} color="bg-tray-talent" />
          ))}
        </div>
      ),
    });
  }
  const genderExtras = prof.stages
    ? prof.stages.map((v, i) => <Bar key={i} label={STAGE_LABELS[i]} value={v} color="bg-chart-bar-2" />)
    : prof.customerType?.map((c) => <Bar key={c.name} label={c.name} value={c.value} color="bg-chart-bar-2" />);
  if (prof.female !== null || genderExtras?.length) {
    blocks.push({
      key: 'gender',
      title: '性别 / 人生阶段',
      body: (
        <div className="mt-2 space-y-1.5">
          {prof.female !== null && <Bar label="女性" value={prof.female} color={accent} />}
          {prof.female !== null && <Bar label="男性" value={100 - prof.female} color="bg-edge-strong" />}
          {genderExtras}
        </div>
      ),
    });
  }
  if (prof.provinces) {
    blocks.push({
      key: 'provinces',
      title: '常驻省份 Top10',
      body: (
        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5">
          {prof.provinces.map((pv) => (
            <Bar key={pv.name} label={pv.name} value={pv.value} color={accent} />
          ))}
        </div>
      ),
    });
  }
  if (blocks.length === 0) return <div className="text-[12px] text-ink-muted">暂无画像数据</div>;
  return (
    <div className="grid grid-cols-2 gap-x-8 gap-y-5">
      {blocks.map((b) => (
        <div key={b.key}>
          <div className="text-[10.5px] font-semibold tracking-widest text-ink-muted">{b.title}</div>
          {b.body}
        </div>
      ))}
    </div>
  );
}

function useSkuProfile(code: string | null, platform: Platform) {
  const cacheKey = code ? `marius:profiles:sku:v1:${code}:${platform}` : null;
  const [state, setState] = useState<{ profile: AudienceProfile | null; available: Platform[]; loading: boolean }>(() => {
    const cached = cacheKey ? readJsonCache<{ profile: AudienceProfile | null; available: Platform[] }>(cacheKey) : null;
    return cached
      ? { profile: cached.profile, available: cached.available, loading: false }
      : { profile: null, available: [], loading: true };
  });
  useEffect(() => {
    if (!code || !cacheKey) return;
    let alive = true;
    // 有缓存先显示缓存（不清空），后台拉新；无缓存才转 loading
    const cached = readJsonCache<{ profile: AudienceProfile | null; available: Platform[] }>(cacheKey);
    if (cached) setState({ profile: cached.profile, available: cached.available, loading: false });
    else setState((s) => ({ ...s, loading: true }));
    fetchSkuProfile(code, platform)
      .then((r) => {
        if (!alive) return;
        const next = { profile: r.profile, available: r.availablePlatforms || [] };
        setState({ ...next, loading: false });
        writeJsonCache(cacheKey, next);
      })
      .catch(() => alive && setState((s) => ({ ...s, loading: false })));
    return () => {
      alive = false;
    };
  }, [code, platform, cacheKey]);
  return state;
}

// 单款 × 平台的画像面板（自请求）；该平台无数据时如实提示
function SkuProfilePanel({ code, platform, accent }: { code: string; platform: Platform; accent: string }) {
  const { profile, loading } = useSkuProfile(code, platform);
  if (loading) return <div className="py-6 text-center text-[12px] text-ink-muted">画像加载中…</div>;
  if (!profile) {
    return (
      <div className="py-6 text-center text-[12px] text-ink-muted">
        {platform}暂无该款的画像数据（BI 单款人群画像共覆盖 240 款，未上架/无动销款不在其中）
      </div>
    );
  }
  return <ProfileBody prof={profile} accent={accent} />;
}

function ProductHeader({ p }: { p: Product }) {
  return (
    <div className="flex items-start gap-4 border-b border-edge-muted pb-4">
      <div>
        {p.img ? (
          <img src={p.img} alt={p.name} className="h-16 w-[85px] object-cover" />
        ) : (
          <div className="flex h-16 w-[85px] items-center justify-center bg-gradient-to-br from-surface-subtle to-surface-muted text-[10px] font-semibold text-ink-muted">{(p.id || '').slice(0, 2).toUpperCase() || '无图'}</div>
        )}
        <div className="mt-1 text-center text-[9px] text-ink-faint">{p.imgSource} 图</div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-bold">{p.name}</div>
        <div className="mt-0.5 text-[11px] text-ink-muted">{p.id.toUpperCase()} · {p.wave} · {p.category} · ¥{p.price}</div>
      </div>
      <div className="grid grid-cols-4 gap-4 text-center">
        {[['转化率', `${(p.conversion * 100).toFixed(1)}%`], ['拉新率', `${(p.newBuyer * 100).toFixed(0)}%`], ['退货率', `${(p.returnRate * 100).toFixed(0)}%`], ['净销量', String(p.netSales)]].map(([k, v]) => (
          <div key={k}>
            <div className="text-[14px] font-bold">{v}</div>
            <div className="mt-0.5 text-[10px] text-ink-muted">{k}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

type Mode = 'sku' | 'compare' | 'store' | 'anchor';
const MODES: { key: Mode; label: string }[] = [
  { key: 'anchor', label: '主播热卖榜' },
  { key: 'sku', label: '款号画像' },
  { key: 'compare', label: '画像对比' },
  { key: 'store', label: '店铺画像' },
];

export default function ProfilePage() {
  const PRODUCTS = useProducts();
  const [mode, setMode] = useState<Mode>('anchor');
  const [query, setQuery] = useState('');
  const [focusId, setFocusId] = useState(PRODUCTS[0]?.id ?? '');
  const [platform, setPlatform] = useState<Platform>('淘宝');
  const [compareIds, setCompareIds] = useState<string[]>([]);
  // 画像对比专用的搜索 keyword（与款号画像 search 隔离，避免互相干扰）
  const [compareQuery, setCompareQuery] = useState('');
  const [anchorName, setAnchorName] = useState(
    () => readJsonCache<AnchorInfo[]>('marius:profiles:anchors:v1')?.[0]?.name ?? '',
  );

  // 有 BI 画像数据的款号集合：空搜索时默认选项优先从这些款里挑（BI 单款画像只覆盖 240 款）
  const [covered, setCovered] = useState<Set<string> | null>(() => {
    const cached = readJsonCache<string[]>('marius:profiles:skuCodes:v1');
    return cached ? new Set(cached.map((c) => c.toLowerCase())) : null;
  });
  useEffect(() => {
    fetchSkuProfileCodes()
      .then((r) => {
        const codes = r.codes.map((c) => c.toLowerCase());
        setCovered(new Set(codes));
        writeJsonCache('marius:profiles:skuCodes:v1', codes);
      })
      .catch(() => { /* 失败保留缓存值 */ });
  }, []);

  const focus = PRODUCTS.find((p) => p.id === focusId) ?? PRODUCTS[0];

  // 默认聚焦的款如果不在画像覆盖里，自动切到第一个有画像的款，避免打开页面就是「暂无数据」
  useEffect(() => {
    if (!covered || !focus || covered.has(focus.id)) return;
    const first = PRODUCTS.find((p) => covered.has(p.id));
    if (first) setFocusId(first.id);
    // 只在 covered 首次加载时校正一次，不跟随用户后续点选
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [covered]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = q
      ? [...PRODUCTS.filter((p) => p.id.includes(q) || p.name.toLowerCase().includes(q))].sort((a, b) =>
          covered ? Number(covered.has(b.id)) - Number(covered.has(a.id)) : 0,
        )
      : covered
        ? // 空搜索：有画像的款排前面，凑满 12 个
          [...PRODUCTS.filter((p) => covered.has(p.id)), ...PRODUCTS.filter((p) => !covered.has(p.id))]
        : PRODUCTS;
    return pool.slice(0, 12);
  }, [query, PRODUCTS, covered]);

  // 款号画像：用户主动选了一个平台后 pin 住，期间不 auto-switch（即使该平台无数据）
  // 用户切到新 focusId 时清掉 pin；或数据加载完成、profile 真的有数据时也清掉 pin（让 auto-switch 重新接管）
  const skuQ = useSkuProfile(mode === 'sku' || mode === 'compare' ? (focus?.id ?? null) : null, platform);
  const [pinnedPlatform, setPinnedPlatform] = useState<Platform | null>(null);
  useEffect(() => {
    setPinnedPlatform(null);
  }, [focusId]);
  useEffect(() => {
    if (pinnedPlatform === null) {
      // 没有 pin：让 auto-switch 工作
      if (skuQ.loading) return;
      if (skuQ.profile !== null) return;
      if (skuQ.available.length === 0) return;
      if (skuQ.available.includes(platform)) return;
      setPlatform(skuQ.available[0]);
    }
    // 有 pin：不 auto-switch，让用户保留手动选择
  }, [skuQ.loading, skuQ.profile, skuQ.available, platform, pinnedPlatform]);

  const setPlatformManual = (p: Platform) => {
    setPinnedPlatform(p);
    setPlatform(p);
  };

  const compareProducts = useMemo(
    () => compareIds.map((id) => PRODUCTS.find((p) => p.id === id)).filter((p): p is Product => p !== undefined),
    [compareIds, PRODUCTS],
  );

  const toggleCompare = (id: string) =>
    setCompareIds((s) => (s.includes(id) ? s.filter((x) => x !== id) : compareProducts.length >= 4 ? s : [...s, id]));

  // 店铺画像
  const [stores, setStores] = useState<{ store: string; month: string; months: number[] }[]>(
    () => readJsonCache<{ store: string; month: string; months: number[] }[]>('marius:profiles:stores:v1') ?? [],
  );
  const [store, setStore] = useState(() => stores[0]?.store || '');
  const [storeScope, setStoreScope] = useState<'month' | 'all'>('month');
  const [storeMonth, setStoreMonth] = useState(''); // '' = 最新月份
  const [storeProf, setStoreProf] = useState<AudienceProfile | null>(null);
  const [storeLoading, setStoreLoading] = useState(false);
  useEffect(() => {
    fetchStoreProfiles()
      .then((r) => {
        setStores(r.stores);
        setStore((s) => s || r.stores[0]?.store || '');
        writeJsonCache('marius:profiles:stores:v1', r.stores);
      })
      .catch(() => { /* 失败保留缓存值 */ });
  }, []);
  useEffect(() => {
    if (!store) return;
    let alive = true;
    const cacheKey = `marius:profiles:store:v1:${store}:${storeScope}:${storeMonth}`;
    const cached = readJsonCache<AudienceProfile | null>(cacheKey);
    if (cached !== null) {
      setStoreProf(cached);
      setStoreLoading(false);
    } else {
      setStoreLoading(true);
    }
    fetchStoreProfile(store, storeScope === 'all' ? { scope: 'all' } : { month: storeMonth })
      .then((r) => {
        if (!alive) return;
        setStoreProf(r.profile);
        writeJsonCache(cacheKey, r.profile);
      })
      .catch(() => { /* 失败保留缓存值 */ })
      .finally(() => alive && setStoreLoading(false));
    return () => {
      alive = false;
    };
  }, [store, storeScope, storeMonth]);
  const storeMonths = useMemo(() => stores.find((s) => s.store === store)?.months ?? [], [stores, store]);
  const fmtMonth = (k: number) => `${String(k).slice(0, 4)}-${String(k).slice(4)}`;

  // 主播热卖榜
  const [anchors, setAnchors] = useState<AnchorInfo[]>(
    () => readJsonCache<AnchorInfo[]>('marius:profiles:anchors:v1') ?? [],
  );
  const [hot, setHot] = useState<{ pdtCode: string; qty: number; ratio: number }[]>([]);
  // 受众画像聚合（主播 Top20 热卖款加权）
  const [anchorAudience, setAnchorAudience] = useState<{
    profile: AudienceProfile | null;
    used: { pdtCode: string; qty: number }[];
    missing: string[];
  } | null>(null);
  const [audienceLoading, setAudienceLoading] = useState(false);
  const ANCHOR_TOPN = 20;
  useEffect(() => {
    fetchAnchors()
      .then((r) => {
        setAnchors(r.anchors);
        setAnchorName((n) => n || r.anchors[0]?.name || '');
        writeJsonCache('marius:profiles:anchors:v1', r.anchors);
      })
      .catch(() => { /* 失败保留缓存值 */ });
  }, []);
  useEffect(() => {
    if (!anchorName) return;
    let alive = true;
    const cacheKey = `marius:profiles:anchor:v1:${anchorName}:${ANCHOR_TOPN}`;
    const cached = readJsonCache<{ hot: { pdtCode: string; qty: number; ratio: number }[]; audience: { profile: AudienceProfile | null; used: { pdtCode: string; qty: number }[]; missing: string[] } | null }>(cacheKey);
    if (cached) {
      setHot(cached.hot);
      setAnchorAudience(cached.audience);
      setAudienceLoading(false);
    } else {
      setAnchorAudience(null);
      setAudienceLoading(true);
    }
    Promise.all([
      fetchAnchorHot(anchorName, ANCHOR_TOPN),
      fetchAnchorAudience(anchorName, ANCHOR_TOPN),
    ])
      .then(([hotR, audR]) => {
        if (!alive) return;
        const audience = { profile: audR.profile, used: audR.used, missing: audR.missing };
        setHot(hotR.hot);
        setAnchorAudience(audience);
        writeJsonCache(cacheKey, { hot: hotR.hot, audience });
      })
      .catch(() => { /* 失败保留缓存值 */ })
      .finally(() => alive && setAudienceLoading(false));
    return () => {
      alive = false;
    };
  }, [anchorName]);
  const hotRows = useMemo(
    () =>
      hot
        .map((h) => ({ h, p: PRODUCTS.find((x) => x.id === h.pdtCode.toLowerCase()) }))
        .filter((x): x is { h: (typeof hot)[number]; p: Product } => x.p !== undefined),
    [hot, PRODUCTS],
  );

  return (
    <div className="responsive-page profile-page px-10 py-8">
      <div className="page-heading flex items-end justify-between border-b border-edge pb-6">
        <div>
          <div className="text-[12px] font-light tracking-[0.3em] text-ink-faint">04 /</div>
          <h1 className="mt-2 text-[28px] font-bold leading-none">画像卡片</h1>
          <p className="mt-3 text-[13px] text-ink-muted">店铺画像 · 主播热卖榜 · 款号画像（淘宝/抖音）· 画像对比</p>
        </div>
        <div className="profile-modes flex gap-1.5">
          {MODES.map((m) => (
            <button
              key={m.key}
              onClick={() => setMode(m.key)}
              className={`rounded-full border px-3.5 py-1.5 text-[12px] transition-colors ${
                mode === m.key ? 'border-edge bg-action-primary text-white' : 'border-edge-strong bg-surface-card hover:border-edge'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── 款号画像：搜索 → 单款 → 平台切换 ── */}
      {mode === 'sku' && focus && (
        <div className="mt-6">
          <div className="flex items-center gap-2 border border-edge-strong bg-surface-card px-3 py-2">
            <Search size={14} className="text-ink-muted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索款号 / 名称，如 ME05、阔腿…"
              className="w-full bg-transparent text-[13px] outline-none"
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {results.map((p) => (
              <button
                key={p.id}
                onClick={() => setFocusId(p.id)}
                className={`rounded-full border px-3 py-1 text-[11.5px] transition-colors ${
                  focusId === p.id ? 'border-edge bg-action-primary text-white' : 'border-edge-strong bg-surface-card hover:border-edge'
                }`}
              >
                {p.id.toUpperCase()} · {p.name}
              </button>
            ))}
          </div>

          <div className="mt-6 border border-edge bg-surface-card p-6">
            <ProductHeader p={focus} />
            <div className="mt-4">
              <PlatformToggle value={platform} onChange={setPlatformManual} />
            </div>
            <div className="mt-5">
              <SkuProfilePanel code={focus.id} platform={platform} accent="bg-tray-talent" />
            </div>
          </div>
        </div>
      )}

      {/* ── 画像对比：多选款 ── */}
      {mode === 'compare' && (
        <div className="mt-6">
          <div className="flex items-center gap-2 border border-edge-strong bg-surface-card px-3 py-2">
            <Search size={14} className="text-ink-muted" />
            <input
              value={compareQuery}
              onChange={(e) => setCompareQuery(e.target.value)}
              placeholder="搜索款号 / 名称后点击图片加入对比（最多 4 款）"
              className="w-full bg-transparent text-[13px] outline-none"
            />
            {compareQuery && (
              <button onClick={() => setCompareQuery('')} className="text-[11.5px] text-ink-muted hover:text-ink-primary">
                清空
              </button>
            )}
          </div>
          {(() => {
            const q = compareQuery.trim().toLowerCase();
            const list = q
              ? PRODUCTS.filter((p) => p.id.includes(q) || p.name.toLowerCase().includes(q))
              : PRODUCTS.slice(0, 24); // 空搜索只展示前 24 个，避免滚动 6500 个商品
            return (
              <div className="mt-3 flex gap-3 overflow-x-auto pb-2">
                {list.length === 0 && <div className="text-[12.5px] text-ink-muted">无匹配款号</div>}
                {list.map((p) => {
                  const on = compareIds.includes(p.id);
                  return (
                    <button key={p.id} onClick={() => toggleCompare(p.id)} className={`relative w-[92px] shrink-0 text-left ${!on && compareProducts.length >= 4 ? 'opacity-40' : ''}`}>
                      <div className={`overflow-hidden border ${on ? 'border-edge' : 'border-transparent'}`}>
                        {p.img ? (
                          <img src={p.img} alt={p.name} className="aspect-[4/3] w-full object-cover" loading="lazy" />
                        ) : (
                          <div className="flex aspect-[4/3] w-full items-center justify-center bg-gradient-to-br from-surface-subtle to-surface-muted text-[10px] font-semibold text-ink-muted">{(p.id || '').slice(0, 2).toUpperCase() || '无图'}</div>
                        )}
                      </div>
                      {on && <span className="absolute right-1 top-1 rounded-full bg-action-primary p-0.5 text-white"><Check size={10} /></span>}
                      <div className="mt-1 truncate text-[10.5px] leading-4">{p.name}</div>
                    </button>
                  );
                })}
              </div>
            );
          })()}
          <div className="mt-6 grid gap-6 xl:grid-cols-2">
            {compareProducts.length === 0 && (
              <div className="text-[12.5px] text-ink-muted">点击上方商品图加入对比（最多 4 款）</div>
            )}
            {compareProducts.map((p) => (
                <div key={p.id} className="border border-edge bg-surface-card p-6">
                  <ProductHeader p={p} />
                  <div className="profile-comparison mt-4 flex gap-8">
                    <div className="flex-1">
                      <div className="mb-3 text-[11px] font-semibold tracking-widest text-stage-connect-fg">淘宝</div>
                      <SkuProfilePanel code={p.id} platform="淘宝" accent="bg-tray-talent" />
                    </div>
                    <div className="w-px bg-surface-muted" />
                    <div className="flex-1">
                      <div className="mb-3 text-[11px] font-semibold tracking-widest text-tray-store">抖音</div>
                      <SkuProfilePanel code={p.id} platform="抖音" accent="bg-tray-store" />
                    </div>
                  </div>
                </div>
            ))}
          </div>
        </div>
      )}

      {/* ── 店铺画像（真实 BI 月度数据） ── */}
      {mode === 'store' && (
        <div className="mt-6">
          <div className="flex flex-wrap gap-2">
            {stores.map((s) => (
              <button
                key={s.store}
                onClick={() => {
                  setStore(s.store);
                  setStoreMonth('');
                }}
                className={`rounded-full border px-4 py-1.5 text-[12.5px] transition-colors ${
                  store === s.store ? 'border-edge bg-action-primary text-white' : 'border-edge-strong bg-surface-card hover:border-edge'
                }`}
              >
                {s.store}
              </button>
            ))}
            {stores.length === 0 && <div className="text-[12.5px] text-ink-muted">店铺画像加载中…</div>}
          </div>
          <div className="mt-5 border border-edge bg-surface-card p-6">
            <div className="flex items-end justify-between border-b border-edge-muted pb-4">
              <div>
                <div className="text-[16px] font-bold">{store} · 店铺人群画像</div>
                <div className="mt-1 text-[11px] text-ink-muted">
                  {storeScope === 'all'
                    ? `数据范围：全部月份累计 · 支付人数（人次）${storeProf?.payers ? storeProf.payers.toLocaleString() : '—'}`
                    : `数据月份：${storeProf?.month || '—'}${storeProf?.payers ? ` · 支付人数 ${storeProf.payers.toLocaleString()}` : ''}`}
                  {storeScope === 'month' &&
                    storeProf?.month &&
                    !storeProf.month.startsWith('2026-10') &&
                    !storeProf.month.startsWith('2026/10') &&
                    ' · 店铺画像 ETL 调度恢复后每日更新'}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {storeScope === 'month' && storeMonths.length > 0 && (
                  <select
                    value={storeMonth || fmtMonth(storeMonths[0])}
                    onChange={(e) => setStoreMonth(e.target.value)}
                    className="rounded-full border border-edge-strong bg-surface-card px-2.5 py-1 text-[11.5px] outline-none"
                  >
                    {storeMonths.map((m) => {
                      const label = fmtMonth(m);
                      return (
                        <option key={m} value={label}>
                          {label}
                        </option>
                      );
                    })}
                  </select>
                )}
                {(['month', 'all'] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setStoreScope(s)}
                    className={`rounded-full border px-3 py-1 text-[11.5px] transition-colors ${
                      storeScope === s ? 'border-edge bg-action-primary text-white' : 'border-edge-strong bg-surface-card hover:border-edge'
                    }`}
                  >
                    {s === 'month' ? '逐月' : '累计'}
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-5">
              {storeLoading && <div className="py-6 text-center text-[12px] text-ink-muted">画像加载中…</div>}
              {!storeLoading && !storeProf && <div className="py-6 text-center text-[12px] text-ink-muted">该店铺暂无画像数据</div>}
              {!storeLoading && storeProf && <ProfileBody prof={storeProf} accent="bg-action-primary" />}
            </div>
          </div>
        </div>
      )}

      {/* ── 主播热卖榜（BI 近一年购买数量） ── */}
      {mode === 'anchor' && (
        <div className="anchor-layout mt-6 flex gap-6">
          <div className="anchor-options w-44 shrink-0 space-y-1">
            {anchors.map((a) => (
              <button
                key={a.name}
                onClick={() => setAnchorName(a.name)}
                className={`flex w-full items-center justify-between rounded-md px-3 py-2.5 text-left text-[12.5px] transition-colors ${
                  anchorName === a.name ? 'bg-surface-muted font-semibold' : 'hover:bg-surface-subtle'
                }`}
              >
                {a.name}
                <span className="text-[10px] text-ink-muted">{a.totalQty.toLocaleString()}件</span>
              </button>
            ))}
            {anchors.length === 0 && <div className="text-[12px] text-ink-muted">主播数据加载中…</div>}
          </div>
          <div className="flex-1">
            {/* 主播聚合受众画像（置顶：选主播第一眼看到的概要信息） */}
            <div className="border border-edge bg-surface-card p-6">
              <div className="flex items-baseline justify-between">
                <div>
                  <div className="text-[16px] font-bold">{anchorName} · 主播受众画像</div>
                  <div className="mt-1 text-[11px] text-ink-muted">
                    按 Top{ANCHOR_TOPN} 热卖款加权聚合，每款画像（淘宝 + 抖音）取 BI「类目占比」加权平均
                  </div>
                </div>
                {anchorAudience && (
                  <div className="text-[11px] text-ink-muted">
                    命中 <span className="font-semibold text-ink-primary">{anchorAudience.used.length}</span> / {ANCHOR_TOPN} 款
                    {anchorAudience.missing.length > 0 && (
                      <span className="ml-2 text-stage-return-fg">（{anchorAudience.missing.length} 款缺画像，已自动跳过）</span>
                    )}
                  </div>
                )}
              </div>
              {audienceLoading && <div className="mt-4 text-[12px] text-ink-muted">聚合画像加载中…</div>}
              {!audienceLoading && anchorAudience?.profile && (
                <div className="mt-4">
                  <ProfileBody prof={anchorAudience.profile} accent="bg-tray-talent" />
                </div>
              )}
              {!audienceLoading && anchorAudience && !anchorAudience.profile && (
                <div className="mt-4 text-[12px] text-ink-muted">
                  Top{ANCHOR_TOPN} 热卖款暂未匹配到有画像的款（BI 单款画像只覆盖 240 款，建议先回顾主播选品）
                </div>
              )}
            </div>
            <div className="mt-8 text-[11px] font-medium tracking-widest text-ink-muted">
              {anchorName} · 近一年热卖款 TOP{ANCHOR_TOPN}（点击看销量）
            </div>
            <div className="mt-3 space-y-2">
              {hotRows.length === 0 && hot.length > 0 && (
                <div className="text-[12.5px] text-ink-muted">
                  该主播的热卖款（{hot.map((h) => h.pdtCode).join('、')}）暂未匹配到当前商品池
                </div>
              )}
              {hotRows.length === 0 && hot.length === 0 && <div className="text-[12.5px] text-ink-muted">暂无热卖款数据</div>}
              {hotRows.map(({ h, p }, i) => {
                // key 必须用 index：BI csv 同款号多行（pdtCode 重复）
                return (
                  <button
                    key={`${h.pdtCode}-${i}`}
                    onClick={() => {
                      setFocusId(p.id);
                      setMode('sku');
                    }}
                    className="flex w-full items-center gap-4 border border-edge bg-surface-card px-4 py-3 text-left transition-colors hover:border-edge"
                  >
                    <span className="w-6 text-[18px] font-light text-ink-faint">{i + 1}</span>
                    {p.img ? (
                      <img src={p.img} alt={p.name} className="h-12 w-16 object-cover" />
                    ) : (
                      <div className="flex h-12 w-16 items-center justify-center bg-gradient-to-br from-surface-subtle to-surface-muted text-[10px] font-semibold text-ink-muted">{(p.id || '').slice(0, 2).toUpperCase() || '无图'}</div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-semibold">{p.name}</div>
                      <div className="text-[10.5px] text-ink-muted">{p.id.toUpperCase()} · ¥{p.price} · {p.category}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-[15px] font-bold">{h.qty}</div>
                      <div className="text-[10px] text-ink-muted">销量</div>
                    </div>
                  </button>
                );
              })}
            </div>
            <p className="mt-4 text-[11px] leading-5 text-ink-muted">
              主播热卖数据来自 BI「主播业绩数据_购买数量」卡片（近一年）。点击任意热卖款可查看其淘宝/抖音人群画像。
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
