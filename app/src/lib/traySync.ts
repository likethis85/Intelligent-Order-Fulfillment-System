// 货盘多人实时协同：WebSocket 客户端 + 字段级合并 + 变更描述生成
// 合并规则见 lib/trayMerge.ts（广播带改动字段清单，接收方只应用这些字段）
import { useEffect, useRef } from 'react';
import type { Tray } from '../data/products';
import { API_BASE, API_ORIGIN, authenticatedFetch } from '@/lib/api-client';
import { mergeTray, changedFields, changedByTray, trayTs } from './trayMerge';

export { mergeTray, changedFields, changedByTray };

export interface TrayOp {
  action: string;
  detail: string;
  change?: string; // 修改前后的值（如 "483.86 → 572.9"）
}

function valStr(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    const o = v as { id?: string; name?: string; colors?: string[] };
    const colorStr = o.colors && o.colors.length > 0 ? ` (${o.colors.join('/')})` : '';
    return o.name ? `${o.id || ''}:${o.name}${colorStr}` : JSON.stringify(o);
  }
  return String(v);
}

function fmtKeys(prev: Record<string, unknown> | undefined, next: Record<string, unknown> | undefined): string {
  const p = prev || {};
  const n = next || {};
  const changed = Object.keys({ ...p, ...n }).filter((k) => valStr(p[k]) !== valStr(n[k]));
  if (changed.length === 0) return '';
  const shown = changed.slice(0, 3).join('、');
  return changed.length > 3 ? `${shown} 等${changed.length}款` : shown;
}

// 每个变化 key 的「旧值 → 新值」文案（最多 3 条），让修改记录能看清改了什么
function fmtKeyChanges(prev: Record<string, unknown> | undefined, next: Record<string, unknown> | undefined): string {
  const p = prev || {};
  const n = next || {};
  const changed = Object.keys({ ...p, ...n }).filter((k) => valStr(p[k]) !== valStr(n[k]));
  if (changed.length === 0) return '';
  const lines = changed.slice(0, 3).map((k) => {
    const clip = (s: string) => (s.length > 40 ? `${s.slice(0, 40)}…` : s);
    const oldV = clip(valStr(p[k]).trim()) || '（空）';
    const newV = clip(valStr(n[k]).trim()) || '（清除）';
    return `${k.toUpperCase()}: ${oldV} → ${newV}`;
  });
  return changed.length > 3 ? `${lines.join('；')} 等${changed.length}款` : lines.join('；');
}

function countLooks(t: Tray): number {
  return (t.sections || []).reduce((n, s) => n + (s.looks?.length || 0), 0);
}

// 对比前后 tray 生成操作描述（谁改了什么的文案）
export function diffTray(prev: Tray, next: Tray): TrayOp[] {
  const ops: TrayOp[] = [];
  const put = (action: string, detail: string, change?: string) => {
    if (detail || change) ops.push({ action, detail, change });
  };

  put('面料', fmtKeys(prev.fabricOverrides, next.fabricOverrides), fmtKeyChanges(prev.fabricOverrides, next.fabricOverrides));
  put('面料注脚', fmtKeys(prev.fabricNotes, next.fabricNotes), fmtKeyChanges(prev.fabricNotes, next.fabricNotes));
  put('成本', fmtKeys(prev.costOverrides, next.costOverrides), fmtKeyChanges(prev.costOverrides, next.costOverrides));
  put('马总成本', fmtKeys(prev.mcostOverrides, next.mcostOverrides), fmtKeyChanges(prev.mcostOverrides, next.mcostOverrides));
  put('售价', fmtKeys(prev.priceOverrides, next.priceOverrides), fmtKeyChanges(prev.priceOverrides, next.priceOverrides));
  put('售价注脚', fmtKeys(prev.priceSuffixOverrides, next.priceSuffixOverrides), fmtKeyChanges(prev.priceSuffixOverrides, next.priceSuffixOverrides));
  put('马总价', fmtKeys(prev.mpriceOverrides, next.mpriceOverrides), fmtKeyChanges(prev.mpriceOverrides, next.mpriceOverrides));
  put('翻单', fmtKeys(prev.restockOverrides, next.restockOverrides), fmtKeyChanges(prev.restockOverrides, next.restockOverrides));
  put('款号注脚', fmtKeys(prev.codeSuffixOverrides, next.codeSuffixOverrides), fmtKeyChanges(prev.codeSuffixOverrides, next.codeSuffixOverrides));
  put('尺码', fmtKeys(prev.sizeRangeOverrides, next.sizeRangeOverrides), fmtKeyChanges(prev.sizeRangeOverrides, next.sizeRangeOverrides));
  put('商品修饰名', fmtKeys(prev.restockShortNames, next.restockShortNames), fmtKeyChanges(prev.restockShortNames, next.restockShortNames));
  put('款号背景色', fmtKeys(prev.codeBgColorByLook, next.codeBgColorByLook), fmtKeyChanges(prev.codeBgColorByLook, next.codeBgColorByLook));
  put('款号字体色', fmtKeys(prev.codeFgColorByLook, next.codeFgColorByLook), fmtKeyChanges(prev.codeFgColorByLook, next.codeFgColorByLook));
  put('自定义款', fmtKeys(prev.customProducts, next.customProducts), fmtKeyChanges(prev.customProducts, next.customProducts));

  const pn = (prev.noRestockItems?.length || 0) + (prev.noRestockSkcs?.length || 0);
  const nn = (next.noRestockItems?.length || 0) + (next.noRestockSkcs?.length || 0);
  if (nn !== pn) put('无面料不翻单', nn > pn ? `新增标记（共${nn}条）` : `取消标记（剩${nn}条）`, `${pn} 条 → ${nn} 条`);

  const pr = prev.plannedRestockItems?.length || 0;
  const nr = next.plannedRestockItems?.length || 0;
  if (nr !== pr) put('计划翻单量', `批次 ${pr} → ${nr}`, `${pr} 批 → ${nr} 批`);

  const ps = prev.sections?.length || 0;
  const ns = next.sections?.length || 0;
  if (ns !== ps) put('版块', ns > ps ? `新增版块（共${ns}个）` : `删除版块（剩${ns}个）`);
  else if (JSON.stringify(prev.sections) !== JSON.stringify(next.sections)) {
    const pa = countLooks(prev);
    const na = countLooks(next);
    put('版块/坑位', '调整了结构', pa !== na ? `坑位 ${pa} → ${na}` : undefined);
  }

  if (prev.name !== next.name) put('货盘名', `${prev.name} → ${next.name}`);
  if (prev.date !== next.date) put('日期', `${prev.date} → ${next.date}`);

  if (ops.length === 0) {
    const a = countLooks(prev);
    const b = countLooks(next);
    if (a !== b) put('坑位', `${a} → ${b}`);
    else put('内容', '更新了货盘');
  }
  return ops.slice(0, 6);
}

export function fetchTrayLog(trayId: string, limit = 200): Promise<{ ok: boolean; entries: TrayOpLogEntry[] }> {
  return authenticatedFetch(`${API_BASE}/trays/log?trayId=${encodeURIComponent(trayId)}&limit=${limit}`)
    .then((r) => (r.ok ? r.json() : { ok: false, entries: [] }))
    .catch(() => ({ ok: false, entries: [] }));
}

export interface TrayOpLogEntry {
  id: string;
  at: string;
  user: string;
  trayId: string;
  trayName?: string;
  action: string;
  detail: string;
  change?: string;
}

export interface StockSyncedEvent {
  type: 'stock-synced';
  at: string;
  count: number;
  message?: string;
}

// ── WS 客户端 hook ──
// activeTrayId 变化时切 room；收 tray-updated 按「改动字段」合并进 setTrays；收 stock-synced 通知库存更新
export function useTraySync(
  activeTrayId: string | null,
  userName: string,
  setTrays: React.Dispatch<React.SetStateAction<Tray[]>>,
  onRemoteUpdate: (user: string, trayName: string) => void,
  onStockSynced?: (event: StockSyncedEvent) => void,
) {
  const wsRef = useRef<WebSocket | null>(null);
  const trayIdRef = useRef<string | null>(activeTrayId);
  const setTraysRef = useRef(setTrays);
  const onRemoteRef = useRef(onRemoteUpdate);
  const onStockSyncedRef = useRef(onStockSynced);
  const userRef = useRef(userName);
  // 每个货盘里「每个字段最后一次改动的本机时间」：接收远端广播时用来判断这个字段要不要采纳
  // （本地刚改过的字段，比对方那条广播更新，保留本地；其余字段照常采纳对方的改动）
  const fieldTimesRef = useRef<Map<string, Record<string, number>>>(new Map());
  trayIdRef.current = activeTrayId;
  setTraysRef.current = setTrays;
  onRemoteRef.current = onRemoteUpdate;
  onStockSyncedRef.current = onStockSynced;
  userRef.current = userName;

  useEffect(() => {
    let closed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let ws: WebSocket | null = null;

    const connect = () => {
      if (closed) return;
      const url = API_ORIGIN.replace(/^http/, 'ws') + '/ws/trays';
      try {
        ws = new WebSocket(url);
      } catch {
        retryTimer = setTimeout(connect, 3000);
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        ws?.send(JSON.stringify({ type: 'hello', user: userRef.current, trayId: trayIdRef.current }));
      };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'stock-synced') {
          onStockSyncedRef.current?.(msg as StockSyncedEvent);
          return;
        }
        if (msg.type === 'tray-updated' && msg.tray?.id) {
          const remote = msg.tray as Tray;
          const changed = Array.isArray(msg.changed) ? (msg.changed as string[]) : undefined;
          setTraysRef.current((ts) => {
            const local = ts.find((t) => t.id === remote.id);
            if (!local) {
              // 本地还没有这个货盘（对方新建）→ 直接加进来
              return [...ts, remote];
            }
            const times = fieldTimesRef.current.get(remote.id) || {};
            const { tray: merged, applied } = mergeTray(local, remote, changed, times);
            if (applied.length > 0) {
              // 记录这些字段的版本时间，之后比它更旧的广播不会再把它们改回去
              const at = trayTs(remote.updatedAt);
              for (const k of applied) times[k] = at;
              fieldTimesRef.current.set(remote.id, times);
            }
            if (JSON.stringify(merged) === JSON.stringify(local)) return ts;
            return ts.map((t) => (t.id === merged.id ? merged : t));
          });
          if (msg.user !== userRef.current) {
            onRemoteRef.current(msg.user || '有人', remote.name || '');
          }
        }
      };
      ws.onclose = () => {
        wsRef.current = null;
        if (!closed) retryTimer = setTimeout(connect, 3000);
      };
      ws.onerror = () => {
        try { ws?.close(); } catch { /* ignore */ }
      };
    };

    connect();
    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      try { ws?.close(); } catch { /* ignore */ }
      wsRef.current = null;
    };
  }, []);

  // activeTrayId 变化 → 换 room
  useEffect(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'hello', user: userRef.current, trayId: activeTrayId }));
    }
  }, [activeTrayId]);

  // 暴露 broadcast（App.tsx 在 setTrays 后调用）
  // changed = 本次真正改动的字段（changedFields 的结果），接收方只应用这些字段
  return {
    broadcast: (tray: Tray, ops: TrayOp[], changed?: string[]) => {
      if (Array.isArray(changed) && changed.length > 0) {
        const times = fieldTimesRef.current.get(tray.id) || {};
        const at = trayTs(tray.updatedAt) || Date.now();
        for (const k of changed) times[k] = at;
        fieldTimesRef.current.set(tray.id, times);
      }
      const ws = wsRef.current;
      if (!ws || ws.readyState !== 1 || ops.length === 0) return;
      try {
        ws.send(JSON.stringify({ type: 'tray-update', user: userRef.current, tray, ops, changed }));
      } catch { /* ignore */ }
    },
  };
}
