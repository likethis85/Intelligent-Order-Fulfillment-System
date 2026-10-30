// 销量客户端：从「宽表关联后数据源」(e106807e71f8045669969e95) 读取
//   ① 直播当天销量: --columns 款式编码,销售量 --filter "款式编码 IN A,B,C" --filter "支付日期 EQ YYYY-MM-DD"
//   ② 累计销量:   --columns 款式编码,销售量 --filter "款式编码 EQ X"（单款，不能批量，见下）
//
// 这个数据集有 1183 万行 × 277 列，BI 侧任何一次预览都是 3-30 秒量级，并且 30 秒左右会被网关
// 判死（API 524）。实测：
//   - 单款 + 日期          ≈ 15s
//   - 20 款 IN + 日期      ≈ 3-15s（45 款就会 524）
//   - 单款累计（无日期）    ≈ 4-13s（20 款 IN 无日期会 524）
//   - 按日期全量            = 524
// 所以「按款号逐条查」一次页面要发上百个请求，必然拖过 nginx 60s（线上 142 次 499、9 次 504）。
//
// 现方案：**请求只读缓存，绝不等待 BI**
//   - 缺失的款号丢进后台预热队列，按 20 款一批走 guancli 批量车道（不占用户请求名额）
//   - 接口立即返回已有值 + pending 数量，前端轮询（10s 一次）把数字补全
//   - 失败的批次按 1/2/3/4 分钟退避重试，超次数后放弃（下次打开页面再入队）
// 约束:
//   - 款式编码大写存储，--filter 大小写敏感 → 传参前 .toUpperCase()
//   - 缓存: bi_daysales.json (近2天30min, 历史12h) / bi_cumusales.json (2h)，成功的 0 也写盘

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

// 预热参数
const CHUNK_SIZE = 20;            // 每批 IN 的款号数（实测 45 会触发 BI 30s 网关超时）
const QUERY_TIMEOUT_MS = 25_000;  // 必须低于 BI 网关的 ~30s 上限
const WARM_CONCURRENCY = Number(process.env.SALES_WARM_CONCURRENCY) || 3;
// 单测/排查时可关掉预热（SALES_WARM_DISABLED=1），接口仍返回缓存值 + pending
const WARM_ENABLED = process.env.SALES_WARM_DISABLED !== '1';
const FAIL_COOLDOWN_MS = 60_000;  // 失败退避基数：1/2/3/4 分钟
const MAX_ATTEMPTS = 4;

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
let dailySaveTimer = null;
let cumuSaveTimer = null;

function scheduleDailySave() {
  if (dailySaveTimer) return;
  dailySaveTimer = setTimeout(async () => {
    dailySaveTimer = null;
    await saveDiskCache(DAILY_CACHE_FILE, memDaily);
  }, 1000);
  dailySaveTimer.unref?.();
}

function scheduleCumuSave() {
  if (cumuSaveTimer) return;
  cumuSaveTimer = setTimeout(async () => {
    cumuSaveTimer = null;
    await saveDiskCache(CUMU_CACHE_FILE, memCumu);
  }, 1000);
  cumuSaveTimer.unref?.();
}

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

function setDailyToCache(lowerPid, date, qty) {
  if (!memDaily) memDaily = {};
  if (!memDaily[lowerPid]) memDaily[lowerPid] = {};
  memDaily[lowerPid][date] = { q: qty, at: Date.now() };
  scheduleDailySave();
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

function setCumuToCache(lowerPid, qty) {
  if (!memCumu) memCumu = {};
  memCumu[lowerPid] = { q: qty, at: Date.now() };
  scheduleCumuSave();
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

// 把款号列表切成固定批次（先排序，保证同一批集合稳定，方便去重）
export function chunkPids(pids, size = CHUNK_SIZE) {
  const uniq = [...new Set(pids.map((p) => String(p).toUpperCase().trim()).filter(Boolean))].sort();
  const out = [];
  for (let i = 0; i < uniq.length; i += size) out.push(uniq.slice(i, i + size));
  return out;
}

// 把「一码一行」的销量行按款号汇总（与原逻辑一致：只累加正数，忽略退货负数）
export function sumRowsByCode(rows, qtyIndex = 1) {
  const sums = new Map();
  for (const r of rows) {
    const code = String(r[0] || '').trim().toUpperCase();
    const qty = Number(r[qtyIndex]);
    if (!code || !Number.isFinite(qty) || qty <= 0) continue;
    sums.set(code, (sums.get(code) || 0) + qty);
  }
  return sums;
}

// ── 后台预热队列 ──
// 每个 job: { kind: 'daily'|'cumu', key, date?, pids?, pid?, attempts, notBefore }
const jobs = [];
const pendingKeys = new Set();
let running = 0;
let wakeTimer = null;
let lastWarnAt = 0;

function enqueue(job) {
  if (!WARM_ENABLED) return;
  if (pendingKeys.has(job.key)) return;
  pendingKeys.add(job.key);
  jobs.push({ attempts: 0, notBefore: 0, ...job });
  pump();
}

function pump() {
  while (running < WARM_CONCURRENCY) {
    const now = Date.now();
    const idx = jobs.findIndex((j) => j.notBefore <= now);
    if (idx < 0) break;
    const job = jobs.splice(idx, 1)[0];
    running++;
    runJob(job).finally(() => {
      running--;
      pump();
    });
  }
  scheduleWake();
}

function scheduleWake() {
  if (wakeTimer || jobs.length === 0) return;
  const next = Math.min(...jobs.map((j) => j.notBefore));
  const delay = Math.max(200, next - Date.now());
  wakeTimer = setTimeout(() => { wakeTimer = null; pump(); }, delay);
  wakeTimer.unref?.();
}

// 失败日志限流：BI 挂的时候别把一个页面刷成上万行（历史错误日志就是这么来的）
function warnThrottled(message) {
  const now = Date.now();
  if (now - lastWarnAt < 60_000) return;
  lastWarnAt = now;
  console.warn(message);
}

async function runJob(job) {
  try {
    if (job.kind === 'daily') {
      await fetchDailyChunk(job.date, job.pids);
    } else {
      await fetchCumuOne(job.pid);
    }
    pendingKeys.delete(job.key);
  } catch (err) {
    job.attempts += 1;
    if (job.attempts >= MAX_ATTEMPTS) {
      pendingKeys.delete(job.key);
      warnThrottled(`[sales-warm] ${job.kind} 放弃（第 ${job.attempts} 次失败）：${err.message}`);
      return;
    }
    job.notBefore = Date.now() + FAIL_COOLDOWN_MS * job.attempts;
    jobs.push(job);
    warnThrottled(`[sales-warm] ${job.kind} 失败，${job.attempts * 60}s 后重试：${err.message}`);
  }
}

async function runQuery(args) {
  const csv = await runGuancli(args, { timeoutMs: QUERY_TIMEOUT_MS, lane: 'bulk' });
  // 空响应是正常的查询结果（BI 无匹配行 = 销量为 0）
  if (!csv || typeof csv !== 'string' || !csv.trim()) return [];
  return parseCsv(csv);
}

// 一批款号的当日销量：一次 IN 查询拿齐，按款号汇总后写缓存
async function fetchDailyChunk(date, pids) {
  const rows = await runQuery([
    'ds', 'preview', DS_ID,
    '--columns', '款式编码,销售量',
    '--filter', `款式编码 IN ${pids.join(',')}`,
    '--combine-type', 'AND',
    '--filter', `支付日期 EQ ${date}`,
    '--limit', '50000',
    '-f', 'csv',
  ]);
  const sums = sumRowsByCode(rows, 1);
  for (const code of pids) {
    setDailyToCache(code.toLowerCase(), date, sums.get(code) || 0);
  }
}

// 单款累计销量（累计无法批量：去掉日期过滤后 20 款 IN 会 524）
async function fetchCumuOne(pid) {
  const rows = await runQuery([
    'ds', 'preview', DS_ID,
    '--columns', '款式编码,销售量',
    '--filter', `款式编码 EQ ${pid}`,
    '--limit', '50000',
    '-f', 'csv',
  ]);
  const sums = sumRowsByCode(rows, 1);
  setCumuToCache(pid.toLowerCase(), sums.get(pid) || 0);
}

// 把 byPid 结果按「大写 + 小写」两种键输出（前端两种写法都在用）
function toByPid(entries) {
  const out = {};
  for (const [upper, qty] of entries) {
    out[upper] = qty;
    out[upper.toLowerCase()] = qty;
  }
  return out;
}

/**
 * 批量查询当日销量：只读缓存，缺失的入队预热
 * @returns {Promise<{ byPid: Record<string, number>, pending: number }>}
 */
export async function getDailySales(pids, date) {
  if (!Array.isArray(pids) || pids.length === 0 || !date) return { byPid: {}, pending: 0 };
  await ensureCacheLoaded();

  const entries = [];
  const missing = [];
  for (const raw of pids) {
    const upper = String(raw).toUpperCase().trim();
    if (!upper) continue;
    const cached = getDailyFromCache(upper.toLowerCase(), date);
    if (cached === null) {
      missing.push(upper);
      entries.push([upper, 0]); // 缺的先用 0 占位，前端轮询补齐
    } else {
      entries.push([upper, cached]);
    }
  }

  for (const chunk of chunkPids(missing, CHUNK_SIZE)) {
    enqueue({ kind: 'daily', key: `d|${date}|${chunk.join(',')}`, date, pids: chunk });
  }

  return { byPid: toByPid(entries), pending: new Set(missing).size };
}

/**
 * 批量查询累计销量：只读缓存，缺失的入队预热
 * @returns {Promise<{ byPid: Record<string, number>, pending: number }>}
 */
export async function getCumulativeSales(pids) {
  if (!Array.isArray(pids) || pids.length === 0) return { byPid: {}, pending: 0 };
  await ensureCacheLoaded();

  const entries = [];
  const missing = [];
  for (const raw of pids) {
    const upper = String(raw).toUpperCase().trim();
    if (!upper) continue;
    const cached = getCumuFromCache(upper.toLowerCase());
    if (cached === null) {
      missing.push(upper);
      entries.push([upper, 0]);
    } else {
      entries.push([upper, cached]);
    }
  }

  for (const code of new Set(missing)) {
    enqueue({ kind: 'cumu', key: `c|${code}`, pid: code });
  }

  return { byPid: toByPid(entries), pending: new Set(missing).size };
}

// 运维用：当前预热队列状态
export function getSalesWarmStats() {
  return { running, queued: jobs.length, pendingKeys: pendingKeys.size };
}

// 清除销量缓存 (hard: true 强清磁盘文件)
export async function clearSalesCache({ hard = false } = {}) {
  memDaily = {};
  memCumu = {};
  jobs.length = 0;
  pendingKeys.clear();
  if (hard) {
    try {
      if (existsSync(DAILY_CACHE_FILE)) await unlink(DAILY_CACHE_FILE).catch(() => {});
      if (existsSync(CUMU_CACHE_FILE)) await unlink(CUMU_CACHE_FILE).catch(() => {});
    } catch (err) {
      console.warn('[sales-cache] 清除磁盘文件失败:', err.message);
    }
  }
}
