/**
 * Shared Review Infrastructure — Common helpers for nightly and evolve review tools.
 *
 * Provides:
 *   - Interactive readline prompt helpers
 *   - Report loading patterns
 *   - Branch walk-through rendering
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import pc from 'picocolors';
import { getCurrentBranch, checkoutBranch, listBranches, getBranchDiffStat, getBranchDiff, getBranchLog, mergeBranch, smartMerge, deleteBranch } from './git-ops.mjs';
import { pushBranchAndCreatePR, isGhAvailable } from '../hydra-github.mjs';

// ── Interactive Prompt ──────────────────────────────────────────────────────

/**
 * Create a readline interface for interactive prompts.
 * @returns {readline.Interface}
 */
export function createRL() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
}

/**
 * Ask a question and return the trimmed lowercase answer.
 * @param {readline.Interface} rl
 * @param {string} question
 * @returns {Promise<string>}
 */
export function ask(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim().toLowerCase()));
  });
}

// ── Report Loading ──────────────────────────────────────────────────────────

/**
 * Load the latest report JSON from a coordination directory.
 *
 * @param {string} reportDir - Path to the report directory
 * @param {string} prefix - Report filename prefix (e.g., 'NIGHTLY', 'EVOLVE')
 * @param {string|null} [dateFilter] - Optional date filter
 * @returns {object|null}
 */
export function loadLatestReport(reportDir, prefix, dateFilter = null) {
  if (!fs.existsSync(reportDir)) return null;

  if (dateFilter) {
    const jsonPath = path.join(reportDir, `${prefix}_${dateFilter}.json`);
    if (fs.existsSync(jsonPath)) {
      try { return JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch { return null; }
    }
    return null;
  }

  try {
    const files = fs.readdirSync(reportDir)
      .filter((f) => f.startsWith(`${prefix}_`) && f.endsWith('.json'))
      .sort()
      .reverse();

    if (files.length === 0) return null;
    return JSON.parse(fs.readFileSync(path.join(reportDir, files[0]), 'utf8'));
  } catch {
    return null;
  }
}

// ── Branch Walk-through ─────────────────────────────────────────────────────

/**
 * Display branch info (commits, diff stat).
 * @param {string} projectRoot
 * @param {string} branch
 * @param {string} baseBranch
 * @returns {{ commitLog: string, diffStat: string }}
 */
export function displayBranchInfo(projectRoot, branch, baseBranch) {
  const diffStat = getBranchDiffStat(projectRoot, branch, baseBranch);
  const commitLog = getBranchLog(projectRoot, branch, baseBranch);

  if (commitLog) {
    console.log(pc.dim('\n  Commits:'));
    for (const line of commitLog.split('\n')) {
      console.log(pc.dim(`    ${line}`));
    }
  }
  if (diffStat) {
    console.log(pc.dim('\n  Changes:'));
    for (const line of diffStat.split('\n')) {
      console.log(pc.dim(`    ${line}`));
    }
  }

  return { commitLog, diffStat };
}

/**
 * Handle the interactive merge/skip/diff/delete/pr prompt for a branch.
 *
 * @param {readline.Interface} rl
 * @param {string} projectRoot
 * @param {string} branch
 * @param {string} baseBranch
 * @param {{ enablePR?: boolean }} [opts={}]
 * @returns {Promise<'merged'|'skipped'|'deleted'|'pr-created'>}
 */
export async function handleBranchAction(rl, projectRoot, branch, baseBranch, opts = {}) {
  const prLabel = opts.enablePR ? `[${pc.magenta('p')}]r  ` : '';
  const answer = await ask(rl, `  ${prLabel}[${pc.green('m')}]erge  [${pc.yellow('s')}]kip  [${pc.blue('d')}]iff  [${pc.red('x')}]delete  ? `);

  switch (answer) {
    case 'p':
    case 'pr': {
      if (!opts.enablePR) {
        console.log(pc.dim('  Skipped.'));
        return 'skipped';
      }
      const result = pushBranchAndCreatePR({ cwd: projectRoot, branch, baseBranch });
      if (result.ok) {
        console.log(pc.green(`  + PR created: ${result.url}`));
        const delAnswer = await ask(rl, `  Delete local branch? (y/N) `);
        if (delAnswer === 'y' || delAnswer === 'yes') {
          checkoutBranch(projectRoot, baseBranch);
          deleteBranch(projectRoot, branch);
          console.log(pc.dim('  Branch deleted.'));
        }
        return 'pr-created';
      } else {
        console.log(pc.red(`  x PR creation failed: ${result.error || 'unknown error'}`));
        return 'skipped';
      }
    }

    case 'm':
    case 'merge': {
      const ok = opts.useSmartMerge
        ? smartMerge(projectRoot, branch, baseBranch, { log: { info: m => console.log(pc.dim(`  ${m}`)), ok: m => console.log(pc.green(`  ${m}`)), warn: m => console.log(pc.yellow(`  ${m}`)) } })
        : mergeBranch(projectRoot, branch, baseBranch);
      if (ok) {
        console.log(pc.green(`  + Merged ${branch} into ${baseBranch}`));
        const delAnswer = await ask(rl, `  Delete branch after merge? (Y/n) `);
        if (delAnswer !== 'n' && delAnswer !== 'no') {
          deleteBranch(projectRoot, branch);
          console.log(pc.dim('  Branch deleted.'));
        }
        return 'merged';
      } else {
        console.log(pc.red(`  x Merge failed — resolve conflicts manually`));
        console.log(pc.dim(`    git merge ${branch}`));
        return 'skipped';
      }
    }

    case 'd':
    case 'diff': {
      const fullDiff = getBranchDiff(projectRoot, branch, baseBranch);
      console.log('\n' + fullDiff + '\n');
      const prLabel2 = opts.enablePR ? `[${pc.magenta('p')}]r  ` : '';
      const postDiff = await ask(rl, `  After review: ${prLabel2}[${pc.green('m')}]erge  [${pc.yellow('s')}]kip  [${pc.red('x')}]delete  ? `);
      if ((postDiff === 'p' || postDiff === 'pr') && opts.enablePR) {
        const result = pushBranchAndCreatePR({ cwd: projectRoot, branch, baseBranch });
        if (result.ok) {
          console.log(pc.green(`  + PR created: ${result.url}`));
          return 'pr-created';
        } else {
          console.log(pc.red(`  x PR creation failed: ${result.error || 'unknown error'}`));
          return 'skipped';
        }
      } else if (postDiff === 'm' || postDiff === 'merge') {
        const ok = opts.useSmartMerge
          ? smartMerge(projectRoot, branch, baseBranch)
          : mergeBranch(projectRoot, branch, baseBranch);
        if (ok) {
          console.log(pc.green(`  + Merged ${branch} into ${baseBranch}`));
          deleteBranch(projectRoot, branch);
          console.log(pc.dim('  Branch deleted.'));
          return 'merged';
        } else {
          console.log(pc.red(`  x Merge failed`));
          return 'skipped';
        }
      } else if (postDiff === 'x' || postDiff === 'delete') {
        deleteBranch(projectRoot, branch);
        console.log(pc.dim('  Branch deleted.'));
        return 'deleted';
      }
      console.log(pc.dim('  Skipped.'));
      return 'skipped';
    }

    case 'x':
    case 'delete': {
      deleteBranch(projectRoot, branch);
      console.log(pc.dim('  Branch deleted.'));
      return 'deleted';
    }

    default: {
      console.log(pc.dim('  Skipped.'));
      return 'skipped';
    }
  }
}

/**
 * Handle empty branch (no commits) with delete prompt.
 * @param {readline.Interface} rl
 * @param {string} projectRoot
 * @param {string} branch
 * @returns {Promise<void>}
 */
export async function handleEmptyBranch(rl, projectRoot, branch) {
  console.log(pc.dim('  (no commits on this branch)'));
  const cleanAnswer = await ask(rl, `\n  ${pc.yellow('Delete empty branch?')} (y/N) `);
  if (cleanAnswer === 'y' || cleanAnswer === 'yes') {
    deleteBranch(projectRoot, branch);
    console.log(pc.dim('  Deleted.'));
  }
}

/**
 * Clean (delete) all branches matching a prefix.
 * @param {string} projectRoot
 * @param {string} prefix
 * @param {string} baseBranch
 * @param {string|null} dateFilter
 */
export function cleanBranches(projectRoot, prefix, baseBranch, dateFilter = null) {
  const branches = listBranches(projectRoot, prefix, dateFilter);

  if (branches.length === 0) {
    console.log(pc.yellow(`No ${prefix} branches to clean.`));
    return;
  }

  const current = getCurrentBranch(projectRoot);
  if (current !== baseBranch) {
    checkoutBranch(projectRoot, baseBranch);
  }

  console.log(pc.bold(`Cleaning ${branches.length} ${prefix} branch(es)...`));

  let deleted = 0;
  for (const branch of branches) {
    const ok = deleteBranch(projectRoot, branch);
    if (ok) {
      console.log(pc.dim(`  Deleted: ${branch}`));
      deleted++;
    } else {
      console.log(pc.red(`  Failed: ${branch}`));
    }
  }

  console.log(pc.green(`\nDone: ${deleted}/${branches.length} branches deleted.`));
}
