// 坑位拖拽重排回归：编辑货盘时可以直接拖动表头左右调整坑位顺序。
// 规则与「更多 → 左移/右移」一致：只能在同一排（band）内移动，跨排会被拒绝。
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
  assert.ok(pageCode.includes('reorderLook(s.id, drag.fromId, l.id, drag.position)'), '松手后按 before/after 插入');
  assert.ok(pageCode.includes("e.clientX < rect.left + rect.width / 2"), '按落点在列内左右半边决定插入位置');
  assert.ok(pageCode.includes("closest('button')"), '从表头的 + / 更多操作按钮上按下不能起拖');
});

test('坑位拖拽：只能同一排内移动，跨排给出提示', () => {
  const start = pageCode.indexOf('const reorderLook =');
  const body = pageCode.slice(start, pageCode.indexOf('// 跨版块移动', start));
  assert.ok(start > 0, 'reorderLook 应存在');
  assert.ok(body.includes('Math.floor(fromIdx / LOOKS_PER_BAND) !== Math.floor(targetIdx / LOOKS_PER_BAND)'), '沿用 moveLook 的同排限制');
  assert.ok(body.includes("toast.error('跨排坑位不能拖拽，请先调整排数')"), '跨排拖拽要提示');
  // 先摘出再按目标位置插入，避免取反后的下标错位
  assert.ok(body.includes('const [moved] = arr.splice(fromIdx, 1);'), '先移除被拖动的坑位');
  assert.ok(body.includes('if (position === \'after\') toIdx += 1;'), '落在右半边插到目标后面');
});
