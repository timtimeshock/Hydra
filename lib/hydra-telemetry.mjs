/**
 * Hydra Telemetry — OTel GenAI tracing wrapper.
 *
 * Adds standardized distributed tracing using OpenTelemetry GenAI semantic
 * conventions. Traces flow to any OTLP backend (Jaeger, Grafana, Langfuse,
 * Arize Phoenix).
 *
 * OTel is an OPTIONAL peer dependency. If @opentelemetry/api is not installed,
 * all functions are no-ops with zero overhead. No hard dependency.
 *
 * Semantic conventions: https://opentelemetry.io/docs/specs/semconv/gen-ai/
 */

import { loadHydraConfig } from './hydra-config.mjs';

// ── Lazy OTel loading ──────────────────────────────────────────────────────

let _otelApi = null;      // cached module or false (not-found sentinel)
let _tracer = null;        // cached Tracer instance

/**
 * Attempt to load @opentelemetry/api. Returns the module or null.
 * Result is cached — subsequent calls are instant.
 */
async function loadOTel() {
  if (_otelApi === false) return null;   // already tried, not found
  if (_otelApi) return _otelApi;         // already loaded

  try {
    _otelApi = await import('@opentelemetry/api');
    return _otelApi;
  } catch {
    _otelApi = false;  // sentinel: don't try again
    return null;
  }
}

/**
 * Check if tracing is enabled (OTel available + config allows it).
 * @returns {Promise<boolean>}
 */
export async function isTracingEnabled() {
  const cfg = loadHydraConfig();
  if (cfg.telemetry?.enabled === false) return false;
  const api = await loadOTel();
  return api !== null;
}

/**
 * Get (or create) the Hydra tracer.
 * @returns {Promise<object|null>} OTel Tracer or null
 */
export async function getTracer() {
  if (_tracer) return _tracer;
  const api = await loadOTel();
  if (!api) return null;
  _tracer = api.trace.getTracer('hydra', '1.0.0');
  return _tracer;
}

// ── No-op span ─────────────────────────────────────────────────────────────

const NOOP_SPAN = {
  setAttribute() { return this; },
  setAttributes() { return this; },
  addEvent() { return this; },
  setStatus() { return this; },
  end() {},
  recordException() {},
  isRecording() { return false; },
  _noop: true,
};

// ── Agent spans ────────────────────────────────────────────────────────────

/**
 * Start a span for an agent CLI execution.
 *
 * @param {string} agent - Agent name (claude, gemini, codex)
 * @param {string} model - Model being used
 * @param {object} [opts]
 * @param {string} [opts.phase] - Pipeline phase (e.g. 'council:propose')
 * @param {string} [opts.taskType] - Task classification
 * @param {string} [opts.parentSpan] - Parent span to nest under
 * @returns {Promise<object>} Span object (or NOOP_SPAN)
 */
export async function startAgentSpan(agent, model, opts = {}) {
  const api = await loadOTel();
  if (!api) return NOOP_SPAN;
  const tracer = await getTracer();
  if (!tracer) return NOOP_SPAN;

  const spanOpts = {};
  if (opts.parentSpan && !opts.parentSpan._noop) {
    const ctx = api.trace.setSpan(api.context.active(), opts.parentSpan);
    spanOpts.context = ctx;
  }

  const spanName = opts.phase ? `${agent}/${opts.phase}` : `${agent}/execute`;

  // Use startActiveSpan so child spans auto-inherit
  const span = tracer.startSpan(spanName, {
    kind: api.SpanKind.CLIENT,
    attributes: {
      'gen_ai.system': agent,
      'gen_ai.request.model': model || 'unknown',
      'gen_ai.agent.name': agent,
      'gen_ai.operation.name': opts.phase || 'execute',
    },
    ...spanOpts,
  });

  if (opts.taskType) {
    span.setAttribute('hydra.task_type', opts.taskType);
  }

  return span;
}

/**
 * End an agent span with result data.
 *
 * @param {object} span - Span from startAgentSpan()
 * @param {object} result - executeAgent() result
 */
export async function endAgentSpan(span, result) {
  if (!span || span._noop) return;

  const api = await loadOTel();
  if (!api) return;

  span.setAttribute('hydra.ok', result.ok ?? false);
  span.setAttribute('hydra.duration_ms', result.durationMs ?? 0);

  if (result.exitCode != null) {
    span.setAttribute('hydra.exit_code', result.exitCode);
  }
  if (result.timedOut) {
    span.setAttribute('hydra.timed_out', true);
  }
  if (result.recovered) {
    span.setAttribute('hydra.recovered', true);
    span.setAttribute('hydra.original_model', result.originalModel || '');
    span.setAttribute('hydra.new_model', result.newModel || '');
  }

  if (result.ok) {
    span.setStatus({ code: api.SpanStatusCode.OK });
  } else {
    span.setStatus({ code: api.SpanStatusCode.ERROR, message: result.error || 'agent failed' });
    if (result.error) {
      span.recordException(new Error(result.error));
    }
  }

  span.end();
}

// ── Provider spans ─────────────────────────────────────────────────────────

/**
 * Start a span for a provider API call (streaming completion).
 *
 * @param {string} provider - Provider name (openai, anthropic, google)
 * @param {string} model - Model identifier
 * @param {object} [opts]
 * @param {string} [opts.operation] - Operation name (default: 'chat')
 * @returns {Promise<object>} Span object (or NOOP_SPAN)
 */
export async function startProviderSpan(provider, model, opts = {}) {
  const api = await loadOTel();
  if (!api) return NOOP_SPAN;
  const tracer = await getTracer();
  if (!tracer) return NOOP_SPAN;

  const operation = opts.operation || 'chat';
  const span = tracer.startSpan(`${provider}/${operation}`, {
    kind: api.SpanKind.CLIENT,
    attributes: {
      'gen_ai.system': provider,
      'gen_ai.request.model': model,
      'gen_ai.operation.name': operation,
    },
  });

  return span;
}

/**
 * End a provider span with usage data.
 *
 * @param {object} span - Span from startProviderSpan()
 * @param {object} [usage] - Token usage: { prompt_tokens, completion_tokens }
 * @param {number} [latencyMs] - Request latency
 */
export async function endProviderSpan(span, usage, latencyMs) {
  if (!span || span._noop) return;

  const api = await loadOTel();
  if (!api) return;

  if (usage) {
    span.setAttribute('gen_ai.usage.input_tokens', usage.prompt_tokens || 0);
    span.setAttribute('gen_ai.usage.output_tokens', usage.completion_tokens || 0);
  }
  if (latencyMs != null) {
    span.setAttribute('hydra.latency_ms', latencyMs);
  }

  span.setStatus({ code: api.SpanStatusCode.OK });
  span.end();
}

// ── Pipeline/council spans ─────────────────────────────────────────────────

/**
 * Start a parent span for a multi-phase pipeline (council, evolve, etc).
 *
 * @param {string} name - Pipeline name (e.g. 'council', 'evolve')
 * @param {object} [attrs] - Additional attributes
 * @returns {Promise<object>} Span object (or NOOP_SPAN)
 */
export async function startPipelineSpan(name, attrs = {}) {
  const api = await loadOTel();
  if (!api) return NOOP_SPAN;
  const tracer = await getTracer();
  if (!tracer) return NOOP_SPAN;

  const span = tracer.startSpan(`hydra/${name}`, {
    kind: api.SpanKind.INTERNAL,
    attributes: {
      'hydra.pipeline': name,
      ...attrs,
    },
  });

  return span;
}

/**
 * End a pipeline span.
 *
 * @param {object} span - Span from startPipelineSpan()
 * @param {object} [opts]
 * @param {boolean} [opts.ok=true] - Whether pipeline succeeded
 * @param {string} [opts.error] - Error message if failed
 */
export async function endPipelineSpan(span, opts = {}) {
  if (!span || span._noop) return;

  const api = await loadOTel();
  if (!api) return;

  if (opts.ok === false) {
    span.setStatus({ code: api.SpanStatusCode.ERROR, message: opts.error || 'pipeline failed' });
    if (opts.error) span.recordException(new Error(opts.error));
  } else {
    span.setStatus({ code: api.SpanStatusCode.OK });
  }

  span.end();
}
