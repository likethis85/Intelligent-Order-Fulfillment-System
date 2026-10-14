import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import {
  ArrowLeft, ArrowRight, Plus, Eye, EyeOff, ArrowUp, ArrowDown, Pencil, Trash2, X, Check,
  Download, RefreshCw, Search, Sparkles, Bot, Send, MoreHorizontal, Archive, FileText,
  Camera, History, CircleAlert,
} from 'lucide-react';
import { toast } from 'sonner';
import * as XLSX from 'xlsx-js-style';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import {
  TRAY_TYPES, goodsValue, matchCandidates,
  type NoRestockItem, type Product, type RoleTag, type Tray, type TrayType,
} from '@/data/products';
import { useProducts, useProductsById, useProductResolver } from '@/data/ProductsContext';
import { fetchSamplesByCodes, fetchSalesSummary, uploadImage, fetchRemainingInventory, fetchHengjiStatus, fetchSampleMaterials, fetchRestockStock, type HengjiStatus, type RemainingGroup, type SampleMaterialRow, type RestockStockFabric } from '@/data/api';
import { formatTimestamp } from '@/lib/utils';
import { fetchTrayLog, type TrayOpLogEntry } from '@/lib/traySync';
import { API_BASE, API_ORIGIN, authenticatedFetch } from '@/lib/api-client';

// 款号注脚内联编辑：款号本身不动，款号后面追加一段文案（如 "黑色" / "黑色/咖色"）
// 用法和 PriceEditor 一致：Enter / Cmd+Enter / blur 保存，Esc 还原
function CodeSuffixEditor({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const trimmed = draft.trim();
          if (trimmed !== value) onSave(trimmed);
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || ((e.metaKey || e.ctrlKey) && e.key === 'Enter')) {
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === 'Escape') { setDraft(value); setEditing(false); }
        }}
        placeholder="+ 注脚"
        className="text-[11px] leading-4 text-ink-secondary bg-transparent text-left border-0 outline-none px-1 w-[88px]"
      />
    );
  }

  return (
    <span
      onClick={() => setEditing(true)}
      className={`select-none text-[11px] leading-4 ${value ? 'text-ink-secondary' : 'text-ink-faint'} cursor-text rounded-sm px-1 hover:bg-surface-subtle ${
        value ? '' : 'opacity-0 group-hover:opacity-100 transition-opacity'
      }`}
      title={value ? `注脚：${value}（点击修改）` : '点击添加注脚（如颜色说明）'}
    >
      {value || '+ 注脚'}
    </span>
  );
}

// 颜色行内联编辑：整行一起改（per-look override）
// 用法同 CodeSuffixEditor：Enter / Cmd+Enter / blur 保存，Esc 还原
// 覆盖态右上 X 一键清除（回退到 pid.colors union）
function ColorLineEditor({ value, defaultText, onSave, onClear }: {
  value: string; defaultText: string; onSave: (v: string) => void; onClear: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);
  const overridden = value !== '' && value !== defaultText;
  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const trimmed = draft.trim();
          if (trimmed !== value) onSave(trimmed);
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || ((e.metaKey || e.ctrlKey) && e.key === 'Enter')) {
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === 'Escape') { setDraft(value); setEditing(false); }
        }}
        className="text-[11.5px] leading-4 text-ink-secondary bg-transparent text-center border-0 outline-none w-full px-1"
        placeholder="颜色文案"
      />
    );
  }
  return (
    <span
      onClick={() => setEditing(true)}
      className={`select-none cursor-text rounded-sm px-1 hover:bg-surface-subtle ${overridden ? 'text-stage-return-fg' : 'text-ink-secondary'}`}
      title={overridden ? `已覆盖：${value}（点击修改，× 还原）` : '点击修改颜色文案'}
    >
      {value || '+ 颜色'}
      {overridden && (
        <button
          onClick={(e) => { e.stopPropagation(); onClear(); }}
          className="ml-1 text-ink-faint hover:text-stage-return-fg"
          title="还原到 pid.colors 自动拼接"
        >×</button>
      )}
    </span>
  );
}

// 样衣 SKC 物料面板：嵌入翻单面板（RestockPicker）顶部，按 smCode 分组列出 SKC + 面料/里料/供应商
// 数据源：/api/samples/materials?codes=...（后端带 1h 缓存）
// 显示策略：列出领猫 BOM 的全部 SKC（包括未转大货的样衣色如驼色），方便翻单时统一规划
function SampleMaterialsPanel({
  pids,
}: {
  pids: string[];
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<SampleMaterialRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!pids || pids.length === 0) {
      setRows([]); setLoading(false); setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    fetchSampleMaterials(pids)
      .then((r) => { if (!cancelled) setRows(r.items || []); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [pids.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!pids || pids.length === 0) return null;
  // 不再按「products.colors」过滤驼色等未转大货 SKC：用户在货盘面板里需要看到所有 BOM SKC
  // 才能完整规划翻单（驼色虽然没转大货，但 BOM 里有面料数据，应该能选、能填翻单计划）
  const filteredRows = rows;
  // 按 smCode 分组
  const byCode = new Map<string, SampleMaterialRow[]>();
  for (const r of filteredRows) {
    if (!byCode.has(r.smCode)) byCode.set(r.smCode, []);
    byCode.get(r.smCode)!.push(r);
  }
  const skcCount = filteredRows.length;
  const codeCount = byCode.size;
  return (
    <div className="border-b border-edge bg-surface-subtle">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-5 py-2 text-left hover:bg-surface-card"
        title={open ? '折叠样衣 SKC 物料' : '展开样衣 SKC 物料（面料/里料/供应商）'}
      >
        <span className="text-[12px] font-semibold text-ink-primary">
          样衣 SKC 物料
          {!loading && (skcCount > 0 || error) && (
            <span className="ml-2 text-[11px] font-normal text-ink-muted">
              {error ? `查询失败：${error}` : `${codeCount} 款号 · ${skcCount} 个 SKC`}
            </span>
          )}
          {loading && <span className="ml-2 text-[11px] font-normal text-ink-muted">查询中…</span>}
        </span>
        <span className="text-[11px] text-ink-muted">{open ? '▲ 收起' : '▼ 展开'}</span>
      </button>
      {open && (
        <div className="max-h-[260px] overflow-auto px-5 pb-3">
          {loading && <div className="py-3 text-center text-[11.5px] text-ink-muted">加载中…</div>}
          {error && !loading && (
            <div className="py-3 text-center text-[11.5px] text-stage-return-fg">查询失败：{error}</div>
          )}
          {!loading && !error && skcCount === 0 && (
            <div className="py-3 text-center text-[11.5px] text-ink-muted">
              这 {pids.length} 个款号在领猫样衣 BOM 里没有面料/里料记录
              <br />
              <span className="text-ink-faint">fabric_Q 面料表里的翻单最大单量，请看下面「面料信息已更新」面板</span>
            </div>
          )}
          {!loading && !error && skcCount > 0 && (
            <div className="space-y-3">
              {[...byCode.entries()].map(([code, items]) => (
                <div key={code} className="rounded border border-edge bg-surface-card p-2.5">
                  <div className="text-[11.5px] font-semibold text-ink-primary">{code}</div>
                  <div className="mt-1 space-y-1">
                    {items.map((r) => (
                      <div key={`${r.smCode}-${r.skc}`} className="flex items-baseline gap-3 text-[11px] text-ink-secondary">
                        <span className="w-[120px] font-mono text-ink-primary">{r.skc}</span>
                        <span className="w-[80px] truncate" title={r.colorName}>{r.colorName}</span>
                        <span className="flex-1 truncate" title={`面料：${r.fabricMt}${r.liningMt ? `｜里料：${r.liningMt}` : ''}`}>
                          {r.fabricMt && <span>面料：{r.fabricMt}</span>}
                          {r.fabricMt && r.liningMt && <span className="mx-1 text-ink-faint">｜</span>}
                          {r.liningMt && <span>里料：{r.liningMt}</span>}
                        </span>
                        <span className="w-[110px] truncate text-ink-muted" title={r.supplierShort}>{r.supplierShort}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// 翻单最大单量面板：拉 fabric_Q 面料表，按 (mtCode+mtSpecName) 聚合米数，算 maxPcs = floor(M / 用量 / 1.05)
// 「同一卷面料一视同仁」：在仓+在途+工厂现货+可订货 全加进 M，不区分 PO 物料 / 大货现货
//   同一卷面料被多个 SKC 引用时，按 (mtCode+mtSpecName+warehouse) 取 max 避免累加
// 默认收起（open: false），避免在移动端/小屏弹窗中占据大量垂直空间遮挡下方的翻单表单；
// 顶部提示条保留核心信息（卷数、SKC数），需要对照面料库存/最大单量时可点「▼ 展开」
function RestockStockPanel({ pids }: { pids: string[] }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<RestockStockFabric[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!pids || pids.length === 0) {
      setItems([]); setLoading(false); setError(null);
      return;
    }
    setLoading(true); setError(null);
    fetchRestockStock({ pids })
      .then((r) => { if (!cancelled) setItems(r.items || []); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [pids.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!pids || pids.length === 0) return null;
  const fabCount = items.length;
  const skcSet = new Set();
  for (const f of items) for (const s of f.skcs) skcSet.add(s.skc);
  return (
    <div className="border-b border-orange-300 bg-orange-50">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 sm:px-5 py-2 text-left hover:bg-orange-100"
        title={open ? '折叠最大单量' : '展开最大单量'}
      >
        <span className="flex flex-wrap items-center gap-1.5 text-[12px] font-semibold text-orange-900">
          <CircleAlert size={13} className="text-orange-600 flex-shrink-0" />
          <span>面料信息已更新（在仓/在途/工厂现货/可订货 已重算最大单量）</span>
          {!loading && (fabCount > 0 || error) && (
            <span className="text-[11px] font-normal text-orange-700 whitespace-nowrap">
              {error ? `查询失败：${error}` : `${fabCount} 卷面料 · ${skcSet.size} 个 SKC`}
            </span>
          )}
          {loading && <span className="text-[11px] font-normal text-orange-700">查询中…</span>}
        </span>
        <span className="text-[11px] text-orange-700 whitespace-nowrap flex-shrink-0">{open ? '▲ 收起' : '▼ 展开'}</span>
      </button>
      {open && (
        <div className="max-h-[220px] overflow-auto bg-surface-card px-5 pb-3">
          {loading && <div className="py-3 text-center text-[11.5px] text-ink-muted">加载中…</div>}
          {error && !loading && (
            <div className="py-3 text-center text-[11.5px] text-stage-return-fg">查询失败：{error}</div>
          )}
          {!loading && !error && fabCount === 0 && (
            <div className="py-3 text-center text-[11.5px] text-ink-muted">
              这 {pids.length} 个款号在 fabric_Q 面料表里没有记录
            </div>
          )}
          {!loading && !error && fabCount > 0 && (
            <div className="space-y-2 pt-2">
              {items.map((f) => (
                <div key={`${f.mtCode}-${f.mtSpecName || ''}`} className="rounded border border-edge p-2">
                  <div className="flex items-baseline justify-between text-[11.5px]">
                    <div className="font-semibold text-ink-primary">
                      {f.mtName || f.mtCode} {f.mtSpecName && <span className="font-mono text-ink-muted">{f.mtSpecName}</span>}
                    </div>
                    <div className="text-ink-secondary">合计 <span className="font-bold text-ink-primary">{f.M.toFixed(0)}</span> 米</div>
                  </div>
                  {f.supplierName && <div className="mt-0.5 text-[10.5px] text-ink-muted">供应商：{f.supplierName}</div>}
                  <div className="mt-1.5 grid grid-cols-1 gap-0.5">
                    {f.skcs.map((s) => (
                      <div key={s.skc} className="flex items-baseline gap-3 text-[11px] text-ink-secondary">
                        <span className="w-[110px] font-mono text-ink-primary">{s.skc}</span>
                        <span className="w-[80px] text-ink-muted">用量 {s.useAmt}</span>
                        <span className="flex-1 truncate text-ink-muted" title={`面料仓 ${s.stockAt.toFixed(0)}米 ｜ 工厂现货 ${s.factorySpot.toFixed(0)}米 ｜ 在途 ${s.inTransit}米 ｜ 可订货 ${s.orderable}米`}>
                          面料仓 {s.stockAt.toFixed(0)} · 工厂现货 {s.factorySpot.toFixed(0)} · 在途 {s.inTransit} · 可订货 {s.orderable}
                        </span>
                        <span className="font-bold text-stage-peak-fg">最大 {s.maxPcs}件</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// 售价 / 马总价 单元格内联编辑：点文字变 input，Enter/blur 保存，Esc 还原
// 覆盖态用 stage-return-fg（橙红）小环标记，右上 X 一键清除（回退到 BI / 领猫价）
function PriceEditor({
  value, isOverridden, onSave, onClear, placeholder, kind,
}: {
  value: string;
  isOverridden: boolean;
  onSave: (v: string) => void;
  onClear: () => void;
  placeholder?: string;
  kind: 'price' | 'mprice';
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);

  const isMprice = kind === 'mprice';
  const cls = isMprice
    ? 'text-[10.5px] leading-4 text-action-danger-fg'
    : 'text-[13px] font-bold leading-4 text-action-danger-fg';
  const ph = placeholder ?? (isMprice ? '马总价' : '待定价');
  // 无边框：input 融进行里，仅靠背景色 + 居中文字 + placeholder 视觉标记；Enter / blur 保存
  const inputCls = `${cls} w-full bg-transparent text-center border-0 outline-none px-1`;

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const trimmed = draft.trim();
          // draft === value 视为不变，不触发 setState 噪音
          if (trimmed !== value) onSave(trimmed);
          setEditing(false);
        }}
        onKeyDown={(e) => {
          // 保存：Enter 触发；Cmd/Ctrl + Enter 兜底（中文输入法下 Enter 会被拦截去确认候选字）
          if (e.key === 'Enter' || ((e.metaKey || e.ctrlKey) && e.key === 'Enter')) {
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === 'Escape') { setDraft(value); setEditing(false); }
        }}
        placeholder={ph}
        className={inputCls}
      />
    );
  }

  return (
    <div className="flex items-center justify-center gap-1">
      <span
        onClick={() => setEditing(true)}
        className={`${cls} cursor-text rounded-sm px-1 hover:bg-surface-subtle`}
        title={isOverridden ? '已手动编辑（点击修改，点 × 清除）' : '点击编辑'}
      >
        {value || <span className="text-ink-faint">{ph}</span>}
      </span>
      {isOverridden && (
        <button
          onClick={(e) => { e.stopPropagation(); onClear(); }}
          className="text-ink-faint hover:text-stage-return-fg"
          title="清除手动编辑（恢复为 BI / 领猫价）"
        >
          <X size={10} />
        </button>
      )}
    </div>
  );
}

// 图片加载失败兜底：样衣款 / 缺图款 fallback 显示款号首字母占位（避免浏览器默认破图小图标）
function SafeImg({ src, alt, className, fallbackText, pid, onClick }: { src: string; alt?: string; className?: string; fallbackText?: string; pid?: string; onClick?: () => void }) {
  const [errored, setErrored] = useState(false);
  if (!src || errored) {
    // 占位字符：优先用款号首字母（如 ME13FW006 → ME），回退到 alt，最后回退到「无图」
    const placeholder = (pid || alt || '').slice(0, 2).toUpperCase() || fallbackText || '无图';
    return (
      <div
        onClick={onClick}
        className={`${className ?? ''} flex items-center justify-center bg-gradient-to-br from-surface-subtle to-surface-muted text-[10px] font-semibold tracking-wide text-ink-muted`}
        title={pid ? `无图：${pid}` : '无图'}
      >
        {placeholder}
      </div>
    );
  }
  return <img src={src} alt={alt ?? ''} className={className} onError={() => setErrored(true)} onClick={onClick} />;
}

// BOM 成本内联编辑：跟 PriceEditor 完全一致的点文字变 input 模式
// 区别：黑色非加粗（小一号文字，让售价 / 倍率仍是视觉重点）
// 通过 ref 暴露 startEdit()，让外层「整行可点」能触发编辑
const CostEditor = forwardRef<
  { startEdit: () => void },
  {
    value: string;
    isOverridden: boolean;
    onSave: (v: string) => void;
    onClear: () => void;
    placeholder?: string;
    kind: 'cost' | 'mcost';
  }
>(function CostEditor({ value, isOverridden, onSave, onClear, placeholder, kind }, ref) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);

  const isMcost = kind === 'mcost';
  const cls = isMcost
    ? 'text-[11px] leading-4 text-ink-primary'
    : 'text-[12px] leading-4 text-ink-primary';
  const ph = placeholder ?? (isMcost ? '马总成本' : '待录成本');

  // 暴露 startEdit 给整行可点的 wrapper
  useImperativeHandle(ref, () => ({ startEdit: () => setEditing(true) }), []);

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const trimmed = draft.trim();
          if (trimmed !== value) onSave(trimmed);
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || ((e.metaKey || e.ctrlKey) && e.key === 'Enter')) {
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === 'Escape') { setDraft(value); setEditing(false); }
        }}
        placeholder={ph}
        className={`${cls} w-full min-w-[60px] bg-transparent text-center border-0 outline-none px-1`}
      />
    );
  }

  return (
    <div className="flex items-center justify-center gap-0.5">
      <span
        onClick={() => setEditing(true)}
        className={`${cls} cursor-text rounded-sm hover:bg-surface-subtle text-center px-1`}
        title={isOverridden ? '已手动编辑（点击修改，点 × 清除）' : '点击录入 BOM 成本'}
      >
        {value || <span className="text-ink-faint">{ph}</span>}
      </span>
      {isOverridden && (
        <button
          onClick={(e) => { e.stopPropagation(); onClear(); }}
          className="text-ink-faint hover:text-stage-return-fg"
          title="清除手动编辑（恢复为 BI bom商品成本）"
        >
          <X size={10} />
        </button>
      )}
    </div>
  );
});

// 整行可点的「cost/ratio」编辑器：
// - 成本在前面（左），倍率在后面（右），整体在 cell 内居中
// - 点 row 任意位置（cost 数字 / "/" / ratio）都触发编辑
// - 编辑态：cost 变 input，text-center 对齐
function CostRatioRow({
  text, isOverridden, ratio, ratioClass, placeholder, onSave, onClear,
}: {
  text: string;
  isOverridden: boolean;
  ratio: string;
  ratioClass: string;
  placeholder: string;
  onSave: (v: string) => void;
  onClear: () => void;
}) {
  const ref = useRef<{ startEdit: () => void }>(null);
  return (
    <div
      onClick={(e) => {
        // 避免点击 × 按钮时触发整行编辑
        const target = e.target as HTMLElement;
        if (target.closest('button')) return;
        ref.current?.startEdit();
      }}
      className="group flex cursor-text items-center justify-center gap-0.5 rounded-sm hover:bg-surface-subtle"
    >
      <CostEditor
        ref={ref}
        value={text}
        isOverridden={isOverridden}
        placeholder={placeholder}
        kind="cost"
        onSave={onSave}
        onClear={onClear}
      />
      <span className="text-ink-faint">/</span>
      <span className={ratioClass}>{ratio}</span>
    </div>
  );
}

// 解析 stock 字符串行：抽出「颜色 + 现货 + 在途 + 交期 + 占单」
// 兼容 BI 新格式 "深灰千鸟：现货40 在途179 占单320" / BI 旧 "深灰千鸟：40米·在途179" / mock "白占单180在途100"
type StockEntry = { color: string; qty: number; eta: string | null; stock: number; inTransit: number; orderBook: number };
function parseStockLine(line: string, productColors: string[]): StockEntry {
  const sorted = [...productColors].sort((a, b) => b.length - a.length);
  const color = sorted.find((c) => line.includes(c)) || '';
  // 现货 X（关键字「现货」或 X米）
  const stockKwd = line.match(/现货\s*(\d+(?:\.\d+)?)/);
  const stockMi = line.match(/(\d+(?:\.\d+)?)\s*米/);
  const stock = stockKwd ? Number(stockKwd[1]) : stockMi ? Number(stockMi[1]) : 0;
  // 在途 X
  const inTransitMatch = line.match(/在途\s*(\d+(?:\.\d+)?)/);
  const inTransit = inTransitMatch ? Number(inTransitMatch[1]) : 0;
  // 占单 X
  const orderMatch = line.match(/占单\s*(\d+(?:\.\d+)?)/);
  const orderBook = orderMatch ? Number(orderMatch[1]) : 0;
  // 交期日期
  const etaMatch = line.match(/(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/);
  const eta = etaMatch ? etaMatch[1] : null;
  // 兼容字段：第一数字（旧渲染兜底用）
  const numMatch = line.match(/(\d+(?:\.\d+)?)/);
  const qty = numMatch ? Number(numMatch[1]) : 0;
  return { color, qty, eta, stock, inTransit, orderBook };
}

const TYPE_COLOR: Record<string, string> = {
  // Marius（马总）= 自有品牌主盘，用品牌红突出，区别于其它彩色类型徽标
  马总直播货盘: 'bg-stage-return-fg text-white font-semibold',
  店播直播货盘: 'bg-tray-store text-white',
  IP直播货盘: 'bg-tray-ip text-white',
  达人货盘: 'bg-tray-talent text-white',
  渠道货盘: 'bg-tray-channel text-white',
};

// ── 面料悬停快速预览 ──
// 鼠标移到「面料情况」单元格上 350ms 后，自动拿这个坑位里所有 pid 去 fabric_Q 查，
// 弹出小卡片按款号展示面料明细（不阻塞用户，可继续浏览其它坑位）
interface FabricQuickTooltipProps {
  rect: DOMRect | null;
  codes: string[];
  data: any[] | null;
  loading: boolean;
  error: string | null;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onOpenFullPicker: () => void;
}
function FabricQuickTooltip({ rect, codes, data, loading, error, onMouseEnter, onMouseLeave, onOpenFullPicker }: FabricQuickTooltipProps) {
  if (!rect) return null;
  // 卡片 360px 宽，贴在锚点下方 6px；左边界避免超出视口右沿
  const W = 360;
  const left = Math.min(Math.max(8, rect.left), (typeof window !== 'undefined' ? window.innerWidth : 1024) - W - 8);
  const top = rect.bottom + 6;
  // 按 pdtCode 分组：每个款号下显示它的所有面料行
  const grouped = new Map<string, any[]>();
  for (const r of (data || [])) {
    const k = String(r.pdtCode || '').toUpperCase();
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k)!.push(r);
  }
  return (
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{ position: 'fixed', left, top, width: W, zIndex: 60 }}
      className="rounded-md border border-edge bg-surface-card shadow-2xl print:hidden"
    >
      <div className="flex items-center justify-between border-b border-edge px-3 py-2">
        <div className="text-[11px] font-semibold tracking-wide text-ink-secondary">面料快查 · {codes.length} 个款号</div>
        <div className="flex items-center gap-2">
          <button
            onClick={onOpenFullPicker}
            className="rounded px-1.5 py-0.5 text-[11px] text-action-link hover:bg-surface-subtle"
          >
            打开完整 →
          </button>
        </div>
      </div>
      <div className="max-h-[420px] overflow-y-auto px-3 py-2 text-[11.5px] leading-5">
        {loading && (
          <div className="flex items-center gap-2 py-6 justify-center text-ink-muted">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-edge border-t-action-link" />
            <span>查询中…</span>
          </div>
        )}
        {!loading && error && (
          <div className="py-4 text-center text-action-danger-fg">查询失败：{error}</div>
        )}
        {!loading && !error && data && data.length === 0 && (
          <div className="py-6 text-center text-ink-muted">这 {codes.length} 个款号查无面料</div>
        )}
        {!loading && !error && data && data.length > 0 && (
          <div className="space-y-3">
            {[...grouped.entries()].map(([code, rows]) => (
              <div key={code} className="border-b border-edge-muted pb-2 last:border-b-0 last:pb-0">
                <div className="mb-1 font-mono font-semibold tracking-wide text-ink-primary">{code}</div>
                {rows.slice(0, 4).map((r, i) => (
                  <div key={i} className="grid grid-cols-[1fr_auto] gap-x-2 gap-y-0.5 text-ink-secondary">
                    <span className="truncate">
                      <span className="text-ink-primary">{r.mtName || '—'}</span>
                      <span className="ml-1 text-ink-muted">· {r.mtSpecName || '—'}</span>
                    </span>
                    <span className="text-right tabular-nums text-ink-muted">
                      {Number(r.useAmt) > 0 && <span className="mr-2">用 {r.useAmt}m</span>}
                      {r.warehouse && r.warehouse !== '-' && <span>{r.warehouse}</span>}
                    </span>
                    <span className="col-span-2 text-[10.5px] text-ink-muted">
                      库存 {r.stock ?? 0}m
                      {Number(r.canProduce) > 0 && <> · 可产 <span className="text-ink-secondary">{r.canProduce}</span> 件</>}
                      {Number(r.mtPrice) > 0 && <> · 单价 ¥{r.mtPrice}/m</>}
                      {r.mtCategory && <> · {r.mtCategory}</>}
                    </span>
                  </div>
                ))}
                {rows.length > 4 && (
                  <div className="mt-1 text-[10.5px] text-ink-muted">还有 {rows.length - 4} 条…</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// 倍率：售价 / 成本，显示 1 位小数；任一缺失返回空串
function ratioOf(price: string | number | undefined, cost: string | number | undefined): string {
  const p = Number(price ?? '');
  const c = Number(cost ?? '');
  if (!Number.isFinite(p) || !Number.isFinite(c) || c <= 0) return '';
  return (p / c).toFixed(1);
}

// 成本显示取整数（BI 源数据 159.6 / 142.13 等小数 → 显示 160 / 142）；编辑保存也用整数
function roundCost(raw: string | number | undefined): string {
  const n = Number(raw ?? '');
  if (!Number.isFinite(n)) return '';
  return String(Math.round(n));
}

// 把 "1599" / "999/1199" / "1599.5" 解析成首个有效正数；解析不到返回 0
function parsePriceNumber(raw: string | undefined | null): number {
  if (raw == null) return 0;
  const first = String(raw).split(/[\/，]/)[0].trim();
  const n = Number(first);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// 售价：手动 override 优先；否则走 BI priceNum / price 字符串
function effectivePrice(override: string | undefined, p: Product): number {
  if (override !== undefined && override !== '') return parsePriceNumber(override);
  if (p.priceNum && p.priceNum > 0) return p.priceNum;
  return parsePriceNumber(p.price);
}

// 马总价：手动 override 优先；否则走 BI mprice
function effectiveMprice(override: string | undefined, p: Product): number {
  if (override !== undefined && override !== '') return parsePriceNumber(override);
  return parsePriceNumber(p.mprice);
}

// BI 面料里只写了「羊毛/棉」这类材质词，没有仓库/色卡/米数等实质信息，对排货没帮助
// 这种短串里只渲染属性（material），product.material 已经承担展示，所以直接隐藏
const FABRIC_MATERIAL_NOISE = new Set([
  '羊毛', '棉', '醋酸', '真丝', '亚麻', '涤纶', '锦纶', '粘纤', '小香', '羊绒', '羊驼', '其他', '面料_其他',
]);
function isFabricNoise(text: string | undefined | null): boolean {
  if (!text) return true;
  const trimmed = text.trim();
  if (!trimmed) return true;
  // 只含材质词（可能带「/」拼接）也视为噪音
  const parts = trimmed.split(/[\/,，\s]+/).filter(Boolean);
  if (parts.length > 0 && parts.every((s) => FABRIC_MATERIAL_NOISE.has(s))) return true;
  // 长度太短（≤2）也按噪音处理
  if (trimmed.length <= 2) return true;
  return false;
}

// 面料文案清洗：上游仓库名 / 颜色字段偶尔会带进来孤立或成对的括号，
// 直接拼进「颜色N米仓库」文案后，每行末尾都会多个右括号。
function cleanFabricText(text: string): string {
  if (!text) return text;
  return text
    .split('\n')
    .map((line) =>
      line
        // 去掉行尾成对括号（如 "200米（面料仓）"），允许括号后有空白
        .replace(/\s*[（(][^）)]*[）)]\s*$/g, '')
        // 去掉行尾孤立右括号（如 "200米面料仓)" / "无面料不翻单）"），允许括号后有空白
        .replace(/[）)]\s*$/g, ''))
    .join('\n');
}

const LOOKS_PER_BAND = 8;

// ── 导出计划翻单量 + 不可翻单清单 ──
// Sheet 1「计划翻单量」按批次展开一行：与钉钉表 1:1 对齐
// - 只导出 fabric_Q 实际填过的批次（tray.plannedRestockItems + sampleRestockItems）；
//   BI「翻单量」兜底不导出——那是计划池数字、没有周期，混进表会被当成已确认翻单
// - 翻单周期：批次的 days（fabric_Q 填的 N 天之内）
// - 直播日期：Tray.date
// - 登记时间：Tray.updatedAt ?? Tray.createdAt
function exportRestockExcel(
  t: Tray,
  byId: (pid: string) => Product, // Sheet 2 不可翻单的面料判定用
) {
  console.log('[exportRestockExcel] tray=', t.id, 'plannedRestockItems=', (t.plannedRestockItems || []).length);
  const wb = XLSX.utils.book_new();

  // 同一 pid 出现在多个坑位时只导出一次（避免批次被坑位放大成 N 行）
  // 同时给后端写入数据库（supabase rest_orders_planned / no_restock / sku_details）去重
  const emittedPids = new Set<string>();

  // Sheet 1: 计划翻单量（每批次一行，与钉钉一致）
  const restockRows: (string | number)[][] = [['款号', 'SKC', '计划翻单量', '翻单周期', '直播日期', '颜色', '登记时间']];
  const liveDate = t.date || '';
  const registeredAt = formatTimestamp(t.updatedAt || t.createdAt);

  // 把 tray.plannedRestockItems 按 pid 分组（样衣阶段翻单 sampleRestockItems 一并导出，颜色列会带驼色等）
  const itemsByPid: Record<string, Array<{ pdt: string; skc: string; color?: string; pieces: number; days: number }>> = {};
  for (const it of [...(t.plannedRestockItems || []), ...(t.sampleRestockItems || [])]) {
    if (!itemsByPid[it.pdt]) itemsByPid[it.pdt] = [];
    itemsByPid[it.pdt].push(it);
  }

  t.sections.forEach((s) =>
    s.looks.forEach((l) =>
      l.pids.forEach((pid) => {
        const items = (itemsByPid[pid] || []).filter(
          (it) => Number(it.pieces) > 0 || Number(it.days) > 0,
        );
        if (items.length > 0) {
          // sales.html 同步过来的每批次 1 行（与钉钉 1:1 对齐）
          // 同一 pid 出现在多个坑位时只输出一次——避免批次被坑位放大重复
          if (emittedPids.has(pid)) return;
          emittedPids.add(pid);
          // 治本：按 (skc, pieces, days) 去重——旧 tray 里多次同步累积的同批次会在这里被丢掉
          const seenBatches = new Set<string>();
          items.forEach((it) => {
            const bk = `${String(it.skc).toLowerCase()}|${Number(it.pieces) || 0}|${Number(it.days) || 0}`;
            if (seenBatches.has(bk)) return;
            seenBatches.add(bk);
            restockRows.push([
              pid.toUpperCase(),
              String(it.skc).toUpperCase(),
              it.pieces,
              it.days > 0 ? `${it.days}天之内` : '',
              liveDate,
              it.color || '',
              registeredAt,
            ]);
          });
          return;
        }
      }),
    ),
  );
  const ws1 = XLSX.utils.aoa_to_sheet(restockRows);
  ws1['!cols'] = [{ wch: 12 }, { wch: 16 }, { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 10 }, { wch: 20 }];
  XLSX.utils.book_append_sheet(wb, ws1, '计划翻单量');

  // Sheet 2: 不可翻单（按坑位列出 SKC）—— 同一款号同一 SKC 跨坑位只输一次
  // 用 effectiveNoRestockItems：BOM 补上后残留的「查无此款」占位（skc='-'）不再导出
  const noRestockItems = t.noRestockItems || [];
  const noRestockRows: (string | number)[][] = [['货盘', '版块', '坑位', '款号', 'SKC', '颜色', '面料']];
  const emittedSkus = new Set<string>();
  t.sections.forEach((s) =>
    s.looks.forEach((l, li) =>
      l.pids.forEach((pid) => {
        const p = byId(pid);
        const allItems = noRestockItems.filter((it) => it.pid.toLowerCase() === pid.toLowerCase());
        const ov0 = t.fabricOverrides?.[pid];
        const hasRealFabric = Boolean((ov0 ?? '').trim() || (!isFabricNoise(p.fabric) && (p.fabric ?? '').trim()));
        effectiveNoRestockItems(allItems, hasRealFabric).forEach((it) => {
          const key = `${it.pid.toLowerCase()} ${it.skc.toLowerCase()}`;
          if (emittedSkus.has(key)) return;
          emittedSkus.add(key);
          noRestockRows.push([t.name, s.label, `坑位${li + 1}`, it.pid.toUpperCase(), it.skc.toUpperCase(), it.color || '', it.fabric || '']);
        });
      }),
    ),
  );
  const ws2 = XLSX.utils.aoa_to_sheet(noRestockRows);
  ws2['!cols'] = [{ wch: 16 }, { wch: 8 }, { wch: 7 }, { wch: 8 }, { wch: 12 }, { wch: 8 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(wb, ws2, '不可翻单');

  XLSX.writeFile(wb, `${t.name}-${t.date}-翻单清单.xlsx`);
  toast.success('已导出翻单清单（计划翻单量 + 不可翻单）');
}

// ── 导出款号维度 Excel ──
// 纯函数：接收 tray + 当前组件里的 byId 查表函数，避免模块级 byId 引用未定义
function exportSkuExcel(t: Tray, byId: (pid: string) => Product) {
  const rows: (string | number)[][] = [['货盘', '版块', '坑位', '款号', '名称', '颜色', '售价', '现货', '在途', '翻单', '计划放量', '已下单放量', '货值']];
  t.sections.forEach((s) =>
    s.looks.forEach((l, li) =>
      l.pids.forEach((pid) => {
        const p = byId(pid);
        rows.push([t.name, s.label, `坑位${li + 1}`, pid.toUpperCase(), p.name, p.colors.join('/'), p.priceNum, p.stockMain, p.inTransit, p.restock ?? '', p.plannedQty, p.orderedQty, goodsValue(p)]);
      }),
    ),
  );
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 16 }, { wch: 8 }, { wch: 7 }, { wch: 8 }, { wch: 26 }, { wch: 12 }, { wch: 8 }, { wch: 7 }, { wch: 7 }, { wch: 9 }, { wch: 9 }, { wch: 11 }, { wch: 11 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '款号明细');
  XLSX.writeFile(wb, `${t.name}-${t.date}-款号明细.xlsx`);
  toast.success('已导出 Excel（款号维度，一行一款）');
}

// ── 导出和货盘布局一模一样的 Excel（行=版块+字段，列=坑位，横排，含图片）──
// 参考钉钉表格 10.7 周三 的版式：
//   版块行：黑底白字 30 号加粗，跨 9 列合并（A:I）
//   字段标签列：A 列，微软雅黑 20 号加粗；主推=黑字，搭配=红字；库存/翻单/面料 标签蓝底 #00B0F0
//   售价行数据：绿底 #92D04F 红字加粗；款号行数据：蓝底 #04B0F1 加粗
//   全部单元格细边框
//   主图行高 230 / 图片 180x224（对齐 HTML 货盘 h-56 w-[180px]）
//   主推版块字段：主图 / 商品名称 / 款号 / 尺码 / 售价 / 成本倍率 / 库存 / 翻单周期 / 面料 / 单耗 / 货值 / [已播完+ 当天销量 / 累计销量]
//   搭配版块字段：主图 / 商品名称 / 款号 / 尺码 / 售价 / 库存 / 货值
import ExcelJS from 'exceljs';

interface TrayById { (pid: string): Product }
interface TraySalesSnap { daily: Record<string, number>; cumulative: Record<string, number> }

const SLOT_DATA_COLS = 8; // 每版块 8 个坑位；总列数 = 1 (标签) + 8 = 9 列 A..I
const IMG_BASE = API_ORIGIN; // 后端 /uploads 静态服务（主机名跟随页面来源，局域网可访问）
const FABRIC_BASE = '/fabric'; // 内置面料与翻单服务（同源免端口）
const THIN_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: 'FF000000' } },
  left: { style: 'thin', color: { argb: 'FF000000' } },
  bottom: { style: 'thin', color: { argb: 'FF000000' } },
  right: { style: 'thin', color: { argb: 'FF000000' } },
};

// 款号 → 主图 URL：优先 look.userImg（自传覆盖），再 cover pid 的 Product.img
// Product.img 已是完整 URL（OSS/淘宝 CDN），不能拼接 /uploads；走 /api/image-proxy 绕开浏览器 CORS
function pidImgUrl(look: { pids: string[]; userImg?: string | null }, byId: TrayById): string | null {
  if (look.userImg) return IMG_BASE + look.userImg;
  const p = byId(look.pids[0]);
  if (!p?.img) return null;
  const raw = String(p.img);
  if (/^https?:\/\//.test(raw)) {
    return `${IMG_BASE}/api/image-proxy?url=${encodeURIComponent(raw)}`;
  }
  // 兜底：相对路径（合成款 / 旧数据）
  return IMG_BASE + (raw.startsWith('/') ? raw : '/uploads/' + raw);
}

// 把远程图拉回来 → 缩到 200px 宽（保持比例）→ 返回 { buffer, ext, w, h }
// 用 wb.addImage 把图作为 floating drawing 写入 xlsx 的 xl/media/ 目录（独立 part，跟 cell 一起打包）
// editAs: 'oneCell'：图锚定到单元格、随单元格移动/复制/筛选
// 为什么不用 =IMAGE() 公式：WPS 的 IMAGE 函数只支持 http/https URL，不支持 data: URL（直接返回 #VALUE! / 空 cell）
const IMG_MAX_WIDTH = 200;
async function fetchImg(url: string): Promise<{ buffer: ArrayBuffer; ext: 'jpeg' | 'png' | 'gif'; w: number; h: number } | null> {
  try {
    const res = await authenticatedFetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    let ext: 'jpeg' | 'png' | 'gif' = 'jpeg';
    if (ct.includes('png')) ext = 'png';
    else if (ct.includes('gif')) ext = 'gif';
    else {
      const b = new Uint8Array(buf);
      if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) ext = 'png';
      else if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) ext = 'gif';
    }
    const blob = new Blob([buf], { type: `image/${ext}` });
    const blobUrl = URL.createObjectURL(blob);
    try {
      const { naturalWidth: w, naturalHeight: h, outBuffer, outExt } = await new Promise<{ naturalWidth: number; naturalHeight: number; outBuffer: ArrayBuffer; outExt: 'jpeg' | 'png' | 'gif' }>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const scale = img.naturalWidth > IMG_MAX_WIDTH ? IMG_MAX_WIDTH / img.naturalWidth : 1;
          const tw = Math.max(1, Math.round(img.naturalWidth * scale));
          const th = Math.max(1, Math.round(img.naturalHeight * scale));
          const canvas = document.createElement('canvas');
          canvas.width = tw; canvas.height = th;
          const ctx = canvas.getContext('2d');
          if (!ctx) return reject(new Error('canvas ctx null'));
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, tw, th);
          ctx.drawImage(img, 0, 0, tw, th);
          // GIF 保留原格式（保留动画），其它统一转 jpeg q=0.82 保留清晰度（addImage 不受 32K 字符限制）
          if (ext === 'gif') {
            canvas.toBlob((b) => {
              if (!b) return reject(new Error('toBlob null'));
              b.arrayBuffer().then((ab) => resolve({ naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, outBuffer: ab, outExt: 'gif' }));
            }, 'image/gif');
          } else {
            canvas.toBlob((b) => {
              if (!b) return reject(new Error('toBlob null'));
              b.arrayBuffer().then((ab) => resolve({ naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, outBuffer: ab, outExt: 'jpeg' }));
            }, 'image/jpeg', 0.82);
          }
        };
        img.onerror = () => reject(new Error('img decode failed'));
        img.src = blobUrl;
      });
      return { buffer: outBuffer, ext: outExt, w, h };
    } finally { URL.revokeObjectURL(blobUrl); }
  } catch { return null; }
}

// 成本/倍率 文本：手动 override > BI bomCost；倍率 = 售价 / 成本，跟 UI 显示口径一致
function costRatioText(pid: string, t: Tray, byId: TrayById): string {
  const p = byId(pid);
  const raw = t.costOverrides?.[pid] !== undefined ? t.costOverrides![pid] : (p.bomCost ?? '');
  const cost = roundCost(raw);
  const price = effectivePrice(t.priceOverrides?.[pid], p);
  const ratio = ratioOf(price, raw);
  if (!cost && !ratio) return '';
  return `${cost || '—'}/${ratio || '—'}`;
}

// 库存情况（主仓）文本：跟 FIELDS.库存情况（主仓）.render 同款
// 领猫款用 p.stock 颜色聚合；BI 独有用 stockMain + inTransit；都没有则 '—'
function stockCellText(p: Product): string {
  const lines = p.stock ?? [];
  if (lines.length === 0) {
    if (!p.biOnly) return '—';
    // 现货 0 不写「现货0」
    const parts: string[] = [];
    if ((p.stockMain ?? 0) > 0) parts.push(`现货${p.stockMain}`);
    if ((p.inTransit ?? 0) > 0) parts.push(`在途${p.inTransit}`);
    return parts.join(' · ') || '—';
  }
  const parsed = lines.map((s) => parseStockLine(s, p.colors ?? []));
  const byColor = new Map<string, { stock: number; inTransit: number; eta: string | null; orderBook: number }>();
  for (const e of parsed) {
    const k = e.color || '其他';
    const cur = byColor.get(k) || { stock: 0, inTransit: 0, eta: null, orderBook: 0 };
    cur.stock = Math.max(cur.stock, e.stock);
    cur.inTransit = Math.max(cur.inTransit, e.inTransit);
    cur.orderBook = Math.max(cur.orderBook, e.orderBook);
    if (e.eta && !cur.eta) cur.eta = e.eta;
    byColor.set(k, cur);
  }
  return [...byColor.entries()].map(([color, v]) => {
    const parts: string[] = [];
    if (v.stock > 0) parts.push(`现货${v.stock}`);
    if (v.inTransit > 0) parts.push(`在途${v.inTransit}`);
    if (v.eta) parts.push(`${v.eta}交`);
    if (v.orderBook > 0) parts.push(`占单${v.orderBook}`);
    return `${color}：${parts.join(' ') || '—'}`;
  }).join('\n') || '—';
}

// 商品名称 单元格：复刻 FIELDS.商品名称.aggregateRender 的 3 行结构
// 行 1 小名(sub) + 行 2 主名(name) + 行 3 颜色(colors) 浅色字
// 用 exceljs richText 支持一格内多段不同样式
function nameCellRichText(ps: Product[], colorOverride?: string, sampleColorsByPid?: Record<string, string[]>): ExcelJS.CellRichTextValue | string {
  if (ps.length === 0) return '';
  const uniqueNames = [...new Set(ps.map((p) => p.name).filter(Boolean))];
  const suitName = uniqueNames.find((n) => n.includes('/'));
  const nameLine = suitName ?? (uniqueNames.length > 1 ? uniqueNames.join(' / ') : uniqueNames[0] ?? '');
  const nameSet = new Set(uniqueNames);
  const subs = [
    ...new Set(
      ps
        .map((p) => p.sub)
        .filter((s) => s && s !== '本' && s.length > 1 && !nameSet.has(s)),
    ),
  ];
  // 颜色与卡片一致：大货颜色 + 样衣阶段颜色（黑巧/驼色等）
  const colorSet = new Set<string>();
  for (const p of ps) for (const c of (p.colors ?? [])) colorSet.add(c);
  for (const p of ps) for (const c of (sampleColorsByPid?.[p.id] ?? [])) colorSet.add(c);
  const defaultColors = [...colorSet].join(' / ');
  const colorText = colorOverride ?? defaultColors;
  const lines: ExcelJS.RichText[] = [];
  if (subs.length > 0) {
    lines.push({ text: subs.join(' / '), font: { name: '微软雅黑', size: 12, bold: true, color: { argb: 'FF1F2937' } } });
  }
  if (nameLine) {
    if (lines.length > 0) lines.push({ text: '\n', font: { name: '微软雅黑', size: 12, bold: true } });
    lines.push({ text: nameLine, font: { name: '微软雅黑', size: 12, bold: true, color: { argb: 'FF1F2937' } } });
  }
  if (colorText) {
    if (lines.length > 0) lines.push({ text: '\n', font: { name: '微软雅黑', size: 12, bold: true } });
    // 覆盖态用橙红字标记，提示这是手工改的
    const isOverridden = colorOverride !== undefined && colorOverride !== defaultColors;
    lines.push({ text: colorText, font: { name: '微软雅黑', size: 11, color: { argb: isOverridden ? 'FFDC2626' : 'FF6B7280' } } });
  }
  if (lines.length === 0) return '';
  return { richText: lines };
}

// 无面料不翻单标记的有效集：优先具体 SKC 标记；
// 只剩「查无此款」占位（skc='-'）且该款已有真实面料文本时，占位作废（BOM 补上后旧占位会残留）。
function effectiveNoRestockItems(allItems: NoRestockItem[], hasRealFabric: boolean): NoRestockItem[] {
  const realItems = allItems.filter((it) => it.skc && it.skc !== '-');
  if (realItems.length > 0) return realItems;
  if (hasRealFabric) return [];
  return allItems;
}

// 面料情况文本：跟 FIELDS.面料情况.aggregateRender 同款
function fabricCellText(pid: string, p: Product, t: Tray): string {
  const allItems = (t.noRestockItems || []).filter((it) => it.pid.toLowerCase() === pid.toLowerCase());
  const ov0 = t.fabricOverrides?.[pid];
  const hasRealFabric = Boolean((ov0 ?? '').trim() || (!isFabricNoise(p.fabric) && (p.fabric ?? '').trim()));
  const items = effectiveNoRestockItems(allItems, hasRealFabric);
  const noRestockLines = items.map((it) => {
    const c = (it.color || '').trim();
    if (!c || c === '-') return '无面料不翻单';
    return `${c}无面料不翻单`;
  });
  let base = '';
  if (noRestockLines.length > 0) base = noRestockLines.join('\n');
  else {
    const ov = t.fabricOverrides?.[pid];
    base = ov !== undefined ? ov : (isFabricNoise(p.fabric) ? '' : (p.fabric ?? ''));
  }
  const note = t.fabricNotes?.[pid] || '';
  let text = note ? `${base}\n※ ${note}` : base;
  text = cleanFabricText(text);
  return text;
}

// 翻单周期文本：跟 FIELDS.翻单周期.aggregateRender 同款（去重 + 短名前缀）
function restockCellText(ps: Product[], t: Tray): string {
  if (ps.length === 0) return '';
  const restockOverrides = t.restockOverrides || {};
  const shortNames = computeRestockShortNames(ps, t.restockShortNames);
  const rows = ps.map((p) => {
    const raw = restockOverrides[p.id] ?? p.restock ?? '';
    const short = shortNames.get(p.id);
    let text = raw && short
      ? raw.split('\n').map((line) => (line.trim() ? `${short} ${line}` : line)).join('\n')
      : raw;
    if (text) {
      const seen = new Set<string>();
      text = text.split('\n').filter((line) => {
        if (!line.trim()) return true;
        if (seen.has(line)) return false;
        seen.add(line);
        return true;
      }).join('\n');
    }
    return { pid: p.id, text, raw };
  });
  // 按 raw 内容去重（同段文字给多个 pid 时挑短名最长的那个）
  const byRaw = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!r.text) continue;
    const key = r.raw || r.text;
    if (!byRaw.has(key)) byRaw.set(key, []);
    byRaw.get(key)!.push(r);
  }
  const visibleRows = Array.from(byRaw.values()).map((group) => {
    if (group.length === 1) return group[0];
    const best = group.reduce((a, b) => (shortNames.get(b.pid) || '').length > (shortNames.get(a.pid) || '').length ? b : a);
    const bestShort = shortNames.get(best.pid);
    if (bestShort && best.raw) {
      const rebuilt = best.raw.split('\n').map((line) => (line.trim() ? `${bestShort} ${line}` : line)).join('\n');
      const seen = new Set<string>();
      const deduped = rebuilt.split('\n').filter((line) => {
        if (!line.trim()) return true;
        if (seen.has(line)) return false;
        seen.add(line);
        return true;
      }).join('\n');
      return { ...best, text: deduped };
    }
    return best;
  });
  return visibleRows.map((r) => r.text).filter(Boolean).join('\n');
}

async function exportTrayLayoutExcel(
  t: Tray,
  byId: TrayById,
  salesByPid: TraySalesSnap,
  todayStr: string,
  sampleColorsByPid?: Record<string, string[]>,
) {
  const visible = t.sections.filter((s) => s.visible);
  const isMazong = t.template === 'mazong';
  const isPast = Boolean(t.date && t.date < todayStr);

  type Look = typeof visible[0]['looks'][0];
  // 售价：多款号坑位两个一行（用户要求，一行一个太细长）；位置仍按款号顺序两两对应
  const priceCellText = (l: Look): string => {
    const vals = l.pids.map((p) => {
      const v = effectivePrice(t.priceOverrides?.[p], byId(p));
      return v > 0 ? String(v) : (byId(p).price ?? '');
    });
    const lines: string[] = [];
    for (let i = 0; i < vals.length; i += 2) lines.push(vals.slice(i, i + 2).join(' / '));
    return lines.join('\n');
  };
  // labelRed=标签红字（搭配版块）；labelBlue=标签蓝底（库存/翻单/面料）；dataStyle=数据区整行样式
  type FieldRow = {
    label: string; height?: number;
    labelRed?: boolean; labelBlue?: boolean; img?: boolean;
    dataStyle?: 'priceGreen' | 'codeBlue';
    get: (look: Look) => ExcelJS.CellValue;
  };

  const mainRows: FieldRow[] = [
    { label: '主图', img: true, height: 224, get: () => '' },
    { label: '商品名称', height: 70, get: (l) => nameCellRichText(l.pids.map(byId), t.colorOverrideByLook?.[l.id], sampleColorsByPid) },
    { label: '款号', height: 40, dataStyle: 'codeBlue', get: (l) => l.pids.map((p) => p.toUpperCase()).join('\n') },
    { label: '尺码', height: 32, get: (l) => byId(l.pids[0])?.sizeRange || '' },
    { label: '售价', height: 45, dataStyle: 'priceGreen', get: (l) => priceCellText(l) },
    { label: '成本/倍率', height: 40, get: (l) => l.pids.map((p) => costRatioText(p, t, byId)).filter(Boolean).join('\n') },
    { label: '库存情况(主仓)', labelBlue: true, height: 70, get: (l) => l.pids.map((p) => stockCellText(byId(p))).join('\n') },
    { label: '翻单周期\n（下单日开始计算）', labelBlue: true, height: 60, get: (l) => restockCellText(l.pids.map(byId), t) },
    { label: '面料情况', labelBlue: true, height: 80, get: (l) => l.pids.map((p) => fabricCellText(p, byId(p), t)).filter(Boolean).join('\n') },
  ];
  if (isPast) {
    // 跟 UI 顺序一致：面料情况 → 直播当天销量 → 累计销量
    mainRows.splice(9, 0,
      { label: '直播当天销量', height: 35, get: (l) => { const total = l.pids.reduce((s, p) => s + ((salesByPid.daily || {})[p] || 0), 0); return total > 0 ? `${total} 件` : ''; } },
      { label: '累计销量', height: 35, get: (l) => { const total = l.pids.reduce((s, p) => s + ((salesByPid.cumulative || {})[p] || 0), 0); return total > 0 ? `${total} 件` : ''; } },
    );
  }
  const subRows: FieldRow[] = [
    { label: '主图', img: true, labelRed: true, height: 224, get: () => '' },
    { label: '商品名称', labelRed: true, height: 70, get: (l) => nameCellRichText(l.pids.map(byId), t.colorOverrideByLook?.[l.id], sampleColorsByPid) },
    { label: '款号', labelRed: true, dataStyle: 'codeBlue', height: 40, get: (l) => l.pids.map((p) => p.toUpperCase()).join('\n') },
    { label: '尺码', labelRed: true, height: 32, get: (l) => byId(l.pids[0])?.sizeRange || '' },
    { label: '售价', labelRed: true, dataStyle: 'priceGreen', height: 45, get: (l) => priceCellText(l) },
    { label: '库存情况(主仓)', labelRed: true, labelBlue: true, height: 70, get: (l) => l.pids.map((p) => stockCellText(byId(p))).join('\n') },
  ];

  const isMainSection = (label: string) => {
    if (!isMazong) return true;
    return !/搭配/.test(label);
  };

  // 用 exceljs 构建
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('货盘');
  // 列宽：标签 26，坑位 26（Excel 列宽单位 ≈ 7px/单位 → 26 ≈ 182px，刚好容纳 180px 图）
  ws.columns = [{ width: 26 }, ...Array(SLOT_DATA_COLS).fill({ width: 26 })];

  let curRow = 1;
  const imgCellsToFetch: { row: number; col: number; url: string }[] = [];

  for (const s of visible) {
    // ── 版块行：黑底白字 30 号加粗，跨 9 列合并，整行黑底 + 边框 ──
    const sectionRow = ws.getRow(curRow);
    sectionRow.height = 55;
    for (let c = 1; c <= 1 + SLOT_DATA_COLS; c++) {
      const cell = sectionRow.getCell(c);
      cell.border = THIN_BORDER;
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000000' } };
      if (c === 1) {
        cell.value = s.label;
        cell.font = { name: '微软雅黑', size: 30, bold: true, color: { argb: 'FFFFFFFF' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      }
    }
    ws.mergeCells(curRow, 1, curRow, 1 + SLOT_DATA_COLS);
    curRow++;

    const rows = isMainSection(s.label) ? mainRows : subRows;
    for (const f of rows) {
      const r = ws.getRow(curRow);
      r.height = f.height ?? 35;

      // 标签列
      const labelCell = r.getCell(1);
      labelCell.value = f.label;
      labelCell.font = {
        name: '微软雅黑', size: 20, bold: true,
        color: { argb: f.labelRed ? 'FFFF0000' : 'FF000000' },
      };
      if (f.labelBlue) {
        labelCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00B0F0' } };
      }
      labelCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      labelCell.border = THIN_BORDER;

      // 数据列
      for (let i = 0; i < SLOT_DATA_COLS; i++) {
        const look = s.looks[i];
        const cell = r.getCell(i + 2);
        cell.border = THIN_BORDER;
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        if (!look) continue;
        const v = f.get(look);
        if (v !== '' && v !== null && v !== undefined) cell.value = v as ExcelJS.CellValue;
        if (f.dataStyle === 'priceGreen') {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF92D04F' } };
          cell.font = { name: '微软雅黑', size: 14, bold: true, color: { argb: 'FFFF0000' } };
        } else if (f.dataStyle === 'codeBlue') {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF04B0F1' } };
          cell.font = { name: '微软雅黑', size: 14, bold: true, color: { argb: 'FF000000' } };
        } else if (!f.img) {
          cell.font = { name: '微软雅黑', size: 12 };
        }
        if (f.img) {
          const url = pidImgUrl(look, byId);
          if (url) imgCellsToFetch.push({ row: curRow, col: i + 2, url });
        }
      }
      curRow++;
    }
  }

  // 并发拉图片（限制并发 4，避免浏览器卡住）
  toast.info('正在嵌入图片…');
  const CONC = 4;
  type Fetched = { row: number; col: number; buffer: ArrayBuffer; ext: 'jpeg' | 'png' | 'gif'; w: number; h: number };
  const fetched: Fetched[] = [];
  for (let i = 0; i < imgCellsToFetch.length; i += CONC) {
    const batch = imgCellsToFetch.slice(i, i + CONC);
    const r = await Promise.all(batch.map(async (ic) => ({ ...ic, data: await fetchImg(ic.url) })));
    for (const x of r) {
      if (x.data) fetched.push({ row: x.row, col: x.col, buffer: x.data.buffer, ext: x.data.ext, w: x.data.w, h: x.data.h });
    }
  }

  // 1) 主图行：固定行高 168pt（约 224px），与 HTML 货盘 h-32 w-24（128×96 比例）一致
  //    所有主图格同一高度，cover 拉伸铺满（与 HTML object-cover 同效果）
  const MAIN_IMG_ROW_HEIGHT_PT = 168;
  for (const { row } of fetched) {
    ws.getRow(row).height = MAIN_IMG_ROW_HEIGHT_PT;
  }

  // 2) 用 wb.addImage 把图作为 floating drawing 铺满整个单元格（editAs: 'oneCell'）
  //    - 图作为 xlsx 内部 part（xl/media/）随 xlsx 一起打包，WPS/Excel 都直接显示
  //    - tl/br 对角 = 单元格对角：图被 cover 拉伸到格子大小，填满不留白
  //    - editAs: 'oneCell'：图跟着单元格走（移动/复制/筛选时整图一起走）
  for (const { row, col, buffer, ext } of fetched) {
    const imgId = wb.addImage({ buffer, extension: ext });
    ws.addImage(imgId, {
      tl: { col: col - 1, row: row - 1 } as any,
      br: { col, row } as any,
      editAs: 'oneCell',
    } as any);
  }

  // 生成并下载
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${t.name}-${t.date}-货盘.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
  toast.success('已导出 Excel（货盘布局，含图片）');
}

// AI 指令解析：把自然语言转成结构化过滤条件
// 支持：品类 / 温度带 / 角色(引流/利润/库存) / 现货/在途/大库存 / 清仓 / 拉新 / 转化 / 退货 / 价格带 / AI top
interface AiFilter { type: string; label: string; value: string }

// 品类别名映射：前端关键词 → BI「产品分类(到款式)」实际值
// 多个 BI 值用 || 分隔，applyAiFilters 里 split 处理
// 注意：风衣 / 卫衣 / 棉衣 / 羽绒 / 鞋靴 / 套装 等 BI 里没有对应值，不做映射
const CATEGORY_ALIASES: Record<string, string[]> = {
  '大衣': ['大衣'],
  '针织': ['针织衫'],
  'T恤': ['T恤'],
  '裤装': ['休闲裤', '牛仔裤'],
  '外套': ['短外套'],
  '夹克': ['短外套'],
  '半裙': ['半身裙'],
  '背心': ['背心/吊带'],
  '马甲': ['马夹/马夹裙'],
  '小香': ['小香风'],
  '西装': ['西装'],
  '衬衫': ['衬衫'],
  '连衣裙': ['连衣裙'],
  '皮草': ['皮草'],
  '配饰': ['配饰'],
  '帽子': ['配饰'],
  '围巾': ['配饰'],
};

// 打标 / 分类字段关键词映射：用户说的词 → Product 字段名（不是 BI 列名）→ 期望值
interface TagKeyword { pattern: RegExp; field: string; expect: string | string[]; label: string; value: string }
const TAG_KEYWORDS: TagKeyword[] = [
  { pattern: /有效款|有效/, field: 'tagValid', expect: '有效', label: '有效款', value: '有效' },
  { pattern: /无效款|无效/, field: 'tagValid', expect: '无效', label: '有效款', value: '无效' },
  { pattern: /红榜/, field: 'tagRedBlack', expect: '红榜', label: '红黑榜', value: '红榜' },
  { pattern: /黑榜/, field: 'tagRedBlack', expect: '黑榜', label: '红黑榜', value: '黑榜' },
  { pattern: /退货高|退货风险/, field: 'tagReturnPostShip', expect: '高', label: '退货风险', value: '高' },
  { pattern: /退货低|少退货/, field: 'tagReturnPostShip', expect: '其他', label: '退货风险', value: '低' },
  { pattern: /退货监控|被监控/, field: 'tagReturn15d', expect: '监控', label: '15天退货率', value: '监控' },
  { pattern: /有动销|在售/, field: 'tagSales30d', expect: '30天有动销', label: '30天动销', value: '有动销' },
  { pattern: /无动销|滞销/, field: 'tagSales30d', expect: '30天无动销', label: '30天动销', value: '无动销' },
  { pattern: /高售罄/, field: 'tagSoldOut', expect: '高售罄', label: '售罄率', value: '高售罄' },
  { pattern: /低售罄/, field: 'tagSoldOut', expect: '低售罄', label: '售罄率', value: '低售罄' },
  { pattern: /绿灯|主推款/, field: 'tagGreenLight', expect: '是', label: '绿灯款', value: '是' },
  // 季节
  { pattern: /夏季|夏天|\b夏\b/, field: 'season', expect: '夏', label: '季节', value: '夏' },
  { pattern: /冬季|冬天|\b冬\b/, field: 'season', expect: '冬', label: '季节', value: '冬' },
  { pattern: /春季|春天|\b春\b/, field: 'season', expect: '春', label: '季节', value: '春' },
  { pattern: /秋季|秋天|\b秋\b/, field: 'season', expect: '秋', label: '季节', value: '秋' },
  // 版型
  { pattern: /修身/, field: 'fit', expect: '修身', label: '版型', value: '修身' },
  { pattern: /宽松/, field: 'fit', expect: '宽松', label: '版型', value: '宽松' },
  { pattern: /合体/, field: 'fit', expect: '合体', label: '版型', value: '合体' },
  { pattern: /廓形/, field: 'fit', expect: '廓形', label: '版型', value: '廓形' },
  { pattern: /阔腿/, field: 'fit', expect: '阔腿', label: '版型', value: '阔腿' },
  { pattern: /直筒/, field: 'fit', expect: '直筒', label: '版型', value: '直筒' },
  // 物料小类
  { pattern: /羊毛/, field: 'material', expect: '羊毛', label: '面料', value: '羊毛' },
  { pattern: /\b棉\b|纯棉/, field: 'material', expect: '棉', label: '面料', value: '棉' },
  { pattern: /真丝/, field: 'material', expect: '真丝', label: '面料', value: '真丝' },
  { pattern: /亚麻/, field: 'material', expect: '亚麻', label: '面料', value: '亚麻' },
  { pattern: /醋酸/, field: 'material', expect: '醋酸', label: '面料', value: '醋酸' },
  { pattern: /羊绒/, field: 'material', expect: '羊绒', label: '面料', value: '羊绒' },
  // 库存区间
  { pattern: /深库存|库深|库存200以上|200以上/, field: 'stockBand', expect: ['200-500', '500-1000', '1000以上'], label: '库存区间', value: '200以上' },
  { pattern: /库存100以上|100以上库存/, field: 'stockBand', expect: ['100-200', '200-500', '500-1000', '1000以上'], label: '库存区间', value: '100以上' },
  // 库存判定
  { pattern: /紧缺|库存稀缺|卖得快/, field: 'stockTurnover', expect: ['周转0-15天，库存稀缺', '周转15-30天，库存不足'], label: '库存周转', value: '紧缺' },
  { pattern: /冗余|库存多|滞销库存/, field: 'stockTurnover', expect: ['无周转，库存冗余', '周转>60天，库存冗余'], label: '库存周转', value: '冗余' },
];

// 名称兜底关键词：BI 没有对应品类值的，搜到时按「名称包含」匹配（风衣 / 卫衣 等）
const TITLE_FALLBACK_KEYWORDS = ['风衣', '卫衣', '棉衣', '羽绒', '皮衣', '鞋靴', '套装'];

// 可选品类（用于「品类专场」按钮展开的选择项）
const CATEGORY_PICKER_OPTIONS = ['大衣', '针织', 'T恤', '裤装', '外套', '半裙', '背心', '马甲', '小香', '西装', '衬衫', '连衣裙', '皮草', '配饰'];

// 场景快捷指令：点击按钮直接填入指令 + 自动发送
const SCENARIO_PRESETS: Array<{ label: string; directive: string; expandable?: boolean }> = [
  { label: '大场冲业绩', directive: '大库存 高转化 红榜' },
  { label: '稳场日常', directive: '红榜 大库存 退货低' },
  { label: '新品测款', directive: 'top 有动销 有效款' },
  { label: '清库存', directive: '冗余 无动销 低价' },
  { label: '拉新', directive: '拉新 低价 大库存' },
  { label: '品类专场', directive: '', expandable: true },
  { label: '节日大促', directive: '大库存 top 高转化' },
];

function parseAiDirective(q: string): AiFilter[] {
  const s = q.trim();
  if (!s) return [];
  const filters: AiFilter[] = [];

  // 品类：用别名映射表匹配（前端关键词 → BI 实际值，多个 BI 值用 || 分隔）
  for (const [alias, biValues] of Object.entries(CATEGORY_ALIASES)) {
    if (s.includes(alias)) {
      filters.push({ type: 'category', label: '品类', value: biValues.join('||') });
      break;
    }
  }

  // 打标 / 分类字段关键词（版本 / 季节 / 面料 / 库存周转 等）
  for (const kw of TAG_KEYWORDS) {
    if (kw.pattern.test(s)) {
      const expect = Array.isArray(kw.expect) ? kw.expect.join('||') : kw.expect;
      filters.push({ type: 'tag', label: kw.label, value: `${kw.field}=${expect}` });
    }
  }

  // 名称兜底关键词（BI 里没有对应品类的，比如风衣/卫衣）→ 按名称 substring 匹配
  for (const kw of TITLE_FALLBACK_KEYWORDS) {
    if (s.includes(kw)) {
      filters.push({ type: 'titleMatch', label: '名称含', value: kw });
      break;
    }
  }

  // 温度带：匹配 "0~12" / "0-12°C" / "10~20度"
  const tempMatch = s.match(/(\d+)[~\-](\d+)\s*[°度C]?/);
  if (tempMatch) filters.push({ type: 'tempBand', label: '温度', value: `${tempMatch[1]}~${tempMatch[2]}°C` });

  // 角色：「库存」单独出现，或「清仓」；排除「大库存/库存多/库存充足」等库存相关短语
  if (/引流|流量/.test(s)) filters.push({ type: 'role', label: '角色', value: '引流' });
  if (/利润|高毛利|赚钱/.test(s)) filters.push({ type: 'role', label: '角色', value: '利润' });
  if (/清仓/.test(s)) {
    filters.push({ type: 'role', label: '角色', value: '库存' });
  } else if (/库存/.test(s) && !/大库存|库存多|库存充足|总库存大|清库存/.test(s)) {
    filters.push({ type: 'role', label: '角色', value: '库存' });
  }

  // 库存相关：大库存 = 现货多（用户看到的"现货"）；总库存大 = 现货+在途；其余按字面
  if (/现货充足|现货多|大量现货/.test(s)) filters.push({ type: 'stockMain', label: '现货', value: '≥50' });
  if (/在途充足|在途多/.test(s)) filters.push({ type: 'inTransit', label: '在途', value: '≥50' });
  if (/大库存/.test(s)) {
    filters.push({ type: 'stockMain', label: '现货', value: '≥100' });
  } else if (/库存多|库存充足/.test(s)) {
    filters.push({ type: 'stockMain', label: '现货', value: '≥50' });
  } else if (/总库存大/.test(s)) {
    filters.push({ type: 'totalStock', label: '总库存', value: '≥100' });
  } else if (/清仓|清库存/.test(s)) {
    filters.push({ type: 'clearance', label: '清仓', value: '是' });
  } else if (/库存/.test(s)) {
    filters.push({ type: 'role', label: '角色', value: '库存' });
  }

  // 指标（值用定性描述；实际阈值在 applyAiFilters 里按当前候选池动态取前/后 30%，避免 BI 数据稀疏时 0 结果）
  if (/拉新|新客/.test(s)) filters.push({ type: 'newBuyer', label: '新买家', value: '靠前' });
  if (/高转化|转化好|转化高/.test(s)) filters.push({ type: 'conversion', label: '转化率', value: '靠前' });
  if (/退货低|低退货/.test(s)) filters.push({ type: 'returnRate', label: '退货率', value: '靠后' });

  // 价格带
  if (/高价|高端/.test(s)) filters.push({ type: 'priceBand', label: '价格带', value: '高' });
  if (/中价/.test(s)) filters.push({ type: 'priceBand', label: '价格带', value: '中' });
  if (/低价|平价|便宜/.test(s)) filters.push({ type: 'priceBand', label: '价格带', value: '低' });

  // AI 推荐
  if (/top|主推|重点|AI推荐/.test(s)) filters.push({ type: 'ai', label: 'AI推荐', value: 'TOP' });

  return filters;
}

function matchTempBand(qValue: string, pTempBand: string): boolean {
  const m = qValue.match(/(\d+)~(\d+)/);
  const pm = pTempBand.match(/(\d+)~(\d+)/);
  if (!m || !pm) return false;
  const [qMin, qMax] = [Number(m[1]), Number(m[2])];
  const [pMin, pMax] = [Number(pm[1]), Number(pm[2])];
  return pMax >= qMin && pMin <= qMax;
}

function parseThreshold(value: string): number {
  const num = Number(value.replace(/[^0-9.]/g, ''));
  return value.includes('%') ? num / 100 : num;
}

// 按当前候选池取指标前/后 30% 阈值：数据稀疏时也能给出结果，不用硬阈值把结果卡死
function getMetricThreshold(list: Product[], metric: 'newBuyer' | 'conversion' | 'returnRate', tail: 'top' | 'bottom'): number {
  const values = list.map((p) => p[metric]).filter((v) => Number.isFinite(v));
  if (values.length === 0) return tail === 'top' ? 0 : Infinity;
  values.sort((a, b) => a - b);
  const idx = Math.floor(values.length * (tail === 'top' ? 0.7 : 0.3));
  return values[Math.min(idx, values.length - 1)];
}

function applyAiFilters(list: Product[], filters: AiFilter[]): Product[] {
  // 指标类过滤使用动态阈值（基于当前候选池）
  const metricThresholds: Record<string, number> = {};
  for (const f of filters) {
    if (f.type === 'newBuyer') metricThresholds.newBuyer = getMetricThreshold(list, 'newBuyer', 'top');
    if (f.type === 'conversion') metricThresholds.conversion = getMetricThreshold(list, 'conversion', 'top');
    if (f.type === 'returnRate') metricThresholds.returnRate = getMetricThreshold(list, 'returnRate', 'bottom');
  }

  return list.filter((p) => filters.every((f) => {
    switch (f.type) {
      case 'category': return f.value.split('||').includes(p.category);
      case 'tempBand': return matchTempBand(f.value, p.tempBand);
      case 'role': return p.roles.includes(f.value as RoleTag);
      case 'stockMain': return p.stockMain >= parseThreshold(f.value);
      case 'inTransit': return p.inTransit >= parseThreshold(f.value);
      case 'totalStock': return p.stockMain + p.inTransit >= parseThreshold(f.value);
      case 'clearance': return p.roles.includes('库存') && p.stockMain + p.inTransit < 100;
      case 'newBuyer': return p.newBuyer >= (metricThresholds.newBuyer ?? 0);
      case 'conversion': return p.conversion >= (metricThresholds.conversion ?? 0);
      case 'returnRate': return p.returnRate <= (metricThresholds.returnRate ?? Infinity);
      case 'priceBand': return p.priceBand === f.value;
      case 'ai': return p.ai === 'top' || p.tagGreenLight === '是';
      case 'tag': {
        // f.value 格式：「field=expected1||expected2」
        const eqIdx = f.value.indexOf('=');
        if (eqIdx === -1) return true;
        const field = f.value.slice(0, eqIdx);
        const expects = f.value.slice(eqIdx + 1).split('||');
        const actual = (p as any)[field];
        return actual !== undefined && expects.includes(actual);
      }
      case 'titleMatch': {
        // 名称 / 小名 / 款号 包含关键词
        return (p.name || '').includes(f.value) || (p.sub || '').includes(f.value) || p.id.toUpperCase().includes(f.value.toUpperCase());
      }
      default: return true;
    }
  }));
}

// ── 坑位选款面板（右侧）：人给指令 → AI 推荐 → 人选主款 → 套装勾选 → 确认 ──
function LookPicker({
  sectionLabel, mode, onConfirm, onClose,
}: {
  sectionLabel: string;
  mode: 'new' | 'append';
  onConfirm: (pids: string[]) => void;
  onClose: () => void;
}) {
  const [directive, setDirective] = useState('');
  const [sent, setSent] = useState('');
  const [pidSearch, setPidSearch] = useState('');
  const [sampleHits, setSampleHits] = useState<Product[]>([]);
  // 批量选择：第一个是主款（用于 AI 套装匹配），其余是同坑位的搭配款
  const [selected, setSelected] = useState<string[]>([]);
  // 「品类专场」按钮展开状态：点击展开品类选择
  const [showCategoryPicker, setShowCategoryPicker] = useState(false);
  const PRODUCTS = useProducts();
  const byId = useProductsById();
  // 预估剩余库存（BI 剩余库存卡片，按款号索引；候选款/搭配款列表展示用）
  const [remainingMap, setRemainingMap] = useState<Map<string, RemainingGroup>>(new Map());
  useEffect(() => {
    fetchRemainingInventory({ limit: 7000 })
      .then((r) => setRemainingMap(new Map(r.items.map((it) => [it.styleCode.toLowerCase(), it]))))
      .catch(() => setRemainingMap(new Map()));
  }, []);

  const main = selected[0] ?? null;
  const mates = selected.slice(1);

  // 款号搜索在本地 PRODUCTS 没命中时，去 /api/samples 兜底查样衣阶段
  // （未转大货款号如 ME15FW015 只在样衣端存在）
  // 支持空格 / 逗号分隔多个款号：「ME05FF067 ME09FF139」→ 命中其中任一即纳入候选
  useEffect(() => {
    const tokens = pidSearch.trim().split(/[\s,]+/).filter(Boolean);
    // 只对"看起来是款号"的输入触发（避免每输入一个中文都查一次）
    const onlyCodeLike = tokens.length > 0 && tokens.every((t) => t.length >= 3 && !/[一-龥]/.test(t));
    if (!onlyCodeLike) {
      setSampleHits([]);
      return;
    }
    const upperTokens = tokens.map((t) => t.toUpperCase());
    // 逐个款号检查：只把本地没命中的 token 拿去查样衣（避免一个命中拖累另一个）
    const missingTokens = upperTokens.filter(
      (t) =>
        !PRODUCTS.some(
          (p) => p.id.toUpperCase().includes(t) || p.name.toLowerCase().includes(t.toLowerCase()),
        ),
    );
    if (missingTokens.length === 0) {
      setSampleHits([]);
      return;
    }
    let cancelled = false;
    Promise.all(missingTokens.map((t) => fetchSamplesByCodes([t]).then((r) => r.items ?? []).catch(() => [])))
      .then((arr) => { if (!cancelled) setSampleHits(arr.flat()); })
      .catch(() => { if (!cancelled) setSampleHits([]); });
    return () => { cancelled = true; };
  }, [pidSearch, PRODUCTS]);

  const pool = useMemo(() => {
    let list = [...PRODUCTS];
    // 款号 / 名称精确搜索（实时过滤，无需点发送）
    // 空格 / 逗号分隔多个款号时，命中任一即纳入候选
    const tokens = pidSearch.trim().split(/[\s,]+/).filter(Boolean);
    if (tokens.length > 0) {
      const uppers = tokens.map((t) => t.toUpperCase());
      const lowers = tokens.map((t) => t.toLowerCase());
      list = list.filter(
        (p) =>
          uppers.some((t) => p.id.toUpperCase().includes(t)) ||
          lowers.some((t) => p.name.toLowerCase().includes(t)),
      );
    }
    // AI 指令（叠加在款号搜索之上）
    const q = sent.trim();
    if (q) {
      // 说明：曾把 sent 里的英文 token 当作款号搜索（兼容旧用法），但导致 "top 有动销 有效款" 这种指令里的 "top"
      // 被拿去跑 p.id.includes('TOP')，款号里没人叫 TOP 直接把结果集清空。款号/名称搜索统一走 pidSearch，这里只跑 AI 解析
      const aiFilters = parseAiDirective(q);
      if (aiFilters.length > 0) {
        let filtered = applyAiFilters(list, aiFilters);
        // 角色过滤无命中时（BI 角色标签可能未打），移除角色条件并按业务代理指标排序
        if (filtered.length === 0 && aiFilters.some((f) => f.type === 'role')) {
          const nonRoleFilters = aiFilters.filter((f) => f.type !== 'role');
          filtered = nonRoleFilters.length > 0 ? applyAiFilters(list, nonRoleFilters) : [...list];
          if (/利润|高毛利|赚钱/.test(q)) {
            filtered.sort((a, b) => b.priceNum - a.priceNum);
          } else if (/引流|流量/.test(q)) {
            filtered.sort((a, b) => b.conversion - a.conversion || b.stockMain - a.stockMain);
          } else if (/库存|清仓/.test(q)) {
            filtered.sort((a, b) => (b.stockMain + b.inTransit) - (a.stockMain + a.inTransit));
          }
        }
        list = filtered;
      }
    }
    // 排序：根据 AI 指令意图，把最相关的维度放在最前面
    return list.sort((a, b) => {
      if (/大库存|现货/.test(q)) return b.stockMain - a.stockMain;
      if (/在途/.test(q)) return b.inTransit - a.inTransit;
      if (/总库存大/.test(q)) return (b.stockMain + b.inTransit) - (a.stockMain + a.inTransit);
      if (/高转化|转化/.test(q)) return b.conversion - a.conversion;
      if (/拉新|新客/.test(q)) return b.newBuyer - a.newBuyer;
      if (/退货/.test(q)) return a.returnRate - b.returnRate;
      if (/利润|高毛利|赚钱/.test(q)) return b.priceNum - a.priceNum;
      if (/引流|流量/.test(q)) return b.conversion - a.conversion || b.stockMain - a.stockMain;
      if (/库存|清仓/.test(q)) return (b.stockMain + b.inTransit) - (a.stockMain + a.inTransit);
      // 默认：AI top 优先，然后转化率
      return (b.ai === 'top' ? 1 : 0) - (a.ai === 'top' ? 1 : 0) || b.conversion - a.conversion;
    }).slice(0, 12);
  }, [sent, pidSearch, PRODUCTS]);

  const aiFilters = useMemo(() => parseAiDirective(sent), [sent]);

  // 样衣兜底结果：本地无命中时，附加到候选池尾部
  const finalPool = useMemo(() => {
    const pidQ = pidSearch.trim();
    if (!pidQ || sampleHits.length === 0) return pool;
    const seen = new Set(pool.map((p) => p.id));
    return [...pool, ...sampleHits.filter((p) => !seen.has(p.id))];
  }, [pool, sampleHits, pidSearch]);

  const candidates = main ? matchCandidates(main) : [];

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-label="坑位选款" className="product-picker absolute right-0 top-0 flex h-full w-[440px] flex-col border-l border-edge bg-surface-card">
        <div className="flex items-center justify-between border-b border-edge-muted px-5 py-4">
          <div>
            <div className="text-[14px] font-bold">坑位选款 · {sectionLabel}</div>
            <div className="mt-0.5 text-[11px] text-ink-muted">{mode === 'new' ? '新建一个坑位（Look）' : '向当前坑位追加款号'}</div>
          </div>
          <button onClick={onClose} aria-label="关闭选款" className="rounded-md p-1.5 hover:bg-surface-subtle"><X size={16} /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="text-[11px] font-medium text-ink-muted">1 · 给 AI 下达筛选指令</div>
          <div className="mt-2 flex items-center gap-2 rounded-md border border-edge-strong px-3 py-2 focus-within:border-edge">
            <Search size={13} className="text-ink-muted" />
            <input
              value={directive}
              onChange={(e) => {
                const v = e.target.value;
                setDirective(v);
                if (!v.trim()) setSent('');
              }}
              onKeyDown={(e) => e.key === 'Enter' && (setSent(directive), setSelected([]))}
              placeholder='如"大衣 0~12°C 现货充足" / "清仓" / "大库存"'
              className="w-full bg-transparent text-[12.5px] outline-none"
            />
            <button
              onClick={() => { setSent(directive); setSelected([]); }}
              className="rounded bg-action-primary p-1.5 text-white hover:bg-action-primary-hover"
            >
              <Send size={12} />
            </button>
          </div>
          {/* 场景快捷指令：点击直接填入 + 自动发送；hover 显示完整指令 */}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {SCENARIO_PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => {
                  if (p.expandable) {
                    setShowCategoryPicker((v) => !v);
                  } else {
                    setDirective(p.directive);
                    setSent(p.directive);
                    setSelected([]);
                    setShowCategoryPicker(false);
                  }
                }}
                className={`rounded-full border px-2.5 py-1 text-[10.5px] transition-colors ${
                  p.expandable && showCategoryPicker
                    ? 'border-action-primary bg-action-primary/10 text-action-primary'
                    : 'border-edge bg-surface-subtle text-ink-secondary hover:border-action-primary hover:bg-action-primary/10 hover:text-action-primary'
                }`}
                title={p.directive || '点击选择品类'}
              >
                {p.label}
                {p.expandable && <span className="ml-1 text-[9px]">{showCategoryPicker ? '▴' : '▾'}</span>}
              </button>
            ))}
          </div>
          {/* 「品类专场」展开后：品类选择 */}
          {showCategoryPicker && (
            <div className="mt-2 flex flex-wrap gap-1.5 rounded-md border border-dashed border-edge-muted p-2">
              {CATEGORY_PICKER_OPTIONS.map((cat) => (
                <button
                  key={cat}
                  onClick={() => {
                    const d = `${cat} 现货充足`;
                    setDirective(d);
                    setSent(d);
                    setSelected([]);
                    setShowCategoryPicker(false);
                  }}
                  className="rounded-full border border-edge bg-surface-card px-2.5 py-1 text-[10.5px] text-ink-primary hover:border-action-primary hover:bg-action-primary/10 hover:text-action-primary"
                >
                  {cat}
                </button>
              ))}
            </div>
          )}
          {aiFilters.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] text-ink-muted">AI 理解为：</span>
              {aiFilters.map((f, i) => (
                <span key={i} className="rounded-full bg-surface-subtle px-2 py-0.5 text-[10px] text-ink-secondary">
                  {f.label} · {f.value}
                </span>
              ))}
            </div>
          )}

          {/* 按款号 / 名称直接搜：实时过滤，与 AI 指令可叠加 */}
          <div className="mt-3 text-[11px] font-medium text-ink-muted">或按款号 / 名称直接搜</div>
          <div className="mt-2 flex items-center gap-2 rounded-md border border-edge-strong px-3 py-2 focus-within:border-edge">
            <Search size={13} className="text-ink-muted" />
            <input
              value={pidSearch}
              onChange={(e) => { setPidSearch(e.target.value); setSelected([]); }}
              placeholder="如 ME01DW020 / 羊毛大衣（空格分隔可批量筛）"
              className="w-full bg-transparent text-[12.5px] outline-none"
            />
            {pidSearch && (
              <button onClick={() => setPidSearch('')} className="text-ink-muted hover:text-ink-primary" title="清空">
                <X size={12} />
              </button>
            )}
          </div>

          <div className="mt-5 flex items-center gap-1.5 text-[11px] font-medium text-ink-muted">
            <Bot size={12} /> 2 · 候选款（{finalPool.length} 款，勾选多款同入一坑位，首选为主款）
          </div>
          <div className="mt-2 space-y-2">
            {finalPool.map((p) => {
              const isOn = selected.includes(p.id);
              const isMain = selected[0] === p.id;
              return (
                <button
                  key={p.id}
                  onClick={() => setSelected((s) => (isOn ? s.filter((x) => x !== p.id) : [...s, p.id]))}
                  className={`flex w-full items-center gap-3 rounded-md border p-2 text-left transition-colors ${
                    isOn ? 'border-edge bg-surface-subtle' : 'border-edge hover:border-edge'
                  }`}
                >
                  <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border ${isOn ? 'border-edge bg-action-primary text-white' : 'border-ink-faint'}`}>
                    {isOn && <Check size={10} />}
                  </span>
                  <SafeImg src={p.img} alt={p.name} pid={p.id} className="h-14 w-12 rounded-sm object-cover" fallbackText="无图" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[12.5px] font-semibold">{p.name}</span>
                      {p.ai === 'top' && <Sparkles size={11} className="shrink-0 text-stage-peak-fg" />}
                      {(p as any).stage === 'sample' && (
                        <span className="shrink-0 rounded-sm bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold text-amber-700">样衣</span>
                      )}
                      {isMain && (
                        <span className="shrink-0 rounded-sm bg-action-primary px-1.5 py-0.5 text-[9px] font-semibold text-white">主款</span>
                      )}
                    </div>
                    <div className="mt-0.5 font-mono text-[10px] uppercase text-ink-muted">{p.id}</div>
                    <div className="mt-0.5 text-[10.5px] leading-4 text-ink-muted">
                      {p.category} · ¥{p.price} · 现货 {p.stockMain}{p.inTransit > 0 && ` · 在途 ${p.inTransit}`} · 转化 {(p.conversion * 100).toFixed(1)}%
                      {(() => { const r = remainingMap.get(p.id.toLowerCase()); return r ? ` · 预估剩余 ${Math.round(r.totals.estimate).toLocaleString()}` : ''; })()}
                    </div>
                  </div>
                </button>
              );
            })}
            {finalPool.length === 0 && (
              <div className="rounded-md border border-dashed border-edge-muted px-3 py-4 text-center text-[11px] text-ink-muted">
                暂无匹配款式，试试换一组关键词
              </div>
            )}
          </div>

          {main && mode === 'new' && candidates.length > 0 && (
            <>
              <div className="mt-5 text-[11px] font-medium text-ink-muted">
                3 · 套装搭配：系统已找出与「{byId(main).name}」成套的款号，勾选并入同一坑位
              </div>
              <div className="mt-2 space-y-2">
                {candidates.map((pid) => {
                  const p = byId(pid);
                  const on = mates.includes(pid);
                  return (
                    <button
                      key={pid}
                      onClick={() => setSelected((s) => (on ? s.filter((x) => x !== pid) : [...s, pid]))}
                      className={`flex w-full items-center gap-3 rounded-md border p-2 text-left transition-colors ${
                        on ? 'border-edge bg-surface-subtle' : 'border-edge hover:border-edge'
                      }`}
                    >
                      <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border ${on ? 'border-edge bg-action-primary text-white' : 'border-ink-faint'}`}>
                        {on && <Check size={10} />}
                      </span>
                      <SafeImg src={p.img} alt={p.name} pid={p.id} className="h-12 w-10 rounded-sm object-cover" fallbackText="无图" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12.5px] font-semibold">{p.name}</div>
                        <div className="mt-0.5 font-mono text-[10px] uppercase text-ink-muted">{p.id}</div>
                        <div className="mt-0.5 text-[10.5px] text-ink-muted">
                          {p.category} · ¥{p.price} · 现货 {p.stockMain}{p.inTransit > 0 && ` · 在途 ${p.inTransit}`}
                          {(() => { const r = remainingMap.get(p.id.toLowerCase()); return r ? ` · 预估剩余 ${Math.round(r.totals.estimate).toLocaleString()}` : ''; })()}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>

        <div className="border-t border-edge-muted px-5 py-4">
          <button
            disabled={selected.length === 0}
            onClick={() => {
              onConfirm(selected);
              toast.success(`已${mode === 'new' ? '放入' : '追加到'}「${sectionLabel}」（${selected.length} 个款号）`);
              onClose();
            }}
            className="w-full rounded-md bg-action-primary py-2.5 text-[13px] font-medium text-white hover:bg-action-primary-hover disabled:opacity-30"
          >
            {mode === 'new' ? `确认放入（${selected.length} 个款号）` : `确认追加到坑位（${selected.length} 个款号）`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Excel 版式的字段行（行=字段，列=坑位，排版参考用户货盘表）──
interface FieldRenderCtx {
  sectionId: string;
  lookId: string;
  pid: string;
  fabricOverride?: string;
  fabricOverrides?: Record<string, string>; // 整个 look 所有 pid 的面料 override（aggregate 用）
  fabricNotes?: Record<string, string>; // 整个 look 所有 pid 的面料注脚（追加在末尾，aggregate 用）
  restockOverrides?: Record<string, string>; // 整个 look 所有 pid 的翻单 override（aggregate 用）
  restockShortNames?: Record<string, string>; // 翻单行前缀手动覆盖（Look.restockShortNames 透传）
  noRestockItems?: NoRestockItem[]; // SKC 维度无面料不翻单标记（含颜色/面料信息）
  skcsByCode?: Record<string, Array<{ code: string; color: string }>>;
  salesByPid?: { daily: Record<string, number>; cumulative: Record<string, number> }; // 已播完货盘销量快照
  onPickFabric?: (pid: string) => void;
  onClearFabric?: (pid: string) => void;
  onSaveFabricNote?: (pid: string, value: string) => void;
  onClearFabricNote?: (pid: string) => void;
  onPickRestock?: (lookId: string) => void;
  // 售价 / 马总价 override：单款号模式传当前 pid 的值；多款号模式走下方 *_Overrides map
  priceOverride?: string;
  mpriceOverride?: string;
  priceOverrides?: Record<string, string>; // 整个 look 所有 pid 的售价 override（多款号用）
  mpriceOverrides?: Record<string, string>; // 整个 look 所有 pid 的马总价 override（多款号用）
  codeSuffixOverrides?: Record<string, string>; // 整个 look 所有 pid 的款号注脚 override（多款号用）
  costOverrides?: Record<string, string>; // 整个 look 所有 pid 的成本 override（多款号用）
  mcostOverrides?: Record<string, string>; // 整个 look 所有 pid 的马总成本 override（多款号用）
  onSavePrice?: (pid: string, value: string) => void;
  onClearPrice?: (pid: string) => void;
  onSaveMprice?: (pid: string, value: string) => void;
  onClearMprice?: (pid: string) => void;
  costOverride?: string;
  mcostOverride?: string;
  onSaveCost?: (pid: string, value: string) => void;
  onClearCost?: (pid: string) => void;
  onSaveMcost?: (pid: string, value: string) => void;
  onClearMcost?: (pid: string) => void;
  codeSuffixOverride?: string;
  onSaveCodeSuffix?: (pid: string, value: string) => void;
  // 颜色文案 override：per-look（整行覆盖 pid.colors union）
  colorOverride?: string;
  // 样衣阶段颜色（黑巧/驼色等未转大货色）：pid → colorName[]，卡片颜色行追加展示
  sampleColorsByPid?: Record<string, string[]>;
  onSaveColor?: (lookId: string, value: string) => void;
  onClearColor?: (lookId: string) => void;
  // 悬停自动查面料：调用方传入当前坑位所有 pid，悬停时弹快查窗
  allPids?: string[];
  onHoverFabric?: (allPids: string[], anchorEl: HTMLElement) => void;
  onLeaveFabric?: () => void;
  // 销量注脚：仅「已播完」的货盘（tray.date < 今天）才传日期；否则 null
  pastDate?: string | null;
}
interface FieldRow {
  label: string;
  labelCls?: string; // 标签格样式
  rowCls?: string;   // 整行底色
  show: (tpl: Tray['template']) => boolean;
  aggregate?: boolean; // 跨款号合并渲染（一格只渲一次，不按款号纵向堆叠）
  render: (p: Product, tpl: Tray['template'], ctx: FieldRenderCtx) => ReactNode;
  aggregateRender?: (ps: Product[], tpl: Tray['template'], ctx: FieldRenderCtx) => ReactNode;
}

const RED = 'text-action-danger-fg';
const BLUE = 'text-action-link';

// 多款号坑位的产品短名（翻单行前缀），如：
//   圆领针织套衫/V领针织套衫         → 圆领/V领
//   羊绒收脚口针织裤/羊绒连帽针织开衫     → 针织裤/开衫
//   水溶羊毛针织背心/水溶羊毛圆领打底衫   → 背心/打底衫
//   撞色羽绒服/撞色羽绒马甲           → 羽绒服/马甲
// 做法：按词典把产品名切成「修饰词/品类词」段 → 去掉所有款共有的段 →
// 再去修饰词、保留品类词；全被去光则保留去共有段之后的剩余部分。
// （纯按位置剥公共前后缀不可靠：圆领/V领 只差首字，位置后缀会把「领」也剥掉）
// overrides 是坑位上手动指定的前缀（坑位多图管理弹窗里维护），优先于自动推导。
const SHORT_NAME_MODIFIERS = new Set([
  '水溶羊毛', '美丽诺羊毛', '精纺羊毛', '山羊绒', '马海毛', '桑蚕丝', '长绒棉', '羊绒', '羊毛', '纯棉', '全棉',
  '撞色', '拼接', '印花', '字母', '提花', '条纹', '绣花', '镂空', '系带', '荷叶边',
  '收脚口', '收口', '束脚', '连帽', '带帽',
  '圆领', 'V领', 'v领', 'U领', 'u领', '高领', '半高领', '翻领', '立领', '娃娃领', 'POLO领', 'Polo领', 'polo领',
  '针织', '羽绒',
]);
// 分词词典：修饰词 + 常见品类词，按长度降序做最长匹配；未命中字符并入「描述段」
const SHORT_NAME_VOCAB = [
  ...SHORT_NAME_MODIFIERS,
  '针织套衫', '针织裤', '针织裙', '打底衫', '羽绒服', '羽绒马甲',
  '连衣裙', '半身裙', '小香风', '长袖', '短袖',
  '外套', '大衣', '风衣', '马甲', '背心', '开衫', '套衫', '卫衣', '衬衫', '短裙', '长裤', '短裤', '裤', '裙', '衫', 'T恤', '西装', '针织衫',
].sort((a, b) => b.length - a.length);
// 品类词集合：在词典里但不是修饰词的，用于「只保留品类词」过滤
const SHORT_NAME_CATEGORIES = new Set(SHORT_NAME_VOCAB.filter((w) => !SHORT_NAME_MODIFIERS.has(w)));

function segmentShortName(name: string): string[] {
  const segs: string[] = [];
  let i = 0;
  let buf = '';
  while (i < name.length) {
    const hit = SHORT_NAME_VOCAB.find((w) => name.startsWith(w, i));
    if (hit) {
      if (buf) { segs.push(buf); buf = ''; }
      segs.push(hit);
      i += hit.length;
    } else {
      buf += name[i];
      i += 1;
    }
  }
  if (buf) segs.push(buf);
  return segs;
}

function computeRestockShortNames(ps: Product[], overrides?: Record<string, string>): Map<string, string> {
  const m = new Map<string, string>();
  if (ps.length < 2) return m;
  let names = ps.map((p) => (p.name || '').trim());
  // BI/领猫经常把套装名写在其中一个款的 name 里（如「休闲连帽卫衣 / 毛边休闲直筒卫裤」），
  // 也可能各款 name 单独写、页面显示时再拼成「休闲连帽卫衣 / 毛边休闲直筒卫裤」。
  // 用套装名拆开后分别推导 short name，否则「卫裤」会被简化成「裤」。
  const uniqueNames = [...new Set(names.filter(Boolean))];
  let suitName = names.find((n) => n.includes('/'));
  if (!suitName && uniqueNames.length > 1) {
    const joined = uniqueNames.join(' / ');
    const candidateParts = joined.split('/').map((s) => s.trim()).filter(Boolean);
    if (candidateParts.length >= ps.length) suitName = joined;
  }
  if (suitName) {
    const parts = suitName.split('/').map((s) => s.trim()).filter(Boolean);
    if (parts.length >= ps.length) {
      names = names.map((orig, i) => parts[i] || orig);
    }
  }
  if (new Set(names).size < 2 || names.some((n) => !n)) return m;
  const ov = overrides || {};
  const ovLower = new Map(Object.keys(ov).map((k) => [k.toLowerCase(), ov[k]]));
  const segList = names.map(segmentShortName);
  // 所有款都出现的段 = 共有段（每款去掉一次）
  const common = new Set(
    segList[0].filter((s) => segList.every((segs) => segs.includes(s))),
  );
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    const manual = ovLower.get(p.id.toLowerCase());
    if (manual) {
      m.set(p.id, manual);
      continue;
    }
    const rest = segList[i].filter((s) => !common.has(s));
    // 只保留品类词（松弛感叠穿长袖 → 长袖）；若一个品类词都没剩（圆领/V领 只有领型差异），
    // 回退保留去共有段后的剩余部分；如果 rest 也为空（极简短款通勤西装 vs 极简短款通勤西装/裤，
    // 西装/裤都被剥光），回退到原 segments 里最后一个品类词（如「极简短款通勤西装」→「西装」）
    const kept = rest.filter((s) => SHORT_NAME_CATEGORIES.has(s));
    // 剥去前后残留的非文字字符（领猫产品名常用 "机场大衣-短款" 这种 "-" 连接写法，
    // "-" 不在 SHORT_NAME_VOCAB 里，会被整段塞进 rest 一起 join 出来 → "-短款"）
    const trimJunk = (s: string) => s.replace(/^[^一-龥a-zA-Z0-9]+|[^一-龥a-zA-Z0-9]+$/g, '');
    let short: string;
    if (kept.length) {
      short = trimJunk(kept.join(''));
    } else if (rest.length) {
      short = trimJunk(rest.join(''));
    } else {
      const lastCategory = [...segList[i]].reverse().find((s) => SHORT_NAME_CATEGORIES.has(s));
      short = trimJunk(lastCategory || '');
    }
    m.set(p.id, short || names[i]);
  }
  return m;
}

const FIELDS: FieldRow[] = [
  {
    label: '商品名称',
    show: () => true,
    aggregate: true, // 多款号时合并展示
    render: (p, _tpl, ctx) => (
      <>
        {p.sub && p.sub !== '本' && p.sub.length > 1 && <div className="text-[12.5px] font-semibold leading-5">{p.sub}</div>}
        <div className="text-[12.5px] font-semibold leading-5">{p.name}</div>
        <div className="mt-0.5 text-[11.5px] leading-4 text-ink-secondary">
          {(() => {
            const extras = (ctx.sampleColorsByPid?.[p.id] || []).filter((c) => !p.colors.includes(c));
            return p.colors.concat(extras).join(' / ');
          })()}
        </div>
      </>
    ),
    aggregateRender: (ps, _tpl, ctx) => {
      // 名称：去重后用「 / 」拼接；优先取含 / 的套装组合名（如「羊绒连帽开衫/裤」）
      const uniqueNames = [...new Set(ps.map((p) => p.name).filter(Boolean))];
      const suitName = uniqueNames.find((n) => n.includes('/'));
      const nameLine = suitName ?? (uniqueNames.length > 1 ? uniqueNames.join(' / ') : uniqueNames[0] ?? '');
      // 小名：去重 + 过滤「本」等占位符，同时过滤掉跟产品名重复的内容
      // （领猫 smName 有时跟 pdtName 相同，会跟第二行商品名称重复）
      const nameSet = new Set(uniqueNames);
      const subs = [
        ...new Set(
          ps
            .map((p) => p.sub)
            .filter((s) => s && s !== '本' && s.length > 1 && !nameSet.has(s)),
        ),
      ];
      // 颜色：跨款号去重后 / 拼接；样衣阶段颜色（黑巧/驼色等）追加在后；per-look override（colorOverrideByLook[lookId]）优先
      const colorSet = new Set<string>();
      for (const p of ps) for (const c of (p.colors ?? [])) colorSet.add(c);
      for (const p of ps) for (const c of (ctx.sampleColorsByPid?.[p.id] ?? [])) colorSet.add(c);
      const defaultColors = [...colorSet].join(' / ');
      const colorText = ctx.colorOverride ?? defaultColors;
      return (
        <>
          {subs.length > 0 && <div className="text-[12.5px] font-semibold leading-5">{subs.join(' / ')}</div>}
          <div className="text-[12.5px] font-semibold leading-5">{nameLine}</div>
          {(defaultColors || ctx.colorOverride) && (
            <div className="mt-0.5 text-[11.5px] leading-4 text-center">
              <ColorLineEditor
                value={colorText}
                defaultText={defaultColors}
                onSave={(v) => ctx.onSaveColor?.(ctx.lookId, v)}
                onClear={() => ctx.onClearColor?.(ctx.lookId)}
              />
            </div>
          )}
        </>
      );
    },
  },
  {
    label: '款号',
    rowCls: 'bg-surface-card',
    show: () => true,
    aggregate: true, // 多款号时合并展示
    render: (p, _tpl, ctx) => (
      // 款号在 cell 中心居中（text-center 推到 div 中央）；
      // 注脚 absolute 挂在款号 span 右边（left-full = 款号右边缘），紧贴款号末尾，不参与居中计算；
      // 不垂直居中——同字号下 absolute 默认 top:0 让注脚 baseline 自然对齐款号 baseline
      <div className="text-center">
        <span className="group relative inline-block">
          <span className="font-mono text-[12px] font-semibold text-ink-primary">{p.id.toUpperCase()}</span>
          <span className="absolute left-full ml-1 whitespace-nowrap select-none">
            <CodeSuffixEditor
              value={ctx.codeSuffixOverride ?? ''}
              onSave={(v) => ctx.onSaveCodeSuffix?.(ctx.pid, v)}
            />
          </span>
        </span>
      </div>
    ),
    aggregateRender: (ps, _tpl, ctx) => {
      // 保留坑位里款号的添加顺序（与售价、名称行顺序一致）
      return (
        <div className="space-y-0.5">
          {ps.map((p) => (
            <div key={p.id} className="text-center leading-5">
              <span className="group relative inline-block">
                <span className="font-mono text-[12px] font-semibold text-ink-primary">{p.id.toUpperCase()}</span>
                <span className="absolute left-full ml-1 whitespace-nowrap select-none">
                  <CodeSuffixEditor
                    value={ctx.codeSuffixOverrides?.[p.id] ?? ''}
                    onSave={(v) => ctx.onSaveCodeSuffix?.(p.id, v)}
                  />
                </span>
              </span>
            </div>
          ))}
        </div>
      );
    },
  },
  {
    label: '尺码',
    show: () => true,
    aggregate: true, // 多款号合并展示：同尺码合一写一行，不同则「款号：尺码」分行
    render: (p) => (
      <div className="text-center font-mono text-[11.5px] text-ink-primary">
        {p.sizeRange || <span className="text-ink-faint">—</span>}
      </div>
    ),
    aggregateRender: (ps) => {
      // 单款号：直接显示尺码
      if (ps.length === 1) {
        return (
          <div className="text-center font-mono text-[12.5px] text-ink-primary">
            {ps[0].sizeRange || <span className="text-ink-faint">—</span>}
          </div>
        );
      }
      const sizes = ps.map((p) => (p.sizeRange ?? '').trim() || '—');
      const allSame = sizes.every((s) => s === sizes[0]);
      // 所有款号尺码一致：写一行
      if (allSame) {
        return (
          <div className="text-center font-mono text-[12.5px] text-ink-primary">{sizes[0]}</div>
        );
      }
      // 尺码不同：按「款号：尺码」分行
      return (
        <div className="space-y-0.5 font-mono text-[12px] text-ink-primary">
          {ps.map((p, i) => (
            <div key={p.id} className="flex items-baseline justify-center gap-1">
              <span className="text-ink-secondary">{p.id.toUpperCase()}</span>
              <span className="text-ink-faint">：</span>
              <span>{sizes[i]}</span>
            </div>
          ))}
        </div>
      );
    },
  },
  {
    label: '售价',
    rowCls: 'bg-excel-price',
    show: () => true,
    aggregate: true, // 多款号时合并展示（每款独立可编辑）
    render: (p, tpl, ctx) => {
      const text = ctx.priceOverride !== undefined ? ctx.priceOverride : p.price;
      const isOverridden = ctx.priceOverride !== undefined && ctx.priceOverride !== (p.price ?? '');
      const mText = ctx.mpriceOverride !== undefined ? ctx.mpriceOverride : (p.mprice ?? '');
      const mOverridden = ctx.mpriceOverride !== undefined && ctx.mpriceOverride !== (p.mprice ?? '');
      return (
        <>
          <PriceEditor
            value={text}
            isOverridden={isOverridden}
            placeholder={p.price ? '' : '待定价'}
            kind="price"
            onSave={(v) => ctx.onSavePrice?.(ctx.pid, v)}
            onClear={() => ctx.onClearPrice?.(ctx.pid)}
          />
          {p.priceNote && !isOverridden && <span className={`ml-1 text-[10px] ${RED}`}>{p.priceNote}</span>}
          {tpl === 'mazong' && (p.mprice || ctx.mpriceOverride !== undefined) && (
            <div className="mt-0.5">
              <PriceEditor
                value={mText}
                isOverridden={mOverridden}
                placeholder="马总价"
                kind="mprice"
                onSave={(v) => ctx.onSaveMprice?.(ctx.pid, v)}
                onClear={() => ctx.onClearMprice?.(ctx.pid)}
              />
            </div>
          )}
        </>
      );
    },
    aggregateRender: (ps, tpl, ctx) => {
      // 多款号：每个款号独立可编辑（不强制 "/" 拼接，避免改一个款号得重排其它款的视觉）
      return (
        <>
          {ps.map((p) => {
            const ov = ctx.priceOverrides?.[p.id];
            const text = ov !== undefined ? ov : p.price;
            const isOverridden = ov !== undefined && ov !== (p.price ?? '');
            return (
              <div key={p.id} className="leading-5">
                <PriceEditor
                  value={text}
                  isOverridden={isOverridden}
                  placeholder={p.price ? '' : '待定价'}
                  kind="price"
                  onSave={(v) => ctx.onSavePrice?.(p.id, v)}
                  onClear={() => ctx.onClearPrice?.(p.id)}
                />
              </div>
            );
          })}
          {tpl === 'mazong' && ps.some((p) => p.mprice || ctx.mpriceOverrides?.[p.id] !== undefined) && (
            <div className="mt-1 border-t border-edge-muted" />
          )}
          {tpl === 'mazong' && ps.map((p) => {
            const ov = ctx.mpriceOverrides?.[p.id];
            const hasM = p.mprice || ov !== undefined;
            if (!hasM) return null;
            const text = ov !== undefined ? ov : (p.mprice ?? '');
            const isOverridden = ov !== undefined && ov !== (p.mprice ?? '');
            return (
              <div key={p.id} className="leading-5">
                <PriceEditor
                  value={text}
                  isOverridden={isOverridden}
                  placeholder="马总价"
                  kind="mprice"
                  onSave={(v) => ctx.onSaveMprice?.(p.id, v)}
                  onClear={() => ctx.onClearMprice?.(p.id)}
                />
              </div>
            );
          })}
        </>
      );
    },
  },
  {
    label: '成本/倍率',
    show: () => true,
    aggregate: true, // 多款号时合并展示（每款独立可编辑）
    // 成本：BOM bom商品成本（BI ETL）；倍率 = 售价 / 成本，显示 1 位小数
    // 整行（cost + "/" + ratio）都可点击编辑，跟售价行 UX 一致
    render: (p, tpl, ctx) => {
      const raw = ctx.costOverride !== undefined ? ctx.costOverride : (p.bomCost ?? '');
      const text = roundCost(raw);
      const isOverridden = ctx.costOverride !== undefined && ctx.costOverride !== (p.bomCost ?? '');
      // 倍率：手动售价 override 优先（BI 没拉到价时尤其重要）；没有 override 再走 BI 价
      const priceNum = effectivePrice(ctx.priceOverride, p);
      const ratio = priceNum > 0 ? ratioOf(priceNum, raw) : '';
      const mcostText = roundCost(ctx.mcostOverride ?? '');
      const mcostRaw = ctx.mcostOverride !== undefined ? ctx.mcostOverride : '';
      const mpriceNum = effectiveMprice(ctx.mpriceOverride, p);
      const mcostRatio = (Number.isFinite(Number(mcostRaw)) && Number(mcostRaw) > 0 && mpriceNum > 0)
        ? ratioOf(mpriceNum, mcostRaw)
        : '';
      return (
        <div className="leading-5">
          <CostRatioRow
            text={text}
            isOverridden={isOverridden}
            ratio={ratio || '—'}
            ratioClass={ratio ? 'text-ink-primary' : 'text-ink-faint'}
            placeholder={p.bomCost ? '' : '待录成本'}
            onSave={(v) => ctx.onSaveCost?.(ctx.pid, v)}
            onClear={() => ctx.onClearCost?.(ctx.pid)}
          />
          {tpl === 'mazong' && (
            <div className="mt-0.5">
              <CostEditor
                value={mcostText}
                isOverridden={ctx.mcostOverride !== undefined && ctx.mcostOverride !== ''}
                placeholder="马总成本"
                kind="mcost"
                onSave={(v) => ctx.onSaveMcost?.(ctx.pid, v)}
                onClear={() => ctx.onClearMcost?.(ctx.pid)}
              />
              <span className="ml-1 text-ink-faint">/</span>
              <span className={mcostRatio ? 'text-ink-primary' : 'text-ink-faint'}>{mcostRatio || '—'}</span>
            </div>
          )}
        </div>
      );
    },
    aggregateRender: (ps, tpl, ctx) => {
      return (
        <>
          {ps.map((p) => {
            const raw = ctx.costOverrides?.[p.id];
            const rawVal = raw !== undefined ? raw : (p.bomCost ?? '');
            const text = roundCost(rawVal);
            const isOverridden = raw !== undefined && raw !== (p.bomCost ?? '');
            // 倍率：手动售价 override 优先；BI 未拉价时尤其关键
            const priceNum = effectivePrice(ctx.priceOverrides?.[p.id], p);
            const ratio = priceNum > 0 ? ratioOf(priceNum, rawVal) : '';
            return (
              <div key={p.id} className="leading-5">
                <CostRatioRow
                  text={text}
                  isOverridden={isOverridden}
                  ratio={ratio || '—'}
                  ratioClass={ratio ? 'text-ink-primary' : 'text-ink-faint'}
                  placeholder={p.bomCost ? '' : '待录成本'}
                  onSave={(v) => ctx.onSaveCost?.(p.id, v)}
                  onClear={() => ctx.onClearCost?.(p.id)}
                />
              </div>
            );
          })}
          {tpl === 'mazong' && ps.some((p) => p.mprice || ctx.mcostOverrides?.[p.id] !== undefined) && (
            <div className="mt-1 border-t border-edge-muted" />
          )}
          {tpl === 'mazong' && ps.map((p) => {
            const ov = ctx.mcostOverrides?.[p.id];
            const mpriceOv = ctx.mpriceOverrides?.[p.id];
            const hasM = p.mprice || ov !== undefined || mpriceOv !== undefined;
            if (!hasM) return null;
            const text = roundCost(ov !== undefined ? ov : '');
            const isOverridden = ov !== undefined && ov !== '';
            const mpriceNum = effectiveMprice(mpriceOv, p);
            const ratio = (ov !== undefined && Number(ov) > 0 && mpriceNum > 0) ? ratioOf(mpriceNum, ov) : '';
            return (
              <div key={p.id} className="leading-5">
                <div className="flex items-center justify-center gap-0.5">
                  <CostEditor
                    value={text}
                    isOverridden={isOverridden}
                    placeholder="马总成本"
                    kind="mcost"
                    onSave={(v) => ctx.onSaveMcost?.(p.id, v)}
                    onClear={() => ctx.onClearMcost?.(p.id)}
                  />
                  <span className="text-ink-faint">/</span>
                  <span className={ratio ? 'text-ink-primary' : 'text-ink-faint'}>{ratio || '—'}</span>
                </div>
              </div>
            );
          })}
        </>
      );
    },
  },
  {
    label: '库存情况（主仓）',
    show: () => true,
    render: (p, _tpl) => {
      const stockLines = p.stock ?? [];
      if (stockLines.length === 0) {
        // 领猫款（biOnly=false/undefined）：领猫里没库存数据 → 显示 —
        if (!p.biOnly) {
          return <div className="w-full text-center text-[10.5px] text-ink-faint leading-5">—</div>;
        }
        // BI 独有款（biOnly=true）：用 BI/款式卡的 stockMain 展示；现货 0 不写「现货0」
        return (
          <div className="w-full text-center text-ink-primary text-[11px] leading-5">
            {(p.stockMain ?? 0) > 0 && `现货${p.stockMain}`}
            {(p.inTransit ?? 0) > 0 && ` · 在途${p.inTransit}`}
            {(p.stockMain ?? 0) <= 0 && (p.inTransit ?? 0) <= 0 && '—'}
          </div>
        );
      }
      const parsed = stockLines.map((s) => parseStockLine(s, p.colors ?? []));
      // 按颜色聚合（每色内可能有 现货/在途/交期/占单）
      const byColor = new Map<string, { stock: number; inTransit: number; eta: string | null; orderBook: number }>();
      for (const e of parsed) {
        const key = e.color || '其他';
        const cur = byColor.get(key) || { stock: 0, inTransit: 0, eta: null, orderBook: 0 };
        cur.stock = Math.max(cur.stock, e.stock);
        cur.inTransit = Math.max(cur.inTransit, e.inTransit);
        cur.orderBook = Math.max(cur.orderBook, e.orderBook);
        if (e.eta && !cur.eta) cur.eta = e.eta;
        byColor.set(key, cur);
      }
      const lines = [...byColor.entries()].map(([color, v]) => {
        // 现货为 0 时不写「现货0」（用户口径：0 现货等于没这句），有在途/交期/占单照样显示
        const parts: string[] = [];
        if (v.stock > 0) parts.push(`现货${v.stock}`);
        if (v.inTransit > 0) parts.push(`在途${v.inTransit}`);
        if (v.eta) parts.push(`${v.eta}交`);
        if (v.orderBook > 0) parts.push(`占单${v.orderBook}`);
        return { color, text: `${color}：${parts.join(' ') || '—'}` };
      });
      return (
        <div className="w-full text-center text-ink-primary leading-5">
          {lines.map((l) => (
            <div key={l.color} className="text-[11px]">
              {l.text}
            </div>
          ))}
        </div>
      );
    },
  },
  {
    label: '翻单周期（下单日开始计算）',
    labelCls: BLUE,
    show: (t) => t !== 'talent',
    aggregate: true,
    render: (p) => <div className={`${RED} text-[14px] font-bold w-full leading-5 whitespace-pre-line`}>{p.restock}</div>,
    aggregateRender: (ps, _tpl, ctx) => {
      const pids = ps.map((p) => p.id);
      const restockOverrides = ctx.restockOverrides || {};
      // 多款号坑位：给每行翻单文案加产品短名前缀（圆领针织套衫/V领针织套衫 → 圆领/V领），
      // 否则两个款的色卡行混在一起分不清归属。单款坑位不加，保持原样。
      const shortNames = computeRestockShortNames(ps, ctx.restockShortNames);
      const rows = pids.map((pid) => {
        const raw = restockOverrides[pid] ?? ps.find((p) => p.id === pid)?.restock ?? '';
        const short = shortNames.get(pid);
        let text = raw && short
          ? raw.split('\n').map((line) => (line.trim() ? `${short} ${line}` : line)).join('\n')
          : raw;
        // 行内去重：上游回传的文案可能同一色出现两行（如 SKC 重复），显示时合并
        if (text) {
          const seen = new Set<string>();
          text = text.split('\n').filter((line) => {
            if (!line.trim()) return true;
            if (seen.has(line)) return false;
            seen.add(line);
            return true;
          }).join('\n');
        }
        return { pid, text, raw };
      });
      // 多款号时按 raw 内容（不带前缀）去重：sales.html 一次回传同一段文字会给每个 pid 都写一份，
      // 若按「加前缀后的 text」去重，前缀不同的行会重复显示（如「极简短款通勤西装 咖色千鸟格 200件25天」和「裤 咖色千鸟格 200件25天」同时出现）。
      // 同一段 raw 出现在多个 pid 上时，挑 short name 最长的那个 pid（更具有区分性），用它重建前缀——
      // 否则前缀会用 pids 数组里第一个 pid 的，可能只是个「裤」之类的弱标识。
      const byRaw = new Map<string, typeof rows>();
      for (const r of rows) {
        if (!r.text) continue;
        const key = r.raw || r.text;
        if (!byRaw.has(key)) byRaw.set(key, []);
        byRaw.get(key)!.push(r);
      }
      const visibleRows = Array.from(byRaw.values()).map((group) => {
        if (group.length === 1) return group[0];
        const shorts = group.map((r) => shortNames.get(r.pid) || '').filter(Boolean);
        const allSameShort = shorts.length > 0 && shorts.every((s) => s === shorts[0]);
        // 款号短名不同（如 卫衣 vs 卫裤）但翻单文案相同：分别显示，不能合并成一条
        if (!allSameShort) {
          const dedupedLines = new Set<string>();
          const text = group
            .map((r) => {
              const short = shortNames.get(r.pid) || '';
              return r.raw
                .split('\n')
                .map((line) => (line.trim() ? `${short} ${line}` : line))
                .join('\n');
            })
            .join('\n')
            .split('\n')
            .filter((line) => {
              if (!line.trim()) return true;
              if (dedupedLines.has(line)) return false;
              dedupedLines.add(line);
              return true;
            })
            .join('\n');
          return { ...group[0], text };
        }
        const best = group.reduce((a, b) => (shortNames.get(b.pid) || '').length > (shortNames.get(a.pid) || '').length ? b : a);
        const bestShort = shortNames.get(best.pid);
        if (bestShort && best.raw) {
          const rebuilt = best.raw.split('\n').map((line) => (line.trim() ? `${bestShort} ${line}` : line)).join('\n');
          // 行内去重（rebuild 之后）
          const seen = new Set<string>();
          const deduped = rebuilt.split('\n').filter((line) => {
            if (!line.trim()) return true;
            if (seen.has(line)) return false;
            seen.add(line);
            return true;
          }).join('\n');
          return { ...best, text: deduped };
        }
        return best;
      });
      const hasAnyContent = visibleRows.length > 0;
      return (
        <div
          className={`group relative w-full min-h-[28px] flex items-center justify-center text-center ${!hasAnyContent ? 'cursor-pointer' : ''}`}
          onClick={!hasAnyContent ? () => ctx.onPickRestock?.(ctx.lookId) : undefined}
          title={!hasAnyContent ? `查询翻单（${pids.map((p) => p.toUpperCase()).join('、')}）` : undefined}
        >
          <div className={`${RED} leading-5 w-full`}>
            {hasAnyContent ? visibleRows.map(({ pid, text }) => (
              <div key={pid} className="text-[14px] font-bold mb-0.5 last:mb-0 whitespace-pre-line">{text}</div>
            )) : (
              <div className="text-[11px] leading-5 whitespace-pre-line text-ink-faint min-h-[20px]" />
            )}
          </div>
          <div className="absolute inset-y-0 right-0 z-10 flex items-center gap-0.5 pr-1 print:hidden opacity-0 transition-opacity group-hover/cell:opacity-100 group-hover:opacity-100">
            <button
              onClick={(e) => {
                e.stopPropagation();
                ctx.onPickRestock?.(ctx.lookId);
              }}
              className="rounded-md p-1.5 text-ink-faint hover:bg-surface-subtle hover:text-ink-primary transition-colors"
              title={hasAnyContent ? `编辑翻单（${pids.map((p) => p.toUpperCase()).join('、')}）` : `查询翻单（${pids.map((p) => p.toUpperCase()).join('、')}）`}
            >
              {hasAnyContent ? <Pencil size={12} /> : <Search size={12} />}
            </button>
          </div>
        </div>
      );
    },
  },
  {
    label: '面料情况',
    labelCls: BLUE,
    show: (t) => t === 'mazong',
    aggregate: true,
    render: (p, _t, ctx) => {
      // 单 pid 兜底（理论上不会再走到，因为面料情况已 aggregate）
      const allItems = (ctx.noRestockItems || []).filter((it) => it.pid.toLowerCase() === ctx.pid.toLowerCase());
      const hasRealFabric = Boolean(
        (ctx.fabricOverride ?? '').trim() || (!isFabricNoise(p.fabric) && (p.fabric ?? '').trim()),
      );
      const items = effectiveNoRestockItems(allItems, hasRealFabric);
      const noRestockLines = items.map((it) => {
        const c = (it.color || '').trim();
        if (!c || c === '-') return '无面料不翻单';
        return `${c}无面料不翻单`;
      });
      let text = '';
      if (noRestockLines.length > 0) text = noRestockLines.join('\n');
      else if (ctx.fabricOverride !== undefined) text = ctx.fabricOverride;
      else {
        const base = isFabricNoise(p.fabric) ? '' : (p.fabric ?? '');
        const note = (ctx.fabricNotes || {})[ctx.pid];
        text = [base, note].filter(Boolean).join('\n');
      }
      text = cleanFabricText(text);
      return (
        <div className={`${BLUE} w-full leading-4 whitespace-pre-line`}>{text || <span className="text-ink-faint">—</span>}</div>
      );
    },
    aggregateRender: (ps, _tpl, ctx) => {
      // 一格内按 pid 堆叠；每个 pid 的文本/注脚/清除按钮独立；只有一个放大镜（一次性搜所有 pid）
      const pids = ps.map((p) => p.id);
      const fabricOverrides = ctx.fabricOverrides || {};
      const fabricNotes = ctx.fabricNotes || {};
      const noRestockItems = ctx.noRestockItems || [];
      const rows = ps.map((p) => {
        const pid = p.id;
        const allItems = noRestockItems.filter((it) => it.pid.toLowerCase() === pid.toLowerCase());
        const hasRealFabric = Boolean(
          (fabricOverrides[pid] ?? '').trim() || (!isFabricNoise(p.fabric) && (p.fabric ?? '').trim()),
        );
        const items = effectiveNoRestockItems(allItems, hasRealFabric);
        const noRestockLines = items.map((it) => {
          const c = (it.color || '').trim();
          if (!c || c === '-') return '无面料不翻单';
          return `${c}无面料不翻单`;
        });
        const hasNoRestock = noRestockLines.length > 0;
        let base = '';
        let note = '';
        if (hasNoRestock) {
          base = noRestockLines.join('\n');
        } else if (fabricOverrides[pid] !== undefined) {
          base = fabricOverrides[pid];
        } else {
          // BI 自带面料里只写「羊毛/棉」这种材质词时视为噪音，不展示
          base = isFabricNoise(p.fabric) ? '' : (p.fabric ?? '');
        }
        base = cleanFabricText(base);
        note = fabricNotes[pid] || '';
        const hasNote = note.trim().length > 0;
        const text = hasNote ? `${base}\n※ ${note}` : base;
        return { pid, text, base, note, hasNote, hasNoRestock };
      });
      const visibleRows = rows.filter((r) => r.text);
      const hasAnyContent = visibleRows.length > 0;
      // 悬停 350ms 后自动拿所有 pid 去 fabric_Q 查面料——展示在右下角小卡片里
      const hoverHandlers = ctx.onHoverFabric
        ? {
            onMouseEnter: (e: React.MouseEvent<HTMLDivElement>) => {
              ctx.onHoverFabric?.(ctx.allPids ?? ps.map((x) => x.id), e.currentTarget);
            },
            onMouseLeave: () => ctx.onLeaveFabric?.(),
          }
        : {};
      return (
        <div className="group relative w-full text-center" {...hoverHandlers}>
          <div className="space-y-1">
            {hasAnyContent ? visibleRows.map(({ pid, base, hasNote, hasNoRestock, note }) => (
              <div key={pid} className={`${hasNoRestock ? RED : BLUE} group/row w-full leading-4 whitespace-pre-line`}>
                {base && (
                  <span className="group/base inline-block max-w-full whitespace-pre-line align-top">
                    {base}
                    {!hasNoRestock && ctx.onClearFabric && (
                      <button
                        onClick={(e) => { e.stopPropagation(); ctx.onClearFabric?.(pid); }}
                        className="ml-1 hidden rounded px-1 align-middle text-[10px] text-ink-faint hover:bg-action-danger/10 hover:text-action-danger-fg group-hover/base:inline"
                        title="隐藏面料信息"
                      >
                        ✕
                      </button>
                    )}
                  </span>
                )}
                {!hasNoRestock && !hasNote && ctx.onSaveFabricNote && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      const v = window.prompt(`为款号 ${pid.toUpperCase()} 添加面料注脚`, '');
                      if (v == null) return;
                      const trimmed = v.trim();
                      if (!trimmed) return;
                      ctx.onSaveFabricNote?.(pid, trimmed);
                    }}
                    className="ml-1 hidden rounded px-1 align-middle text-[10px] text-ink-faint hover:bg-surface-subtle hover:text-ink-primary group-hover/row:inline"
                    title="添加面料注脚"
                  >
                    ＋注脚
                  </button>
                )}
                {hasNote && (
                  <div
                    onClick={() => {
                      const v = window.prompt(`编辑款号 ${pid.toUpperCase()} 的面料注脚（留空删除）`, note);
                      if (v === null) return;
                      const trimmed = v.trim();
                      if (!trimmed) ctx.onClearFabricNote?.(pid);
                      else ctx.onSaveFabricNote?.(pid, trimmed);
                    }}
                    className="group/note mt-0.5 inline-block max-w-full cursor-text whitespace-pre-line rounded italic text-ink-muted hover:bg-surface-subtle hover:text-ink-primary"
                    title="点击编辑 / 留空删除"
                  >
                    ※ {note}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        ctx.onClearFabricNote?.(pid);
                      }}
                      className="ml-1 hidden rounded px-1 text-[10px] text-ink-faint hover:bg-action-danger/10 hover:text-action-danger-fg group-hover/note:inline"
                      title="删除注脚"
                    >
                      ✕
                    </button>
                  </div>
                )}
              </div>
            )) : (
              <div className={`${BLUE} w-full leading-4 whitespace-pre-line`} />)}
          </div>
          <div className="absolute inset-y-0 right-0 z-10 flex items-center gap-0.5 pr-1 print:hidden opacity-0 transition-opacity group-hover/cell:opacity-100 group-hover:opacity-100">
            <button
              onClick={() => ctx.onPickFabric?.(ctx.pid)}
              className="rounded-md p-1.5 text-ink-faint hover:bg-surface-subtle hover:text-ink-primary transition-colors"
              title={hasAnyContent ? `编辑面料（${pids.map((p) => p.toUpperCase()).join('、')}）` : `查询面料（${pids.map((p) => p.toUpperCase()).join('、')}）`}
            >
              {hasAnyContent ? <Pencil size={12} /> : <Search size={12} />}
            </button>
          </div>
        </div>
      );
    },
  },
  {
    label: '直播当天销量',
    labelCls: 'text-action-primary',
    show: (t) => t === 'mazong',
    aggregate: true,
    aggregateRender: (ps, _tpl, ctx) => {
      // 未播完（future / today）不显示
      if (!ctx.pastDate) return null;
      const total = ps.reduce((sum, p) => sum + ((ctx.salesByPid?.daily || {})[p.id] || 0), 0);
      if (total === 0) return null;
      return (
        <span className="text-action-primary" title={`直播当天 (${ctx.pastDate}) 销量`}>
          <strong className="font-semibold">{total}</strong> 件
        </span>
      );
    },
    render: (p, _t, ctx) => {
      if (!ctx.pastDate) return null;
      const qty = (ctx.salesByPid?.daily || {})[p.id] || 0;
      if (qty === 0) return null;
      return <span className="text-action-primary"><strong className="font-semibold">{qty}</strong> 件</span>;
    },
  },
  {
    label: '累计销量',
    labelCls: 'text-ink-secondary',
    show: (t) => t === 'mazong',
    aggregate: true,
    aggregateRender: (ps, _tpl, ctx) => {
      if (!ctx.pastDate) return null;
      const total = ps.reduce((sum, p) => sum + ((ctx.salesByPid?.cumulative || {})[p.id] || 0), 0);
      if (total === 0) return null;
      return (
        <span className="text-ink-secondary" title="累计总销量（款级，来自 BI 宽表）">
          <strong className="font-semibold">{total}</strong> 件
        </span>
      );
    },
    render: (p, _t, ctx) => {
      if (!ctx.pastDate) return null;
      const qty = (ctx.salesByPid?.cumulative || {})[p.id] || 0;
      if (qty === 0) return null;
      return <span className="text-ink-secondary"><strong className="font-semibold">{qty}</strong> 件</span>;
    },
  },
];

// ── 主页面 ──
export default function TraysPage({
  trays, activeTrayId, onOpenTray, onCreateTray, onUpdateTray, onDeleteTray, onSync,
  syncing, dataVersion,
}: {
  trays: Tray[];
  activeTrayId: string;
  onOpenTray: (id: string) => void;
  onCreateTray: (name: string, type: TrayType, date: string) => Tray;
  onUpdateTray: (t: Tray) => void;
  onDeleteTray: (id: string) => void;
  onSync: (kind: '商品' | '库存' | '成本及价格') => void;
  syncing: '商品' | '库存' | '成本及价格' | null;
  dataVersion: number;
}) {
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<TrayType>('马总直播货盘');
  const [date, setDate] = useState('');
  const [editingDate, setEditingDate] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [picker, setPicker] = useState<{ sectionId: string; lookIdx?: number } | null>(null);
  const [menuLookId, setMenuLookId] = useState<string | null>(null);
  const [coverMenu, setCoverMenu] = useState<{ sectionId: string; lookId: string } | null>(null);
  const [fabricPicker, setFabricPicker] = useState<{ sectionId: string; lookId: string; pid: string } | null>(null);
  const [restockPicker, setRestockPicker] = useState<{ sectionId: string; lookId: string } | null>(null);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  // 修改记录抽屉：右侧滑出，读 /api/trays/log
  const [showLog, setShowLog] = useState(false);
  const [logEntries, setLogEntries] = useState<TrayOpLogEntry[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  useEffect(() => {
    if (!picker && !coverMenu && !fabricPicker && !restockPicker && !showLog) return;
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement as HTMLElement | null;
    document.body.style.overflow = 'hidden';
    const dialog = document.querySelector<HTMLElement>('.product-picker, .cover-dialog, .tray-iframe-dialog, .tray-history');
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled):not([type="hidden"]), select, textarea, iframe, [tabindex="0"]') ?? []).filter((el) => el.getClientRects().length > 0);
    focusable()[0]?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPicker(null); setCoverMenu(null); setFabricPicker(null); setRestockPicker(null); setShowLog(false);
      }
      if (event.key === 'Tab') {
        const items = focusable();
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [picker, coverMenu, fabricPicker, restockPicker, showLog]);
  // 删除确认弹窗：点击 trash 图标先 set 这个，再渲染 Radix AlertDialog 二次确认
  //   避免之前 window.confirm 在某些场景下被自动 dismiss 或被误点
  const [pendingDelete, setPendingDelete] = useState<Tray | null>(null);
  // 版块拖拽重排：{ fromId, overId, position: 'before' | 'after' }
  const [sectionDrag, setSectionDrag] = useState<{ fromId: string; overId: string; position: 'before' | 'after' } | null>(null);
  // WPS 核价表登录态：null=检查中; loggedIn=true/false 在按钮旁显示状态点
  // 同步完成后通过 dataVersion 触发重新检查
  const [hengjiStatus, setHengjiStatus] = useState<HengjiStatus | null>(null);
  // 面料悬停快查：移到某个坑位的「面料情况」上时，350ms 内自动查 fabric_Q
  const [fabricTip, setFabricTip] = useState<{
    sectionId: string; lookId: string; codes: string[];
    rect: DOMRect | null; data: any[] | null; loading: boolean; error: string | null;
  } | null>(null);
  const fabricTipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fabricTipAbort = useRef<AbortController | null>(null);
  // fabric_Q iframe ref（提到顶层避免 IIFE 内对象字面量被 React 重置）
  const fabricIframeRef = useRef<HTMLIFrameElement | null>(null);
  // 翻单弹窗（sales.html）iframe ref，同样提到顶层避免 IIFE 内对象字面量被 React 重置
  const salesIframeRef = useRef<HTMLIFrameElement | null>(null);
  // 鼠标进入锚点 → 350ms 后开始查（避免来回扫鼠标时频繁打接口）
  const onHoverFabricQuick = (codes: string[], anchorEl: HTMLElement) => {
    if (!codes || codes.length === 0) return;
    if (fabricTipTimer.current) clearTimeout(fabricTipTimer.current);
    const rect = anchorEl.getBoundingClientRect();
    // 如果已经在查同一个坑位，不要重置 loading 闪一下
    const sameLook = fabricTip && fabricTip.sectionId === undefined /* sectionId not in scope here */;
    setFabricTip({
      sectionId: '', lookId: '', codes,
      rect,
      data: sameLook ? fabricTip?.data ?? null : null,
      loading: sameLook ? !!fabricTip?.loading : true,
      error: null,
    });
    fabricTipTimer.current = setTimeout(() => {
      // 取最新 codes（防止用户在定时器期间又移到了另一个坑位）
      setFabricTip((cur) => cur ? { ...cur, loading: true, error: null } : cur);
      // 取消上一次进行中的请求
      fabricTipAbort.current?.abort();
      const ac = new AbortController();
      fabricTipAbort.current = ac;
      fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pdtCodes: codes.map((c) => c.toUpperCase()) }),
        signal: ac.signal,
      })
        .then((r) => r.ok ? r.json() : r.json().then((j) => Promise.reject(new Error(j.error || `HTTP ${r.status}`))))
        .then((j) => {
          setFabricTip((cur) => cur ? { ...cur, loading: false, data: j.data || [], error: null } : cur);
        })
        .catch((e) => {
          if (e?.name === 'AbortError') return;
          setFabricTip((cur) => cur ? { ...cur, loading: false, error: String(e?.message || e) } : cur);
        });
    }, 350);
  };
  // 180ms 延迟关闭，让用户能移到 tooltip 上（hoverable）
  const onLeaveFabricQuick = () => {
    if (fabricTipTimer.current) clearTimeout(fabricTipTimer.current);
    fabricTipTimer.current = setTimeout(() => {
      fabricTipAbort.current?.abort();
      setFabricTip(null);
    }, 180);
  };
  // tooltip 内 hover 时保持显示
  const onTipEnter = () => {
    if (fabricTipTimer.current) clearTimeout(fabricTipTimer.current);
  };
  const onTipLeave = onLeaveFabricQuick;
  // 当前货盘的实时引用：postMessage 监听器是长生命周期闭包，若直接用闭包里的 tray，
  // 会拿旧快照覆盖整个 tray（fabric-selected 一写就把刚标记的 noRestockItems 冲掉）
  const trayRef = useRef<Tray | null>(null);
  // 消息回写统一走这里：始终基于最新 tray 计算
  const updLatest = (fn: (t: Tray) => Tray) => {
    const t = trayRef.current;
    if (!t) return;
    onUpdateTray(fn(t));
  };

  // 监听 fabric_Q iframe 发回的 postMessage（面料信息回填 + 无面料不翻单 SKC 标记）
  useEffect(() => {
    function onMsg(ev: MessageEvent) {
      if (!ev.data || typeof ev.data !== 'object') return;
      // 面料文本回填
      if (ev.data.type === 'fabric-selected' && ev.data.source === 'fabric-query') {
        const text: string = String(ev.data.payload?.text || '').trim();
        if (!text || !fabricPicker) return;
        updLatest((t) => ({
          ...t,
          fabricOverrides: { ...(t.fabricOverrides || {}), [fabricPicker.pid]: text },
          // 面料信息已拿到：之前「查无此款」时留下的占位标记（skc='-'）作废，避免红字残留。
          // 具体 SKC 的勾选标记保留（那是逐色显式勾的）。
          noRestockItems: (t.noRestockItems || []).filter(
            (it) => !(it.pid.toLowerCase() === fabricPicker.pid.toLowerCase() && (it.skc === '-' || !it.skc)),
          ),
        }));
        toast.success('面料信息已写入货盘');
        setFabricPicker(null);
        return;
      }
      // 面料文案为空但用户已勾选无面料不翻单：关闭弹窗，noRestock 已通过 fabric-no-restock 写入
      if (ev.data.type === 'fabric-selected-empty' && ev.data.source === 'fabric-query') {
        if (!fabricPicker) return;
        toast.success('已保存无面料不翻单标记');
        setFabricPicker(null);
        return;
      }
      // sales.html 翻单信息回填：写入 restockOverrides + plannedRestockItems（每批次 1 条），并 toast
      if (ev.data.type === 'restock-selected' && ev.data.source === 'sales-page') {
        const pids: string[] = Array.isArray(ev.data.pids) ? ev.data.pids.map((x: string) => String(x).toLowerCase()) : [];
        const text: string = String(ev.data.payload?.text || '').trim();
        // 按款号分组的翻单文案（西装 vs 裤 的色卡分开——避免共用同一段文字导致前缀错乱）
        const textByPdt: Record<string, string> = (() => {
          const raw = ev.data.text_by_pdt;
          if (!raw || typeof raw !== 'object') return {};
          const out: Record<string, string> = {};
          for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
            const s = String(v || '').trim();
            if (s) out[String(k).toLowerCase()] = s;
          }
          return out;
        })();
        // 结构化：[{ pdt, skc, color, pieces, days, _source? }, ...] —— 每批次 1 条，与钉钉表 1:1 对齐
        const items: Array<{ pdt?: string; skc?: string; color?: string; pieces?: number; days?: number; _source?: string }> =
          Array.isArray(ev.data.items) ? ev.data.items : [];
        const allSkcs: string[] = Array.isArray(ev.data.all_skcs) ? ev.data.all_skcs : [];
        if (pids.length === 0) return;
        // 修复：空提交（reset 后再提交）也要走完流程——清空 override + 关弹窗。
        // 原来 `(!text && items.length === 0)` 会直接 return，导致重置后弹窗关不掉、override 也漏清。
        // 现在只在三个信号都空时才进入空提交分支（清空 override + 关弹窗）。
        const allEmpty = !text && items.length === 0 && Object.keys(textByPdt).length === 0;
        if (allEmpty) {
          // 空提交：仍然要清掉这些 pid 的 override（用户重置后再提交 = 期望把货盘里的旧翻单文案也清掉）
          // 之前直接 return 漏了这一步，货盘里的旧文案残留
          updLatest((t) => {
            const nextOverrides = { ...(t.restockOverrides || {}) };
            for (const pid of pids) nextOverrides[pid] = '';
            return {
              ...t,
              restockOverrides: nextOverrides,
              plannedRestockItems: (t.plannedRestockItems || []).filter((x) => !pids.includes(x.pdt)),
              sampleRestockItems: (t.sampleRestockItems || []).filter((x) => !pids.includes(x.pdt)),
            };
          });
          toast.info('无翻单信息可同步');
          setRestockPicker(null);
          return;
        }
        console.log('[TraysPage] 收到 restock-selected: pids=', pids, 'text_by_pdt keys=', Object.keys(textByPdt), 'text_by_pdt=', textByPdt);
        // 在 callback 外面算 itemsNorm（updLatest 异步，toast.success 在外面读不到 callback 内的变量）
        const itemsNorm = items
          .map((it) => ({
            pdt: String(it.pdt || '').toLowerCase(),
            skc: String(it.skc || '').toLowerCase(),
            color: it.color || '',
            pieces: Number(it.pieces) || 0,
            days: Number(it.days) || 0,
            _source: it._source === 'sample' ? ('sample' as const) : undefined,
          }))
          .filter((it) => it.pdt && it.skc);
        // 治本：本次 itemsNorm 按 (pdt, skc, pieces, days) 去重（同一批次只留 1 条）
        // 避免 sales.html 多次同步时累加重复；用户多次提交=后一次覆盖前一次的同 pid 批次
        const normDedupMap = new Map<string, typeof itemsNorm[number]>();
        for (const it of itemsNorm) {
          normDedupMap.set(`${it.pdt}|${it.skc}|${it.pieces}|${it.days}|${it._source || ''}`, it);
        }
        const itemsNormDedup = Array.from(normDedupMap.values());
        updLatest((t) => {
          const nextOverrides = { ...(t.restockOverrides || {}) };
          if (Object.keys(textByPdt).length > 0) {
            // 新路径：按款号分别写（多款号坑位不会共用同一段文案）
            for (const pid of pids) {
              const pdtText = textByPdt[pid];
              if (pdtText !== undefined) nextOverrides[pid] = pdtText;
              else if (text) nextOverrides[pid] = text; // 兜底：没分到组的用完整 text
            }
          } else if (text) {
            // 旧路径：所有 pid 写同一段 text（兼容未升级的 fabric_Q）
            for (const pid of pids) nextOverrides[pid] = text;
          } else {
            // 修复：fabric_Q 提交的是「空翻单」（用户重置后再提交），必须清空这些 pid 的 override
            // 设成空串 "" 而不是 delete：restockCellText 的 `??` 不会把空串当 nullish，cell 就显示空而不是 p.restock 默认值
            for (const pid of pids) nextOverrides[pid] = '';
          }
          // plannedRestockItems: 整段替换「本次 pids」的批次，其他 pid 的保留
          // 同一 pid 多次提交 = 后一次覆盖前一次（之前累积的同 pid 旧批次被本次 itemsNormDedup 顶掉）
          // 驼色等样衣色（_source='sample'）单独存到 sampleRestockItems，不混进大货批次
          const craftItems = itemsNormDedup
            .filter((it) => it._source !== 'sample')
            .map(({ _source, ...rest }) => rest);
          const sampleItems = itemsNormDedup
            .filter((it): it is typeof it & { _source: 'sample' } => it._source === 'sample')
            .map((it) => ({ pdt: it.pdt, skc: it.skc, color: it.color, pieces: it.pieces, days: it.days, _source: it._source }));
          const existingCraft = (t.plannedRestockItems || []).filter((x) => !pids.includes(x.pdt));
          const existingSample = (t.sampleRestockItems || []).filter((x) => !pids.includes(x.pdt));
          const nextAllSkcs = { ...(t.plannedRestockAllSkcs || {}) };
          for (const pid of pids) {
            if (allSkcs.length > 0) nextAllSkcs[pid] = [...allSkcs];
          }
          return {
            ...t,
            restockOverrides: nextOverrides,
            plannedRestockItems: [...existingCraft, ...craftItems],
            sampleRestockItems: [...existingSample, ...sampleItems],
            plannedRestockAllSkcs: nextAllSkcs,
          };
        });
        toast.success(`翻单信息已同步至货盘（${pids.length} 个款号，${itemsNormDedup.length} 条批次）`);
        setRestockPicker(null);
        return;
      }
      // 无面料不翻单（SKC 级）：在 fabric_Q 结果表格里勾选 checkbox 后同步到货盘
      if (ev.data.type === 'fabric-no-restock' && ev.data.skc) {
        const skc = String(ev.data.skc).toLowerCase();
        const pid = String(ev.data.pid || '').toLowerCase();
        const color = String(ev.data.color || '').trim();
        const fabric = String(ev.data.fabric || '').trim();
        const checked = !!ev.data.checked;
        updLatest((t) => {
          let cur = (t.noRestockItems || []).filter((it) => it.skc.toLowerCase() !== skc);
          // 清理旧占位：同一款号出现具体 SKC 标记时，删除之前 skc='-' 的兜底占位，
          // 避免用户取消具体 SKC 后，旧占位仍然导致「无面料不翻单」文案残留。
          const isRealSkc = skc && skc !== '-';
          if (isRealSkc) {
            cur = cur.filter((it) => !(it.pid.toLowerCase() === pid && it.skc === '-'));
          }
          const next = checked
            ? [...cur, { skc, pid, color, fabric }]
            : cur;
          // 若取消后该 pid 下已无任何具体 SKC 标记，连 skc='-' 兜底占位也清掉
          if (!checked) {
            const hasRealForPid = next.some((it) => it.pid.toLowerCase() === pid && it.skc && it.skc !== '-');
            if (!hasRealForPid) {
              return { ...t, noRestockItems: next.filter((it) => it.pid.toLowerCase() !== pid) };
            }
          }
          return { ...t, noRestockItems: next };
        });
        // 不弹 toast：用户连续勾多个 SKC 时频繁弹窗体验差；改用底部 silent 更新
      }
      // 无面料不翻单（全量快照）：fabric_Q 打开/查询后用 localStorage 里的已勾选状态一次性同步，
      // 不依赖用户手动点 checkbox（初始态不触发 onchange）
      // 注意：快照只代表「当前 fabric_Q 里展示的款号」的勾选态，不能用它删除货盘里其他款的标记。
      if (ev.data.type === 'fabric-no-restock-snapshot') {
        const rawItems: Array<Record<string, unknown>> = Array.isArray(ev.data.items) ? ev.data.items : [];
        const pids: string[] = Array.isArray(ev.data.pids) ? ev.data.pids.map((p: unknown) => String(p).toLowerCase()) : [];
        if (pids.filter(Boolean).length === 0) return;
        const incoming = rawItems
          .map((it) => ({
            skc: String(it?.skc ?? '').toLowerCase(),
            pid: String(it?.pid ?? '').toLowerCase(),
            color: String(it?.color ?? '').trim(),
            fabric: String(it?.fabric ?? '').trim(),
          }))
          .filter((it) => it.skc && it.pid);
        updLatest((t) => {
          // fabric_Q 的语义：pids 里的款号按 incoming 整组替换（取消勾选后快照不再带该 SKC，就要从货盘删掉）。
          // 不在 pids 里的款号不动（快照只代表这次查询覆盖的款号，不能删其他款的标记）。
          const snapPids = new Set(pids);
          const bySkc = new Map(
            (t.noRestockItems || []).filter((it) => !snapPids.has(it.pid)).map((it) => [it.skc, it]),
          );
          incoming.forEach((it) => bySkc.set(it.skc, it));
          const pidsWithRealSkc = new Set(
            incoming.filter((it) => it.skc && it.skc !== '-').map((it) => it.pid)
          );
          const next = [...bySkc.values()]
            .filter((it) => !(pidsWithRealSkc.has(it.pid) && it.skc === '-'))
            .sort((a, b) => `${a.pid}|${a.skc}`.localeCompare(`${b.pid}|${b.skc}`));
          const cur = [...(t.noRestockItems || [])].sort((a, b) => `${a.pid}|${a.skc}`.localeCompare(`${b.pid}|${b.skc}`));
          if (JSON.stringify(next) === JSON.stringify(cur)) return t;
          return { ...t, noRestockItems: next };
        });
        return;
      }
    }
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [fabricPicker]);

  const PRODUCTS = useProducts();
  // 兜底：坑位里的样衣/老款 pids 在 /api/products 里不存在，从 /api/samples 拉一次补到渲染
  // （逻辑在 useProductResolver 里，与 SequencePage 共用，保证两页查表结果一致）
  const allPids = useMemo(
    () => trays.flatMap((t) => t.sections.flatMap((s) => s.looks.flatMap((l) => l.pids))),
    [trays],
  );
  const fullById = useProductResolver(allPids);

  // 面料 row 用 + 翻单清单导出用：服务端 BI SKC 卡返回的 SKC 列表（[{code, color, plannedRestockQty}]）
  // plannedRestockQty 来自 BI「翻单量」列（bi-client.js getSkcsForCode 已提取）
  const [skcsByCode, setSkcsByCode] = useState<Record<string, Array<{ code: string; color: string; plannedRestockQty: number }>>>({});
  useEffect(() => {
    const ids = new Set<string>();
    for (const t of trays) for (const s of t.sections) for (const l of s.looks) for (const pid of l.pids) ids.add(pid);
    const list = [...ids];
    if (list.length === 0) return;
    let cancelled = false;
    authenticatedFetch(`${API_BASE}/products/skcs/by-ids?ids=${encodeURIComponent(list.join(','))}`)
      .then((r) => r.ok ? r.json() : { byCode: {} })
      .then((j) => { if (!cancelled) setSkcsByCode(j.byCode || {}); })
      .catch(() => { if (!cancelled) setSkcsByCode({}); });
    return () => { cancelled = true; };
  }, [trays, dataVersion]);

  // 样衣阶段颜色（黑巧/驼色等未转大货色）：批量拉所有 tray 款号的样衣 BOM，卡片颜色行追加展示
  // 服务端按款号缓存 1h，冷启动慢但在后台跑，不阻塞渲染
  const [sampleColorsByCode, setSampleColorsByCode] = useState<Record<string, string[]>>({});
  useEffect(() => {
    const ids = new Set<string>();
    for (const t of trays) for (const s of t.sections) for (const l of s.looks) for (const pid of l.pids) ids.add(pid);
    const list = [...ids];
    if (list.length === 0) return;
    let cancelled = false;
    fetchSampleMaterials(list)
      .then((r) => {
        if (cancelled) return;
        const byCode: Record<string, string[]> = {};
        for (const it of r.items || []) {
          const pid = it.smCode.toLowerCase();
          const color = (it.colorName || '').trim();
          if (!color) continue;
          if (!byCode[pid]) byCode[pid] = [];
          if (!byCode[pid].includes(color)) byCode[pid].push(color);
        }
        setSampleColorsByCode(byCode);
      })
      .catch(() => { /* 失败保留旧值，不清空（限流恢复后下次进页自动补上） */ });
    return () => { cancelled = true; };
  }, [trays, dataVersion]);

  // 尺码范围：批量拉所有 tray 里出现的款号，从 BI ETL 数据集聚合 "S~XL"
  // 依赖 dataVersion：每次「同步商品/库存」完成后重新拉（缓存被清掉了）
  // 说明：2026-09-29 砍掉了 localStorage 持久化缓存（曾因此前服务端返回过错尺码范围，
  // 旧脏值在客户端缓存里反复保留，刷新也清不掉）。代价是首屏短暂显示 `—`（<1s），
  // 但换来了任何后端数据/聚合逻辑变更都能即时生效。
  const [sizeByCode, setSizeByCode] = useState<Record<string, string>>({});
  useEffect(() => {
    const ids = new Set<string>();
    for (const t of trays) for (const s of t.sections) for (const l of s.looks) for (const pid of l.pids) ids.add(pid);
    const list = [...ids];
    if (list.length === 0) return;
    let cancelled = false;
    authenticatedFetch(`${API_BASE}/products/sizes/by-ids?ids=${encodeURIComponent(list.join(','))}`)
      .then((r) => r.ok ? r.json() : { byCode: {} })
      .then((j) => {
        if (cancelled) return;
        // 服务端响应是权威来源：直接替换，不继承任何可能的旧脏值
        setSizeByCode(j.byCode || {});
      })
      .catch(() => { /* 离线/失败：保留空对象，不回退到可能过期的缓存 */ });
    return () => { cancelled = true; };
  }, [trays, dataVersion]);
  // 检查 WPS 核价表登录态：进入页面 + 每次同步（dataVersion++）后重新检查
  // 失败/无登录态时按钮旁显示红点 + 提示，让用户提前知道同步会失败
  useEffect(() => {
    let cancelled = false;
    fetchHengjiStatus()
      .then((s) => { if (!cancelled) setHengjiStatus(s); })
      .catch(() => { if (!cancelled) setHengjiStatus({ ok: false, error: 'check_failed' }); });
    return () => { cancelled = true; };
  }, [dataVersion]);
  const fullByIdWithSize = useMemo(() => {
    if (Object.keys(sizeByCode).length === 0) return fullById;
    return (id: string) => {
      const p = fullById(id);
      const size = sizeByCode[id];
      return size ? { ...p, sizeRange: size } : p;
    };
  }, [fullById, sizeByCode]);

  // 销量（直播当天 + 累计总销量）：只在「已播完」的货盘（tray.date < 今天）才请求；未开播的不显示也不请求
  // 数据源：BI ETL e106807e71f8045669969e95「宽表关联后数据源」
  // 按 (tray.date, pids) 分组缓存 → 不同货盘不同日期各自一份
  const todayStr = useMemo(() => new Date().toISOString().slice(0, 10), []);
  // salesByDate[date] = { daily, cumulative } —— 仅缓存「已播完」日期（tray.date < todayStr）
  const [salesByDate, setSalesByDate] = useState<Record<string, {
    daily: Record<string, number>;
    cumulative: Record<string, number>;
  }>>({});
  useEffect(() => {
    // 找出所有「已播完」的货盘，按日期分组
    const byDate = new Map<string, Set<string>>();
    for (const t of trays) {
      if (!t.date || t.date >= todayStr) continue;
      if (!byDate.has(t.date)) byDate.set(t.date, new Set());
      for (const s of t.sections) for (const l of s.looks) for (const pid of l.pids) byDate.get(t.date)!.add(pid);
    }
    if (byDate.size === 0) {
      setSalesByDate({});
      return;
    }
    let alive = true;
    (async () => {
      const merged: typeof salesByDate = {};
      const dates = [...byDate.entries()];
      await Promise.all(dates.map(async ([date, pids]) => {
        try {
          const r = await fetchSalesSummary(date, [...pids]);
          if (!alive) return;
          merged[date] = { daily: r.daily || {}, cumulative: r.cumulative || {} };
        } catch {
          if (alive) merged[date] = { daily: {}, cumulative: {} };
        }
      }));
      if (alive) setSalesByDate(merged);
    })();
    return () => { alive = false; };
  }, [trays, todayStr]);

  // 当前打开的货盘销量快照：ctx 注入给 aggregateRender 用
  // 仅 tray.date < todayStr 时才有销量；否则给空快照，不渲染
  const salesByPid = useMemo(() => {
    const cur = trays.find((t) => t.id === activeTrayId);
    if (!cur?.date || cur.date >= todayStr) return { daily: {}, cumulative: {} };
    const slot = salesByDate[cur.date];
    return slot || { daily: {}, cumulative: {} };
  }, [trays, activeTrayId, todayStr, salesByDate]);

  // BOM 成本：批量拉所有 tray 里出现的款号，从 BI ETL 数据集取 bom商品成本 max
  const [costByCode, setCostByCode] = useState<Record<string, string>>({});
  useEffect(() => {
    const ids = new Set<string>();
    for (const t of trays) for (const s of t.sections) for (const l of s.looks) for (const pid of l.pids) ids.add(pid);
    const list = [...ids];
    if (list.length === 0) return;
    let cancelled = false;
    authenticatedFetch(`${API_BASE}/products/cost/by-ids?ids=${encodeURIComponent(list.join(','))}`)
      .then((r) => r.ok ? r.json() : { byCode: {} })
      .then((j) => { if (!cancelled) setCostByCode(j.byCode || {}); })
      .catch(() => { if (!cancelled) setCostByCode({}); });
    return () => { cancelled = true; };
  }, [trays]);
  const fullByIdWithCost = useMemo(() => {
    return (id: string) => {
      const p = fullByIdWithSize(id);
      // 成本来源优先级：手动 override > /api/cost/by-ids（领猫优先、BI 兜底）> 产品自带 costPrice（领猫）
      const cost = costByCode[id] || (p.costPrice ? String(p.costPrice) : '');
      return cost ? { ...p, bomCost: cost } : p;
    };
  }, [fullByIdWithSize, costByCode]);

  const tray = trays.find((t) => t.id === activeTrayId) ?? trays[0];
  // 修改记录抽屉：打开时拉一次；期间本地/远端更新也顺带刷新（靠 tray.updatedAt 变化触发）
  useEffect(() => {
    if (!showLog || !tray?.id) return;
    let cancelled = false;
    setLogLoading(true);
    fetchTrayLog(tray.id, 200)
      .then((r) => { if (!cancelled) setLogEntries(r.entries || []); })
      .catch(() => { if (!cancelled) setLogEntries([]); })
      .finally(() => { if (!cancelled) setLogLoading(false); });
    return () => { cancelled = true; };
  }, [showLog, tray?.id, tray?.updatedAt]);
  // 每次渲染刷新引用，保证 postMessage 回写基于最新货盘
  trayRef.current = tray;
  const visible = tray.sections.filter((s) => s.visible);
  const fields = FIELDS.filter((f) => f.show(tray.template));
  // 销量字段：仅「已播完」（tray.date < 今天）的货盘才显示；未开播/今天开播的过滤掉整行
  const isPastTray = Boolean(tray.date && tray.date < todayStr);
  const visibleFields = fields.filter((f) => {
    if (f.label === '直播当天销量' || f.label === '累计销量') return isPastTray;
    return true;
  });

  // 用户自传主图：per-look，键值 lookup。在主图 SafeImg 处直接读取（不进 fullById）。
  // 必须在 const tray 声明之后（依赖 tray.sections），否则触发 TDZ ReferenceError → 白屏
  const userImgByLook = useMemo(() => {
    const m: Record<string, string> = {};
    for (const s of tray.sections) for (const l of s.looks) if (l.userImg) m[l.id] = l.userImg;
    return m;
  }, [tray]);

  const upd = (fn: (t: Tray) => Tray) => onUpdateTray(fn(tray));

  const addLooks = (sectionId: string, pids: string[], lookIdx?: number) =>
    upd((t) => ({
      ...t,
      sections: t.sections.map((s) => {
        if (s.id !== sectionId) return s;
        if (lookIdx !== undefined)
          return { ...s, looks: s.looks.map((l, i) => (i === lookIdx ? { ...l, pids: [...new Set([...l.pids, ...pids])], cover: null } : l)) };
        // 新建坑位：cover 留空（待用户主动确认主图）
        return { ...s, looks: [...s.looks, { id: `l${Date.now()}`, pids, cover: null }] };
      }),
    }));

  const moveSection = (id: string, dir: -1 | 1) =>
    upd((t) => {
      const i = t.sections.findIndex((s) => s.id === id);
      const j = i + dir;
      if (j < 0 || j >= t.sections.length) return t;
      const arr = [...t.sections];
      [arr[i], arr[j]] = [arr[j], arr[i]];
      return { ...t, sections: arr };
    });

  // 同 band 内横向左右移动（跨 band 禁止）
  const moveLook = (sectionId: string, lookId: string, dir: -1 | 1) => {
    const section = tray.sections.find((s) => s.id === sectionId);
    if (!section) return;
    const i = section.looks.findIndex((l) => l.id === lookId);
    if (i === -1) return;
    const j = i + dir;
    if (j < 0 || j >= section.looks.length) return;
    if (Math.floor(i / LOOKS_PER_BAND) !== Math.floor(j / LOOKS_PER_BAND)) {
      toast.error('跨排坑位不能左右移，请先调整排数');
      return;
    }
    upd((t) => ({
      ...t,
      sections: t.sections.map((s) => {
        if (s.id !== sectionId) return s;
        const arr = [...s.looks];
        [arr[i], arr[j]] = [arr[j], arr[i]];
        return { ...s, looks: arr };
      }),
    }));
    toast.success(dir === -1 ? '已左移一位' : '已右移一位');
  };

  // 跨版块移动（移到目标 section 末尾）
  const moveLookToSection = (fromSectionId: string, lookId: string, toSectionId: string) => {
    if (fromSectionId === toSectionId) return;
    const fromSection = tray.sections.find((s) => s.id === fromSectionId);
    const look = fromSection?.looks.find((l) => l.id === lookId);
    const toSection = tray.sections.find((s) => s.id === toSectionId);
    if (!look || !toSection) return;
    upd((t) => ({
      ...t,
      sections: t.sections.map((s) => {
        if (s.id === fromSectionId) return { ...s, looks: s.looks.filter((l) => l.id !== lookId) };
        if (s.id === toSectionId) return { ...s, looks: [...s.looks, look] };
        return s;
      }),
    }));
    toast.success(`已移至「${toSection.label}」`);
    setMenuLookId(null);
  };

  // 切换坑位的封面款号
  const setCover = (sectionId: string, lookId: string, pid: string) => {
    upd((t) => ({
      ...t,
      sections: t.sections.map((s) => {
        if (s.id !== sectionId) return s;
        return {
          ...s,
          looks: s.looks.map((l) => {
            if (l.id !== lookId) return l;
            if (!l.pids.includes(pid)) return l;
            if (l.cover === pid) return l; // 已是封面
            return { ...l, cover: pid };
          }),
        };
      }),
    }));
  };

  // 用户自传主图：per-look，url 为 '/uploads/<uuid>.<ext>'（由 uploadImage 返回）
  const setUserImg = (sectionId: string, lookId: string, url: string | null) => {
    upd((t) => ({
      ...t,
      sections: t.sections.map((s) => {
        if (s.id !== sectionId) return s;
        return {
          ...s,
          looks: s.looks.map((l) => (l.id === lookId ? { ...l, userImg: url } : l)),
        };
      }),
    }));
  };
  const clearUserImg = (sectionId: string, lookId: string) => setUserImg(sectionId, lookId, null);

  // 翻单行前缀（如 针织裤/开衫）手动覆盖；传空串清除覆盖、回退自动推导
  const setRestockShortName = (sectionId: string, lookId: string, pid: string, value: string) => {
    upd((t) => ({
      ...t,
      sections: t.sections.map((s) => {
        if (s.id !== sectionId) return s;
        return {
          ...s,
          looks: s.looks.map((l) => {
            if (l.id !== lookId) return l;
            const next = { ...(l.restockShortNames || {}) };
            if (value.trim()) next[pid] = value.trim();
            else delete next[pid];
            return { ...l, restockShortNames: next };
          }),
        };
      }),
    }));
  };

  // 从坑位移除某个款号（保护：至少留 1 个；若是封面则用剩余第一张作新封面）
  const removePid = (sectionId: string, lookId: string, pid: string) => {
    const section = tray.sections.find((s) => s.id === sectionId);
    const look = section?.looks.find((l) => l.id === lookId);
    if (!look) return;
    if (look.pids.length <= 1) {
      toast.error('坑位至少保留 1 个款号，请整坑位删除');
      return;
    }
    upd((t) => ({
      ...t,
      sections: t.sections.map((s) => {
        if (s.id !== sectionId) return s;
        return {
          ...s,
          looks: s.looks.map((l) => {
            if (l.id !== lookId) return l;
            const next = l.pids.filter((x) => x !== pid);
            const nextCover = l.cover === pid ? next[0] : l.cover;
            return { ...l, pids: next, cover: nextCover };
          }),
        };
      }),
    }));
    toast.success('已从坑位移除款号');
  };

  // ── 列表模式 ──
  if (!editing) {
    return (
      <div className="responsive-page trays-page px-10 py-8">
        <div className="page-heading flex items-end justify-between border-b border-edge pb-6">
          <div>
            <div className="text-[12px] font-light tracking-[0.3em] text-ink-faint">01 /</div>
            <h1 className="mt-2 text-[28px] font-bold leading-none">货盘</h1>
            <p className="mt-3 text-[13px] text-ink-muted">直播货盘（马总 / 店播 / IP）· 达人货盘 · 渠道货盘</p>
          </div>
          <button
            onClick={() => setCreating(true)}
            className="flex items-center gap-1.5 rounded-md bg-action-primary px-4 py-2 text-[12.5px] font-medium text-white hover:bg-action-primary-hover"
          >
            <Plus size={14} /> 新增货盘
          </button>
        </div>

        {creating && (
          <div className="tray-create-form mt-5 flex flex-wrap items-center gap-3 border border-edge bg-surface-card px-5 py-4">
            <span className="text-[12.5px] font-semibold">新建货盘</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="货盘名称（如：马总场）"
              className="w-44 rounded border border-edge-strong px-2.5 py-1.5 text-[12.5px] outline-none focus:border-edge"
            />
            <select
              value={type}
              onChange={(e) => setType(e.target.value as TrayType)}
              className="rounded border border-edge-strong bg-surface-card px-2 py-1.5 text-[12.5px] outline-none focus:border-edge"
            >
              {TRAY_TYPES.map((t) => <option key={t}>{t}</option>)}
            </select>
            <label className="flex items-center gap-1.5 text-[12px] text-ink-secondary">
              直播日期
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="rounded border border-edge-strong px-2 py-1 text-[12.5px] outline-none focus:border-edge"
              />
            </label>
            <button
              onClick={() => {
                if (!name.trim()) { toast.error('请填写货盘名称'); return; }
                if (!date) { toast.error('请选择直播日期'); return; }
                const t = onCreateTray(name.trim(), type, date);
                toast.success(`货盘「${t.name} · ${t.date}」已创建`);
                setCreating(false); setName(''); setDate('');
                setEditing(true);
              }}
              className="rounded bg-action-primary px-4 py-1.5 text-[12px] text-white hover:bg-action-primary-hover"
            >
              创建并打开
            </button>
            <button onClick={() => setCreating(false)} className="text-[12px] text-ink-muted hover:text-ink-primary">取消</button>
          </div>
        )}

        <div className="mt-8 grid gap-4">
          {trays.map((t) => {
            const looks = t.sections.reduce((s, x) => s + x.looks.length, 0);
            const skus = t.sections.reduce((s, x) => s + x.looks.reduce((k, l) => k + l.pids.length, 0), 0);
            return (
              <div
                key={t.id}
                onClick={() => { onOpenTray(t.id); setEditing(true); }}
                className="tray-card flex cursor-pointer items-center justify-between border border-edge bg-surface-card px-6 py-5 text-left transition-colors hover:border-edge"
              >
                <div className="tray-card-main flex items-center gap-4">
                  <span className={`rounded-sm px-2 py-1 text-[11px] font-medium ${TYPE_COLOR[t.type]}`}>{t.type}</span>
                  <div>
                    <div className="text-[15px] font-bold">{t.name} <span className="ml-1 text-[12px] font-normal text-ink-muted">{t.date}</span></div>
                    <div className="mt-1 text-[11.5px] text-ink-muted">{looks} 个坑位 · {skus} 个款号 · 创建人：商品组</div>
                  </div>
                </div>
                <div className="tray-card-meta flex items-center gap-4">
                  <div className="text-right text-[11.5px] leading-5 text-ink-muted">
                    <div>查看：{t.viewPerm.join('、')}</div>
                    <div>编辑：{t.editPerm.join('、')}</div>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setPendingDelete(t);
                    }}
                    className="rounded-md p-1.5 text-ink-faint transition-colors hover:bg-surface-subtle hover:text-stage-return-fg"
                    title="删除货盘"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* 删除货盘二次确认弹窗（Radix AlertDialog，替换之前的 window.confirm） */}
        <AlertDialog.Root open={!!pendingDelete} onOpenChange={(o) => { if (!o) setPendingDelete(null); }}>
          <AlertDialog.Portal>
            <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[1px]" />
            <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(440px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-edge bg-surface-card p-6 shadow-2xl">
              <div>
                <AlertDialog.Title className="text-[16px] font-semibold text-ink-primary">
                  删除货盘
                </AlertDialog.Title>
                <AlertDialog.Description className="mt-2 text-[13px] text-ink-secondary">
                  {pendingDelete && (() => {
                    const looks = pendingDelete.sections.reduce((s, x) => s + x.looks.length, 0);
                    const skus = pendingDelete.sections.reduce((s, x) => s + x.looks.reduce((k, l) => k + l.pids.length, 0), 0);
                    return (
                      <span>
                        确定删除货盘 <strong className="text-ink-primary">「{pendingDelete.name} · {pendingDelete.date}」</strong> 吗？
                        该货盘 <strong className="text-ink-primary">{looks}</strong> 个坑位、<strong className="text-ink-primary">{skus}</strong> 个款号将一并删除，<span className="text-stage-return-fg font-medium">操作后不可恢复</span>。
                      </span>
                    );
                  })()}
                </AlertDialog.Description>
              </div>
              <div className="mt-5 flex justify-end gap-2">
                <AlertDialog.Cancel className="rounded-md border border-edge-strong px-4 py-2 text-[12px] hover:border-edge">
                  取消
                </AlertDialog.Cancel>
                <AlertDialog.Action
                  onClick={() => {
                    if (!pendingDelete) return;
                    const name = pendingDelete.name;
                    onDeleteTray(pendingDelete.id);
                    setPendingDelete(null);
                    toast.success(`货盘「${name}」已删除`);
                  }}
                  className="rounded-md bg-stage-return-fg px-4 py-2 text-[12px] font-medium text-white hover:opacity-90"
                >
                  删除
                </AlertDialog.Action>
              </div>
            </AlertDialog.Content>
          </AlertDialog.Portal>
        </AlertDialog.Root>
      </div>
    );
  }

  // ── 编辑模式：Excel 版式 ──
  const pickerSection = picker ? tray.sections.find((s) => s.id === picker.sectionId) : null;
  const cell = 'border border-ink-disabled px-2 py-2 align-middle text-center relative group/cell';
  const labelCell = `${cell} w-[74px] text-[10px] font-semibold leading-3 text-ink-primary`;

  return (
    <div className="responsive-page trays-page px-10 py-8">
      <div className="page-heading flex items-end justify-between border-b border-edge pb-6">
        <div>
          <div className="text-[12px] font-light tracking-[0.3em] text-ink-faint">01 /</div>
          <div className="tray-title mt-2 flex items-center gap-3">
            {editingName ? (
              <input
                type="text"
                defaultValue={tray.name}
                autoFocus
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== tray.name) {
                    upd((t) => ({ ...t, name: v }));
                    toast.success(`已改货盘名为「${v}」`);
                  }
                  setEditingName(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') setEditingName(false);
                }}
                className="rounded border border-edge-strong px-2 py-1 text-[20px] font-bold leading-none outline-none focus:border-edge"
              />
            ) : (
              <>
                <h1 className="text-[28px] font-bold leading-none">{tray.name}</h1>
                <button
                  onClick={() => setEditingName(true)}
                  className="text-ink-faint hover:text-ink-primary"
                  title="修改货盘名"
                >
                  <Pencil size={14} />
                </button>
              </>
            )}
            {editingDate ? (
              <div className="flex items-center gap-1">
                <input
                  type="date"
                  defaultValue={tray.date}
                  autoFocus
                  onBlur={(e) => {
                    const v = e.target.value;
                    if (v && v !== tray.date) {
                      upd((t) => ({ ...t, date: v }));
                      toast.success(`已改直播日期为 ${v}`);
                    }
                    setEditingDate(false);
                  }}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditingDate(false); }}
                  className="rounded border border-edge-strong px-2 py-1 text-[13px] outline-none focus:border-edge"
                />
              </div>
            ) : (
              <>
                <span className="text-[14px] text-ink-muted">{tray.date}</span>
                <button
                  onClick={() => setEditingDate(true)}
                  className="text-ink-faint hover:text-ink-primary"
                  title="修改直播日期"
                >
                  <Pencil size={12} />
                </button>
              </>
            )}
            <span className={`rounded-sm px-2 py-1 text-[11px] font-medium ${TYPE_COLOR[tray.type]}`}>{tray.type}</span>
          </div>
          <p className="mt-3 text-[13px] text-ink-muted">
            {tray.template === 'mazong'
              ? '马总模板：含面料 / 计划翻单量（内部版）。点击图片列可在右侧选款。'
              : tray.template === 'talent'
                ? '达人模板：对外精简版，仅展示款号 / 名称 / 颜色 / 售价 / 现货。'
                : '普通模板：标准呈现。点击图片列可在右侧选款。'}
          </p>
        </div>
        <div className="tray-actions flex items-center gap-2 print:hidden">
          <button
            onClick={() => onSync('商品')}
            disabled={syncing !== null}
            className="flex items-center gap-1.5 rounded-md border border-edge-strong px-3 py-2 text-[12px] hover:border-edge disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <RefreshCw size={13} className={syncing === '商品' ? 'animate-spin' : ''} />
            {syncing === '商品' ? '同步中…' : '同步商品'}
          </button>
          <button
            onClick={() => onSync('库存')}
            disabled={syncing !== null}
            className="flex items-center gap-1.5 rounded-md border border-edge-strong px-3 py-2 text-[12px] hover:border-edge disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <RefreshCw size={13} className={syncing === '库存' ? 'animate-spin' : ''} />
            {syncing === '库存' ? '同步中…' : '同步库存'}
          </button>
          <button
            onClick={() => onSync('成本及价格')}
            disabled={syncing !== null}
            className="flex items-center gap-1.5 rounded-md border border-edge-strong px-3 py-2 text-[12px] hover:border-edge disabled:opacity-60 disabled:cursor-not-allowed"
            title={hengjiStatus && !hengjiStatus.loggedIn
              ? `钉钉文档登录态失效（${hengjiStatus.reason || hengjiStatus.error || '未知'}），请在本地跑 npm run dingtalk:auth 登录后重新导出`
              : '从钉钉核价表同步款号的总成本和销售价（会打开浏览器并同步数据约 30-60s）'}
          >
            <RefreshCw size={13} className={syncing === '成本及价格' ? 'animate-spin' : ''} />
            {syncing === '成本及价格' ? '同步中…' : '同步成本及价格'}
            {hengjiStatus?.loggedIn === true && (
              <span className="ml-0.5 inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" title="钉钉文档登录态正常" />
            )}
            {hengjiStatus?.loggedIn === false && (
              <span className="ml-0.5 inline-block h-1.5 w-1.5 rounded-full bg-amber-500" title={`钉钉文档登录态失效：${hengjiStatus.reason || hengjiStatus.error || '未知'}`} />
            )}
          </button>
          <div className="relative">
            <button
              onClick={() => setExportMenuOpen((v) => !v)}
              onBlur={() => setTimeout(() => setExportMenuOpen(false), 150)}
              className="flex items-center gap-1.5 rounded-md border border-edge-strong px-3 py-2 text-[12px] hover:border-edge"
            >
              <Download size={13} /> 导出 Excel <MoreHorizontal size={11} />
            </button>
            {exportMenuOpen && (
              <div className="absolute right-0 z-20 mt-1 w-44 rounded-md border border-edge bg-surface-card shadow-lg">
                <button
                  onMouseDown={(e) => { e.preventDefault(); void exportTrayLayoutExcel(tray, fullByIdWithCost, salesByPid, todayStr, sampleColorsByCode); setExportMenuOpen(false); }}
                  className="block w-full px-3 py-2 text-left text-[12px] hover:bg-surface-subtle"
                >
                  货盘布局（同款盘格式）
                </button>
                <button
                  onMouseDown={(e) => { e.preventDefault(); exportSkuExcel(tray, fullByIdWithSize); setExportMenuOpen(false); }}
                  className="block w-full px-3 py-2 text-left text-[12px] hover:bg-surface-subtle"
                >
                  款号明细（一行一款）
                </button>
              </div>
            )}
          </div>
          <button onClick={() => exportRestockExcel(tray, fullByIdWithSize)} className="flex items-center gap-1.5 rounded-md border border-edge-strong px-3 py-2 text-[12px] hover:border-edge" title="导出计划翻单量 + 不可翻单清单">
            <FileText size={13} /> 导出翻单信息
          </button>
          <button onClick={() => window.print()} className="rounded-md border border-edge-strong px-3 py-2 text-[12px] hover:border-edge">打印</button>
          <button
            onClick={() => setShowLog(true)}
            className="flex items-center gap-1.5 rounded-md border border-edge-strong px-3 py-2 text-[12px] hover:border-edge"
            title="谁什么时间改了什么"
          >
            <History size={13} /> 修改记录
          </button>
          <button onClick={() => setEditing(false)} className="flex items-center gap-1.5 rounded-md bg-action-primary px-3.5 py-2 text-[12px] font-medium text-white hover:bg-action-primary-hover">
            <ArrowLeft size={13} /> 返回清单
          </button>
        </div>
      </div>

      {/* 版块管理 */}
      <div className="tray-sections mt-5 flex flex-wrap items-center gap-2 print:hidden" data-local-scroll>
        <span className="text-[11px] font-medium text-ink-muted">版块：</span>
        {tray.sections.map((s) => {
          const dragFromHere = sectionDrag?.fromId === s.id;
          const showBeforeLine = sectionDrag?.overId === s.id && sectionDrag.position === 'before' && !dragFromHere;
          const showAfterLine = sectionDrag?.overId === s.id && sectionDrag.position === 'after' && !dragFromHere;
          return (
            <span key={s.id} className="relative flex items-center gap-1">
              {showBeforeLine && (
                <span
                  className="pointer-events-none absolute -left-1.5 top-1 bottom-1 z-20 w-1 rounded-full bg-action-link shadow-[0_0_8px_rgba(46,95,163,0.8)]"
                  title="释放插入到此位置"
                />
              )}
              <span
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', s.id);
                  setSectionDrag({ fromId: s.id, overId: s.id, position: 'before' });
                }}
                onDragEnter={(e) => {
                  e.preventDefault();
                  if (!sectionDrag || sectionDrag.fromId === s.id) return;
                  // 鼠标位置在前半部分 → before；后半部分 → after
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  const before = e.clientY < rect.top + rect.height / 2;
                  setSectionDrag({ fromId: sectionDrag.fromId, overId: s.id, position: before ? 'before' : 'after' });
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (!sectionDrag || sectionDrag.fromId === s.id) return;
                  e.dataTransfer.dropEffect = 'move';
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  const before = e.clientY < rect.top + rect.height / 2;
                  setSectionDrag({ fromId: sectionDrag.fromId, overId: s.id, position: before ? 'before' : 'after' });
                }}
                onDragEnd={() => setSectionDrag(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  const drag = sectionDrag;
                  setSectionDrag(null);
                  if (!drag || drag.fromId === s.id) return;
                  const before = drag.position === 'before';
                  upd((t) => {
                    const arr = [...t.sections];
                    const fromIdx = arr.findIndex((x) => x.id === drag.fromId);
                    if (fromIdx < 0) return t;
                    const [moved] = arr.splice(fromIdx, 1);
                    let toIdx = arr.findIndex((x) => x.id === s.id);
                    if (toIdx < 0) toIdx = arr.length;
                    if (!before) toIdx += 1;
                    arr.splice(toIdx, 0, moved);
                    return { ...t, sections: arr };
                  });
                }}
                className={`flex cursor-grab items-center gap-1 rounded-full border px-2.5 py-1 text-[11.5px] transition-opacity ${
                  dragFromHere ? 'opacity-40 border-action-link' :
                  s.visible ? 'border-edge-strong bg-surface-card' : 'border-dashed border-edge-strong text-ink-faint'
                } active:cursor-grabbing`}
              >
                {s.label}
                <button onClick={() => moveSection(s.id, -1)} className="text-ink-faint hover:text-ink-primary"><ArrowUp size={11} /></button>
                <button onClick={() => moveSection(s.id, 1)} className="text-ink-faint hover:text-ink-primary"><ArrowDown size={11} /></button>
                <button onClick={() => { const l = prompt('版块名称', s.label); if (l?.trim()) upd((t) => ({ ...t, sections: t.sections.map((x) => (x.id === s.id ? { ...x, label: l.trim() } : x)) })); }} className="text-ink-faint hover:text-ink-primary"><Pencil size={10} /></button>
                <button onClick={() => upd((t) => ({ ...t, sections: t.sections.map((x) => (x.id === s.id ? { ...x, visible: !x.visible } : x)) }))} className="text-ink-faint hover:text-ink-primary">
                  {s.visible ? <Eye size={11} /> : <EyeOff size={11} />}
                </button>
                <button onClick={() => upd((t) => ({ ...t, sections: t.sections.filter((x) => x.id !== s.id) }))} className="text-ink-faint hover:text-stage-return-fg"><Trash2 size={11} /></button>
              </span>
              {showAfterLine && (
                <span className="pointer-events-none absolute -right-0.5 top-0 z-10 h-full w-1 rounded-full bg-action-link shadow-[0_0_6px_rgba(46,95,163,0.6)]" />
              )}
            </span>
          );
        })}
        <button
          onClick={() => { const l = prompt('新版块名称'); if (l?.trim()) upd((t) => ({ ...t, sections: [...t.sections, { id: `s${Date.now()}`, label: l.trim(), visible: true, looks: [] }] })); }}
          className="flex items-center gap-1 rounded-full border border-dashed border-ink-faint px-2.5 py-1 text-[11.5px] text-ink-muted hover:border-edge hover:text-ink-primary"
        >
          <Plus size={11} /> 加版块
        </button>
        <button
          onClick={() => { const l = prompt('备用版块名称', '备用'); if (l?.trim()) upd((t) => ({ ...t, sections: [...t.sections, { id: `s${Date.now()}`, label: l.trim(), visible: true, looks: [], isBackup: true }] })); }}
          className="flex items-center gap-1 rounded-full border border-dashed border-ink-faint px-2.5 py-1 text-[11.5px] text-ink-muted hover:border-edge hover:text-ink-primary"
          title="备用区域：暂存已选但暂不播的坑位，面料/翻单覆盖随款号保留"
        >
          <Archive size={11} /> 加备用
        </button>
      </div>

      {/* Excel 版式：每个版块一张表，行=字段，列=坑位；超宽换排 */}
      <p className="mobile-scroll-hint" aria-label="表格可横向滑动">↔ 左右滑动查看全部坑位，点击单元格编辑</p>
      <div className="mt-6 space-y-2 pb-16">
        {visible.map((s) => {
          const bands: (typeof s.looks)[] = [];
          for (let i = 0; i < s.looks.length; i += LOOKS_PER_BAND) bands.push(s.looks.slice(i, i + LOOKS_PER_BAND));
          return (
            <div key={s.id}>
              {bands.map((band, bi) => {
                const isFirstBand = bi === 0;
                return (
                  <div key={bi} className={isFirstBand ? '' : 'border-t border-edge'}>
                    {isFirstBand && (
                      <div className={`flex items-center px-3 py-2.5 ${s.isBackup ? 'bg-ink-muted' : 'bg-action-primary'}`}>
                        <span className="flex-1 text-center text-[14px] font-bold tracking-[0.25em] text-white">
                          {s.label}{s.isBackup && ' · 备用'}
                        </span>
                        <span className="shrink-0 text-[10px] text-white/60">{`${s.looks.length} 个坑位`}</span>
                      </div>
                    )}
                  <div className="tray-sheet overflow-x-auto" data-local-scroll tabIndex={0} role="region" aria-label={`${s.label}货盘表格，左右滑动查看全部坑位`}>
                  <table className="border-collapse bg-surface-card text-[11.5px] table-fixed" style={{ '--tray-table-width': `${74 + band.length * 220}px` } as React.CSSProperties}>
                    <thead>
                      <tr>
                        <th className={`${cell} bg-surface-card`} style={{ width: 74 }}>
                          <span className="text-[9px] font-normal text-ink-faint">坑位</span>
                        </th>
                        {band.map((l) => {
                          const gi = s.looks.indexOf(l);
                          return (
                            <th key={l.id} className={`${cell} bg-surface-card py-1 font-medium`} style={{ width: 220 }}>
                              <div className="flex items-center justify-between">
                                <span className="text-[10px] text-ink-muted">坑位 {gi + 1} · {l.pids.length} 款</span>
                                <span className="flex items-center gap-1 print:hidden">
                                  <button onClick={() => setPicker({ sectionId: s.id, lookIdx: gi })} title="向坑位追加款号" className="text-ink-faint hover:text-ink-primary"><Plus size={11} /></button>
                                  <div className="relative">
                                    <button
                                      onClick={() => setMenuLookId(menuLookId === l.id ? null : l.id)}
                                      className="text-ink-faint hover:text-ink-primary"
                                      title="更多操作（左移/右移/移至版块/删除）"
                                    >
                                      <MoreHorizontal size={11} />
                                    </button>
                                    {menuLookId === l.id && (
                                      <div
                                        className="absolute right-0 top-full z-20 mt-1 w-36 border border-edge bg-surface-card py-1 text-left text-[11px] shadow-md"
                                        onMouseLeave={() => setMenuLookId(null)}
                                      >
                                        <button
                                          onClick={() => { moveLook(s.id, l.id, -1); setMenuLookId(null); }}
                                          className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-surface-subtle"
                                        >
                                          <ArrowLeft size={10} /> 左移一位
                                        </button>
                                        <button
                                          onClick={() => { moveLook(s.id, l.id, 1); setMenuLookId(null); }}
                                          className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-surface-subtle"
                                        >
                                          <ArrowRight size={10} /> 右移一位
                                        </button>
                                        <div className="my-1 border-t border-edge-muted" />
                                        <div className="px-3 py-1 text-[10px] tracking-wider text-ink-faint">移至版块</div>
                                        {tray.sections.filter((x) => x.id !== s.id).map((target) => (
                                          <button
                                            key={target.id}
                                            onClick={() => moveLookToSection(s.id, l.id, target.id)}
                                            className="block w-full px-3 py-1.5 text-left hover:bg-surface-subtle"
                                          >
                                            → {target.label}
                                          </button>
                                        ))}
                                        <div className="my-1 border-t border-edge-muted" />
                                        <button
                                          onClick={() => {
                                            upd((t) => ({
                                              ...t,
                                              sections: t.sections.map((x) =>
                                                x.id === s.id ? { ...x, looks: x.looks.filter((y) => y.id !== l.id) } : x,
                                              ),
                                            }));
                                            toast.success('坑位已删除');
                                            setMenuLookId(null);
                                          }}
                                          className="flex w-full items-center gap-2 px-3 py-1.5 text-stage-return-fg hover:bg-surface-subtle"
                                        >
                                          <Trash2 size={10} /> 删除坑位
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                </span>
                              </div>
                            </th>
                          );
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      {/* 主图行：默认只显示一张封面图；多图且 cover 未确认时显红点提醒 */}
                      <tr>
                        <td className={`${labelCell} text-action-danger-fg`}>主图</td>
                        {band.map((l) => {
                          const coverPid = l.cover ?? l.pids[0];
                          const coverP = fullByIdWithSize(coverPid);
                          const multi = l.pids.length > 1;
                          const needsConfirm = multi; // 只要多图就显示红点提示（之前 cover===null 太严格，默认 cover=pids[0] 让红点永远不出现）
                          const userImg = userImgByLook[l.id];
                          return (
                            <td key={l.id} className={cell}>
                              <div className="relative inline-block">
                                <SafeImg
                                  src={userImg ?? coverP.img}
                                  alt={`${coverP.name}（${coverPid.toUpperCase()}）`}
                                  pid={coverPid}
                                  fallbackText="无图"
                                  onClick={() => multi && setCoverMenu({ sectionId: s.id, lookId: l.id })}
                                  className={`h-56 w-[180px] object-cover ring-2 ring-edge ${multi ? 'cursor-pointer' : ''}`}
                                />
                                {userImg && (
                                  <span
                                    title="已替换为自传图"
                                    className="absolute left-1 top-1 rounded bg-stage-success-fg px-1 text-[9px] font-semibold text-white print:hidden"
                                  >
                                    自传
                                  </span>
                                )}
                                {needsConfirm && (
                                  <span
                                    onClick={(e) => { e.stopPropagation(); setCoverMenu({ sectionId: s.id, lookId: l.id }); }}
                                    className="absolute right-0.5 top-0.5 h-2.5 w-2.5 cursor-pointer rounded-full bg-stage-return-fg ring-2 ring-surface-bg print:hidden"
                                    title="待确认主图"
                                  />
                                )}
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                      {visibleFields.map((f) => {
                        // 售价 / 马总价 setter：复用同一 upd 闭包即可
                        const savePrice = (pid: string, v: string) =>
                          upd((t) => ({ ...t, priceOverrides: { ...(t.priceOverrides || {}), [pid]: v } }));
                        const clearPrice = (pid: string) =>
                          upd((t) => {
                            const next = { ...(t.priceOverrides || {}) };
                            delete next[pid];
                            const m = { ...t };
                            if (Object.keys(next).length > 0) m.priceOverrides = next; else delete m.priceOverrides;
                            return m;
                          });
                        const saveMprice = (pid: string, v: string) =>
                          upd((t) => ({ ...t, mpriceOverrides: { ...(t.mpriceOverrides || {}), [pid]: v } }));
                        const clearMprice = (pid: string) =>
                          upd((t) => {
                            const next = { ...(t.mpriceOverrides || {}) };
                            delete next[pid];
                            const m = { ...t };
                            if (Object.keys(next).length > 0) m.mpriceOverrides = next; else delete m.mpriceOverrides;
                            return m;
                          });
                        const saveCodeSuffix = (pid: string, v: string) =>
                          upd((t) => {
                            // 空字符串 = 清除 override
                            if (v === '') {
                              const next = { ...(t.codeSuffixOverrides || {}) };
                              delete next[pid];
                              const m = { ...t };
                              if (Object.keys(next).length > 0) m.codeSuffixOverrides = next; else delete m.codeSuffixOverrides;
                              return m;
                            }
                            return { ...t, codeSuffixOverrides: { ...(t.codeSuffixOverrides || {}), [pid]: v } };
                          });
                        const saveColor = (lookId: string, v: string) =>
                          upd((t) => {
                            // 空字符串 = 清除 override
                            if (v === '') {
                              const next = { ...(t.colorOverrideByLook || {}) };
                              delete next[lookId];
                              const m = { ...t };
                              if (Object.keys(next).length > 0) m.colorOverrideByLook = next; else delete m.colorOverrideByLook;
                              return m;
                            }
                            return { ...t, colorOverrideByLook: { ...(t.colorOverrideByLook || {}), [lookId]: v } };
                          });
                        const clearColor = (lookId: string) => saveColor(lookId, '');
                        const saveFabricNote = (pid: string, v: string) =>
                          upd((t) => ({
                            ...t,
                            fabricNotes: { ...(t.fabricNotes || {}), [pid]: v },
                          }));
                        const clearFabricNote = (pid: string) =>
                          upd((t) => {
                            const next = { ...(t.fabricNotes || {}) };
                            delete next[pid];
                            const m = { ...t };
                            if (Object.keys(next).length > 0) m.fabricNotes = next; else delete m.fabricNotes;
                            return m;
                          });
                        const saveCost = (pid: string, v: string) =>
                          upd((t) => {
                            if (v === '') {
                              const next = { ...(t.costOverrides || {}) };
                              delete next[pid];
                              const m = { ...t };
                              if (Object.keys(next).length > 0) m.costOverrides = next; else delete m.costOverrides;
                              return m;
                            }
                            return { ...t, costOverrides: { ...(t.costOverrides || {}), [pid]: v } };
                          });
                        const clearCost = (pid: string) =>
                          upd((t) => {
                            const next = { ...(t.costOverrides || {}) };
                            delete next[pid];
                            const m = { ...t };
                            if (Object.keys(next).length > 0) m.costOverrides = next; else delete m.costOverrides;
                            return m;
                          });
                        const saveMcost = (pid: string, v: string) =>
                          upd((t) => {
                            if (v === '') {
                              const next = { ...(t.mcostOverrides || {}) };
                              delete next[pid];
                              const m = { ...t };
                              if (Object.keys(next).length > 0) m.mcostOverrides = next; else delete m.mcostOverrides;
                              return m;
                            }
                            return { ...t, mcostOverrides: { ...(t.mcostOverrides || {}), [pid]: v } };
                          });
                        const clearMcost = (pid: string) =>
                          upd((t) => {
                            const next = { ...(t.mcostOverrides || {}) };
                            delete next[pid];
                            const m = { ...t };
                            if (Object.keys(next).length > 0) m.mcostOverrides = next; else delete m.mcostOverrides;
                            return m;
                          });
                        return (
                        <tr key={f.label} className={f.rowCls ?? ''}>
                          <td className={`${labelCell} ${f.labelCls ?? ''}`}>{f.label}</td>
                          {band.map((l) => {
                            // 跨款号合并字段（如售价）：一格只渲一次，把所有款号拼起来
                            if (f.aggregate && f.aggregateRender) {
                              const ps = l.pids.map(fullByIdWithCost);
                              // aggregateRender 返回 null → 整格不渲染（td 都不输出）
                              const aggNode = f.aggregateRender(ps, tray.template, {
                                    sectionId: s.id,
                                    lookId: l.id,
                                    pid: l.pids[0],
                                    allPids: l.pids,
                                    // 仅「已播完」（tray.date < 今天）的货盘显示销量注脚
                                    pastDate: tray.date && tray.date < todayStr ? tray.date : null,
                                    salesByPid,
                                    fabricOverrides: tray.fabricOverrides,
                                    fabricNotes: tray.fabricNotes,
                                    restockOverrides: tray.restockOverrides,
                                    restockShortNames: l.restockShortNames,
                                    noRestockItems: tray.noRestockItems,
                                    skcsByCode,
                                    onHoverFabric: f.label === '面料情况' ? (codes, el) => {
                                      // 重置定位 + 复用当前坑位 sectionId/lookId（点"打开完整"时用）
                                      setFabricTip({ sectionId: s.id, lookId: l.id, codes, rect: el.getBoundingClientRect(), data: null, loading: true, error: null });
                                      onHoverFabricQuick(codes, el);
                                    } : undefined,
                                    onLeaveFabric: f.label === '面料情况' ? onLeaveFabricQuick : undefined,
                                    onPickFabric: (p) => setFabricPicker({ sectionId: s.id, lookId: l.id, pid: p }),
                                    onClearFabric: (p) => {
                                      upd((t) => {
                                        // 把 fabricOverrides[p] 置为空字符串以「隐藏」BI / 旧 override 的面料信息
                                        // （保留 key，避免 BI 面料再冒出来）
                                        const next = { ...(t.fabricOverrides || {}), [p]: '' };
                                        const items = (t.noRestockItems || []).filter((it) => it.pid.toLowerCase() !== p.toLowerCase());
                                        return { ...t, fabricOverrides: next, noRestockItems: items };
                                      });
                                      toast.success('已隐藏面料信息');
                                    },
                                    onPickRestock: () => setRestockPicker({ sectionId: s.id, lookId: l.id }),
                                    priceOverrides: tray.priceOverrides,
                                    mpriceOverrides: tray.mpriceOverrides,
                                    codeSuffixOverrides: tray.codeSuffixOverrides,
                                    costOverrides: tray.costOverrides,
                                    mcostOverrides: tray.mcostOverrides,
                                    onSavePrice: savePrice,
                                    onClearPrice: clearPrice,
                                    onSaveMprice: saveMprice,
                                    onClearMprice: clearMprice,
                                    onSaveCost: saveCost,
                                    onClearCost: clearCost,
                                    onSaveMcost: saveMcost,
                                    onClearMcost: clearMcost,
                                    onSaveCodeSuffix: saveCodeSuffix,
                                    colorOverride: tray.colorOverrideByLook?.[l.id],
                                    sampleColorsByPid: sampleColorsByCode,
                                    onSaveColor: saveColor,
                                    onClearColor: clearColor,
                                    onSaveFabricNote: saveFabricNote,
                                    onClearFabricNote: clearFabricNote,
                                  });
                              if (aggNode === null) return null;
                              return (
                                <td key={l.id} className={cell}>
                                  <div className="text-center">{aggNode}</div>
                                </td>
                              );
                            }
                            return (
                              <td key={l.id} className={cell}>
                                <div className="space-y-2">
                                {l.pids.map((pid) => (
                                  <div key={pid} className="group relative">
                                    {/* 移除款号按钮：只挂在「款号」字段行（多款时悬停显示） */}
                                    {f.label === '款号' && l.pids.length > 1 && (
                                      <button
                                        onClick={() => removePid(s.id, l.id, pid)}
                                        className="absolute -right-1 -top-1 z-10 hidden h-4 w-4 items-center justify-center rounded-full bg-action-danger text-white shadow-sm hover:bg-action-danger-fg group-hover:flex print:hidden"
                                        title="从这个坑位移除该款号"
                                      >
                                        <X size={9} />
                                      </button>
                                    )}
                                    {f.render(fullByIdWithCost(pid), tray.template, {
                                      sectionId: s.id,
                                      lookId: l.id,
                                      pid,
                                      fabricOverride: tray.fabricOverrides?.[pid],
                                      fabricNotes: tray.fabricNotes,
                                      noRestockItems: tray.noRestockItems,
                                      skcsByCode,
                                      sampleColorsByPid: sampleColorsByCode,
                                      onPickFabric: (p) => setFabricPicker({ sectionId: s.id, lookId: l.id, pid: p }),
                                      onClearFabric: (p) => {
                                        upd((t) => {
                                          // 把 fabricOverrides[p] 置为空字符串以「隐藏」BI / 旧 override 的面料信息
                                          const next = { ...(t.fabricOverrides || {}), [p]: '' };
                                          const items = (t.noRestockItems || []).filter((it) => it.pid.toLowerCase() !== p.toLowerCase());
                                          return { ...t, fabricOverrides: next, noRestockItems: items };
                                        });
                                        toast.success('已隐藏面料信息');
                                      },
                                      priceOverride: tray.priceOverrides?.[pid],
                                      mpriceOverride: tray.mpriceOverrides?.[pid],
                                      codeSuffixOverride: tray.codeSuffixOverrides?.[pid],
                                      costOverride: tray.costOverrides?.[pid],
                                      mcostOverride: tray.mcostOverrides?.[pid],
                                      onSavePrice: savePrice,
                                      onClearPrice: clearPrice,
                                      onSaveMprice: saveMprice,
                                      onClearMprice: clearMprice,
                                      onSaveCost: saveCost,
                                      onClearCost: clearCost,
                                      onSaveMcost: saveMcost,
                                      onClearMcost: clearMcost,
                                      onSaveCodeSuffix: saveCodeSuffix,
                                    onSaveFabricNote: saveFabricNote,
                                    onClearFabricNote: clearFabricNote,
                                    })}
                                  </div>
                                ))}
                              </div>
                            </td>
                            );
                          })}
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  </div>
                  </div>
                );
              })}
              {s.looks.length > 0 && (
                <button
                  onClick={() => setPicker({ sectionId: s.id })}
                  className="flex w-full items-center justify-center gap-1 border border-dashed border-edge-strong py-2 text-[11.5px] text-ink-faint hover:border-edge hover:text-ink-primary print:hidden"
                >
                  <Plus size={12} /> 新坑位
                </button>
              )}
              {s.looks.length === 0 && (
                <button
                  onClick={() => setPicker({ sectionId: s.id })}
                  className="flex w-full items-center justify-center border border-dashed border-edge-strong py-8 text-[12px] text-ink-faint hover:border-edge hover:text-ink-primary print:hidden"
                >
                  <Plus size={13} className="mr-1" /> 「{s.label}」还没有坑位，点击选款
                </button>
              )}
            </div>
          );
        })}
      </div>

      {picker && pickerSection && (
        <LookPicker
          sectionLabel={pickerSection.label}
          mode={picker.lookIdx !== undefined ? 'append' : 'new'}
          onConfirm={(pids) => addLooks(picker.sectionId, pids, picker.lookIdx)}
          onClose={() => setPicker(null)}
        />
      )}

      {fabricPicker && (() => {
        // 批量查询：一次性把坑位里所有 pid 都传给 fabric_Q
        const fpSection = tray.sections.find((x) => x.id === fabricPicker.sectionId);
        const fpLook = fpSection?.looks.find((y) => y.id === fabricPicker.lookId);
        const fpPids = fpLook?.pids || [fabricPicker.pid];
        function prefillFabricQ() {
          const win = fabricIframeRef.current?.contentWindow;
          if (!win) return;
          win.postMessage({
            type: 'fabric-prefill',
            codes: fpPids.map((p) => p.toUpperCase()),
            autoSubmit: true,
          }, window.location.origin);
        }
        // 聚合所有 pid 的 noRestock 计数（占位标记且该款已有真实面料时不算数，跟面料格渲染口径一致）
        const totalNoRestock = fpPids.reduce((n, pid) => {
          const p = fullById(pid);
          const allItems = (tray.noRestockItems || []).filter((it) => it.pid.toLowerCase() === pid.toLowerCase());
          const ov0 = tray.fabricOverrides?.[pid];
          const hasRealFabric = Boolean((ov0 ?? '').trim() || (!isFabricNoise(p?.fabric) && (p?.fabric ?? '').trim()));
          return n + effectiveNoRestockItems(allItems, hasRealFabric).length;
        }, 0);
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-0 sm:p-3">
            <div className="absolute inset-0 bg-black/40" onClick={() => setFabricPicker(null)} />
            <div style={{ zIndex: 10, position: 'relative' }} role="dialog" aria-modal="true" aria-label="面料或翻单信息" className="tray-iframe-dialog flex h-[100dvh] w-full sm:h-[85vh] sm:w-[90vw] max-w-[1100px] flex-col border-0 sm:border border-edge bg-surface-card shadow-2xl rounded-none sm:rounded-lg overflow-hidden">
              <div className="flex items-center justify-between border-b border-edge px-3 py-2 sm:px-5 sm:py-3">
                <div>
                  <div className="text-[13px] font-bold">
                    查询面料 · {fpPids.length > 1 ? `${fpPids.length} 个款号` : (PRODUCTS.find((x) => x.id === fabricPicker.pid)?.name ?? fabricPicker.pid)}
                  </div>
                  <div className="mt-0.5 text-[11px] text-ink-muted">
                    {fpPids.map((p) => p.toUpperCase()).join(' / ')} · 自动按款号搜索 → 勾选底部 SKC 标记「无面料不翻单」
                  </div>
                </div>
                <button onClick={() => setFabricPicker(null)} aria-label="关闭面料信息" className="rounded-md p-1.5 hover:bg-surface-subtle">
                  <X size={16} />
                </button>
              </div>
              <iframe
                key="fabric-q-iframe"
                ref={fabricIframeRef}
                src={`${FABRIC_BASE}/index.html?codes=${fpPids.map((p) => p.toUpperCase()).join(',')}`}
                className="flex-1 w-full border-0"
                title="fabric_Q 面料查询"
                onLoad={() => {
                  // iframe 重新加载完成后再 prefill，避免父组件 render 导致反复查询
                  setTimeout(prefillFabricQ, 200);
                }}
              />
              {/* 底部说明：勾选操作在 fabric_Q 内部完成（结果表格最右列「翻单」checkbox） */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between border-t border-edge bg-surface-subtle px-3 py-2 sm:px-5 sm:py-2.5 text-[11px] sm:text-[11.5px] gap-1 sm:gap-2">
                <span className="text-ink-secondary">
                  提示：fabric_Q 结果表格最右列「翻单」checkbox 可标记「无面料不翻单」（SKC 级）
                </span>
                <span className="text-ink-muted">
                  本坑位已标记 {totalNoRestock} 个 SKC
                </span>
              </div>
            </div>
          </div>
        );
      })()}

      {/* 面料悬停快查：350ms 后自动查，移到卡片上不关，移走 180ms 后关 */}
      {fabricTip && (
        <FabricQuickTooltip
          rect={fabricTip.rect}
          codes={fabricTip.codes}
          data={fabricTip.data}
          loading={fabricTip.loading}
          error={fabricTip.error}
          onMouseEnter={onTipEnter}
          onMouseLeave={onTipLeave}
          onOpenFullPicker={() => {
            // 把当前坑位传去 fabricPicker（复用现有 iframe 流）
            const cur = fabricTip;
            setFabricPicker({ sectionId: cur.sectionId, lookId: cur.lookId, pid: cur.codes[0] });
            setFabricTip(null);
          }}
        />
      )}

      {restockPicker && (() => {
        const rpSection = tray.sections.find((x) => x.id === restockPicker.sectionId);
        const rpLook = rpSection?.looks.find((y) => y.id === restockPicker.lookId);
        const rpPids = rpLook?.pids || [];
        function prefillSales() {
          const win = salesIframeRef.current?.contentWindow;
          if (!win) return;
          // 样衣行（驼色等）不落 fabric_Q 的 Supabase，重开弹窗时由货盘侧把上次同步的批次回传回填
          const sampleItems = (tray.sampleRestockItems || [])
            .filter((it) => rpPids.includes(it.pdt))
            .map((it) => ({ pdt: it.pdt.toUpperCase(), skc: it.skc.toUpperCase(), pieces: it.pieces, days: it.days }));
          win.postMessage({
            type: 'restock-prefill',
            pids: rpPids.map((p) => p.toUpperCase()),
            autoSelect: true,
            items: sampleItems,
          }, window.location.origin);
        }
        function openInNewTab() {
          const url = `${FABRIC_BASE}/sales.html?pids=${rpPids.map((p) => p.toUpperCase()).join(',')}`;
          window.open(url, '_blank', 'noopener,noreferrer');
          setRestockPicker(null);
        }
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-0 sm:p-3">
            <div className="absolute inset-0 bg-black/40" onClick={() => setRestockPicker(null)} />
            <div style={{ zIndex: 10, position: 'relative' }} role="dialog" aria-modal="true" aria-label="面料或翻单信息" className="tray-iframe-dialog flex h-[100dvh] w-full sm:h-[85vh] sm:w-[90vw] max-w-[1100px] flex-col border-0 sm:border border-edge bg-surface-card shadow-2xl rounded-none sm:rounded-lg overflow-hidden">
              <div className="flex items-center justify-between border-b border-edge px-3 py-2 sm:px-5 sm:py-3">
                <div>
                  <div className="text-[13px] font-bold">
                    翻单计划 · {rpPids.length} 个款号
                  </div>
                  <div className="mt-0.5 text-[11px] text-ink-muted">
                    {rpPids.map((p) => p.toUpperCase()).join(' / ')} · 已自动搜索并勾选
                  </div>
                </div>
                <button onClick={() => setRestockPicker(null)} aria-label="关闭翻单信息" className="rounded-md p-1.5 hover:bg-surface-subtle">
                  <X size={16} />
                </button>
              </div>
              <SampleMaterialsPanel pids={rpPids} />
              <RestockStockPanel pids={rpPids} />
              <iframe
                key="restock-iframe"
                ref={salesIframeRef}
                src={`${FABRIC_BASE}/sales.html?iframe=1&pids=${rpPids.map((p) => p.toUpperCase()).join(',')}`}
                className="flex-1 w-full border-0"
                title="翻单计划"
                onLoad={() => {
                  // 跨域 iframe 加载后：先 focus 让表单可用，再 postMessage prefill
                  const frame = salesIframeRef.current;
                  if (frame) {
                    try { frame.contentWindow?.focus(); } catch { /* cross-origin, ignore */ }
                  }
                  setTimeout(prefillSales, 400);
                }}
              />
              <div className="flex items-center justify-between border-t border-edge bg-surface-subtle px-5 py-2.5 text-[11.5px]">
                <span className="text-ink-secondary">
                  提示：左侧勾选款号 → 右侧填写翻单 → 点「确认翻单信息并同步至货盘」自动回写
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={openInNewTab}
                    className="rounded border border-edge-strong px-3 py-1 text-[11.5px] hover:border-edge"
                    title="在新窗口打开（输入框失焦时使用）"
                  >
                    在新窗口打开
                  </button>
                  <button
                    onClick={() => setRestockPicker(null)}
                    className="rounded border border-edge-strong px-3 py-1 text-[11.5px] hover:border-edge"
                  >
                    关闭
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {coverMenu && (() => {
        const cmSection = tray.sections.find((x) => x.id === coverMenu.sectionId);
        const cmLook = cmSection?.looks.find((y) => y.id === coverMenu.lookId);
        if (!cmLook) return null;
        const uploadInputRef = { current: null as HTMLInputElement | null };
        const handleUpload = async (e: ChangeEvent<HTMLInputElement>) => {
          const file = e.target.files?.[0];
          e.target.value = ''; // 允许同名重复上传
          if (!file) return;
          if (!file.type.startsWith('image/')) {
            toast.error('请选择图片文件');
            return;
          }
          const toastId = toast.loading('正在上传自传图…');
          try {
            const url = await uploadImage(file);
            setUserImg(coverMenu.sectionId, coverMenu.lookId, url);
            toast.success('自传图已替换', { id: toastId });
            setCoverMenu(null);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            toast.error(`上传失败：${msg}`, { id: toastId });
          }
        };
        const handleRemoveUserImg = () => {
          clearUserImg(coverMenu.sectionId, coverMenu.lookId);
          toast.success('已移除自传图，回退到封面款号原图');
          setCoverMenu(null);
        };
        // 自动推导的翻单前缀（placeholder 提示用）：圆领/V领、针织裤/开衫 等
        const autoShorts = computeRestockShortNames(cmLook.pids.map(fullByIdWithSize));
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div className="absolute inset-0 bg-black/20" onClick={() => setCoverMenu(null)} />
            <div role="dialog" aria-modal="true" aria-label="坑位多图管理" className="cover-dialog relative w-[520px] border border-edge bg-surface-card p-5 shadow-xl">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <div className="text-[13px] font-bold">坑位多图管理</div>
                  <div className="mt-0.5 text-[11px] text-ink-muted">
                    「{cmSection?.label}」共 {cmLook.pids.length} 个款号 · 点击设为主图 · × 移除
                  </div>
                </div>
                <button onClick={() => setCoverMenu(null)} aria-label="关闭多图管理" className="rounded-md p-1 hover:bg-surface-subtle">
                  <X size={14} />
                </button>
              </div>
              <div className="cover-grid grid grid-cols-5 gap-3">
                {cmLook.pids.map((pid) => {
                  const p = fullByIdWithSize(pid);
                  const isCover = cmLook.cover === pid;
                  return (
                    <div key={pid} className="group relative">
                      <button
                        onClick={() => { setCover(coverMenu.sectionId, coverMenu.lookId, pid); toast.success('已设为主图'); setCoverMenu(null); }}
                        className="block w-full text-left"
                      >
                        <SafeImg
                          src={p.img}
                          alt={p.name}
                          pid={pid}
                          fallbackText="无图"
                          className={`h-20 w-full object-cover ${isCover ? 'ring-2 ring-edge' : 'opacity-80 hover:opacity-100'}`}
                        />
                        <div className="mt-1 flex items-center justify-between text-[10px] text-ink-muted">
                          <span className="truncate">{pid.toUpperCase()}</span>
                          {isCover && <span className="text-[10px] font-semibold text-ink-primary">主图</span>}
                        </div>
                      </button>
                      <input
                        value={cmLook.restockShortNames?.[pid] ?? ''}
                        onChange={(e) => setRestockShortName(coverMenu.sectionId, coverMenu.lookId, pid, e.target.value)}
                        placeholder={autoShorts.get(pid) ? `前缀：${autoShorts.get(pid)}` : '翻单前缀'}
                        title="翻单周期每行的产品短名前缀（如 针织裤 / 开衫）；留空用自动推导"
                        className="mt-0.5 w-full rounded border border-edge-strong px-1 py-0.5 text-[10px] outline-none focus:border-edge"
                      />
                      <button
                        onClick={() => removePid(coverMenu.sectionId, coverMenu.lookId, pid)}
                        className="absolute -right-1 -top-1 hidden h-4 w-4 items-center justify-center rounded-full bg-action-primary text-white shadow-sm hover:bg-action-primary-hover group-hover:flex"
                        title="从坑位移除"
                      >
                        <X size={9} />
                      </button>
                    </div>
                  );
                })}
              </div>
              <input
                ref={uploadInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleUpload}
              />
              <div className="mt-4 flex items-center justify-between border-t border-edge-muted pt-3">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => uploadInputRef.current?.click()}
                    className="flex items-center gap-1.5 rounded-md border border-edge-strong px-3 py-1.5 text-[12px] hover:border-edge"
                    title="上传自己的主图，替换当前坑位主图（不影响其它坑位）"
                  >
                    <Camera size={13} />
                    {cmLook.userImg ? '重新上传主图' : '上传自己的主图'}
                  </button>
                  {cmLook.userImg && (
                    <button
                      onClick={handleRemoveUserImg}
                      className="flex items-center gap-1.5 rounded-md border border-edge-strong px-3 py-1.5 text-[12px] hover:border-edge"
                      title="清除自传图，回退到封面款号原图（不会删除服务端文件）"
                    >
                      <Trash2 size={12} />
                      移除自传图
                    </button>
                  )}
                </div>
                <button onClick={() => setCoverMenu(null)} className="rounded-md border border-edge-strong px-3 py-1.5 text-[12px] hover:border-edge">
                  完成
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* 修改记录抽屉：谁、什么时间、改了什么 */}
      {showLog && tray && (
        <div className="fixed inset-0 z-50 print:hidden" onClick={() => setShowLog(false)}>
          <div className="absolute inset-0 bg-black/30" />
          <div
            role="dialog" aria-modal="true" aria-label="修改记录" className="tray-history absolute right-0 top-0 flex h-full w-[380px] flex-col border-l border-edge bg-surface-card shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-edge px-4 py-3">
              <div className="text-[13px] font-medium text-ink-primary">
                修改记录 · {tray.name}
              </div>
              <button onClick={() => setShowLog(false)} className="rounded p-1 hover:bg-surface-subtle" title="关闭">
                <X size={15} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-3">
              {logLoading ? (
                <div className="py-10 text-center text-[12px] text-ink-muted">加载中…</div>
              ) : logEntries.length === 0 ? (
                <div className="py-10 text-center text-[12px] text-ink-muted">暂无修改记录</div>
              ) : (
                <ul className="space-y-2">
                  {logEntries.map((e) => {
                    const d = new Date(e.at);
                    const time = Number.isNaN(d.getTime())
                      ? e.at
                      : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
                    return (
                      <li key={e.id} className="rounded-md border border-edge px-3 py-2 text-[12px]">
                        <div className="flex items-center justify-between">
                          <span className="font-medium text-ink-primary">{e.user || '匿名'}</span>
                          <span className="text-[11px] text-ink-muted">{time}</span>
                        </div>
                        <div className="mt-0.5 text-ink-secondary">
                          <span className="mr-1 rounded bg-surface-subtle px-1 py-0.5 text-[11px]">{e.action}</span>
                          {e.detail}
                        </div>
                        {e.change && (
                          <div className="mt-0.5 break-all font-mono text-[11px] leading-4 text-ink-muted">{e.change}</div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <div className="border-t border-edge px-4 py-2 text-right">
              <button
                onClick={() => {
                  setLogLoading(true);
                  fetchTrayLog(tray.id, 200)
                    .then((r) => setLogEntries(r.entries || []))
                    .catch(() => setLogEntries([]))
                    .finally(() => setLogLoading(false));
                }}
                className="rounded-md border border-edge-strong px-3 py-1 text-[12px] hover:border-edge"
              >
                刷新
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
