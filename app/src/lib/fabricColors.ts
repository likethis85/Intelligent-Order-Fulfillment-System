// 面料情况文本按颜色筛选：商品名称里只勾了部分色号时，面料行也只保留这些颜色。
//
// 面料文本形如：
//   「黑色1105米面料仓；灰色1345米面料仓」           ← 颜色开头（面料查询写入的文案）
//   「ME15FF037流沙色1036米面料仓；深灰夹花354米」   ← SKC 色号开头（BI 面料列原文，颜色名是面料色）
// 后者颜色名对不上商品颜色，所以优先按 SKC 色号判断：勾选的颜色 → 对应 SKC 编码，
// 行里出现未被勾选的 SKC 编码就整段去掉；没有 SKC 编码的段再退回颜色名匹配。

export type ColorSku = { code?: string; color?: string };

// 颜色文案可能带款号/面料前缀（「全羊绒：黑色」「INCA:驼色」），取冒号后的颜色名
function normColor(name: string | null | undefined): string {
  let s = String(name ?? '').trim();
  const idx = Math.max(s.lastIndexOf('：'), s.lastIndexOf(':'));
  if (idx >= 0 && idx < s.length - 1) s = s.slice(idx + 1).trim();
  return s;
}

function sameColor(a: string, b: string): boolean {
  const x = normColor(a);
  const y = normColor(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

export function filterFabricTextByColors(
  text: string | null | undefined,
  visibleColors: string[] | undefined,
  knownColors: string[] = [],
  skus: ColorSku[] = [],
): string {
  const raw = String(text ?? '');
  const visible = [...new Set((visibleColors || []).map((c) => normColor(c)).filter(Boolean))];
  if (!raw || visible.length === 0) return raw;

  // 勾选的颜色 → SKC 编码（色号）。色号是精确的，优先用它判断。
  const selectedSkcs = new Set(
    (skus || [])
      .filter((s) => s?.code && visible.some((v) => sameColor(v, s.color || '')))
      .map((s) => String(s.code).trim().toUpperCase())
      .filter(Boolean),
  );
  const allSkcs = (skus || [])
    .map((s) => String(s.code || '').trim().toUpperCase())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  // 已知颜色 + 可见颜色，长的优先匹配（「藏青」和「藏青色」并存时优先长的）
  const known = [...new Set([...knownColors, ...visible].map((c) => normColor(c)).filter(Boolean))]
    .sort((a, b) => b.length - a.length);

  const skcOf = (segment: string): string | null => {
    const s = segment.toUpperCase();
    return allSkcs.find((code) => s.includes(code)) || null;
  };
  const colorOf = (segment: string): string | null => {
    const s = normColor(segment.split(/[；;]/)[0]);
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
        const skc = skcOf(segment);
        if (skc && selectedSkcs.size > 0) {
          // 有 SKC 编码就按色号判：勾选色对应的 SKC 才保留
          if (!selectedSkcs.has(skc)) continue;
          out.push(segment, sep);
          continue;
        }
        // 没编码的段：按颜色名判；认不出颜色（里料/备注）照旧保留
        const color = colorOf(segment);
        if (color && !visible.includes(color)) continue;
        out.push(segment, sep);
      }
      while (out.length > 0 && /^[；;]$/.test(out[out.length - 1])) out.pop();
      return out.join('').trim();
    })
    .filter((line) => line.trim())
    .join('\n');
}
