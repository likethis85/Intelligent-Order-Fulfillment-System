import test from 'node:test';
import assert from 'node:assert/strict';

// 只测纯逻辑：什么时候该发起后台回源，读请求永不阻塞的前提就是这里判断正确
const { shouldStartRefresh } = await import('../server/bi-client.js');

const MIN = 60_000;
const TTL = 30 * MIN;
const COOLDOWN = 10 * MIN;

test('bi refresh: 数据新鲜时不回源', () => {
  const now = 10 * TTL;
  assert.equal(shouldStartRefresh({
    hasData: true, dataAt: now - 5 * MIN, now, refreshing: false, ttlMs: TTL,
  }), false);
});

test('bi refresh: 数据过期时发起回源', () => {
  const now = 10 * TTL;
  assert.equal(shouldStartRefresh({
    hasData: true, dataAt: now - 31 * MIN, now, refreshing: false, ttlMs: TTL,
  }), true);
});

test('bi refresh: 完全没有缓存时发起回源', () => {
  assert.equal(shouldStartRefresh({
    hasData: false, dataAt: 0, now: Date.now(), refreshing: false, ttlMs: TTL,
  }), true);
});

test('bi refresh: 正在刷新时不重复发起（单飞）', () => {
  const now = 10 * TTL;
  assert.equal(shouldStartRefresh({
    hasData: false, dataAt: 0, now, refreshing: true, ttlMs: TTL,
  }), false);
});

test('bi refresh: 冷却期内不重试，冷却结束后才重试', () => {
  const now = 10 * TTL;
  const lastFailureAt = now - 2 * MIN;
  assert.equal(shouldStartRefresh({
    hasData: true, dataAt: now - 31 * MIN, now, lastFailureAt, cooldownMs: COOLDOWN, ttlMs: TTL,
  }), false);
  assert.equal(shouldStartRefresh({
    hasData: true, dataAt: now - 31 * MIN, now: now + 9 * MIN, lastFailureAt, cooldownMs: COOLDOWN, ttlMs: TTL,
  }), true);
});

test('bi refresh: 12h 以上的旧数据仍会被用于展示（回源不等数据过期）', () => {
  const now = 100 * TTL;
  // 12h 的旧数据：不该因为没有「可信数据」就永远不刷新
  assert.equal(shouldStartRefresh({
    hasData: true, dataAt: now - 13 * 60 * MIN, now, refreshing: false, ttlMs: TTL,
  }), true);
});
