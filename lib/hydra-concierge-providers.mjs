/**
 * Hydra Concierge Providers — Multi-provider abstraction and fallback chain.
 *
 * Detects available API keys, builds a fallback chain, and streams
 * completions through providers in order until one succeeds.
 * Dynamically reorders the chain based on remaining rate limit capacity.
 */

import { loadHydraConfig } from './hydra-config.mjs';
import { getModelReasoningCaps } from './hydra-agents.mjs';
import { canMakeRequest, getHealthiestProvider } from './hydra-rate-limits.mjs';

// ── Provider Detection ────────────────────────────────────────────────────────

const PROVIDER_KEYS = {
  openai:    () => process.env.OPENAI_API_KEY,
  anthropic: () => process.env.ANTHROPIC_API_KEY,
  google:    () => process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
};

/**
 * Detect which providers have API keys configured.
 * @returns {Array<{provider: string, apiKey: string}>}
 */
export function detectAvailableProviders() {
  const available = [];
  for (const [provider, getKey] of Object.entries(PROVIDER_KEYS)) {
    const key = getKey();
    if (key) {
      available.push({ provider, apiKey: key });
    }
  }
  return available;
}

// ── Fallback Chain ────────────────────────────────────────────────────────────

/**
 * Build the fallback chain from config, filtered by available API keys.
 * @returns {Array<{provider: string, model: string, available: boolean}>}
 */
export function buildFallbackChain() {
  const cfg = loadHydraConfig();
  const chain = cfg.concierge?.fallbackChain || [
    { provider: 'openai', model: 'gpt-5.6-terra' },
    { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
    { provider: 'google', model: 'gemini-3-flash-preview' },
  ];

  const available = detectAvailableProviders();
  const availableSet = new Set(available.map((a) => a.provider));

  return chain.map((entry) => ({
    provider: entry.provider,
    model: entry.model,
    available: availableSet.has(entry.provider),
  }));
}

// ── Display Helpers ───────────────────────────────────────────────────────────

/**
 * Create a display label for the active provider/model.
 * @param {string} provider - Provider name
 * @param {string} model - Model ID
 * @param {boolean} isFallback - Whether this is a fallback (not the primary)
 * @returns {string}
 */
export function providerLabel(provider, model, isFallback) {
  const suffix = isFallback ? ' \u2193' : ''; // ↓ for fallback
  return `${provider}:${model}${suffix}`;
}

// ── Streaming with Fallback ───────────────────────────────────────────────────

// Lazy-loaded provider modules
let _streamOpenAI = null;
let _streamAnthropic = null;
let _streamGoogle = null;

async function getStreamFn(provider) {
  if (provider === 'openai') {
    if (!_streamOpenAI) {
      const mod = await import('./hydra-openai.mjs');
      _streamOpenAI = mod.streamCompletion;
    }
    return _streamOpenAI;
  }
  if (provider === 'anthropic') {
    if (!_streamAnthropic) {
      const mod = await import('./hydra-anthropic.mjs');
      _streamAnthropic = mod.streamAnthropicCompletion;
    }
    return _streamAnthropic;
  }
  if (provider === 'google') {
    if (!_streamGoogle) {
      const mod = await import('./hydra-google.mjs');
      _streamGoogle = mod.streamGoogleCompletion;
    }
    return _streamGoogle;
  }
  throw new Error(`Unknown provider: ${provider}`);
}

/**
 * Stream a completion through the fallback chain.
 * Dynamically reorders providers by remaining capacity, then tries each
 * available provider in order. Returns on first success.
 * Throws combined error if all fail.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @param {object} cfg - Base config (model overridden per provider)
 * @param {Function} [onChunk] - Called with each streamed text chunk
 * @returns {Promise<{fullResponse: string, usage: object|null, provider: string, model: string, isFallback: boolean}>}
 */
export async function streamWithFallback(messages, cfg, onChunk) {
  let chain = buildFallbackChain().filter((e) => e.available);

  if (chain.length === 0) {
    throw new Error(
      'No API keys configured for concierge. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY.'
    );
  }

  // Dynamic reordering: sort by remaining capacity (healthiest provider first)
  chain = getHealthiestProvider(chain);

  const errors = [];
  const configPrimary = chain[0]?.provider; // Track who was first after reordering

  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i];
    const isFallback = i > 0;

    // Pre-request capacity check — skip exhausted providers (unless last resort)
    const check = canMakeRequest(entry.provider, entry.model);
    if (!check.allowed && i < chain.length - 1) {
      errors.push({
        provider: entry.provider,
        model: entry.model,
        error: `skipped: ${check.reason}`,
      });
      continue;
    }

    try {
      const streamFn = await getStreamFn(entry.provider);
      const providerCfg = { ...cfg, model: entry.model };

      // Map reasoning effort to provider-specific params
      if (cfg.reasoningEffort && entry.provider === 'anthropic') {
        const caps = getModelReasoningCaps(entry.model);
        if (caps.type === 'thinking') {
          const LEGACY_MAP = { high: 'deep', xhigh: 'deep', medium: 'standard', low: 'light' };
          const normalized = LEGACY_MAP[cfg.reasoningEffort] || cfg.reasoningEffort;
          const budget = caps.budgets?.[normalized];
          if (budget && normalized !== 'off') {
            providerCfg.thinkingBudget = budget;
          }
        }
      }
      // OpenAI: reasoningEffort passed through as-is (already handled by streamCompletion)
      // Google: no reasoning params needed

      const result = await streamFn(messages, providerCfg, onChunk);

      return {
        fullResponse: result.fullResponse,
        usage: result.usage,
        provider: entry.provider,
        model: entry.model,
        isFallback,
      };
    } catch (err) {
      errors.push({ provider: entry.provider, model: entry.model, error: err.message });
      // Continue to next provider
    }
  }

  // All providers failed
  const details = errors.map((e) => `${e.provider}(${e.model}): ${e.error}`).join('; ');
  throw new Error(`All concierge providers failed: ${details}`);
}
