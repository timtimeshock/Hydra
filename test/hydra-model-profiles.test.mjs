import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODEL_PROFILES,
  ROLE_DEFAULTS,
  AGENT_PRESETS,
  getProfile,
  getProfilesForAgent,
  getAgentPresets,
  getRoleRecommendation,
  getFallbackOrder,
  formatBenchmarkAnnotation,
  getDefaultRoles,
  getCostTable,
  getReasoningCapsMap,
  getShortName,
  getConciergeFallbackChain,
  getModeTiers,
} from '../lib/hydra-model-profiles.mjs';

describe('MODEL_PROFILES data integrity', () => {
  it('contains expected number of profiles', () => {
    const keys = Object.keys(MODEL_PROFILES);
    assert.ok(keys.length >= 12, `Expected at least 12 profiles, got ${keys.length}`);
  });

  it('every profile has required fields', () => {
    for (const [id, p] of Object.entries(MODEL_PROFILES)) {
      assert.equal(p.id, id, `Profile id mismatch for ${id}`);
      assert.ok(p.provider, `${id} missing provider`);
      assert.ok(p.agent, `${id} missing agent`);
      assert.ok(p.displayName, `${id} missing displayName`);
      assert.ok(p.shortName, `${id} missing shortName`);
      assert.ok(p.tier, `${id} missing tier`);
      assert.ok(typeof p.contextWindow === 'number', `${id} contextWindow must be number`);
      assert.ok(typeof p.maxOutput === 'number', `${id} maxOutput must be number`);
      assert.ok(p.pricePer1M && typeof p.pricePer1M.input === 'number', `${id} missing pricePer1M.input`);
      assert.ok(p.pricePer1M && typeof p.pricePer1M.output === 'number', `${id} missing pricePer1M.output`);
      assert.ok(p.costPer1K && typeof p.costPer1K.input === 'number', `${id} missing costPer1K.input`);
      assert.ok(p.costPer1K && typeof p.costPer1K.output === 'number', `${id} missing costPer1K.output`);
      assert.ok(typeof p.qualityScore === 'number', `${id} qualityScore must be number`);
      assert.ok(typeof p.valueScore === 'number', `${id} valueScore must be number`);
      assert.ok(typeof p.speedScore === 'number', `${id} speedScore must be number`);
      assert.ok(p.qualityScore >= 0 && p.qualityScore <= 100, `${id} qualityScore out of range`);
      assert.ok(Array.isArray(p.strengths), `${id} strengths must be array`);
      assert.ok(Array.isArray(p.bestFor), `${id} bestFor must be array`);
      assert.ok(p.reasoning && typeof p.reasoning.type === 'string', `${id} missing reasoning.type`);
    }
  });

  it('costPer1K matches pricePer1M / 1000', () => {
    for (const [id, p] of Object.entries(MODEL_PROFILES)) {
      const expectedInput = p.pricePer1M.input / 1000;
      const expectedOutput = p.pricePer1M.output / 1000;
      assert.ok(
        Math.abs(p.costPer1K.input - expectedInput) < 0.0001,
        `${id} costPer1K.input (${p.costPer1K.input}) != pricePer1M.input/1000 (${expectedInput})`
      );
      assert.ok(
        Math.abs(p.costPer1K.output - expectedOutput) < 0.0001,
        `${id} costPer1K.output (${p.costPer1K.output}) != pricePer1M.output/1000 (${expectedOutput})`
      );
    }
  });

  it('every agent in profiles is one of claude/codex/gemini', () => {
    const validAgents = new Set(['claude', 'codex', 'gemini']);
    for (const [id, p] of Object.entries(MODEL_PROFILES)) {
      assert.ok(validAgents.has(p.agent), `${id} has invalid agent: ${p.agent}`);
    }
  });

  it('tier is one of flagship/mid/economy', () => {
    const validTiers = new Set(['flagship', 'mid', 'economy']);
    for (const [id, p] of Object.entries(MODEL_PROFILES)) {
      assert.ok(validTiers.has(p.tier), `${id} has invalid tier: ${p.tier}`);
    }
  });
});

describe('ROLE_DEFAULTS', () => {
  it('has all expected roles', () => {
    const expected = ['architect', 'analyst', 'implementer', 'concierge', 'investigator', 'nightlyHandoff'];
    for (const role of expected) {
      assert.ok(ROLE_DEFAULTS[role], `Missing role: ${role}`);
    }
  });

  it('every role has required fields', () => {
    for (const [role, rd] of Object.entries(ROLE_DEFAULTS)) {
      assert.ok(rd.agent, `${role} missing agent`);
      assert.ok(Array.isArray(rd.models), `${role} models must be array`);
      assert.ok(rd.models.length > 0, `${role} must have at least 1 recommended model`);
      assert.ok(rd.note, `${role} missing note`);
    }
  });
});

describe('AGENT_PRESETS', () => {
  it('has presets for all 3 agents', () => {
    for (const agent of ['claude', 'codex', 'gemini']) {
      const presets = AGENT_PRESETS[agent];
      assert.ok(presets, `Missing presets for ${agent}`);
      assert.ok(presets.default, `${agent} missing default preset`);
      assert.ok(presets.fast, `${agent} missing fast preset`);
      assert.ok(presets.cheap, `${agent} missing cheap preset`);
    }
  });

  it('preset model IDs exist in profiles', () => {
    for (const [agent, presets] of Object.entries(AGENT_PRESETS)) {
      for (const [key, modelId] of Object.entries(presets)) {
        assert.ok(MODEL_PROFILES[modelId], `${agent}.${key} = ${modelId} not in profiles`);
      }
    }
  });
});

describe('query functions', () => {
  it('getProfile returns profile for known model', () => {
    const p = getProfile('claude-opus-4-6');
    assert.ok(p);
    assert.equal(p.provider, 'anthropic');
    assert.equal(p.agent, 'claude');
  });

  it('getProfile returns null for unknown model', () => {
    assert.equal(getProfile('nonexistent-model'), null);
    assert.equal(getProfile(null), null);
  });

  it('getProfilesForAgent returns correct profiles', () => {
    const claude = getProfilesForAgent('claude');
    assert.ok(claude.length >= 3);
    assert.ok(claude.every(p => p.agent === 'claude'));

    const codex = getProfilesForAgent('codex');
    assert.ok(codex.length >= 4);
    assert.ok(codex.every(p => p.agent === 'codex'));

    const gemini = getProfilesForAgent('gemini');
    assert.ok(gemini.length >= 4);
    assert.ok(gemini.every(p => p.agent === 'gemini'));
  });

  it('getAgentPresets returns correct presets', () => {
    const p = getAgentPresets('claude');
    assert.equal(p.default, 'claude-sonnet-4-6');
    assert.equal(p.fast, 'claude-sonnet-4-5-20250929');
    assert.equal(p.cheap, 'claude-haiku-4-5-20251001');
  });

  it('getAgentPresets returns null for unknown agent', () => {
    assert.equal(getAgentPresets('unknown'), null);
  });

  it('getRoleRecommendation returns data for known role', () => {
    const r = getRoleRecommendation('architect');
    assert.ok(r);
    assert.equal(r.agent, 'claude');
    assert.ok(r.models.includes('claude-opus-4-6'));
  });

  it('getRoleRecommendation returns null for unknown role', () => {
    assert.equal(getRoleRecommendation('nonexistent'), null);
  });

  it('getFallbackOrder excludes the failed model and sorts by quality', () => {
    const candidates = getFallbackOrder('claude', 'claude-opus-4-6');
    assert.ok(candidates.length >= 2);
    assert.ok(!candidates.some(c => c.id === 'claude-opus-4-6'));
    // Should be sorted by qualityScore descending
    for (let i = 1; i < candidates.length; i++) {
      assert.ok(candidates[i - 1].qualityScore >= candidates[i].qualityScore);
    }
  });

  it('formatBenchmarkAnnotation returns annotation for known model', () => {
    const annotation = formatBenchmarkAnnotation('claude-opus-4-6');
    assert.ok(annotation.includes('SWE'));
    assert.ok(annotation.includes('80.8%'));
    assert.ok(annotation.includes('66 tok/s'));
    assert.ok(annotation.includes('$5'));
  });

  it('formatBenchmarkAnnotation returns empty for unknown model', () => {
    assert.equal(formatBenchmarkAnnotation('nonexistent'), '');
  });

  it('formatBenchmarkAnnotation respects opts', () => {
    const noPrice = formatBenchmarkAnnotation('claude-opus-4-6', { includePrice: false });
    assert.ok(!noPrice.includes('$5'));
    assert.ok(noPrice.includes('SWE'));
  });

  it('getDefaultRoles returns roles and recommendations', () => {
    const { roles, recommendations } = getDefaultRoles();
    assert.ok(roles.architect);
    assert.equal(roles.architect.agent, 'claude');
    assert.ok(recommendations.architect);
    assert.ok(recommendations.architect.models.includes('claude-opus-4-6'));
    assert.ok(recommendations.architect.note);
  });

  it('getCostTable returns per-1K costs for all profiles', () => {
    const table = getCostTable();
    assert.ok(table['claude-opus-4-6']);
    assert.equal(typeof table['claude-opus-4-6'].input, 'number');
    assert.equal(typeof table['claude-opus-4-6'].output, 'number');
    assert.ok(Object.keys(table).length >= 12);
  });

  it('getReasoningCapsMap returns expected keys', () => {
    const map = getReasoningCapsMap();
    assert.ok(map['o4-mini']);
    assert.equal(map['o4-mini'].type, 'effort');
    assert.ok(map['claude-opus']);
    assert.equal(map['claude-opus'].type, 'thinking');
    assert.ok(map['gemini-3-pro']);
    assert.equal(map['gemini-3-pro'].type, 'model-swap');
    assert.equal(map['gpt-5'].type, 'none');
  });

  it('getShortName returns short names for known models', () => {
    assert.equal(getShortName('claude-opus-4-6'), 'opus');
    assert.equal(getShortName('gpt-5.6-terra'), 'terra');
    assert.equal(getShortName('gemini-3-pro-preview'), 'pro');
    assert.equal(getShortName('nonexistent'), null);
  });

  it('getConciergeFallbackChain returns valid chain', () => {
    const chain = getConciergeFallbackChain();
    assert.ok(chain.length >= 3);
    assert.ok(chain[0].provider);
    assert.ok(chain[0].model);
    // First should be the concierge model (gpt-5.6-terra)
    assert.equal(chain[0].model, 'gpt-5.6-terra');
  });

  it('getModeTiers returns all 4 tiers', () => {
    const tiers = getModeTiers();
    assert.ok(tiers.performance);
    assert.ok(tiers.balanced);
    assert.ok(tiers.economy);
    assert.ok(tiers.custom);
  });
});
