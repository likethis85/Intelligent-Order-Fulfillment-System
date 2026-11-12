// AI 策略提示词必须与看板当前口径一致：
// 商品角色 / 场景 / 适穿温度带都已下线，而 prompt 曾经还在教模型输出 roles、注入 sceneRules，
// 角色阈值也还停在「签收率 ≥ 45%」。这一组测试锁住现在的口径。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const aiSrc = fs.readFileSync(path.resolve(__dirname, '../server/routes/ai.js'), 'utf8');
const page = fs.readFileSync(path.resolve(__dirname, '../src/sections/BoardPage.tsx'), 'utf8');
const apiSrc = fs.readFileSync(path.resolve(__dirname, '../src/data/api.ts'), 'utf8');

const prompt = aiSrc.slice(aiSrc.indexOf('const SYSTEM_PROMPT'), aiSrc.indexOf('// 拉真实天气预报'));

test('patch 字段只剩看板还在用的筛选维度，不再教模型输出 roles / 场景 / 温度带', () => {
  for (const f of ['cats', 'waves', 'bands', 'seasons', 'years', 'minStock', 'minConv', 'minSignRate', 'maxReturn', 'minNewBuyer', 'noTransit']) {
    assert.ok(prompt.includes(`${f}:`), `prompt 里列出 ${f}`);
  }
  assert.ok(!prompt.includes('roles: ('), 'prompt 不再把 roles 列为可改字段');
  assert.ok(prompt.includes('不要输出 roles'), '明确告诉模型角色只是展示页签');
  assert.ok(!/\btemps\b/.test(prompt), '不再提适穿温度带');
});

test('不再注入 role-rules / scene-rules 的旧阈值，角色口径写死在 prompt 里', () => {
  assert.ok(!aiSrc.includes('getRoleRules'), '不注入 role-rules');
  assert.ok(!aiSrc.includes('getSceneRules'), '不注入 scene-rules');
  assert.ok(!aiSrc.includes('{roleRules}'), '没有 roleRules 占位符');
  assert.ok(!aiSrc.includes('{sceneRules}'), '没有 sceneRules 占位符');
  assert.ok(prompt.includes('主推：预估可用 ≥ 150 且 发货后退货率 ≤ 40% 且 应季'), '主推口径与 boardRoles.ts 一致');
  assert.ok(prompt.includes('经典：红榜且预估可用 ≥ 150，或 发货后退货率 ≤ 40% 且近 14 天销量 ≥ 30'), '经典口径一致');
});

test('应季按月、发货后退货率 ≤40% 写进口径', () => {
  assert.ok(prompt.includes('8、9、10、11、12、1 月应季为「秋 + 冬」，2–7 月应季为「春 + 夏」'), '应季按当前月份');
  assert.ok(prompt.includes('发货后退货率 = SUM(发货后退货) / SUM(实发量)'), '发货后退货率公式');
  assert.ok(prompt.includes('≤ 40% 才算过线'), '40% 阈值');
  assert.ok(prompt.includes('SUM(退货数量) / SUM(销售数量)'), '签收率用数量口径');
  const stale = prompt.split('签收率 ≥ 45%').length - 1;
  assert.equal(stale, 1, '旧的 45% 签收率门槛只剩「不要再说」这一处否定用法');
  assert.ok(prompt.includes('不要再说「签收率 ≥ 45%」'), '明确禁止旧口径');
});

test('天气规则只落到品类/季节，不再指向已经下线的温度带', () => {
  assert.ok(aiSrc.includes('调 cats（看板只按品类筛，没有适穿温度带这个维度）'), '天气只调 cats');
  assert.ok(!aiSrc.includes('调 cats/temps'), '已删除 cats/temps 的旧指引');
  assert.ok(aiSrc.includes('用 seasons'), '要收口季节就用 seasons');
});

test('调用网关：默认模型 deepseek-v4.1-flash-new，baseUrl 兼容贴完整 /chat/completions', () => {
  assert.ok(aiSrc.includes("process.env.AI_MODEL || 'deepseek-v4.1-flash-new'"), '默认模型已更新');
  assert.ok(aiSrc.includes(".replace(/\\/chat\\/completions\\/?$/, '')"), 'AI_BASE_URL 贴完整地址也能用');
  assert.ok(aiSrc.includes("router.get('/status'"), '有配置自检端点');
  assert.ok(!aiSrc.includes('AI_API_KEY:'), '不把 key 写进代码');
});

test('前端同样清理旧字段：patch 类型与 normalizePatch 都去掉 roles/scenes/temps', () => {
  const block = apiSrc.slice(apiSrc.indexOf('export interface AiStrategyPatch'), apiSrc.indexOf('export function postAiStrategy'));
  assert.ok(!/\broles\?/.test(block) && !/\btemps\?/.test(block) && !/\bscenes\?/.test(block), 'AiStrategyPatch 不带旧字段');
  assert.ok(block.includes('minSignRate?'), '补上 minSignRate');
  assert.ok(block.includes('waves?') && block.includes('years?'), '补上波段与年份');
  assert.ok(page.includes('const PATCH_KEYS = ['), '看板用白名单过滤 AI patch');
  assert.ok(page.includes('(PATCH_KEYS as readonly string[]).includes(k)'), '白名单外的键直接丢掉');
  assert.ok(page.includes('品类 / 波段 / 季节 / 上新年份 / 价格带'), '兜底回复文案同步更新');
  assert.ok(!page.includes('角色（引流·利润·库存）'), '兜底文案不再宣传角色维度');
});
