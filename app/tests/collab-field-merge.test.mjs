// 多人同时编辑同一货盘：以前按整盘 updatedAt 合并，谁的时间戳新谁整份覆盖，
// 于是「对方只改了售价」会把本地刚改的面料盖回旧值；本地更新时还会把对方的广播整条丢掉，
// 下次保存再把对方的改动冲回服务端（丢改动）。
// 现在广播带 changedFields() 的字段清单，接收方只应用这些字段，逐字段比较时间。
import test from 'node:test';
import assert from 'node:assert/strict';

const { mergeTray, changedFields } = await import('../src/lib/trayMerge.ts');

const base = () => ({
  id: 't-1',
  name: '马总 11.7 直播货盘',
  date: '2026-11-07',
  type: '马总直播货盘',
  template: 'mazong',
  sections: [
    { id: 's1', label: '主推A', visible: true, looks: [{ id: 'L1', pids: ['ME01'], cover: 'ME01' }] },
    { id: 's2', label: '现货', visible: true, looks: [] },
  ],
  viewPerm: [],
  editPerm: [],
  createdAt: '2026-11-01',
  updatedAt: '2026-11-06T10:00:00.000Z',
});

const at = (s) => new Date(`2026-11-06T10:00:${String(s).padStart(2, '0')}.000Z`).getTime();

test('changedFields：map 精确到 key，版块精确到版块 id', () => {
  const prev = base();
  const a = {
    ...base(),
    fabricOverrides: { ME01: '羊毛' },
    sections: prev.sections.map((s) => (s.id === 's1' ? { ...s, label: '主推A改' } : s)),
    updatedAt: '2026-11-06T10:00:05.000Z',
  };
  const changed = changedFields(prev, a);
  assert.deepEqual(changed.sort(), ['fabricOverrides:ME01', 'sections:s1'].sort());
  assert.deepEqual(changedFields(prev, base()), [], '没改动就不报字段');
});

test('两个人改不同字段，只应用对方改的那一个', () => {
  const prev = base();
  const a = { ...base(), fabricOverrides: { ME01: '羊毛' }, updatedAt: '2026-11-06T10:00:05.000Z' };
  const b = { ...base(), priceOverrides: { ME02: '999' }, updatedAt: '2026-11-06T10:00:04.000Z' };

  const { tray, applied } = mergeTray(b, a, changedFields(prev, a), {});
  assert.equal(tray.fabricOverrides.ME01, '羊毛', '对方的改动要能进来');
  assert.equal(tray.priceOverrides.ME02, '999', '本地刚改的售价不能被整盘盖掉');
  assert.deepEqual(applied, ['fabricOverrides:ME01']);
});

test('本地整盘更新时，对方的其它字段改动不再被丢弃', () => {
  const prev = base();
  const a = { ...base(), fabricOverrides: { ME01: '羊毛' }, updatedAt: '2026-11-06T10:00:05.000Z' };
  // 本地时间戳比对方新（刚改过名称）：旧实现直接 return local，对方的改动永久丢失
  const local = { ...base(), name: 'B 改的名字', updatedAt: '2026-11-06T10:00:06.000Z' };
  const { tray } = mergeTray(local, a, changedFields(prev, a), {});
  assert.equal(tray.name, 'B 改的名字');
  assert.equal(tray.fabricOverrides.ME01, '羊毛');
});

test('同一个字段本地改得更晚 → 保留本地，不被对方的旧值回退', () => {
  const prev = base();
  const a = { ...base(), fabricOverrides: { ME01: '羊毛' }, updatedAt: '2026-11-06T10:00:05.000Z' };
  const local = { ...base(), fabricOverrides: { ME01: '醋酸' }, updatedAt: '2026-11-06T10:00:03.000Z' };
  const { tray, applied } = mergeTray(local, a, changedFields(prev, a), { 'fabricOverrides:ME01': at(9) });
  assert.equal(tray.fabricOverrides.ME01, '醋酸');
  assert.deepEqual(applied, []);
});

test('两个人改不同版块，互不覆盖', () => {
  const prev = base();
  const a = {
    ...base(),
    sections: prev.sections.map((s) => (s.id === 's1' ? { ...s, label: 'A 改的' } : s)),
    updatedAt: '2026-11-06T10:00:05.000Z',
  };
  const b = {
    ...base(),
    sections: prev.sections.map((s) => (s.id === 's2' ? { ...s, label: 'B 改的' } : s)),
    updatedAt: '2026-11-06T10:00:04.000Z',
  };
  const { tray } = mergeTray(b, a, changedFields(prev, a), {});
  assert.equal(tray.sections.find((s) => s.id === 's1').label, 'A 改的');
  assert.equal(tray.sections.find((s) => s.id === 's2').label, 'B 改的');
});

test('新增版块按版块 id 同步，两个人各加一个版块都保留；纯调顺序才整份同步', () => {
  const prev = base();
  const sectionOf = (id, label) => ({ id, label, visible: true, looks: [] });
  const a = { ...base(), sections: [...prev.sections, sectionOf('s3', 'A 新增')], updatedAt: '2026-11-06T10:00:05.000Z' };
  const b = { ...base(), sections: [...prev.sections, sectionOf('s4', 'B 新增')], updatedAt: '2026-11-06T10:00:04.000Z' };

  assert.deepEqual(changedFields(prev, a), ['sections:s3'], '新增版块只报那一个版块');
  const { tray } = mergeTray(b, a, changedFields(prev, a), {});
  assert.deepEqual(tray.sections.map((s) => s.id).sort(), ['s1', 's2', 's3', 's4']);

  const reordered = { ...base(), sections: [prev.sections[1], prev.sections[0]], updatedAt: '2026-11-06T10:00:05.000Z' };
  assert.ok(changedFields(prev, reordered).includes('sections'), '纯调整顺序要整份同步');
});

test('服务端按字段合并：库里为底，只套用客户端声明的字段', async () => {
  const { applyChangedFields } = await import('../server/trays-field-merge.js');
  const prev = base();
  const a = { ...base(), fabricOverrides: { ME01: '羊毛' }, updatedAt: '2026-11-06T10:00:05.000Z' };
  const b = { ...base(), priceOverrides: { ME02: '999' }, updatedAt: '2026-11-06T10:00:09.000Z' };

  const merged = applyChangedFields(a, b, ['priceOverrides:ME02']);
  assert.equal(merged.fabricOverrides.ME01, '羊毛', '服务端已有的面料改动不能被冲掉');
  assert.equal(merged.priceOverrides.ME02, '999');
  assert.equal(merged.updatedAt, b.updatedAt, '时间戳取两边较新的');
});

test('前端和后端的字段合并口径一致（同一批用例结果相同）', async () => {
  const { applyChangedFields } = await import('../server/trays-field-merge.js');
  const prev = base();
  const cases = [
    { changed: ['fabricOverrides:ME01'], next: { fabricOverrides: { ME01: '羊毛', ME09: '醋酸' } } },
    { changed: ['priceOverrides:ME02'], next: { priceOverrides: { ME02: '999' } } },
    { changed: ['sections:s1'], next: { sections: prev.sections.map((s) => (s.id === 's1' ? { ...s, label: '改' } : s)) } },
    { changed: ['plannedRestockItems'], next: { plannedRestockItems: [{ pdt: 'ME01', skc: 'SK1', pieces: 10, days: 7 }] } },
    { changed: ['trashedAt', 'trashedBy'], next: { trashedAt: '2026-11-06T10:00:05.000Z', trashedBy: '张三' } },
    { changed: ['name'], next: { name: '新名字' } },
  ];
  for (const c of cases) {
    const remote = { ...base(), ...c.next, updatedAt: '2026-11-06T10:00:05.000Z' };
    const client = mergeTray(prev, remote, c.changed, {}).tray;
    const server = applyChangedFields(prev, remote, c.changed);
    assert.deepEqual(client, server, `口径不一致: ${c.changed.join(',')}`);
  }
});

test('没带字段清单的旧消息仍按整盘 LWW 处理', () => {
  const a = { ...base(), fabricOverrides: { ME01: '羊毛' }, updatedAt: '2026-11-06T10:00:05.000Z' };
  const local = { ...base(), priceOverrides: { ME02: '999' }, updatedAt: '2026-11-06T10:00:09.000Z' };
  const { tray } = mergeTray(local, a, undefined, {});
  assert.equal(tray.fabricOverrides, undefined, '本地更新时保持本地');
  assert.equal(tray.priceOverrides.ME02, '999');
});
