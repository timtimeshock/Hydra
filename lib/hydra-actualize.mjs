#!/usr/bin/env node
/**
 * Hydra Actualize — experimental self-actualization runner.
 *
 * A pragmatic autonomous loop for improving Hydra (or any project) by:
 *   SELF-SNAPSHOT → SCAN → DISCOVER → PRIORITIZE → EXECUTE (branch per task) → REPORT
 *
 * Notes:
 * - Makes changes only on isolated branches (default prefix: actualize/<date>/...)
 * - Does not auto-merge; use hydra-actualize-review.mjs to merge/clean
 *
 * Usage:
 *   node lib/hydra-actualize.mjs                       # defaults
 *   node lib/hydra-actualize.mjs max-tasks=3 max-hours=2
 *   node lib/hydra-actualize.mjs --dry-run
 *   node lib/hydra-actualize.mjs --interactive
 */

import './hydra-env.mjs';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import pc from 'picocolors';

import { resolveProject, loadHydraConfig, HYDRA_ROOT } from './hydra-config.mjs';
import { initAgentRegistry, classifyTask, bestAgentFor, getActiveModel } from './hydra-agents.mjs';
import { parseArgs, ensureDir, runProcess } from './hydra-utils.mjs';
import { resolveVerificationPlan } from './hydra-verification.mjs';
import { recordCallStart, recordCallComplete, recordCallError } from './hydra-metrics.mjs';
import { getAgentInstructionFile } from './hydra-sync-md.mjs';
import { BudgetTracker } from './hydra-shared/budget-tracker.mjs';
import { executeAgentWithRecovery } from './hydra-shared/agent-executor.mjs';
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
  deduplicateTasks,
  prioritizeTasks,
} from './hydra-tasks-scanner.mjs';
import { runDiscovery } from './hydra-nightly-discovery.mjs';
import { buildSelfSnapshot, formatSelfSnapshotForPrompt } from './hydra-self.mjs';
import { buildSelfIndex, formatSelfIndexForPrompt } from './hydra-self-index.mjs';

// ── Logging ─────────────────────────────────────────────────────────────────

const log = {
  info:  (msg) => process.stderr.write(`  ${pc.blue('i')} ${msg}\n`),
  ok:    (msg) => process.stderr.write(`  ${pc.green('+')} ${msg}\n`),
  warn:  (msg) => process.stderr.write(`  ${pc.yellow('!')} ${msg}\n`),
  error: (msg) => process.stderr.write(`  ${pc.red('x')} ${msg}\n`),
  phase: (name) => process.stderr.write(`\n${pc.bold(pc.magenta(`[${name}]`))}\n`),
  task:  (msg) => process.stderr.write(`\n${pc.bold(pc.cyan('>'))} ${pc.bold(msg)}\n`),
  dim:   (msg) => process.stderr.write(`  ${pc.dim(msg)}\n`),
};

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

function askLine(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function phaseSelect(sortedTasks, maxTasks) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    console.log(pc.bold(`\nSelect up to ${maxTasks} task(s) to run:\n`));
    for (let i = 0; i < Math.min(sortedTasks.length, 20); i++) {
      const t = sortedTasks[i];
      const prioColor = t.priority === 'high' ? pc.red : t.priority === 'low' ? pc.dim : pc.yellow;
      console.log(`  ${pc.bold(String(i + 1).padStart(2))}. ${prioColor(t.priority.padEnd(6))} [${t.source}] ${t.title}`);
      console.log(`      ${pc.dim(`[${t.taskType}] → ${t.suggestedAgent} | ${t.sourceRef}`)}`);
    }
    if (sortedTasks.length > 20) {
      console.log(pc.dim(`\n  ... and ${sortedTasks.length - 20} more`));
    }
    console.log(pc.dim(`\n  Enter numbers (e.g. 1,3,5) or press Enter for top ${maxTasks}.`));
    const answer = await askLine(rl, pc.bold('  Select: '));
    if (!answer) return sortedTasks.slice(0, maxTasks);

    const indices = answer.split(',')
      .map((s) => parseInt(s.trim(), 10) - 1)
      .filter((i) => i >= 0 && i < sortedTasks.length);

    if (indices.length === 0) return sortedTasks.slice(0, maxTasks);
    return indices.map((i) => sortedTasks[i]).slice(0, maxTasks);
  } finally {
    rl.close();
  }
}

// ── Budget Thresholds ───────────────────────────────────────────────────────

function buildThresholds(budgetCfg) {
  return [
    { pct: 0.95, action: 'hard_stop', reason: 'Hard limit reached: {pct}% of budget used' },
    { pct: 0.85, action: 'soft_stop', reason: 'Soft limit reached: {pct}% budget ({consumed} tokens)' },
    { pct: budgetCfg.handoffThreshold || 0.70, action: 'handoff', reason: '{pct}% budget — switching remaining tasks to economy models', once: true },
    { pct: 0.50, action: 'warn', reason: '{pct}% budget used ({consumed} tokens)' },
  ];
}

// ── Prompt Builder ──────────────────────────────────────────────────────────

function buildTaskPrompt(task, branchName, projectRoot, agent, opts = {}) {
  const instructionFile = getAgentInstructionFile(agent, projectRoot);

  const selfSnapshot = opts.selfSnapshotText || '';
  const selfIndex = opts.selfIndexText || '';

  const safetyBlock = buildSafetyPrompt(branchName, {
    runner: 'actualize runner',
    reportName: 'actualize report',
    protectedFiles: new Set(BASE_PROTECTED_FILES),
    blockedCommands: BLOCKED_COMMANDS,
    attribution: { pipeline: 'hydra-actualize', agent },
  });

  const bodySection = task.body
    ? `\n## Details\n${task.body}\n`
    : '';

  const sourceNote = task.sourceRef
    ? `**Source:** ${task.source} (${task.sourceRef})`
    : `**Source:** ${task.source}`;

  const intent = `You are Hydra improving itself. Be bold, but keep scope bounded and verifiable.
- Prefer changes that increase self-awareness, diagnostics, safety, and autonomy.
- Add/extend tests when behavior changes.
- Run verification (or ensure it runs) and fix failures you introduce.
- Commit your work with a descriptive message.`;

  return `# Hydra Actualize Task

**Task:** ${task.title}
**Branch:** \`${branchName}\` (already checked out)
**Project:** ${projectRoot}
${sourceNote}

## Self Context (ground truth)
${selfSnapshot}

${selfIndex}

## Intent
${intent}

## Instructions
1. Read the project's \`${instructionFile}\` for conventions and patterns
2. Read relevant source files to understand the current implementation
3. Implement the task with focused, minimal changes (no sweeping rewrite)
4. Commit your work
5. Ensure verification passes
${bodySection}
${safetyBlock}

## Begin
Start working on the task now.`;
}

// ── Verification ────────────────────────────────────────────────────────────

function runVerification(projectRoot, cfg) {
  const plan = resolveVerificationPlan(projectRoot, cfg);
  if (!plan.enabled || !plan.command) {
    return { ran: false, passed: true, command: '', output: '', reason: plan.reason || 'disabled' };
  }

  log.dim(`Verifying: ${plan.command}`);
  const parts = plan.command.split(/\s+/);
  const result = runProcess(parts[0], parts.slice(1), plan.timeoutMs, { cwd: projectRoot });
  return {
    ran: true,
    passed: result.ok,
    command: plan.command,
    output: (result.stdout || '').slice(-2000) + (result.stderr || '').slice(-1000),
    reason: plan.reason || '',
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { options } = parseArgs(process.argv);
  const startedAt = Date.now();
  const dateStr = new Date().toISOString().split('T')[0];

  // Resolve project (default: Hydra itself)
  let projectConfig;
  try {
    const projectOpt = options.project || HYDRA_ROOT;
    projectConfig = resolveProject({ project: projectOpt });
  } catch (err) {
    log.error(`Project resolution failed: ${err.message}`);
    process.exit(1);
  }

  const { projectRoot, coordDir } = projectConfig;
  log.info(`Project: ${projectRoot}`);

  initAgentRegistry();

  const cfg = loadHydraConfig();
  const baseBranch = String(options['base-branch'] || cfg.evolve?.baseBranch || cfg.nightly?.baseBranch || 'dev');
  const branchPrefix = String(options['branch-prefix'] || 'actualize');
  const maxTasks = options['max-tasks'] ? parseInt(options['max-tasks'], 10) : 5;
  const maxHours = options['max-hours'] ? parseFloat(options['max-hours']) : 4;
  const isDryRun = !!options['dry-run'];
  const isInteractive = !!options['interactive'];
  const noDiscovery = !!options['no-discovery'];

  // Preconditions
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

  // ── Phase: SELF ──
  log.phase('SELF');
  const actualizeDir = path.join(coordDir, 'actualize');
  ensureDir(actualizeDir);

  const snapshotObj = buildSelfSnapshot({ projectRoot, projectName: projectConfig.projectName });
  const snapshotText = formatSelfSnapshotForPrompt(snapshotObj, { maxLines: 120 });
  const indexObj = buildSelfIndex(HYDRA_ROOT);
  const indexText = formatSelfIndexForPrompt(indexObj, { maxChars: 7000 });

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const snapshotPath = path.join(actualizeDir, `SELF_SNAPSHOT_${dateStr}_${ts}.json`);
  const indexPath = path.join(actualizeDir, `SELF_INDEX_${dateStr}_${ts}.json`);
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshotObj, null, 2) + '\n', 'utf8');
  fs.writeFileSync(indexPath, JSON.stringify(indexObj, null, 2) + '\n', 'utf8');
  log.ok(`Wrote self snapshot: ${path.relative(projectRoot, snapshotPath)}`);
  log.ok(`Wrote self index: ${path.relative(projectRoot, indexPath)}`);

  // ── Phase: SCAN ──
  log.phase('SCAN');
  const scanned = scanAllSources(projectRoot);
  log.info(`Scanned ${scanned.length} task(s) from TODO comments / TODO.md / GitHub issues`);

  // ── Phase: DISCOVER ──
  let discovered = [];
  if (!noDiscovery) {
    log.phase('DISCOVER');
    const discoveryCfg = cfg.nightly?.aiDiscovery || {};
    const discoveryAgent = String(options['discovery-agent'] || discoveryCfg.agent || 'gemini');
    const focus = (options.focus ? String(options.focus).split(',').map(s => s.trim()).filter(Boolean) : (discoveryCfg.focus || []));
    const maxSuggestions = options['discover-max']
      ? parseInt(options['discover-max'], 10)
      : (discoveryCfg.maxSuggestions || 6);

    const extraContext = [
      snapshotText,
      indexText,
    ].join('\n\n');

    discovered = await runDiscovery(projectRoot, {
      agent: discoveryAgent,
      maxSuggestions,
      focus,
      timeoutMs: discoveryCfg.timeoutMs || 5 * 60 * 1000,
      existingTasks: scanned.map(t => t.title),
      profile: 'actualize',
      extraContext,
    });
  } else {
    log.dim('AI discovery: disabled');
  }

  // Merge + prioritize
  log.phase('PRIORITIZE');
  const all = [...scanned, ...discovered];
  const deduped = deduplicateTasks(all);
  const sorted = prioritizeTasks(deduped);
  let selected = sorted.slice(0, Math.max(1, maxTasks));

  if (isInteractive && process.stdin.isTTY) {
    selected = await phaseSelect(sorted, Math.max(1, maxTasks));
  }

  if (selected.length === 0) {
    log.warn('No tasks to execute. Nothing to do.');
    process.exit(0);
  }

  log.info(`Selected ${selected.length} task(s)`);
  for (const t of selected) {
    const prioColor = t.priority === 'high' ? pc.red : t.priority === 'low' ? pc.dim : pc.yellow;
    log.dim(`  ${prioColor(t.priority.padEnd(6))} [${t.source}] ${t.title}`);
  }

  if (isDryRun) {
    console.log('');
    console.log(pc.bold('=== Dry Run Complete ==='));
    console.log(`  Would execute ${selected.length} task(s):`);
    for (const t of selected) {
      console.log(`    - [${t.source}] ${t.title} -> ${t.suggestedAgent}`);
    }
    console.log('');
    process.exit(0);
  }

  // ── Phase: EXECUTE ──
  log.phase('EXECUTE');

  const budgetCfg = cfg.nightly?.budget || { softLimit: 300_000, hardLimit: 450_000, perTaskEstimate: 100_000 };
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
  const maxHoursMs = maxHours * 60 * 60 * 1000;
  let useEconomy = false;
  let stopReason = null;

  for (let i = 0; i < selected.length; i++) {
    const task = selected[i];

    if (Date.now() - startedAt > maxHoursMs) {
      stopReason = 'time limit';
      log.warn(`Time limit reached (${formatDuration(maxHoursMs)}). Stopping.`);
      break;
    }

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
      useEconomy = true;
      log.warn(budgetCheck.reason);
    }
    if (budgetCheck.action === 'warn') {
      log.warn(budgetCheck.reason);
    }

    const date = new Date().toISOString().split('T')[0];
    const branchName = `${branchPrefix}/${date}/${task.slug}`;

    // Choose agent (simple heuristic)
    const taskType = classifyTask(task.title);
    const agent = task.suggestedAgent || bestAgentFor(taskType);
    const modelOverride = useEconomy
      ? (agent === 'codex'
        ? (budgetCfg.handoffModel || 'o4-mini')
        : agent === 'claude'
          ? 'claude-sonnet-4-5-20250929'
          : agent === 'gemini'
            ? 'gemini-3-flash-preview'
            : undefined)
      : undefined;

    log.task(`Task ${i + 1}/${selected.length}: ${task.title} [${agent}]`);

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

    if (!createBranch(projectRoot, branchName, baseBranch)) {
      log.error(`Failed to create branch: ${branchName}`);
      results.push({
        slug: task.slug, title: task.title, branch: branchName,
        source: task.source, taskType: task.taskType || 'unknown',
        status: 'error', agent, tokensUsed: 0, durationMs: 0,
        commits: 0, filesChanged: 0, verification: 'SKIP', violations: [], error: 'Branch creation failed',
      });
      checkoutBranch(projectRoot, baseBranch);
      continue;
    }
    log.ok(`Branch: ${branchName}`);

    const prompt = buildTaskPrompt(task, branchName, projectRoot, agent, {
      selfSnapshotText: snapshotText,
      selfIndexText: indexText,
    });

    const effectiveModel = modelOverride || getActiveModel(agent) || 'default';
    const handle = recordCallStart(agent, effectiveModel);
    log.dim(`Dispatching ${agent}${modelOverride ? ` (${modelOverride})` : ''}...`);

    let agentResult;
    try {
      agentResult = await executeAgentWithRecovery(agent, prompt, {
        cwd: projectRoot,
        timeoutMs: (cfg.nightly?.perTaskTimeoutMs || 15 * 60 * 1000),
        modelOverride,
        progressIntervalMs: 15_000,
        onProgress: (elapsed, outputKB) => {
          const elStr = formatDuration(elapsed);
          const kbStr = outputKB > 0 ? ` | ${outputKB}KB` : '';
          process.stderr.write(`\r  ${pc.dim(`${agent}: working... ${elStr}${kbStr}`)}${' '.repeat(20)}`);
        },
      });
    } catch (err) {
      agentResult = { ok: false, output: '', stderr: '', error: err.message, durationMs: 0 };
    }
    process.stderr.write('\r' + ' '.repeat(100) + '\r');

    if (agentResult.ok) recordCallComplete(handle, agentResult);
    else recordCallError(handle, new Error(agentResult.error || 'unknown'));

    const taskDurationMs = agentResult.durationMs || 0;
    const tokenDelta = budget.recordUnitEnd(task.slug, taskDurationMs);

    // Branch integrity
    const branchCheck = verifyBranch(projectRoot, branchName);
    if (!branchCheck.ok) {
      log.error(`Branch escape detected! Expected '${branchName}', on '${branchCheck.currentBranch}'`);
      try { git(['checkout', branchName], projectRoot); } catch { /* best effort */ }
    }

    // Verification
    const verification = runVerification(projectRoot, cfg);
    const verificationStatus = !verification.ran ? 'SKIP' : verification.passed ? 'PASS' : 'FAIL';
    if (verification.ran) {
      if (verification.passed) log.ok('Verification: PASS');
      else log.warn('Verification: FAIL');
    }

    // Violations
    const violations = scanBranchViolations(projectRoot, branchName, {
      baseBranch,
      protectedFiles: new Set(BASE_PROTECTED_FILES),
      protectedPatterns: [...BASE_PROTECTED_PATTERNS],
    });
    if (violations.length > 0) {
      log.warn(`${violations.length} violation(s) detected`);
      for (const v of violations) log.dim(`  [${v.severity}] ${v.detail}`);
    }

    const stats = getBranchStats(projectRoot, branchName, baseBranch);
    let status = 'success';
    if (!agentResult.ok) status = 'error';
    else if (verification.ran && !verification.passed) status = 'partial';

    log.ok(`Done: ${status} | ${stats.commits} commits | ${stats.filesChanged} files | ~${tokenDelta.tokens.toLocaleString()} tokens | ${formatDuration(taskDurationMs)}`);

    results.push({
      slug: task.slug,
      title: task.title,
      branch: branchName,
      source: task.source,
      taskType: task.taskType || 'unknown',
      status,
      agent,
      tokensUsed: tokenDelta.tokens,
      durationMs: taskDurationMs,
      commits: stats.commits,
      filesChanged: stats.filesChanged,
      verification: verificationStatus,
      violations,
    });

    checkoutBranch(projectRoot, baseBranch);
  }

  // Ensure base branch
  if (getCurrentBranch(projectRoot) !== baseBranch) {
    checkoutBranch(projectRoot, baseBranch);
  }

  // ── Phase: REPORT ──
  log.phase('REPORT');

  const runMeta = {
    date: dateStr,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date().toISOString(),
    projectRoot,
    baseBranch,
    branchPrefix,
    totalTasks: selected.length,
    processedTasks: results.length,
    stopReason,
    artifacts: {
      selfSnapshot: path.relative(projectRoot, snapshotPath).replace(/\\/g, '/'),
      selfIndex: path.relative(projectRoot, indexPath).replace(/\\/g, '/'),
    },
  };

  const budgetSummary = budget.getSummary();
  if (stopReason) budgetSummary.stopReason = stopReason;

  const jsonReport = {
    ...runMeta,
    budget: budgetSummary,
    results,
  };

  const md = [];
  md.push(`# Hydra Actualize Report — ${runMeta.date}`);
  md.push('');
  md.push(`- Project: \`${runMeta.projectRoot}\``);
  md.push(`- Base branch: \`${runMeta.baseBranch}\``);
  md.push(`- Branch prefix: \`${runMeta.branchPrefix}\``);
  md.push(`- Tasks: ${runMeta.processedTasks}/${runMeta.totalTasks}`);
  if (runMeta.stopReason) md.push(`- Stopped: ${runMeta.stopReason}`);
  md.push(`- Self snapshot: \`${runMeta.artifacts.selfSnapshot}\``);
  md.push(`- Self index: \`${runMeta.artifacts.selfIndex}\``);
  md.push('');
  md.push('## Results');
  md.push('');
  md.push('| # | Task | Agent | Status | Verification | Branch |');
  md.push('|---|------|-------|--------|--------------|--------|');
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    md.push(`| ${i + 1} | ${String(r.title || '').slice(0, 60)} | ${r.agent} | ${r.status} | ${r.verification} | \`${r.branch}\` |`);
  }
  md.push('');
  md.push('## Budget');
  md.push(`- Consumed: ${budgetSummary.consumed?.toLocaleString?.() || budgetSummary.consumed} of ${budgetSummary.hardLimit?.toLocaleString?.() || budgetSummary.hardLimit}`);
  md.push(`- Avg per task: ${(budgetSummary.avgPerTask || 0).toLocaleString?.() || budgetSummary.avgPerTask}`);
  md.push('');
  md.push('## Next');
  md.push('- Review and merge: `node lib/hydra-actualize-review.mjs review`');
  md.push('- Status: `node lib/hydra-actualize-review.mjs status`');
  md.push('- Clean branches: `node lib/hydra-actualize-review.mjs clean`');
  md.push('');

  const reportJsonPath = path.join(actualizeDir, `ACTUALIZE_${runMeta.date}.json`);
  const reportMdPath = path.join(actualizeDir, `ACTUALIZE_${runMeta.date}.md`);
  fs.writeFileSync(reportJsonPath, JSON.stringify(jsonReport, null, 2) + '\n', 'utf8');
  fs.writeFileSync(reportMdPath, md.join('\n'), 'utf8');

  log.ok(`Report: ${path.relative(projectRoot, reportMdPath)}`);
  log.ok(`Review: node lib/hydra-actualize-review.mjs review`);
}

main().catch((err) => {
  process.stderr.write(pc.red(`Fatal: ${err.message}\n`));
  process.exit(1);
});
