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
