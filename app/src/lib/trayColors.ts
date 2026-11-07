// 货盘颜色行的纯逻辑：候选色号、拆分/拼接文案、与「自动拼接」是否一致
// 颜色行以前只能整段手输（"黑色 / 金扣黑带身" 一大串，分不清哪个是哪个），
// 现在点开弹窗按款号列出每个色号（SKC + 颜色）逐条勾选，勾完再拼回同一段文案，
// 所以存储格式（colorOverrideByLook[lookId] = "A / B"）和导出、协同合并都不用改。
import type { Product } from '../data/products';

export interface ColorOption {
  color: string;   // 颜色名（展示 + 保存）
  code?: string;   // 色号 / SKC 编码（列表里的小字）
  pid: string;     // 所属款号
  sample?: boolean; // 样衣阶段颜色（未转大货色）
}

// 文案里用 " / "（也兼容全角）分隔颜色
const SEP = /\s*[/／]\s*/;

export function splitColorText(text: string): string[] {
  const out: string[] = [];
  for (const raw of String(text || '').split(SEP)) {
    const color = raw.trim();
    if (color && !out.includes(color)) out.push(color);
  }
  return out;
}

export function joinColorText(colors: string[]): string {
  const out: string[] = [];
  for (const raw of colors) {
    const color = String(raw || '').trim();
    if (color && !out.includes(color)) out.push(color);
  }
  return out.join(' / ');
}

// 没设置 override 时展示的自动拼接：跨款号在库颜色去重后按顺序拼，样衣色追加在后
export function defaultColorText(ps: Product[], sampleColorsByPid?: Record<string, string[]>): string {
  const out: string[] = [];
  for (const p of ps) for (const c of p.colors ?? []) if (c && !out.includes(c)) out.push(c);
  for (const p of ps) for (const c of sampleColorsByPid?.[p.id] ?? []) if (c && !out.includes(c)) out.push(c);
  return out.join(' / ');
}

// 弹窗候选：先色号（SKC 带编码），再在库颜色，最后样衣色；同款号内按颜色名去重
export function buildColorOptions(input: {
  pids: string[];
  colorsByPid?: Record<string, string[]>;
  sampleColorsByPid?: Record<string, string[]>;
  skcsByPid?: Record<string, Array<{ code: string; color: string }>>;
}): ColorOption[] {
  const out: ColorOption[] = [];
  for (const pid of input.pids ?? []) {
    const seen = new Set<string>();
    const push = (opt: ColorOption) => {
      if (!opt.color || seen.has(opt.color)) return;
      seen.add(opt.color);
      out.push(opt);
    };
    for (const s of input.skcsByPid?.[pid] ?? []) push({ color: String(s.color || '').trim(), code: s.code, pid });
    for (const c of input.colorsByPid?.[pid] ?? []) push({ color: String(c || '').trim(), pid });
    for (const c of input.sampleColorsByPid?.[pid] ?? []) push({ color: String(c || '').trim(), pid, sample: true });
  }
  return out;
}

// 勾选结果 → 存储值；和自动拼接一致就存 ''（等于清除 override，颜色随款号自动变）
export function colorOverrideValue(colors: string[], defaultText: string): string {
  const text = joinColorText(colors);
  return text === defaultText ? '' : text;
}

// 库存行和颜色行的对应关系：BI 的颜色名可能比颜色行更细（"深灰千鸟" vs "深灰"），
// 所以双向包含即算命中；没解析出颜色的行（"其他"）保留，别把不可归类的库存藏掉
export function colorMatchesSelection(lineColor: string, visibleColors: string[]): boolean {
  const color = String(lineColor || '').trim();
  if (!color) return true;
  return visibleColors.some((v) => {
    const visible = v.trim();
    return Boolean(visible) && (color.includes(visible) || visible.includes(color));
  });
}

// ── 颜色字色：商品名称下面那行颜色可以逐条设字体颜色 ──
// 预设色挑的是深浅主题下都能看清的中间调；键是色值，label 只用于弹窗里的提示
export const COLOR_FG_PRESETS: Array<{ value: string; label: string }> = [
  { value: '#dc2626', label: '红' },
  { value: '#ea580c', label: '橙' },
  { value: '#ca8a04', label: '黄' },
  { value: '#16a34a', label: '绿' },
  { value: '#0891b2', label: '青' },
  { value: '#2563eb', label: '蓝' },
  { value: '#7c3aed', label: '紫' },
  { value: '#db2777', label: '粉' },
];

// 统一成 #rrggbb 小写（三位缩写补全）；认不出来就返回 ''，等于「用默认灰字」
export function normalizeHexColor(input: string): string {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const withHash = raw.startsWith('#') ? raw : `#${raw}`;
  const m = withHash.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (!m) return '';
  const hex = m[1].toLowerCase();
  return `#${hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex}`;
}

// 查某个颜色的字色：按颜色名精确匹配（颜色改名后旧色值就不再命中，跟色号一个口径）
export function colorFgOf(fgByColor: Record<string, string> | undefined, color: string): string {
  const key = String(color || '').trim();
  if (!key) return '';
  return normalizeHexColor(fgByColor?.[key] || '');
}

// 保存时只留仍然勾选的颜色对应的字色，删掉的颜色不再拖着一份配色
export function pruneColorFg(
  fgByColor: Record<string, string> | undefined,
  keptColors: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const color of keptColors) {
    const value = colorFgOf(fgByColor, color);
    if (value) out[color.trim()] = value;
  }
  return out;
}

// 落库前清洗：色值统一成 #rrggbb、键裁空白、丢掉认不出的色值。
// 注意这里**不能**再按「颜色文案」过滤：勾选没变时 colorOverrideByLook 存的是空串
// （等于「跟款号自动拼接」），字色却是要留的。以前拿文案当过滤条件，
// 结果只设字色、不动勾选的那份配色全被丢掉，表现就是「设了一个颜色生效，其他都没生效」。
export function cleanColorFg(fgByColor: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawColor, rawHex] of Object.entries(fgByColor ?? {})) {
    const color = String(rawColor || '').trim();
    const hex = normalizeHexColor(rawHex);
    if (color && hex) out[color] = hex;
  }
  return out;
}

// 颜色文案 → 分段（每段一个颜色和它的字色），页面和 Excel 导出共用
export function colorSegments(
  text: string,
  fgByColor?: Record<string, string>,
): Array<{ text: string; color: string }> {
  return splitColorText(text).map((c) => ({ text: c, color: colorFgOf(fgByColor, c) }));
}

// #rrggbb → ExcelJS 需要的 ARGB
export function hexToArgb(hex: string): string {
  const normalized = normalizeHexColor(hex);
  return normalized ? `FF${normalized.slice(1).toUpperCase()}` : '';
}

// 库存按颜色行里选中的颜色过滤：勾掉的色号不显示库存；一个都没匹配上（比如手动写了
// 系统里没有的颜色）就退回全量，避免整列库存被过滤成空
export function pickEntriesByColors<T extends { color: string }>(entries: T[], visibleColors?: string[]): T[] {
  const visible = (visibleColors ?? []).map((c) => c.trim()).filter(Boolean);
  if (visible.length === 0 || entries.length === 0) return entries;
  const kept = entries.filter((e) => colorMatchesSelection(e.color, visible));
  return kept.length > 0 ? kept : entries;
}
