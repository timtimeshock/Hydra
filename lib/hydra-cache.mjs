/**
 * hydra-cache.mjs — LRU cache with TTL, content hashing, and negative cache
 *
 * Provides named-namespace caching for deterministic operations,
 * routing classification results, and failure tracking.
 *
 * Zero Hydra imports — sits at the bottom of the import tree.
 */

import crypto from 'crypto';

// ---------------------------------------------------------------------------
// LRU Cache with TTL
// ---------------------------------------------------------------------------

class CacheEntry {
  constructor(value, ttlMs) {
    this.value = value;
    this.expires = Date.now() + ttlMs;
    this.hits = 0;
    this.createdAt = Date.now();
  }
  isExpired() {
    return Date.now() > this.expires;
  }
}

class LRUCache {
  constructor(opts = {}) {
    this.maxEntries = opts.maxEntries || 1000;
    this.ttlMs = (opts.ttlSec || 300) * 1000;
    this._data = new Map();
    this._hits = 0;
    this._misses = 0;
  }

  get(key) {
    const entry = this._data.get(key);
    if (!entry || entry.isExpired()) {
      if (entry) this._data.delete(key);
      this._misses++;
      return undefined;
    }
    entry.hits++;
    this._hits++;
    // Move to end (most recently used)
    this._data.delete(key);
    this._data.set(key, entry);
    return entry.value;
  }

  set(key, value, ttlMs) {
    // Evict oldest if at capacity
    if (this._data.size >= this.maxEntries && !this._data.has(key)) {
      const oldest = this._data.keys().next().value;
      this._data.delete(oldest);
    }
    this._data.set(key, new CacheEntry(value, ttlMs || this.ttlMs));
  }

  has(key) {
    const entry = this._data.get(key);
    if (!entry || entry.isExpired()) {
      if (entry) this._data.delete(key);
      return false;
    }
    return true;
  }

  delete(key) {
    return this._data.delete(key);
  }

  clear() {
    this._data.clear();
    this._hits = 0;
    this._misses = 0;
  }

  get size() {
    return this._data.size;
  }

  getStats() {
    const total = this._hits + this._misses;
    return {
      size: this._data.size,
      maxEntries: this.maxEntries,
      hits: this._hits,
      misses: this._misses,
      hitRate: total > 0 ? (this._hits / total) : 0,
    };
  }

  /**
   * Remove expired entries (housekeeping).
   */
  prune() {
    let pruned = 0;
    for (const [key, entry] of this._data) {
      if (entry.isExpired()) {
        this._data.delete(key);
        pruned++;
      }
    }
    return pruned;
  }
}

// ---------------------------------------------------------------------------
// Content hashing
// ---------------------------------------------------------------------------

export function contentHash(data) {
  const str = typeof data === 'string' ? data : JSON.stringify(data);
  return crypto.createHash('sha256').update(str).digest('hex');
}

// ---------------------------------------------------------------------------
// Singleton namespace caches
// ---------------------------------------------------------------------------

const _caches = {};

function _getCache(namespace) {
  if (!_caches[namespace]) {
    _caches[namespace] = new LRUCache({ maxEntries: 1000, ttlSec: 300 });
  }
  return _caches[namespace];
}

/**
 * Initialize caches from config. Call once at startup if custom sizes needed.
 */
export function initCaches(config = {}) {
  if (!config.enabled) return;
  const defaults = { maxEntries: config.maxEntries || 1000, ttlSec: config.ttlSec || 300 };
  _caches.routing = new LRUCache(defaults);
  _caches.agent = new LRUCache(defaults);
  _caches.negative = new LRUCache({
    maxEntries: config.negativeCache?.maxEntries || 200,
    ttlSec: config.negativeCache?.ttlSec || 180,
  });
}

// ---------------------------------------------------------------------------
// High-level API
// ---------------------------------------------------------------------------

export function getCached(namespace, key) {
  return _getCache(namespace).get(key);
}

export function setCached(namespace, key, value, ttlMs) {
  _getCache(namespace).set(key, value, ttlMs);
}

export function invalidateCache(namespace, key) {
  if (key !== undefined) {
    _getCache(namespace).delete(key);
  } else {
    _getCache(namespace).clear();
  }
}

// ---------------------------------------------------------------------------
// Negative cache (record failures to skip retries)
// ---------------------------------------------------------------------------

export function recordNegativeHit(namespace, key, error) {
  const negKey = `${namespace}:${key}`;
  _getCache('negative').set(negKey, {
    error: typeof error === 'string' ? error : (error?.message || 'unknown'),
    timestamp: Date.now(),
  });
}

export function isNegativeHit(namespace, key) {
  const negKey = `${namespace}:${key}`;
  return _getCache('negative').has(negKey);
}

// ---------------------------------------------------------------------------
// Stats & maintenance
// ---------------------------------------------------------------------------

export function getCacheStats() {
  const stats = {};
  for (const [name, cache] of Object.entries(_caches)) {
    stats[name] = cache.getStats();
  }
  return stats;
}

export function clearAllCaches() {
  for (const cache of Object.values(_caches)) {
    cache.clear();
  }
}

export function pruneExpired() {
  let total = 0;
  for (const cache of Object.values(_caches)) {
    total += cache.prune();
  }
  return total;
}

// For testing
export { LRUCache };
