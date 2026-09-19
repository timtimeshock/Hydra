/**
 * Hydra Google — Streaming client for Google Gemini Generative Language API.
 *
 * Mirrors hydra-openai.mjs pattern for the Google Gemini API.
 * Used by the concierge fallback chain when OpenAI and Anthropic are unavailable.
 *
 * Uses hydra-streaming-middleware.mjs for rate limiting, circuit breaking,
 * retry, usage tracking, and latency measurement.
 */

import { createStreamingPipeline } from './hydra-streaming-middleware.mjs';

/**
 * Core Google streaming function — ONLY does the HTTP call + SSE parsing.
 * All cross-cutting concerns (rate limit, retry, usage, etc.) are handled by middleware.
 */
async function coreStreamGoogle(messages, cfg, onChunk) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY or GOOGLE_API_KEY not set');
  }

  if (!cfg.model) {
    throw new Error('streamGoogleCompletion requires cfg.model to be set');
  }

  // Extract system message and map roles
  let systemText = '';
  const contents = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      systemText += (systemText ? '\n\n' : '') + msg.content;
    } else {
      // Map assistant → model for Gemini API
      const role = msg.role === 'assistant' ? 'model' : 'user';
      contents.push({ role, parts: [{ text: msg.content }] });
    }
  }

  const body = { contents };

  if (systemText) {
    body.systemInstruction = { parts: [{ text: systemText }] };
  }

  if (cfg.maxTokens) {
    body.generationConfig = { ...body.generationConfig, maxOutputTokens: cfg.maxTokens };
  }

  if (cfg.responseType === 'json') {
    if (!body.generationConfig) body.generationConfig = {};
    body.generationConfig.responseMimeType = 'application/json';
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:streamGenerateContent?alt=sse&key=${apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const err = new Error(`Google API error ${res.status}: ${errText.slice(0, 200)}`);
    err.status = res.status;
    // Attach rate limit metadata for callers to handle
    if (res.status === 429 || /RESOURCE_EXHAUSTED|QUOTA_EXHAUSTED/i.test(errText)) {
      err.isRateLimit = true;
      const retryAfter = res.headers?.get?.('retry-after');
      err.retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : null;
    }
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
      if (!trimmed || !trimmed.startsWith('data: ')) continue;

      try {
        const data = JSON.parse(trimmed.slice(6));

        // Extract text from candidates (skip thinking/thought parts)
        const parts = data.candidates?.[0]?.content?.parts;
        if (parts) {
          for (const part of parts) {
            if (part.text && !part.thought) {
              fullResponse += part.text;
              if (onChunk) onChunk(part.text);
            }
          }
        }

        // Extract usage metadata
        if (data.usageMetadata) {
          usage = {
            prompt_tokens: data.usageMetadata.promptTokenCount || 0,
            completion_tokens: data.usageMetadata.candidatesTokenCount || 0,
          };
        }
      } catch {
        // Skip malformed SSE chunks
      }
    }
  }

  // Google doesn't send rate limit headers on success — return null rateLimits
  return { fullResponse, usage, rateLimits: null };
}

// Create the pipeline-wrapped version
const pipelinedStream = createStreamingPipeline('google', coreStreamGoogle);

/**
 * Stream a chat completion from the Google Gemini API.
 *
 * @param {Array<{role: string, content: string}>} messages - Chat messages
 * @param {object} cfg - Configuration
 * @param {string} cfg.model - Model identifier (required)
 * @param {number} [cfg.maxTokens] - Optional max output tokens
 * @param {Function} [onChunk] - Called with each streamed text chunk
 * @returns {Promise<{fullResponse: string, usage: {prompt_tokens: number, completion_tokens: number}|null}>}
 */
export async function streamGoogleCompletion(messages, cfg, onChunk) {
  return pipelinedStream(messages, cfg, onChunk);
}
