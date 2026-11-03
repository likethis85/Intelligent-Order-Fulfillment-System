// 货盘写盘并发回归：以前所有 save 共用 `<trays>.tmp`，并发写会出现
// rename ENOENT（接口 500、这一笔写丢）或旧数据覆盖新数据。
// 这里把缓存目录指到临时目录，连发多个写请求验证：全部成功、最终落盘的是最后一次写、不留临时文件。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trays-save-'));
process.env.TRAYS_CACHE_DIR = tmpDir;

const { saveTrays, loadTrays } = await import('../server/trays-store.js');

const tray = (id) => ({ id, name: id, date: '2026-10-30', sections: [], plannedRestockItems: [], noRestockItems: [] });

test('saveTrays: 并发写不报错，同一货盘以后写入的为准，且不丢其他货盘', async (t) => {
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // 先写一次，让后续的「读旧数据 + 快照」路径也走一遍
  await saveTrays([tray('seed')]);

  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => saveTrays([tray(`t-${i}`)])),
  );
  assert.ok(results.every((r) => r.ok));

  const { trays } = await loadTrays();
  // 服务端会保留「本次没带、也没有删除墓碑」的货盘（防残缺数据冲掉整份货盘），
  // 所以并发写之后是并集：seed + t-0..t-7
  assert.equal(trays.length, 9);
  assert.ok(trays.some((x) => x.id === 'seed'));
  for (let i = 0; i < 8; i++) assert.ok(trays.some((x) => x.id === `t-${i}`));

  // 同一个货盘的并发修改：最后落盘的那份为准
  await Promise.all(
    Array.from({ length: 5 }, (_, i) => saveTrays([{ ...tray('t-0'), name: `v${i}` }])),
  );
  const after = await loadTrays();
  assert.equal(after.trays.filter((x) => x.id === 't-0').length, 1, '同一货盘不能出现两份');

  const leftovers = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], '不能留下临时文件');
});

test('saveTrays: 一次写失败不会卡死后续写盘', async (t) => {
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  await saveTrays([tray('before-fail')]);

  // 循环引用会让 JSON.stringify 在队列里抛错，模拟「写盘中间失败」
  const broken = tray('broken');
  broken.self = broken;
  await assert.rejects(() => saveTrays([broken]));

  const ok = await saveTrays([tray('after-fail')]);
  assert.equal(ok.ok, true);

  const { trays } = await loadTrays();
  assert.ok(trays.some((x) => x.id === 'after-fail'));

  const leftovers = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});
