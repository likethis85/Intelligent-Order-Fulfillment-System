// 二十四节气上下文：当前节气、备货提示、近期节点（移植自 weather 项目 solar_terms.py）
// 弥补 Open-Meteo 仅 16 天数值预报的局限：节气提供约 15 天一节气的中长期节奏参考
import { TERM_DATES, TERM_GUIDANCE } from './solarTermData';

export interface TermEvent {
  name: string;
  date: string; // YYYY-MM-DD
}

export interface SolarTermContext {
  current: { name: string; date: string; dayInTerm: number; daysUntilNext: number | null; nextName: string | null; guidanceTip: string; focus: string[]; tempBand: string };
  season: 'spring' | 'summer' | 'autumn' | 'winter';
  seasonLabel: string;
  upcoming: { name: string; date: string; daysAway: number }[];
  outlook: string;
}

const SPRING = new Set(['立春', '雨水', '惊蛰', '春分', '清明', '谷雨']);
const SUMMER = new Set(['立夏', '小满', '芒种', '夏至', '小暑', '大暑']);
const AUTUMN = new Set(['立秋', '处暑', '白露', '秋分', '寒露', '霜降']);

const dayMs = 86400_000;

function parseYmd(s: string): number {
  return new Date(s + 'T00:00:00+08:00').getTime();
}

function yearTerms(year: number): TermEvent[] {
  const table = TERM_DATES[year];
  if (table) return table.map(([name, date]) => ({ name, date }));
  // 无历表年份：以 2025 为基准平移（误差通常 ±1 天，仅兜底）
  const base = TERM_DATES[2025];
  const delta = year - 2025;
  return base.map(([name, date]) => {
    const d = new Date(date + 'T00:00:00+08:00');
    const shifted = new Date(d.getTime());
    shifted.setFullYear(year);
    // 粗略闰年校正：每 4 年节气整体略漂移
    shifted.setDate(shifted.getDate() + Math.floor(delta / 4));
    const ym = `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, '0')}-${String(shifted.getDate()).padStart(2, '0')}`;
    return { name, date: ym };
  });
}

// 跨年连续节气时间线（定位「当前节气」用）
function timeline(aroundYmd: string): TermEvent[] {
  const year = Number(aroundYmd.slice(0, 4));
  const events: TermEvent[] = [];
  for (const y of [year - 1, year, year + 1]) events.push(...yearTerms(y));
  const seen = new Set<string>();
  return events
    .sort((a, b) => parseYmd(a.date) - parseYmd(b.date))
    .filter((e) => {
      const k = e.name + e.date;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

export function getSolarTermContext(todayYmd?: string, tempTrend: 'rising' | 'falling' | 'stable' = 'stable'): SolarTermContext {
  const now = todayYmd ? parseYmd(todayYmd) : Date.now();
  const today = new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
  const tl = timeline(today);
  const t = parseYmd(today);

  let idx = -1;
  for (let i = 0; i < tl.length; i++) {
    if (parseYmd(tl[i].date) <= t) idx = i;
    else break;
  }
  const current = tl[idx];
  const next = tl[idx + 1];
  const g = TERM_GUIDANCE[current.name] || { tempBand: '', focus: [], tip: '' };
  const daysUntilNext = next ? Math.round((parseYmd(next.date) - t) / dayMs) : null;

  const upcoming = tl
    .slice(idx + 1, idx + 6)
    .map((e) => ({ name: e.name, date: e.date, daysAway: Math.round((parseYmd(e.date) - t) / dayMs) }));

  const season = SPRING.has(current.name) ? 'spring' : SUMMER.has(current.name) ? 'summer' : AUTUMN.has(current.name) ? 'autumn' : 'winter';
  const seasonLabel = { spring: '春季', summer: '夏季', autumn: '秋季', winter: '冬季' }[season];

  const horizonEnd = t + 15 * dayMs; // 16 天数值预报窗口
  const beyond = upcoming.filter((u) => parseYmd(u.date) > horizonEnd).slice(0, 3);

  const trendNote = {
    rising: '数值预报显示短期升温，若与节气偏凉指引冲突，以近 7 日实况温度规则为准。',
    falling: '数值预报显示短期降温，可与节气换季指引相互印证，加大外套/针织权重。',
    stable: '短期气温平稳，节气节点可作为下一波段备货节奏的主要参考。',
  }[tempTrend];

  const parts = [`当前「${current.name}」（第 ${Math.round((t - parseYmd(current.date)) / dayMs) + 1} 天），${g.tip}`];
  if (daysUntilNext != null && next) parts.push(`约 ${daysUntilNext} 天后进入「${next.name}」。`);
  if (beyond.length > 0) parts.push(`超出 16 天数值预报后，近期节气节点：${beyond.map((b) => `「${b.name}」(${b.daysAway}天后)`).join('、')}。`);
  parts.push(trendNote);

  return {
    current: {
      name: current.name,
      date: current.date,
      dayInTerm: Math.round((t - parseYmd(current.date)) / dayMs) + 1,
      daysUntilNext,
      nextName: next?.name ?? null,
      guidanceTip: g.tip,
      focus: g.focus,
      tempBand: g.tempBand,
    },
    season,
    seasonLabel,
    upcoming,
    outlook: parts.join(''),
  };
}

// 某天所在的节气（预报日标注用）；早于首个节气返回 null
export function termOn(ymd: string): string | null {
  const tl = timeline(ymd);
  const t = parseYmd(ymd);
  let name: string | null = null;
  for (const e of tl) {
    if (parseYmd(e.date) <= t) name = e.name;
    else break;
  }
  return name;
}
