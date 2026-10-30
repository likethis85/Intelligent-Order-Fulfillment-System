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

test('saveTrays: 并发写不报错，最终落盘的是最后一次写', async (t) => {
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // 先写一次，让后续的「读旧数据 + 快照」路径也走一遍
  await saveTrays([tray('seed')]);

  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => saveTrays([tray(`t-${i}`)])),
  );
  assert.ok(results.every((r) => r.ok));

  const { trays } = await loadTrays();
  assert.equal(trays.length, 1);
  assert.equal(trays[0].id, 't-7', '最后发起的那次写必须赢');

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
  assert.equal(trays[0].id, 'after-fail');

  const leftovers = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});
