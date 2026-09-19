import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTracingEnabled,
  getTracer,
  startAgentSpan,
  endAgentSpan,
  startProviderSpan,
  endProviderSpan,
  startPipelineSpan,
  endPipelineSpan,
} from '../lib/hydra-telemetry.mjs';

describe('hydra-telemetry (no-op mode — OTel not installed)', () => {
  it('isTracingEnabled returns false when OTel not installed', async () => {
    const enabled = await isTracingEnabled();
    assert.equal(enabled, false);
  });

  it('getTracer returns null when OTel not installed', async () => {
    const tracer = await getTracer();
    assert.equal(tracer, null);
  });

  it('startAgentSpan returns no-op span', async () => {
    const span = await startAgentSpan('claude', 'test-model');
    assert.ok(span);
    assert.equal(span._noop, true);
    assert.equal(span.isRecording(), false);
    // Should not throw
    span.setAttribute('key', 'value');
    span.setStatus({ code: 0 });
    span.end();
  });

  it('endAgentSpan handles no-op span gracefully', async () => {
    const span = await startAgentSpan('codex', 'test-model');
    // Should not throw
    await endAgentSpan(span, { ok: true, durationMs: 100 });
  });

  it('startProviderSpan returns no-op span', async () => {
    const span = await startProviderSpan('openai', 'gpt-5.2');
    assert.ok(span);
    assert.equal(span._noop, true);
  });

  it('endProviderSpan handles no-op span gracefully', async () => {
    const span = await startProviderSpan('anthropic', 'claude-opus-4-6');
    await endProviderSpan(span, { prompt_tokens: 100, completion_tokens: 50 }, 1200);
  });

  it('startPipelineSpan returns no-op span', async () => {
    const span = await startPipelineSpan('council');
    assert.ok(span);
    assert.equal(span._noop, true);
  });

  it('endPipelineSpan handles no-op span gracefully', async () => {
    const span = await startPipelineSpan('evolve');
    await endPipelineSpan(span, { ok: true });
    await endPipelineSpan(span, { ok: false, error: 'test error' });
  });

  it('handles null span in end functions', async () => {
    await endAgentSpan(null, { ok: true });
    await endProviderSpan(null, null);
    await endPipelineSpan(null);
  });
});
