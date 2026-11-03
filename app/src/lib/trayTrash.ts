// 货盘回收站：保留期与提示文案统一放这里。
// 服务端 trays-store.js 的 TRAYS_TRASH_RETENTION_DAYS 默认值必须与这里保持一致（都是 30 天）。
export const TRASH_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// trashedAt 缺失/非法一律当正常货盘，避免界面上误隐藏或误删
export function isTrashExpired(trashedAt?: string | null): boolean {
  if (!trashedAt) return false;
  const at = new Date(trashedAt).getTime();
  return Number.isFinite(at) && Date.now() - at > TRASH_RETENTION_DAYS * DAY_MS;
}

// 回收站里还剩几天可恢复；0 表示今天到期
export function trashDaysLeft(trashedAt?: string | null): number {
  if (!trashedAt) return 0;
  const at = new Date(trashedAt).getTime();
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, Math.ceil((TRASH_RETENTION_DAYS * DAY_MS - (Date.now() - at)) / DAY_MS));
}
