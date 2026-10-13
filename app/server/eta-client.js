// 成衣采购单明细卡片 → 提取每个款号的「最早待收货的 协议到货日期」
// 卡片 id：u6ad35151e3a842b3bd1ebb3（成衣采购单明细）
// 路径：根目录 > 商品看板 > 成衣采购单明细
// 字段：款式编码, 状态, 协议到货日期, 数量, 已入库数
//
// 算法：每个款号找「最早仍未收齐的 PO」的 协议到货日期
//   - 已入库数 < 数量 视为待收货
//   - 该款无任何待收货 PO 时，不返回（避免展示过去日期）
//
// 双层缓存：内存 60s + 磁盘 12h

import { previewGuancliCard } from './guancli.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CACHE_DIR = join(__dirname, '.cache');
const CACHE_FILE = join(CACHE_DIR, 'eta_card.csv');

const CARD_ID = 'u6ad35151e3a842b3bd1ebb3';

const MEM_TTL_MS = 60_000;
const DISK_TTL_MS = 12 * 60 * 60 * 1000;
let cache = { at: 0, byCode: new Map() };

function runGuancliCardPreview() {
  return previewGuancliCard(CARD_ID, { limit: 10000 });
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
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

// '2026-10-13 23:59:59' → '10/13'
function fmtEta(raw) {
  const m = String(raw || '').match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return '';
  return `${Number(m[2])}/${Number(m[3])}`;
}

function rowsToMap(rows) {
  // 每个款号聚合出交期：优先取「最早待收货」，若无 pending 则取「最早 PO」（可能在过去）
  const m = new Map();
  for (const r of rows) {
    const code = String(r['款式编码'] || '').trim().toLowerCase();
    if (!code) continue;
    const etaRaw = String(r['协议到货日期'] || '').trim();
    if (!etaRaw) continue;
    const qty = Number(r['数量']) || 0;
    const received = Number(r['已入库数']) || 0;
    if (qty <= 0) continue;
    const eta = fmtEta(etaRaw);
    if (!eta) continue;
    const isPending = received < qty;
    const cur = m.get(code);
    if (!cur) {
      m.set(code, { eta, etaRaw, isPending });
      continue;
    }
    // pending 的比 cur.isPending 优先；同状态取更早的 etaRaw
    const better =
      (isPending && !cur.isPending) ||
      (isPending === cur.isPending && etaRaw < cur.etaRaw);
    if (better) m.set(code, { eta, etaRaw, isPending });
  }
  return m;
}

async function loadEtaFromDisk() {
  try {
    const text = await readFile(CACHE_FILE, 'utf8');
    const j = JSON.parse(text);
    if (Date.now() - j.at < DISK_TTL_MS) {
      return { at: Date.now(), byCode: new Map(j.byCode) };
    }
  } catch { /* */ }
  return null;
}

async function saveToDisk({ byCode }) {
  await mkdir(CACHE_DIR, { recursive: true });
  const tmp = `${CACHE_FILE}.tmp`;
  const serializable = { at: Date.now(), byCode: Array.from(byCode.entries()) };
  await writeFile(tmp, JSON.stringify(serializable), 'utf8');
  const { rename } = await import('node:fs/promises');
  await rename(tmp, CACHE_FILE);
}

export async function loadEtaMap() {
  if (cache.byCode.size && Date.now() - cache.at < MEM_TTL_MS) {
    return cache;
  }
  const fromDisk = await loadEtaFromDisk();
  if (fromDisk) {
    cache = fromDisk;
    return cache;
  }
  const csv = await runGuancliCardPreview();
  const rows = parseCsv(csv);
  const byCode = rowsToMap(rows);
  cache = { at: Date.now(), byCode };
  await saveToDisk({ byCode });
  return cache;
}

// 给 bi-client / routes 调用：按款号查交期
export function getEtaForCode(code) {
  if (!code) return null;
  const entry = cache.byCode.get(String(code).toLowerCase());
  return entry?.eta || null;
}

export function clearEtaCache() {
  cache = { at: 0, byCode: new Map() };
}
