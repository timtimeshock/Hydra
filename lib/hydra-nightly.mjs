#!/usr/bin/env node
/**
 * Hydra Nightly Runner — Autonomous, config-driven task execution pipeline.
 *
 * 6-phase pipeline:
 *   1. SCAN       — Aggregate tasks from TODO comments, TODO.md, GitHub issues, config
 *   2. DISCOVER   — (Optional) AI agent suggests improvement tasks
 *   3. PRIORITIZE — Deduplicate, sort by priority/complexity, cap at maxTasks
 *   4. SELECT     — (Optional, --interactive) Interactive task selection & confirmation
 *   5. EXECUTE    — Per-task: branch → classify → dispatch agent → verify → violations
 *   6. REPORT     — Generate JSON + Markdown morning reports
 *
 * Project-agnostic: works for any repo with hydra.config.json.
 * Uses intelligent agent routing, model recovery, investigator self-healing,
 * and budget-aware handoff. EXECUTE phase shows a live progress dashboard.
 *
 * Usage:
 *   node lib/hydra-nightly.mjs                             # defaults from config
 *   node lib/hydra-nightly.mjs project=/path/to/YourProject # explicit project
 *   node lib/hydra-nightly.mjs max-tasks=3 max-hours=2     # override limits
 *   node lib/hydra-nightly.mjs --no-discovery              # skip AI discovery
 *   node lib/hydra-nightly.mjs --dry-run                   # scan + prioritize only
 *   node lib/hydra-nightly.mjs --interactive               # interactive task selection
 */

import './hydra-env.mjs';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import pc from 'picocolors';

import { loadHydraConfig, resolveProject } from './hydra-config.mjs';
import { initAgentRegistry, classifyTask, bestAgentFor, getActiveModel } from './hydra-agents.mjs';
import { parseArgs, ensureDir, runProcess } from './hydra-utils.mjs';
import { resolveVerificationPlan } from './hydra-verification.mjs';
import { recordCallStart, recordCallComplete, recordCallError } from './hydra-metrics.mjs';
import { getAgentInstructionFile } from './hydra-sync-md.mjs';
import { BudgetTracker } from './hydra-shared/budget-tracker.mjs';
import { executeAgentWithRecovery } from './hydra-shared/agent-executor.mjs';
import { compactProgressBar, AGENT_COLORS, AGENT_ICONS } from './hydra-ui.mjs';
import {
  buildSafetyPrompt,
  verifyBranch,
  isCleanWorkingTree,
  scanBranchViolations,
} from './hydra-shared/guardrails.mjs';
import {
  git,
  getCurrentBranch,
  checkoutBranch,
  createBranch,
  branchExists,
  getBranchStats,
} from './hydra-shared/git-ops.mjs';
import { BASE_PROTECTED_FILES, BASE_PROTECTED_PATTERNS, BLOCKED_COMMANDS } from './hydra-shared/constants.mjs';
import {
  scanAllSources,
  createUserTask,
  deduplicateTasks,
  prioritizeTasks,
  taskToSlug,
} from './hydra-tasks-scanner.mjs';
import { runDiscovery } from './hydra-nightly-discovery.mjs';

// ── Logging ─────────────────────────────────────────────────────────────────

const log = {
  info:  (msg) => process.stderr.write(`  ${pc.blue('i')} ${msg}\n`),
  ok:    (msg) => process.stderr.write(`  ${pc.green('+')} ${msg}\n`),
  warn:  (msg) => process.stderr.write(`  ${pc.yellow('!')} ${msg}\n`),
  error: (msg) => process.stderr.write(`  ${pc.red('x')} ${msg}\n`),
  task:  (msg) => process.stderr.write(`\n${pc.bold(pc.cyan('>'))} ${pc.bold(msg)}\n`),
  dim:   (msg) => process.stderr.write(`  ${pc.dim(msg)}\n`),
  phase: (name) => process.stderr.write(`\n${pc.bold(pc.magenta(`[${name}]`))}\n`),
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatDuration(ms) {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return `${mins}m ${remSecs}s`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h ${remMins}m`;
}

// ── Budget Thresholds ───────────────────────────────────────────────────────

function buildThresholds(budgetCfg) {
  return [
    { pct: 0.95, action: 'hard_stop', reason: 'Hard limit reached: {pct}% of budget used' },
    { pct: 0.85, action: 'soft_stop', reason: 'Soft limit reached: {pct}% budget ({consumed} tokens)' },
    { pct: budgetCfg.handoffThreshold || 0.70, action: 'handoff', reason: '{pct}% budget — handing remaining tasks to handoff agent', once: true },
    { pct: 0.50, action: 'warn', reason: '{pct}% budget used ({consumed} tokens)' },
  ];
}

// ── Prompt Builder ──────────────────────────────────────────────────────────

function buildTaskPrompt(task, branchName, projectRoot, agent, opts = {}) {
  const instructionFile = getAgentInstructionFile(agent, projectRoot);
  const safetyBlock = buildSafetyPrompt(branchName, {
    runner: 'nightly runner',
    reportName: 'morning report',
    protectedFiles: new Set(BASE_PROTECTED_FILES),
    blockedCommands: BLOCKED_COMMANDS,
    attribution: { pipeline: 'hydra-nightly', agent },
  });

  const bodySection = task.body
    ? `\n## Details\n${task.body}\n`
    : '';

  const sourceNote = task.sourceRef
    ? `**Source:** ${task.source} (${task.sourceRef})`
    : `**Source:** ${task.source}`;

  const handoffNote = opts.isHandoff
    ? `\n## Context\nYou are taking over from a previous agent to conserve budget. Be efficient.\n`
    : '';

  return `# Nightly Autonomous Task

**Task:** ${task.title}
**Branch:** \`${branchName}\` (already checked out)
**Project:** ${projectRoot}
${sourceNote}
${handoffNote}
## Instructions
1. Read the project's ${instructionFile} for conventions and patterns
2. Read relevant source files to understand the codebase
3. Implement the task with focused, minimal changes
4. Commit your work with a descriptive message
5. Run verification and fix any issues you introduce
${bodySection}
${safetyBlock}

## Begin
Start working on the task now.`;
}

// ── Verification ────────────────────────────────────────────────────────────

function runVerification(projectRoot) {
  const plan = resolveVerificationPlan(projectRoot);
  if (!plan.enabled) {
    return { ran: false, passed: true, command: '', output: '' };
  }

  log.dim(`Verifying: ${plan.command}`);
  const parts = plan.command.split(' ');
  const result = runProcess(parts[0], parts.slice(1), plan.timeoutMs, { cwd: projectRoot });

  return {
    ran: true,
    passed: result.ok,
    command: plan.command,
    output: (result.stdout || '').slice(-2000) + (result.stderr || '').slice(-1000),
  };
}

// ── Investigator (lazy-load) ────────────────────────────────────────────────

let _investigator = null;
async function getInvestigator() {
  if (_investigator) return _investigator;
  try {
    _investigator = await import('./hydra-investigator.mjs');
    return _investigator;
  } catch {
    return null;
  }
}

// ── Report Generation ───────────────────────────────────────────────────────

function generateReportJSON(results, budgetSummary, runMeta) {
  return {
    ...runMeta,
    budget: budgetSummary,
    results: results.map((r) => ({
      slug: r.slug,
      title: r.title,
      branch: r.branch,
      source: r.source,
      taskType: r.taskType,
      status: r.status,
      agent: r.agent,
      tokensUsed: r.tokensUsed,
      durationMs: r.durationMs,
      commits: r.commits,
      filesChanged: r.filesChanged,
      verification: r.verification,
      violations: r.violations,
    })),
  };
}

function generateReportMd(results, budgetSummary, runMeta) {
  const { startedAt, finishedAt, date, baseBranch, sources, totalTasks, processedTasks, stopReason } = runMeta;

  const startStr = new Date(startedAt).toLocaleTimeString('en-US', { hour12: false });
  const endStr = new Date(finishedAt).toLocaleTimeString('en-US', { hour12: false });
  const durationStr = formatDuration(finishedAt - startedAt);
  const tokensStr = `~${budgetSummary.consumed.toLocaleString()}`;

  const sourceSummary = Object.entries(sources || {})
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');

  const lines = [
    `# Nightly Run - ${date}`,
    `Started: ${startStr} | Finished: ${endStr} | Duration: ${durationStr}`,
    `Tasks: ${processedTasks}/${totalTasks} processed` +
      (stopReason ? ` (stopped: ${stopReason})` : '') +
      ` | Tokens: ${tokensStr}`,
    `Base branch: ${baseBranch} | Sources: ${sourceSummary || 'n/a'}`,
    '',
    '## Results',
  ];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const tokenNote = r.tokensUsed ? ` - ~${r.tokensUsed.toLocaleString()} tokens` : '';
    const statusTag = r.status.toUpperCase();
    const agentNote = ` (${r.agent})`;

    lines.push(`### ${i + 1}. ${r.slug} [${statusTag}]${tokenNote}${agentNote}`);
    lines.push(`- Branch: \`${r.branch}\``);
    lines.push(`- Source: ${r.source} | Type: ${r.taskType}`);
    lines.push(`- Commits: ${r.commits} | Files: ${r.filesChanged} | Verification: ${r.verification}`);
    if (r.violations.length > 0) {
      lines.push(`- **Violations:** ${r.violations.length}`);
      for (const v of r.violations) {
        lines.push(`  - [${v.severity}] ${v.detail}`);
      }
    }
    lines.push(`- Duration: ${formatDuration(r.durationMs)}`);
    lines.push(`- Review: \`git log ${baseBranch}..${r.branch} --oneline\``);
    lines.push('');
  }

  lines.push('## Quick Commands');
  lines.push('```');
  lines.push(`git branch --list "nightly/${date}/*"    # list branches`);
  lines.push(`git diff ${baseBranch}...nightly/${date}/<slug>     # review changes`);
  lines.push('npm run nightly:review                    # interactive merge');
  lines.push('npm run nightly:clean                     # delete all nightly branches');
  lines.push('```');
  lines.push('');
  lines.push('## Budget Summary');
  lines.push(`- Consumed: ${budgetSummary.consumed.toLocaleString()} of ${budgetSummary.hardLimit.toLocaleString()} limit`);
  lines.push(`- Avg per task: ${(budgetSummary.avgPerTask || 0).toLocaleString()}`);
  if (budgetSummary.taskDeltas?.length > 0) {
    lines.push('');
    lines.push('| Task | Tokens | Duration |');
    lines.push('|------|--------|----------|');
    for (const d of budgetSummary.taskDeltas) {
      lines.push(`| ${d.label} | ${d.tokens.toLocaleString()} | ${formatDuration(d.durationMs)} |`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

// ── Phase 1: SCAN ───────────────────────────────────────────────────────────

function phaseScan(projectRoot, cfg) {
  log.phase('SCAN');
  const sources = cfg.nightly.sources;
  const sourceCounts = {};

  // Multi-source scan via tasks-scanner
  const scanned = scanAllSources(projectRoot, {
    todoComments: sources.todoComments,
    todoMd: sources.todoMd,
    githubIssues: sources.githubIssues,
  });

  // Count by source type
  for (const t of scanned) {
    sourceCounts[t.source] = (sourceCounts[t.source] || 0) + 1;
  }

  // Config-defined static tasks
  const configTasks = [];
  if (sources.configTasks && cfg.nightly.tasks?.length > 0) {
    for (const text of cfg.nightly.tasks) {
      configTasks.push(createUserTask(text));
    }
    sourceCounts['config'] = configTasks.length;
  }

  const allTasks = [...scanned, ...configTasks];
  log.info(`Scanned ${allTasks.length} tasks from ${Object.keys(sourceCounts).length} source(s)`);
  for (const [src, count] of Object.entries(sourceCounts)) {
    log.dim(`  ${src}: ${count}`);
  }

  return { tasks: allTasks, sourceCounts };
}

// ── Phase 2: DISCOVER ───────────────────────────────────────────────────────

async function phaseDiscover(projectRoot, existingTasks, cfg) {
  if (!cfg.nightly.sources.aiDiscovery) {
    log.dim('AI discovery: disabled');
    return [];
  }

  log.phase('DISCOVER');
  const discoveryCfg = cfg.nightly.aiDiscovery;

  const discovered = await runDiscovery(projectRoot, {
    agent: discoveryCfg.agent,
    maxSuggestions: discoveryCfg.maxSuggestions,
    focus: discoveryCfg.focus,
    timeoutMs: discoveryCfg.timeoutMs,
    existingTasks: existingTasks.map(t => t.title),
  });

  return discovered;
}

// ── Phase 3: PRIORITIZE ─────────────────────────────────────────────────────

function phasePrioritize(allTasks, maxTasks) {
  log.phase('PRIORITIZE');
  const deduped = deduplicateTasks(allTasks);
  const sorted = prioritizeTasks(deduped);
  const selected = sorted.slice(0, maxTasks);

  log.info(`${allTasks.length} total -> ${deduped.length} deduped -> ${selected.length} selected`);
  for (const t of selected) {
    const prioColor = t.priority === 'high' ? pc.red : t.priority === 'low' ? pc.dim : pc.yellow;
    log.dim(`  ${prioColor(t.priority.padEnd(6))} [${t.source}] ${t.title}`);
  }

  return selected;
}

// ── Phase 3b: SELECT (interactive) ─────────────────────────────────────────

const SOURCE_ORDER = ['todo-md', 'todo-comment', 'github-issue', 'config', 'ai-discovery'];

function sourceRank(source) {
  const idx = SOURCE_ORDER.indexOf(source);
  return idx >= 0 ? idx : SOURCE_ORDER.length;
}

function askLine(rl, question) {
  return new Promise(resolve => {
    rl.question(question, answer => resolve(answer.trim()));
  });
}

async function phaseSelect(sortedTasks, maxTasks) {
  log.phase('SELECT');

  if (sortedTasks.length === 0) {
    log.warn('No tasks found to select from.');
    return null;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  try {
    const recommended = sortedTasks.slice(0, maxTasks);

    // Display all tasks grouped by source
    const grouped = new Map();
    for (const t of sortedTasks) {
      const src = t.source || 'unknown';
      if (!grouped.has(src)) grouped.set(src, []);
      grouped.get(src).push(t);
    }

    // Sort groups by SOURCE_ORDER
    const sortedGroups = [...grouped.entries()].sort((a, b) => sourceRank(a[0]) - sourceRank(b[0]));

    // Display numbered list
    let globalIdx = 0;
    const indexMap = new Map(); // globalIdx -> task
    const recommendedSet = new Set(recommended);

    process.stderr.write('\n');
    for (const [source, tasks] of sortedGroups) {
      process.stderr.write(`  ${pc.bold(pc.blue(source))} (${tasks.length})\n`);
      for (const t of tasks) {
        globalIdx++;
        indexMap.set(globalIdx, t);
        const marker = recommendedSet.has(t) ? pc.green('*') : ' ';
        const prioColor = t.priority === 'high' ? pc.red : t.priority === 'low' ? pc.dim : pc.yellow;
        const num = String(globalIdx).padStart(3);
        const agent = t.suggestedAgent || 'auto';
        process.stderr.write(`  ${marker}${pc.bold(num)}. ${prioColor(t.priority.padEnd(6))} ${t.title} ${pc.dim(`[${agent}]`)}\n`);
      }
      process.stderr.write('\n');
    }

    process.stderr.write(pc.dim(`  * = recommended (top ${recommended.length})\n\n`));

    // Initial action prompt
    process.stderr.write(pc.dim(`  Options:\n`));
    process.stderr.write(pc.dim(`    Enter        Accept recommended ${recommended.length} tasks\n`));
    process.stderr.write(pc.dim(`    1,3,5        Pick specific tasks by number\n`));
    process.stderr.write(pc.dim(`    all          Select all ${sortedTasks.length} tasks\n`));
    process.stderr.write(pc.dim(`    add          Add a custom freeform task\n`));
    process.stderr.write(pc.dim(`    q            Cancel nightly run\n\n`));

    const answer = await askLine(rl, pc.bold('  Select tasks: '));

    let selected;
    if (!answer || answer === '') {
      // Accept recommended
      selected = [...recommended];
      log.ok(`Accepted ${selected.length} recommended tasks`);
    } else if (answer === 'q' || answer === 'quit') {
      rl.close();
      return null;
    } else if (answer === 'all') {
      selected = [...sortedTasks];
      log.ok(`Selected all ${selected.length} tasks`);
    } else if (answer === 'add') {
      selected = [];
      let adding = true;
      while (adding) {
        const text = await askLine(rl, '  Enter task description (empty to stop): ');
        if (!text) {
          adding = false;
        } else {
          selected.push(createUserTask(text));
          log.ok(`Added: ${text}`);
        }
      }
      if (selected.length === 0) {
        rl.close();
        return null;
      }
    } else {
      // Parse comma-separated numbers
      const indices = answer.split(',')
        .map(s => parseInt(s.trim(), 10))
        .filter(i => i >= 1 && indexMap.has(i));

      if (indices.length === 0) {
        log.warn('No valid selections.');
        rl.close();
        return null;
      }
      selected = indices.map(i => indexMap.get(i));
      log.ok(`Selected ${selected.length} task(s)`);
    }

    // Offer to add more freeform tasks
    const addMore = await askLine(rl, pc.dim('  Add custom tasks? (y/N): '));
    if (addMore === 'y' || addMore === 'yes') {
      let adding = true;
      while (adding) {
        const text = await askLine(rl, '  Enter task description (empty to stop): ');
        if (!text) {
          adding = false;
        } else {
          selected.push(createUserTask(text));
          log.ok(`Added: ${text}`);
        }
      }
    }

    // Show final selection summary
    process.stderr.write(`\n  ${pc.bold('Final selection')} (${selected.length} tasks):\n`);
    for (let i = 0; i < selected.length; i++) {
      const t = selected[i];
      const agent = t.suggestedAgent || 'auto';
      process.stderr.write(`    ${pc.bold(String(i + 1).padStart(2))}. ${t.title} ${pc.dim(`[${t.source}] → ${agent}`)}\n`);
    }
    process.stderr.write('\n');

    const confirm = await askLine(rl, pc.bold('  Proceed? (Y/n): '));
    if (confirm === 'n' || confirm === 'no') {
      rl.close();
      return null;
    }

    rl.close();
    return selected;
  } catch (err) {
    rl.close();
    log.error(`Selection error: ${err.message}`);
    return null;
  }
}

// ── Progress Dashboard ─────────────────────────────────────────────────────

const STATUS_ICONS = {
  pending:  pc.dim('[ ]'),
  running:  pc.bold(pc.cyan('[~]')),
  success:  pc.green('[+]'),
  error:    pc.red('[x]'),
  skipped:  pc.yellow('[-]'),
  timeout:  pc.yellow('[!]'),
  partial:  pc.yellow('[~]'),
};

function getAgentColor(agent) {
  return AGENT_COLORS[agent] || pc.white;
}

function truncate(str, maxLen) {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '\u2026';
}

function renderProgress(tasks, results, budget, startedAt, maxHoursMs, currentIdx) {
  const lines = [];
  const elapsed = Date.now() - startedAt;
  const elapsedStr = formatDuration(elapsed);
  const maxStr = formatDuration(maxHoursMs);

  lines.push('');
  lines.push(`  ${pc.bold('Task Progress:')}`);

  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const r = results[i]; // undefined if not yet processed
    const agent = r?.agent || t.suggestedAgent || 'auto';
    const colorFn = getAgentColor(agent);
    const title = truncate(t.title, 42);

    if (r) {
      // Completed task
      const icon = STATUS_ICONS[r.status] || STATUS_ICONS.pending;
      const dur = formatDuration(r.durationMs);
      const tok = r.tokensUsed > 0 ? `~${(r.tokensUsed / 1000).toFixed(0)}K tok` : '';
      lines.push(`    ${icon} ${pc.bold(String(i + 1).padStart(2))}. ${title}  ${colorFn(agent.padEnd(7))} ${pc.dim(dur.padStart(7))}  ${pc.dim(tok)}`);
    } else if (i === currentIdx) {
      // Currently running
      lines.push(`    ${STATUS_ICONS.running} ${pc.bold(String(i + 1).padStart(2))}. ${pc.bold(title)}  ${colorFn(agent.padEnd(7))} ${pc.dim('...')}`);
    } else {
      // Pending
      lines.push(`    ${STATUS_ICONS.pending} ${pc.bold(String(i + 1).padStart(2))}. ${pc.dim(title)}  ${pc.dim(agent)}`);
    }
  }

  // Budget gauge
  const summary = budget.getSummary();
  const pct = summary.hardLimit > 0 ? (summary.consumed / summary.hardLimit) * 100 : 0;
  const gauge = compactProgressBar(pct, 15);
  const remaining = tasks.length - results.length;
  const remainStr = remaining > 0 ? `  Remaining: ~${remaining} tasks` : '';

  lines.push('');
  lines.push(`  Budget: ${gauge} ${pct.toFixed(1)}%  Time: ${elapsedStr} / ${maxStr}${remainStr}`);
  lines.push('');

  process.stderr.write(lines.join('\n') + '\n');
}

// ── Phase 4: EXECUTE ────────────────────────────────────────────────────────

async function phaseExecute(tasks, projectRoot, cfg, startedAt) {
  log.phase('EXECUTE');

  const nightlyCfg = cfg.nightly;
  const budgetCfg = nightlyCfg.budget;
  const baseBranch = nightlyCfg.baseBranch;
  const branchPrefix = nightlyCfg.branchPrefix;
  const perTaskTimeoutMs = nightlyCfg.perTaskTimeoutMs;
  const maxHoursMs = nightlyCfg.maxHours * 60 * 60 * 1000;
  const dateStr = new Date().toISOString().split('T')[0];

  // Initialize budget tracker
  const budget = new BudgetTracker({
    softLimit: budgetCfg.softLimit,
    hardLimit: budgetCfg.hardLimit,
    unitEstimate: budgetCfg.perTaskEstimate,
    unitLabel: 'task',
    thresholds: buildThresholds(budgetCfg),
  });
  budget.recordStart();
  log.info(`Budget: ${budget.hardLimit.toLocaleString()} token hard limit`);

  const results = [];
  let stopReason = null;
  let useHandoff = false;

  // Initial overview
  renderProgress(tasks, results, budget, startedAt, maxHoursMs, 0);

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const branchName = `${branchPrefix}/${dateStr}/${task.slug}`;

    // Time limit check
    if (Date.now() - startedAt > maxHoursMs) {
      stopReason = 'time limit';
      log.warn(`Time limit reached (${formatDuration(maxHoursMs)}). Stopping.`);
      break;
    }

    // Budget check
    const budgetCheck = budget.check();

    if (budgetCheck.action === 'hard_stop') {
      stopReason = 'hard budget limit';
      log.error(`HARD STOP: ${budgetCheck.reason}`);
      break;
    }

    if (budgetCheck.action === 'soft_stop') {
      stopReason = 'soft budget limit';
      log.warn(`SOFT STOP: ${budgetCheck.reason}`);
      break;
    }

    if (budgetCheck.action === 'handoff') {
      useHandoff = true;
      log.warn(budgetCheck.reason);
      log.info(`Remaining tasks will use ${budgetCfg.handoffAgent} (${budgetCfg.handoffModel})`);
    }

    if (budgetCheck.action === 'warn') {
      log.warn(budgetCheck.reason);
    }

    if (!budgetCheck.canFitNextTask && i > 0) {
      stopReason = 'predicted budget exceeded';
      log.warn(`Predicted next task would exceed remaining budget. Stopping.`);
      break;
    }

    // Select agent
    let agent;
    let modelOverride;
    if (useHandoff) {
      agent = budgetCfg.handoffAgent || 'codex';
      modelOverride = budgetCfg.handoffModel || 'o4-mini';
    } else {
      const taskType = classifyTask(task.title);
      agent = task.suggestedAgent || bestAgentFor(taskType);
      modelOverride = undefined;
    }

    log.task(`Task ${i + 1}/${tasks.length}: ${task.title} [${agent}${modelOverride ? `:${modelOverride}` : ''}]`);

    // Skip if branch already exists (e.g., from a previous aborted run)
    if (branchExists(projectRoot, branchName)) {
      log.warn(`Branch already exists: ${branchName} — skipping`);
      results.push({
        slug: task.slug, title: task.title, branch: branchName,
        source: task.source, taskType: task.taskType || 'unknown',
        status: 'skipped', agent, tokensUsed: 0, durationMs: 0,
        commits: 0, filesChanged: 0, verification: 'SKIP', violations: [],
      });
      continue;
    }

    // Create branch from baseBranch
    if (!createBranch(projectRoot, branchName, baseBranch)) {
      log.error(`Failed to create branch: ${branchName}`);
      results.push({
        slug: task.slug, title: task.title, branch: branchName,
        source: task.source, taskType: task.taskType || 'unknown',
        status: 'error', agent, tokensUsed: 0, durationMs: 0,
        commits: 0, filesChanged: 0, verification: 'SKIP',
        violations: [], error: 'Branch creation failed',
      });
      checkoutBranch(projectRoot, baseBranch);
      continue;
    }
    log.ok(`Branch: ${branchName}`);

    // Build prompt
    const prompt = buildTaskPrompt(task, branchName, projectRoot, agent, {
      isHandoff: useHandoff,
    });

    // Dispatch agent with progress feedback
    const handle = recordCallStart(agent, modelOverride || getActiveModel(agent));
    log.dim(`Dispatching ${agent}${modelOverride ? ` (${modelOverride})` : ''}...`);

    let agentResult = await executeAgentWithRecovery(agent, prompt, {
      cwd: projectRoot,
      timeoutMs: perTaskTimeoutMs,
      modelOverride,
      progressIntervalMs: 15_000,
      onProgress: (elapsed, outputKB) => {
        const elStr = formatDuration(elapsed);
        const kbStr = outputKB > 0 ? ` | ${outputKB}KB` : '';
        process.stderr.write(`\r  ${pc.dim(`${agent}: working... ${elStr}${kbStr}`)}${' '.repeat(20)}`);
      },
    });
    process.stderr.write('\r' + ' '.repeat(80) + '\r'); // clear progress line

    // Investigator self-healing on failure
    if (!agentResult.ok && nightlyCfg.investigator?.enabled) {
      const inv = await getInvestigator();
      if (inv) {
        try {
          log.dim('Investigating failure...');
          const diagnosis = await inv.investigate({
            agent,
            prompt,
            error: agentResult.error || agentResult.stderr || '',
            output: agentResult.stdout || agentResult.output || '',
            projectRoot,
          });

          if (diagnosis && (diagnosis.category === 'transient' || diagnosis.category === 'fixable')) {
            log.info(`Investigator: ${diagnosis.category} — retrying...`);
            agentResult = await executeAgentWithRecovery(agent, prompt, {
              cwd: projectRoot,
              timeoutMs: perTaskTimeoutMs,
              modelOverride,
            });
          }
        } catch (invErr) {
          log.dim(`Investigator error: ${invErr.message}`);
        }
      }
    }

    // Doctor notification on persistent failure
    if (!agentResult.ok) {
      import('./hydra-doctor.mjs').then((doc) => {
        if (doc.isDoctorEnabled()) doc.diagnose({
          pipeline: 'nightly', phase: 'execute', agent,
          error: agentResult.error || agentResult.stderr || '',
          exitCode: agentResult.exitCode ?? null,
          signal: agentResult.signal || null,
          command: agentResult.command,
          args: agentResult.args,
          promptSnippet: agentResult.promptSnippet,
          stderr: agentResult.stderr, stdout: agentResult.stdout || agentResult.output,
          errorCategory: agentResult.errorCategory || null,
          errorDetail: agentResult.errorDetail || null,
          errorContext: agentResult.errorContext || null,
          timedOut: agentResult.timedOut || false,
          taskTitle: task.title, branchName,
        });
      }).catch(() => {});
    }

    if (agentResult.ok) {
      recordCallComplete(handle, agentResult);
    } else {
      recordCallError(handle, new Error(agentResult.error || 'unknown'));
    }

    const taskDurationMs = agentResult.durationMs || 0;
    const tokenDelta = budget.recordUnitEnd(task.slug, taskDurationMs);

    if (agentResult.timedOut) {
      log.warn(`Task timed out after ${formatDuration(perTaskTimeoutMs)}`);
    }

    // Verify branch integrity
    const branchCheck = verifyBranch(projectRoot, branchName);
    if (!branchCheck.ok) {
      log.error(`Branch escape detected! Expected '${branchName}', on '${branchCheck.currentBranch}'`);
      try { git(['checkout', branchName], projectRoot); } catch { /* best effort */ }
    }

    // Run verification
    const verification = runVerification(projectRoot);
    const verificationStatus = !verification.ran ? 'SKIP' : verification.passed ? 'PASS' : 'FAIL';
    if (verification.ran) {
      if (verification.passed) log.ok(`Verification: PASS`);
      else log.warn(`Verification: FAIL`);
    }

    // Scan for violations
    const violations = scanBranchViolations(projectRoot, branchName, {
      baseBranch,
      protectedFiles: new Set(BASE_PROTECTED_FILES),
      protectedPatterns: [...BASE_PROTECTED_PATTERNS],
    });
    if (violations.length > 0) {
      log.warn(`${violations.length} violation(s) detected`);
      for (const v of violations) {
        log.dim(`  [${v.severity}] ${v.detail}`);
      }
    }

    // Get commit/file stats
    const stats = getBranchStats(projectRoot, branchName, baseBranch);

    // Determine status
    let status = 'success';
    if (agentResult.timedOut) status = 'timeout';
    else if (!agentResult.ok) status = 'error';
    else if (!verification.passed && verification.ran) status = 'partial';

    const taskTokens = tokenDelta.tokens;
    log.ok(`Done: ${status} | ${stats.commits} commits | ${stats.filesChanged} files | ~${taskTokens.toLocaleString()} tokens | ${formatDuration(taskDurationMs)}`);

    results.push({
      slug: task.slug,
      title: task.title,
      branch: branchName,
      source: task.source,
      taskType: task.taskType || 'unknown',
      status,
      agent,
      tokensUsed: taskTokens,
      durationMs: taskDurationMs,
      commits: stats.commits,
      filesChanged: stats.filesChanged,
      verification: verificationStatus,
      violations,
    });

    // Return to baseBranch for next task
    checkoutBranch(projectRoot, baseBranch);

    // Refresh progress dashboard
    renderProgress(tasks, results, budget, startedAt, maxHoursMs, i + 1);
  }

  // Always return to baseBranch
  const finalBranch = getCurrentBranch(projectRoot);
  if (finalBranch !== baseBranch) {
    checkoutBranch(projectRoot, baseBranch);
  }

  return { results, budget, stopReason };
}

// ── Phase 5: REPORT ─────────────────────────────────────────────────────────

function phaseReport(results, budget, runMeta, coordDir) {
  log.phase('REPORT');

  const nightlyDir = path.join(coordDir, 'nightly');
  ensureDir(nightlyDir);

  const budgetSummary = budget.getSummary();

  const mdReport = generateReportMd(results, budgetSummary, runMeta);
  const jsonReport = generateReportJSON(results, budgetSummary, runMeta);

  const mdPath = path.join(nightlyDir, `NIGHTLY_${runMeta.date}.md`);
  const jsonPath = path.join(nightlyDir, `NIGHTLY_${runMeta.date}.json`);

  fs.writeFileSync(mdPath, mdReport, 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2), 'utf8');

  log.ok(`Report saved: ${mdPath}`);
  log.ok(`JSON saved:   ${jsonPath}`);

  return { mdPath, jsonPath, budgetSummary };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { options } = parseArgs(process.argv);
  const startedAt = Date.now();
  const dateStr = new Date().toISOString().split('T')[0];

  // Resolve project
  let projectConfig;
  try {
    projectConfig = resolveProject({ project: options.project });
  } catch (err) {
    log.error(`Project resolution failed: ${err.message}`);
    process.exit(1);
  }

  const { projectRoot, coordDir } = projectConfig;
  log.info(`Project: ${projectRoot}`);

  // Initialize agent registry
  initAgentRegistry();

  // Load config
  const cfg = loadHydraConfig();
  const nightlyCfg = cfg.nightly;
  const baseBranch = nightlyCfg.baseBranch;

  // Apply CLI overrides
  if (options['max-tasks']) nightlyCfg.maxTasks = parseInt(options['max-tasks'], 10);
  if (options['max-hours']) nightlyCfg.maxHours = parseFloat(options['max-hours']);
  if (options['no-discovery']) nightlyCfg.sources.aiDiscovery = false;

  const isDryRun = !!options['dry-run'];

  // Validate preconditions
  const currentBranch = getCurrentBranch(projectRoot);
  if (currentBranch !== baseBranch) {
    log.error(`Must be on '${baseBranch}' branch (currently on '${currentBranch}')`);
    process.exit(1);
  }

  if (!isCleanWorkingTree(projectRoot)) {
    log.error('Working tree is not clean. Commit or stash changes first.');
    process.exit(1);
  }

  log.ok(`Preconditions met: on ${baseBranch}, clean working tree`);

  // Phase 1: SCAN
  const { tasks: scannedTasks, sourceCounts } = phaseScan(projectRoot, cfg);

  // Phase 2: DISCOVER
  const discoveredTasks = await phaseDiscover(projectRoot, scannedTasks, cfg);
  const allTasks = [...scannedTasks, ...discoveredTasks];
  if (discoveredTasks.length > 0) {
    sourceCounts['ai-discovery'] = discoveredTasks.length;
  }

  // Phase 3: PRIORITIZE + optional SELECT
  const isInteractive = !!options['interactive'];

  let selectedTasks;
  if (isInteractive && !isDryRun && process.stdin.isTTY) {
    // Deduplicate and sort, but let the user pick
    log.phase('PRIORITIZE');
    const deduped = deduplicateTasks(allTasks);
    const sorted = prioritizeTasks(deduped);
    log.info(`${allTasks.length} total -> ${deduped.length} unique -> interactive selection`);

    const userSelected = await phaseSelect(sorted, nightlyCfg.maxTasks);
    if (!userSelected || userSelected.length === 0) {
      log.warn('Cancelled.');
      process.exit(0);
    }
    selectedTasks = userSelected;
  } else {
    selectedTasks = phasePrioritize(allTasks, nightlyCfg.maxTasks);
  }

  if (selectedTasks.length === 0) {
    log.warn('No tasks to execute. Nothing to do.');
    process.exit(0);
  }

  // Dry run: stop here
  if (isDryRun) {
    console.log('');
    console.log(pc.bold('=== Dry Run Complete ==='));
    console.log(`  Would execute ${selectedTasks.length} task(s):`);
    for (const t of selectedTasks) {
      console.log(`    - [${t.source}] ${t.title} -> ${t.suggestedAgent}`);
    }
    console.log('');
    process.exit(0);
  }

  // Phase 4: EXECUTE
  const { results, budget, stopReason } = await phaseExecute(selectedTasks, projectRoot, cfg, startedAt);

  // Phase 5: REPORT
  const finishedAt = Date.now();
  const runMeta = {
    startedAt,
    finishedAt,
    date: dateStr,
    project: projectRoot,
    baseBranch,
    sources: sourceCounts,
    totalTasks: selectedTasks.length,
    processedTasks: results.length,
    stopReason,
  };

  const { budgetSummary } = phaseReport(results, budget, runMeta, coordDir);

  // Summary
  const successCount = results.filter(r => r.status === 'success').length;
  const failCount = results.filter(r => r.status !== 'success' && r.status !== 'skipped').length;
  const skipCount = results.filter(r => r.status === 'skipped').length;

  console.log('');
  console.log(pc.bold('=== Nightly Run Complete ==='));
  console.log(`  Tasks: ${pc.green(successCount + ' passed')}${failCount ? `, ${pc.red(failCount + ' failed')}` : ''}${skipCount ? `, ${pc.dim(skipCount + ' skipped')}` : ''} of ${selectedTasks.length} queued`);
  console.log(`  Tokens: ~${budgetSummary.consumed.toLocaleString()} consumed`);
  console.log(`  Duration: ${formatDuration(finishedAt - startedAt)}`);
  if (stopReason) console.log(`  Stopped: ${stopReason}`);
  console.log(`  Review: npm run nightly:review`);
  console.log('');
}

// ── Entry ───────────────────────────────────────────────────────────────────

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  // Always try to get back to baseBranch
  try {
    const cfg = loadHydraConfig();
    const baseBranch = cfg.nightly?.baseBranch || 'dev';
    const projectRoot = process.cwd();
    const branch = getCurrentBranch(projectRoot);
    if (branch !== baseBranch && branch.startsWith('nightly/')) {
      checkoutBranch(projectRoot, baseBranch);
    }
  } catch { /* last resort */ }
  process.exit(1);
});
