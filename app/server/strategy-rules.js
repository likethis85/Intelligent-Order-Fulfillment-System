// AI 选款策略口径：默认 + server/data/strategy-rules.json 覆盖
// 硬阈值给 LLM 一个起步 patch（用户没明确数字时用），用户可在 ConfigPage 改
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_FILE = path.join(__dirname, 'data', 'strategy-rules.json');

export const DEFAULT_STRATEGY_RULES = {
  // 默认 patch：什么都不筛（用户说一句"这场主打拉新"，AI 至少会把 minNewBuyer 抬到 30）
  defaults: {
    minStock: 0,
    minConv: 0,
    maxReturn: 100,
    minNewBuyer: 0,
  },
  // 关键词 → 推荐 patch（用户没说话 / 话太抽象时，AI 看到这些 hint 会往这个方向调）
  // 这块只是"AI 助手的内部 hint"，不是用户问的关键词——关键词匹配目前是 LLM 自己做的
  hints: {
    '清仓': { roles: ['库存'], noTransit: true, minStock: 200, minConv: 5, maxReturn: 30 },
    '拉新': { minNewBuyer: 30, bands: ['低', '中'] },
    '利润': { roles: ['利润'], bands: ['高'], maxReturn: 30 },
    '主推': { roles: ['引流'], minConv: 6 },
  },
  // 天气选款的湿度 / 风速阈值（与 weather 项目一致：≥75% 视为高湿，≥6 级视为大风）
  weatherThresholds: {
    humidityHigh: 75,   // %  体感湿度 ≥ 此值触发"高湿叠加"（降低厚针织优先级）
    windStrong: 6,     // 级 风级 ≥ 此值触发"大风叠加"（按季节叠外套/保暖）
  },
  // 用户加在 ConfigPage 的「补充提示语」：直接拼到 system prompt 后面
  extraSystemPrompt: '',
};

let cache = null;
let cacheMtime = 0;

function mergeWithDefaults(saved) {
  const d = DEFAULT_STRATEGY_RULES;
  const s = saved && typeof saved === 'object' ? saved : {};
  return {
    defaults: { ...d.defaults, ...(s.defaults || {}) },
    hints: { ...d.hints, ...(s.hints || {}) },
    weatherThresholds: { ...d.weatherThresholds, ...(s.weatherThresholds || {}) },
    extraSystemPrompt: typeof s.extraSystemPrompt === 'string' ? s.extraSystemPrompt : d.extraSystemPrompt,
  };
}

export function getStrategyRules() {
  try {
    const st = fs.statSync(RULES_FILE);
    if (cache && st.mtimeMs === cacheMtime) return cache;
    const saved = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
    cache = mergeWithDefaults(saved);
    cacheMtime = st.mtimeMs;
    return cache;
  } catch {
    return DEFAULT_STRATEGY_RULES;
  }
}

export function saveStrategyRules(rules) {
  const merged = mergeWithDefaults(rules);
  fs.mkdirSync(path.dirname(RULES_FILE), { recursive: true });
  fs.writeFileSync(RULES_FILE, JSON.stringify(merged, null, 2));
  cache = null;
  cacheMtime = 0;
  return merged;
}
