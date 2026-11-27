// 面料情况文本按颜色筛选：商品名称里只勾了部分色号时，面料行也只保留这些颜色。
// 面料文本形如「黑色1105米面料仓；灰色1345米面料仓」「米白151米…」，按 ；/; 分段，
// 每段开头的颜色名命中才保留；没有颜色开头的段（里料、供应商备注等）原样保留。
export function filterFabricTextByColors(
  text: string | null | undefined,
  visibleColors: string[] | undefined,
  knownColors: string[] = [],
): string {
  const raw = String(text ?? '');
  if (!raw || !visibleColors || visibleColors.length === 0) return raw;

  const visible = new Set(visibleColors.map((c) => c.trim()).filter(Boolean));
  if (visible.size === 0) return raw;
  // 已知颜色 + 可见颜色，长的优先匹配（「藏青」和「藏青色」并存时优先长的）
  const known = [...new Set([...knownColors, ...visibleColors, ...visible])]
    .map((c) => String(c).trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  const colorOf = (segment: string): string | null => {
    const s = segment.trim();
    if (!s) return null;
    return known.find((c) => s.startsWith(c)) || null;
  };

  return raw
    .split('\n')
    .map((line) => {
      if (!line.trim()) return '';
      const parts = line.split(/([；;])/);
      const out: string[] = [];
      for (let i = 0; i < parts.length; i += 2) {
        const segment = parts[i] ?? '';
        const sep = parts[i + 1] ?? '';
        const color = colorOf(segment);
        // 只保留勾选的颜色；认不出颜色的段（里料/备注）照旧保留
        if (color && !visible.has(color)) continue;
        out.push(segment, sep);
      }
      while (out.length > 0 && /^[；;]$/.test(out[out.length - 1])) out.pop();
      return out.join('').trim();
    })
    .filter((line) => line.trim())
    .join('\n');
}
