import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Plus, Check, Sparkles, CircleAlert, Layers, Send, Bot, ChevronLeft, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { TRAY_TYPES, totalQty, goodsValue, type Product, type Tray, type TrayType } from '@/data/products';
import { useProducts } from '@/data/ProductsContext';
import { postAiStrategy, fetchRemainingInventory, type RemainingGroup, fetchFilters, type ApiFilters, fetchLaunchYears, fetchSales14d } from '@/data/api';
import { availableOf, BOARD_ROLES, buildSuiteGroups, suiteSiblings, type BoardRole } from '@/lib/boardRoles';

// ── 策略筛选条件（多维筛选框，维度与商品侧共创） ──
interface Filters {
  cats: string[];      // 品类
  waves: string[];     // 波段
  bands: string[];     // 价格带
  seasons: string[];   // 季节（到款式）
  years: number[];     // 上新年份
  minStock: number;    // 预估剩余库存 ≥
  noTransit: boolean;  // 仅无在途
  minConv: number;     // 转化率 ≥ %
  minSignRate: number; // 签收率 ≥ %（= 1 − SUM(退货数量)/SUM(销售数量)）
  maxReturn: number;   // 退货率 ≤ %
  minNewBuyer: number; // 拉新率 ≥ %
}

const DEFAULT_FILTERS: Filters = {
  cats: [], waves: [], bands: [], seasons: [], years: [],
  minStock: 0, noTransit: false, minConv: 0, minSignRate: 0, maxReturn: 80, minNewBuyer: 0,
};

// AI 能改的筛选字段（与后端 prompt 的 patch 字段一一对应）；其余键一律丢弃
const PATCH_KEYS = [
  'cats', 'waves', 'bands', 'seasons', 'years',
  'minStock', 'noTransit', 'minConv', 'minSignRate', 'maxReturn', 'minNewBuyer',
] as const satisfies readonly (keyof Filters)[];

const DIM = {
  cats: ['大衣', '针织', 'T恤', '裤装', '套装', '鞋靴', '衬衫', '外套', '西装', '背心', '夹克', '羽绒'],
  waves: ['9月1波段', '9月2波段', '10月1波段', '常青款'],
  bands: ['低', '中', '高'] as const,
  // 季节（到款式）：BI 里是「夏/秋/冬/春/其他」这类值，兜底用这组
  seasons: ['春', '夏', '秋', '冬', '其他'],
};

// 配件 / 赠品不是选款对象：包装配件、配件、配饰、赠品（如「抖音赠品(超时用途)」）整类排除，
// 品类选项里不列、候选池里也不出现。
const ACCESSORY_CAT_RE = /配件|配饰|赠品/;
const isAccessoryOrGift = (p: { category?: string; name?: string }) =>
  ACCESSORY_CAT_RE.test(String(p.category || '')) || ACCESSORY_CAT_RE.test(String(p.name || ''));

interface ChatMsg {
  from: 'me' | 'ai';
  text: string;
  patch?: Partial<Filters>;
}

// LLM 不可用时的关键词兜底（不要随便删：AI 故障时仍有应答）
function aiReplyFallback(q: string): ChatMsg {
  if (/清仓|库存|滞销/.test(q))
    return {
      from: 'ai',
      text: '建议按清仓策略：只看无在途、预估可用 ≥200 的款，转化率 ≥5% 保证动销，退货率 ≤30% 避免清出售后压力。要应用吗？',
      patch: { noTransit: true, minStock: 200, minConv: 5, maxReturn: 30 },
    };
  if (/拉新|新客/.test(q))
    return {
      from: 'ai',
      text: '拉新导向建议：拉新率 ≥40%，价格带低/中，预估剩余库存 ≥100 保证承接。纤纤裤（拉新 52%）这类款会是主力。要应用吗？',
      patch: { minNewBuyer: 40, bands: ['低', '中'], minStock: 100 },
    };
  if (/利润|毛利|赚钱/.test(q))
    return {
      from: 'ai',
      text: '利润导向建议：价格带高、退货率 ≤30% 的款，零售/成本比 ≥2.8 的优先。建议峰值时段释放。要应用吗？',
      patch: { bands: ['高'], maxReturn: 30 },
    };
  const catHit = DIM.cats.find((c) => q.includes(c));
  if (catHit)
    return {
      from: 'ai',
      text: `已理解：本场聚焦「${catHit}」。建议叠加退货率 ≤80% 的底线。要应用吗？`,
      patch: { cats: [catHit], maxReturn: 80 },
    };
  return {
    from: 'ai',
    text: '我可以按这些维度帮你定策略：品类 / 波段 / 季节 / 上新年份 / 价格带 / 库存条件 / 转化率·签收率·退货率·拉新率阈值 / 无在途。试试说"清一波库存"或"这场主打拉新"。',
  };
}

function AiBadge({ p }: { p: Product }) {
  if (p.ai === 'top')
    return (
      <span className="inline-flex items-center gap-1 rounded-sm bg-action-primary px-1.5 py-0.5 text-[10px] font-medium text-white">
        <Sparkles size={10} /> AI 重点推荐
      </span>
    );
  if (p.ai === 'extra')
    return (
      <span className="inline-flex items-center gap-1 rounded-sm border border-edge px-1.5 py-0.5 text-[10px] font-medium">
        <Plus size={10} /> AI 池外补充
      </span>
    );
  if (p.ai === 'avoid')
    return (
      <span className="inline-flex items-center gap-1 rounded-sm bg-edge px-1.5 py-0.5 text-[10px] text-ink-muted">
        <CircleAlert size={10} /> 不建议
      </span>
    );
  return <span className="inline-flex rounded-sm bg-stage-connect-bg px-1.5 py-0.5 text-[10px] text-stage-connect-fg">筛选命中</span>;
}

function InvCell({ label, v, color = 'text-ink-secondary' }: { label: string; v: number; color?: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] text-ink-muted">{label}</span>
      <span className={`text-[12px] font-semibold ${color}`}>{(v || 0).toLocaleString()}</span>
    </div>
  );
}

// 波段排序键：按月号的数字排（1A < 1B < 2A < 2B …），A/B/C/D 同月内按字母；
// 非月份型波段（专属款/其他/未采购/未上架）固定排最后，顺序按下面的数组。
const WAVE_SPECIAL_ORDER = ['专属款', '其他', '未采购', '未上架'];
function waveSortKey(v: string): [number, string] {
  const special = WAVE_SPECIAL_ORDER.indexOf(v);
  if (special >= 0) return [1000 + special, ''];
  const m = v.match(/^(\d{1,2})(.*)$/);
  if (m) return [Number(m[1]), m[2]];
  return [999, v];
}

// 筛选维度行。必须定义在组件外：放在 BoardPage 内部会每次渲染生成新的组件类型，
// React 会把整行卸载重建，输入框每敲一个字就丢焦点（只能输入一次）。
function Dim({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="board-dimension flex items-start gap-3 border-b border-edge-muted py-3">
      <span className="w-24 shrink-0 pt-1 text-[11px] font-medium text-ink-muted">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

function Chip({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-[11.5px] transition-colors ${
        on ? 'border-edge bg-action-primary text-white' : 'border-edge-strong bg-surface-card hover:border-edge'
      }`}
    >
      {label}
    </button>
  );
}

// 多选筛选项：固定带一个「全部」，选中等于该维度不过滤（数组为空）。
// 勾具体项时从「全部」切到具体项；取消到最后一个时自动回到「全部」。
function DimChips<T extends string | number>({
  options, selected, onChange, labelOf,
}: {
  options: T[];
  selected: T[];
  onChange: (next: T[]) => void;
  labelOf?: (v: T) => string;
}) {
  return (
    <>
      <Chip on={selected.length === 0} label="全部" onClick={() => onChange([])} />
      {options.map((o) => (
        <Chip
          key={String(o)}
          on={selected.includes(o)}
          label={labelOf ? labelOf(o) : String(o)}
          onClick={() => onChange(selected.includes(o) ? selected.filter((x) => x !== o) : [...selected, o])}
        />
      ))}
    </>
  );
}

export default function BoardPage({
  trays, activeTrayId, onSwitchTray, onCreateTray, onAdd,
}: {
  trays: Tray[];
  activeTrayId: string;
  onSwitchTray: (id: string) => void;
  onCreateTray: (name: string, type: TrayType, date: string) => Tray;
  onAdd: (pids: string[], sectionId: string) => void;
}) {
  // 默认所有维度都是「全部」：不预设品类，进页面先看到全量候选池
  const [f, setF] = useState<Filters>({ ...DEFAULT_FILTERS });
  // 角色只做结果页签的切换（不再作为筛选维度，也不联动其他条件）
  const [roleTab, setRoleTab] = useState<'全部' | BoardRole>('全部');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<TrayType>('马总直播货盘');
  const [newDate, setNewDate] = useState('2026-10-02');
  const [chat, setChat] = useState<ChatMsg[]>([
    { from: 'ai', text: '这场想怎么打？告诉我目标（清仓 / 拉新 / 利润 / 主打某品类），我把策略转成筛选条件。' },
  ]);
  const [input, setInput] = useState('');

  const PRODUCTS = useProducts();

  // 放入货盘时的套系提示：这款有同小名的其他款时，先问要不要一起放进同一个坑位。
  // picked 默认空 —— 不勾选就只放当前这款。
  const [suitePrompt, setSuitePrompt] = useState<{
    product: Product;
    sectionId: string;
    others: Product[];
    picked: string[];
  } | null>(null);

  // 上新年份（优先 /api/products/meta/filters 的全量年份；兜底 remaining-inventory 的）
  const [remainingYears, setRemainingYears] = useState<number[]>([]);
  useEffect(() => {
    fetchLaunchYears().then((r) => setRemainingYears(r.years || [])).catch(() => setRemainingYears([]));
  }, []);
  // 筛选维度（来自后端 /api/products/meta/filters；兜底用硬编码）
  const [dims, setDims] = useState<ApiFilters>({ categories: [], waves: [], tempBands: [], priceBands: [], roles: [] });
  useEffect(() => {
    fetchFilters()
      .then((r) => setDims(r))
      .catch(() => setDims({ categories: DIM.cats, waves: DIM.waves, tempBands: [], priceBands: [...DIM.bands], roles: [...BOARD_ROLES], launchYears: [] }));
  }, []);
  // BI 返回的维度值里偶尔带「全部」占位，去掉后由 DimChips 统一渲染自己的「全部」
  // 「包装配件」「赠品」这类不是选款对象，不放进品类选项
  const catList = (dims.categories.length ? dims.categories : DIM.cats)
    .filter((v) => v !== '全部' && !ACCESSORY_CAT_RE.test(v));
  // 波段选项：按月份从早到晚（1A、1B、2A、2B…），季度波段不展示，占位值固定排最后
  const waveList = (() => {
    const raw = (dims.waves.length ? dims.waves : DIM.waves)
      .filter((v) => v !== '全部' && !v.includes('季度'));
    return [...new Set(raw)].sort((a, b) => {
      const [an, at] = waveSortKey(a);
      const [bn, bt] = waveSortKey(b);
      return an !== bn ? an - bn : at.localeCompare(bt);
    });
  })();
  const bandList = (dims.priceBands.length ? dims.priceBands : DIM.bands).filter((v) => v !== '全部');
  // 季节（到款式）：按 春/夏/秋/冬/其他 排序，数据里出现的组合值（如「秋冬」）追加在后面
  const seasonList = (() => {
    const seen = new Set(PRODUCTS.map((p) => String(p.season || '').trim()).filter(Boolean));
    if (seen.size === 0) return DIM.seasons;
    const known = DIM.seasons.filter((s) => seen.has(s));
    const extra = [...seen].filter((s) => !DIM.seasons.includes(s)).sort();
    return [...known, ...extra];
  })();
  // 上新年份：优先 /meta/filters，其次剩余库存卡；都拿不到时用商品自身的上新日期兜底，
  // 保证这一维度始终能出现（否则接口失败时整个「上新年份」行会被隐藏）
  const yearList = (() => {
    const fromApi = dims.launchYears && dims.launchYears.length ? dims.launchYears : remainingYears;
    if (fromApi.length) return [...fromApi].sort((a, b) => b - a);
    const years = new Set<number>();
    for (const p of PRODUCTS) {
      const m = String(p.launchDate || '').match(/^(\d{4})/);
      if (m) years.add(Number(m[1]));
    }
    return [...years].sort((a, b) => b - a);
  })();
  const roleList = BOARD_ROLES;

  // 剩余库存推荐（按款号索引，未覆盖的款不显示该段）
  const [remainingMap, setRemainingMap] = useState<Map<string, RemainingGroup>>(new Map());
  useEffect(() => {
    fetchRemainingInventory({ limit: 7000 })
      .then((r) => setRemainingMap(new Map(r.items.map((it) => [it.styleCode.toLowerCase(), it]))))
      .catch(() => setRemainingMap(new Map()));
  }, []);

  // 近 14 天销量（经典款判定用）：接口只读缓存，缺的款号后端后台预热；
  // 前端分批请求（每批 400 个款号，避免 URL 过长），有待预热时 30s 后自动补一次。
  const [sales14Map, setSales14Map] = useState<Map<string, number>>(new Map());
  const [sales14Pending, setSales14Pending] = useState(0);
  const [sales14Date, setSales14Date] = useState(''); // 快照里数据的日期（每天随 BI 刷新）
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let tries = 0;
    const ids = PRODUCTS.map((p) => p.id).filter(Boolean);
    if (ids.length === 0) return;
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += 400) chunks.push(ids.slice(i, i + 400));
    const load = async () => {
      const map = new Map<string, number>();
      let pending = 0;
      let snapDate = '';
      for (const chunk of chunks) {
        try {
          const r = await fetchSales14d(chunk);
          for (const [k, v] of Object.entries(r.byPid || {})) map.set(k.toLowerCase(), Number(v) || 0);
          pending += r.pending || 0;
          snapDate = r.snapshotDate || snapDate;
        } catch {
          // 取不到就按 0 计：经典款那一支会因此更严格，不会误放
        }
      }
      if (!alive) return;
      setSales14Map(map);
      setSales14Pending(pending);
      setSales14Date(snapDate);
      // 后端预热有延迟：还有缺的就再补一次（最多 3 次）
      if (pending > 0 && tries < 3) {
        tries++;
        timer = setTimeout(load, 30_000);
      }
    };
    load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [PRODUCTS]);

  const tray = trays.find((t) => t.id === activeTrayId) ?? trays[0];
  const traySections = tray.sections.filter((s) => s.visible);

  // 目标货盘按直播日期倒序（最新场次在最前面），与货盘列表页同一口径；
  // 只排显示副本，不动 App 里的 trays 顺序（原地排会触发多余的云端写盘）。
  const sortedTrays = useMemo(
    () => [...trays].sort((a, b) => {
      const byDate = String(b.date || '').localeCompare(String(a.date || ''));
      if (byDate !== 0) return byDate;
      return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    }),
    [trays],
  );

  // 预估剩余可用数：剩余库存卡片按 SKC 颜色行汇总的 estimate；缺失时退回主仓库存
  const estimateOf = (p: Product) => remainingMap.get(p.id.toLowerCase())?.totals.estimate;

  const pool = useMemo(
    () =>
      PRODUCTS.filter(
        (p) =>
          // 配件 / 赠品整类不进候选池（包装配件、赠品、配饰等都算），与品类选项里隐藏的口径一致
          !isAccessoryOrGift(p) &&
          (f.cats.length === 0 || f.cats.includes(p.category)) &&
          (f.waves.length === 0 || f.waves.includes(p.wave)) &&
          (f.bands.length === 0 || f.bands.includes(p.priceBand)) &&
          // 季节含组合值（如「秋冬」）时，选「秋」也要能命中
          (f.seasons.length === 0 || f.seasons.some((s) => String(p.season || '').includes(s))) &&
          (f.years.length === 0 || (() => {
            // 领猫侧没有 launchDate，回退到剩余库存 BI 卡片的「款上新时间」
            const ld = String(p.launchDate || '') || String(remainingMap.get(p.id.toLowerCase())?.launchDate || '');
            const m = ld.match(/^(\d{4})/);
            const y = m ? Number(m[1]) : 0;
            return f.years.includes(y);
          })()) &&
          availableOf(p, estimateOf(p)) >= f.minStock &&
          (!f.noTransit || p.inTransit === 0) &&
          p.conversion * 100 >= f.minConv &&
          // 签收率 = 1 − 总退货率（SUM 退货数量 / SUM 销售数量）；没有退货数据的款不算达标
          (f.minSignRate <= 0 ||
            (p.returnRate != null && p.returnRate > 0 && (1 - p.returnRate) * 100 >= f.minSignRate)) &&
          // 无退货率数据的款不卡阈值（避免 NaN 比较误杀）
          (p.returnRate == null || p.returnRate * 100 <= f.maxReturn) &&
          p.newBuyer * 100 >= f.minNewBuyer,
      ),
    [f, PRODUCTS, remainingMap],
  );

  // 看板按款呈现：一款一张卡（bySuite: false）。角色仍按组内相加口径判定，只用于卡片上的标签，
  // 不再参与筛选（商品角色筛选已下线）；同套系的其他款在放入货盘时再问要不要一起带。
  const groups = useMemo(
    () => buildSuiteGroups(pool, estimateOf, (p) => sales14Map.get(p.id.toLowerCase()) || 0, { bySuite: false }),
    [pool, remainingMap, sales14Map],
  );

  const visible = useMemo(() => {
    const list = roleTab === '全部' ? groups : groups.filter((g) => g.role === roleTab);
    // 排序：预估剩余可用数降序；同数时按转化率降序保证顺序稳定
    return [...list].sort((a, b) => b.available - a.available || b.members[0].conversion - a.members[0].conversion);
  }, [groups, roleTab]);

  const inTray = (pid: string) => tray.sections.some((s) => s.looks.some((l) => l.pids.includes(pid)));

  // ── 分页：候选可能有几千款，一次全渲染会把页面拖死 ──
  const PAGE_SIZES = [24, 48, 96];
  const [pageSize, setPageSize] = useState(24);
  const [page, setPage] = useState(0);
  const resultsRef = useRef<HTMLDivElement>(null);

  // 换筛选条件 / 切角色 Tab / 改每页数量都回到第一页
  useEffect(() => { setPage(0); }, [pool, roleTab, pageSize]);

  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const pageItems = useMemo(
    () => visible.slice(safePage * pageSize, safePage * pageSize + pageSize),
    [visible, safePage, pageSize],
  );
  const goPage = (n: number) => {
    const target = Math.min(Math.max(0, n), pageCount - 1);
    if (target === safePage) return;
    setPage(target);
    resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  // 页码窗口：1 … 4 5 6 … 20
  const pageButtons = useMemo<(number | '…')[]>(() => {
    if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i);
    const out: (number | '…')[] = [0];
    const start = Math.max(1, safePage - 1);
    const end = Math.min(pageCount - 2, safePage + 1);
    if (start > 1) out.push('…');
    for (let i = start; i <= end; i++) out.push(i);
    if (end < pageCount - 2) out.push('…');
    out.push(pageCount - 1);
    return out;
  }, [pageCount, safePage]);

  // 商品角色 / 场景 / 适穿温度带筛选都已下线：AI 返回的 patch 只按白名单保留看板还在用的字段，
  // 已下线维度和模型乱造的键直接丢掉，避免脏数据写进筛选状态
  const normalizePatch = (patch?: Partial<Filters>): Partial<Filters> | undefined => {
    if (!patch) return undefined;
    return Object.fromEntries(
      Object.entries(patch).filter(([k]) => (PATCH_KEYS as readonly string[]).includes(k)),
    ) as Partial<Filters>;
  };

  const send = async () => {
    const q = input.trim();
    if (!q) return;
    setChat((c) => [...c, { from: 'me', text: q }, { from: 'ai', text: 'AI 思考中…' }]);
    setInput('');
    try {
      const r = await postAiStrategy(q, f, pool.slice(0, 30));
      setChat((c) => [...c.slice(0, -1), { from: 'ai', text: r.text, patch: normalizePatch(r.patch as Partial<Filters> | undefined) }]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'AI 暂时不可用';
      setChat((c) => [...c.slice(0, -1), { from: 'ai', text: `AI 失败：${msg}（已回退到关键词兜底）` }, aiReplyFallback(q)]);
    }
  };

  return (
    <div className="responsive-page board-page px-10 py-8">
      <div className="page-heading flex items-end justify-between border-b border-edge pb-6">
        <div>
          <div className="text-[12px] font-light tracking-[0.3em] text-ink-faint">03 /</div>
          <h1 className="mt-2 text-[28px] font-bold leading-none">选款看板 · 主攻策略</h1>
          <p className="mt-3 text-[13px] text-ink-muted">定策略（人 + AI 共创）→ 按条件筛款 → 放入目标货盘</p>
        </div>
        <div className="text-right text-[11px] leading-5 text-ink-muted">目标城市：杭州 · 未来7天 12~19°C</div>
      </div>

      {/* 目标货盘 */}
      <div className="mt-6 flex flex-wrap items-center gap-2 border border-edge bg-surface-card px-4 py-3">
        <span className="flex items-center gap-1.5 text-[12px] font-medium text-ink-secondary">
          <Layers size={13} /> 目标货盘：
        </span>
        {sortedTrays.map((t) => (
          <Chip key={t.id} on={t.id === tray.id} label={`${t.name} ${t.date}`} onClick={() => onSwitchTray(t.id)} />
        ))}
        <button
          onClick={() => setCreating(!creating)}
          className="flex items-center gap-1 rounded-full border border-dashed border-ink-faint px-3.5 py-1 text-[12px] text-ink-muted hover:border-edge hover:text-ink-primary"
        >
          <Plus size={11} /> 新建货盘
        </button>
        {creating && (
          <span className="flex flex-wrap items-center gap-2">
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="货盘名称" className="w-36 rounded border border-edge-strong px-2.5 py-1 text-[12px] outline-none focus:border-edge" />
            <input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} className="rounded border border-edge-strong px-2 py-1 text-[12px] outline-none focus:border-edge" />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="rounded border border-edge-strong px-2.5 py-1 text-[11.5px]">{newType}</button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                {TRAY_TYPES.map((t) => (
                  <DropdownMenuItem key={t} onClick={() => setNewType(t)}>{t}</DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <button
              onClick={() => {
                if (!newName.trim() || !newDate) {
                  toast.error('请填写货盘名称和日期');
                  return;
                }
                const t = onCreateTray(newName.trim(), newType, newDate);
                toast.success(`货盘「${t.name}」已创建，现在为它选款`);
                setCreating(false);
                setNewName('');
              }}
              className="rounded bg-action-primary px-3 py-1 text-[11.5px] text-white"
            >
              创建并选款
            </button>
          </span>
        )}
      </div>

      <div className="board-strategy mt-6 grid grid-cols-[1fr_340px] gap-6">
        {/* 策略筛选面板 */}
        <div className="border border-edge bg-surface-card px-5 py-2">
          <div className="flex items-start gap-2 border-b border-edge-muted py-3">
            <div className="min-w-0 text-[11px] leading-5 text-ink-muted">
              <div>
                按款显示：一个款一张卡；放入货盘时若有同套系的其他款，可选一起加入一个坑位
                {/* 近14天销量/成本/尺码都来自每天下载一次的「商品全表」快照，这里标明数据日期 */}
                {sales14Date && <span className="ml-2 text-ink-faint">数据日期 {sales14Date}</span>}
                {sales14Pending > 0 && <span className="ml-2 text-ink-faint">近14天销量补齐中（{sales14Pending} 款）</span>}
              </div>
              {/* 季节 / 价格带 / 指标阈值的口径，写在筛选面板顶部，免得每次都要问 */}
              <div className="mt-0.5 text-[10.5px] leading-4 text-ink-faint">
                季节：取款级「季节(到款式)」，组合值（如「秋冬」）选「秋」也算命中；
                应季：按当前月份，8–12 月及 1 月为秋+冬，2–7 月为春+夏；
                角色判定：主推、经典看「发货后退货率」= SUM(发货后退货)/SUM(实发) ≤ 40%
                <span className="mx-1.5">·</span>
                价格带：基于各品类相对价格调整，非固定价格划分
                <span className="mx-1.5">·</span>
                指标阈值：转化率、拉新率为款级占比，≥ 阈值才保留；签收率 = 1 − 总退货率（含发货前+发货后），
                没有退货数据的款不算达标；退货率 ≤ 也是总退货率（Σ退货数量/Σ销售数量），无数据的款不设限
              </div>
            </div>
            <button onClick={() => setF(DEFAULT_FILTERS)} className="ml-auto shrink-0 pt-0.5 text-[11px] text-ink-muted hover:text-ink-primary">清空条件</button>
          </div>
          {yearList.length > 0 && (
            <Dim label="上新年份">
              <DimChips options={yearList} selected={f.years} onChange={(years) => setF((x) => ({ ...x, years }))} labelOf={(y) => `${y}年`} />
            </Dim>
          )}
          <Dim label="波段">
            <DimChips options={waveList} selected={f.waves} onChange={(waves) => setF((x) => ({ ...x, waves }))} />
          </Dim>
          <Dim label="品类">
            <DimChips options={catList} selected={f.cats} onChange={(cats) => setF((x) => ({ ...x, cats }))} />
          </Dim>
          <Dim label="季节">
            <DimChips options={seasonList} selected={f.seasons} onChange={(seasons) => setF((x) => ({ ...x, seasons }))} />
          </Dim>
          <Dim label="价格带">
            <DimChips
              options={bandList}
              selected={f.bands}
              onChange={(bands) => setF((x) => ({ ...x, bands }))}
              labelOf={(b) => (b === '空' ? '未分类' : `${b}价位`)}
            />
          </Dim>
          <Dim label="库存条件">
            <label className="flex items-center gap-1 text-[11.5px] text-ink-secondary">
              预估剩余可用 ≥
              <input type="number" value={f.minStock} onChange={(e) => setF((x) => ({ ...x, minStock: Number(e.target.value) }))} className="w-16 rounded border border-edge-strong px-1.5 py-0.5 text-center text-[11.5px] outline-none focus:border-edge" />
            </label>
            <Chip on={f.noTransit} label="仅无在途" onClick={() => setF((x) => ({ ...x, noTransit: !x.noTransit }))} />
          </Dim>
          <Dim label="指标阈值">
            {[['转化率≥%', 'minConv', f.minConv], ['签收率≥%', 'minSignRate', f.minSignRate], ['退货率≤%', 'maxReturn', f.maxReturn], ['拉新率≥%', 'minNewBuyer', f.minNewBuyer]].map(([label, key, val]) => (
              <label key={key as string} className="flex items-center gap-1 text-[11.5px] text-ink-secondary">
                {label as string}
                <input
                  type="number"
                  value={val as number}
                  onChange={(e) => setF((x) => ({ ...x, [key as string]: Number(e.target.value) }))}
                  className="w-14 rounded border border-edge-strong px-1.5 py-0.5 text-center text-[11.5px] outline-none focus:border-edge"
                />
              </label>
            ))}
          </Dim>
        </div>

        {/* AI 共创对话 */}
        <div className="flex flex-col border border-edge bg-surface-card">
          <div className="flex items-center gap-2 border-b border-edge-muted px-4 py-3 text-[12px] font-semibold">
            <Bot size={14} /> AI 策略共创
          </div>
          <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3" style={{ maxHeight: 420 }}>
            {chat.map((m, i) => (
              <div key={i} className={m.from === 'me' ? 'text-right' : ''}>
                <div className={`inline-block max-w-[92%] rounded-md px-3 py-2 text-left text-[12px] leading-5 ${m.from === 'me' ? 'bg-action-primary text-white' : 'bg-surface-subtle'}`}>
                  {m.text}
                </div>
                {m.patch && (
                  <button
                    onClick={() => { setF((x) => ({ ...x, ...m.patch })); toast.success('已应用 AI 建议的筛选条件'); }}
                    className="mt-1.5 rounded-md border border-edge px-2.5 py-1 text-[11px] font-medium hover:bg-action-primary hover:text-white"
                  >
                    应用此策略
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 border-t border-edge-muted px-3 py-2.5">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && send()}
              placeholder="如：这场主打拉新 / 清一波库存"
              className="w-full bg-transparent text-[12.5px] outline-none"
            />
            <button onClick={send} className="rounded-md bg-action-primary p-1.5 text-white hover:bg-action-primary-hover">
              <Send size={13} />
            </button>
          </div>
        </div>
      </div>

      {/* 结果 */}
      <div className="board-results-tabs mt-8 flex flex-wrap items-center gap-6 border-b border-edge" data-local-scroll>
        {(['全部', ...roleList] as const).map((r) => (
          <button
            key={r}
            onClick={() => setRoleTab(r)}
            className={`relative pb-3 text-[13px] transition-colors ${roleTab === r ? 'font-semibold' : 'text-ink-muted hover:text-ink-primary'}`}
          >
            {r === '全部' ? `全部候选（${groups.length} 款）` : `${r}款（${groups.filter((g) => g.role === r).length}）`}
            {roleTab === r && <span className="absolute inset-x-0 -bottom-px h-[2px] bg-action-primary" />}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2 pb-2 text-[11.5px] text-ink-muted">
          <span>共 {visible.length} 款</span>
          <span className="text-ink-faint">·</span>
          <span>每页</span>
          {PAGE_SIZES.map((n) => (
            <button
              key={n}
              onClick={() => setPageSize(n)}
              className={`rounded-sm border px-1.5 py-0.5 text-[11px] transition-colors ${
                pageSize === n ? 'border-edge bg-action-primary text-white' : 'border-edge-strong hover:border-edge'
              }`}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      <div ref={resultsRef} className="mt-6 grid grid-cols-2 gap-x-4 gap-y-8 pb-10 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
        {pageItems.map((g) => {
          const p = g.members[0];
          const avoid = p.ai === 'avoid';
          const added = g.members.some((m) => inTray(m.id));
          const remain = remainingMap.get(p.id.toLowerCase());
          // 属性行：比原来多带季节/版型/材质/尺码
          const metaLine = [p.category, p.wave, p.tempBand, p.season, p.fit, p.material, p.sizeRange]
            .filter(Boolean)
            .join(' · ');
          // 打标：售罄率 / 绿灯 / 红黑榜 / 30 天动销 / 发货后退货率 / 库存周转
          const flags = [
            p.tagSoldOut && p.tagSoldOut !== '其他' ? `售罄 ${p.tagSoldOut}` : '',
            p.tagGreenLight === '是' ? '绿灯款' : '',
            p.tagRedBlack && p.tagRedBlack !== '其他' ? p.tagRedBlack : '',
            p.tagSales30d === '30天无动销' ? '30天无动销' : '',
            p.tagReturnPostShip === '高' ? '退货率偏高' : '',
            p.stockTurnover || '',
          ].filter(Boolean);
          // 套系内指标相加：计划翻单 / 已下单 / 货值
          const qty = g.members.reduce((s, m) => s + totalQty(m), 0);
          const gv = g.members.reduce((s, m) => s + goodsValue(m), 0);
          // 采购交期：负数 = 已超期
          const etaMs = remain?.purchaseEtaDate
            ? new Date(`${remain.purchaseEtaDate}T00:00:00+08:00`).getTime()
            : Number.NaN;
          const etaDays = Number.isFinite(etaMs) ? Math.round((etaMs - Date.now()) / 86_400_000) : null;
          return (
            <div key={g.key} className={avoid ? 'opacity-45 grayscale' : ''}>
              <div className="relative overflow-hidden bg-surface-muted">
                {p.img ? (
                  <img src={p.img} alt={p.name} className="aspect-square w-full object-contain" loading="lazy" />
                ) : (
                  <div className="flex aspect-square w-full items-center justify-center bg-gradient-to-br from-surface-subtle to-surface-muted text-[11px] font-semibold text-ink-muted">{(p.id || '').slice(0, 2).toUpperCase() || '无图'}</div>
                )}
                {added && (
                  <span className="absolute left-2 top-2 flex items-center gap-1 rounded-sm bg-surface-card/90 px-1.5 py-0.5 text-[10px] font-medium">
                    <Check size={10} /> 已入盘
                  </span>
                )}
                {remain && remain.tags.length > 0 && (
                  <span className="absolute right-2 top-2 rounded-sm bg-stage-return-fg px-1.5 py-0.5 text-[10px] font-medium text-white">
                    {remain.tags[0]}
                  </span>
                )}
              </div>
              <div className="mt-3 flex items-start justify-between gap-2">
                <div className="min-w-0 truncate text-[14px] font-semibold leading-tight">{g.members.length > 1 ? g.name : p.name}</div>
                <div className="shrink-0 text-[14px] font-bold text-stage-connect-fg">¥{p.price}</div>
              </div>
              <div className="mt-1 text-[11.5px] text-ink-muted">
                {g.members.length > 1 ? `${g.members.length} 件套系` : p.id.toUpperCase()} · {p.colors.join(' / ')}
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {g.role !== '其他' && (
                  <span className="rounded-sm border border-edge-strong px-1.5 py-0.5 text-[10px] text-ink-secondary">{g.role}款</span>
                )}
                <AiBadge p={p} />
              </div>
              <div className="mt-1.5 text-[11.5px] leading-5 text-ink-muted">
                预估可用 {Math.round(g.available)} · 签收 {g.signRate === null ? '—' : `${(g.signRate * 100).toFixed(0)}%`}
                · 发货退货 {g.afterShipRate === null ? '—' : `${(g.afterShipRate * 100).toFixed(0)}%`} · 在途 {g.members.reduce((s, m) => s + (m.inTransit || 0), 0)} · 转化 {(p.conversion * 100).toFixed(1)}% · 拉新 {(p.newBuyer * 100).toFixed(0)}%
              </div>
              {g.members.length > 1 && (
                <div className="mt-1.5 space-y-0.5 border-t border-edge-muted pt-1.5">
                  {g.members.map((m) => (
                    <div key={m.id} className="flex items-center justify-between text-[10.5px] leading-4">
                      <span className="min-w-0 truncate text-ink-secondary">
                        {m.id.toUpperCase()} {m.name}
                      </span>
                      <span className="ml-2 shrink-0 font-medium">{Math.round(availableOf(m, estimateOf(m))).toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              )}
              {metaLine && <div className="mt-0.5 text-[11px] text-ink-faint">{metaLine}</div>}
              {flags.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {flags.slice(0, 4).map((t) => {
                    const warn = /超期|无动销|偏高|黑榜|低售罄/.test(t);
                    return (
                      <span
                        key={t}
                        className={`rounded-sm px-1.5 py-0.5 text-[10px] ${warn ? 'bg-stage-return-fg/10 text-stage-return-fg' : 'bg-surface-subtle text-ink-secondary'}`}
                      >
                        {t}
                      </span>
                    );
                  })}
                </div>
              )}
              {(qty > 0 || gv > 0) && (
                <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-ink-muted">
                  <span>计划翻单 <span className="font-semibold text-ink-secondary">{p.plannedQty}</span></span>
                  <span>已下单 <span className="font-semibold text-ink-secondary">{p.orderedQty}</span></span>
                  <span>货值 <span className="font-semibold text-ink-secondary">¥{Math.round(gv).toLocaleString()}</span></span>
                </div>
              )}
              {p.aiReason && <div className={`mt-1.5 text-[11px] leading-5 ${avoid ? 'text-stage-return-fg' : 'text-ink-secondary'}`}>{p.aiReason}</div>}

              {!remain && (
                <div className="mt-3 border-t border-edge-muted pt-3 text-[10.5px] text-ink-faint">
                  暂无剩余库存推荐 · BI 卡片未覆盖此款
                </div>
              )}
              {remain && (
                <div className="mt-3 border-t border-edge-muted pt-3">
                  <div className="flex items-baseline justify-between">
                    <div className="text-[10.5px] font-medium tracking-widest text-ink-muted">
                      预估剩余可用{g.members.length > 1 ? '（套系合计）' : ''}
                    </div>
                    <div className="text-[18px] font-bold text-stage-return-fg">{Math.round(g.available).toLocaleString()}</div>
                  </div>
                  <div className="mt-2 grid grid-cols-4 gap-x-2 gap-y-1.5 text-[10.5px]">
                    <InvCell label="总库存" v={remain.totals.totalStock} />
                    <InvCell label="主仓" v={remain.totals.mainStock} />
                    <InvCell label="采购在途" v={remain.totals.ontheway} color="text-ink-primary" />
                    <InvCell label="销退在途" v={remain.totals.returnOnway} color="text-stage-connect-fg" />
                    <InvCell label="订单占有" v={remain.totals.orderBook} />
                    <InvCell label="下单量" v={remain.totals.orderQty} />
                    <InvCell label="虚拟云仓" v={remain.totals.virtualStock} />
                    <InvCell label="销退仓" v={remain.totals.returnStock} />
                  </div>
                  {remain && p.netSales !== undefined && p.netSales !== null && (
                    <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 text-[10.5px]">
                      <span className="text-ink-primary">
                        净销量 <span className="text-[12px] font-semibold">{Math.round(p.netSales).toLocaleString()}</span>
                      </span>
                      {p.returnRate !== undefined && p.returnRate !== null && p.returnRate > 0 && (
                        <span className="text-ink-faint">退货率 {(p.returnRate * 100).toFixed(0)}%</span>
                      )}
                      {remain.last7dNetSales != null && (
                        <span className="text-ink-faint">近7天 {Math.round(remain.last7dNetSales).toLocaleString()}</span>
                      )}
                      {remain.last30dNetSales != null && (
                        <span className="text-ink-faint">近30天 {Math.round(remain.last30dNetSales).toLocaleString()}</span>
                      )}
                    </div>
                  )}
                  <div className="mt-1.5 text-[10.5px] text-ink-primary">
                    采购交期：
                    {remain.purchaseEtaDate ? (
                      <>
                        <span className="font-medium">{remain.purchaseEtaDate}</span>
                        {etaDays !== null && (
                          etaDays < 0 ? (
                            <span className="ml-1 font-medium text-stage-return-fg">（已超期 {-etaDays} 天）</span>
                          ) : etaDays === 0 ? (
                            <span className="ml-1 text-ink-faint">（今天到仓）</span>
                          ) : (
                            <span className="ml-1 text-ink-faint">（预计 {etaDays} 天）</span>
                          )
                        )}
                      </>
                    ) : (
                      <span className="text-ink-muted">—</span>
                    )}
                  </div>
                  <div className="mt-1.5 text-[10.5px] text-ink-muted">
                    上新 {remain.launchDate || p.launchDate || '—'}
                  </div>
                  {remain.skus.length > 0 && (
                    <div className="mt-1.5 border-t border-edge-muted pt-1.5">
                      <div className="text-[10.5px] font-medium tracking-widest text-ink-muted">{remain.skus.length} 个色号/SKC 预估剩余库存</div>
                      <div className="mt-1 space-y-0.5">
                        {remain.skus.slice(0, 4).map((s) => (
                          <div key={s.skc} className="flex items-center justify-between text-[10.5px] leading-4">
                            <span className="min-w-0 truncate">
                              <span className="text-ink-secondary">{s.color || '默认'}</span>
                              <span className="ml-1 text-ink-faint">{s.skc}</span>
                            </span>
                            <span className="ml-2 shrink-0 font-medium">{Math.round(s.estimate).toLocaleString()}</span>
                          </div>
                        ))}
                        {remain.skus.length > 4 && (
                          <div className="text-[10px] text-ink-faint">+{remain.skus.length - 4} 个色号未显示</div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {!avoid && (
                // modal={false}：菜单打开时不要给 body 加 pointer-events: none，
                // 否则紧接着弹出的套系确认框关闭后可能把这一层一起带走，整页点不动
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <button className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-md border border-edge py-2 text-[12px] font-medium transition-colors hover:bg-action-primary hover:text-white">
                      <Plus size={13} /> 放入「{tray.name}」
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-44">
                    {traySections.map((s) => (
                      <DropdownMenuItem
                        key={s.id}
                        onClick={() => {
                          // 有同套系的其他款就先问一句；没有就直接放这一款
                          const others = suiteSiblings(p, PRODUCTS);
                          if (others.length > 0) {
                            setSuitePrompt({ product: p, sectionId: s.id, others, picked: [] });
                            return;
                          }
                          onAdd([p.id], s.id);
                          toast.success(`「${p.name}」已作为新坑位放入 ${s.label}`);
                        }}
                      >
                        {s.label} 版块（新坑位）
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          );
        })}
        {visible.length === 0 && (
          <div className="col-span-full border border-dashed border-edge-strong py-16 text-center text-[13px] text-ink-muted">
            当前策略条件下无候选款 —— 放宽条件，或让 AI 给一版策略
          </div>
        )}
      </div>

      {/* 分页 */}
      {pageCount > 1 && (
        <div className="mb-12 flex flex-wrap items-center justify-between gap-3 border-t border-edge pt-4">
          <div className="text-[11.5px] text-ink-muted">
            第 {safePage + 1} / {pageCount} 页 · 每页 {pageSize} 款 · 共 {visible.length} 款
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => goPage(safePage - 1)}
              disabled={safePage === 0}
              className="flex items-center gap-0.5 rounded-md border border-edge px-2.5 py-1.5 text-[12px] transition-colors hover:border-edge-strong disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronLeft size={13} /> 上一页
            </button>
            {pageButtons.map((n, i) =>
              n === '…' ? (
                <span key={`gap-${i}`} className="px-1 text-[12px] text-ink-faint">…</span>
              ) : (
                <button
                  key={n}
                  onClick={() => goPage(n)}
                  className={`min-w-[30px] rounded-md border px-2 py-1.5 text-[12px] transition-colors ${
                    n === safePage
                      ? 'border-action-primary bg-action-primary text-white'
                      : 'border-edge hover:border-edge-strong'
                  }`}
                >
                  {n + 1}
                </button>
              ),
            )}
            <button
              onClick={() => goPage(safePage + 1)}
              disabled={safePage >= pageCount - 1}
              className="flex items-center gap-0.5 rounded-md border border-edge px-2.5 py-1.5 text-[12px] transition-colors hover:border-edge-strong disabled:cursor-not-allowed disabled:opacity-40"
            >
              下一页 <ChevronRight size={13} />
            </button>
          </div>
        </div>
      )}

      {/* 套系提醒：这款有同小名的其他款，勾选的会一起放进同一个坑位。
          注意：这里用自绘遮罩，不用 Radix Dialog —— 从 DropdownMenu 里打开 Radix 弹层时，
          两层都会给 body 加 pointer-events: none，回滚顺序打架会把整页变成点不动。 */}
      {suitePrompt && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
          onClick={() => setSuitePrompt(null)}
        >
          <div
            className="w-full max-w-md rounded-lg border border-edge bg-surface-card p-5 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-[14px] font-semibold">这个款还有同套系的其他款</div>
            <div className="mt-1 text-[12px] leading-5 text-ink-muted">
              「{suitePrompt.product.sub}」套系下除 {suitePrompt.product.id.toUpperCase()} 外还有{' '}
              {suitePrompt.others.length} 款。勾选的会作为同一坑位一起放入，不勾选就只放当前这款。
            </div>
            <div className="mt-3 max-h-72 space-y-1 overflow-auto">
              {suitePrompt.others.map((q) => {
                const on = suitePrompt.picked.includes(q.id);
                return (
                  <label
                    key={q.id}
                    className={`flex cursor-pointer items-center gap-2 rounded-sm border px-2.5 py-2 text-[12px] transition-colors ${
                      on ? 'border-action-primary bg-action-primary/5' : 'border-edge hover:border-edge-strong'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() =>
                        setSuitePrompt((prev) =>
                          prev
                            ? {
                                ...prev,
                                picked: prev.picked.includes(q.id)
                                  ? prev.picked.filter((x) => x !== q.id)
                                  : [...prev.picked, q.id],
                              }
                            : prev,
                        )
                      }
                    />
                    <span className="w-24 shrink-0 font-medium">{q.id.toUpperCase()}</span>
                    <span className="min-w-0 flex-1 truncate text-ink-muted">{q.name}</span>
                    <span className="shrink-0 text-[11px] text-ink-faint">
                      可用 {Math.round(availableOf(q, estimateOf(q))).toLocaleString()} · 在途 {q.inTransit || 0}
                    </span>
                  </label>
                );
              })}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setSuitePrompt(null)}
                className="rounded-md border border-edge px-3 py-1.5 text-[12px] text-ink-muted hover:border-edge-strong"
              >
                取消
              </button>
              <button
                onClick={() => {
                  const { product, sectionId, picked } = suitePrompt;
                  onAdd([product.id, ...picked], sectionId);
                  setSuitePrompt(null);
                  toast.success(
                    picked.length > 0
                      ? `「${product.name}」及 ${picked.length} 件同套系款已作为一个坑位放入`
                      : `「${product.name}」已作为新坑位放入`,
                  );
                }}
                className="rounded-md bg-action-primary px-3 py-1.5 text-[12px] font-medium text-white"
              >
                {suitePrompt.picked.length > 0 ? `一起放入（${suitePrompt.picked.length + 1} 件）` : '只放入这一款'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
