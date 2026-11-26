// 阿里云 OSS 不可用时（AccessKey 失效 403），图片改读服务端本地备份 /uploads/<文件名>。
// 服务端每次上传都会在本地留一份；只有本 bucket 的直链才映射，别的地址不动。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ossUrlToLocalUpload, OSS_UPLOADS_BASE } from '../src/data/products.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pageCode = fs.readFileSync(path.resolve(__dirname, '../src/sections/TraysPage.tsx'), 'utf8');

test('OSS 直链能映射成同源本地备份', () => {
  assert.equal(
    ossUrlToLocalUpload(`${OSS_UPLOADS_BASE}8ff8e716bbce.jpg`),
    '/uploads/8ff8e716bbce.jpg',
  );
  assert.equal(
    ossUrlToLocalUpload(`${OSS_UPLOADS_BASE}8ff8e716bbce.jpg?x-oss-process=image/resize`),
    '/uploads/8ff8e716bbce.jpg',
  );
});

test('不是本 bucket / 不是直链的地址不映射', () => {
  assert.equal(ossUrlToLocalUpload('https://cdn.example.com/a.jpg'), null);
  assert.equal(ossUrlToLocalUpload('/uploads/a.jpg'), null, '相对路径本身就用本地，不用再映射');
  assert.equal(ossUrlToLocalUpload(`${OSS_UPLOADS_BASE}sub/a.jpg`), null, '带子目录的不猜');
  assert.equal(ossUrlToLocalUpload(''), null);
  assert.equal(ossUrlToLocalUpload(null), null);
});

test('SafeImg 加载 OSS 图失败时先用本地备份重试，再退占位', () => {
  assert.ok(pageCode.includes('ossUrlToLocalUpload'), 'SafeImg 用这个映射做兜底');
  assert.ok(pageCode.includes('setLocalRetry(local)'), '失败后切到本地地址重试一次');
  assert.ok(pageCode.includes('改读服务器本地备份'), '日志能看出走的是本地兜底');
});
