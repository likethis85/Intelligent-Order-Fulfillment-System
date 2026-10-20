// 权限中心单元测试：只测纯函数，不碰真实配置文件
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, resolveRole, accessFor } from '../server/access-control.js';

const baseConfig = () => normalizeConfig({
  settings: { defaultRole: 'view' },
  departments: [
    { id: 'dept-goods', name: '商品部', role: 'edit' },
    { id: 'dept-ops', name: '运营部', role: 'view' },
  ],
  members: [
    { userId: 'u_goods', name: '张三', deptIds: ['dept-goods'] },
    { userId: 'u_ops', name: '李四', deptIds: ['dept-ops'] },
    { userId: 'u_both', name: '王五', deptIds: ['dept-ops', 'dept-goods'] },
  ],
  overrides: [{ userId: 'u_ops', name: '李四', role: 'edit' }],
  admins: [{ userId: 'u_boss', name: '老板' }],
});

test('默认口径：商品部可编辑、其余部门只读', () => {
  assert.equal(resolveRole({ id: 'u_goods' }, baseConfig()).role, 'edit');
  assert.equal(resolveRole({ id: 'u_new' }, baseConfig()).role, 'view');
});

test('管理员组优先级最高，压过账号例外与部门', () => {
  const cfg = baseConfig();
  const r = resolveRole({ id: 'u_boss', displayName: '老板' }, cfg);
  assert.equal(r.role, 'admin');
  assert.equal(r.reason, 'admin_group');
  assert.equal(accessFor({ id: 'u_boss' }, cfg).canManageAccess, true);
});

test('账号例外压过部门设置', () => {
  const cfg = baseConfig();
  const r = resolveRole({ id: 'u_ops' }, cfg);
  assert.equal(r.role, 'edit');
  assert.equal(r.reason, 'account_override');
});

test('多部门时取最高权限', () => {
  const cfg = baseConfig();
  const r = resolveRole({ id: 'u_both' }, cfg);
  assert.equal(r.role, 'edit');
  assert.equal(r.reason, 'department');
});

test('未匹配部门时回落全局默认角色', () => {
  const cfg = normalizeConfig({ settings: { defaultRole: 'edit' } });
  assert.equal(resolveRole({ id: 'u_unknown' }, cfg).role, 'edit');
});

test('权限位与角色一致', () => {
  const cfg = baseConfig();
  assert.deepEqual(
    (({ canEditTray, canManageAccess, canSyncData, canEditRules }) => ({ canEditTray, canManageAccess, canSyncData, canEditRules }))(accessFor({ id: 'u_goods' }, cfg)),
    { canEditTray: true, canManageAccess: false, canSyncData: false, canEditRules: false },
  );
  assert.deepEqual(
    (({ canEditTray, canManageAccess }) => ({ canEditTray, canManageAccess }))(accessFor({ id: 'u_new' }, cfg)),
    { canEditTray: false, canManageAccess: false },
  );
});

test('匿名用户按只读处理', () => {
  const a = accessFor(null, baseConfig());
  assert.equal(a.role, 'view');
  assert.equal(a.canEditTray, false);
});

test('环境变量白名单可直接授予管理员', () => {
  const prev = process.env.ACCESS_ADMIN_IDS;
  process.env.ACCESS_ADMIN_IDS = 'ops@example.com, u_ops';
  try {
    const r = resolveRole({ id: 'u_x', email: 'ops@example.com' }, baseConfig());
    assert.equal(r.role, 'admin');
    assert.equal(r.reason, 'env_admin');
  } finally {
    if (prev === undefined) delete process.env.ACCESS_ADMIN_IDS;
    else process.env.ACCESS_ADMIN_IDS = prev;
  }
});

test('配置清洗：非法角色回落、重复 id 去重、空字段过滤', () => {
  const cfg = normalizeConfig({
    settings: { defaultRole: 'superuser' },
    departments: [
      { id: 'd1', name: '商品部', role: 'edit' },
      { id: 'd1', name: '重复部门', role: 'admin' },
      { id: '', name: '无 id', role: 'edit' },
      { id: 'd2', name: '坏角色', role: 'root' },
    ],
    members: [{ userId: 'u1', deptIds: ['d1', 'd1', ''] }, { userId: '' }],
    admins: [{ userId: 'u1', name: '甲' }, { userId: 'u1', name: '甲重复' }],
  });
  assert.equal(cfg.settings.defaultRole, 'view');
  assert.equal(cfg.departments.length, 2);
  // 非法角色不再是硬性 view，而是留空表示继承上级
  assert.equal(cfg.departments.find((d) => d.id === 'd2').role, null);
  assert.deepEqual(cfg.members[0].deptIds, ['d1']);
  assert.equal(cfg.members.length, 1);
  assert.equal(cfg.admins.length, 1);
});

test('子部门未设置角色时继承父部门', () => {
  const cfg = normalizeConfig({
    settings: { defaultRole: 'view' },
    departments: [
      { id: 'dt-1', name: '总部', role: null, parentId: null },
      { id: 'dt-2', name: '供应链中心', role: 'edit', parentId: 'dt-1' },
      { id: 'dt-3', name: '采购部', role: null, parentId: 'dt-2' },
      { id: 'dt-4', name: '其他部门', role: null, parentId: 'dt-1' },
    ],
    members: [
      { userId: 'u_purchase', name: '采购', deptIds: ['dt-3'] },
      { userId: 'u_other', name: '其他', deptIds: ['dt-4'] },
    ],
  });
  const purchase = resolveRole({ id: 'u_purchase' }, cfg);
  assert.equal(purchase.role, 'edit');
  assert.equal(purchase.reason, 'department');
  assert.deepEqual(purchase.deptNames, ['采购部']);
  // 上级没设角色，一路继承到全局默认
  assert.equal(resolveRole({ id: 'u_other' }, cfg).role, 'view');
});

test('子部门显式设置可以覆盖父部门', () => {
  const cfg = normalizeConfig({
    settings: { defaultRole: 'view' },
    departments: [
      { id: 'dt-1', name: '供应链中心', role: 'edit' },
      { id: 'dt-2', name: '外部协作', role: 'view', parentId: 'dt-1' },
    ],
    members: [{ userId: 'u_out', name: '外包', deptIds: ['dt-2'] }],
  });
  assert.equal(resolveRole({ id: 'u_out' }, cfg).role, 'view');
});

test('成员匹配优先用钉钉 unionId，SSO 用户 id 不同也能认出来', () => {
  const cfg = normalizeConfig({
    settings: { defaultRole: 'view' },
    departments: [{ id: 'dt-1', name: '供应链中心', role: 'edit' }],
    members: [
      { userId: '011268023412643974', unionId: 'union-abc', name: '张三', deptIds: ['dt-1'] },
    ],
  });
  // SSO 的 user.id 是 u_xxx，与钉钉 userid 完全不同，只能靠 unionId 关联
  const r = resolveRole({ id: 'u_0ffdb08304f3479387a614eb4545002e', externalId: 'union-abc' }, cfg);
  assert.equal(r.role, 'edit');
  assert.equal(r.reason, 'department');
  // 没带 unionId 时不能凭空匹配
  assert.equal(resolveRole({ id: 'u_0ffdb08304f3479387a614eb4545002e' }, cfg).role, 'view');
});

test('空配置给出可用的默认结构', () => {
  const cfg = normalizeConfig(null);
  assert.deepEqual(cfg.departments.map((d) => d.name), ['商品部', '供应链']);
  assert.ok(cfg.departments.every((d) => d.role === 'edit'));
  assert.equal(cfg.settings.defaultRole, 'view');
});

test('没登录过的员工也能先加进管理员组，登录后按 unionId 生效', () => {
  const cfg = normalizeConfig({
    settings: { defaultRole: 'view' },
    departments: [],
    members: [{ userId: 'dingtalk-001', unionId: 'union-001', name: '张三', deptIds: [] }],
    // 此时还不知道对方的 SSO 用户 id，只能记 unionId
    admins: [{ userId: '', unionId: 'union-001', name: '张三' }],
  });
  assert.equal(cfg.admins.length, 1);
  const r = resolveRole({ id: 'u_9', externalId: 'union-001' }, cfg);
  assert.equal(r.role, 'admin');
  assert.equal(r.reason, 'admin_group');
});

test('没登录过的员工也能单独授权，且优先于部门', () => {
  const cfg = normalizeConfig({
    settings: { defaultRole: 'view' },
    departments: [{ id: 'dt-1', name: '商品部', role: 'edit' }],
    members: [{ userId: 'dingtalk-002', unionId: 'union-002', name: '李四', deptIds: ['dt-1'] }],
    overrides: [{ userId: '', unionId: 'union-002', name: '李四', role: 'view' }],
  });
  assert.equal(cfg.overrides.length, 1);
  const r = resolveRole({ id: 'u_10', externalId: 'union-002' }, cfg);
  assert.equal(r.role, 'view');
  assert.equal(r.reason, 'account_override');
});
