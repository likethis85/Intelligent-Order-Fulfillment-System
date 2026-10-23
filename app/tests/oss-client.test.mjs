import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getOssConfig, isOssConfigured, getOssPublicUrl, generatePostPolicy, uploadBufferToOss } from '../server/oss-client.js';

test('oss-client: correctly identifies configuration', () => {
  const cfg = getOssConfig();
  assert.equal(typeof cfg.accessKeyId, 'string');
  assert.equal(typeof cfg.accessKeySecret, 'string');
  assert.equal(cfg.bucket, 'marius');
  assert.equal(cfg.endpoint, 'oss-cn-shanghai.aliyuncs.com');
  assert.equal(isOssConfigured(), true);
});

test('oss-client: generates public URL correctly', () => {
  const url = getOssPublicUrl('abc12345.jpg');
  assert.equal(url, 'https://marius.oss-cn-shanghai.aliyuncs.com/trays/uploads/abc12345.jpg');

  const urlWithPrefix = getOssPublicUrl('/uploads/abc12345.jpg');
  assert.equal(urlWithPrefix, 'https://marius.oss-cn-shanghai.aliyuncs.com/trays/uploads/abc12345.jpg');
});

test('oss-client: generates direct upload PostObject policy and signature', () => {
  const params = generatePostPolicy('my_dress.png');
  assert.equal(params.host, 'https://marius.oss-cn-shanghai.aliyuncs.com');
  assert.match(params.key, /^trays\/uploads\/[0-9a-f]{16}\.png$/);
  assert.equal(typeof params.policy, 'string');
  assert.equal(typeof params.signature, 'string');
  assert.equal(params.OSSAccessKeyId, getOssConfig().accessKeyId);
  assert.ok(params.OSSAccessKeyId.length > 0);
  assert.match(params.url, /^https:\/\/marius\.oss-cn-shanghai\.aliyuncs\.com\/trays\/uploads\/[0-9a-f]{16}\.png$/);
});
