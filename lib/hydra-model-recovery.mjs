/**
 * Hydra Model Recovery — Post-hoc detection and fallback for model errors.
 *
 * When an agent CLI fails because the configured model is unavailable
 * (e.g. Codex rejecting codex-5.2 on a ChatGPT account), this module detects
 * the error, offers fallback selection, and retries — so a single bad model
 * config doesn't kill an entire session.
 *
 * Pattern: check the result AFTER failure, then decide whether to recover.
 * Zero overhead on successful calls. Callers opt in explicitly.
 */

import { loadHydraConfig } from './hydra-config.mjs';
import { getActiveModel, setActiveModel } from './hydra-agents.mjs';
import { getProfile } from './hydra-model-profiles.mjs';

// ── Usage Limit Detection Patterns ──────────────────────────────────────────
// These are long-term quota exhaustions (hours/days), NOT transient rate limits.
// Key distinction: usage limits reset after days, rate limits reset after seconds.

const USAGE_LIMIT_PATTERNS = [
  // OpenAI / Codex — account-level quota
  /usage_limit_reached/i,
  /usage limit has been reached/i,
  /You've hit your usage limit/i,

  // Google — daily/monthly quota (not per-minute)
  /QUOTA_EXHAUSTED.*(?:per day|per month|daily|monthly)/i,

  // Anthropic — account-level spend limit
  /spending_limit_reached/i,
  /credit balance.*(?:exhausted|zero|empty)/i,
];

// ── Rate Limit Detection Patterns ───────────────────────────────────────────

const RATE_LIMIT_PATTERNS = [
  // Google / Gemini
  /RESOURCE_EXHAUSTED/i,
  /QUOTA_EXHAUSTED/i,
  /429\s*(?:Too Many Requests|Resource Exhausted)/i,
  /rate[_ ]?limit/i,
  /quota[_ ]?exceeded/i,

  // OpenAI / Codex
  /Rate limit reached/i,
  /Too Many Requests/i,
  /tokens per min/i,
  /requests per min/i,

  // Anthropic / Claude
  /overloaded_error/i,
  /rate_limit_error/i,

  // HTTP status
  /\b429\b.*(?:error|status|code)/i,
  /(?:error|status|code).*\b429\b/i,

  // Generic
  /too many requests/i,
  /(?:at|over)\s+capacity/i,
];

/**
 * Extract a Retry-After delay (in ms) from error text, if present.
 * Looks for "Retry-After: N" header or "retry after N seconds" prose.
 */
function extractRetryAfterMs(text) {
  // "Retry-After: 30" (HTTP header style)
  const header = text.match(/retry[- ]after[:\s]+(\d+)/i);
  if (header) {
    const val = parseInt(header[1], 10);
    // If value > 1000, it's probably already in ms; if small, treat as seconds
    return val > 1000 ? val : val * 1000;
  }
  // "retry after 30 seconds" / "wait 30s"
  const prose = text.match(/(?:retry|wait)\s+(?:after\s+)?(\d+)\s*(?:s(?:ec(?:ond)?s?)?|ms)/i);
  if (prose) {
    const val = parseInt(prose[1], 10);
    const unit = prose[0].toLowerCase();
    return unit.includes('ms') ? val : val * 1000;
  }
  return null;
}

/**
 * Extract the reset time (in seconds) from a usage-limit JSON error body.
 * Looks for `"resets_in_seconds": N` in Codex/OpenAI error responses.
 * @param {string} text - Combined error text
 * @returns {number|null} Seconds until reset, or null if not found
 */
function extractResetSeconds(text) {
  const match = text.match(/"resets_in_seconds"\s*:\s*(\d+)/);
  if (match) return parseInt(match[1], 10);
  // "try again at Feb 13th, 2026 11:43 PM" — parse as future date
  const dateMatch = text.match(/try again (?:at|after)\s+(.+?)(?:\.|$)/im);
  if (dateMatch) {
    try {
      const resetDate = new Date(dateMatch[1]);
      if (!isNaN(resetDate.getTime())) {
        const seconds = Math.round((resetDate.getTime() - Date.now()) / 1000);
        if (seconds > 0) return seconds;
      }
    } catch { /* ignore parse failures */ }
  }
  return null;
}

// ── Circuit Breaker ─────────────────────────────────────────────────────────
// Tracks per-model failure counts within a sliding window.
// When failures exceed threshold, the circuit "opens" and callers skip
// directly to fallback instead of wasting time on a known-bad model.

const circuitState = new Map(); // model → { failures: [{ts}], isOpen, openedAt }

/**
 * Record a model failure for circuit breaker tracking.
 * Opens the circuit if failures exceed threshold within window.
 * @param {string} model - Model ID that failed
 */
export function recordModelFailure(model) {
  if (!model) return;
  const cfg = loadHydraConfig();
  const cbCfg = cfg.modelRecovery?.circuitBreaker || {};
  if (cbCfg.enabled === false) return;

  const threshold = cbCfg.failureThreshold || 5;
  const windowMs = cbCfg.windowMs || 300_000;
  const now = Date.now();

  let state = circuitState.get(model);
  if (!state) {
    state = { failures: [], isOpen: false, openedAt: null };
    circuitState.set(model, state);
  }

  // Add failure, prune old entries outside window
  state.failures.push({ ts: now });
  state.failures = state.failures.filter(f => (now - f.ts) < windowMs);

  if (state.failures.length >= threshold && !state.isOpen) {
    state.isOpen = true;
    state.openedAt = now;
  }
}

/**
 * Check whether the circuit breaker is open (tripped) for a model.
 * Auto-resets after the configured window elapses.
 * @param {string} model - Model ID
 * @returns {boolean}
 */
export function isCircuitOpen(model) {
  if (!model) return false;
  const cfg = loadHydraConfig();
  const cbCfg = cfg.modelRecovery?.circuitBreaker || {};
  if (cbCfg.enabled === false) return false;

  const state = circuitState.get(model);
  if (!state || !state.isOpen) return false;

  // Auto-reset after window elapses
  const windowMs = cbCfg.windowMs || 300_000;
  if (Date.now() - state.openedAt > windowMs) {
    state.isOpen = false;
    state.openedAt = null;
    state.failures = [];
    return false;
  }

  return true;
}

/**
 * Get circuit breaker state for all tracked models.
 * @returns {Object<string, {failures: number, isOpen: boolean, openedAt: number|null}>}
 */
export function getCircuitState() {
  const result = {};
  for (const [model, state] of circuitState) {
    result[model] = {
      failures: state.failures.length,
      isOpen: state.isOpen,
      openedAt: state.openedAt,
    };
  }
  return result;
}

/**
 * Reset circuit breaker for a specific model or all models.
 * @param {string} [model] - Model ID, or undefined to reset all
 */
export function resetCircuitBreaker(model) {
  if (model) {
    circuitState.delete(model);
  } else {
    circuitState.clear();
  }
}

// ── Error Detection Patterns ────────────────────────────────────────────────

const MODEL_ERROR_PATTERNS = [
  // Codex / OpenAI
  /model\b.*\bis[_ ]not[_ ]supported/i,
  /model\b.*\bdoes[_ ]not[_ ]exist/i,
  /model[_-]?not[_-]?found/i,
  /that model is not available/i,

  // Claude / Anthropic
  /model\b.*\bis[_ ]not[_ ]available/i,
  /invalid[_-]?model/i,
  /model:.*not found/i,

  // Gemini / Google
  /Model not found/i,
  /PERMISSION_DENIED.*model/i,
  /models\/\S+ is not found/i,

  // Generic
  /unsupported model/i,
  /model.*unavailable/i,
  /unknown model/i,
  /could not find model/i,
];

// ── Codex-Specific Error Patterns ───────────────────────────────────────────
// These don't trigger model fallback — they indicate invocation, auth, or
// sandbox problems that need different handling (reported to doctor, not retried).

const CODEX_ERROR_PATTERNS = [
  // Sandbox / permission
  { pattern: /sandbox\s*(?:violation|error|timeout|denied)/i,   category: 'sandbox' },
  { pattern: /execution\s*(?:not permitted|denied|failed)/i,    category: 'sandbox' },
  // Auth / API key
  { pattern: /(?:auth|api.?key|token)\s*(?:failed|invalid|missing|expired)/i, category: 'auth' },
  // CLI invocation
  { pattern: /unknown\s+(?:flag|option|argument)/i,             category: 'invocation' },
  { pattern: /ENOENT/i,                                         category: 'invocation' },
  // Internal / runtime errors (Codex CLI or backend)
  { pattern: /something went wrong/i,                           category: 'internal' },
  { pattern: /internal\s*(?:server\s*)?error/i,                 category: 'internal' },
  { pattern: /unexpected\s*error/i,                             category: 'internal' },
  { pattern: /unhandled\s*(?:exception|error|rejection)/i,      category: 'internal' },
  { pattern: /(?:codex|cli)\s*(?:crash|panic|fatal)/i,          category: 'internal' },
  // Configuration / setup
  { pattern: /config(?:uration)?\s*(?:error|invalid|missing)/i, category: 'config' },
  { pattern: /invalid\s*(?:request|input|payload|prompt)/i,     category: 'config' },
  { pattern: /context\s*(?:length|window|limit)\s*exceeded/i,   category: 'context-overflow' },
  { pattern: /maximum\s*(?:context|token)\s*length/i,           category: 'context-overflow' },
  // Codex-specific process issues
  { pattern: /(?:timed?\s*out|deadline)\s*(?:waiting|exceeded|reached)/i, category: 'timeout' },
  { pattern: /(?:connection|session)\s*(?:closed|reset|lost|dropped)/i,   category: 'network' },
];

/**
 * Extract the failed model ID from an error message, if possible.
 */
function extractModelFromError(text) {
  // "The model `gpt-999` does not exist" / "model 'gpt-999' not found"
  const quoted = text.match(/model\s+[`'"]([\w.:-]+)[`'"]/i);
  if (quoted) return quoted[1];
  // "The 'gpt-999' model is not supported" (reversed order)
  const preQuoted = text.match(/[`'"]([\w.:-]+)[`'"]\s+model/i);
  if (preQuoted) return preQuoted[1];
  // "model gpt-999 is not supported"
  const bare = text.match(/model\s+([\w.:-]+)\s+(?:is|does|not)/i);
  if (bare && !['is', 'does', 'not'].includes(bare[1].toLowerCase())) return bare[1];
  // "models/gemini-999 is not found"
  const modelsSlash = text.match(/models\/([\w.:-]+)/i);
  if (modelsSlash) return modelsSlash[1];
  return null;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Check whether a failed agent result is due to a long-term usage/quota limit.
 *
 * Usage limits are fundamentally different from rate limits:
 * - Rate limits reset in seconds/minutes (transient, worth retrying)
 * - Usage limits reset in hours/days (account quota, NOT worth retrying)
 *
 * This should be checked BEFORE detectRateLimitError() — if it's a usage
 * limit, don't waste retries with backoff.
 *
 * @param {string} agent - Agent name (claude, codex, gemini)
 * @param {object} result - executeAgent result: { ok, output, stderr, error }
 * @returns {{ isUsageLimit: boolean, resetInSeconds: number|null, errorMessage: string }}
 */
export function detectUsageLimitError(agent, result) {
  if (!result || result.ok) {
    return { isUsageLimit: false, resetInSeconds: null, errorMessage: '' };
  }

  const sources = [
    result.stderr || '',
    result.output || '',
    result.error || '',
  ].join('\n');

  for (const pattern of USAGE_LIMIT_PATTERNS) {
    if (pattern.test(sources)) {
      const matchLine = sources.split('\n').find(l => pattern.test(l)) || sources.slice(0, 200);

      // If the matched line mentions per-minute/per-hour/rate-limit language, it's a
      // transient rate limit (not an account-level quota) — skip this pattern so
      // detectRateLimitError() can handle it properly.
      if (/per\s*(?:min(?:ute)?|hour|sec(?:ond)?)|rpm|tpm|itpm|otpm|rate\s*limit/i.test(matchLine)) {
        continue;
      }

      const resetInSeconds = extractResetSeconds(sources);

      // If a reset time is given and it's very short (< 2 hours), it's transient.
      if (resetInSeconds !== null && resetInSeconds < 7200) {
        continue;
      }

      return {
        isUsageLimit: true,
        resetInSeconds,
        errorMessage: matchLine.trim().slice(0, 300),
      };
    }
  }

  return { isUsageLimit: false, resetInSeconds: null, errorMessage: '' };
}

/**
 * Format reset time for display (e.g. "3.2 days", "6 hours", "45 min").
 * @param {number|null} resetInSeconds
 * @returns {string}
 */
export function formatResetTime(resetInSeconds) {
  if (!resetInSeconds || resetInSeconds <= 0) return 'unknown';
  if (resetInSeconds >= 86400) return `${(resetInSeconds / 86400).toFixed(1)} days`;
  if (resetInSeconds >= 3600) return `${(resetInSeconds / 3600).toFixed(1)} hours`;
  if (resetInSeconds >= 60) return `${Math.round(resetInSeconds / 60)} min`;
  return `${resetInSeconds}s`;
}

/**
 * Verify whether an agent's API account is actually quota-exhausted by making
 * a lightweight test call to the relevant API endpoint (GET /models).
 *
 * Prevents false positives: if the account returns HTTP 200, the pattern match
 * that triggered usage-limit detection was a false positive.
 *
 * Returns:
 *   { verified: false }     — Account is active; pattern match was a false positive
 *   { verified: true }      — API confirmed quota exhausted (402 or quota-type 429)
 *   { verified: 'unknown' } — Could not reach API (no key, network error, ambiguous)
 *
 * @param {string} agent - 'codex', 'claude', or 'gemini'
 * @param {object} [opts]
 * @param {string} [opts.hintText] - Error text from the agent, used to detect quota type
 * @returns {Promise<{ verified: boolean|'unknown', status?: number, reason?: string }>}
 */
export async function verifyAgentQuota(agent, opts = {}) {
  const hintText = opts.hintText || '';
  try {
    if (agent === 'codex') {
      // The Codex CLI uses two separate quota systems:
      //   1. ChatGPT Codex quota (chatgpt.com/codex) — for models like gpt-5.2-codex
      //      Managed via the ChatGPT web auth, NOT the OpenAI REST API.
      //      Cannot be verified with OPENAI_API_KEY.
      //   2. OpenAI API quota (api.openai.com) — for API-based models like o4-mini
      // Detect which type by looking for chatgpt.com URLs in the error message.
      if (hintText && /chatgpt\.com\/codex/i.test(hintText)) {
        return {
          verified: 'unknown',
          reason: 'Codex CLI ChatGPT quota (chatgpt.com/codex/settings/usage) — not verifiable via OPENAI_API_KEY',
        };
      }
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return { verified: 'unknown', reason: 'no OPENAI_API_KEY' };
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) return { verified: false, status: res.status };
      if (res.status === 402) return { verified: true, status: 402, reason: 'billing' };
      if (res.status === 429) {
        const body = await res.text().catch(() => '');
        const isQuota = /usage_limit|spending_limit|hard_limit|insufficient_quota/i.test(body);
        return { verified: isQuota, status: 429, reason: isQuota ? 'quota' : 'rate-limit' };
      }
      return { verified: 'unknown', status: res.status, reason: `HTTP ${res.status}` };
    }

    if (agent === 'claude') {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      // Claude Code uses OAuth auth, not an API key — cannot verify remotely.
      // The CLI's auth token is managed by `claude auth login` and not exposed as an env var.
      if (!apiKey) return { verified: 'unknown', reason: 'OAuth CLI auth — set ANTHROPIC_API_KEY to enable verification' };
      const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) return { verified: false, status: res.status };
      if (res.status === 402 || res.status === 529) return { verified: true, status: res.status, reason: 'billing' };
      if (res.status === 429) {
        const body = await res.text().catch(() => '');
        const isQuota = /spending_limit|credit_balance|usage_limit/i.test(body);
        return { verified: isQuota, status: 429, reason: isQuota ? 'quota' : 'rate-limit' };
      }
      return { verified: 'unknown', status: res.status, reason: `HTTP ${res.status}` };
    }

    if (agent === 'gemini') {
      const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
      // Gemini CLI uses OAuth / gcloud ADC — cannot verify remotely without an API key.
      if (!apiKey) return { verified: 'unknown', reason: 'OAuth CLI auth — set GEMINI_API_KEY to enable verification' };
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=1`,
        { signal: AbortSignal.timeout(6000) }
      );
      if (res.ok) return { verified: false, status: res.status };
      if (res.status === 429) {
        const body = await res.text().catch(() => '');
        const isQuota = /QUOTA_EXHAUSTED.*(?:day|month)|daily.*quota|monthly.*quota/i.test(body);
        return { verified: isQuota, status: 429, reason: isQuota ? 'quota' : 'rate-limit' };
      }
      return { verified: 'unknown', status: res.status, reason: `HTTP ${res.status}` };
    }

    return { verified: 'unknown', reason: `unknown agent: ${agent}` };
  } catch (err) {
    return { verified: 'unknown', reason: err.message?.slice(0, 80) || 'network error' };
  }
}

/**
 * Check whether a failed agent result is due to a rate limit / quota error.
 * NOTE: Call detectUsageLimitError() first — usage limits are a superset of
 * the 429 pattern but require different handling (no retry, immediate fallback).
 *
 * @param {string} agent - Agent name (claude, codex, gemini)
 * @param {object} result - executeAgent result: { ok, output, stderr, error }
 * @returns {{ isRateLimit: boolean, retryAfterMs: number|null, errorMessage: string }}
 */
export function detectRateLimitError(agent, result) {
  if (!result || result.ok) {
    return { isRateLimit: false, retryAfterMs: null, errorMessage: '' };
  }

  // Skip if this is a usage limit (handled by detectUsageLimitError)
  const usageCheck = detectUsageLimitError(agent, result);
  if (usageCheck.isUsageLimit) {
    return { isRateLimit: false, retryAfterMs: null, errorMessage: '' };
  }

  const sources = [
    result.stderr || '',
    result.output || '',
    result.error || '',
  ].join('\n');

  for (const pattern of RATE_LIMIT_PATTERNS) {
    if (pattern.test(sources)) {
      const retryAfterMs = extractRetryAfterMs(sources);
      const matchLine = sources.split('\n').find(l => pattern.test(l)) || sources.slice(0, 200);
      return {
        isRateLimit: true,
        retryAfterMs,
        errorMessage: matchLine.trim().slice(0, 300),
      };
    }
  }

  return { isRateLimit: false, retryAfterMs: null, errorMessage: '' };
}

/**
 * Calculate exponential backoff delay with jitter.
 *
 * @param {number} attempt - 0-indexed attempt number
 * @param {object} [opts]
 * @param {number} [opts.baseDelayMs=5000] - Base delay for first retry
 * @param {number} [opts.maxDelayMs=60000] - Maximum delay cap
 * @param {number} [opts.retryAfterMs] - Server-suggested delay (overrides calculation)
 * @returns {number} delay in ms
 */
export function calculateBackoff(attempt, opts = {}) {
  const { baseDelayMs = 5000, maxDelayMs = 60_000, retryAfterMs } = opts;

  // Honour server-suggested delay if present
  if (retryAfterMs && retryAfterMs > 0) {
    return Math.min(retryAfterMs, maxDelayMs);
  }

  // Exponential backoff: base * 2^attempt + jitter (0-25% of delay)
  const exponential = baseDelayMs * Math.pow(2, attempt);
  const capped = Math.min(exponential, maxDelayMs);
  const jitter = Math.random() * capped * 0.25;
  return Math.round(capped + jitter);
}

/**
 * Check whether a failed agent result is due to a model error.
 *
 * @param {string} agent - Agent name (claude, codex, gemini)
 * @param {object} result - executeAgent result: { ok, output, stderr, error }
 * @returns {{ isModelError: boolean, failedModel: string|null, errorMessage: string }}
 */
export function detectModelError(agent, result) {
  if (!result || result.ok) {
    return { isModelError: false, failedModel: null, errorMessage: '' };
  }

  // Combine all text sources to scan
  const sources = [
    result.stderr || '',
    result.output || '',
    result.error || '',
  ].join('\n');

  for (const pattern of MODEL_ERROR_PATTERNS) {
    if (pattern.test(sources)) {
      const failedModel = extractModelFromError(sources) || getActiveModel(agent) || null;
      // Find the matching line for a descriptive error message
      const matchLine = sources.split('\n').find(l => pattern.test(l)) || sources.slice(0, 200);
      return {
        isModelError: true,
        failedModel,
        errorMessage: matchLine.trim().slice(0, 300),
      };
    }
  }

  return { isModelError: false, failedModel: null, errorMessage: '' };
}

/**
 * Check for Codex-specific non-model errors.
 * These are NOT worth retrying with a different model — they need different fixes.
 *
 * Categories: sandbox, auth, invocation, internal, config, context-overflow,
 * timeout, network, signal, silent-crash, codex-jsonl-error, codex-unknown.
 *
 * The catch-all 'codex-unknown' ensures NO Codex failure falls through
 * undetected — it captures exit code, stderr tail, and JSONL error events
 * for doctor diagnosis.
 *
 * @param {string} agent - Agent name (only meaningful for 'codex')
 * @param {object} result - executeAgent result: { ok, output, stderr, error, exitCode, errorCategory }
 * @returns {{ isCodexError: boolean, category: string, errorMessage: string }}
 */
export function detectCodexError(agent, result) {
  if (!result || result.ok || agent !== 'codex') {
    return { isCodexError: false, category: '', errorMessage: '' };
  }

  // If diagnoseAgentError already classified it, use that
  if (result.errorCategory && result.errorCategory !== 'unclassified') {
    return {
      isCodexError: true,
      category: result.errorCategory,
      errorMessage: result.errorDetail || result.error || '',
    };
  }

  const sources = [
    result.stderr || '',
    result.output || '',
    result.error || '',
  ].join('\n');

  for (const { pattern, category } of CODEX_ERROR_PATTERNS) {
    if (pattern.test(sources)) {
      const matchLine = sources.split('\n').find(l => pattern.test(l)) || sources.slice(0, 200);
      return {
        isCodexError: true,
        category,
        errorMessage: matchLine.trim().slice(0, 300),
      };
    }
  }

  // Empty output with non-zero exit or signal = silent crash
  if ((result.exitCode !== 0 || result.signal) && !(result.output || '').trim() && !(result.stderr || '').trim()) {
    const reason = result.signal ? `signal ${result.signal}` : `code ${result.exitCode}`;
    return {
      isCodexError: true,
      category: 'silent-crash',
      errorMessage: `Codex aborted (${reason}) but produced no output`,
    };
  }

  // Handle signal-based aborts even if there was some output
  if (result.signal && !result.ok) {
    return {
      isCodexError: true,
      category: 'signal',
      errorMessage: `Codex aborted by signal ${result.signal}`,
    };
  }

  // Catch-all: non-zero exit or null exit with stderr, that didn't match any known pattern.
  // Instead of returning false (which loses the error to "unclassified" limbo),
  // classify it as a Codex-specific unknown error with rich diagnostic context.
  const hasOutput = (result.stderr || '').trim() || (result.output || '').trim();
  if ((result.exitCode !== 0 || (result.exitCode === null && hasOutput)) && result.exitCode !== undefined) {
    // Gather the best diagnostic context available
    const stderrTail = (result.stderr || '').trim().split('\n').slice(-5).join(' | ').slice(0, 300);
    const errorTail = (result.error || '').slice(0, 200);
    // Check for JSONL error events in raw stdout
    const jsonlErrors = extractCodexErrorsFromResult(result);
    const jsonlContext = jsonlErrors.length > 0
      ? ` JSONL errors: ${jsonlErrors.join('; ').slice(0, 200)}`
      : '';

    const exitInfo = result.exitCode !== null ? `exit ${result.exitCode}` : 'terminated';
    return {
      isCodexError: true,
      category: 'codex-unknown',
      errorMessage: `Codex ${exitInfo}: ${stderrTail || errorTail || 'no context'}${jsonlContext}`.slice(0, 500),
    };
  }

  return { isCodexError: false, category: '', errorMessage: '' };
}

/**
 * Extract error messages from Codex JSONL output within a result object.
 * Lightweight helper that avoids importing agent-executor (circular dep).
 * @param {object} result - executeAgent result
 * @returns {string[]} extracted error messages
 */
function extractCodexErrorsFromResult(result) {
  const raw = result.stdout || result.output || '';
  if (!raw || typeof raw !== 'string') return [];
  const errors = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj.type === 'error' && obj.message) errors.push(obj.message);
      else if (obj.error?.message) errors.push(obj.error.message);
      else if (obj.error && typeof obj.error === 'string') errors.push(obj.error);
    } catch { /* skip non-JSON */ }
  }
  return errors;
}

/**
 * Get fallback model candidates for an agent, excluding the failed model.
 * Reads config presets (default, fast, cheap) + aliases. Does NOT call
 * the expensive fetchModels() API — keeps it fast.
 *
 * @param {string} agent - Agent name
 * @param {string} failedModel - The model that failed
 * @returns {Array<{ id: string, label: string, source: string }>}
 */
export function getFallbackCandidates(agent, failedModel) {
  const cfg = loadHydraConfig();
  const agentModels = cfg.models?.[agent] || {};
  const aliases = cfg.aliases?.[agent] || {};

  const seen = new Set();
  const failed = (failedModel || '').toLowerCase();
  const skipCodexApiOnly = (id) => agent === 'codex' && /^(o4-mini|gpt-5|gpt-5\.4)$/i.test(id);

  const candidates = [];

  // 1. Config presets in priority order
  for (const preset of ['default', 'fast', 'cheap']) {
    const modelId = agentModels[preset];
    if (modelId && modelId.toLowerCase() !== failed && !seen.has(modelId.toLowerCase()) && !skipCodexApiOnly(modelId)) {
      seen.add(modelId.toLowerCase());
      const profile = getProfile(modelId);
      candidates.push({
        id: modelId,
        label: `${preset}: ${modelId}`,
        source: 'preset',
        qualityScore: profile?.qualityScore ?? 0,
      });
    }
  }

  // 2. Aliases (deduplicated)
  for (const [alias, modelId] of Object.entries(aliases)) {
    if (modelId && modelId.toLowerCase() !== failed && !seen.has(modelId.toLowerCase()) && !skipCodexApiOnly(modelId)) {
      seen.add(modelId.toLowerCase());
      const profile = getProfile(modelId);
      candidates.push({
        id: modelId,
        label: `${alias}: ${modelId}`,
        source: 'alias',
        qualityScore: profile?.qualityScore ?? 0,
      });
    }
  }

  // Sort: presets first, then by qualityScore descending within each group
  candidates.sort((a, b) => {
    if (a.source === 'preset' && b.source !== 'preset') return -1;
    if (a.source !== 'preset' && b.source === 'preset') return 1;
    return b.qualityScore - a.qualityScore;
  });

  return candidates;
}

/**
 * Attempt to recover from a model error by selecting a fallback model.
 *
 * Two modes:
 * - **Interactive** (opts.rl + TTY): Uses promptChoice() for user selection
 * - **Headless** (no rl / no TTY): Auto-selects the first candidate
 *
 * On success, persists via setActiveModel() if autoPersist is enabled.
 *
 * @param {string} agent - Agent name
 * @param {string} failedModel - The model that failed
 * @param {object} [opts]
 * @param {object} [opts.rl] - readline interface for interactive mode
 * @returns {Promise<{ recovered: boolean, newModel: string|null }>}
 */
export async function recoverFromModelError(agent, failedModel, opts = {}) {
  const cfg = loadHydraConfig();
  const recoveryCfg = cfg.modelRecovery || {};

  if (recoveryCfg.enabled === false) {
    return { recovered: false, newModel: null };
  }

  const candidates = getFallbackCandidates(agent, failedModel);
  if (candidates.length === 0) {
    return { recovered: false, newModel: null };
  }

  const isInteractive = opts.rl && process.stdout.isTTY;

  let selected = null;

  if (isInteractive) {
    // Interactive mode — use promptChoice if available
    try {
      const { promptChoice } = await import('./hydra-prompt-choice.mjs');
      const { pickModel } = await import('./hydra-models-select.mjs');

      const options = candidates.map(c => c.label);
      options.push('Browse all models...');
      options.push('Skip (disable agent)');

      const { value } = await promptChoice(opts.rl, {
        title: `Model error: ${failedModel || 'unknown'} is unavailable for ${agent}`,
        context: { 'Failed model': failedModel || 'unknown', Agent: agent },
        options,
      });

      if (value === 'Skip (disable agent)') {
        return { recovered: false, newModel: null };
      }

      if (value === 'Browse all models...') {
        // Delegate to full model picker
        const pickedModel = await pickModel(agent);
        if (pickedModel) {
          selected = pickedModel;
        } else {
          return { recovered: false, newModel: null };
        }
      } else {
        // Find the candidate matching the selected label
        const match = candidates.find(c => c.label === value);
        selected = match ? match.id : null;
      }
    } catch {
      // promptChoice not available or failed — fall through to headless
      selected = candidates[0].id;
    }
  } else {
    // Headless mode — auto-select first candidate
    if (recoveryCfg.headlessFallback === false) {
      return { recovered: false, newModel: null };
    }
    selected = candidates[0].id;
  }

  if (!selected) {
    return { recovered: false, newModel: null };
  }

  // Persist the new model selection
  if (recoveryCfg.autoPersist !== false) {
    setActiveModel(agent, selected);
  }

  return { recovered: true, newModel: selected };
}

/**
 * Check whether model recovery is enabled in config.
 * @returns {boolean}
 */
export function isModelRecoveryEnabled() {
  const cfg = loadHydraConfig();
  return cfg.modelRecovery?.enabled !== false;
}
