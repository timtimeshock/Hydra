/**
 * Shared Git Helpers — Common git operations for nightly and evolve pipelines.
 *
 * Adopts evolve's parameterized versions as the superset.
 * Nightly callers simply pass baseBranch='dev'.
 */

import { spawnSyncCapture } from '../hydra-proc.mjs';

/**
 * Run a git command synchronously.
 * @param {string[]} args - Git arguments
 * @param {string} cwd - Working directory
 * @returns {{ status: number|null, stdout: string, stderr: string, error: Error|null }}
 */
export function git(args, cwd) {
  const r = spawnSyncCapture('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
    shell: false,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, error: r.error, signal: r.signal };
}

/**
 * Get the current branch name.
 * @param {string} cwd
 * @returns {string}
 */
export function getCurrentBranch(cwd) {
  const r = git(['branch', '--show-current'], cwd);
  return (r.stdout || '').trim();
}

/**
 * Checkout a branch.
 * @param {string} cwd
 * @param {string} branch
 */
export function checkoutBranch(cwd, branch) {
  return git(['checkout', branch], cwd);
}

/**
 * Check if a branch exists.
 * @param {string} cwd
 * @param {string} branchName
 * @returns {boolean}
 */
export function branchExists(cwd, branchName) {
  const r = git(['rev-parse', '--verify', branchName], cwd);
  return r.status === 0;
}

/**
 * Create a new branch from a base branch. Deletes stale branch if it exists.
 * @param {string} cwd
 * @param {string} branchName
 * @param {string} fromBranch
 * @returns {boolean} success
 */
export function createBranch(cwd, branchName, fromBranch) {
  if (branchExists(cwd, branchName)) {
    git(['branch', '-D', branchName], cwd);
  }
  const r = git(['checkout', '-b', branchName, fromBranch], cwd);
  return r.status === 0;
}

/**
 * Check if a branch has commits beyond baseBranch.
 * @param {string} cwd
 * @param {string} branchName
 * @param {string} [baseBranch='dev']
 * @returns {boolean}
 */
export function branchHasCommits(cwd, branchName, baseBranch = 'dev') {
  const r = git(['log', `${baseBranch}..${branchName}`, '--oneline'], cwd);
  return (r.stdout || '').trim().length > 0;
}

/**
 * Get commit count and files changed for a branch vs base.
 * @param {string} cwd
 * @param {string} branchName
 * @param {string} [baseBranch='dev']
 * @returns {{ commits: number, filesChanged: number }}
 */
export function getBranchStats(cwd, branchName, baseBranch = 'dev') {
  const logResult = git(['log', `${baseBranch}..${branchName}`, '--oneline'], cwd);
  const commits = (logResult.stdout || '').trim().split('\n').filter(Boolean).length;

  const diffResult = git(['diff', '--stat', `${baseBranch}...${branchName}`], cwd);
  const statLines = (diffResult.stdout || '').trim().split('\n').filter(Boolean);
  const filesChanged = Math.max(0, statLines.length - 1);

  return { commits, filesChanged };
}

/**
 * Get the full diff between a branch and its base.
 * @param {string} cwd
 * @param {string} branchName
 * @param {string} [baseBranch='dev']
 * @returns {string}
 */
export function getBranchDiff(cwd, branchName, baseBranch = 'dev') {
  const r = git(['diff', `${baseBranch}...${branchName}`], cwd);
  return (r.stdout || '').trim();
}

/**
 * Stage all changes and commit.
 * @param {string} cwd
 * @param {string} message
 * @param {{ originatedBy?: string, executedBy?: string }} [opts]
 * @returns {boolean} success
 */
export function stageAndCommit(cwd, message, opts = {}) {
  git(['add', '-A'], cwd);
  let fullMessage = message;
  const trailers = [];
  if (opts.originatedBy) trailers.push(`Originated-By: ${opts.originatedBy}`);
  if (opts.executedBy) trailers.push(`Executed-By: ${opts.executedBy}`);
  if (trailers.length) fullMessage = message.trimEnd() + '\n\n' + trailers.join('\n');
  const r = git(['commit', '-m', fullMessage, '--allow-empty'], cwd);
  return r.status === 0;
}

/**
 * Smart merge: rebase-first strategy with conflict detection.
 * @param {string} cwd
 * @param {string} branchName
 * @param {string} baseBranch
 * @param {{ log?: { info: Function, ok: Function, warn: Function } }} [opts]
 * @returns {{ ok: boolean, method: string, conflicts: string[] }}
 */
export function smartMerge(cwd, branchName, baseBranch, opts = {}) {
  const _log = opts.log || { info: () => {}, ok: () => {}, warn: () => {} };

  const isAncestor = git(['merge-base', '--is-ancestor', baseBranch, branchName], cwd);
  const baseDiverged = isAncestor.status !== 0;

  if (baseDiverged) {
    _log.info(`Base branch '${baseBranch}' has diverged — attempting rebase...`);

    const rebase = git(['rebase', baseBranch, branchName], cwd);
    if (rebase.status !== 0) {
      git(['rebase', '--abort'], cwd);
      _log.warn('Rebase had conflicts — falling back to merge...');
    } else {
      _log.ok(`Rebased ${branchName} onto ${baseBranch}`);
      checkoutBranch(cwd, baseBranch);
      const ff = git(['merge', branchName, '--ff-only'], cwd);
      if (ff.status === 0) {
        return { ok: true, method: 'rebase+ff', conflicts: [] };
      }
    }
  }

  checkoutBranch(cwd, baseBranch);
  const merge = git(['merge', branchName, '--no-edit'], cwd);
  if (merge.status === 0) {
    return { ok: true, method: baseDiverged ? 'merge' : 'fast-forward', conflicts: [] };
  }

  const conflictFiles = git(['diff', '--name-only', '--diff-filter=U'], cwd);
  const conflicts = (conflictFiles.stdout || '').trim().split('\n').filter(Boolean);
  git(['merge', '--abort'], cwd);

  return { ok: false, method: 'failed', conflicts };
}

// ── Review-specific git helpers ─────────────────────────────────────────────

/**
 * List branches matching a prefix pattern.
 * @param {string} cwd
 * @param {string} prefix - e.g. 'nightly' or 'evolve'
 * @param {string|null} [dateFilter]
 * @returns {string[]}
 */
export function listBranches(cwd, prefix, dateFilter = null) {
  const pattern = dateFilter ? `${prefix}/${dateFilter}/*` : `${prefix}/*`;
  const r = git(['branch', '--list', pattern], cwd);
  if (!r.stdout) return [];
  return r.stdout
    .split('\n')
    .map((b) => b.trim().replace(/^\*\s*/, ''))
    .filter(Boolean);
}

/**
 * Get diff stat for a branch vs base.
 * @param {string} cwd
 * @param {string} branch
 * @param {string} [baseBranch='dev']
 * @returns {string}
 */
export function getBranchDiffStat(cwd, branch, baseBranch = 'dev') {
  const r = git(['diff', '--stat', `${baseBranch}...${branch}`], cwd);
  return (r.stdout || '').trim();
}

/**
 * Get one-line commit log for a branch vs base.
 * @param {string} cwd
 * @param {string} branch
 * @param {string} [baseBranch='dev']
 * @returns {string}
 */
export function getBranchLog(cwd, branch, baseBranch = 'dev') {
  const r = git(['log', `${baseBranch}..${branch}`, '--oneline', '--no-decorate'], cwd);
  return (r.stdout || '').trim();
}

/**
 * Merge a branch into the current branch (or baseBranch).
 * @param {string} cwd
 * @param {string} branch
 * @param {string} [baseBranch='dev']
 * @returns {boolean} success
 */
export function mergeBranch(cwd, branch, baseBranch = 'dev') {
  const current = getCurrentBranch(cwd);
  if (current !== baseBranch) {
    git(['checkout', baseBranch], cwd);
  }
  const r = git(['merge', branch, '--no-edit'], cwd);
  return r.status === 0;
}

/**
 * Delete a branch (force).
 * @param {string} cwd
 * @param {string} branch
 * @returns {boolean} success
 */
export function deleteBranch(cwd, branch) {
  const r = git(['branch', '-D', branch], cwd);
  return r.status === 0;
}

// ── Remote sync helpers ─────────────────────────────────────────────────────

/**
 * Get the URL of a remote.
 * @param {string} cwd
 * @param {string} [remote='origin']
 * @returns {string} URL or empty string
 */
export function getRemoteUrl(cwd, remote = 'origin') {
  const r = git(['remote', 'get-url', remote], cwd);
  return r.status === 0 ? (r.stdout || '').trim() : '';
}

/**
 * Parse an SSH or HTTPS git remote URL into owner/repo.
 * Handles: git@host:owner/repo.git, https://host/owner/repo.git, etc.
 * @param {string} url
 * @returns {{ host: string, owner: string, repo: string } | null}
 */
export function parseRemoteUrl(url) {
  if (!url || typeof url !== 'string') return null;
  // SSH: git@github.com:owner/repo.git
  const ssh = url.match(/^[\w+-]+@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh) return { host: ssh[1], owner: ssh[2], repo: ssh[3] };
  // HTTPS: https://github.com/owner/repo.git
  try {
    const u = new URL(url);
    const parts = u.pathname.replace(/^\//, '').replace(/\.git$/, '').split('/');
    if (parts.length >= 2) return { host: u.host, owner: parts[0], repo: parts[1] };
  } catch { /* not a URL */ }
  return null;
}

/**
 * Fetch from origin (optionally a specific branch).
 * @param {string} cwd
 * @param {string|null} [branch=null]
 * @returns {{ ok: boolean, stderr: string }}
 */
export function fetchOrigin(cwd, branch = null) {
  const args = branch ? ['fetch', 'origin', branch] : ['fetch', 'origin'];
  const r = git(args, cwd);
  return { ok: r.status === 0, stderr: (r.stderr || '').trim() };
}

/**
 * Push a branch to origin.
 * @param {string} cwd
 * @param {string} branch
 * @param {{ force?: boolean, setUpstream?: boolean }} [opts={}]
 * @returns {{ ok: boolean, stderr: string }}
 */
export function pushBranch(cwd, branch, opts = {}) {
  const args = ['push', 'origin', branch];
  if (opts.setUpstream) args.splice(1, 0, '-u');
  if (opts.force) args.splice(1, 0, '--force-with-lease');
  const r = git(args, cwd);
  return { ok: r.status === 0, stderr: (r.stderr || '').trim() };
}

/**
 * Check if a named remote exists.
 * @param {string} cwd
 * @param {string} [remote='origin']
 * @returns {boolean}
 */
export function hasRemote(cwd, remote = 'origin') {
  const r = git(['remote'], cwd);
  if (r.status !== 0) return false;
  return (r.stdout || '').split('\n').map(s => s.trim()).includes(remote);
}

/**
 * Get the tracking (upstream) branch for the current or given branch.
 * @param {string} cwd
 * @param {string|null} [branch=null]
 * @returns {string} Tracking branch name or empty string
 */
export function getTrackingBranch(cwd, branch = null) {
  const ref = branch ? `${branch}@{u}` : '@{u}';
  const r = git(['rev-parse', '--abbrev-ref', ref], cwd);
  return r.status === 0 ? (r.stdout || '').trim() : '';
}

/**
 * Check how many commits the local branch is ahead/behind its remote tracking branch.
 * @param {string} cwd
 * @returns {{ ahead: number, behind: number }}
 */
export function isAheadOfRemote(cwd) {
  const r = git(['status', '-b', '--porcelain=v1'], cwd);
  if (r.status !== 0) return { ahead: 0, behind: 0 };
  const first = (r.stdout || '').split('\n')[0] || '';
  const aheadMatch = first.match(/ahead (\d+)/);
  const behindMatch = first.match(/behind (\d+)/);
  return {
    ahead: aheadMatch ? parseInt(aheadMatch[1], 10) : 0,
    behind: behindMatch ? parseInt(behindMatch[1], 10) : 0,
  };
}
