// 坑位 id 重复回归：旧生成规则 `let seq = 100; nid = (p) => `${p}-${++seq}`` 每次刷新页面都从头数，
// 隔天再开页面加坑位就生成了同一个 L-101（线上 t-111「现货 老品」里就有两个）。
// 重复 React key 在跨行拖拽（唯一会跨表搬节点的操作）时会串位，同一款号被画进两列，
// 刷新（全量挂载，不复用节点）又正常 —— 用户看到的「重复的款」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { newId, repairDuplicateIds } = await import('../src/lib/trayIds.ts');
const appCode = fs.readFileSync(path.resolve(__dirname, '../src/App.tsx'), 'utf8');
const pageCode = fs.readFileSync(path.resolve(__dirname, '../src/sections/TraysPage.tsx'), 'utf8');

const look = (id, pids = [id]) => ({ id, pids, cover: pids[0] });
const tray = (sections) => ({
  id: 't-111',
  name: '马总 11.8直播',
  date: '2026-11-08',
  type: '马总直播货盘',
  template: 'mazong',
  sections,
  viewPerm: [],
  editPerm: [],
  createdAt: '2026-11-01',
  updatedAt: '2026-11-06T06:44:36.717Z',
});

test('newId：同一毫秒里连续生成也不重复，带前缀', () => {
  const ids = new Set();
  for (let i = 0; i < 5000; i += 1) ids.add(newId('L'));
  assert.equal(ids.size, 5000, '5000 次生成必须 5000 个不同 id');
  for (const id of ids) assert.ok(id.startsWith('L-'), 'id 带前缀');
});

test('newId：刷新页面（模块状态重置）后也不会和上次生成的撞', () => {
  // 旧实现 reset 后从 100 重数，第二次调用又得到 L-101；新实现看的是时间戳
  const first = newId('L');
  const again = newId('L');
  assert.notEqual(first, again);
  assert.ok(!/^L-10[0-9]$/.test(first), '不再是 L-101 这种可预测的小序号');
});

test('repairDuplicateIds：重复坑位确定性改名，第一个保留原 id', () => {
  const t = tray([
    { id: 's-101', label: '现货 老品', visible: true, looks: [look('l1793692364898'), look('L-101'), look('L-102'), look('L-101')] },
  ]);
  const fixed = repairDuplicateIds(t);
  const ids = fixed.sections[0].looks.map((l) => l.id);
  assert.deepEqual(ids, ['l1793692364898', 'L-101', 'L-102', 'L-101-2'], '第二个 L-101 改名，位置不变');
  assert.equal(fixed.sections[0].looks.length, 4, '不增不减，只改名');
  assert.deepEqual(fixed.sections[0].looks[3].pids, ['L-101'], '款号不受影响');
  // 两台客户端各自算，结果必须一样（否则广播会互相打架）
  assert.deepEqual(repairDuplicateIds(t), fixed);
});

test('repairDuplicateIds：改名时把按坑位 id 存的配色 / 颜色文案一起搬过去', () => {
  const t = {
    ...tray([{ id: 's-101', label: '现货', visible: true, looks: [look('L-101', ['me01']), look('L-101', ['me02'])] }]),
    codeBgColorByLook: { 'L-101': 'yellow', 'L-999': 'blue' },
    codeFgColorByLook: { 'L-101': 'red' },
    colorOverrideByLook: { 'L-101': '棕色 / 灰' },
    colorCodesByLook: { 'L-101': { '棕色': '1937' } },
  };
  const fixed = repairDuplicateIds(t);
  assert.deepEqual(fixed.sections[0].looks.map((l) => l.id), ['L-101', 'L-101-2']);
  assert.equal(fixed.codeBgColorByLook['L-101'], 'yellow', '原来的配色保留');
  assert.equal(fixed.codeBgColorByLook['L-101-2'], 'yellow', '改名后的坑位继承同一份配色');
  assert.equal(fixed.codeBgColorByLook['L-999'], 'blue', '无关的键不动');
  assert.equal(fixed.codeFgColorByLook['L-101-2'], 'red');
  assert.equal(fixed.colorOverrideByLook['L-101-2'], '棕色 / 灰');
  assert.deepEqual(fixed.colorCodesByLook['L-101-2'], { '棕色': '1937' }, '手动填的颜色色号也要跟着搬');
});

test('repairDuplicateIds：没有重复就原样返回同一个对象（不制造多余渲染和保存）', () => {
  const t = tray([{ id: 's-101', label: '现货', visible: true, looks: [look('L-101'), look('L-102')] }]);
  assert.equal(repairDuplicateIds(t), t);
});

test('repairDuplicateIds：版块 id 重复也一并修掉', () => {
  const t = tray([
    { id: 's-101', label: '现货', visible: true, looks: [look('L-1')] },
    { id: 's-101', label: '备用', visible: true, looks: [look('L-2')] },
  ]);
  assert.deepEqual(repairDuplicateIds(t).sections.map((s) => s.id), ['s-101', 's-101-2']);
});

test('新建坑位 / 版块不再用可预测的计数器或毫秒时间戳', () => {
  assert.ok(appCode.includes('const nid = (p: string) => newId(p);'), 'App.tsx 的 nid 走 newId');
  assert.ok(!appCode.includes('let seq = 100;'), '旧的模块级计数器要删掉');
  assert.ok(!pageCode.includes('id: `l${Date.now()}`'), '坑位 id 不能再只用毫秒时间戳');
  assert.ok(!pageCode.includes('id: `s${Date.now()}`'), '版块 id 不能再只用毫秒时间戳');
  const adds = pageCode.match(/newId\('(l|s)'\)/g) || [];
  assert.ok(adds.length >= 3, '加坑位 / 加版块 / 加备用版块都走 newId');
});

test('载入货盘时自动修复历史重复 id', () => {
  assert.ok(appCode.includes('repairDuplicateIds(normalizeTrayImages(t))'), '云端 + 本地载入后统一修复');
});
