// BOM 成本客户端：从「商品全表」ETL 数据集（g94553b7c10714125a095ea8）取「bom商品成本」字段
// 按款号聚合：跨 SKC / 颜色取最大值（保守口径）
// 用法：loadBomCost(pids) 批量查询并缓存（按需 guancli ds preview with --filter OR）
//       getBomCostForCode(code) 同步取缓存
//
// 性能：单次 batch 5s 左右（数据集 58k 行），首次查会慢，缓存后毫秒级
// 缓存：内存 Map + 磁盘 JSON（小，pid→数字字符串），TTL 7 天

import { runGuancli } from './guancli.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CACHE_DIR = join(__dirname, '.cache');
const CACHE_FILE = join(CACHE_DIR, 'cost_card.json');

const DS_ID = 'g94553b7c10714125a095ea8';
const DISK_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
// 缓存版本：聚合逻辑变更时 +1，让旧磁盘缓存（含内存里的旧值）整体失效重查
const CACHE_VERSION = 2;
const memCache = new Map(); // pid 小写 → "123.45"
let diskLoadedAt = 0;

function runGuancliDsPreview(filters) {
  const args = ['ds', 'preview', DS_ID, '--columns', '款式编码,bom商品成本', '--combine-type', 'OR', '-f', 'csv'];
  for (const f of filters) args.push('--filter', f);
  return runGuancli(args);
}

function parseCsv(text) {
  const lines = text.split('\n').filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].split(',').map((s) => s.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    if (cells.length !== header.length) continue;
    const row = {};
    for (let j = 0; j < header.length; j++) row[header[j]] = cells[j];
    rows.push(row);
  }
  return rows;
}

async function loadDiskCache() {
  if (diskLoadedAt && Date.now() - diskLoadedAt < 60_000) return;
  try {
    const text = await readFile(CACHE_FILE, 'utf8');
    const j = JSON.parse(text);
    if (j && j.v === CACHE_VERSION && j.at && Date.now() - j.at < DISK_TTL_MS && j.byCode) {
      for (const [k, v] of Object.entries(j.byCode)) memCache.set(k.toLowerCase(), v);
    } else {
      // 版本不匹配 / 已过期：连内存里的旧值一起丢掉
      memCache.clear();
    }
  } catch { /* 文件不存在：保留内存里的值 */ }
  diskLoadedAt = Date.now();
}

async function saveDiskCache() {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    const tmp = `${CACHE_FILE}.tmp`;
    const serializable = { v: CACHE_VERSION, at: Date.now(), byCode: Object.fromEntries(memCache) };
    await writeFile(tmp, JSON.stringify(serializable), 'utf8');
    const { rename } = await import('node:fs/promises');
    await rename(tmp, CACHE_FILE);
  } catch (err) {
    console.warn('[cost] 写盘失败:', err.message);
  }
}

let inflight = null; // 单飞：并发请求合并
export async function loadBomCost(pids) {
  await loadDiskCache();
  const missing = [];
  for (const p of (pids || [])) {
    const k = String(p).trim().toLowerCase();
    if (!k) continue;
    if (!memCache.has(k)) missing.push(k);
  }
  if (missing.length === 0) return;
  if (inflight) return inflight;
  inflight = (async () => {
    const filters = missing.map((k) => `款式编码 EQ ${k.toUpperCase()}`);
    let csv = '';
    try {
      csv = await runGuancliDsPreview(filters);
    } catch (err) {
      console.warn('[cost] guancli 失败:', err.message);
      inflight = null;
      return;
    }
    const rows = parseCsv(csv);
    // 按款号取 bom商品成本 最大值（保守口径，跨 SKC / 颜色）
    const byPid = new Map();
    for (const r of rows) {
      const code = String(r['款式编码'] || '').trim();
      const v = Number(String(r['bom商品成本'] || '').trim());
      if (!code || !Number.isFinite(v) || v < 0) continue; // 负数 / NaN 视为脏数据；0 保留（可能是录入中 / 数据缺失占位）
      const k = code.toLowerCase();
      const cur = byPid.get(k);
      byPid.set(k, cur === undefined ? v : Math.max(cur, v));
    }
    for (const k of missing) {
      const cost = byPid.get(k);
      const rounded = cost !== undefined ? Math.round(cost * 10) / 10 : undefined;
      const range = rounded !== undefined ? String(rounded) : '';
      if (process.env.COST_DEBUG === '1') {
        console.log(`[cost] ${k}: max=${cost} → "${range}"`);
      }
      // 不缓存空值：BI 临时失败 / 返回空时，下一次必须重查
      if (range) memCache.set(k, range);
    }
    saveDiskCache().catch(() => {});
    inflight = null;
  })();
  return inflight;
}

export function getBomCostForCode(code) {
  if (!code) return '';
  return memCache.get(String(code).trim().toLowerCase()) ?? '';
}

export function clearCostCache() {
  memCache.clear();
  diskLoadedAt = 0;
  unlink(CACHE_FILE).catch(() => {});
}
