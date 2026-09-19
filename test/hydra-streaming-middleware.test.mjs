import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PeakEWMA, compose, createStreamingPipeline, getProviderEWMA, getLatencyEstimates } from '../lib/hydra-streaming-middleware.mjs';

describe('PeakEWMA', () => {
  it('returns 0 when no observations', () => {
    const ewma = new PeakEWMA();
    assert.equal(ewma.get(), 0);
    assert.equal(ewma.count, 0);
  });

  it('stores first observation directly', () => {
    const ewma = new PeakEWMA();
    ewma.observe(500);
    assert.equal(ewma.count, 1);
    // Immediately after observation, should be close to 500
    const val = ewma.get();
    assert.ok(val > 400 && val <= 500, `Expected ~500, got ${val}`);
  });

  it('converges toward new observations', () => {
    const ewma = new PeakEWMA(100); // fast decay for testing
    ewma.observe(1000);
    // Simulate time passage by observing a much lower value
    ewma.observe(100);
    const val = ewma.get();
    // Should be between 100 and 1000, biased toward 100
    assert.ok(val >= 100 && val <= 1000, `Expected 100-1000, got ${val}`);
  });

  it('resets to initial state', () => {
    const ewma = new PeakEWMA();
    ewma.observe(500);
    ewma.reset();
    assert.equal(ewma.get(), 0);
    assert.equal(ewma.count, 0);
  });
});

describe('compose', () => {
  it('applies layers outside-in', async () => {
    const order = [];

    const layer1 = async (ctx, next) => {
      order.push('layer1-before');
      const result = await next();
      order.push('layer1-after');
      return result;
    };

    const layer2 = async (ctx, next) => {
      order.push('layer2-before');
      const result = await next();
      order.push('layer2-after');
      return result;
    };

    const core = async (ctx) => {
      order.push('core');
      return { value: 42 };
    };

    const fn = compose([layer1, layer2], core);
    const result = await fn({});

    assert.deepEqual(order, ['layer1-before', 'layer2-before', 'core', 'layer2-after', 'layer1-after']);
    assert.deepEqual(result, { value: 42 });
  });

  it('propagates errors through layers', async () => {
    const layer = async (ctx, next) => {
      try {
        return await next();
      } catch (err) {
        err.wrapped = true;
        throw err;
      }
    };

    const core = async () => {
      throw new Error('core error');
    };

    const fn = compose([layer], core);
    await assert.rejects(() => fn({}), (err) => {
      assert.equal(err.message, 'core error');
      assert.equal(err.wrapped, true);
      return true;
    });
  });
});

describe('getProviderEWMA', () => {
  it('returns same instance for same provider', () => {
    const a = getProviderEWMA('test-provider');
    const b = getProviderEWMA('test-provider');
    assert.equal(a, b);
  });

  it('returns different instances for different providers', () => {
    const a = getProviderEWMA('provider-a');
    const b = getProviderEWMA('provider-b');
    assert.notEqual(a, b);
  });
});

describe('getLatencyEstimates', () => {
  it('returns object keyed by provider', () => {
    const estimates = getLatencyEstimates();
    assert.equal(typeof estimates, 'object');
  });
});
