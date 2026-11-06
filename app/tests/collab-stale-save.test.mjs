// 云端保存的丢改动回归：客户端每次 PUT 的是「全部货盘」，他没打开过的货盘只是本机旧副本。
// 以前服务端直接整份覆盖，于是 A 改自己货盘时会把 B 刚改的另一个货盘冲成旧版本。
// 现在服务端逐盘比较 updatedAt：比库里旧的保留库里版本，并返回 rejected 让调用方跳过落库/广播。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trays-stale-'));
process.env.TRAYS_CACHE_DIR = tmpDir;

const { saveTrays, loadTrays } = await import('../server/trays-store.js');

const tray = (id, updatedAt, name = id, extra = {}) => ({
  id, name, date: '2026-11-07', type: '直播货盘', template: 'normal',
  sections: [], viewPerm: [], editPerm: [], createdAt: '2026-11-01', updatedAt, ...extra,
});

test('比服务端更旧的货盘副本被拒绝，服务端版本保留', async (t) => {
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  await saveTrays([tray('t-a', '2026-11-06T10:00:00.000Z', 'B 改过的新版本')]);

  // A 的本机还是更早的副本，同时 A 改了另一个货盘 t-b → 全量提交
  const r = await saveTrays([
    tray('t-a', '2026-11-06T09:00:00.000Z', 'A 本机的旧版本'),
    tray('t-b', '2026-11-06T11:00:00.000Z', 'A 新建的'),
  ]);

  assert.equal(r.ok, true);
  assert.deepEqual(r.rejected.map((x) => x.id), ['t-a'], '旧副本要报出来');

  const { trays } = await loadTrays();
  assert.equal(trays.find((x) => x.id === 't-a').name, 'B 改过的新版本', 'B 的修改不能被冲掉');
  assert.equal(trays.find((x) => x.id === 't-b').name, 'A 新建的', '同一批里的新货盘照常写入');
});

test('时间戳相同或更新时照常写入', async (t) => {
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  await saveTrays([tray('t-c', '2026-11-06T10:00:00.000Z', 'v1')]);
  const same = await saveTrays([tray('t-c', '2026-11-06T10:00:00.000Z', 'v2-same-ms')]);
  assert.deepEqual(same.rejected, []);
  assert.equal((await loadTrays()).trays.find((x) => x.id === 't-c').name, 'v2-same-ms');

  const newer = await saveTrays([tray('t-c', '2026-11-06T10:05:00.000Z', 'v3-newer')]);
  assert.deepEqual(newer.rejected, []);
  assert.equal((await loadTrays()).trays.find((x) => x.id === 't-c').name, 'v3-newer');
});

test('带 changedByTray 的保存按字段合并：旧副本里的其它字段不会冲掉服务端', async (t) => {
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // 服务端已有 B 的面料改动
  await saveTrays([tray('t-x', '2026-11-06T10:00:00.000Z', 't-x', {
    fabricOverrides: { ME01: '羊毛' },
    priceOverrides: { ME01: '100' },
  })]);

  // A 的本机是旧副本（没有面料覆盖），这次只改了售价 → 带上字段清单
  const r = await saveTrays(
    [tray('t-x', '2026-11-06T10:03:00.000Z', 't-x', { priceOverrides: { ME01: '120' } })],
    [],
    { 't-x': ['priceOverrides:ME01'] },
  );

  assert.deepEqual(r.rejected, [], '按字段合并的保存不该被当成旧副本拒掉');
  const saved = r.trays.find((x) => x.id === 't-x');
  assert.equal(saved.fabricOverrides.ME01, '羊毛', '服务端的面料改动要保留');
  assert.equal(saved.priceOverrides.ME01, '120', 'A 改的售价要写进去');

  const onDisk = (await loadTrays()).trays.find((x) => x.id === 't-x');
  assert.equal(onDisk.fabricOverrides.ME01, '羊毛');
  assert.equal(onDisk.priceOverrides.ME01, '120');
});

test('没有 updatedAt 的老数据不因为守卫写不进去', async (t) => {
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const legacy = { ...tray('t-d', undefined, '老数据') };
  delete legacy.updatedAt;
  await saveTrays([legacy]);
  const again = { ...tray('t-e', undefined, '另一个老数据') };
  delete again.updatedAt;
  const r = await saveTrays([again]);
  assert.deepEqual(r.rejected, []);
  assert.deepEqual((await loadTrays()).trays.map((x) => x.id).sort(), ['t-d', 't-e']);
});
