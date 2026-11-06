// 同一货盘的在线成员提示：服务端一直在推 users，之前前端直接丢掉了。
// 现在接住并显示「XX 也在看」，只读账号会标「（只读）」；有人更新时在名单上闪一下，
// 不再每条广播弹一次 toast（多账号时会被刷屏）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.resolve(__dirname, p), 'utf8');

const { roomOthers } = await import('../src/lib/presence.ts');

test('roomOthers：去重、去掉自己、保留只读标记', () => {
  assert.deepEqual(
    roomOthers([{ name: '张三', canEdit: true }, { name: '李四', canEdit: false }], '王五'),
    [{ name: '张三', canEdit: true }, { name: '李四', canEdit: false }],
  );
  assert.deepEqual(roomOthers([{ name: '张三', canEdit: true }], '张三'), [], '自己不算「也在看」');
  assert.deepEqual(
    roomOthers([{ name: '张三', canEdit: false }, { name: '张三', canEdit: true }], '王五'),
    [{ name: '张三', canEdit: true }],
    '同一个人开两个标签页只算一个，只要能编辑就算能编辑',
  );
  assert.deepEqual(roomOthers([' 张三 ', ''], '王五'), [{ name: '张三', canEdit: true }], '兼容纯字符串老格式');
  assert.deepEqual(roomOthers([1, { name: 'x' }], '王五'), [{ name: 'x', canEdit: true }], '脏数据不抛错');
  assert.deepEqual(roomOthers(null, '王五'), []);
});

test('服务端 users 消息带 canEdit', () => {
  const ws = read('../server/ws-trays.js');
  assert.ok(
    ws.includes("map((w) => ({ name: w._user, canEdit: w._canEdit !== false }))"),
    '只读账号也要能标出来',
  );
});

test('WS 客户端接住 users 消息并排除自己', () => {
  const sync = read('../src/lib/traySync.ts');
  assert.ok(sync.includes("if (msg.type === 'users')"), '要处理 users 消息');
  assert.ok(sync.includes('setOthers(roomOthers(msg.users, userRef.current))'), '同一货盘的成员要去重并排除自己');
  assert.match(sync, /return \{\s*others,/, 'hook 要把成员列表暴露出去');
  assert.ok(sync.includes('setOthers([]); // 上一间房间的成员不能带到新货盘上'), '切货盘要清空旧成员');
  assert.ok(sync.includes('setOthers([]); // 断线期间成员列表不可信'), '断线要清空，避免显示幽灵成员');
});

test('顶栏展示同盘在线成员，只读加标注，窄屏只显示人数', () => {
  const app = read('../src/App.tsx');
  assert.ok(app.includes('const { broadcast, others } = useTraySync('), 'App 要拿到成员列表');
  assert.ok(app.includes('className={`app-presence flex items-center gap-1'), '顶栏有在线成员区块');
  assert.ok(app.includes("o.canEdit ? '' : '（只读）'"), '只读账号要标出来');
  assert.ok(app.includes('hidden whitespace-nowrap 2xl:inline'), '宽屏显示名字');
  assert.ok(app.includes('2xl:hidden'), '窄屏退化成人数');
  assert.ok(app.includes('同一货盘在线：${others.map'), 'hover 能看到完整名单');
});

test('更新提示改成名单高亮，不再每条广播弹 toast', () => {
  const app = read('../src/App.tsx');
  assert.ok(app.includes('handleRemoteUpdate'), 'App 里有更新回调');
  assert.ok(app.includes("setFlashUser(who)"), '收到更新只记一个名字，供名单高亮');
  assert.ok(!app.includes('更新了货盘「${trayName}」'), '不再为每条广播弹 toast');
  assert.ok(app.includes("flashUser === o.name ? 'font-semibold'"), '正在更新的人高亮');
});
