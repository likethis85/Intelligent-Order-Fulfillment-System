import test from 'node:test';
import assert from 'node:assert/strict';

// 这些测试用假 fetch 替掉真实网络，验证库存翻页与防重复逻辑
process.env.JUSHUITAN_APP_KEY = 'test_key';
process.env.JUSHUITAN_APP_SECRET = 'test_secret';

const { getInventoryByPids } = await import('../server/jushuitan-client.js');

function jsonResponse(payload) {
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
}

function row(pid, skuId, qty, extra = {}) {
  return { i_id: pid, sku_id: skuId, name: pid, qty, order_lock: 0, pick_lock: 0, purchase_qty: 0, allocate_qty: 0, defective_qty: 0, ...extra };
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
    return handler(u, { ...biz, params }, calls);
  };
  return {
    calls,
    restore: () => { globalThis.fetch = original; },
  };
}

test('jushuitan inventory: 超过单页上限时会继续翻页，库存不被截断', async (t) => {
  const stub = installFetch((url, params) => {
    const page = Number(params.page_index);
    if (page === 1) {
      return jsonResponse({ code: 0, data: { inventorys: [row('P1', 'S1', 5), row('P1', 'S2', 7)] } });
    }
    if (page === 2) {
      return jsonResponse({ code: 0, data: { inventorys: [row('P2', 'S3', 11)] } });
    }
    return jsonResponse({ code: 0, data: { inventorys: [] } });
  });
  t.after(() => stub.restore());

  const { byPid, items } = await getInventoryByPids(['P1', 'P2'], { pageSize: 2 });
  assert.equal(items.length, 3);
  assert.equal(byPid.P1.totalQty, 12);
  assert.equal(byPid.p2.totalQty, 11);
  assert.equal(Object.keys(byPid.P1.skus).length, 2);

  const pages = stub.calls
    .filter((c) => c.url.includes('/open/inventory/query'))
    .map((c) => JSON.parse(new URLSearchParams(String(c.body)).get('biz') || '{}').page_index);
  assert.deepEqual(pages, [1, 2]);
});

test('jushuitan inventory: 接口忽略 page_index 时不会重复累加', async (t) => {
  const samePage = [row('P1', 'S1', 5), row('P1', 'S2', 7)];
  let inventoryCalls = 0;
  const stub = installFetch(() => {
    inventoryCalls += 1;
    return jsonResponse({ code: 0, data: { inventorys: samePage } });
  });
  t.after(() => stub.restore());

  const { byPid, items } = await getInventoryByPids(['P1'], { pageSize: 2 });
  assert.equal(items.length, 2);
  assert.equal(byPid.P1.totalQty, 12);
  // 第二页全是重复行 → fresh === 0 立即停止，不会翻满 maxPages
  assert.equal(inventoryCalls, 2);
});

test('jushuitan inventory: 空输入直接返回空结构', async () => {
  const res = await getInventoryByPids([]);
  assert.deepEqual(res, { byPid: {}, items: [] });
});
