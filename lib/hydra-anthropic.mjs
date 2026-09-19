/**
 * Hydra Anthropic — Streaming client for Anthropic Messages API.
 *
 * Mirrors hydra-openai.mjs pattern for the Anthropic Claude API.
 * Used by the concierge fallback chain when OpenAI is unavailable.
 *
 * Uses hydra-streaming-middleware.mjs for rate limiting, circuit breaking,
 * retry, usage tracking, and latency measurement.
 */

import { createStreamingPipeline } from './hydra-streaming-middleware.mjs';

/**
 * Core Anthropic streaming function — ONLY does the HTTP call + SSE parsing.
 * All cross-cutting concerns (rate limit, retry, usage, etc.) are handled by middleware.
 */
async function coreStreamAnthropic(messages, cfg, onChunk) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set');
  }

  if (!cfg.model) {
    throw new Error('streamAnthropicCompletion requires cfg.model to be set');
  }

  // Extract system message from array → separate system param (Anthropic requirement)
  let systemText = '';
  const filteredMessages = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      systemText += (systemText ? '\n\n' : '') + msg.content;
    } else {
      filteredMessages.push({ role: msg.role, content: msg.content });
    }
  }

  const body = {
    model: cfg.model,
    messages: filteredMessages,
    max_tokens: cfg.maxTokens || 4096,
    stream: true,
  };

  if (systemText) {
    body.system = systemText;
  }

  // Extended thinking support
  if (cfg.thinkingBudget && cfg.thinkingBudget > 0) {
    body.thinking = {
      type: 'enabled',
      budget_tokens: cfg.thinkingBudget,
    };
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  // Capture rate limit headers (Anthropic sends these on every response)
  const rateLimits = {
    remainingRequests: parseInt(res.headers.get('anthropic-ratelimit-requests-remaining')) || null,
    remainingInputTokens: parseInt(res.headers.get('anthropic-ratelimit-input-tokens-remaining')) || null,
    remainingOutputTokens: parseInt(res.headers.get('anthropic-ratelimit-output-tokens-remaining')) || null,
    remainingTokens: parseInt(res.headers.get('anthropic-ratelimit-tokens-remaining')) || null,
    resetRequests: res.headers.get('anthropic-ratelimit-requests-reset'),
  };

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const err = new Error(`Anthropic API error ${res.status}: ${errText.slice(0, 200)}`);
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
      if (!trimmed || trimmed.startsWith(':')) continue;

      if (trimmed.startsWith('event: ')) continue; // skip event type lines

      if (!trimmed.startsWith('data: ')) continue;

      try {
        const data = JSON.parse(trimmed.slice(6));

        // content_block_delta → only process text_delta, skip thinking_delta
        if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta' && data.delta.text) {
          fullResponse += data.delta.text;
          if (onChunk) onChunk(data.delta.text);
        }

        // message_delta → usage (stop reason + output tokens)
        if (data.type === 'message_delta' && data.usage) {
          usage = usage || { prompt_tokens: 0, completion_tokens: 0 };
          usage.completion_tokens = data.usage.output_tokens || 0;
        }

        // message_start → input usage
        if (data.type === 'message_start' && data.message?.usage) {
          usage = usage || { prompt_tokens: 0, completion_tokens: 0 };
          usage.prompt_tokens = data.message.usage.input_tokens || 0;
        }
      } catch {
        // Skip malformed SSE chunks
      }
    }
  }

  return { fullResponse, usage, rateLimits };
}

// Create the pipeline-wrapped version
const pipelinedStream = createStreamingPipeline('anthropic', coreStreamAnthropic);

/**
 * Stream a chat completion from the Anthropic Messages API.
 *
 * @param {Array<{role: string, content: string}>} messages - Chat messages (system extracted automatically)
 * @param {object} cfg - Configuration
 * @param {string} cfg.model - Model identifier (required)
 * @param {number} [cfg.maxTokens=4096] - Max tokens to generate
 * @param {number} [cfg.thinkingBudget] - Extended thinking budget in tokens (enables thinking when set)
 * @param {Function} [onChunk] - Called with each streamed text chunk
 * @returns {Promise<{fullResponse: string, usage: {prompt_tokens: number, completion_tokens: number}|null}>}
 */
export async function streamAnthropicCompletion(messages, cfg, onChunk) {
  return pipelinedStream(messages, cfg, onChunk);
}
