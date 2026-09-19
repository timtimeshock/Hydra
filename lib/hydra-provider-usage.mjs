/**
 * Hydra Provider Usage — Per-provider token tracking (local + external APIs).
 *
 * Two-layer tracking:
 * - Local: tokens recorded from our streaming calls (hydra-openai, hydra-anthropic, hydra-google)
 * - External: provider billing APIs when admin keys are available (OpenAI, Anthropic)
 *
 * Single source of truth for COST_PER_1K pricing table (previously in hydra-concierge.mjs).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadHydraConfig } from './hydra-config.mjs';
import { getCostTable as _getCostTable } from './hydra-model-profiles.mjs';
import { loadRpdState, getRpdState } from './hydra-rate-limits.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HYDRA_ROOT = path.resolve(__dirname, '..');

const USAGE_PATH = path.join(HYDRA_ROOT, 'docs', 'coordination', 'provider-usage.json');
const RETENTION_DAYS = 7;

// ── Cost per 1K tokens (input/output) for known models ──────────────────────
// Derived from hydra-model-profiles.mjs — single source of truth for pricing.

export const COST_PER_1K = _getCostTable();

/**
 * Estimate cost for a model given usage tokens.
 */
export function estimateCost(model, usage) {
  if (!usage) return 0;
  const rates = COST_PER_1K[model];
  if (!rates) return 0;
  const inputCost = ((usage.prompt_tokens || usage.inputTokens || 0) / 1000) * rates.input;
  const outputCost = ((usage.completion_tokens || usage.outputTokens || 0) / 1000) * rates.output;
  return inputCost + outputCost;
}

// ── In-Memory State ─────────────────────────────────────────────────────────

function emptyCounters() {
  return { inputTokens: 0, outputTokens: 0, cost: 0, calls: 0 };
}

const _usage = {
  openai:    { session: emptyCounters(), today: emptyCounters(), external: null },
  anthropic: { session: emptyCounters(), today: emptyCounters(), external: null },
  google:    { session: emptyCounters(), today: emptyCounters(), external: null },
};

let _externalCache = { ts: 0, ttlMs: 10 * 60 * 1000 };

// ── Recording ───────────────────────────────────────────────────────────────

/**
 * Record usage from a streaming API call.
 *
 * @param {'openai'|'anthropic'|'google'} provider
 * @param {object} data
 * @param {number} [data.inputTokens]
 * @param {number} [data.outputTokens]
 * @param {number} [data.cost] - Pre-calculated cost, or computed from model
 * @param {string} [data.model] - Model name for cost estimation
 */
export function recordProviderUsage(provider, data) {
  const entry = _usage[provider];
  if (!entry) return;

  const input = data.inputTokens || 0;
  const output = data.outputTokens || 0;
  const cost = data.cost || (data.model ? estimateCost(data.model, {
    prompt_tokens: input,
    completion_tokens: output,
  }) : 0);

  entry.session.inputTokens += input;
  entry.session.outputTokens += output;
  entry.session.cost += cost;
  entry.session.calls++;

  entry.today.inputTokens += input;
  entry.today.outputTokens += output;
  entry.today.cost += cost;
  entry.today.calls++;
}

// ── Queries ─────────────────────────────────────────────────────────────────

/**
 * Get full usage snapshot for all providers.
 */
export function getProviderUsage() {
  return {
    openai:    { session: { ..._usage.openai.session }, today: { ..._usage.openai.today }, external: _usage.openai.external },
    anthropic: { session: { ..._usage.anthropic.session }, today: { ..._usage.anthropic.today }, external: _usage.anthropic.external },
    google:    { session: { ..._usage.google.session }, today: { ..._usage.google.today }, external: _usage.google.external },
  };
}

/**
 * Get a formatted one-liner per provider for display.
 * @returns {string[]}
 */
export function getProviderSummary() {
  const lines = [];
  for (const [name, data] of Object.entries(_usage)) {
    const s = data.session;
    if (s.calls === 0) continue;
    const totalTokens = s.inputTokens + s.outputTokens;
    const tokenStr = totalTokens >= 1_000_000
      ? `${(totalTokens / 1_000_000).toFixed(1)}M`
      : totalTokens >= 1_000
        ? `${(totalTokens / 1_000).toFixed(0)}K`
        : String(totalTokens);
    const costStr = s.cost > 0 ? `$${s.cost.toFixed(2)}` : '~';
    lines.push(`${name}: ${tokenStr} (${costStr})`);
  }
  return lines;
}

/**
 * Get external account usage summary lines (for providers with admin keys).
 * @returns {string[]}
 */
export function getExternalSummary() {
  const lines = [];
  for (const [name, data] of Object.entries(_usage)) {
    if (!data.external) continue;
    const e = data.external;
    const totalTokens = (e.inputTokens || 0) + (e.outputTokens || 0);
    const tokenStr = totalTokens >= 1_000_000
      ? `${(totalTokens / 1_000_000).toFixed(1)}M`
      : totalTokens >= 1_000
        ? `${(totalTokens / 1_000).toFixed(0)}K`
        : String(totalTokens);
    const costStr = e.cost > 0 ? `$${e.cost.toFixed(2)} today` : '~';
    lines.push(`${name}: ${tokenStr} (${costStr})`);
  }
  return lines;
}

// ── Session Management ──────────────────────────────────────────────────────

/**
 * Reset session counters (call at startup).
 */
export function resetSessionUsage() {
  for (const entry of Object.values(_usage)) {
    entry.session = emptyCounters();
  }
}

// ── Persistence (daily rollup) ──────────────────────────────────────────────

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Load persisted daily counters from JSON. Merges into today's in-memory counters.
 */
export function loadProviderUsage() {
  try {
    if (!fs.existsSync(USAGE_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(USAGE_PATH, 'utf8'));
    const key = todayKey();
    const today = raw[key];
    if (!today) return;

    for (const provider of ['openai', 'anthropic', 'google']) {
      if (today[provider]) {
        _usage[provider].today = { ...emptyCounters(), ...today[provider] };
      }
    }

    // Restore RPD counters for rate limit tracking
    loadRpdState(raw);
  } catch {
    // Best effort
  }
}

/**
 * Persist daily counters to JSON. Keeps last RETENTION_DAYS days.
 */
export function saveProviderUsage() {
  try {
    const dir = path.dirname(USAGE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    let existing = {};
    try {
      if (fs.existsSync(USAGE_PATH)) {
        existing = JSON.parse(fs.readFileSync(USAGE_PATH, 'utf8'));
      }
    } catch { /* start fresh */ }

    const key = todayKey();
    existing[key] = {
      openai: { ..._usage.openai.today },
      anthropic: { ..._usage.anthropic.today },
      google: { ..._usage.google.today },
    };

    // Persist RPD counters for rate limit tracking across restarts
    existing.rpd = getRpdState();

    // Prune old entries
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
    const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`;
    for (const k of Object.keys(existing)) {
      if (k < cutoffKey) delete existing[k];
    }

    fs.writeFileSync(USAGE_PATH, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  } catch {
    // Best effort
  }
}

// ── External API Integration ────────────────────────────────────────────────

function getAdminKeys() {
  const cfg = loadHydraConfig();
  const providers = cfg.providers || {};
  return {
    openai: process.env.OPENAI_ADMIN_KEY || providers.openai?.adminKey || null,
    anthropic: process.env.ANTHROPIC_ADMIN_KEY || providers.anthropic?.adminKey || null,
  };
}

/**
 * Query external billing APIs for account-wide usage (cached, non-blocking).
 * Silently skips if admin keys are not configured.
 */
export async function refreshExternalUsage() {
  const now = Date.now();
  if (now - _externalCache.ts < _externalCache.ttlMs) return;
  _externalCache.ts = now;

  const keys = getAdminKeys();
  const tasks = [];

  if (keys.openai) tasks.push(fetchOpenAIUsage(keys.openai));
  if (keys.anthropic) tasks.push(fetchAnthropicUsage(keys.anthropic));

  if (tasks.length === 0) return;

  try {
    await Promise.allSettled(tasks);
  } catch {
    // Never block on external API failures
  }
}

async function fetchOpenAIUsage(adminKey) {
  try {
    const today = todayKey();
    const url = `https://api.openai.com/v1/organization/usage/completions?start_date=${today}`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${adminKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return;
    const data = await res.json();
    // Sum up tokens across all models
    let inputTokens = 0, outputTokens = 0;
    for (const bucket of (data.data || [])) {
      for (const result of (bucket.results || [])) {
        inputTokens += result.input_tokens || 0;
        outputTokens += result.output_tokens || 0;
      }
    }
    const cost = estimateCostGeneric('openai', inputTokens, outputTokens);
    _usage.openai.external = { inputTokens, outputTokens, cost };
  } catch {
    // Silently skip
  }
}

async function fetchAnthropicUsage(adminKey) {
  try {
    const today = todayKey();
    const url = `https://api.anthropic.com/v1/organizations/usage_report/messages?start_date=${today}`;
    const res = await fetch(url, {
      headers: {
        'x-api-key': adminKey,
        'anthropic-version': '2023-06-01',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return;
    const data = await res.json();
    let inputTokens = 0, outputTokens = 0;
    for (const entry of (data.data || [])) {
      inputTokens += entry.input_tokens || 0;
      outputTokens += entry.output_tokens || 0;
    }
    const cost = estimateCostGeneric('anthropic', inputTokens, outputTokens);
    _usage.anthropic.external = { inputTokens, outputTokens, cost };
  } catch {
    // Silently skip
  }
}

function estimateCostGeneric(provider, inputTokens, outputTokens) {
  // Use average rates for the provider as rough estimate
  const avgRates = {
    openai: { input: 0.002, output: 0.008 },
    anthropic: { input: 0.005, output: 0.025 },
  };
  const rates = avgRates[provider];
  if (!rates) return 0;
  return (inputTokens / 1000) * rates.input + (outputTokens / 1000) * rates.output;
}
