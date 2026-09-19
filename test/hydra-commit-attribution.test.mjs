/**
 * Tests for commit attribution — safety prompt trailers and stageAndCommit opts.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { buildSafetyPrompt } from '../lib/hydra-shared/guardrails.mjs';
import { stageAndCommit, git } from '../lib/hydra-shared/git-ops.mjs';

// ── buildSafetyPrompt attribution tests ─────────────────────────────────────

describe('buildSafetyPrompt — attribution', () => {
  const baseOpts = {
    runner: 'test runner',
    reportName: 'test report',
    protectedFiles: new Set(['README.md']),
    blockedCommands: ['rm -rf /'],
  };

  it('includes Originated-By and Executed-By when attribution is provided', () => {
    const result = buildSafetyPrompt('test-branch', {
      ...baseOpts,
      attribution: { pipeline: 'hydra-evolve', agent: 'codex' },
    });

    assert.ok(result.includes('### Commit Attribution'), 'should have attribution section');
    assert.ok(result.includes('Originated-By: hydra-evolve'), 'should include pipeline trailer');
    assert.ok(result.includes('Executed-By: codex'), 'should include agent trailer');
  });

  it('includes only Originated-By when agent is not provided', () => {
    const result = buildSafetyPrompt('test-branch', {
      ...baseOpts,
      attribution: { pipeline: 'hydra-nightly' },
    });

    assert.ok(result.includes('Originated-By: hydra-nightly'));
    assert.ok(!result.includes('Executed-By:'), 'should not include Executed-By without agent');
  });

  it('omits attribution section when attribution is not provided', () => {
    const result = buildSafetyPrompt('test-branch', baseOpts);

    assert.ok(!result.includes('### Commit Attribution'), 'should not have attribution section');
    assert.ok(!result.includes('Originated-By:'), 'should not include trailers');
  });

  it('still includes all other safety sections', () => {
    const result = buildSafetyPrompt('test-branch', {
      ...baseOpts,
      attribution: { pipeline: 'hydra-tasks', agent: 'gemini' },
    });

    assert.ok(result.includes('### Branch Isolation'));
    assert.ok(result.includes('### Protected Files'));
    assert.ok(result.includes('### Blocked Commands'));
    assert.ok(result.includes('### Scope'));
    assert.ok(result.includes('### Commit Attribution'));
  });

  it('includes doc-update requirement in scope section', () => {
    const result = buildSafetyPrompt('test-branch', {
      runner: 'test-runner',
      reportName: 'test-report',
      protectedFiles: new Set([]),
      blockedCommands: [],
    });
    assert.ok(
      result.includes('verify that README.md'),
      'scope should contain the doc-update verification instruction'
    );
    assert.ok(
      result.includes('docs/ARCHITECTURE.md'),
      'scope should mention docs/ARCHITECTURE.md'
    );
  });
});

// ── stageAndCommit trailer tests ────────────────────────────────────────────

describe('stageAndCommit — trailers', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-attr-test-'));
    // Init a git repo
    git(['init'], tmpDir);
    git(['config', 'user.email', 'test@test.com'], tmpDir);
    git(['config', 'user.name', 'Test'], tmpDir);
    // Initial commit so we have a HEAD
    fs.writeFileSync(path.join(tmpDir, 'init.txt'), 'init');
    git(['add', '-A'], tmpDir);
    git(['commit', '-m', 'init'], tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appends trailers when originatedBy and executedBy are provided', () => {
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'content');
    const ok = stageAndCommit(tmpDir, 'test commit', {
      originatedBy: 'hydra-evolve',
      executedBy: 'codex',
    });

    assert.ok(ok, 'commit should succeed');

    const log = git(['log', '-1', '--format=%B'], tmpDir);
    const msg = (log.stdout || '').trim();
    assert.ok(msg.includes('test commit'), 'message body present');
    assert.ok(msg.includes('Originated-By: hydra-evolve'), 'pipeline trailer present');
    assert.ok(msg.includes('Executed-By: codex'), 'agent trailer present');
  });

  it('appends only originatedBy when executedBy is omitted', () => {
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'v2');
    const ok = stageAndCommit(tmpDir, 'partial trailer', {
      originatedBy: 'hydra-nightly',
    });

    assert.ok(ok);
    const log = git(['log', '-1', '--format=%B'], tmpDir);
    const msg = (log.stdout || '').trim();
    assert.ok(msg.includes('Originated-By: hydra-nightly'));
    assert.ok(!msg.includes('Executed-By:'));
  });

  it('works without opts (backward-compatible)', () => {
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'v3');
    const ok = stageAndCommit(tmpDir, 'no trailers');

    assert.ok(ok);
    const log = git(['log', '-1', '--format=%B'], tmpDir);
    const msg = (log.stdout || '').trim();
    assert.equal(msg, 'no trailers');
    assert.ok(!msg.includes('Originated-By:'));
  });
});
