import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { fetchRoleRules, saveRoleRules, fetchSceneRules, saveSceneRules, fetchStrategyRules, saveStrategyRules, fetchWeatherRules, saveWeatherRules, type RoleRules, type SceneRule, type StrategyRules, type WeatherRules } from '../data/api';

const PRICE_BANDS = ['低', '中', '高'];
const TURNOVER_OPTS = ['无周转', '周转>60天', '周转30-60天', '周转15-30天', '周转0-15天'];
const SOLDOUT_OPTS = ['低销售', '低售罄', '高售罄', '高销售', '其他'];

// 多选 chip：点击切换 arr 中 value 的成员资格
function Chip({ text, on, onClick }: { text: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded border px-2.5 py-1 text-[12px] transition-colors ${
        on ? 'border-ink-primary bg-surface-subtle text-ink-primary' : 'border-edge-strong text-ink-muted hover:border-ink-primary'
      }`}
    >
      {text}
    </button>
  );
}

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label="启用规则" onClick={onClick} className="config-toggle relative inline-flex h-5 w-9 shrink-0 items-center justify-center">
      <span className={`relative block h-5 w-9 rounded-full transition-colors ${on ? 'bg-action-primary' : 'bg-edge-strong'}`}>
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-surface-card transition-all ${on ? 'left-[18px]' : 'left-0.5'}`} />
      </span>
    </button>
  );
}

export default function ConfigPage({ canEditRules = true }: { canEditRules?: boolean }) {
  const [rules, setRules] = useState<RoleRules | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sceneRules, setSceneRules] = useState<SceneRule[] | null>(null);
  const [sceneLoaded, setSceneLoaded] = useState(false);
  const [sceneSaving, setSceneSaving] = useState(false);
  const [strategyRules, setStrategyRules] = useState<StrategyRules | null>(null);
  const [strategyLoaded, setStrategyLoaded] = useState(false);
  const [strategySaving, setStrategySaving] = useState(false);
  const [weatherRules, setWeatherRules] = useState<WeatherRules | null>(null);
  const [weatherLoaded, setWeatherLoaded] = useState(false);
  const [weatherSaving, setWeatherSaving] = useState(false);

  useEffect(() => {
    fetchRoleRules()
      .then((r) => setRules(r.rules))
      .catch((e) => toast.error('读取角色规则失败：' + e.message))
      .finally(() => setLoaded(true));
    fetchSceneRules()
      .then((r) => setSceneRules(r.rules))
      .catch((e) => toast.error('读取场景规则失败：' + e.message))
      .finally(() => setSceneLoaded(true));
    fetchStrategyRules()
      .then((r) => setStrategyRules(r.rules))
      .catch((e) => toast.error('读取 AI 策略口径失败：' + e.message))
      .finally(() => setStrategyLoaded(true));
    fetchWeatherRules()
      .then((r) => setWeatherRules(r.rules))
      .catch((e) => toast.error('读取天气选款规则失败：' + e.message))
      .finally(() => setWeatherLoaded(true));
  }, []);

  const toggleIn = (arr: string[], v: string) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  const save = async () => {
    if (!rules) return;
    setSaving(true);
    try {
      const r = await saveRoleRules(rules);
      setRules(r.rules);
      toast.success('角色规则已保存；到货盘点「手动同步」后角色标签重算生效');
    } catch (e: any) {
      toast.error('保存失败：' + e.message);
    } finally {
      setSaving(false);
    }
  };

  const saveScenes = async () => {
    if (!sceneRules) return;
    setSceneSaving(true);
    try {
      const r = await saveSceneRules(sceneRules);
      setSceneRules(r.rules);
      toast.success('场景规则已保存');
    } catch (e: any) {
      toast.error('保存失败：' + e.message);
    } finally {
      setSceneSaving(false);
    }
  };

  const saveStrategy = async () => {
    if (!strategyRules) return;
    setStrategySaving(true);
    try {
      const r = await saveStrategyRules(strategyRules);
      setStrategyRules(r.rules);
      toast.success('AI 策略口径已保存；下次对话立即生效');
    } catch (e: any) {
      toast.error('保存失败：' + e.message);
    } finally {
      setStrategySaving(false);
    }
  };

  const patchStrategyDefaults = (k: keyof StrategyRules['defaults'], v: number) =>
    setStrategyRules((s) => (s ? { ...s, defaults: { ...s.defaults, [k]: v } } : s));
  const patchStrategyWeather = (k: keyof StrategyRules['weatherThresholds'], v: number) =>
    setStrategyRules((s) => (s ? { ...s, weatherThresholds: { ...s.weatherThresholds, [k]: v } } : s));

  const saveWeather = async () => {
    if (!weatherRules) return;
    setWeatherSaving(true);
    try {
      const r = await saveWeatherRules(weatherRules);
      setWeatherRules(r.rules);
      toast.success('天气选款规则已保存；下次 AI 对话立即生效');
    } catch (e: any) {
      toast.error('保存失败：' + e.message);
    } finally {
      setWeatherSaving(false);
    }
  };

  const ALL_CATEGORIES = ['T恤', '背心/吊带', '连衣裙', '半身裙', '衬衫', '针织衫', '卫衣', '短外套', '风衣', '西装', '大衣', '羽绒服', '皮衣', '皮草', '小香风', '组合套', '牛仔裤', '休闲裤', '马夹/马夹裙', '配饰', '其他'];
  const toggleCat = (arr: string[], v: string) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const patchTempRule = (i: number, cats: string[]) =>
    setWeatherRules((w) => (w ? { ...w, temperature_rules: w.temperature_rules.map((r, ri) => (ri === i ? { ...r, categories: cats } : r)) } : w));
  const patchSolarCats = (i: number, cats: string[]) =>
    setWeatherRules((w) => (w ? { ...w, solar_term_overlays: w.solar_term_overlays.map((s, si) => (si === i ? { ...s, categories: cats } : s)) } : w));

  const patchScene = (i: number, patch: Partial<SceneRule>) =>
    setSceneRules((rs) => (rs ? rs.map((x, xi) => (xi === i ? { ...x, ...patch } : x)) : rs));
  const patchSceneParam = (i: number, j: number, value: string) =>
    setSceneRules((rs) =>
      rs ? rs.map((x, xi) => (xi === i ? { ...x, params: x.params.map((y, yj) => (yj === j ? { ...y, value } : y)) } : x)) : rs,
    );

  return (
    <div className="responsive-page config-page mx-auto w-full max-w-[1440px] px-6 py-8 lg:px-10">
      <div className="border-b border-edge pb-6">
        <div className="text-[12px] font-light tracking-[0.3em] text-ink-faint">06 /</div>
        <h1 className="mt-2 text-[28px] font-bold leading-none">配置后台</h1>
        <p className="mt-3 text-[13px] text-ink-muted">
          排品角色判定规则在此维护，保存后服务端实时生效；场景规则由商品侧维护，数据每日定时同步
        </p>
      </div>

      {/* 排品角色判定规则（真实持久化到后端 server/data/role-rules.json） */}
      <div className="mt-10">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-[11px] font-medium tracking-widest text-ink-muted">排品角色判定规则（引流 / 利润 / 库存）</div>
          <button
            onClick={save}
            disabled={!rules || saving || !canEditRules}
            className="rounded-md bg-action-primary px-4 py-1.5 text-[12px] text-surface-card hover:opacity-90 disabled:opacity-40"
          >
            {saving ? '保存中…' : '保存规则'}
          </button>
        </div>

        {!loaded ? (
          <div className="mt-4 text-[12px] text-ink-muted">加载中…</div>
        ) : !rules ? (
          <div className="mt-4 text-[12px] text-ink-muted">后端未响应，规则暂时不可编辑（请确认 3737 已启动）</div>
        ) : (
          <div className="mt-4 space-y-4">
            {/* 引流款 */}
            <div className="border border-edge bg-surface-card p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="text-[14px] font-bold">引流款</div>
                <div className="text-[11px] text-ink-muted">开场聚人气；满足「价格带」或「转化率」任一即标引流</div>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3">
                <label className="flex items-center gap-2 text-[12px] text-ink-secondary">
                  转化率 ≥
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={0.5}
                    value={rules.traffic.minConversion}
                    onChange={(e) => setRules({ ...rules, traffic: { ...rules.traffic, minConversion: Number(e.target.value) } })}
                    className="w-20 rounded border border-edge-strong bg-surface-bg px-2 py-1 text-[12px] text-ink-primary outline-none focus:border-edge"
                  />
                  %
                </label>
                <div className="flex items-center gap-2 text-[12px] text-ink-secondary">
                  价格带
                  <div className="flex gap-1.5">
                    {PRICE_BANDS.map((b) => (
                      <Chip key={b} text={b} on={rules.traffic.priceBands.includes(b)} onClick={() => setRules({ ...rules, traffic: { ...rules.traffic, priceBands: toggleIn(rules.traffic.priceBands, b) } })} />
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* 利润款 */}
            <div className="border border-edge bg-surface-card p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="text-[14px] font-bold">利润款</div>
                <div className="text-[11px] text-ink-muted">利润峰值段主讲；高价滞销款默认归库存、不标利润</div>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3">
                <div className="flex items-center gap-2 text-[12px] text-ink-secondary">
                  价格带
                  <div className="flex gap-1.5">
                    {PRICE_BANDS.map((b) => (
                      <Chip key={b} text={b} on={rules.profit.priceBands.includes(b)} onClick={() => setRules({ ...rules, profit: { ...rules.profit, priceBands: toggleIn(rules.profit.priceBands, b) } })} />
                    ))}
                  </div>
                </div>
                <label className="flex items-center gap-2 text-[12px] text-ink-secondary">
                  <Toggle on={rules.profit.excludeSlow} onClick={() => setRules({ ...rules, profit: { ...rules.profit, excludeSlow: !rules.profit.excludeSlow } })} />
                  排除滞销款（滞销归库存）
                </label>
              </div>
            </div>

            {/* 库存款 */}
            <div className="border border-edge bg-surface-card p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="text-[14px] font-bold">库存款</div>
                <div className="text-[11px] text-ink-muted">滞销清仓，清仓场主讲；「低销售但库存稀缺、周转快」的热销款不会被误判</div>
              </div>
              <div className="mt-4 space-y-3">
                <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-secondary">
                  库存周转前缀
                  <div className="flex flex-wrap gap-1.5">
                    {TURNOVER_OPTS.map((t) => (
                      <Chip key={t} text={t} on={rules.stock.slowTurnover.includes(t)} onClick={() => setRules({ ...rules, stock: { ...rules.stock, slowTurnover: toggleIn(rules.stock.slowTurnover, t) } })} />
                    ))}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-secondary">
                  售罄率打标
                  <div className="flex flex-wrap gap-1.5">
                    {SOLDOUT_OPTS.map((t) => (
                      <Chip key={t} text={t} on={rules.stock.lowSellTags.includes(t)} onClick={() => setRules({ ...rules, stock: { ...rules.stock, lowSellTags: toggleIn(rules.stock.lowSellTags, t) } })} />
                    ))}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[12px] text-ink-secondary">
                  <div className="flex items-center gap-2">
                    周转与售罄率
                    <div className="flex gap-1.5">
                      <Chip text="需同时满足" on={rules.stock.requireBoth} onClick={() => setRules({ ...rules, stock: { ...rules.stock, requireBoth: true } })} />
                      <Chip text="任一满足即可" on={!rules.stock.requireBoth} onClick={() => setRules({ ...rules, stock: { ...rules.stock, requireBoth: false } })} />
                    </div>
                  </div>
                  <label className="flex items-center gap-2">
                    <Toggle on={rules.stock.noSales30d} onClick={() => setRules({ ...rules, stock: { ...rules.stock, noSales30d: !rules.stock.noSales30d } })} />
                    「30天无动销」直接判滞销
                  </label>
                </div>
              </div>
            </div>
          </div>
        )}
        <p className="mt-3 text-[11px] leading-5 text-ink-muted">
          角色标签在商品同步时按此规则推导，用于「直播排品」的三套节奏策略分桶（引流开场 / 利润峰值 / 库存释放）。
        </p>
      </div>

      {/* 场景规则库（真实持久化到后端 server/data/scene-rules.json） */}
      <div className="mt-10 pb-10">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-[11px] font-medium tracking-widest text-ink-muted">场景规则库（按天气 API / 日历自动激活，参数可改）</div>
          <button
            onClick={saveScenes}
            disabled={!sceneRules || sceneSaving || !canEditRules}
            className="rounded-md bg-action-primary px-4 py-1.5 text-[12px] text-surface-card hover:opacity-90 disabled:opacity-40"
          >
            {sceneSaving ? '保存中…' : '保存场景规则'}
          </button>
        </div>
        {!sceneLoaded ? (
          <div className="mt-4 text-[12px] text-ink-muted">加载中…</div>
        ) : !sceneRules ? (
          <div className="mt-4 text-[12px] text-ink-muted">后端未响应，场景规则暂时不可编辑（请确认 3737 已启动）</div>
        ) : (
          <div className="mt-4 divide-y divide-edge-muted border border-edge bg-surface-card">
            {sceneRules.map((r, i) => (
              <div key={r.key} className={`flex flex-wrap items-start gap-x-4 gap-y-2 px-5 py-4 ${r.enabled ? '' : 'opacity-50'}`}>
                <button
                  onClick={() => patchScene(i, { enabled: !r.enabled })}
                  className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors ${r.enabled ? 'bg-action-primary' : 'bg-edge-strong'}`}
                >
                  <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-surface-card transition-all ${r.enabled ? 'left-[18px]' : 'left-0.5'}`} />
                </button>
                <input
                  value={r.name}
                  onChange={(e) => patchScene(i, { name: e.target.value })}
                  className="w-32 shrink-0 rounded border border-transparent bg-transparent px-1 py-0.5 text-[12.5px] font-semibold leading-6 text-ink-primary outline-none hover:border-edge focus:border-edge"
                />
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {r.params.map((p, j) => (
                    <label key={p.label} className="flex items-center gap-1.5 text-[11px] text-ink-muted">
                      {p.label}
                      <input
                        value={p.value}
                        onChange={(e) => patchSceneParam(i, j, e.target.value)}
                        className="w-28 rounded border border-edge-strong bg-surface-bg px-2 py-0.5 text-[11px] text-ink-primary outline-none focus:border-edge"
                      />
                    </label>
                  ))}
                </div>
                <input
                  value={r.action}
                  onChange={(e) => patchScene(i, { action: e.target.value })}
                  className="ml-auto min-w-52 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-[11px] leading-5 text-ink-secondary outline-none hover:border-edge focus:border-edge lg:w-72 lg:max-w-[280px]"
                />
              </div>
            ))}
          </div>
        )}
        <p className="mt-3 text-[11px] leading-5 text-ink-muted">
          天气类规则（高湿 / 降温 / 高温 / 雨雪 / 换季 / 供暖）已在「天气面板」按此处阈值实时判定命中；大促期 / 节庆依赖日历，仍为人工判定。
        </p>
      </div>

      {/* AI 选款策略口径（system prompt 引用，不写死） */}
      <div className="mt-10">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-[11px] font-medium tracking-widest text-ink-muted">AI 选款策略口径（system prompt 引用，业务阈值在此可调）</div>
          <button
            onClick={saveStrategy}
            disabled={!strategyRules || strategySaving || !canEditRules}
            className="rounded-md bg-action-primary px-4 py-1.5 text-[12px] text-surface-card hover:opacity-90 disabled:opacity-40"
          >
            {strategySaving ? '保存中…' : '保存策略口径'}
          </button>
        </div>
        <p className="mt-2 text-[11.5px] leading-5 text-ink-muted">
          选款看板「AI 策略共创」对话会调 deepseek-v4.1-flash。系统提示词由四部分拼装：① 上方「排品角色判定规则」+「场景规则库」② 此处的 defaults 兜底阈值 ③ 此处的 extraSystemPrompt 补充 ④ 用户的实时问题。改完保存即生效。
        </p>
        {!strategyLoaded && <div className="mt-3 text-[12px] text-ink-muted">加载中…</div>}
        {strategyRules && (
          <div className="mt-4 space-y-6">
            <fieldset className="border border-edge-strong p-4">
              <legend className="px-2 text-[12px] font-semibold">默认兜底阈值（用户问得抽象时 AI 起步 patch）</legend>
              <div className="grid grid-cols-2 gap-x-8 gap-y-3 text-[12px] md:grid-cols-4">
                {([
                  ['minStock', '最低现货（件）'],
                  ['minConv', '最低转化率（%）'],
                  ['maxReturn', '最高退货率（%）'],
                  ['minNewBuyer', '最低拉新率（%）'],
                ] as const).map(([k, label]) => (
                  <label key={k} className="flex items-center gap-2">
                    {label}
                    <input
                      type="number"
                      value={strategyRules.defaults[k]}
                      onChange={(e) => patchStrategyDefaults(k, Number(e.target.value))}
                      className="w-20 rounded border border-edge-strong px-2 py-1 text-center outline-none focus:border-edge"
                    />
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="border border-edge-strong p-4">
              <legend className="px-2 text-[12px] font-semibold">天气阈值（超过则 AI 视为触发叠加规则）</legend>
              <div className="grid grid-cols-2 gap-x-8 gap-y-3 text-[12px] md:grid-cols-4">
                <label className="flex items-center gap-2">
                  湿度 ≥（% 触发高湿叠加）
                  <input
                    type="number"
                    value={strategyRules.weatherThresholds.humidityHigh}
                    onChange={(e) => patchStrategyWeather('humidityHigh', Number(e.target.value))}
                    className="w-20 rounded border border-edge-strong px-2 py-1 text-center outline-none focus:border-edge"
                  />
                </label>
                <label className="flex items-center gap-2">
                  风级 ≥（级 触发大风叠加）
                  <input
                    type="number"
                    value={strategyRules.weatherThresholds.windStrong}
                    onChange={(e) => patchStrategyWeather('windStrong', Number(e.target.value))}
                    className="w-20 rounded border border-edge-strong px-2 py-1 text-center outline-none focus:border-edge"
                  />
                </label>
              </div>
            </fieldset>
            <fieldset className="border border-edge-strong p-4">
              <legend className="px-2 text-[12px] font-semibold">补充提示语（直接拼到 system prompt 末尾）</legend>
              <textarea
                value={strategyRules.extraSystemPrompt}
                onChange={(e) => setStrategyRules((s) => (s ? { ...s, extraSystemPrompt: e.target.value } : s))}
                placeholder="例：Marius 偏好极简调性，规避高饱和大色块；利润款优先推"
                rows={4}
                className="w-full rounded border border-edge-strong px-3 py-2 text-[12.5px] leading-5 outline-none focus:border-edge"
              />
            </fieldset>
            <p className="text-[11px] leading-5 text-ink-muted">
              关键词 hint（清仓/拉新/利润/主推）作为 LLM 看到的目标方向引导，不在前端做硬匹配——你直接问"清库存"时由 LLM 自行决定要不要走库存款过滤。
            </p>
          </div>
        )}
      </div>

      {/* 天气选款规则（从 weather 项目移植；仅在用户提及天气/温度/降雨/节气时注入 system prompt） */}
      <div className="mt-10">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-[11px] font-medium tracking-widest text-ink-muted">天气选款规则（温度档 / 降雨 / 节气，移植自 weather 项目）</div>
          <button
            onClick={saveWeather}
            disabled={!weatherRules || weatherSaving || !canEditRules}
            className="rounded-md bg-action-primary px-4 py-1.5 text-[12px] text-surface-card hover:opacity-90 disabled:opacity-40"
          >
            {weatherSaving ? '保存中…' : '保存天气规则'}
          </button>
        </div>
        <p className="mt-2 text-[11.5px] leading-5 text-ink-muted">
          选款看板用户问句包含「天气/温度/下雨/降温/节气」等关键词时，AI 会按此处规则出 patch。保存后立即生效。
        </p>
        {!weatherLoaded && <div className="mt-3 text-[12px] text-ink-muted">加载中…</div>}
        {weatherRules && (
          <div className="mt-4 space-y-6">
            <fieldset className="border border-edge-strong p-4">
              <legend className="px-2 text-[12px] font-semibold">温度主规则（8 档：体感温度 → 推荐品类）</legend>
              <div className="space-y-3">
                {weatherRules.temperature_rules.map((r, i) => (
                  <div key={r.temp_range} className="flex flex-wrap items-start gap-2 text-[12px]">
                    <span className="w-24 shrink-0 rounded bg-surface-muted px-2 py-1 text-center font-mono text-[11px] font-semibold">
                      {r.temp_range}°C
                    </span>
                    <div className="flex flex-1 flex-wrap gap-1.5">
                      {ALL_CATEGORIES.map((c) => {
                        const on = r.categories.includes(c);
                        return (
                          <button
                            type="button"
                            key={c}
                            onClick={() => patchTempRule(i, toggleCat(r.categories, c))}
                            className={`rounded border px-2 py-0.5 text-[11px] transition-colors ${
                              on ? 'border-ink-primary bg-surface-subtle text-ink-primary' : 'border-edge-strong text-ink-muted hover:border-ink-primary'
                            }`}
                          >
                            {c}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </fieldset>
            <fieldset className="border border-edge-strong p-4">
              <legend className="px-2 text-[12px] font-semibold">降雨叠加（连续雨天推这些品类）</legend>
              <div className="flex flex-wrap gap-1.5">
                {ALL_CATEGORIES.map((c) => {
                  const on = weatherRules.rain_overlay_categories.includes(c);
                  return (
                    <button
                      type="button"
                      key={c}
                      onClick={() =>
                        setWeatherRules((w) =>
                          w ? { ...w, rain_overlay_categories: toggleCat(w.rain_overlay_categories, c) } : w,
                        )
                      }
                      className={`rounded border px-2 py-0.5 text-[11px] transition-colors ${
                        on ? 'border-ink-primary bg-surface-subtle text-ink-primary' : 'border-edge-strong text-ink-muted hover:border-ink-primary'
                      }`}
                    >
                      {c}
                    </button>
                  );
                })}
              </div>
            </fieldset>
            <fieldset className="border border-edge-strong p-4">
              <legend className="px-2 text-[12px] font-semibold">节气叠加（7 段：节气 → 备货品类）</legend>
              <div className="space-y-4">
                {weatherRules.solar_term_overlays.map((s, i) => (
                  <div key={i} className="border border-edge-muted p-3">
                    <div className="text-[11.5px] text-ink-muted">{s.description}</div>
                    <div className="mt-1 text-[11.5px]">节气：
                      {s.terms.join('、')}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {ALL_CATEGORIES.map((c) => {
                        const on = s.categories.includes(c);
                        return (
                          <button
                            type="button"
                            key={c}
                            onClick={() => patchSolarCats(i, toggleCat(s.categories, c))}
                            className={`rounded border px-2 py-0.5 text-[11px] transition-colors ${
                              on ? 'border-ink-primary bg-surface-subtle text-ink-primary' : 'border-edge-strong text-ink-muted hover:border-ink-primary'
                            }`}
                          >
                            {c}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </fieldset>
          </div>
        )}
      </div>
    </div>
  );
}
