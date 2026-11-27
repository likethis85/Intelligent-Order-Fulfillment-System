// 共用面料的「可分摊米数 M」在电脑版和手机版必须是同一个口径：
// M = 在仓 + 在途 + 可订货 + 工厂现货（按仓库去重取最大再相加）。
// 手机版曾经漏掉工厂现货，同一个款在电脑和手机上分摊件数会不一样。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.resolve(__dirname, '../server/fabric-public', f), 'utf8');

const FORMULA =
  /\(Number\(f\.stock\) \|\| 0\) \+ \(Number\(f\.in_transit_qty\) \|\| 0\) \+ \(Number\(f\.orderable_qty\) \|\| 0\) \+ \(Number\(f\.factory_spot_qty\) \|\| 0\)/;

test('电脑版：共用面料 M 含工厂现货', () => {
  assert.ok(FORMULA.test(read('sales.html')), 'sales.html 的 M 必须是四项相加');
});

test('手机版：共用面料 M 与电脑版一致，含工厂现货', () => {
  assert.ok(FORMULA.test(read('sales-mobile.html')), 'sales-mobile.html 的 M 也要四项相加，别漏工厂现货');
});
