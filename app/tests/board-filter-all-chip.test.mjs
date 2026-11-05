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
  for (const dim of ['品类', '波段', '上新年份', '价格带', '适穿温度带', '商品角色', '场景规则']) {
    assert.ok(code.includes(`<Dim label="${dim}">`), `${dim} 维度存在`);
  }
  const uses = code.match(/<DimChips/g) || [];
  assert.ok(uses.length >= 6, '品类/波段/价格带/温度带/角色/场景都要用 DimChips');
});

test('点具体项时从「全部」切过去，多选仍可叠加', () => {
  assert.ok(
    code.includes('onChange(selected.includes(o) ? selected.filter((x) => x !== o) : [...selected, o])'),
    '已选则取消，未选则追加（「全部」状态下追加即替换）',
  );
});

test('默认筛选全部为空，等于每个维度都选中「全部」', () => {
  assert.ok(code.includes('const [f, setF] = useState<Filters>({ ...DEFAULT_FILTERS });'), '初始值不能预设品类/场景');
  assert.ok(code.includes('cats: [], waves: [], bands: [], temps: [], roles: [], years: []'), 'DEFAULT_FILTERS 的数组维度都为空');
});

test('BI 维度值里若带「全部」占位要去重，避免重复渲染', () => {
  const filters = code.match(/const catList = .*;\n.*const bandList = .*;/s);
  assert.ok(filters, '找到维度列表定义');
  assert.equal((filters[0].match(/v !== '全部'/g) || []).length, 4, '品类/波段/温度带/价格带都要过滤占位');
});
