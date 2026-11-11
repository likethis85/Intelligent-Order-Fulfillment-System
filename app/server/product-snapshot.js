// 「商品全表」ETL 数据集（g94553b7c10714125a095ea8）的本地快照
//
// 为什么不再实时查 BI：
//   选款看板一次要几千个款号的「近14天销量」，实时查要么拆成大量小请求把 BI 挤到 25s 超时，
//   要么拖垮用户请求。这个数据集由 BI 每天刷新一次，我们跟着每天下一次快照，
//   之后所有查询都读本地文件（毫秒级），不再有任何 BI 往返。
//
// 快照内容：款式编码 → 近14天销量（跨 SKC/颜色行相加，只累加正数）
// 刷新时机：
//   - 每天定时（默认随 bi-schedule 的 10:00 一起跑，串行排在两张卡之后）
//   - 进程启动后首次查询发现快照缺失/超过 24h：后台补下一次（不阻塞请求）
// 文件：server/.cache/product_snapshot.json = { at, date, column, byCode: { [大写款号]: number } }

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
const DOWNLOAD_TIMEOUT_MS = 180_000; // 5.8 万行整拉，首次冷启动约 20-60s
const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;

let mem = null;          // { at, date, column, byCode: Map<upperCode, number> }
let loadedAt = 0;
let downloading = null;  // Promise，防止并发下载

function parseCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = lines[0].split(',').map((s) => s.trim());
  const idxCode = header.indexOf('款式编码');
  if (idxCode < 0) return [];
  const idxQty = 1; // 列顺序固定为 款式编码,<销量列>
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    if (cells.length <= idxQty) continue;
    out.push([String(cells[idxCode] || '').trim(), Number(cells[idxQty])]);
  }
  return out;
}

// 把 SKC/颜色行按款号相加（退货负数不计入销量）
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
    mem = { at: Number(j.at) || 0, date: String(j.date || ''), column: String(j.column || ''), byCode: new Map(Object.entries(j.byCode)) };
    return mem;
  } catch {
    mem = null;
    return null;
  }
}

export function isSnapshotStale(snap, now = Date.now()) {
  return !snap || !snap.at || now - snap.at >= SNAPSHOT_TTL_MS;
}

/**
 * 下载并落盘快照。已在下载时复用同一个 Promise。
 * @returns {Promise<{ at: number, date: string, column: string, count: number }>}
 */
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
    ['ds', 'preview', PRODUCT_DS_ID, '--columns', `款式编码,${column}`, '--filter', filter, '--limit', '60000', '-f', 'csv'],
    { timeoutMs: DOWNLOAD_TIMEOUT_MS, lane: 'background' },
  );
  return parseCsv(csv);
}

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

    const sums = sumByCode(rows);
    const at = Date.now();
    const date = new Date(at + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const byCode = Object.fromEntries([...sums.entries()].sort((a, b) => a[0].localeCompare(b[0])));
    await mkdir(CACHE_DIR, { recursive: true });
    const tmp = `${SNAPSHOT_FILE}.tmp`;
    await writeFile(tmp, JSON.stringify({ at, date, column: usedCol, byCode }), 'utf8');
    await rename(tmp, SNAPSHOT_FILE);
    mem = { at, date, column: usedCol, byCode: sums };
    loadedAt = Date.now();
    console.log(`[product-snapshot] 已更新：${sums.size} 个款号，字段「${usedCol}」`);
    return { at, date, column: usedCol, count: sums.size };
  })().finally(() => { downloading = null; });
  return downloading;
}

/**
 * 查询快照里的近14天销量（只读本地，绝不触发 BI；快照缺失/过期时后台补一次）
 * @param {string[]} pids
 * @param {{ triggerRefresh?: boolean }} opts
 */
export async function getSales14dFromSnapshot(pids, { triggerRefresh = true } = {}) {
  const snap = await loadFromDisk();
  if (isSnapshotStale(snap)) {
    if (snap) {
      // 有旧快照先用着，同时后台刷新（.finally 捕获，失败只记日志不影响请求）
      if (triggerRefresh) downloadProductSnapshot().catch((err) => console.warn('[product-snapshot] 后台刷新失败:', err.message));
    } else if (triggerRefresh) {
      downloadProductSnapshot().catch((err) => console.warn('[product-snapshot] 首次下载失败:', err.message));
    }
  }
  const out = {};
  for (const raw of pids || []) {
    const code = String(raw).toUpperCase().trim();
    if (!code) continue;
    const q = snap?.byCode.get(code);
    if (q === undefined) continue;
    out[code] = q;
    out[code.toLowerCase()] = q;
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
