// 销量客户端：从「宽表关联后数据源」(e106807e71f8045669969e95) 读取
//   ① 直播当天销量: --columns 款式编码,支付日期,销售量 --filter "款式编码 = X" --filter "支付日期 = YYYY-MM-DD"
//   ② 累计销量: --columns 款式编码,销售量 --filter "款式编码 = X"
// 约束:
//   - 款式编码大写存储，--filter 大小写敏感 → 传参前 .toUpperCase()
//   - 单款单查，Promise.all 并发，全局并发限制 MAX_CONC = 3
//   - 空响应/失败重试: runGuancliWithRetry(retries = 2)
//   - 缓存: bi_daysales.json (近2天30min, 历史12h) / bi_cumusales.json (2h)
//   - 成功(含真实0)写盘，失败不写盘

import { runGuancli } from './guancli.js';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CACHE_DIR = join(__dirname, '.cache');
const DAILY_CACHE_FILE = join(CACHE_DIR, 'bi_daysales.json');
const CUMU_CACHE_FILE = join(CACHE_DIR, 'bi_cumusales.json');

const DS_ID = 'e106807e71f8045669969e95'; // 宽表关联后数据源

// 缓存 TTL 配置
const TTL_DAILY_RECENT_MS = 30 * 60 * 1000;       // 近 2 天日期: 30 分钟
const TTL_DAILY_HISTORY_MS = 12 * 60 * 60 * 1000; // 历史日期: 12 小时
const TTL_CUMU_MS = 2 * 60 * 60 * 1000;           // 累计销量: 2 小时

// 内存缓存: 启动或首次按需从磁盘装载
// daily: { [lowerPid]: { [date]: { q: number, at: timestamp } } }
// cumu:  { [lowerPid]: { q: number, at: timestamp } }
let memDaily = null;
let memCumu = null;
let diskLoadPromise = null;

// 判断目标日期是否为近 2 天 (Date.now() - t < 2d)
function isRecent2Days(dateStr) {
  const t = new Date(`${dateStr}T00:00:00+08:00`).getTime();
  if (Number.isNaN(t)) return false;
  return (Date.now() - t) < 2 * 24 * 60 * 60 * 1000;
}

// 磁盘装载
async function ensureCacheLoaded() {
  if (memDaily !== null && memCumu !== null) return;
  if (diskLoadPromise) return diskLoadPromise;
  diskLoadPromise = (async () => {
    try {
      if (existsSync(DAILY_CACHE_FILE)) {
        const text = await readFile(DAILY_CACHE_FILE, 'utf8');
        memDaily = JSON.parse(text) || {};
      } else {
        memDaily = {};
      }
    } catch {
      memDaily = {};
    }

    try {
      if (existsSync(CUMU_CACHE_FILE)) {
        const text = await readFile(CUMU_CACHE_FILE, 'utf8');
        memCumu = JSON.parse(text) || {};
      } else {
        memCumu = {};
      }
    } catch {
      memCumu = {};
    }
  })();
  await diskLoadPromise;
}

// 保存磁盘缓存
async function saveDiskCache(file, data) {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.warn('[sales-cache] 写盘失败:', err.message);
  }
}

// 缓存查询与写入
function getDailyFromCache(lowerPid, date) {
  if (!memDaily) return null;
  const entry = memDaily[lowerPid]?.[date];
  if (!entry || typeof entry.q !== 'number' || !entry.at) return null;
  const ttl = isRecent2Days(date) ? TTL_DAILY_RECENT_MS : TTL_DAILY_HISTORY_MS;
  if (Date.now() - entry.at < ttl) {
    return entry.q;
  }
  return null;
}

async function setDailyToCache(lowerPid, date, qty) {
  if (!memDaily) memDaily = {};
  if (!memDaily[lowerPid]) memDaily[lowerPid] = {};
  memDaily[lowerPid][date] = { q: qty, at: Date.now() };
  await saveDiskCache(DAILY_CACHE_FILE, memDaily);
}

function getCumuFromCache(lowerPid) {
  if (!memCumu) return null;
  const entry = memCumu[lowerPid];
  if (!entry || typeof entry.q !== 'number' || !entry.at) return null;
  if (Date.now() - entry.at < TTL_CUMU_MS) {
    return entry.q;
  }
  return null;
}

async function setCumuToCache(lowerPid, qty) {
  if (!memCumu) memCumu = {};
  memCumu[lowerPid] = { q: qty, at: Date.now() };
  await saveDiskCache(CUMU_CACHE_FILE, memCumu);
}

// 全局并发控制器: MAX_CONC = 3
const MAX_CONC = 3;
let active = 0;
const queue = [];

function limited(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      active++;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          active--;
          if (queue.length > 0) {
            const next = queue.shift();
            next();
          }
        });
    };
    if (active < MAX_CONC) {
      run();
    } else {
      queue.push(run);
    }
  });
}

// CSV 行解析
export function parseCsv(text) {
  if (!text || typeof text !== 'string') return [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const idx = lines.findIndex((l) => l.includes('款式编码'));
  if (idx < 0) return [];
  const rows = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i];
    const cells = line.split(',').map((s) => s.replace(/^["']|["']$/g, '').trim());
    if (cells.length >= 2) {
      rows.push(cells);
    }
  }
  return rows;
}

// 带重试调用 guancli (默认重试 2 次)
async function runGuancliWithRetry(args, { retries = 2, delayMs = 500 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const csv = await runGuancli(args);
      if (!csv || typeof csv !== 'string' || !csv.trim()) {
        throw new Error('guancli 返回空响应');
      }
      return parseCsv(csv);
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

// 单款当日销量查询
async function dailyOne(pid, date) {
  const upperPid = String(pid).toUpperCase().trim();
  const lowerPid = upperPid.toLowerCase();

  // 1. 命中缓存直接返
  const cached = getDailyFromCache(lowerPid, date);
  if (cached !== null) {
    return { pid: upperPid, qty: cached, cached: true, success: true };
  }

  // 2. 限流并发拉取
  try {
    const rows = await limited(() => runGuancliWithRetry([
      'ds', 'preview', DS_ID,
      '--columns', '款式编码,支付日期,销售量',
      '--filter', `款式编码 = ${upperPid}`,
      '--combine-type', 'AND',
      '--filter', `支付日期 = ${date}`,
      '--limit', '50000',
      '-f', 'csv',
    ]));

    let sum = 0;
    for (const r of rows) {
      const qty = Number(r[2]);
      if (Number.isFinite(qty) && qty > 0) sum += qty;
    }

    // 成功（含真实 0）写盘
    await setDailyToCache(lowerPid, date, sum);
    return { pid: upperPid, qty: sum, cached: false, success: true };
  } catch (err) {
    console.warn(`[daily-sales] 款号 ${upperPid} (${date}) 拉取失败:`, err.message);
    // 拉失败不写盘，本次按 0 返回
    return { pid: upperPid, qty: 0, cached: false, success: false, error: err };
  }
}

// 单款累计销量查询 (去掉日期 filter)
async function cumuOne(pid) {
  const upperPid = String(pid).toUpperCase().trim();
  const lowerPid = upperPid.toLowerCase();

  // 1. 命中缓存直接返
  const cached = getCumuFromCache(lowerPid);
  if (cached !== null) {
    return { pid: upperPid, qty: cached, cached: true, success: true };
  }

  // 2. 限流并发拉取
  try {
    const rows = await limited(() => runGuancliWithRetry([
      'ds', 'preview', DS_ID,
      '--columns', '款式编码,销售量',
      '--filter', `款式编码 = ${upperPid}`,
      '--combine-type', 'AND',
      '--limit', '50000',
      '-f', 'csv',
    ]));

    let sum = 0;
    for (const r of rows) {
      const qty = Number(r[1]);
      if (Number.isFinite(qty) && qty > 0) sum += qty;
    }

    // 成功（含真实 0）写盘
    await setCumuToCache(lowerPid, sum);
    return { pid: upperPid, qty: sum, cached: false, success: true };
  } catch (err) {
    console.warn(`[cumu-sales] 款号 ${upperPid} 累计销量拉取失败:`, err.message);
    // 拉失败不写盘，本次按 0 返回
    return { pid: upperPid, qty: 0, cached: false, success: false, error: err };
  }
}

// 批量查询当日销量
export async function getDailySales(pids, date) {
  if (!Array.isArray(pids) || pids.length === 0 || !date) return {};
  await ensureCacheLoaded();
  const results = await Promise.all(pids.map((p) => dailyOne(p, date)));

  // 判断是否全部失败（且没有缓存命中）
  const allFailed = results.length > 0 && results.every((r) => !r.success && !r.cached);
  if (allFailed) {
    const firstErr = results[0]?.error;
    throw firstErr || new Error('拉取当日销量全失败');
  }

  const out = {};
  for (const r of results) {
    out[r.pid] = r.qty;
    out[r.pid.toLowerCase()] = r.qty;
  }
  return out;
}

// 批量查询累计销量
export async function getCumulativeSales(pids) {
  if (!Array.isArray(pids) || pids.length === 0) return {};
  await ensureCacheLoaded();
  const results = await Promise.all(pids.map((p) => cumuOne(p)));

  // 判断是否全部失败（且没有缓存命中）
  const allFailed = results.length > 0 && results.every((r) => !r.success && !r.cached);
  if (allFailed) {
    const firstErr = results[0]?.error;
    throw firstErr || new Error('拉取累计销量全失败');
  }

  const out = {};
  for (const r of results) {
    out[r.pid] = r.qty;
    out[r.pid.toLowerCase()] = r.qty;
  }
  return out;
}

// 清除销量缓存 (hard: true 强清磁盘文件)
export async function clearSalesCache({ hard = false } = {}) {
  memDaily = {};
  memCumu = {};
  if (hard) {
    try {
      if (existsSync(DAILY_CACHE_FILE)) await unlink(DAILY_CACHE_FILE).catch(() => {});
      if (existsSync(CUMU_CACHE_FILE)) await unlink(CUMU_CACHE_FILE).catch(() => {});
    } catch (err) {
      console.warn('[sales-cache] 清除磁盘文件失败:', err.message);
    }
  }
}
