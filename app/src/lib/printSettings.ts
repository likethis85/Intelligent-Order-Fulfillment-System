/**
 * 打印设置模型与样式注入引擎
 * 支持：纸张大小（A3/A4/B4等）、页面方向（横向/纵向）、缩放比例（40%~150%）及页边距
 */

export type PaperSize = 'A3' | 'A4' | 'A5' | 'B4' | 'B5' | 'Letter' | 'Legal';
export type PageOrientation = 'landscape' | 'portrait';

export interface PrintSettings {
  paperSize: PaperSize;
  orientation: PageOrientation;
  scaleRatio: number; // 40 - 150 整数百分比
  marginMm: number; // 0, 4, 8, 15
  hideBackupSections?: boolean;
}

export interface PaperInfo {
  name: PaperSize;
  widthMm: number;
  heightMm: number;
  desc: string;
  tag?: string;
  recommendedLandscapeScale: number;
  recommendedPortraitScale: number;
}

export const PAPER_SIZES: Record<PaperSize, PaperInfo> = {
  A3: {
    name: 'A3',
    widthMm: 420,
    heightMm: 297,
    desc: '420 × 297 mm',
    tag: '货盘宽表推荐',
    recommendedLandscapeScale: 80,
    recommendedPortraitScale: 55,
  },
  A4: {
    name: 'A4',
    widthMm: 297,
    heightMm: 210,
    desc: '297 × 210 mm',
    tag: '日常标准办公',
    recommendedLandscapeScale: 58,
    recommendedPortraitScale: 45,
  },
  B4: {
    name: 'B4',
    widthMm: 353,
    heightMm: 250,
    desc: '353 × 250 mm',
    tag: '中号排版',
    recommendedLandscapeScale: 70,
    recommendedPortraitScale: 50,
  },
  B5: {
    name: 'B5',
    widthMm: 250,
    heightMm: 176,
    desc: '250 × 176 mm',
    tag: '紧凑版面',
    recommendedLandscapeScale: 50,
    recommendedPortraitScale: 40,
  },
  A5: {
    name: 'A5',
    widthMm: 210,
    heightMm: 148,
    desc: '210 × 148 mm',
    tag: '便携卡片',
    recommendedLandscapeScale: 45,
    recommendedPortraitScale: 35,
  },
  Letter: {
    name: 'Letter',
    widthMm: 279,
    heightMm: 216,
    desc: '216 × 279 mm',
    tag: '美规标准',
    recommendedLandscapeScale: 55,
    recommendedPortraitScale: 45,
  },
  Legal: {
    name: 'Legal',
    widthMm: 356,
    heightMm: 216,
    desc: '216 × 356 mm',
    tag: '美规长纸',
    recommendedLandscapeScale: 70,
    recommendedPortraitScale: 45,
  },
};

export const DEFAULT_PRINT_SETTINGS: PrintSettings = {
  paperSize: 'A3',
  orientation: 'landscape',
  scaleRatio: 80,
  marginMm: 8,
  hideBackupSections: false,
};

const STORAGE_KEY = 'marius:print-settings:v1';
const DYNAMIC_STYLE_ID = 'marius-print-dynamic-style';

/**
 * 读取当前已保存的打印设置
 */
export function getPrintSettings(): PrintSettings {
  if (typeof window === 'undefined') return DEFAULT_PRINT_SETTINGS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PRINT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<PrintSettings>;
    return {
      paperSize: parsed.paperSize && PAPER_SIZES[parsed.paperSize] ? parsed.paperSize : DEFAULT_PRINT_SETTINGS.paperSize,
      orientation: parsed.orientation === 'portrait' ? 'portrait' : 'landscape',
      scaleRatio: typeof parsed.scaleRatio === 'number' && parsed.scaleRatio >= 30 && parsed.scaleRatio <= 200 ? Math.round(parsed.scaleRatio) : DEFAULT_PRINT_SETTINGS.scaleRatio,
      marginMm: typeof parsed.marginMm === 'number' ? parsed.marginMm : DEFAULT_PRINT_SETTINGS.marginMm,
      hideBackupSections: Boolean(parsed.hideBackupSections),
    };
  } catch {
    return DEFAULT_PRINT_SETTINGS;
  }
}

/**
 * 持久化打印设置
 */
export function savePrintSettings(settings: PrintSettings): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // 忽略异常
  }
}

/**
 * 获取当前纸张与方向下的推荐缩放比例
 */
export function getRecommendedScale(paperSize: PaperSize, orientation: PageOrientation): number {
  const info = PAPER_SIZES[paperSize] ?? PAPER_SIZES.A3;
  return orientation === 'landscape' ? info.recommendedLandscapeScale : info.recommendedPortraitScale;
}

/**
 * 将打印样式动态写入 document.head 中的 <style id="marius-print-dynamic-style">
 */
export function applyPrintStyles(settings: PrintSettings): void {
  if (typeof document === 'undefined') return;

  let styleEl = document.getElementById(DYNAMIC_STYLE_ID) as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = DYNAMIC_STYLE_ID;
    document.head.appendChild(styleEl);
  }

  const { paperSize, orientation, scaleRatio, marginMm, hideBackupSections } = settings;
  const zoomFactor = Math.max(0.3, Math.min(2.0, scaleRatio / 100));

  styleEl.textContent = `
@media print {
  @page {
    size: ${paperSize} ${orientation};
    margin: ${marginMm}mm;
  }

  * {
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }

  html, body {
    zoom: ${zoomFactor} !important;
    background: #ffffff !important;
    color: #111827 !important;
    overflow: visible !important;
    width: 100% !important;
    margin: 0 !important;
    padding: 0 !important;
  }

  main, .app-main {
    padding-top: 0 !important;
    margin: 0 !important;
  }

  .responsive-page, .sequence-page, .trays-page {
    padding: 0 !important;
    margin: 0 !important;
  }

  .tray-sheet {
    overflow: visible !important;
  }

  .tray-zoom-inner {
    zoom: 1 !important;
    width: 100% !important;
  }

  table {
    page-break-inside: auto;
  }

  tr {
    page-break-inside: avoid;
    page-break-after: auto;
  }

  /* 打印时隐藏纯交互元素 */
  header,
  .app-header,
  .mobile-nav,
  .mobile-zoom-toolbar,
  .mobile-scroll-hint,
  .tray-actions,
  .tray-sections,
  .sequence-toolbar,
  .sequence-presets,
  .print-hidden,
  [data-slot="dialog-portal"],
  [data-slot="dialog-overlay"] {
    display: none !important;
  }

  ${hideBackupSections ? '.tray-section-backup { display: none !important; }' : ''}
}
`;
}

/**
 * 系统初始化时注入一次保存的打印样式
 */
export function initPrintStyles(): void {
  const current = getPrintSettings();
  applyPrintStyles(current);
}

/**
 * 应用设置并触发浏览器打印
 */
export function triggerPrint(settings?: PrintSettings): void {
  const active = settings ?? getPrintSettings();
  savePrintSettings(active);
  applyPrintStyles(active);

  // 稍微延迟一帧以确保 style 样式表已被浏览器 DOM 解析
  requestAnimationFrame(() => {
    setTimeout(() => {
      window.print();
    }, 50);
  });
}
