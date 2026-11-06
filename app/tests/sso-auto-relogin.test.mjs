// 会话过期（部署重启、超过 8 小时）不再停在「登录已过期，请重新登录」这个死页面：
// 自动回统一登录续一次（SSO 侧通常还是登录状态，用户几乎无感），
// 但 60 秒内只跳一次——SSO 挂掉时要退回手动登录，不能来回弹跳。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.resolve(__dirname, p), 'utf8');

const gate = read('../src/components/AuthGate.tsx');

test('过期后自动回 SSO 续登录，跳到当前页面', () => {
  assert.match(gate, /location\.assign\('\/api\/auth\/sso\/start\?'/, '过期要自动发起统一登录');
  assert.ok(gate.includes('origin: location.origin'), '要带上项目来源，服务端只认登记过的回调');
  assert.ok(gate.includes('returnTo: getCleanReturnTo()'), '续登录后回到用户原来在的页面');
  assert.ok(
    gate.includes("if (!autoRelogin(setMessage)) setMessage('登录已过期，请重新登录。')"),
    '跳不动时才退回原来的手动登录提示',
  );
  // 三条路径都要走自动续登录：接口 401、本地到期定时器、60 秒轮询发现掉线
  assert.equal((gate.match(/if \(!autoRelogin\(setMessage\)\)/g) || []).length, 3, '三条过期路径都要覆盖');
  assert.ok(gate.includes('const wasSignedIn = wasAuthenticated.current'), '轮询要能区分「会话过期」和「第一次打开页面」');
});

test('自动续登录有防循环保护，不会把用户弹死在 SSO 上', () => {
  assert.ok(gate.includes("const AUTO_RELOGIN_KEY = 'marius:sso-auto-relogin-at'"), '用 sessionStorage 记录跳转时间');
  assert.ok(gate.includes('AUTO_RELOGIN_WINDOW_MS = 60_000'), '窗口是 60 秒');
  assert.ok(gate.includes('Date.now() - last < AUTO_RELOGIN_WINDOW_MS'), '窗口内不重复跳转');
  assert.ok(gate.includes('if (reloginInFlight) return true;'), '并发的多个 401 只跳一次');
  assert.ok(gate.includes('if (loggingOut.current) return;'), '主动退出登录时不能被自动登录拉回来');
  assert.ok(gate.includes("notify('登录状态已过期，正在重新登录…')"), '跳转前告诉用户发生了什么');
});

test('会话文件落在部署包不覆盖的 server/.cache 下', () => {
  const index = read('../server/index.js');
  assert.ok(
    index.includes("sessionFile: process.env.SSO_SESSIONS_FILE || path.join(__dirname, '.cache', 'sessions.json')"),
    '线上会话要写到 server/.cache/sessions.json',
  );
  const deploy = read('../../deploy/deploy.mjs');
  assert.ok(deploy.includes('--exclude=server/.cache'), '部署包必须排除 .cache，否则每次部署又清空会话');
});
