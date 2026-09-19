import test from 'node:test';
import assert from 'node:assert/strict';
import {
  recordCallStart,
  recordCallComplete,
  recordCallError,
  getMetrics,
  getAgentMetrics,
  getMetricsSummary,
  getSessionUsage,
  getRecentTokens,
  estimateFlowDuration,
  resetMetrics,
  metricsEmitter,
} from '../lib/hydra-metrics.mjs';

// Reset metrics before each test group to ensure isolation
test('metrics: reset clears all state', () => {
  resetMetrics();
  const metrics = getMetrics();
  assert.deepEqual(metrics.agents, {});
  assert.ok(metrics.startedAt);
  assert.ok(metrics.sessionUsage);
  assert.equal(metrics.sessionUsage.totalTokens, 0);
});

// ── recordCallStart / recordCallComplete ─────────────────────────────────────

test('metrics: record a successful call lifecycle', () => {
  resetMetrics();

  const handle = recordCallStart('claude', 'claude-opus-4-6');
  assert.ok(handle, 'Should return a handle string');
  assert.ok(typeof handle === 'string');

  // Simulate some output
  recordCallComplete(handle, { stdout: 'x'.repeat(100), stderr: '' });

  const agent = getAgentMetrics('claude');
  assert.ok(agent, 'Claude metrics should exist');
  assert.equal(agent.callsTotal, 1);
  assert.equal(agent.callsToday, 1);
  assert.equal(agent.callsSuccess, 1);
  assert.equal(agent.callsFailed, 0);
  assert.ok(agent.estimatedTokensToday > 0, 'Should estimate tokens from output length');
  assert.ok(agent.totalDurationMs >= 0);
  assert.equal(agent.lastModel, 'claude-opus-4-6');
  assert.ok(agent.lastCallAt);
  assert.equal(agent.history.length, 1);
  assert.equal(agent.history[0].ok, true);
});

test('metrics: record a failed call', () => {
  resetMetrics();

  const handle = recordCallStart('gemini', 'gemini-2.5-pro');
  recordCallError(handle, new Error('API timeout'));

  const agent = getAgentMetrics('gemini');
  assert.equal(agent.callsTotal, 1);
  assert.equal(agent.callsSuccess, 0);
  assert.equal(agent.callsFailed, 1);
  assert.equal(agent.estimatedTokensToday, 0);
  assert.equal(agent.history.length, 1);
  assert.equal(agent.history[0].ok, false);
  assert.ok(agent.history[0].error.includes('API timeout'));
});

test('metrics: multiple calls accumulate correctly', () => {
  resetMetrics();

  for (let i = 0; i < 5; i++) {
    const handle = recordCallStart('codex', 'gpt-5.2-codex');
    recordCallComplete(handle, { stdout: 'output', stderr: '' });
  }

  const handle = recordCallStart('codex', 'gpt-5.2-codex');
  recordCallError(handle, 'network error');

  const agent = getAgentMetrics('codex');
  assert.equal(agent.callsTotal, 6);
  assert.equal(agent.callsSuccess, 5);
  assert.equal(agent.callsFailed, 1);
  assert.equal(agent.history.length, 6);
});

test('metrics: history is capped at 20 entries', () => {
  resetMetrics();

  for (let i = 0; i < 25; i++) {
    const handle = recordCallStart('claude', 'opus');
    recordCallComplete(handle, { stdout: `output-${i}`, stderr: '' });
  }

  const agent = getAgentMetrics('claude');
  assert.equal(agent.callsTotal, 25);
  assert.equal(agent.history.length, 20, 'History should be capped at 20');
});

test('metrics: avgDurationMs is calculated correctly', () => {
  resetMetrics();

  // Record two calls
  const h1 = recordCallStart('claude', 'opus');
  recordCallComplete(h1, { stdout: 'a', stderr: '' });
  const h2 = recordCallStart('claude', 'opus');
  recordCallComplete(h2, { stdout: 'b', stderr: '' });

  const agent = getAgentMetrics('claude');
  assert.equal(agent.avgDurationMs, Math.round(agent.totalDurationMs / agent.callsTotal));
});

// ── Claude JSON token extraction ─────────────────────────────────────────────

test('metrics: extracts real tokens from Claude JSON output', () => {
  resetMetrics();

  const handle = recordCallStart('claude', 'claude-opus-4-6');
  const claudeOutput = JSON.stringify({
    type: 'result',
    result: 'Hello',
    usage: {
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 100,
    },
    cost_usd: 0.05,
  });

  recordCallComplete(handle, { stdout: claudeOutput, stderr: '' });

  const agent = getAgentMetrics('claude');
  assert.equal(agent.sessionTokens.inputTokens, 1000);
  assert.equal(agent.sessionTokens.outputTokens, 500);
  assert.equal(agent.sessionTokens.cacheCreationTokens, 200);
  assert.equal(agent.sessionTokens.cacheReadTokens, 100);
  assert.equal(agent.sessionTokens.totalTokens, 1500);
  assert.equal(agent.sessionTokens.costUsd, 0.05);
  assert.equal(agent.sessionTokens.callCount, 1);

  // Session-level should also accumulate
  const session = getSessionUsage();
  assert.equal(session.inputTokens, 1000);
  assert.equal(session.totalTokens, 1500);
  assert.equal(session.costUsd, 0.05);
});

// ── getAgentMetrics ──────────────────────────────────────────────────────────

test('metrics: getAgentMetrics returns null for unrecorded agents', () => {
  resetMetrics();
  assert.equal(getAgentMetrics('nonexistent'), null);
});

// ── getMetricsSummary ────────────────────────────────────────────────────────

test('metrics: getMetricsSummary returns aggregated data', () => {
  resetMetrics();

  const h1 = recordCallStart('claude', 'opus');
  recordCallComplete(h1, { stdout: 'hello', stderr: '' });
  const h2 = recordCallStart('gemini', 'pro');
  recordCallComplete(h2, { stdout: 'world', stderr: '' });

  const summary = getMetricsSummary();
  assert.ok(summary.startedAt);
  assert.ok(typeof summary.uptimeSec === 'number');
  assert.equal(summary.totalCalls, 2);
  assert.ok(summary.totalTokens > 0);
  assert.ok(summary.agents.claude);
  assert.ok(summary.agents.gemini);
  assert.equal(summary.agents.claude.callsToday, 1);
  assert.equal(summary.agents.gemini.callsToday, 1);
});

test('metrics: success rate calculation', () => {
  resetMetrics();

  // 3 successes, 1 failure
  for (let i = 0; i < 3; i++) {
    const h = recordCallStart('claude', 'opus');
    recordCallComplete(h, { stdout: 'ok', stderr: '' });
  }
  const h = recordCallStart('claude', 'opus');
  recordCallError(h, 'fail');

  const summary = getMetricsSummary();
  assert.equal(summary.agents.claude.successRate, 75);
});

// ── getSessionUsage ──────────────────────────────────────────────────────────

test('metrics: getSessionUsage starts at zero', () => {
  resetMetrics();
  const usage = getSessionUsage();
  assert.equal(usage.totalTokens, 0);
  assert.equal(usage.costUsd, 0);
  assert.equal(usage.callCount, 0);
});

// ── estimateFlowDuration ─────────────────────────────────────────────────────

test('metrics: estimateFlowDuration uses defaults when no history', () => {
  resetMetrics();
  const flow = [{ agent: 'gemini' }, { agent: 'codex' }, { agent: 'claude' }];
  const estimate = estimateFlowDuration(flow);
  // Default: gemini=90s, codex=180s, claude=120s → 390s
  assert.equal(estimate, 90_000 + 180_000 + 120_000);
});

test('metrics: estimateFlowDuration uses historical averages when positive', () => {
  resetMetrics();

  // Record a call — duration will be ~0ms in tests
  const h = recordCallStart('claude', 'opus');
  recordCallComplete(h, { stdout: 'x', stderr: '' });

  const agent = getAgentMetrics('claude');
  const flow = [{ agent: 'claude' }];
  const estimate = estimateFlowDuration(flow);

  // avgDurationMs rounds to 0 for instant calls; estimateFlowDuration falls back to default (120s)
  // when avg is 0. This tests that behavior: 0ms avg → use default.
  if (agent.avgDurationMs > 0) {
    assert.equal(estimate, agent.avgDurationMs);
  } else {
    assert.equal(estimate, 120_000, 'Should fall back to default when avg is 0');
  }
});

test('metrics: estimateFlowDuration multiplies by rounds', () => {
  resetMetrics();
  const flow = [{ agent: 'claude' }];
  const oneRound = estimateFlowDuration(flow, 1);
  const twoRounds = estimateFlowDuration(flow, 2);
  assert.equal(twoRounds, oneRound * 2);
});

// ── metricsEmitter events ────────────────────────────────────────────────────

test('metrics: emits call:start event', () => {
  resetMetrics();
  let emitted = null;
  const handler = (evt) => { emitted = evt; };
  metricsEmitter.on('call:start', handler);

  recordCallStart('claude', 'opus');

  metricsEmitter.off('call:start', handler);
  assert.ok(emitted);
  assert.equal(emitted.agent, 'claude');
  assert.equal(emitted.model, 'opus');
});

test('metrics: emits call:complete event', () => {
  resetMetrics();
  let emitted = null;
  const handler = (evt) => { emitted = evt; };
  metricsEmitter.on('call:complete', handler);

  const h = recordCallStart('gemini', 'pro');
  recordCallComplete(h, { stdout: 'ok', stderr: '' });

  metricsEmitter.off('call:complete', handler);
  assert.ok(emitted);
  assert.equal(emitted.agent, 'gemini');
  assert.equal(emitted.ok, true);
});

test('metrics: emits call:error event', () => {
  resetMetrics();
  let emitted = null;
  const handler = (evt) => { emitted = evt; };
  metricsEmitter.on('call:error', handler);

  const h = recordCallStart('codex', 'gpt-5');
  recordCallError(h, 'test error');

  metricsEmitter.off('call:error', handler);
  assert.ok(emitted);
  assert.equal(emitted.agent, 'codex');
  assert.ok(emitted.error.includes('test error'));
});

// ── Edge cases ───────────────────────────────────────────────────────────────

test('metrics: recordCallComplete with unknown handle is no-op', () => {
  resetMetrics();
  recordCallComplete('nonexistent_handle', { stdout: 'x', stderr: '' });
  const metrics = getMetrics();
  assert.deepEqual(metrics.agents, {});
});

test('metrics: recordCallError with unknown handle is no-op', () => {
  resetMetrics();
  recordCallError('nonexistent_handle', 'error');
  const metrics = getMetrics();
  assert.deepEqual(metrics.agents, {});
});

test('metrics: handles missing stdout/stderr gracefully', () => {
  resetMetrics();
  const h = recordCallStart('claude', 'opus');
  recordCallComplete(h, {});
  const agent = getAgentMetrics('claude');
  assert.equal(agent.callsSuccess, 1);
  assert.equal(agent.estimatedTokensToday, 0);
});

// ── result.output compatibility (Bug 2 fix) ─────────────────────────────────

test('metrics: recordCallComplete accepts result.output as alias for stdout', () => {
  resetMetrics();
  const h = recordCallStart('claude', 'claude-opus-4-6');
  const claudeOutput = JSON.stringify({
    type: 'result',
    result: 'Hello',
    usage: { input_tokens: 800, output_tokens: 200 },
    cost_usd: 0.03,
  });
  recordCallComplete(h, { output: claudeOutput, stderr: '' });

  const agent = getAgentMetrics('claude');
  assert.equal(agent.callsSuccess, 1);
  assert.equal(agent.sessionTokens.inputTokens, 800);
  assert.equal(agent.sessionTokens.outputTokens, 200);
  assert.equal(agent.sessionTokens.totalTokens, 1000);
  assert.equal(agent.sessionTokens.costUsd, 0.03);
});

test('metrics: result.stdout takes precedence over result.output', () => {
  resetMetrics();
  const h = recordCallStart('claude', 'claude-opus-4-6');
  const claudeOutput = JSON.stringify({
    type: 'result',
    result: 'Hello',
    usage: { input_tokens: 100, output_tokens: 50 },
    cost_usd: 0.01,
  });
  // When both stdout and output are present, stdout wins
  recordCallComplete(h, { stdout: claudeOutput, output: 'ignored', stderr: '' });

  const agent = getAgentMetrics('claude');
  assert.equal(agent.sessionTokens.inputTokens, 100);
  assert.equal(agent.sessionTokens.totalTokens, 150);
});

// ── history stores full realTokens object ────────────────────────────────────

test('metrics: history entry contains full realTokens breakdown', () => {
  resetMetrics();
  const h = recordCallStart('claude', 'claude-opus-4-6');
  const claudeOutput = JSON.stringify({
    type: 'result',
    result: 'Hello',
    usage: {
      input_tokens: 500,
      output_tokens: 300,
      cache_creation_input_tokens: 50,
      cache_read_input_tokens: 25,
    },
    cost_usd: 0.02,
  });
  recordCallComplete(h, { stdout: claudeOutput, stderr: '' });

  const agent = getAgentMetrics('claude');
  const entry = agent.history[0];
  assert.ok(typeof entry.realTokens === 'object', 'realTokens should be an object');
  assert.equal(entry.realTokens.inputTokens, 500);
  assert.equal(entry.realTokens.outputTokens, 300);
  assert.equal(entry.realTokens.cacheCreationTokens, 50);
  assert.equal(entry.realTokens.cacheReadTokens, 25);
  assert.equal(entry.realTokens.totalTokens, 800);
});

// ── getRecentTokens ──────────────────────────────────────────────────────────

test('metrics: getRecentTokens returns zeros when no data', () => {
  resetMetrics();
  const result = getRecentTokens('claude', 5 * 60 * 60 * 1000);
  assert.equal(result.real, 0);
  assert.equal(result.estimated, 0);
  assert.equal(result.total, 0);
  assert.equal(result.entries, 0);
});

test('metrics: getRecentTokens sums tokens from recent calls', () => {
  resetMetrics();
  // Record a Claude call with real tokens
  const h1 = recordCallStart('claude', 'claude-opus-4-6');
  const out1 = JSON.stringify({
    type: 'result', result: 'ok',
    usage: { input_tokens: 1000, output_tokens: 500 },
    cost_usd: 0.04,
  });
  recordCallComplete(h1, { stdout: out1, stderr: '' });

  // Record a non-Claude call (estimated only)
  const h2 = recordCallStart('gemini', 'pro');
  recordCallComplete(h2, { stdout: 'x'.repeat(400), stderr: '' });

  const claudeRecent = getRecentTokens('claude', 60_000);
  assert.equal(claudeRecent.real, 1500);
  assert.equal(claudeRecent.estimated, 0);
  assert.equal(claudeRecent.entries, 1);

  const geminiRecent = getRecentTokens('gemini', 60_000);
  assert.equal(geminiRecent.real, 0);
  assert.ok(geminiRecent.estimated > 0);
  assert.equal(geminiRecent.entries, 1);
});

test('metrics: getRecentTokens with null agentName sums all agents', () => {
  resetMetrics();
  const h1 = recordCallStart('claude', 'opus');
  recordCallComplete(h1, { stdout: 'hello world', stderr: '' });
  const h2 = recordCallStart('gemini', 'pro');
  recordCallComplete(h2, { stdout: 'hello world', stderr: '' });

  const all = getRecentTokens(null, 60_000);
  assert.equal(all.entries, 2);
  assert.ok(all.estimated > 0);
});
