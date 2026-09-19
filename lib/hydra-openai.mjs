/**
 * Hydra OpenAI — Shared streaming client for OpenAI chat completions API.
 *
 * Extracted from hydra-concierge.mjs so both the concierge and the evolve
 * investigator can use the same SSE streaming logic without duplication.
 *
 * Uses hydra-streaming-middleware.mjs for rate limiting, circuit breaking,
 * retry, usage tracking, and latency measurement.
 */

import { createStreamingPipeline } from './hydra-streaming-middleware.mjs';

/**
 * Core OpenAI streaming function — ONLY does the HTTP call + SSE parsing.
 * All cross-cutting concerns (rate limit, retry, usage, etc.) are handled by middleware.
 */
async function coreStreamOpenAI(messages, cfg, onChunk) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY not set');
  }

  if (!cfg.model) {
    throw new Error('streamCompletion requires cfg.model to be set');
  }
  const model = cfg.model;
  const reasoningEffort = cfg.reasoningEffort || 'xhigh';

  // Reasoning models: o-series only (o1, o3, o4-mini) — gpt-5 does NOT support `reasoning`
  const isReasoningModel = /^o\d/.test(model);

  const body = {
    model,
    messages,
    stream: true,
  };

  if (isReasoningModel) {
    body.reasoning = { effort: reasoningEffort };
  }

  if (cfg.maxTokens) {
    body.max_completion_tokens = cfg.maxTokens;
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  // Capture rate limit headers (available on both success and error responses)
  const rateLimits = {
    remainingRequests: parseInt(res.headers.get('x-ratelimit-remaining-requests')) || null,
    remainingTokens: parseInt(res.headers.get('x-ratelimit-remaining-tokens')) || null,
    resetRequests: res.headers.get('x-ratelimit-reset-requests'),
    resetTokens: res.headers.get('x-ratelimit-reset-tokens'),
  };

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const err = new Error(`OpenAI API error ${res.status}: ${errText.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }

  // Parse SSE stream
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullResponse = '';
  let usage = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') continue;
      if (!trimmed.startsWith('data: ')) continue;

      try {
        const data = JSON.parse(trimmed.slice(6));
        const delta = data.choices?.[0]?.delta;
        if (delta?.content) {
          fullResponse += delta.content;
          if (onChunk) onChunk(delta.content);
        }
        // Capture usage from final chunk if present
        if (data.usage) {
          usage = data.usage;
        }
      } catch {
        // Skip malformed SSE chunks
      }
    }
  }

  return { fullResponse, usage, rateLimits };
}

// Create the pipeline-wrapped version
const pipelinedStream = createStreamingPipeline('openai', coreStreamOpenAI);

/**
 * Stream a chat completion from the OpenAI API.
 *
 * @param {Array<{role: string, content: string}>} messages - Chat messages
 * @param {object} cfg - Configuration
 * @param {string} cfg.model - Model identifier (required)
 * @param {string} [cfg.reasoningEffort='xhigh'] - Reasoning effort level
 * @param {number} [cfg.maxTokens] - Optional max tokens
 * @param {Function} [onChunk] - Called with each streamed text chunk
 * @returns {Promise<{fullResponse: string, usage: object|null}>}
 */
export async function streamCompletion(messages, cfg, onChunk) {
  return pipelinedStream(messages, cfg, onChunk);
}
