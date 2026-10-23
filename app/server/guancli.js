import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Optional BI tools must reject their request on failure, never crash the API.
export function runGuancli(args, { timeoutMs = 180_000, maxOutputBytes = 64 * 1024 * 1024, captureStdout = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.GUANCLI_PATH || 'guancli', args, {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    const chunks = [];
    let bytes = 0, stderr = '', settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`观远 BI 数据读取超时（${timeoutMs / 1000} 秒），请稍后重试`));
    }, timeoutMs);
    child.on('error', (error) => {
      const message = error.code === 'ENOENT'
        ? '观远 BI 数据工具 guancli 未安装或不在 PATH 中'
        : '观远 BI 数据工具无法启动，请检查本机安装';
      finish(Object.assign(new Error(message), { code: error.code }));
    });
    child.stdout.on('data', (data) => {
      if (settled || !captureStdout) return;
      bytes += data.length;
      if (bytes > maxOutputBytes) {
        child.kill();
        return finish(new Error('观远 BI 返回的数据超出读取限制'));
      }
      chunks.push(data);
    });
    child.stderr.on('data', (data) => { stderr = (stderr + data.toString()).slice(-1000); });
    child.on('close', (code) => finish(code === 0 ? null : new Error(`观远 BI 数据读取失败（exit ${code}）：${stderr.slice(-300)}`)));
  });
}

export async function previewGuancliCard(cardId, { limit, timeoutMs } = {}) {
  const tmpFile = join(tmpdir(), `marius-bi-${randomUUID()}.csv`);
  const args = ['card', 'preview', cardId, '--value-format', 'raw', '-f', 'csv'];
  if (limit !== undefined) args.push('--limit', String(limit));
  args.push('-o', tmpFile);
  try {
    await runGuancli(args, { captureStdout: false, timeoutMs });
    return await readFile(tmpFile, 'utf8');
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
}
