#!/usr/bin/env node
/**
 * Hydra Tasks Runner — Scan codebase for work items and execute them autonomously.
 *
 * Bridges the gap between nightly (pre-curated queue) and evolve (AI-discovered improvements).
 * Aggregates TODO/FIXME comments, docs/TODO.md items, and GitHub issues,
 * lets the user pick tasks and set budget limits, then executes autonomously
 * with self-healing, council-lite review, and per-task branch isolation.
 *
 * Usage:
 *   node lib/hydra-tasks.mjs                     # Interactive setup
 *   node lib/hydra-tasks.mjs preset=light         # Quick preset
 *   node lib/hydra-tasks.mjs max=3 hours=1        # Custom limits
 *
 * Per-task lifecycle:
 *   CLASSIFY → PLAN (complex only) → EXECUTE → VERIFY → DECIDE (complex only)
 */

import fs from 'fs';
import path from 'path';
import spawn from 'cross-spawn';
import pc from 'picocolors';

import { resolveProject, loadHydraConfig } from './hydra-config.mjs';
import { parseArgs, classifyPrompt, ensureDir } from './hydra-utils.mjs';
import { initAgentRegistry, classifyTask, bestAgentFor, getVerifier } from './hydra-agents.mjs';
import { recordCallStart, recordCallComplete } from './hydra-metrics.mjs';
import { checkUsage } from './hydra-usage.mjs';
import { resolveVerificationPlan } from './hydra-verification.mjs';
import { BudgetTracker } from './hydra-shared/budget-tracker.mjs';
import { executeAgentWithRecovery } from './hydra-shared/agent-executor.mjs';
import {
  buildSafetyPrompt,
  verifyBranch,
  isCleanWorkingTree,
  scanBranchViolations,
} from './hydra-shared/guardrails.mjs';
import {
  getCurrentBranch,
  checkoutBranch,
  createBranch,
  branchExists,
  branchHasCommits,
  getBranchStats,
  getBranchDiff,
} from './hydra-shared/git-ops.mjs';
import { BASE_PROTECTED_FILES, BASE_PROTECTED_PATTERNS, BLOCKED_COMMANDS } from './hydra-shared/constants.mjs';
import { scanAllSources, createUserTask, taskToSlug } from './hydra-tasks-scanner.mjs';
import { getAgentInstructionFile } from './hydra-sync-md.mjs';

// Lazy-load investigator (optional)
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

// Lazy-load promptChoice (optional — falls back to simple readline)
let _promptChoice = null;
async function getPromptChoice() {
  if (_promptChoice) return _promptChoice;
  try {
    const mod = await import('./hydra-prompt-choice.mjs');
    _promptChoice = mod.promptChoice;
    return _promptChoice;
  } catch {
    return null;
  }
}

// ── Constants ───────────────────────────────────────────────────────────────

const RUNNER_NAME = 'tasks runner';
const REPORT_NAME = 'tasks report';
const BRANCH_PREFIX = 'tasks';

const BUDGET_PRESETS = {
  light:  { maxHours: 0.5, budgetPct: 0.10, maxTasks: 3, label: 'Light (30min, 10% budget, 3 tasks)' },
  medium: { maxHours: 1,   budgetPct: 0.20, maxTasks: 5, label: 'Medium (1hr, 20% budget, 5 tasks)' },
  heavy:  { maxHours: 2,   budgetPct: 0.40, maxTasks: 10, label: 'Heavy (2hr, 40% budget, 10 tasks)' },
};

const BUDGET_THRESHOLDS = [
  { pct: 0.95, action: 'hard_stop', reason: 'Budget at {pct}% — hard stop', once: false },
  { pct: 0.85, action: 'soft_stop', reason: 'Budget at {pct}% — soft stop (finishing current task)', once: true },
  { pct: 0.70, action: 'handoff_cheap', reason: 'Budget at {pct}% — switching to economy tier', once: true },
  { pct: 0.50, action: 'warn', reason: 'Budget at {pct}% ({consumed} tokens used)', once: true },
];

const PROTECTED_FILES = new Set([
  ...BASE_PROTECTED_FILES,
  'hydra.config.json',
]);

// ── Date Helpers ────────────────────────────────────────────────────────────

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

// ── Simple Readline Fallback ────────────────────────────────────────────────

import readline from 'readline';

function createRL() {
  return readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
}

function askLine(rl, question) {
  return new Promise(resolve => {
    rl.question(question, answer => resolve(answer.trim()));
  });
}

// ── Interactive Task Selection ──────────────────────────────────────────────

async function selectTasks(rl, scannedTasks) {
  console.log(pc.bold(`\nScanned Tasks (${scannedTasks.length} found):\n`));

  const maxShow = Math.min(scannedTasks.length, 20);
  for (let i = 0; i < maxShow; i++) {
    const t = scannedTasks[i];
    const prioColor = t.priority === 'high' ? pc.red : t.priority === 'low' ? pc.dim : pc.yellow;
    const num = pc.bold(String(i + 1).padStart(3));
    console.log(`  ${num}. ${prioColor(t.priority.padEnd(6))} ${t.title}`);
    console.log(`       ${pc.dim(`[${t.source}] ${t.taskType} → ${t.suggestedAgent} | ${t.sourceRef}`)}`);
  }

  if (scannedTasks.length > maxShow) {
    console.log(pc.dim(`\n  ... and ${scannedTasks.length - maxShow} more (enter 'all' to see full list)`));
  }

  console.log('');
  console.log(pc.dim('  Enter task numbers (e.g. 1,3,5), "all" for top 10, "add" for freeform, or "q" to quit'));
  const answer = await askLine(rl, pc.bold('  Select tasks: '));

  if (!answer || answer === 'q' || answer === 'quit') return null;

  if (answer === 'all') {
    return scannedTasks.slice(0, 10);
  }

  if (answer === 'add' || answer === 'freeform') {
    const text = await askLine(rl, '  Enter task description: ');
    if (!text) return null;
    return [createUserTask(text)];
  }

  // Parse comma-separated numbers
  const indices = answer.split(',')
    .map(s => parseInt(s.trim(), 10) - 1)
    .filter(i => i >= 0 && i < scannedTasks.length);

  if (indices.length === 0) {
    console.log(pc.yellow('  No valid selections.'));
    return null;
  }

  return indices.map(i => scannedTasks[i]);
}

// ── Budget Preset Selection ─────────────────────────────────────────────────

async function selectBudget(rl, cfg) {
  const defaultPreset = cfg.tasks?.budget?.defaultPreset || 'medium';

  console.log(pc.bold('\nBudget Preset:\n'));
  const presetNames = Object.keys(BUDGET_PRESETS);
  for (let i = 0; i < presetNames.length; i++) {
    const name = presetNames[i];
    const preset = BUDGET_PRESETS[name];
    const marker = name === defaultPreset ? pc.green(' (default)') : '';
    console.log(`  ${i + 1}. ${preset.label}${marker}`);
  }
  console.log(`  ${presetNames.length + 1}. Custom`);

  const answer = await askLine(rl, pc.bold(`\n  Select [1-${presetNames.length + 1}]: `));
  const idx = parseInt(answer, 10) - 1;

  if (idx >= 0 && idx < presetNames.length) {
    return BUDGET_PRESETS[presetNames[idx]];
  }

  if (idx === presetNames.length) {
    const hours = parseFloat(await askLine(rl, '  Max hours: ') || '1') || 1;
    const pct = parseFloat(await askLine(rl, '  Budget % (0-100): ') || '20') / 100 || 0.20;
    const max = parseInt(await askLine(rl, '  Max tasks: ') || '5', 10) || 5;
    return { maxHours: hours, budgetPct: pct, maxTasks: max, label: `Custom (${hours}hr, ${Math.round(pct * 100)}%, ${max} tasks)` };
  }

  // Default
  return BUDGET_PRESETS[defaultPreset];
}

// ── Verification ────────────────────────────────────────────────────────────

function runVerification(projectRoot, cfg) {
  const plan = resolveVerificationPlan(projectRoot, cfg);
  if (!plan.enabled || !plan.command) {
    return { ran: false, passed: true, output: '', command: '' };
  }

  const parts = plan.command.split(/\s+/);
  const result = spawn.sync(parts[0], parts.slice(1), {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: plan.timeoutMs || 60_000,
    windowsHide: true,
  });

  return {
    ran: true,
    passed: result.status === 0,
    output: ((result.stdout || '') + (result.stderr || '')).slice(0, 4096),
    command: plan.command,
  };
}

// ── Council-Lite (DECIDE Phase) ─────────────────────────────────────────────

async function councilLiteReview(agent, diff, projectRoot, cfg) {
  const verifier = getVerifier(agent);
  const truncatedDiff = diff.length > 8192 ? diff.slice(0, 8192) + '\n... (truncated)' : diff;

  const reviewPrompt = `Review this code change and determine if it should be approved.

## Diff
\`\`\`
${truncatedDiff}
\`\`\`

## Instructions
- Check for bugs, security issues, and correctness
- Check that the change is focused and doesn't introduce unrelated modifications
- Respond with EXACTLY one of these verdicts on the first line:
  APPROVE - Change looks good
  REJECT - Change has significant issues
  NEEDS_REVISION - Change needs minor fixes

Then explain your reasoning briefly.`;

  const handle = recordCallStart(verifier, null);
  const result = await executeAgentWithRecovery(verifier, reviewPrompt, {
    cwd: projectRoot,
    timeoutMs: 5 * 60 * 1000,
    phaseLabel: 'council-lite review',
  });
  recordCallComplete(handle, result);

  if (!result.ok || !result.output) {
    return { verdict: 'approve', reason: 'Verifier unavailable — defaulting to approve' };
  }

  const output = result.output.trim();
  const firstLine = output.split('\n')[0].toUpperCase();

  if (firstLine.includes('REJECT')) {
    return { verdict: 'reject', reason: output };
  }
  if (firstLine.includes('NEEDS_REVISION')) {
    return { verdict: 'needs-revision', reason: output };
  }
  return { verdict: 'approve', reason: output };
}

// ── Per-Task Execution ──────────────────────────────────────────────────────

async function executeTask(task, idx, total, projectRoot, baseBranch, cfg, budget, sessionMode) {
  const date = todayStr();
  const branchName = `${BRANCH_PREFIX}/${date}/${task.slug}`;
  const startTime = Date.now();

  const result = {
    task: task.title,
    slug: task.slug,
    source: task.source,
    sourceRef: task.sourceRef,
    branch: branchName,
    agent: task.suggestedAgent,
    taskType: task.taskType,
    complexity: task.complexity,
    status: 'pending',
    phases: {},
    tokens: 0,
    durationMs: 0,
    filesChanged: 0,
    commits: 0,
    verification: null,
    violations: [],
    verdict: null,
  };

  const phaseLabel = `Task ${idx + 1}/${total}`;

  try {
    // ── CLASSIFY ──
    result.phases.classify = { status: 'done', taskType: task.taskType, complexity: task.complexity, agent: task.suggestedAgent };

    // ── Branch Setup ──
    console.log(pc.bold(`\n${'─'.repeat(60)}`));
    console.log(pc.bold(`  ${phaseLabel}: ${task.title}`));
    console.log(pc.dim(`  [${task.source}] ${task.taskType} → ${task.suggestedAgent} | ${task.complexity}`));
    console.log(pc.bold('─'.repeat(60)));

    // Ensure we're on base branch before creating task branch
    const currentBranch = getCurrentBranch(projectRoot);
    if (currentBranch !== baseBranch) {
      checkoutBranch(projectRoot, baseBranch);
    }

    if (branchExists(projectRoot, branchName)) {
      console.log(pc.yellow(`  Branch ${branchName} already exists, skipping`));
      result.status = 'skipped';
      result.durationMs = Date.now() - startTime;
      return result;
    }

    createBranch(projectRoot, branchName);
    checkoutBranch(projectRoot, branchName);

    // ── PLAN (complex tasks only) ──
    if (task.complexity === 'complex') {
      console.log(pc.dim(`  [PLAN] Generating implementation plan...`));

      const planPrompt = `Create a brief implementation plan (5-7 bullet points) for this task:

Task: ${task.title}
${task.body ? `\nDescription:\n${task.body}` : ''}
${task.sourceRef !== 'manual' ? `\nSource: ${task.sourceRef}` : ''}

Focus on:
- Which files need to be modified
- What changes are needed
- Any edge cases to handle
- How to verify the change works

Be concise — this is a planning checklist, not a design doc.`;

      const planHandle = recordCallStart('claude', null);
      const planResult = await executeAgentWithRecovery('claude', planPrompt, {
        cwd: projectRoot,
        timeoutMs: 3 * 60 * 1000,
        phaseLabel: `${phaseLabel} plan`,
      });
      recordCallComplete(planHandle, planResult);

      result.phases.plan = {
        status: planResult.ok ? 'done' : 'failed',
        output: planResult.output?.slice(0, 2048) || '',
      };

      if (!planResult.ok) {
        console.log(pc.yellow(`  [PLAN] Planning failed, proceeding with direct execution`));
      }
    }

    // ── EXECUTE ──
    console.log(pc.dim(`  [EXECUTE] Dispatching to ${task.suggestedAgent}...`));

    const safetyRules = buildSafetyPrompt(branchName, {
      runner: RUNNER_NAME,
      reportName: REPORT_NAME,
      protectedFiles: PROTECTED_FILES,
      blockedCommands: BLOCKED_COMMANDS,
      attribution: { pipeline: 'hydra-tasks', agent: task.suggestedAgent },
    });

    const instructionFile = getAgentInstructionFile(task.suggestedAgent, projectRoot);
    const planOutput = result.phases.plan?.output || '';
    const planSection = planOutput ? `\n\n## Implementation Plan\n${planOutput}` : '';

    const executePrompt = `${safetyRules}

## Task
${task.title}
${task.body ? `\n### Description\n${task.body}` : ''}
${task.sourceRef !== 'manual' ? `\n### Source Reference\n${task.sourceRef}` : ''}
${planSection}

## Instructions
1. Read the relevant code files first to understand the current state
2. Make the minimal changes needed to complete this task
3. Commit your changes with a clear commit message
4. Do NOT modify files outside the scope of this task

Read ${instructionFile} for project conventions.`;

    const timeoutMs = cfg.tasks?.perTaskTimeoutMs || 15 * 60 * 1000;
    const execHandle = recordCallStart(task.suggestedAgent, null);
    const execResult = await executeAgentWithRecovery(task.suggestedAgent, executePrompt, {
      cwd: projectRoot,
      timeoutMs,
      phaseLabel,
      progressIntervalMs: 30_000,
      onProgress: (elapsed) => {
        process.stderr.write(pc.dim(`  [${phaseLabel}] ${formatDuration(elapsed)} elapsed...\r`));
      },
      hubCwd: projectRoot,
      hubProject: path.basename(projectRoot),
      hubAgent: `${task.suggestedAgent}-forge`,
    });
    recordCallComplete(execHandle, execResult);

    result.phases.execute = {
      status: execResult.ok ? 'done' : 'failed',
      timedOut: execResult.timedOut || false,
      error: execResult.error || null,
      recovered: execResult.recovered || false,
    };

    if (!execResult.ok) {
      console.log(pc.red(`  [EXECUTE] Failed: ${execResult.error || 'unknown error'}`));

      // Self-healing via investigator
      const inv = await getInvestigator();
      if (inv && cfg.tasks?.investigator?.enabled !== false && inv.isInvestigatorAvailable()) {
        console.log(pc.dim(`  [INVESTIGATE] Diagnosing failure...`));
        try {
          const diagnosis = await inv.investigate({
            phase: 'agent',
            agent: task.suggestedAgent,
            error: execResult.error || execResult.stderr || 'Agent execution failed',
            output: execResult.output?.slice(0, 2048) || '',
            timedOut: execResult.timedOut || false,
          });

          result.phases.investigate = { diagnosis: diagnosis.diagnosis };

          if (diagnosis.diagnosis === 'transient') {
            console.log(pc.yellow(`  [INVESTIGATE] Transient failure — retrying...`));
            const retryResult = await executeAgentWithRecovery(task.suggestedAgent, executePrompt, {
              cwd: projectRoot,
              timeoutMs,
              phaseLabel: `${phaseLabel} retry`,
              hubCwd: projectRoot,
              hubProject: path.basename(projectRoot),
              hubAgent: `${task.suggestedAgent}-forge`,
            });
            recordCallComplete(recordCallStart(task.suggestedAgent, null), retryResult);

            if (retryResult.ok) {
              result.phases.execute.status = 'done';
              result.phases.execute.retried = true;
            }
          } else if (diagnosis.diagnosis === 'fixable' && diagnosis.retryRecommendation?.preamble) {
            console.log(pc.yellow(`  [INVESTIGATE] Fixable — retrying with corrective prompt...`));
            const correctedPrompt = `${diagnosis.retryRecommendation.preamble}\n\n${executePrompt}`;
            const retryResult = await executeAgentWithRecovery(task.suggestedAgent, correctedPrompt, {
              cwd: projectRoot,
              timeoutMs,
              phaseLabel: `${phaseLabel} fix-retry`,
              hubCwd: projectRoot,
              hubProject: path.basename(projectRoot),
              hubAgent: `${task.suggestedAgent}-forge`,
            });
            recordCallComplete(recordCallStart(task.suggestedAgent, null), retryResult);

            if (retryResult.ok) {
              result.phases.execute.status = 'done';
              result.phases.execute.retried = true;
            }
          } else {
            console.log(pc.red(`  [INVESTIGATE] Fundamental failure — skipping task`));
          }
        } catch (invErr) {
          console.log(pc.dim(`  [INVESTIGATE] Investigation failed: ${invErr.message}`));
        }
      }

      if (result.phases.execute.status !== 'done') {
        // Doctor notification for persistent failure
        import('./hydra-doctor.mjs').then((doc) => {
          if (doc.isDoctorEnabled()) doc.diagnose({
            pipeline: 'tasks', phase: 'execute', agent: task.suggestedAgent,
            error: execResult.error || execResult.stderr || '',
            exitCode: execResult.exitCode ?? null,
            signal: execResult.signal || null,
            command: execResult.command,
            args: execResult.args,
            promptSnippet: execResult.promptSnippet,
            stderr: execResult.stderr, stdout: execResult.output,
            errorCategory: execResult.errorCategory || null,
            errorDetail: execResult.errorDetail || null,
            errorContext: execResult.errorContext || null,
            timedOut: execResult.timedOut || false,
            taskTitle: task.title, branchName,
          });
        }).catch(() => {});

        result.status = 'failed';
        result.durationMs = Date.now() - startTime;
        // Return to base branch
        checkoutBranch(projectRoot, baseBranch);
        return result;
      }
    }

    // Check if the branch has any commits
    if (!branchHasCommits(projectRoot, branchName, baseBranch)) {
      console.log(pc.yellow(`  [EXECUTE] No commits produced — skipping`));
      result.status = 'empty';
      result.durationMs = Date.now() - startTime;
      checkoutBranch(projectRoot, baseBranch);
      return result;
    }

    // Get stats
    const stats = getBranchStats(projectRoot, branchName, baseBranch);
    result.filesChanged = stats.filesChanged || 0;
    result.commits = stats.commits || 0;

    // ── VERIFY ──
    console.log(pc.dim(`  [VERIFY] Running verification...`));
    const verification = runVerification(projectRoot, cfg);
    result.verification = {
      ran: verification.ran,
      passed: verification.passed,
      command: verification.command,
    };

    if (verification.ran) {
      console.log(verification.passed
        ? pc.green(`  [VERIFY] Passed: ${verification.command}`)
        : pc.red(`  [VERIFY] Failed: ${verification.command}`));
    }

    // Scan for violations
    const violations = scanBranchViolations(projectRoot, branchName, {
      baseBranch,
      protectedFiles: PROTECTED_FILES,
      protectedPatterns: BASE_PROTECTED_PATTERNS,
      checkDeletedTests: true,
    });
    result.violations = violations;

    if (violations.length > 0) {
      console.log(pc.red(`  [VERIFY] ${violations.length} violation(s) detected`));
      for (const v of violations) {
        console.log(pc.red(`    [${v.severity}] ${v.detail}`));
      }
    }

    result.phases.verify = {
      status: 'done',
      passed: verification.passed,
      violations: violations.length,
    };

    // ── DECIDE (council-lite for complex tasks) ──
    const councilCfg = cfg.tasks?.councilLite || {};
    const needsCouncil = councilCfg.enabled !== false &&
      (task.complexity === 'complex' || (!councilCfg.complexOnly && (violations.length > 0 || !verification.passed)));

    if (needsCouncil) {
      console.log(pc.dim(`  [DECIDE] Council-lite review...`));
      const diff = getBranchDiff(projectRoot, branchName, baseBranch);

      if (diff) {
        const review = await councilLiteReview(task.suggestedAgent, diff, projectRoot, cfg);
        result.verdict = review.verdict;
        result.phases.decide = { status: 'done', verdict: review.verdict };

        const verdictColor = review.verdict === 'approve' ? pc.green
          : review.verdict === 'reject' ? pc.red : pc.yellow;
        console.log(`  [DECIDE] Verdict: ${verdictColor(review.verdict)}`);
      } else {
        result.verdict = 'approve';
        result.phases.decide = { status: 'skipped', reason: 'no diff' };
      }
    } else {
      // Simple tasks: auto-approve if verification passed
      result.verdict = (verification.passed || !verification.ran) && violations.length === 0
        ? 'approve' : 'needs-review';
      result.phases.decide = { status: 'auto', verdict: result.verdict };
    }

    result.status = result.verdict === 'reject' ? 'rejected' : 'success';

  } catch (err) {
    result.status = 'error';
    result.phases.error = { message: err.message };
    console.log(pc.red(`  [ERROR] ${err.message}`));
  }

  result.durationMs = Date.now() - startTime;

  // Return to base branch
  try {
    checkoutBranch(projectRoot, baseBranch);
  } catch { /* best effort */ }

  return result;
}

// ── Report Generation ───────────────────────────────────────────────────────

function generateReport(date, results, budgetSummary, sessionConfig) {
  const successful = results.filter(r => r.status === 'success').length;
  const failed = results.filter(r => r.status === 'failed' || r.status === 'error').length;
  const skipped = results.filter(r => r.status === 'skipped' || r.status === 'empty').length;
  const rejected = results.filter(r => r.status === 'rejected').length;

  // JSON report
  const jsonReport = {
    date,
    runner: 'hydra-tasks',
    totalTasks: results.length,
    processedTasks: results.filter(r => r.status !== 'skipped').length,
    successful,
    failed,
    skipped,
    rejected,
    stopReason: null,
    budget: budgetSummary,
    config: sessionConfig,
    results,
  };

  // Markdown report
  let md = `# Hydra Tasks Report — ${date}\n\n`;
  md += `## Summary\n`;
  md += `- **Total tasks**: ${results.length}\n`;
  md += `- **Successful**: ${successful}\n`;
  md += `- **Failed**: ${failed}\n`;
  md += `- **Skipped**: ${skipped}\n`;
  md += `- **Rejected**: ${rejected}\n\n`;

  md += `## Budget\n`;
  md += `- Consumed: ${budgetSummary.consumed?.toLocaleString() || '?'} tokens\n`;
  md += `- Limit: ${budgetSummary.hardLimit?.toLocaleString() || '?'} tokens\n`;
  md += `- Duration: ${formatDuration(budgetSummary.durationMs || 0)}\n\n`;

  md += `## Tasks\n\n`;
  md += `| # | Task | Agent | Status | Tokens | Duration | Verdict |\n`;
  md += `|---|------|-------|--------|--------|----------|----------|\n`;

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const statusIcon = r.status === 'success' ? 'pass' : r.status === 'failed' ? 'FAIL' : r.status;
    md += `| ${i + 1} | ${r.task.slice(0, 40)} | ${r.agent} | ${statusIcon} | ${r.tokens || '?'} | ${formatDuration(r.durationMs)} | ${r.verdict || '-'} |\n`;
  }

  md += '\n';

  return { json: jsonReport, markdown: md };
}

// ── Main Session ────────────────────────────────────────────────────────────

async function main() {
  initAgentRegistry();

  const { options, positionals } = parseArgs(process.argv);

  let config;
  try {
    config = resolveProject({ project: options.project });
  } catch (err) {
    console.error(pc.red(`Project resolution failed: ${err.message}`));
    process.exit(1);
  }

  const { projectRoot } = config;
  const cfg = loadHydraConfig();
  const baseBranch = cfg.tasks?.baseBranch || 'dev';

  // ── Preconditions ──
  const branchCheck = verifyBranch(projectRoot, baseBranch);
  if (!branchCheck.ok) {
    console.log(pc.yellow(`Switching to ${baseBranch} (was on ${branchCheck.currentBranch})`));
    checkoutBranch(projectRoot, baseBranch);
  }

  if (!isCleanWorkingTree(projectRoot)) {
    console.error(pc.red('Working tree is not clean. Commit or stash changes first.'));
    process.exit(1);
  }

  // ── Scan ──
  console.log(pc.bold('\nHydra Tasks Runner\n'));
  console.log(pc.dim('Scanning for work items...'));

  const scannedTasks = scanAllSources(projectRoot);

  if (scannedTasks.length === 0) {
    console.log(pc.yellow('\nNo tasks found. Add TODO/FIXME comments or create GitHub issues.'));
    process.exit(0);
  }

  // ── Interactive Selection ──
  const rl = createRL();
  let selectedTasks;

  // Check for preset/cli overrides
  if (options.preset || options.max) {
    selectedTasks = scannedTasks.slice(0, parseInt(options.max, 10) || 5);
  } else {
    selectedTasks = await selectTasks(rl, scannedTasks);
  }

  if (!selectedTasks || selectedTasks.length === 0) {
    console.log(pc.dim('\nNo tasks selected. Exiting.'));
    rl.close();
    process.exit(0);
  }

  // ── Budget Selection ──
  let budgetPreset;
  if (options.preset && BUDGET_PRESETS[options.preset]) {
    budgetPreset = BUDGET_PRESETS[options.preset];
  } else if (options.hours || options.budget) {
    budgetPreset = {
      maxHours: parseFloat(options.hours || '1') || 1,
      budgetPct: parseFloat(options.budget || '20') / 100 || 0.20,
      maxTasks: parseInt(options.max || '10', 10) || 10,
      label: 'CLI override',
    };
  } else {
    budgetPreset = await selectBudget(rl, cfg);
  }

  rl.close();

  // Cap tasks to budget max
  selectedTasks = selectedTasks.slice(0, budgetPreset.maxTasks);

  // ── Budget Tracker Setup ──
  const weeklyBudget = cfg.usage?.weeklyTokenBudget?.['claude-opus-4-6'] || 25_000_000;
  const tokenBudget = Math.round(weeklyBudget * budgetPreset.budgetPct);
  const perTaskEstimate = cfg.tasks?.budget?.perTaskEstimate || 100_000;

  const budget = new BudgetTracker({
    softLimit: Math.round(tokenBudget * 0.85),
    hardLimit: tokenBudget,
    unitEstimate: perTaskEstimate,
    unitLabel: 'task',
    thresholds: BUDGET_THRESHOLDS,
  });
  budget.recordStart();

  // ── Session Summary ──
  const date = todayStr();

  console.log(pc.bold('\n── Session Configuration ──\n'));
  console.log(`  Tasks: ${pc.cyan(String(selectedTasks.length))}`);
  console.log(`  Budget: ${pc.cyan(budgetPreset.label)}`);
  console.log(`  Token limit: ${pc.cyan(tokenBudget.toLocaleString())}`);
  console.log(`  Time limit: ${pc.cyan(`${budgetPreset.maxHours}hr`)}`);
  console.log(`  Base branch: ${pc.cyan(baseBranch)}`);
  console.log('');

  for (let i = 0; i < selectedTasks.length; i++) {
    const t = selectedTasks[i];
    console.log(`  ${pc.dim(String(i + 1) + '.')} ${t.title} ${pc.dim(`[${t.suggestedAgent}]`)}`);
  }
  console.log('');

  // ── Execute Tasks ──
  const sessionStart = Date.now();
  const maxMs = budgetPreset.maxHours * 60 * 60 * 1000;
  const results = [];
  let stopReason = null;
  let useCheapMode = false;

  for (let i = 0; i < selectedTasks.length; i++) {
    const task = selectedTasks[i];

    // Time check
    const elapsed = Date.now() - sessionStart;
    if (elapsed >= maxMs) {
      stopReason = `Time limit reached (${budgetPreset.maxHours}hr)`;
      console.log(pc.yellow(`\n  ${stopReason}`));
      break;
    }

    // Budget check
    const budgetCheck = budget.check();
    if (budgetCheck.action === 'hard_stop') {
      stopReason = budgetCheck.reason;
      console.log(pc.red(`\n  ${stopReason}`));
      break;
    }
    if (budgetCheck.action === 'soft_stop') {
      stopReason = budgetCheck.reason;
      console.log(pc.yellow(`\n  ${stopReason} — completing this task then stopping`));
    }
    if (budgetCheck.action === 'handoff_cheap' && !useCheapMode) {
      useCheapMode = true;
      console.log(pc.yellow(`\n  Budget at ${Math.round(budgetCheck.percentUsed * 100)}% — switching to economy tier`));
    }
    if (budgetCheck.action === 'warn') {
      console.log(pc.yellow(`  Budget: ${Math.round(budgetCheck.percentUsed * 100)}% used`));
    }

    const result = await executeTask(
      task, i, selectedTasks.length, projectRoot, baseBranch, cfg, budget,
      useCheapMode ? 'economy' : 'performance',
    );

    results.push(result);

    // Record budget
    const budgetDelta = budget.recordUnitEnd(task.slug, result.durationMs);
    result.tokens = budgetDelta.tokens;

    const statusIcon = result.status === 'success' ? pc.green('PASS')
      : result.status === 'failed' ? pc.red('FAIL')
      : pc.yellow(result.status.toUpperCase());
    console.log(`\n  ${statusIcon} ${task.title} (${formatDuration(result.durationMs)})`);

    if (stopReason) break;
  }

  // ── Return to base branch ──
  try {
    checkoutBranch(projectRoot, baseBranch);
  } catch { /* best effort */ }

  // ── Generate Report ──
  const budgetSummary = budget.getSummary();
  if (stopReason) budgetSummary.stopReason = stopReason;

  const report = generateReport(date, results, budgetSummary, {
    preset: budgetPreset.label,
    maxTasks: budgetPreset.maxTasks,
    maxHours: budgetPreset.maxHours,
    tokenBudget,
  });

  // Save reports
  const reportDir = path.join(projectRoot, 'docs', 'coordination', 'tasks');
  ensureDir(reportDir);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const jsonPath = path.join(reportDir, `TASKS_${date}_${timestamp}.json`);
  const mdPath = path.join(reportDir, `TASKS_${date}_${timestamp}.md`);

  fs.writeFileSync(jsonPath, JSON.stringify(report.json, null, 2) + '\n', 'utf8');
  fs.writeFileSync(mdPath, report.markdown, 'utf8');

  // ── Final Summary ──
  const successful = results.filter(r => r.status === 'success').length;
  const failed = results.filter(r => r.status === 'failed' || r.status === 'error').length;

  console.log(pc.bold('\n── Tasks Runner Complete ──\n'));
  console.log(`  Processed: ${results.length}/${selectedTasks.length}`);
  console.log(`  Success: ${pc.green(String(successful))}`);
  console.log(`  Failed: ${failed > 0 ? pc.red(String(failed)) : pc.dim('0')}`);
  console.log(`  Budget: ${Math.round(budgetSummary.percentUsed * 100)}% used (${budgetSummary.consumed?.toLocaleString() || '?'} tokens)`);
  console.log(`  Duration: ${formatDuration(budgetSummary.durationMs)}`);
  if (stopReason) console.log(`  Stopped: ${pc.yellow(stopReason)}`);
  console.log(`\n  Report: ${pc.dim(mdPath)}`);

  // List branches for review
  const taskBranches = results.filter(r => r.status === 'success').map(r => r.branch);
  if (taskBranches.length > 0) {
    console.log(pc.dim(`\n  Run 'npm run tasks:review' to merge approved branches.`));
  }

  console.log('');
}

main().catch(err => {
  console.error(pc.red(`Fatal: ${err.message}`));
  process.exit(1);
});
