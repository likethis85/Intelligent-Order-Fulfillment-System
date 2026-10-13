// 画像 + 主播数据客户端：通过 guancli 拉观远 BI 的三个数据源
//
//   - 单款人群画像：数据集 全渠道单款人群画像 f15987d5391014699986c658（款×平台×维度×类目，已关联款式编码）
//   - 店铺人群画像：数据集 全渠道人群画像 if646f03929234bedb9fd2c1（月×平台×店铺×维度×类目）
//   - 主播热卖榜：卡片 b1bee7b8debb044e59cc4fad（款×主播 数量/数量占比）
//
// 缓存：内存 60s + 磁盘 12h（与 bi-client 相同策略）

import { runGuancli, previewGuancliCard } from './guancli.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CACHE_DIR = join(__dirname, '.cache');
const SKU_CACHE_FILE = join(CACHE_DIR, 'bi_sku_profile.csv');
const STORE_CACHE_FILE = join(CACHE_DIR, 'bi_store_profile.csv');
const ANCHOR_CACHE_FILE = join(CACHE_DIR, 'bi_anchor_card.csv');

const SKU_PROFILE_DS = 'f15987d5391014699986c658'; // 全渠道单款人群画像
const STORE_PROFILE_DS = 'if646f03929234bedb9fd2c1'; // 全渠道人群画像
const ANCHOR_CARD_ID = 'b1bee7b8debb044e59cc4fad'; // 主播业绩数据_购买数量

// 主播白名单：BI 卡片返回的主播里只有这些是真主播；其他是渠道/品牌/店播等
// 输入包含中文别名/小写/重复条目，运行时用更宽松匹配
const ANCHOR_WHITELIST = [
  '李紫薇', '格格', '杜佳欣', '宁沐', '许闻宇', '文文', '田雨妍', '小田', '珍妮', 'Jenny', '孙文静',
  '小文', '王祖儿', '祖儿', '杨亚琴', '杨曦', '刘凯月', 'Kerry', '夏天', '蕾蕾', '小鱼', '痴痴', '晨晨',
  '海燕', '陈妍', '小郁',
];
const ANCHOR_WHITELIST_LOWER = new Set(ANCHOR_WHITELIST.map((s) => s.toLowerCase()));

const MEM_TTL_MS = 60_000;
const DISK_TTL_MS = 12 * 60 * 60 * 1000;

let skuCache = { at: 0, byCode: new Map() };
let storeCache = { at: 0, byStore: new Map() };
let anchorCache = { at: 0, anchors: [], byAnchor: new Map(), byCode: new Map() };

// guancli ds preview 只支持 stdout 输出，直接捕获
function runGuancliDsPreview(dsId, columns) {
  const args = ['ds', 'preview', dsId, '--limit', '50000', '-f', 'csv'];
  if (columns) args.push('--columns', columns);
  return runGuancli(args);
}

// guancli card preview 支持 -o 写文件（与 bi-client 相同）
function runGuancliCardPreview(cardId) {
  // 不设 --limit：保留主播卡片的聚合口径，避免重复切片计数。
  return previewGuancliCard(cardId);
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

const num = (v) => {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// ── 维度归一化 ──
// 年龄桶：淘宝 25-29/30-34/35-39/40-49 与 抖音 25-30/31-35/36-40/41-50 分箱不同，统一映射到 UI 六桶
const AGE_BUCKETS = ['18-24', '25-30', '31-35', '36-40', '41-50', '50+'];
function ageBucket(label) {
  const s = String(label || '').replace(/\s/g, '');
  if (s.startsWith('18-24')) return '18-24';
  if (s.startsWith('25-')) return '25-30'; // 25-29 / 25-30
  if (s.startsWith('30-') || s.startsWith('31-')) return '31-35';
  if (s.startsWith('35-') || s.startsWith('36-')) return '36-40';
  if (s.startsWith('40-') || s.startsWith('41-')) return '41-50';
  if (s.startsWith('50')) return '50+';
  return null; // 18岁以下 / 未知 丢弃
}

const CROWD_ORDER = ['精致妈妈', '小镇青年', '小镇中老年', '资深中产', '都市银发', '都市蓝领', '新锐白领', 'GenZ'];
function crowdNorm(label) {
  const s = String(label || '').trim();
  if (/genz|z世代/i.test(s)) return 'GenZ';
  const hit = CROWD_ORDER.find((c) => s.includes(c.slice(0, 2)) && s.includes(c.slice(-2)));
  return hit || null;
}

const STAGE_ORDER = ['孕期', '单身', '恋爱', '已育'];
function stageNorm(label) {
  const s = String(label || '').trim();
  return STAGE_ORDER.find((c) => s === c || s.includes(c)) || null;
}

function genderOf(label) {
  const s = String(label || '').trim();
  if (s.startsWith('女')) return 'female';
  if (s.startsWith('男')) return 'male';
  return null;
}

// 把某一组维度行（同维度分布）聚合成 {label: 占比百分比}
// 优先用「类目占比」；没有占比时按支付人数在维度内归一
function dimPcts(rows, norm) {
  const out = new Map();
  let anyRatio = false;
  for (const r of rows) {
    const key = norm(r['类目']);
    if (!key) continue;
    const ratio = num(r['类目占比']);
    const payers = num(r['支付人数']);
    if (ratio > 0) anyRatio = true;
    const cur = out.get(key) || { ratio: 0, payers: 0 };
    cur.ratio += ratio;
    cur.payers += payers;
    out.set(key, cur);
  }
  const entries = [...out.entries()];
  if (entries.length === 0) return null;
  if (anyRatio) {
    const sum = entries.reduce((a, [, v]) => a + v.ratio, 0);
    if (sum > 0) return new Map(entries.map(([k, v]) => [k, (v.ratio / sum) * 100]));
  }
  const sum = entries.reduce((a, [, v]) => a + v.payers, 0);
  if (sum <= 0) return null;
  return new Map(entries.map(([k, v]) => [k, (v.payers / sum) * 100]));
}

function buildProfile(rows) {
  if (!rows || rows.length === 0) return null;
  const byDim = new Map();
  for (const r of rows) {
    const d = String(r['维度分布'] || '').trim();
    if (!byDim.has(d)) byDim.set(d, []);
    byDim.get(d).push(r);
  }
  const profile = { ages: null, female: null, crowds: null, stages: null, provinces: null, interests: null, customerType: null, payers: 0, store: '', platform: '' };

  const ageP = dimPcts(byDim.get('年龄分布') || [], ageBucket);
  if (ageP) profile.ages = AGE_BUCKETS.map((b) => Math.round(ageP.get(b) || 0));

  const genderP = dimPcts(byDim.get('性别分布') || [], genderOf);
  if (genderP && (genderP.get('female') || 0) > 0) profile.female = Math.round(genderP.get('female'));

  const crowdP = dimPcts(byDim.get('8大人群分布') || byDim.get('八大策略人群分布') || [], crowdNorm);
  if (crowdP) profile.crowds = CROWD_ORDER.map((c) => Math.round(crowdP.get(c) || 0));

  const stageP = dimPcts(byDim.get('人生阶段') || [], stageNorm);
  if (stageP) profile.stages = STAGE_ORDER.map((s) => Math.round(stageP.get(s) || 0));

  const provRows = byDim.get('常驻省份Top10') || byDim.get('常驻省份') || [];
  const provP = dimPcts(provRows, (l) => (String(l || '').trim() && !/未知/.test(l) ? String(l).trim() : null));
  if (provP) {
    profile.provinces = [...provP.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, v]) => ({ name, value: Math.round(v) }));
  }

  const intP = dimPcts(byDim.get('兴趣爱好') || [], (l) => (/未知/.test(l) ? null : String(l || '').trim() || null));
  if (intP) {
    profile.interests = [...intP.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, v]) => ({ name, value: Math.round(v) }));
  }

  const custP = dimPcts(byDim.get('客群') || [], (l) => (/新客户|新客/.test(l) ? '新客户' : /老客户|老客/.test(l) ? '老客户' : null));
  if (custP) profile.customerType = [...custP.entries()].map(([name, v]) => ({ name, value: Math.round(v) }));

  // 支付人数取该维度行的最大（每个维度行重复了款级汇总数）
  let payers = 0;
  for (const r of rows) payers = Math.max(payers, num(r['支付人数']));
  profile.payers = payers;
  const store = String(rows[0]['店铺名'] || '').trim();
  const platform = String(rows[0]['平台'] || '').trim();
  if (store) profile.store = store;
  if (platform) profile.platform = platform;
  return profile;
}

// ── 单款人群画像 ──
async function loadSkuFromDisk() {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    const text = await readFile(SKU_CACHE_FILE, 'utf8');
    const j = JSON.parse(text);
    // 兼容两种历史磁盘格式：{ at, byCode }（当前）与 { at, rows }（旧版无 byCode）
    if (j && j.at && Date.now() - j.at < DISK_TTL_MS && (j.byCode || j.rows)) return j;
  } catch {}
  return null;
}

async function loadSkuProfiles() {
  if (skuCache.byCode.size && Date.now() - skuCache.at < MEM_TTL_MS) return skuCache;
  const fromDisk = await loadSkuFromDisk();
  if (fromDisk) {
    skuCache = { at: fromDisk.at, byCode: new Map(Object.entries(fromDisk.byCode)) };
    return skuCache;
  }
  const csv = await runGuancliDsPreview(SKU_PROFILE_DS, '商品ID,平台,店铺名,维度分布,类目,支付人数,类目占比,款式编码');
  const rows = parseCsv(csv);
  const byCode = new Map();
  for (const r of rows) {
    const code = String(r['款式编码'] || '').trim();
    if (!code) continue;
    const key = code.toLowerCase();
    if (!byCode.has(key)) byCode.set(key, []);
    byCode.get(key).push(r);
  }
  skuCache = { at: Date.now(), byCode };
  writeFile(SKU_CACHE_FILE, JSON.stringify({ at: skuCache.at, byCode: Object.fromEntries(byCode) })).catch((err) =>
    console.warn('[profile/sku] 写盘失败:', err.message),
  );
  return skuCache;
}

// platform：'淘宝' | '抖音'，缺省合并两个平台
// 返回 { profile, availablePlatforms }；指定平台无数据时 profile 为 null（不静默回退到另一平台）
export async function getSkuProfile(code, platform) {
  const { byCode } = await loadSkuProfiles();
  const rows = byCode.get(String(code || '').trim().toLowerCase());
  if (!rows || rows.length === 0) return { profile: null, availablePlatforms: [] };
  const availablePlatforms = [...new Set(rows.map((r) => String(r['平台']).trim()).filter(Boolean))];
  if (platform) {
    const filtered = rows.filter((r) => String(r['平台']).trim() === platform);
    if (!filtered.length) return { profile: null, availablePlatforms };
    return { profile: buildProfile(filtered), availablePlatforms };
  }
  return { profile: buildProfile(rows), availablePlatforms };
}

// 有画像数据的款号清单（前端默认选项用：空搜索时优先展示有画像的款）
export async function listSkuProfileCodes() {
  const { byCode } = await loadSkuProfiles();
  return [...byCode.keys()];
}

// ── 店铺人群画像 ──
async function loadStoreFromDisk() {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    const text = await readFile(STORE_CACHE_FILE, 'utf8');
    const j = JSON.parse(text);
    if (j && j.at && Date.now() - j.at < DISK_TTL_MS && j.rows) return j;
  } catch {}
  return null;
}

async function loadStoreProfiles() {
  if (storeCache.byStore.size && Date.now() - storeCache.at < MEM_TTL_MS) return storeCache;
  const fromDisk = await loadStoreFromDisk();
  if (fromDisk) {
    storeCache = { at: fromDisk.at, byStore: new Map(Object.entries(fromDisk.byStore)) };
    return storeCache;
  }
  const csv = await runGuancliDsPreview(STORE_PROFILE_DS, '日期,平台,店铺名,维度分布,类目,类目占比,支付人数');
  const rows = parseCsv(csv);
  const byStore = new Map();
  for (const r of rows) {
    const store = String(r['店铺名'] || '').trim();
    if (!store) continue;
    if (!byStore.has(store)) byStore.set(store, []);
    byStore.get(store).push(r);
  }
  storeCache = { at: Date.now(), byStore };
  writeFile(STORE_CACHE_FILE, JSON.stringify({ at: storeCache.at, byStore: Object.fromEntries(byStore) })).catch((err) =>
    console.warn('[profile/store] 写盘失败:', err.message),
  );
  return storeCache;
}

function monthKey(dateStr) {
  const m = String(dateStr || '').match(/(\d{4})[-/](\d{1,2})/);
  return m ? Number(m[1]) * 100 + Number(m[2]) : 0;
}

// scope：'month'（默认，取该店最新一个月份）| 'all'（全部月份累计）
// month：指定月份（如 '2026-08'），优先于 scope
export async function getStoreProfile(store, platform, { scope = 'month', month = '' } = {}) {
  const { byStore } = await loadStoreProfiles();
  const rows = byStore.get(String(store || '').trim());
  if (!rows || rows.length === 0) return null;
  let scoped;
  let label;
  if (month) {
    const target = monthKey(month);
    scoped = rows.filter((r) => monthKey(r['日期']) === target);
    label = month;
  } else if (scope === 'all') {
    scoped = rows;
    label = '累计';
  } else {
    let latest = 0;
    for (const r of rows) latest = Math.max(latest, monthKey(r['日期']));
    scoped = rows.filter((r) => monthKey(r['日期']) === latest);
    label = String(scoped[0]?.['日期'] || '').trim();
  }
  if (platform) {
    const f = scoped.filter((r) => String(r['平台']).trim() === platform);
    if (f.length) scoped = f;
  }
  if (scope === 'all' && !month) {
    // 跨月累计：占比不能跨月相加，按月份支付人数加权平均（该数据集中每行的支付人数
    // 是该维度当月总数，类目间相同，恰好可作权重；类目自身人数不可用——全部相同）
    const merged = new Map();
    for (const r of scoped) {
      const key = `${r['维度分布']}|${r['类目']}`;
      const w = num(r['支付人数']);
      const cur = merged.get(key) || { ...r, wr: 0, w: 0, payers: 0 };
      cur.wr += num(r['类目占比']) * w;
      cur.w += w;
      cur.payers += w;
      merged.set(key, cur);
    }
    scoped = [...merged.values()].map((c) => ({ ...c, 类目占比: c.w > 0 ? c.wr / c.w : 0 }));
  }
  const profile = buildProfile(scoped);
  if (profile) {
    profile.month = label;
    profile.payers = 0;
    for (const r of scoped) profile.payers = Math.max(profile.payers, num(r['支付人数']));
  }
  return profile;
}

export async function listStoreProfiles() {
  const { byStore } = await loadStoreProfiles();
  return [...byStore.keys()].map((store) => {
    const rows = byStore.get(store);
    const months = [...new Set(rows.map((r) => monthKey(r['日期'])))].filter(Boolean).sort((a, b) => b - a);
    const latest = months[0] || 0;
    return {
      store,
      month: String(rows.find((r) => monthKey(r['日期']) === latest)?.['日期'] || '').trim(),
      months,
    };
  });
}

// ── 主播热卖榜 ──
async function loadAnchorFromDisk() {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    const text = await readFile(ANCHOR_CACHE_FILE, 'utf8');
    const j = JSON.parse(text);
    if (j && j.at && Date.now() - j.at < DISK_TTL_MS && j.data) return j;
  } catch {}
  return null;
}

async function loadAnchors() {
  if (anchorCache.anchors.length && Date.now() - anchorCache.at < MEM_TTL_MS) return anchorCache;
  const fromDisk = await loadAnchorFromDisk();
  if (fromDisk) {
    anchorCache = {
      at: fromDisk.at,
      anchors: fromDisk.data.anchors,
      byAnchor: new Map(Object.entries(fromDisk.data.byAnchor)),
      byCode: new Map(Object.entries(fromDisk.data.byCode)),
    };
    return anchorCache;
  }
  const csv = await runGuancliCardPreview(ANCHOR_CARD_ID);
  const rows = parseCsv(csv);
  // 列约定：「数量 > 主播名」「数量占比 > 主播名」；跳过「总计」行
  const qtyCols = Object.keys(rows[0] || {}).filter((k) => k.startsWith('数量 > '));
  const byAnchor = new Map();
  const byCode = new Map();
  for (const col of qtyCols) {
    const name = col.slice('数量 > '.length).trim();
    if (!name) continue;
    const ratioCol = `数量占比 > ${name}`;
    const hot = [];
    for (const r of rows) {
      const code = String(r['款式编码'] || '').trim();
      if (!code || code === '总计') continue;
      const qty = num(r[col]);
      if (qty <= 0) continue;
      const ratio = num(r[ratioCol]);
      const key = code.toLowerCase();
      hot.push({ pdtCode: code, qty, ratio });
      if (!byCode.has(key)) byCode.set(key, []);
      byCode.get(key).push({ anchor: name, qty, ratio });
    }
    hot.sort((a, b) => b.qty - a.qty);
    byAnchor.set(name, hot);
  }
  const anchors = [...byAnchor.entries()]
    .map(([name, hot]) => ({ name, totalQty: hot.reduce((a, h) => a + h.qty, 0) }))
    .filter((a) => a.totalQty > 0)
    .sort((a, b) => b.totalQty - a.totalQty);
  anchorCache = { at: Date.now(), anchors, byAnchor, byCode };
  writeFile(ANCHOR_CACHE_FILE, JSON.stringify({ at: anchorCache.at, data: { anchors, byAnchor: Object.fromEntries(byAnchor), byCode: Object.fromEntries(byCode) } })).catch(
    (err) => console.warn('[profile/anchor] 写盘失败:', err.message),
  );
  return anchorCache;
}

// 把某主播名匹配白名单（处理大小写、去空格、别名）
// 例：王祖儿 / 祖儿 / 祖儿 / WangZuEr 都能匹配上「祖儿」白名单条目
function matchWhitelist(name) {
  const s = String(name || '').trim().toLowerCase();
  if (!s) return null;
  // 直接相等
  if (ANCHOR_WHITELIST_LOWER.has(s)) return name;
  // 白名单里反过来包含在 s 里 / s 包含在白名单里
  for (const w of ANCHOR_WHITELIST) {
    const wl = w.toLowerCase();
    if (wl.length >= 2 && (s.includes(wl) || wl.includes(s))) return w;
  }
  return null;
}

// 主播热卖款 TOP N：与 BI 卡片「销量_购买数量」一致——按 csv 行的 qty 直接排名
// （同款号下不同 SKC 行可能多次出现，这是 BI 卡片的原始展示逻辑）
export async function getAnchorHot(name, topN = 5) {
  const { byAnchor } = await loadAnchors();
  const matchName = matchWhitelist(name) || name;
  const hot = byAnchor.get(String(matchName || '').trim()) || [];
  return hot.slice(0, topN);
}

// 去掉 BI 行里主播名后面追加的「-50.00%」类折扣标签（同一主播多 SKU 时出现）
function stripDiscountTag(name) {
  const s = String(name || '');
  return s.replace(/[-‐-―]\d+(\.\d+)?\s*%?$/g, '').trim() || s.trim();
}

export async function listAnchors() {
  const { anchors } = await loadAnchors();
  // 1) 每行先去掉「-折扣%」尾巴
  // 2) 与白名单 fuzzy 匹配（不区分大小写 / 别名）
  // 3) 合并同名主播的 totalQty，但显示名优先用纯名（不长于一个数字）
  const group = new Map();
  for (const a of anchors) {
    const cleanName = stripDiscountTag(a.name);
    const canonical = matchWhitelist(cleanName) || matchWhitelist(a.name);
    if (!canonical) continue;
    const cur = group.get(canonical);
    if (!cur) {
      group.set(canonical, { name: cleanName || canonical, totalQty: a.totalQty });
    } else {
      cur.totalQty += a.totalQty;
      // 纯名优先（cleanName 通常更短于 BI 原始「-折扣%」）
      if (cleanName && cleanName.length < cur.name.length && !/%\d/.test(cur.name)) cur.name = cleanName;
    }
  }
  return [...group.values()].sort((a, b) => b.totalQty - a.totalQty);
}

export async function getAnchorTotals() {
  const { anchors, byAnchor } = await loadAnchors();
  return { anchors, byAnchor };
}

// 主播受众聚合：取主播 TopN 热卖款，按购买数量加权聚合各款的画像行
// 返回合成后的 AudienceProfile（年龄段/性别/8大人群/人生阶段/省份/兴趣，淘宝 + 抖音合并）
export async function getAnchorAudience(name, topN = 20) {
  const { byAnchor } = await loadAnchors();
  const { byCode: skuByCode } = await loadSkuProfiles();
  const matchName = matchWhitelist(name) || String(name || '').trim();
  const hot = byAnchor.get(matchName) || [];
  const items = hot.slice(0, topN).filter((h) => (h.qty || 0) > 0);
  if (items.length === 0) return { profile: null, used: [], missing: [] };

  // 把每款的画像行按 (平台 + 维度) 拆开，淘宝抖音分别聚合后再按款号购买数量加权
  const used = [];
  const missing = [];
  // 每个 维度 × 子桶 累加「加权占比」和「加权利率」
  const sums = {
    age: new Map(),
    gender: new Map(),
    crowd: new Map(),
    stage: new Map(),
    province: new Map(),
    interest: new Map(),
    customer: new Map(),
  };
  let totalWeight = 0;

  for (const h of items) {
    const code = String(h.pdtCode || '').trim().toLowerCase();
    if (!code) continue;
    const rows = skuByCode.get(code);
    if (!rows || rows.length === 0) { missing.push(code); continue; }
    used.push({ pdtCode: code, qty: h.qty });
    const w = Number(h.qty) || 0;
    if (w <= 0) continue;
    totalWeight += w;

    // 不同平台维度字段可能不同（如省份/兴趣互斥）；按行直接聚合
    for (const r of rows) {
      const dim = String(r['维度分布'] || '').trim();
      const label = String(r['类目'] || '').trim();
      const ratio = num(r['类目占比']);
      const payers = num(r['支付人数']);
      const inc = (m) => {
        if (!label || /未知/.test(label)) return;
        const cur = sums[m].get(label) || 0;
        // 有占比用类目占比加权（与单款一致）；否则用支付人数归一（这里继续累加付款人，最后做归一）
        sums[m].set(label, cur + (ratio > 0 ? ratio * w : payers * w));
      };
      if (dim === '年龄分布') {
        const k = ageBucket(label);
        if (k) _bump(sums.age, k, ratio, payers, w);
      } else if (dim === '性别分布') {
        const g = genderOf(label);
        if (g) _bump(sums.gender, g, ratio, payers, w);
      } else if (dim === '8大人群分布' || dim === '八大策略人群分布') {
        const c = crowdNorm(label);
        if (c) _bump(sums.crowd, c, ratio, payers, w);
      } else if (dim === '人生阶段') {
        const s = stageNorm(label);
        if (s) _bump(sums.stage, s, ratio, payers, w);
      } else if (dim === '常驻省份Top10' || dim === '常驻省份') {
        if (!/未知/.test(label)) _bump(sums.province, label, ratio, payers, w);
      } else if (dim === '兴趣爱好') {
        if (!/未知/.test(label)) _bump(sums.interest, label, ratio, payers, w);
      } else if (dim === '客群') {
        const c = /新客户|新客/.test(label) ? '新客户' : /老客户|老客/.test(label) ? '老客户' : null;
        if (c) _bump(sums.customer, c, ratio, payers, w);
      }
    }
  }

  // 归一 + 模板化成 AudienceProfile
  function _normAge(m) {
    if (totalWeight === 0) return null;
    const out = AGE_BUCKETS.map((b) => m.get(b) || 0);
    const sum = out.reduce((a, v) => a + v, 0);
    if (sum <= 0) return null;
    return out.map((v) => Math.round((v / sum) * 100));
  }
  function _normPct(m, keys) {
    if (totalWeight === 0) return null;
    const sum = keys.reduce((a, k) => a + (m.get(k) || 0), 0);
    if (sum <= 0) return null;
    return keys.map((k) => Math.round(((m.get(k) || 0) / sum) * 100));
  }
  function _normTop(m, n = 10) {
    if (totalWeight === 0) return null;
    const total = [...m.values()].reduce((a, v) => a + v, 0);
    if (total <= 0) return null;
    return [...m.entries()]
      .map(([name, v]) => ({ name, value: Math.round((v / total) * 100) }))
      .sort((a, b) => b.value - a.value)
      .slice(0, n);
  }

  const profile = {
    ages: _normPct(sums.age, AGE_BUCKETS),
    female: null,
    crowds: _normPct(sums.crowd, CROWD_ORDER),
    stages: _normPct(sums.stage, STAGE_ORDER),
    provinces: _normTop(sums.province, 10),
    interests: _normTop(sums.interest, 10),
    customerType: _normTop(sums.customer, 2),
    payers: items.reduce((s, h) => s + (h.qty || 0), 0),
    store: '',
    platform: '',
  };
  // 性别只保留女性占比
  if (sums.gender && sums.gender.size > 0) {
    const f = sums.gender.get('female') || 0;
    const m = sums.gender.get('male') || 0;
    const tot = f + m;
    if (tot > 0) profile.female = Math.round((f / tot) * 100);
  }
  if (profile.ages === null && profile.female === null && !profile.crowds && !profile.stages) {
    return { profile: null, used, missing };
  }
  return { profile, used, missing };
}

function _bump(m, key, ratio, payers, w) {
  if (!key) return;
  const cur = m.get(key) || 0;
  m.set(key, cur + (ratio > 0 ? ratio * w : payers * w));
}

export function clearProfileCache() {
  skuCache = { at: 0, byCode: new Map() };
  storeCache = { at: 0, byStore: new Map() };
  anchorCache = { at: 0, anchors: [], byAnchor: new Map(), byCode: new Map() };
  unlink(SKU_CACHE_FILE).catch(() => {});
  unlink(STORE_CACHE_FILE).catch(() => {});
  unlink(ANCHOR_CACHE_FILE).catch(() => {});
}
