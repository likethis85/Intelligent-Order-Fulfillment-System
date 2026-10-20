import { useEffect, useMemo, useState } from 'react';
import { useIsMobile } from '@/hooks/use-mobile';
import { ArrowUp, ArrowDown, RotateCcw, Trash2, Sparkles, Clock, Layers, Printer } from 'lucide-react';
import { toast } from 'sonner';
import { type Product, type Tray, type SeqEntry } from '@/data/products';
import { useProductResolver } from '@/data/ProductsContext';
import PrintSettingsDialog from '@/components/PrintSettingsDialog';

// ── 排品 = 货盘的"上场顺序视图"：绑定货盘，坑位拉成直播时间线 ──

// 图片加载失败兜底：显示款号前两字符首字母占位
function SeqImg({ src, alt, pid, className }: { src: string; alt?: string; pid?: string; className?: string }) {
  const [errored, setErrored] = useState(false);
  if (!src || errored) {
    const placeholder = (pid || alt || '').slice(0, 2).toUpperCase() || '无图';
    return (
      <div className={`${className ?? ''} flex items-center justify-center bg-gradient-to-br from-surface-subtle to-surface-muted text-[10px] font-semibold tracking-wide text-ink-muted`} title={pid ? `无图：${pid}` : '无图'}>
        {placeholder}
      </div>
    );
  }
  return <img src={src} alt={alt ?? ''} className={className} onError={() => setErrored(true)} />;
}

const SEG_COLOR: Record<string, string> = {
  开场引流: 'bg-action-primary text-white',
  承接: 'bg-stage-connect-bg text-stage-connect-fg',
  利润峰值: 'bg-stage-peak-bg text-stage-peak-fg',
  库存释放: 'bg-surface-subtle text-ink-secondary',
  返场: 'bg-stage-return-bg text-stage-return-fg',
};

const STRATEGIES = [
  { key: 'daily', label: '日常场节奏', desc: '按货盘坑位顺序上场（主推A → 主推B → 主推C…），段标签按角色标注，TOP2 返场收尾' },
  { key: 'promo', label: '大促场节奏', desc: '引流占比上调、节奏加快：引流开场后直接进利润峰值，库存款提前穿插，返场增加到 TOP3' },
  { key: 'clear', label: '清仓场节奏', desc: '库存款前置主讲，引流款每 4 坑穿插一次稳人气，不设置利润峰值段' },
];

function defaultEntries(tray: Tray): SeqEntry[] {
  return tray.sections
    .filter((s) => s.visible)
    .flatMap((s) => s.looks.map((l) => ({ key: `${s.id}/${l.id}`, lookId: l.id, sectionLabel: s.label })));
}

function lookPids(tray: Tray, lookId: string): string[] {
  for (const s of tray.sections) {
    const l = s.looks.find((x) => x.id === lookId);
    if (l) return l.pids;
  }
  return [];
}

// 查找坑位对象（含 userImg 用户自传主图）
function findLook(tray: Tray, lookId: string): { pids: string[]; userImg?: string | null } | null {
  for (const s of tray.sections) {
    const l = s.looks.find((x) => x.id === lookId);
    if (l) return l;
  }
  return null;
}

function bucketOf(pids: string[], byId: (id: string) => Product): string {
  const ps = pids.map(byId);
  if (ps.some((p) => p.roles.includes('引流'))) return '引流';
  if (ps.some((p) => p.roles.includes('利润'))) return '利润';
  if (ps.some((p) => p.roles.includes('库存'))) return '库存';
  return '其他';
}

const conv = (pids: string[], byId: (id: string) => Product) =>
  Math.max(...pids.map((id) => byId(id).conversion));

function aiSort(entries: SeqEntry[], tray: Tray, mode: string, byId: (id: string) => Product): SeqEntry[] {
  const withB = entries.map((e) => ({ e, b: bucketOf(lookPids(tray, e.lookId), byId) }));
  const byConv = (x: (typeof withB)[number], y: (typeof withB)[number]) =>
    conv(lookPids(tray, y.e.lookId), byId) - conv(lookPids(tray, x.e.lookId), byId);
  const pick = (b: string) => withB.filter((x) => x.b === b).sort(byConv).map((x) => x.e);

  let ordered: SeqEntry[];
  if (mode === 'clear') {
    const stock = pick('库存').concat(pick('其他'));
    const traffic = pick('引流');
    ordered = [];
    let ti = 0;
    stock.forEach((e, i) => {
      ordered.push({ ...e, seg: '库存释放' });
      if ((i + 1) % 4 === 0 && ti < traffic.length) ordered.push({ ...traffic[ti++], seg: '开场引流' });
    });
    while (ti < traffic.length) ordered.push({ ...traffic[ti++], seg: '开场引流' });
    ordered = [...ordered, ...pick('利润').map((e) => ({ ...e, seg: '库存释放' }))];
  } else if (mode === 'daily') {
    // 日常场：不重排，按货盘分区顺序（主推A→B→C…）上场，段标签按坑位角色标注，TOP2 返场收尾
    const segOf = (b: string) => (b === '引流' ? '开场引流' : b === '利润' ? '利润峰值' : b === '库存' ? '库存释放' : '承接');
    ordered = withB.map((x) => ({ ...x.e, seg: segOf(x.b) }));
    const top = [...ordered]
      .sort((a, b) => conv(lookPids(tray, b.lookId), byId) - conv(lookPids(tray, a.lookId), byId))
      .slice(0, 2);
    ordered = [...ordered, ...top.map((e) => ({ ...e, key: e.key + '#返场', seg: '返场', rerun: true }))];
  } else {
    const open = pick('引流');
    const carry = pick('其他');
    const profit = pick('利润');
    const stock = pick('库存');
    if (mode === 'promo') {
      // 引流开场后直接进利润峰值；库存款提前穿插进峰值段（每 2 个利润款穿插 1 个库存款），
      // 剩余库存提前到承接之前收尾。无利润款时库存款整体提前（与日常场的差异点）。
      const peak: SeqEntry[] = [];
      let si = 0;
      profit.forEach((e, i) => {
        peak.push({ ...e, seg: '利润峰值' });
        if ((i + 1) % 2 === 0 && si < stock.length) peak.push({ ...stock[si++], seg: '库存释放' });
      });
      ordered = [
        ...open.map((e) => ({ ...e, seg: '开场引流' })),
        ...peak,
        ...stock.slice(si).map((e) => ({ ...e, seg: '库存释放' })),
        ...carry.map((e) => ({ ...e, seg: '承接' })),
      ];
    } else {
      ordered = [
        ...open.map((e) => ({ ...e, seg: '开场引流' })),
        ...carry.map((e) => ({ ...e, seg: '承接' })),
        ...profit.map((e) => ({ ...e, seg: '利润峰值' })),
        ...stock.map((e) => ({ ...e, seg: '库存释放' })),
      ];
    }
    const n = mode === 'promo' ? 3 : 2;
    const top = [...ordered]
      .sort((a, b) => conv(lookPids(tray, b.lookId), byId) - conv(lookPids(tray, a.lookId), byId))
      .slice(0, n);
    ordered = [...ordered, ...top.map((e) => ({ ...e, key: e.key + '#返场', seg: '返场', rerun: true }))];
  }
  return ordered;
}

export default function SequencePage({
  trays, activeTrayId, onSwitchTray, onUpdateTray, readOnly = false,
}: {
  trays: Tray[];
  activeTrayId: string;
  onSwitchTray: (id: string) => void;
  onUpdateTray: (t: Tray) => void;
  readOnly?: boolean;
}) {
  const isMobile = useIsMobile();
  const tray = trays.find((t) => t.id === activeTrayId) ?? trays[0];
  const [strategy, setStrategy] = useState('');
  const [printDialogOpen, setPrintDialogOpen] = useState(false);
  // 与 TraysPage 同源：/api/products 没有的老款/样衣号从 /api/samples 兜底补齐
  const allPids = useMemo(
    () => tray.sections.flatMap((s) => s.looks.flatMap((l) => l.pids)),
    [tray],
  );
  const byId = useProductResolver(allPids);

  const savedEntries = tray.seqOrders?.[tray.id] ?? defaultEntries(tray);
  // 草稿：调顺序（拖拽/节奏生成/返场/删除）先落在草稿，点「保存排品」才写回货盘持久化
  // —— 避免手滑点了别的节奏模式，把已调好的顺序冲掉
  const [draft, setDraft] = useState<SeqEntry[] | null>(null);
  const entries = draft ?? savedEntries;

  // 通用 upd：把当前 tray 走 onUpdateTray 写回（持久化到 localStorage + /api/trays）
  const upd = (fn: (t: Tray) => Tray) => onUpdateTray(fn(tray));

  const persistEntries = (next: SeqEntry[]) => {
    upd((t) => ({ ...t, seqOrders: { ...(t.seqOrders || {}), [t.id]: next } }));
  };

  // 所有顺序编辑都进草稿（未保存）
  const editEntries = (next: SeqEntry[]) => setDraft(next);

  const saveDraft = () => {
    if (!draft) return;
    persistEntries(draft);
    setDraft(null);
    toast.success('排品顺序已保存');
  };

  const discardDraft = () => {
    setDraft(null);
    setStrategy('');
    toast.success('已放弃未保存的修改');
  };

  // 换货盘：丢弃未保存草稿（已保存的顺序不受影响）
  useEffect(() => { setDraft(null); setStrategy(''); }, [tray.id]);

  // 货盘内容变化（新增坑位）时补齐：已保存顺序和草稿都补
  useEffect(() => {
    const base = defaultEntries(tray);
    const cur = tray.seqOrders?.[tray.id];
    if (cur) {
      const missing = base.filter((b) => !cur.some((c) => c.lookId === b.lookId));
      if (missing.length > 0) {
        upd((t) => ({ ...t, seqOrders: { ...(t.seqOrders || {}), [t.id]: [...cur, ...missing] } }));
      }
    }
    setDraft((d) => {
      if (!d) return d;
      const missingD = base.filter((b) => !d.some((c) => c.lookId === b.lookId));
      return missingD.length > 0 ? [...d, ...missingD] : d;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tray.id]);

  // 拖拽 / 上下移动通用：把 from 位置的项搬到 to（to 用「移除后数组」的插入下标，允许 to === length 表示插到末尾）
  const move = (from: number, to: number) => {
    if (from === to || from < 0 || from >= entries.length || to < 0 || to > entries.length) return;
    const arr = [...entries];
    const [m] = arr.splice(from, 1);
    arr.splice(to, 0, m);
    editEntries(arr);
  };

  // 拖拽释放：把 from 插到坑位 i 的前/后。
  // splice 语义下，from < i 时移除后目标会左移一位，所以插入下标要相应 -1，
  // 否则「从上往下拖、插在目标后面」会多偏一位。
  const moveDrop = (from: number, i: number, before: boolean) => {
    const to = from < i ? (before ? i - 1 : i) : before ? i : i + 1;
    move(from, to);
  };

  const gen = (key: string) => {
    editEntries(aiSort(defaultEntries(tray), tray, key, byId));
    setStrategy(key);
    toast.success('已生成节奏初稿（未保存）—— 微调后点「保存排品」生效');
  };

  // 把 'HH:MM' + i * 8 分钟转成 'HH:MM'
  const minutes = (i: number) => {
    const [h, m] = (tray.startTime ?? '19:00').split(':').map(Number);
    const t = (h * 60 + (m || 0)) + i * 8;
    return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  };

  const setStartTime = (v: string) => {
    upd((t) => ({ ...t, startTime: v }));
  };

  const setDisplayMode = (m: 'list' | 'timeline') => {
    upd((t) => ({ ...t, seqDisplayMode: m }));
  };

  const chip = (t: Tray) => (
    <button
      key={t.id}
      onClick={() => onSwitchTray(t.id)}
      className={`rounded-full border px-3.5 py-1.5 text-xs transition-colors ${
        t.id === tray.id ? 'border-edge bg-action-primary text-white' : 'border-edge-strong hover:border-edge'
      }`}
    >
      {t.name} {t.date}
    </button>
  );

  // 渲染一个坑位的关键信息：价格 / 现货+在途 / 翻单
  const metaOf = (pids: string[]): React.ReactNode => {
    const ps: Product[] = pids.map(byId);
    if (ps.length === 0) return null;
    const totalStock = ps.reduce((s, p) => s + (p.stockMain || 0), 0);
    const totalTransit = ps.reduce((s, p) => s + (p.inTransit || 0), 0);
    const priceTxt = ps
      .map((p) => {
        const base = p.price ? `¥${p.price}` : '—';
        const suffix = tray.priceSuffixOverrides?.[p.id];
        return suffix ? `${base} ${suffix}` : base;
      })
      .join(' / ');
    const restockTxt = ps.map((p) => p.restock || '—').join(' / ');
    const hasRestock = ps.some((p) => p.restock);
    return (
      <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[11px]">
        <span className="font-semibold text-stage-connect-fg">{priceTxt}</span>
        <span className="text-ink-muted">
          现货 {totalStock}
          {totalTransit > 0 && <> · 在途 {totalTransit}</>}
        </span>
        {hasRestock && <span className="text-stage-promote-fg">翻单：{restockTxt}</span>}
      </div>
    );
  };

  const displayMode = tray.seqDisplayMode ?? 'list';
  // 线轴模式拖拽重排：{ fromIdx, overIdx, position: 'before' | 'after' }
  const [seqDrag, setSeqDrag] = useState<{ fromIdx: number; overIdx: number; position: 'before' | 'after' } | null>(null);

  return (
    <div className="responsive-page sequence-page px-12 py-10">
      {readOnly && (
        <div className="mb-5 flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-4 py-2.5 text-[12.5px] text-amber-800">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
          当前账号仅有查看权限，排品调整不会保存
        </div>
      )}
      {/* 页面 header */}
      <div className="page-heading flex items-end justify-between border-b border-edge pb-6">
        <div>
          <div className="text-xs font-light tracking-[0.3em] text-ink-faint">02 /</div>
          <h1 className="mt-2 text-2xl font-bold leading-none tracking-tight">直播排品</h1>
          <p className="mt-3 text-sm text-ink-muted">
            排品绑定货盘 —— 盘内坑位拉成上场时间线，AI 策略出初稿，人定稿
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-ink-muted">
          开播
          <input
            type="time"
            value={tray.startTime ?? '19:00'}
            onChange={(e) => setStartTime(e.target.value)}
            className="rounded border border-edge-strong bg-surface-card px-1.5 py-0.5 text-xs outline-none focus:border-edge"
            title="直播开始时间"
          />
          <span>· 每坑位约 8 分钟</span>
        </div>
      </div>

      {/* 绑定货盘 */}
      <div className="sequence-trays mt-8 flex flex-wrap items-center gap-2.5 border border-edge px-5 py-4" data-local-scroll>
        <span className="flex items-center gap-1.5 text-sm font-medium text-ink-secondary">
          <Layers size={13} /> 绑定货盘：
        </span>
        {trays.map(chip)}
        <span className="ml-auto text-xs text-ink-muted">「{tray.name}」共 {entries.length} 个上场坑位</span>
      </div>

      {/* AI 策略库 */}
      <details className="sequence-presets" open={!isMobile}>
      <summary className="sequence-presets-toggle">
        <Sparkles size={14} aria-hidden="true" /> AI 节奏策略
        <span>{STRATEGIES.find((s) => s.key === strategy)?.label ?? '展开选择方案'}</span>
      </summary>
      <div className="sequence-strategies mt-6 grid grid-cols-3 gap-4">
        {STRATEGIES.map((s) => (
          <button
            key={s.key}
            onClick={(event) => {
              gen(s.key);
              if (isMobile) event.currentTarget.closest('details')?.removeAttribute('open');
            }}
            className={`border p-6 text-left transition-colors ${
              strategy === s.key ? 'border-ink-primary' : 'border-edge hover:border-ink-primary'
            }`}
          >
            <div className="flex items-center gap-1.5 text-sm font-semibold">
              <Sparkles size={13} /> {s.label}
            </div>
            <div className="mt-2 text-xs leading-5 text-ink-muted">{s.desc}</div>
          </button>
        ))}
      </div>
      </details>

      {/* 显示模式 + 重置 + 保存 + 提示 */}
      <div className="sequence-toolbar mt-5 flex items-center gap-3">
        <button
          onClick={() => { editEntries(defaultEntries(tray)); setStrategy(''); toast.success('已回到货盘顺序（未保存）—— 点「保存排品」生效'); }}
          className="flex items-center gap-1.5 rounded-md border border-edge-strong px-3.5 py-1.5 text-xs hover:border-edge"
        >
          <RotateCcw size={12} /> 恢复货盘顺序
        </button>
        {draft && (
          <>
            <button
              onClick={saveDraft}
              className="rounded-md bg-action-primary px-3.5 py-1.5 text-xs font-medium text-white hover:opacity-90"
            >
              保存排品
            </button>
            <button
              onClick={discardDraft}
              className="rounded-md border border-edge-strong px-3.5 py-1.5 text-xs hover:border-edge"
            >
              放弃修改
            </button>
            <span className="text-xs font-medium text-stage-return-fg">有未保存的修改</span>
          </>
        )}
        <span className="text-xs text-ink-muted">显示模式：</span>
        <button
          onClick={() => setDisplayMode('list')}
          className={`rounded border px-2.5 py-0.5 text-xs transition-colors ${
            displayMode === 'list' ? 'border-ink-primary bg-surface-subtle text-ink-primary' : 'border-edge-strong hover:border-edge'
          }`}
        >
          列表
        </button>
        <button
          onClick={() => setDisplayMode('timeline')}
          className={`rounded border px-2.5 py-0.5 text-xs transition-colors ${
            displayMode === 'timeline' ? 'border-ink-primary bg-surface-subtle text-ink-primary' : 'border-edge-strong hover:border-edge'
          }`}
        >
          线轴
        </button>
        <button
          onClick={() => setPrintDialogOpen(true)}
          className="flex items-center gap-1.5 rounded-md border border-edge-strong px-3 py-1 text-xs hover:border-edge"
          title="打印排品（纸张大小、页面方向、缩放比例）"
        >
          <Printer size={12} /> 打印排品
        </button>
        <span className="text-xs text-ink-muted">· 拖拽行 / 卡片调整顺序 · 「返场」追加到收尾 · 删除仅影响排品不动货盘 · 调整后点「保存排品」生效</span>
      </div>

      {/* 列表视图 */}
      {displayMode === 'list' && (
        <div className="sequence-list mt-8 border border-edge">
          {entries.map((e, i) => {
            const pids = lookPids(tray, e.lookId);
            if (!pids.length) return null;
            const ps: Product[] = pids.map(byId);
            const roles = [...new Set(ps.flatMap((p) => p.roles))];
            return (
              <div
                key={e.key + i}
                draggable
                onDragStart={(ev) => {
                  ev.dataTransfer.setData('text/plain', String(i));
                  ev.dataTransfer.effectAllowed = 'move';
                  setSeqDrag({ fromIdx: i, overIdx: i, position: 'before' });
                }}
                onDragEnter={(ev) => {
                  ev.preventDefault();
                  if (!seqDrag || seqDrag.fromIdx === i) return;
                  const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
                  const before = ev.clientY < rect.top + rect.height / 2;
                  setSeqDrag({ fromIdx: seqDrag.fromIdx, overIdx: i, position: before ? 'before' : 'after' });
                }}
                onDragOver={(ev) => {
                  ev.preventDefault();
                  if (!seqDrag || seqDrag.fromIdx === i) return;
                  ev.dataTransfer.dropEffect = 'move';
                  const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
                  const before = ev.clientY < rect.top + rect.height / 2;
                  setSeqDrag({ fromIdx: seqDrag.fromIdx, overIdx: i, position: before ? 'before' : 'after' });
                }}
                onDragEnd={() => setSeqDrag(null)}
                onDrop={(ev) => {
                  ev.preventDefault();
                  const drag = seqDrag;
                  setSeqDrag(null);
                  if (!drag || drag.fromIdx === i) return;
                  moveDrop(drag.fromIdx, i, drag.position === 'before');
                }}
                className={`sequence-item relative flex items-center gap-5 border-b border-edge-muted px-5 py-4 last:border-b-0 cursor-grab active:cursor-grabbing ${e.rerun ? 'bg-stage-return-row' : ''} ${seqDrag?.fromIdx === i ? 'opacity-40' : ''}`}
              >
                {seqDrag && seqDrag.fromIdx !== i && seqDrag.overIdx === i && seqDrag.position === 'before' && (
                  <span className="pointer-events-none absolute inset-x-4 top-0 z-20 h-[3px] rounded-full bg-action-link shadow-[0_0_6px_rgba(46,95,163,0.5)]" />
                )}
                {seqDrag && seqDrag.fromIdx !== i && seqDrag.overIdx === i && seqDrag.position === 'after' && (
                  <span className="pointer-events-none absolute inset-x-4 bottom-0 z-20 h-[3px] rounded-full bg-action-link shadow-[0_0_6px_rgba(46,95,163,0.5)]" />
                )}
                <span className="sequence-index w-10 shrink-0 text-sm font-bold tracking-wide text-ink-faint">{String(i + 1).padStart(2, '0')}</span>
                <span className="sequence-time flex w-16 shrink-0 items-center gap-1 text-xs text-ink-muted">
                  <Clock size={11} /> {minutes(i)}
                </span>
                <div className="sequence-images flex shrink-0 gap-1">
                  {ps.map((p) => (p.img ? (
                    <img key={p.id} src={p.img} className="h-14 w-11 rounded-md object-cover" alt={p.name} />
                  ) : (
                    <div key={p.id} className="flex h-14 w-11 items-center justify-center rounded-md bg-gradient-to-br from-surface-subtle to-surface-muted text-[10px] font-semibold text-ink-muted">{(p.id || '').slice(0, 2).toUpperCase() || '无图'}</div>
                  )))}
                </div>
                <div className="sequence-product min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{ps.map((p) => p.name).join(' + ')}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
                    <span>{pids.map((x) => x.toUpperCase()).join(' / ')}</span>
                    <span>· {e.sectionLabel}</span>
                    {roles.map((r) => (
                      <span key={r} className="rounded-md border border-edge-strong px-1.5 py-px text-[10px] tracking-wide text-ink-secondary">{r}款</span>
                    ))}
                  </div>
                  {metaOf(pids)}
                </div>
                {e.seg && (
                  <span className={`sequence-segment shrink-0 rounded-md px-2.5 py-1 text-xs font-medium tracking-wide ${SEG_COLOR[e.seg]}`}>{e.seg}</span>
                )}
                <span className="sequence-actions flex shrink-0 items-center gap-1">
                  <button onClick={() => move(i, i - 1)} disabled={i === 0} className="rounded-md p-1 text-ink-faint hover:text-ink-primary disabled:opacity-30" title="上移"><ArrowUp size={13} /></button>
                  <button onClick={() => move(i, i + 1)} disabled={i === entries.length - 1} className="rounded-md p-1 text-ink-faint hover:text-ink-primary disabled:opacity-30" title="下移"><ArrowDown size={13} /></button>
                  {!e.rerun && (
                    <button
                      onClick={() => { editEntries([...entries, { ...e, key: e.key + `#返场${Date.now()}`, seg: '返场', rerun: true }]); toast.success('已追加到返场段（未保存）'); }}
                      className="rounded-md border border-edge-strong px-2 py-0.5 text-xs text-ink-secondary hover:border-edge"
                    >
                      返场
                    </button>
                  )}
                  <button
                    onClick={() => editEntries(entries.filter((_, j) => j !== i))}
                    className="rounded-md p-1 text-ink-faint hover:text-stage-return-fg"
                    title="从排品中移除"
                  >
                    <Trash2 size={13} />
                  </button>
                </span>
              </div>
            );
          })}
          {entries.length === 0 && (
            <div className="py-20 text-center text-sm text-ink-muted">该货盘还没有坑位 —— 先去货盘或选款看板加款</div>
          )}
        </div>
      )}

      {/* 线轴视图：横向时间线 */}
      {displayMode === 'timeline' && (
        <div className="mt-8 overflow-x-auto border border-edge">
          <div className="min-w-fit">
            {/* 时间标尺 */}
            <div className="flex border-b border-edge bg-surface-subtle">
              {entries.map((e, i) => (
                <div key={`tk-${e.key}-${i}`} className="flex w-48 shrink-0 flex-col border-r border-edge-muted px-2 py-1.5">
                  <span className="text-[11px] font-bold text-ink-primary">{minutes(i)}</span>
                  <span className="text-[10px] text-ink-muted">坑位 {i + 1}</span>
                </div>
              ))}
            </div>
            {/* 卡片行 */}
            <div className="flex">
              {entries.map((e, i) => {
                const look = findLook(tray, e.lookId);
                const pids = look?.pids || lookPids(tray, e.lookId);
                if (!pids.length) return null;
                const ps: Product[] = pids.map(byId);
                const userImg = look?.userImg;
                const dragFromHere = seqDrag?.fromIdx === i;
                const showBeforeLine = seqDrag?.overIdx === i && seqDrag.position === 'before' && !dragFromHere;
                const showAfterLine = seqDrag?.overIdx === i && seqDrag.position === 'after' && !dragFromHere;
                return (
                  <div
                    key={`tl-${e.key}-${i}`}
                    className="relative w-48 shrink-0"
                  >
                    {showBeforeLine && (
                      <span className="pointer-events-none absolute -left-px top-3 bottom-3 z-20 w-[3px] rounded-full bg-action-link shadow-[0_0_6px_rgba(46,95,163,0.5)]" />
                    )}
                    <div
                      draggable
                      onDragStart={(ev) => {
                        ev.dataTransfer.setData('text/plain', String(i));
                        ev.dataTransfer.effectAllowed = 'move';
                        setSeqDrag({ fromIdx: i, overIdx: i, position: 'before' });
                      }}
                      onDragEnter={(ev) => {
                        ev.preventDefault();
                        if (!seqDrag || seqDrag.fromIdx === i) return;
                        const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
                        const before = ev.clientX < rect.left + rect.width / 2;
                        setSeqDrag({ fromIdx: seqDrag.fromIdx, overIdx: i, position: before ? 'before' : 'after' });
                      }}
                      onDragOver={(ev) => {
                        ev.preventDefault();
                        if (!seqDrag || seqDrag.fromIdx === i) return;
                        ev.dataTransfer.dropEffect = 'move';
                        const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
                        const before = ev.clientX < rect.left + rect.width / 2;
                        setSeqDrag({ fromIdx: seqDrag.fromIdx, overIdx: i, position: before ? 'before' : 'after' });
                      }}
                      onDragEnd={() => setSeqDrag(null)}
                      onDrop={(ev) => {
                        ev.preventDefault();
                        const drag = seqDrag;
                        setSeqDrag(null);
                        if (!drag || drag.fromIdx === i) return;
                        moveDrop(drag.fromIdx, i, drag.position === 'before');
                      }}
                      className={`m-1 cursor-grab border border-edge-muted p-2 active:cursor-grabbing ${dragFromHere ? 'opacity-40 border-action-link' : ''} ${e.rerun ? 'bg-stage-return-row' : ''}`}
                    >
                      <div className="flex gap-1">
                        {ps.slice(0, 1).map((p) => (
                          <SeqImg key={p.id} src={userImg ?? p.img} alt={p.name} pid={p.id} className="h-32 w-24 rounded object-cover" />
                        ))}
                      </div>
                      <div className="mt-2 truncate text-[11.5px] font-semibold">{ps.map((p) => p.name).join('+')}</div>
                      <div className="mt-1 text-[12px] font-bold text-stage-connect-fg">
                        {ps[0] ? `¥${ps[0].price || '—'}${tray.priceSuffixOverrides?.[ps[0].id] ? ` ${tray.priceSuffixOverrides[ps[0].id]}` : ''}` : '—'}
                      </div>
                      <div className="text-[10.5px] text-ink-muted">
                        现货 {ps.reduce((s, p) => s + (p.stockMain || 0), 0)}
                        {ps.some((p) => p.inTransit > 0) && <> · 在途 {ps.reduce((s, p) => s + (p.inTransit || 0), 0)}</>}
                      </div>
                      {e.seg && (
                        <div className={`mt-1 inline-block rounded px-1.5 py-0.5 text-[10px] ${SEG_COLOR[e.seg]}`}>{e.seg}</div>
                      )}
                      <div className="mt-2 flex items-center gap-0.5 print:hidden">
                        <button onClick={() => move(i, i - 1)} className="rounded p-0.5 text-ink-faint hover:text-ink-primary" title="上移"><ArrowUp size={11} /></button>
                        <button onClick={() => move(i, i + 1)} className="rounded p-0.5 text-ink-faint hover:text-ink-primary" title="下移"><ArrowDown size={11} /></button>
                        {!e.rerun && (
                          <button
                            onClick={() => { editEntries([...entries, { ...e, key: e.key + `#返场${Date.now()}`, seg: '返场', rerun: true }]); toast.success('已追加到返场段（未保存）'); }}
                            className="rounded border border-edge-strong px-1.5 py-px text-[10px] text-ink-secondary hover:border-edge"
                            title="追加一个返场副本到末尾"
                          >
                            返场
                          </button>
                        )}
                        <button onClick={() => editEntries(entries.filter((_, j) => j !== i))} className="rounded p-0.5 text-ink-faint hover:text-stage-return-fg" title="移除"><Trash2 size={11} /></button>
                      </div>
                    </div>
                    {showAfterLine && (
                      <span className="pointer-events-none absolute -right-px top-3 bottom-3 z-20 w-[3px] rounded-full bg-action-link shadow-[0_0_6px_rgba(46,95,163,0.5)]" />
                    )}
                  </div>
                );
              })}
              {entries.length === 0 && (
                <div className="px-6 py-20 text-center text-sm text-ink-muted">该货盘还没有坑位 —— 先去货盘或选款看板加款</div>
              )}
            </div>
          </div>
        </div>
      )}

      {tray && (
        <PrintSettingsDialog
          open={printDialogOpen}
          onOpenChange={setPrintDialogOpen}
          title={`直播排品打印设置 - ${tray.name}`}
          showHideBackupOption={false}
        />
      )}
    </div>
  );
}
