// 只做一件事：在其它模块被求值之前，把 server/.env 载入 process.env。
//
// 必须是 index.js 的第一个 import —— ESM 的静态 import 按出现顺序求值，
// 这样 supabase-client / jushuitan-client / oss-client 这类在模块顶层读
// process.env 的文件才能拿到值。
//
// 之前靠 PM2 的 --node-args="--env-file=server/.env" 提供，但 pm2 丢弃该参数时
// index.js 里的 process.loadEnvFile() 已经太晚（模块早已求值完），
// 后果是 Supabase 直接「未配置」静默跳过写库。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const envFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '.env');

if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(envFile);
  } catch (err) {
    console.warn(`[env] 读取 ${envFile} 失败：${err.message}`);
  }
}
