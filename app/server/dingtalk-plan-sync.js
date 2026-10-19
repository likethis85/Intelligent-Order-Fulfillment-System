import { execSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);

const DINGTALK_PLAN_NODE_URL = process.env.DINGTALK_PLAN_NODE_URL || 'https://alidocs.dingtalk.com/i/nodes/QOG9lyrgJPBLrEORiXeg0a5vWzN67Mw4';
const DINGTALK_PLAN_SHEET_ID = process.env.DINGTALK_PLAN_SHEET_ID || 'st-92d5f099-36547';

const EXPECTED_HEADERS = [
  '款号',
  'skc',
  '计划翻单量',
  '翻单周期',
  '直播日期',
  '颜色',
  '登记时间',
  '翻单周期（表格）',
  '生成的文字信息（本skc）',
  '生成的文字信息（完整的）'
];

/**
 * RFC 4180 CSV 解析器，支持字段内引号、逗号及跨行文本
 */
export function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || (row.length === 1 && row[0] !== '')) {
        rows.push(row);
      }
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.length > 1 || (row.length === 1 && row[0] !== '')) {
      rows.push(row);
    }
  }
  return rows;
}

/**
 * RFC 4180 CSV 单行序列化
 */
export function toCsvRow(cells) {
  return cells.map((v) => {
    if (v === null || v === undefined) return '';
    const str = String(v);
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }).join(',');
}

/**
 * 格式化日期为 YYYY/MM/DD HH:mm:ss
 */
function formatDateTime(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const y = d.getFullYear();
  const m = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const h = pad(d.getHours());
  const min = pad(d.getMinutes());
  const s = pad(d.getSeconds());
  return `${y}/${m}/${day} ${h}:${min}:${s}`;
}

/**
 * 检查 dws 是否可用及登录状态
 */
export async function checkDwsStatus() {
  try {
    const { stdout } = await execFileAsync('dws', ['auth', 'status', '-f', 'json'], {
      timeout: 5000,
    });
    const parsed = JSON.parse(stdout);
    return { ok: true, authenticated: !!parsed.authenticated, profile: parsed.profile || null };
  } catch (err) {
    return { ok: false, authenticated: false, error: err.message };
  }
}

// 串行锁，防止并发同步覆盖
let syncLock = Promise.resolve();

/**
 * 同步翻单计划到钉钉文档的「计划翻单量」工作表
 * @param {Object} params
 * @param {string[]} params.pdt_codes 本次涉及的款号列表
 * @param {Array<{pdt: string, skc: string, color?: string, pieces: number, days: number}>} params.items 本次翻单项列表
 * @param {string[]} params.all_skcs 本次款下的所有 SKC（含清零的）
 * @param {string} params.full_text 完整翻单文字
 * @param {Record<string, string>} params.per_skc_text 每个 SKC 单行文字
 */
export function syncPlanToDingtalk(params) {
  const run = () => executeSyncPlanToDingtalk(params);
  const next = syncLock.then(run, run);
  syncLock = next.catch(() => {});
  return next;
}

async function executeSyncPlanToDingtalk({
  pdt_codes = [],
  items = [],
  all_skcs = [],
  full_text = '',
  per_skc_text = {},
}) {
  const t0 = Date.now();
  console.log(`\n[dingtalk-plan-sync] 开始同步翻单计划... 款号数: ${pdt_codes.length}, 条目数: ${items.length}, all_skcs: ${all_skcs.length}`);

  // 1. 检查 dws 状态
  const dwsStatus = await checkDwsStatus();
  if (!dwsStatus.ok || !dwsStatus.authenticated) {
    throw new Error(`钉钉 CLI (dws) 未就绪: ${dwsStatus.error || '未登录钉钉账号，请先在服务器执行 npm run dws:login'}`);
  }

  // 2. 导出当前工作表已有数据
  let rawCsv = '';
  try {
    const { stdout } = await execFileAsync(
      'dws',
      [
        'sheet',
        'export-csv',
        '--node',
        DINGTALK_PLAN_NODE_URL,
        '--sheet-id',
        DINGTALK_PLAN_SHEET_ID,
      ],
      { maxBuffer: 10 * 1024 * 1024, timeout: 20000 }
    );
    rawCsv = stdout;
  } catch (err) {
    throw new Error(`读取钉钉「计划翻单量」表格失败: ${err.message}`);
  }

  const parsedRows = parseCsv(rawCsv);
  const header = parsedRows.length > 0 ? parsedRows[0] : EXPECTED_HEADERS;
  const existingDataRows = parsedRows.slice(1);

  console.log(`[dingtalk-plan-sync] 当前工作表已有行数: ${existingDataRows.length}`);

  // 3. 构建匹配集合（全部转大写匹配）
  const pdtSet = new Set(pdt_codes.map((s) => String(s || '').trim().toUpperCase()).filter(Boolean));
  const skcSet = new Set(all_skcs.map((s) => String(s || '').trim().toUpperCase()).filter(Boolean));

  // 记录已有行中被触及的旧数据（用于提取既有直播日期和计算指标）
  const unaffectedRows = [];
  const affectedOldRows = [];
  const oldSkcSeen = new Set();
  const oldLiveDateBySkc = new Map();

  for (const row of existingDataRows) {
    const rowPdt = String(row[0] || '').trim().toUpperCase();
    const rowSkc = String(row[1] || '').trim().toUpperCase();

    // 过滤空行：若款号和 SKC 均为空，或整行字段全为空，则属于无效空行，直接跳过不保留
    if (!rowPdt && !rowSkc) {
      continue;
    }
    const isAllBlank = row.every((c) => !c || !String(c).trim());
    if (isAllBlank) {
      continue;
    }

    const liveDate = String(row[4] || '').trim();

    if (rowSkc && liveDate) {
      oldLiveDateBySkc.set(rowSkc, liveDate);
    }

    if (pdtSet.has(rowPdt) || skcSet.has(rowSkc)) {
      affectedOldRows.push(row);
      if (rowSkc) oldSkcSeen.add(rowSkc);
    } else {
      unaffectedRows.push(row);
    }
  }

  // 4. 构建本次新增/更新的行
  const nowStr = formatDateTime();
  const newRows = [];
  const newSkcSeen = new Set();
  const seenSyncKeys = new Set();
  let updatedCount = 0;
  let appendedCount = 0;

  for (const it of items) {
    const pdt = String(it.pdt || '').trim().toUpperCase();
    const skc = String(it.skc || '').trim().toUpperCase();
    const pieces = Number(it.pieces) || 0;
    const days = Number(it.days) || 0;

    // 过滤无实质翻单量的行（件数和天数均 <= 0）
    if (pieces <= 0 && days <= 0) continue;

    // 同一 (款号, SKC, 件数, 天数) 只写入一行，避免同一颜色下多条面料或多仓库导致同一批次重复写多行
    const syncKey = `${pdt}|${skc}|${pieces}|${days}`;
    if (seenSyncKeys.has(syncKey)) {
      console.log(`[dingtalk-plan-sync] 跳过重复批次: ${syncKey}`);
      continue;
    }
    seenSyncKeys.add(syncKey);

    newSkcSeen.add(skc);

    // 统计指标
    if (oldSkcSeen.has(skc)) {
      updatedCount++;
    } else {
      appendedCount++;
    }

    const liveDate = oldLiveDateBySkc.get(skc) || '';
    const color = String(it.color || '').trim();
    const cycle = days > 0 ? `${days}天之内` : '';

    // 生成的文字信息（单 SKC）
    const skcText =
      per_skc_text[it.skc] ||
      per_skc_text[skc] ||
      per_skc_text[skc.toLowerCase()] ||
      (color ? `${color} ${pieces}件${days}天` : '');

    newRows.push([
      pdt,
      skc,
      pieces,
      cycle,
      liveDate,
      color,
      nowStr,
      '', // 翻单周期（表格）
      skcText,
      full_text || '',
    ]);
  }

  // 计算被完全清空的旧 SKC 数量
  let clearedCount = 0;
  for (const skc of oldSkcSeen) {
    if (!newSkcSeen.has(skc)) {
      clearedCount++;
    }
  }

  // 5. 组合最终新表数据
  const finalRows = [header, ...unaffectedRows, ...newRows];
  const oldTotalRows = existingDataRows.length;
  const newTotalRows = unaffectedRows.length + newRows.length;

  console.log(`[dingtalk-plan-sync] 合成完成: 旧行数 ${oldTotalRows} -> 新行数 ${newTotalRows} (更新 ${updatedCount}, 追加 ${appendedCount}, 清空 ${clearedCount})`);

  // 6. 执行写入操作
  // 为确保旧多余行彻底删除（如清空或合并批次），先 clear 数据区域 A2:J(maxRows)
  const maxClearRow = Math.max(oldTotalRows + 30, newTotalRows + 30, 200);
  try {
    await execFileAsync(
      'dws',
      [
        'sheet',
        'range',
        'clear',
        '--node',
        DINGTALK_PLAN_NODE_URL,
        '--sheet-id',
        DINGTALK_PLAN_SHEET_ID,
        '--range',
        `A2:J${maxClearRow}`,
        '--yes',
      ],
      { timeout: 15000 }
    );
  } catch (clearErr) {
    console.warn('[dingtalk-plan-sync] range clear 告警:', clearErr.message);
  }

  // 将 finalRows 写入临时文件，使用 csv-put 批量写入
  const csvContent = finalRows.map(toCsvRow).join('\n');
  const tmpFile = path.join(os.tmpdir(), `dingtalk_plan_sync_${Date.now()}_${Math.random().toString(36).slice(2)}.csv`);

  try {
    await fs.promises.writeFile(tmpFile, csvContent, 'utf8');

    const { stdout: putOut } = await execFileAsync(
      'dws',
      [
        'sheet',
        'csv-put',
        '--node',
        DINGTALK_PLAN_NODE_URL,
        '--sheet-id',
        DINGTALK_PLAN_SHEET_ID,
        '--start-cell',
        'A1',
        '--allow-overwrite',
        '--csv',
        `@${tmpFile}`,
      ],
      { timeout: 30000 }
    );
    console.log('[dingtalk-plan-sync] csv-put 完成:', putOut.trim());
  } catch (putErr) {
    throw new Error(`写入钉钉表格数据失败: ${putErr.message}`);
  } finally {
    try {
      await fs.promises.unlink(tmpFile);
    } catch {}
  }

  const durationMs = Date.now() - t0;
  console.log(`[dingtalk-plan-sync] 同步钉钉「计划翻单量」成功，耗时 ${durationMs}ms`);

  return {
    success: true,
    updatedCount,
    appendedCount,
    clearedCount,
    totalRows: newTotalRows,
    durationMs,
  };
}
