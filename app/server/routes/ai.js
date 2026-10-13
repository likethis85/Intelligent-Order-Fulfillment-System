// AI 选款策略端点：POST /api/ai/strategy
// 1) 注入：role-rules.json + scene-rules.json + strategy-rules.json 作为 system prompt
// 2) 调 deepseek-v4.1-flash（OpenAI 兼容 chat/completions）
// 3) 要求 LLM 返回 JSON：{ text, patch } —— patch 是对前端 FilterState 的部分覆盖
//    { cats?, bands?, temps?, roles?, minStock?, minConv?, maxReturn?, minNewBuyer?, noTransit?, scenes? }

import { Router } from 'express';
import { getRoleRules } from '../role-rules.js';
import { getSceneRules } from '../scene-rules.js';
import { getStrategyRules } from '../strategy-rules.js';
import { getWeatherRules } from '../weather-rules.js';
import { getWeather } from '../weather-client.js';

const router = Router();

// 触发 weather 规则注入的关键词（用户问题里命中其一就把 weather 规则拼进 system prompt）
const WEATHER_TRIGGERS = /天气|温度|体感|降温|升温|下雨|降雨|雨季|雨雪|梅雨|暴雨|潮湿|湿度|高湿|干燥|大风|风速|风寒|节气|立春|雨水|惊蛰|春分|清明|谷雨|立夏|小满|芒种|夏至|小暑|大暑|立秋|处暑|白露|秋分|寒露|霜降|立冬|小雪|大雪|冬至|小寒|大寒|换季|供暖|夏装|冬装|清凉|保暖|防泼水/;

const SYSTEM_PROMPT = `你是货盘选款策略助手。基于用户的直播目标（清仓/拉新/利润/品类聚焦等），把策略转成具体的筛选条件 patch。

## 输出格式（严格 JSON，不要 markdown）
{
  "text": "给用户的解释（1-2 句，口语化）",
  "patch": { /* 要改的筛选字段，可选 */ }
}

## 可改的 patch 字段
- cats: string[]   品类
- bands: string[]  价格带（低/中/高）
- temps: string[]  温度带（必须从这 7 个值里选：<5°C / 0~12°C / 5~15°C / 10~20°C / 15~25°C / 18~28°C / 全季）
- roles: ('引流'|'利润'|'库存')[]  角色
- scenes: string[] 场景规则 key
- minStock: number 最低现货
- minConv: number  最低转化率 %
- maxReturn: number 最高退货率 %
- minNewBuyer: number 最低拉新率 %
- noTransit: boolean 只要无在途的款

## 当前业务口径（来自配置后台，运行时可能已改；以这条为准）
{roleRules}

## 当前场景规则（命中条件 + 动作）
{sceneRules}

## 用户的默认策略起点（如果他什么都没说，按这套兜底）
{strategyDefaults}

## 用户在 ConfigPage 自定义补充
{extraPrompt}

## 行为规则
1. 只输出 JSON，不要包 \`\`\`json 块、不要解释字段名。
2. 用户的输入如果太抽象（"这场主打拉新"），patch 至少含 minNewBuyer 抬升；不要把所有字段都填。
3. 如果用户问的是操作建议（"应该选什么品类"），也可以只返回 text 不带 patch。
4. 数字单位：minStock 是「件」、minConv/maxReturn/minNewBuyer 都是「%」。`;

// 拉真实天气预报（Open-Meteo，weather-client 自带 1h 缓存），压成给 LLM 看的紧凑文本
async function buildWeatherContext() {
  try {
    const w = await getWeather();
    return w.cities
      .map((c) => {
        const t = c.trends || {};
        const days = (c.forecast || [])
          .slice(0, 7)
          .map((d) => `    ${d.date} ${d.week} ${d.weather} ${d.tempMin}~${d.tempMax}°C 降水概率${d.precip}% 湿度${d.humidity}% 风${d.windScale}级`)
          .join('\n');
        return `  【${c.name}】未来7天：均温 ${t.avgTemp}°C（${t.tempTrendDesc}），雨天 ${t.rainDays} 天，平均湿度 ${t.avgHumidity}%\n${days}`;
      })
      .join('\n');
  } catch (err) {
    return `  （实时天气拉取失败：${err.message}；请只按天气规则推断，并在 text 里说明暂未拿到实况）`;
  }
}

async function buildSystemPrompt(query) {
  const role = getRoleRules();
  const scene = getSceneRules();
  const strat = getStrategyRules();
  let prompt = SYSTEM_PROMPT
    .replace('{roleRules}', JSON.stringify(role, null, 2))
    .replace('{sceneRules}', JSON.stringify(scene.map((s) => ({ key: s.key, name: s.name, params: s.params, action: s.action, enabled: s.enabled })), null, 2))
    .replace('{strategyDefaults}', JSON.stringify(strat.defaults, null, 2))
    .replace('{extraPrompt}', strat.extraSystemPrompt || '（无）');

  // 天气相关问题时，注入 weather 项目的天气选款规则 + 实时天气预报（真实数据，非拍脑袋）
  if (WEATHER_TRIGGERS.test(query || '')) {
    const weatherRules = getWeatherRules();
    const wt = strat.weatherThresholds || { humidityHigh: 75, windStrong: 6 };
    const tempRules = (weatherRules.temperature_rules || []).map(
      (r) => `  - 体感 ${r.temp_range}°C：${(r.categories || []).join('、')}`,
    ).join('\n');
    const rainCats = (weatherRules.rain_overlay_categories || []).join('、');
    const solarRules = (weatherRules.solar_term_overlays || []).map(
      (s) => `  - ${(s.terms || []).join('、')}：${s.description}（品类：${(s.categories || []).join('、')}）`,
    ).join('\n');
    const realtime = await buildWeatherContext();
    prompt += `\n\n## 实时天气预报（Open-Meteo 真实数据，今日起 7 天；天气类选款必须以此为准）
${realtime}

## 天气选款规则（来自 weather 项目；阈值可在 ConfigPage 改）
- 温度主规则：按体感温度区间决定主推品类
${tempRules}
- 降雨叠加：连续雨天推 ${rainCats}
- 高湿叠加：湿度 ≥ ${wt.humidityHigh}% 视为高湿，降低厚针织优先级、提高透气类
- 大风叠加：风级 ≥ ${wt.windStrong} 级视为大风，按季节叠外套/保暖
- 节气叠加（7 个分时段品类策略，按当前节气节点选其一）
${solarRules}

天气类问题的行为要求：
1. text 里必须引用上面的真实天气（具体城市 + 日期 + 温度/降雨，例如"杭州 10-12 起连续 3 天雨、均温 18°C"），不要空谈规则。
2. 按实时温度命中温度主规则调 cats/temps；未来 7 天雨天 ≥2 天叠加降雨品类；平均湿度 ≥ ${wt.humidityHigh}% 叠加高湿规则。
3. 用户要"现货"时（天气备货默认要现货），patch 里给 minStock（如 50）并可考虑 noTransit。`;
  }
  return prompt;
}

function buildUserMessage(query, currentFilters, candidates) {
  // candidates 已经按当前筛选过滤过了；按场景相关度截前 30 个 + 关键指标
  // 全量传到 LLM 会超 Express body 限制 + 烧 token；前 30 个对策略推荐已够
  const slim = (candidates || []).slice(0, 30).map((p) => ({
    code: p.id,
    name: p.name,
    category: p.category,
    priceBand: p.priceBand,
    tempBand: p.tempBand,
    roles: p.roles,
    stockMain: p.stockMain,
    inTransit: p.inTransit,
    conversion: Math.round((p.conversion || 0) * 1000) / 10,
    returnRate: Math.round((p.returnRate || 0) * 1000) / 10,
    newBuyer: Math.round((p.newBuyer || 0) * 1000) / 10,
  }));
  return [
    `【用户目标】${query}`,
    `【当前筛选】${JSON.stringify(currentFilters || {})}`,
    `【候选款（已按当前筛选过滤；本次传前 ${slim.length} 个）】${JSON.stringify(slim)}`,
  ].join('\n');
}

// 从 LLM 输出里抠 JSON（容忍 ```json 包裹 / 前后杂文本）
function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : text;
  const m = body.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

router.post('/strategy', async (req, res) => {
  const { query, currentFilters, candidates } = req.body || {};
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'bad_param', message: '缺少 query' });
  }
  const baseUrl = process.env.AI_BASE_URL || 'https://aigw.telecomjs.com/v1';
  const apiKey = process.env.AI_API_KEY;
  const model = process.env.AI_MODEL || 'deepseek-v4.1-flash';
  if (!apiKey) {
    return res.status(503).json({ error: 'no_api_key', message: '服务端未配置 AI_API_KEY' });
  }

  try {
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: await buildSystemPrompt(query) },
          { role: 'user', content: buildUserMessage(query, currentFilters, candidates) },
        ],
      }),
    });
    if (!r.ok) {
      const text = await r.text();
      return res.status(502).json({ error: 'upstream', message: `AI 网关 ${r.status}: ${text.slice(0, 300)}` });
    }
    const j = await r.json();
    const content = j?.choices?.[0]?.message?.content || '';
    const parsed = extractJson(content);
    if (!parsed || typeof parsed.text !== 'string') {
      return res.status(502).json({ error: 'bad_response', message: 'AI 输出无法解析', raw: content.slice(0, 500) });
    }
    res.json({ text: parsed.text, patch: parsed.patch || null, model });
  } catch (err) {
    console.error('[ai/strategy]', err);
    res.status(503).json({ error: 'fetch_failed', message: err.message });
  }
});

export default router;
