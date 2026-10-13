// 场景规则库：默认 8 条 + 配置后台可改（server/data/scene-rules.json）
// 每条：key（稳定标识）/ name / params（参数键值）/ action（命中后的动作文案）/ enabled
// 注意：持久化已接真，但「按天气 API / 日历自动激活」的执行引擎尚未实现，当前仅维护配置
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_FILE = path.join(__dirname, 'data', 'scene-rules.json');

export const DEFAULT_SCENE_RULES = [
  { key: 'humid', name: '高湿 / 回南天 / 梅雨', params: [{ label: '7天均湿 >', value: '75%' }], action: '针织衫只留速干候选；真丝、羊绒降权', enabled: true },
  { key: 'cold-snap', name: '降温 / 寒潮', params: [{ label: '48h 降温 ≥', value: '8°C' }], action: '大衣、羽绒、羊绒提权，按降温幅度分档', enabled: true },
  { key: 'heat', name: '高温 / 热浪', params: [{ label: '7天最高温 ≥', value: '33°C' }], action: '厚款降权；速干、亚麻、短袖提权', enabled: true },
  { key: 'heating', name: '供暖季', params: [{ label: '时段', value: '11月~3月' }, { label: '区域', value: '北方供暖城市' }], action: '厚毛衣降权；薄内搭、开衫提权', enabled: true },
  { key: 'rain-snow', name: '雨雪天', params: [{ label: '降水概率 >', value: '30%' }], action: '防水/易打理面料提权；拖地长款降权', enabled: true },
  { key: 'season-change', name: '换季期', params: [{ label: '昼夜温差 >', value: '10°C' }], action: '薄外套、开衫、可叠穿款提权', enabled: true },
  { key: 'promo', name: '大促期', params: [{ label: '引流款占比上调至', value: '40%' }], action: '引流款占比上调、目标款数上调', enabled: true },
  { key: 'festival', name: '节庆', params: [{ label: '节庆日历', value: '年货节/情人节/…' }], action: '对应色系 / 礼赠属性款提权', enabled: true },
];

// 单条规则规范化：缺字段时用默认规则（按 key 匹配，匹配不到按序号）兜底
function normalizeRule(raw, idx) {
  const dflt = DEFAULT_SCENE_RULES.find((d) => d.key === raw?.key) || DEFAULT_SCENE_RULES[idx] || {};
  const params = Array.isArray(raw?.params)
    ? raw.params.map((p, pi) => ({
        label: String(p?.label ?? dflt.params?.[pi]?.label ?? `参数${pi + 1}`),
        value: String(p?.value ?? dflt.params?.[pi]?.value ?? ''),
      }))
    : (dflt.params || []).map((p) => ({ ...p }));
  return {
    key: String(raw?.key ?? dflt.key ?? `rule-${idx}`),
    name: String(raw?.name ?? dflt.name ?? ''),
    params,
    action: String(raw?.action ?? dflt.action ?? ''),
    enabled: raw?.enabled !== undefined ? Boolean(raw.enabled) : (dflt.enabled ?? true),
  };
}

export function getSceneRules() {
  try {
    const saved = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
    if (Array.isArray(saved)) return saved.map((r, i) => normalizeRule(r, i));
  } catch {
    // 文件不存在 / 损坏：回落默认
  }
  return DEFAULT_SCENE_RULES.map((r) => ({ ...r, params: r.params.map((p) => ({ ...p })) }));
}

export function saveSceneRules(rules) {
  if (!Array.isArray(rules)) throw new Error('场景规则必须是数组');
  const normalized = rules.map((r, i) => normalizeRule(r, i));
  fs.mkdirSync(path.dirname(RULES_FILE), { recursive: true });
  const tmp = RULES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2), 'utf8');
  fs.renameSync(tmp, RULES_FILE);
  return normalized;
}
