import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { format } from "date-fns"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// 把 ISO 时间或 YYYY-MM-DD 转成 "yyyy/M/d HH:mm:ss"（翻单清单登记时间列）
// 空值返回空串，非法输入原样回退
export function formatTimestamp(ts?: string | null): string {
  if (!ts) return '';
  // createdAt 形如 "2026-09-30"（10 字符），补 T00:00:00 让本地时区解析为当天
  const d = ts.length === 10 ? new Date(`${ts}T00:00:00`) : new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return format(d, 'yyyy/M/d HH:mm:ss');
}
