import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('hydra-local', () => {
  it('exports streamLocalCompletion', async () => {
    const mod = await import('../lib/hydra-local.mjs');
    assert.strictEqual(typeof mod.streamLocalCompletion, 'function');
  });

  it('returns local-unavailable on ECONNREFUSED', async () => {
    const { streamLocalCompletion } = await import('../lib/hydra-local.mjs');
    // Port 19999 is almost certainly unused
    const result = await streamLocalCompletion(
      [{ role: 'user', content: 'hello' }],
      { model: 'test', baseUrl: 'http://localhost:19999/v1' }
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCategory, 'local-unavailable');
    assert.strictEqual(result.output, '');
  });
});

describe('local agent registration', () => {
  it('local agent appears in registry after initAgentRegistry()', async () => {
    const { initAgentRegistry, listAgents, _resetRegistry } = await import('../lib/hydra-agents.mjs');
    _resetRegistry();
    initAgentRegistry();
    const agents = listAgents();
    assert.ok(agents.some(a => a.name === 'local'), 'local agent should be in registry');
  });

  it('local agent is enabled', async () => {
    const { listAgents } = await import('../lib/hydra-agents.mjs');
    const agents = listAgents();
    const local = agents.find(a => a.name === 'local');
    assert.ok(local, 'local agent should exist');
    assert.strictEqual(local.enabled, true);
  });

  it('local agent has research affinity of 0 (hard excluded)', async () => {
    const { listAgents } = await import('../lib/hydra-agents.mjs');
    const agents = listAgents();
    const local = agents.find(a => a.name === 'local');
    assert.strictEqual(local.taskAffinity.research, 0.00);
  });

  it('bestAgentFor returns local for implementation in economy mode', async () => {
    const { bestAgentFor } = await import('../lib/hydra-agents.mjs');
    const agent = bestAgentFor('implementation', { mode: 'economy' });
    assert.strictEqual(agent, 'local');
  });

  it('bestAgentFor does NOT return local for planning even in economy mode', async () => {
    const { bestAgentFor } = await import('../lib/hydra-agents.mjs');
    const agent = bestAgentFor('planning', { mode: 'economy' });
    assert.notStrictEqual(agent, 'local');
  });

  it('bestAgentFor never returns local for research in any mode', async () => {
    const { bestAgentFor } = await import('../lib/hydra-agents.mjs');
    for (const mode of ['economy', 'balanced', 'performance']) {
      const agent = bestAgentFor('research', { mode });
      assert.notStrictEqual(agent, 'local', `local must not win research in ${mode} mode`);
    }
  });

  it('bestAgentFor returns cloud agent for implementation in balanced mode', async () => {
    const { bestAgentFor } = await import('../lib/hydra-agents.mjs');
    const agent = bestAgentFor('implementation', { mode: 'balanced' });
    // In balanced mode, local gets no boost: local=0.82 vs codex=0.85 → codex wins
    assert.notStrictEqual(agent, 'local');
  });
});
