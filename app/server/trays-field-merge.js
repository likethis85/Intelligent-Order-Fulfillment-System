// 货盘字段级合并（服务端侧）
//
// 客户端每次保存的是「全部货盘」，并且带上 changedByTray（本次真正改了哪些字段）。
// 以前服务端整盘覆盖：A 没打开过的货盘在他本机只是旧副本，一保存就把同事刚改的版本冲掉。
// 现在对带字段清单的货盘，以库里的版本为底，只套用客户端声明的这些字段，其余字段保留
// 服务端的值 —— 两个人同时改同一货盘的不同字段时，后到的保存不会把先到的改动冲掉。
//
// 粒度：键控字段到 key，版块到 sections:<id>，坑位到 sections:<id>:<lookId>
// （同一版块里两个人改不同坑位时互不覆盖；坑位增删/换序仍整块同步）。
// 口径必须与前端 src/lib/trayMerge.ts 的 applyField 保持一致（tests/collab-field-merge 有对照）。

const KEYED_FIELDS = new Set([
  'fabricOverrides',
  'fabricNotes',
  'fabricHiddenLines',
  'costOverrides',
  'priceOverrides',
  'priceSuffixOverrides',
  'costSuffixOverrides',
  'mpriceOverrides',
  'mcostOverrides',
  'restockOverrides',
  'restockShortNames',
  'codeSuffixOverrides',
  'sizeRangeOverrides',
  'colorOverrideByLook',
  'colorCodesByLook',
  'colorFgByLook',
  'plannedRestockAllSkcs',
  'codeBgColorByLook',
  'codeFgColorByLook',
  'customProducts',
]);

// 明细数组：按子键去重取并集（远端优先）
const ARRAY_KEY_FIELDS = {
  plannedRestockItems: (it) =>
    `${String(it?.pdt || '').toLowerCase()}|${String(it?.skc || '').toLowerCase()}|${Number(it?.pieces) || 0}|${Number(it?.days) || 0}`,
  sampleRestockItems: (it) =>
    `${String(it?.pdt || '').toLowerCase()}|${String(it?.skc || '').toLowerCase()}|${Number(it?.pieces) || 0}|${Number(it?.days) || 0}`,
  noRestockItems: (it) => String(it?.skc || '').toLowerCase(),
};

function asObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

function tsOf(value) {
  if (!value) return 0;
  const at = typeof value === 'number' ? value : new Date(String(value)).getTime();
  return Number.isFinite(at) ? at : 0;
}

function applyArrayUnion(incomingItems, baseItems, keyFn) {
  const seen = new Set();
  const out = [];
  for (const it of [...(Array.isArray(incomingItems) ? incomingItems : []), ...(Array.isArray(baseItems) ? baseItems : [])]) {
    const k = keyFn(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

function applyField(target, incoming, key) {
  const sep = key.indexOf(':');
  const field = sep > 0 ? key.slice(0, sep) : key;
  const sub = sep > 0 ? key.slice(sep + 1) : null;

  if (field === 'sections' && sub !== null) {
    // 版块 id 里不含冒号：`sections:<版块>` 是整块同步，`sections:<版块>:<坑位>` 只同步一个坑位
    const cut = sub.indexOf(':');
    const sectionId = cut > 0 ? sub.slice(0, cut) : sub;
    const lookId = cut > 0 ? sub.slice(cut + 1) : null;
    const base = Array.isArray(target.sections) ? [...target.sections] : [];
    const idx = base.findIndex((s) => s?.id === sectionId);
    const rs = (incoming.sections || []).find((s) => s?.id === sectionId);

    if (lookId !== null) {
      // 只换这一个坑位，保留服务端对同一版块其它坑位的改动。
      // 坑位的增删/换序一律走整块同步，所以这里找不到就什么都不做。
      if (!rs || idx < 0) return;
      const looks = Array.isArray(base[idx]?.looks) ? [...base[idx].looks] : [];
      const li = looks.findIndex((l) => l?.id === lookId);
      if (li < 0) return;
      const rl = (rs.looks || []).find((l) => l?.id === lookId);
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
    if (!KEYED_FIELDS.has(field)) return;
    const im = asObj(incoming[field]);
    const base = { ...asObj(target[field]) };
    if (Object.prototype.hasOwnProperty.call(im, sub)) base[sub] = im[sub];
    else delete base[sub];
    target[field] = base;
    return;
  }

  const keyFn = ARRAY_KEY_FIELDS[field];
  if (keyFn) {
    target[field] = applyArrayUnion(incoming[field], target[field], keyFn);
    return;
  }

  const v = incoming[field];
  if (v === undefined) delete target[field];
  else target[field] = v;
}

// 以 prev（服务端版本）为底，套用 incoming 声明的改动字段
export function applyChangedFields(prev, incoming, changed) {
  if (!prev || !incoming || !Array.isArray(changed) || changed.length === 0) return incoming;
  const merged = { ...prev };
  for (const key of changed) {
    if (typeof key === 'string' && key) applyField(merged, incoming, key);
  }
  merged.updatedAt = tsOf(incoming.updatedAt) >= tsOf(prev.updatedAt) ? incoming.updatedAt : prev.updatedAt;
  return merged;
}
