// 尺码范围客户端：从「商品全表」ETL 数据集（g94553b7c10714125a095ea8）取「尺码名称调整」字段
// 按款号聚合：跨色去重 → 按尺码顺序排序 → 范围式 "S~XL"
// 用法：loadSizeRange(pids) 批量查询并缓存（按需 guancli ds preview with --filter OR）
//       getSizeRangeForCode(code) 同步取缓存
//
// 性能：单次 batch 5s 左右（数据集 58k 行），首次查会慢，缓存后毫秒级
// 缓存：内存 Map + 磁盘 JSON（小，pid→"S~XL"），TTL 7 天

import { runGuancli } from './guancli.js';
import { unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CACHE_DIR = join(__dirname, '.cache');
const CACHE_FILE = join(CACHE_DIR, 'size_card.json');

const DS_ID = 'g94553b7c10714125a095ea8';
const DISK_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
// 缓存版本：聚合逻辑变更时 +1，旧缓存文件（含内存里的值）整体失效后重查。
// 否则旧逻辑算错的尺码会被缓存 7 天，刷新、重开页面都一直显示错误值。
const CACHE_VERSION = 2;
const memCache = new Map(); // pid 小写 → sizeRange 字符串
let diskLoadedAt = 0;

function runGuancliDsPreview(filters) {
  // filters: string[] of "款式编码 = X"
  const args = [
    'ds', 'preview', DS_ID,
    // 多取「上新年份」：未采购 / 未上架 的 SKC 不计入尺码范围（用户要求）
    '--columns', '款式编码,颜色,尺码名称调整,上新年份',
    '--combine-type', 'OR', '-f', 'csv',
  ];
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

// 尺码顺序：服装常见尺码优先按顺序排，未识别的放后面按字母排
const SIZE_ORDER = ['XXXS','XXS','XS','S','M','L','XL','XXL','XXXL','XXXXL','均码','FREE','ONE SIZE'];

function sortSizes(arr) {
  const idx = (s) => {
    const up = String(s).trim().toUpperCase();
    const i = SIZE_ORDER.indexOf(up);
    return i >= 0 ? i : 999 + up.localeCompare('a');
  };
  return [...arr].sort((a, b) => idx(a) - idx(b));
}

function aggregateSizes(sizes) {
  const set = new Set();
  for (const s of sizes) {
    const v = String(s || '').trim();
    if (v) set.add(v);
  }
  const arr = sortSizes([...set]);
  if (arr.length === 0) return '';
  if (arr.length === 1) return arr[0];
  return `${arr[0]}~${arr[arr.length - 1]}`;
}

async function loadDiskCache() {
  if (diskLoadedAt && Date.now() - diskLoadedAt < 60_000) return; // 60s 内不重读
  try {
    const text = await readFile(CACHE_FILE, 'utf8');
    const j = JSON.parse(text);
    if (j && j.v === CACHE_VERSION && j.at && Date.now() - j.at < DISK_TTL_MS && j.byCode) {
      for (const [k, v] of Object.entries(j.byCode)) memCache.set(k.toLowerCase(), v);
    } else {
      // 版本不匹配 / 已过期：连内存里的旧值一起丢掉，强制下次重查
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
    console.warn('[size] 写盘失败:', err.message);
  }
}

let inflight = null; // 单飞：并发请求合并
export async function loadSizeRange(pids) {
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
    // 一次 OR 查询拿所有缺失款号
    const filters = missing.map((k) => `款式编码 = ${k.toUpperCase()}`);
    let csv = '';
    try {
      csv = await runGuancliDsPreview(filters);
    } catch (err) {
      console.warn('[size] guancli 失败:', err.message);
      inflight = null;
      return;
    }
    const rows = parseCsv(csv);
    // 按款号聚合尺码；过滤「上新年份 = 未采购未上架」的 SKC（用户要求：仅这个状态不计入尺码范围）
    const byPid = new Map();
    for (const r of rows) {
      const code = String(r['款式编码'] || '').trim();
      const size = String(r['尺码名称调整'] || '').trim();
      const year = String(r['上新年份'] || '').trim();
      if (!code || !size) continue;
      if (year === '未采购未上架') continue;
      const k = code.toLowerCase();
      if (!byPid.has(k)) byPid.set(k, []);
      byPid.get(k).push(size);
    }
    for (const k of missing) {
      const sizes = byPid.get(k) || [];
      const range = aggregateSizes(sizes);
      if (process.env.SIZE_DEBUG === '1') {
        console.log(`[size] ${k}: raw sizes=${JSON.stringify(sizes)} → "${range}"`);
      }
      // 不缓存空值：BI 临时失败/返回空时，下一次请求必须重新查，否则错误结果会卡 7 天
      if (range) memCache.set(k, range);
    }
    saveDiskCache().catch(() => {});
    inflight = null;
  })();
  return inflight;
}

export function getSizeRangeForCode(code) {
  if (!code) return '';
  return memCache.get(String(code).trim().toLowerCase()) ?? '';
}

export function clearSizeCache() {
  memCache.clear();
  diskLoadedAt = 0;
  // 同步删除磁盘文件：不清掉的话，下次 loadDiskCache 还会读回旧的脏数据
  // 同步商品/库存触发此函数后调用方紧接着会拉尺码，必须保证文件已删
  try { unlinkSync(CACHE_FILE); } catch { /* 文件可能不存在，忽略 */ }
}
