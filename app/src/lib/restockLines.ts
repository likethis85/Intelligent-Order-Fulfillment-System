// 翻单周期的行拆分：一个坑位挂多个款号（套装：针织裤 + 开衫、外套 + 半裙…）时，
// 两个款号往往收到的是同一批「颜色 件数 天数」记录，加上商品前缀就会变成一倍重复行。
// 套装坑位按整行去重、不带前缀；单款坑位保持原样（可带短名前缀）。
//
// 去重口径是「整行完全一致」——颜色、件数、天数都相同才算重复。
// 同一个颜色翻单量不一样（针织裤 沙丘驼 200件25天 / 开衫 沙丘驼 260件30天）必须两条都留着，
// 不能按颜色去重，否则会吞掉一个款号的翻单记录。
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
      if (!text) continue;
      // 只把空白差异（多个空格 / 全角空格）当同一条，其余任何字符不同都保留
      const key = text.replace(/[\s　]+/g, ' ');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(text);
    }
  }
  return out;
}
