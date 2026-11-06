// 坑位 / 版块 id：生成与历史重复 id 修复
//
// 线上出现过「跨行拖拽后同一款号画进两列、刷新又正常」：t-111 的同一个版块里
// 有两个坑位 id 都是 L-101。旧生成规则是模块级计数器 `seq`（let seq = 100），
// 每次刷新页面都从 100 重数，隔天再开页面加坑位就又生成 L-101 —— 和上次加的撞了。
// 表头/单元格的 React key 用的是坑位 id，重复 key 时全量挂载照样各画各的（刷新看着正常），
// 一旦列表重排（跨行拖拽是唯一会跨表搬节点的操作）React 按 key 复用节点就会串位。
//
// 所以：① 生成 id 带时间戳 + 随机，永不撞；② 载入货盘时把历史上已经撞了的 id 确定性地改名
// （第二个及以后改成 `L-101-2`），并同步迁移按坑位 id 存的配色/颜色覆盖表。
import type { Tray } from '../data/products';

// 同一个毫秒里连续生成也不能重：随机后缀兜底（36^5 ≈ 6000 万种）
export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// 与坑位 id 绑定的字段：坑位改名时必须跟着搬，否则配色/颜色文案/色号会丢
const LOOK_KEYED_FIELDS = ['colorOverrideByLook', 'colorCodesByLook', 'colorFgByLook', 'codeBgColorByLook', 'codeFgColorByLook'] as const;

function freeId(id: string, seen: Set<string>): string {
  let n = 2;
  while (seen.has(`${id}-${n}`)) n += 1;
  return `${id}-${n}`;
}

/**
 * 修复一份货盘里重复的版块 / 坑位 id。
 * - 确定性改名：第一个保留原 id，后面的依次改成 `原id-2`、`原id-3`（两台客户端算出同一个结果）
 * - 没有重复就原样返回同一个对象（不制造多余渲染和保存）
 */
export function repairDuplicateIds(tray: Tray): Tray {
  if (!tray || !Array.isArray(tray.sections)) return tray;
  const seenSections = new Set<string>();
  // 坑位 id 按整份货盘去重：跨版块重名同样会让 key / 配色表混在一起
  const seenLooks = new Set<string>();
  const renames: [string, string][] = [];
  let changed = false;

  const sections = tray.sections.map((section) => {
    let sectionId = section.id;
    if (seenSections.has(sectionId)) {
      sectionId = freeId(sectionId, seenSections);
      changed = true;
    }
    seenSections.add(sectionId);

    let looksChanged = false;
    const looks = (section.looks || []).map((look) => {
      if (!seenLooks.has(look.id)) {
        seenLooks.add(look.id);
        return look;
      }
      const id = freeId(look.id, seenLooks);
      seenLooks.add(id);
      renames.push([look.id, id]);
      looksChanged = true;
      changed = true;
      return { ...look, id };
    });

    if (sectionId === section.id && !looksChanged) return section;
    return { ...section, id: sectionId, looks };
  });

  if (!changed) return tray;

  const next = { ...tray, sections } as unknown as Record<string, unknown>;
  for (const field of LOOK_KEYED_FIELDS) {
    const map = (tray as unknown as Record<string, Record<string, unknown> | undefined>)[field];
    if (!map) continue;
    let copy: Record<string, unknown> | undefined;
    for (const [from, to] of renames) {
      if (!(from in map) || to in map) continue;
      copy = copy || { ...map };
      copy[to] = map[from];
    }
    if (copy) next[field] = copy;
  }
  return next as unknown as Tray;
}
