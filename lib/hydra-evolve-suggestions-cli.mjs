#!/usr/bin/env node
/**
 * Hydra Evolve Suggestions CLI — Manage the improvement suggestions backlog.
 *
 * Subcommands:
 *   list     — List suggestions (default: pending; use status=all for all)
 *   add      — Add a new suggestion (title=... area=... description=...)
 *   remove   — Remove a suggestion by ID (set to abandoned)
 *   reset    — Reset a suggestion back to pending
 *   import   — Scan decision artifacts and create suggestions for retryable rounds
 *   stats    — Show suggestion backlog statistics
 *
 * Usage:
 *   node lib/hydra-evolve-suggestions-cli.mjs
 *   node lib/hydra-evolve-suggestions-cli.mjs list status=all
 *   node lib/hydra-evolve-suggestions-cli.mjs add title="..." area=testing-reliability
 *   node lib/hydra-evolve-suggestions-cli.mjs remove SUG_003
 *   node lib/hydra-evolve-suggestions-cli.mjs reset SUG_003
 *   node lib/hydra-evolve-suggestions-cli.mjs import
 *   node lib/hydra-evolve-suggestions-cli.mjs stats
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { resolveProject, loadHydraConfig } from './hydra-config.mjs';
import { parseArgs } from './hydra-utils.mjs';
import {
  loadSuggestions,
  saveSuggestions,
  addSuggestion,
  updateSuggestion,
  removeSuggestion,
  getPendingSuggestions,
  getSuggestionById,
  searchSuggestions,
  getSuggestionStats,
} from './hydra-evolve-suggestions.mjs';
import pc from 'picocolors';

// ── Helpers ─────────────────────────────────────────────────────────────────

function createRL() {
  return readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
}

function askQuestion(rl, question) {
  return new Promise(resolve => rl.question(question, answer => resolve(answer.trim())));
}

function formatEntry(s) {
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
  if (s.source) parts.push(`source: ${s.source}`);
  console.log(`    ${pc.dim(parts.join(' | '))}`);

  if (s.notes) {
    const noteLines = s.notes.split('\n').filter(Boolean);
    for (const line of noteLines.slice(0, 2)) {
      console.log(`    ${pc.dim(line.slice(0, 100))}`);
    }
  }
  console.log('');
}

// ── List Command ────────────────────────────────────────────────────────────

function listCommand(evolveDir, options) {
  const sg = loadSuggestions(evolveDir);
  const statusFilter = options.status || null;
  const areaFilter = options.area || null;
  const query = options.query || null;

  let entries;
  if (statusFilter === 'all') {
    entries = searchSuggestions(sg, query, { area: areaFilter });
  } else if (statusFilter) {
    entries = searchSuggestions(sg, query, { status: statusFilter, area: areaFilter });
  } else {
    entries = query || areaFilter
      ? searchSuggestions(sg, query, { status: 'pending', area: areaFilter })
      : getPendingSuggestions(sg);
  }

  const label = statusFilter === 'all' ? 'all' : (statusFilter || 'pending');
  console.log(pc.bold(`\nSuggestions — ${entries.length} ${label}\n`));

  if (entries.length === 0) {
    console.log(pc.dim('  No suggestions found.'));
    console.log('');
    return;
  }

  for (const s of entries) {
    formatEntry(s);
  }
}

// ── Add Command ─────────────────────────────────────────────────────────────

async function addCommand(evolveDir, options) {
  const sg = loadSuggestions(evolveDir);
  let title = options.title || '';
  let area = options.area || '';
  let description = options.description || '';
  let priority = options.priority || 'medium';

  // Interactive mode if title not provided
  if (!title) {
    const cfg = loadHydraConfig();
    const focusAreas = cfg.evolve?.focusAreas || [];

    const rl = createRL();
    try {
      title = await askQuestion(rl, pc.cyan('  Title: '));
      if (!title) {
        console.log(pc.yellow('  Cancelled — no title provided.'));
        return;
      }

      if (focusAreas.length > 0) {
        console.log(pc.dim(`  Areas: ${focusAreas.join(', ')}`));
      }
      area = await askQuestion(rl, pc.cyan('  Area: '));
      description = await askQuestion(rl, pc.cyan('  Description (optional): '));
      const p = await askQuestion(rl, pc.cyan('  Priority [high/medium/low]: '));
      if (['high', 'medium', 'low'].includes(p)) priority = p;
    } finally {
      rl.close();
    }
  }

  if (!area) area = 'general';
  if (!description) description = title;

  const created = addSuggestion(sg, {
    source: 'user:manual',
    area,
    title,
    description,
    priority,
    tags: [area, 'user-submitted'],
  });

  if (created) {
    saveSuggestions(evolveDir, sg);
    console.log(pc.green(`\n  + Created: ${created.id} — ${created.title}`));
  } else {
    console.log(pc.yellow('\n  Similar suggestion already exists.'));
  }
  console.log('');
}

// ── Remove Command ──────────────────────────────────────────────────────────

function removeCommand(evolveDir, options, positionals) {
  const id = positionals[1] || options.id;
  if (!id) {
    console.error(pc.red('  Usage: remove <SUG_ID>'));
    return;
  }

  const sg = loadSuggestions(evolveDir);
  const entry = getSuggestionById(sg, id);
  if (!entry) {
    console.error(pc.red(`  Suggestion ${id} not found.`));
    return;
  }

  removeSuggestion(sg, id);
  saveSuggestions(evolveDir, sg);
  console.log(pc.yellow(`  ${id} marked as abandoned: ${entry.title.slice(0, 60)}`));
}

// ── Reset Command ───────────────────────────────────────────────────────────

function resetCommand(evolveDir, options, positionals) {
  const id = positionals[1] || options.id;
  if (!id) {
    console.error(pc.red('  Usage: reset <SUG_ID>'));
    return;
  }

  const sg = loadSuggestions(evolveDir);
  const entry = getSuggestionById(sg, id);
  if (!entry) {
    console.error(pc.red(`  Suggestion ${id} not found.`));
    return;
  }

  updateSuggestion(sg, id, { status: 'pending', attempts: 0, lastAttemptDate: null, lastAttemptVerdict: null, lastAttemptScore: null, lastAttemptLearnings: null });
  saveSuggestions(evolveDir, sg);
  console.log(pc.green(`  ${id} reset to pending: ${entry.title.slice(0, 60)}`));
}

// ── Import Command ──────────────────────────────────────────────────────────

function importCommand(evolveDir) {
  const decisionsDir = path.join(evolveDir, 'decisions');
  const specsDir = path.join(evolveDir, 'specs');

  if (!fs.existsSync(decisionsDir)) {
    console.log(pc.yellow('  No decisions directory found.'));
    return;
  }

  const sg = loadSuggestions(evolveDir);
  const files = fs.readdirSync(decisionsDir).filter(f => f.match(/^ROUND_\d+_DECISION\.json$/));
  let created = 0;

  for (const file of files) {
    try {
      const decision = JSON.parse(fs.readFileSync(path.join(decisionsDir, file), 'utf8'));
      // Only import rejected rounds with valid improvement text
      if (
        (decision.verdict === 'reject' || decision.verdict === 'revise') &&
        decision.improvement &&
        decision.improvement !== 'No improvement selected' &&
        decision.improvement.length >= 10
      ) {
        const roundNum = file.match(/ROUND_(\d+)/)?.[1];
        const specPath = roundNum ? path.join(specsDir, `ROUND_${roundNum}_SPEC.md`) : null;
        const hasSpec = specPath && fs.existsSync(specPath);

        const entry = addSuggestion(sg, {
          source: 'auto:rejected-round',
          sourceRef: `${decision.branchName || file}`,
          area: decision.area || 'general',
          title: decision.improvement.slice(0, 100),
          description: decision.improvement,
          specPath: hasSpec ? specPath : null,
          priority: decision.score >= 5 ? 'high' : 'medium',
          tags: [decision.area, 'imported', decision.verdict].filter(Boolean),
          notes: `Imported from ${file}. Score: ${decision.score}/10. ${decision.reason || ''}`.trim(),
        });

        if (entry) {
          created++;
          console.log(pc.green(`  + ${entry.id}: ${entry.title.slice(0, 70)}`));
        }
      }
    } catch {
      // Skip malformed files
    }
  }

  if (created > 0) {
    saveSuggestions(evolveDir, sg);
    console.log(pc.bold(`\n  Imported ${created} suggestion(s).`));
  } else {
    console.log(pc.dim('  No new suggestions to import (all already exist or no retryable rounds).'));
  }
  console.log('');
}

// ── Stats Command ───────────────────────────────────────────────────────────

function statsCommand(evolveDir) {
  const sg = loadSuggestions(evolveDir);
  const stats = getSuggestionStats(sg);

  console.log(pc.bold('\nSuggestions Backlog Stats\n'));
  console.log(`  Total entries:  ${sg.entries.length}`);
  console.log(`  Pending:        ${pc.cyan(String(stats.totalPending))}`);
  console.log(`  Exploring:      ${pc.yellow(String(stats.totalExploring || 0))}`);
  console.log(`  Completed:      ${pc.green(String(stats.totalCompleted))}`);
  console.log(`  Rejected:       ${pc.red(String(stats.totalRejected))}`);
  console.log(`  Abandoned:      ${pc.dim(String(stats.totalAbandoned))}`);

  // Area breakdown
  const areas = {};
  for (const e of sg.entries.filter(e => e.status === 'pending')) {
    areas[e.area] = (areas[e.area] || 0) + 1;
  }
  if (Object.keys(areas).length > 0) {
    console.log(pc.bold('\n  Pending by area:'));
    for (const [area, count] of Object.entries(areas).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${pc.yellow(area)}: ${count}`);
    }
  }

  console.log('');
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { options, positionals } = parseArgs(process.argv);
  const command = positionals[0] || 'list';

  let config;
  try {
    config = resolveProject({ project: options.project });
  } catch (err) {
    console.error(pc.red(`Project resolution failed: ${err.message}`));
    process.exit(1);
  }

  const { projectRoot } = config;
  const evolveDir = path.join(projectRoot, 'docs', 'coordination', 'evolve');

  switch (command) {
    case 'list':
      listCommand(evolveDir, options);
      break;
    case 'add':
      await addCommand(evolveDir, options);
      break;
    case 'remove':
      removeCommand(evolveDir, options, positionals);
      break;
    case 'reset':
      resetCommand(evolveDir, options, positionals);
      break;
    case 'import':
      importCommand(evolveDir);
      break;
    case 'stats':
      statsCommand(evolveDir);
      break;
    default:
      console.error(pc.red(`Unknown command: ${command}`));
      console.error('Usage: hydra-evolve-suggestions-cli.mjs [list|add|remove|reset|import|stats]');
      process.exit(1);
  }
}

main().catch(err => {
  console.error(pc.red(`Fatal: ${err.message}`));
  process.exit(1);
});
