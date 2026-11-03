// 货盘云端存储：单用户场景，磁盘 JSON 存一份
// 路径：.cache/trays.json
// 写盘时同时留一份带时间戳的历史快照（最多 50 份），误删可恢复
import { mkdir, readFile, readdir, unlink, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getOssPublicUrl } from './oss-client.js';
import { deleteUploadedImage, extractFilenameFromUploadUrl, UPLOAD_DIR } from './uploads.js';
import { writeJsonAtomic } from './atomic-write.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// 允许测试把整份缓存目录指到临时目录（TRAYS_CACHE_DIR），避免碰到线上 trays.json
const CACHE_DIR = process.env.TRAYS_CACHE_DIR || join(__dirname, '.cache');
const TRAYS_FILE = join(CACHE_DIR, 'trays.json');
const SNAPSHOT_DIR = join(CACHE_DIR, 'trays-snapshots');
const MAX_SNAPSHOTS = 50;
// 回收站保留天数：删除的货盘（trashedAt）超过这个期限就在保存时真正清掉，
// 同时 cleanupAbandonedImages 会删掉它的自传图片。前端 TraysPage 的提示文案用同一个 30 天。
const TRASH_RETENTION_DAYS = Number(process.env.TRAYS_TRASH_RETENTION_DAYS) || 30;
const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;

// 回收站里的货盘是否已过期（trashedAt 缺失/非法一律当正常货盘，不误删）
export function isTrashExpired(tray, now = Date.now()) {
  if (!tray || !tray.trashedAt) return false;
  const at = new Date(tray.trashedAt).getTime();
  return Number.isFinite(at) && now - at > TRASH_RETENTION_MS;
}

// 删除墓碑：彻底删除的货盘 id + 时间，随 trays 一起持久化。
// 没有墓碑时，别的客户端只要还开着旧数据，下一次保存就会把已删货盘原样带回服务端
//（线上「彻底删除不生效」就是这么来的）。墓碑口径与前端 src/lib/trayTrash.ts 保持一致。
const TOMBSTONE_KEEP_DAYS = 180;
const TOMBSTONE_KEEP_MS = TOMBSTONE_KEEP_DAYS * 24 * 60 * 60 * 1000;

export function isTombstoned(tray, tombstones) {
  if (!tray || !tray.id || !Array.isArray(tombstones)) return false;
  const tomb = tombstones.find((x) => x && x.id === tray.id);
  if (!tomb) return false;
  const at = new Date(tomb.at).getTime();
  if (!Number.isFinite(at)) return false;
  // 墓碑之后又被重建/修改过的货盘（updatedAt 更新）不算被删
  const trayAt = tray.updatedAt ? new Date(tray.updatedAt).getTime() : 0;
  return !Number.isFinite(trayAt) || trayAt <= at;
}

// 合并墓碑（同 id 取较新的），裁掉超过保留期的记录
export function mergeTombstones(a, b, now = Date.now()) {
  const map = new Map();
  for (const t of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    if (!t || !t.id || !t.at) continue;
    const prev = map.get(t.id);
    if (!prev || new Date(t.at).getTime() > new Date(prev.at).getTime()) map.set(t.id, t);
  }
  return [...map.values()]
    .filter((t) => !(new Date(t.at).getTime() < now - TOMBSTONE_KEEP_MS))
    .sort((x, y) => String(y.at).localeCompare(String(x.at)));
}

function normalizeUploadUrl(url) {
  if (!url || typeof url !== 'string') return url;
  const str = url.trim();
  if (/^\/?uploads\//i.test(str)) {
    return getOssPublicUrl(str);
  }
  const match = str.match(/^https?:\/\/[^\/]+\/uploads\/(.+)$/i);
  if (match) {
    return getOssPublicUrl(match[1]);
  }
  return str;
}

export function cleanTrayImages(tray) {
  if (!tray || typeof tray !== 'object' || !Array.isArray(tray.sections)) return tray;
  return {
    ...tray,
    sections: tray.sections.map((section) => ({
      ...section,
      looks: (section.looks || []).map((look) => {
        let changed = false;
        let nextUserImg = look.userImg;
        if (look.userImg) {
          const norm = normalizeUploadUrl(look.userImg);
          if (norm !== look.userImg) {
            nextUserImg = norm;
            changed = true;
          }
        }
        let nextUserImgs = look.userImgs;
        if (look.userImgs && typeof look.userImgs === 'object') {
          const updated = {};
          for (const [pid, u] of Object.entries(look.userImgs)) {
            const norm = normalizeUploadUrl(u);
            if (norm !== u) changed = true;
            updated[pid] = norm;
          }
          if (changed) nextUserImgs = updated;
        }
        return changed ? { ...look, userImg: nextUserImg, userImgs: nextUserImgs } : look;
      }),
    })),
  };
}

// 提取货盘集合中所有被引用的自传图片文件名（全小写集合）
export function extractReferencedImageFilenames(trays) {
  const referenced = new Set();
  if (!Array.isArray(trays)) return referenced;
  for (const tray of trays) {
    if (!tray || !Array.isArray(tray.sections)) continue;
    for (const section of tray.sections) {
      if (!section || !Array.isArray(section.looks)) continue;
      for (const look of section.looks) {
        if (!look) continue;
        if (typeof look.userImg === 'string' && look.userImg.trim()) {
          const fn = extractFilenameFromUploadUrl(look.userImg);
          if (fn) referenced.add(fn.toLowerCase());
        }
        if (look.userImgs && typeof look.userImgs === 'object') {
          for (const u of Object.values(look.userImgs)) {
            if (typeof u === 'string' && u.trim()) {
              const fn = extractFilenameFromUploadUrl(u);
              if (fn) referenced.add(fn.toLowerCase());
            }
          }
        }
      }
    }
  }
  return referenced;
}

// 增量清理：当货盘发生变动（恢复原图 / 删除坑位 / 更换主图 / 删除货盘）时，
// 找出在旧货盘中存在、但在当前所有货盘中均不再被引用的自传图片，执行物理删除
// 增量清理：当货盘发生变动（恢复原图 / 删除坑位 / 更换主图 / 删除货盘）时，
// 找出在旧货盘中存在、但在当前所有货盘中均不再被引用的自传图片，执行物理删除
async function cleanupAbandonedImages(prevTrays, currentTrays) {
  if (!prevTrays || prevTrays.length === 0) return;
  // 安全门禁：若当前货盘为空数组，可能为异常清空，拒绝触发全量删除
  if (!currentTrays || currentTrays.length === 0) {
    console.warn('[uploads-gc] 当前货盘为空，跳过废弃图片物理删除以防止误删');
    return;
  }
  const prevFilenames = extractReferencedImageFilenames(prevTrays);
  if (prevFilenames.size === 0) return;

  const currentFilenames = extractReferencedImageFilenames(currentTrays);
  const abandoned = [];
  for (const fn of prevFilenames) {
    if (!currentFilenames.has(fn)) {
      abandoned.push(fn);
    }
  }

  if (abandoned.length === 0) return;
  console.log(`[uploads-gc] 货盘变动检测到 ${abandoned.length} 张废弃自传图片，执行物理删除:`, abandoned);

  for (const fn of abandoned) {
    try {
      await deleteUploadedImage(fn);
      console.log(`[uploads-gc] 已成功物理删除废弃自传图: ${fn}`);
    } catch (e) {
      console.warn(`[uploads-gc] 物理删除图片 ${fn} 异常:`, e.message);
    }
  }
}

// 从历史快照中寻找并加载最新的有效快照（用于 trays.json 损坏或丢失时的灾难恢复）
export async function loadLatestSnapshot() {
  if (!existsSync(SNAPSHOT_DIR)) return null;
  try {
    const files = (await readdir(SNAPSHOT_DIR))
      .filter((f) => f.startsWith('trays-') && f.endsWith('.json'))
      .sort()
      .reverse();
    for (const file of files) {
      try {
        const text = await readFile(join(SNAPSHOT_DIR, file), 'utf8');
        const j = JSON.parse(text);
        if (j && Array.isArray(j.trays) && j.trays.length > 0) {
          return {
            snapshotFile: file,
            trays: j.trays.map((t) => cleanTrayImages(t)),
            tombstones: Array.isArray(j.tombstones) ? j.tombstones : [],
          };
        }
      } catch {
        // 单个快照文件损坏继续尝试下一个
      }
    }
  } catch (err) {
    console.warn('[trays-store] 读取历史快照失败:', err.message);
  }
  return null;
}

// 从历史快照中提取所有被引用的图片文件名（全小写集合）
// 保护期机制：默认保护最近 7 天内的快照，防止回退历史快照时出现死链
export async function extractReferencedImageFilenamesFromSnapshots(options = {}) {
  const referenced = new Set();
  if (!existsSync(SNAPSHOT_DIR)) return referenced;
  const maxAgeMs = Number(options.maxAgeMs) || (7 * 24 * 60 * 60 * 1000);
  const now = Date.now();
  try {
    const files = (await readdir(SNAPSHOT_DIR))
      .filter((f) => f.startsWith('trays-') && f.endsWith('.json'))
      .sort()
      .reverse();
    // 保护最近的 30 份快照
    for (const file of files.slice(0, 30)) {
      const snapPath = join(SNAPSHOT_DIR, file);
      try {
        const st = await stat(snapPath);
        if (now - st.mtimeMs > maxAgeMs) continue;
        const text = await readFile(snapPath, 'utf8');
        const j = JSON.parse(text);
        if (j && Array.isArray(j.trays)) {
          const snapRefs = extractReferencedImageFilenames(j.trays);
          for (const fn of snapRefs) referenced.add(fn);
        }
      } catch {
        // 单个快照损坏跳过
      }
    }
  } catch (err) {
    console.warn('[trays-store] 读取历史快照图片引用异常:', err.message);
  }
  return referenced;
}

// 严格带状态与熔断保护的货盘加载函数
// 绝不将“读取或解析失败”静默当成“空货盘 []”，并支持快照自动容灾恢复
export async function loadTraysWithStatus() {
  if (!existsSync(TRAYS_FILE)) {
    // trays.json 不存在时，先检查是否存在历史快照（防止主文件被误删/未挂载）
    const snap = await loadLatestSnapshot();
    if (snap) {
      console.warn(`[trays-store] trays.json 不存在，但已自动从最新历史快照 ${snap.snapshotFile} 恢复 (${snap.trays.length} 个货盘)`);
      return { ok: true, trays: snap.trays, tombstones: snap.tombstones || [], from: 'snapshot', snapshotFile: snap.snapshotFile };
    }
    return { ok: true, trays: [], tombstones: [], from: 'empty' };
  }

  try {
    const text = await readFile(TRAYS_FILE, 'utf8');
    if (!text || !text.trim()) {
      throw new Error('trays.json 文件为空 (0 字节)');
    }
    const j = JSON.parse(text);
    if (!j || !Array.isArray(j.trays)) {
      throw new Error('trays.json 缺少 trays 数组结构');
    }
    const trays = j.trays.map((t) => cleanTrayImages(t));
    return { ok: true, trays, tombstones: Array.isArray(j.tombstones) ? j.tombstones : [], from: 'file' };
  } catch (err) {
    console.error(`[trays-store] CRITICAL: 读取或解析 trays.json 失败 (${err.message})，尝试从历史快照恢复...`);
    const snap = await loadLatestSnapshot();
    if (snap) {
      console.warn(`[trays-store] 已成功从最新历史快照 ${snap.snapshotFile} 恢复货盘数据 (${snap.trays.length} 个货盘)`);
      return { ok: true, trays: snap.trays, tombstones: snap.tombstones || [], from: 'snapshot', snapshotFile: snap.snapshotFile };
    }
    console.error('[trays-store] FATAL: 历史快照无可恢复数据，货盘加载失败!');
    return { ok: false, error: err, trays: null, tombstones: [] };
  }
}

// 全局扫盘清理孤儿图片文件（可作为定时任务 / 启动时自检 / 手动触发）
// 保护机制：
// 1. 货盘数据加载熔断：读取或解析失败时，绝不执行清理，立即中止；
// 2. 空货盘安全门禁：若当前货盘为空但本地存在图片，除非显式指定 forceEmptyTrays，否则绝不清理；
// 3. 快照引用双重保护：同时保护当前货盘与历史快照中的引用图片；
// 4. 上传保护期：默认 15 分钟内创建或修改的文件受保护，避免客户端上传并发中的竞态；
// 5. 大批量删除熔断：待删除文件比例异常过高时 (>70% 且 >15个) 熔断中止，防止灾难性误删。
export async function cleanOrphanedUploads(currentTrays, options = {}) {
  const gracePeriodMs = Number(options.gracePeriodMs) || (15 * 60 * 1000);
  const forceEmptyTrays = Boolean(options.forceEmptyTrays);
  const forceMassDelete = Boolean(options.forceMassDelete);

  if (!existsSync(UPLOAD_DIR)) {
    return { scanned: 0, deleted: 0, freedBytes: 0, deletedFiles: [] };
  }

  // 1. 确定当前有效货盘列表（带失败熔断保护）
  let activeTrays = null;
  if (Array.isArray(currentTrays)) {
    activeTrays = currentTrays;
  } else {
    const status = await loadTraysWithStatus();
    if (!status.ok) {
      console.error(`[uploads-gc] 货盘文件读取或解析失败，触发安全熔断保护，立即终止图片清理以避免误删! 错误原因: ${status.error?.message}`);
      return {
        scanned: 0,
        deleted: 0,
        freedBytes: 0,
        deletedFiles: [],
        aborted: true,
        reason: 'load_trays_failed',
        error: status.error?.message,
      };
    }
    activeTrays = status.trays;
  }

  // 2. 扫描本地图片文件
  const localFiles = (await readdir(UPLOAD_DIR)).filter((file) =>
    /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(file)
  );

  // 3. 空货盘安全门禁 (Safety Gate)
  if (activeTrays.length === 0 && localFiles.length > 0 && !forceEmptyTrays) {
    console.warn(`[uploads-gc] 货盘列表为空但本地存在 ${localFiles.length} 个图片文件，触发安全熔断保护，终止清理以防止误删!`);
    return {
      scanned: localFiles.length,
      deleted: 0,
      freedBytes: 0,
      deletedFiles: [],
      aborted: true,
      reason: 'empty_trays_safety_stop',
    };
  }

  // 4. 提取被引用的文件名集合（当前货盘 + 历史快照双重保护）
  const referenced = extractReferencedImageFilenames(activeTrays);
  if (options.checkSnapshots !== false) {
    const snapshotRefs = await extractReferencedImageFilenamesFromSnapshots();
    for (const fn of snapshotRefs) {
      referenced.add(fn);
    }
  }

  // 5. 零引用安全熔断
  if (localFiles.length > 0 && referenced.size === 0 && !forceEmptyTrays) {
    console.warn(`[uploads-gc] 扫描到 ${localFiles.length} 个文件但引用集合为 0，触发安全熔断保护，终止清理以防止误删!`);
    return {
      scanned: localFiles.length,
      deleted: 0,
      freedBytes: 0,
      deletedFiles: [],
      aborted: true,
      reason: 'zero_references_safety_stop',
    };
  }

  // 6. 扫描待删除候选文件（先收集做安全判定，再物理执行）
  const now = Date.now();
  let scanned = 0;
  const candidates = [];

  for (const file of localFiles) {
    scanned++;
    const fnLower = file.toLowerCase();
    if (referenced.has(fnLower)) {
      continue;
    }

    const filePath = join(UPLOAD_DIR, file);
    try {
      const st = await stat(filePath);
      // 保护期内的最新上传文件不清理（默认 15 分钟）
      if (now - st.mtimeMs < gracePeriodMs) {
        continue;
      }
      candidates.push({ file, size: st.size || 0 });
    } catch (err) {
      console.warn(`[uploads-gc] 检查文件 ${file} 状态失败:`, err.message);
    }
  }

  // 7. 大批量删除熔断保护 (Mass Deletion Circuit Breaker)
  if (candidates.length > 15 && candidates.length > scanned * 0.7 && !forceMassDelete) {
    console.warn(`[uploads-gc] 触发大批量删除熔断保护：拟删除 ${candidates.length} / ${scanned} 个文件 (>70%)，已终止操作以防灾难性误删! (若确需大批量删除请传入 forceMassDelete: true)`);
    return {
      scanned,
      deleted: 0,
      freedBytes: 0,
      deletedFiles: [],
      aborted: true,
      reason: 'mass_deletion_circuit_breaker',
      candidateCount: candidates.length,
    };
  }

  // 8. 正式执行物理删除
  let deleted = 0;
  let freedBytes = 0;
  const deletedFiles = [];

  for (const { file, size } of candidates) {
    try {
      await deleteUploadedImage(file);
      deleted++;
      freedBytes += size;
      deletedFiles.push(file);
    } catch (err) {
      console.warn(`[uploads-gc] 扫盘清理文件 ${file} 失败:`, err.message);
    }
  }

  if (deleted > 0) {
    const kb = (freedBytes / 1024).toFixed(1);
    console.log(`[uploads-gc] 孤儿图片垃圾清理完成：扫描 ${scanned} 个本地文件，物理清除 ${deleted} 个孤儿废弃文件，释放 ${kb} KB 空间`);
  }

  return { scanned, deleted, freedBytes, deletedFiles };
}

async function load() {
  const res = await loadTraysWithStatus();
  if (!res.ok) {
    throw new Error(`货盘数据文件读取或解析失败: ${res.error?.message || '未知错误'}`);
  }
  return { trays: res.trays, tombstones: Array.isArray(res.tombstones) ? res.tombstones : [] };
}

// 写盘串行化：save() 会「读旧数据 → 快照 → 覆盖」，这两步并发就会互相踩。
// 以前所有请求共用 `<trays>.tmp` 一个临时文件：A 写完 tmp、B 又写同一个 tmp，
// A 先 rename 成功，B 再 rename 就是 ENOENT（接口 500，这一笔写丢）。
// 即便不报错，两个响应的顺序也会乱（旧数据覆盖新数据）。
// 把整个 save 排进队列，最后发起的那次写就是最终落盘的版本。
// （临时文件本身的原子写由 atomic-write.js 统一处理，vscm 缓存也走同一份实现）
let saveChain = Promise.resolve();

function enqueueSave(task) {
  const run = saveChain.then(task);
  saveChain = run.then(() => {}, () => {}); // 一次失败不能卡死后续写盘
  return run;
}

async function save(trays, tombstones = []) {
  return enqueueSave(async () => {
    await mkdir(CACHE_DIR, { recursive: true });
    // 读取旧托盘以便对比哪些图片被废弃（恢复原图/删除坑位/删除货盘）
    let prevTrays = [];
    let fileTombstones = [];
    try {
      const status = await loadTraysWithStatus();
      if (status.ok && Array.isArray(status.trays)) {
        prevTrays = status.trays;
        fileTombstones = Array.isArray(status.tombstones) ? status.tombstones : [];
      }
    } catch {}

    // 先留一份当前快照，再覆盖
    await snapshot(trays);
    const now = Date.now();
    const mergedTombstones = mergeTombstones(fileTombstones, tombstones, now);

    // 1) 墓碑货盘：其他客户端拿着旧数据保存带回来的，直接丢弃（彻底删除才真正生效）
    let next = (Array.isArray(trays) ? trays : []).filter((t) => !isTombstoned(t, mergedTombstones));
    // 2) 防误覆盖：客户端这次没带、也没有墓碑的货盘一律保留。
    //    正常删除只有两条路——进回收站（还在数组里）和彻底删除（有墓碑），
    //    所以「凭空少掉」的货盘只会是客户端数据残缺（例如加载失败只剩一个货盘）导致的。
    const incomingIds = new Set(next.map((t) => t.id));
    const recovered = [];
    for (const t of prevTrays) {
      if (!t?.id || incomingIds.has(t.id) || isTombstoned(t, mergedTombstones)) continue;
      next.push(t);
      incomingIds.add(t.id);
      recovered.push(t.name || t.id);
    }
    if (recovered.length > 0) {
      console.warn(`[trays-store] 客户端提交缺少 ${recovered.length} 个货盘（${recovered.slice(0, 5).join('、')}${recovered.length > 5 ? ' 等' : ''}），已从服务端保留，避免残缺数据冲掉货盘`);
    }
    // 3) 回收站过期清理：过期货盘从数据里真正移除（其自传图随后由 cleanupAbandonedImages 一起清掉）
    const kept = next.filter((t) => !isTrashExpired(t, now));
    if (kept.length !== next.length) {
      console.log(`[trays-store] 回收站过期清理 ${next.length - kept.length} 个货盘（保留 ${TRASH_RETENTION_DAYS} 天）`);
    }
    // 清洗上游可能带进来的括号与自传图地址（自动迁移至阿里云 OSS 高速 CDN 地址）
    const cleaned = kept.map((t) => cleanTrayImages(cleanTrayFabric(t)));
    const payload = {
      at: Date.now(),
      count: cleaned.length,
      trays: cleaned,
      tombstones: mergedTombstones,
    };
    await writeJsonAtomic(TRAYS_FILE, payload);

    // 异步执行废弃自传图片物理清理（不阻塞主响应）
    cleanupAbandonedImages(prevTrays, cleaned).catch((err) => {
      console.warn('[trays-store] 清理废弃图片异常:', err.message);
    });
  });
}


// 面料文案清洗：去掉行尾孤立/成对括号（允许括号后带空白）
function cleanFabricText(text) {
  if (text === undefined || text === null) return text;
  return String(text)
    .split('\n')
    .map((line) =>
      line
        .replace(/\s*[（(][^）)]*[）)]\s*$/g, '')
        .replace(/[）)]\s*$/g, ''))
    .join('\n');
}

function cleanTrayFabric(t) {
  if (!t || typeof t !== 'object') return t;
  const next = { ...t };
  if (next.fabricOverrides && typeof next.fabricOverrides === 'object') {
    next.fabricOverrides = Object.fromEntries(
      Object.entries(next.fabricOverrides).map(([k, v]) => [k, cleanFabricText(v)]),
    );
  }
  if (Array.isArray(next.noRestockItems)) {
    next.noRestockItems = next.noRestockItems.map((it) =>
      it && typeof it === 'object'
        ? { ...it, color: it.color ? String(it.color).replace(/[）)]$/g, '') : it.color }
        : it,
    );
  }
  return next;
}

// 保留最近 N 份快照（按时间戳文件名排序）
async function snapshot(trays) {
  try {
    if (!existsSync(TRAYS_FILE)) return;
    const st = await stat(TRAYS_FILE);
    if (st.size < 100) return; // 太小的快照不值得保留
    await mkdir(SNAPSHOT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const snapFile = join(SNAPSHOT_DIR, `trays-${stamp}.json`);
    const { copyFile } = await import('node:fs/promises');
    await copyFile(TRAYS_FILE, snapFile);
    // 清理老的快照
    const files = (await readdir(SNAPSHOT_DIR))
      .filter((f) => f.startsWith('trays-') && f.endsWith('.json'))
      .sort();
    while (files.length > MAX_SNAPSHOTS) {
      await unlink(join(SNAPSHOT_DIR, files.shift())).catch(() => {});
    }
  } catch (err) {
    console.warn('[trays-store] snapshot 失败:', err.message);
  }
}

export async function listSnapshots() {
  try {
    if (!existsSync(SNAPSHOT_DIR)) return [];
    const files = await readdir(SNAPSHOT_DIR);
    return files
      .filter((f) => f.startsWith('trays-') && f.endsWith('.json'))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

export async function loadTrays() {
  const { trays, tombstones } = await load();
  const now = Date.now();
  // 已彻底删除（墓碑）和回收站过期的货盘都不下发
  const active = trays
    .filter((t) => !isTombstoned(t, tombstones))
    .filter((t) => !isTrashExpired(t, now));
  return { trays: active, tombstones, at: Date.now() };
}

export async function saveTrays(trays, tombstones = []) {
  if (!Array.isArray(trays)) throw new Error('trays 必须是数组');
  await save(trays, tombstones);
  return { ok: true, at: Date.now(), count: trays.length };
}