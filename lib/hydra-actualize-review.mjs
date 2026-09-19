#!/usr/bin/env node
/**
 * Hydra Actualize Review — review/merge/clean branches created by hydra-actualize.
 *
 * Subcommands:
 *   review  — Walk through actualize branches, show diffs, merge approved ones
 *   status  — Show latest actualize report summary
 *   clean   — Delete all actualize/* branches (or filter by date)
 *
 * Usage:
 *   node lib/hydra-actualize-review.mjs review
 *   node lib/hydra-actualize-review.mjs status
 *   node lib/hydra-actualize-review.mjs clean
 *   node lib/hydra-actualize-review.mjs clean date=2026-02-09
 */

import path from 'path';
import { resolveProject } from './hydra-config.mjs';
import { parseArgs } from './hydra-utils.mjs';
import { scanBranchViolations } from './hydra-shared/guardrails.mjs';
import {
  git,
  getCurrentBranch,
  checkoutBranch,
  listBranches,
  getBranchLog,
} from './hydra-shared/git-ops.mjs';
import { BASE_PROTECTED_FILES, BASE_PROTECTED_PATTERNS } from './hydra-shared/constants.mjs';
import {
  createRL,
  loadLatestReport,
  displayBranchInfo,
  handleBranchAction,
  handleEmptyBranch,
  cleanBranches,
} from './hydra-shared/review-common.mjs';
import { isGhAvailable } from './hydra-github.mjs';
import pc from 'picocolors';

function hasBaseAdvanced(projectRoot, branch, baseBranch) {
  try {
    const r = git(['merge-base', '--is-ancestor', baseBranch, branch], projectRoot);
    return r.status !== 0;
  } catch {
    return true;
  }
}

async function reviewCommand(projectRoot, options) {
  const dateFilter = options.date || null;
  const branches = listBranches(projectRoot, 'actualize', dateFilter);

  if (branches.length === 0) {
    console.log(pc.yellow('No actualize branches found.'));
    if (dateFilter) console.log(pc.dim(`  Filter: actualize/${dateFilter}/*`));
    return;
  }

  const reportDir = path.join(projectRoot, 'docs', 'coordination', 'actualize');
  const reportData = loadLatestReport(reportDir, 'ACTUALIZE', dateFilter);
  const baseBranch = reportData?.baseBranch || 'dev';

  const current = getCurrentBranch(projectRoot);
  if (current !== baseBranch) {
    console.log(pc.yellow(`Switching to ${baseBranch} branch (was on ${current})`));
    checkoutBranch(projectRoot, baseBranch);
  }

  console.log(pc.bold(`\nActualize Review — ${branches.length} branch(es)\n`));

  const rl = createRL();
  let merged = 0;
  let skipped = 0;

  for (const branch of branches) {
    const reportEntry = reportData?.results?.find((r) => r.branch === branch);

    console.log(pc.bold(pc.cyan(`\n── ${branch} ──`)));

    if (reportEntry) {
      const statusColor = reportEntry.status === 'success' ? pc.green : pc.yellow;
      console.log(`  Status: ${statusColor(String(reportEntry.status || '').toUpperCase())}`);
      console.log(`  Agent: ${reportEntry.agent || 'claude'}`);
      if (reportEntry.source) console.log(`  Source: ${reportEntry.source}${reportEntry.taskType ? ` (${reportEntry.taskType})` : ''}`);
      if (reportEntry.tokensUsed) console.log(`  Tokens: ~${reportEntry.tokensUsed.toLocaleString()}`);
      console.log(`  Verification: ${reportEntry.verification || '?'}`);
      if (reportEntry.violations?.length > 0) {
        console.log(pc.red(`  Violations: ${reportEntry.violations.length}`));
        for (const v of reportEntry.violations) {
          console.log(pc.red(`    [${v.severity}] ${v.detail}`));
        }
      }
    }

    if (hasBaseAdvanced(projectRoot, branch, baseBranch)) {
      console.log(pc.yellow(`  ${baseBranch} has advanced since this branch was created — smart merge will rebase first`));
    }

    const { commitLog } = displayBranchInfo(projectRoot, branch, baseBranch);
    if (!commitLog) {
      await handleEmptyBranch(rl, projectRoot, branch);
      continue;
    }

    const liveViolations = scanBranchViolations(projectRoot, branch, {
      baseBranch,
      protectedFiles: new Set(BASE_PROTECTED_FILES),
      protectedPatterns: [...BASE_PROTECTED_PATTERNS],
    });
    if (liveViolations.length > 0 && !reportEntry?.violations?.length) {
      console.log(pc.red(`\n  Live violation scan: ${liveViolations.length} issue(s)`));
      for (const v of liveViolations) {
        console.log(pc.red(`    [${v.severity}] ${v.detail}`));
      }
    }

    console.log('');
    const result = await handleBranchAction(rl, projectRoot, branch, baseBranch, {
      enablePR: isGhAvailable(),
      useSmartMerge: true,
    });
    if (result === 'merged' || result === 'pr-created') merged++;
    else if (result === 'skipped') skipped++;
  }

  rl.close();
  console.log(pc.bold(`\nDone: ${merged} merged, ${skipped} skipped`));
}

function statusCommand(projectRoot, options) {
  const dateFilter = options.date || null;
  const branches = listBranches(projectRoot, 'actualize', dateFilter);

  const reportDir = path.join(projectRoot, 'docs', 'coordination', 'actualize');
  const report = loadLatestReport(reportDir, 'ACTUALIZE', dateFilter);
  const baseBranch = report?.baseBranch || 'dev';

  console.log(pc.bold('\nActualize Status'));

  if (branches.length === 0) {
    console.log(pc.dim('  No actualize branches found.'));
  } else {
    console.log(`\n  Branches (${branches.length}):`);
    for (const b of branches) {
      const branchLog = getBranchLog(projectRoot, b, baseBranch);
      const commitCount = branchLog ? branchLog.split('\n').length : 0;
      console.log(`    ${b} (${commitCount} commit${commitCount !== 1 ? 's' : ''})`);
    }
  }

  if (report) {
    console.log(`\n  Latest Report: ${report.date}`);
    console.log(`  Tasks: ${report.processedTasks}/${report.totalTasks}`);
    if (report.stopReason) console.log(`  Stopped: ${report.stopReason}`);
    console.log(`  Tokens: ~${report.budget?.consumed?.toLocaleString() || '?'}`);
    if (report.artifacts?.selfSnapshot) console.log(`  Self snapshot: ${report.artifacts.selfSnapshot}`);
    if (report.artifacts?.selfIndex) console.log(`  Self index: ${report.artifacts.selfIndex}`);
  } else {
    console.log(pc.dim('\n  No actualize report found.'));
  }

  console.log('');
}

function cleanCommand(projectRoot, options) {
  const reportDir = path.join(projectRoot, 'docs', 'coordination', 'actualize');
  const report = loadLatestReport(reportDir, 'ACTUALIZE', options.date || null);
  const baseBranch = report?.baseBranch || 'dev';
  cleanBranches(projectRoot, 'actualize', baseBranch, options.date || null);
}

async function main() {
  const { options, positionals } = parseArgs(process.argv);
  const command = positionals[0] || options.command || 'status';

  let config;
  try {
    config = resolveProject({ project: options.project });
  } catch (err) {
    console.error(pc.red(`Project resolution failed: ${err.message}`));
    process.exit(1);
  }

  const { projectRoot } = config;

  switch (command) {
    case 'review':
      await reviewCommand(projectRoot, options);
      break;
    case 'status':
      statusCommand(projectRoot, options);
      break;
    case 'clean':
      cleanCommand(projectRoot, options);
      break;
    default:
      console.error(pc.red(`Unknown command: ${command}`));
      console.error('Usage: hydra-actualize-review.mjs [review|status|clean]');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(pc.red(`Fatal: ${err.message}`));
  process.exit(1);
});

