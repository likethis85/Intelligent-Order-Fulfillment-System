// 货盘跨客户端合并：字段级 LWW（后写者赢）
//
// 以前是整盘比较 updatedAt：对方整盘时间戳更新就用对方那一整份覆盖本地，
// 于是「对方只改了售价」也会把本地刚改的面料盖回旧值；反过来本地更新时直接丢弃
// 对方的整条广播，对方的改动在这台机器上永远看不到，下次保存还会把它冲回服务端。
//
// 现在广播带上 changedFields() 算出的「本次真正改了哪些字段」（map 精确到 key，
// 版块精确到版块 id，坑位精确到 sections:版块:坑位），接收方只应用这些字段，
// 并且每个字段单独比较时间戳。
// 没有字段清单的旧消息退回整盘 LWW，行为与以前一致。
import type { Tray } from '../data/products';

// 键控字段：按 key 合并（pid / lookId → 值）
export const KEYED_FIELDS = [
  'fabricOverrides',
  'fabricNotes',
  'costOverrides',
  'priceOverrides',
  'priceSuffixOverrides',
  'mpriceOverrides',
  'mcostOverrides',
  'restockOverrides',
  'restockShortNames',
  'codeSuffixOverrides',
  'sizeRangeOverrides',
  'colorOverrideByLook',
  'colorCodesByLook',
  'plannedRestockAllSkcs',
  'codeBgColorByLook',
  'codeFgColorByLook',
  'customProducts',
] as const;

// 明细数组：按子键去重取并集（远端优先）
const ARRAY_KEY_FIELDS: Record<string, (item: unknown) => string> = {
  plannedRestockItems: (it) =>
    `${String((it as { pdt?: string }).pdt || '').toLowerCase()}|${String((it as { skc?: string }).skc || '').toLowerCase()}|${Number((it as { pieces?: number }).pieces) || 0}|${Number((it as { days?: number }).days) || 0}`,
  sampleRestockItems: (it) =>
    `${String((it as { pdt?: string }).pdt || '').toLowerCase()}|${String((it as { skc?: string }).skc || '').toLowerCase()}|${Number((it as { pieces?: number }).pieces) || 0}|${Number((it as { days?: number }).days) || 0}`,
  noRestockItems: (it) => String((it as { skc?: string }).skc || '').toLowerCase(),
};

// 其余整体替换的字段（值变了就整份取远端；undefined 表示清除该字段）
const PLAIN_FIELDS = [
  'name',
  'date',
  'type',
  'template',
  'viewPerm',
  'editPerm',
  'trashedAt',
  'trashedBy',
  'noRestockSkcs',
  'startTime',
  'seqDisplayMode',
  'seqOrders',
] as const;

export function trayTs(value: unknown): number {
  if (!value) return 0;
  const at = typeof value === 'number' ? value : new Date(String(value)).getTime();
  return Number.isFinite(at) ? at : 0;
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

type AnySection = { id: string; looks?: { id: string }[] } & Record<string, unknown>;

const looksOf = (section: unknown): { id: string }[] =>
  Array.isArray((section as AnySection | undefined)?.looks) ? ((section as AnySection).looks as { id: string }[]) : [];

// 版块除 looks 以外的部分（标题/可见性/是否备用区）
function sectionSansLooks(section: unknown): string {
  if (!section || typeof section !== 'object') return '';
  const { looks: _looks, ...rest } = section as AnySection;
  return JSON.stringify(rest);
}

// 对比前后两份货盘，返回本次真正改动的字段清单：
//   - 键控字段 → `字段:key`（两个人改同一张表的不同行时互不覆盖）
//   - 版块 → `sections:版块id`（两个人改不同版块时互不覆盖）
//   - 坑位 → `sections:版块id:坑位id`（同一版块里两个人改不同坑位时互不覆盖）
//   - 其余字段 → 字段名
export function changedFields(prev: Tray, next: Tray): string[] {
  const out: string[] = [];
  const p = prev as unknown as Record<string, unknown>;
  const n = next as unknown as Record<string, unknown>;

  for (const f of KEYED_FIELDS) {
    const pm = asObj(p[f]);
    const nm = asObj(n[f]);
    for (const k of new Set([...Object.keys(pm), ...Object.keys(nm)])) {
      if (JSON.stringify(pm[k]) !== JSON.stringify(nm[k])) out.push(`${f}:${k}`);
    }
  }

  for (const f of Object.keys(ARRAY_KEY_FIELDS)) {
    if (JSON.stringify(p[f]) !== JSON.stringify(n[f])) out.push(f);
  }

  for (const f of PLAIN_FIELDS) {
    if (JSON.stringify(p[f]) !== JSON.stringify(n[f])) out.push(f);
  }

  // 版块：增删/内容变化按版块 id 单独同步（不影响别人正在改的其它版块）；
  // 只有「版块集合没变、纯调整顺序」时才整份同步（按 id 的差异看不出来顺序变了）
  const pIds = (prev.sections || []).map((s) => s.id);
  const nIds = (next.sections || []).map((s) => s.id);
  const sameSet = pIds.length === nIds.length && [...pIds].sort().join('|') === [...nIds].sort().join('|');
  if (sameSet && pIds.join('|') !== nIds.join('|')) out.push('sections');
  const pm = new Map((prev.sections || []).map((s) => [s.id, s]));
  const nm = new Map((next.sections || []).map((s) => [s.id, s]));
  for (const id of new Set([...pm.keys(), ...nm.keys()])) {
    const before = pm.get(id);
    const after = nm.get(id);
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    // 版块整体新增/删除、坑位增删或换序、版块标题/可见性变化 → 整块同步
    const beforeLooks = looksOf(before).map((l) => l.id);
    const afterLooks = looksOf(after).map((l) => l.id);
    if (!before || !after || beforeLooks.join('|') !== afterLooks.join('|') || sectionSansLooks(before) !== sectionSansLooks(after)) {
      out.push(`sections:${id}`);
      continue;
    }
    // 只有坑位内容变了：按坑位分别同步，两人改同一版块的不同坑位也不互相覆盖
    const beforeById = new Map(looksOf(before).map((l) => [l.id, l]));
    const afterById = new Map(looksOf(after).map((l) => [l.id, l]));
    for (const lookId of afterLooks) {
      if (JSON.stringify(beforeById.get(lookId)) !== JSON.stringify(afterById.get(lookId))) {
        out.push(`sections:${id}:${lookId}`);
      }
    }
  }

  return out;
}

// 整份货盘列表的字段级差异（保存时带给服务端，服务端据此按字段合并，不用整盘覆盖）
export function changedByTray(prevList: Tray[], nextList: Tray[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const prevById = new Map(prevList.map((t) => [t.id, t]));
  for (const t of nextList) {
    const prev = prevById.get(t.id);
    if (!prev) continue;
    const changed = changedFields(prev, t);
    if (changed.length > 0) out[t.id] = changed;
  }
  return out;
}

// 把远端某个字段/某个 key 应用到结果上（结果从本地副本开始，所以未改动的字段天然保留本地）
function applyField(target: Record<string, unknown>, remote: Tray, key: string): void {
  const sep = key.indexOf(':');
  const field = sep > 0 ? key.slice(0, sep) : key;
  const sub = sep > 0 ? key.slice(sep + 1) : null;
  const r = remote as unknown as Record<string, unknown>;

  if (field === 'sections' && sub !== null) {
    // 版块 id 里不含冒号：`sections:<版块>` 是整块同步，`sections:<版块>:<坑位>` 只同步一个坑位
    const cut = sub.indexOf(':');
    const sectionId = cut > 0 ? sub.slice(0, cut) : sub;
    const lookId = cut > 0 ? sub.slice(cut + 1) : null;
    const base = Array.isArray(target.sections) ? [...(target.sections as AnySection[])] : [];
    const idx = base.findIndex((s) => s.id === sectionId);
    const rs = (remote.sections || []).find((s) => s.id === sectionId) as AnySection | undefined;

    if (lookId !== null) {
      // 只换这一个坑位，保留本机对同一版块其它坑位（以及版块标题）的任何改动。
      // 坑位的增删/换序一律走整块同步，所以这里找不到就什么都不做。
      if (!rs || idx < 0) return;
      const looks = Array.isArray(base[idx].looks) ? [...(base[idx].looks as { id: string }[])] : [];
      const li = looks.findIndex((l) => l.id === lookId);
      if (li < 0) return;
      const rl = (rs.looks || []).find((l) => l.id === lookId);
      if (!rl) return;
      looks[li] = rl;
      base[idx] = { ...base[idx], looks };
      target.sections = base;
      return;
    }

    // 按版块 id 替换/新增/删除；基于已合并的结果继续叠加，多个版块改动不会互相盖掉
    if (rs) {
      if (idx >= 0) base[idx] = rs;
      else base.push(rs);
    } else if (idx >= 0) {
      base.splice(idx, 1);
    }
    target.sections = base;
    return;
  }

  if (sub !== null) {
    // 只有键控字段才存在「字段:key」这种粒度（版块在上面的分支里已处理）
    if (!(KEYED_FIELDS as readonly string[]).includes(field)) return;
    const rm = asObj(r[field]);
    const base = { ...asObj(target[field]) };
    if (Object.prototype.hasOwnProperty.call(rm, sub)) base[sub] = rm[sub];
    else delete base[sub];
    target[field] = base;
    return;
  }

  const keyFn = ARRAY_KEY_FIELDS[field];
  if (keyFn) {
    target[field] = applyArrayUnion(r[field] as unknown[], target[field] as unknown[], keyFn);
    return;
  }

  const v = r[field];
  if (v === undefined) delete target[field];
  else target[field] = v;
}

export interface MergeResult {
  tray: Tray;
  applied: string[]; // 实际采纳的远端字段（供调用方记录字段版本时间）
}

// 合并远端广播：
//   changed 为空/缺失 → 退回整盘 LWW（兼容没有字段清单的旧消息）
//   fieldTimes[key] > remoteAt → 本地这个字段改得更晚，保留本地
export function mergeTray(
  local: Tray,
  remote: Tray,
  changed?: string[],
  fieldTimes: Record<string, number> = {},
): MergeResult {
  const localAt = trayTs(local.updatedAt);
  const remoteAt = trayTs(remote.updatedAt);

  if (!Array.isArray(changed) || changed.length === 0) {
    if (localAt && remoteAt && localAt > remoteAt) return { tray: local, applied: [] };
    const merged: Record<string, unknown> = { ...(local as unknown as Record<string, unknown>), ...(remote as unknown as Record<string, unknown>) };
    for (const f of KEYED_FIELDS) {
      const rk = (remote as unknown as Record<string, Record<string, unknown>>)[f];
      const lk = (local as unknown as Record<string, Record<string, unknown>>)[f];
      if (rk || lk) merged[f] = { ...(lk || {}), ...(rk || {}) };
    }
    for (const f of Object.keys(ARRAY_KEY_FIELDS)) {
      const rk = (remote as unknown as Record<string, unknown[]>)[f];
      const lk = (local as unknown as Record<string, unknown[]>)[f];
      if (!rk && !lk) continue;
      merged[f] = applyArrayUnion(rk, lk, ARRAY_KEY_FIELDS[f]);
    }
    return { tray: merged as unknown as Tray, applied: [] };
  }

  const merged: Record<string, unknown> = { ...(local as unknown as Record<string, unknown>) };
  const applied: string[] = [];
  for (const key of changed) {
    const mine = fieldTimes[key] ?? 0;
    if (mine > remoteAt) continue;
    applyField(merged, remote, key);
    applied.push(key);
  }
  merged.updatedAt = remoteAt >= localAt ? remote.updatedAt : local.updatedAt;
  return { tray: merged as unknown as Tray, applied };
}

function applyArrayUnion(remoteItems: unknown[] | undefined, localItems: unknown[] | undefined, keyFn: (it: unknown) => string): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const it of [...(remoteItems || []), ...(localItems || [])]) {
    const k = keyFn(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}
