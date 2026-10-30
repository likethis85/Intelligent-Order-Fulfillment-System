// 原子写回归：并发写同一个目标文件不能报 ENOENT，也不能留下临时文件。
// 旧实现共用 `<file>.tmp`，并发时后一个 rename 必然失败（vscm 缓存线上就在刷这个告警）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { writeJsonAtomic } = await import('../server/atomic-write.js');

test('writeJsonAtomic: 并发写全部成功，最终是最后一次写', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'nested', 'cache.json');

  await Promise.all(Array.from({ length: 10 }, (_, i) => writeJsonAtomic(file, { n: i })));

  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { n: 9 });
  const leftovers = fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('writeJsonAtomic: 序列化失败会抛错、清掉临时文件，且不卡死后续写', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'cache.json');

  const circular = {};
  circular.self = circular;
  await assert.rejects(() => writeJsonAtomic(file, circular), TypeError);

  await writeJsonAtomic(file, { ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ok: true });
  const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});
