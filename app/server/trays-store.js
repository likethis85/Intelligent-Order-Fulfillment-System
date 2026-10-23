// 货盘云端存储：单用户场景，磁盘 JSON 存一份
// 路径：.cache/trays.json
// 写盘时同时留一份带时间戳的历史快照（最多 5 份），误删可恢复
import { mkdir, readFile, writeFile, readdir, unlink, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getOssPublicUrl } from './oss-client.js';

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