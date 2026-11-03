// 样衣面料查询回归：样衣款没有大货标准 BOM，走 GetSampleDevMaterialBomList。
// 线上症状：ME27FW005 的面料 8827/20 在面料查询里显示库存 0，
// 但领猫面料仓实际有 398.3 米。原因是样衣 BOM 分支把 stock 写死成 0，从没查库存接口。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.resolve(__dirname, '../server/fabric-client.js'), 'utf8');

const sampleFnStart = src.indexOf('async function getSampleDevMaterials');
const sampleFnEnd = src.indexOf('async function getFabricMaterials');
const sampleFn = src.slice(sampleFnStart, sampleFnEnd);

test('样衣 BOM 分支要查真实面料库存，不能写死 0', () => {
  assert.ok(sampleFnStart > 0 && sampleFnEnd > sampleFnStart, '样衣 BOM 函数应存在');
  assert.ok(sampleFn.includes('getFabricStock(stockQueryCodes)'), '样衣 BOM 必须按物料规格码查库存');
  assert.ok(sampleFn.includes('stocksWithQty'), '有库存的仓库要各出一行（与标准 BOM 路径一致）');
  assert.ok(sampleFn.includes('matchedStocks'), '库存要按 materialSubCode 匹配');
  // 只查面料/纱线，不要拿吊牌、纽扣等辅料去查库存
  assert.ok(sampleFn.includes('isFabricMaterial(mtTypeMap.get(code)'), '库存查询范围应限定面料/纱线');
});

test('标准 BOM 的库存口径保持原样', () => {
  assert.ok(src.includes('getFabricStock(mtCodes)'), '大货款仍按标准 BOM 物料码批量查库存');
});
