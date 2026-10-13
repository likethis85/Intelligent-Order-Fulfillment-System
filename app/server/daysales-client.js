// 销量客户端：从「宽表关联后数据源」(e106807e71f8045669969e95) 拉
//   ① 直播当日销量 (按款 + 日期 group by SUM 净销量)
//   ② 累计总销量 (款级字段「款净销量」，后端取 max)
// 数据集字段：款式编码 / 支付日期 / 净销量 / 款净销量
// 缓存：按 (pdtCodes, date) 缓存当天全集 24h；按 (pdtCodes) 缓存款级全集 12h
// 数据量：当日 filter 后几千 ~ 几万行；款级全集 ~ 857 万行（仅首次）

import { runGuancli } from './guancli.js';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CACHE_DIR = join(__dirname, '.cache');
const DAILY_CACHE_FILE = join(CACHE_DIR, 'bi_daysales.json');
const CUMU_CACHE_FILE = join(CACHE_DIR, 'bi_cumusales.json');

const DS_ID = 'e106807e71f8045669969e95'; // 宽表关联后数据源
const MEM_TTL_MS = 30 * 60 * 1000; // 30 分钟
const DAILY_DISK_TTL_MS = 12 * 60 * 60 * 1000; // 当日集 12h
const CUMU_DISK_TTL_MS = 24 * 60 * 60 * 1000; // 累计集 24h

let memDaily = { at: 0, byPid: {} }; // key: 排序后的 pid 列表 → Map<lowerPdtCode, qty>
let memCumu = { at: 0, byPid: {} }; // key: 排序后的 pid 列表 → Map<lowerPdtCode, qty>

// 去掉警告行 + 类型说明行，从首行含「款式编码」开始
function parseCsv(text) {
  const lines = text.split('\n').filter(Boolean);
  const idx = lines.findIndex((l) => l.startsWith('款式编码,'));
  if (idx < 0) return [];
  const rows = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    if (cells.length < 2) continue;
    rows.push(cells.map((s) => s.trim()));
  }
  return rows;
}

function pidKey(pids) {
  return [...new Set(pids.map((p) => String(p).toLowerCase().trim()).filter(Boolean))].sort().join('|');
}

async function loadDisk(file) {
  try {
    if (!existsSync(file)) return null;
    const text = await readFile(file, 'utf8');
    return JSON.parse(text);
  } catch { return null; }
}

async function saveDisk(file, payload) {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(file, JSON.stringify(payload), 'utf8');
  } catch (err) {
    console.warn('[sales] 写盘失败:', err.message);
  }
}

// 日销量：按 (pdtCodes, date) 过滤 → SUM 净销量
// guancli 的 OR + 多 filter 不可靠，且 IN 多值有兼容问题，改用并发：每款一个 IN 单值 filter
async function loadDaily(pids, date) {
  const key = pidKey(pids);
  if (memDaily.byPid[key]?.[date] && Date.now() - memDaily.at < MEM_TTL_MS) {
    const v = memDaily.byPid[key][date];
    return v instanceof Map ? v : new Map(Object.entries(v));
  }
  const disk = await loadDisk(DAILY_CACHE_FILE);
  if (disk?.byPid?.[key]?.[date] && Date.now() - disk.at < DAILY_DISK_TTL_MS) {
    const restored = new Map(Object.entries(disk.byPid[key][date]));
    memDaily = { at: Date.now(), byPid: { ...memDaily.byPid, ...disk.byPid } };
    return restored;
  }
  // 并发调用：每款各自拉一次（按日期过滤），效率比 IN 多值高
  const CONC = 4;
  const agg = new Map();
  for (let i = 0; i < pids.length; i += CONC) {
    const batch = pids.slice(i, i + CONC);
    const results = await Promise.all(batch.map(async (p) => {
      try {
        // 数据源款式编码是大写存储（如 ME01FF042），guancli filter 大小写敏感 → 用大写
        const csv = await runGuancli([
          'ds', 'preview', DS_ID,
          '--columns', '款式编码,支付日期,净销量',
          '--filter', `款式编码 = ${String(p).toUpperCase()}`,
          '--combine-type', 'AND',
          '--filter', `支付日期 = ${date}`,
          '--limit', '50000',
          '-f', 'csv',
        ]);
        return { p, rows: parseCsv(csv) };
      } catch (e) {
        console.warn('[daily-sales]', p, e.message);
        throw e;
      }
    }));
    for (const { p, rows } of results) {
      let sum = 0;
      for (const r of rows) {
        const qty = Number(r[2]);
        if (Number.isFinite(qty) && qty > 0) sum += qty;
      }
      if (sum > 0) agg.set(String(p).toLowerCase(), sum);
    }
  }
  // 落盘
  const byPid = { ...(disk?.byPid || {}) };
  if (!byPid[key]) byPid[key] = {};
  byPid[key][date] = Object.fromEntries(agg);
  const payload = { at: Date.now(), byPid };
  memDaily = { at: Date.now(), byPid };
  await saveDisk(DAILY_CACHE_FILE, payload);
  return agg;
}

// 累计销量：每款各自拉一次（款净销量字段），取 max 防重复
async function loadCumulative(pids) {
  const key = pidKey(pids);
  if (memCumu.byPid[key] && Date.now() - memCumu.at < MEM_TTL_MS) {
    // mem 里既可能是 Map（本次进程）也可能是 Object（从磁盘 restored），统一转 Map
    const v = memCumu.byPid[key];
    return v instanceof Map ? v : new Map(Object.entries(v));
  }
  const disk = await loadDisk(CUMU_CACHE_FILE);
  if (disk?.byPid?.[key] && Date.now() - disk.at < CUMU_DISK_TTL_MS) {
    const restored = new Map(Object.entries(disk.byPid[key]));
    memCumu = { at: Date.now(), byPid: { ...memCumu.byPid, ...disk.byPid } };
    return restored;
  }
  const CONC = 4;
  const agg = new Map();
  for (let i = 0; i < pids.length; i += CONC) {
    const batch = pids.slice(i, i + CONC);
    const results = await Promise.all(batch.map(async (p) => {
      try {
        // 数据源款式编码是大写存储（如 ME01FF042），guancli filter 大小写敏感 → 用大写
        const csv = await runGuancli([
          'ds', 'preview', DS_ID,
          '--columns', '款式编码,款净销量',
          '--filter', `款式编码 = ${String(p).toUpperCase()}`,
          '--combine-type', 'AND',
          '--limit', '50000',
          '-f', 'csv',
        ]);
        return { p, rows: parseCsv(csv) };
      } catch (e) {
        console.warn('[cumu-sales]', p, e.message);
        throw e;
      }
    }));
    for (const { p, rows } of results) {
      let max = 0;
      for (const r of rows) {
        if (r.length < 2) continue;
        const qty = Number(r[1]);
        if (Number.isFinite(qty) && qty > max) max = qty;
      }
      if (max > 0) agg.set(String(p).toLowerCase(), max);
    }
  }
  const byPid = { ...(disk?.byPid || {}), [key]: Object.fromEntries(agg) };
  const payload = { at: Date.now(), byPid };
  memCumu = { at: Date.now(), byPid };
  await saveDisk(CUMU_CACHE_FILE, payload);
  return agg;
}

export async function getDailySales(pids, date) {
  if (!Array.isArray(pids) || pids.length === 0 || !date) return {};
  try {
    const map = await loadDaily(pids, date);
    const out = {};
    for (const c of pids) out[c] = map.get(String(c).toLowerCase()) || 0;
    return out;
  } catch (err) {
    console.warn('[daily-sales] 拉取失败:', err.message);
    throw err;
  }
}

export async function getCumulativeSales(pids) {
  if (!Array.isArray(pids) || pids.length === 0) return {};
  try {
    const map = await loadCumulative(pids);
    const out = {};
    for (const c of pids) out[c] = map.get(String(c).toLowerCase()) || 0;
    return out;
  } catch (err) {
    console.warn('[cumu-sales] 拉取失败:', err.message);
    throw err;
  }
}

export function clearSalesCache() {
  memDaily = { at: 0, byPid: {} };
  memCumu = { at: 0, byPid: {} };
}
