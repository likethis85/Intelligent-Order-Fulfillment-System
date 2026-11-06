// 坑位拖拽重排回归：编辑货盘时可以直接拖动表头调整坑位顺序。
// 规则与「更多 → 左移/右移」一致：同一版块内都可以移，跨排也可以——
// looks 是线性数组，行只是按 LOOKS_PER_BAND（8 个）切出来的视觉分排。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pageCode = fs.readFileSync(path.resolve(__dirname, '../src/sections/TraysPage.tsx'), 'utf8');

test('坑位拖拽：表头可拖，松手按落点插入', () => {
  assert.ok(pageCode.includes('const [lookDrag, setLookDrag]'), '需要拖拽状态');
  assert.ok(pageCode.includes('draggable={!readOnly}'), '只读货盘不能拖');
  assert.ok(pageCode.includes('const hit = lookHitAt(x, y);'), '松手后按落点坐标插入');
  assert.ok(pageCode.includes('reorderLook(drag.sectionId, drag.fromId, hit.lookId, hit.position)'), '按 before/after 插入');
  assert.ok(pageCode.includes("x < rect.left + rect.width / 2 ? 'before' : 'after'"), '按落点在列内左右半边决定插入位置');
  assert.ok(pageCode.includes("closest('button')"), '从表头的 + / 更多操作按钮上按下不能起拖');
});

test('坑位拖拽：落点自己算，不依赖浏览器 drop 命中（自动滚屏时会丢事件）', () => {
  // 表头带坐标命中标记
  assert.ok(pageCode.includes('data-look-id={l.id}'), '表头要能被坐标查询到');
  assert.ok(pageCode.includes('data-look-section={s.id}'), '落点要能判断属于哪个版块');
  assert.ok(pageCode.includes("document.elementFromPoint(x, y)?.closest('[data-look-id]')"), '按坐标查落点');
  // drop 只记录坐标，结算统一放在 dragend
  assert.ok(!pageCode.includes('reorderLook(s.id, drag.fromId, l.id, drag.position)'), 'drop 里不再直接结算');
  const end = pageCode.indexOf('onDragEnd={(e) => {');
  assert.ok(end > 0, 'dragend 里要结算落点');
  const body = pageCode.slice(end, pageCode.indexOf('title={readOnly', end));
  assert.ok(body.includes('lookHitAt(x, y)'), 'dragend 用松手坐标命中');
  assert.ok(body.includes('lookPointRef.current'), '坐标是 0 时用拖拽期间记下的坐标兜底');
  // 拖拽期间的 rAF 循环也要更新插入线，否则自动滚动后插入线停在旧位置
  const loop = pageCode.slice(pageCode.indexOf('const lookDragging'), pageCode.indexOf('}, [lookDragging]);'));
  assert.ok(loop.includes('const hit = lookHitAt(point.x, point.y);'), '自动滚屏时插入线跟着坐标走');
});

test('坑位拖拽：同一版块内可跨排，reorderLook 不再按排拦截', () => {
  const start = pageCode.indexOf('const reorderLook =');
  const body = pageCode.slice(start, pageCode.indexOf('// 跨版块移动', start));
  assert.ok(start > 0, 'reorderLook 应存在');
  assert.ok(!body.includes('LOOKS_PER_BAND'), 'reorderLook 不能再用排号拦截（跨排是合法操作）');
  assert.ok(!body.includes('请先调整排数'), '「请先调整排数」是空话：每排固定 8 个，没有调整排数的入口');
  // 先摘出再按目标位置插入，避免取反后的下标错位（跨排时中间坑位随之整体平移）
  assert.ok(body.includes('const [moved] = arr.splice(fromIdx, 1);'), '先移除被拖动的坑位');
  assert.ok(body.includes("if (position === 'after') toIdx += 1;"), '落在右半边插到目标后面');
});

test('坑位拖拽：跨排落点也要允许 drop', () => {
  const start = pageCode.indexOf('const handleLookDragOver');
  assert.ok(start > 0, 'handleLookDragOver 应存在');
  const body = pageCode.slice(start, pageCode.indexOf('return (', start));
  assert.ok(body.includes('e.preventDefault();'), '要 preventDefault 才允许 drop');
  assert.ok(!body.includes("dropEffect = 'none'"), '跨排不能再把落点判成无效');
  assert.ok(pageCode.includes('可跨排'), '表头 title 说明可以跨排拖');
});

test('坑位拖拽：拖到边缘自动滚屏（拖拽期间滚轮被浏览器吞掉）', () => {
  const start = pageCode.indexOf('const lookDragging');
  assert.ok(start > 0, '需要 lookDragging 派生标记（布尔值，dragover 换目标时不能重启循环）');
  const body = pageCode.slice(start, pageCode.indexOf('}, [lookDragging]);', start));
  assert.ok(body.includes("window.addEventListener('dragover', track, true)"), '拖拽期间要持续跟住鼠标位置');
  assert.ok(body.includes('requestAnimationFrame(step)'), '指针停住不动时也要继续滚');
  assert.ok(body.includes('document.elementFromPoint'), '按鼠标下面的容器判断该滚谁，而不是写死 window');
  assert.ok(body.includes('node.scrollTop +='), '上下方向自动滚（跨排能拖到看不见的坑位）');
  assert.ok(body.includes('node.scrollLeft +='), '左右方向自动滚货盘表格');
  assert.ok(pageCode.includes('}, [lookDragging]);'), '依赖是布尔标记：换落点时不能反复重建循环');
});

test('坑位左右移：跨排同样放行，不再提示「请先调整排数」', () => {
  const start = pageCode.indexOf('const moveLook =');
  assert.ok(start > 0, 'moveLook 应存在');
  const body = pageCode.slice(start, pageCode.indexOf('// 拖拽调整坑位顺序', start));
  assert.ok(!body.includes('LOOKS_PER_BAND'), '左右移也按线性下标走，跨排合法');
  assert.ok(!body.includes('请先调整排数'), '过时提示要删掉');
  assert.ok(body.includes('const j = i + dir;'), '仍然是一次一位的交换');
});
