#!/usr/bin/env node
/**
 * 检查 dingtalk-workspace-cli (dws) 安装与登录状态
 * 输出 JSON: { ok: boolean, installed: boolean, loggedIn: boolean, profile?: string, message?: string }
 */

import { execSync } from 'node:child_process';

function checkDwsStatus() {
  let whichDws = '';
  try {
    whichDws = execSync('which dws || where dws', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
  } catch {}

  if (!whichDws) {
    return {
      ok: true,
      installed: false,
      loggedIn: false,
      message: 'dws (dingtalk-workspace-cli) 未安装或未加入 PATH'
    };
  }

  try {
    const raw = execSync('dws auth status -f json', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    const parsed = JSON.parse(raw);
    const authenticated = Boolean(parsed.authenticated);
    return {
      ok: true,
      installed: true,
      loggedIn: authenticated,
      profile: parsed.profile || parsed.current_profile || parsed.active_profile || null,
      message: authenticated ? '已登录钉钉工作台 (dws)' : (parsed.message || '未登录'),
      raw: parsed
    };
  } catch (err) {
    return {
      ok: false,
      installed: true,
      loggedIn: false,
      message: `检测 dws 状态失败: ${err.message}`
    };
  }
}

const status = checkDwsStatus();
console.log(JSON.stringify(status, null, 2));
process.exit(status.loggedIn ? 0 : 1);
