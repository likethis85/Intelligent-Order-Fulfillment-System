import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUsageStats } from '../server/usage-stats.js';

test('usage stats aggregates sessions, pages, users and online state', () => {
  const file = path.join(os.tmpdir(), `usage-stats-${process.pid}-${Date.now()}.json`);
  const stats = createUsageStats({ file });
  const user = {
    id: 'u-test', displayName: '测试同事', email: 'test@example.com',
    provider: 'dingtalk', externalId: 'union-test',
  };
  try {
    stats.startSession({ key: 'session-1', user, telemetrySessionId: 'telemetry-1' });
    assert.equal(stats.recordEvent({ key: 'session-1', user, kind: 'page_view', path: '/trays', title: '货盘' }), true);
    assert.equal(stats.recordEvent({ key: 'session-1', user, kind: 'heartbeat' }), true);

    const overview = stats.overview(30);
    assert.equal(overview.logins, 1);
    assert.equal(overview.pv, 1);
    assert.equal(overview.uv, 1);
    assert.equal(overview.online, 1);
    assert.equal(overview.providers[0].provider, 'dingtalk');

    const pages = stats.pages(30);
    assert.deepEqual(pages.map((x) => [x.path, x.pv]), [['/trays', 1]]);

    const users = stats.users(30);
    assert.equal(users.length, 1);
    assert.equal(users[0].name, '测试同事');
    assert.equal(users[0].online, true);
    assert.equal(users[0].pv, 1);

    stats.endSession('session-1');
    assert.equal(stats.users(30)[0].online, false);
  } finally {
    stats.flush();
    fs.rmSync(file, { force: true });
  }
});

test('usage stats rejects unknown event kinds', () => {
  const file = path.join(os.tmpdir(), `usage-stats-${process.pid}-${Date.now()}-bad.json`);
  const stats = createUsageStats({ file });
  try {
    assert.equal(stats.recordEvent({ key: 's', user: { id: 'u', displayName: 'U' }, kind: 'nope' }), false);
  } finally {
    fs.rmSync(file, { force: true });
  }
});
