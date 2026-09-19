import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENTS,
  AGENT_NAMES,
  AGENT_TYPE,
  KNOWN_OWNERS,
  TASK_TYPES,
  getAgent,
  bestAgentFor,
  classifyTask,
  registerAgent,
  unregisterAgent,
  resolvePhysicalAgent,
  listAgents,
  getPhysicalAgentNames,
  getAllAgentNames,
  _resetRegistry,
  initAgentRegistry,
} from '../lib/hydra-agents.mjs';
import { AFFINITY_PRESETS, loadHydraConfig, saveHydraConfig } from '../lib/hydra-config.mjs';

const CLOUD_AGENT_NAMES = ['claude', 'gemini', 'codex'];

// ── AGENTS registry (backward compat) ──────────────────────────────────────

test('AGENTS includes the cloud physical agents', () => {
  const keys = Object.keys(AGENTS);
  for (const name of CLOUD_AGENT_NAMES) {
    assert.ok(keys.includes(name), `AGENTS should include ${name}`);
  }
  assert.ok(keys.every((name) => getAgent(name)?.type === 'physical'));
});

test('AGENT_NAMES returns physical agents only', () => {
  const names = [...AGENT_NAMES];
  for (const name of CLOUD_AGENT_NAMES) {
    assert.ok(names.includes(name), `AGENT_NAMES should include ${name}`);
  }
  assert.ok(names.includes('local'), 'AGENT_NAMES should include local');
  assert.ok(names.every((name) => getAgent(name)?.type === 'physical'));
});

test('AGENT_NAMES.length is at least 3', () => {
  assert.ok(AGENT_NAMES.length >= 3);
});

test('AGENT_NAMES.includes works', () => {
  assert.ok(AGENT_NAMES.includes('claude'));
  assert.ok(AGENT_NAMES.includes('gemini'));
  assert.ok(AGENT_NAMES.includes('codex'));
  assert.ok(!AGENT_NAMES.includes('security-reviewer'));
});

test('KNOWN_OWNERS includes all agents plus human and unassigned', () => {
  for (const agent of AGENT_NAMES) {
    assert.ok(KNOWN_OWNERS.has(agent), `${agent} should be a known owner`);
  }
  assert.ok(KNOWN_OWNERS.has('human'));
  assert.ok(KNOWN_OWNERS.has('unassigned'));
});

test('TASK_TYPES has 10 types including new ones', () => {
  assert.equal(TASK_TYPES.length, 10);
  assert.ok(TASK_TYPES.includes('research'));
  assert.ok(TASK_TYPES.includes('documentation'));
  assert.ok(TASK_TYPES.includes('security'));
  // Original 7 still present
  for (const t of ['planning', 'architecture', 'review', 'refactor', 'implementation', 'analysis', 'testing']) {
    assert.ok(TASK_TYPES.includes(t), `${t} should be in TASK_TYPES`);
  }
});

// ── Agent structure ──────────────────────────────────────────────────────────

test('each physical agent has required fields', () => {
  for (const [name, agent] of Object.entries(AGENTS)) {
    assert.ok(agent.label, `${name} should have a label`);
    assert.ok(agent.invoke, `${name} should have invoke methods`);

    if (agent.cli === null) {
      assert.equal(name, 'local', 'only local should omit a CLI binary');
      assert.equal(agent.invoke.nonInteractive, null, `${name} should not expose nonInteractive invoke`);
      assert.equal(agent.invoke.interactive, null, `${name} should not expose interactive invoke`);
      assert.equal(agent.invoke.headless, null, `${name} should not expose headless invoke`);
    } else {
      assert.equal(typeof agent.cli, 'string', `${name} should have a cli command`);
      assert.equal(typeof agent.invoke.nonInteractive, 'function', `${name} should have nonInteractive invoke`);
      assert.equal(typeof agent.invoke.interactive, 'function', `${name} should have interactive invoke`);
      assert.equal(typeof agent.invoke.headless, 'function', `${name} should have headless invoke`);
    }

    assert.ok(typeof agent.contextBudget === 'number', `${name} should have contextBudget`);
    assert.ok(
      agent.contextTier === null || typeof agent.contextTier === 'string',
      `${name} should have a string or null contextTier`
    );
    assert.ok(Array.isArray(agent.strengths), `${name} should have strengths array`);
    assert.ok(Array.isArray(agent.weaknesses), `${name} should have weaknesses array`);
    if (agent.councilRole === null) {
      assert.equal(name, 'local', 'only local should omit a council role');
    } else {
      assert.ok(agent.councilRole, `${name} should have councilRole`);
    }
    assert.ok(agent.taskAffinity, `${name} should have taskAffinity`);
    assert.ok(agent.rolePrompt, `${name} should have rolePrompt`);
    assert.ok(typeof agent.timeout === 'number', `${name} should have timeout`);
    assert.equal(agent.type, 'physical', `${name} should be a physical agent`);
    assert.ok(Array.isArray(agent.tags), `${name} should have tags array`);
    assert.equal(agent.enabled, true, `${name} should be enabled`);
  }
});

test('all physical agents have affinity scores for all task types', () => {
  for (const [name, agent] of Object.entries(AGENTS)) {
    for (const taskType of TASK_TYPES) {
      const score = agent.taskAffinity[taskType];
      assert.ok(typeof score === 'number', `${name} should have affinity for ${taskType}`);
      assert.ok(score >= 0 && score <= 1, `${name}.taskAffinity.${taskType} should be 0-1, got ${score}`);
    }
  }
});

test('agent context tiers are assigned correctly', () => {
  assert.equal(AGENTS.claude.contextTier, 'medium');
  assert.equal(AGENTS.gemini.contextTier, 'large');
  assert.equal(AGENTS.codex.contextTier, 'minimal');
});

test('agent council roles are distinct', () => {
  const roles = [...AGENT_NAMES]
    .map((n) => getAgent(n).councilRole)
    .filter((role) => role !== null);
  assert.equal(new Set(roles).size, roles.length, 'Council roles should be unique');
});

// ── getAgent ─────────────────────────────────────────────────────────────────

test('getAgent returns agent config for known agents', () => {
  for (const name of AGENT_NAMES) {
    const agent = getAgent(name);
    assert.ok(agent, `getAgent(${name}) should return agent`);
    if (name === 'local') {
      assert.equal(agent.cli, null);
      assert.equal(agent.councilRole, null);
    } else {
      assert.equal(agent.cli, name === 'claude' ? 'claude' : name);
    }
  }
});

test('getAgent returns null for unknown agents', () => {
  assert.equal(getAgent('nonexistent'), null);
  assert.equal(getAgent(''), null);
  assert.equal(getAgent(null), null);
});

// ── bestAgentFor ─────────────────────────────────────────────────────────────

test('bestAgentFor returns correct agents for each task type', () => {
  assert.equal(bestAgentFor('planning'), 'claude');
  assert.equal(bestAgentFor('architecture'), 'claude');
  assert.equal(bestAgentFor('analysis'), 'gemini');
  assert.equal(bestAgentFor('review'), 'gemini');
  assert.equal(bestAgentFor('implementation'), 'codex');
  assert.equal(bestAgentFor('testing'), 'codex');
});

test('bestAgentFor returns a valid agent name for all task types', () => {
  for (const taskType of TASK_TYPES) {
    const agent = bestAgentFor(taskType);
    assert.ok(AGENT_NAMES.includes(agent), `${agent} should be a valid agent for ${taskType}`);
  }
});

// ── classifyTask ─────────────────────────────────────────────────────────────

test('classifyTask detects planning tasks', () => {
  assert.equal(classifyTask('Plan the new authentication system'), 'planning');
  assert.equal(classifyTask('Design a strategy for migration'), 'planning');
  assert.equal(classifyTask('Break down the refactoring work'), 'planning');
});

test('classifyTask detects review tasks', () => {
  assert.equal(classifyTask('Review the PR for login flow'), 'review');
  assert.equal(classifyTask('Check for memory leaks'), 'review');
});

test('classifyTask detects refactor tasks', () => {
  assert.equal(classifyTask('Refactor the auth module'), 'refactor');
  assert.equal(classifyTask('Rename the handler class'), 'refactor');
  assert.equal(classifyTask('Extract shared utilities'), 'refactor');
});

test('classifyTask detects testing tasks', () => {
  assert.equal(classifyTask('Write tests for the API'), 'testing');
  assert.equal(classifyTask('Add coverage for the utils module'), 'testing');
  assert.equal(classifyTask('Create test spec for validation'), 'testing');
});

test('classifyTask detects analysis tasks', () => {
  assert.equal(classifyTask('Analyze the performance bottleneck'), 'analysis');
  assert.equal(classifyTask('Find all usages of deprecated API'), 'analysis');
});

test('classifyTask detects architecture tasks', () => {
  assert.equal(classifyTask('Define the database schema migration'), 'architecture');
  assert.equal(classifyTask('Build the module structure layout'), 'architecture');
});

test('classifyTask detects new task types: research', () => {
  assert.equal(classifyTask('Research the best caching strategy'), 'research');
  assert.equal(classifyTask('Explore the codebase for patterns'), 'research');
  assert.equal(classifyTask('Investigate the memory leak'), 'research');
});

test('classifyTask detects new task types: documentation', () => {
  assert.equal(classifyTask('Document the API endpoints'), 'documentation');
  assert.equal(classifyTask('Write a README for the module'), 'documentation');
  assert.equal(classifyTask('Add JSDoc comments to utils'), 'documentation');
});

test('classifyTask detects new task types: security', () => {
  assert.equal(classifyTask('Security audit of the auth module'), 'security');
  assert.equal(classifyTask('Check for vulnerabilities in deps'), 'security');
  assert.equal(classifyTask('OWASP review of input handling'), 'security');
  assert.equal(classifyTask('Sanitize user inputs'), 'security');
});

test('classifyTask defaults to implementation', () => {
  assert.equal(classifyTask('Add the login button'), 'implementation');
  assert.equal(classifyTask('Build the new feature'), 'implementation');
  assert.equal(classifyTask('Random text with no signals'), 'implementation');
});

test('classifyTask uses notes for classification', () => {
  assert.equal(classifyTask('Do the thing', 'review all changes carefully'), 'review');
  assert.equal(classifyTask('Work on it', 'write comprehensive tests'), 'testing');
});

// ── invoke methods ───────────────────────────────────────────────────────────

test('claude invoke produces correct CLI args', () => {
  const [cmd, args] = AGENTS.claude.invoke.nonInteractive('hello world');
  assert.equal(cmd, 'claude');
  assert.ok(args.includes('-p'));
  assert.ok(args.includes('hello world'));
  assert.ok(args.includes('--output-format'));
});

test('gemini invoke produces correct CLI args', () => {
  const [cmd, args] = AGENTS.gemini.invoke.nonInteractive('test prompt');
  assert.equal(cmd, 'gemini');
  assert.ok(args.includes('-p'));
  assert.ok(args.includes('test prompt'));
});

test('codex invoke requires cwd option', () => {
  assert.throws(() => {
    AGENTS.codex.invoke.nonInteractive('test prompt');
  }, /cwd/i);
});

test('codex invoke produces correct CLI args with cwd', () => {
  const [cmd, args] = AGENTS.codex.invoke.nonInteractive('test prompt', { cwd: '/tmp/project' });
  assert.equal(cmd, 'codex');
  assert.ok(args.includes('exec'));
  assert.ok(args.includes('-C'));
  assert.ok(args.includes('/tmp/project'));
});

// ── Registry operations ──────────────────────────────────────────────────────

test('registerAgent registers a virtual agent', () => {
  const def = {
    type: 'virtual',
    baseAgent: 'claude',
    displayName: 'Test Virtual',
    rolePrompt: 'You are a test agent.',
    taskAffinity: { testing: 0.99 },
    tags: ['test'],
  };
  const entry = registerAgent('test-virtual', def);
  assert.equal(entry.name, 'test-virtual');
  assert.equal(entry.type, 'virtual');
  assert.equal(entry.baseAgent, 'claude');
  assert.equal(entry.enabled, true);

  // Should be gettable
  const got = getAgent('test-virtual');
  assert.ok(got);
  assert.equal(got.displayName, 'Test Virtual');

  // Clean up
  unregisterAgent('test-virtual');
});

test('registerAgent rejects invalid names', () => {
  assert.throws(() => registerAgent('', { type: 'physical' }), /non-empty/);
  assert.throws(() => registerAgent('Has Spaces', { type: 'physical' }), /lowercase/);
  assert.throws(() => registerAgent('123start', { type: 'physical' }), /lowercase/);
});

test('registerAgent rejects virtual agent without baseAgent', () => {
  assert.throws(() => registerAgent('bad-virtual', { type: 'virtual' }), /baseAgent/);
});

test('registerAgent rejects virtual agent with unknown baseAgent', () => {
  assert.throws(() => registerAgent('bad-virtual', { type: 'virtual', baseAgent: 'nonexistent' }), /unknown baseAgent/);
});

test('unregisterAgent removes virtual agents', () => {
  registerAgent('temp-agent', { type: 'virtual', baseAgent: 'gemini', rolePrompt: 'temp' });
  assert.ok(getAgent('temp-agent'));
  const removed = unregisterAgent('temp-agent');
  assert.equal(removed, true);
  assert.equal(getAgent('temp-agent'), null);
});

test('unregisterAgent refuses to remove built-in physical agents', () => {
  assert.throws(() => unregisterAgent('claude'), /Cannot unregister/);
  assert.throws(() => unregisterAgent('gemini'), /Cannot unregister/);
  assert.throws(() => unregisterAgent('codex'), /Cannot unregister/);
  assert.throws(() => unregisterAgent('local'), /Cannot unregister/);
});

test('unregisterAgent returns false for unknown agents', () => {
  assert.equal(unregisterAgent('does-not-exist'), false);
});

// ── resolvePhysicalAgent ─────────────────────────────────────────────────────

test('resolvePhysicalAgent returns physical agent for physical names', () => {
  for (const name of [...CLOUD_AGENT_NAMES, 'local']) {
    const resolved = resolvePhysicalAgent(name);
    assert.ok(resolved);
    assert.equal(resolved.name, name);
    assert.equal(resolved.type, 'physical');
  }
});

test('resolvePhysicalAgent follows virtual → physical chain', () => {
  registerAgent('chain-test', { type: 'virtual', baseAgent: 'gemini', rolePrompt: 'test' });
  const resolved = resolvePhysicalAgent('chain-test');
  assert.ok(resolved);
  assert.equal(resolved.name, 'gemini');
  assert.equal(resolved.type, 'physical');
  unregisterAgent('chain-test');
});

test('resolvePhysicalAgent returns null for unknown agents', () => {
  assert.equal(resolvePhysicalAgent('unknown'), null);
  assert.equal(resolvePhysicalAgent(null), null);
});

// ── listAgents ───────────────────────────────────────────────────────────────

test('listAgents returns all agents when no filter', () => {
  const all = listAgents();
  assert.ok(all.length >= 4, 'Should have at least 4 physical agents');
  const names = all.map((a) => a.name);
  assert.ok(names.includes('claude'));
  assert.ok(names.includes('gemini'));
  assert.ok(names.includes('codex'));
  assert.ok(names.includes('local'));
});

test('listAgents filters by type', () => {
  const physical = listAgents({ type: 'physical' });
  assert.ok(physical.length >= 4);
  for (const a of physical) assert.equal(a.type, 'physical');
  assert.ok(physical.some((agent) => agent.name === 'local'));

  // Register a virtual and check
  registerAgent('filter-test', { type: 'virtual', baseAgent: 'claude', rolePrompt: 'test' });
  const virtual = listAgents({ type: 'virtual' });
  assert.ok(virtual.length >= 1);
  for (const a of virtual) assert.equal(a.type, 'virtual');
  unregisterAgent('filter-test');
});

test('listAgents filters by enabled', () => {
  registerAgent('disabled-test', { type: 'virtual', baseAgent: 'claude', rolePrompt: 'test', enabled: false });
  const enabled = listAgents({ enabled: true });
  assert.ok(!enabled.find((a) => a.name === 'disabled-test'));
  const disabled = listAgents({ enabled: false });
  assert.ok(disabled.find((a) => a.name === 'disabled-test'));
  unregisterAgent('disabled-test');
});

// ── getPhysicalAgentNames / getAllAgentNames ──────────────────────────────────

test('getPhysicalAgentNames returns only physical agents', () => {
  const names = getPhysicalAgentNames();
  for (const name of [...CLOUD_AGENT_NAMES, 'local']) {
    assert.ok(names.includes(name), `physical agent names should include ${name}`);
  }
  assert.ok(names.every((name) => getAgent(name)?.type === 'physical'));
});

test('getAllAgentNames includes virtual agents when registered', () => {
  registerAgent('all-names-test', { type: 'virtual', baseAgent: 'codex', rolePrompt: 'test' });
  const all = getAllAgentNames();
  assert.ok(all.includes('claude'));
  assert.ok(all.includes('all-names-test'));
  unregisterAgent('all-names-test');
});

// ── bestAgentFor with virtual agents ─────────────────────────────────────────

test('bestAgentFor with includeVirtual returns virtual agents when they score highest', () => {
  registerAgent('super-tester', {
    type: 'virtual',
    baseAgent: 'codex',
    rolePrompt: 'You are the ultimate test specialist.',
    taskAffinity: { testing: 0.999 },
  });
  // Without includeVirtual: physical agents only
  const physicalBest = bestAgentFor('testing', { includeVirtual: false });
  assert.equal(physicalBest, 'codex');

  // With includeVirtual: should return the virtual agent
  const virtualBest = bestAgentFor('testing', { includeVirtual: true });
  assert.equal(virtualBest, 'super-tester');

  unregisterAgent('super-tester');
});

// ── KNOWN_OWNERS dynamic ─────────────────────────────────────────────────────

test('KNOWN_OWNERS includes virtual agents after registration', () => {
  registerAgent('owner-test', { type: 'virtual', baseAgent: 'claude', rolePrompt: 'test' });
  assert.ok(KNOWN_OWNERS.has('owner-test'));
  unregisterAgent('owner-test');
});

// ── AGENT_TYPE enum ──────────────────────────────────────────────────────────

test('AGENT_TYPE has PHYSICAL and VIRTUAL', () => {
  assert.equal(AGENT_TYPE.PHYSICAL, 'physical');
  assert.equal(AGENT_TYPE.VIRTUAL, 'virtual');
});

// ── AFFINITY_PRESETS ─────────────────────────────────────────────────────────

test('AFFINITY_PRESETS exports balanced, code-focused, review-focused, research-focused', () => {
  const keys = Object.keys(AFFINITY_PRESETS);
  assert.ok(keys.includes('balanced'), 'should have balanced preset');
  assert.ok(keys.includes('code-focused'), 'should have code-focused preset');
  assert.ok(keys.includes('review-focused'), 'should have review-focused preset');
  assert.ok(keys.includes('research-focused'), 'should have research-focused preset');
});

test('each AFFINITY_PRESETS entry covers all 10 task types with numbers', () => {
  for (const [presetName, affinity] of Object.entries(AFFINITY_PRESETS)) {
    for (const tt of TASK_TYPES) {
      assert.strictEqual(typeof affinity[tt], 'number', `preset "${presetName}" missing task type: ${tt}`);
    }
  }
});

// ── Custom physical agents (CLI + API) ────────────────────────────────────────

import { describe, it, beforeEach, afterEach } from 'node:test';

describe('initAgentRegistry — custom physical agents', () => {
  let originalAgentsCfg;

  beforeEach(() => {
    const cfg = loadHydraConfig();
    originalAgentsCfg = cfg.agents;
    saveHydraConfig({
      agents: {
        ...cfg.agents,
        customAgents: [
          {
            name: 'test-cli-agent',
            type: 'cli',
            displayName: 'Test CLI',
            invoke: {
              nonInteractive: { cmd: 'echo', args: ['{prompt}'] },
              headless: { cmd: 'echo', args: ['{prompt}'] },
            },
            responseParser: 'plaintext',
            contextBudget: 16000,
            councilRole: null,
            taskAffinity: {
              implementation: 0.70, review: 0.40, research: 0.00,
              planning: 0.30, architecture: 0.25, refactor: 0.60,
              analysis: 0.40, testing: 0.55, security: 0.30, documentation: 0.40,
            },
            enabled: true,
          },
          {
            name: 'test-api-agent',
            type: 'api',
            displayName: 'Test API',
            baseUrl: 'http://localhost:9999/v1',
            model: 'test-model',
            contextBudget: 8000,
            councilRole: null,
            taskAffinity: {
              implementation: 0.80, review: 0.50, research: 0.00,
              planning: 0.35, architecture: 0.30, refactor: 0.75,
              analysis: 0.45, testing: 0.65, security: 0.25, documentation: 0.45,
            },
            enabled: true,
          },
        ],
      },
    });
    _resetRegistry();
    initAgentRegistry();
  });

  afterEach(() => {
    saveHydraConfig({ agents: originalAgentsCfg });
    _resetRegistry();
    initAgentRegistry();
  });

  it('registers custom CLI agent from customAgents config', () => {
    const agent = getAgent('test-cli-agent');
    assert.ok(agent, 'test-cli-agent should be in registry');
    assert.strictEqual(agent.type, 'physical');
    assert.strictEqual(agent.customType, 'cli');
    assert.strictEqual(agent.displayName, 'Test CLI');
  });

  it('registers custom API agent from customAgents config', () => {
    const agent = getAgent('test-api-agent');
    assert.ok(agent, 'test-api-agent should be in registry');
    assert.strictEqual(agent.type, 'physical');
    assert.strictEqual(agent.customType, 'api');
  });

  it('custom agents appear in listAgents({ type: "physical" })', () => {
    const names = listAgents({ type: 'physical' }).map(a => a.name);
    assert.ok(names.includes('test-cli-agent'), 'test-cli-agent should be listed');
    assert.ok(names.includes('test-api-agent'), 'test-api-agent should be listed');
  });

  it('built-in agents are still registered after loading custom agents', () => {
    assert.ok(getAgent('claude'), 'claude should still be registered');
    assert.ok(getAgent('gemini'), 'gemini should still be registered');
    assert.ok(getAgent('codex'), 'codex should still be registered');
  });

  it('entry with invalid type is silently skipped', () => {
    // The beforeEach fixture only has valid entries, so we add a bad one inline
    const cfg = loadHydraConfig();
    const withBadEntry = [
      ...(cfg.agents?.customAgents || []),
      { name: 'bad-type-agent', type: 'invalid', displayName: 'Bad' },
    ];
    saveHydraConfig({ agents: { ...cfg.agents, customAgents: withBadEntry } });
    _resetRegistry();
    initAgentRegistry();

    assert.equal(getAgent('bad-type-agent'), null, 'invalid type should be silently skipped');
    // Cleanup (afterEach will also restore, but be explicit)
    saveHydraConfig({ agents: cfg.agents });
    _resetRegistry();
    initAgentRegistry();
  });
});
