import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  TokenBucket,
  initRateLimiters, acquireRateLimit, tryAcquireRateLimit,
  getRateLimitStats, resetRateLimiter,
  initConcurrency, acquireConcurrencySlot, tryAcquireConcurrencySlot,
  getConcurrencyStats,
} from '../lib/hydra-rate-limits.mjs';

describe('TokenBucket', () => {
  it('starts with full capacity', () => {
    const bucket = new TokenBucket(10, 1);
    assert.equal(bucket.available(), 10);
  });

  it('consumes tokens', () => {
    const bucket = new TokenBucket(10, 1);
    assert.ok(bucket.tryConsume(3));
    assert.equal(bucket.available(), 7);
  });

  it('rejects when insufficient tokens', () => {
    const bucket = new TokenBucket(2, 1);
    assert.ok(bucket.tryConsume(2));
    assert.ok(!bucket.tryConsume(1));
  });

  it('refills over time', async () => {
    const bucket = new TokenBucket(10, 100); // 100/sec
    bucket.tryConsume(10); // drain
    assert.equal(bucket.available(), 0);
    await new Promise(r => setTimeout(r, 60));
    const avail = bucket.available();
    assert.ok(avail >= 3, `expected >=3 tokens after 60ms at 100/s, got ${avail}`);
  });

  it('does not exceed capacity', async () => {
    const bucket = new TokenBucket(5, 1000); // fast refill
    await new Promise(r => setTimeout(r, 50));
    assert.ok(bucket.available() <= 5);
  });

  it('waitForTokens resolves when tokens available', async () => {
    const bucket = new TokenBucket(1, 100); // 100/sec
    bucket.tryConsume(1); // drain
    const start = Date.now();
    await bucket.waitForTokens(1);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 500, `waited ${elapsed}ms, expected < 500ms`);
  });
});

describe('provider rate limiters', () => {
  beforeEach(() => {
    initRateLimiters({ openai: 600, anthropic: 600, google: 600 }); // high limits for tests
    resetRateLimiter();
  });

  it('acquireRateLimit resolves quickly under limit', async () => {
    const start = Date.now();
    await acquireRateLimit('openai');
    assert.ok(Date.now() - start < 200);
  });

  it('tryAcquireRateLimit returns boolean', () => {
    const result = tryAcquireRateLimit('openai');
    assert.equal(typeof result, 'boolean');
  });

  it('getRateLimitStats returns per-provider info', () => {
    const stats = getRateLimitStats();
    assert.ok(stats.openai);
    assert.ok(typeof stats.openai.available === 'number');
    assert.ok(typeof stats.openai.capacity === 'number');
  });

  it('resetRateLimiter restores tokens', () => {
    tryAcquireRateLimit('openai');
    tryAcquireRateLimit('openai');
    const before = getRateLimitStats().openai.available;
    resetRateLimiter('openai');
    const after = getRateLimitStats().openai.available;
    assert.ok(after >= before);
  });
});

describe('concurrency', () => {
  beforeEach(() => {
    initConcurrency(2);
  });

  it('acquires and releases slots', async () => {
    const release1 = await acquireConcurrencySlot();
    const release2 = await acquireConcurrencySlot();
    assert.equal(getConcurrencyStats().active, 2);
    release1();
    assert.equal(getConcurrencyStats().active, 1);
    release2();
    assert.equal(getConcurrencyStats().active, 0);
  });

  it('tryAcquire returns null when at capacity', async () => {
    initConcurrency(1);
    const release = await acquireConcurrencySlot();
    const result = tryAcquireConcurrencySlot();
    assert.equal(result, null);
    release();
  });

  it('tryAcquire returns release function when available', () => {
    initConcurrency(2);
    const release = tryAcquireConcurrencySlot();
    assert.equal(typeof release, 'function');
    release();
  });

  it('release is idempotent', async () => {
    const release = await acquireConcurrencySlot();
    release();
    release(); // double release
    assert.equal(getConcurrencyStats().active, 0);
  });

  it('reports utilization', async () => {
    initConcurrency(4);
    const r1 = await acquireConcurrencySlot();
    const r2 = await acquireConcurrencySlot();
    const stats = getConcurrencyStats();
    assert.equal(stats.active, 2);
    assert.equal(stats.maxInFlight, 4);
    assert.equal(stats.utilization, 0.5);
    r1();
    r2();
  });
});
