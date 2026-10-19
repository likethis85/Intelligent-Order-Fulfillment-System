import { useState, useEffect, useMemo } from 'react';
import {
  Printer, RotateCcw, Check, Sparkles, Sliders, FileText,
  Layout, AlertCircle, Info, ChevronRight
} from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Slider } from '@/components/ui/slider';
import {
  type PaperSize,
  type PageOrientation,
  type PrintSettings,
  PAPER_SIZES,
  DEFAULT_PRINT_SETTINGS,
  getPrintSettings,
  savePrintSettings,
  applyPrintStyles,
  triggerPrint,
  getRecommendedScale,
} from '@/lib/printSettings';

interface PrintSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  showHideBackupOption?: boolean;
}

const PRESET_SCALES = [50, 60, 70, 75, 80, 90, 100, 120];

const MARGIN_OPTIONS = [
  { label: '默认边距 (8mm)', value: 8 },
  { label: '窄边距 (4mm)', value: 4 },
  { label: '宽边距 (15mm)', value: 15 },
  { label: '无边距 (0mm)', value: 0 },
];

export default function PrintSettingsDialog({
  open,
  onOpenChange,
  title = '打印设置',
  showHideBackupOption = true,
}: PrintSettingsDialogProps) {
  const [settings, setSettings] = useState<PrintSettings>(getPrintSettings());

  // 打开弹窗时重新载入已持久化的设置
  useEffect(() => {
    if (open) {
      setSettings(getPrintSettings());
    }
  }, [open]);

  const recommendedScale = useMemo(
    () => getRecommendedScale(settings.paperSize, settings.orientation),
    [settings.paperSize, settings.orientation],
  );

  const paperInfo = PAPER_SIZES[settings.paperSize] ?? PAPER_SIZES.A3;

  const handleSelectPaper = (size: PaperSize) => {
    const nextRecommended = getRecommendedScale(size, settings.orientation);
    setSettings((prev) => ({
      ...prev,
      paperSize: size,
      // 如果当前缩放是旧尺寸推荐值，顺带切换到新尺寸推荐值
      scaleRatio: prev.scaleRatio === recommendedScale ? nextRecommended : prev.scaleRatio,
    }));
  };

  const handleSelectOrientation = (orientation: PageOrientation) => {
    const nextRecommended = getRecommendedScale(settings.paperSize, orientation);
    setSettings((prev) => ({
      ...prev,
      orientation,
      scaleRatio: prev.scaleRatio === recommendedScale ? nextRecommended : prev.scaleRatio,
    }));
  };

  const handleReset = () => {
    setSettings(DEFAULT_PRINT_SETTINGS);
    savePrintSettings(DEFAULT_PRINT_SETTINGS);
    applyPrintStyles(DEFAULT_PRINT_SETTINGS);
    toast.success('已恢复为默认打印配置（A3 · 横向 · 80%）');
  };

  const handlePrint = () => {
    savePrintSettings(settings);
    applyPrintStyles(settings);
    onOpenChange(false);
    toast.info('正在调起浏览器打印窗口…');
    triggerPrint(settings);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[720px] p-0 overflow-hidden bg-surface-card border-edge">
        {/* 顶部标题区 */}
        <div className="border-b border-edge bg-gradient-to-r from-surface-card via-surface-subtle to-surface-card px-6 py-4">
          <DialogHeader className="gap-1">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-action-link/10 text-action-link shadow-xs">
                <Printer size={17} />
              </span>
              <DialogTitle className="text-base font-bold text-ink-primary">
                {title}
              </DialogTitle>
            </div>
            <DialogDescription className="text-xs text-ink-muted">
              自定义打印纸张大小、页面方向与缩放比例，系统将自动适配版面排版
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="max-h-[75vh] overflow-y-auto px-6 py-5 space-y-6">
          {/* 实时纸张版式缩略预览 */}
          <div className="rounded-xl border border-edge bg-surface-subtle/60 p-4">
            <div className="flex items-center justify-between text-xs font-semibold text-ink-primary mb-3">
              <span className="flex items-center gap-1.5">
                <Layout size={13} className="text-action-link" />
                排版版面预览
              </span>
              <div className="flex items-center gap-2">
                <span className="rounded bg-surface-card px-2 py-0.5 text-[11px] font-medium text-ink-secondary border border-edge">
                  {paperInfo.name} · {settings.orientation === 'landscape' ? '横向' : '纵向'} · {settings.scaleRatio}% 缩放
                </span>
                <span className="text-[11px] text-ink-muted">边距 {settings.marginMm}mm</span>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row items-center gap-5 justify-center py-2">
              {/* 纸张模型 */}
              <div className="relative flex items-center justify-center">
                <div
                  className="relative rounded-md border-2 border-edge-strong bg-white shadow-md transition-all duration-300 overflow-hidden"
                  style={{
                    width: settings.orientation === 'landscape' ? '180px' : '130px',
                    height: settings.orientation === 'landscape' ? '128px' : '176px',
                    padding: `${Math.max(4, Math.round(settings.marginMm * 0.8))}px`,
                  }}
                >
                  {/* 模拟页面内容微缩结构 */}
                  <div className="h-full w-full flex flex-col justify-between rounded border border-dashed border-slate-200 p-1.5 bg-slate-50/60">
                    <div>
                      {/* 模拟标题行 */}
                      <div className="h-2 w-2/5 rounded bg-slate-400/80 mb-1" />
                      <div className="h-1 w-3/5 rounded bg-slate-300 mb-2" />
                      {/* 模拟表格网格 */}
                      <div
                        className="grid gap-1 transition-all duration-300"
                        style={{
                          gridTemplateColumns: `repeat(${settings.orientation === 'landscape' ? 6 : 4}, minmax(0, 1fr))`,
                          transform: `scale(${Math.max(0.6, Math.min(1.2, settings.scaleRatio / 100))})`,
                          transformOrigin: 'top left',
                        }}
                      >
                        {Array.from({ length: settings.orientation === 'landscape' ? 12 : 8 }).map((_, i) => (
                          <div key={i} className="h-5 rounded bg-slate-200/90 border border-slate-300/50 flex items-center justify-center">
                            <div className="h-1.5 w-1.5 rounded-full bg-slate-400/60" />
                          </div>
                        ))}
                      </div>
                    </div>
                    {/* 页底 */}
                    <div className="flex items-center justify-between pt-1 border-t border-slate-200 text-[8px] text-slate-400">
                      <span>第 1 页</span>
                      <span>Marius 货盘</span>
                    </div>
                  </div>

                  {/* 纸张角落方向角标 */}
                  <span className="absolute top-1 right-1.5 text-[9px] font-bold text-slate-400 select-none">
                    {paperInfo.name}
                  </span>
                </div>
              </div>

              {/* 推荐度提示 */}
              <div className="flex-1 text-xs space-y-1.5">
                <div className="flex items-center gap-1.5 font-medium text-ink-primary">
                  {settings.scaleRatio === recommendedScale ? (
                    <span className="flex items-center gap-1 text-stage-success-fg">
                      <Sparkles size={12} /> 当前已采用黄金推荐缩放（{settings.scaleRatio}%）
                    </span>
                  ) : settings.scaleRatio > recommendedScale + 20 ? (
                    <span className="flex items-center gap-1 text-stage-return-fg">
                      <AlertCircle size={12} /> 当前缩放偏大，较多坑位时可能分页，建议降至 {recommendedScale}%
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-ink-secondary">
                      <Info size={12} /> 自定义缩放模式（推荐基准: {recommendedScale}%）
                    </span>
                  )}
                </div>
                <p className="text-ink-muted leading-relaxed text-[11.5px]">
                  {settings.orientation === 'landscape'
                    ? `${paperInfo.name} 横向排版适合 8 坑位宽表展示，坑位卡片并列舒展清晰。`
                    : `${paperInfo.name} 纵向排版适合列表视图或按场次时序打印。`}
                </p>
                {settings.scaleRatio !== recommendedScale && (
                  <button
                    type="button"
                    onClick={() => setSettings((s) => ({ ...s, scaleRatio: recommendedScale }))}
                    className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold text-action-link hover:underline"
                  >
                    一键应用推荐缩放 ({recommendedScale}%) <ChevronRight size={11} />
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* 1. 纸张大小设置 */}
          <div>
            <div className="flex items-center justify-between mb-2.5">
              <label className="text-xs font-bold text-ink-primary flex items-center gap-1.5">
                <FileText size={13} className="text-action-link" />
                1. 纸张大小 (Paper Size)
              </label>
              <span className="text-[11px] text-ink-muted">选定规格: {paperInfo.desc}</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {(Object.keys(PAPER_SIZES) as PaperSize[]).map((size) => {
                const info = PAPER_SIZES[size];
                const active = settings.paperSize === size;
                return (
                  <button
                    key={size}
                    type="button"
                    onClick={() => handleSelectPaper(size)}
                    className={`relative flex flex-col items-start p-2.5 rounded-lg border text-left transition-all ${
                      active
                        ? 'border-action-link bg-action-link/5 ring-1 ring-action-link shadow-xs'
                        : 'border-edge hover:border-edge-strong bg-surface-card hover:bg-surface-subtle'
                    }`}
                  >
                    <div className="flex items-center justify-between w-full">
                      <span className={`text-sm font-bold ${active ? 'text-action-link' : 'text-ink-primary'}`}>
                        {info.name}
                      </span>
                      {active && <Check size={13} className="text-action-link" />}
                    </div>
                    <span className="mt-0.5 text-[10.5px] text-ink-muted">{info.desc}</span>
                    {info.tag && (
                      <span
                        className={`mt-1.5 inline-block text-[9.5px] px-1.5 py-0.2 rounded font-medium ${
                          active ? 'bg-action-link text-white' : 'bg-surface-subtle text-ink-secondary border border-edge'
                        }`}
                      >
                        {info.tag}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 2. 页面方向设置 */}
          <div>
            <label className="text-xs font-bold text-ink-primary flex items-center gap-1.5 mb-2.5">
              <Layout size={13} className="text-action-link" />
              2. 页面方向 (Page Orientation)
            </label>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => handleSelectOrientation('landscape')}
                className={`flex items-center gap-3.5 p-3 rounded-lg border text-left transition-all ${
                  settings.orientation === 'landscape'
                    ? 'border-action-link bg-action-link/5 ring-1 ring-action-link shadow-xs'
                    : 'border-edge hover:border-edge-strong bg-surface-card hover:bg-surface-subtle'
                }`}
              >
                {/* 横向示意图 */}
                <div
                  className={`flex h-9 w-12 shrink-0 items-center justify-center rounded border-2 ${
                    settings.orientation === 'landscape' ? 'border-action-link bg-action-link/10' : 'border-edge-strong bg-surface-subtle'
                  }`}
                >
                  <div className="space-y-0.5 w-8">
                    <div className="h-1 w-full bg-current rounded-xs opacity-60" />
                    <div className="h-1 w-3/4 bg-current rounded-xs opacity-40" />
                  </div>
                </div>
                <div>
                  <div className="flex items-center gap-1 text-xs font-bold text-ink-primary">
                    横向 (Landscape)
                    {settings.orientation === 'landscape' && <Check size={12} className="text-action-link" />}
                  </div>
                  <div className="text-[11px] text-ink-muted mt-0.5">适合宽表格与多坑位并列（推荐）</div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => handleSelectOrientation('portrait')}
                className={`flex items-center gap-3.5 p-3 rounded-lg border text-left transition-all ${
                  settings.orientation === 'portrait'
                    ? 'border-action-link bg-action-link/5 ring-1 ring-action-link shadow-xs'
                    : 'border-edge hover:border-edge-strong bg-surface-card hover:bg-surface-subtle'
                }`}
              >
                {/* 纵向示意图 */}
                <div
                  className={`flex h-12 w-9 shrink-0 items-center justify-center rounded border-2 ${
                    settings.orientation === 'portrait' ? 'border-action-link bg-action-link/10' : 'border-edge-strong bg-surface-subtle'
                  }`}
                >
                  <div className="space-y-1 w-5">
                    <div className="h-1 w-full bg-current rounded-xs opacity-60" />
                    <div className="h-1 w-full bg-current rounded-xs opacity-40" />
                    <div className="h-1 w-2/3 bg-current rounded-xs opacity-30" />
                  </div>
                </div>
                <div>
                  <div className="flex items-center gap-1 text-xs font-bold text-ink-primary">
                    纵向 (Portrait)
                    {settings.orientation === 'portrait' && <Check size={12} className="text-action-link" />}
                  </div>
                  <div className="text-[11px] text-ink-muted mt-0.5">适合时序单行清单与垂直排版</div>
                </div>
              </button>
            </div>
          </div>

          {/* 3. 缩放比例设置 */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-bold text-ink-primary flex items-center gap-1.5">
                <Sliders size={13} className="text-action-link" />
                3. 缩放比例 (Scale Ratio)
              </label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setSettings((s) => ({ ...s, scaleRatio: Math.max(40, s.scaleRatio - 5) }))}
                  className="flex h-6 w-6 items-center justify-center rounded border border-edge bg-surface-card text-xs font-bold hover:bg-surface-subtle"
                  title="缩小 5%"
                >
                  -
                </button>
                <span className="min-w-14 text-center rounded-md bg-action-link/10 border border-action-link/20 px-2 py-0.5 text-xs font-bold text-action-link">
                  {settings.scaleRatio}%
                </span>
                <button
                  type="button"
                  onClick={() => setSettings((s) => ({ ...s, scaleRatio: Math.min(150, s.scaleRatio + 5) }))}
                  className="flex h-6 w-6 items-center justify-center rounded border border-edge bg-surface-card text-xs font-bold hover:bg-surface-subtle"
                  title="放大 5%"
                >
                  +
                </button>
              </div>
            </div>

            {/* 滑块 */}
            <div className="px-1 py-2">
              <Slider
                value={[settings.scaleRatio]}
                min={40}
                max={150}
                step={1}
                onValueChange={([val]) => {
                  if (typeof val === 'number') {
                    setSettings((s) => ({ ...s, scaleRatio: val }));
                  }
                }}
              />
              <div className="flex justify-between text-[10px] text-ink-muted mt-1.5">
                <span>40% 紧凑极小</span>
                <span className="font-medium text-ink-secondary">推荐 {recommendedScale}%</span>
                <span>150% 大字清晰</span>
              </div>
            </div>

            {/* 常用预设比例徽标 */}
            <div className="flex flex-wrap items-center gap-1.5 mt-2">
              <span className="text-[11px] text-ink-muted mr-1">快捷预设:</span>
              {PRESET_SCALES.map((pct) => (
                <button
                  key={pct}
                  type="button"
                  onClick={() => setSettings((s) => ({ ...s, scaleRatio: pct }))}
                  className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
                    settings.scaleRatio === pct
                      ? 'bg-action-link text-white shadow-xs'
                      : 'border border-edge bg-surface-card text-ink-secondary hover:bg-surface-subtle'
                  }`}
                >
                  {pct}%
                </button>
              ))}
              {settings.scaleRatio !== recommendedScale && (
                <button
                  type="button"
                  onClick={() => setSettings((s) => ({ ...s, scaleRatio: recommendedScale }))}
                  className="rounded border border-dashed border-action-link bg-action-link/5 px-2 py-0.5 text-[11px] font-medium text-action-link hover:bg-action-link/10"
                >
                  智能推荐 {recommendedScale}%
                </button>
              )}
            </div>
          </div>

          {/* 4. 辅助选项：页边距与备用版块 */}
          <div className="rounded-lg border border-edge p-3.5 bg-surface-card space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <span className="text-xs font-semibold text-ink-primary">打印边距 (Page Margin)</span>
              <div className="flex flex-wrap items-center gap-1">
                {MARGIN_OPTIONS.map((m) => (
                  <button
                    key={m.value}
                    type="button"
                    onClick={() => setSettings((s) => ({ ...s, marginMm: m.value }))}
                    className={`rounded px-2 py-1 text-[11px] transition-colors ${
                      settings.marginMm === m.value
                        ? 'bg-ink-primary text-white font-medium'
                        : 'border border-edge bg-surface-subtle text-ink-secondary hover:text-ink-primary'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            {showHideBackupOption && (
              <div className="flex items-center justify-between pt-2.5 border-t border-edge-muted text-xs">
                <div>
                  <span className="font-semibold text-ink-primary">隐藏备用版块</span>
                  <p className="text-[11px] text-ink-muted">打印时自动排除归入「备用」的暂存坑位</p>
                </div>
                <input
                  type="checkbox"
                  id="hide-backup-checkbox"
                  checked={Boolean(settings.hideBackupSections)}
                  onChange={(e) => setSettings((s) => ({ ...s, hideBackupSections: e.target.checked }))}
                  className="h-4 w-4 rounded border-edge text-action-link focus:ring-action-link cursor-pointer"
                />
              </div>
            )}
          </div>
        </div>

        {/* 底部操作条 */}
        <div className="flex items-center justify-between border-t border-edge bg-surface-subtle/50 px-6 py-3.5">
          <button
            type="button"
            onClick={handleReset}
            className="flex items-center gap-1.5 rounded-md border border-edge bg-surface-card px-3 py-1.5 text-xs text-ink-secondary hover:bg-surface-subtle hover:text-ink-primary"
            title="恢复默认设置（A3 · 横向 · 80% 缩放）"
          >
            <RotateCcw size={12} /> 恢复默认
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded-md border border-edge bg-surface-card px-3.5 py-1.5 text-xs text-ink-secondary hover:bg-surface-subtle"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handlePrint}
              className="flex items-center gap-1.5 rounded-md bg-action-primary px-4 py-1.5 text-xs font-semibold text-white shadow-sm hover:opacity-95 active:scale-[0.98] transition-all"
            >
              <Printer size={13} />
              立即打印 (Enter)
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
