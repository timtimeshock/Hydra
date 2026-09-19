import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// These tests verify module structure and error handling without making real API calls.

describe('hydra-anthropic', () => {
  let streamAnthropicCompletion;

  beforeEach(async () => {
    const mod = await import('../lib/hydra-anthropic.mjs');
    streamAnthropicCompletion = mod.streamAnthropicCompletion;
  });

  it('exports streamAnthropicCompletion function', () => {
    assert.equal(typeof streamAnthropicCompletion, 'function');
  });

  it('throws when ANTHROPIC_API_KEY is not set', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await assert.rejects(
        () => streamAnthropicCompletion(
          [{ role: 'user', content: 'test' }],
          { model: 'claude-sonnet-4-5-20250929' }
        ),
        { message: /ANTHROPIC_API_KEY not set/ }
      );
    } finally {
      if (saved) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it('throws when model is missing', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    try {
      await assert.rejects(
        () => streamAnthropicCompletion(
          [{ role: 'user', content: 'test' }],
          {}
        ),
        { message: /requires cfg\.model/ }
      );
    } finally {
      if (saved) process.env.ANTHROPIC_API_KEY = saved;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });
});

describe('hydra-google', () => {
  let streamGoogleCompletion;

  beforeEach(async () => {
    const mod = await import('../lib/hydra-google.mjs');
    streamGoogleCompletion = mod.streamGoogleCompletion;
  });

  it('exports streamGoogleCompletion function', () => {
    assert.equal(typeof streamGoogleCompletion, 'function');
  });

  it('throws when no API key is set', async () => {
    const savedGemini = process.env.GEMINI_API_KEY;
    const savedGoogle = process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    try {
      await assert.rejects(
        () => streamGoogleCompletion(
          [{ role: 'user', content: 'test' }],
          { model: 'gemini-2.5-flash' }
        ),
        { message: /GEMINI_API_KEY or GOOGLE_API_KEY not set/ }
      );
    } finally {
      if (savedGemini) process.env.GEMINI_API_KEY = savedGemini;
      if (savedGoogle) process.env.GOOGLE_API_KEY = savedGoogle;
    }
  });

  it('throws when model is missing', async () => {
    const saved = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'test-key';
    try {
      await assert.rejects(
        () => streamGoogleCompletion(
          [{ role: 'user', content: 'test' }],
          {}
        ),
        { message: /requires cfg\.model/ }
      );
    } finally {
      if (saved) process.env.GEMINI_API_KEY = saved;
      else delete process.env.GEMINI_API_KEY;
    }
  });
});

describe('hydra-concierge multi-provider exports', () => {
  let concierge;

  beforeEach(async () => {
    concierge = await import('../lib/hydra-concierge.mjs');
  });

  it('exports getActiveProvider', () => {
    assert.equal(typeof concierge.getActiveProvider, 'function');
  });

  it('exports getConciergeModelLabel', () => {
    assert.equal(typeof concierge.getConciergeModelLabel, 'function');
  });

  it('exports switchConciergeModel', () => {
    assert.equal(typeof concierge.switchConciergeModel, 'function');
  });

  it('exports exportConversation', () => {
    assert.equal(typeof concierge.exportConversation, 'function');
  });

  it('exports getRecentContext', () => {
    assert.equal(typeof concierge.getRecentContext, 'function');
  });

  it('exports setConciergeBaseUrl', () => {
    assert.equal(typeof concierge.setConciergeBaseUrl, 'function');
  });

  it('getActiveProvider returns null initially', () => {
    assert.equal(concierge.getActiveProvider(), null);
  });

  it('getConciergeModelLabel returns a string', () => {
    const lbl = concierge.getConciergeModelLabel();
    assert.equal(typeof lbl, 'string');
    assert.ok(lbl.length > 0);
  });

  it('switchConciergeModel sets the active provider', () => {
    concierge.switchConciergeModel('sonnet');
    const ap = concierge.getActiveProvider();
    assert.ok(ap);
    assert.equal(ap.provider, 'anthropic');
    assert.equal(ap.model, 'claude-sonnet-4-5-20250929');
    assert.equal(ap.isFallback, false);
  });

  it('switchConciergeModel handles flash alias', () => {
    concierge.switchConciergeModel('flash');
    const ap = concierge.getActiveProvider();
    assert.equal(ap.provider, 'google');
    assert.equal(ap.model, 'gemini-3-flash-preview');
  });

  it('switchConciergeModel handles full model ID', () => {
    concierge.switchConciergeModel('gpt-5.2-codex');
    const ap = concierge.getActiveProvider();
    assert.equal(ap.provider, 'openai');
    assert.equal(ap.model, 'gpt-5.2-codex');
  });

  it('exportConversation returns structured data', () => {
    const exported = concierge.exportConversation();
    assert.ok(exported.exportedAt);
    assert.equal(typeof exported.turns, 'number');
    assert.ok(Array.isArray(exported.messages));
    assert.ok(exported.stats);
  });

  it('isConciergeAvailable checks any provider key', () => {
    // This depends on env, but the function should exist and return boolean
    const available = concierge.isConciergeAvailable();
    assert.equal(typeof available, 'boolean');
  });
});
