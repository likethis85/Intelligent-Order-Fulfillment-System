import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Layers, LayoutGrid, BarChart3, Settings2, ListOrdered, CloudSun, LogOut, ShieldCheck } from 'lucide-react';
import { Toaster } from '@/components/ui/sonner';
import { toast } from 'sonner';
import BoardPage from '@/sections/BoardPage';
import SequencePage from '@/sections/SequencePage';
import TraysPage from '@/sections/TraysPage';
import ProfilePage from '@/sections/ProfilePage';
import WeatherPage from '@/sections/WeatherPage';
import ConfigPage from '@/sections/ConfigPage';
import AccessPage from '@/sections/AccessPage';
import { ProductsProvider } from '@/data/ProductsContext';
import { fetchProducts, syncProducts, syncHengjiCost, readProductsCache, fetchAccessMe } from '@/data/api';
import type { AccessMe } from '@/data/api';
import { useTraySync, diffTray } from '@/lib/traySync';
import { API_BASE, authenticatedFetch } from '@/lib/api-client';
import type { AuthUser } from '@/lib/api-client';
import type { Look, Product, Tray, TraySection, TrayType } from '@/data/products';

type PageKey = 'trays' | 'sequence' | 'board' | 'profile' | 'weather' | 'config' | 'access';

const NAV: { key: PageKey; label: string; icon: typeof LayoutGrid; adminOnly?: boolean }[] = [
  { key: 'trays', label: '货盘', icon: Layers },
  { key: 'sequence', label: '直播排品', icon: ListOrdered },
  { key: 'board', label: '选款看板', icon: LayoutGrid },
  { key: 'profile', label: '画像卡片', icon: BarChart3 },
  { key: 'weather', label: '天气面板', icon: CloudSun },
  { key: 'config', label: '配置后台', icon: Settings2 },
  { key: 'access', label: '权限管理', icon: ShieldCheck, adminOnly: true },
];

// 移动端底部导航：配置与权限管理都是低频管理入口，改放右上角图标
const MOBILE_NAV = NAV.filter((n) => n.key !== 'config' && n.key !== 'access');
const TRAYS_KEY = 'marius:trays:v2';
const ACTIVE_KEY = 'marius:activeTrayId';
const TRAYS_UPDATED_AT_KEY = 'marius:trays:updatedAt';
const TRAYS_SNAPSHOTS_KEY = 'marius:trays:snapshots';
const MAX_LOCAL_SNAPSHOTS = 50;

// 把 ISO 时间格式化成"X 分钟前"短描述
function fmtStamp(iso: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  if (diff < 30_000) return '刚刚';
  if (diff < 60_000) return `${Math.floor(diff / 1000)} 秒前`;
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

// 本地货盘读写（带修改时间戳，便于和云端比较新旧）
function readLocalTrays(): { trays: Tray[]; updatedAt: number } | null {
  try {
    const saved = localStorage.getItem(TRAYS_KEY);
    if (!saved) return null;
    const parsed = JSON.parse(saved) as Tray[];
    const at = Number(localStorage.getItem(TRAYS_UPDATED_AT_KEY) || '0');
    if (Array.isArray(parsed) && parsed.length > 0) {
      return { trays: parsed, updatedAt: at };
    }
  } catch {}
  return null;
}
function writeLocalTrays(trays: Tray[], at?: number) {
  try {
    // 先留一份本地快照，防止下一次误覆盖/误删后无法恢复
    const prev = localStorage.getItem(TRAYS_KEY);
    if (prev) {
      try {
        const prevParsed = JSON.parse(prev) as Tray[];
        if (Array.isArray(prevParsed) && prevParsed.length > 0) {
          const raw = localStorage.getItem(TRAYS_SNAPSHOTS_KEY);
          const snaps: { at: number; trays: Tray[] }[] = raw ? (JSON.parse(raw) as { at: number; trays: Tray[] }[]) : [];
          snaps.push({ at: Date.now(), trays: prevParsed });
          while (snaps.length > MAX_LOCAL_SNAPSHOTS) snaps.shift();
          localStorage.setItem(TRAYS_SNAPSHOTS_KEY, JSON.stringify(snaps));
        }
      } catch {}
    }
    localStorage.setItem(TRAYS_KEY, JSON.stringify(trays));
    if (at) localStorage.setItem(TRAYS_UPDATED_AT_KEY, String(at));
  } catch {}
}

const mkSection = (id: string, label: string, looks: Look[]): TraySection => ({ id, label, visible: true, looks });

let seq = 100;
const nid = (p: string) => `${p}-${++seq}`;

// ── 真实款号清单（已 BI 卡片「商品全表数据(款式)」验证存在） ──
// 这些款号在 card preview CSV 中有真实价格 / 库存 / 退货率等字段
const REAL_CODES = {
  // 大衣组（12A 冬，价格段中高，主推位）
  longCoats:  ['me14dw030', 'me14dw041', 'me14df046'],
  // 外套/西装（中价，承接位）
  outer:       ['9aw2315052'],
  suit:        ['me01dw020'],
  // 裤装
  denimPants:  ['9aw210553', '9ss230517'],
  casualPants: ['me23df001'],
  // 针织/夹克
  knit:        ['md09dc045'],
  jacket:      ['md15ff025'],
};

// 在已加载的产品池里按款号找，找到才生成 look；找不到就跳过
const pickLook = (products: Product[], code: string, lookId: string): Look | null => {
  const target = code.toLowerCase();
  const p = products.find((x) => x.id.toLowerCase() === target);
  if (!p) return null;
  return { id: lookId, pids: [p.id], cover: p.id };
};

const pickLooks = (
  products: Product[],
  codes: string[],
  idPrefix: string,
): Look[] =>
  codes
    .map((c, i) => pickLook(products, c, `${idPrefix}-${i}`))
    .filter((x): x is Look => x !== null);

// 用真实 BI 数据生成 4 个 demo 货盘（覆盖能力：mazong、normal、talent 三种模板）
const buildInitialTrays = (products: Product[]): Tray[] => {
  if (products.length === 0) return [];

  return [
    {
      id: 't1', name: '马总场', date: '2026-10-15',
      type: '马总直播货盘', template: 'mazong',
      sections: [
        mkSection('s1', '主推A', pickLooks(products, REAL_CODES.longCoats, 't1-s1')),
        mkSection('s2', '主推B', pickLooks(products, [...REAL_CODES.outer, ...REAL_CODES.suit], 't1-s2')),
        mkSection('s3', '现货', pickLooks(products, REAL_CODES.denimPants, 't1-s3')),
        mkSection('s4', '搭配款', pickLooks(products, REAL_CODES.knit, 't1-s4')),
      ],
      viewPerm: ['马总', '商品', '运营', '主播团队'],
      editPerm: ['商品', '运营'],
      createdAt: '2026-10-15',
      updatedAt: '2026-10-15',
    },
    {
      id: 't2', name: '店播日常场', date: '2026-10-16',
      type: '店播直播货盘', template: 'normal',
      sections: [
        mkSection('s1', '引流区', pickLooks(products, [REAL_CODES.jacket[0], REAL_CODES.denimPants[0]], 't2-s1')),
        mkSection('s2', '现货区', pickLooks(products, [REAL_CODES.denimPants[1], REAL_CODES.casualPants[0]], 't2-s2')),
      ],
      viewPerm: ['商品', '运营', '主播团队'],
      editPerm: ['运营'],
      createdAt: '2026-10-16',
      updatedAt: '2026-10-16',
    },
    {
      id: 't3', name: '达人 · 王祖儿专场', date: '2026-10-18',
      type: '达人货盘', template: 'talent',
      sections: [
        mkSection('s1', '主播热卖', pickLooks(products, [REAL_CODES.longCoats[0], REAL_CODES.knit[0]], 't3-s1')),
        mkSection('s2', '相似画像推荐', pickLooks(products, [REAL_CODES.denimPants[0], REAL_CODES.casualPants[0]], 't3-s2')),
      ],
      viewPerm: ['商品', '运营', '达人商务'],
      editPerm: ['达人商务'],
      createdAt: '2026-10-18',
      updatedAt: '2026-10-18',
    },
    {
      id: 't4', name: '抖音旗舰店铺货', date: '2026-10-20',
      type: '渠道货盘', template: 'normal',
      sections: [
        mkSection('s1', '上架主推', pickLooks(products, [REAL_CODES.longCoats[1], REAL_CODES.suit[0]], 't4-s1')),
        mkSection('s2', '清仓', pickLooks(products, [REAL_CODES.denimPants[1]], 't4-s2')),
      ],
      viewPerm: ['商品', '渠道运营'],
      editPerm: ['渠道运营'],
      createdAt: '2026-10-20',
      updatedAt: '2026-10-20',
    },
  ];
};

export default function App({ user, onLogout, logoutPending }: { user: AuthUser; onLogout: () => Promise<void>; logoutPending: boolean }) {
  const [page, setPage] = useState<PageKey>('trays');
  // 权限页有未保存的改动时，切页面前先确认，避免静默丢失
  const [accessDirty, setAccessDirty] = useState(false);
  // 权限：登录后从服务端取一次角色（部门/账号/管理员组），未取到前按“只读”处理，避免误放开
  const [access, setAccess] = useState<AccessMe | null>(null);
  const canEdit = access?.canEditTray === true;
  const canManage = access?.canManageAccess === true;
  const canSync = access?.canSyncData === true;

  const goPage = (key: PageKey) => {
    if (key !== page && accessDirty && !window.confirm('权限管理里有未保存的修改，切换页面会丢失，确定离开吗？')) return;
    if (key !== 'access') setAccessDirty(false);
    setPage(key);
    window.scrollTo({ top: 0 });
  };

  useEffect(() => {
    let alive = true;
    fetchAccessMe()
      .then((info) => { if (alive) setAccess(info); })
      .catch(() => { if (alive) toast.error('读取权限失败，货盘暂按只读处理'); });
    return () => { alive = false; };
  }, []);
  // 立刻从 localStorage 同步读，零延迟渲染上次数据
  const initialCache = typeof window !== 'undefined' ? readProductsCache() : null;
  const [products, setProducts] = useState<Product[]>(initialCache?.items ?? []);
  const [cacheStamp, setCacheStamp] = useState<string>(initialCache?.updatedAt ?? '');
  const [loading, setLoading] = useState(initialCache == null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [trays, setTrays] = useState<Tray[]>([]);
  const [traysReady, setTraysReady] = useState(false);
  const [activeTrayId, setActiveTrayId] = useState<string>('t1');

  // 多人实时协同：WS 广播 + 收远端按键级合并
  const collabUser = user.displayName.slice(0, 30);
  const collabRef = useRef<{ broadcast: (t: Tray, ops: ReturnType<typeof diffTray>) => void } | null>(null);
  const { broadcast } = useTraySync(
    traysReady ? activeTrayId : null,
    collabUser,
    setTrays,
    (user, trayName) => toast.info(`${user} 更新了货盘「${trayName}」`, { duration: 3000 }),
  );
  collabRef.current = { broadcast };

  // 初次加载：拉最新商品（已用本地缓存秒开，再后台拉新）
  useEffect(() => {
    let cancelled = false;
    setError(null);
    if (initialCache == null) setLoading(true);
    else setRefreshing(true);
    fetchProducts()
      .then((items) => {
        if (cancelled) return;
        setProducts(items);
        setLoading(false);
        setRefreshing(false);
        setCacheStamp(new Date().toISOString());
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setLoading(false);
        setRefreshing(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 从云端 + localStorage 恢复货盘：合并两者，本地独有货盘不会被云端旧数据覆盖
  // 云端/本地任一来源有数据就恢复；都没有才进入默认示例货盘生成逻辑
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let cloudTrays: Tray[] = [];
      let cloudAt = 0;
      try {
        const res = await authenticatedFetch(API_BASE + '/trays');
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data.trays)) {
            cloudTrays = data.trays;
            cloudAt = typeof data.updatedAt === 'number' ? data.updatedAt : data.at ?? 0;
          }
        }
      } catch {
        // 云端拉取失败（后端没起 / 网络断），继续用本地兜底
      }
      const local = readLocalTrays();
      const localTrays = local?.trays ?? [];
      const localAt = local?.updatedAt ?? 0;

      let merged: Tray[];
      if (cloudTrays.length === 0 && localTrays.length === 0) {
        merged = [];
      } else if (cloudTrays.length === 0) {
        merged = localTrays;
      } else if (localTrays.length === 0) {
        merged = cloudTrays;
      } else {
        // 以较新的来源为基准，另一来源仅补充本地/云端独有的货盘
        const newerIsLocal = localAt >= cloudAt;
        const base = newerIsLocal ? localTrays : cloudTrays;
        const other = newerIsLocal ? cloudTrays : localTrays;
        const map = new Map(base.map((t) => [t.id, t]));
        for (const t of other) {
          if (!map.has(t.id)) map.set(t.id, t);
        }
        merged = Array.from(map.values());
      }

      if (cancelled) return;
      if (merged.length > 0) {
        setTrays(merged);
        writeLocalTrays(merged, Date.now());
      }
      setTraysReady(true);
    })();
    return () => { cancelled = true; };
  }, []);

  // 写盘：本地 + 云端（云端异步，不阻塞 UI；失败时只 console.warn）
  // prevTraysRef 记上次 PUT 时提交的 tray 列表，用来 diff 出 deletedTrayIds
  //   → 后端同步把 supabase 三张表里那些 tray 的行清掉（避免过期行残留）
  const prevTraysRef = useRef<Tray[] | null>(null);
  const pendingSaveRef = useRef<{ trays: Tray[]; body: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  useEffect(() => {
    if (!traysReady) return;
    const at = Date.now();
    writeLocalTrays(trays, at);
    // 云端备份（debounce 500ms 避免每次编辑都打一次接口）
    if (pendingSaveRef.current) clearTimeout(pendingSaveRef.current.timer);
    // 对比上次 PUT 提交过的 trays：被移除的 id 一并附在 body 里（同步清 supabase）
    const prevTrays = prevTraysRef.current;
    const prevIds = new Set((prevTrays || []).map((t) => t.id));
    const nextIds = new Set(trays.map((t) => t.id));
    const deletedTrayIds = [...prevIds].filter((id) => !nextIds.has(id));
    const body = JSON.stringify({ trays, deletedTrayIds });
    const timer = setTimeout(() => {
      pendingSaveRef.current = null;
      prevTraysRef.current = trays;
      authenticatedFetch(API_BASE + '/trays', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body,
      }).catch((err) => console.warn('[trays] 云端备份失败：', err.message));
    }, 500);
    pendingSaveRef.current = { trays, body, timer };
    return () => clearTimeout(timer);
  }, [trays, traysReady]);

  // 关闭/刷新页面前，强制把未发送的云端备份 flush 出去
  useEffect(() => {
    const handler = () => {
      const pending = pendingSaveRef.current;
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingSaveRef.current = null;
      try {
        authenticatedFetch(API_BASE + '/trays', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: pending.body,
          keepalive: true,
        }).catch(() => {});
      } catch {
        // ignore
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(ACTIVE_KEY);
      if (saved) setActiveTrayId(saved);
    } catch {}
  }, []);

  useEffect(() => {
    try { localStorage.setItem(ACTIVE_KEY, activeTrayId); } catch {}
  }, [activeTrayId]);

  // 商品到位后，若没有持久化的货盘，则写入默认示例货盘
  useEffect(() => {
    if (!traysReady || loading || products.length === 0) return;
    const local = readLocalTrays();
    if (local && local.trays.length > 0) return;
    setTrays(buildInitialTrays(products));
  }, [traysReady, loading, products]);

  const retry = () => {
    setLoading(true);
    setError(null);
    fetchProducts({ force: true })
      .then((items) => {
        setProducts(items);
        setLoading(false);
        setCacheStamp(new Date().toISOString());
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setLoading(false);
      });
  };

  const updateTray = (id: string, fn: (t: Tray) => Tray) => {
    if (!canEdit) {
      toast.error('当前账号只有查看权限，不能修改货盘内容');
      return;
    }
    setTrays((ts) => {
      const prev = ts.find((t) => t.id === id);
      if (!prev) return ts;
      const next = { ...fn(prev), updatedAt: new Date().toISOString() };
      if (JSON.stringify(prev) === JSON.stringify(next)) return ts;
      const ops = diffTray(prev, next);
      if (ops.length > 0) collabRef.current?.broadcast(next, ops);
      return ts.map((t) => (t.id === id ? next : t));
    });
  };

  // 治本：tray 数据加载完后，对每个 tray 的 plannedRestockItems 去重（多次同步累积的同批次会丢）
  //   这样无论用户是否重新点过 sales.html 的"确认翻单"按钮，旧残留都会被清掉
  //   - 去重粒度：(pdt, skc, pieces, days) — 多次 push 的同一批次只留 1 条
  //   - 只在 plannedRestockItems 真的有重复时才 setTrays，避免无限重渲染
  useEffect(() => {
    if (!traysReady || trays.length === 0) return;
    let changedAny = false;
    const next = trays.map((t) => {
      const items = t.plannedRestockItems || [];
      if (items.length === 0) return t;
      const seen = new Set<string>();
      const dedup: typeof items = [];
      for (const it of items) {
        const k = `${String(it.pdt || '').toLowerCase()}|${String(it.skc || '').toLowerCase()}|${Number(it.pieces) || 0}|${Number(it.days) || 0}`;
        if (seen.has(k)) { changedAny = true; continue; }
        seen.add(k);
        dedup.push(it);
      }
      if (dedup.length === items.length) return t;
      return { ...t, plannedRestockItems: dedup, updatedAt: new Date().toISOString() };
    });
    if (changedAny) setTrays(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [traysReady]);

  // 删除货盘：本地 + 云端同步走 useEffect 里的自动写盘（debounced PUT /api/trays）
  const deleteTray = (id: string) => {
    if (!canEdit) {
      toast.error('当前账号只有查看权限，不能删除货盘');
      return;
    }
    const t = trays.find((x) => x.id === id);
    if (t) {
      collabRef.current?.broadcast(t, [{ action: '删除货盘', detail: t.name }]);
      authenticatedFetch(API_BASE + '/trays/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trayId: id, trayName: t.name, user: collabUser, ops: [{ action: '删除货盘', detail: t.name }] }),
      }).catch(() => {});
    }
    setTrays((ts) => ts.filter((t) => t.id !== id));
  };

  const createTray = (name: string, type: TrayType, date: string) => {
    if (!canEdit) {
      toast.error('当前账号只有查看权限，不能新建货盘');
      return (trays.find((t) => t.id === activeTrayId) || trays[0] || { id: activeTrayId }) as Tray;
    }
    const now = new Date().toISOString();
    // 模块级 seq 会在 HMR / 刷新后重置，必须从现有 trays 取最大后缀 +1，
    // 否则新建货盘会重复已存在的 id（如 t-101），导致旧货盘被覆盖。
    const existingIds = new Set(trays.map((x) => x.id));
    let nextTraySeq = 101;
    while (existingIds.has(`t-${nextTraySeq}`)) nextTraySeq++;
    const t: Tray = {
      id: `t-${nextTraySeq}`,
      name,
      date,
      type,
      template: type === '达人货盘' ? 'talent' : type === '马总直播货盘' ? 'mazong' : 'normal',
      sections: [
        mkSection(nid('s'), '主推A', []),
        mkSection(nid('s'), '现货', []),
        mkSection(nid('s'), '搭配款', []),
      ],
      viewPerm: ['商品', '运营'],
      editPerm: ['运营'],
      createdAt: now.slice(0, 10),
      updatedAt: now,
    };
    setTrays((ts) => [...ts, t]);
    setActiveTrayId(t.id);
    collabRef.current?.broadcast(t, [{ action: '新建货盘', detail: `${name}（${type}）` }]);
    return t;
  };

  const addToTray = (pid: string, sectionId: string) => {
    updateTray(activeTrayId, (t) => ({
      ...t,
      sections: t.sections.map((s) =>
        s.id === sectionId ? { ...s, looks: [...s.looks, { id: nid('L'), pids: [pid], cover: pid }] } : s,
      ),
    }));
  };

  const [syncing, setSyncing] = useState<'商品' | '库存' | '成本及价格' | null>(null);
  // 数据版本号：每次同步完成后 +1，TraysPage 用它来触发尺码/成本等衍生数据重新拉取
  const [dataVersion, setDataVersion] = useState(0);

  const onSync = useCallback(async (kind: '商品' | '库存' | '成本及价格') => {
    if (!canSync) {
      toast.error('仅管理员可执行数据同步');
      return;
    }
    setSyncing(kind);
    try {
      let message: string;
      if (kind === '成本及价格') {
        const res = await syncHengjiCost();
        message = res.message;
      } else {
        const res = await syncProducts(kind);
        message = res.message;
      }
      toast.success(message);
      // 同步后都刷新一次商品池（同步库存也会改 stock 行，必须重拉）
      // 防御：拿到 mock-fallback / fetch-failed 时不要 setProducts，否则会把
      //   残缺的 items（32 款）灌进 React state，让本该有的款号查不到 → UI 显示「—」。
      try {
        const items = await fetchProducts();
        const src = (items as unknown as { source?: string })?.source ?? '';
        if (src === 'mock-fallback' || src === 'fetch-failed' || items.length === 0) {
          toast.error('同步完成但商品池为空（领猫/BI 拉取失败），请稍后重试');
        } else {
          setProducts(items);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        toast.error(`同步后重拉失败：${msg}`);
      }
      // 通知 TraysPage 重新拉尺码/成本等衍生数据
      // （hengji 同步后 hengji-client.js 按 mtime 自动 reload 新 JSON，
      //   dataVersion++ 让 TraysPage 重拉 /api/products/cost/by-ids 拿到新成本/价格）
      setDataVersion((v) => v + 1);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`同步失败：${msg}`);
    } finally {
      setSyncing(null);
    }
  }, [canSync]);

  const activeTray = useMemo(() => trays.find((t) => t.id === activeTrayId) ?? trays[0], [trays, activeTrayId]);

  // 兜底轮询：每 15s 拉一次服务端权威数据，避免 WS 断线时漏掉同事的修改
  // 只比对 updatedAt 比本地新的 tray 才更新，不影响用户正在编辑的内容
  useEffect(() => {
    if (!traysReady) return;
    const timer = setInterval(async () => {
      try {
        const r = await authenticatedFetch(API_BASE + '/trays');
        if (!r.ok) return;
        const j = await r.json();
        const cloudTrays: Tray[] = j.trays || [];
        if (!Array.isArray(cloudTrays) || cloudTrays.length === 0) return;
        setTrays((local) => {
          let changed = false;
          const next = local.map((t) => {
            const cloud = cloudTrays.find((c) => c.id === t.id);
            if (!cloud) return t;
            const localAt = t.updatedAt ? new Date(t.updatedAt).getTime() : 0;
            const cloudAt = cloud.updatedAt ? new Date(cloud.updatedAt).getTime() : 0;
            // 云端较新 → 用远端值覆盖
            if (cloudAt > localAt) {
              changed = true;
              return cloud;
            }
            return t;
          });
          // 补全新出现的 tray
          for (const c of cloudTrays) {
            if (!next.find((t) => t.id === c.id)) {
              next.push(c);
              changed = true;
            }
          }
          return changed ? next : local;
        });
      } catch { /* ignore */ }
    }, 15000);
    return () => clearInterval(timer);
  }, [traysReady]);

  return (
    <div className="min-h-screen bg-surface-bg text-ink-primary">
      {/* 顶栏 */}
      <header className="app-header fixed inset-x-0 top-0 z-40 flex h-16 items-center gap-8 border-b border-edge bg-surface-bg/95 px-10 backdrop-blur print:hidden">
        <div className="app-brand flex items-baseline gap-2.5 whitespace-nowrap">
          <span className="text-[22px] font-extrabold tracking-[0.18em] text-ink-primary">Marius</span>
          <span className="app-brand-title text-[15px] font-bold tracking-wide">智慧货盘</span>
          <span className="app-brand-mobile">智慧货盘</span>
        </div>
        <nav aria-label="主导航" className="desktop-nav flex items-center gap-1">
          {NAV.filter((n) => !n.adminOnly || canManage).map((n) => {
            const active = page === n.key;
            return (
              <button
                key={n.key}
                aria-current={active ? 'page' : undefined}
                onClick={() => goPage(n.key)}
                className={`flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-[13px] transition-colors ${
                  active ? 'bg-surface-muted font-semibold' : 'text-ink-secondary hover:bg-surface-subtle'
                }`}
              >
                <n.icon size={14} strokeWidth={1.8} />
                {n.label}
              </button>
            );
          })}
        </nav>
        <div className="app-status ml-auto flex items-center gap-3 text-[11px] text-ink-muted">
          {refreshing && <span className="flex items-center gap-1.5"><span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-action-link" />同步中…</span>}
          {!refreshing && cacheStamp && (
            <span className="auth-refresh-stamp" title={cacheStamp}>上次刷新 {fmtStamp(cacheStamp)}</span>
          )}
          <span className="app-target">当前选款目标：<span className="font-medium text-ink-primary">{activeTray?.name} · {activeTray?.date}</span></span>
          {canManage && (
            <button
              type="button"
              aria-current={page === 'access' ? 'page' : undefined}
              onClick={() => goPage('access')}
              aria-label="权限管理"
              title="权限管理"
              className={`mobile-config-btn flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-ink-secondary hover:bg-surface-subtle transition-colors ${
                page === 'access' ? 'bg-surface-muted font-semibold text-ink-primary' : ''
              }`}
            >
              <ShieldCheck size={16} strokeWidth={page === 'access' ? 2 : 1.7} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            aria-current={page === 'config' ? 'page' : undefined}
            onClick={() => goPage('config')}
            aria-label="配置后台"
            title="配置后台"
            className={`mobile-config-btn flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-ink-secondary hover:bg-surface-subtle transition-colors ${
              page === 'config' ? 'bg-surface-muted font-semibold text-ink-primary' : ''
            }`}
          >
            <Settings2 size={16} strokeWidth={page === 'config' ? 2 : 1.7} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => { void onLogout(); }}
            disabled={logoutPending}
            aria-label={`退出登录（${user.displayName}）`}
            title={`${user.displayName} · 退出登录`}
            className="flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-ink-secondary hover:bg-surface-subtle disabled:opacity-50"
          >
            <span className="hidden max-w-20 truncate xl:inline">{user.displayName}</span>
            <LogOut size={16} aria-hidden="true" />
          </button>
        </div>
      </header>

      <main className="app-main pt-16">
        {/* 商品拉取失败只在「没有任何货盘可展示」时才整屏报错；有货盘则照常渲染，商品位留空稍后填实 */}
        {error && trays.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-3 px-10 py-24 text-center">
            <div className="text-[14px] font-semibold text-stage-return-fg">加载商品数据失败</div>
            <div className="max-w-[480px] text-[12.5px] leading-5 text-ink-secondary">{error}</div>
            <div className="text-[11.5px] text-ink-muted">
              请确认后端 <code className="rounded bg-surface-subtle px-1.5 py-0.5">http://{location.hostname}:3737</code> 已启动（<code>npm run dev:be</code>）
            </div>
            <button
              onClick={retry}
              className="mt-2 rounded-md bg-action-primary px-4 py-2 text-[12.5px] font-medium text-white hover:bg-action-primary-hover"
            >
              重试
            </button>
          </div>
        )}
        {/* 商品加载中转圈只在尚无货盘可展示时全屏显示；货盘已恢复则直接渲染页面 */}
        {!error && loading && trays.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-3 px-10 py-24 text-center">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-edge-strong border-t-action-primary" />
            <div className="text-[13px] text-ink-muted">正在加载商品数据…</div>
          </div>
        )}
        {!error && !loading && trays.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-3 px-10 py-24 text-center">
            <div className="text-[14px] font-semibold">暂无货盘</div>
            <div className="max-w-[480px] text-[12.5px] leading-5 text-ink-secondary">
              商品池为空，示例货盘未能生成。请先同步商品数据，或直接新建一个货盘。
            </div>
            <button
              onClick={() => createTray('新货盘', '店播直播货盘', new Date().toISOString().slice(0, 10))}
              className="mt-2 rounded-md bg-action-primary px-4 py-2 text-[12.5px] font-medium text-white hover:bg-action-primary-hover"
            >
              新建货盘
            </button>
          </div>
        )}
        {/* 货盘恢复（本地/云端）后立即渲染页面，不等商品池拉完 ——
            商品未到位时各页用 EMPTY_PRODUCT 占位，拉到后自动填实 */}
        {traysReady && trays.length > 0 && (
          <ProductsProvider products={products}>
            {page === 'trays' && (
              <TraysPage
                trays={trays}
                activeTrayId={activeTrayId}
                onOpenTray={setActiveTrayId}
                onCreateTray={createTray}
                onUpdateTray={(t) => updateTray(t.id, () => t)}
                onDeleteTray={deleteTray}
                onSync={onSync}
                syncing={syncing}
                dataVersion={dataVersion}
                readOnly={!canEdit}
                canSync={canSync}
              />
            )}
            {page === 'sequence' && (
              <SequencePage
                trays={trays}
                activeTrayId={activeTrayId}
                onSwitchTray={setActiveTrayId}
                onUpdateTray={(t) => updateTray(t.id, () => t)}
                readOnly={!canEdit}
              />
            )}
            {page === 'board' && (
              <BoardPage
                trays={trays}
                activeTrayId={activeTrayId}
                onSwitchTray={setActiveTrayId}
                onCreateTray={createTray}
                onAdd={addToTray}
              />
            )}
            {page === 'profile' && <ProfilePage />}
            {page === 'weather' && <WeatherPage />}
            {page === 'config' && <ConfigPage canEditRules={access?.canEditRules === true} />}
            {page === 'access' && canManage && (
              <AccessPage
                me={access}
                onDirtyChange={setAccessDirty}
                onChanged={() => { fetchAccessMe().then(setAccess).catch(() => {}); }}
              />
            )}
          </ProductsProvider>
        )}
      </main>
      <nav aria-label="移动端主导航" className="mobile-nav print:hidden">
        {MOBILE_NAV.filter((n) => !n.adminOnly || canManage).map((n) => (
          <button
            key={n.key}
            type="button"
            aria-current={page === n.key ? 'page' : undefined}
            onClick={() => goPage(n.key)}
          >
            <n.icon size={20} strokeWidth={page === n.key ? 2 : 1.7} aria-hidden="true" />
            <span>{n.label}</span>
          </button>
        ))}
      </nav>
      <Toaster position="top-center" />
    </div>
  );
}
