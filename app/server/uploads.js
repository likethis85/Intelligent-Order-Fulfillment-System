import { Router } from 'express';
import multer from 'multer';
import { mkdir, unlink } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = join(__dirname, '.cache', 'uploads');
const MAX_BYTES = 50 * 1024 * 1024; // 50MB（手机原图通常 2-5MB）

// 接受 image/*（手机原图常见 jpg/png/heic/webp）
const ALLOWED_MIME = /^image\/(jpeg|jpg|png|webp|heic|heif|gif)$/i;

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
    if (ALLOWED_MIME.test(file.mimetype)) cb(null, true);
    else cb(new Error(`unsupported mime ${file.mimetype}`));
  },
});

function mimeToExt(mime) {
  const map = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic', 'image/heif': '.heif', 'image/gif': '.gif' };
  return map[mime.toLowerCase()] || '';
}

const router = Router();

// 单图上传：前端 FormData.append('file', file)
router.post('/', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file', message: '请在 multipart/form-data 里提供 file 字段' });
  const url = `/uploads/${req.file.filename}`;
  res.json({
    ok: true,
    url,
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

// 删除上传文件（前端"移除自传图"时调用）
export async function removeUploadFile(filename) {
  if (!filename || filename.includes('/') || filename.includes('..')) return;
  const p = join(UPLOAD_DIR, filename);
  if (existsSync(p)) await unlink(p).catch(() => {});
}