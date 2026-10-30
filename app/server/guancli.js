import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// guancli 并发限制：避免多进程并发读写 ~/.config/guancli/config.json 导致 JSON 解析损坏或 CPU 争抢。
// 分两条车道，互不挤占：
//   - 交互车道（用户请求在等）：默认 2 个并发
//   - 后台车道（SKC/款式卡全量刷新，单次可能跑 5-10 分钟）：默认 1 个并发
// 不分车道的话，一次全量刷新就会长期占住全部名额，尺码/成本这类秒级请求只能排队到 nginx 504。
const INTERACTIVE_MAX_CONCURRENCY = Number(process.env.GUANCLI_MAX_CONCURRENCY) || 2;
const BACKGROUND_MAX_CONCURRENCY = Number(process.env.GUANCLI_BACKGROUND_CONCURRENCY) || 1;

const lanes = {
  interactive: { active: 0, queue: [] },
  background: { active: 0, queue: [] },
};

function laneOf(background) {
  return background ? lanes.background : lanes.interactive;
}

function acquireGuancliSlot(background = false) {
  const lane = laneOf(background);
  const max = background ? BACKGROUND_MAX_CONCURRENCY : INTERACTIVE_MAX_CONCURRENCY;
  if (lane.active < max) {
    lane.active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => lane.queue.push(resolve));
}

function releaseGuancliSlot(background = false) {
  const lane = laneOf(background);
  if (lane.queue.length > 0) {
    // 名额直接转交给队首，active 保持不变
    const next = lane.queue.shift();
    next();
    return;
  }
  lane.active--;
}

// 运维/测试用：查看当前排队情况
export function getGuancliLaneStats() {
  return {
    interactive: { active: lanes.interactive.active, queued: lanes.interactive.queue.length, max: INTERACTIVE_MAX_CONCURRENCY },
    background: { active: lanes.background.active, queued: lanes.background.queue.length, max: BACKGROUND_MAX_CONCURRENCY },
  };
}

// Optional BI tools must reject their request on failure, never crash the API.
// background=true 走后台车道：全量刷新不能把用户请求的名额占满
export async function runGuancli(args, { timeoutMs = 30_000, maxOutputBytes = 64 * 1024 * 1024, captureStdout = true, background = false } = {}) {
  await acquireGuancliSlot(background);
  try {
    return await new Promise((resolve, reject) => {
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
  } finally {
    releaseGuancliSlot(background);
  }
}

export async function previewGuancliCard(cardId, { limit, timeoutMs, background = false } = {}) {
  const tmpFile = join(tmpdir(), `marius-bi-${randomUUID()}.csv`);
  const args = ['card', 'preview', cardId, '--value-format', 'raw', '-f', 'csv'];
  if (limit !== undefined) args.push('--limit', String(limit));
  args.push('-o', tmpFile);
  try {
    await runGuancli(args, { captureStdout: false, timeoutMs, background });
    return await readFile(tmpFile, 'utf8');
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
}
