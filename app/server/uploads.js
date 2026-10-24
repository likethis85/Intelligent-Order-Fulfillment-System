import { Router } from 'express';
import multer from 'multer';
import { mkdir, unlink, readFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { isOssConfigured, generatePostPolicy, uploadBufferToOss, deleteOssObject, getOssConfig } from './oss-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = join(__dirname, '.cache', 'uploads');
try {
  mkdirSync(UPLOAD_DIR, { recursive: true });
} catch {}
const MAX_BYTES = 50 * 1024 * 1024; // 50MB（手机原图通常 2-5MB）

// 接受 image/*（手机原图常见 jpg/png/heic/webp/pjpeg/x-png）
const ALLOWED_MIME = /^image\/(jpeg|jpg|png|webp|heic|heif|gif|pjpeg|x-png)$/i;
const ALLOWED_EXT = /\.(jpe?g|png|webp|heic|heif|gif)$/i;

const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    try {
      await mkdir(UPLOAD_DIR, { recursive: true });
      cb(null, UPLOAD_DIR);
    } catch (err) {
      cb(err);
    }
  },
  filename: (_req, file, cb) => {
    // 时间戳 + 原始扩展名（避免重名）
    const ext = (extname(file.originalname) || mimeToExt(file.mimetype) || '.jpg').toLowerCase();
    const id = createHash('sha1').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 12);
    cb(null, `${id}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    const ext = extname(file.originalname || '').toLowerCase();
    if (ALLOWED_MIME.test(file.mimetype) || ALLOWED_EXT.test(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`不支持的图片格式（${file.mimetype || ext || '未知'}），请上传 jpg/png/webp 等格式图片`));
    }
  },
});

function mimeToExt(mime) {
  const map = {
    'image/jpeg': '.jpg',
    'image/pjpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/x-png': '.png',
    'image/webp': '.webp',
    'image/heic': '.heic',
    'image/heif': '.heif',
    'image/gif': '.gif',
  };
  return map[(mime || '').toLowerCase()] || '';
}

const router = Router();

// 获取前端直传阿里云 OSS 的临时凭证（直传绕过单机出口瓶颈，极速上传）
router.get('/oss-params', (req, res) => {
  if (!isOssConfigured()) {
    return res.json({ ossEnabled: false });
  }
  try {
    const filename = String(req.query.filename || '').trim();
    const params = generatePostPolicy(filename);
    res.json({ ossEnabled: true, ...params });
  } catch (err) {
    res.status(500).json({ ossEnabled: false, error: err.message });
  }
});

// 单图上传：前端 FormData.append('file', file)
// 若配置了 OSS，服务端将文件转存至 OSS，并返回 OSS 永久高速访问地址；同时在本地保留备份
router.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file', message: '请在 multipart/form-data 里提供 file 字段' });

  let finalUrl = `/uploads/${req.file.filename}`;

  if (isOssConfigured()) {
    try {
      const cfg = getOssConfig();
      const key = `${cfg.dir}${req.file.filename}`;
      const buffer = await readFile(req.file.path);
      finalUrl = await uploadBufferToOss(key, buffer, req.file.mimetype || 'image/jpeg');
    } catch (err) {
      console.warn('[upload] 转存 OSS 失败，回退本地存储:', err.message);
    }
  }

  res.json({
    ok: true,
    url: finalUrl,
    bytes: req.file.size,
    filename: req.file.filename,
    original: req.file.originalname,
  });
});

// multer 错（超限 / 类型不符）会走到这里 — express 自带的 error handler 把它当成 500，
// 我们包一层返回 400 + 友好 message
router.use((err, _req, res, next) => {
  if (err) {
    const code = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(code).json({ error: err.code || 'upload_failed', message: err.message });
  }
  next();
});

export { router, UPLOAD_DIR };

// 从自传图 URL（/uploads/xxx 或 OSS URL 或七牛等）解析出标准文件名
export function extractFilenameFromUploadUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const clean = url.split(/[?#]/)[0].trim();
  const m = clean.match(/(?:^|\/)(?:trays\/uploads|uploads)\/([^\/]+)$/i);
  if (m && m[1]) {
    return decodeURIComponent(m[1]).trim();
  }
  // 若传入的就是纯文件名（如 0f14d7984485.jpg）
  if (/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(clean)) {
    return clean;
  }
  return null;
}

// 物理删除自传图片（同时清理本地存储与阿里云 OSS）
export async function deleteUploadedImage(urlOrFilename) {
  const cleanFilename = extractFilenameFromUploadUrl(urlOrFilename);
  if (!cleanFilename || cleanFilename.includes('..')) return false;

  let localDeleted = false;
  let ossDeleted = false;

  // 1. 本地磁盘文件物理删除
  try {
    const localPath = join(UPLOAD_DIR, cleanFilename);
    if (existsSync(localPath)) {
      await unlink(localPath);
      localDeleted = true;
    }
  } catch (err) {
    console.warn(`[uploads] 本地删除文件 ${cleanFilename} 异常:`, err.message);
  }

  // 2. 阿里云 OSS 对象物理删除
  if (isOssConfigured()) {
    try {
      const cfg = getOssConfig();
      const ossKey = `${cfg.dir}${cleanFilename}`;
      ossDeleted = await deleteOssObject(ossKey);
    } catch (err) {
      console.warn(`[uploads] OSS 删除文件 ${cleanFilename} 异常:`, err.message);
    }
  }

  return localDeleted || ossDeleted;
}

// 兼容别名
export const removeUploadFile = deleteUploadedImage;