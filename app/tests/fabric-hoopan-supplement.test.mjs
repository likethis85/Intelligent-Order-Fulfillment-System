// 货盘「查询面料」→「确认并同步面料信息到货盘」：
// 只要填了 工厂现货 / 可订货 / 订货周期，即使库存为 0，面料情况也必须出现这条记录。
//
// 线上症状：H74450 库存 0、工厂现货 316、可订货 1、订货周期 25，
// 同步后货盘面料情况里完全没有这行——旧逻辑只把「有库存」的面料放进 popup 文案，
// 库里为 0 的面料只有整款都没库存时才靠 pickMainFabric 兜底挑一条。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.resolve(__dirname, '../server/fabric-public/index.html'), 'utf8');

test('生成货盘文案：填了补充信息的零库存行也要入选', () => {
  assert.ok(html.includes('const hasSupplementFill = (it) =>'), '要有补充信息判定');
  assert.ok(html.includes('(Number(ex.factorySpotQty) || 0) > 0'), '工厂现货');
  assert.ok(html.includes('(Number(ex.orderableQty) || 0) > 0'), '可订货');
  assert.ok(html.includes('(Number(ex.leadTimeDays) || 0) > 0'), '订货周期');
  assert.ok(html.includes('return (it.stock || 0) > 0 || filled;'), '库存 > 0 或填了补充信息都入选');
  assert.ok(html.includes('if (isLining) return filled;'), '里布只在填了补充信息时出现');
  assert.ok(html.includes('const displayItems = items.filter('), '入选逻辑集中在一个地方');
});

test('生成货盘文案：同仓库多行按 库存+工厂现货+可订货 取最大，别把补充行挤掉', () => {
  assert.ok(html.includes('const groupScore = (it) =>'), '要按综合米数挑代表行');
  assert.ok(
    html.includes('(Number(it.stock) || 0) + (Number(ex.factorySpotQty) || 0) + (Number(ex.orderableQty) || 0)'),
    '评分要含库存、工厂现货、可订货',
  );
  assert.ok(html.includes('groupScore(it) > groupScore(warehouseGroups[wh])'), '分组时用综合评分比较');
});

test('生成货盘文案：零库存只填可订货时写成「XX现货X米 可订货Y米Z天」', () => {
  assert.ok(
    html.includes("line += ` 可订货${Math.round(orderableQty)}米${leadTimeDays > 0 ? leadTimeDays + '天' : ''}`;"),
    '可订货文案要带「可订货」字样和订货周期',
  );
});
