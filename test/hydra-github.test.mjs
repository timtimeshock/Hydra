import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  gh,
  isGhAvailable,
  isGhAuthenticated,
  detectRepo,
  createPR,
  listPRs,
  getPR,
  mergePR,
  closePR,
  getGitHubConfig,
  pushBranchAndCreatePR,
} from '../lib/hydra-github.mjs';
import { parseRemoteUrl } from '../lib/hydra-shared/git-ops.mjs';

// ── parseRemoteUrl ──────────────────────────────────────────────────────────

describe('parseRemoteUrl', () => {
  it('parses SSH URLs', () => {
    const result = parseRemoteUrl('git@github.com:owner/repo.git');
    assert.deepStrictEqual(result, { host: 'github.com', owner: 'owner', repo: 'repo' });
  });

  it('parses SSH URLs without .git suffix', () => {
    const result = parseRemoteUrl('git@github.com:myorg/myrepo');
    assert.deepStrictEqual(result, { host: 'github.com', owner: 'myorg', repo: 'myrepo' });
  });

  it('parses HTTPS URLs', () => {
    const result = parseRemoteUrl('https://github.com/owner/repo.git');
    assert.deepStrictEqual(result, { host: 'github.com', owner: 'owner', repo: 'repo' });
  });

  it('parses HTTPS URLs without .git suffix', () => {
    const result = parseRemoteUrl('https://github.com/owner/repo');
    assert.deepStrictEqual(result, { host: 'github.com', owner: 'owner', repo: 'repo' });
  });

  it('parses non-GitHub HTTPS hosts', () => {
    const result = parseRemoteUrl('https://gitlab.com/myorg/project.git');
    assert.deepStrictEqual(result, { host: 'gitlab.com', owner: 'myorg', repo: 'project' });
  });

  it('parses non-GitHub SSH hosts', () => {
    const result = parseRemoteUrl('git@bitbucket.org:team/project.git');
    assert.deepStrictEqual(result, { host: 'bitbucket.org', owner: 'team', repo: 'project' });
  });

  it('returns null for empty/null input', () => {
    assert.strictEqual(parseRemoteUrl(''), null);
    assert.strictEqual(parseRemoteUrl(null), null);
    assert.strictEqual(parseRemoteUrl(undefined), null);
  });

  it('returns null for invalid URLs', () => {
    assert.strictEqual(parseRemoteUrl('not-a-url'), null);
    assert.strictEqual(parseRemoteUrl('ftp://example.com'), null);
  });
});

// ── getGitHubConfig ─────────────────────────────────────────────────────────

describe('getGitHubConfig', () => {
  it('returns default shape', () => {
    const cfg = getGitHubConfig();
    assert.strictEqual(typeof cfg.enabled, 'boolean');
    assert.strictEqual(typeof cfg.defaultBase, 'string');
    assert.strictEqual(typeof cfg.draft, 'boolean');
    assert.ok(Array.isArray(cfg.labels));
    assert.ok(Array.isArray(cfg.reviewers));
    assert.strictEqual(typeof cfg.prBodyFooter, 'string');
  });

  it('has expected default values', () => {
    const cfg = getGitHubConfig();
    assert.strictEqual(cfg.enabled, false);
    assert.strictEqual(cfg.defaultBase, '');
    assert.strictEqual(cfg.draft, false);
    assert.deepStrictEqual(cfg.labels, []);
    assert.deepStrictEqual(cfg.reviewers, []);
  });
});

// ── Export verification ─────────────────────────────────────────────────────

describe('hydra-github exports', () => {
  it('exports all expected functions', () => {
    assert.strictEqual(typeof gh, 'function');
    assert.strictEqual(typeof isGhAvailable, 'function');
    assert.strictEqual(typeof isGhAuthenticated, 'function');
    assert.strictEqual(typeof detectRepo, 'function');
    assert.strictEqual(typeof createPR, 'function');
    assert.strictEqual(typeof listPRs, 'function');
    assert.strictEqual(typeof getPR, 'function');
    assert.strictEqual(typeof mergePR, 'function');
    assert.strictEqual(typeof closePR, 'function');
    assert.strictEqual(typeof getGitHubConfig, 'function');
    assert.strictEqual(typeof pushBranchAndCreatePR, 'function');
  });
});

// ── isGhAvailable ───────────────────────────────────────────────────────────

describe('isGhAvailable', () => {
  it('returns a boolean', () => {
    const result = isGhAvailable();
    assert.strictEqual(typeof result, 'boolean');
  });
});

// ── gh executor ─────────────────────────────────────────────────────────────

describe('gh executor', () => {
  it('returns object with status property', () => {
    const result = gh(['--version']);
    assert.ok(result.status === null || typeof result.status === 'number');
    assert.ok('stdout' in result);
    assert.ok('stderr' in result);
  });
});

// ── git-ops remote helpers ──────────────────────────────────────────────────

describe('git-ops remote helpers', () => {
  it('exports all remote sync functions', async () => {
    const gitOps = await import('../lib/hydra-shared/git-ops.mjs');
    assert.strictEqual(typeof gitOps.getRemoteUrl, 'function');
    assert.strictEqual(typeof gitOps.parseRemoteUrl, 'function');
    assert.strictEqual(typeof gitOps.fetchOrigin, 'function');
    assert.strictEqual(typeof gitOps.pushBranch, 'function');
    assert.strictEqual(typeof gitOps.hasRemote, 'function');
    assert.strictEqual(typeof gitOps.getTrackingBranch, 'function');
    assert.strictEqual(typeof gitOps.isAheadOfRemote, 'function');
  });
});

// ── gh-dependent tests (skipped if gh not installed) ────────────────────────

const ghInstalled = isGhAvailable();

describe('detectRepo', { skip: !ghInstalled ? 'gh CLI not installed' : false }, () => {
  it('returns object or null', () => {
    const result = detectRepo();
    if (result) {
      assert.strictEqual(typeof result.owner, 'string');
      assert.strictEqual(typeof result.repo, 'string');
      assert.strictEqual(typeof result.defaultBranch, 'string');
    } else {
      assert.strictEqual(result, null);
    }
  });
});

describe('listPRs', { skip: !ghInstalled ? 'gh CLI not installed' : false }, () => {
  it('returns an array', () => {
    const result = listPRs();
    assert.ok(Array.isArray(result));
  });
});
