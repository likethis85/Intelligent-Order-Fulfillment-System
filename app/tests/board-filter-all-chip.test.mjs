// 选款看板的筛选维度统一带「全部」按钮，且默认就是「全部」（该维度不过滤）。
// 语义：选中「全部」= 清空该维度；点具体项从「全部」切过去；取消到最后一个自动回到「全部」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.resolve(__dirname, '../src/sections/BoardPage.tsx'), 'utf8');

test('每个多选维度都走统一的 DimChips，并带「全部」', () => {
  assert.ok(code.includes('function DimChips<T extends string | number>('), '需要统一的筛选 chip 组件');
  assert.ok(code.includes('<Chip on={selected.length === 0} label="全部" onClick={() => onChange([])} />'), '「全部」在数组为空时选中');
  for (const dim of ['品类', '波段', '上新年份', '价格带', '季节']) {
    assert.ok(code.includes(`<Dim label="${dim}">`), `${dim} 维度存在`);
  }
  const uses = code.match(/<DimChips/g) || [];
  assert.ok(uses.length >= 5, '品类/上新年份/波段/价格带/季节都要用 DimChips');
});

test('点具体项时从「全部」切过去，多选仍可叠加', () => {
  assert.ok(
    code.includes('onChange(selected.includes(o) ? selected.filter((x) => x !== o) : [...selected, o])'),
    '已选则取消，未选则追加（「全部」状态下追加即替换）',
  );
});

test('默认筛选全部为空，等于每个维度都选中「全部」', () => {
  assert.ok(code.includes('const [f, setF] = useState<Filters>({ ...DEFAULT_FILTERS });'), '初始值不能预设品类');
  assert.ok(code.includes('cats: [], waves: [], bands: [], seasons: [], years: []'), 'DEFAULT_FILTERS 的数组维度都为空');
});

test('维度顺序：上新年份 → 波段 → 品类 → 季节 → 价格带', () => {
  const at = (label) => code.indexOf(`<Dim label="${label}">`);
  const seq = ['上新年份', '波段', '品类', '季节', '价格带'].map(at);
  assert.ok(seq.every((i) => i > 0), '五个维度都存在');
  for (let i = 1; i < seq.length; i++) assert.ok(seq[i] > seq[i - 1], '顺序不能变');
});

test('季节筛选按「季节(到款式)」匹配，组合值（秋冬）也能被秋/冬命中', () => {
  assert.ok(code.includes("f.seasons.some((s) => String(p.season || '').includes(s))"), '按季节值包含匹配');
  assert.ok(code.includes("const seasonList = (() =>"), '季节选项从商品数据里取');
});

test('商品角色筛选已下线：没有角色维度、预置和页签', () => {
  assert.ok(!code.includes('<Dim label="商品角色">'), '不再渲染商品角色维度');
  assert.ok(!code.includes('ROLE_PRESETS'), '不再有角色预置');
  assert.ok(!code.includes('applyRole'), '不再有角色联动');
  // 结果区的角色页签保留（只切换展示，不联动筛选条件）
  assert.ok(code.includes("onClick={() => setRoleTab(r)}"), '结果区角色页签保留');
  assert.ok(!code.includes('applyRole'), '页签不再联动筛选条件');
  assert.ok(!code.includes('f.roles'), '筛选条件里不再有 roles');
  assert.ok(code.includes('商品角色筛选已下线'), 'AI 下发的 roles 会被丢掉，注释写明原因');
});

test('指标阈值里有签收率，位于转化率和退货率之间', () => {
  const conv = code.indexOf("['转化率≥%', 'minConv'");
  const sign = code.indexOf("['签收率≥%', 'minSignRate'");
  const ret = code.indexOf("['退货率≤%', 'maxReturn'");
  assert.ok(conv > 0 && sign > conv && ret > sign, '顺序：转化率 → 签收率 → 退货率');
  assert.ok(code.includes('(1 - p.returnRate) * 100 >= f.minSignRate'), '签收率 = 1 − 总退货率（SUM 退货数量/SUM 销售数量）');
});

test('配件 / 赠品整类排除：品类选项不列、候选池也不出现', () => {
  assert.ok(code.includes("const ACCESSORY_CAT_RE = /配件|配饰|赠品/"), '统一的排除规则');
  assert.ok(code.includes("v !== '全部' && !ACCESSORY_CAT_RE.test(v)"), '品类选项里过滤');
  assert.ok(code.includes('!isAccessoryOrGift(p) &&'), '候选池里先排除，排在所有维度条件之前');
  // 品类是「包装配件」、或者名称里带「赠品」的款都不该进候选池
  const re = /配件|配饰|赠品/;
  assert.ok(re.test('包装配件') && re.test('配件') && re.test('赠品'), '覆盖常见取值');
  assert.ok(!re.test('针织衫') && !re.test('大衣'), '正常品类不受影响');
});

test('坑位数量维度已移除', () => {
  assert.ok(!code.includes('<Dim label="坑位数量">'), '不再渲染坑位数量');
  assert.ok(!code.includes('perLookN'), 'Filters 里不再保留 perLookN');
});

test('适穿温度带与场景规则维度已移除', () => {
  assert.ok(!code.includes('<Dim label="适穿温度带">'), '不再渲染温度带筛选');
  assert.ok(!code.includes('<Dim label="场景规则">'), '不再渲染场景规则筛选');
  assert.ok(!code.includes('temps:'), 'Filters 里不再保留 temps');
  assert.ok(!code.includes('scenes:'), 'Filters 里不再保留 scenes');
});

test('上新年份位于波段之前，且无接口数据时用商品上新日期兜底', () => {
  const yearAt = code.indexOf('<Dim label="上新年份">');
  const waveAt = code.indexOf('<Dim label="波段">');
  assert.ok(yearAt >= 0 && waveAt > yearAt, '顺序：上新年份 → 波段');
  assert.ok(code.includes("p.launchDate || '').match(/^(\\d{4})/"), '接口没有年份时从商品上新日期兜底取年份');
});

test('库存条件用「预估剩余库存」，输入框可连续输入（Dim 必须在组件外）', () => {
  assert.ok(code.includes('预估剩余库存 ≥'), '库存条件文案');
  assert.ok(!code.includes('现货 ≥'), '不再显示旧的「现货 ≥」');
  // Dim 若定义在 BoardPage 内部，每次渲染都是新组件类型 → 输入框重挂载丢焦点
  assert.ok(/^function Dim\(/m.test(code), 'Dim 定义在模块级');
  assert.ok(!code.includes('const Dim = '), '不能在组件内定义 Dim');
});

test('波段按月份从早到晚排序，季度波段不展示，占位值排最后', () => {
  assert.ok(/function waveSortKey\(/.test(code), '排序键定义在模块级');
  assert.ok(code.includes("filter((v) => v !== '全部' && !v.includes('季度'))"), '季度波段不进波段选项');
  const specials = code.match(/const WAVE_SPECIAL_ORDER = \[(.*?)\];/s);
  assert.ok(specials, '占位值有固定顺序');
  const order = specials[1].split(',').map((s) => s.trim().replace(/'/g, ''));
  assert.deepEqual(order, ['专属款', '其他', '未采购', '未上架'], '占位值顺序：专属款 → 其他 → 未采购 → 未上架');
  assert.ok(code.includes('return an !== bn ? an - bn : at.localeCompare(bt);'), '数字月份主排序，字母次排序');
});

test('BI 维度值里若带「全部」占位要去重，避免重复渲染', () => {
  const filters = code.match(/const catList = .*;\n.*const bandList = .*;/s);
  assert.ok(filters, '找到维度列表定义');
  assert.equal((filters[0].match(/v !== '全部'/g) || []).length, 3, '品类/波段/价格带都要过滤占位');
});

test('筛选面板顶部写明 季节 / 价格带 / 指标阈值 的口径', () => {
  assert.ok(code.includes('季节：取款级「季节(到款式)」'), '季节口径');
  assert.ok(code.includes('组合值（如「秋冬」）选「秋」也算命中'), '季节组合值说明与筛选实现一致');
  assert.ok(code.includes('价格带：基于各品类相对价格调整，非固定价格划分'), '价格带口径');
  assert.ok(code.includes('签收率 = 1 − 总退货率（含发货前+发货后）'), '签收率口径');
  assert.ok(code.includes('Σ退货数量/Σ销售数量'), '退货率数量口径');
  assert.ok(code.includes('没有退货数据的款不算达标'), '无数据不算签收达标');
});
