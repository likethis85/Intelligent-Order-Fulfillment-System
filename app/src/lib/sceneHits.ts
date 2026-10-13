// 场景规则 × 实时天气：自动判定命中（口径对齐 weather 项目配置后台 recommendation_rules.json）
//  - 雨天口径：降水概率 > 30% 记雨天（weather 项目雨天定义）
//  - 高湿口径：7 天平均湿度（weather 项目 HIGH_HUMIDITY_THRESHOLD = 75）
//  - 阈值来源：场景规则自身的 params（配置后台可调），解析其中数值
//  - promo / festival 依赖大促日历 / 节庆日历，天气不可判定，标记 manual
import type { CityWeather, WeatherDay } from '../data/api';
import type { SceneRule } from '../data/api';

export interface SceneHit {
  key: string;
  name: string;
  action: string;
  enabled: boolean;
  status: 'hit' | 'miss' | 'manual';
  metric: string; // 实测值描述
  threshold: string; // 阈值描述
}

const num = (v: string) => {
  const m = String(v || '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};

const w7 = (f: WeatherDay[]) => f.slice(0, 7);

function evalRule(rule: SceneRule, city: CityWeather, today: Date): Omit<SceneHit, 'key' | 'name' | 'action' | 'enabled'> {
  const f = city.forecast;
  const w = w7(f);
  const p0 = rule.params[0]?.value ?? '';
  const p1 = rule.params[1]?.value ?? '';

  switch (rule.key) {
    case 'humid': {
      const th = num(p0) ?? 75;
      const avg = Math.round(city.trends?.avgHumidity ?? 0);
      return { status: avg > th ? 'hit' : 'miss', metric: `7天平均湿度 ${avg}%`, threshold: `湿度 > ${th}%` };
    }
    case 'cold-snap': {
      const th = num(p0) ?? 8;
      // 48h 降温：未来 7 天内任意「隔一天」的最高温最大降幅
      let maxDrop = 0;
      for (let i = 0; i + 2 < f.length; i++) maxDrop = Math.max(maxDrop, f[i].tempMax - f[i + 2].tempMax);
      return { status: maxDrop >= th ? 'hit' : 'miss', metric: `48h最大降温 ${maxDrop}°C`, threshold: `48h 降温 ≥ ${th}°C` };
    }
    case 'heat': {
      const th = num(p0) ?? 33;
      const hottest = Math.max(...w.map((d) => d.tempMax));
      const day = w.find((d) => d.tempMax === hottest);
      return { status: hottest >= th ? 'hit' : 'miss', metric: `7天最高 ${hottest}°C（${day?.date.slice(5) ?? ''}）`, threshold: `最高温 ≥ ${th}°C` };
    }
    case 'heating': {
      // 时段参数（如 "11月~3月"）按当前月份判定
      const months = (String(p0).match(/\d+/g) || []).map(Number);
      const m = today.getMonth() + 1;
      let inSeason = false;
      if (months.length >= 2) {
        const [a, b] = months;
        inSeason = a <= b ? m >= a && m <= b : m >= a || m <= b; // 跨年期段
      }
      return { status: inSeason ? 'hit' : 'miss', metric: `当前 ${m} 月`, threshold: `供暖时段 ${p0}${p1 ? ` · ${p1}` : ''}` };
    }
    case 'rain-snow': {
      const th = num(p0) ?? 30;
      const rainy = w.filter((d) => d.precip > th);
      return {
        status: rainy.length >= 2 ? 'hit' : 'miss', // 对齐 weather 项目「未来7天雨天数≥2」
        metric: `7天雨天 ${rainy.length} 天${rainy.length > 0 ? `（${rainy[0].date.slice(5)} 起）` : ''}`,
        threshold: `降水概率 > ${th}%`,
      };
    }
    case 'season-change': {
      const th = num(p0) ?? 10;
      let maxDiff = 0;
      let diffDay: WeatherDay | null = null;
      for (const d of w) {
        const diff = d.tempMax - d.tempMin;
        if (diff > maxDiff) { maxDiff = diff; diffDay = d; }
      }
      return { status: maxDiff > th ? 'hit' : 'miss', metric: `最大昼夜温差 ${maxDiff}°C（${diffDay?.date.slice(5) ?? ''}）`, threshold: `昼夜温差 > ${th}°C` };
    }
    case 'promo':
      return { status: 'manual', metric: '大促日历未接入', threshold: p0 };
    case 'festival':
      return { status: 'manual', metric: '节庆日历未接入', threshold: p0 };
    default:
      return { status: 'manual', metric: '无自动判定逻辑', threshold: '' };
  }
}

export function evaluateSceneRules(rules: SceneRule[], city: CityWeather | null): SceneHit[] {
  if (!city) return [];
  const today = new Date();
  return rules.map((r) => ({
    key: r.key,
    name: r.name,
    action: r.action,
    enabled: r.enabled,
    ...evalRule(r, city, today),
  }));
}
