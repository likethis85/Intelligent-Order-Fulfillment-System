// 部署包不能覆盖生产上的运行时数据：server/data 下的权限配置、访问统计、规则配置等
// 会被线上持续写入，打包前必须排除，否则每次部署都拿本地开发副本重置线上。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const deployCode = fs.readFileSync(path.resolve(__dirname, '../../deploy/deploy.mjs'), 'utf8');

test('部署包排除运行时数据文件', () => {
  for (const name of [
    'access-control.json',
    'access-users.json',
    'access-audit.json',
    'usage-stats.json',
    'fabric-history.json',
    'hengji-cost.json',
    'sample-bom-cache.json',
    'role-rules.json',
    'strategy-rules.json',
    'weather-recommendation-rules.json',
  ]) {
    assert.ok(deployCode.includes(`'${name}'`), `${name} 应列入运行时排除清单`);
  }
  assert.ok(deployCode.includes("`--exclude=server/data/${name}`"), '排除清单要拼进 tar 参数');
  assert.ok(deployCode.includes('--exclude=server/.cache'), '缓存目录仍然排除');
  assert.ok(deployCode.includes('--exclude=server/data/dingtalk-storage-state.json'), '钉钉凭证仍然排除');
});
