// 货盘回收站：保留期与提示文案统一放这里。
// 服务端 trays-store.js 的 TRAYS_TRASH_RETENTION_DAYS 默认值必须与这里保持一致（都是 30 天）。
export const TRASH_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// 删除墓碑：彻底删除的货盘 id + 时间。
// 只从「某一个客户端的数组里删掉」是不够的——其他还开着页面、数据较旧的客户端
// 下一次保存会把它原样带回服务端（彻底删除看起来没生效）。墓碑随货盘一起持久化，
// 服务端和所有客户端都据此拒绝复活。
export interface Tombstone {
  id: string;
  at: string;
  by?: string;
}

// trashedAt 缺失/非法一律当正常货盘，避免界面上误隐藏或误删
export function isTrashExpired(trashedAt?: string | null): boolean {
  if (!trashedAt) return false;
  const at = new Date(trashedAt).getTime();
  return Number.isFinite(at) && Date.now() - at > TRASH_RETENTION_DAYS * DAY_MS;
}

// 这个货盘是否已被彻底删除（墓碑之后又重建/修改过的货盘要保留：按 updatedAt 比时间）
export function isTombstoned(
  tray: { id?: string; updatedAt?: string } | null | undefined,
  tombstones: Tombstone[] | null | undefined,
): boolean {
  if (!tray?.id || !Array.isArray(tombstones) || tombstones.length === 0) return false;
  const tomb = tombstones.find((x) => x?.id === tray.id);
  if (!tomb) return false;
  const at = new Date(tomb.at).getTime();
  if (!Number.isFinite(at)) return false;
  const trayAt = tray.updatedAt ? new Date(tray.updatedAt).getTime() : 0;
  return !Number.isFinite(trayAt) || trayAt <= at;
}

// 过滤掉墓碑货盘；没有可过滤项时返回原数组，避免每 15s 轮询都产生新引用触发重渲染
export function stripTombstoned<T extends { id?: string; updatedAt?: string }>(
  trays: T[],
  tombstones: Tombstone[] | null | undefined,
): T[] {
  if (!Array.isArray(trays) || !Array.isArray(tombstones) || tombstones.length === 0) return trays;
  const kept = trays.filter((t) => !isTombstoned(t, tombstones));
  return kept.length === trays.length ? trays : kept;
}

// 两组墓碑是否等价（id + 时间），用来避免每 15s 轮询都新建数组、触发无意义的保存
export function sameTombstones(a: Tombstone[] | null | undefined, b: Tombstone[] | null | undefined): boolean {
  const x = a || [];
  const y = b || [];
  if (x.length !== y.length) return false;
  return x.every((t) => y.some((u) => u.id === t.id && u.at === t.at));
}

// 合并两边的墓碑（同 id 取较新的），并按保留期裁掉太老的记录
export const TOMBSTONE_KEEP_DAYS = 180;
export function mergeTombstones(
  a: Tombstone[] | null | undefined,
  b: Tombstone[] | null | undefined,
): Tombstone[] {
  const map = new Map<string, Tombstone>();
  for (const t of [...(a || []), ...(b || [])]) {
    if (!t?.id || !t.at) continue;
    const prev = map.get(t.id);
    if (!prev || new Date(t.at).getTime() > new Date(prev.at).getTime()) map.set(t.id, t);
  }
  const cutoff = Date.now() - TOMBSTONE_KEEP_DAYS * DAY_MS;
  return [...map.values()]
    .filter((t) => !(new Date(t.at).getTime() < cutoff))
    .sort((x, y) => String(y.at).localeCompare(String(x.at)));
}


// 回收站里还剩几天可恢复；0 表示今天到期
export function trashDaysLeft(trashedAt?: string | null): number {
  if (!trashedAt) return 0;
  const at = new Date(trashedAt).getTime();
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, Math.ceil((TRASH_RETENTION_DAYS * DAY_MS - (Date.now() - at)) / DAY_MS));
}
