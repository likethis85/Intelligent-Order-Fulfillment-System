// 把 TraysPage 导出 Excel 的三 sheet 持久化到 Supabase（自托管 api.marius.vip）
//
// 三张表：restock_planned / no_restock / sku_detail（schema 见 scripts/sales-tables.sql）
// 策略：纯 upsert 单条，不删旧行——保留每次改动的历史（用户每次编辑都会留下记录）
//   同一 unique key 下新数据会覆盖旧数据；被删除的 tray 由前端传 deletedTrayIds → removeTray 一次性清理
//
// 调用点：routes/trays.js 的 PUT /api/trays 在 saveTrays 成功后，对每个 tray 调用 persistTray
// 失败兜底：本文件异常不抛——日志 warn 即可，supabase 写失败不影响本地 saveTrays

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { supabase, isSupabaseReady, warnIfRlsDenied } from './supabase-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PRODUCTS_FILE = join(__dirname, 'data', 'products.json');

// 按 pid（小写）→ Product 的查表函数（只读 products.json 缓存，不走网络）
// 后端拉一次后做 lowercase Map；products.json 改了重进程就生效
let _byIdCache = null;
function byIdFromDisk(pid) {
  if (!existsSync(PRODUCTS_FILE)) return null;
  if (!_byIdCache) {
    try {
      const arr = JSON.parse(readFileSync(PRODUCTS_FILE, 'utf8'));
      _byIdCache = new Map();
      if (Array.isArray(arr)) {
        for (const p of arr) {
          if (p && p.id) _byIdCache.set(String(p.id).toLowerCase(), p);
        }
      }
    } catch {
      _byIdCache = new Map();
    }
  }
  return _byIdCache.get(String(pid || '').toLowerCase()) || null;
}

const BATCH = 200; // 单次 upsert 行数上限（PostgREST 默认 1000，分批更稳）

// 进程内记录每个货盘上次写入的直播日期，用来判断是否需要按 tray_id 统一刷新历史行
const lastLiveDateByTray = new Map();

// 每张表的业务唯一键。必须显式传给 PostgREST：
// supabase-js 的 upsert 不带 onConflict 时，PostgREST 只按主键(id)判冲突，
// 而 id 是 DEFAULT gen_random_uuid() → 每次保存都会插入一批新行而不是覆盖旧行。
const ON_CONFLICT = {
  restock_planned: 'tray_id,pdt_code,skc,pieces,days',
  no_restock: 'tray_id,pdt_code,skc',
  sku_detail: 'tray_id,section,look_idx,pdt_code',
};

/**
 * 把 tray 的「计划翻单量」「不可翻单」「款号明细」整体覆盖到 supabase 三张表
 * @returns {Promise<{restock: number, noRestock: number, sku: number, skipped?: string}>}
 */
export async function persistTray(tray) {
  if (!isSupabaseReady()) {
    return { restock: 0, noRestock: 0, sku: 0, skipped: 'supabase-not-configured' };
  }
  if (!tray || !tray.id) {
    return { restock: 0, noRestock: 0, sku: 0, skipped: 'no-tray-id' };
  }
  const trayId = String(tray.id);
  const liveDate = tray.date || null;
  const registeredAt = tray.updatedAt || tray.createdAt || null;
  // 回收站标记：进回收站的货盘不参与 BI 统计。写「入回收站时间」，恢复时 trashedAt 为 null 会写回 NULL；
  // 只有彻底删除（墓碑）才由 removeTray 真删行，回收站里数据仍然可恢复。
  const deletedAt = tray.trashedAt || null;
  // 直播日期变更检测：upsert 只覆盖「当前货盘还在的行」，改过坑位/删过款号留下的旧行不在 payload 里，
  // 日期会停留成旧值，BI 里同一个货盘出现两个直播日期。日期变了就按 tray_id 统一刷新一次。
  // 用进程内缓存避免每次保存都多打请求；进程重启后的首次保存（缓存为空）也会刷一次。
  const prevLiveDate = lastLiveDateByTray.get(trayId);
  lastLiveDateByTray.set(trayId, liveDate);
  const liveDateChanged = prevLiveDate !== liveDate;

  try {
    // ① 计划翻单量：按 plannedRestockItems 展开，去重（款号多坑位只输出一次）
    // 样衣阶段翻单（sampleRestockItems，驼色等未转大货色）一并持久化，source 标 sample
    // 再对 (pdt_code, skc, pieces, days) 去重，避免 upsert 时 unique constraint 冲突
    const itemsByPid = new Map();
    for (const it of tray.plannedRestockItems || []) {
      const p = String(it.pdt || '').toLowerCase();
      if (!itemsByPid.has(p)) itemsByPid.set(p, []);
      itemsByPid.get(p).push({ ...it, _source: undefined });
    }
    for (const it of tray.sampleRestockItems || []) {
      const p = String(it.pdt || '').toLowerCase();
      if (!itemsByPid.has(p)) itemsByPid.set(p, []);
      itemsByPid.get(p).push(it);
    }
    const restockRows = [];
    const seenPids = new Set();
    const seenBatch = new Set();
    for (const s of tray.sections || []) {
      for (const l of s.looks || []) {
        for (const pidRaw of l.pids || []) {
          const pid = String(pidRaw || '').toLowerCase();
          if (!pid || seenPids.has(pid)) continue;
          const items = itemsByPid.get(pid) || [];
          if (items.length > 0) {
            seenPids.add(pid);
            for (const it of items) {
              const skc = String(it.skc || '').toLowerCase();
              const pieces = Number(it.pieces) || 0;
              const days = Number(it.days) || 0;
              const bk = `${pid}|${skc}|${pieces}|${days}`;
              if (seenBatch.has(bk)) continue; // 同批次重复（来自 sales.html 多次同步），跳过
              seenBatch.add(bk);
              restockRows.push({
                tray_id: trayId,
                pdt_code: pid,
                skc,
                pieces,
                days,
                color: it.color || null,
                cycle: days > 0 ? `${days}天之内` : null,
                live_date: liveDate,
                registered_at: registeredAt,
                source: it._source === 'sample' ? 'sample' : 'sales-sync',
                deleted_at: deletedAt,
              });
            }
          }
        }
      }
    }
    // ② 不可翻单：按 pid+skc 去重（每个 SKC 一行，多坑位去重）
    const noRestockRows = [];
    const seen = new Set();
    for (const s of tray.sections || []) {
      for (let li = 0; li < (s.looks || []).length; li++) {
        const l = s.looks[li];
        for (const it of (tray.noRestockItems || [])) {
          if (!(l.pids || []).some((p) => String(p).toLowerCase() === String(it.pid).toLowerCase())) continue;
          const pidLc = String(it.pid).toLowerCase();
          const skcLc = String(it.skc || '').toLowerCase();
          const key = `${pidLc}|${skcLc}`;
          if (seen.has(key)) continue;
          seen.add(key);
          noRestockRows.push({
            tray_id: trayId,
            pdt_code: pidLc,
            skc: skcLc,
            color: it.color || null,
            fabric: it.fabric || null,
            section: s.label || null,
            look_idx: li + 1,
            deleted_at: deletedAt,
          });
        }
      }
    }
    // ③ 款号明细：一坑位一pid 一行（用户确认的多坑位保留）
    // 即使 products.json 没这个 pid（mock/老数据），也要写入基础字段（pid/section/look_idx），
    // name/price/planned_qty/goods_value 等 product 属性允许 null，BI 后续可 join 补齐。
    const skuRows = [];
    // unique(tray_id, section, look_idx, pdt_code) 的进程内去重：
    // 同一坑位重复的 pid 会让 ON CONFLICT 报 "cannot affect row a second time"
    const seenSku = new Set();
    for (const s of tray.sections || []) {
      for (let li = 0; li < (s.looks || []).length; li++) {
        const l = s.looks[li];
        for (const pid of l.pids || []) {
          const p = byIdFromDisk(pid);
          const pidLc = String(pid).toLowerCase();
          // section 用空串而不是 null：unique 约束对 NULL 不生效，会导致每次保存都插一行
          const section = s.label || '';
          const skuKey = `${section}|${li + 1}|${pidLc}`;
          if (seenSku.has(skuKey)) continue;
          seenSku.add(skuKey);
          if (p) {
            const plannedQty = Number(p.plannedQty) || 0;
            const orderedQty = Number(p.orderedQty) || 0;
            const priceNum = Number(p.priceNum) || 0;
            const goodsValue = priceNum * (plannedQty + orderedQty);
            skuRows.push({
              tray_id: trayId,
              pdt_code: pidLc,
              skc: null,
              section,
              look_idx: li + 1,
              name: p.name || null,
              color: (p.colors || []).join('/') || null,
              price: priceNum || null,
              stock_main: Number(p.stockMain) || null,
              in_transit: Number(p.inTransit) || null,
              restock: p.restock || null,
              planned_qty: plannedQty || null,
              ordered_qty: orderedQty || null,
              goods_value: goodsValue || null,
              live_date: liveDate,
              deleted_at: deletedAt,
            });
          } else {
            // products.json 没命中：只写基础字段，BI 可由 pid 关联其他数据源补齐
            skuRows.push({
              tray_id: trayId,
              pdt_code: pidLc,
              skc: null,
              section,
              look_idx: li + 1,
              name: null,
              color: null,
              price: null,
              stock_main: null,
              in_transit: null,
              restock: null,
              planned_qty: null,
              ordered_qty: null,
              goods_value: null,
              live_date: liveDate,
              deleted_at: deletedAt,
            });
          }
        }
      }
    }

    // 纯增量 upsert：保留旧行，新行按 unique key 覆盖；删除 tray 由前端传 deletedTrayIds → removeTray
    const [restockN, noRestockN, skuN] = await Promise.all([
      bulkUpsert('restock_planned', restockRows),
      bulkUpsert('no_restock', noRestockRows),
      bulkUpsert('sku_detail', skuRows),
    ]);
    // 直播日期变了：把该 tray 的所有历史行（含已移出货盘的残留行）统一刷新，
    // 避免 BI 里同一个货盘出现两个直播日期。只有 restock_planned / sku_detail 有 live_date 列。
    if (liveDateChanged) {
      for (const table of ['restock_planned', 'sku_detail']) {
        const { error } = await supabase.from(table).update({ live_date: liveDate }).eq('tray_id', trayId);
        if (error) console.warn(`[sales-persist] ${table} 直播日期刷新失败 tray=${trayId}: ${error.message}`);
      }
    }
    // 进回收站的货盘：除本次 upsert 的行以外，tray 里已被删掉/改过坑位的历史行不会出现在 payload 里，
    // 按 tray_id 统一打标，保证回收站货盘的全部行都不进 BI 统计。
    // 恢复时由上面的 upsert 把这些行写回 NULL（当前行），历史行本来就已不属于该货盘。
    if (deletedAt) {
      for (const table of ['restock_planned', 'no_restock', 'sku_detail']) {
        const { error } = await supabase.from(table).update({ deleted_at: deletedAt }).eq('tray_id', trayId);
        if (error) console.warn(`[sales-persist] ${table} 回收站标记失败 tray=${trayId}: ${error.message}`);
      }
    }
    return { restock: restockN, noRestock: noRestockN, sku: skuN };
  } catch (err) {
    console.warn(`[sales-persist] tray=${trayId} 写入失败：`, err.message);
    return { restock: 0, noRestock: 0, sku: 0, skipped: 'error' };
  }
}

// deleted_at 迁移脚本还没执行时会提示一次（不影响写入：自动降级为旧结构）
let deletedAtHinted = false;
function warnDeletedAtMissing(table) {
  if (deletedAtHinted) return;
  deletedAtHinted = true;
  console.warn(
    `[supabase] ${table} 还没有 deleted_at 列，本次按旧结构写入。` +
      '请在 Supabase SQL Editor 执行 scripts/sales-tables.sql 里的「回收站删除标记」ALTER 语句，' +
      '之后货盘进回收站会自动打标记。',
  );
}

async function bulkUpsert(table, rows) {
  if (rows.length === 0) return 0;
  const onConflict = ON_CONFLICT[table];
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    let { error, status, statusText } = await supabase
      .from(table)
      .upsert(batch, onConflict ? { onConflict } : undefined);
    // 表还没加 deleted_at（迁移未执行）：去掉该列重试，保证货盘保存不受影响
    if (error && String(error.message || '').includes('deleted_at')) {
      warnDeletedAtMissing(table);
      const legacy = batch.map((row) => {
        const { deleted_at: _omit, ...rest } = row;
        return rest;
      });
      ({ error, status, statusText } = await supabase
        .from(table)
        .upsert(legacy, onConflict ? { onConflict } : undefined));
      if (!error) {
        inserted += legacy.length;
        continue;
      }
    }
    if (error) {
      warnIfRlsDenied(table, error);
      const detail = `${table} upsert 失败: status=${status} ${statusText} | message=${error.message || '(no message)'} | code=${error.code || '-'} | hint=${error.hint || '-'}`;
      throw new Error(detail);
    }
    inserted += batch.length;
  }
  return inserted;
}

/**
 * 维护用：删掉某 tray 的所有 supabase 行（不带 byId 也能跑——只删不写）
 */
export async function removeTray(trayId) {
  if (!isSupabaseReady() || !trayId) return;
  for (const table of ['restock_planned', 'no_restock', 'sku_detail']) {
    const { error, status, statusText } = await supabase.from(table).delete().eq('tray_id', trayId);
    if (error) {
      const detail = `${table} delete 失败: status=${status} ${statusText} | message=${error.message || '(no message)'} | code=${error.code || '-'}`;
      console.warn(`[sales-persist] remove ${trayId} ${detail}`);
    }
  }
}
