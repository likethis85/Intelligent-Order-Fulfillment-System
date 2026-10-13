// 货盘多人实时协同：WebSocket 客户端 + 键级合并 + 变更描述生成
import { useEffect, useRef } from 'react';
import type { Tray } from '../data/products';
import { API_BASE, API_ORIGIN, authenticatedFetch } from '@/lib/api-client';

export interface TrayOp {
  action: string;
  detail: string;
  change?: string; // 修改前后的值（如 "483.86 → 572.9"）
}

// 键控字段：远端较新时按远端覆盖本地（保证接收方能看到发送方的最新值）
const KEYED_FIELDS = [
  'fabricOverrides',
  'fabricNotes',
  'costOverrides',
  'priceOverrides',
  'mpriceOverrides',
  'mcostOverrides',
  'restockOverrides',
  'codeSuffixOverrides',
  'plannedRestockAllSkcs',
] as const;

// 数组成员按稳定子键去重合并（先到的优先 → 远端优先）
const ARRAY_FIELDS: Record<string, (a: unknown) => string> = {
  plannedRestockItems: (it) => `${String((it as { pdt?: string }).pdt || '').toLowerCase()}|${String((it as { skc?: string }).skc || '').toLowerCase()}|${Number((it as { pieces?: number }).pieces) || 0}|${Number((it as { days?: number }).days) || 0}`,
  noRestockItems: (it) => String((it as { skc?: string }).skc || '').toLowerCase(),
};

// 远端后写赢：按 tray.updatedAt 比较，本地较新就保留本地，远程较新就把远端值铺到结果上。
// 这样保证接收方看到发送方的最新修改（不会因为本地旧值覆盖掉远端新值）。
// 数组字段（plannedRestockItems / noRestockItems）按子键去重，先出现的优先 → 远端优先。
export function mergeTray(local: Tray, remote: Tray): Tray {
  const localAt = local.updatedAt ? new Date(local.updatedAt).getTime() : 0;
  const remoteAt = remote.updatedAt ? new Date(remote.updatedAt).getTime() : 0;
  // 本地刚刚广播过（localAt 更新）→ 保留本地，避免同事的旧广播覆盖用户正在编辑的值
  if (localAt && remoteAt && localAt > remoteAt) return local;

  // 远端较新（或相等）→ 远端覆盖
  const merged: Tray = { ...local, ...remote } as Tray;
  for (const f of KEYED_FIELDS) {
    const rk = (remote as unknown as Record<string, Record<string, unknown>>)[f];
    const lk = (local as unknown as Record<string, Record<string, unknown>>)[f];
    if (rk || lk) {
      (merged as unknown as Record<string, Record<string, unknown>>)[f] = {
        ...(lk || {}),
        ...(rk || {}),
      };
    }
  }
  for (const [f, keyFn] of Object.entries(ARRAY_FIELDS)) {
    const rk = (remote as unknown as Record<string, unknown[]>)[f];
    const lk = (local as unknown as Record<string, unknown[]>)[f];
    if (!rk && !lk) continue;
    const seen = new Set<string>();
    const out: unknown[] = [];
    for (const it of [...(rk || []), ...(lk || [])]) {
      const k = keyFn(it);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(it);
    }
    (merged as unknown as Record<string, unknown[]>)[f] = out;
  }
  return merged;
}

function fmtKeys(prev: Record<string, unknown> | undefined, next: Record<string, unknown> | undefined): string {
  const p = prev || {};
  const n = next || {};
  const changed = Object.keys({ ...p, ...n }).filter((k) => String(p[k] ?? '') !== String(n[k] ?? ''));
  if (changed.length === 0) return '';
  const shown = changed.slice(0, 3).join('、');
  return changed.length > 3 ? `${shown} 等${changed.length}款` : shown;
}

// 每个变化 key 的「旧值 → 新值」文案（最多 3 条），让修改记录能看清改了什么
function fmtKeyChanges(prev: Record<string, unknown> | undefined, next: Record<string, unknown> | undefined): string {
  const p = prev || {};
  const n = next || {};
  const changed = Object.keys({ ...p, ...n }).filter((k) => String(p[k] ?? '') !== String(n[k] ?? ''));
  if (changed.length === 0) return '';
  const lines = changed.slice(0, 3).map((k) => {
    const clip = (s: string) => (s.length > 40 ? `${s.slice(0, 40)}…` : s);
    const oldV = clip(String(p[k] ?? '').trim()) || '（空）';
    const newV = clip(String(n[k] ?? '').trim()) || '（清除）';
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
  put('马总价', fmtKeys(prev.mpriceOverrides, next.mpriceOverrides), fmtKeyChanges(prev.mpriceOverrides, next.mpriceOverrides));
  put('翻单', fmtKeys(prev.restockOverrides, next.restockOverrides), fmtKeyChanges(prev.restockOverrides, next.restockOverrides));
  put('款号注脚', fmtKeys(prev.codeSuffixOverrides, next.codeSuffixOverrides), fmtKeyChanges(prev.codeSuffixOverrides, next.codeSuffixOverrides));

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

// ── WS 客户端 hook ──
// activeTrayId 变化时切 room；收 tray-updated 按键级合并进 setTrays
export function useTraySync(
  activeTrayId: string | null,
  userName: string,
  setTrays: React.Dispatch<React.SetStateAction<Tray[]>>,
  onRemoteUpdate: (user: string, trayName: string) => void,
) {
  const wsRef = useRef<WebSocket | null>(null);
  const trayIdRef = useRef<string | null>(activeTrayId);
  const setTraysRef = useRef(setTrays);
  const onRemoteRef = useRef(onRemoteUpdate);
  const userRef = useRef(userName);
  trayIdRef.current = activeTrayId;
  setTraysRef.current = setTrays;
  onRemoteRef.current = onRemoteUpdate;
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
        if (msg.type === 'tray-updated' && msg.tray?.id) {
          const remote = msg.tray as Tray;
          setTraysRef.current((ts) => {
            const local = ts.find((t) => t.id === remote.id);
            if (!local) {
              // 本地还没有这个货盘（对方新建）→ 直接加进来
              return [...ts, remote];
            }
            const merged = mergeTray(local, remote);
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
  return {
    broadcast: (tray: Tray, ops: TrayOp[]) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== 1 || ops.length === 0) return;
      try {
        ws.send(JSON.stringify({ type: 'tray-update', user: userRef.current, tray, ops }));
      } catch { /* ignore */ }
    },
  };
}
