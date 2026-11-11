// 「商品全表」ETL 数据集的本地快照
//
// 为什么不再实时查 BI：
//   选款看板一次要几千个款号的「近14天销量」，实时查要么拆成大量小请求把 BI 挤到 25s 超时，
//   要么拖垮用户请求。这个数据集由 BI 每天刷新一次，我们跟着每天下一次快照，
//   之后所有查询都读本地文件（毫秒级），不再有任何 BI 往返。
//
// 快照内容（一次下载三份数据，都来自同一张商品全表，避免零散查 BI）：
//   款式编码 → { s: 近14天销量, c: BOM 商品成本, z: [尺码名称调整...] }
//     · s 跨 SKC/颜色行相加，只累加正数（退货负数不计入销量）
//     · c 跨 SKC 取最大值，保留 1 位小数（与 cost-client 原口径一致）
//     · z 去重后的尺码集合，过滤「上新年份 = 未采购未上架」的行（与 size-client 原口径一致）
// 刷新时机：
//   - 每天定时（随 bi-schedule 的 10:00 一起跑，串行排在两张卡之后）
//   - 进程启动后首次查询发现快照缺失/超过 24h：后台补下一次（不阻塞请求）
// 文件：server/.cache/product_snapshot.json

import { runGuancli } from './guancli.js';
import { mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CACHE_DIR = join(__dirname, '.cache');
export const SNAPSHOT_FILE = join(CACHE_DIR, 'product_snapshot.json');

export const PRODUCT_DS_ID = 'g94553b7c10714125a095ea8';
// 字段名在不同 ETL 版本里叫法可能不同：按顺序探测，成功后把用到的列名写进快照
const SALES14D_COLUMNS = ['近14天销量', '近14天净销量', '近14天销售量', '最近14天销量'];
const EXTRA_COLUMNS = ['bom商品成本', '尺码名称调整', '上新年份'];
const DOWNLOAD_TIMEOUT_MS = 180_000; // 分年拉，每年一万多行
const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_VERSION = 2;

let mem = null;          // { at, date, column, byCode: Map<upperCode, {s,c,z:Set}> }
let loadedAt = 0;
let downloading = null;  // Promise，防止并发下载

// CSV → 行对象（只取需要的列）
export function parseRows(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = lines[0].split(',').map((s) => s.trim());
  const idx = (name) => header.indexOf(name);
  const iCode = idx('款式编码');
  if (iCode < 0) return [];
  const iQty = 1; // 列顺序固定为 款式编码,<销量列>,bom商品成本,尺码名称调整,上新年份
  const iCost = idx('bom商品成本');
  const iSize = idx('尺码名称调整');
  const iYear = idx('上新年份');
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    if (cells.length <= iQty) continue;
    out.push({
      code: String(cells[iCode] || '').trim(),
      qty: Number(cells[iQty]),
      cost: iCost >= 0 ? Number(cells[iCost]) : Number.NaN,
      size: iSize >= 0 ? String(cells[iSize] || '').trim() : '',
      year: iYear >= 0 ? String(cells[iYear] || '').trim() : '',
    });
  }
  return out;
}

// 把 SKC/颜色行按款号相加（退货负数不计入销量）——保留给近14天销量单独使用
export function sumByCode(rows) {
  const sums = new Map();
  for (const [codeRaw, qty] of rows) {
    const code = String(codeRaw || '').trim().toUpperCase();
    if (!code || code === '总计' || code === '小计') continue;
    if (!Number.isFinite(qty) || qty <= 0) continue;
    sums.set(code, (sums.get(code) || 0) + qty);
  }
  return sums;
}

// 行 → 每款 { s: 近14天销量合计, c: BOM 成本最大值, z: 尺码集合 }
export function aggregateRows(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const code = String(r.code || '').trim().toUpperCase();
    if (!code || code === '总计' || code === '小计') continue;
    let e = map.get(code);
    if (!e) {
      e = { s: 0, c: 0, z: new Set() };
      map.set(code, e);
    }
    const qty = Number(r.qty);
    if (Number.isFinite(qty) && qty > 0) e.s += qty;
    const cost = Number(r.cost);
    // 负数 / NaN 视为脏数据；0 保留（可能是录入中 / 数据缺失占位），取最大值
    if (Number.isFinite(cost) && cost >= 0) e.c = Math.max(e.c, Math.round(cost * 10) / 10);
    const size = String(r.size || '').trim();
    if (size && r.year !== '未采购未上架') e.z.add(size);
  }
  return map;
}

function normalizeEntry(v) {
  // 兼容 v1 快照：byCode 直接是数字（只有近14天销量）
  if (typeof v === 'number') return { s: v, c: 0, z: new Set() };
  if (!v || typeof v !== 'object') return null;
  return { s: Number(v.s) || 0, c: Number(v.c) || 0, z: new Set(Array.isArray(v.z) ? v.z : []) };
}

async function loadFromDisk() {
  if (mem && Date.now() - loadedAt < 60_000) return mem;
  loadedAt = Date.now();
  if (!existsSync(SNAPSHOT_FILE)) {
    mem = null;
    return null;
  }
  try {
    const j = JSON.parse(await readFile(SNAPSHOT_FILE, 'utf8'));
    if (!j || !j.byCode) { mem = null; return null; }
    const byCode = new Map();
    for (const [k, v] of Object.entries(j.byCode)) {
      const e = normalizeEntry(v);
      if (e) byCode.set(String(k).toUpperCase(), e);
    }
    mem = { at: Number(j.at) || 0, date: String(j.date || ''), column: String(j.column || ''), byCode };
    return mem;
  } catch {
    mem = null;
    return null;
  }
}

export function isSnapshotStale(snap, now = Date.now()) {
  return !snap || !snap.at || now - snap.at >= SNAPSHOT_TTL_MS;
}

// 整拉 5.8 万行会被 BI 网关判 524（剩余库存那个数据集就是这个毛病），
// 按「款上新时间」分年拉，每年一万多行秒回；尾段 GE 明年兜住 9999 占位与未来年份
export function partitionFilters(now = new Date()) {
  const thisYear = now.getFullYear();
  const filters = [];
  for (let y = 2019; y <= thisYear; y++) filters.push(`款上新时间 BT ${y}-01-01,${y}-12-31`);
  filters.push(`款上新时间 GE ${thisYear + 1}-01-01`);
  return filters;
}

async function fetchPartition(column, filter) {
  const csv = await runGuancli(
    ['ds', 'preview', PRODUCT_DS_ID, '--columns', ['款式编码', column, ...EXTRA_COLUMNS].join(','), '--filter', filter, '--limit', '60000', '-f', 'csv'],
    { timeoutMs: DOWNLOAD_TIMEOUT_MS, lane: 'background' },
  );
  return parseRows(csv);
}

/**
 * 下载并落盘快照。已在下载时复用同一个 Promise。
 * @returns {Promise<{ at: number, date: string, column: string, count: number, withCost: number, withSize: number }>}
 */
export function downloadProductSnapshot() {
  if (downloading) return downloading;
  downloading = (async () => {
    const rows = [];
    let usedCol = '';
    let lastErr = null;
    for (const filter of partitionFilters()) {
      if (!usedCol) {
        // 第一段用来探测字段名（不同 ETL 版本叫法可能不同）
        for (const col of SALES14D_COLUMNS) {
          try {
            rows.push(...(await fetchPartition(col, filter)));
            usedCol = col;
            break;
          } catch (err) {
            lastErr = err;
          }
        }
        if (!usedCol) throw new Error(`商品全表下载失败（已试 ${SALES14D_COLUMNS.join('/')}）：${lastErr?.message || '无数据'}`);
      } else {
        rows.push(...(await fetchPartition(usedCol, filter)));
      }
    }

    const agg = aggregateRows(rows);
    const at = Date.now();
    const date = new Date(at + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const byCode = {};
    let withCost = 0;
    let withSize = 0;
    for (const code of [...agg.keys()].sort()) {
      const e = agg.get(code);
      byCode[code] = { s: e.s, c: e.c, z: [...e.z] };
      if (e.c > 0) withCost++;
      if (e.z.size > 0) withSize++;
    }
    await mkdir(CACHE_DIR, { recursive: true });
    const tmp = `${SNAPSHOT_FILE}.tmp`;
    await writeFile(tmp, JSON.stringify({ v: SNAPSHOT_VERSION, at, date, column: usedCol, byCode }), 'utf8');
    await rename(tmp, SNAPSHOT_FILE);
    mem = { at, date, column: usedCol, byCode: agg };
    loadedAt = Date.now();
    console.log(`[product-snapshot] 已更新：${agg.size} 个款号（成本 ${withCost} / 尺码 ${withSize}），字段「${usedCol}」`);
    return { at, date, column: usedCol, count: agg.size, withCost, withSize };
  })().finally(() => { downloading = null; });
  return downloading;
}

// 快照原始数据（成本 / 尺码客户端复用）：{ at, date, byCode: Map<code, {s,c,z}> }
export async function getSnapshotData({ triggerRefresh = true } = {}) {
  const snap = await loadFromDisk();
  if (isSnapshotStale(snap) && triggerRefresh) {
    downloadProductSnapshot().catch((err) => console.warn('[product-snapshot] 后台刷新失败:', err.message));
  }
  return snap;
}

/**
 * 查询快照里的近14天销量（只读本地，绝不触发 BI；快照缺失/过期时后台补一次）
 */
export async function getSales14dFromSnapshot(pids, { triggerRefresh = true } = {}) {
  const snap = await getSnapshotData({ triggerRefresh });
  const out = {};
  for (const raw of pids || []) {
    const code = String(raw).toUpperCase().trim();
    if (!code) continue;
    const e = snap?.byCode.get(code);
    if (!e) continue;
    out[code] = e.s;
    out[code.toLowerCase()] = e.s;
  }
  return { byPid: out, ready: !!snap, at: snap?.at || 0, date: snap?.date || '' };
}

export function getSnapshotStatus() {
  return { ready: !!mem, at: mem?.at || 0, date: mem?.date || '', column: mem?.column || '', count: mem?.byCode.size || 0 };
}

// 单测用：重置内存态
export function __resetSnapshotForTest() {
  mem = null;
  loadedAt = 0;
  downloading = null;
}
