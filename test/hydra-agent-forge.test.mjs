import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateAgentSpec,
  analyzeCodebase,
  loadForgeRegistry,
  saveForgeRegistry,
  listForgedAgents,
  persistForgedAgent,
  removeForgedAgent,
  generateSamplePrompt,
} from '../lib/hydra-agent-forge.mjs';
import {
  TASK_TYPES,
  getAgent,
  _resetRegistry,
  initAgentRegistry,
} from '../lib/hydra-agents.mjs';
import { registerBuiltInSubAgents } from '../lib/hydra-sub-agents.mjs';

// ── validateAgentSpec ─────────────────────────────────────────────────────────

test('validateAgentSpec: valid spec passes', () => {
  const spec = {
    name: 'test-agent',
    displayName: 'Test Agent',
    baseAgent: 'claude',
    strengths: ['testing'],
    weaknesses: ['speed'],
    tags: ['test'],
    taskAffinity: Object.fromEntries(TASK_TYPES.map((t) => [t, 0.5])),
    rolePrompt: 'A'.repeat(200),
    enabled: true,
  };
  const result = validateAgentSpec(spec);
  assert.ok(result.valid, `Expected valid but got errors: ${result.errors.join(', ')}`);
  assert.equal(result.errors.length, 0);
});

test('validateAgentSpec: rejects invalid name', () => {
  const spec = {
    name: 'INVALID NAME!',
    baseAgent: 'claude',
    taskAffinity: Object.fromEntries(TASK_TYPES.map((t) => [t, 0.5])),
    rolePrompt: 'A'.repeat(200),
  };
  const result = validateAgentSpec(spec);
  assert.ok(!result.valid);
  assert.ok(result.errors.some((e) => e.includes('Invalid name')));
});

test('validateAgentSpec: rejects missing baseAgent', () => {
  const spec = {
    name: 'test-agent',
    taskAffinity: Object.fromEntries(TASK_TYPES.map((t) => [t, 0.5])),
    rolePrompt: 'A'.repeat(200),
  };
  const result = validateAgentSpec(spec);
  assert.ok(!result.valid);
  assert.ok(result.errors.some((e) => e.includes('baseAgent')));
});

test('validateAgentSpec: rejects non-physical baseAgent', () => {
  // security-reviewer is virtual, should be rejected
  _resetRegistry();
  initAgentRegistry();
  registerBuiltInSubAgents();

  const spec = {
    name: 'bad-base',
    baseAgent: 'security-reviewer',
    taskAffinity: Object.fromEntries(TASK_TYPES.map((t) => [t, 0.5])),
    rolePrompt: 'A'.repeat(200),
  };
  const result = validateAgentSpec(spec);
  assert.ok(!result.valid);
  assert.ok(result.errors.some((e) => e.includes('must be a physical agent')));
});

test('validateAgentSpec: rejects collision with physical agent', () => {
  const spec = {
    name: 'claude',
    baseAgent: 'gemini',
    taskAffinity: Object.fromEntries(TASK_TYPES.map((t) => [t, 0.5])),
    rolePrompt: 'A'.repeat(200),
  };
  const result = validateAgentSpec(spec);
  assert.ok(!result.valid);
  assert.ok(result.errors.some((e) => e.includes('collides')));
});

test('validateAgentSpec: rejects missing rolePrompt', () => {
  const spec = {
    name: 'no-prompt',
    baseAgent: 'claude',
    taskAffinity: Object.fromEntries(TASK_TYPES.map((t) => [t, 0.5])),
  };
  const result = validateAgentSpec(spec);
  assert.ok(!result.valid);
  assert.ok(result.errors.some((e) => e.includes('rolePrompt')));
});

test('validateAgentSpec: rejects missing taskAffinity', () => {
  const spec = {
    name: 'no-affinity',
    baseAgent: 'claude',
    rolePrompt: 'A'.repeat(200),
  };
  const result = validateAgentSpec(spec);
  assert.ok(!result.valid);
  assert.ok(result.errors.some((e) => e.includes('taskAffinity')));
});

test('validateAgentSpec: warns on short rolePrompt', () => {
  const spec = {
    name: 'short-prompt',
    baseAgent: 'claude',
    taskAffinity: Object.fromEntries(TASK_TYPES.map((t) => [t, 0.5])),
    rolePrompt: 'Brief.',
  };
  const result = validateAgentSpec(spec);
  assert.ok(result.valid); // warnings don't make it invalid
  assert.ok(result.warnings.some((w) => w.includes('very short')));
});

test('validateAgentSpec: warns on missing affinities', () => {
  const spec = {
    name: 'partial-affinity',
    baseAgent: 'claude',
    taskAffinity: { implementation: 0.9 },
    rolePrompt: 'A'.repeat(200),
  };
  const result = validateAgentSpec(spec);
  assert.ok(result.valid);
  assert.ok(result.warnings.some((w) => w.includes('Missing affinity')));
});

test('validateAgentSpec: warns on high affinity where base is weak', () => {
  const spec = {
    name: 'bad-affinity',
    baseAgent: 'codex',
    taskAffinity: Object.fromEntries(TASK_TYPES.map((t) => [t, 0.3])),
    rolePrompt: 'A'.repeat(200),
  };
  // Codex is weak at architecture (0.15) — set high affinity to trigger warning
  spec.taskAffinity.architecture = 0.95;
  const result = validateAgentSpec(spec);
  assert.ok(result.valid);
  assert.ok(result.warnings.some((w) => w.includes('underperform')));
});

// ── analyzeCodebase ───────────────────────────────────────────────────────────

test('analyzeCodebase returns expected profile structure', () => {
  const profile = analyzeCodebase();
  assert.ok(profile.projectName, 'should have projectName');
  assert.ok(typeof profile.fileTypes === 'object', 'should have fileTypes');
  assert.ok(typeof profile.hasTests === 'boolean', 'should have hasTests');
  assert.ok(Array.isArray(profile.existingAgents), 'should have existingAgents');
  assert.ok(Array.isArray(profile.coverageGaps), 'should have coverageGaps');
  assert.ok(Array.isArray(profile.recentCommits), 'should have recentCommits');
});

test('analyzeCodebase detects this project correctly', () => {
  const profile = analyzeCodebase();
  // This is the Hydra project
  assert.ok(profile.claudeMd, 'should detect CLAUDE.md');
  assert.ok(profile.hasTests, 'should detect test directory');
  assert.ok(profile.existingAgents.length >= 3, 'should have at least 3 agents');
});

// ── generateSamplePrompt ──────────────────────────────────────────────────────

test('generateSamplePrompt returns a string matching top affinity', () => {
  const spec = {
    taskAffinity: {
      testing: 0.95,
      implementation: 0.5,
      review: 0.3,
    },
  };
  const prompt = generateSamplePrompt(spec, { projectName: 'TestProject' });
  assert.ok(typeof prompt === 'string');
  assert.ok(prompt.length > 20);
  // Testing is the top affinity, so prompt should be test-related
  assert.ok(prompt.toLowerCase().includes('test'));
});

test('generateSamplePrompt handles empty affinity', () => {
  const prompt = generateSamplePrompt({ taskAffinity: {} }, { projectName: 'X' });
  assert.ok(typeof prompt === 'string');
  assert.ok(prompt.length > 10);
});

// ── Registry operations ───────────────────────────────────────────────────────

test('loadForgeRegistry returns object (may be empty)', () => {
  const registry = loadForgeRegistry();
  assert.ok(typeof registry === 'object');
  assert.ok(!Array.isArray(registry));
});

test('listForgedAgents returns array', () => {
  const list = listForgedAgents();
  assert.ok(Array.isArray(list));
});

// ── persistForgedAgent + removeForgedAgent round-trip ──────────────────────────

test('persist and remove a forged agent round-trip', () => {
  const testName = 'forge-test-roundtrip';

  // Clean up first in case of previous failed test
  try { removeForgedAgent(testName); } catch { /* ignore */ }

  const spec = {
    name: testName,
    displayName: 'Forge Test Roundtrip',
    baseAgent: 'claude',
    strengths: ['testing'],
    weaknesses: ['scope'],
    tags: ['test'],
    taskAffinity: Object.fromEntries(TASK_TYPES.map((t) => [t, 0.4])),
    rolePrompt: 'Test agent for unit test round-trip validation. ' + 'A'.repeat(100),
    enabled: true,
    type: 'virtual',
  };

  // Persist
  persistForgedAgent(spec, {
    description: 'Unit test round-trip',
    phasesRun: ['analyze', 'design', 'critique', 'refine'],
  });

  // Verify registered
  const agent = getAgent(testName);
  assert.ok(agent, 'Agent should be registered after persist');
  assert.equal(agent.displayName, 'Forge Test Roundtrip');
  assert.equal(agent.baseAgent, 'claude');

  // Verify in forge registry
  const registry = loadForgeRegistry();
  assert.ok(registry[testName], 'Should be in forge registry');
  assert.equal(registry[testName].description, 'Unit test round-trip');

  // Verify in listForgedAgents
  const list = listForgedAgents();
  assert.ok(list.some((a) => a.name === testName), 'Should appear in listForgedAgents');

  // Remove
  removeForgedAgent(testName);

  // Verify removed from live registry
  const afterRemove = getAgent(testName);
  assert.ok(!afterRemove, 'Agent should be unregistered after remove');

  // Verify removed from forge registry
  const registryAfter = loadForgeRegistry();
  assert.ok(!registryAfter[testName], 'Should be removed from forge registry');
});
