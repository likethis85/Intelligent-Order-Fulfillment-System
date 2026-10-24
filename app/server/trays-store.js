// 货盘云端存储：单用户场景，磁盘 JSON 存一份
// 路径：.cache/trays.json
// 写盘时同时留一份带时间戳的历史快照（最多 50 份），误删可恢复
import { mkdir, readFile, writeFile, readdir, unlink, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getOssPublicUrl } from './oss-client.js';
import { deleteUploadedImage, extractFilenameFromUploadUrl, UPLOAD_DIR } from './uploads.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CACHE_DIR = join(__dirname, '.cache');
const TRAYS_FILE = join(CACHE_DIR, 'trays.json');
const SNAPSHOT_DIR = join(CACHE_DIR, 'trays-snapshots');
const MAX_SNAPSHOTS = 50;

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
async function cleanupAbandonedImages(prevTrays, currentTrays) {
  if (!prevTrays || prevTrays.length === 0) return;
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

// 全局扫盘清理孤儿图片文件（可作为定时任务 / 启动时自检 / 手动触发）
// 保护期机制：默认 15 分钟内创建或修改的文件受保护，避免客户端上传并发中的竞态
export async function cleanOrphanedUploads(currentTrays, options = {}) {
  const gracePeriodMs = Number(options.gracePeriodMs) || (15 * 60 * 1000);
  const activeTrays = Array.isArray(currentTrays) ? currentTrays : await load();
  const referenced = extractReferencedImageFilenames(activeTrays);

  if (!existsSync(UPLOAD_DIR)) {
    return { scanned: 0, deleted: 0, freedBytes: 0, deletedFiles: [] };
  }

  const files = await readdir(UPLOAD_DIR);
  const now = Date.now();
  let scanned = 0;
  let deleted = 0;
  let freedBytes = 0;
  const deletedFiles = [];

  for (const file of files) {
    if (!/\.(jpe?g|png|webp|gif|heic|heif)$/i.test(file)) continue;
    scanned++;
    const fnLower = file.toLowerCase();
    if (referenced.has(fnLower)) {
      continue;
    }

    const filePath = join(UPLOAD_DIR, file);
    try {
      const st = await stat(filePath);
      // 保护期内的最新上传文件不清理
      if (now - st.mtimeMs < gracePeriodMs) {
        continue;
      }

      const size = st.size || 0;
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
  try {
    const text = await readFile(TRAYS_FILE, 'utf8');
    const j = JSON.parse(text);
    const trays = j && Array.isArray(j.trays) ? j.trays : [];
    return trays.map((t) => cleanTrayImages(t));
  } catch {
    return [];
  }
}

async function save(trays) {
  await mkdir(CACHE_DIR, { recursive: true });
  // 读取旧托盘以便对比哪些图片被废弃（恢复原图/删除坑位/删除货盘）
  let prevTrays = [];
  try {
    if (existsSync(TRAYS_FILE)) {
      const oldText = await readFile(TRAYS_FILE, 'utf8');
      const oldJ = JSON.parse(oldText);
      if (oldJ && Array.isArray(oldJ.trays)) {
        prevTrays = oldJ.trays;
      }
    }
  } catch {}

  // 先留一份当前快照，再覆盖
  await snapshot(trays);
  // 清洗上游可能带进来的括号与自传图地址（自动迁移至阿里云 OSS 高速 CDN 地址）
  const cleaned = trays.map((t) => cleanTrayImages(cleanTrayFabric(t)));
  const payload = {
    at: Date.now(),
    count: cleaned.length,
    trays: cleaned,
  };
  const tmp = TRAYS_FILE + '.tmp';
  await writeFile(tmp, JSON.stringify(payload), 'utf8');
  const { rename } = await import('node:fs/promises');
  await rename(tmp, TRAYS_FILE);

  // 异步执行废弃自传图片物理清理（不阻塞主响应）
  cleanupAbandonedImages(prevTrays, cleaned).catch((err) => {
    console.warn('[trays-store] 清理废弃图片异常:', err.message);
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
  const trays = await load();
  return { trays, at: Date.now() };
}

export async function saveTrays(trays) {
  if (!Array.isArray(trays)) throw new Error('trays 必须是数组');
  await save(trays);
  return { ok: true, at: Date.now(), count: trays.length };
}