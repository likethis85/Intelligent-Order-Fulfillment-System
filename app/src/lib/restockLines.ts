// 翻单周期的行拆分：一个坑位挂多个款号（套装：针织裤 + 开衫、外套 + 半裙…）时，
// 两个款号往往收到的是同一批「颜色 + 件数 + 天数」记录，加上商品前缀就会变成一倍重复行。
// 套装坑位按整行去重、不带前缀；单款坑位保持原样（可带短名前缀）。
export function suitRestockLines(
  ps: { id: string; restock?: string }[],
  overrides: Record<string, string> = {},
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of ps) {
    const raw = overrides[p.id] ?? p.restock ?? '';
    for (const line of String(raw).split('\n')) {
      const text = line.trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      out.push(text);
    }
  }
  return out;
}
