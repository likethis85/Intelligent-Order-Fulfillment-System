import { createHmac, createHash, randomBytes } from 'node:crypto';
import { extname, join } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const envFile = fileURLToPath(new URL('./.env', import.meta.url));
if (existsSync(envFile)) {
  if (typeof process.loadEnvFile === 'function') {
    try { process.loadEnvFile(envFile); } catch {}
  }
  try {
    const raw = readFileSync(envFile, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        const k = trimmed.slice(0, idx).trim();
        const v = trimmed.slice(idx + 1).trim();
        if (k && !process.env[k]) {
          process.env[k] = v;
        }
      }
    }
  } catch {}
}

function getEnvValue(keyName) {
  if (process.env[keyName]) return process.env[keyName];
  const found = Object.keys(process.env).find(k => k.trim().endsWith(keyName));
  return found ? process.env[found] : '';
}

export function getOssConfig() {
  const accessKeyId = getEnvValue('OSS_ACCESS_KEY_ID').trim();
  const accessKeySecret = getEnvValue('OSS_ACCESS_KEY_SECRET').trim();
  const bucket = (getEnvValue('OSS_BUCKET') || getEnvValue('OSS_BUCKET_NAME') || 'marius').trim();
  const endpoint = (getEnvValue('OSS_ENDPOINT') || 'oss-cn-shanghai.aliyuncs.com').trim().replace(/^https?:\/\//, '');
  const dir = (getEnvValue('OSS_DIR') || 'trays/uploads/').replace(/^\/+/, '');
  const customBase = getEnvValue('OSS_PUBLIC_BASE');
  const publicBase = customBase
    ? customBase.replace(/\/+$/, '')
    : `https://${bucket}.${endpoint}`;

  return {
    accessKeyId,
    accessKeySecret,
    bucket,
    endpoint,
    dir: dir.endsWith('/') ? dir : dir + '/',
    publicBase,
    configured: Boolean(accessKeyId && accessKeySecret && bucket && endpoint),
  };
}

export function isOssConfigured() {
  return getOssConfig().configured;
}

export function getOssPublicUrl(filename) {
  const cfg = getOssConfig();
  const cleanName = filename.replace(/^(\/?trays\/uploads\/|\/?uploads\/)/, '');
  return `${cfg.publicBase}/${cfg.dir}${cleanName}`;
}

export function generatePostPolicy(originalFilename = '') {
  const cfg = getOssConfig();
  if (!cfg.configured) {
    throw new Error('OSS 未配置，无法生成直传签名');
  }

  const rawExt = extname(originalFilename || '').toLowerCase();
  const ext = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.gif'].includes(rawExt) ? rawExt : '.jpg';
  const id = createHash('sha1').update(`${Date.now()}-${randomBytes(16).toString('hex')}`).digest('hex').slice(0, 16);
  const filename = `${id}${ext}`;
  const key = `${cfg.dir}${filename}`;

  const expireDate = new Date(Date.now() + 60 * 60 * 1000); // 1 小时有效期
  const policyObj = {
    expiration: expireDate.toISOString(),
    conditions: [
      { bucket: cfg.bucket },
      ['content-length-range', 0, 50 * 1024 * 1024],
      ['starts-with', '$key', cfg.dir],
    ],
  };

  const policyBase64 = Buffer.from(JSON.stringify(policyObj)).toString('base64');
  const signature = createHmac('sha1', cfg.accessKeySecret).update(policyBase64).digest('base64');

  return {
    host: `https://${cfg.bucket}.${cfg.endpoint}`,
    key,
    filename,
    policy: policyBase64,
    OSSAccessKeyId: cfg.accessKeyId,
    signature,
    url: `${cfg.publicBase}/${key}`,
    expire: expireDate.getTime(),
  };
}

export async function uploadBufferToOss(key, buffer, contentType = 'image/jpeg') {
  const cfg = getOssConfig();
  if (!cfg.configured) {
    throw new Error('OSS 未配置，无法上传');
  }

  const cleanKey = key.startsWith('/') ? key.slice(1) : key;
  const date = new Date().toUTCString();
  const canonicalizedResource = `/${cfg.bucket}/${cleanKey}`;
  const stringToSign = `PUT\n\n${contentType}\n${date}\n${canonicalizedResource}`;
  const signature = createHmac('sha1', cfg.accessKeySecret).update(stringToSign).digest('base64');
  const authorization = `OSS ${cfg.accessKeyId}:${signature}`;

  const url = `https://${cfg.bucket}.${cfg.endpoint}/${cleanKey}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
      'Date': date,
      'Authorization': authorization,
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
    body: buffer,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`OSS 上传失败 (${res.status}): ${errText || res.statusText}`);
  }

  return `${cfg.publicBase}/${cleanKey}`;
}

export async function deleteOssObject(key) {
  const cfg = getOssConfig();
  if (!cfg.configured || !key) return false;

  const cleanKey = (key.startsWith('/') ? key.slice(1) : key).trim();
  if (!cleanKey) return false;

  const date = new Date().toUTCString();
  const canonicalizedResource = `/${cfg.bucket}/${cleanKey}`;
  const stringToSign = `DELETE\n\n\n${date}\n${canonicalizedResource}`;
  const signature = createHmac('sha1', cfg.accessKeySecret).update(stringToSign).digest('base64');
  const authorization = `OSS ${cfg.accessKeyId}:${signature}`;

  const url = `https://${cfg.bucket}.${cfg.endpoint}/${cleanKey}`;
  try {
    const res = await fetch(url, {
      method: 'DELETE',
      headers: {
        'Date': date,
        'Authorization': authorization,
      },
    });
    return res.status === 204 || res.status === 200 || res.status === 404;
  } catch (err) {
    console.warn(`[oss] 删除对象 ${cleanKey} 失败:`, err.message);
    return false;
  }
}


const MIME_MAP = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};

// 后台异步同步历史上传文件到 OSS
export async function syncLocalUploadsToOss(uploadDir) {
  if (!isOssConfigured() || !uploadDir || !existsSync(uploadDir)) return;
  try {
    const files = await readdir(uploadDir);
    const imageFiles = files.filter(f => /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(f));
    if (imageFiles.length === 0) return;

    console.log(`[oss] 检测到 ${imageFiles.length} 个本地历史上传文件，正在检查同步至 OSS...`);
    const cfg = getOssConfig();

    for (const file of imageFiles) {
      try {
        const key = `${cfg.dir}${file}`;
        const ext = extname(file).toLowerCase();
        const mime = MIME_MAP[ext] || 'image/jpeg';
        const filePath = join(uploadDir, file);
        const buffer = await readFile(filePath);
        await uploadBufferToOss(key, buffer, mime);
      } catch (err) {
        console.warn(`[oss] 同步历史文件 ${file} 到 OSS 失败:`, err.message);
      }
    }
    console.log(`[oss] 本地历史上传文件已同步完成`);
  } catch (err) {
    console.warn('[oss] 扫描历史上传文件失败:', err.message);
  }
}
