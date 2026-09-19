import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { after, before, beforeEach, describe, test } from 'node:test';

import {
  _resetRegistry,
  bestAgentFor,
  getAgent,
  initAgentRegistry,
  listAgents,
  unregisterAgent,
} from '../lib/hydra-agents.mjs';
import { createMockExecuteAgent, loadAgentFixture } from './helpers/mock-agent.mjs';

const require = createRequire(import.meta.url);
const fsModule = require('node:fs');
const childProcess = require('node:child_process');

const ROUTING_MODES = ['economy', 'balanced', 'performance'];

let mockExecuteAgent;

before(async () => {
  const [claudeFixtures, geminiFixtures, codexFixtures] = await Promise.all([
    loadAgentFixture('claude'),
    loadAgentFixture('gemini'),
    loadAgentFixture('codex'),
  ]);

  mockExecuteAgent = createMockExecuteAgent({
    claude: claudeFixtures,
    gemini: geminiFixtures,
    codex: codexFixtures,
  });
});

beforeEach(() => {
  _resetRegistry();
  initAgentRegistry();
});

after(() => {
  _resetRegistry();
  initAgentRegistry();
});

describe('mock agent isolation', () => {
  test('mockExecuteAgent stays fully in-process after fixtures are loaded', async () => {
    const activity = [];
    const originalReadFile = fsModule.promises.readFile;
    const originalReadFileSync = fsModule.readFileSync;
    const originalSpawn = childProcess.spawn;
    const originalSpawnSync = childProcess.spawnSync;

    fsModule.promises.readFile = async (...args) => {
      activity.push({ method: 'readFile', args });
      throw new Error('Unexpected fs.promises.readFile during mock execution');
    };
    fsModule.readFileSync = (...args) => {
      activity.push({ method: 'readFileSync', args });
      throw new Error('Unexpected fs.readFileSync during mock execution');
    };
    childProcess.spawn = (...args) => {
      activity.push({ method: 'spawn', args });
      throw new Error('Unexpected child_process.spawn during mock execution');
    };
    childProcess.spawnSync = (...args) => {
      activity.push({ method: 'spawnSync', args });
      throw new Error('Unexpected child_process.spawnSync during mock execution');
    };

    try {
      const fallbackResult = await mockExecuteAgent('claude', 'unmatched prompt for default fixture', {});
      const matchedResult = await mockExecuteAgent('codex', 'implement the feature', { cwd: process.cwd() });

      assert.equal(fallbackResult.ok, true);
      assert.equal(matchedResult.ok, true);
      assert.match(fallbackResult.output, /default summary/i);
      assert.match(matchedResult.output, /implementation result/i);
    } finally {
      fsModule.promises.readFile = originalReadFile;
      fsModule.readFileSync = originalReadFileSync;
      childProcess.spawn = originalSpawn;
      childProcess.spawnSync = originalSpawnSync;
    }

    assert.deepEqual(activity, [], 'mock execution must not perform file I/O or spawn processes');
  });
});

describe('local agent routing contract', () => {
  test('initAgentRegistry exposes local alongside the cloud physical agents', () => {
    const physicalAgentNames = new Set(listAgents({ type: 'physical' }).map((agent) => agent.name));

    for (const agentName of ['claude', 'gemini', 'codex', 'local']) {
      assert.ok(physicalAgentNames.has(agentName), `physical agents should include ${agentName}`);
    }

    const local = getAgent('local');
    assert.ok(local);
    assert.equal(local.cli, null);
    assert.equal(local.councilRole, null);
  });

  test('implementation routing follows the documented mode policy without budget pressure', () => {
    assert.equal(bestAgentFor('implementation', { mode: 'economy' }), 'local');
    assert.equal(bestAgentFor('implementation', { mode: 'balanced' }), 'codex');
    assert.notEqual(bestAgentFor('implementation', { mode: 'performance' }), 'local');
  });

  test('budget gating promotes local implementation work without ever routing research to local', () => {
    const budgetState = {
      daily: { percentUsed: 95 },
      weekly: { percentUsed: 95 },
    };

    assert.equal(bestAgentFor('implementation', { mode: 'balanced', budgetState }), 'local');

    for (const mode of ROUTING_MODES) {
      assert.notEqual(
        bestAgentFor('research', { mode, budgetState }),
        'local',
        `research must not route to local in ${mode} mode under budget pressure`
      );
    }
  });

  test('local remains a built-in physical agent and cannot be unregistered', () => {
    assert.throws(() => unregisterAgent('local'), /Cannot unregister built-in physical agent "local"/);
  });
});
