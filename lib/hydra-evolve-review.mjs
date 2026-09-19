#!/usr/bin/env node
/**
 * Hydra Evolve Review — Post-session review, merge, cleanup, and knowledge browsing.
 *
 * Subcommands:
 *   review    — Walk through evolve branches, show diffs, merge approved ones
 *   status    — Show latest evolve report summary
 *   clean     — Delete all evolve/* branches (or filter by date)
 *   knowledge — Display knowledge base stats, search entries
 *
 * Usage:
 *   node lib/hydra-evolve-review.mjs review
 *   node lib/hydra-evolve-review.mjs status
 *   node lib/hydra-evolve-review.mjs clean
 *   node lib/hydra-evolve-review.mjs clean date=2026-02-09
 *   node lib/hydra-evolve-review.mjs knowledge
 *   node lib/hydra-evolve-review.mjs knowledge query=routing
 *
 * Now uses shared modules from hydra-shared/ for git helpers and review infrastructure.
 */

import fs from 'fs';
import path from 'path';
import { resolveProject, loadHydraConfig } from './hydra-config.mjs';
import { parseArgs } from './hydra-utils.mjs';
import { scanBranchViolations } from './hydra-evolve-guardrails.mjs';
import { loadKnowledgeBase, searchEntries, getStats } from './hydra-knowledge.mjs';
import {
  getCurrentBranch,
  checkoutBranch,
  listBranches,
  getBranchLog,
} from './hydra-shared/git-ops.mjs';
import {
  createRL,
  ask,
  loadLatestReport,
  displayBranchInfo,
  handleBranchAction,
  handleEmptyBranch,
  cleanBranches,
} from './hydra-shared/review-common.mjs';
import { isGhAvailable } from './hydra-github.mjs';
import {
  loadSuggestions,
  saveSuggestions,
  addSuggestion,
  getPendingSuggestions,
  getSuggestionStats,
} from './hydra-evolve-suggestions.mjs';
import pc from 'picocolors';

// ── Review Command ──────────────────────────────────────────────────────────

async function reviewCommand(projectRoot, options) {
  const cfg = loadHydraConfig();
  const baseBranch = cfg.evolve?.baseBranch || 'dev';
  const dateFilter = options.date || null;
  const branches = listBranches(projectRoot, 'evolve', dateFilter);

  if (branches.length === 0) {
    console.log(pc.yellow('No evolve branches found.'));
    if (dateFilter) console.log(pc.dim(`  Filter: evolve/${dateFilter}/*`));
    return;
  }

  // Ensure we're on base branch
  const current = getCurrentBranch(projectRoot);
  if (current !== baseBranch) {
    console.log(pc.yellow(`Switching to ${baseBranch} branch (was on ${current})`));
    checkoutBranch(projectRoot, baseBranch);
  }

  console.log(pc.bold(`\nEvolve Review — ${branches.length} branch(es)\n`));

  // Load latest decision data
  const evolveDir = path.join(projectRoot, 'docs', 'coordination', 'evolve');
  const reportData = loadLatestReport(evolveDir, 'EVOLVE', dateFilter);

  const rl = createRL();
  let merged = 0;
  let skipped = 0;

  for (const branch of branches) {
    // Try to find matching decision
    const roundMatch = branch.match(/\/(\d+)$/);
    const roundNum = roundMatch ? parseInt(roundMatch[1], 10) : null;
    const roundEntry = reportData?.rounds?.find(r => r.round === roundNum);

    console.log(pc.bold(pc.cyan(`\n-- ${branch} --`)));

    // Show decision info if available
    if (roundEntry) {
      const verdictColor = roundEntry.verdict === 'approve' ? pc.green
        : roundEntry.verdict === 'revise' ? pc.yellow
        : pc.red;
      console.log(`  Area: ${roundEntry.area}`);
      console.log(`  Verdict: ${verdictColor(roundEntry.verdict?.toUpperCase() || '?')}`);
      if (roundEntry.score) console.log(`  Score: ${roundEntry.score}/10`);
      if (roundEntry.selectedImprovement) {
        console.log(`  Improvement: ${roundEntry.selectedImprovement.slice(0, 100)}`);
      }
      if (roundEntry.learnings) {
        console.log(`  Learnings: ${roundEntry.learnings.slice(0, 150)}`);
      }
    }

    // Show diff stat and commit log
    const { commitLog } = displayBranchInfo(projectRoot, branch, baseBranch);

    if (!commitLog) {
      await handleEmptyBranch(rl, projectRoot, branch);
      continue;
    }

    // Live violation scan
    const violations = scanBranchViolations(projectRoot, branch, baseBranch);
    if (violations.length > 0) {
      console.log(pc.red(`\n  Violations: ${violations.length}`));
      for (const v of violations) {
        console.log(pc.red(`    [${v.severity}] ${v.detail}`));
      }
    }

    // Offer retry-as-suggestion for rejected/revise rounds
    if (roundEntry && (roundEntry.verdict === 'reject' || roundEntry.verdict === 'revise') && roundEntry.selectedImprovement) {
      const retryAnswer = await ask(rl, `  ${pc.magenta('[r]')}etry as suggestion? (r/n) `);
      if (retryAnswer === 'r' || retryAnswer === 'retry') {
        const sg = loadSuggestions(evolveDir);
        const created = addSuggestion(sg, {
          source: 'review:retry',
          sourceRef: branch,
          area: roundEntry.area,
          title: (roundEntry.selectedImprovement || '').slice(0, 100),
          description: roundEntry.selectedImprovement || '',
          priority: 'high',
          tags: [roundEntry.area, 'retry', 'review-flagged'],
          notes: `Flagged during review. Original score: ${roundEntry.score || '?'}/10. ${roundEntry.learnings || ''}`,
        });
        if (created) {
          saveSuggestions(evolveDir, sg);
          console.log(pc.green(`  + Suggestion created: ${created.id}`));
        } else {
          console.log(pc.dim('  (similar suggestion already exists)'));
        }
      }
    }

    // Prompt
    console.log('');
    const result = await handleBranchAction(rl, projectRoot, branch, baseBranch, { enablePR: isGhAvailable() });
    if (result === 'merged' || result === 'pr-created') merged++;
    else if (result === 'skipped') skipped++;
  }

  rl.close();
  console.log(pc.bold(`\nDone: ${merged} merged, ${skipped} skipped`));
}

// ── Status Command ──────────────────────────────────────────────────────────

function loadSessionState(evolveDir) {
  const statePath = path.join(evolveDir, 'EVOLVE_SESSION_STATE.json');
  try {
    if (!fs.existsSync(statePath)) return null;
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

function statusCommand(projectRoot, options) {
  const cfg = loadHydraConfig();
  const baseBranch = cfg.evolve?.baseBranch || 'dev';
  const dateFilter = options.date || null;
  const branches = listBranches(projectRoot, 'evolve', dateFilter);
  const evolveDir = path.join(projectRoot, 'docs', 'coordination', 'evolve');

  console.log(pc.bold('\nEvolve Status'));

  // ── Session state (live tracking) ───────────────────────────────────
  const sessionState = loadSessionState(evolveDir);
  if (sessionState) {
    const statusColors = {
      running: pc.blue,
      completed: pc.green,
      partial: pc.yellow,
      failed: pc.red,
      interrupted: pc.red,
    };
    const statusColor = statusColors[sessionState.status] || pc.dim;
    console.log(`\n  Session: ${pc.bold(sessionState.sessionId || '?')}`);
    console.log(`  Status:  ${statusColor(pc.bold(sessionState.status.toUpperCase()))}`);

    if (sessionState.summary) {
      const s = sessionState.summary;
      const parts = [];
      if (s.approved > 0) parts.push(pc.green(`${s.approved} approved`));
      if (s.rejected > 0) parts.push(pc.red(`${s.rejected} rejected`));
      if (s.skipped > 0) parts.push(pc.dim(`${s.skipped} skipped`));
      if (s.errors > 0) parts.push(pc.red(`${s.errors} errors`));
      if (parts.length > 0) {
        console.log(`  Summary: ${parts.join(pc.dim(' / '))}`);
      }
    }

    // Per-round breakdown
    if (sessionState.completedRounds?.length > 0) {
      console.log('');
      for (const r of sessionState.completedRounds) {
        const icon = r.verdict === 'approve' ? pc.green('+')
          : r.verdict === 'reject' ? pc.red('x')
          : r.verdict === 'skipped' ? pc.dim('-')
          : r.verdict === 'error' ? pc.red('!')
          : pc.dim('?');
        const scoreStr = r.score != null ? pc.dim(` (${r.score}/10)`) : '';
        console.log(`    ${icon} Round ${r.round}: ${r.area} — ${r.verdict || '?'}${scoreStr}`);
      }
    }

    if (sessionState.actionNeeded) {
      console.log(`\n  ${pc.yellow(sessionState.actionNeeded)}`);
    }

    if (sessionState.resumable) {
      console.log(`  ${pc.dim('Tip:')} ${pc.cyan(':evolve resume')} to continue this session`);
    }

    console.log('');
  }

  // Show branches
  if (branches.length === 0) {
    console.log(pc.dim('  No evolve branches found.'));
  } else {
    console.log(`  Branches (${branches.length}):`);
    for (const b of branches) {
      const commitLog = getBranchLog(projectRoot, b, baseBranch);
      const commitCount = commitLog ? commitLog.split('\n').length : 0;
      console.log(`    ${b} (${commitCount} commit${commitCount !== 1 ? 's' : ''})`);
    }
  }

  // Show latest report
  const report = loadLatestReport(evolveDir, 'EVOLVE', dateFilter);

  if (report) {
    console.log(`\n  Latest Report: ${report.dateStr}`);
    console.log(`  Rounds: ${report.processedRounds}/${report.maxRounds}`);
    if (report.stopReason) console.log(`  Stopped: ${report.stopReason}`);
    console.log(`  Tokens: ~${report.budget?.consumed?.toLocaleString() || '?'}`);

    if (report.rounds && !sessionState) {
      console.log('');
      for (const r of report.rounds) {
        const icon = r.verdict === 'approve' ? pc.green('+')
          : r.verdict === 'revise' ? pc.yellow('~')
          : r.verdict === 'skipped' ? pc.dim('-')
          : pc.red('x');
        console.log(`    ${icon} Round ${r.round}: ${r.area} — ${r.verdict || '?'}${r.score ? ` (${r.score}/10)` : ''}`);
      }
    }
  } else if (!sessionState) {
    console.log(pc.dim('\n  No evolve report found.'));
  }

  // Knowledge base summary
  const kb = loadKnowledgeBase(evolveDir);
  const stats = getStats(kb);
  console.log(`\n  Knowledge Base: ${stats.totalResearched} entries, ${stats.totalApproved} approved, ${stats.totalRejected} rejected`);
  if (stats.topAreas.length > 0) {
    console.log(`  Top areas: ${stats.topAreas.slice(0, 5).map(a => `${a.area}(${a.count})`).join(', ')}`);
  }

  console.log('');
}

// ── Clean Command ───────────────────────────────────────────────────────────

function cleanCommand(projectRoot, options) {
  const cfg = loadHydraConfig();
  const baseBranch = cfg.evolve?.baseBranch || 'dev';
  cleanBranches(projectRoot, 'evolve', baseBranch, options.date || null);
}

// ── Knowledge Command ───────────────────────────────────────────────────────

function knowledgeCommand(projectRoot, options) {
  const evolveDir = path.join(projectRoot, 'docs', 'coordination', 'evolve');
  const kb = loadKnowledgeBase(evolveDir);
  const stats = getStats(kb);

  console.log(pc.bold('\nEvolve Knowledge Base'));
  console.log(`  Entries: ${stats.totalResearched}`);
  console.log(`  Attempted: ${stats.totalAttempted}`);
  console.log(`  Approved: ${pc.green(String(stats.totalApproved))}`);
  console.log(`  Rejected: ${pc.red(String(stats.totalRejected))}`);
  console.log(`  Revised: ${pc.yellow(String(stats.totalRevised))}`);

  if (stats.topAreas.length > 0) {
    console.log('\n  Areas:');
    for (const a of stats.topAreas) {
      console.log(`    ${a.area}: ${a.count} entries`);
    }
  }

  // Search if query provided
  const query = options.query || options.search || '';
  const tags = options.tags ? options.tags.split(',') : [];

  if (query || tags.length > 0) {
    const results = searchEntries(kb, query, tags);
    console.log(`\n  Search results (${results.length}):`);
    for (const entry of results.slice(0, 20)) {
      const icon = entry.outcome === 'approve' ? pc.green('+')
        : entry.outcome === 'reject' ? pc.red('x')
        : entry.outcome === 'revise' ? pc.yellow('~')
        : pc.dim('?');
      console.log(`    ${icon} [${entry.id}] ${entry.area}: ${entry.finding.slice(0, 80)}`);
      if (entry.learnings) {
        console.log(pc.dim(`      Learnings: ${entry.learnings.slice(0, 80)}`));
      }
    }
  } else if (kb.entries.length > 0) {
    console.log('\n  Recent entries:');
    const recent = [...kb.entries].sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 10);
    for (const entry of recent) {
      const icon = entry.outcome === 'approve' ? pc.green('+')
        : entry.outcome === 'reject' ? pc.red('x')
        : entry.outcome === 'revise' ? pc.yellow('~')
        : pc.dim('?');
      console.log(`    ${icon} [${entry.id}] ${entry.area}: ${entry.finding.slice(0, 80)}`);
    }
  }

  console.log('');
}

// ── Suggestions Command ─────────────────────────────────────────────────────

function suggestionsCommand(projectRoot, options) {
  const evolveDir = path.join(projectRoot, 'docs', 'coordination', 'evolve');
  const sg = loadSuggestions(evolveDir);
  const statusFilter = options.status || null;
  const entries = statusFilter
    ? sg.entries.filter(e => e.status === statusFilter)
    : getPendingSuggestions(sg);

  const label = statusFilter ? `${statusFilter} suggestions` : 'pending suggestions';
  console.log(pc.bold(`\nEvolve Suggestions — ${entries.length} ${label}\n`));

  if (entries.length === 0) {
    console.log(pc.dim('  No suggestions found.'));
    console.log('');
    return;
  }

  for (const s of entries) {
    const statusColor = s.status === 'pending' ? pc.cyan
      : s.status === 'completed' ? pc.green
      : s.status === 'rejected' ? pc.red
      : s.status === 'exploring' ? pc.yellow
      : pc.dim;
    const priorityBadge = s.priority === 'high' ? pc.red('HIGH')
      : s.priority === 'low' ? pc.dim('low')
      : pc.yellow('med');

    console.log(`  ${statusColor(s.id)} ${pc.yellow(s.area)}: ${s.title.slice(0, 80)}`);
    const parts = [`status: ${statusColor(s.status)}`, `priority: ${priorityBadge}`];
    if (s.attempts > 0) {
      parts.push(`attempts: ${s.attempts}/${s.maxAttempts}`);
      if (s.lastAttemptScore != null) parts.push(`last: ${s.lastAttemptScore}/10`);
    }
    if (s.specPath) parts.push('has spec');
    console.log(`    ${pc.dim(parts.join(' | '))}`);
    console.log('');
  }

  const stats = getSuggestionStats(sg);
  console.log(pc.dim(`  Stats: ${stats.totalPending} pending, ${stats.totalCompleted} completed, ${stats.totalRejected} rejected, ${stats.totalAbandoned} abandoned`));
  console.log('');
}

// ── Main ────────────────────────────────────────────────────────────────────

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
    case 'knowledge':
      knowledgeCommand(projectRoot, options);
      break;
    case 'suggestions':
      suggestionsCommand(projectRoot, options);
      break;
    default:
      console.error(pc.red(`Unknown command: ${command}`));
      console.error('Usage: hydra-evolve-review.mjs [review|status|clean|knowledge|suggestions]');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(pc.red(`Fatal: ${err.message}`));
  process.exit(1);
});
