import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, toCsvRow } from '../server/dingtalk-plan-sync.js';

test('RFC 4180 CSV parser parses multiline and quoted fields correctly', () => {
  const sample = [
    '款号,skc,计划翻单量,生成的文字信息（完整的）',
    'ME15FW022,ME15FW02216,192,"格纹 192件35天\n第二行文案\n第三行文案"',
    'ME14FW016,ME14FW01602,210,"单行文案, 带逗号"',
    'ME12FF022,ME12FF02202,110,"带""引号""的内容"'
  ].join('\n');

  const parsed = parseCsv(sample);
  assert.equal(parsed.length, 4);
  assert.equal(parsed[0][0], '款号');
  assert.equal(parsed[1][0], 'ME15FW022');
  assert.equal(parsed[1][3], '格纹 192件35天\n第二行文案\n第三行文案');
  assert.equal(parsed[2][3], '单行文案, 带逗号');
  assert.equal(parsed[3][3], '带"引号"的内容');
});

test('RFC 4180 toCsvRow escapes commas, quotes, and newlines correctly', () => {
  const cells = [
    'ME15FW022',
    'ME15FW02216',
    192,
    '格纹 192件35天\n第二行',
    '带"引号"',
    '普通文本'
  ];
  const row = toCsvRow(cells);
  assert.equal(row, 'ME15FW022,ME15FW02216,192,"格纹 192件35天\n第二行","带""引号""",普通文本');

  // Verify roundtrip
  const parsed = parseCsv(row);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], [
    'ME15FW022',
    'ME15FW02216',
    '192',
    '格纹 192件35天\n第二行',
    '带"引号"',
    '普通文本'
  ]);
});

test('empty rows with commas or whitespace are identified and filtered', () => {
  const sample = [
    '款号,skc,计划翻单量',
    'ME15FW022,ME15FW02216,192',
    ',,',
    '   ,   ,   ',
    'ME14FW016,ME14FW01602,210',
    ',,'
  ].join('\n');

  const parsed = parseCsv(sample);
  const dataRows = parsed.slice(1);
  const filtered = dataRows.filter((row) => {
    const rowPdt = String(row[0] || '').trim().toUpperCase();
    const rowSkc = String(row[1] || '').trim().toUpperCase();
    if (!rowPdt && !rowSkc) return false;
    if (row.every((c) => !c || !String(c).trim())) return false;
    return true;
  });

  assert.equal(filtered.length, 2);
  assert.equal(filtered[0][0], 'ME15FW022');
  assert.equal(filtered[1][0], 'ME14FW016');
});

