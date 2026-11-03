// 翻单文案「注脚」回归：每行末尾的「最大单量140件」这类说明文字，用户要能改、能清空、能自己加。
//
// 注脚按 SKC 覆盖：undefined = 用自动注脚，'' = 这一行不要注脚，其它 = 用户写的文字。
// sales.html 是纯静态页，这里用静态断言锁住生成口径与编辑入口。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, '..', 'server', 'fabric-public', 'sales.html'), 'utf8');

test('注脚：生成文案时优先用用户覆盖值，其次才是自动的「最大单量X件」', () => {
  assert.ok(
    html.includes('getFootnoteOverride(cardSkc)'),
    '生成文案必须查用户的注脚覆盖（用卡片上截短后的 SKC 查）',
  );
  assert.ok(
    html.includes("const footnote = footnoteOv === undefined ? autoFootnote : footnoteOv.trim();"),
    "覆盖值为 '' 时必须真的不输出注脚（不能回落成自动）",
  );
  // 自动注脚仍然只有共用面料才有
  assert.ok(html.includes("const autoFootnote = maxNum > 0 ? `最大单量${maxNum}件` : '';"));
  // 文案仍按原始 sku_code 分组：钉钉同步靠它匹配行，不能被截断
  assert.ok(
    html.includes('const skc = fabric.sku_code || fabric.skuCode || fabric.mt_code || \'\';'),
    'perSkcText 的 key 必须保持原始 sku_code，否则钉钉 J 列取不到单行文案',
  );
});

test('注脚：卡片上有编辑入口和「恢复自动」', () => {
  assert.ok(html.includes('oninput="updatePlanFootnote(this)"'), '卡片上必须有注脚输入框');
  assert.ok(html.includes('onclick="resetPlanFootnote('), '必须有恢复自动注脚的按钮');
  assert.ok(html.includes('function updatePlanFootnote(el)') && html.includes('function resetPlanFootnote(skc)'));
});

test('注脚：自动值放进 value，才能被选中删掉', () => {
  // 放 placeholder 里的灰字选不中也删不掉，等于自动注脚永远去不掉
  assert.ok(
    html.includes('const fnValue = fnOverride === undefined ? fnAuto : fnOverride;'),
    '自动注脚必须作为输入框的 value 呈现',
  );
  assert.ok(html.includes('value="${escapeAttr(fnValue)}"'), '输入框 value 用 fnValue');
  assert.ok(!/placeholder="\$\{escapeAttr\(fnAuto/.test(html), '不要再把自动注脚塞进 placeholder');
  // 清空后要能看出「已删除」，并且还能一键恢复自动
  assert.ok(html.includes('（已删除注脚 — 点「恢复自动」还原）'));
});

test('注脚：按 SKC 记忆，改完会刷新文本框', () => {
  assert.ok(html.includes("localStorage.getItem('fabricPlanFootnotes')"), '注脚要能跨刷新记住');
  assert.ok(
    /function updatePlanFootnote\(el\) \{[\s\S]*?scheduleTextRefresh\(\);[\s\S]*?\}/.test(html),
    '改注脚要刷新文本框，否则用户看不到效果',
  );
  // 手动改过 textarea 时不能覆盖用户修改（跟批次输入同一套行为）
  assert.ok(/function scheduleTextRefresh\(\) \{\s*if \(_manualEdited\) return;/.test(html));
});
