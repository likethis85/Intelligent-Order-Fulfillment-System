// 天气客户端：Open-Meteo 免费 API（无需 key），移植自 weather 项目 weather_service.py
// 提供 5 个重点城市 16 天预报 + 7 天窗口趋势分析，1 小时内存缓存
const BASE_URL = 'https://api.open-meteo.com/v1/forecast';

export const WEATHER_CITIES = {
  北京: { lat: 39.904989, lon: 116.405285 },
  上海: { lat: 31.231706, lon: 121.472644 },
  广州: { lat: 23.125178, lon: 113.280637 },
  江苏: { lat: 32.060255, lon: 118.796877 },
  浙江: { lat: 30.274084, lon: 120.155070 },
};

const WMO_CODES = {
  0: '晴', 1: '多云', 2: '多云', 3: '阴', 45: '雾', 48: '雾凇',
  51: '毛毛雨', 53: '小雨', 55: '中雨', 56: '冻雨', 57: '冻雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '阵雨', 82: '暴雨', 85: '阵雪', 86: '阵雪',
  95: '雷雨', 96: '雷雨伴冰雹', 99: '雷雨伴冰雹',
};

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

// 风速 km/h → 蒲福风力等级（Open-Meteo 返回 km/h）
function windScale(kmh) {
  if (kmh == null) return '3';
  if (kmh < 1) return '0';
  if (kmh < 5.5) return '1';
  if (kmh < 11) return '2';
  if (kmh < 19) return '3';
  if (kmh < 28) return '4';
  if (kmh < 38) return '5';
  if (kmh < 49) return '6';
  if (kmh < 61) return '7';
  return '8';
}

function uvLevel(uv) {
  if (uv == null || uv < 0) return '0';
  if (uv < 3) return '1';
  if (uv < 6) return '3';
  if (uv < 8) return '5';
  if (uv < 11) return '7';
  return '10';
}

function wmoText(code) {
  return WMO_CODES[code] ?? '未知';
}

async function fetchCity(cityName) {
  const c = WEATHER_CITIES[cityName];
  if (!c) throw new Error(`不支持的城市: ${cityName}`);
  const daily = [
    'weather_code', 'temperature_2m_max', 'temperature_2m_min',
    'precipitation_probability_max', 'relative_humidity_2m_mean',
    'wind_speed_10m_max', 'uv_index_max', 'sunrise', 'sunset',
  ].join(',');
  const qs = new URLSearchParams({
    latitude: String(c.lat),
    longitude: String(c.lon),
    daily,
    timezone: 'Asia/Shanghai',
    forecast_days: '16',
  });
  const res = await fetch(`${BASE_URL}?${qs}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  const data = await res.json();
  const d = data.daily;
  if (!d || !Array.isArray(d.time)) throw new Error('Open-Meteo 未返回 daily 数据');

  const at = (arr, i) => (Array.isArray(arr) && i < arr.length ? arr[i] : null);
  return d.time.map((date, i) => ({
    date,
    week: WEEKDAYS[(new Date(date + 'T00:00:00+08:00').getDay() + 6) % 7],
    tempMax: Math.round(at(d.temperature_2m_max, i) ?? 0),
    tempMin: Math.round(at(d.temperature_2m_min, i) ?? 0),
    weather: wmoText(at(d.weather_code, i)),
    precip: Math.round(at(d.precipitation_probability_max, i) ?? 0),
    humidity: Math.round(at(d.relative_humidity_2m_mean, i) ?? 50),
    windScale: windScale(at(d.wind_speed_10m_max, i)),
    uvIndex: uvLevel(at(d.uv_index_max, i)),
    sunrise: (at(d.sunrise, i) || '').slice(11, 16),
    sunset: (at(d.sunset, i) || '').slice(11, 16),
  }));
}

// 7 天窗口趋势分析（对齐 weather 项目 analyze_weather_trends）
function analyzeTrends(forecast) {
  const window = forecast.slice(0, 7);
  if (window.length === 0) return null;
  const tempsMax = window.map((d) => d.tempMax);
  const tempsMin = window.map((d) => d.tempMin);
  let tempTrend = 'stable';
  if (tempsMax.length >= 2) {
    if (tempsMax[tempsMax.length - 1] > tempsMax[0] + 3) tempTrend = 'rising';
    else if (tempsMax[tempsMax.length - 1] < tempsMax[0] - 3) tempTrend = 'falling';
  }
  const trendDesc = { rising: '升温趋势', falling: '降温趋势', stable: '气温平稳' };
  const weatherTypes = {};
  for (const d of window) weatherTypes[d.weather] = (weatherTypes[d.weather] || 0) + 1;
  const avg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
  return {
    avgTempMax: Math.round(avg(tempsMax) * 10) / 10,
    avgTempMin: Math.round(avg(tempsMin) * 10) / 10,
    avgTemp: Math.round((avg(tempsMax) + avg(tempsMin)) / 2 * 10) / 10,
    tempTrend,
    tempTrendDesc: trendDesc[tempTrend],
    rainDays: window.filter((d) => d.precip > 30).length,
    weatherTypes,
    avgHumidity: Math.round(avg(window.map((d) => d.humidity)) * 10) / 10,
    hottestDay: window.reduce((a, b) => (b.tempMax > a.tempMax ? b : a)),
    coldestDay: window.reduce((a, b) => (b.tempMin < a.tempMin ? b : a)),
  };
}

let cache = null; // { at, cities: Map<name, forecast>, failed: [] }
const CACHE_TTL_MS = 60 * 60 * 1000;

export async function getWeather({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return formatResult(cache);
  }
  const names = Object.keys(WEATHER_CITIES);
  const settled = await Promise.allSettled(names.map((n) => fetchCity(n)));
  const cities = new Map();
  const failed = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') cities.set(names[i], r.value);
    else failed.push({ city: names[i], error: r.reason?.message || String(r.reason) });
  });
  if (cities.size === 0) {
    const err = new Error('所有城市天气拉取失败: ' + failed.map((f) => `${f.city} ${f.error}`).join('; '));
    err.failed = failed;
    throw err;
  }
  cache = { at: Date.now(), cities, failed };
  return formatResult(cache);
}

function formatResult({ at, cities, failed }) {
  return {
    updateTime: new Date(at).toISOString(),
    cachedSecondsAgo: Math.round((Date.now() - at) / 1000),
    cities: [...cities.entries()].map(([name, forecast]) => ({
      name,
      forecast,
      trends: analyzeTrends(forecast),
    })),
    failed,
  };
}
