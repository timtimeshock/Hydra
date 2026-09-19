/**
 * Tests for hydra-doctor.mjs — failure diagnosis and triage layer.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  initDoctor,
  isDoctorEnabled,
  diagnose,
  getDoctorStats,
  resetDoctor,
} from '../lib/hydra-doctor.mjs';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeFailure(overrides = {}) {
  return {
    pipeline: 'evolve',
    phase: 'agent',
    agent: 'codex',
    error: 'Agent process exited with code 1',
    stderr: 'Error: something went wrong',
    stdout: '',
    timedOut: false,
    taskTitle: 'test task',
    branchName: 'evolve/test',
    context: '',
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('hydra-doctor', () => {
  beforeEach(() => {
    resetDoctor();
  });

  afterEach(() => {
    resetDoctor();
  });

  describe('isDoctorEnabled()', () => {
    it('returns true by default', () => {
      assert.ok(isDoctorEnabled());
    });
  });

  describe('getDoctorStats()', () => {
    it('returns zero counts initially', () => {
      const stats = getDoctorStats();
      assert.equal(stats.total, 0);
      assert.equal(stats.fixes, 0);
      assert.equal(stats.tickets, 0);
      assert.equal(stats.investigations, 0);
      assert.equal(stats.ignored, 0);
    });
  });

  describe('diagnose()', () => {
    it('ignores rate limit errors', async () => {
      const result = await diagnose(makeFailure({
        error: '429 Too Many Requests',
        stderr: 'rate limit exceeded',
      }));

      assert.equal(result.action, 'ignore');
      assert.equal(result.rootCause, 'rate_limit');
      assert.equal(result.severity, 'low');

      const stats = getDoctorStats();
      assert.equal(stats.total, 1);
      assert.equal(stats.ignored, 1);
    });

    it('ignores RESOURCE_EXHAUSTED errors', async () => {
      const result = await diagnose(makeFailure({
        error: 'RESOURCE_EXHAUSTED: quota exceeded',
      }));

      assert.equal(result.action, 'ignore');
      assert.equal(result.rootCause, 'rate_limit');
    });

    it('produces a valid diagnosis for non-rate-limit failures', async () => {
      const result = await diagnose(makeFailure({
        error: 'Segmentation fault in agent subprocess',
      }));

      // The action depends on whether the investigator is available,
      // but it must be one of the valid actions
      assert.ok(['ignore', 'fix', 'ticket'].includes(result.action));
      assert.ok(['low', 'medium', 'high', 'critical'].includes(result.severity));
      assert.ok(typeof result.explanation === 'string');
      assert.ok(typeof result.rootCause === 'string');

      const stats = getDoctorStats();
      assert.equal(stats.total, 1);
    });

    it('handles timeout failures', async () => {
      // Use unique error to avoid matching stale log entries
      const result = await diagnose(makeFailure({
        timedOut: true,
        error: `Timeout ${Date.now()}-${Math.random().toString(36).slice(2)}`,
      }));

      // Timeouts can be transient (ignore) or escalated if recurring
      assert.ok(['ignore', 'ticket'].includes(result.action));
      assert.ok(typeof result.rootCause === 'string');
      assert.equal(result.recurring, false);
    });

    it('increments total stat across multiple calls', async () => {
      // Rate limit → always ignored
      await diagnose(makeFailure({ error: '429 rate limit' }));
      // Unknown error → depends on investigator
      await diagnose(makeFailure({ error: 'mystery error XYZ' }));
      // Timeout → depends on investigator
      await diagnose(makeFailure({ timedOut: true, error: 'timeout' }));

      const stats = getDoctorStats();
      assert.equal(stats.total, 3);
      // At minimum, the rate limit one was ignored
      assert.ok(stats.ignored >= 1, 'at least the rate limit should be ignored');
      // Total actions should sum to total
      assert.equal(stats.fixes + stats.tickets + stats.ignored, stats.total);
    });

    it('detects recurring patterns and escalates', async () => {
      // Create identical failures to trigger recurring detection
      // Default recurringThreshold is 3
      // Use a truly unique error string with timestamp to avoid matching stale log entries
      const uniqueError = `Recurrence test ${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const failure = makeFailure({
        error: uniqueError,
        timedOut: true,  // Use timeout so investigator short-circuits (fast)
      });

      // First three build up history
      const r1 = await diagnose(failure);
      assert.equal(r1.recurring, false);
      const r2 = await diagnose(failure);
      assert.equal(r2.recurring, false);
      const r3 = await diagnose(failure);
      assert.equal(r3.recurring, false);

      // Fourth sees 3 prior matching entries → recurring
      const r4 = await diagnose(failure);
      assert.equal(r4.recurring, true);
      // Recurring should escalate — not ignore
      assert.ok(['ticket', 'fix'].includes(r4.action), `recurring should escalate, got: ${r4.action}`);
    });

    it('returns a well-shaped diagnosis object', async () => {
      const result = await diagnose(makeFailure());

      assert.ok('severity' in result);
      assert.ok('action' in result);
      assert.ok('explanation' in result);
      assert.ok('rootCause' in result);
      assert.ok('followUp' in result);
      assert.ok('investigatorDiagnosis' in result);
      assert.ok('recurring' in result);

      assert.ok(['low', 'medium', 'high', 'critical'].includes(result.severity));
      assert.ok(['ignore', 'fix', 'ticket'].includes(result.action));
    });
  });

  describe('resetDoctor()', () => {
    it('clears session stats', async () => {
      await diagnose(makeFailure({ error: '429 rate limit' }));
      assert.equal(getDoctorStats().total, 1);

      resetDoctor();
      assert.equal(getDoctorStats().total, 0);
    });
  });
});
