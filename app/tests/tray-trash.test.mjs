// 货盘回收站回归：删除 = 打上 trashedAt 移入回收站，30 天内可恢复；彻底删除才真正移除。
// 另外锁住服务端的过期清理：过期货盘不再下发，保存时从文件里删掉。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appCode = fs.readFileSync(path.resolve(__dirname, '../src/App.tsx'), 'utf8');
const pageCode = fs.readFileSync(path.resolve(__dirname, '../src/sections/TraysPage.tsx'), 'utf8');
const storeCode = fs.readFileSync(path.resolve(__dirname, '../server/trays-store.js'), 'utf8');
const libCode = fs.readFileSync(path.resolve(__dirname, '../src/lib/trayTrash.ts'), 'utf8');

// trays-store 在 import 时读取 TRAYS_CACHE_DIR，整个文件共用一个临时目录；
// 每个用例开始前清空目录，避免上一个用例的货盘串进来。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trays-trash-'));
process.env.TRAYS_CACHE_DIR = tmpDir;
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
const resetStore = () => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
};
const { saveTrays, loadTrays, isTrashExpired } = await import('../server/trays-store.js');

test('回收站：删除只是打标记，不再直接从 trays 里移除', () => {
  assert.ok(appCode.includes('trays.filter((t) => !t.trashedAt)'), '正常列表要过滤掉回收站里的货盘');
  assert.ok(appCode.includes('trashedAt: now, trashedBy: collabUser'), '删除时写入删除时间和删除人');
  assert.ok(
    /const deleteTray = \(id: string\) => \{[\s\S]*?setTrays\(\(ts\) => ts\.map\(\(x\) => \(x\.id === id \? trashed : x\)\)\);/.test(appCode),
    'deleteTray 必须改成 map 打标记，而不是 filter 删除',
  );
  assert.ok(
    /const restoreTray[\s\S]*?trashedAt: null/.test(appCode),
    '恢复时 trashedAt 置 null（不删字段，WS 合并才能覆盖其他客户端的旧值）',
  );
  assert.ok(
    /const purgeTray[\s\S]*?setTrays\(\(ts\) => ts\.filter\(\(x\) => x\.id !== id\)\);/.test(appCode),
    '彻底删除才真正从数组里移除',
  );
});

test('回收站：货盘页有入口、抽屉和恢复/彻底删除按钮', () => {
  assert.ok(pageCode.includes('trashedTrays'), 'TraysPage 要接收回收站列表');
  assert.ok(pageCode.includes('const [showTrash, setShowTrash] = useState(false);'));
  assert.ok(pageCode.includes('回收站{trashedTrays.length > 0'), '列表页头部要有回收站入口和数量');
  assert.ok(pageCode.includes('className="tray-trash absolute right-0 top-0'), '回收站抽屉');
  assert.ok(pageCode.includes('onRestoreTray(t.id)'), '回收站里每个货盘都能恢复');
  assert.ok(pageCode.includes('onPurgeTray(purgeTarget.id)'), '彻底删除前要二次确认');
  assert.ok(pageCode.includes('回收站是空的'));
  // 删除确认弹窗要说明能恢复，不再写「不可恢复」
  const dialogStart = pageCode.indexOf('确定删除货盘');
  const dialog = pageCode.slice(dialogStart, pageCode.indexOf('</AlertDialog.Description>', dialogStart));
  assert.ok(!dialog.includes('操作后不可恢复'), '普通删除已经可以恢复了');
  assert.ok(dialog.includes('天内可恢复'), '删除确认要写明回收站保留期');
});

test('回收站：服务端 30 天后清理，未过期照常保留', async () => {
  resetStore();

  const tray = (id, trashedAt) => ({
    id, name: id, date: '2026-10-30', sections: [], plannedRestockItems: [], noRestockItems: [],
    ...(trashedAt === undefined ? {} : { trashedAt }),
  });
  const daysAgo = (n) => new Date(Date.now() - n * 86400_000).toISOString();

  // 非法/缺失的 trashedAt 不能当成过期（避免误删正常货盘）
  assert.equal(isTrashExpired(tray('a')), false);
  assert.equal(isTrashExpired(tray('b', 'not-a-date')), false);
  assert.equal(isTrashExpired(tray('c', daysAgo(29))), false);
  assert.equal(isTrashExpired(tray('d', daysAgo(31))), true);

  await saveTrays([tray('active'), tray('trash-recent', daysAgo(1))]);
  let loaded = await loadTrays();
  assert.deepEqual(loaded.trays.map((x) => x.id).sort(), ['active', 'trash-recent'], '30 天内的回收站货盘要保留');

  await saveTrays([tray('active'), tray('trash-recent', daysAgo(1)), tray('trash-old', daysAgo(31))]);
  loaded = await loadTrays();
  assert.deepEqual(loaded.trays.map((x) => x.id).sort(), ['active', 'trash-recent'], '保存时过期货盘要被清掉');

  // 文件里也不能再留着过期货盘（下次读取不会复活）
  const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, 'trays.json'), 'utf8'));
  assert.deepEqual(onDisk.trays.map((x) => x.id).sort(), ['active', 'trash-recent']);
});

test('彻底删除：墓碑能挡住旧客户端把货盘带回来', async () => {
  resetStore();

  const tray = (id, extra = {}) => ({ id, name: id, date: '2026-10-30', sections: [], plannedRestockItems: [], noRestockItems: [], ...extra });

  await saveTrays([tray('keep'), tray('gone')]);
  const tomb = { id: 'gone', at: new Date().toISOString(), by: '测试' };
  await saveTrays([tray('keep')], [tomb]);

  let loaded = await loadTrays();
  assert.deepEqual(loaded.trays.map((x) => x.id), ['keep'], '彻底删除的货盘不能再下发');
  assert.equal(loaded.tombstones[0].id, 'gone', '墓碑要持久化并下发');

  // 模拟「另一个客户端还拿着旧数据」：把 gone 原样提交回来
  await saveTrays([tray('keep'), tray('gone')], [tomb]);
  loaded = await loadTrays();
  assert.deepEqual(loaded.trays.map((x) => x.id), ['keep'], '旧客户端不能复活已彻底删除的货盘');

  // 但墓碑之后重新建的同一个 id（updatedAt 更新）要允许存在
  const future = new Date(Date.now() + 60_000).toISOString();
  await saveTrays([tray('keep'), tray('gone', { updatedAt: future })], [tomb]);
  loaded = await loadTrays();
  assert.deepEqual(loaded.trays.map((x) => x.id).sort(), ['gone', 'keep'], '墓碑之后重建的同 id 货盘不能被误杀');
});

test('彻底删除：客户端数据残缺时，服务端不会把其他货盘一起冲掉', async () => {
  resetStore();

  const tray = (id) => ({ id, name: id, date: '2026-10-30', sections: [], plannedRestockItems: [], noRestockItems: [] });

  await saveTrays([tray('a'), tray('b'), tray('c')]);
  // 一个只加载到一个货盘的客户端保存（线上真实发生过）
  await saveTrays([tray('a')]);

  const { trays } = await loadTrays();
  assert.deepEqual(trays.map((x) => x.id).sort(), ['a', 'b', 'c'], '没带删除墓碑的货盘要保留');
});

test('回收站：服务端有独立的保留期开关', () => {
  assert.ok(storeCode.includes('TRAYS_TRASH_RETENTION_DAYS'), '保留天数要能用环境变量覆盖');
  assert.ok(storeCode.includes('export function isTrashExpired'), '过期判断要可测试');
  // 客户端 / 服务端默认值必须一致，否则「还剩 N 天」和真正清理时间对不上
  assert.match(storeCode, /TRAYS_TRASH_RETENTION_DAYS\) \|\| 30/);
  assert.match(libCode, /TRASH_RETENTION_DAYS = 30/);
});

test('回收站：客户端也按保留期过滤，过期货盘不再显示', () => {
  assert.match(appCode, /import \{[^}]*isTrashExpired[^}]*\} from '@\/lib\/trayTrash'/, 'App 要用共享的保留期判断');
  assert.ok(
    appCode.includes('t.trashedAt && !isTrashExpired(t.trashedAt)'),
    '回收站列表要滤掉过期项（服务端下次保存时才真正清掉）',
  );
  assert.ok(pageCode.includes("from '@/lib/trayTrash'"), '页面提示文案用共享的保留期常量');
});

test('彻底删除：客户端写墓碑、随保存一起提交', () => {
  assert.ok(
    /const purgeTray[\s\S]*?setTombstones\(\(list\) => mergeTombstones\(list, \[\{ id, at: new Date\(\)\.toISOString\(\), by: collabUser \}\]\)\)/.test(appCode),
    '彻底删除必须写墓碑，否则其他客户端的旧数据会把它带回来',
  );
  assert.ok(appCode.includes('JSON.stringify({ trays, deletedTrayIds, tombstones })'), '保存时 tombstones 要一起提交');
  assert.ok(appCode.includes('[trays, traysReady, tombstones]'), '墓碑变化要触发一次保存');
  assert.ok(appCode.includes('stripTombstoned'), 'WS / 轮询写入的货盘要过墓碑过滤');
  assert.ok(appCode.includes("Array.isArray(data.tombstones)"), '初始化要从服务端读墓碑');
});
