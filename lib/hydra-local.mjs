/**
 * Hydra Local — Streaming client for any OpenAI-compatible local endpoint.
 *
 * Wraps the OpenAI SSE streaming format with a configurable baseUrl.
 * Works with Ollama, LM Studio, vllm, llama.cpp server, and any other
 * OpenAI-compatible runtime.
 */

/**
 * Stream a chat completion from a local OpenAI-compatible endpoint.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @param {object} cfg
 * @param {string} cfg.model - Model identifier (e.g. 'mistral:7b')
 * @param {string} cfg.baseUrl - Base URL (e.g. 'http://localhost:11434/v1')
 * @param {number} [cfg.maxTokens] - Optional max tokens
 * @param {Function} [onChunk] - Called with each streamed text chunk
 * @returns {Promise<{ok: boolean, fullResponse: string, usage: object|null, rateLimits: null, output: string, errorCategory?: string}>}
 */
export async function streamLocalCompletion(messages, cfg, onChunk) {
  const { baseUrl, model, maxTokens, signal } = cfg;

  const body = { model, messages, stream: true };
  if (maxTokens) body.max_tokens = maxTokens;

  let res;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    const errCode = err.cause?.code || err.code;
    const unreachable = ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH'];
    if (unreachable.includes(errCode)) {
      return { ok: false, errorCategory: 'local-unavailable', output: '', fullResponse: '', usage: null, rateLimits: null };
    }
    throw err;
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const err = new Error(`Local API error ${res.status}: ${errText.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }

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
        if (data.usage) usage = data.usage;
      } catch {
        // Skip malformed SSE chunks
      }
    }
  }

  return { ok: true, fullResponse, output: fullResponse, usage, rateLimits: null };
}
