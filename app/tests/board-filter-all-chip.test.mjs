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
  for (const dim of ['品类', '波段', '上新年份', '价格带', '季节', '商品角色']) {
    assert.ok(code.includes(`<Dim label="${dim}">`), `${dim} 维度存在`);
  }
  const uses = code.match(/<DimChips/g) || [];
  assert.ok(uses.length >= 5, '品类/上新年份/波段/价格带/角色都要用 DimChips');
});

test('点具体项时从「全部」切过去，多选仍可叠加', () => {
  assert.ok(
    code.includes('onChange(selected.includes(o) ? selected.filter((x) => x !== o) : [...selected, o])'),
    '已选则取消，未选则追加（「全部」状态下追加即替换）',
  );
});

test('默认筛选全部为空，等于每个维度都选中「全部」', () => {
  assert.ok(code.includes('const [f, setF] = useState<Filters>({ ...DEFAULT_FILTERS });'), '初始值不能预设品类');
  assert.ok(code.includes('cats: [], waves: [], bands: [], seasons: [], roles: [], years: []'), 'DEFAULT_FILTERS 的数组维度都为空');
});

test('维度顺序：商品角色 → 上新年份 → 波段 → 品类 → 季节 → 价格带', () => {
  const at = (label) => code.indexOf(`<Dim label="${label}">`);
  const seq = ['商品角色', '上新年份', '波段', '品类', '季节', '价格带'].map(at);
  assert.ok(seq.every((i) => i > 0), '六个维度都存在');
  for (let i = 1; i < seq.length; i++) assert.ok(seq[i] > seq[i - 1], '顺序不能变');
});

test('季节筛选按「季节(到款式)」匹配，组合值（秋冬）也能被秋/冬命中', () => {
  assert.ok(code.includes("f.seasons.some((s) => String(p.season || '').includes(s))"), '按季节值包含匹配');
  assert.ok(code.includes("const seasonList = (() =>"), '季节选项从商品数据里取');
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
