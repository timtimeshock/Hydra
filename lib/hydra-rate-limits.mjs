/**
 * Hydra Rate Limits — Proactive rate limit awareness.
 *
 * Tracks API request rates (RPM), token throughput (TPM), and daily request
 * counts (RPD) per provider. Captures real remaining-capacity from response
 * headers when available, falls back to estimated tracking otherwise.
 *
 * Lightweight: no timers, no polling. State updated passively on each request.
 * Sliding windows pruned lazily on access.
 */

import { loadHydraConfig } from './hydra-config.mjs';
import { getRateLimits as getModelRateLimits, getProfile } from './hydra-model-profiles.mjs';
import { getProviderEWMA, getLatencyEstimates } from './hydra-streaming-middleware.mjs';

// ── Sliding Window State ────────────────────────────────────────────────────

// RPM: array of request timestamps (ms) within the last 60s
const _requestTimestamps = { openai: [], anthropic: [], google: [] };

// TPM: array of { ts, tokens } within the last 60s
const _tokenTimestamps = { openai: [], anthropic: [], google: [] };

// RPD: daily request counter per provider
const _dailyRequests = {
  openai:    { date: null, count: 0 },
  anthropic: { date: null, count: 0 },
  google:    { date: null, count: 0 },
};

// Real remaining capacity from provider response headers
// Overrides estimated tracking when fresh (< HEADER_TTL_MS old)
const _headerCapacity = {
  openai:    null, // { remainingRequests, remainingTokens, resetAt, ts }
  anthropic: null, // { remainingRequests, remainingInputTokens, remainingOutputTokens, ts }
  google:    null, // (Google doesn't send these on success)
};

const WINDOW_MS = 60_000;       // 60-second sliding window
const HEADER_TTL_MS = 60_000;   // Trust header data for 60 seconds

// ── Helpers ─────────────────────────────────────────────────────────────────

function today() {
  return new Date().toISOString().slice(0, 10);
}

function pruneWindow(arr) {
  const cutoff = Date.now() - WINDOW_MS;
  while (arr.length > 0 && arr[0] < cutoff) arr.shift();
}

function pruneTokenWindow(arr) {
  const cutoff = Date.now() - WINDOW_MS;
  while (arr.length > 0 && arr[0].ts < cutoff) arr.shift();
}

function getProviderTier(provider) {
  const cfg = loadHydraConfig();
  const providerCfg = cfg.providers?.[provider] || {};
  const defaults = { openai: 1, anthropic: 1, google: 'free' };
  return providerCfg.tier ?? defaults[provider] ?? 1;
}

/**
 * Get effective rate limits for a provider+model at the user's configured tier.
 * @param {string} provider
 * @param {string} [model] - Model ID; if omitted, uses a sensible default
 * @returns {{ rpm?: number, tpm?: number, itpm?: number, otpm?: number, rpd?: number }|null}
 */
function getEffectiveLimits(provider, model) {
  const tier = getProviderTier(provider);
  if (model) {
    const limits = getModelRateLimits(model, tier);
    if (limits) return limits;
  }
  return null;
}

// ── Recording ───────────────────────────────────────────────────────────────

/**
 * Record that an API request was made to a provider.
 * Called from streaming clients after each successful request.
 *
 * @param {string} provider - 'openai' | 'anthropic' | 'google'
 * @param {string} model - Model ID used
 * @param {{ prompt_tokens?: number, completion_tokens?: number, inputTokens?: number, outputTokens?: number }|null} usage
 */
export function recordApiRequest(provider, model, usage) {
  if (!_requestTimestamps[provider]) return;

  const now = Date.now();

  // RPM: add timestamp
  _requestTimestamps[provider].push(now);
  pruneWindow(_requestTimestamps[provider]);

  // TPM: add token count
  const totalTokens = (usage?.prompt_tokens || usage?.inputTokens || 0) +
                      (usage?.completion_tokens || usage?.outputTokens || 0);
  if (totalTokens > 0) {
    _tokenTimestamps[provider].push({ ts: now, tokens: totalTokens });
    pruneTokenWindow(_tokenTimestamps[provider]);
  }

  // RPD: increment daily counter
  const d = today();
  const daily = _dailyRequests[provider];
  if (daily.date !== d) {
    daily.date = d;
    daily.count = 0;
  }
  daily.count++;
}

/**
 * Update remaining capacity from provider response headers.
 * Called from streaming clients immediately after fetch().
 *
 * @param {string} provider
 * @param {object} headers - Parsed header values (provider-specific)
 */
export function updateFromHeaders(provider, headers) {
  if (!headers || !_headerCapacity.hasOwnProperty(provider)) return;

  // Only store if we got at least one meaningful value
  const hasData = Object.values(headers).some(v => v != null && v !== '' && !isNaN(v));
  if (!hasData) return;

  _headerCapacity[provider] = { ...headers, ts: Date.now() };
}

// ── Querying ────────────────────────────────────────────────────────────────

/**
 * Check whether a request can be made to a provider without exceeding limits.
 *
 * @param {string} provider
 * @param {string} model - Model ID
 * @param {number} [estimatedTokens=0] - Estimated total tokens for the request
 * @returns {{ allowed: boolean, reason: string, remaining: { rpm: number|null, tpm: number|null, rpd: number|null } }}
 */
export function canMakeRequest(provider, model, estimatedTokens = 0) {
  const limits = getEffectiveLimits(provider, model);
  const remaining = getRemainingCapacity(provider, model);

  // No limit data → allow (we can't predict)
  if (!limits) {
    return { allowed: true, reason: 'no limit data', remaining };
  }

  // Check RPM
  if (limits.rpm && remaining.rpm != null && remaining.rpm <= 0) {
    return { allowed: false, reason: `RPM exhausted (${limits.rpm}/min)`, remaining };
  }

  // Check TPM (use either tpm or itpm depending on provider)
  const tpmLimit = limits.tpm || limits.itpm;
  if (tpmLimit && remaining.tpm != null) {
    if (remaining.tpm <= 0) {
      return { allowed: false, reason: `TPM exhausted (${tpmLimit}/min)`, remaining };
    }
    if (estimatedTokens > 0 && remaining.tpm < estimatedTokens) {
      return { allowed: false, reason: `insufficient TPM (need ~${estimatedTokens}, have ${remaining.tpm})`, remaining };
    }
  }

  // Check RPD (critical for Google free tier)
  if (limits.rpd && remaining.rpd != null && remaining.rpd <= 0) {
    return { allowed: false, reason: `RPD exhausted (${limits.rpd}/day)`, remaining };
  }

  // Warn threshold: allow but note when approaching limits
  const RPM_WARN_PCT = 0.1; // warn at 10% remaining
  if (limits.rpm && remaining.rpm != null && remaining.rpm < limits.rpm * RPM_WARN_PCT) {
    return { allowed: true, reason: `RPM low (${remaining.rpm} remaining)`, remaining };
  }

  return { allowed: true, reason: 'ok', remaining };
}

/**
 * Get remaining capacity for a provider.
 * Uses header data when fresh, otherwise estimates from sliding windows.
 *
 * @param {string} provider
 * @param {string} [model] - Model ID for limit lookup
 * @returns {{ rpm: number|null, tpm: number|null, rpd: number|null, pctRpm: number|null, pctTpm: number|null, pctRpd: number|null }}
 */
export function getRemainingCapacity(provider, model) {
  const limits = model ? getEffectiveLimits(provider, model) : null;
  const result = { rpm: null, tpm: null, rpd: null, pctRpm: null, pctTpm: null, pctRpd: null };

  // Check for fresh header data first
  const headers = _headerCapacity[provider];
  const headersFresh = headers && (Date.now() - headers.ts) < HEADER_TTL_MS;

  // RPM
  if (headersFresh && headers.remainingRequests != null) {
    result.rpm = headers.remainingRequests;
    if (limits?.rpm) result.pctRpm = Math.round((result.rpm / limits.rpm) * 100);
  } else if (limits?.rpm) {
    pruneWindow(_requestTimestamps[provider] || []);
    const used = (_requestTimestamps[provider] || []).length;
    result.rpm = Math.max(0, limits.rpm - used);
    result.pctRpm = Math.round((result.rpm / limits.rpm) * 100);
  }

  // TPM
  const tpmLimit = limits?.tpm || limits?.itpm;
  if (headersFresh && headers.remainingTokens != null) {
    result.tpm = headers.remainingTokens;
    if (tpmLimit) result.pctTpm = Math.round((result.tpm / tpmLimit) * 100);
  } else if (headersFresh && headers.remainingInputTokens != null) {
    result.tpm = headers.remainingInputTokens;
    if (tpmLimit) result.pctTpm = Math.round((result.tpm / tpmLimit) * 100);
  } else if (tpmLimit) {
    pruneTokenWindow(_tokenTimestamps[provider] || []);
    const usedTokens = (_tokenTimestamps[provider] || []).reduce((sum, e) => sum + e.tokens, 0);
    result.tpm = Math.max(0, tpmLimit - usedTokens);
    result.pctTpm = Math.round((result.tpm / tpmLimit) * 100);
  }

  // RPD
  if (limits?.rpd) {
    const d = today();
    const daily = _dailyRequests[provider];
    const used = (daily && daily.date === d) ? daily.count : 0;
    result.rpd = Math.max(0, limits.rpd - used);
    result.pctRpd = Math.round((result.rpd / limits.rpd) * 100);
  }

  return result;
}

/**
 * Score and sort provider candidates by remaining capacity (healthiest first).
 * Candidates with exhausted limits are pushed to the end.
 *
 * @param {Array<{ provider: string, model: string, available: boolean }>} candidates
 * @returns {Array<{ provider: string, model: string, available: boolean }>} Sorted copy
 */
export function getHealthiestProvider(candidates) {
  if (!candidates || candidates.length <= 1) return candidates;

  return [...candidates].sort((a, b) => {
    const capA = getRemainingCapacity(a.provider, a.model);
    const capB = getRemainingCapacity(b.provider, b.model);

    // Score: weighted average of capacity + latency (higher = healthier)
    const scoreA = computeHealthScore(capA, a.provider);
    const scoreB = computeHealthScore(capB, b.provider);

    return scoreB - scoreA; // descending (healthiest first)
  });
}

function computeHealthScore(cap, provider) {
  // Weight RPD higher (most critical constraint, especially for Google free tier)
  let score = 0;
  let weight = 0;
  if (cap.pctRpm != null) { score += cap.pctRpm * 1; weight += 1; }
  if (cap.pctTpm != null) { score += cap.pctTpm * 1; weight += 1; }
  if (cap.pctRpd != null) { score += cap.pctRpd * 2; weight += 2; } // double weight for RPD

  // Factor in latency via PeakEWMA (lower latency → higher score)
  if (provider) {
    const ewma = getProviderEWMA(provider);
    const latencyMs = ewma.get();
    if (latencyMs > 0) {
      // Map latency to a 0-100 score: <500ms → 100, >10s → 0, linear between
      const latencyScore = Math.max(0, Math.min(100, 100 - ((latencyMs - 500) / 9500) * 100));
      score += latencyScore * 1;
      weight += 1;
    }
  }

  if (weight === 0) return 50; // no data → neutral score
  return score / weight;
}

// ── Display ─────────────────────────────────────────────────────────────────

/**
 * Get a formatted rate limit summary for all providers.
 * Suitable for display in :usage command output.
 *
 * @returns {Array<{ provider: string, summary: string, model?: string }>}
 */
export function getRateLimitSummary() {
  const cfg = loadHydraConfig();
  const results = [];

  for (const provider of ['openai', 'anthropic', 'google']) {
    const tier = getProviderTier(provider);
    const cap = getRemainingCapacity(provider);
    const parts = [];

    if (cap.rpm != null) parts.push(`RPM: ${cap.rpm} left${cap.pctRpm != null ? ` (${cap.pctRpm}%)` : ''}`);
    if (cap.tpm != null) parts.push(`TPM: ${fmtTokens(cap.tpm)} left${cap.pctTpm != null ? ` (${cap.pctTpm}%)` : ''}`);
    if (cap.rpd != null) parts.push(`RPD: ${cap.rpd} left${cap.pctRpd != null ? ` (${cap.pctRpd}%)` : ''}`);

    if (parts.length === 0) parts.push('no tracking data');

    results.push({
      provider,
      summary: `Tier ${tier} — ${parts.join(' | ')}`,
    });
  }

  return results;
}

function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

// ── RPD Persistence ─────────────────────────────────────────────────────────
// Load/save daily request counts alongside provider-usage.json

/**
 * Load persisted RPD state (called on startup).
 * @param {object} data - Parsed provider-usage.json content
 */
export function loadRpdState(data) {
  if (!data?.rpd) return;
  for (const [provider, state] of Object.entries(data.rpd)) {
    if (_dailyRequests[provider] && state?.date && state?.count) {
      _dailyRequests[provider].date = state.date;
      _dailyRequests[provider].count = state.count;
    }
  }
}

/**
 * Get current RPD state for persistence.
 * @returns {object} RPD state keyed by provider
 */
export function getRpdState() {
  const out = {};
  for (const [provider, state] of Object.entries(_dailyRequests)) {
    if (state.date) {
      out[provider] = { date: state.date, count: state.count };
    }
  }
  return out;
}

// ── Reset (for testing) ─────────────────────────────────────────────────────

export function _resetState() {
  for (const p of ['openai', 'anthropic', 'google']) {
    _requestTimestamps[p] = [];
    _tokenTimestamps[p] = [];
    _dailyRequests[p] = { date: null, count: 0 };
    _headerCapacity[p] = null;
  }
}

// ── Token Bucket Rate Limiter ───────────────────────────────────────────────
// Pre-request enforcement: blocks until tokens are available.
// Merged from hydra-rate-limiter.mjs to consolidate rate limiting in one module.

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class TokenBucket {
  /**
   * @param {number} capacity    Max tokens (burst limit)
   * @param {number} refillRate  Tokens per second
   */
  constructor(capacity, refillRate) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillRate = refillRate;
    this._lastRefill = Date.now();
  }

  _refill() {
    const now = Date.now();
    const elapsed = (now - this._lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
    this._lastRefill = now;
  }

  tryConsume(n = 1) {
    this._refill();
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }

  async waitForTokens(n = 1) {
    while (!this.tryConsume(n)) {
      const deficit = n - this.tokens;
      const waitMs = Math.max(50, Math.ceil((deficit / this.refillRate) * 1000));
      await sleep(Math.min(waitMs, 5000));
    }
  }

  available() {
    this._refill();
    return Math.floor(this.tokens);
  }
}

// ── Per-Provider Limiters ───────────────────────────────────────────────────

const _limiters = new Map();

const DEFAULT_BUCKET_LIMITS = {
  openai: 60,       // 60 req/min
  anthropic: 50,    // 50 req/min
  google: 300,      // 300 req/min
};

export function initRateLimiters(rpsConfig = {}) {
  const limits = { ...DEFAULT_BUCKET_LIMITS, ...rpsConfig };
  for (const [provider, rps] of Object.entries(limits)) {
    const perSecond = rps / 60;
    _limiters.set(provider, new TokenBucket(Math.max(1, Math.ceil(rps / 6)), perSecond));
  }
}

function _getLimiter(provider) {
  if (!_limiters.has(provider)) {
    const rps = DEFAULT_BUCKET_LIMITS[provider] || 60;
    const perSecond = rps / 60;
    _limiters.set(provider, new TokenBucket(Math.max(1, Math.ceil(rps / 6)), perSecond));
  }
  return _limiters.get(provider);
}

/**
 * Acquire a rate limit token for a provider. Waits if necessary.
 * @param {string} provider  'openai' | 'anthropic' | 'google'
 */
export async function acquireRateLimit(provider) {
  const limiter = _getLimiter(provider);
  await limiter.waitForTokens(1);
}

export function tryAcquireRateLimit(provider) {
  return _getLimiter(provider).tryConsume(1);
}

export function getRateLimitStats() {
  const stats = {};
  for (const [provider, limiter] of _limiters) {
    stats[provider] = {
      available: limiter.available(),
      capacity: limiter.capacity,
      refillRate: limiter.refillRate,
    };
  }
  return stats;
}

export function resetRateLimiter(provider) {
  if (provider) {
    const limiter = _limiters.get(provider);
    if (limiter) limiter.tokens = limiter.capacity;
  } else {
    for (const limiter of _limiters.values()) {
      limiter.tokens = limiter.capacity;
    }
  }
}

// ── System-Wide Concurrency ─────────────────────────────────────────────────

let _activeCount = 0;
let _maxInFlight = 3;

export function initConcurrency(maxInFlight = 3) {
  _maxInFlight = maxInFlight;
}

export async function acquireConcurrencySlot() {
  while (_activeCount >= _maxInFlight) {
    await sleep(250);
  }
  _activeCount++;
  let released = false;
  return function release() {
    if (!released) {
      released = true;
      _activeCount--;
    }
  };
}

export function tryAcquireConcurrencySlot() {
  if (_activeCount >= _maxInFlight) return null;
  _activeCount++;
  let released = false;
  return function release() {
    if (!released) {
      released = true;
      _activeCount--;
    }
  };
}

export function getConcurrencyStats() {
  return {
    active: _activeCount,
    maxInFlight: _maxInFlight,
    utilization: _maxInFlight > 0 ? _activeCount / _maxInFlight : 0,
  };
}
