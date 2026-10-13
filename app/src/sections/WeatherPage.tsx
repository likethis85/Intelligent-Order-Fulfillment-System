import { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { fetchWeather, fetchSceneRules, readWeatherCache, writeWeatherCache, type CityWeather, type WeatherDay } from '../data/api';
import { getSolarTermContext } from '../lib/solarTerms';
import { evaluateSceneRules, type SceneHit } from '../lib/sceneHits';

// 设计 token 取值（tailwind.config.js），canvas 无法直接用 className
const C = {
  ink: '#1C1B18',
  muted: '#8A877F',
  faint: '#B5B2A8',
  edge: '#E8E6E0',
  strong: '#D8D5CC',
  card: '#FFFFFF',
  subtle: '#F3F1EA',
  link: '#2E5FA3',
  bar: '#C9BFA6',
  bar2: '#B7C4B0',
  danger: '#B4452F',
  connect: '#6B8060',
};

function useCanvas(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const render = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = cv.clientWidth;
      const h = cv.clientHeight;
      cv.width = w * dpr;
      cv.height = h * dpr;
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      draw(ctx, w, h);
    };
    render();
    const ro = new ResizeObserver(render);
    ro.observe(cv);
    return () => ro.disconnect();
  }, [draw]);
  return ref;
}

const PAD = { l: 34, r: 10, t: 12, b: 22 };

function TempChart({ forecast }: { forecast: WeatherDay[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const draw = (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    const iw = w - PAD.l - PAD.r;
    const ih = h - PAD.t - PAD.b;
    const maxT = Math.max(...forecast.map((d) => d.tempMax)) + 2;
    const minT = Math.min(...forecast.map((d) => d.tempMin)) - 2;
    const x = (i: number) => PAD.l + (iw * (i + 0.5)) / forecast.length;
    const y = (t: number) => PAD.t + ih * (1 - (t - minT) / (maxT - minT));

    ctx.font = '10px sans-serif';
    // 网格 + Y 轴刻度
    for (let t = Math.ceil(minT / 5) * 5; t <= maxT; t += 5) {
      ctx.strokeStyle = C.edge;
      ctx.beginPath();
      ctx.moveTo(PAD.l, y(t));
      ctx.lineTo(w - PAD.r, y(t));
      ctx.stroke();
      ctx.fillStyle = C.faint;
      ctx.textAlign = 'right';
      ctx.fillText(`${t}°`, PAD.l - 5, y(t) + 3);
    }
    // X 轴日期（隔一天显示）
    ctx.textAlign = 'center';
    forecast.forEach((d, i) => {
      if (i % 2 === 0) {
        ctx.fillStyle = C.faint;
        ctx.fillText(d.date.slice(5), x(i), h - 7);
      }
    });
    // 最高温线 / 最低温线
    const line = (key: 'tempMax' | 'tempMin', color: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      forecast.forEach((d, i) => (i === 0 ? ctx.moveTo(x(i), y(d[key])) : ctx.lineTo(x(i), y(d[key]))));
      ctx.stroke();
    };
    line('tempMax', C.ink);
    line('tempMin', C.faint);
    // 数据点 + 首末日温度标注
    forecast.forEach((d, i) => {
      ctx.fillStyle = C.ink;
      ctx.beginPath();
      ctx.arc(x(i), y(d.tempMax), 2, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.fillStyle = C.ink;
    ctx.textAlign = 'left';
    ctx.fillText(`最高 ${forecast[0].tempMax}°`, x(0) + 4, y(forecast[0].tempMax) - 6);
    const li = forecast.length - 1;
    ctx.textAlign = 'right';
    ctx.fillText(`最低 ${forecast[li].tempMin}°`, x(li) - 4, y(forecast[li].tempMin) + 12);

    // 悬停：竖向参考线 + 双点高亮 + 温度浮层
    if (hover != null && forecast[hover]) {
      const d = forecast[hover];
      ctx.strokeStyle = C.strong;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x(hover), PAD.t);
      ctx.lineTo(x(hover), PAD.t + ih);
      ctx.stroke();
      ctx.setLineDash([]);
      for (const [key, color] of [['tempMax', C.ink], ['tempMin', C.faint]] as const) {
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(x(hover), y(d[key]), 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }
      // 浮层：日期 + 最高/最低温，靠右时翻转避免溢出
      const lines = [`${d.date} ${d.week}`, `最高 ${d.tempMax}°C · 最低 ${d.tempMin}°C`];
      ctx.font = '11px sans-serif';
      const tw = Math.max(...lines.map((s) => ctx.measureText(s).width)) + 16;
      const th = lines.length * 16 + 10;
      let bx = x(hover) + 10;
      if (bx + tw > w - PAD.r) bx = x(hover) - tw - 10;
      const by = Math.max(PAD.t, Math.min(y(d.tempMax) - th - 8, h - PAD.b - th));
      ctx.fillStyle = C.ink;
      ctx.beginPath();
      ctx.roundRect(bx, by, tw, th, 4);
      ctx.fill();
      ctx.fillStyle = '#FFFFFF';
      ctx.textAlign = 'left';
      lines.forEach((s, i) => ctx.fillText(s, bx + 8, by + 16 + i * 16));
    }
  };
  const ref = useCanvas(draw);
  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const iw = rect.width - PAD.l - PAD.r;
    const rel = e.clientX - rect.left - PAD.l;
    const i = Math.round(((rel / iw) * forecast.length - 0.5));
    setHover(Math.max(0, Math.min(forecast.length - 1, i)));
  };
  return (
    <canvas
      ref={ref}
      className="h-56 w-full cursor-crosshair"
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
    />
  );
}

function PrecipChart({ forecast }: { forecast: WeatherDay[] }) {
  const draw = (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    const iw = w - PAD.l - PAD.r;
    const ih = h - PAD.t - PAD.b;
    const x = (i: number) => PAD.l + (iw * (i + 0.5)) / forecast.length;
    const bw = Math.min(18, (iw / forecast.length) * 0.55);
    const y = (p: number) => PAD.t + ih * (1 - p / 100);

    ctx.font = '10px sans-serif';
    for (let p = 0; p <= 100; p += 25) {
      ctx.strokeStyle = C.edge;
      ctx.beginPath();
      ctx.moveTo(PAD.l, y(p));
      ctx.lineTo(w - PAD.r, y(p));
      ctx.stroke();
      ctx.fillStyle = C.faint;
      ctx.textAlign = 'right';
      ctx.fillText(`${p}%`, PAD.l - 5, y(p) + 3);
    }
    // 雨天口径线（30%）
    ctx.strokeStyle = C.strong;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(PAD.l, y(30));
    ctx.lineTo(w - PAD.r, y(30));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = C.muted;
    ctx.textAlign = 'left';
    ctx.fillText('雨天口径 30%', PAD.l + 4, y(30) - 4);

    ctx.textAlign = 'center';
    forecast.forEach((d, i) => {
      ctx.fillStyle = C.bar;
      ctx.fillRect(x(i) - bw / 2, y(d.precip), bw, PAD.t + ih - y(d.precip));
      if (d.precip > 30) {
        ctx.fillStyle = C.link;
        ctx.fillRect(x(i) - bw / 2, y(d.precip), bw, PAD.t + ih - y(d.precip));
      }
      if (i % 2 === 0) {
        ctx.fillStyle = C.faint;
        ctx.fillText(d.date.slice(5), x(i), h - 7);
      }
      if (d.precip > 0) {
        ctx.fillStyle = C.muted;
        ctx.fillText(String(d.precip), x(i), y(d.precip) - 3);
      }
    });
  };
  const ref = useCanvas(draw);
  return <canvas ref={ref} className="h-56 w-full" />;
}

function MetricCard({ label, value, unit, hint, tone = C.ink }: { label: string; value: string; unit: string; hint: string; tone?: string }) {
  return (
    <div className="border border-edge bg-surface-card p-5">
      <div className="text-[11px] text-ink-muted">{label}</div>
      <div className="mt-2 flex items-end gap-1.5">
        <span className="text-[34px] font-bold leading-none" style={{ color: tone }}>{value}</span>
        <span className="mb-0.5 text-[13px] text-ink-muted">{unit}</span>
      </div>
      <div className="mt-2 text-[11px] leading-4 text-ink-muted">{hint}</div>
    </div>
  );
}

const HIT_BADGE: Record<SceneHit['status'], { text: string; cls: string }> = {
  hit: { text: '命中', cls: 'bg-stage-connect-bg text-stage-connect-fg' },
  miss: { text: '未命中', cls: 'bg-surface-subtle text-ink-muted' },
  manual: { text: '人工判定', cls: 'bg-stage-peak-bg text-stage-peak-fg' },
};

export default function WeatherPage() {
  // 切 tab 会重新挂载：先同步读本地缓存秒开，再后台拉新（stale-while-revalidate）
  const initialWeather = typeof window !== 'undefined' ? readWeatherCache() : null;
  const [data, setData] = useState<CityWeather[] | null>(initialWeather?.cities ?? null);
  const [failed, setFailed] = useState<{ city: string; error: string }[]>(initialWeather?.failed ?? []);
  const [updateTime, setUpdateTime] = useState(initialWeather?.updateTime ?? '');
  const [loading, setLoading] = useState(initialWeather == null);
  const [refreshing, setRefreshing] = useState(false);
  const [city, setCity] = useState('上海');
  const [hits, setHits] = useState<SceneHit[]>([]);

  const load = async (fresh = false) => {
    if (fresh) setRefreshing(true);
    else if (data == null) setLoading(true);
    try {
      const [w, s] = await Promise.all([fetchWeather({ fresh }), fetchSceneRules()]);
      setData(w.cities);
      writeWeatherCache(w);
      setFailed(w.failed);
      setUpdateTime(w.updateTime);
      const target = w.cities.find((c) => c.name === city) ?? w.cities[0];
      if (target) setCity(target.name);
      setHits(evaluateSceneRules(s.rules, target ?? null));
    } catch (e: any) {
      // 已有缓存数据时静默（界面已展示旧数据）；只有无数据才报错
      if (data == null) toast.error('天气加载失败：' + e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current: CityWeather | null = useMemo(() => data?.find((c) => c.name === city) ?? null, [data, city]);

  useEffect(() => {
    if (!current) return;
    fetchSceneRules().then((s) => setHits(evaluateSceneRules(s.rules, current)));
  }, [current]);

  const solar = useMemo(() => getSolarTermContext(undefined, current?.trends?.tempTrend ?? 'stable'), [current]);

  return (
    <div className="responsive-page weather-page mx-auto w-full max-w-[1440px] px-6 py-8 lg:px-10">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-edge pb-6">
        <div>
          <div className="text-[12px] font-light tracking-[0.3em] text-ink-faint">05 /</div>
          <h1 className="mt-2 text-[28px] font-bold leading-none">天气面板</h1>
          <p className="mt-3 text-[13px] text-ink-muted">
            Open-Meteo 16 天数值预报 + 二十四节气中长期节奏；下方「场景规则命中」按配置后台阈值实时判定
          </p>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-ink-muted">
          {updateTime && <span>更新于 {new Date(updateTime).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>}
          <button
            onClick={() => load(true)}
            disabled={refreshing}
            className="flex items-center gap-1.5 rounded-md bg-action-primary px-3.5 py-1.5 text-[12px] text-surface-card hover:opacity-90 disabled:opacity-40"
          >
            <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
            {refreshing ? '刷新中…' : '刷新'}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-3 py-24 text-[13px] text-ink-muted">
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-edge-strong border-t-action-primary" />
          正在加载天气…
        </div>
      ) : !current ? (
        <div className="py-24 text-center text-[13px] text-ink-muted">
          天气数据不可用{failed.length > 0 && `（${failed.map((f) => f.city).join('、')} 拉取失败）`}
        </div>
      ) : (
        <>
          {/* 二十四节气 · 中长期展望 */}
          <div className="mt-6 border border-edge bg-surface-card p-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="max-w-3xl">
                <div className="flex items-center gap-2">
                  <h3 className="text-[14px] font-bold">二十四节气 · 备货节奏</h3>
                  <span className="rounded-full bg-surface-subtle px-2 py-0.5 text-[11px] text-ink-secondary">
                    当前「{solar.current.name}」第 {solar.current.dayInTerm} 天 · {solar.seasonLabel}
                  </span>
                </div>
                <p className="mt-2 text-[12px] leading-5 text-ink-secondary">{solar.outlook}</p>
              </div>
              <div className="shrink-0">
                <div className="mb-1 text-[11px] font-medium text-ink-muted">近期节气节点</div>
                <ul className="space-y-0.5 text-[11.5px] text-ink-secondary">
                  {solar.upcoming.slice(0, 4).map((u) => (
                    <li key={u.name + u.date}>
                      {u.name} · {u.date.slice(5)}（{u.daysAway} 天后）
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>

          {/* 城市切换 */}
          <div className="mt-5 flex flex-wrap gap-1.5">
            {(data ?? []).map((c) => (
              <button
                key={c.name}
                onClick={() => setCity(c.name)}
                className={`rounded-md border px-4 py-1.5 text-[12.5px] transition-colors ${
                  city === c.name ? 'border-edge bg-action-primary text-surface-card' : 'border-edge-strong bg-surface-card text-ink-secondary hover:border-edge'
                }`}
              >
                {c.name}
              </button>
            ))}
          </div>

          {/* 概览指标 */}
          <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricCard
              label="7天平均温度"
              value={String(current.trends?.avgTemp ?? '--')}
              unit="°C"
              tone={C.ink}
              hint={`${current.trends?.tempTrendDesc ?? ''} · 区间 ${current.trends?.avgTempMin}~${current.trends?.avgTempMax}°C`}
            />
            <MetricCard
              label="7天雨天数"
              value={String(current.trends?.rainDays ?? 0)}
              unit="天"
              tone={C.link}
              hint="降水概率 > 30% 记雨天（weather 项目口径）"
            />
            <MetricCard
              label="7天平均湿度"
              value={String(current.trends?.avgHumidity ?? '--')}
              unit="%"
              tone={C.connect}
              hint={`最高 ${current.trends?.hottestDay.tempMax ?? '--'}°C · 最低 ${current.trends?.coldestDay.tempMin ?? '--'}°C`}
            />
            <MetricCard
              label="未来天气分布"
              value={String(Object.keys(current.trends?.weatherTypes ?? {}).length)}
              unit="种"
              tone={C.bar}
              hint={Object.entries(current.trends?.weatherTypes ?? {}).map(([k, v]) => `${k}${v}天`).join(' · ')}
            />
          </div>

          {/* 图表 */}
          <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
            <div className="border border-edge bg-surface-card p-5">
              <h3 className="mb-3 text-[13px] font-semibold">16日温度趋势</h3>
              <TempChart forecast={current.forecast} />
              <div className="mt-2 flex gap-4 text-[11px] text-ink-muted">
                <span className="flex items-center gap-1.5"><span className="inline-block h-[2px] w-4" style={{ background: C.ink }} /> 最高温</span>
                <span className="flex items-center gap-1.5"><span className="inline-block h-[2px] w-4" style={{ background: C.faint }} /> 最低温</span>
              </div>
            </div>
            <div className="border border-edge bg-surface-card p-5">
              <h3 className="mb-3 text-[13px] font-semibold">16日降水概率</h3>
              <PrecipChart forecast={current.forecast} />
              <div className="mt-2 flex gap-4 text-[11px] text-ink-muted">
                <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5" style={{ background: C.link }} /> 雨天（&gt;30%）</span>
                <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5" style={{ background: C.bar }} /> 非雨天</span>
              </div>
            </div>
          </div>

          {/* 16天预报明细（窄屏横向滚动） */}
          <div className="mt-4 border border-edge bg-surface-card">
            <div className="border-b border-edge px-5 py-3 text-[13px] font-semibold">16天预报明细</div>
            <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-[12px]">
              <thead>
                <tr className="border-b border-edge-muted text-left text-[11px] text-ink-muted">
                  <th className="px-5 py-2 font-normal">日期</th>
                  <th className="px-2 py-2 font-normal">天气</th>
                  <th className="px-2 py-2 text-right font-normal">温度</th>
                  <th className="px-2 py-2 text-right font-normal">降水</th>
                  <th className="px-2 py-2 text-right font-normal">湿度</th>
                  <th className="px-2 py-2 text-right font-normal">风力</th>
                  <th className="px-2 py-2 text-right font-normal">紫外线</th>
                </tr>
              </thead>
              <tbody>
                {current.forecast.map((d, i) => (
                  <tr key={d.date} className={`border-b border-edge-muted last:border-0 ${i === 0 ? 'bg-surface-subtle' : ''}`}>
                    <td className="px-5 py-2 text-ink-primary">
                      {d.date} {d.week}
                      {i === 0 && <span className="ml-2 rounded bg-action-primary px-1.5 py-0.5 text-[10px] text-surface-card">今天</span>}
                    </td>
                    <td className="px-2 py-2 text-ink-secondary">{d.weather}</td>
                    <td className="px-2 py-2 text-right text-ink-primary">{d.tempMin}~{d.tempMax}°C</td>
                    <td className="px-2 py-2 text-right" style={{ color: d.precip > 30 ? C.link : C.ink }}>{d.precip}%</td>
                    <td className="px-2 py-2 text-right text-ink-secondary">{d.humidity}%</td>
                    <td className="px-2 py-2 text-right text-ink-secondary">{d.windScale}级</td>
                    <td className="px-2 py-2 text-right text-ink-secondary">{d.uvIndex}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>

          {/* 场景规则命中 */}
          <div className="mt-4 border border-edge bg-surface-card">
            <div className="flex items-center justify-between border-b border-edge px-5 py-3">
              <div className="text-[13px] font-semibold">场景规则命中（{city}）</div>
              <div className="text-[11px] text-ink-muted">阈值来自配置后台「场景规则库」，判定口径对齐 weather 项目配置</div>
            </div>
            <div className="divide-y divide-edge-muted">
              {hits.map((hit) => {
                const badge = HIT_BADGE[hit.status];
                return (
                  <div key={hit.key} className={`flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 ${hit.enabled ? '' : 'opacity-50'}`}>
                    <span className={`w-14 shrink-0 rounded-full px-2 py-0.5 text-center text-[11px] ${badge.cls}`}>{badge.text}</span>
                    <div className="w-40 shrink-0 text-[12.5px] font-semibold text-ink-primary">{hit.name}</div>
                    <div className="min-w-44 shrink-0 text-[11.5px] text-ink-secondary">
                      {hit.metric} <span className="text-ink-faint">/ 阈值 {hit.threshold}</span>
                    </div>
                    <div className="ml-auto text-right text-[11.5px] text-ink-muted">{hit.action}</div>
                  </div>
                );
              })}
            </div>
            <p className="border-t border-edge-muted px-5 py-2.5 text-[11px] text-ink-muted">
              命中只代表天气条件满足，实际提权/降权动作由商品侧按配置后台的动作文案执行；「人工判定」类规则（大促期 / 节庆）需结合日历。
            </p>
          </div>
        </>
      )}
    </div>
  );
}
