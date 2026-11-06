// 货盘颜色行「按色号勾选」回归：
// 以前颜色行只能整段手输（"黑色 / 金扣黑带身" 一坨，分不清哪个是哪个），
// 现在点开弹窗按款号列出每个色号逐条勾选，勾完拼回同一段文案。
// 存储格式没变（colorOverrideByLook[lookId] = "A / B"），所以导表和协同合并不用动。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const {
  splitColorText, joinColorText, defaultColorText, buildColorOptions, colorOverrideValue,
} = await import('../src/lib/trayColors.ts');

const pageCode = fs.readFileSync(path.resolve(__dirname, '../src/sections/TraysPage.tsx'), 'utf8');

const product = (id, colors, sample = []) => ({ id, colors, sampleColors: sample });

test('splitColorText：按 " / " 拆开、去空去重，全角斜杠也认', () => {
  assert.deepEqual(splitColorText('黑色 / 金扣黑带身'), ['黑色', '金扣黑带身']);
  assert.deepEqual(splitColorText('黑色／咖色/驼色'), ['黑色', '咖色', '驼色']);
  assert.deepEqual(splitColorText(' 黑色 / 黑色 /  '), ['黑色']);
  assert.deepEqual(splitColorText(''), []);
  assert.deepEqual(splitColorText(undefined), []);
});

test('joinColorText：拼回 " / "，空值不占位，重复只留一个', () => {
  assert.equal(joinColorText(['黑色', '金扣黑带身']), '黑色 / 金扣黑带身');
  assert.equal(joinColorText([' 黑色 ', '', '黑色']), '黑色');
  assert.equal(joinColorText([]), '');
});

test('defaultColorText：款号在库颜色去重后在前，样衣色追加在后', () => {
  const ps = [product('me01', ['黑色', '咖色']), product('me02', ['咖色', '驼色'])];
  assert.equal(defaultColorText(ps, { me01: ['驼色', '金扣黑带身'] }), '黑色 / 咖色 / 驼色 / 金扣黑带身');
  assert.equal(defaultColorText(ps), '黑色 / 咖色 / 驼色');
});

test('buildColorOptions：按款号分组，色号（SKC）带编码，同款号内按颜色去重', () => {
  const options = buildColorOptions({
    pids: ['me01', 'me02'],
    colorsByPid: { me01: ['黑色', '咖色'], me02: ['咖色'] },
    sampleColorsByPid: { me01: ['驼色'] },
    skcsByPid: { me01: [{ code: 'ME01091', color: '黑色' }] },
  });
  assert.deepEqual(options.map((o) => `${o.pid}:${o.color}:${o.code || ''}`), [
    'me01:黑色:ME01091', // 色号优先，且不再重复一条无编码的「黑色」
    'me01:咖色:',
    'me01:驼色:',
    'me02:咖色:',
  ]);
  assert.equal(options[2].sample, true, '样衣色要打标');
  assert.equal(options[3].sample, undefined);
});

test('buildColorOptions：空颜色、没有数据的款号不会造出空行', () => {
  const options = buildColorOptions({
    pids: ['me01', 'me02'],
    colorsByPid: { me01: ['', '  '] },
    skcsByPid: { me02: [{ code: 'X', color: '' }] },
  });
  assert.deepEqual(options, []);
});

test('colorOverrideValue：勾选结果与自动拼接一致时存空（等于不覆盖）', () => {
  const defaultText = '黑色 / 咖色';
  assert.equal(colorOverrideValue(['黑色', '咖色'], defaultText), '', '跟默认一样就不写 override');
  assert.equal(colorOverrideValue(['咖色', '黑色'], defaultText), '咖色 / 黑色', '顺序变了要保留');
  assert.equal(colorOverrideValue(['黑色'], defaultText), '黑色', '只留一个颜色');
  assert.equal(colorOverrideValue([], defaultText), '', '全部取消 = 回到默认');
});

test('页面接线：点颜色打开弹窗，弹窗保存写回 colorOverrideByLook', () => {
  assert.ok(pageCode.includes("from '@/lib/trayColors'"), '颜色逻辑走独立模块');
  assert.ok(pageCode.includes('onOpenColorTextPicker'), '颜色行要能唤起弹窗');
  assert.ok(pageCode.includes('<LookColorDialog'), '弹窗挂载');
  assert.ok(pageCode.includes('defaultColorText(ps, ctx.sampleColorsByPid)'), '展示的自动拼接与弹窗用同一套逻辑');
  assert.ok(
    pageCode.includes('onOpenPicker={ctx.onOpenColorTextPicker}'),
    'ColorLineEditor 点击走弹窗',
  );
  assert.ok(
    pageCode.includes('if (onOpenPicker) onOpenPicker(); else setEditing(true);'),
    '没接弹窗的场景仍保留原来的内联编辑',
  );
  assert.ok(
    pageCode.includes('const setColorOverride = (') && pageCode.includes('fgColors: Record<string, string> = {},'),
    '弹窗保存复用同一个写入函数（文案 + 色号 + 字色一起写）',
  );
});

test('手动添加颜色时可以填色号，色号跟文案一起存、一起同步', async () => {
  const productsCode = fs.readFileSync(path.resolve(__dirname, '../src/data/products.ts'), 'utf8');
  const mergeCode = fs.readFileSync(path.resolve(__dirname, '../src/lib/trayMerge.ts'), 'utf8');
  const serverMerge = fs.readFileSync(path.resolve(__dirname, '../server/trays-field-merge.js'), 'utf8');
  const idsCode = fs.readFileSync(path.resolve(__dirname, '../src/lib/trayIds.ts'), 'utf8');

  assert.ok(productsCode.includes('colorCodesByLook?: Record<string, Record<string, string>>;'), '货盘上有存色号的字段');
  assert.ok(mergeCode.includes("'colorCodesByLook'"), '协同合并按坑位同步色号');
  assert.ok(serverMerge.includes("'colorCodesByLook'"), '服务端字段级合并口径要跟客户端一致');
  assert.ok(idsCode.includes("'colorCodesByLook'"), '坑位 id 修复改名时色号要跟着搬');

  // 弹窗里色号优先用 SKC 的，没有就用手动填的
  assert.ok(pageCode.includes('const codeOf = (color: string, skc?: string) => skc || codes[color] || \'\';'));
  // 手动添加：色号输入框 + 颜色输入框
  assert.ok(pageCode.includes('placeholder="色号"'));
  assert.ok(pageCode.includes('const [customCode, setCustomCode] = useState(\'\');'));
  // 保存时只留仍被选中的颜色对应的色号
  assert.ok(pageCode.includes('if (code) keptCodes[color] = code;'));
});
