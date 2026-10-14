#!/usr/bin/env node
/**
 * 钉钉工作台 CLI (dws) 授权登录辅助脚本
 * 
 * 在本地终端或服务器终端运行：
 *   npm run dws:login
 * 
 * 流程：
 *   1. 调起 dws 设备授权流 (dws auth login --device)
 *   2. 终端打印授权链接及 8 位授权码
 *   3. 用户在电脑浏览器打开链接，或在手机钉钉中确认授权
 *   4. 授权成功后，dws 自动保存凭证至 ~/.dws/.data
 */

import { spawn } from 'node:child_process';

console.log('====================================================');
console.log('🚀 正在启动钉钉工作台 (dws) 设备流认证...');
console.log('   请根据控制台输出的链接和授权码，使用钉钉账号完成确认');
console.log('====================================================\n');

const child = spawn('dws', ['auth', 'login', '--device'], {
  stdio: 'inherit',
  shell: true,
});

child.on('close', (code) => {
  if (code === 0) {
    console.log('\n✅ 恭喜！钉钉工作台 CLI 授权成功！');
    console.log('   现在您可以使用 dws 直接读取企业钉钉表格，或运行: npm run sync:dws');
  } else {
    console.error(`\n❌ 认证未完成或异常退出 (code ${code})`);
  }
  process.exit(code || 0);
});

child.on('error', (err) => {
  console.error('\n❌ 启动 dws 失败:', err.message);
  console.error('   请确保已安装全局 CLI: npm install -g dingtalk-workspace-cli');
  process.exit(1);
});
