import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';

import {
  TASK_TYPES,
  bestAgentFor,
  getAgent,
  initAgentRegistry,
  listAgents,
  unregisterAgent,
  _resetRegistry,
} from '../lib/hydra-agents.mjs';

const ROUTING_MODES = ['economy', 'balanced', 'performance'];

beforeEach(() => {
  _resetRegistry();
  initAgentRegistry();
});

after(() => {
  _resetRegistry();
  initAgentRegistry();
});

describe('local physical agent registration', () => {
  test('listAgents includes local after initAgentRegistry()', () => {
    const agents = listAgents();
    const local = agents.find((agent) => agent.name === 'local');

    assert.ok(local, 'local should be registered after initAgentRegistry()');
    assert.equal(local.type, 'physical');
    assert.equal(local.enabled, true);
  });

  test('getAgent exposes local as a built-in physical agent without a CLI or council role', () => {
    const local = getAgent('local');

    assert.ok(local);
    assert.equal(local.name, 'local');
    assert.equal(local.type, 'physical');
    assert.equal(local.cli, null);
    assert.equal(local.councilRole, null);
    assert.deepEqual(local.invoke, {
      nonInteractive: null,
      interactive: null,
      headless: null,
    });
  });

  test('unregisterAgent rejects local because it is a built-in physical agent', () => {
    assert.throws(() => unregisterAgent('local'), /Cannot unregister built-in physical agent "local"/);
  });
});

describe('bestAgentFor mode-aware routing', () => {
  test('returns a registered agent name for every task type in every mode', () => {
    const registeredAgents = new Set(listAgents().map((agent) => agent.name));

    for (const taskType of TASK_TYPES) {
      for (const mode of ROUTING_MODES) {
        const agent = bestAgentFor(taskType, { mode });
        assert.ok(registeredAgents.has(agent), `${agent} should be registered for ${taskType} in ${mode} mode`);
      }
    }
  });

  test('economy mode routes implementation work to local', () => {
    assert.equal(bestAgentFor('implementation', { mode: 'economy' }), 'local');
  });

  test('balanced mode keeps codex ahead of local for implementation work', () => {
    assert.equal(bestAgentFor('implementation', { mode: 'balanced' }), 'codex');
  });

  test('performance mode penalizes local for implementation work', () => {
    assert.equal(bestAgentFor('implementation', { mode: 'performance' }), 'codex');
  });

  test('research affinity of zero keeps local out of research routing in every mode', () => {
    const local = getAgent('local');
    assert.ok(local);
    assert.equal(local.taskAffinity.research, 0);

    for (const mode of ROUTING_MODES) {
      assert.notEqual(
        bestAgentFor('research', { mode }),
        'local',
        `local must not win research in ${mode} mode`
      );
    }
  });

  test('budget gating can boost local in balanced mode without overriding research exclusion', () => {
    const budgetState = {
      daily: { percentUsed: 81 },
      weekly: { percentUsed: 10 },
    };

    assert.equal(bestAgentFor('implementation', { mode: 'balanced', budgetState }), 'local');
    assert.notEqual(bestAgentFor('research', { mode: 'balanced', budgetState }), 'local');
  });
});
