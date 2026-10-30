// 聚水潭查询接口的 i_ids 硬上限是 20 个/次（超了报 code=170 / code=130，整批失败）。
// 这里用假 fetch 验证：不论调用方传进来多少款号，实际请求都必须切到 ≤20 个一批。
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.JUSHUITAN_APP_KEY = 'test_key';
process.env.JUSHUITAN_APP_SECRET = 'test_secret';

const { chunkPidsByMax, getInventoryByPids, getItemsByPids, JST_MAX_IDS } =
  await import('../server/jushuitan-client.js');

function jsonResponse(payload) {
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
}

function installFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, body: init.body });
    if (u.includes('/openWeb/auth/getInitToken')) {
      return jsonResponse({ code: 0, data: { access_token: 'stub_token', expires_in: 3600 } });
    }
    const params = new URLSearchParams(String(init.body || ''));
    const biz = JSON.parse(params.get('biz') || '{}');
    return handler(u, biz, calls);
  };
  return {
    calls,
    restore: () => { globalThis.fetch = original; },
  };
}

const bizOf = (call) => JSON.parse(new URLSearchParams(String(call.body)).get('biz') || '{}');

const makePids = (n, prefix = 'P') =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i + 1).padStart(3, '0')}`);

test('chunkPidsByMax: 按 20 个一批切开，并去重去空', () => {
  assert.equal(JST_MAX_IDS, 20);

  const pids = makePids(45);
  const chunks = chunkPidsByMax(pids);
  assert.deepEqual(chunks.map((c) => c.length), [20, 20, 5]);
  assert.ok(chunks.every((c) => c.length <= JST_MAX_IDS));

  // 重复、空白、首尾空格都要先清洗，否则接口会因为「id 重复」整批报错
  const messy = [' A ', 'a', '', '  ', 'B', 'A'];
  assert.deepEqual(chunkPidsByMax(messy), [['A', 'a', 'B']]);

  assert.deepEqual(chunkPidsByMax([]), []);
});

test('getInventoryByPids: 45 个款号拆成 3 次请求，每次 i_ids ≤ 20', async (t) => {
  const stub = installFetch((url, biz) => {
    const ids = String(biz.i_ids || '').split(',').filter(Boolean);
    return jsonResponse({
      code: 0,
      data: {
        inventorys: ids.map((pid) => ({
          i_id: pid, sku_id: `S-${pid}`, name: pid, qty: 1,
          order_lock: 0, pick_lock: 0, purchase_qty: 0, allocate_qty: 0, defective_qty: 0,
        })),
      },
    });
  });
  t.after(() => stub.restore());

  // 款号用全小写（和线上一致），这样 byPid 不会同时出现大小写两份键
  const pids = makePids(45, 'p');
  const { byPid } = await getInventoryByPids(pids);

  const invCalls = stub.calls.filter((c) => c.url.includes('/open/inventory/query'));
  assert.equal(invCalls.length, 3);
  for (const call of invCalls) {
    assert.ok(String(bizOf(call).i_ids).split(',').length <= JST_MAX_IDS);
  }
  // 三批全部合并：任何一款都不能因为超限而丢库存
  assert.equal(Object.keys(byPid).length, 45);
  assert.equal(byPid.p001.totalQty, 1);
  assert.equal(byPid.p045.totalQty, 1);
});

test('getItemsByPids: 25 个款号拆成 2 次请求，i_ids 数组长度 ≤ 20', async (t) => {
  const stub = installFetch((url, biz) => {
    const ids = Array.isArray(biz.i_ids) ? biz.i_ids : [];
    return jsonResponse({
      code: 0,
      data: {
        datas: ids.map((pid) => ({ i_id: pid, name: pid, skus: [] })),
      },
    });
  });
  t.after(() => stub.restore());

  const pids = makePids(25);
  const { items, byPid } = await getItemsByPids(pids);

  const itemCalls = stub.calls.filter((c) => c.url.includes('/open/mall/item/query'));
  assert.equal(itemCalls.length, 2);
  for (const call of itemCalls) {
    const biz = bizOf(call);
    assert.ok(Array.isArray(biz.i_ids));
    assert.ok(biz.i_ids.length <= JST_MAX_IDS);
  }
  assert.equal(items.length, 25);
  assert.equal(byPid.P025.name, 'P025');
});
