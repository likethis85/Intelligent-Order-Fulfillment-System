// 面料情况文本按颜色筛选：商品名称里只勾了部分色号时，面料行也只保留这些颜色。
// 面料文本形如「黑色1105米面料仓；灰色1345米面料仓」「米白151米…」，按 ；/; 分段，
// 每段开头的颜色名命中才保留；没有颜色开头的段（里料、供应商备注等）原样保留。
//
// 面料系统里的颜色叫法和商品颜色不一定完全一致（商品里是「灰」，面料里写「灰色」），
// 所以认颜色分两步：先查已知颜色（商品颜色 / 样衣颜色 / 勾选颜色），
// 认不出时再用「数字或『无面料』前面那段短词」当颜色名，并排除里料/供应商这类非颜色词。
const NON_COLOR_WORDS = /面料|里料|供应|定染|现货|仓库|仓|天|米|交期|备注|合计|未|无|每|条|件/;

function segmentColor(segment: string, known: string[]): string | null {
  const s = segment.trim();
  if (!s) return null;
  const knownHit = known.find((c) => s.startsWith(c));
  if (knownHit) return knownHit;
  // 「灰色1345米」「黑色：1105米」「灰色 1345米」「黑色无面料不翻单」→ 取数字/无面料前那段短词
  const m = s.match(/^([^\d\s；;，,、：:]+)[\s：:]*?(?=\d|无面料)/);
  if (!m) return null;
  const cand = m[1];
  if (cand.length > 6) return null;
  if (NON_COLOR_WORDS.test(cand)) return null;
  return cand;
}

function isVisibleColor(color: string, visible: string[]): boolean {
  const c = color.trim();
  if (!c) return false;
  // 「灰」和「灰色」视为同一个颜色
  return visible.some((v) => v === c || c.startsWith(v) || v.startsWith(c));
}

export function filterFabricTextByColors(
  text: string | null | undefined,
  visibleColors: string[] | undefined,
  knownColors: string[] = [],
): string {
  const raw = String(text ?? '');
  if (!raw || !visibleColors || visibleColors.length === 0) return raw;

  const visible = visibleColors.map((c) => String(c).trim()).filter(Boolean);
  if (visible.length === 0) return raw;
  // 已知颜色 + 可见颜色，长的优先匹配（「藏青」和「藏青色」并存时优先长的）
  const known = [...new Set([...knownColors, ...visible])]
    .map((c) => String(c).trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  return raw
    .split('\n')
    .map((line) => {
      if (!line.trim()) return '';
      const parts = line.split(/([；;、])/);
      const out: string[] = [];
      for (let i = 0; i < parts.length; i += 2) {
        const segment = parts[i] ?? '';
        const sep = parts[i + 1] ?? '';
        // 1) 颜色写在段首：按它判断
        const color = segmentColor(segment, known);
        if (color && !isVisibleColor(color, visible)) continue;
        // 2) 段首认不出颜色，但段里出现了已知颜色名（如「面料仓现货：黑色1105米」）：
        //    只提到了没勾的颜色才丢；提到勾上的就保留
        if (!color) {
          const mentioned = known.filter((c) => segment.includes(c));
          if (mentioned.length > 0 && !mentioned.some((c) => isVisibleColor(c, visible))) continue;
        }
        out.push(segment, sep);
      }
      while (out.length > 0 && /^[；;、]$/.test(out[out.length - 1])) out.pop();
      return out.join('').trim();
    })
    .filter((line) => line.trim())
    .join('\n');
}
