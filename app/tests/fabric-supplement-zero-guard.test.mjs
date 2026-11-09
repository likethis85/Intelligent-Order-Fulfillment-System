// 补充信息（工厂现货 / 可订货 / 订货周期）不能被「本地没数据」这件事清成 0。
//
// 之前的链路：查询后先从服务器恢复补充信息 → 只写进 localStorage → 配额写满时
// saveFabricData 失败并清空内存缓存 → 紧接着的自动保存把整批结果按「空即 0」提交，
// 服务端 upsert 无条件覆盖，库里原有的现货/可订货/周期就变成 0，并联动到同面料的其他行。
// 现在三层一起挡：内存缓存兜住、恢复失败就不保存、不知道的字段服务端保留原值。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
const html = read('server/fabric-public/index.html');
const fabricRoute = read('server/routes/fabric.js');

const sliceFn = (src, header, len) => {
  const at = src.indexOf(header);
  assert.ok(at > 0, `找不到 ${header}`);
  return src.slice(at, at + len);
};

test('本地写不下时保留内存缓存，恢复出来的值不会当场丢', () => {
  const fn = sliceFn(html, 'function saveFabricData(data, keepKeys)', 1600);
  assert.ok(fn.includes('savedDataCache = data;'), '写失败要把这份数据留在内存里，否则下一次读取全是空');
  assert.ok(!fn.includes('savedDataCache = null;'), '写失败不能清空缓存');
  assert.ok(fn.includes('return false;'), '仍然明确告诉调用方没存下');
});

test('恢复失败就不自动保存：本地是空的，整批提交等于把服务器清成 0', () => {
  const fn = sliceFn(html, 'async function syncSupplementsFromServer()', 3400);
  assert.ok(fn.includes('return false;'), '接口失败/数据无效要返回 false');
  assert.ok(fn.includes('return true;'), '成功返回 true');
  const flow = sliceFn(html, 'const restored = await syncSupplementsFromServer();', 900);
  assert.ok(flow.includes('if (restored) autoSaveToSupabase();'), '只有恢复成功才自动保存');
  assert.ok(
    flow.includes("console.warn('[面料查询] 服务器补充信息没恢复成功，本次跳过自动保存"),
    '跳过时要留下可排查的日志',
  );
});

test('「不知道」的行不提交这三个字段（留 undefined，服务端保留原值）', () => {
  const fn = sliceFn(html, 'function buildItemsToSave(validItems)', 4200);
  assert.ok(fn.includes('const known = Boolean(item._extraKnown);'), '按行判断补充信息是否已知');
  for (const field of ['factorySpotQty', 'orderableQty', 'leadTimeDays']) {
    assert.ok(
      fn.includes(`${field}: known ? (Number(extra.${field}) || 0) : undefined,`),
      `${field} 不知道时要留 undefined，不能写 0`,
    );
  }
});

test('「已知」的判定：本地/服务器有值、用户手动改过、用户主动清零', () => {
  // 不能只看「这一行有没有数据」：seedAutoPurchasing 会给有采购数据的行建一条只带在途/交期的记录，
  // 那种行对工厂现货/可订货/订货周期仍然是一无所知，照样不能提交 0
  assert.ok(html.includes('item._extraKnown = Boolean('), '渲染时按三个字段是否真的存在判断');
  assert.ok(html.includes('rawExtra.factorySpotQty !== undefined ||'), '工厂现货存在才算已知');
  assert.ok(html.includes('rawExtra.leadTimeDays !== undefined'), '订货周期存在才算已知');
  const handle = sliceFn(html, 'function handleExtraChange(key, field, value)', 900);
  assert.ok(handle.includes('item._extraKnown = true;'), '用户手动填过就是已知');
  const propagate = sliceFn(html, 'function propagateSharedFabricExtra(origin, field, value)', 900);
  assert.ok(propagate.includes('other._extraKnown = true;'), '联动到兄弟行也算已知');
  // 重置补充信息是用户明确要清零：必须照常写成 0，不能被「未知跳过」挡掉
  const reset = sliceFn(html, 'function resetSupplementaryData()', 1200);
  assert.ok(reset.includes('item._extraKnown = true;'), '主动清零要标成已知，否则清不掉');
});

test('服务端：客户端没带这几个字段时保留库里原值', () => {
  const fn = sliceFn(fabricRoute, 'if (item.factorySpotQty === undefined) delete record.factory_spot_qty;', 400);
  assert.ok(fn.includes('delete record.orderable_qty;'), '可订货量同样保留');
  assert.ok(fn.includes('delete record.lead_time_days;'), '订货周期同样保留');
  // 显式传 0 仍然能清零
  assert.ok(fabricRoute.includes('orderable_qty: item.orderableQty || 0,'), '显式传 0 仍然写入 0');
});
