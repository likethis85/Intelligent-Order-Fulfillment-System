// 保存的写放大：以前每次编辑都是「整份上传 + 整份重写 + 逐个 upsert 全部货盘」，
// 线上 17 个货盘就是每次 116KB 上行 + 17 次 Supabase 串行 upsert，名字叫增量实际是全量。
// 现在客户端只发改动的货盘（partial），服务端其余货盘保持库里版本，只 upsert 带上来那几个。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.resolve(__dirname, p), 'utf8');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trays-partial-'));
process.env.TRAYS_CACHE_DIR = tmpDir;

const { saveTrays, loadTrays } = await import('../server/trays-store.js');

const tray = (id, name, extra = {}) => ({
  id,
  name,
  date: '2026-11-07',
  type: '直播货盘',
  template: 'normal',
  sections: [],
  viewPerm: [],
  editPerm: [],
  createdAt: '2026-11-01',
  updatedAt: '2026-11-06T10:00:00.000Z',
  ...extra,
});

test('增量保存只替换带上去的货盘，其余保持库里版本与顺序', async (t) => {
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  await saveTrays([tray('t-a', 'A'), tray('t-b', 'B'), tray('t-c', 'C')]);
  const r = await saveTrays(
    [tray('t-b', 'B2', { updatedAt: '2026-11-06T10:05:00.000Z' })],
    [],
    null,
    { partial: true },
  );

  assert.deepEqual(r.rejected, []);
  const { trays } = await loadTrays();
  assert.deepEqual(trays.map((x) => x.id), ['t-a', 't-b', 't-c'], '没带上来的货盘不能被丢掉，顺序也保持库里顺序');
  assert.equal(trays.find((x) => x.id === 't-b').name, 'B2', '带上来的是新版本');
  assert.equal(trays.find((x) => x.id === 't-a').name, 'A');
  assert.equal(r.trays.length, 3, '返回值仍是完整落地列表，调用方据此广播');
});

test('增量保存里的新货盘追加在末尾', async (t) => {
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  await saveTrays([tray('t-a', 'A')]);
  await saveTrays([tray('t-n', '新货盘'), tray('t-a', 'A2', { updatedAt: '2026-11-06T10:05:00.000Z' })], [], null, { partial: true });
  const { trays } = await loadTrays();
  assert.deepEqual(trays.map((x) => x.id), ['t-a', 't-n']);
  assert.equal(trays.find((x) => x.id === 't-a').name, 'A2');
});

test('增量保存同样受旧副本守卫和字段合并约束', async (t) => {
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  await saveTrays([tray('t-x', 'X', { fabricOverrides: { ME01: '羊毛' }, updatedAt: '2026-11-06T10:00:00.000Z' })]);

  // 旧副本：整盘更旧 → 拒绝
  const stale = await saveTrays([tray('t-x', '旧本机', { updatedAt: '2026-11-06T09:00:00.000Z' })], [], null, { partial: true });
  assert.deepEqual(stale.rejected.map((x) => x.id), ['t-x']);
  assert.equal((await loadTrays()).trays.find((x) => x.id === 't-x').name, 'X', '旧副本不能冲掉服务端版本');

  // 带字段清单：按字段合并，服务端的面料保留，本机改的售价写进去
  const merged = await saveTrays(
    [tray('t-x', 'X', { priceOverrides: { ME01: '120' }, updatedAt: '2026-11-06T10:03:00.000Z' })],
    [],
    { 't-x': ['priceOverrides:ME01'] },
    { partial: true },
  );
  assert.deepEqual(merged.rejected, []);
  const saved = merged.trays.find((x) => x.id === 't-x');
  assert.equal(saved.fabricOverrides.ME01, '羊毛');
  assert.equal(saved.priceOverrides.ME01, '120');
});

test('前端只上传变动的货盘，服务端按 partial 合并', () => {
  const app = read('../src/App.tsx');
  assert.ok(app.includes('partial: changed !== null'), '要带增量标记');
  assert.match(
    app,
    /const outgoing = changed\s*\?\s*trays\.filter\(\(t\) => !prevIds\.has\(t\.id\) \|\| Boolean\(changed\[t\.id\]\)\)\s*:\s*trays;/,
    '只挑出新增和真正变了的货盘',
  );
  assert.ok(app.includes('prevTraysRef.current = cloudTrays'), '页面加载后以云端版本作为 diff 基线');
  assert.ok(app.includes('const changed = prevTrays ? changedByTray(prevTrays, trays) : null'), '基线缺失时整份上传');

  const route = read('../server/routes/trays.js');
  assert.ok(route.includes('const partial = req.body?.partial === true'), '服务端解析 partial');
  assert.ok(route.includes('saveTrays(trays, tombstones, changedByTray, { partial })'), '透传给 store');

  const ws = read('../server/ws-trays.js');
  assert.ok(ws.includes('{ partial: true }'), 'WS 单盘保存本来就是增量的，别再走整份口径');
});
