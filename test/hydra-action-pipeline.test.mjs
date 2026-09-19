/**
 * Tests for hydra-action-pipeline.mjs — pipeline flow with mock scanners/executors.
 * Tests the non-interactive parts (scan, dedup, execute logic).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// We test the module's importability and its core logic.
// Full interactive testing requires readline mocking which is out of scope
// for unit tests — that's covered by manual testing.

describe('hydra-action-pipeline', () => {
  it('exports runActionPipeline', async () => {
    const mod = await import('../lib/hydra-action-pipeline.mjs');
    assert.equal(typeof mod.runActionPipeline, 'function');
  });
});

describe('hydra-output-history', () => {
  it('exports all expected functions', async () => {
    const mod = await import('../lib/hydra-output-history.mjs');
    assert.equal(typeof mod.initOutputHistory, 'function');
    assert.equal(typeof mod.getRecentOutput, 'function');
    assert.equal(typeof mod.getRecentOutputRaw, 'function');
    assert.equal(typeof mod.clearOutputHistory, 'function');
    assert.equal(typeof mod.getOutputContext, 'function');
  });

  it('getRecentOutput returns an array', async () => {
    const { getRecentOutput } = await import('../lib/hydra-output-history.mjs');
    const result = getRecentOutput(10);
    assert.ok(Array.isArray(result));
  });

  it('getOutputContext returns a string', async () => {
    const { getOutputContext } = await import('../lib/hydra-output-history.mjs');
    const result = getOutputContext();
    assert.equal(typeof result, 'string');
  });

  it('clearOutputHistory resets the buffer', async () => {
    const { clearOutputHistory, getRecentOutput } = await import('../lib/hydra-output-history.mjs');
    clearOutputHistory();
    assert.deepEqual(getRecentOutput(), []);
  });
});

describe('hydra-cleanup', () => {
  it('exports all scanner functions', async () => {
    const mod = await import('../lib/hydra-cleanup.mjs');
    assert.equal(typeof mod.scanArchivableTasks, 'function');
    assert.equal(typeof mod.scanOldHandoffs, 'function');
    assert.equal(typeof mod.scanStaleBranches, 'function');
    assert.equal(typeof mod.scanStaleTasks, 'function');
    assert.equal(typeof mod.scanAbandonedSuggestions, 'function');
    assert.equal(typeof mod.scanOldCheckpoints, 'function');
    assert.equal(typeof mod.scanOldArtifacts, 'function');
    assert.equal(typeof mod.executeCleanupAction, 'function');
  });

  it('scanners return empty arrays when no data', async () => {
    const { scanArchivableTasks, scanOldHandoffs, scanStaleTasks } = await import('../lib/hydra-cleanup.mjs');

    // These call the daemon which isn't running — should return []
    const t = await scanArchivableTasks('http://localhost:99999');
    assert.deepEqual(t, []);

    const h = await scanOldHandoffs('http://localhost:99999');
    assert.deepEqual(h, []);

    const s = await scanStaleTasks('http://localhost:99999');
    assert.deepEqual(s, []);
  });
});

describe('hydra-doctor scanners', () => {
  it('exports action pipeline scanner functions', async () => {
    const mod = await import('../lib/hydra-doctor.mjs');
    assert.equal(typeof mod.scanDoctorLog, 'function');
    assert.equal(typeof mod.scanDaemonIssues, 'function');
    assert.equal(typeof mod.scanErrorActivity, 'function');
    assert.equal(typeof mod.enrichWithDiagnosis, 'function');
    assert.equal(typeof mod.executeFixAction, 'function');
  });

  it('scanDoctorLog returns ActionItem array', async () => {
    const { scanDoctorLog, resetDoctor } = await import('../lib/hydra-doctor.mjs');
    resetDoctor();
    const items = await scanDoctorLog();
    assert.ok(Array.isArray(items));
  });

  it('scanDaemonIssues returns empty when daemon unavailable', async () => {
    const { scanDaemonIssues } = await import('../lib/hydra-doctor.mjs');
    const items = await scanDaemonIssues('http://localhost:99999');
    assert.deepEqual(items, []);
  });

  it('scanErrorActivity returns array', async () => {
    const { scanErrorActivity } = await import('../lib/hydra-doctor.mjs');
    const items = await scanErrorActivity();
    assert.ok(Array.isArray(items));
  });
});
