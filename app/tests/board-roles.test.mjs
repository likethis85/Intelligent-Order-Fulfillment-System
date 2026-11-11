// 选款看板五类角色：主推 → 经典 → 现金回收 → 利润 → 库存，先命中先生效。
// 套系（小名，无小名用款号）是坑位单位：同一套系的多件先相加再判定，禁止拆到不同角色。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const roles = fs.readFileSync(path.resolve(__dirname, '../src/lib/boardRoles.ts'), 'utf8');
const page = fs.readFileSync(path.resolve(__dirname, '../src/sections/BoardPage.tsx'), 'utf8');

test('角色顺序固定：主推 → 经典 → 现金回收 → 利润 → 库存', () => {
  const m = roles.match(/BOARD_ROLES: BoardRole\[\] = \[(.*?)\]/s);
  assert.ok(m, 'BOARD_ROLES 常量存在');
  const order = m[1].split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);
  assert.deepEqual(order, ['主推', '经典', '现金回收', '利润', '库存']);
});

test('判定按优先级短路，后面的维度不覆盖', () => {
  const body = roles.slice(roles.indexOf('export function deriveGroupRole'));
  const idx = ['主推', '经典', '现金回收', '利润', '库存'].map((r) => body.indexOf(`return '${r}'`));
  assert.ok(idx.every((i) => i > 0), '五个角色都有返回分支');
  for (let i = 1; i < idx.length; i++) assert.ok(idx[i] > idx[i - 1], '顺序不能变');
  assert.ok(body.indexOf("return '主推'") < body.indexOf('经典'), '主推先判');
});

test('主推 / 经典 / 现金回收 / 利润 的阈值口径', () => {
  assert.ok(roles.includes('g.available >= 150 && signOk && g.seasonal'), '主推：可用≥150 + 签收≥45% + 应季');
  assert.ok(roles.includes('(g.red && g.available >= 150) || (signOk && g.sales14d >= 30)'), '经典：红榜+可用≥150 或 签收≥45%+近14天≥30');
  assert.ok(roles.includes('g.returnRate >= 0.85'), '现金回收：总退货率≥85%');
  assert.ok(roles.includes('g.available > 100'), '现金回收：可用数 >100');
  assert.ok(roles.includes('g.ratio >= 3 && g.seasonal && g.available >= 150'), '利润：倍率≥3.0 + 应季 + 可用≥150');
  assert.ok(roles.includes('g.available >= 150) return \'库存\''), '库存：可用≥150 且未落入以上');
});

test('签收率 = 1 − 总退货率，不用发货后退货率', () => {
  assert.ok(roles.includes('g.signRate = rr === null ? null : 1 - rr;'), '签收率 = 1 − 总退货率');
  assert.ok(roles.includes('signRate !== null && g.signRate >= 0.45'), '无退货数据时不算签收达标');
  assert.ok(!/tagReturnPostShip/.test(roles), '禁用发货后退货率打标');
});

test('组内总退货率 = SUM(退货数量)/SUM(销售数量)，不是按款平均', async () => {
  const { buildSuiteGroups } = await import('../src/lib/boardRoles.ts');
  const p = (over) => ({ sub: '上班套', name: over.id, season: '秋冬', price: 1000, ...over });
  // A：销售 1000 件、退货 400 件（40%）；B：销售 100 件、退货 50 件（50%）
  // 数量口径 450/1100 ≈ 40.9%；若按款平均会是 45%，按净销量加权又会是另一个值
  const groups = buildSuiteGroups(
    [
      p({ id: 'A1', returnQty: 400, salesQty: 1000, returnRate: 0.4, netSales: 600 }),
      p({ id: 'A2', returnQty: 50, salesQty: 100, returnRate: 0.5, netSales: 50 }),
    ],
    () => 200,
    () => 50,
  );
  assert.equal(groups.length, 1, '同一小名合成一个套系');
  const sign = groups[0].signRate;
  assert.ok(Math.abs(sign - (1 - 450 / 1100)) < 1e-9, `签收率按数量口径：得到 ${sign}`);
  assert.ok(Math.abs(sign - 0.55) > 1e-6, '不能退化成按款平均的 55%');
});

test('卡里没有数量列时用 总退货率 + 净销量 反推销售数量，口径一致', async () => {
  const { buildSuiteGroups } = await import('../src/lib/boardRoles.ts');
  const p = (over) => ({ sub: '通勤套', name: over.id, season: '秋冬', price: 1000, ...over });
  // 反推：A 销售 600/(1−0.4)=1000，退货 400；B 销售 50/(1−0.5)=100，退货 50 → 450/1100
  const groups = buildSuiteGroups(
    [
      p({ id: 'B1', returnRate: 0.4, netSales: 600 }),
      p({ id: 'B2', returnRate: 0.5, netSales: 50 }),
    ],
    () => 200,
    () => 50,
  );
  assert.ok(Math.abs(groups[0].signRate - (1 - 450 / 1100)) < 1e-9);

  const src = roles.slice(roles.indexOf('// 组内总退货率'), roles.indexOf('export function buildSuiteGroups'));
  assert.ok(src.includes('SUM(退货数量) / SUM(销售数量)'), '注释写明口径');
  assert.ok(src.includes('const s = net / (1 - r)'), '没有数量列时反推销售数量');
  assert.ok(!src.includes('weighted / weight, r'), '不能先按款算率再平均');
});

test('套系 key = 小名（无小名退回款号），组内指标相加', () => {
  assert.ok(roles.includes("String(p.sub || '').trim() || p.id"), '小名优先、款号兜底');
  assert.ok(roles.includes('g.available += availableOf(p, estimateOf(p))'), '可用数按件相加');
  assert.ok(roles.includes('g.sales14d += sales14dOf(p) || 0'), '近14天销量按件相加');
  assert.ok(page.includes('buildSuiteGroups(pool, estimateOf'), '看板按套系聚合后再判定');
  assert.ok(page.includes('<div key={g.key}'), '一张卡片 = 一个套系');
  assert.ok(page.includes('onAdd(g.members.map((m) => m.id), s.id)'), '放入货盘时整套系作为一个坑位');
});

test('评分四段：净签收贡献 50 / 签收健康 20 / 应季 15 / 库存 15', () => {
  const body = roles.slice(roles.indexOf('export function scoreGroup'));
  assert.ok(body.includes('Math.min(50, ((g.sales14d * sign) / 110) * 50)'), '净件数 110 封顶，占 50 分');
  assert.ok(body.includes('Math.min(20, Math.max(0, ((sign - 0.15) / 0.45) * 20))'), '签收率 15% 起算、60% 满分');
  assert.ok(body.includes('g.available >= 150 ? 15 : g.available >= 100 ? 10 : 5'), '库存 15/10/5 分档');
  assert.ok(roles.includes("if (list.some((s) => /秋|冬/.test(s))) return 15;"), '秋冬 15 分');
  assert.ok(roles.includes("if (list.every((s) => /春|夏/.test(s))) return 0;"), '只有春夏 0 分');
  assert.ok(roles.includes('return 8;'), '其他或空值 8 分');
  assert.ok(roles.includes('const sign = g.signRate ?? 0;'), '签收率缺失按 0 计');
});

test('卡片在预估可用与在途之间显示签收率', () => {
  assert.ok(
    page.includes("预估可用 {Math.round(g.available)} · 签收 {g.signRate === null ? '—'"),
    '签收率位于预估可用和在途之间；没有退货数据时显示 —',
  );
});

test('看板按评分从高到低排序，卡片显示评分', () => {
  assert.ok(page.includes('.sort((a, b) => b.score - a.score'), '评分降序');
  assert.ok(page.includes('评分 {score.toFixed(1)}'), '卡片展示评分');
});

test('快捷方案已移除，商品角色排在最上面', () => {
  assert.ok(!page.includes('const PRESETS'), '不再有快捷方案');
  assert.ok(!page.includes('快捷方案'), '不再渲染快捷方案行');
  const roleAt = page.indexOf('<Dim label="商品角色">');
  const catAt = page.indexOf('<Dim label="品类">');
  assert.ok(roleAt > 0 && roleAt < catAt, '商品角色在品类之前');
  assert.ok(page.includes('近14天销量补齐中'), '近14天销量还在预热时给出提示');
});
