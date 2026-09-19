#!/usr/bin/env node
/**
 * Hydra Metrics Collection
 *
 * In-memory metrics store with file persistence. Tracks per-agent call counts,
 * durations, estimated tokens, and success rates.
 *
 * Usage:
 *   import { recordCallStart, recordCallComplete, getMetrics } from './hydra-metrics.mjs';
 *   const handle = recordCallStart('claude', 'claude-opus-4-6');
 *   // ... agent call ...
 *   recordCallComplete(handle, result);
 */

import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';

// ── Metrics Event Emitter ───────────────────────────────────────────────────

export const metricsEmitter = new EventEmitter();

const MAX_HISTORY = 20;
const TOKENS_PER_CHAR_ESTIMATE = 0.25; // rough estimate: 4 chars ≈ 1 token

// ── Percentile Calculation ──────────────────────────────────────────────────

function calculatePercentiles(values, percentiles = [50, 95, 99]) {
  if (values.length === 0) return {};
  const sorted = [...values].sort((a, b) => a - b);
  const result = {};
  for (const p of percentiles) {
    const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
    result[`p${p}`] = sorted[idx];
  }
  return result;
}

// ── Metrics Store ───────────────────────────────────────────────────────────

let metricsStore = createEmptyStore();

function createEmptySessionUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    callCount: 0,
  };
}

function createEmptyStore() {
  return {
    startedAt: new Date().toISOString(),
    agents: {},
    sessionUsage: createEmptySessionUsage(),
  };
}

function ensureAgent(agentName) {
  if (!metricsStore.agents[agentName]) {
    metricsStore.agents[agentName] = {
      callsTotal: 0,
      callsToday: 0,
      callsSuccess: 0,
      callsFailed: 0,
      estimatedTokensToday: 0,
      totalDurationMs: 0,
      avgDurationMs: 0,
      lastCallAt: null,
      lastModel: null,
      history: [],
      sessionTokens: createEmptySessionUsage(),
    };
  }
  // Backfill sessionTokens for stores loaded from disk before this field existed
  if (!metricsStore.agents[agentName].sessionTokens) {
    metricsStore.agents[agentName].sessionTokens = createEmptySessionUsage();
  }
  return metricsStore.agents[agentName];
}

// ── Recording ───────────────────────────────────────────────────────────────

let handleCounter = 0;
const activeHandles = new Map();

/**
 * Record the start of an agent call.
 * @param {string} agentName - gemini, codex, or claude
 * @param {string} [model] - Model ID being used
 * @returns {string} Handle ID for recordCallComplete/Error
 */
export function recordCallStart(agentName, model) {
  handleCounter += 1;
  const handle = `call_${handleCounter}_${Date.now()}`;
  activeHandles.set(handle, {
    agent: agentName,
    model: model || 'unknown',
    startedAt: Date.now(),
    startIso: new Date().toISOString(),
  });
  metricsEmitter.emit('call:start', { agent: agentName, model: model || 'unknown' });
  return handle;
}

/**
 * Record successful completion of an agent call.
 * @param {string} handle - Handle from recordCallStart
 * @param {object} result - Process result with stdout/stderr
 */
export function recordCallComplete(handle, result) {
  const meta = activeHandles.get(handle);
  if (!meta) return;
  activeHandles.delete(handle);

  const durationMs = Date.now() - meta.startedAt;
  const agent = ensureAgent(meta.agent);
  // Accept both field names: shared agent-executor returns 'output', workers return 'stdout'
  const stdout = result?.stdout || result?.output || '';
  const stderr = result?.stderr || '';
  const outputLen = stdout.length + stderr.length;
  const estimatedTokens = Math.round(outputLen * TOKENS_PER_CHAR_ESTIMATE);

  // Try to extract real token usage from agent output
  let realTokens = null;
  let costUsd = 0;

  // Accept pre-parsed tokenUsage from callers (e.g. worker with codex --json)
  if (result?.tokenUsage) {
    realTokens = {
      inputTokens: result.tokenUsage.inputTokens || 0,
      outputTokens: result.tokenUsage.outputTokens || 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    };
    realTokens.totalTokens = realTokens.inputTokens + realTokens.outputTokens;
  }

  // Claude: parse JSON output for usage data
  if (!realTokens && meta.agent === 'claude') {
    try {
      const parsed = JSON.parse(stdout);
      if (parsed?.type === 'result' && parsed?.usage) {
        const u = parsed.usage;
        realTokens = {
          inputTokens: u.input_tokens || 0,
          outputTokens: u.output_tokens || 0,
          cacheCreationTokens: u.cache_creation_input_tokens || 0,
          cacheReadTokens: u.cache_read_input_tokens || 0,
        };
        realTokens.totalTokens = realTokens.inputTokens + realTokens.outputTokens;
        costUsd = parsed.cost_usd || 0;
      }
    } catch {
      // Not JSON or not a Claude result object — fall through to estimate path
    }
  }

  // Codex: parse JSONL stdout for usage data
  if (!realTokens && meta.agent === 'codex') {
    try {
      const lines = stdout.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed[0] !== '{') continue;
        try {
          const obj = JSON.parse(trimmed);
          const u = obj.usage || obj.token_usage;
          if (u) {
            if (!realTokens) realTokens = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0 };
            realTokens.inputTokens += u.input_tokens || u.prompt_tokens || 0;
            realTokens.outputTokens += u.output_tokens || u.completion_tokens || 0;
          }
        } catch { /* skip non-JSON line */ }
      }
      if (realTokens) {
        realTokens.totalTokens = realTokens.inputTokens + realTokens.outputTokens;
      }
    } catch { /* fall through to estimate */ }
  }

  agent.callsTotal += 1;
  agent.callsToday += 1;
  agent.callsSuccess += 1;
  agent.estimatedTokensToday += estimatedTokens;
  agent.totalDurationMs += durationMs;
  agent.avgDurationMs = Math.round(agent.totalDurationMs / agent.callsTotal);
  agent.lastCallAt = new Date().toISOString();
  agent.lastModel = meta.model;

  // Accumulate real token usage into session counters
  if (realTokens) {
    agent.sessionTokens.inputTokens += realTokens.inputTokens;
    agent.sessionTokens.outputTokens += realTokens.outputTokens;
    agent.sessionTokens.cacheCreationTokens += realTokens.cacheCreationTokens;
    agent.sessionTokens.cacheReadTokens += realTokens.cacheReadTokens;
    agent.sessionTokens.totalTokens += realTokens.totalTokens;
    agent.sessionTokens.costUsd += costUsd;
    agent.sessionTokens.callCount += 1;

    metricsStore.sessionUsage.inputTokens += realTokens.inputTokens;
    metricsStore.sessionUsage.outputTokens += realTokens.outputTokens;
    metricsStore.sessionUsage.cacheCreationTokens += realTokens.cacheCreationTokens;
    metricsStore.sessionUsage.cacheReadTokens += realTokens.cacheReadTokens;
    metricsStore.sessionUsage.totalTokens += realTokens.totalTokens;
    metricsStore.sessionUsage.costUsd += costUsd;
    metricsStore.sessionUsage.callCount += 1;
  }

  agent.history.push({
    at: meta.startIso,
    model: meta.model,
    durationMs,
    estimatedTokens,
    realTokens: realTokens ? { ...realTokens } : null,
    costUsd: costUsd || null,
    ok: true,
    outputLen,
    outcome: result?.outcome || 'success',
  });
  if (agent.history.length > MAX_HISTORY) {
    agent.history = agent.history.slice(-MAX_HISTORY);
  }
  metricsEmitter.emit('call:complete', { agent: meta.agent, ok: true });
}

/**
 * Record a failed agent call.
 * @param {string} handle - Handle from recordCallStart
 * @param {Error|string} error - Error info
 */
export function recordCallError(handle, error) {
  const meta = activeHandles.get(handle);
  if (!meta) return;
  activeHandles.delete(handle);

  const durationMs = Date.now() - meta.startedAt;
  const agent = ensureAgent(meta.agent);

  agent.callsTotal += 1;
  agent.callsToday += 1;
  agent.callsFailed += 1;
  agent.totalDurationMs += durationMs;
  agent.avgDurationMs = Math.round(agent.totalDurationMs / agent.callsTotal);
  agent.lastCallAt = new Date().toISOString();
  agent.lastModel = meta.model;

  agent.history.push({
    at: meta.startIso,
    model: meta.model,
    durationMs,
    estimatedTokens: 0,
    ok: false,
    error: String(error?.message || error || 'unknown'),
    outcome: 'failed',
  });
  if (agent.history.length > MAX_HISTORY) {
    agent.history = agent.history.slice(-MAX_HISTORY);
  }
  metricsEmitter.emit('call:error', { agent: meta.agent, error: String(error?.message || error || 'unknown') });
}

// ── Querying ────────────────────────────────────────────────────────────────

/**
 * Get the full metrics store.
 */
export function getMetrics() {
  return { ...metricsStore };
}

/**
 * Get metrics for a specific agent, including latency percentiles.
 */
export function getAgentMetrics(agentName) {
  const agent = metricsStore.agents[agentName];
  if (!agent) return null;

  const durations = agent.history.filter(h => h.ok).map(h => h.durationMs);
  const latency = {
    avg: agent.avgDurationMs,
    ...calculatePercentiles(durations),
  };

  return { ...agent, latency };
}

/**
 * Get a summary suitable for dashboard display.
 */
export function getMetricsSummary() {
  const agents = {};
  let totalCalls = 0;
  let totalTokens = 0;
  let totalDurationMs = 0;

  for (const [name, data] of Object.entries(metricsStore.agents)) {
    const durations = (data.history || []).filter(h => h.ok).map(h => h.durationMs);
    agents[name] = {
      callsToday: data.callsToday,
      callsSuccess: data.callsSuccess,
      callsFailed: data.callsFailed,
      estimatedTokensToday: data.estimatedTokensToday,
      avgDurationMs: data.avgDurationMs,
      latency: { avg: data.avgDurationMs, ...calculatePercentiles(durations) },
      lastModel: data.lastModel,
      lastCallAt: data.lastCallAt,
      successRate: data.callsTotal > 0
        ? Math.round((data.callsSuccess / data.callsTotal) * 100)
        : 100,
      sessionTokens: data.sessionTokens || createEmptySessionUsage(),
    };
    totalCalls += data.callsToday;
    totalTokens += data.estimatedTokensToday;
    totalDurationMs += data.totalDurationMs;
  }

  const uptimeSec = Math.floor((Date.now() - new Date(metricsStore.startedAt).getTime()) / 1000);

  return {
    startedAt: metricsStore.startedAt,
    uptimeSec,
    totalCalls,
    totalTokens,
    totalDurationMs,
    agents,
    sessionUsage: metricsStore.sessionUsage || createEmptySessionUsage(),
  };
}

/**
 * Get session-level real token usage (accumulated from Claude JSON output).
 */
export function getSessionUsage() {
  return metricsStore.sessionUsage || createEmptySessionUsage();
}

/**
 * Sum tokens consumed by an agent within a recent time window.
 * Uses realTokens.totalTokens when available, otherwise estimatedTokens.
 * @param {string} agentName - Agent name (or null for all agents)
 * @param {number} windowMs - Time window in milliseconds
 * @returns {{ real: number, estimated: number, total: number, entries: number }}
 */
export function getRecentTokens(agentName, windowMs) {
  const cutoff = Date.now() - windowMs;
  let real = 0;
  let estimated = 0;
  let entries = 0;

  const agentNames = agentName ? [agentName] : Object.keys(metricsStore.agents);
  for (const name of agentNames) {
    const agent = metricsStore.agents[name];
    if (!agent?.history) continue;
    for (const entry of agent.history) {
      if (!entry.ok) continue;
      const entryTime = new Date(entry.at).getTime();
      if (entryTime < cutoff) continue;
      entries++;
      if (entry.realTokens) {
        const total = typeof entry.realTokens === 'object'
          ? (entry.realTokens.totalTokens || 0)
          : (entry.realTokens || 0);
        real += total;
      } else {
        estimated += entry.estimatedTokens || 0;
      }
    }
  }

  return { real, estimated, total: real + estimated, entries };
}

/**
 * Aggregate cost by outcome for an agent (or all agents).
 * @param {string} [agentName] - Agent name, or null/undefined for all
 * @returns {Object<string, {count: number, totalCost: number}>}
 */
export function getCostByOutcome(agentName) {
  const result = {};
  const agentNames = agentName ? [agentName] : Object.keys(metricsStore.agents);

  for (const name of agentNames) {
    const agent = metricsStore.agents[name];
    if (!agent?.history) continue;
    for (const entry of agent.history) {
      const outcome = entry.outcome || (entry.ok ? 'success' : 'failed');
      if (!result[outcome]) result[outcome] = { count: 0, totalCost: 0 };
      result[outcome].count += 1;
      result[outcome].totalCost += entry.costUsd || 0;
    }
  }
  return result;
}

/**
 * Check per-agent SLOs against current metrics.
 * @param {object} sloConfig - e.g. { claude: { maxP95Ms: 180000, maxErrorRate: 0.10 }, ... }
 * @returns {Array<{agent: string, metric: string, value: number, threshold: number}>}
 */
export function checkSLOs(sloConfig) {
  if (!sloConfig) return [];
  const violations = [];

  for (const [agentName, thresholds] of Object.entries(sloConfig)) {
    const agent = metricsStore.agents[agentName];
    if (!agent) continue;

    // Latency SLO
    if (thresholds.maxP95Ms) {
      const durations = (agent.history || []).filter(h => h.ok).map(h => h.durationMs);
      const pcts = calculatePercentiles(durations);
      if (pcts.p95 && pcts.p95 > thresholds.maxP95Ms) {
        violations.push({
          agent: agentName,
          metric: 'p95_latency',
          value: pcts.p95,
          threshold: thresholds.maxP95Ms,
        });
      }
    }

    // Error rate SLO
    if (thresholds.maxErrorRate != null && agent.callsTotal > 0) {
      const errorRate = agent.callsFailed / agent.callsTotal;
      if (errorRate > thresholds.maxErrorRate) {
        violations.push({
          agent: agentName,
          metric: 'error_rate',
          value: Math.round(errorRate * 1000) / 1000,
          threshold: thresholds.maxErrorRate,
        });
      }
    }
  }

  return violations;
}

// ── ETA Estimation ──────────────────────────────────────────────────────────

// Realistic fallback durations (ms) per agent when no metrics history exists.
// Based on typical cold-start times for each agent CLI.
const DEFAULT_AGENT_DURATION_MS = { gemini: 90_000, codex: 180_000, claude: 120_000 };

/**
 * Estimate total duration (ms) for a sequence of agent calls.
 * Uses historical avgDurationMs when available, otherwise falls back to defaults.
 * @param {Array<{agent: string}>} flow - Ordered list of agent steps
 * @param {number} [rounds=1] - Number of rounds through the flow
 * @returns {number} Estimated total duration in ms
 */
export function estimateFlowDuration(flow, rounds = 1) {
  let total = 0;
  for (const step of flow) {
    const data = metricsStore.agents[step.agent];
    const avg = data?.avgDurationMs || 0;
    total += avg > 0 ? avg : (DEFAULT_AGENT_DURATION_MS[step.agent] || 120_000);
  }
  return total * rounds;
}

// ── Persistence ─────────────────────────────────────────────────────────────

const METRICS_FILENAME = 'hydra-metrics.json';

/**
 * Save metrics to a JSON file in the given directory.
 */
export function persistMetrics(coordDir) {
  if (!coordDir) return;
  try {
    if (!fs.existsSync(coordDir)) {
      fs.mkdirSync(coordDir, { recursive: true });
    }
    const filePath = path.join(coordDir, METRICS_FILENAME);
    fs.writeFileSync(filePath, JSON.stringify(metricsStore, null, 2) + '\n', 'utf8');
  } catch {
    // Non-critical — skip silently
  }
}

/**
 * Load previously persisted metrics.
 */
export function loadPersistedMetrics(coordDir) {
  if (!coordDir) return;
  try {
    const filePath = path.join(coordDir, METRICS_FILENAME);
    if (!fs.existsSync(filePath)) return;
    const raw = fs.readFileSync(filePath, 'utf8');
    const loaded = JSON.parse(raw);
    if (loaded && typeof loaded === 'object' && loaded.agents) {
      metricsStore = loaded;
      // Backfill sessionUsage if loaded from older format
      if (!metricsStore.sessionUsage) {
        metricsStore.sessionUsage = createEmptySessionUsage();
      }
      // Reset today counters if date changed
      const today = new Date().toISOString().slice(0, 10);
      const startDate = (metricsStore.startedAt || '').slice(0, 10);
      if (startDate !== today) {
        for (const agent of Object.values(metricsStore.agents)) {
          agent.callsToday = 0;
          agent.estimatedTokensToday = 0;
          agent.sessionTokens = createEmptySessionUsage();
        }
        metricsStore.sessionUsage = createEmptySessionUsage();
        metricsStore.startedAt = new Date().toISOString();
      }
    }
  } catch {
    // Non-critical — start fresh
  }
}

/**
 * Reset all metrics.
 */
export function resetMetrics() {
  metricsStore = createEmptyStore();
}
