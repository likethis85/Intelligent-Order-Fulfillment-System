// 货盘列表回归：最新的直播日期排最上面，且列表分页显示。
//
// 排序只在渲染时做（sortedTrays 是 trays 的副本），不能原地 sort：
// trays 是 App 的 state，原地排会触发云端保存、打乱数据顺序。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.resolve(__dirname, '../src/sections/TraysPage.tsx'), 'utf8');

test('货盘列表：按直播日期倒序，同一天按创建时间倒序', () => {
  assert.ok(code.includes('() => [...trays].sort((a, b) => {'), '排序必须基于 trays 的副本');
  assert.ok(
    code.includes("const byDate = String(b.date || '').localeCompare(String(a.date || ''));"),
    'date 是 YYYY-MM-DD，按字符串倒序即最新场次在最上面',
  );
  assert.ok(
    code.includes("return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));"),
    '同一天的多场要有稳定的次级排序',
  );
});

test('货盘列表：渲染分页后的切片，而不是全部', () => {
  assert.ok(code.includes('{pageTrays.map((t) => {'), '列表必须渲染当前页的货盘');
  assert.ok(!code.includes('{sortedTrays.map((t) => {'), '不要再整表渲染');
  assert.ok(
    /const pageTrays = useMemo\(\s*\(\) => sortedTrays\.slice\(traySafePage \* trayPageSize, \(traySafePage \+ 1\) \* trayPageSize\)/.test(code),
    '切片口径：safePage * pageSize 起，取一页',
  );
  assert.ok(
    code.includes('const traySafePage = Math.min(trayPage, trayPageCount - 1);'),
    '删除货盘导致页数变少时要兜住页码，不能停在空白页',
  );
  assert.ok(code.includes('TRAY_PAGE_SIZES') && code.includes('共 {sortedTrays.length} 个货盘'), '分页条要显示总数和每页数量');
  assert.ok(code.includes('onClick={() => goTrayPage(traySafePage - 1)}') && code.includes('onClick={() => goTrayPage(traySafePage + 1)}'));
});

test('货盘列表分页：手机端用两行布局，控件不再被 44px 撑大', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../src/index.css'), 'utf8');

  assert.ok(code.includes('className="tray-pagination mt-6'), '分页条要挂 tray-pagination 类');
  assert.ok(code.includes('className="tray-pagination-meta'), '统计/每页数量要挂 tray-pagination-meta 类');
  assert.ok(code.includes('className="tray-page-size '), '每页下拉要挂 tray-page-size 类');
  assert.ok(code.includes('className="tray-pager flex'), '翻页按钮组要挂 tray-pager 类');
  assert.ok(code.includes('tray-pager-step') && code.includes('tray-pager-num'), '上一页/下一页与页码要分别有类名');

  // 规则必须写在手机断点里：统计在上、按钮在下
  assert.match(
    css,
    /@media screen and \(max-width: 767px\)[\s\S]*?\.tray-pagination \{[\s\S]*?flex-direction: column;/,
    '.tray-pagination 在手机上要竖排',
  );
  assert.match(css, /\.tray-pagination \.tray-page-size \{[\s\S]*?min-height: 34px;/, '每页下拉在手机上要收小');
  assert.match(css, /\.tray-pager > button \{[\s\S]*?min-height: 38px;/, '翻页按钮高度收小');
  assert.match(css, /\.tray-pager > \.tray-pager-step \{[\s\S]*?flex: 1 1 auto;/, '上一页/下一页撑满剩余宽度');
});
