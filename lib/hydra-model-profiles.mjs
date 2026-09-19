/**
 * Hydra Model Profiles — Single source of truth for model data.
 *
 * Encodes MODEL_PROFILES.md benchmark, pricing, speed, and recommendation data
 * as a JS data module. Drives all model-related defaults, recommendations,
 * pricing, and UI annotations across the system.
 *
 * IMPORTANT: Zero Hydra imports — this module sits at the very bottom of the
 * import tree. hydra-config.mjs imports it, and hydra-config is imported by
 * nearly everything else.
 */

// ── MODEL_PROFILES ──────────────────────────────────────────────────────────
// Keyed by exact model ID. Each entry contains benchmark, pricing, speed,
// and capability data sourced from docs/MODEL_PROFILES.md.

export const MODEL_PROFILES = {
  'claude-opus-4-6': {
    id: 'claude-opus-4-6',
    provider: 'anthropic',
    agent: 'claude',
    displayName: 'Claude Opus 4.6',
    shortName: 'opus',
    tier: 'flagship',
    contextWindow: 200_000,
    maxOutput: 128_000,
    pricePer1M: { input: 5.00, output: 25.00 },
    costPer1K: { input: 0.005, output: 0.025 },
    tokPerSec: 66,
    ttft: 1.52,
    reasoning: { type: 'thinking', levels: ['off', 'light', 'standard', 'deep'], budgets: { light: 4096, standard: 16384, deep: 65536 }, default: 'off' },
    benchmarks: { sweBench: 80.8, terminalBench: 65.4, gpqaDiamond: 91.3, arcAgi2: 68.8, aime2025: 100, humanEval: 97.6, liveCodeBench: 76, aiderPolyglot: 89.4 },
    qualityScore: 95,
    valueScore: 40,
    speedScore: 25,
    strengths: ['abstract-reasoning', 'agentic', 'code-quality', 'long-context'],
    bestFor: ['planning', 'architecture', 'review', 'security'],
    // Opus 4.x shared limit (across Opus 4.6, 4.5, 4.1, 4)
    rateLimits: {
      1: { rpm: 50, itpm: 30_000, otpm: 8_000 },
      2: { rpm: 1_000, itpm: 450_000, otpm: 90_000 },
      3: { rpm: 2_000, itpm: 800_000, otpm: 160_000 },
      4: { rpm: 4_000, itpm: 2_000_000, otpm: 400_000 },
    },
  },
  'claude-sonnet-4-6': {
    id: 'claude-sonnet-4-6',
    provider: 'anthropic',
    agent: 'claude',
    displayName: 'Claude Sonnet 4.6',
    shortName: 'sonnet',
    tier: 'mid',
    contextWindow: 200_000,
    maxOutput: 64_000,
    pricePer1M: { input: 3.00, output: 15.00 },
    costPer1K: { input: 0.003, output: 0.015 },
    tokPerSec: 82,
    ttft: 1.50,
    reasoning: { type: 'thinking', levels: ['off', 'light', 'standard', 'deep'], budgets: { light: 4096, standard: 16384, deep: 65536 }, default: 'off' },
    benchmarks: { sweBench: 79.2, gpqaDiamond: 87.4, liveCodeBench: 72 },
    qualityScore: 85,
    valueScore: 62,
    speedScore: 30,
    strengths: ['price-performance', 'coding', 'balanced', 'agentic'],
    bestFor: ['implementation', 'review', 'documentation'],
    // Sonnet 4.x shared limit
    rateLimits: {
      1: { rpm: 50, itpm: 30_000, otpm: 8_000 },
      2: { rpm: 1_000, itpm: 450_000, otpm: 90_000 },
      3: { rpm: 2_000, itpm: 800_000, otpm: 160_000 },
      4: { rpm: 4_000, itpm: 2_000_000, otpm: 400_000 },
    },
  },
  'claude-sonnet-4-5-20250929': {
    id: 'claude-sonnet-4-5-20250929',
    provider: 'anthropic',
    agent: 'claude',
    displayName: 'Claude Sonnet 4.5',
    shortName: 'sonnet-4.5',
    tier: 'mid',
    contextWindow: 200_000,
    maxOutput: 64_000,
    pricePer1M: { input: 3.00, output: 15.00 },
    costPer1K: { input: 0.003, output: 0.015 },
    tokPerSec: 67,
    ttft: 1.80,
    reasoning: { type: 'thinking', levels: ['off', 'light', 'standard', 'deep'], budgets: { light: 4096, standard: 16384, deep: 65536 }, default: 'off' },
    benchmarks: { sweBench: 77.2, gpqaDiamond: 83.4, terminalBench: 50.5, liveCodeBench: 68, aiderPolyglot: 78.8 },
    qualityScore: 80,
    valueScore: 60,
    speedScore: 25,
    strengths: ['price-performance', 'coding', 'balanced'],
    bestFor: ['implementation', 'documentation', 'review'],
    // Sonnet 4.x shared limit (across Sonnet 4.5 and 4)
    rateLimits: {
      1: { rpm: 50, itpm: 30_000, otpm: 8_000 },
      2: { rpm: 1_000, itpm: 450_000, otpm: 90_000 },
      3: { rpm: 2_000, itpm: 800_000, otpm: 160_000 },
      4: { rpm: 4_000, itpm: 2_000_000, otpm: 400_000 },
    },
  },
  'claude-haiku-4-5-20251001': {
    id: 'claude-haiku-4-5-20251001',
    provider: 'anthropic',
    agent: 'claude',
    displayName: 'Claude Haiku 4.5',
    shortName: 'haiku',
    tier: 'economy',
    contextWindow: 200_000,
    maxOutput: 64_000,
    pricePer1M: { input: 1.00, output: 5.00 },
    costPer1K: { input: 0.001, output: 0.005 },
    tokPerSec: 150,
    ttft: 0.50,
    reasoning: { type: 'none' },
    benchmarks: { sweBench: 73.3, terminalBench: 41.0 },
    qualityScore: 65,
    valueScore: 85,
    speedScore: 65,
    strengths: ['speed', 'cost', 'volume'],
    bestFor: ['implementation', 'testing'],
    rateLimits: {
      1: { rpm: 50, itpm: 50_000, otpm: 10_000 },
      2: { rpm: 1_000, itpm: 450_000, otpm: 90_000 },
      3: { rpm: 2_000, itpm: 1_000_000, otpm: 200_000 },
      4: { rpm: 4_000, itpm: 4_000_000, otpm: 800_000 },
    },
  },

  'gpt-5.2-codex': {
    id: 'gpt-5.2-codex',
    provider: 'openai',
    agent: 'codex',
    displayName: 'GPT-5.2 Codex',
    shortName: 'gpt-5.2c',
    tier: 'flagship',
    contextWindow: 400_000,
    maxOutput: 128_000,
    pricePer1M: { input: 1.75, output: 14.00 },
    costPer1K: { input: 0.00175, output: 0.014 },
    tokPerSec: 339,
    ttft: null,
    reasoning: { type: 'effort', levels: ['low', 'medium', 'high', 'xhigh'], default: 'medium' },
    benchmarks: { terminalBench: 77.3, sweBenchPro: 56.8 },
    qualityScore: 88,
    valueScore: 65,
    speedScore: 100,
    strengths: ['speed', 'terminal-ops', 'implementation', 'sandboxed'],
    bestFor: ['implementation', 'refactor', 'testing'],
    // Uses GPT-5.2 limits (same API family)
    rateLimits: {
      1: { rpm: 500, tpm: 500_000 },
      2: { rpm: 5_000, tpm: 1_000_000 },
      3: { rpm: 5_000, tpm: 2_000_000 },
      4: { rpm: 10_000, tpm: 4_000_000 },
      5: { rpm: 15_000, tpm: 40_000_000 },
    },
  },
  'gpt-5.2': {
    id: 'gpt-5.2',
    provider: 'openai',
    agent: 'codex',
    displayName: 'GPT-5.2',
    shortName: 'gpt-5.2',
    tier: 'flagship',
    contextWindow: 400_000,
    maxOutput: 128_000,
    pricePer1M: { input: 1.75, output: 14.00 },
    costPer1K: { input: 0.00175, output: 0.014 },
    tokPerSec: 50,
    ttft: null,
    reasoning: { type: 'effort', levels: ['none', 'low', 'medium', 'high', 'xhigh'], default: 'medium' },
    benchmarks: { sweBench: 80.0, gpqaDiamond: 93.2, aime2025: 100, arcAgi2: 54.2 },
    qualityScore: 90,
    valueScore: 55,
    speedScore: 20,
    strengths: ['deep-reasoning', 'science', 'math', 'long-context'],
    bestFor: ['analysis', 'research', 'security'],
    rateLimits: {
      1: { rpm: 500, tpm: 500_000 },
      2: { rpm: 5_000, tpm: 1_000_000 },
      3: { rpm: 5_000, tpm: 2_000_000 },
      4: { rpm: 10_000, tpm: 4_000_000 },
      5: { rpm: 15_000, tpm: 40_000_000 },
    },
  },
  'gpt-5.6-terra': {
    id: 'gpt-5.6-terra',
    provider: 'openai',
    agent: 'codex',
    displayName: 'GPT-5.6 Terra',
    shortName: 'terra',
    tier: 'mid',
    contextWindow: 400_000,
    maxOutput: 128_000,
    pricePer1M: { input: 1.25, output: 10.00 },
    costPer1K: { input: 0.00125, output: 0.010 },
    tokPerSec: 50,
    ttft: 0.20,
    reasoning: { type: 'effort', levels: ['minimal', 'low', 'medium', 'high'], default: 'medium' },
    benchmarks: {},
    qualityScore: 75,
    valueScore: 70,
    speedScore: 20,
    strengths: ['chatgpt-plus', 'codex-cli'],
    bestFor: ['implementation', 'chat'],
    rateLimits: {
      1: { rpm: 500, tpm: 500_000 },
      2: { rpm: 5_000, tpm: 1_000_000 },
      3: { rpm: 5_000, tpm: 2_000_000 },
      4: { rpm: 10_000, tpm: 4_000_000 },
      5: { rpm: 15_000, tpm: 40_000_000 },
    },
  },
  'gpt-5': {
    id: 'gpt-5',
    provider: 'openai',
    agent: 'codex',
    displayName: 'GPT-5',
    shortName: 'gpt-5',
    tier: 'mid',
    contextWindow: 400_000,
    maxOutput: 128_000,
    pricePer1M: { input: 1.25, output: 10.00 },
    costPer1K: { input: 0.00125, output: 0.010 },
    tokPerSec: 50,
    ttft: 0.20,
    reasoning: { type: 'effort', levels: ['minimal', 'low', 'medium', 'high'], default: 'medium' },
    benchmarks: { sweBench: 74.9, gpqaDiamond: 88.4, aime2025: 94.6, aiderPolyglot: 88 },
    qualityScore: 75,
    valueScore: 70,
    speedScore: 20,
    strengths: ['streaming', 'broad-knowledge', 'unified-reasoning'],
    bestFor: ['implementation', 'documentation'],
    rateLimits: {
      1: { rpm: 500, tpm: 500_000 },
      2: { rpm: 5_000, tpm: 1_000_000 },
      3: { rpm: 5_000, tpm: 2_000_000 },
      4: { rpm: 10_000, tpm: 4_000_000 },
      5: { rpm: 15_000, tpm: 40_000_000 },
    },
  },
  'o4-mini': {
    id: 'o4-mini',
    provider: 'openai',
    agent: 'codex',
    displayName: 'o4-mini',
    shortName: 'o4-mini',
    tier: 'economy',
    contextWindow: 200_000,
    maxOutput: 100_000,
    pricePer1M: { input: 1.10, output: 4.40 },
    costPer1K: { input: 0.0011, output: 0.0044 },
    tokPerSec: null,
    ttft: null,
    reasoning: { type: 'effort', levels: ['low', 'medium', 'high'], default: 'medium' },
    benchmarks: { sweBench: 68.1, aime2025: 99.5, gpqaDiamond: 81.4 },
    qualityScore: 60,
    valueScore: 80,
    speedScore: 50,
    strengths: ['math', 'budget-reasoning', 'throughput'],
    bestFor: ['implementation', 'testing'],
    rateLimits: {
      1: { rpm: 1_000, tpm: 100_000 },
      2: { rpm: 2_000, tpm: 200_000 },
      3: { rpm: 5_000, tpm: 4_000_000 },
      4: { rpm: 10_000, tpm: 10_000_000 },
      5: { rpm: 30_000, tpm: 150_000_000 },
    },
  },
  'gpt-4.1-mini': {
    id: 'gpt-4.1-mini',
    provider: 'openai',
    agent: 'codex',
    displayName: 'GPT-4.1 Mini',
    shortName: 'gpt-4.1m',
    tier: 'economy',
    contextWindow: 1_000_000,
    maxOutput: 32_768,
    pricePer1M: { input: 0.40, output: 1.60 },
    costPer1K: { input: 0.0004, output: 0.0016 },
    tokPerSec: null,
    ttft: null,
    reasoning: { type: 'none' },
    benchmarks: {},
    qualityScore: 45,
    valueScore: 90,
    speedScore: 60,
    strengths: ['cost', 'long-context', 'speed'],
    bestFor: ['documentation'],
    rateLimits: {
      1: { rpm: 500, tpm: 200_000, rpd: 10_000 },
      2: { rpm: 5_000, tpm: 2_000_000 },
      3: { rpm: 5_000, tpm: 4_000_000 },
      4: { rpm: 10_000, tpm: 10_000_000 },
      5: { rpm: 30_000, tpm: 150_000_000 },
    },
  },

  'gemini-3-pro-preview': {
    id: 'gemini-3-pro-preview',
    provider: 'google',
    agent: 'gemini',
    displayName: 'Gemini 3 Pro',
    shortName: 'pro',
    tier: 'flagship',
    contextWindow: 1_000_000,
    maxOutput: 65_000,
    pricePer1M: { input: 2.00, output: 12.00 },
    costPer1K: { input: 0.002, output: 0.012 },
    tokPerSec: 130,
    ttft: null,
    reasoning: { type: 'model-swap', variants: { standard: 'gemini-3-pro-preview', deep: 'gemini-3-pro-deep-think' }, default: 'standard' },
    benchmarks: { sweBench: 76.2, gpqaDiamond: 91.9, aime2025: 95, liveCodeBench: 91.7, aiderPolyglot: 82.2, terminalBench: 54.2 },
    qualityScore: 85,
    valueScore: 60,
    speedScore: 55,
    strengths: ['algorithmic-coding', 'analysis', 'long-context', 'multimodal'],
    bestFor: ['analysis', 'review', 'research'],
    rateLimits: {
      free: { rpm: 10, tpm: 250_000, rpd: 100 },
      1: { rpm: 150, tpm: 1_000_000, rpd: 1_000 },
      2: { rpm: 1_000, tpm: 2_000_000, rpd: 10_000 },
    },
  },
  'gemini-3-flash-preview': {
    id: 'gemini-3-flash-preview',
    provider: 'google',
    agent: 'gemini',
    displayName: 'Gemini 3 Flash',
    shortName: 'flash',
    tier: 'economy',
    contextWindow: 1_000_000,
    maxOutput: 65_000,
    pricePer1M: { input: 0.50, output: 3.00 },
    costPer1K: { input: 0.0005, output: 0.003 },
    tokPerSec: 218,
    ttft: null,
    reasoning: { type: 'none' },
    benchmarks: { sweBench: 78.0, gpqaDiamond: 90.4, aiderPolyglot: 95.2 },
    qualityScore: 72,
    valueScore: 95,
    speedScore: 85,
    strengths: ['value', 'speed', 'code-editing', 'long-context'],
    bestFor: ['implementation', 'review', 'testing'],
    rateLimits: {
      free: { rpm: 10, tpm: 250_000, rpd: 250 },
      1: { rpm: 300, tpm: 2_000_000, rpd: 1_500 },
      2: { rpm: 2_000, tpm: 4_000_000, rpd: 10_000 },
    },
  },
  'gemini-2.5-pro': {
    id: 'gemini-2.5-pro',
    provider: 'google',
    agent: 'gemini',
    displayName: 'Gemini 2.5 Pro',
    shortName: '2.5-pro',
    tier: 'mid',
    contextWindow: 1_000_000,
    maxOutput: 65_000,
    pricePer1M: { input: 1.25, output: 10.00 },
    costPer1K: { input: 0.00125, output: 0.010 },
    tokPerSec: 150,
    ttft: null,
    reasoning: { type: 'none' },
    benchmarks: { sweBench: 63.8, gpqaDiamond: 84.0 },
    qualityScore: 65,
    valueScore: 65,
    speedScore: 65,
    strengths: ['stability', 'long-context'],
    bestFor: ['analysis', 'review'],
    rateLimits: {
      free: { rpm: 5, tpm: 250_000, rpd: 100 },
      1: { rpm: 150, tpm: 1_000_000, rpd: 1_000 },
      2: { rpm: 1_000, tpm: 2_000_000, rpd: 10_000 },
    },
  },
  'gemini-2.5-flash': {
    id: 'gemini-2.5-flash',
    provider: 'google',
    agent: 'gemini',
    displayName: 'Gemini 2.5 Flash',
    shortName: '2.5-flash',
    tier: 'economy',
    contextWindow: 1_000_000,
    maxOutput: 65_000,
    pricePer1M: { input: 0.30, output: 2.50 },
    costPer1K: { input: 0.0003, output: 0.0025 },
    tokPerSec: 237,
    ttft: 0.30,
    reasoning: { type: 'none' },
    benchmarks: {},
    qualityScore: 50,
    valueScore: 90,
    speedScore: 90,
    strengths: ['speed', 'cost', 'stability'],
    bestFor: ['implementation'],
    rateLimits: {
      free: { rpm: 10, tpm: 250_000, rpd: 250 },
      1: { rpm: 300, tpm: 2_000_000, rpd: 1_500 },
      2: { rpm: 2_000, tpm: 4_000_000, rpd: 10_000 },
    },
  },

  'gpt-5.3-codex': {
    id: 'gpt-5.3-codex',
    provider: 'openai',
    agent: 'codex',
    displayName: 'GPT-5.3 Codex',
    shortName: 'gpt-5.3c',
    tier: 'flagship',
    contextWindow: 400_000,
    maxOutput: 128_000,
    pricePer1M: { input: 1.75, output: 14.00 },
    costPer1K: { input: 0.00175, output: 0.014 },
    tokPerSec: 424,
    ttft: null,
    reasoning: { type: 'effort', levels: ['low', 'medium', 'high', 'xhigh'], default: 'medium' },
    benchmarks: { terminalBench: 77.3, sweBenchPro: 56.8 },
    qualityScore: 92,
    valueScore: 68,
    speedScore: 100,
    strengths: ['speed', 'terminal-ops', 'implementation', 'sandboxed', 'code-generation'],
    bestFor: ['implementation', 'refactor', 'testing'],
    rateLimits: {
      1: { rpm: 500, tpm: 500_000 },
      2: { rpm: 5_000, tpm: 1_000_000 },
      3: { rpm: 5_000, tpm: 2_000_000 },
      4: { rpm: 10_000, tpm: 4_000_000 },
      5: { rpm: 15_000, tpm: 40_000_000 },
    },
  },
  'gpt-5.4': {
    id: 'gpt-5.4',
    provider: 'openai',
    agent: 'codex',
    displayName: 'GPT-5.4',
    shortName: 'gpt-5.4',
    tier: 'flagship',
    contextWindow: 1_050_000,
    maxOutput: 128_000,
    pricePer1M: { input: 2.50, output: 15.00 },
    costPer1K: { input: 0.0025, output: 0.015 },
    tokPerSec: 78,
    ttft: null,
    reasoning: { type: 'effort', levels: ['none', 'low', 'medium', 'high', 'xhigh'], default: 'none' },
    benchmarks: { sweBenchPro: 57.7, gpqaDiamond: 84.2, aime2025: 100 },
    qualityScore: 93,
    valueScore: 62,
    speedScore: 45,
    strengths: ['reasoning', 'long-context', 'implementation', 'computer-use', 'code-generation'],
    bestFor: ['implementation', 'refactor', 'analysis'],
    rateLimits: {
      1: { rpm: 500, tpm: 500_000 },
      2: { rpm: 5_000, tpm: 1_000_000 },
      3: { rpm: 5_000, tpm: 2_000_000 },
      4: { rpm: 10_000, tpm: 4_000_000 },
      5: { rpm: 15_000, tpm: 40_000_000 },
    },
  },

  'gemini-3.1-pro-preview': {
    id: 'gemini-3.1-pro-preview',
    provider: 'google',
    agent: 'gemini',
    displayName: 'Gemini 3.1 Pro',
    shortName: '3.1-pro',
    tier: 'flagship',
    contextWindow: 1_000_000,
    maxOutput: 65_000,
    pricePer1M: { input: 2.00, output: 12.00 },
    costPer1K: { input: 0.002, output: 0.012 },
    tokPerSec: 140,
    ttft: null,
    reasoning: { type: 'model-swap', variants: { standard: 'gemini-3.1-pro-preview', deep: 'gemini-3.1-pro-deep-think' }, default: 'standard' },
    benchmarks: { sweBench: 76.2, gpqaDiamond: 91.9, aime2025: 95, liveCodeBench: 91.7, aiderPolyglot: 82.2, terminalBench: 54.2 },
    qualityScore: 88,
    valueScore: 62,
    speedScore: 58,
    strengths: ['reasoning', 'algorithmic-coding', 'analysis', 'long-context', 'multimodal'],
    bestFor: ['analysis', 'review', 'research'],
    rateLimits: {
      free: { rpm: 10, tpm: 250_000, rpd: 100 },
      1: { rpm: 150, tpm: 1_000_000, rpd: 1_000 },
      2: { rpm: 1_000, tpm: 2_000_000, rpd: 10_000 },
    },
  },

  // Additional aliases that map to the same cost structure
  'codex-5.3': {
    id: 'codex-5.3',
    provider: 'openai',
    agent: 'codex',
    displayName: 'Codex 5.3 (alias)',
    shortName: 'gpt-5.3c',
    tier: 'flagship',
    contextWindow: 400_000,
    maxOutput: 128_000,
    pricePer1M: { input: 1.75, output: 14.00 },
    costPer1K: { input: 0.00175, output: 0.014 },
    tokPerSec: 424,
    ttft: null,
    reasoning: { type: 'effort', levels: ['low', 'medium', 'high', 'xhigh'], default: 'medium' },
    benchmarks: { terminalBench: 77.3, sweBenchPro: 56.8 },
    qualityScore: 92,
    valueScore: 68,
    speedScore: 100,
    strengths: ['speed', 'terminal-ops', 'implementation'],
    bestFor: ['implementation', 'refactor', 'testing'],
    rateLimits: {
      1: { rpm: 500, tpm: 500_000 },
      2: { rpm: 5_000, tpm: 1_000_000 },
      3: { rpm: 5_000, tpm: 2_000_000 },
      4: { rpm: 10_000, tpm: 4_000_000 },
      5: { rpm: 15_000, tpm: 40_000_000 },
    },
  },
  'codex-5.2': {
    id: 'codex-5.2',
    provider: 'openai',
    agent: 'codex',
    displayName: 'Codex 5.2 (alias)',
    shortName: 'gpt-5.2c',
    tier: 'flagship',
    contextWindow: 400_000,
    maxOutput: 128_000,
    pricePer1M: { input: 1.75, output: 14.00 },
    costPer1K: { input: 0.00175, output: 0.014 },
    tokPerSec: 339,
    ttft: null,
    reasoning: { type: 'effort', levels: ['low', 'medium', 'high', 'xhigh'], default: 'medium' },
    benchmarks: { terminalBench: 77.3, sweBenchPro: 56.8 },
    qualityScore: 88,
    valueScore: 65,
    speedScore: 100,
    strengths: ['speed', 'terminal-ops', 'implementation'],
    bestFor: ['implementation', 'refactor', 'testing'],
    rateLimits: {
      1: { rpm: 500, tpm: 500_000 },
      2: { rpm: 5_000, tpm: 1_000_000 },
      3: { rpm: 5_000, tpm: 2_000_000 },
      4: { rpm: 10_000, tpm: 4_000_000 },
      5: { rpm: 15_000, tpm: 40_000_000 },
    },
  },
};

// ── ROLE_DEFAULTS ───────────────────────────────────────────────────────────
// Per-role recommended assignments with benchmark-backed rationale.

export const ROLE_DEFAULTS = {
  architect: {
    agent: 'claude',
    model: null,    // uses agent default (claude-sonnet-4-6)
    reasoningEffort: null,
    models: ['claude-sonnet-4-6', 'claude-opus-4-6', 'gpt-5.6-terra'],
    note: 'Strong coding + agentic at 40% lower cost than Opus; Opus available for highest-complexity tasks',
  },
  analyst: {
    agent: 'gemini',
    model: null,    // uses agent default (gemini-3.1-pro-preview)
    reasoningEffort: null,
    models: ['gemini-3.1-pro-preview', 'claude-opus-4-6'],
    note: 'Latest SOTA reasoning model, GPQA 91.9%, 1M native context',
  },
  implementer: {
    agent: 'codex',
    model: null,    // uses agent default (gpt-5.6-terra)
    reasoningEffort: null,
    models: ['gpt-5.6-terra', 'gpt-5.3-codex', 'claude-sonnet-4-5-20250929'],
    note: 'ChatGPT Plus / Codex — gpt-5.6-terra (gpt-5.4 účet nebere)',
  },
  concierge: {
    agent: 'codex',
    model: 'gpt-5.6-terra',
    reasoningEffort: null,
    models: ['gpt-5.6-terra', 'claude-sonnet-4-5-20250929'],
    note: 'ChatGPT Plus / Codex — stejný účet jako zápis, ne Gemini',
  },
  investigator: {
    agent: 'codex',
    model: 'gpt-5.2',
    reasoningEffort: null,
    models: ['gpt-5.2', 'gpt-5'],
    note: 'Best deep reasoning (GPQA 93.2%, FrontierMath 40.3%)',
  },
  nightlyHandoff: {
    agent: 'codex',
    model: 'gpt-5.6-terra',
    reasoningEffort: 'low',
    models: ['gpt-5.6-terra', 'gpt-5.2-codex'],
    note: 'ChatGPT Codex účet — o4-mini/gpt-5/gpt-5.4 CLI nebere',
  },
};

// ── AGENT_PRESETS ───────────────────────────────────────────────────────────
// Per-agent default/fast/cheap model mappings.

export const AGENT_PRESETS = {
  claude: { default: 'claude-sonnet-4-6', fast: 'claude-sonnet-4-5-20250929', cheap: 'claude-haiku-4-5-20251001' },
  opus:   { default: 'claude-opus-4-6', fast: 'claude-opus-4-6', cheap: 'claude-sonnet-4-6' },
  codex:  { default: 'gpt-5.6-terra', fast: 'gpt-5.6-terra', cheap: 'gpt-5.6-terra' },
  gemini: { default: 'gemini-3.6-flash', fast: 'gemini-3.6-flash', cheap: 'gemini-3.6-flash' },
};

// ── Query Functions ─────────────────────────────────────────────────────────

/**
 * Get a single model profile by exact ID.
 * @param {string} modelId
 * @returns {object|null}
 */
export function getProfile(modelId) {
  if (!modelId) return null;
  return MODEL_PROFILES[modelId] || null;
}

/**
 * Get all profiles for a specific agent.
 * @param {string} agent - 'claude', 'codex', or 'gemini'
 * @returns {object[]}
 */
export function getProfilesForAgent(agent) {
  if (!agent) return [];
  return Object.values(MODEL_PROFILES).filter((p) => p.agent === agent);
}

/**
 * Get agent presets (default/fast/cheap model IDs).
 * @param {string} agent
 * @returns {{ default: string, fast: string, cheap: string }|null}
 */
export function getAgentPresets(agent) {
  return AGENT_PRESETS[agent] || null;
}

/**
 * Get role recommendation data.
 * @param {string} role
 * @returns {{ agent: string, model: string|null, reasoningEffort: string|null, models: string[], note: string }|null}
 */
export function getRoleRecommendation(role) {
  return ROLE_DEFAULTS[role] || null;
}

/**
 * Get fallback candidates for an agent, sorted by qualityScore descending.
 * Excludes the specified model ID.
 * @param {string} agent
 * @param {string} excludeId - Model ID to exclude (the failed one)
 * @returns {Array<{ id: string, qualityScore: number, displayName: string }>}
 */
export function getFallbackOrder(agent, excludeId) {
  const profiles = getProfilesForAgent(agent);
  const exclude = (excludeId || '').toLowerCase();
  return profiles
    .filter((p) => p.id.toLowerCase() !== exclude)
    .sort((a, b) => b.qualityScore - a.qualityScore)
    .map((p) => ({ id: p.id, qualityScore: p.qualityScore, displayName: p.displayName }));
}

/**
 * Format a compact benchmark annotation for display.
 * @param {string} modelId
 * @param {object} [opts]
 * @param {boolean} [opts.includePrice=true]
 * @param {boolean} [opts.includeSpeed=true]
 * @param {boolean} [opts.includeSwe=true]
 * @returns {string} e.g. "SWE 80.8% | 66 tok/s | $5/$25"
 */
export function formatBenchmarkAnnotation(modelId, opts = {}) {
  const profile = getProfile(modelId);
  if (!profile) return '';

  const parts = [];
  const { includePrice = true, includeSpeed = true, includeSwe = true } = opts;

  if (includeSwe && profile.benchmarks.sweBench) {
    parts.push(`SWE ${profile.benchmarks.sweBench}%`);
  }

  if (includeSpeed && profile.tokPerSec) {
    parts.push(`${profile.tokPerSec} tok/s`);
  }

  if (includePrice) {
    const inp = profile.pricePer1M.input;
    const out = profile.pricePer1M.output;
    const fmt = (v) => v >= 1 ? `$${v}` : `$${v.toFixed(2)}`;
    parts.push(`${fmt(inp)}/${fmt(out)}`);
  }

  return parts.join(' | ');
}

/**
 * Get all role defaults as an object.
 * Returns { roles, recommendations } suitable for DEFAULT_CONFIG.
 * @returns {{ roles: object, recommendations: object }}
 */
export function getDefaultRoles() {
  const roles = {};
  const recommendations = {};

  for (const [role, rd] of Object.entries(ROLE_DEFAULTS)) {
    roles[role] = {
      agent: rd.agent,
      model: rd.model,
      reasoningEffort: rd.reasoningEffort,
    };
    recommendations[role] = {
      models: rd.models,
      reasoningEffort: rd.reasoningEffort,
      note: rd.note,
    };
  }

  return { roles, recommendations };
}

/**
 * Get cost table in COST_PER_1K format (model ID → { input, output }).
 * Compatible with hydra-provider-usage.mjs.
 * @returns {Object<string, { input: number, output: number }>}
 */
export function getCostTable() {
  const table = {};
  for (const profile of Object.values(MODEL_PROFILES)) {
    table[profile.id] = { ...profile.costPer1K };
  }
  return table;
}

/**
 * Get reasoning capabilities map in MODEL_REASONING_CAPS format.
 * Uses longest-prefix matching keys, same shape as hydra-agents.mjs.
 * @returns {Object<string, { type: string, levels?: string[], budgets?: object, variants?: object, default?: string }>}
 */
export function getReasoningCapsMap() {
  // Build prefix-based map from profiles, same key style as the old hardcoded map.
  // Deduplicate by prefix — use the primary model for each prefix.
  const map = {};

  // OpenAI o-series
  map['o1'] = { type: 'effort', levels: ['low', 'medium', 'high'], default: 'medium' };
  map['o3'] = { type: 'effort', levels: ['low', 'medium', 'high'], default: 'medium' };

  // Derive from profiles
  const o4 = MODEL_PROFILES['o4-mini'];
  if (o4) map['o4-mini'] = { type: o4.reasoning.type, levels: o4.reasoning.levels, default: o4.reasoning.default };

  const gpt5 = MODEL_PROFILES['gpt-5'];
  if (gpt5) map['gpt-5'] = { type: 'none' };

  const opus = MODEL_PROFILES['claude-opus-4-6'];
  if (opus) map['claude-opus'] = { ...opus.reasoning };

  const sonnet46 = MODEL_PROFILES['claude-sonnet-4-6'];
  if (sonnet46) map['claude-sonnet-4-6'] = { ...sonnet46.reasoning };

  const sonnet = MODEL_PROFILES['claude-sonnet-4-5-20250929'];
  if (sonnet) map['claude-sonnet'] = { ...sonnet.reasoning };

  map['claude-haiku'] = { type: 'none' };

  const gem31pro = MODEL_PROFILES['gemini-3.1-pro-preview'];
  if (gem31pro) map['gemini-3.1-pro'] = { ...gem31pro.reasoning };

  const gem3pro = MODEL_PROFILES['gemini-3-pro-preview'];
  if (gem3pro) map['gemini-3-pro'] = { ...gem3pro.reasoning };

  map['gemini-3-flash'] = { type: 'none' };
  map['gemini-2.5'] = { type: 'none' };

  return map;
}

/**
 * Get short display name for a model ID.
 * @param {string} modelId
 * @returns {string|null} Short name or null if not in profiles
 */
export function getShortName(modelId) {
  const profile = getProfile(modelId);
  return profile ? profile.shortName : null;
}

/**
 * Get the concierge fallback chain derived from ROLE_DEFAULTS.
 * @returns {Array<{ provider: string, model: string }>}
 */
export function getConciergeFallbackChain() {
  const concierge = ROLE_DEFAULTS.concierge;
  if (!concierge) return [];

  // Primary: concierge model
  const chain = [];
  const primaryProfile = getProfile(concierge.model);
  if (primaryProfile) {
    chain.push({ provider: primaryProfile.provider, model: primaryProfile.id });
  }

  // Fallback: recommended models (skip primary)
  for (const modelId of concierge.models) {
    if (modelId === concierge.model) continue;
    const p = getProfile(modelId);
    if (p) chain.push({ provider: p.provider, model: p.id });
  }

  // Final fallback: cheapest flash model
  const flash = getProfile('gemini-3-flash-preview');
  if (flash && !chain.some((c) => c.model === flash.id)) {
    chain.push({ provider: flash.provider, model: flash.id });
  }

  return chain;
}

/**
 * Get rate limits for a model at a specific provider tier.
 * @param {string} modelId
 * @param {string|number} tier - Provider tier (e.g. 1, 2, 3, 'free')
 * @returns {{ rpm: number, tpm?: number, itpm?: number, otpm?: number, rpd?: number }|null}
 */
export function getRateLimits(modelId, tier) {
  const profile = getProfile(modelId);
  if (!profile?.rateLimits) return null;
  // Try exact match, then fall back to lowest available tier
  const limits = profile.rateLimits[tier] || profile.rateLimits[String(tier)];
  if (limits) return limits;
  // Fallback: return lowest tier limits (most conservative)
  const keys = Object.keys(profile.rateLimits);
  return keys.length > 0 ? profile.rateLimits[keys[0]] : null;
}

/**
 * Get smart mode tier mappings derived from agent presets.
 * @returns {{ performance: object, balanced: object, economy: object }}
 */
export function getModeTiers() {
  return {
    performance: { gemini: 'default', codex: 'default', claude: 'default' },
    balanced:    { gemini: 'fast',    codex: 'fast',    claude: 'fast' },
    economy:     { gemini: 'cheap',   codex: 'cheap',   claude: 'cheap' },
    custom:      { gemini: 'default', codex: 'default', claude: 'default' },
  };
}
