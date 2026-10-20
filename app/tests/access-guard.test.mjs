// 权限拦截集成测试：真实起一个 Express，验证只读账号无法写入
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'access-'));
const configFile = path.join(tmpDir, 'access-control.json');
const usersFile = path.join(tmpDir, 'access-users.json');

fs.writeFileSync(configFile, JSON.stringify({
  settings: { defaultRole: 'view' },
  departments: [
    { id: 'dept-goods', name: '商品部', role: 'edit' },
    { id: 'dept-ops', name: '运营部', role: 'view' },
  ],
  members: [
    { userId: 'u_goods', name: '张三', deptIds: ['dept-goods'] },
    { userId: 'u_ops', name: '李四', deptIds: ['dept-ops'] },
  ],
  overrides: [],
  admins: [{ userId: 'u_boss', name: '老板' }],
}));

process.env.ACCESS_CONFIG_FILE = configFile;
process.env.ACCESS_USERS_FILE = usersFile;
process.env.ACCESS_ADMIN_IDS = '';

const express = (await import('express')).default;
const { createAccessControl } = await import('../server/access-control.js');

const ac = createAccessControl();
const app = express();
app.use(express.json());
// 用请求头模拟已登录身份（真实环境由 SSO 中间件写入 req.auth）
app.use((req, _res, next) => {
  const id = String(req.headers['x-test-user'] || '');
  if (id) req.auth = { key: 'k', user: { id, provider: 'dingtalk', email: null, displayName: id, avatarUrl: null }, expiresAt: Date.now() + 3600_000 };
  next();
});
app.use('/api', ac.attach);
app.use('/api/access', ac.router);
app.put('/api/trays', ac.guardWrites, (_req, res) => res.json({ ok: true }));
app.get('/api/trays', (_req, res) => res.json({ ok: true }));
app.post('/api/sync', ac.guardAdminWrites, (_req, res) => res.json({ ok: true }));
app.put('/api/config/role-rules', ac.guardAdminWrites, (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const call = (method, url, user) => fetch(base + url, {
  method,
  headers: { 'Content-Type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
  body: method === 'GET' ? undefined : '{}',
});

test.after(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('只读账号读得到、写不了货盘', async () => {
  assert.equal((await call('GET', '/api/trays', 'u_ops')).status, 200);
  const res = await call('PUT', '/api/trays', 'u_ops');
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'edit_forbidden');
});

test('商品部账号可以写货盘', async () => {
  const res = await call('PUT', '/api/trays', 'u_goods');
  assert.equal(res.status, 200);
});

test('未匹配部门的人默认只读', async () => {
  const res = await call('PUT', '/api/trays', 'u_stranger');
  assert.equal(res.status, 403);
});

test('同步与规则配置只有管理员能写', async () => {
  assert.equal((await call('POST', '/api/sync', 'u_goods')).status, 403);
  assert.equal((await call('POST', '/api/sync', 'u_boss')).status, 200);
  assert.equal((await call('PUT', '/api/config/role-rules', 'u_goods')).status, 403);
  assert.equal((await call('PUT', '/api/config/role-rules', 'u_boss')).status, 200);
});

test('权限管理接口只有管理员可访问', async () => {
  assert.equal((await call('GET', '/api/access/config', 'u_goods')).status, 403);
  const ok = await call('GET', '/api/access/config', 'u_boss');
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.config.departments.length, 2);
});

test('/api/access/me 返回本人角色但不泄露配置', async () => {
  const res = await call('GET', '/api/access/me', 'u_ops');
  assert.equal(res.status, 200);
  const me = await res.json();
  assert.equal(me.role, 'view');
  assert.equal(me.canEditTray, false);
  assert.equal(me.canManageAccess, false);
  assert.equal('departments' in me ? Array.isArray(me.departments) : false, true);
});

test('保存管理员组为空会被拒绝', async () => {
  const res = await fetch(base + '/api/access/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-test-user': 'u_boss' },
    body: JSON.stringify({ admins: [] }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'no_admin_left');
});

test('带上过期的版本号保存会返回 409，避免覆盖别人的修改', async () => {
  const headers = { 'Content-Type': 'application/json', 'x-test-user': 'u_boss' };

  // 先正常保存一次，拿到新的 updatedAt
  const first = await fetch(base + '/api/access/config', {
    method: 'PUT', headers,
    body: JSON.stringify({
      departments: [{ id: 'dept-goods', name: '商品部', role: 'edit' }],
      members: [{ userId: 'u_goods', name: '张三', deptIds: ['dept-goods'] }],
      admins: [{ userId: 'u_boss', name: '老板' }],
      settings: { defaultRole: 'view' },
    }),
  });
  assert.equal(first.status, 200);
  const fresh = (await first.json()).config;

  // 第二个管理员拿着旧版本号来保存，必须被拒
  const stale = await fetch(base + '/api/access/config', {
    method: 'PUT', headers,
    body: JSON.stringify({
      expectedUpdatedAt: '2000-01-01T00:00:00.000Z',
      departments: fresh.departments,
      members: fresh.members,
      admins: fresh.admins,
      settings: fresh.settings,
    }),
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error, 'config_conflict');

  // 带上正确版本号就能保存
  const ok = await fetch(base + '/api/access/config', {
    method: 'PUT', headers,
    body: JSON.stringify({
      expectedUpdatedAt: fresh.updatedAt,
      departments: fresh.departments,
      members: fresh.members,
      admins: fresh.admins,
      settings: fresh.settings,
    }),
  });
  assert.equal(ok.status, 200);
});
