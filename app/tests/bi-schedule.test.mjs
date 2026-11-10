// BI 定时刷新：每天固定 10:00 主动跑，不依赖访问触发。
// 这里只测纯逻辑（下次触发时间、两张卡的串行/失败隔离），不真的等定时器。
import test from 'node:test';
import assert from 'node:assert/strict';

const { msUntilNextRun, runBiDailyRefresh, startBiDailyRefresh, stopBiDailyRefresh } =
  await import('../server/bi-schedule.js');

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('10:00 前：当天 10:00 触发', () => {
  assert.equal(msUntilNextRun(new Date(2026, 10, 10, 9, 0, 0), 10, 0), HOUR);
  assert.equal(msUntilNextRun(new Date(2026, 10, 10, 0, 0, 0), 10, 0), 10 * HOUR);
});

test('正好 10:00：立即触发', () => {
  assert.equal(msUntilNextRun(new Date(2026, 10, 10, 10, 0, 0), 10, 0), 0);
});

test('过了 10:00：顺延到第二天', () => {
  assert.equal(msUntilNextRun(new Date(2026, 10, 10, 10, 0, 1), 10, 0), DAY - 1000);
  assert.equal(msUntilNextRun(new Date(2026, 10, 10, 15, 30, 0), 10, 0), 18.5 * HOUR);
});

test('跨月/跨年也顺延正确', () => {
  const now = new Date(2026, 11, 31, 11, 0, 0);
  const next = new Date(now.getTime() + msUntilNextRun(now, 10, 0));
  assert.equal(next.getFullYear(), 2027);
  assert.equal(next.getMonth(), 0);
  assert.equal(next.getDate(), 1);
  assert.equal(next.getHours(), 10);
  assert.equal(next.getMinutes(), 0);
});

test('两张卡串行刷新，trigger 标记为 schedule', async () => {
  const calls = [];
  const runner = (name) => async (opts) => {
    calls.push([name, opts?.trigger]);
    return { status: 'started', promise: Promise.resolve() };
  };
  await runBiDailyRefresh({ runners: [['skc', runner('skc')], ['product', runner('product')]] });
  assert.deepEqual(calls, [['skc', 'schedule'], ['product', 'schedule']]);
});

test('一张卡失败不影响另一张', async () => {
  const calls = [];
  const bad = async () => { throw new Error('boom'); };
  const good = async () => { calls.push('product'); return { status: 'started', promise: Promise.resolve() }; };
  await runBiDailyRefresh({ runners: [['skc', bad], ['product', good]] });
  assert.deepEqual(calls, ['product']);
});

test('已有刷新在跑时跳过，不等待它的 promise', async () => {
  let waited = false;
  const running = async () => ({
    status: 'already_running',
    promise: { then: () => { waited = true; } },
  });
  await runBiDailyRefresh({ runners: [['skc', running]] });
  assert.equal(waited, false);
});

test('startBiDailyRefresh 只注册一次，stop 后可重新注册', () => {
  try {
    assert.equal(startBiDailyRefresh(), true);
    assert.equal(startBiDailyRefresh(), false, '重复调用不会注册多个定时器');
  } finally {
    stopBiDailyRefresh();
  }
  assert.equal(startBiDailyRefresh(), true);
  stopBiDailyRefresh();
});
