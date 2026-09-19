import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectAvailableProviders,
  buildFallbackChain,
  providerLabel,
} from '../lib/hydra-concierge-providers.mjs';

describe('detectAvailableProviders', () => {
  const saved = {};

  beforeEach(() => {
    saved.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    saved.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    saved.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    saved.GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
  });

  it('returns empty when no keys set', () => {
    const providers = detectAvailableProviders();
    assert.equal(providers.length, 0);
  });

  it('detects OpenAI when key is set', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const providers = detectAvailableProviders();
    assert.equal(providers.length, 1);
    assert.equal(providers[0].provider, 'openai');
  });

  it('detects Anthropic when key is set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const providers = detectAvailableProviders();
    assert.equal(providers.length, 1);
    assert.equal(providers[0].provider, 'anthropic');
  });

  it('detects Google via GEMINI_API_KEY', () => {
    process.env.GEMINI_API_KEY = 'AIza-test';
    const providers = detectAvailableProviders();
    assert.equal(providers.length, 1);
    assert.equal(providers[0].provider, 'google');
  });

  it('detects Google via GOOGLE_API_KEY fallback', () => {
    process.env.GOOGLE_API_KEY = 'AIza-test2';
    const providers = detectAvailableProviders();
    assert.equal(providers.length, 1);
    assert.equal(providers[0].provider, 'google');
  });

  it('detects multiple providers', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.GEMINI_API_KEY = 'AIza-test';
    const providers = detectAvailableProviders();
    assert.equal(providers.length, 3);
    const names = providers.map((p) => p.provider);
    assert.ok(names.includes('openai'));
    assert.ok(names.includes('anthropic'));
    assert.ok(names.includes('google'));
  });
});

describe('buildFallbackChain', () => {
  const saved = {};

  beforeEach(() => {
    saved.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    saved.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    saved.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
  });

  it('returns chain with availability flags', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const chain = buildFallbackChain();
    assert.ok(chain.length >= 1);
    const openai = chain.find((e) => e.provider === 'openai');
    assert.ok(openai);
    assert.equal(openai.available, true);
    const anthropic = chain.find((e) => e.provider === 'anthropic');
    if (anthropic) assert.equal(anthropic.available, false);
  });

  it('marks all unavailable when no keys set', () => {
    const chain = buildFallbackChain();
    for (const entry of chain) {
      assert.equal(entry.available, false);
    }
  });
});

describe('providerLabel', () => {
  it('returns provider:model without suffix for primary', () => {
    const lbl = providerLabel('openai', 'gpt-5.2-codex', false);
    assert.equal(lbl, 'openai:gpt-5.2-codex');
  });

  it('appends down arrow for fallback', () => {
    const lbl = providerLabel('anthropic', 'claude-sonnet-4-5-20250929', true);
    assert.ok(lbl.includes('\u2193'));
    assert.ok(lbl.includes('anthropic'));
  });
});
