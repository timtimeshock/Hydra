#!/usr/bin/env node
/**
 * Hydra Git Worktree Isolation
 *
 * Provides per-task git worktree management for parallel agent work
 * without file conflicts. Each task gets an isolated filesystem
 * that shares the repo's history.
 */

import fs from 'fs';
import path from 'path';
import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import { loadHydraConfig } from './hydra-config.mjs';

const execPromise = promisify(exec);

/**
 * Get worktree config with defaults.
 */
function getWorktreeConfig() {
  const cfg = loadHydraConfig();
  const branchPrefix = cfg.worktrees?.branchPrefix || 'hydra/';
  
  // Security: Validate branchPrefix to prevent shell injection
  if (!/^[\w\/\.-]+$/.test(branchPrefix)) {
    throw new Error(`Invalid branchPrefix "${branchPrefix}". Only alphanumeric, /, ., -, and _ are allowed.`);
  }

  return {
    enabled: cfg.worktrees?.enabled || false,
    basePath: cfg.worktrees?.basePath || '.hydra/worktrees',
    autoCleanup: cfg.worktrees?.autoCleanup !== false,
    branchPrefix,
  };
}

function runSync(cmd, cwd) {
  return execSync(cmd, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function runAsync(cmd, cwd) {
  const { stdout } = await execPromise(cmd, {
    cwd,
    encoding: 'utf8',
  });
  return stdout.trim();
}

/**
 * Create a git worktree for a task.
 * @param {string} taskId - Task identifier (e.g. 'T001')
 * @param {string} projectRoot - Root of the git repo
 * @param {string} [baseBranch] - Branch to base the worktree on (default: current branch)
 * @returns {Promise<{ worktreePath: string, branch: string }>}
 */
export async function createWorktree(taskId, projectRoot, baseBranch = null) {
  const config = getWorktreeConfig();
  const branch = `${config.branchPrefix}${taskId}`;
  const worktreePath = path.resolve(projectRoot, config.basePath, taskId);

  // Ensure parent directory exists
  const parentDir = path.dirname(worktreePath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  // Determine base branch
  let base = baseBranch;
  if (!base) {
    try {
      base = await runAsync('git branch --show-current', projectRoot);
    } catch {
      base = 'HEAD';
    }
  }
  if (!base) base = 'HEAD';

  // Create branch and worktree
  try {
    await runAsync(`git worktree add -b "${branch}" "${worktreePath}" "${base}"`, projectRoot);
  } catch (err) {
    // Branch might already exist — try without -b
    try {
      await runAsync(`git worktree add "${worktreePath}" "${branch}"`, projectRoot);
    } catch (innerErr) {
      throw new Error(`Failed to create worktree for ${taskId}: ${innerErr.message}`);
    }
  }

  return { worktreePath, branch };
}

/**
 * Remove a git worktree for a task.
 * @param {string} taskId - Task identifier
 * @param {string} projectRoot - Root of the git repo
 * @param {{ deleteBranch?: boolean }} [opts]
 * @returns {Promise<void>}
 */
export async function removeWorktree(taskId, projectRoot, opts = {}) {
  const config = getWorktreeConfig();
  const worktreePath = path.resolve(projectRoot, config.basePath, taskId);
  const branch = `${config.branchPrefix}${taskId}`;

  try {
    await runAsync(`git worktree remove "${worktreePath}" --force`, projectRoot);
  } catch {
    // Worktree may already be removed; try to clean up directory
    if (fs.existsSync(worktreePath)) {
      try {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
    // Prune stale worktree entries
    try { await runAsync('git worktree prune', projectRoot); } catch { /* ignore */ }
  }

  if (opts.deleteBranch) {
    try {
      await runAsync(`git branch -D "${branch}"`, projectRoot);
    } catch { /* branch may not exist */ }
  }
}

/**
 * Get the worktree path for a task (without checking if it exists).
 * @param {string} taskId
 * @param {string} projectRoot
 * @returns {string}
 */
export function getWorktreePath(taskId, projectRoot) {
  const config = getWorktreeConfig();
  return path.resolve(projectRoot, config.basePath, taskId);
}

/**
 * List all active worktrees.
 * @param {string} projectRoot
 * @returns {Promise<Array<{ path: string, branch: string, head: string }>>}
 */
export async function listWorktrees(projectRoot) {
  let output;
  try {
    output = await runAsync('git worktree list --porcelain', projectRoot);
  } catch {
    return [];
  }

  const worktrees = [];
  let current = {};

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) worktrees.push(current);
      current = { path: line.slice('worktree '.length).trim() };
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim();
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    } else if (line === '' && current.path) {
      worktrees.push(current);
      current = {};
    }
  }
  if (current.path) worktrees.push(current);

  return worktrees;
}

/**
 * Merge a worktree branch back into a target branch.
 * @param {string} taskId
 * @param {string} projectRoot
 * @param {string} [targetBranch] - Branch to merge into (default: current branch)
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function mergeWorktree(taskId, projectRoot, targetBranch = null) {
  const config = getWorktreeConfig();
  const branch = `${config.branchPrefix}${taskId}`;
  let target = targetBranch;
  
  if (!target) {
    try {
      target = await runAsync('git branch --show-current', projectRoot);
    } catch {
      target = 'main';
    }
  }

  try {
    const result = await runAsync(`git merge "${branch}" --no-edit`, projectRoot);
    return { ok: true, message: result || `Merged ${branch} into ${target}` };
  } catch (err) {
    return { ok: false, message: `Merge failed: ${err.message}` };
  }
}

/**
 * Check if worktree isolation is enabled in config.
 */
export function isWorktreeEnabled() {
  return getWorktreeConfig().enabled;
}
