/**
 * Hydra Streaming Middleware — Composable middleware pipeline for provider API calls.
 *
 * Inspired by Helicone's Tower middleware architecture: each concern (rate limiting,
 * circuit breaking, retry, usage tracking, telemetry) is an independent layer that
 * wraps the core streaming call in an onion-style pipeline.
 *
 * Usage:
 *   const pipeline = createStreamingPipeline('openai', coreStreamFn);
 *   const result = await pipeline(messages, cfg, onChunk);
 *
 * Each middleware has the signature: (ctx, next) => Promise<result>
 * where ctx carries cross-cutting data (provider, model, timing, headers, usage).
 */

import { acquireRateLimit, recordApiRequest, updateFromHeaders } from './hydra-rate-limits.mjs';
import { recordProviderUsage } from './hydra-provider-usage.mjs';
import { isCircuitOpen, recordModelFailure } from './hydra-model-recovery.mjs';
import { loadHydraConfig } from './hydra-config.mjs';
import { startProviderSpan, endProviderSpan } from './hydra-telemetry.mjs';

// ---------------------------------------------------------------------------
// PeakEWMA — Exponentially Weighted Moving Average for latency tracking
// Inspired by Helicone/Linkerd's P2C load balancing algorithm
// ---------------------------------------------------------------------------

/**
 * Tracks latency using an exponentially weighted moving average.
 * Recent observations have more weight; old observations decay.
 */
export class PeakEWMA {
  /**
   * @param {number} [decayMs=10000] — Half-life in ms. After this period, an observation's weight halves.
   */
  constructor(decayMs = 10000) {
    this._decayMs = decayMs;
    this._ewma = 0;
    this._lastTs = 0;
    this._count = 0;
  }

  /**
   * Record a latency observation.
   * @param {number} latencyMs
   */
  observe(latencyMs) {
    const now = Date.now();
    if (this._count === 0) {
      this._ewma = latencyMs;
      this._lastTs = now;
      this._count = 1;
      return;
    }

    const elapsed = now - this._lastTs;
    // Weight = e^(-elapsed/decay) — how much of the old average survives
    const weight = Math.exp(-elapsed / this._decayMs);
    this._ewma = (weight * this._ewma) + ((1 - weight) * latencyMs);
    this._lastTs = now;
    this._count++;
  }

  /**
   * Get the current estimated latency (decayed to now).
   * @returns {number} Estimated latency in ms, or 0 if no observations.
   */
  get() {
    if (this._count === 0) return 0;
    const elapsed = Date.now() - this._lastTs;
    const weight = Math.exp(-elapsed / this._decayMs);
    return this._ewma * weight;
  }

  /** @returns {number} Total observations recorded */
  get count() { return this._count; }

  /** Reset to initial state */
  reset() {
    this._ewma = 0;
    this._lastTs = 0;
    this._count = 0;
  }
}

// Per-provider PeakEWMA instances for health scoring
const providerLatency = new Map();

/**
 * Get the PeakEWMA tracker for a provider. Creates one if needed.
 * @param {string} provider
 * @returns {PeakEWMA}
 */
export function getProviderEWMA(provider) {
  if (!providerLatency.has(provider)) {
    providerLatency.set(provider, new PeakEWMA());
  }
  return providerLatency.get(provider);
}

/**
 * Get estimated latency for all tracked providers.
 * @returns {Record<string, number>} provider → estimated latency ms
 */
export function getLatencyEstimates() {
  const out = {};
  for (const [provider, ewma] of providerLatency) {
    out[provider] = ewma.get();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Middleware layers
// ---------------------------------------------------------------------------

/**
 * Rate limit middleware — waits for token bucket before proceeding.
 */
function rateLimitMiddleware(ctx, next) {
  return acquireRateLimit(ctx.provider).then(() => next());
}

/**
 * Circuit breaker middleware — checks if model is tripped, records failures.
 */
async function circuitBreakerMiddleware(ctx, next) {
  if (ctx.model && isCircuitOpen(ctx.model)) {
    const err = new Error(`Circuit breaker open for model ${ctx.model}`);
    err.circuitBreakerOpen = true;
    throw err;
  }

  try {
    const result = await next();
    return result;
  } catch (err) {
    // Record failure for circuit breaker tracking
    if (ctx.model && err.status && err.status >= 500) {
      recordModelFailure(ctx.model);
    }
    throw err;
  }
}

/**
 * Retry middleware — retries on 429 rate limit errors with exponential backoff.
 */
async function retryMiddleware(ctx, next) {
  const cfg = loadHydraConfig();
  const maxRetries = cfg.rateLimits?.maxRetries || 3;
  const baseDelayMs = cfg.rateLimits?.baseDelayMs || 5000;
  const maxDelayMs = cfg.rateLimits?.maxDelayMs || 60000;

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await next();
    } catch (err) {
      lastErr = err;
      const is429 = err.status === 429 || err.isRateLimit;
      if (!is429 || attempt >= maxRetries) throw err;

      // Exponential backoff with jitter
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
      const jitter = delay * 0.1 * Math.random();
      await new Promise((r) => setTimeout(r, delay + jitter));

      // Re-acquire rate limit token before retry
      await acquireRateLimit(ctx.provider);
    }
  }
  throw lastErr;
}

/**
 * Usage tracking middleware — records provider usage and API request after completion.
 */
async function usageTrackingMiddleware(ctx, next) {
  const result = await next();

  if (result.usage) {
    recordProviderUsage(ctx.provider, {
      inputTokens: result.usage.prompt_tokens || 0,
      outputTokens: result.usage.completion_tokens || 0,
      model: ctx.model,
    });
    recordApiRequest(ctx.provider, ctx.model, result.usage);
  }

  return result;
}

/**
 * Header capture middleware — extracts rate limit info from response headers.
 */
async function headerCaptureMiddleware(ctx, next) {
  const result = await next();

  if (result.rateLimits) {
    updateFromHeaders(ctx.provider, result.rateLimits);
  }

  return result;
}

/**
 * Telemetry middleware — creates OTel spans for provider calls.
 */
async function telemetryMiddleware(ctx, next) {
  const span = await startProviderSpan(ctx.provider, ctx.model);
  const start = Date.now();
  try {
    const result = await next();
    await endProviderSpan(span, result.usage, Date.now() - start);
    return result;
  } catch (err) {
    // End span with error
    if (!span._noop) {
      span.recordException?.(err);
      span.setStatus?.({ code: 2, message: err.message }); // SpanStatusCode.ERROR = 2
      span.end?.();
    }
    throw err;
  }
}

/**
 * Latency tracking middleware — feeds response time to PeakEWMA.
 */
async function latencyMiddleware(ctx, next) {
  const start = Date.now();
  try {
    const result = await next();
    const latencyMs = Date.now() - start;
    getProviderEWMA(ctx.provider).observe(latencyMs);
    ctx.latencyMs = latencyMs;
    return result;
  } catch (err) {
    // Don't track latency for rate limit errors (they skew the average)
    if (err.status !== 429 && !err.isRateLimit) {
      const latencyMs = Date.now() - start;
      getProviderEWMA(ctx.provider).observe(latencyMs);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Pipeline composition
// ---------------------------------------------------------------------------

/**
 * Compose middleware layers into a single function.
 * Layers are applied outside-in: the first layer in the array wraps everything.
 *
 * @param {Array<(ctx, next) => Promise>} layers
 * @param {(ctx) => Promise} core — innermost function
 * @returns {(ctx) => Promise}
 */
function compose(layers, core) {
  let fn = core;
  // Build from inside out
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    const next = fn;
    fn = (ctx) => layer(ctx, () => next(ctx));
  }
  return fn;
}

/**
 * Default middleware stack order.
 * Outermost (first) to innermost (last):
 *   latency → retry → rateLimit → circuitBreaker → telemetry → headerCapture → usageTracking → [core]
 */
const DEFAULT_LAYERS = [
  latencyMiddleware,
  retryMiddleware,
  rateLimitMiddleware,
  circuitBreakerMiddleware,
  telemetryMiddleware,
  headerCaptureMiddleware,
  usageTrackingMiddleware,
];

/**
 * Create a streaming pipeline that wraps a core provider function with middleware.
 *
 * The core function should have the signature:
 *   (messages, cfg, onChunk) => Promise<{ fullResponse, usage, rateLimits? }>
 *
 * The returned pipeline has the same signature as the core function.
 *
 * @param {string} provider — Provider name ('openai', 'anthropic', 'google')
 * @param {Function} coreFn — Core streaming function
 * @param {object} [opts]
 * @param {Array} [opts.layers] — Custom middleware layers (default: DEFAULT_LAYERS)
 * @returns {Function} Wrapped streaming function with same signature
 */
export function createStreamingPipeline(provider, coreFn, opts = {}) {
  const layers = opts.layers || DEFAULT_LAYERS;

  const composed = compose(layers, (ctx) => {
    return coreFn(ctx.messages, ctx.cfg, ctx.onChunk);
  });

  return async function pipelinedStream(messages, cfg, onChunk) {
    const ctx = {
      provider,
      model: cfg.model,
      messages,
      cfg,
      onChunk,
      latencyMs: 0,
    };
    return composed(ctx);
  };
}

// Re-export middleware layers for custom pipeline composition
export {
  rateLimitMiddleware,
  circuitBreakerMiddleware,
  retryMiddleware,
  usageTrackingMiddleware,
  headerCaptureMiddleware,
  latencyMiddleware,
  telemetryMiddleware,
  DEFAULT_LAYERS,
  compose,
};
