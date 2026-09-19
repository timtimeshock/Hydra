import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  LRUCache, contentHash,
  getCached, setCached, invalidateCache,
  recordNegativeHit, isNegativeHit,
  getCacheStats, clearAllCaches, pruneExpired,
} from '../lib/hydra-cache.mjs';

describe('LRUCache', () => {
  let cache;
  beforeEach(() => {
    cache = new LRUCache({ maxEntries: 3, ttlSec: 60 });
  });

  it('stores and retrieves values', () => {
    cache.set('a', 1);
    assert.equal(cache.get('a'), 1);
  });

  it('returns undefined for missing keys', () => {
    assert.equal(cache.get('missing'), undefined);
  });

  it('evicts oldest entry when at capacity', () => {
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.set('d', 4); // should evict 'a'
    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.get('d'), 4);
    assert.equal(cache.size, 3);
  });

  it('promotes accessed entries (LRU order)', () => {
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.get('a'); // promote 'a'
    cache.set('d', 4); // should evict 'b' (oldest non-promoted)
    assert.equal(cache.get('a'), 1);
    assert.equal(cache.get('b'), undefined);
  });

  it('expires entries after TTL', () => {
    cache = new LRUCache({ maxEntries: 10, ttlSec: 0 }); // 0 sec TTL
    cache.set('x', 42, 1); // 1ms TTL
    // Immediately expired
    const before = cache.get('x');
    // Wait briefly
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
    assert.equal(cache.get('x'), undefined);
  });

  it('tracks hit/miss stats', () => {
    cache.set('a', 1);
    cache.get('a');     // hit
    cache.get('a');     // hit
    cache.get('miss');  // miss
    const stats = cache.getStats();
    assert.equal(stats.hits, 2);
    assert.equal(stats.misses, 1);
    assert.ok(stats.hitRate > 0.6);
  });

  it('has() returns correct state', () => {
    cache.set('a', 1);
    assert.ok(cache.has('a'));
    assert.ok(!cache.has('b'));
  });

  it('delete() removes entry', () => {
    cache.set('a', 1);
    cache.delete('a');
    assert.equal(cache.get('a'), undefined);
  });

  it('clear() empties cache', () => {
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    assert.equal(cache.size, 0);
  });

  it('prune() removes expired entries', () => {
    cache.set('a', 1, 1); // 1ms TTL
    cache.set('b', 2, 60000); // 60s TTL
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
    const pruned = cache.prune();
    assert.equal(pruned, 1);
    assert.equal(cache.size, 1);
    assert.equal(cache.get('b'), 2);
  });
});

describe('contentHash', () => {
  it('produces deterministic hashes for strings', () => {
    const h1 = contentHash('hello');
    const h2 = contentHash('hello');
    assert.equal(h1, h2);
    assert.equal(typeof h1, 'string');
    assert.equal(h1.length, 64); // SHA-256 hex
  });

  it('produces deterministic hashes for objects', () => {
    const h1 = contentHash({ a: 1, b: 2 });
    const h2 = contentHash({ a: 1, b: 2 });
    assert.equal(h1, h2);
  });

  it('produces different hashes for different inputs', () => {
    const h1 = contentHash('hello');
    const h2 = contentHash('world');
    assert.notEqual(h1, h2);
  });
});

describe('namespace API', () => {
  beforeEach(() => {
    clearAllCaches();
  });

  it('getCached/setCached work across namespaces', () => {
    setCached('routing', 'key1', 'val1');
    setCached('agent', 'key1', 'val2');
    assert.equal(getCached('routing', 'key1'), 'val1');
    assert.equal(getCached('agent', 'key1'), 'val2');
  });

  it('invalidateCache removes specific key', () => {
    setCached('routing', 'a', 1);
    setCached('routing', 'b', 2);
    invalidateCache('routing', 'a');
    assert.equal(getCached('routing', 'a'), undefined);
    assert.equal(getCached('routing', 'b'), 2);
  });

  it('invalidateCache without key clears namespace', () => {
    setCached('routing', 'a', 1);
    setCached('routing', 'b', 2);
    invalidateCache('routing');
    assert.equal(getCached('routing', 'a'), undefined);
    assert.equal(getCached('routing', 'b'), undefined);
  });
});

describe('negative cache', () => {
  beforeEach(() => {
    clearAllCaches();
  });

  it('records and checks negative hits', () => {
    assert.ok(!isNegativeHit('agent', 'bad-model'));
    recordNegativeHit('agent', 'bad-model', new Error('Model unavailable'));
    assert.ok(isNegativeHit('agent', 'bad-model'));
  });

  it('accepts string errors', () => {
    recordNegativeHit('agent', 'key', 'failed');
    assert.ok(isNegativeHit('agent', 'key'));
  });
});

describe('getCacheStats', () => {
  beforeEach(() => {
    clearAllCaches();
  });

  it('returns stats for all namespaces', () => {
    setCached('routing', 'a', 1);
    getCached('routing', 'a');
    const stats = getCacheStats();
    assert.ok(stats.routing);
    assert.equal(stats.routing.size, 1);
    assert.equal(stats.routing.hits, 1);
  });
});
