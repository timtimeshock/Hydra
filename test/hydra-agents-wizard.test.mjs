import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCustomAgentEntry, parseArgsTemplate, validateAgentName } from '../lib/hydra-agents-wizard.mjs';
import { AFFINITY_PRESETS } from '../lib/hydra-config.mjs';

describe('validateAgentName', () => {
  it('accepts valid lowercase names', () => {
    assert.strictEqual(validateAgentName('copilot'), null);
    assert.strictEqual(validateAgentName('my-agent'), null);
    assert.strictEqual(validateAgentName('agent123'), null);
  });

  it('rejects names with spaces or uppercase', () => {
    assert.ok(validateAgentName('My Agent') !== null);
    assert.ok(validateAgentName('AGENT') !== null);
    assert.ok(validateAgentName('') !== null);
  });

  it('rejects reserved agent names', () => {
    assert.ok(validateAgentName('claude') !== null);
    assert.ok(validateAgentName('gemini') !== null);
    assert.ok(validateAgentName('codex') !== null);
    assert.ok(validateAgentName('local') !== null);
  });
});

describe('parseArgsTemplate', () => {
  it('splits space-separated args into an array', () => {
    const result = parseArgsTemplate('copilot suggest -p {prompt}');
    assert.deepStrictEqual(result, ['copilot', 'suggest', '-p', '{prompt}']);
  });

  it('handles single arg', () => {
    assert.deepStrictEqual(parseArgsTemplate('{prompt}'), ['{prompt}']);
  });
});

describe('buildCustomAgentEntry', () => {
  it('builds a CLI agent entry from wizard fields', () => {
    const entry = buildCustomAgentEntry({
      name: 'copilot',
      type: 'cli',
      cmd: 'gh',
      argsTemplate: 'copilot suggest -p {prompt}',
      responseParser: 'plaintext',
      contextBudget: 32000,
      affinityPreset: 'code-focused',
      councilRole: null,
      enabled: true,
    });
    assert.strictEqual(entry.name, 'copilot');
    assert.strictEqual(entry.type, 'cli');
    assert.deepStrictEqual(entry.invoke.headless.cmd, 'gh');
    assert.deepStrictEqual(entry.invoke.headless.args, ['copilot', 'suggest', '-p', '{prompt}']);
    assert.deepStrictEqual(entry.taskAffinity, AFFINITY_PRESETS['code-focused']);
  });

  it('builds an API agent entry from wizard fields', () => {
    const entry = buildCustomAgentEntry({
      name: 'mixtral',
      type: 'api',
      baseUrl: 'http://localhost:11434/v1',
      model: 'mixtral:8x7b',
      contextBudget: 32000,
      affinityPreset: 'balanced',
      councilRole: null,
      enabled: true,
    });
    assert.strictEqual(entry.type, 'api');
    assert.strictEqual(entry.baseUrl, 'http://localhost:11434/v1');
    assert.strictEqual(entry.model, 'mixtral:8x7b');
    assert.deepStrictEqual(entry.taskAffinity, AFFINITY_PRESETS['balanced']);
  });
});
