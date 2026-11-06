// 面料查询的「物料规格名称 / 物料颜色」回归：
// 线上 ME14DW013 / ME14FF036 两列整片是 "-"，查下来是物料基础信息（Getmaterials）
// 那一次没返回数据，而失败是静默的 —— 空结果还被当正常结果缓存 4 小时，缓存期内怎么点都出不来。
// 现在：① 失败打日志；② 查不到就用 BOM 行自带的色号/颜色兜底；③ 这种结果的缓存只留 2 分钟。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverCode = fs.readFileSync(path.resolve(__dirname, '../server/fabric-client.js'), 'utf8');

const TMP_CACHE = path.join(os.tmpdir(), `fabric-cache-test-${process.pid}.json`);
// 预置一条「升级前写下的失败结果」：整片没有规格/颜色，也没有 verified 标记
fs.writeFileSync(TMP_CACHE, JSON.stringify({
  ME14FF036: {
    time: Date.now(),
    data: [{ pdtCode: 'ME14FF036', mtCode: '6461/W20', mtSpecName: '-', colorName: '-', supplierName: '缇素' }],
  },
}));

process.env.FABRIC_CACHE_FILE = TMP_CACHE;
process.env.VSCM_APP_ID = 'test-app';
process.env.VSCM_APP_SECRET = 'test-secret';

const BOM_ROW = {
  pdtCode: 'ME14DW013',
  skuCode: 'ME14DW013091',
  skuCorlorName: '烟草绿',
  mtCode: '6461/W20',
  mtName: '6461/W20',
  mtType: '面料',
  mtSubCode: '6461/W201937',
  colorCode: '1937',
  colorName: '烟草绿',
  useAmt: 2.7,
  mtPrice: 675,
  supplierName: '缇素',
};

let baseInfoFails = true;
const calls = { standardBom: 0, getmaterials: 0 };

globalThis.fetch = async (url, init) => {
  const target = String(url);
  const body = init?.body ? JSON.parse(init.body) : {};
  if (target.endsWith('/auth/token')) {
    return json({ isSuccess: true, data: { access_token: 'tok', expires_in: 7200 } });
  }
  if (target.endsWith('/v1/product/standardbom/getmaterials')) {
    calls.standardBom += 1;
    const code = String(body.pdtCodes || '');
    const row = code === 'ME14FF036' ? { ...BOM_ROW, pdtCode: 'ME14FF036', skuCode: 'ME14FF036091' } : BOM_ROW;
    return json({ code: 200, data: { datas: code === 'ME14DW013' || code === 'ME14FF036' ? [row] : [] } });
  }
  if (target.endsWith('/v1/material/getstores')) {
    return json({ code: 200, data: { datas: [{ mtSpecCode: '6461/W201937', warehouseCode: 'M01', warehouseName: '面料仓', realQty: 177.5 }] } });
  }
  if (target.endsWith('/v1/mtpurchase/getbills')) {
    return json({ code: 200, data: { datas: [] } });
  }
  if (target.endsWith('/v1/BaseInfo/Getmaterials')) {
    calls.getmaterials += 1;
    if (baseInfoFails) return json({ code: 500, msg: '系统繁忙，请稍后再试' });
    const mtCodes = String(body.codes || '').split(',');
    return json({
      code: 200,
      data: {
        datas: mtCodes.map((code) => ({
          mtCode: code,
          mtName: code,
          price: 675,
          mtCtg: '面料',
          subs: [{ mtSubCode: '6461/W201937', colorCode: '1937', colorName: '烟草绿', spColorName: '308#' }],
        })),
      },
    });
  }
  if (target.endsWith('/v1/Research/GetSampleDevMaterialBomList')) {
    return json({ code: 200, data: { datas: [] } });
  }
  throw new Error('未预期的上游请求: ' + target);
};

function json(value) {
  return { ok: true, status: 200, json: async () => value };
}

const { queryFabricInfo } = await import('../server/fabric-client.js');

const realNow = Date.now;

test('旧缓存里「整片没有规格/颜色」的失败结果会被丢弃并重查', async () => {
  // 这条是预置在缓存文件里的升级前结果（不是本次查出来的）
  const before = calls.standardBom;
  const rows = await queryFabricInfo('ME14FF036');
  assert.ok(calls.standardBom > before, '不能直接吃旧缓存，要重新查一次');
  assert.equal(rows[0].colorName, '烟草绿', '重查后颜色来自 BOM');
  assert.notEqual(rows[0].mtSpecName, '-');
});

test('Getmaterials 失败时，规格和颜色退回 BOM 行自带的色号/颜色名', async () => {
  const rows = await queryFabricInfo('ME14DW013', true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].colorName, '烟草绿', '物料颜色不能是 "-"');
  assert.equal(rows[0].mtSpecName, '[1937]烟草绿;', '规格名退回 BOM 色号');
  assert.equal(rows[0].supplierName, '缇素');
});

test('失败结果只缓存 2 分钟：过期后会重新查，不再锁 4 小时', async () => {
  const before = calls.standardBom;
  await queryFabricInfo('ME14DW013'); // 2 分钟内：命中缓存
  assert.equal(calls.standardBom, before, '短 TTL 内仍然命中缓存');

  Date.now = () => realNow() + 3 * 60 * 1000; // 拨快 3 分钟
  try {
    baseInfoFails = false;
    const rows = await queryFabricInfo('ME14DW013');
    assert.ok(calls.standardBom > before, '过了重试窗口要重新查上游');
    assert.equal(rows[0].mtSpecName, '[1937]烟草绿-308#;', '重查成功后规格名补齐');
    assert.equal(rows[0].colorName, '烟草绿');
  } finally {
    Date.now = realNow;
  }
});

test('查到物料基础信息后按 4 小时长缓存', async () => {
  const before = calls.standardBom;
  Date.now = () => realNow() + 3 * 3600 * 1000; // 3 小时后，长缓存还没过期
  try {
    await queryFabricInfo('ME14DW013');
    assert.equal(calls.standardBom, before, '正常结果 3 小时内不重查');
  } finally {
    Date.now = realNow;
  }
});

test('源码：失败要打日志、短缓存常量存在、缓存文件可指向临时目录', () => {
  assert.ok(serverCode.includes('FABRIC_CACHE_RETRY_MS = 2 * 60 * 1000'), '失败结果的重试窗口');
  assert.ok(serverCode.includes('cacheItemFresh'), '缓存新鲜度按条目自己的 ttl 判断');
  assert.ok(serverCode.includes('面料基础信息返回 code='), '上游失败要留痕，不能静默');
  assert.ok(serverCode.includes('process.env.FABRIC_CACHE_FILE'), '测试不能写线上缓存文件');
});

test.after(() => {
  Date.now = realNow;
  fs.rmSync(TMP_CACHE, { force: true });
});
