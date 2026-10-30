import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Plus, Check, Sparkles, CircleAlert, Layers, Send, Bot, ChevronLeft, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { TRAY_TYPES, totalQty, goodsValue, type Product, type RoleTag, type Tray, type TrayType } from '@/data/products';
import { useProducts } from '@/data/ProductsContext';
import { postAiStrategy, fetchRemainingInventory, type RemainingGroup, fetchFilters, type ApiFilters, fetchLaunchYears } from '@/data/api';

// ── 策略筛选条件（多维筛选框，维度与商品侧共创） ──
interface Filters {
  cats: string[];      // 品类
  waves: string[];     // 波段
  bands: string[];     // 价格带
  temps: string[];     // 适穿温度带
  roles: RoleTag[];    // 商品角色
  years: number[];     // 上新年份
  minStock: number;    // 现货 ≥
  noTransit: boolean;  // 仅无在途
  minConv: number;     // 转化率 ≥ %
  maxReturn: number;   // 退货率 ≤ %
  minNewBuyer: number; // 拉新率 ≥ %
  scenes: string[];    // 场景规则
  perLookN: number;    // 每品类每角色取 X 个坑位
}

const DEFAULT_FILTERS: Filters = {
  cats: [], waves: [], bands: [], temps: [], roles: [], years: [],
  minStock: 0, noTransit: false, minConv: 0, maxReturn: 80, minNewBuyer: 0,
  scenes: [], perLookN: 3,
};

const DIM = {
  cats: ['大衣', '针织', 'T恤', '裤装', '套装', '鞋靴', '衬衫', '外套', '西装', '背心', '夹克', '羽绒'],
  waves: ['9月1波段', '9月2波段', '10月1波段', '常青款'],
  bands: ['低', '中', '高'] as const,
  temps: ['<5°C', '0~12°C', '5~15°C', '10~20°C', '15~25°C', '18~28°C', '全季'],
  roles: ['引流', '利润', '库存'] as RoleTag[],
  scenes: ['降温提权', '高湿→速干候选', '大促引流占比上调'],
};

const PRESETS: { label: string; patch: Partial<Filters> }[] = [
  { label: '冬季日常场', patch: { ...DEFAULT_FILTERS, cats: ['大衣', '针织', '套装', '裤装', 'T恤', '外套'], temps: ['0~12°C', '5~15°C', '10~20°C'], scenes: ['降温提权'] } },
  { label: '清仓场', patch: { ...DEFAULT_FILTERS, roles: ['库存'], noTransit: true, minStock: 200 } },
  { label: '新品首发场', patch: { ...DEFAULT_FILTERS, waves: ['9月2波段', '常青款'] } },
  { label: '大促场', patch: { ...DEFAULT_FILTERS, scenes: ['大促引流占比上调'] } },
];

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
      text: '建议按清仓策略：锁定「库存款」角色（主仓>200 且无在途），转化率 ≥5% 保证动销，退货率 ≤30% 避免清出售后压力。要应用吗？',
      patch: { roles: ['库存'], noTransit: true, minStock: 200, minConv: 5, maxReturn: 30 },
    };
  if (/拉新|新客/.test(q))
    return {
      from: 'ai',
      text: '拉新导向建议：拉新率 ≥40%，价格带低/中，现货 ≥100 保证承接。纤纤裤（拉新 52%）这类款会是主力。要应用吗？',
      patch: { minNewBuyer: 40, bands: ['低', '中'], minStock: 100 },
    };
  if (/利润|毛利|赚钱/.test(q))
    return {
      from: 'ai',
      text: '利润导向建议：锁定「利润款」角色（零售/成本比 ≥2.8），价格带高，退货率 ≤30%。建议峰值时段释放。要应用吗？',
      patch: { roles: ['利润'], bands: ['高'], maxReturn: 30 },
    };
  const catHit = DIM.cats.find((c) => q.includes(c));
  if (catHit)
    return {
      from: 'ai',
      text: `已理解：本场聚焦「${catHit}」。建议叠加温度带匹配和退货率 ≤80% 的底线。要应用吗？`,
      patch: { cats: [catHit], maxReturn: 80 },
    };
  return {
    from: 'ai',
    text: '我可以按这些维度帮你定策略：品类 / 波段 / 价格带 / 温度带 / 角色（引流·利润·库存）/ 库存条件 / 转化率·退货率·拉新率阈值 / 场景规则。试试说"清一波库存"或"这场主打拉新"。',
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

export default function BoardPage({
  trays, activeTrayId, onSwitchTray, onCreateTray, onAdd,
}: {
  trays: Tray[];
  activeTrayId: string;
  onSwitchTray: (id: string) => void;
  onCreateTray: (name: string, type: TrayType, date: string) => Tray;
  onAdd: (pid: string, sectionId: string) => void;
}) {
  const [f, setF] = useState<Filters>({ ...DEFAULT_FILTERS, cats: ['大衣', '针织', '套装', '裤装', 'T恤', '外套'], scenes: ['降温提权'] });
  const [roleTab, setRoleTab] = useState<'全部' | RoleTag>('全部');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<TrayType>('马总直播货盘');
  const [newDate, setNewDate] = useState('2026-10-02');
  const [chat, setChat] = useState<ChatMsg[]>([
    { from: 'ai', text: '这场想怎么打？告诉我目标（清仓 / 拉新 / 利润 / 主打某品类），我把策略转成筛选条件。' },
  ]);
  const [input, setInput] = useState('');

  const PRODUCTS = useProducts();

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
      .catch(() => setDims({ categories: DIM.cats, waves: DIM.waves, tempBands: DIM.temps, priceBands: [...DIM.bands], roles: DIM.roles, launchYears: [] }));
  }, []);
  const catList = dims.categories.length ? dims.categories : DIM.cats;
  const waveList = dims.waves.length ? dims.waves : DIM.waves;
  const tempList = dims.tempBands.length ? dims.tempBands : DIM.temps;
  const bandList = dims.priceBands.length ? dims.priceBands : DIM.bands;
  const yearList = (dims.launchYears && dims.launchYears.length ? dims.launchYears : remainingYears);
  const roleList = DIM.roles;

  // 剩余库存推荐（按款号索引，未覆盖的款不显示该段）
  const [remainingMap, setRemainingMap] = useState<Map<string, RemainingGroup>>(new Map());
  useEffect(() => {
    fetchRemainingInventory({ limit: 7000 })
      .then((r) => setRemainingMap(new Map(r.items.map((it) => [it.styleCode.toLowerCase(), it]))))
      .catch(() => setRemainingMap(new Map()));
  }, []);

  const tray = trays.find((t) => t.id === activeTrayId) ?? trays[0];
  const traySections = tray.sections.filter((s) => s.visible);

  const toggleArr = <T,>(arr: T[], v: T) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  const pool = useMemo(
    () =>
      PRODUCTS.filter(
        (p) =>
          (f.cats.length === 0 || f.cats.includes(p.category)) &&
          (f.waves.length === 0 || f.waves.includes(p.wave)) &&
          (f.bands.length === 0 || f.bands.includes(p.priceBand)) &&
          (f.temps.length === 0 || f.temps.includes(p.tempBand)) &&
          (f.roles.length === 0 || p.roles.some((r) => f.roles.includes(r))) &&
          (f.years.length === 0 || (() => {
            // 领猫侧没有 launchDate，回退到剩余库存 BI 卡片的「款上新时间」
            const ld = String(p.launchDate || '') || String(remainingMap.get(p.id.toLowerCase())?.launchDate || '');
            const m = ld.match(/^(\d{4})/);
            const y = m ? Number(m[1]) : 0;
            return f.years.includes(y);
          })()) &&
          p.stockMain >= f.minStock &&
          (!f.noTransit || p.inTransit === 0) &&
          p.conversion * 100 >= f.minConv &&
          // 无退货率数据的款不卡阈值（避免 NaN 比较误杀）
          (p.returnRate == null || p.returnRate * 100 <= f.maxReturn) &&
          p.newBuyer * 100 >= f.minNewBuyer,
      ),
    [f, PRODUCTS, remainingMap],
  );

  const visible = useMemo(() => {
    const list = roleTab === '全部' ? [...pool] : pool.filter((p) => p.roles.includes(roleTab));
    const rank = (p: Product) => (p.ai === 'top' ? 0 : p.ai === 'extra' ? 2 : p.ai === 'avoid' ? 3 : 1);
    return list.sort((a, b) => rank(a) - rank(b) || b.conversion - a.conversion);
  }, [pool, roleTab]);

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

  const send = async () => {
    const q = input.trim();
    if (!q) return;
    setChat((c) => [...c, { from: 'me', text: q }, { from: 'ai', text: 'AI 思考中…' }]);
    setInput('');
    try {
      const r = await postAiStrategy(q, f, pool.slice(0, 30));
      setChat((c) => [...c.slice(0, -1), { from: 'ai', text: r.text, patch: (r.patch as Partial<Filters>) || undefined }]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'AI 暂时不可用';
      setChat((c) => [...c.slice(0, -1), { from: 'ai', text: `AI 失败：${msg}（已回退到关键词兜底）` }, aiReplyFallback(q)]);
    }
  };

  const Dim = ({ label, children }: { label: string; children: ReactNode }) => (
    <div className="board-dimension flex items-start gap-3 border-b border-edge-muted py-3">
      <span className="w-24 shrink-0 pt-1 text-[11px] font-medium text-ink-muted">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );

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
        {trays.map((t) => (
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
          <div className="flex items-center gap-2 border-b border-edge-muted py-3">
            <span className="w-24 shrink-0 text-[11px] font-medium text-ink-muted">快捷方案</span>
            {PRESETS.map((p) => (
              <Chip key={p.label} on={false} label={p.label} onClick={() => { setF((x) => ({ ...x, ...p.patch })); toast.success(`已应用「${p.label}」策略`); }} />
            ))}
            <button onClick={() => setF(DEFAULT_FILTERS)} className="ml-auto text-[11px] text-ink-muted hover:text-ink-primary">清空条件</button>
          </div>
          <Dim label="品类">
            {catList.map((c) => <Chip key={c} on={f.cats.includes(c)} label={c} onClick={() => setF((x) => ({ ...x, cats: toggleArr(x.cats, c) }))} />)}
          </Dim>
          <Dim label="波段">
            {waveList.map((w) => <Chip key={w} on={f.waves.includes(w)} label={w} onClick={() => setF((x) => ({ ...x, waves: toggleArr(x.waves, w) }))} />)}
          </Dim>
          {yearList.length > 0 && (
            <Dim label="上新年份">
              {yearList.map((y) => <Chip key={y} on={f.years.includes(y)} label={String(y)} onClick={() => setF((x) => ({ ...x, years: toggleArr(x.years, y) }))} />)}
            </Dim>
          )}
          <Dim label="价格带">
            {bandList.map((b) => <Chip key={b} on={f.bands.includes(b)} label={b === '空' ? '未分类' : `${b}价位`} onClick={() => setF((x) => ({ ...x, bands: toggleArr(x.bands, b) }))} />)}
          </Dim>
          <Dim label="适穿温度带">
            {tempList.map((t) => <Chip key={t} on={f.temps.includes(t)} label={t} onClick={() => setF((x) => ({ ...x, temps: toggleArr(x.temps, t) }))} />)}
          </Dim>
          <Dim label="商品角色">
            {DIM.roles.map((r) => <Chip key={r} on={f.roles.includes(r)} label={`${r}款`} onClick={() => setF((x) => ({ ...x, roles: toggleArr(x.roles, r) }))} />)}
          </Dim>
          <Dim label="库存条件">
            <label className="flex items-center gap-1 text-[11.5px] text-ink-secondary">
              现货 ≥
              <input type="number" value={f.minStock} onChange={(e) => setF((x) => ({ ...x, minStock: Number(e.target.value) }))} className="w-16 rounded border border-edge-strong px-1.5 py-0.5 text-center text-[11.5px] outline-none focus:border-edge" />
            </label>
            <Chip on={f.noTransit} label="仅无在途" onClick={() => setF((x) => ({ ...x, noTransit: !x.noTransit }))} />
          </Dim>
          <Dim label="指标阈值">
            {[['转化率≥%', 'minConv', f.minConv], ['退货率≤%', 'maxReturn', f.maxReturn], ['拉新率≥%', 'minNewBuyer', f.minNewBuyer]].map(([label, key, val]) => (
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
          <Dim label="场景规则">
            {DIM.scenes.map((s) => <Chip key={s} on={f.scenes.includes(s)} label={s} onClick={() => setF((x) => ({ ...x, scenes: toggleArr(x.scenes, s) }))} />)}
          </Dim>
          <Dim label="坑位数量">
            <label className="flex items-center gap-1 text-[11.5px] text-ink-secondary">
              每品类每角色取
              <input type="number" min={1} max={9} value={f.perLookN} onChange={(e) => setF((x) => ({ ...x, perLookN: Number(e.target.value) }))} className="w-14 rounded border border-edge-strong px-1.5 py-0.5 text-center text-[11.5px] outline-none focus:border-edge" />
              个坑位（每坑位多款号）
            </label>
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
            {r === '全部' ? `全部候选（${pool.length}）` : `${r}款（${pool.filter((p) => p.roles.includes(r)).length}）`}
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
        {pageItems.map((p) => {
          const avoid = p.ai === 'avoid';
          const added = inTray(p.id);
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
          const qty = totalQty(p);
          const gv = goodsValue(p);
          // 采购交期：负数 = 已超期
          const etaMs = remain?.purchaseEtaDate
            ? new Date(`${remain.purchaseEtaDate}T00:00:00+08:00`).getTime()
            : Number.NaN;
          const etaDays = Number.isFinite(etaMs) ? Math.round((etaMs - Date.now()) / 86_400_000) : null;
          return (
            <div key={p.id} className={avoid ? 'opacity-45 grayscale' : ''}>
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
                <div className="min-w-0 truncate text-[14px] font-semibold leading-tight">{p.name}</div>
                <div className="shrink-0 text-[14px] font-bold text-stage-connect-fg">¥{p.price}</div>
              </div>
              <div className="mt-1 text-[11.5px] text-ink-muted">
                {p.id.toUpperCase()} · {p.colors.join(' / ')}
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {p.roles.map((r) => (
                  <span key={r} className="rounded-sm border border-edge-strong px-1.5 py-0.5 text-[10px] text-ink-secondary">{r}款</span>
                ))}
                <AiBadge p={p} />
              </div>
              <div className="mt-1.5 text-[11.5px] leading-5 text-ink-muted">
                现货 {p.stockMain} · 在途 {p.inTransit} · 转化 {(p.conversion * 100).toFixed(1)}% · 拉新 {(p.newBuyer * 100).toFixed(0)}%
              </div>
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
                    <div className="text-[10.5px] font-medium tracking-widest text-ink-muted">预估剩余库存</div>
                    <div className="text-[18px] font-bold text-stage-return-fg">{Math.round(remain.totals.estimate).toLocaleString()}</div>
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
                <DropdownMenu>
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
                          onAdd(p.id, s.id);
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
    </div>
  );
}
