// 观远 BI 定时刷新：每天固定时间（默认 10:00，服务器本地时区；生产为 Asia/Shanghai）
// 主动拉一次 SKC 库存卡 + 款式卡，不再依赖「有人访问且数据过期」才回源。
//
// 访问触发的 SWR（bi-client.js 里的 maybeRefreshSkc/maybeRefreshMaster）仍然保留：
// 定时任务失败、或服务在 10:00 前后重启错过当天，首个访问会在数据超过 24h 时兜底补拉。

import { refreshBiSkc, refreshBiProductMaster } from './bi-client.js';
import { downloadProductSnapshot } from './product-snapshot.js';

const DEFAULT_HOUR = 10;
const DEFAULT_MINUTE = 0;

// 距离下一次 hour:minute 的毫秒数；已经过了就顺延到明天
export function msUntilNextRun(now = new Date(), hour = DEFAULT_HOUR, minute = DEFAULT_MINUTE) {
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() < now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

const defaultRunners = [
  ['skc', refreshBiSkc],
  ['product', refreshBiProductMaster],
  // 商品全表快照（近14天销量等）：每天跟两张卡一起下，排在最后，走同一条后台车道串行
  ['product-snapshot', () => downloadProductSnapshot()],
];

// 两张卡串行执行：guancli 后台车道只有 1 个并发名额，同时发起也会排队，串行日志更清楚
export async function runBiDailyRefresh({ runners = defaultRunners } = {}) {
  for (const [name, refresh] of runners) {
    try {
      const r = await refresh({ trigger: 'schedule' });
      if (r?.status === 'already_running') {
        console.log(`[bi] 定时刷新 ${name}：已有刷新在跑，跳过本次`);
        continue;
      }
      if (r?.promise) await r.promise;
      console.log(`[bi] 定时刷新 ${name} 完成`);
    } catch (err) {
      console.error(`[bi] 定时刷新 ${name} 失败（保留旧数据，访问时会兜底重试）:`, err.message);
    }
  }
}

let timer = null;
let armed = false;

export function startBiDailyRefresh({
  hour = Number(process.env.BI_DAILY_REFRESH_HOUR || DEFAULT_HOUR),
  minute = Number(process.env.BI_DAILY_REFRESH_MINUTE || DEFAULT_MINUTE),
} = {}) {
  if (armed) return false;
  armed = true;

  const arm = () => {
    const delay = msUntilNextRun(new Date(), hour, minute);
    const at = new Date(Date.now() + delay);
    console.log(`[bi] 下次定时刷新：${at.toLocaleString('zh-CN', { hour12: false })}（${Math.round(delay / 60000)} 分钟后）`);
    timer = setTimeout(async () => {
      timer = null;
      try {
        await runBiDailyRefresh();
      } finally {
        arm();
      }
    }, delay);
    // 不阻止进程退出（生产由 HTTP server 保活；单测里也不会挂住）
    timer.unref?.();
  };

  arm();
  return true;
}

export function stopBiDailyRefresh() {
  if (timer) clearTimeout(timer);
  timer = null;
  armed = false;
}
