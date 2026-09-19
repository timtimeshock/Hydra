#!/usr/bin/env node
/**
 * Hydra Operator Console (hydra:go)
 *
 * One-terminal command center for dispatching prompts to Gemini/Codex/Claude.
 * Dispatch is recorded as Hydra handoffs so each agent can pull with hydra:next.
 * Supports modes: auto (mini-round triage), handoff (direct), council (full deliberation).
 *
 * Usage:
 *   node hydra-operator.mjs prompt="Investigate auth deadlock"
 *   node hydra-operator.mjs              # interactive mode
 *   node hydra-operator.mjs mode=dispatch prompt="..."  # dispatch pipeline
 */

import './hydra-env.mjs';
import readline from 'readline';
import path from 'path';
import { exec, spawn, spawnSync } from 'child_process';
import { getProjectContext } from './hydra-context.mjs';
import { rewriteNodeInvocation, spawnHydraNode, spawnHydraNodeSync } from './hydra-exec.mjs';
import { getAgent, AGENT_NAMES, getActiveModel, getModelSummary, setActiveModel, getMode, setMode, resetAgentModel, getVerifier, listAgents, resolvePhysicalAgent, AGENT_TYPE, registerAgent, unregisterAgent, formatEffortDisplay, bestAgentFor } from './hydra-agents.mjs';
import { checkUsage, renderUsageDashboard, renderUsageBar, formatTokens, getContingencyOptions, executeContingency } from './hydra-usage.mjs';
import { verifyAgentQuota } from './hydra-model-recovery.mjs';
import { getSessionUsage, getMetricsSummary, estimateFlowDuration, resetMetrics } from './hydra-metrics.mjs';
import { resolveProject, HYDRA_ROOT, loadHydraConfig, saveHydraConfig, getRoleConfig, getRecentProjects } from './hydra-config.mjs';
import { envFileExists } from './hydra-env.mjs';
import { executeAgent } from './hydra-shared/agent-executor.mjs';
import {
  parseArgs,
  getPrompt,
  parseList,
  boolFlag,
  short,
  request,
  normalizeTask,
  classifyPrompt,
  selectTandemPair,
  generateSpec,
} from './hydra-utils.mjs';
import {
  hydraSplash,
  hydraLogoCompact,
  renderDashboard,
  renderStatsDashboard,
  progressBar,
  agentBadge,
  label,
  sectionHeader,
  divider,
  colorAgent,
  createSpinner,
  extractTopic,
  phaseNarrative,
  SUCCESS,
  ERROR,
  WARNING,
  DIM,
  ACCENT,
  AGENT_COLORS,
  stripAnsi,
  shortModelName,
} from './hydra-ui.mjs';
import {
  initStatusBar,
  destroyStatusBar,
  drawStatusBar,
  startEventStream,
  stopEventStream,
  onActivityEvent,
  setAgentActivity,
  setLastDispatch,
  setActiveMode,
  setDispatchContext,
  clearDispatchContext,
  setAgentExecMode,
} from './hydra-statusbar.mjs';
import { AgentWorker } from './hydra-worker.mjs';
import {
  promptChoice,
  isChoiceActive,
  isAutoAccepting,
  setAutoAccept,
  resetAutoAccept,
} from './hydra-prompt-choice.mjs';
import {
  conciergeTurn,
  conciergeSuggest,
  resetConversation,
  isConciergeAvailable,
  getConciergeStats,
  getConciergeConfig,
  getActiveProvider,
  getConciergeModelLabel,
  switchConciergeModel,
  exportConversation,
  getRecentContext,
  setConciergeBaseUrl,
} from './hydra-concierge.mjs';
import { buildFallbackChain, detectAvailableProviders } from './hydra-concierge-providers.mjs';
import { syncHydraMd } from './hydra-sync-md.mjs';
import { registerBuiltInSubAgents } from './hydra-sub-agents.mjs';
import {
  isGhAvailable,
  isGhAuthenticated,
  detectRepo,
  listPRs,
  getPR,
  pushBranchAndCreatePR,
  getGitHubConfig,
} from './hydra-github.mjs';
import {
  detectSituationalQuery,
  buildActivityDigest,
  formatDigestForPrompt,
  generateSitrep,
  pushActivity,
  annotateDispatch,
  annotateHandoff,
  annotateCompletion,
} from './hydra-activity.mjs';
import {
  loadCodebaseContext,
  detectCodebaseQuery,
  getTopicContext,
  getBaselineContext,
  searchKnowledgeBase,
} from './hydra-codebase-context.mjs';
import { buildSelfSnapshot, formatSelfSnapshotForPrompt } from './hydra-self.mjs';
import { buildSelfIndex, formatSelfIndexForPrompt } from './hydra-self-index.mjs';
import {
  runForgeWizard,
  listForgedAgents,
  removeForgedAgent,
  testForgedAgent,
  validateAgentSpec,
  loadForgeRegistry,
  analyzeCodebase as forgeAnalyzeCodebase,
  runForgePipeline,
  persistForgedAgent,
} from './hydra-agent-forge.mjs';
import { scanResumableState } from './hydra-resume-scanner.mjs';
import { checkForUpdates } from './hydra-updater.mjs';
import { isPersonaEnabled, getAgentFraming, getProcessLabel, showPersonaSummary, applyPreset, listPresets, invalidatePersonaCache } from './hydra-persona.mjs';
import {
  getProviderSummary,
  getExternalSummary,
  getProviderUsage,
  loadProviderUsage,
  saveProviderUsage,
  refreshExternalUsage,
  resetSessionUsage,
} from './hydra-provider-usage.mjs';
import pc from 'picocolors';

const config = resolveProject();
const DEFAULT_URL = process.env.AI_ORCH_URL || 'http://127.0.0.1:4173';

// ── Dry-Run Mode ─────────────────────────────────────────────────────────────

let dryRunMode = false;

// ── Agent Workers (headless background execution) ────────────────────────────

const workers = new Map(); // agent -> AgentWorker

function startAgentWorker(agent, baseUrl, { rl } = {}) {
  const name = agent.toLowerCase();
  if (workers.has(name) && workers.get(name).status !== 'stopped') {
    return workers.get(name);
  }

  const worker = new AgentWorker(name, {
    baseUrl,
    projectRoot: config.projectRoot,
  });

  // Wire worker events to status bar
  worker.on('task:start', ({ agent: a, taskId, title }) => {
    setAgentActivity(a, 'working', title || 'Working', { taskTitle: title });
    drawStatusBar();
  });

  worker.on('task:complete', ({ agent: a, taskId, title: taskTitle, status, durationMs, outputSummary }) => {
    // Record activity annotation for all completions
    pushActivity(status === 'error' ? 'error' : 'completion', annotateCompletion({
      agent: a, taskId, title: taskTitle || '', durationMs, outputSummary, status,
    }), { agent: a, taskId, durationMs });

    // Skip success notification for failed tasks — task:error handler covers those
    if (status === 'error') return;

    const elapsed = durationMs ? `${Math.round(durationMs / 1000)}s` : '';
    const shortTitle = taskTitle ? ` (${String(taskTitle).slice(0, 40)})` : '';
    setAgentActivity(a, 'idle', `Done ${taskId}${elapsed ? ` (${elapsed})` : ''}`);
    drawStatusBar();

    // Show inline notification with sparkle
    const icon = SUCCESS('\u2713');
    const sparkle = '\u2728'; // ✨
    const msg = `  ${icon} ${sparkle} ${colorAgent(a)} completed ${pc.white(taskId)}${shortTitle ? DIM(shortTitle) : ''}${elapsed ? ` ${DIM(`in ${elapsed}`)}` : ''}`;

    // Brief flash effect: bold → normal
    if (process.stdout?.isTTY) {
      process.stdout.write(`\r\x1b[2K${pc.bold(msg)}\n`);
      setTimeout(() => {
        process.stdout.write(`\x1b[1A\r\x1b[2K${msg}\n`);
        if (rl && !isChoiceActive()) {
          rl.prompt(true);
        }
      }, 100);
    } else {
      process.stdout.write(`\r\x1b[2K${msg}\n`);
      if (rl && !isChoiceActive()) {
        rl.prompt(true);
      }
    }
  });

  worker.on('task:error', ({ agent: a, taskId, title: taskTitle, error, errorCategory, errorDetail, errorContext }) => {
    pushActivity('error', annotateCompletion({
      agent: a, taskId, title: taskTitle || '', status: 'error', outputSummary: error,
    }), { agent: a, taskId });

    setAgentActivity(a, 'error', `Error: ${(error || '').slice(0, 30)}`);
    drawStatusBar();

    const shortTitle = taskTitle ? ` (${String(taskTitle).slice(0, 40)})` : '';
    const shortError = (error || '').slice(0, 60);
    const msg = `  ${ERROR('\u2717')} ${colorAgent(a)} error on ${pc.white(taskId || '?')}${shortTitle ? DIM(shortTitle) : ''}: ${DIM(shortError)}`;
    process.stdout.write(`\r\x1b[2K${msg}\n`);

    // Show full error details for debugging
    if (errorCategory && errorDetail) {
      const fullMsg = `    ${DIM(`[${errorCategory}] ${errorDetail}`)}`;
      process.stdout.write(`${fullMsg}\n`);
    }
    if (errorContext && errorContext.length > 100) {
      const ctx = errorContext.slice(0, 300);
      process.stdout.write(`    ${DIM(ctx)}\n`);
    }

    if (rl && !isChoiceActive()) {
      rl.prompt(true);
    }
  });

  worker.on('worker:idle', ({ agent: a }) => {
    setAgentActivity(a, 'idle', 'Awaiting next task');
    drawStatusBar();
  });

  worker.on('worker:stop', ({ agent: a, reason }) => {
    setAgentExecMode(a, null);
    setAgentActivity(a, 'inactive', 'Stopped');
    drawStatusBar();
  });

  setAgentExecMode(name, 'worker');
  worker.start();
  workers.set(name, worker);

  console.log(`  ${SUCCESS('\u2713')} ${colorAgent(name)} worker started ${DIM(`(${worker.permissionMode})`)}`);
  return worker;
}

function stopAgentWorker(agent) {
  const name = agent.toLowerCase();
  const worker = workers.get(name);
  if (!worker) return;
  worker.stop();
  setAgentExecMode(name, null);
}

function stopAllWorkers() {
  for (const [name, worker] of workers) {
    worker.kill();
    setAgentExecMode(name, null);
  }
  workers.clear();
}

function getWorkerStatus(agent) {
  const worker = workers.get(agent.toLowerCase());
  if (!worker) return null;
  return {
    agent: worker.agent,
    status: worker.status,
    currentTask: worker.currentTask,
    uptime: worker.uptime,
    permissionMode: worker.permissionMode,
  };
}

function startAgentWorkers(agentNames, baseUrl, opts = {}) {
  for (const agent of agentNames) {
    startAgentWorker(agent, baseUrl, opts);
  }
}

function formatUptime(ms) {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3600_000).toFixed(1)}h`;
}

// ── Daemon Auto-Start ────────────────────────────────────────────────────────

async function ensureDaemon(baseUrl, { quiet = false } = {}) {
  // Check if daemon is already running
  try {
    await request('GET', baseUrl, '/health');
    return true;
  } catch {
    // Not running — try to start it
  }

  if (!quiet) {
    process.stderr.write(`  ${DIM('\u2026')} Starting daemon...\n`);
  }

  const daemonScript = path.join(HYDRA_ROOT, 'lib', 'orchestrator-daemon.mjs');
  const child = spawnHydraNode(daemonScript, ['start'], {
    cwd: config.projectRoot,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  // Wait for health (up to 8 seconds)
  for (let i = 0; i < 32; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      await request('GET', baseUrl, '/health');
      if (!quiet) {
        process.stderr.write(`  ${SUCCESS('\u2713')} Daemon started\n`);
      }
      return true;
    } catch {
      // keep waiting
    }
  }

  return false;
}

// ── Agent Terminal Auto-Launch ───────────────────────────────────────────────

/**
 * Detect pwsh or powershell on Windows. Returns exe path or null.
 */
function findPowerShell() {
  if (process.platform !== 'win32') return null;
  for (const cmd of ['pwsh', 'powershell']) {
    try {
      const result = spawnSync('where', [cmd], { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
      const exe = (result.stdout || '').split('\n')[0].trim();
      if (exe) return exe;
    } catch { /* not found */ }
  }
  return null;
}

/**
 * Detect Windows Terminal (wt.exe). Returns exe path or null.
 */
function findWindowsTerminal() {
  if (process.platform !== 'win32') return null;
  try {
    const result = spawnSync('where', ['wt'], { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
    const exe = (result.stdout || '').split('\n')[0].trim();
    if (exe) return exe;
  } catch { /* not found */ }
  return null;
}

/**
 * Spawn visible terminal windows running hydra-head.ps1 for each agent.
 * Uses -EncodedCommand to avoid escaping issues, and exec(start ...) for
 * reliable window visibility on Windows.
 */
function launchAgentTerminals(agentNames, baseUrl) {
  if (process.platform !== 'win32' || agentNames.length === 0) return;
  if (process.pkg) {
    console.log(`  ${DIM('(standalone build: terminal launch disabled; use :workers start instead)')}`);
    return;
  }

  const shell = findPowerShell();
  if (!shell) {
    console.log(`  ${DIM('(skipping terminal launch — no PowerShell found)')}`);
    return;
  }

  const wt = findWindowsTerminal();
  const headScript = path.join(HYDRA_ROOT, 'bin', 'hydra-head.ps1');
  const cwd = config.projectRoot;
  const cwdEscaped = cwd.replace(/'/g, "''");

  for (const agent of agentNames) {
    if (!getAgent(agent)) continue;
    const title = `Hydra Head - ${agent.toUpperCase()}`;
    const psCommand = [
      `Set-Location -LiteralPath '${cwdEscaped}'`,
      `& '${headScript}' -Agent ${agent} -Url '${baseUrl}'`,
    ].join('; ');

    // Encode as UTF-16LE base64 for -EncodedCommand (avoids all escaping issues)
    const encoded = Buffer.from(psCommand, 'utf16le').toString('base64');

    let cmd;
    if (wt) {
      // Windows Terminal: open a new tab in the current window
      cmd = `wt -w 0 new-tab --title "${title}" "${shell}" -NoExit -EncodedCommand ${encoded}`;
    } else {
      // Fallback: start command reliably opens a visible console window
      cmd = `start "${title}" "${shell}" -NoExit -EncodedCommand ${encoded}`;
    }
    exec(cmd, { cwd });

    const icon = { gemini: '\u2726', codex: '\u25B6', claude: '\u2666' }[agent] || '\u25CF';
    console.log(`  ${SUCCESS('\u2713')} ${colorAgent(agent, `${icon} ${agent}`)}  terminal launched`);
  }
}

/**
 * Extract unique agent names from auto/smart dispatch result.
 */
function extractHandoffAgents(result) {
  const handoffs = result?.published?.handoffs;
  if (!Array.isArray(handoffs) || handoffs.length === 0) return [];
  const seen = new Set();
  for (const h of handoffs) {
    const name = String(h.to || '').toLowerCase();
    if (name && getAgent(name)) seen.add(name);
  }
  return [...seen];
}

// ── Welcome Screen ───────────────────────────────────────────────────────────

async function printWelcome(baseUrl) {
  console.log(hydraSplash());
  console.log(label('Project', pc.white(config.projectName)));
  // Sync HYDRA.md → agent instruction files on startup
  try {
    const syncResult = syncHydraMd(config.projectRoot);
    if (syncResult.synced.length > 0) {
      console.log(label('Sync', DIM(`HYDRA.md → ${syncResult.synced.join(', ')}`)));
    }
  } catch { /* non-critical */ }

  console.log(label('Daemon', DIM(baseUrl)));

  // Startup alert: check for in-progress tasks and pending handoffs
  try {
    const sessionStatus = await request('GET', baseUrl, '/session/status');
    if (sessionStatus.activeSession?.status === 'paused') {
      const reason = sessionStatus.activeSession.pauseReason;
      console.log(`  ${WARNING('\u23F8')} Session paused${reason ? `: "${reason}"` : ''} \u2014 type ${ACCENT(':unpause')} to resume`);
    }
    const inProgressCount = (sessionStatus.inProgressTasks || []).length;
    const handoffCount = (sessionStatus.pendingHandoffs || []).length;
    const staleCount = (sessionStatus.staleTasks || []).length;
    const parts = [];
    if (inProgressCount > 0) parts.push(`${inProgressCount} task${inProgressCount !== 1 ? 's' : ''} in progress`);
    if (handoffCount > 0) parts.push(`${handoffCount} handoff${handoffCount !== 1 ? 's' : ''} pending`);
    if (staleCount > 0) parts.push(`${staleCount} stale`);
    if (parts.length > 0) {
      console.log(`  ${WARNING('\u26A0')} ${parts.join(', ')} \u2014 type ${ACCENT(':resume')} for details`);
    }
  } catch { /* daemon may not have session data yet */ }

  // Mode & Models
  try {
    const models = getModelSummary();
    const currentMode = models._mode || getMode();
    console.log(label('Mode', ACCENT(currentMode)));
    const parts = [];
    for (const [agent, info] of Object.entries(models)) {
      if (agent === '_mode') continue;
      const colorFn = AGENT_COLORS[agent] || pc.white;
      const shortModel = (info.active || '').replace(/^claude-/, '').replace(/^gemini-/, '');
      const tag = info.isOverride ? pc.yellow(' *') : '';
      const effLabel = formatEffortDisplay(info.active, info.reasoningEffort);
      const eff = effLabel ? pc.yellow(` ${effLabel}`) : '';
      parts.push(`${colorFn(agent)}${DIM(':')}${pc.white(shortModel)}${eff}${tag}`);
    }
    console.log(label('Models', parts.join(DIM('  '))));
  } catch { /* skip */ }

  // Usage — show today's actual tokens from stats-cache
  try {
    const usage = checkUsage();
    if (usage.todayTokens > 0) {
      const modelShort = (usage.model || '').replace(/^claude-/, '').replace(/^gemini-/, '');
      console.log(label('Today', `${pc.white(formatTokens(usage.todayTokens))} tokens ${modelShort ? DIM(`(${modelShort})`) : ''}`));
    }
  } catch { /* skip */ }

  // Session token usage (from real Claude JSON output)
  try {
    const session = getSessionUsage();
    if (session.callCount > 0) {
      console.log(label('Session', `${pc.white(formatTokens(session.totalTokens))} tokens  ${pc.white('$' + session.costUsd.toFixed(4))}  ${DIM(`(${session.callCount} calls)`)}`));
    }
  } catch { /* skip */ }

  // Provider usage (load persisted + refresh external in background)
  try {
    loadProviderUsage();
    refreshExternalUsage(); // non-blocking
    const providerLines = getProviderSummary();
    if (providerLines.length > 0) {
      console.log(label('Providers', providerLines.join(DIM(' │ '))));
    }
    const extLines = getExternalSummary();
    if (extLines.length > 0) {
      console.log(label('Account', extLines.join(DIM(' │ '))));
    }
  } catch { /* skip */ }

  // Context-aware next steps on startup
  try {
    const sessionStatus = await request('GET', baseUrl, '/session/status');
    printNextSteps({
      agentSuggestions: sessionStatus.agentSuggestions,
      pendingHandoffs: sessionStatus.pendingHandoffs,
      staleTasks: sessionStatus.staleTasks,
      inProgressTasks: sessionStatus.inProgressTasks,
    });
  } catch {
    console.log(`  ${DIM('Type a prompt to dispatch, or :help for commands')}`);
  }
}

function buildAgentMessage(agent, userPrompt) {
  const agentConfig = getAgent(agent);
  const rolePrompt = agentConfig ? agentConfig.rolePrompt : 'Contribute effectively to this objective.';
  const agentLabel = agentConfig ? agentConfig.label : agent.toUpperCase();

  const heading = isPersonaEnabled()
    ? `${getAgentFraming(agent)} ${getProcessLabel('dispatch')} directive:`
    : `Hydra dispatch for ${agentLabel}:`;

  return [
    heading,
    `Primary objective: ${userPrompt}`,
    '',
    rolePrompt,
    '',
    agent === 'codex' ? 'You will receive precise task specs. Execute efficiently and report what you changed.' : '',
    agent === 'gemini' ? 'Cite specific file paths and line numbers in all findings.' : '',
    agent === 'claude' ? 'Create detailed task specs for Codex (file paths, signatures, DoD) in your handoffs.' : '',
    '',
    'If blocked or unclear, ask direct questions immediately.',
    'When done with current chunk, create a Hydra handoff with exact next step.',
    '',
    getProjectContext(agent, {}, config),
  ].filter(Boolean).join('\n');
}

function buildMiniRoundBrief(agent, userPrompt, report) {
  const agentConfig = getAgent(agent);
  const tasks = Array.isArray(report?.tasks) ? report.tasks.map(normalizeTask).filter(Boolean) : [];
  const questions = Array.isArray(report?.questions) ? report.questions : [];
  const consensus = String(report?.consensus || '').trim();

  const myTasks = tasks.filter((task) => task.owner === agent || task.owner === 'unassigned');
  const myQuestions = questions.filter((q) => q && (q.to === agent || q.to === 'human'));

  const taskText =
    myTasks.length === 0
      ? '- No explicit task assigned. Start by proposing first concrete step.'
      : myTasks
          .map((task) => `- ${task.title}${task.done ? ` (DoD: ${task.done})` : ''}${task.rationale ? ` [${task.rationale}]` : ''}`)
          .join('\n');

  const questionText =
    myQuestions.length === 0
      ? '- none'
      : myQuestions
          .map((q) => {
            const to = String(q.to || 'human');
            const question = String(q.question || '').trim();
            return question ? `- to ${to}: ${question}` : null;
          })
          .filter(Boolean)
          .join('\n');

  return [
    isPersonaEnabled()
      ? `${getAgentFraming(agent)} ${getProcessLabel('miniRound')} delegation.`
      : `Hydra mini-round delegation for ${agentConfig ? agentConfig.label : agent.toUpperCase()}.`,
    '',
    agentConfig ? agentConfig.rolePrompt : '',
    '',
    getProjectContext(agent, {}, config),
    '',
    `Objective: ${userPrompt}`,
    `Recommendation: ${report?.recommendedMode || 'handoff'} (${report?.recommendationRationale || 'n/a'})`,
    `Consensus: ${consensus || 'No explicit consensus text.'}`,
    'Assigned tasks:',
    taskText,
    'Open questions:',
    questionText,
    'Next step: execute first task and publish milestone/blocker via Hydra handoff.',
  ].filter(Boolean).join('\n');
}

/**
 * Cross-model verification: route producer output to a paired verifier agent.
 * Returns { approved, issues, suggestions } or null if verification is skipped/fails.
 */
async function runCrossVerification(producerAgent, producerOutput, originalPrompt, specContent = null) {
  const cfg = loadHydraConfig();
  const cvConfig = cfg.crossModelVerification;
  if (!cvConfig?.enabled) return null;

  const verifierAgent = getVerifier(producerAgent);
  if (verifierAgent === producerAgent) return null;

  const reviewPrompt = [
    'You are reviewing another AI agent\'s output. Be precise and adversarial — your job is to surface what the producer missed or got wrong.',
    '',
    `Original objective: ${originalPrompt}`,
    specContent ? `\nAnchoring specification:\n${specContent}\n` : '',
    `Producer agent: ${producerAgent}`,
    `Producer output:\n${producerOutput}`,
    '',
    'Review this output and return JSON only:',
    '{',
    '  "approved": true|false,',
    '  "strongestAssumption": "The single most load-bearing assumption in this output — if it is wrong, the whole approach fails",',
    '  "attackVector": "A concrete scenario or counterexample that would break the strongest assumption",',
    '  "issues": ["string — specific correctness or completeness failures"],',
    '  "suggestions": ["string — concrete improvements"],',
    '  "criteriaScores": {',
    '    "correctness": 0-10,',
    '    "complexity": 0-10,',
    '    "reversibility": 0-10,',
    '    "userImpact": 0-10',
    '  }',
    '}',
    '',
    'Scoring guide: correctness = factual/logical soundness; complexity = simplicity of approach (10 = minimal); reversibility = how easily this can be undone (10 = fully reversible); userImpact = positive effect on end users.',
  ].filter(Boolean).join('\n');

  try {
    const result = await executeAgent(verifierAgent, reviewPrompt, {
      cwd: config.projectRoot,
      timeoutMs: 60_000,
      permissionMode: verifierAgent === 'codex' ? 'read-only' : 'plan',
    });
    if (!result.ok) return null;

    const output = result.stdout || result.output || '';
    let parsed = null;
    try {
      parsed = JSON.parse(output);
    } catch {
      // Try extracting JSON from response
      const match = output.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch { /* give up */ }
      }
    }
    if (!parsed) return null;

    return {
      verifier: verifierAgent,
      approved: Boolean(parsed.approved),
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
    };
  } catch {
    return null;
  }
}

/**
 * Check if cross-model verification should run for a given classification.
 */
function shouldCrossVerify(classification) {
  const cfg = loadHydraConfig();
  const cvConfig = cfg.crossModelVerification;
  if (!cvConfig?.enabled) return false;
  if (cvConfig.mode === 'always') return true;
  if (cvConfig.mode === 'on-complex') return classification.tier === 'complex';
  return false;
}

async function publishMiniRoundDelegation({ baseUrl, from, agents, promptText, report }) {
  const normalizedTasks = (Array.isArray(report?.tasks) ? report.tasks : []).map(normalizeTask).filter(Boolean);
  const tasksToCreate =
    normalizedTasks.length > 0
      ? normalizedTasks
      : agents.map((agent) => ({
          owner: agent,
          title: `Execute ${agent} contribution for: ${short(promptText, 120)}`,
          done: '',
          rationale: 'Generated fallback task because mini-round had no explicit allocations.',
        }));

  const createdTasks = [];
  for (const task of tasksToCreate) {
    const created = await request('POST', baseUrl, '/task/add', {
      title: task.title,
      owner: task.owner,
      status: 'todo',
      notes: task.rationale ? `Mini-round rationale: ${task.rationale}` : '',
    });
    createdTasks.push(created.task);
  }

  const decision = await request('POST', baseUrl, '/decision', {
    title: `Hydra Mini Round: ${short(promptText, 90)}`,
    owner: from,
    rationale: short(report?.consensus || 'Mini-round completed without explicit consensus.', 600),
    impact: `recommended=${report?.recommendedMode || 'handoff'}; tasks=${createdTasks.length}`,
  });

  const handoffs = [];
  for (const agent of agents) {
    const agentTaskIds = createdTasks.filter((task) => task.owner === agent || task.owner === 'unassigned').map((task) => task.id);
    const summary = buildMiniRoundBrief(agent, promptText, report);
    const handoff = await request('POST', baseUrl, '/handoff', {
      from,
      to: agent,
      summary,
      nextStep: 'Acknowledge and execute top-priority delegated task.',
      tasks: agentTaskIds,
    });
    handoffs.push(handoff.handoff);
  }

  // Record activity annotation
  pushActivity('dispatch', annotateDispatch({
    prompt: promptText,
    classification: { tier: 'medium', taskType: 'mixed' },
    mode: 'auto',
    route: 'mini-round',
    agent: agents[0],
  }), { agents, taskCount: createdTasks.length });

  return {
    decision: decision.decision,
    tasks: createdTasks,
    handoffs,
  };
}

async function dispatchPrompt({ baseUrl, from, agents, promptText }) {
  const records = [];
  for (const agent of agents) {
    const summary = buildAgentMessage(agent, promptText);
    const payload = {
      from,
      to: agent,
      summary,
      nextStep: 'Start work and report first milestone via hydra:handoff.',
      tasks: [],
    };
    const result = await request('POST', baseUrl, '/handoff', payload);
    records.push({
      agent,
      handoffId: result?.handoff?.id || null,
      summary,
    });
  }
  return records;
}

async function publishFastPathDelegation({ baseUrl, from, promptText, classification, agents = null }) {
  const { taskType } = classification;
  let { suggestedAgent } = classification;

  // If agents filter provided and suggestedAgent is excluded, pick best from allowed list
  if (agents && agents.length > 0 && !agents.includes(suggestedAgent)) {
    let best = agents[0];
    let bestScore = 0;
    for (const a of agents) {
      const cfg = getAgent(a);
      const score = cfg?.taskAffinity?.[taskType] || 0.5;
      if (score > bestScore) {
        bestScore = score;
        best = a;
      }
    }
    suggestedAgent = best;
  }

  const task = await request('POST', baseUrl, '/task/add', {
    title: short(promptText, 200),
    owner: suggestedAgent,
    status: 'todo',
    type: taskType,
    notes: `Fast-path dispatch (confidence=${classification.confidence}, reason: ${classification.reason})`,
  });

  const summary = buildAgentMessage(suggestedAgent, promptText);
  const handoff = await request('POST', baseUrl, '/handoff', {
    from,
    to: suggestedAgent,
    summary,
    nextStep: 'Start work and report first milestone via hydra:handoff.',
    tasks: task.task?.id ? [task.task.id] : [],
  });

  // Record activity annotation
  pushActivity('dispatch', annotateDispatch({
    prompt: promptText,
    classification,
    mode: 'auto',
    route: 'fast-path',
    agent: suggestedAgent,
  }), { agent: suggestedAgent, taskId: task.task?.id });

  return {
    task: task.task,
    handoff: handoff.handoff,
    agent: suggestedAgent,
  };
}

/**
 * Build a role-aware tandem brief for an agent in a tandem pair.
 */
function buildTandemBrief(agent, partner, promptText, classification, role) {
  const agentConfig = getAgent(agent);
  const agentLabel = agentConfig ? agentConfig.label : agent.toUpperCase();
  const partnerLabel = (getAgent(partner)?.label || partner.toUpperCase());

  const heading = isPersonaEnabled()
    ? `${getAgentFraming(agent)} ${getProcessLabel('dispatch')} directive (tandem ${role}):`
    : `Hydra tandem dispatch for ${agentLabel} (${role}):`;

  const roleInstruction = role === 'lead'
    ? `You are the lead in a tandem pair. Analyze the objective and produce an actionable plan or analysis. Your output will be handed to ${partnerLabel} for execution.`
    : `You are the follow-up in a tandem pair. Build on ${partnerLabel}'s analysis and execute the work. Focus on implementation and verification.`;

  const rolePrompt = agentConfig ? agentConfig.rolePrompt : 'Contribute effectively to this objective.';

  return [
    heading,
    `Primary objective: ${promptText}`,
    '',
    roleInstruction,
    '',
    rolePrompt,
    '',
    'If blocked or unclear, ask direct questions immediately.',
    'When done, create a Hydra handoff with exact next step.',
    '',
    getProjectContext(agent, {}, config),
  ].filter(Boolean).join('\n');
}

/**
 * Tandem dispatch: create 2 tasks + 2 handoffs for a lead→follow pair.
 * Zero agent CLI calls — daemon HTTP posts only.
 */
async function publishTandemDelegation({ baseUrl, from, promptText, classification, agents = null }) {
  let { tandemPair, taskType } = classification;

  // Re-resolve pair with agent filter
  if (agents && agents.length > 0) {
    tandemPair = selectTandemPair(taskType, classification.suggestedAgent, agents);
  }

  // Degrade to single if tandem not viable
  if (!tandemPair) {
    return publishFastPathDelegation({ baseUrl, from, promptText, classification, agents });
  }

  const { lead, follow } = tandemPair;

  // Create lead task
  const leadTask = await request('POST', baseUrl, '/task/add', {
    title: `[Lead] ${short(promptText, 180)}`,
    owner: lead,
    status: 'todo',
    type: taskType,
    notes: `Tandem lead (${lead} → ${follow}). Analyze/plan then hand off.`,
  });

  // Create follow task
  const followTask = await request('POST', baseUrl, '/task/add', {
    title: `[Follow] ${short(promptText, 180)}`,
    owner: follow,
    status: 'todo',
    type: taskType,
    notes: `Tandem follow (from ${lead}). Execute based on lead's analysis. Ref: task ${leadTask.task?.id || '?'}`,
  });

  // Create lead handoff
  const leadBrief = buildTandemBrief(lead, follow, promptText, classification, 'lead');
  const leadHandoff = await request('POST', baseUrl, '/handoff', {
    from,
    to: lead,
    summary: leadBrief,
    nextStep: `Analyze the objective and produce actionable plan. Your output will be forwarded to ${follow}.`,
    tasks: leadTask.task?.id ? [leadTask.task.id] : [],
  });

  // Create follow handoff
  const followBrief = buildTandemBrief(follow, lead, promptText, classification, 'follow');
  const followHandoff = await request('POST', baseUrl, '/handoff', {
    from,
    to: follow,
    summary: followBrief,
    nextStep: `Build on ${lead}'s analysis and execute. Reference task ${leadTask.task?.id || '?'}.`,
    tasks: followTask.task?.id ? [followTask.task.id] : [],
  });

  // Record activity
  pushActivity('dispatch', annotateDispatch({
    prompt: promptText,
    classification,
    mode: 'auto',
    route: `tandem: ${lead} → ${follow}`,
    agent: lead,
  }), { agent: lead, taskId: leadTask.task?.id });

  return {
    tasks: [leadTask.task, followTask.task].filter(Boolean),
    handoffs: [leadHandoff.handoff, followHandoff.handoff].filter(Boolean),
    lead,
    follow,
  };
}

/**
 * Spawn a child process asynchronously, collecting stdout/stderr.
 * Unlike spawnSync, this does NOT block the event loop, so status bar
 * polling and redraws continue while the subprocess runs.
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} [opts]
 * @param {Function} [onProgress] - Called with parsed JSON progress markers from stderr
 */
function spawnAsync(cmd, args, opts = {}, onProgress = null) {
  return new Promise((resolve) => {
    const chunks = { stdout: [], stderr: [] };
    let stderrBuf = '';
    const invocation = rewriteNodeInvocation(cmd, args, HYDRA_ROOT);
    const child = spawn(invocation.command, invocation.args, {
      cwd: opts.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => chunks.stdout.push(d));
    child.stderr.on('data', (d) => {
      chunks.stderr.push(d);
      if (onProgress) {
        stderrBuf += d;
        const lines = stderrBuf.split('\n');
        stderrBuf = lines.pop(); // keep incomplete last line
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed[0] !== '{') continue;
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed.type === 'council_phase') onProgress(parsed);
          } catch { /* not a progress marker */ }
        }
      }
    });
    child.on('error', (err) => {
      resolve({ status: 1, stdout: '', stderr: err.message });
    });
    child.on('close', (code) => {
      resolve({
        status: code ?? 1,
        stdout: chunks.stdout.join(''),
        stderr: chunks.stderr.join(''),
      });
    });
  });
}

async function runCouncilPrompt({ baseUrl, promptText, rounds = 2, preview = false, onProgress = null, agents = null }) {
  const councilScript = path.join(HYDRA_ROOT, 'lib', 'hydra-council.mjs');
  const councilTimeoutMs = config.routing?.councilTimeoutMs ?? 420_000;
  const args = [councilScript, `prompt=${promptText}`, `url=${baseUrl}`, `rounds=${rounds}`, `timeoutMs=${councilTimeoutMs}`];
  if (preview) {
    args.push('mode=preview', 'publish=false');
  } else {
    args.push('publish=true');
  }
  if (agents && agents.length > 0) {
    args.push(`agents=${agents.join(',')}`);
  }

  const result = await spawnAsync('node', args, { cwd: config.projectRoot }, onProgress);

  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

async function runCouncilJson({ baseUrl, promptText, rounds = 1, preview = false, publish = false, onProgress = null, agents = null }) {
  const councilScript = path.join(HYDRA_ROOT, 'lib', 'hydra-council.mjs');
  const councilTimeoutMs = config.routing?.councilTimeoutMs ?? 420_000;
  const args = [
    councilScript,
    `prompt=${promptText}`,
    `url=${baseUrl}`,
    `rounds=${rounds}`,
    `timeoutMs=${councilTimeoutMs}`,
    'emit=json',
    'save=false',
    `publish=${publish ? 'true' : 'false'}`,
  ];
  if (preview) {
    args.push('mode=preview', 'publish=false');
  }
  if (agents && agents.length > 0) {
    args.push(`agents=${agents.join(',')}`);
  }

  const result = await spawnAsync('node', args, { cwd: config.projectRoot }, onProgress);

  if (result.status !== 0) {
    return {
      ok: false,
      status: result.status,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      report: null,
    };
  }

  try {
    const parsed = JSON.parse(result.stdout || '{}');
    return {
      ok: true,
      status: result.status,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      report: parsed.report || null,
    };
  } catch (error) {
    return {
      ok: false,
      status: result.status,
      stdout: result.stdout || '',
      stderr: `Failed to parse council JSON: ${error.message}`,
      report: null,
    };
  }
}

async function runAutoPrompt({ baseUrl, from, agents, promptText, miniRounds, councilRounds, preview, onProgress = null }) {
  // Classify locally — zero agent calls
  const classification = classifyPrompt(promptText);
  const routingConfig = config.routing || {};

  // Re-resolve route strategy with agent filter
  let { routeStrategy } = classification;
  let tandemPair = classification.tandemPair;
  if (routeStrategy === 'tandem' && agents && agents.length > 0) {
    tandemPair = selectTandemPair(classification.taskType, classification.suggestedAgent, agents);
    if (!tandemPair) routeStrategy = 'single';
  }
  if (routeStrategy === 'tandem' && routingConfig.tandemEnabled === false) {
    routeStrategy = 'single';
  }

  // Legacy triage toggle: fall through to old mini-round path
  if (routingConfig.useLegacyTriage && routeStrategy !== 'single') {
    return runAutoPromptLegacy({ baseUrl, from, agents, promptText, miniRounds, councilRounds, preview, onProgress, classification });
  }

  // ── Single route (fast-path) ──
  if (routeStrategy === 'single') {
    if (preview) {
      return { mode: 'fast-path', recommended: 'handoff', route: `fast-path → ${classification.suggestedAgent}`, classification, triage: null, published: null, escalatedToCouncil: false };
    }
    const published = await publishFastPathDelegation({ baseUrl, from, promptText, classification, agents });
    return {
      mode: 'fast-path',
      recommended: 'handoff',
      route: `fast-path → ${published.agent} (${classification.taskType}, ${classification.confidence} confidence)`,
      classification,
      triage: null,
      published: { tasks: [published.task], handoffs: [published.handoff] },
      escalatedToCouncil: false,
    };
  }

  // ── Tandem route (2 agents, 0 CLI calls) ──
  if (routeStrategy === 'tandem') {
    if (preview) {
      const pair = tandemPair || { lead: 'claude', follow: 'codex' };
      return { mode: 'tandem', recommended: 'tandem', route: `tandem: ${pair.lead} → ${pair.follow}`, classification, triage: null, published: null, escalatedToCouncil: false };
    }
    const published = await publishTandemDelegation({ baseUrl, from, promptText, classification, agents });
    const pair = published.lead ? { lead: published.lead, follow: published.follow } : (tandemPair || { lead: '?', follow: '?' });
    return {
      mode: 'tandem',
      recommended: 'tandem',
      route: `tandem: ${pair.lead} → ${pair.follow} (${classification.taskType})`,
      classification,
      triage: null,
      published: { tasks: published.tasks, handoffs: published.handoffs },
      escalatedToCouncil: false,
    };
  }

  // ── Council route (skip mini-round triage, go directly) ──
  let spec = null;
  try {
    spec = await generateSpec(promptText, null, { cwd: config.projectRoot });
  } catch { /* non-critical */ }

  if (preview) {
    return { mode: 'council', recommended: 'council', route: 'council (complex prompt)', classification, triage: null, published: null, escalatedToCouncil: true, spec: spec ? { specId: spec.specId, specPath: spec.specPath } : null };
  }

  const council = await runCouncilPrompt({
    baseUrl,
    promptText,
    rounds: councilRounds,
    preview: false,
    onProgress,
    agents,
  });
  if (!council.ok) {
    throw new Error(council.stderr || council.stdout || `Council exited with status ${council.status}`);
  }

  let verification = null;
  if (shouldCrossVerify(classification) && council.stdout) {
    verification = await runCrossVerification('claude', council.stdout.trim(), promptText, spec?.specContent);
  }

  return {
    mode: 'council',
    recommended: 'council',
    route: 'council (complex prompt)',
    classification,
    triage: null,
    published: null,
    escalatedToCouncil: true,
    councilOutput: council.stdout.trim(),
    spec: spec ? { specId: spec.specId, specPath: spec.specPath } : null,
    verification,
  };
}

/**
 * Legacy auto prompt path: uses mini-round triage (4 agent calls).
 * Retained behind `routing.useLegacyTriage` config toggle.
 */
async function runAutoPromptLegacy({ baseUrl, from, agents, promptText, miniRounds, councilRounds, preview, onProgress, classification }) {
  const triage = await runCouncilJson({
    baseUrl,
    promptText,
    rounds: miniRounds,
    preview,
    publish: false,
    onProgress,
    agents,
  });

  if (!triage.ok || !triage.report) {
    throw new Error(triage.stderr || triage.stdout || `Mini-round exited with status ${triage.status}`);
  }

  const recommended = String(triage.report.recommendedMode || 'handoff').toLowerCase();
  if (preview) {
    return {
      mode: 'preview',
      recommended,
      route: classification.tier === 'complex' ? 'council (complex prompt)' : 'mini-round triage → preview',
      classification,
      triage: triage.report,
      published: null,
      escalatedToCouncil: recommended === 'council',
    };
  }

  let spec = null;
  if (classification.tier === 'complex') {
    try { spec = await generateSpec(promptText, null, { cwd: config.projectRoot }); } catch { /* non-critical */ }
  }

  if (recommended === 'council' || classification.tier === 'complex') {
    const council = await runCouncilPrompt({ baseUrl, promptText, rounds: councilRounds, preview: false, onProgress, agents });
    if (!council.ok) throw new Error(council.stderr || council.stdout || `Council exited with status ${council.status}`);
    let verification = null;
    if (shouldCrossVerify(classification) && council.stdout) {
      verification = await runCrossVerification('claude', council.stdout.trim(), promptText, spec?.specContent);
    }
    return { mode: 'council', recommended, route: 'council (escalated)', classification, triage: triage.report, published: null, escalatedToCouncil: true, councilOutput: council.stdout.trim(), spec: spec ? { specId: spec.specId, specPath: spec.specPath } : null, verification };
  }

  const published = await publishMiniRoundDelegation({ baseUrl, from, agents, promptText, report: triage.report });
  return { mode: 'handoff', recommended, route: 'mini-round triage → delegated', classification, triage: triage.report, published, escalatedToCouncil: false };
}

// ── Smart Mode: auto-select model tier per prompt ───────────────────────────

const SMART_TIER_MAP = {
  simple: 'economy',
  medium: 'balanced',
  complex: 'performance',
};

async function runSmartPrompt({ baseUrl, from, agents, promptText, miniRounds, councilRounds, preview, onProgress = null }) {
  const classification = classifyPrompt(promptText);
  const targetMode = SMART_TIER_MAP[classification.tier] || 'balanced';

  // Save current mode to restore after dispatch
  const previousMode = getMode();

  try {
    // Temporarily switch to the tier-appropriate model preset
    setMode(targetMode);
  } catch {
    // If targetMode doesn't exist in modeTiers, fall through to auto
  }

  try {
    const result = await runAutoPrompt({
      baseUrl,
      from,
      agents,
      promptText,
      miniRounds,
      councilRounds,
      preview,
      onProgress,
    });

    // Annotate result with smart routing info
    result.smartTier = classification.tier;
    result.smartMode = targetMode;
    result.route = `${classification.tier}\u2192${result.route}`;

    // Update status bar dispatch info
    setLastDispatch({
      route: `${classification.tier}\u2192${result.mode === 'fast-path' ? (result.published?.handoffs?.[0]?.to || classification.suggestedAgent || 'agent') : result.mode}`,
      tier: classification.tier,
      agent: result.mode === 'fast-path' ? (classification.suggestedAgent || '') : '',
      mode: 'smart',
    });

    return result;
  } finally {
    // Restore previous mode
    try {
      setMode(previousMode);
    } catch { /* ignore */ }
  }
}

async function printStatus(baseUrl, agents) {
  const summary = await request('GET', baseUrl, '/summary');
  const agentNextMap = {};
  for (const agent of agents) {
    try {
      const next = await request('GET', baseUrl, `/next?agent=${encodeURIComponent(agent)}`);
      agentNextMap[agent] = next.next;
    } catch { agentNextMap[agent] = { action: 'unknown' }; }
  }
  console.log('');
  console.log(renderDashboard(summary.summary, agentNextMap));
  printNextSteps({ agentSuggestions: agentNextMap, summary: summary.summary });
  return summary.summary;
}

/**
 * Print actionable suggested next steps based on current daemon state.
 * Shows concrete commands the user can type at the hydra> prompt.
 */
function printNextSteps({ agentSuggestions, pendingHandoffs, staleTasks, inProgressTasks, summary } = {}) {
  const steps = [];

  // Derive counts from summary if available
  const openTasks = summary?.openTasks ?? 0;
  const handoffCount = pendingHandoffs?.length ?? summary?.pendingHandoffs ?? 0;
  const staleCount = staleTasks?.length ?? 0;
  const inProgressCount = inProgressTasks?.length ?? 0;
  const hasPendingWork = handoffCount > 0 || staleCount > 0 || inProgressCount > 0;

  // If there's pending work that needs resuming
  if (hasPendingWork) {
    const parts = [];
    if (handoffCount > 0) parts.push(`${handoffCount} handoff${handoffCount > 1 ? 's' : ''}`);
    if (staleCount > 0) parts.push(`${staleCount} stale`);
    if (inProgressCount > 0) parts.push(`${inProgressCount} in progress`);
    steps.push(`${ACCENT(':resume')}    ${DIM(`Ack handoffs & launch agents (${parts.join(', ')})`)}`);
  }

  // If there are open tasks but agents are idle, suggest status check
  if (openTasks > 0 && !hasPendingWork) {
    steps.push(`${ACCENT(':status')}    ${DIM(`Review ${openTasks} open task${openTasks > 1 ? 's' : ''}`)}`);
  }

  // Always offer dispatching new work
  if (openTasks === 0 && !hasPendingWork) {
    steps.push(`${ACCENT('<your objective>')}  ${DIM('Type a prompt to dispatch work to agents')}`);
    steps.push(`${ACCENT(':mode council')}     ${DIM('Switch to council mode for complex objectives')}`);
  } else {
    steps.push(`${ACCENT('<your objective>')}  ${DIM('Dispatch additional work to agents')}`);
  }

  if (steps.length > 0) {
    console.log(sectionHeader('Try next'));
    for (const step of steps.slice(0, 4)) {
      console.log(`  ${DIM('>')} ${step}`);
    }
  }
}

function printHelp() {
  console.log('');
  console.log(hydraLogoCompact());
  console.log(DIM('  Operator Console'));
  console.log('');
  console.log(pc.bold('Interactive commands:'));
  console.log(`  ${ACCENT(':help')}                 Show help`);
  console.log(`  ${ACCENT(':status')}               Dashboard with agents & tasks`);
  console.log(`  ${ACCENT(':sitrep')}               AI-narrated situation report`);
  console.log(`  ${ACCENT(':self')}                 Hydra self snapshot (models, config, runtime)`);
  console.log(`  ${ACCENT(':aware')}                Hyper-awareness toggle (self snapshot/index injection)`);
  console.log(`  ${ACCENT(':mode auto')}            Mini-round triage then delegate/escalate`);
  console.log(`  ${ACCENT(':mode smart')}           Auto-select model tier per prompt complexity`);
  console.log(`  ${ACCENT(':mode handoff')}         Direct handoffs (fast, no triage)`);
  console.log(`  ${ACCENT(':mode council')}         Full council deliberation`);
  console.log(`  ${ACCENT(':mode dispatch')}        Headless pipeline (Claude\u2192Gemini\u2192Codex)`);
  console.log(`  ${ACCENT(':mode economy')}         Set routing mode (economy|balanced|performance)`);
  console.log(`  ${ACCENT(':model')}                Show mode & active models`);
  console.log(`  ${ACCENT(':model mode=economy')} Switch global mode`);
  console.log(`  ${ACCENT(':model claude=sonnet')} Override agent model`);
  console.log(`  ${ACCENT(':model reset')}         Clear all overrides`);
  console.log(`  ${ACCENT(':model:select')}         Interactive model picker`);
  console.log(`  ${ACCENT(':roles')}                Show role→agent→model mapping & recommendations`);
  console.log(`  ${ACCENT(':roster')}               Edit role→agent→model assignments interactively`);
  console.log(`  ${ACCENT(':persona')}              Edit personality settings interactively`);
  console.log(`  ${ACCENT(':persona show')}         Show current personality config`);
  console.log(`  ${ACCENT(':persona <preset>')}     Apply preset (default/professional/casual/analytical/terse)`);
  console.log(`  ${ACCENT(':usage')}                Token usage & contingencies`);
  console.log(`  ${ACCENT(':stats')}                Agent metrics & performance`);
  console.log(`  ${ACCENT(':resume')}               Scan all resumable state (daemon, evolve, branches)`);
  console.log(`  ${ACCENT(':pause [reason]')}       Pause the active session`);
  console.log(`  ${ACCENT(':unpause')}              Resume a paused session`);
  console.log(`  ${ACCENT(':fork')}                 Fork current session (explore alternatives)`);
  console.log(`  ${ACCENT(':spawn <focus>')}       Spawn child session (fresh context)`);
  console.log('');
  console.log(pc.bold('Task & handoff management:'));
  console.log(`  ${ACCENT(':tasks')}                List active daemon tasks`);
  console.log(`  ${ACCENT(':tasks scan')}           Scan codebase for TODO/FIXME/issues`);
  console.log(`  ${ACCENT(':tasks run')}            Launch autonomous tasks runner`);
  console.log(`  ${ACCENT(':tasks review')}         Interactive branch review & merge`);
  console.log(`  ${ACCENT(':tasks status')}         Show latest tasks run report`);
  console.log(`  ${ACCENT(':tasks clean')}          Delete all tasks/* branches`);
  console.log(`  ${ACCENT(':handoffs')}             List pending & recent handoffs`);
  console.log(`  ${ACCENT(':cancel <id>')}          Cancel a task (e.g. :cancel T003)`);
  console.log(`  ${ACCENT(':clear')}                Interactive menu to select clear target`);
  console.log(`  ${ACCENT(':clear all')}            Cancel all tasks & ack all handoffs`);
  console.log(`  ${ACCENT(':clear tasks')}          Cancel all open tasks`);
  console.log(`  ${ACCENT(':clear handoffs')}       Ack all pending handoffs`);
  console.log(`  ${ACCENT(':clear concierge')}      Clear conversation history`);
  console.log(`  ${ACCENT(':clear metrics')}        Reset session metrics`);
  console.log(`  ${ACCENT(':clear screen')}         Clear terminal`);
  console.log(`  ${ACCENT(':archive')}              Archive completed work & trim events`);
  console.log(`  ${ACCENT(':events')}               Show recent event log`);
  console.log('');
  console.log(pc.bold('Workers:'));
  console.log(`  ${ACCENT(':workers')}              Show worker status (running/idle/stopped)`);
  console.log(`  ${ACCENT(':workers start [agent]')} Start worker(s)`);
  console.log(`  ${ACCENT(':workers stop [agent]')}  Stop worker(s)`);
  console.log(`  ${ACCENT(':workers restart')}      Restart all workers`);
  console.log(`  ${ACCENT(':workers mode <mode>')}  Change permission mode (auto-edit/full-auto)`);
  console.log(`  ${ACCENT(':watch <agent>')}        Open visible terminal for agent observation`);
  console.log('');
  console.log(pc.bold('Concierge (conversational AI):'));
  console.log(`  ${ACCENT(':chat')}                 Toggle concierge on/off`);
  console.log(`  ${ACCENT(':chat off')}             Disable concierge`);
  console.log(`  ${ACCENT(':chat reset')}           Clear conversation history`);
  console.log(`  ${ACCENT(':chat stats')}           Show token usage`);
  console.log(`  ${ACCENT(':chat model')}           Show active model & fallback chain`);
  console.log(`  ${ACCENT(':chat model <name>')}    Switch model (e.g. sonnet, flash, opus)`);
  console.log(`  ${ACCENT(':chat export')}          Export conversation to file`);
  console.log(`  ${ACCENT('!<prompt>')}             Force dispatch (bypass concierge)`);
  console.log('');
  console.log(pc.bold('Evolve (autonomous self-improvement):'));
  console.log(`  ${ACCENT(':evolve')}               Launch evolve session (research\u2192plan\u2192test\u2192implement)`);
  console.log(`  ${ACCENT(':evolve focus=<area>')}  Focus on specific area (e.g. testing-reliability)`);
  console.log(`  ${ACCENT(':evolve max-rounds=N')} Limit rounds (default: 3)`);
  console.log(`  ${ACCENT(':evolve status')}        Show latest evolve session report`);
  console.log(`  ${ACCENT(':evolve resume')}        Resume an incomplete/interrupted session`);
  console.log(`  ${ACCENT(':evolve knowledge')}     Browse accumulated knowledge base`);
  console.log('');
  console.log(pc.bold('Actualize (experimental self-actualization):'));
  console.log(`  ${ACCENT(':actualize')}            Launch actualize run (branches only, no auto-merge)`);
  console.log(`  ${ACCENT(':actualize dry-run')}    Scan + discover + prioritize without executing`);
  console.log(`  ${ACCENT(':actualize review')}     Interactive branch review & merge`);
  console.log(`  ${ACCENT(':actualize status')}     Show latest actualize run report`);
  console.log(`  ${ACCENT(':actualize clean')}      Delete all actualize/* branches`);
  console.log('');
  console.log(pc.bold('Nightly (autonomous overnight tasks):'));
  console.log(`  ${ACCENT(':nightly')}              Launch nightly run (interactive setup)`);
  console.log(`  ${ACCENT(':nightly dry-run')}      Scan & prioritize without executing`);
  console.log(`  ${ACCENT(':nightly review')}       Interactive branch review & merge`);
  console.log(`  ${ACCENT(':nightly status')}       Show latest nightly run report`);
  console.log(`  ${ACCENT(':nightly clean')}        Delete all nightly/* branches`);
  console.log('');
  console.log(pc.bold('GitHub (requires gh CLI):'));
  console.log(`  ${ACCENT(':github')}               GitHub status (gh installed, auth, repo, PRs)`);
  console.log(`  ${ACCENT(':github prs')}           List open pull requests`);
  console.log(`  ${ACCENT(':pr create [branch]')}   Push branch & create pull request`);
  console.log(`  ${ACCENT(':pr list')}              List open pull requests`);
  console.log(`  ${ACCENT(':pr view <number>')}     Show PR details`);
  console.log('');
  console.log(pc.bold('Agent Forge (create custom agents):'));
  console.log(`  ${ACCENT(':forge')}                Interactive agent creation wizard`);
  console.log(`  ${ACCENT(':forge <description>')} Start forge with a goal description`);
  console.log(`  ${ACCENT(':forge list')}           List all forged agents`);
  console.log(`  ${ACCENT(':forge info <name>')}    Show forge details + metadata`);
  console.log(`  ${ACCENT(':forge test <name>')}    Test an existing forged agent`);
  console.log(`  ${ACCENT(':forge delete <name>')}  Remove a forged agent`);
  console.log(`  ${ACCENT(':forge edit <name>')}    Re-run refinement on an existing agent`);
  console.log('');
  console.log(pc.bold('Agents & diagnostics:'));
  console.log(`  ${ACCENT(':agents')}               List all registered agents`);
  console.log(`  ${ACCENT(':agents add')}            Register a new custom agent (CLI or API)`);
  console.log(`  ${ACCENT(':agents remove <name>')}  Remove a custom agent`);
  console.log(`  ${ACCENT(':agents test <name>')}    Send a test prompt to verify agent works`);
  console.log(`  ${ACCENT(':agents info <name>')}   Show agent details & config`);
  console.log(`  ${ACCENT(':doctor')}               Diagnostic stats & recent log entries`);
  console.log(`  ${ACCENT(':doctor log')}           Show last 25 diagnostic entries`);
  console.log(`  ${ACCENT(':doctor fix')}           Auto-detect and fix issues`);
  console.log(`  ${ACCENT(':doctor diagnose <text>')} Investigate a failure via GPT-5.3`);
  console.log(`  ${ACCENT(':kb')}                   Knowledge base stats & recent entries`);
  console.log(`  ${ACCENT(':kb <query>')}           Search knowledge base entries`);
  console.log(`  ${ACCENT(':cleanup')}              Scan & clean stale branches, tasks, artifacts`);
  console.log('');
  console.log(pc.bold('System:'));
  console.log(`  ${ACCENT(':sync')}                 Sync HYDRA.md → agent instruction files`);
  console.log(`  ${ACCENT(':confirm')}              Show/toggle dispatch confirmations`);
  console.log(`  ${ACCENT(':dry-run')}              Toggle dry-run mode (preview only, no tasks created)`);
  console.log(`  ${ACCENT(':shutdown')}             Stop the daemon`);
  console.log(`  ${ACCENT(':quit')}                 Exit operator console  ${DIM('(alias: :exit)')}`);
  console.log(`  ${DIM('<any text>')}             Dispatch as shared prompt`);
  console.log('');
  console.log(pc.bold('One-shot mode:'));
  console.log(DIM('  npm run hydra:go -- prompt="Your objective"'));
  console.log(DIM('  npm run hydra:go -- mode=council prompt="Your objective"'));
  console.log('');
}

// ── Fuzzy Command Matching ─────────────────────────────────────────────────

const KNOWN_COMMANDS = [
  ':help', ':status', ':sitrep', ':self', ':aware', ':mode', ':model', ':usage', ':stats', ':resume',
  ':pause', ':unpause', ':fork', ':spawn', ':tasks', ':handoffs', ':cancel',
  ':clear', ':archive', ':events', ':workers', ':watch', ':chat', ':evolve', ':nightly',
  ':actualize',
  ':github', ':pr', ':forge', ':confirm', ':dry-run', ':roster', ':persona', ':doctor', ':kb', ':agents', ':cleanup',
  ':shutdown', ':quit', ':exit', ':sync',
];

// ── Per-Command Help (shown via `:command ?`) ─────────────────────────────
const COMMAND_HELP = {
  ':help':     { usage: [':help'], desc: 'Show full help' },
  ':status':   { usage: [':status'], desc: 'Dashboard with agents & tasks' },
  ':sitrep':   { usage: [':sitrep'], desc: 'AI-narrated situation report' },
  ':self':     { usage: [':self', ':self json'], desc: 'Hydra self snapshot (models, config, runtime state)' },
  ':aware':    { usage: [':aware', ':aware status', ':aware on|off', ':aware minimal|full'], desc: 'Hyper-awareness injection (self snapshot/index) for concierge prompts' },
  ':mode':     { usage: [':mode', ':mode auto|smart|handoff|council|dispatch'], desc: 'Show or switch orchestration mode' },
  ':model':    { usage: [':model', ':model mode=economy|balanced|performance', ':model <agent>=<model>', ':model <agent>=default', ':model reset'], desc: 'Show or change active models' },
  ':model:select': { usage: [':model:select', ':model:select [agent]'], desc: 'Interactive model picker' },
  ':roles':    { usage: [':roles'], desc: 'Show role\u2192agent\u2192model mapping & recommendations' },
  ':roster':   { usage: [':roster'], desc: 'Interactive role\u2192agent\u2192model editor' },
  ':persona':  { usage: [':persona', ':persona show', ':persona on|off', ':persona <preset>'], desc: 'Personality settings (presets: default/professional/casual/analytical/terse)' },
  ':usage':    { usage: [':usage'], desc: 'Token usage & budget' },
  ':stats':    { usage: [':stats'], desc: 'Agent metrics & performance' },
  ':resume':   { usage: [':resume'], desc: 'Scan all resumable state (daemon, evolve, branches)' },
  ':pause':    { usage: [':pause', ':pause [reason]'], desc: 'Pause the active session' },
  ':unpause':  { usage: [':unpause'], desc: 'Resume a paused session' },
  ':fork':     { usage: [':fork', ':fork [reason]'], desc: 'Fork current session' },
  ':spawn':    { usage: [':spawn <focus>'], desc: 'Spawn child session with focus area' },
  ':tasks':    { usage: [':tasks', ':tasks scan', ':tasks run [args]', ':tasks review', ':tasks status', ':tasks clean'], desc: 'Task management & autonomous runner' },
  ':handoffs': { usage: [':handoffs'], desc: 'List pending & recent handoffs' },
  ':cancel':   { usage: [':cancel <id>'], desc: 'Cancel a task (e.g. :cancel T003)' },
  ':clear':    { usage: [':clear', ':clear all', ':clear tasks', ':clear handoffs', ':clear concierge', ':clear metrics', ':clear screen'], desc: 'Clear/reset various state' },
  ':archive':  { usage: [':archive'], desc: 'Archive completed work & trim events' },
  ':events':   { usage: [':events'], desc: 'Show recent event log' },
  ':workers':  { usage: [':workers', ':workers start [agent]', ':workers stop [agent]', ':workers restart [agent]', ':workers mode auto-edit|full-auto'], desc: 'Worker management' },
  ':watch':    { usage: [':watch <agent>'], desc: 'Open visible terminal for agent observation' },
  ':chat':     { usage: [':chat', ':chat off', ':chat reset', ':chat stats', ':chat model', ':chat model <name>', ':chat export'], desc: 'Concierge (conversational AI)' },
  ':evolve':   { usage: [':evolve', ':evolve focus=<area>', ':evolve max-rounds=N', ':evolve status', ':evolve resume [args]', ':evolve knowledge'], desc: 'Autonomous self-improvement' },
  ':nightly':  { usage: [':nightly', ':nightly dry-run', ':nightly review', ':nightly status', ':nightly clean'], desc: 'Autonomous overnight tasks' },
  ':actualize': { usage: [':actualize', ':actualize dry-run', ':actualize review', ':actualize status', ':actualize clean'], desc: 'Self-actualization runner (branches only, no auto-merge)' },
  ':github':   { usage: [':github', ':github prs'], desc: 'GitHub status & pull requests' },
  ':pr':       { usage: [':pr create [branch]', ':pr list', ':pr view <number>'], desc: 'Pull request management' },
  ':forge':    { usage: [':forge', ':forge <description>', ':forge list', ':forge info <name>', ':forge test <name>', ':forge delete <name>', ':forge edit <name>'], desc: 'Custom agent creation' },
  ':agents':   { usage: [':agents', ':agents list [virtual|physical|all]', ':agents info <name>', ':agents add', ':agents remove <name>', ':agents test <name>', ':agents enable <name>', ':agents disable <name>'], desc: 'Agent registry management — list, add, remove, test, enable/disable agents' },
  ':doctor':   { usage: [':doctor', ':doctor log', ':doctor fix', ':doctor diagnose <text>'], desc: 'Diagnostics & self-healing' },
  ':kb':       { usage: [':kb', ':kb <query>'], desc: 'Knowledge base stats & search' },
  ':cleanup':  { usage: [':cleanup'], desc: 'Scan & clean stale branches, tasks, artifacts' },
  ':sync':     { usage: [':sync'], desc: 'Sync HYDRA.md \u2192 agent instruction files' },
  ':confirm':  { usage: [':confirm', ':confirm on|off'], desc: 'Show/toggle dispatch confirmations' },
  ':dry-run':  { usage: [':dry-run', ':dry-run on|off'], desc: 'Toggle dry-run mode (preview dispatches without executing)' },
  ':shutdown': { usage: [':shutdown'], desc: 'Stop the daemon' },
  ':quit':     { usage: [':quit'], desc: 'Exit operator console (alias: :exit)' },
  ':exit':     { usage: [':exit'], desc: 'Exit operator console (alias: :quit)' },
};

function printCommandHelp(cmd) {
  const help = COMMAND_HELP[cmd];
  if (!help) {
    console.log(`  ${DIM('No help available for')} ${ACCENT(cmd)}`);
    return;
  }
  console.log('');
  console.log(`  ${ACCENT(cmd)} ${DIM('\u2014')} ${help.desc}`);
  console.log('');
  for (const u of help.usage) {
    console.log(`    ${pc.white(u)}`);
  }
  console.log('');
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => {
    const row = new Array(n + 1);
    row[0] = i;
    return row;
  });
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function fuzzyMatchCommand(input) {
  const normalized = input.toLowerCase().split(/\s/)[0];
  const target = normalized.startsWith(':') ? normalized : `:${normalized}`;
  let best = null;
  let bestDist = 3; // threshold
  for (const cmd of KNOWN_COMMANDS) {
    const dist = levenshtein(target, cmd);
    if (dist < bestDist) {
      bestDist = dist;
      best = cmd;
    }
  }
  return best;
}

// ── Self Awareness (Hyper-Aware Concierge Context) ────────────────────────────

let _selfIndexCache = { block: '', builtAt: 0, key: '' };

function normalizeSimpleCommandText(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseSelfAwarenessPlaintextCommand(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (raw.startsWith(':') || raw.startsWith('!')) return null;
  if (raw.includes('\n')) return null;

  const s = normalizeSimpleCommandText(raw);
  if (!s || s.length > 80) return null;

  const target = '(?:hyper\\s*aware(?:ness)?|self\\s*awareness)';
  const polite = '(?:please\\s+)?(?:can\\s+you\\s+|could\\s+you\\s+|would\\s+you\\s+)?';
  const agentSuffix = '(?:\\s+agent)?';

  if (new RegExp(`^${polite}(?:turn\\s+off|disable)\\s+${target}${agentSuffix}$`).test(s)) return 'off';
  if (new RegExp(`^${polite}${target}${agentSuffix}\\s+off$`).test(s)) return 'off';

  if (new RegExp(`^${polite}(?:turn\\s+on|enable)\\s+${target}${agentSuffix}$`).test(s)) return 'on';
  if (new RegExp(`^${polite}${target}${agentSuffix}\\s+on$`).test(s)) return 'on';

  if (new RegExp(`^${polite}(?:set\\s+)?${target}${agentSuffix}\\s+(?:to\\s+)?minimal$`).test(s)) return 'minimal';
  if (new RegExp(`^${polite}(?:set\\s+)?${target}${agentSuffix}\\s+(?:to\\s+)?full$`).test(s)) return 'full';

  if (new RegExp(`^${polite}${target}${agentSuffix}\\s+status$`).test(s)) return 'status';
  return null;
}

function getSelfAwarenessSummary(sa = {}) {
  const obj = sa && typeof sa === 'object' ? sa : {};
  const enabled = obj.enabled !== false;
  const includeSnapshot = obj.includeSnapshot !== false;
  const includeIndex = obj.includeIndex !== false;
  const level = !enabled ? 'off' : includeIndex ? 'full' : 'minimal';
  return { enabled, includeSnapshot, includeIndex, level };
}

function printSelfAwarenessStatus(sa = {}) {
  const s = getSelfAwarenessSummary(sa);
  const value = s.enabled ? pc.green(s.level) : pc.red('off');
  console.log(label('Hyper-awareness', value));
  console.log(DIM(`  snapshot: ${s.includeSnapshot ? 'on' : 'off'} (maxLines=${sa.snapshotMaxLines ?? 80})`));
  console.log(DIM(`  index: ${s.includeIndex ? 'on' : 'off'} (maxChars=${sa.indexMaxChars ?? 7000}, refreshMs=${sa.indexRefreshMs ?? 300_000})`));
}

async function applySelfAwarenessPatch(patch = {}) {
  const cfg = loadHydraConfig();
  const current = cfg.selfAwareness && typeof cfg.selfAwareness === 'object' ? cfg.selfAwareness : {};
  cfg.selfAwareness = { ...current, ...patch };
  const { saveHydraConfig: save } = await import('./hydra-config.mjs');
  const merged = save(cfg);
  _selfIndexCache = { block: '', builtAt: 0, key: '' };
  return merged.selfAwareness || cfg.selfAwareness;
}

// ── Git Info Cache ────────────────────────────────────────────────────────────

let _gitInfoCache = { data: null, at: 0 };
const GIT_CACHE_TTL = 30_000;

function getGitInfo() {
  const now = Date.now();
  if (_gitInfoCache.data && (now - _gitInfoCache.at) < GIT_CACHE_TTL) {
    return _gitInfoCache.data;
  }
  try {
    const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: config.projectRoot, encoding: 'utf8', timeout: 5000,
    }).stdout.trim();
    const porcelain = spawnSync('git', ['status', '--porcelain'], {
      cwd: config.projectRoot, encoding: 'utf8', timeout: 5000,
    }).stdout.trim();
    const modifiedFiles = porcelain ? porcelain.split('\n').length : 0;
    const info = { branch, modifiedFiles };
    _gitInfoCache = { data: info, at: now };
    return info;
  } catch {
    return null;
  }
}

async function interactiveLoop({
  baseUrl,
  from,
  agents,
  initialMode,
  councilRounds,
  councilPreview,
  autoMiniRounds,
  autoCouncilRounds,
  autoPreview,
  showWelcome,
}) {
  let mode = initialMode;
  let conciergeActive = false;
  let dispatchDepth = 0;   // >0 while a blocking dispatch/council await is in flight
  let sidecaring = false;  // true while a sidecar conciergeTurn is in flight
  let conciergeWelcomeShown = false;
  const cCfg = getConciergeConfig();
  if (cCfg.autoActivate && isConciergeAvailable()) conciergeActive = true;

  // Set daemon base URL for bidirectional concierge events
  setConciergeBaseUrl(baseUrl);

  // Initialize status bar BEFORE welcome so splash renders within the scroll region
  // (scroll region must be set first to prevent content from being overwritten by the status bar)
  initStatusBar(agents);
  setActiveMode(conciergeActive ? 'chat' : mode);

  // Initialize output history ring buffer (captures CLI output for AI context)
  try { const { initOutputHistory } = await import('./hydra-output-history.mjs'); initOutputHistory(); } catch { /* non-critical */ }

  // Fire update check in background — resolves from 24h disk cache on most startups
  const updateCheckPromise = checkForUpdates().catch(() => null);

  if (showWelcome) {
    await printWelcome(baseUrl);
  } else {
    printHelp();
    console.log(label('Mode', ACCENT(mode)));
    console.log('');
  }

  // First-run hint: suggest copying .env.example if no .env and no OPENAI_API_KEY
  if (!envFileExists() && !process.env.OPENAI_API_KEY) {
    console.log(DIM('  Tip: Copy .env.example to .env and add your API keys to get started.'));
    console.log('');
  }

  // Update notice (non-blocking — show if check resolved by now, otherwise skip)
  const updateResult = await Promise.race([
    updateCheckPromise,
    new Promise(r => setTimeout(() => r(null), 0)),
  ]);
  if (updateResult?.hasUpdate) {
    console.log(`  ${pc.yellow('Update available:')} ${DIM(updateResult.localVersion)} → ${pc.bold(pc.yellow(updateResult.remoteVersion))}  ${DIM('git pull origin master')}`);
    console.log('');
  }

  // Wrap ANSI escapes for readline so cursor position is calculated correctly
  const rlSafe = (s) => s.replace(/(\x1b\[[0-9;]*m)/g, '\x01$1\x02');

  function buildConciergePrompt() {
    const modelLabel = getConciergeModelLabel();
    const showModel = cCfg.showProviderInPrompt !== false;
    const modelSuffix = showModel ? `${DIM('[')}${pc.blue(modelLabel)}${DIM(']')}` : '';
    return rlSafe(`${ACCENT('hydra')}${pc.blue('\u2B22')}${modelSuffix}${DIM('>')} `);
  }

  function showConciergeWelcome() {
    if (conciergeWelcomeShown || !cCfg.welcomeMessage) return;
    conciergeWelcomeShown = true;
    const modelLabel = getConciergeModelLabel();
    console.log('');
    console.log(`  ${pc.blue('\u2B22')} Concierge active ${DIM(`(${modelLabel})`)}`);

  }

  const normalPrompt = rlSafe(`${ACCENT('hydra')}${DIM('>')} `);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: conciergeActive ? buildConciergePrompt() : normalPrompt,
  });

  // ── Multi-line paste buffer for concierge ──────────────────────────────────
  // When concierge is active, buffer rapidly-arriving lines (typical of paste)
  // and process them as a single input after a short debounce.
  let _pasteBuffer = [];
  let _pasteTimer = null;
  let _isPastedInput = false;
  const PASTE_DEBOUNCE_MS = 120;

  // Show welcome on first activate
  if (conciergeActive) showConciergeWelcome();

  // ── Ghost Text (greyed-out placeholder, Claude Code CLI style) ────────────
  // Shows dim hint text after the prompt cursor. Disappears on first keystroke.
  // Re-appears on blank line submissions or after command completion.
  // When _acceptableGhostText is set, Tab accepts + submits the ghost text.
  let _ghostCleanup = null;
  let _acceptableGhostText = null;   // Text that Tab would accept+submit
  let _ghostUpgradeAborted = false;  // Set true when user types; prevents async AI upgrade

  const GHOST_HINTS_CONCIERGE = [
    () => `Chat with ${getConciergeModelLabel()} — prefix ! to dispatch`,
    () => 'Ask a question or describe what you need',
    () => `Talking to ${getConciergeModelLabel()} — :chat off to disable`,
    () => 'What would you like to work on?',
  ];
  const GHOST_HINTS_NORMAL = [
    () => 'Describe a task to dispatch to agents',
    () => ':help for commands, or type a prompt',
    () => 'What would you like to work on?',
  ];
  let _ghostIdx = 0;

  function getGhostText() {
    const pool = conciergeActive ? GHOST_HINTS_CONCIERGE : GHOST_HINTS_NORMAL;
    const text = pool[_ghostIdx % pool.length]();
    _ghostIdx++;
    return text;
  }

  /**
   * Show ghost text after the prompt cursor.
   * @param {string} [overrideText] - Custom text instead of cycling hints
   * @param {string} [acceptableText] - If set, Tab will accept+submit this text
   */
  function showGhostAfterPrompt(overrideText, acceptableText) {
    if (!process.stdout.isTTY) return;
    const base = overrideText || getGhostText();
    if (!base) return;

    _acceptableGhostText = acceptableText || null;
    _ghostUpgradeAborted = false;

    // Append [Tab] hint for acceptable ghost text
    const text = _acceptableGhostText ? `${base}  [Tab]` : base;
    const plain = stripAnsi(text);

    // Write dim ghost text, then move cursor back to prompt end
    process.stdout.write(DIM(text));
    if (plain.length > 0) {
      process.stdout.write(`\x1b[${plain.length}D`);
    }
    // One-shot: clear ghost text on first keystroke
    if (_ghostCleanup) {
      process.stdin.removeListener('data', _ghostCleanup);
      _ghostCleanup = null;
    }
    const cleanup = () => {
      process.stdout.write('\x1b[K'); // Erase from cursor to end of line
      _acceptableGhostText = null;
      _ghostUpgradeAborted = true;
      process.stdin.removeListener('data', cleanup);
      if (_ghostCleanup === cleanup) _ghostCleanup = null;
    };
    _ghostCleanup = cleanup;
    process.stdin.on('data', cleanup);
  }

  /**
   * Upgrade displayed ghost text with an AI-generated suggestion.
   * No-op if user has already started typing.
   */
  function upgradeGhostText(newText) {
    if (_ghostUpgradeAborted) return;
    if (!process.stdout.isTTY) return;
    if (rl.line && rl.line.length > 0) {
      _ghostUpgradeAborted = true;
      return;
    }
    // Erase old ghost, write new acceptable ghost
    process.stdout.write('\x1b[K');
    const display = `${newText}  [Tab]`;
    const plain = stripAnsi(display);
    process.stdout.write(DIM(display));
    if (plain.length > 0) {
      process.stdout.write(`\x1b[${plain.length}D`);
    }
    _acceptableGhostText = newText;
  }

  // Wrap rl.prompt to auto-show ghost text on fresh prompts (not refreshes)
  const _origPrompt = rl.prompt.bind(rl);
  rl.prompt = function (preserveCursor) {
    _origPrompt(preserveCursor);
    if (!preserveCursor) {
      showGhostAfterPrompt();
    }
  };

  // ── Tab Interception (accept + submit ghost text) ──────────────────────────
  // Override readline's internal _ttyWrite to intercept Tab when acceptable
  // ghost text is displayed. Standard pattern used by inquirer/ora.
  const _origTtyWrite = rl._ttyWrite.bind(rl);
  rl._ttyWrite = function (s, key) {
    if (key?.name === 'tab' && _acceptableGhostText && (!rl.line || !rl.line.length)) {
      // Clear ghost visual
      process.stdout.write('\x1b[K');
      const text = _acceptableGhostText;
      _acceptableGhostText = null;
      _ghostUpgradeAborted = true;
      // Clean up ghost listener
      if (_ghostCleanup) {
        process.stdin.removeListener('data', _ghostCleanup);
        _ghostCleanup = null;
      }
      // Inject text into readline and submit
      rl.write(text);
      setImmediate(() => rl.write(null, { name: 'return' }));
      return; // swallow the Tab
    }
    _origTtyWrite(s, key);
  };

  // ── Daemon resume helper (extracted for unified :resume) ───────────────────
  async function executeDaemonResume(baseUrl, agents, rl) {
    try {
      const sessionStatus = await request('GET', baseUrl, '/session/status');

      // Unpause if paused
      if (sessionStatus.activeSession?.status === 'paused') {
        try {
          await request('POST', baseUrl, '/session/unpause');
          console.log(`  ${SUCCESS('✓')} Session unpaused`);
        } catch (e) {
          console.log(`  ${WARNING('⚠')} Could not unpause: ${e.message}`);
        }
      }

      // Reset stale tasks
      const stale = sessionStatus.staleTasks || [];
      if (stale.length > 0) {
        console.log('');
        for (const t of stale) {
          try {
            await request('POST', baseUrl, '/task/update', { taskId: t.id, status: 'todo' });
            const mins = Math.round((Date.now() - new Date(t.updatedAt).getTime()) / 60_000);
            console.log(`  ${WARNING('↻')} ${pc.white(t.id)} ${colorAgent(t.owner)} reset to todo ${DIM(`(was stale ${mins}m)`)}`);
          } catch { /* skip */ }
        }
      }

      // Ack pending handoffs
      const handoffs = sessionStatus.pendingHandoffs || [];
      const agentsToLaunch = new Set();
      if (handoffs.length > 0) {
        console.log('');
        for (const h of handoffs) {
          const targetAgent = String(h.to || '').toLowerCase();
          try {
            await request('POST', baseUrl, '/handoff/ack', { handoffId: h.id, agent: targetAgent });
            console.log(`  ${SUCCESS('✓')} ${pc.white(h.id)} ${colorAgent(h.from)}→${colorAgent(h.to)} acknowledged`);
            if (targetAgent) agentsToLaunch.add(targetAgent);
          } catch (e) {
            console.log(`  ${ERROR('✗')} ${pc.white(h.id)} ${e.message}`);
          }
        }
      }

      // Collect in-progress agent owners
      for (const t of (sessionStatus.inProgressTasks || [])) {
        const owner = String(t.owner || '').toLowerCase();
        if (owner) agentsToLaunch.add(owner);
      }

      // Agent suggestions
      for (const [agent, suggestion] of Object.entries(sessionStatus.agentSuggestions || {})) {
        if (suggestion?.action && suggestion.action !== 'idle' && suggestion.action !== 'unknown') {
          agentsToLaunch.add(agent);
        }
      }

      // Launch workers
      const launchList = [...agentsToLaunch].filter((a) => agents.includes(a));
      if (launchList.length > 0) {
        console.log('');
        startAgentWorkers(launchList, baseUrl, { rl });
      }

      // Summary
      const actions = [];
      if (stale.length > 0) actions.push(`${stale.length} stale task${stale.length > 1 ? 's' : ''} reset`);
      if (handoffs.length > 0) actions.push(`${handoffs.length} handoff${handoffs.length > 1 ? 's' : ''} acked`);
      if (launchList.length > 0) actions.push(`${launchList.length} agent${launchList.length > 1 ? 's' : ''} launched`);
      if (actions.length > 0) {
        console.log('');
        console.log(`  ${SUCCESS('✓')} ${actions.join(', ')}`);
      }
    } catch (e) {
      console.log(`  ${ERROR(e.message)}`);
    }
  }

  startEventStream(baseUrl, agents);

  const workerCfg = loadHydraConfig().workers || {};
  if (workerCfg.autoStart) {
    startAgentWorkers(agents, baseUrl, { rl });
  }

  // Subscribe to significant activity events and show them inline
  onActivityEvent(({ event, agent, detail }) => {
    const significant = ['handoff_ack', 'task_done', 'verify'];
    if (!significant.includes(event)) return;
    const prefix = event === 'verify' ? WARNING('\u2691') : SUCCESS('\u2713');
    const msg = `  ${prefix} ${DIM(event.replace(/_/g, ' '))}${agent ? ` ${colorAgent(agent)}` : ''} ${DIM(detail || '')}`;
    // Clear current prompt line, print event, re-show prompt
    process.stdout.write(`\r\x1b[2K${msg}\n`);
    // Don't flash normal prompt while a choice selection is active
    if (!isChoiceActive()) {
      rl.prompt(true);
    }
  });

  rl.prompt();

  rl.on('line', async (lineRaw) => {
    const line = String(lineRaw || '').trim();

    // ── Paste buffering: collect rapid-fire lines while buffer is active ────
    if (_pasteTimer !== null) {
      _pasteBuffer.push(line);
      clearTimeout(_pasteTimer);
      _pasteTimer = setTimeout(() => {
        const fullInput = _pasteBuffer.join('\n').trim();
        _pasteBuffer = [];
        _pasteTimer = null;
        if (fullInput) {
          _isPastedInput = true;
          rl.emit('line', fullInput);
        } else {
          rl.prompt();
        }
      }, PASTE_DEBOUNCE_MS);
      return;
    }

    // ── Universal paste detection: non-command input waits briefly for more lines ──
    // Commands (:foo) execute immediately; all other input is buffered so that a
    // multi-line paste is collected into one submission regardless of mode.
    if (!_isPastedInput && line && !line.startsWith(':') && !isChoiceActive()) {
      _pasteBuffer = [line];
      _pasteTimer = setTimeout(() => {
        const fullInput = _pasteBuffer.join('\n').trim();
        _pasteBuffer = [];
        _pasteTimer = null;
        if (fullInput) {
          _isPastedInput = true;
          rl.emit('line', fullInput);
        } else {
          rl.prompt();
        }
      }, PASTE_DEBOUNCE_MS);
      return;
    }
    _isPastedInput = false;

    try {
      if (!line) {
        rl.prompt();
        return;
      }
      if (line === ':quit' || line === ':exit') {
        rl.close();
        return;
      }

      // ── Plaintext hyper-awareness toggles (explicit user intent) ───────────
      const awarePlain = parseSelfAwarenessPlaintextCommand(line);
      if (awarePlain) {
        const cfg = loadHydraConfig();
        if (awarePlain === 'status') {
          printSelfAwarenessStatus(cfg.selfAwareness);
          console.log('');
          rl.prompt();
          return;
        }
        if (awarePlain === 'off') {
          await applySelfAwarenessPatch({ enabled: false });
        } else if (awarePlain === 'on') {
          await applySelfAwarenessPatch({ enabled: true });
        } else if (awarePlain === 'minimal') {
          await applySelfAwarenessPatch({ enabled: true, includeSnapshot: true, includeIndex: false });
        } else if (awarePlain === 'full') {
          await applySelfAwarenessPatch({ enabled: true, includeSnapshot: true, includeIndex: true });
        }
        const next = loadHydraConfig();
        printSelfAwarenessStatus(next.selfAwareness);
        console.log('');
        rl.prompt();
        return;
      }

      // ── Command help via `?` suffix (e.g. `:model ?`) ──────────────────
      if (line.startsWith(':') && line.endsWith('?')) {
        const cmdPart = line.slice(0, -1).trim();
        // Try exact match, then base command (e.g. `:tasks scan ?` → `:tasks`)
        const cmd = COMMAND_HELP[cmdPart] ? cmdPart : cmdPart.split(/\s/)[0];
        printCommandHelp(cmd);
        rl.prompt();
        return;
      }

      if (line === ':help') {
        printHelp();
        rl.prompt();
        return;
      }
      if (line === ':status') {
        const summary = await printStatus(baseUrl, agents);

        // Smart ghost: nudge about blocked tasks
        const blockedTasks = (summary?.openTasks || []).filter(
          (t) => t.status === 'blocked' || (t.pendingDependencies && t.pendingDependencies.length > 0)
        );

        if (blockedTasks.length > 0 && !isChoiceActive()) {
          // Phase 1: Deterministic ghost (immediate)
          const first = blockedTasks[0];
          const deps = (first.pendingDependencies || first.blockedBy || []).join(', ');
          const deterministicHint = blockedTasks.length === 1
            ? `Investigate why ${first.id} is blocked${deps ? ` (waiting on ${deps})` : ''}`
            : `Investigate ${blockedTasks.length} blocked tasks: ${blockedTasks.map((t) => t.id).join(', ')}`;

          _origPrompt();
          showGhostAfterPrompt(deterministicHint, deterministicHint);

          // Phase 2: AI upgrade (async, non-blocking)
          if (conciergeActive && isConciergeAvailable()) {
            const contextDesc = blockedTasks.map((t) =>
              `Task ${t.id} "${(t.title || 'untitled').slice(0, 60)}" is blocked, waiting on: ${(t.pendingDependencies || []).join(', ') || 'unknown'}`
            ).join('. ');
            conciergeSuggest(
              `The user just ran :status and sees ${blockedTasks.length} blocked task(s). ${contextDesc}. Suggest a single actionable prompt they could type to investigate or resolve the blockage.`
            ).then((result) => {
              if (result?.suggestion) upgradeGhostText(result.suggestion);
            }).catch(() => { /* silent */ });
          }
        } else {
          rl.prompt();
        }
        return;
      }
      if (line === ':sitrep') {
        // Gather supplemental data (each in try/catch)
        let budgetStatus = null;
        try { budgetStatus = checkUsage(); } catch { /* skip */ }
        const gitInfo = getGitInfo();
        let statsData = null;
        try { statsData = await request('GET', baseUrl, '/stats'); } catch { /* skip */ }
        // Recent git log for big-picture context
        let gitLog = null;
        try {
          const logResult = spawnSync('git', ['log', '--oneline', '-n', '10', '--no-decorate'], {
            cwd: config.projectRoot, encoding: 'utf8', timeout: 5000,
          });
          if (logResult.status === 0 && logResult.stdout.trim()) {
            gitLog = logResult.stdout.trim();
          }
        } catch { /* skip */ }

        // Show spinner if AI is likely available
        const providers = detectAvailableProviders();
        const spinner = providers.length > 0
          ? createSpinner(`${DIM('Generating situation report...')}`, { style: 'stellar' })
          : null;
        if (spinner) spinner.start();

        try {
          const result = await generateSitrep({
            baseUrl,
            workers,
            budgetStatus,
            gitBranch: gitInfo?.branch,
            gitLog,
            statsData,
          });
          if (spinner) spinner.stop();

          if (result.fallback) {
            const reason = result.reason === 'no_provider'
              ? 'no AI provider available'
              : result.reason === 'empty_response'
                ? 'AI returned empty response'
                : result.error
                  ? `AI call failed: ${result.error}`
                  : 'AI unavailable';
            console.log(`\n  ${DIM(`(${reason} — showing raw digest)`)}\n`);
            console.log(result.narrative);
          } else {
            const modelLbl = result.model ? shortModelName(result.model) : result.provider || 'ai';
            console.log(`\n  ${ACCENT('SITREP')} ${DIM(`via ${modelLbl}`)}`);
            console.log(`  ${result.narrative.split('\n').join('\n  ')}`);
            // Cost estimate from usage data
            if (result.usage) {
              const inTok = result.usage.input_tokens || result.usage.prompt_tokens || 0;
              const outTok = result.usage.output_tokens || result.usage.completion_tokens || 0;
              if (inTok + outTok > 0) {
                console.log(`  ${DIM(`[${inTok + outTok} tokens]`)}`);
              }
            }
          }
          console.log('');
        } catch (err) {
          if (spinner) spinner.stop();
          console.log(`  ${ERROR('Sitrep error:')} ${err.message}`);
        }
        rl.prompt();
        return;
      }
      if (line === ':self' || line.startsWith(':self ')) {
        const arg = line.slice(':self'.length).trim().toLowerCase();

        let self = null;
        try {
          const resp = await request('GET', baseUrl, '/self');
          self = resp?.self || null;
        } catch {
          self = null;
        }

        if (!self) {
          self = buildSelfSnapshot({ projectRoot: config.projectRoot, projectName: config.projectName });
        }

        if (arg === 'json') {
          console.log(JSON.stringify(self, null, 2));
          console.log('');
          rl.prompt();
          return;
        }

        console.log('');
        const block = formatSelfSnapshotForPrompt(self, { maxLines: 120 });
        console.log(block.split('\n').map((l) => `  ${l}`).join('\n'));

        // If daemon-provided runtime exists, show a short summary
        const counts = self?.runtime?.counts;
        if (counts) {
          console.log('');
          console.log(`  ${ACCENT('Runtime counts')}`);
          for (const [k, v] of Object.entries(counts)) {
            console.log(`    ${pc.bold(String(k).padEnd(18))} ${pc.white(String(v))}`);
          }
        }

        console.log('');
        rl.prompt();
        return;
      }
      if (line === ':aware' || line.startsWith(':aware ')) {
        const arg = line.slice(':aware'.length).trim().toLowerCase();
        const cfg = loadHydraConfig();

        if (!arg || arg === 'status' || arg === 'show') {
          printSelfAwarenessStatus(cfg.selfAwareness);
          console.log('');
          rl.prompt();
          return;
        }

        if (arg === 'off') {
          await applySelfAwarenessPatch({ enabled: false });
        } else if (arg === 'on') {
          await applySelfAwarenessPatch({ enabled: true });
        } else if (arg === 'minimal') {
          await applySelfAwarenessPatch({ enabled: true, includeSnapshot: true, includeIndex: false });
        } else if (arg === 'full') {
          await applySelfAwarenessPatch({ enabled: true, includeSnapshot: true, includeIndex: true });
        } else {
          console.log(`  ${ERROR('Usage:')} :aware status | on | off | minimal | full`);
          rl.prompt();
          return;
        }

        const next = loadHydraConfig();
        printSelfAwarenessStatus(next.selfAwareness);
        console.log('');
        rl.prompt();
        return;
      }
      if (line.startsWith(':mode ') && ['economy', 'balanced', 'performance'].includes(line.slice(5).trim().toLowerCase())) {
        const modeArg = line.slice(5).trim().toLowerCase();
        const cfg = loadHydraConfig();
        cfg.routing = { ...(cfg.routing || {}), mode: modeArg };
        saveHydraConfig(cfg);
        const chip = modeArg === 'economy' ? pc.yellow('◆ ECO') : modeArg === 'performance' ? pc.cyan('◆ PERF') : pc.green('◆ BAL');
        console.log(`Mode set to ${chip}`);
        if (typeof setActiveMode === 'function') setActiveMode(modeArg);
        rl.prompt();
        return;
      }
      if (line === ':usage') {
        const usage = checkUsage();
        console.log(renderUsageDashboard(usage));
        // Append real session token usage when available (per-agent breakdown)
        try {
          const session = getSessionUsage();
          if (session.callCount > 0) {
            const lines = [];
            lines.push(sectionHeader('Session Token Usage'));
            lines.push(label('Input tokens', pc.white(formatTokens(session.inputTokens))));
            lines.push(label('Output tokens', pc.white(formatTokens(session.outputTokens))));
            lines.push(label('Total tokens', pc.white(formatTokens(session.totalTokens))));
            if (session.cacheCreationTokens > 0 || session.cacheReadTokens > 0) {
              lines.push(label('Cache create', pc.white(formatTokens(session.cacheCreationTokens))));
              lines.push(label('Cache read', pc.white(formatTokens(session.cacheReadTokens))));
            }
            lines.push(label('Cost', pc.white('$' + session.costUsd.toFixed(4))));
            lines.push(label('Calls', pc.white(String(session.callCount))));

            // Per-agent breakdown when multiple agents have real token data
            try {
              const summary = getMetricsSummary();
              const agentsWithTokens = Object.entries(summary.agents || {})
                .filter(([, a]) => a.sessionTokens?.callCount > 0);
              if (agentsWithTokens.length > 1) {
                lines.push('');
                lines.push(DIM('  Per-agent:'));
                for (const [name, a] of agentsWithTokens) {
                  const t = a.sessionTokens;
                  lines.push(`    ${pc.bold(name.padEnd(8))} ${formatTokens(t.totalTokens)} tokens  ${t.costUsd > 0 ? '$' + t.costUsd.toFixed(4) : ''}  (${t.callCount} calls)`);
                }
              }
            } catch { /* skip per-agent */ }

            lines.push('');
            console.log(lines.join('\n'));
          }
        } catch { /* skip */ }

        // Per-provider usage breakdown
        try {
          const provUsage = getProviderUsage();
          const hasData = Object.values(provUsage).some(p => p.session.calls > 0 || p.today.calls > 0);
          if (hasData) {
            const pLines = [];
            pLines.push(sectionHeader('Provider Usage'));
            for (const [name, p] of Object.entries(provUsage)) {
              if (p.session.calls === 0 && p.today.calls === 0) continue;
              const sTotal = p.session.inputTokens + p.session.outputTokens;
              const tTotal = p.today.inputTokens + p.today.outputTokens;
              pLines.push(`  ${pc.bold(name.padEnd(10))} session: ${formatTokens(sTotal)} ($${p.session.cost.toFixed(4)}, ${p.session.calls} calls)  today: ${formatTokens(tTotal)} ($${p.today.cost.toFixed(4)})`);
              if (p.external) {
                const eTotal = (p.external.inputTokens || 0) + (p.external.outputTokens || 0);
                pLines.push(`  ${' '.repeat(10)} account: ${formatTokens(eTotal)} ($${(p.external.cost || 0).toFixed(2)} today)`);
              }
            }
            pLines.push('');
            console.log(pLines.join('\n'));
          }
        } catch { /* skip */ }

        // Save provider usage after display
        try { saveProviderUsage(); } catch { /* skip */ }

        // API quota check — verify actual account status for each agent
        // Works with API keys; for OAuth CLI auth (Claude Code, Gemini CLI) shows auth type
        try {
          console.log(sectionHeader('API Quota Status (live check)'));
          const verifications = await Promise.all(
            ['codex', 'claude', 'gemini'].map(async a => [a, await verifyAgentQuota(a)])
          );
          const qLines = [];
          for (const [a, v] of verifications) {
            const icon = v.verified === false ? pc.green('✓ active') : v.verified === true ? pc.red('✗ QUOTA EXHAUSTED') : pc.yellow('? unverified');
            const detail = v.reason ? pc.dim(` — ${v.reason}`) : '';
            qLines.push(`  ${pc.bold(a.padEnd(8))} ${icon}${detail}`);
          }
          qLines.push('');
          console.log(qLines.join('\n'));
        } catch { /* skip */ }

        rl.prompt();
        return;
      }
      if (line === ':stats') {
        try {
          const statsData = await request('GET', baseUrl, '/stats');
          console.log(renderStatsDashboard(statsData.metrics, statsData.usage));
        } catch {
          // Fallback to just usage if daemon is down
          const usage = checkUsage();
          console.log(renderStatsDashboard(null, usage));
        }
        rl.prompt();
        return;
      }
      if (line === ':resume') {
        try {
          const items = await scanResumableState({ baseUrl, projectRoot: config.projectRoot });
          console.log('');

          if (items.length === 0) {
            console.log(`  ${DIM('Nothing to resume — dispatch a new objective to get started')}`);
            console.log('');
            rl.prompt();
            return;
          }

          // Auto-execute if only one source type, or let user pick
          let selectedValue;
          if (items.length === 1) {
            selectedValue = items[0].value;
            console.log(`  ${ACCENT('→')} ${items[0].label}`);
            console.log(`    ${DIM(items[0].hint)}`);
          } else {
            const choice = await promptChoice(rl, {
              message: 'What would you like to resume?',
              choices: items.map(it => ({ label: it.label, value: it.value, description: it.hint })),
              timeout: 60_000,
            });
            if (!choice.value) { rl.prompt(); return; }
            selectedValue = choice.value;
          }

          // Dispatch by selected value
          console.log(sectionHeader('Resuming'));
          if (selectedValue === 'daemon:unpause' || selectedValue === 'daemon:stale' ||
              selectedValue === 'daemon:handoffs' || selectedValue === 'daemon:resume') {
            await executeDaemonResume(baseUrl, agents, rl);
          } else if (selectedValue === 'evolve') {
            console.log(`  ${ACCENT('→')} Evolve session can be resumed`);
            console.log(`  ${DIM('Type')} ${ACCENT(':evolve resume')} ${DIM('to continue the session')}`);
          } else if (selectedValue.startsWith('council:')) {
            const hash = selectedValue.slice('council:'.length);
            console.log(`  ${ACCENT('Council checkpoint found:')} ${hash}`);
            console.log(`  ${DIM('Re-run the prompt in council mode to continue deliberation')}`);
          } else if (selectedValue.startsWith('branches:')) {
            const prefix = selectedValue.slice('branches:'.length);
            const reviewCmd = prefix === 'evolve' ? ':evolve review' : prefix === 'nightly' ? ':nightly review' : ':tasks review';
            console.log(`  ${ACCENT('→')} Unmerged ${prefix}/* branches found`);
            console.log(`  ${DIM('Type')} ${ACCENT(reviewCmd)} ${DIM('to review and merge')}`);
          } else if (selectedValue === 'suggestions') {
            const pendingCount = items.find(i => i.value === 'suggestions')?.label || 'pending suggestions';
            console.log(`  ${ACCENT('→')} ${pendingCount}`);
            console.log(`  ${DIM('Type')} ${ACCENT(':evolve')} ${DIM('to pick a suggestion, or')} ${ACCENT(':evolve suggestions')} ${DIM('to manage them')}`);
          }

          console.log('');
        } catch (e) {
          console.log(`  ${ERROR(e.message)}`);
        }
        rl.prompt();
        return;
      }
      if (line === ':pause' || line.startsWith(':pause ')) {
        const reason = line.slice(':pause'.length).trim();
        try {
          await request('POST', baseUrl, '/session/pause', { reason });
          console.log(`  ${SUCCESS('\u2713')} Session paused${reason ? `: "${reason}"` : ''}`);
        } catch (e) {
          console.log(`  ${ERROR(e.message)}`);
        }
        rl.prompt();
        return;
      }
      if (line === ':unpause') {
        try {
          await request('POST', baseUrl, '/session/resume', {});
          console.log(`  ${SUCCESS('\u2713')} Session resumed`);
        } catch (e) {
          console.log(`  ${ERROR(e.message)}`);
        }
        rl.prompt();
        return;
      }
      if (line === ':model' || line.startsWith(':model ')) {
        const modelArgs = line.slice(':model'.length).trim();
        if (modelArgs) {
          // Handle "reset" — clear all overrides
          if (modelArgs === 'reset') {
            setMode(getMode());
            console.log(`  ${SUCCESS('\u2713')} All agent overrides cleared, following mode ${ACCENT(getMode())}`);
            rl.prompt();
            return;
          }
          // Parse "mode=economy" or "claude=sonnet gemini=flash" style
          const pairs = modelArgs.split(/\s+/);
          for (const pair of pairs) {
            const eqIdx = pair.indexOf('=');
            if (eqIdx > 0) {
              const key = pair.slice(0, eqIdx).toLowerCase();
              const value = pair.slice(eqIdx + 1);
              if (key === 'mode') {
                try {
                  setMode(value);
                  console.log(`  ${SUCCESS('\u2713')} Mode ${DIM('\u2192')} ${ACCENT(value)}`);
                } catch (e) {
                  console.log(`  ${ERROR(e.message)}`);
                }
              } else if (AGENT_NAMES.includes(key)) {
                if (value === 'default') {
                  const resolved = resetAgentModel(key);
                  console.log(`  ${SUCCESS('\u2713')} ${pc.bold(key)} ${DIM('\u2192')} ${pc.white(resolved)} ${DIM('(following mode)')}`);
                } else {
                  const resolved = setActiveModel(key, value);
                  console.log(`  ${SUCCESS('\u2713')} ${pc.bold(key)} ${DIM('\u2192')} ${pc.white(resolved)}`);
                }
              } else {
                console.log(`  ${ERROR('Unknown key:')} ${key}`);
              }
            }
          }
        } else {
          const summary = getModelSummary();
          const currentMode = summary._mode || getMode();
          console.log('');
          console.log(`  ${pc.bold('Mode:')} ${ACCENT(currentMode)}`);
          for (const [agent, info] of Object.entries(summary)) {
            if (agent === '_mode') continue;
            const model = info.isOverride ? pc.white(info.active) : DIM(info.active);
            const tag = info.isOverride ? WARNING('(override)') : DIM(`(${info.tierSource})`);
            const effLabel2 = formatEffortDisplay(info.active, info.reasoningEffort);
            const effort = effLabel2 ? pc.yellow(` [${effLabel2}]`) : '';
            console.log(`  ${colorAgent(agent)}  ${model}${effort} ${tag}`);
          }
          console.log('');
          console.log(DIM(`  Set mode:  :model mode=economy`));
          console.log(DIM(`  Override:  :model codex=gpt-5.2-codex`));
          console.log(DIM(`  Reset all: :model reset`));
          console.log(DIM(`  Reset one: :model codex=default`));
          console.log(DIM(`  Browse:    :model:select [agent]`));
        }
        rl.prompt();
        return;
      }
      if (line === ':model:select' || line.startsWith(':model:select ')) {
        const selectArg = line.slice(':model:select'.length).trim();
        const pickerArgs = [path.join(HYDRA_ROOT, 'lib', 'hydra-models-select.mjs')];
        if (selectArg && AGENT_NAMES.includes(selectArg.toLowerCase())) {
          pickerArgs.push(selectArg.toLowerCase());
        }
        // Hand terminal control to the interactive picker subprocess
        rl.pause();
        destroyStatusBar();
        spawnHydraNodeSync(pickerArgs[0], pickerArgs.slice(1), { stdio: 'inherit', windowsHide: true });
        initStatusBar(agents);
        rl.resume();
        rl.prompt();
        return;
      }
      if (line === ':roles') {
        const cfg = loadHydraConfig();
        const roles = cfg.roles || {};
        const recs = cfg.recommendations || {};
        console.log('');
        console.log(pc.bold('  Role → Agent → Model mapping'));
        console.log('');
        for (const [role, rc] of Object.entries(roles)) {
          const rec = recs[role];
          const modelStr = rc.model ? pc.white(rc.model) : DIM('(agent default)');
          const roleEffLabel = formatEffortDisplay(rc.model || getActiveModel(rc.agent), rc.reasoningEffort);
          const effortStr = roleEffLabel ? pc.yellow(` [${roleEffLabel}]`) : '';
          const match = rec?.models?.[0] === rc.model ? SUCCESS(' ✓') : '';
          console.log(`  ${ACCENT(role.padEnd(16))} ${colorAgent(rc.agent)}  ${modelStr}${effortStr}${match}`);
          if (rec) {
            console.log(`  ${' '.repeat(16)} ${DIM(`Recommended: ${rec.models.join(', ')}`)}`);
            if (rec.note) console.log(`  ${' '.repeat(16)} ${DIM(rec.note)}`);
          }
        }
        console.log('');
        console.log(DIM('  Override in hydra.config.json under "roles" section'));
        console.log(DIM('  Or use :roster to edit interactively'));
        console.log('');
        rl.prompt();
        return;
      }
      if (line === ':roster') {
        try {
          const { runRosterEditor } = await import('./hydra-roster.mjs');
          await runRosterEditor(rl);
        } catch (err) {
          console.log(`  ${ERROR('Roster editor error:')} ${err.message}`);
        }
        rl.prompt();
        return;
      }
      // ── :persona command ──────────────────────────────────────────────────
      if (line === ':persona') {
        try {
          const { runPersonaEditor } = await import('./hydra-persona.mjs');
          await runPersonaEditor(rl);
        } catch (err) {
          console.log(`  ${ERROR('Persona editor error:')} ${err.message}`);
        }
        rl.prompt();
        return;
      }
      if (line.startsWith(':persona ')) {
        const arg = line.slice(':persona '.length).trim().toLowerCase();
        if (arg === 'show') {
          showPersonaSummary();
        } else if (arg === 'off') {
          const cfg = loadHydraConfig();
          cfg.persona = { ...cfg.persona, enabled: false };
          const { saveHydraConfig: save } = await import('./hydra-config.mjs');
          save(cfg);
          invalidatePersonaCache();
          console.log(`  Persona ${pc.red('disabled')}`);
        } else if (arg === 'on') {
          const cfg = loadHydraConfig();
          cfg.persona = { ...cfg.persona, enabled: true };
          const { saveHydraConfig: save } = await import('./hydra-config.mjs');
          save(cfg);
          invalidatePersonaCache();
          console.log(`  Persona ${pc.green('enabled')}`);
        } else {
          // Try as preset name
          const presets = listPresets();
          if (presets.includes(arg)) {
            applyPreset(arg);
            console.log(`  ${SUCCESS('\u2713')} Applied persona preset: ${pc.white(arg)}`);
            showPersonaSummary();
          } else {
            console.log(`  ${WARNING('Unknown preset:')} ${arg}`);
            console.log(`  Available: ${presets.join(', ')}`);
          }
        }
        rl.prompt();
        return;
      }
      if (line === ':fork' || line.startsWith(':fork ')) {
        const reason = line.slice(':fork'.length).trim();
        try {
          const result = await request('POST', baseUrl, '/session/fork', { reason });
          console.log(`  ${SUCCESS('\u2713')} Session forked: ${pc.white(result.session.id)}`);
          if (reason) console.log(`  ${DIM('Reason:')} ${reason}`);
        } catch (e) {
          console.log(`  ${ERROR(e.message)}`);
        }
        rl.prompt();
        return;
      }
      if (line.startsWith(':spawn ')) {
        const focus = line.slice(':spawn '.length).trim();
        if (!focus) {
          console.log(`  ${ERROR('Usage: :spawn <focus description>')}`);
          rl.prompt();
          return;
        }
        try {
          const result = await request('POST', baseUrl, '/session/spawn', { focus });
          console.log(`  ${SUCCESS('\u2713')} Child session spawned: ${pc.white(result.session.id)}`);
          console.log(`  ${DIM('Focus:')} ${focus}`);
        } catch (e) {
          console.log(`  ${ERROR(e.message)}`);
        }
        rl.prompt();
        return;
      }
      if (line === ':mode') {
        const routingModeCfg = loadHydraConfig().routing?.mode || 'balanced';
        const chip = routingModeCfg === 'economy' ? pc.yellow('◆ ECO') : routingModeCfg === 'performance' ? pc.cyan('◆ PERF') : pc.green('◆ BAL');
        console.log(label('Mode', ACCENT(mode)));
        console.log(label('Routing mode', `${chip} ${pc.dim('(economy | balanced | performance)')}`));
        console.log(DIM(`  Switch orchestration: :mode auto | smart | handoff | council | dispatch`));
        console.log(DIM(`  Switch routing:       :mode economy | balanced | performance`));
        rl.prompt();
        return;
      }
      if (line.startsWith(':mode ')) {
        const nextMode = line.slice(':mode '.length).trim().toLowerCase();
        if (!['auto', 'handoff', 'council', 'dispatch', 'smart'].includes(nextMode)) {
          console.log('Invalid mode. Use :mode auto, :mode handoff, :mode council, :mode dispatch, or :mode smart');
          rl.prompt();
          return;
        }
        mode = nextMode;
        setActiveMode(mode);
        console.log(label('Mode', ACCENT(mode)));
        drawStatusBar();
        rl.prompt();
        return;
      }

      // ── Confirmation Toggle ──────────────────────────────────────────────
      if (line === ':confirm' || line.startsWith(':confirm ')) {
        const arg = line.slice(':confirm'.length).trim().toLowerCase();
        if (arg === 'off') {
          setAutoAccept(true);
          console.log(`  ${SUCCESS('\u2713')} Confirmations ${DIM('disabled')} (auto-accepting all prompts)`);
        } else if (arg === 'on') {
          setAutoAccept(false);
          console.log(`  ${SUCCESS('\u2713')} Confirmations ${ACCENT('enabled')}`);
        } else {
          const state = isAutoAccepting() ? DIM('off (auto-accepting)') : ACCENT('on');
          console.log(label('Confirmations', state));
          console.log(DIM(`  Toggle: :confirm on | :confirm off`));
        }
        rl.prompt();
        return;
      }

      // ── Dry-Run Toggle ──────────────────────────────────────────────────
      if (line === ':dry-run' || line.startsWith(':dry-run ')) {
        const arg = line.slice(':dry-run'.length).trim().toLowerCase();
        if (arg === 'on') {
          dryRunMode = true;
          console.log(`  ${SUCCESS('\u2713')} Dry-run mode ${ACCENT('enabled')} — dispatches will preview only, no tasks created`);
        } else if (arg === 'off') {
          dryRunMode = false;
          console.log(`  ${SUCCESS('\u2713')} Dry-run mode ${DIM('disabled')} — dispatches will execute normally`);
        } else {
          dryRunMode = !dryRunMode;
          const state = dryRunMode ? ACCENT('ON') : DIM('off');
          console.log(label('Dry-run mode', state));
          if (dryRunMode) {
            console.log(DIM(`  Dispatches will preview route/agent selection without creating tasks`));
          }
        }
        rl.prompt();
        return;
      }

      // ── Task & Handoff Management ─────────────────────────────────────────
      if (line === ':clear' || line.startsWith(':clear ')) {
        let what = line.slice(':clear'.length).trim().toLowerCase();

        // Interactive menu when no target specified
        if (!what) {
          const pick = await promptChoice(rl, {
            title: 'Clear Target',
            context: { Warning: 'Select what to clear' },
            choices: [
              { label: 'Tasks & Handoffs', value: 'all', hint: 'cancel tasks + ack handoffs' },
              { label: 'Tasks only', value: 'tasks', hint: 'cancel all open tasks' },
              { label: 'Handoffs only', value: 'handoffs', hint: 'ack all pending handoffs' },
              { label: 'Concierge history', value: 'concierge', hint: 'clear conversation' },
              { label: 'Session metrics', value: 'metrics', hint: 'reset counters' },
              { label: 'Screen', value: 'screen', hint: 'clear terminal' },
            ],
          });
          if (!pick.value) { rl.prompt(); return; }
          what = pick.value;
        }

        // Non-destructive targets (no confirmation needed)
        if (what === 'screen') {
          process.stdout.write('\x1b[2J\x1b[H');
          rl.prompt();
          return;
        }
        if (what === 'concierge') {
          resetConversation();
          console.log(`  ${SUCCESS('\u2713')} Concierge conversation cleared`);
          rl.prompt();
          return;
        }
        if (what === 'metrics') {
          resetMetrics();
          resetSessionUsage();
          console.log(`  ${SUCCESS('\u2713')} Session metrics reset`);
          rl.prompt();
          return;
        }

        // Destructive targets — confirmation gate
        if (what === 'all' || what === 'tasks' || what === 'handoffs') {
          const clearConfirm = await promptChoice(rl, {
            title: 'Confirm Clear',
            context: { Scope: what === 'all' ? 'all tasks & handoffs' : what, Warning: 'This cannot be undone' },
            choices: [
              { label: 'Yes, proceed', value: 'yes', hint: `clear ${what}` },
              { label: 'No, cancel', value: 'no', hint: 'abort' },
            ],
            defaultValue: 'yes',
          });
          if (clearConfirm.value === 'no') {
            console.log(`  ${DIM('Cancelled.')}`);
            rl.prompt();
            return;
          }
          try {
            const { state } = await request('GET', baseUrl, '/state');
            let ackedCount = 0;
            let cancelledCount = 0;

            if (what === 'all' || what === 'handoffs') {
              const pending = state.handoffs.filter((h) => !h.acknowledgedAt);
              for (const h of pending) {
                const agent = String(h.to || 'human').toLowerCase();
                await request('POST', baseUrl, '/handoff/ack', { handoffId: h.id, agent });
                ackedCount++;
              }
            }

            if (what === 'all' || what === 'tasks') {
              const open = state.tasks.filter((t) => t.status === 'todo' || t.status === 'in_progress');
              for (const t of open) {
                await request('POST', baseUrl, '/task/update', { taskId: t.id, status: 'cancelled' });
                cancelledCount++;
              }
            }

            const parts = [];
            if (ackedCount > 0) parts.push(`${ackedCount} handoff${ackedCount > 1 ? 's' : ''} acked`);
            if (cancelledCount > 0) parts.push(`${cancelledCount} task${cancelledCount > 1 ? 's' : ''} cancelled`);
            console.log(parts.length > 0
              ? `  ${SUCCESS('\u2713')} ${parts.join(', ')}`
              : `  ${DIM('Nothing to clear')}`);
          } catch (e) {
            console.log(`  ${ERROR(e.message)}`);
          }
          rl.prompt();
          return;
        }

        // Unknown target
        console.log(`  ${ERROR('Unknown target:')} ${what}`);
        console.log(`  ${DIM('Usage: :clear [all|tasks|handoffs|concierge|metrics|screen]')}`);
        rl.prompt();
        return;
      }

      if (line.startsWith(':cancel ')) {
        const id = line.slice(':cancel '.length).trim().toUpperCase();
        try {
          const result = await request('POST', baseUrl, '/task/update', { taskId: id, status: 'cancelled' });
          console.log(`  ${SUCCESS('\u2713')} ${pc.white(result.task.id)} cancelled ${DIM(result.task.title)}`);
        } catch (e) {
          console.log(`  ${ERROR(e.message)}`);
        }
        rl.prompt();
        return;
      }

      if (line === ':tasks' || line.startsWith(':tasks ')) {
        const tasksArg = line.slice(':tasks'.length).trim().toLowerCase();

        if (tasksArg === 'scan') {
          // Run scanner inline
          console.log(`  ${ACCENT('Scanning for work items...')}`);
          try {
            const { scanAllSources } = await import('./hydra-tasks-scanner.mjs');
            const scanned = scanAllSources(config.projectRoot);
            if (scanned.length === 0) {
              console.log(`  ${DIM('No tasks found.')}`);
            } else {
              console.log('');
              console.log(sectionHeader(`Scanned Tasks (${scanned.length})`));
              for (const t of scanned.slice(0, 15)) {
                const prioColor = t.priority === 'high' ? pc.red : t.priority === 'low' ? DIM : pc.yellow;
                console.log(`  ${prioColor(t.priority.padEnd(6))} ${t.title}`);
                console.log(`         ${DIM(`[${t.source}] ${t.taskType} → ${t.suggestedAgent} | ${t.sourceRef}`)}`);
              }
              if (scanned.length > 15) {
                console.log(DIM(`  ... and ${scanned.length - 15} more`));
              }
              console.log('');
            }
          } catch (e) {
            console.log(`  ${ERROR(e.message)}`);
          }
          rl.prompt();
          return;
        }

        if (tasksArg === 'run' || tasksArg.startsWith('run ')) {
          // Launch tasks runner as subprocess (same pattern as :evolve)
          const cwd = config.projectRoot;
          console.log(`  ${ACCENT('Launching tasks runner...')}`);
          rl.pause();
          destroyStatusBar();
          const tasksScript = path.join(HYDRA_ROOT, 'lib', 'hydra-tasks.mjs');
          const tasksArgs = [tasksScript, `project=${cwd}`];
          const extra = tasksArg.slice('run'.length).trim();
          if (extra) {
            tasksArgs.push(...extra.split(/\s+/).filter(Boolean));
          }
          const child = spawnHydraNode(tasksArgs[0], tasksArgs.slice(1), {
            cwd,
            stdio: 'inherit',
            shell: process.platform === 'win32',
          });
          child.on('close', (code) => {
            initStatusBar(agents);
            rl.resume();
            if (code === 0) {
              console.log(`  ${SUCCESS('\u2713')} Tasks runner complete`);
            } else {
              console.log(`  ${ERROR(`Tasks runner exited with code ${code}`)}`);
            }
            rl.prompt();
          });
          return;
        }

        if (tasksArg === 'review') {
          const cwd = config.projectRoot;
          rl.pause();
          destroyStatusBar();
          const reviewScript = path.join(HYDRA_ROOT, 'lib', 'hydra-tasks-review.mjs');
          const child = spawnHydraNode(reviewScript, ['review'], {
            cwd,
            stdio: 'inherit',
            shell: process.platform === 'win32',
          });
          child.on('close', () => {
            initStatusBar(agents);
            rl.resume();
            rl.prompt();
          });
          return;
        }

        if (tasksArg === 'status') {
          const reviewScript = path.join(HYDRA_ROOT, 'lib', 'hydra-tasks-review.mjs');
          const child = spawnHydraNode(reviewScript, ['status'], {
            cwd: config.projectRoot,
            stdio: 'inherit',
            shell: process.platform === 'win32',
          });
          child.on('close', () => { rl.prompt(); });
          return;
        }

        if (tasksArg === 'clean') {
          const reviewScript = path.join(HYDRA_ROOT, 'lib', 'hydra-tasks-review.mjs');
          const child = spawnHydraNode(reviewScript, ['clean'], {
            cwd: config.projectRoot,
            stdio: 'inherit',
            shell: process.platform === 'win32',
          });
          child.on('close', () => { rl.prompt(); });
          return;
        }

        // Default: list daemon tasks (original behavior)
        try {
          const { state } = await request('GET', baseUrl, '/state');
          const active = state.tasks.filter((t) => t.status !== 'cancelled' && t.status !== 'done');
          if (active.length === 0) {
            console.log(`  ${DIM('No active tasks')}`);
          } else {
            console.log('');
            console.log(sectionHeader(`Tasks (${active.length})`));
            for (const t of active) {
              const statusIcon = t.status === 'in_progress' ? WARNING('\u25CF') : DIM('\u25CB');
              console.log(`  ${statusIcon} ${pc.white(t.id)} ${colorAgent(t.owner)} ${t.title} ${DIM(t.status)}`);
            }
            console.log('');
          }
        } catch (e) {
          console.log(`  ${ERROR(e.message)}`);
        }
        rl.prompt();
        return;
      }

      if (line === ':handoffs') {
        try {
          const { state } = await request('GET', baseUrl, '/state');
          const pending = state.handoffs.filter((h) => !h.acknowledgedAt);
          const recent = state.handoffs.filter((h) => h.acknowledgedAt).slice(-5);
          if (pending.length === 0 && recent.length === 0) {
            console.log(`  ${DIM('No handoffs')}`);
          } else {
            if (pending.length > 0) {
              console.log('');
              console.log(sectionHeader(`Pending handoffs (${pending.length})`));
              for (const h of pending) {
                console.log(`  ${WARNING('\u25CF')} ${pc.white(h.id)} ${colorAgent(h.from)}\u2192${colorAgent(h.to)} ${DIM(short(h.summary, 50))}`);
              }
            }
            if (recent.length > 0) {
              console.log('');
              console.log(sectionHeader('Recent handoffs'));
              for (const h of recent) {
                console.log(`  ${SUCCESS('\u2713')} ${pc.white(h.id)} ${colorAgent(h.from)}\u2192${colorAgent(h.to)} ${DIM(short(h.summary, 50))}`);
              }
            }
            console.log('');
          }
        } catch (e) {
          console.log(`  ${ERROR(e.message)}`);
        }
        rl.prompt();
        return;
      }

      if (line === ':archive') {
        try {
          const result = await request('POST', baseUrl, '/state/archive');
          console.log(`  ${SUCCESS('\u2713')} Archived: ${result.moved.tasks} tasks, ${result.moved.handoffs} handoffs, ${result.moved.blockers} blockers${result.eventsTrimmed ? `, ${result.eventsTrimmed} events trimmed` : ''}`);
        } catch (e) {
          console.log(`  ${ERROR(e.message)}`);
        }
        rl.prompt();
        return;
      }

      if (line === ':events') {
        try {
          const result = await request('GET', baseUrl, '/events');
          const events = result.events || [];
          if (events.length === 0) {
            console.log(`  ${DIM('No events')}`);
          } else {
            console.log('');
            console.log(sectionHeader(`Recent events (${events.length})`));
            for (const e of events.slice(-15)) {
              const time = e.timestamp ? new Date(e.timestamp).toLocaleTimeString() : '';
              const agent = e.agent ? ` ${colorAgent(e.agent)}` : '';
              console.log(`  ${DIM(time)}${agent} ${e.event || e.type || 'unknown'} ${DIM(e.detail || e.taskId || '')}`);
            }
            console.log('');
          }
        } catch (e) {
          console.log(`  ${ERROR(e.message)}`);
        }
        rl.prompt();
        return;
      }

      if (line === ':sync') {
        try {
          const syncResult = syncHydraMd(config.projectRoot);
          if (syncResult.skipped) {
            console.log(`  ${DIM('No HYDRA.md found in project root.')}`);
          } else if (syncResult.synced.length > 0) {
            console.log(`  ${SUCCESS('\u2713')} Synced HYDRA.md \u2192 ${syncResult.synced.join(', ')}`);
          } else {
            console.log(`  ${DIM('All agent files up to date.')}`);
          }
        } catch (e) {
          console.log(`  ${ERROR(e.message)}`);
        }
        rl.prompt();
        return;
      }

      if (line === ':shutdown') {
        const shutdownConfirm = await promptChoice(rl, {
          title: 'Confirm Shutdown',
          context: { Warning: 'This will stop the daemon and all agent activity' },
          choices: [
            { label: 'Yes, proceed', value: 'yes', hint: 'stop the daemon' },
            { label: 'No, cancel', value: 'no', hint: 'abort' },
          ],
          defaultValue: 'yes',
        });
        if (shutdownConfirm.value === 'no') {
          console.log(`  ${DIM('Cancelled.')}`);
          rl.prompt();
          return;
        }
        stopAllWorkers();
        try {
          await request('POST', baseUrl, '/shutdown');
          console.log(`  ${SUCCESS('\u2713')} Daemon shutting down`);
        } catch (e) {
          console.log(`  ${ERROR(e.message)}`);
        }
        rl.close();
        return;
      }

      // ── Agent Forge Commands ─────────────────────────────────────────────
      if (line === ':forge' || line.startsWith(':forge ')) {
        const forgeArgs = line.slice(':forge'.length).trim();
        const forgeParts = forgeArgs.split(/\s+/);
        const forgeSubCmd = forgeParts[0] || '';

        if (!forgeSubCmd) {
          // Interactive wizard
          try {
            await runForgeWizard(rl);
          } catch (err) {
            console.log(`  ${ERROR('Forge error:')} ${err.message}`);
          }
        } else if (forgeSubCmd === 'list') {
          const forged = listForgedAgents();
          console.log('');
          console.log(sectionHeader('Forged Agents'));
          if (forged.length === 0) {
            console.log(`  ${DIM('No forged agents yet. Use :forge to create one.')}`);
          } else {
            for (const f of forged) {
              const status = f.enabled ? SUCCESS('on') : ERROR('off');
              console.log(`  ${ACCENT(f.name)} ${DIM(f.displayName)}  ${DIM('\u2192')} ${f.baseAgent}  [${status}]`);
              console.log(`    ${DIM('Top:')} ${f.topAffinities.join(', ')}  ${DIM('v' + f.version)}  ${DIM(f.forgedAt?.slice(0, 10) || '')}`);
              if (f.description) console.log(`    ${DIM(f.description.slice(0, 80))}`);
            }
          }
          console.log('');
        } else if (forgeSubCmd === 'info') {
          const targetName = forgeParts[1];
          if (!targetName) {
            console.log(`  ${ERROR('Usage:')} :forge info <name>`);
          } else {
            const registry = loadForgeRegistry();
            const meta = registry[targetName];
            const agentDef = getAgent(targetName);
            if (!meta && !agentDef) {
              console.log(`  ${ERROR('Unknown forged agent:')} ${targetName}`);
            } else {
              console.log('');
              console.log(sectionHeader(`Forge: ${agentDef?.displayName || targetName}`));
              if (agentDef) {
                console.log(`  ${pc.bold('Name:')}      ${agentDef.name}`);
                console.log(`  ${pc.bold('Base:')}      ${agentDef.baseAgent}`);
                console.log(`  ${pc.bold('Enabled:')}   ${agentDef.enabled ? SUCCESS('yes') : ERROR('no')}`);
                console.log(`  ${pc.bold('Strengths:')} ${agentDef.strengths.join(', ')}`);
                console.log(`  ${pc.bold('Tags:')}      ${agentDef.tags.join(', ')}`);
              }
              if (meta) {
                console.log(`  ${pc.bold('Forged:')}    ${meta.forgedAt}`);
                console.log(`  ${pc.bold('Version:')}   ${meta.version}`);
                console.log(`  ${pc.bold('Phases:')}    ${meta.phasesRun?.join(' \u2192 ') || 'unknown'}`);
                if (meta.description) console.log(`  ${pc.bold('Goal:')}      ${meta.description}`);
                if (meta.testResult) console.log(`  ${pc.bold('Test:')}      ${meta.testResult.ok ? SUCCESS('passed') : ERROR('failed')} (${(meta.testResult.durationMs / 1000).toFixed(1)}s)`);
              }
              console.log('');
            }
          }
        } else if (forgeSubCmd === 'test') {
          const targetName = forgeParts[1];
          if (!targetName) {
            console.log(`  ${ERROR('Usage:')} :forge test <name>`);
          } else {
            const agentDef = getAgent(targetName);
            if (!agentDef) {
              console.log(`  ${ERROR('Unknown agent:')} ${targetName}`);
            } else {
              console.log(`  ${ACCENT('\u25B6')} Testing ${targetName} ${DIM(`(${agentDef.baseAgent}...)`)}`);
              try {
                const result = await testForgedAgent(agentDef);
                console.log(`  ${result.ok ? SUCCESS('\u2713') : ERROR('\u2718')} Test ${result.ok ? 'passed' : 'failed'} ${DIM(`(${(result.durationMs / 1000).toFixed(1)}s)`)}`);
                if (result.output) {
                  const preview = result.output.split('\n').slice(0, 8);
                  for (const l of preview) console.log(`    ${DIM(l.slice(0, 120))}`);
                  if (result.output.split('\n').length > 8) console.log(`    ${DIM('...')}`);
                }
              } catch (err) {
                console.log(`  ${ERROR('Test error:')} ${err.message}`);
              }
            }
          }
          console.log('');
        } else if (forgeSubCmd === 'delete') {
          const targetName = forgeParts[1];
          if (!targetName) {
            console.log(`  ${ERROR('Usage:')} :forge delete <name>`);
          } else {
            const agentDef = getAgent(targetName);
            if (!agentDef) {
              console.log(`  ${ERROR('Unknown agent:')} ${targetName}`);
            } else if (agentDef.type === AGENT_TYPE.PHYSICAL) {
              console.log(`  ${ERROR('Cannot delete physical agents.')}`);
            } else {
              removeForgedAgent(targetName);
              console.log(`  ${SUCCESS('\u2713')} Agent ${ACCENT(targetName)} removed.`);
            }
          }
          console.log('');
        } else if (forgeSubCmd === 'edit') {
          const targetName = forgeParts[1];
          if (!targetName) {
            console.log(`  ${ERROR('Usage:')} :forge edit <name>`);
          } else {
            const agentDef = getAgent(targetName);
            const registry = loadForgeRegistry();
            const meta = registry[targetName];
            if (!agentDef) {
              console.log(`  ${ERROR('Unknown agent:')} ${targetName}`);
            } else {
              console.log(`  ${ACCENT('\u25B6')} Re-forging ${targetName}...`);
              try {
                const desc = meta?.description || agentDef.displayName;
                await runForgeWizard(rl, desc);
              } catch (err) {
                console.log(`  ${ERROR('Forge error:')} ${err.message}`);
              }
            }
          }
        } else {
          // Treat the whole arg string as a description
          try {
            await runForgeWizard(rl, forgeArgs);
          } catch (err) {
            console.log(`  ${ERROR('Forge error:')} ${err.message}`);
          }
        }

        rl.prompt();
        return;
      }

      // ── Agent Registry Commands ────────────────────────────────────────
      if (line === ':agents' || line.startsWith(':agents ')) {
        const agentArgs = line.slice(':agents'.length).trim();
        const agentParts = agentArgs.split(/\s+/);
        const agentSubCmd = agentParts[0] || '';

        if (!agentSubCmd) {
          // List all agents
          console.log('');
          console.log(sectionHeader('Agent Registry'));
          const physical = listAgents({ type: 'physical' });
          const virtual = listAgents({ type: 'virtual' });

          console.log(`  ${pc.bold('Physical Agents')} (${physical.length})`);
          for (const a of physical) {
            const model = getActiveModel(a.name) || DIM('default');
            console.log(`    ${colorAgent(a.name)} ${DIM(a.label)}  ${DIM('model:')} ${pc.white(model)}`);
          }

          if (virtual.length > 0) {
            console.log('');
            console.log(`  ${pc.bold('Virtual Sub-Agents')} (${virtual.length})`);
            for (const a of virtual) {
              const status = a.enabled ? SUCCESS('on') : ERROR('off');
              const base = DIM(`\u2192 ${a.baseAgent}`);
              console.log(`    ${colorAgent(a.name)} ${DIM(a.displayName)}  ${base}  [${status}]`);
            }
          } else {
            console.log('');
            console.log(`  ${DIM('No virtual sub-agents registered.')}`);
          }

          console.log('');
          console.log(DIM('  :agents info <name>      Show agent details'));
          console.log(DIM('  :agents enable <name>    Enable a virtual agent'));
          console.log(DIM('  :agents disable <name>   Disable a virtual agent'));
          console.log(DIM('  :agents list virtual     List virtual agents only'));
          console.log(DIM('  :agents list physical    List physical agents only'));
          console.log('');
        } else if (agentSubCmd === 'list') {
          const filterType = agentParts[1] || 'all';
          const opts = {};
          if (filterType === 'virtual') opts.type = 'virtual';
          else if (filterType === 'physical') opts.type = 'physical';
          const list = listAgents(opts);
          console.log('');
          console.log(sectionHeader(`Agents (${filterType})`));
          for (const a of list) {
            const typeTag = a.type === 'virtual' ? DIM('[virtual]') : DIM('[physical]');
            const status = a.enabled ? SUCCESS('on') : ERROR('off');
            console.log(`    ${colorAgent(a.name)} ${typeTag} ${DIM(a.displayName)}  [${status}]`);
          }
          if (list.length === 0) console.log(`    ${DIM('(none)')}`);
          console.log('');
        } else if (agentSubCmd === 'info') {
          const targetName = agentParts[1];
          if (!targetName) {
            console.log(`  ${ERROR('Usage:')} :agents info <name>`);
          } else {
            const agentDef = getAgent(targetName);
            if (!agentDef) {
              console.log(`  ${ERROR('Unknown agent:')} ${targetName}`);
            } else {
              console.log('');
              console.log(sectionHeader(`Agent: ${agentDef.displayName}`));
              console.log(`  ${pc.bold('Name:')}      ${agentDef.name}`);
              console.log(`  ${pc.bold('Type:')}      ${agentDef.type}`);
              console.log(`  ${pc.bold('Label:')}     ${agentDef.label}`);
              console.log(`  ${pc.bold('Enabled:')}   ${agentDef.enabled ? SUCCESS('yes') : ERROR('no')}`);
              if (agentDef.baseAgent) {
                console.log(`  ${pc.bold('Base:')}      ${colorAgent(agentDef.baseAgent)}`);
              }
              if (agentDef.councilRole) {
                console.log(`  ${pc.bold('Council:')}   ${agentDef.councilRole}`);
              }
              if (agentDef.strengths.length > 0) {
                console.log(`  ${pc.bold('Strengths:')} ${agentDef.strengths.join(', ')}`);
              }
              if (agentDef.tags.length > 0) {
                console.log(`  ${pc.bold('Tags:')}      ${agentDef.tags.join(', ')}`);
              }
              // Show task affinities sorted by score
              const affinities = Object.entries(agentDef.taskAffinity || {})
                .sort(([, a], [, b]) => b - a);
              if (affinities.length > 0) {
                console.log(`  ${pc.bold('Affinities:')}`);
                for (const [type, score] of affinities) {
                  const bar = '\u2588'.repeat(Math.round(score * 20));
                  const pad = ' '.repeat(20 - Math.round(score * 20));
                  console.log(`    ${type.padEnd(16)} ${DIM(bar)}${DIM(pad)} ${(score * 100).toFixed(0)}%`);
                }
              }
              if (agentDef.rolePrompt) {
                console.log(`  ${pc.bold('Role Prompt:')}`);
                const lines = agentDef.rolePrompt.split('\n').slice(0, 6);
                for (const l of lines) console.log(`    ${DIM(l)}`);
                if (agentDef.rolePrompt.split('\n').length > 6) console.log(`    ${DIM('...')}`);
              }
              console.log('');
            }
          }
        } else if (agentSubCmd === 'enable' || agentSubCmd === 'disable') {
          const targetName = agentParts[1];
          if (!targetName) {
            console.log(`  ${ERROR('Usage:')} :agents ${agentSubCmd} <name>`);
          } else {
            const agentDef = getAgent(targetName);
            if (!agentDef) {
              console.log(`  ${ERROR('Unknown agent:')} ${targetName}`);
            } else if (agentDef.type === 'physical') {
              console.log(`  ${ERROR('Cannot')} ${agentSubCmd} physical agents.`);
            } else {
              agentDef.enabled = agentSubCmd === 'enable';
              console.log(`  ${SUCCESS('\u2713')} ${colorAgent(targetName)} ${agentSubCmd}d`);
            }
          }

        } else if (agentSubCmd === 'add') {
          const { runAgentsWizard } = await import('./hydra-agents-wizard.mjs');
          await runAgentsWizard(rl);

        } else if (agentSubCmd === 'remove') {
          const targetName = agentParts[1]?.toLowerCase();
          if (!targetName) {
            console.log(`  ${ERROR('Usage:')} :agents remove <name>`);
          } else {
            const cfg = loadHydraConfig();
            const before = cfg.agents?.customAgents || [];
            const customAgents = before.filter(a => a.name !== targetName);
            if (customAgents.length === before.length) {
              console.log(`  ${ERROR('Not found:')} "${targetName}" is not a custom agent`);
            } else {
              saveHydraConfig({ agents: { ...cfg.agents, customAgents } });
              console.log(`  ${SUCCESS('\u2713')} Removed agent "${targetName}" from config (restart to take effect)`);
            }
          }

        } else if (agentSubCmd === 'test') {
          const targetName = agentParts[1]?.toLowerCase();
          if (!targetName) {
            console.log(`  ${ERROR('Usage:')} :agents test <name>`);
          } else {
            const agentDef = getAgent(targetName);
            if (!agentDef) {
              console.log(`  ${ERROR('Not found:')} agent "${targetName}" not in registry`);
            } else {
              console.log(`  Testing agent "${targetName}"...`);
              try {
                const result = await executeAgent(targetName, 'Say "hello" in one sentence.');
                if (result.ok) {
                  console.log(`  ${SUCCESS('OK')} ${DIM(result.output?.slice(0, 200) || '(empty output)')}`);
                } else {
                  console.log(`  ${ERROR('FAIL')} ${result.errorCategory}: ${result.stderr?.slice(0, 200)}`);
                }
              } catch (err) {
                console.log(`  ${ERROR('ERROR')} ${err.message}`);
              }
            }
          }

        } else {
          console.log(`  ${ERROR('Unknown subcommand:')} ${agentSubCmd}`);
          console.log(`  ${DIM('Usage: :agents [add|remove|test|info|list|enable|disable] [name]')}`);
        }

        rl.prompt();
        return;
      }

      // ── Doctor Commands ──────────────────────────────────────────────────
      if (line === ':doctor' || line.startsWith(':doctor ')) {
        const doctorArg = line.slice(':doctor'.length).trim();
        try {
          const { initDoctor, isDoctorEnabled, getDoctorStats, getDoctorLog } = await import('./hydra-doctor.mjs');
          initDoctor();

          if (!doctorArg || doctorArg === 'stats') {
            // Show stats + last 10 log entries
            console.log('');
            console.log(sectionHeader('Doctor'));
            const enabled = isDoctorEnabled();
            console.log(label('Status', enabled ? SUCCESS('enabled') : ERROR('disabled')));
            const stats = getDoctorStats();
            console.log(label('Session', `${stats.total} diagnoses — ${stats.fixes} fixes, ${stats.tickets} tickets, ${stats.investigations} investigations, ${stats.ignored} ignored`));
            const recent = getDoctorLog(10);
            if (recent.length > 0) {
              console.log('');
              console.log(DIM('  Recent diagnoses:'));
              for (const e of recent) {
                const sev = e.severity === 'critical' || e.severity === 'high' ? ERROR(e.severity) : e.severity === 'medium' ? WARNING(e.severity) : DIM(e.severity);
                const ts = e.ts ? new Date(e.ts).toLocaleTimeString() : '';
                console.log(`    ${DIM(ts)} ${sev} ${pc.white(e.action)} ${DIM(e.pipeline || '')} ${(e.explanation || '').slice(0, 60)}`);
              }
            } else {
              console.log(`  ${DIM('No diagnostic entries yet')}`);
            }
            console.log('');
          } else if (doctorArg === 'log') {
            // Show last 25 entries
            const entries = getDoctorLog(25);
            console.log('');
            console.log(sectionHeader('Doctor Log'));
            if (entries.length === 0) {
              console.log(`  ${DIM('No diagnostic entries yet')}`);
            } else {
              for (const e of entries) {
                const sev = e.severity === 'critical' || e.severity === 'high' ? ERROR(e.severity.padEnd(8)) : e.severity === 'medium' ? WARNING(e.severity.padEnd(8)) : DIM(e.severity.padEnd(8));
                const ts = e.ts ? new Date(e.ts).toLocaleString() : '';
                console.log(`  ${DIM(ts)} ${sev} [${e.action}] ${e.pipeline || ''}: ${(e.explanation || '').slice(0, 80)}`);
                if (e.recurring) console.log(`    ${WARNING('↻ recurring')}`);
              }
            }
            console.log('');
          } else if (doctorArg === 'fix') {
            // Auto-detect and fix issues via action pipeline
            try {
              const { runActionPipeline } = await import('./hydra-action-pipeline.mjs');
              const { scanDoctorLog, scanDaemonIssues, scanErrorActivity,
                      enrichWithDiagnosis, executeFixAction } = await import('./hydra-doctor.mjs');
              const { getOutputContext } = await import('./hydra-output-history.mjs');

              await runActionPipeline(rl, {
                title: 'Doctor Fix',
                scanners: [
                  () => scanDoctorLog(),
                  () => scanDaemonIssues(baseUrl),
                  () => scanErrorActivity(),
                ],
                enrich: (items) => enrichWithDiagnosis(items, getOutputContext()),
                preSelectFilter: (item) => item.severity === 'critical' || item.severity === 'high',
                executeFn: (item) => executeFixAction(item, { projectRoot: config.projectRoot, rl }),
                projectRoot: config.projectRoot,
                baseUrl,
              });
            } catch (e) {
              console.log(`  ${ERROR(e.message)}`);
            }
          } else if (doctorArg.startsWith('diagnose ')) {
            const errorText = doctorArg.slice('diagnose '.length).trim();
            if (!errorText) {
              console.log(`  ${ERROR('Usage:')} :doctor diagnose <error text>`);
            } else {
              console.log('');
              console.log(sectionHeader('Investigating'));
              const spinner = createSpinner('Diagnosing failure...', { style: 'orbital' });
              try {
                const inv = await import('./hydra-investigator.mjs');
                if (!inv.isInvestigatorAvailable()) {
                  spinner.stop();
                  console.log(`  ${ERROR('Investigator unavailable')} — OPENAI_API_KEY required`);
                } else {
                  inv.initInvestigator();
                  const result = await inv.investigate({
                    phase: 'manual',
                    error: errorText,
                    context: errorText,
                    attemptNumber: 1,
                  });
                  spinner.stop();

                  // Display diagnosis
                  const diagColor = result.diagnosis === 'fundamental' ? ERROR : result.diagnosis === 'fixable' ? WARNING : DIM;
                  console.log(label('Type', diagColor(result.diagnosis)));
                  console.log(label('Root cause', pc.white(result.rootCause || 'unknown')));
                  console.log(label('Explanation', pc.white(result.explanation || 'none')));
                  if (result.corrective) {
                    console.log(label('Corrective', ACCENT(result.corrective)));
                  }
                  if (result.retryRecommendation) {
                    const rec = result.retryRecommendation;
                    console.log(label('Retry', rec.retryPhase ? SUCCESS('yes') : DIM('no')));
                    if (rec.retryAgent) console.log(label('Alt agent', colorAgent(rec.retryAgent)));
                  }

                  // Also triage into follow-ups
                  try {
                    const { diagnose } = await import('./hydra-doctor.mjs');
                    await diagnose({
                      pipeline: 'manual',
                      phase: 'manual',
                      error: errorText,
                      context: errorText,
                    });
                    console.log(`  ${DIM('Triaged into follow-ups (suggestion/KB)')}`);
                  } catch { /* best effort */ }
                }
              } catch (e) {
                spinner.stop();
                console.log(`  ${ERROR(e.message)}`);
              }
              console.log('');
            }
          } else {
            console.log(`  ${ERROR('Unknown subcommand:')} ${doctorArg}`);
            console.log(`  ${DIM('Usage: :doctor [stats|log|fix|diagnose <text>]')}`);
          }
        } catch (e) {
          console.log(`  ${ERROR(e.message)}`);
        }
        rl.prompt();
        return;
      }

      // ── Knowledge Base Commands ────────────────────────────────────────────
      if (line === ':kb' || line.startsWith(':kb ')) {
        const kbArg = line.slice(':kb'.length).trim();
        try {
          const { loadKnowledgeBase, searchEntries, getStats } = await import('./hydra-knowledge.mjs');
          const evolveDir = path.join(config.projectRoot, 'docs', 'coordination', 'evolve');
          const kb = loadKnowledgeBase(evolveDir);

          if (!kbArg) {
            // Stats + 10 most recent entries
            console.log('');
            console.log(sectionHeader('Knowledge Base'));
            const stats = getStats(kb);
            console.log(label('Entries', pc.white(String(stats.totalEntries || kb.entries?.length || 0))));
            if (stats.byArea && Object.keys(stats.byArea).length > 0) {
              const areas = Object.entries(stats.byArea).sort(([,a],[,b]) => b - a).slice(0, 5);
              console.log(label('Top areas', areas.map(([a, c]) => `${a} (${c})`).join(', ')));
            }
            console.log('');
            const recent = (kb.entries || []).slice(-10).reverse();
            if (recent.length > 0) {
              console.log(DIM('  Recent entries:'));
              for (const e of recent) {
                const appColor = e.applicability === 'high' ? SUCCESS : e.applicability === 'medium' ? WARNING : DIM;
                console.log(`    ${DIM(e.id || '?')} ${appColor(String(e.applicability || '?').padEnd(6))} ${DIM(e.area || '')} ${(e.finding || '').slice(0, 70)}`);
              }
            } else {
              console.log(`  ${DIM('Knowledge base is empty — run :evolve to accumulate learnings')}`);
            }
            console.log('');
          } else {
            // Search entries
            const results = searchEntries(kb, kbArg);
            console.log('');
            console.log(sectionHeader(`KB Search: "${kbArg}"`));
            if (results.length === 0) {
              console.log(`  ${DIM('No matching entries')}`);
            } else {
              for (const e of results.slice(0, 15)) {
                const appColor = e.applicability === 'high' ? SUCCESS : e.applicability === 'medium' ? WARNING : DIM;
                console.log(`  ${DIM(e.id || '?')} ${appColor(String(e.applicability || '?').padEnd(6))} ${DIM(e.area || '')}`);
                console.log(`    ${(e.finding || '').slice(0, 100)}`);
                if (e.learnings) console.log(`    ${DIM('→ ' + e.learnings.slice(0, 80))}`);
              }
              if (results.length > 15) {
                console.log(`  ${DIM(`... and ${results.length - 15} more`)}`);
              }
            }
            console.log('');
          }
        } catch (e) {
          console.log(`  ${ERROR(e.message)}`);
        }
        rl.prompt();
        return;
      }

      // ── Cleanup Command ──────────────────────────────────────────────────
      if (line === ':cleanup') {
        try {
          const { runActionPipeline } = await import('./hydra-action-pipeline.mjs');
          const { scanArchivableTasks, scanOldHandoffs, scanStaleBranches,
                  scanStaleTasks, scanAbandonedSuggestions, scanOldCheckpoints,
                  scanOldArtifacts, enrichCleanupWithSitrep,
                  executeCleanupAction } = await import('./hydra-cleanup.mjs');

          await runActionPipeline(rl, {
            title: 'Cleanup',
            scanners: [
              () => scanArchivableTasks(baseUrl),
              () => scanOldHandoffs(baseUrl),
              () => scanStaleBranches(config.projectRoot),
              () => scanStaleTasks(baseUrl),
              () => scanAbandonedSuggestions(),
              () => scanOldCheckpoints(config.projectRoot),
              () => scanOldArtifacts(config.projectRoot),
            ],
            enrich: (items) => enrichCleanupWithSitrep(items, { baseUrl, projectRoot: config.projectRoot }),
            preSelectFilter: (item) => item.category === 'archive',
            executeFn: (item) => executeCleanupAction(item, { baseUrl, projectRoot: config.projectRoot }),
            projectRoot: config.projectRoot,
            baseUrl,
          });
        } catch (e) {
          console.log(`  ${ERROR(e.message)}`);
        }
        rl.prompt();
        return;
      }

      // ── Worker Commands ──────────────────────────────────────────────────
      if (line === ':workers' || line.startsWith(':workers ')) {
        const workerArgs = line.slice(':workers'.length).trim().toLowerCase();

        if (!workerArgs) {
          // Show status of all workers
          console.log('');
          console.log(sectionHeader('Agent Workers'));
          if (workers.size === 0) {
            console.log(`  ${DIM('No workers running. Dispatch a prompt to start workers.')}`);
          } else {
            for (const [name, w] of workers) {
              const statusIcon = w.status === 'working' ? WARNING('\u25CF')
                : w.status === 'idle' ? SUCCESS('\u25CB')
                : w.status === 'error' ? ERROR('\u25CF')
                : DIM('\u25CB');
              const task = w.currentTask ? `${pc.white(w.currentTask.taskId)} ${DIM(short(w.currentTask.title, 40))}` : DIM('no task');
              const up = w.uptime > 0 ? DIM(`  up ${formatUptime(w.uptime)}`) : '';
              const perm = DIM(`  (${w.permissionMode})`);
              console.log(`  ${statusIcon} ${colorAgent(name)} ${pc.white(w.status)}  ${task}${up}${perm}`);
            }
          }
          console.log('');
          console.log(DIM('  :workers start [agent]   Start worker(s)'));
          console.log(DIM('  :workers stop [agent]    Stop worker(s)'));
          console.log(DIM('  :workers restart [agent] Restart worker(s)'));
          console.log(DIM('  :workers mode <mode>     Change permission mode'));
          console.log('');
          rl.prompt();
          return;
        }

        const parts = workerArgs.split(/\s+/);
        const subCmd = parts[0];
        const targetAgent = parts[1] || null;

        if (subCmd === 'start') {
          const toStart = targetAgent ? [targetAgent] : agents;
          for (const a of toStart) {
            if (!agents.includes(a)) {
              console.log(`  ${ERROR('Unknown agent:')} ${a}`);
              continue;
            }
            startAgentWorker(a, baseUrl, { rl });
          }
        } else if (subCmd === 'stop') {
          const toStop = targetAgent ? [targetAgent] : [...workers.keys()];
          for (const a of toStop) {
            stopAgentWorker(a);
            console.log(`  ${SUCCESS('\u2713')} ${colorAgent(a)} worker stopped`);
          }
        } else if (subCmd === 'restart') {
          const toRestart = targetAgent ? [targetAgent] : [...workers.keys()];
          for (const a of toRestart) {
            stopAgentWorker(a);
            startAgentWorker(a, baseUrl, { rl });
          }
        } else if (subCmd === 'mode') {
          const newMode = parts[1];
          if (!newMode || !['auto-edit', 'full-auto'].includes(newMode)) {
            console.log(`  ${ERROR('Usage:')} :workers mode auto-edit | full-auto`);
          } else {
            for (const [, w] of workers) {
              w.setPermissionMode(newMode);
            }
            console.log(`  ${SUCCESS('\u2713')} Worker permission mode ${DIM('\u2192')} ${ACCENT(newMode)}`);
          }
        } else {
          console.log(`  ${ERROR('Unknown subcommand:')} ${subCmd}`);
          console.log(`  ${DIM('Usage: :workers [start|stop|restart|mode] [agent]')}`);
        }

        rl.prompt();
        return;
      }

      if (line.startsWith(':watch ')) {
        const watchAgent = line.slice(':watch '.length).trim().toLowerCase();
        if (!watchAgent || !agents.includes(watchAgent)) {
          console.log(`  ${ERROR('Usage:')} :watch <agent>  (${agents.join(', ')})`);
          rl.prompt();
          return;
        }
        setAgentExecMode(watchAgent, 'terminal');
        launchAgentTerminals([watchAgent], baseUrl);
        console.log(`  ${DIM('Terminal opened for observation. Worker continues running in background.')}`);
        rl.prompt();
        return;
      }

      // ── GitHub Commands ──────────────────────────────────────────────────
      if (line === ':github' || line.startsWith(':github ')) {
        const ghArg = line.slice(':github'.length).trim().toLowerCase();

        if (!ghArg) {
          // Status dashboard
          const installed = isGhAvailable();
          console.log(`  ${label('gh CLI')}      ${installed ? SUCCESS('installed') : ERROR('not found')}`);
          if (installed) {
            const authed = isGhAuthenticated();
            console.log(`  ${label('Auth')}        ${authed ? SUCCESS('authenticated') : WARNING('not authenticated — run: gh auth login')}`);
            if (authed) {
              const repo = detectRepo(config.projectRoot);
              if (repo) {
                console.log(`  ${label('Repo')}        ${SUCCESS(`${repo.owner}/${repo.repo}`)} ${DIM(`(default: ${repo.defaultBranch})`)}`);
                const prs = listPRs({ cwd: config.projectRoot });
                console.log(`  ${label('Open PRs')}    ${prs.length}`);
              } else {
                console.log(`  ${label('Repo')}        ${WARNING('not detected (not a GitHub repo?)')}`);
              }
            }
          }
          const ghCfg = getGitHubConfig();
          console.log(`  ${label('Config')}      enabled=${ghCfg.enabled}, draft=${ghCfg.draft}, labels=[${ghCfg.labels.join(',')}]`);
        } else if (ghArg === 'prs') {
          if (!isGhAvailable()) {
            console.log(`  ${ERROR('gh CLI not found.')} Install: https://cli.github.com`);
            rl.prompt();
            return;
          }
          const prs = listPRs({ cwd: config.projectRoot });
          if (prs.length === 0) {
            console.log(`  ${DIM('No open pull requests.')}`);
          } else {
            console.log(`  ${pc.bold(`Open PRs (${prs.length}):`)}`);
            for (const pr of prs) {
              console.log(`    ${ACCENT(`#${pr.number}`)} ${pr.title} ${DIM(`(${pr.headRefName} by ${pr.author})`)}`);
            }
          }
        } else {
          console.log(`  ${ERROR('Usage:')} :github [prs]`);
        }

        rl.prompt();
        return;
      }

      if (line === ':pr' || line.startsWith(':pr ')) {
        const prArgs = line.slice(':pr'.length).trim();
        const prCmd = prArgs.split(/\s+/)[0]?.toLowerCase() || '';
        const prRest = prArgs.slice(prCmd.length).trim();

        if (!isGhAvailable()) {
          console.log(`  ${ERROR('gh CLI not found.')} Install: https://cli.github.com`);
          rl.prompt();
          return;
        }

        if (prCmd === 'create') {
          const branch = prRest || undefined;
          console.log(`  ${DIM('Pushing branch and creating PR...')}`);
          const result = pushBranchAndCreatePR({ cwd: config.projectRoot, branch });
          if (result.ok) {
            console.log(`  ${SUCCESS('PR created:')} ${result.url}`);
          } else {
            console.log(`  ${ERROR('Failed:')} ${result.error || 'unknown error'}`);
          }
        } else if (prCmd === 'list') {
          const prs = listPRs({ cwd: config.projectRoot });
          if (prs.length === 0) {
            console.log(`  ${DIM('No open pull requests.')}`);
          } else {
            console.log(`  ${pc.bold(`Open PRs (${prs.length}):`)}`);
            for (const pr of prs) {
              console.log(`    ${ACCENT(`#${pr.number}`)} ${pr.title} ${DIM(`(${pr.headRefName} by ${pr.author})`)}`);
            }
          }
        } else if (prCmd === 'view') {
          if (!prRest) {
            console.log(`  ${ERROR('Usage:')} :pr view <number>`);
            rl.prompt();
            return;
          }
          const pr = getPR({ cwd: config.projectRoot, ref: prRest });
          if (!pr) {
            console.log(`  ${ERROR('PR not found:')} ${prRest}`);
          } else {
            console.log(`  ${ACCENT(`#${pr.number}`)} ${pr.title}`);
            console.log(`  ${label('State')}       ${pr.state}`);
            console.log(`  ${label('Branch')}      ${pr.headRefName} → ${pr.baseRefName}`);
            console.log(`  ${label('Author')}      ${pr.author?.login || pr.author || '?'}`);
            console.log(`  ${label('Changes')}     ${SUCCESS(`+${pr.additions || 0}`)} ${ERROR(`-${pr.deletions || 0}`)}`);
            if (pr.url) console.log(`  ${label('URL')}         ${pr.url}`);
          }
        } else {
          console.log(`  ${ERROR('Usage:')} :pr <create|list|view> [args]`);
        }

        rl.prompt();
        return;
      }

      // ── Concierge (Chat) Commands ─────────────────────────────────────────
      if (line === ':chat' || line.startsWith(':chat ')) {
        const chatArg = line.slice(':chat'.length).trim().toLowerCase();

        if (chatArg === 'off') {
          conciergeActive = false;
          setActiveMode(mode);
          rl.setPrompt(normalPrompt);
          console.log(`  ${SUCCESS('\u2713')} Concierge ${DIM('disabled')}`);
          drawStatusBar();
        } else if (chatArg === 'reset') {
          resetConversation();
          console.log(`  ${SUCCESS('\u2713')} Conversation history cleared`);
        } else if (chatArg === 'stats') {
          const cStats = getConciergeStats();
          const ap = getActiveProvider();
          console.log('');
          console.log(sectionHeader('Concierge Stats'));
          console.log(label('Provider', pc.white(ap ? `${ap.provider}` : 'none')));
          console.log(label('Model', pc.white(ap ? ap.model : getConciergeConfig().model)));
          if (ap?.isFallback) console.log(label('Note', WARNING('Using fallback provider')));
          console.log(label('Turns', pc.white(String(cStats.turns))));
          console.log(label('Prompt tokens', pc.white(String(cStats.promptTokens))));
          console.log(label('Completion tokens', pc.white(String(cStats.completionTokens))));
          console.log(label('Total tokens', pc.white(String(cStats.promptTokens + cStats.completionTokens))));
          console.log('');
        } else if (chatArg === 'model' || chatArg.startsWith('model ')) {
          const modelName = chatArg.slice('model'.length).trim();
          if (!modelName) {
            // Show active model + fallback chain
            const ap = getActiveProvider();
            const chain = buildFallbackChain();
            console.log('');
            console.log(sectionHeader('Concierge Model'));
            console.log(label('Active', pc.white(ap ? `${ap.provider}:${ap.model}${ap.isFallback ? ' (fallback)' : ''}` : 'none yet')));
            console.log(label('Chain', ''));
            for (const entry of chain) {
              const status = entry.available ? SUCCESS('\u2713') : ERROR('\u2717');
              console.log(`    ${status} ${entry.provider}: ${pc.white(entry.model)}`);
            }
            console.log('');
          } else {
            // Switch model
            try {
              switchConciergeModel(modelName);
              const ap = getActiveProvider();
              rl.setPrompt(buildConciergePrompt());
              console.log(`  ${SUCCESS('\u2713')} Concierge model switched to ${ACCENT(ap.model)} ${DIM(`(${ap.provider})`)}`);
            } catch (err) {
              console.log(`  ${ERROR('Failed to switch model:')} ${err.message}`);
            }
          }
        } else if (chatArg === 'export') {
          try {
            const fs = await import('fs');
            const exportData = exportConversation();
            const coordDir = path.join(config.projectRoot, 'docs', 'coordination');
            fs.mkdirSync(coordDir, { recursive: true });
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const exportPath = path.join(coordDir, `concierge_export_${timestamp}.json`);
            fs.writeFileSync(exportPath, JSON.stringify(exportData, null, 2) + '\n', 'utf8');
            console.log(`  ${SUCCESS('\u2713')} Conversation exported to ${DIM(path.relative(config.projectRoot, exportPath))}`);
          } catch (err) {
            console.log(`  ${ERROR('Export failed:')} ${err.message}`);
          }
        } else {
          // Toggle
          if (!isConciergeAvailable()) {
            console.log(`  ${ERROR('Concierge unavailable')} — set an API key (OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY)`);
            rl.prompt();
            return;
          }
          conciergeActive = !conciergeActive;
          if (conciergeActive) {
            setActiveMode('chat');
            rl.setPrompt(buildConciergePrompt());
            showConciergeWelcome();
            console.log(`  ${SUCCESS('\u2713')} Concierge ${ACCENT('enabled')} ${DIM(`(${getConciergeModelLabel()})`)}`);
          } else {
            setActiveMode(mode);
            rl.setPrompt(normalPrompt);
            console.log(`  ${SUCCESS('\u2713')} Concierge ${DIM('disabled')}`);
          }
          drawStatusBar();
        }

        rl.prompt();
        return;
      }

      // ── Actualize Commands ───────────────────────────────────────────────
      if (line === ':actualize' || line.startsWith(':actualize ')) {
        const actualizeArg = line.slice(':actualize'.length).trim().toLowerCase();

        const reviewScript = path.join(HYDRA_ROOT, 'lib', 'hydra-actualize-review.mjs');
        const runScript = path.join(HYDRA_ROOT, 'lib', 'hydra-actualize.mjs');

        if (actualizeArg === 'status') {
          const child = spawnHydraNode(reviewScript, ['status'], {
            cwd: config.projectRoot,
            stdio: 'inherit',
            shell: process.platform === 'win32',
          });
          child.on('close', () => { rl.prompt(); });
          return;
        }

        if (actualizeArg === 'review') {
          const cwd = config.projectRoot;
          rl.pause();
          destroyStatusBar();
          const child = spawnHydraNode(reviewScript, ['review'], {
            cwd,
            stdio: 'inherit',
            shell: process.platform === 'win32',
          });
          child.on('close', () => {
            initStatusBar(agents);
            rl.resume();
            rl.prompt();
          });
          return;
        }

        if (actualizeArg === 'clean') {
          const child = spawnHydraNode(reviewScript, ['clean'], {
            cwd: config.projectRoot,
            stdio: 'inherit',
            shell: process.platform === 'win32',
          });
          child.on('close', () => { rl.prompt(); });
          return;
        }

        const isDryRun = actualizeArg === 'dry-run';
        const cfg = loadHydraConfig();
        const baseBranch = cfg.evolve?.baseBranch || cfg.nightly?.baseBranch || 'dev';
        const cwd = config.projectRoot;

        // Pre-flight: must be on base branch
        const curBranch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim();
        if (curBranch !== baseBranch) {
          const brExists = spawnSync('git', ['rev-parse', '--verify', baseBranch], { cwd, encoding: 'utf8' }).status === 0;
          if (!brExists) {
            console.log(`  ${ACCENT(`Creating '${baseBranch}' branch from '${curBranch}'...`)}`);
            spawnSync('git', ['branch', baseBranch], { cwd });
          }
          console.log(`  ${ACCENT(`Switching from '${curBranch}' to '${baseBranch}'...`)}`);
          const sw = spawnSync('git', ['checkout', baseBranch], { cwd, encoding: 'utf8' });
          if (sw.status !== 0) {
            console.log(`  ${ERROR(`Failed to switch branch: ${(sw.stderr || '').trim()}`)}`);
            rl.prompt();
            return;
          }
        }

        // Pre-flight: clean working tree (offer auto-commit)
        const status = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).stdout.trim();
        if (status) {
          const confirm = await promptChoice(rl, {
            message: 'Working tree is not clean. Auto-commit before actualize?',
            choices: [
              { label: 'Yes — commit all changes', value: 'yes' },
              { label: 'No — abort', value: 'no' },
            ],
            defaultIndex: 0,
            timeout: 30_000,
          });
          if (confirm.value !== 'yes') {
            console.log(`  ${WARNING('Aborted — commit or stash changes first.')}`);
            rl.prompt();
            return;
          }
          const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          spawnSync('git', ['add', '-A'], { cwd });
          spawnSync('git', ['commit', '-m', `chore: auto-commit before actualize run ${ts}`], { cwd });
          console.log(`  ${SUCCESS('\u2713')} Changes committed.`);
        }

        const actualizeArgs = [runScript, `project=${cwd}`];
        if (isDryRun) actualizeArgs.push('--dry-run');

        if (!isDryRun) {
          const modeChoice = await promptChoice(rl, {
            message: 'Actualize intensity?',
            context: { default: 'balanced' },
            choices: [
              { label: 'Balanced (Recommended)', value: 'balanced', description: 'Good default: moderate time/tasks, discovery on' },
              { label: 'Quick', value: 'quick', description: 'Fewer tasks, shorter run' },
              { label: 'Deep', value: 'deep', description: 'More tasks, longer run' },
            ],
            defaultIndex: 0,
            timeout: 60_000,
          });

          if (modeChoice.value === 'quick') actualizeArgs.push('max-tasks=3', 'max-hours=1');
          else if (modeChoice.value === 'deep') actualizeArgs.push('max-tasks=8', 'max-hours=6');

          const discoveryChoice = await promptChoice(rl, {
            message: 'Enable AI discovery? (agent suggests improvement tasks)',
            context: { default: 'on' },
            choices: [
              { label: 'Yes — discover + scan', value: 'yes' },
              { label: 'No — scan only', value: 'no' },
            ],
            defaultIndex: 0,
            timeout: 20_000,
          });
          if (discoveryChoice.value === 'no') actualizeArgs.push('--no-discovery');

          // Let the user choose tasks if they want
          const selectChoice = await promptChoice(rl, {
            message: 'Select tasks interactively?',
            context: { default: 'yes' },
            choices: [
              { label: 'Yes (Recommended)', value: 'yes', description: 'Pick tasks before execution' },
              { label: 'No', value: 'no', description: 'Run top-ranked tasks automatically' },
            ],
            defaultIndex: 0,
            timeout: 20_000,
          });
          if (selectChoice.value === 'yes') actualizeArgs.push('--interactive');
        }

        const label = isDryRun ? 'actualize dry-run' : 'actualize run';
        console.log(`  ${ACCENT(`Launching ${label}...`)}`);
        rl.pause();
        destroyStatusBar();
        const child = spawnHydraNode(actualizeArgs[0], actualizeArgs.slice(1), {
          cwd,
          stdio: 'inherit',
          shell: process.platform === 'win32',
        });
        child.on('close', (code) => {
          initStatusBar(agents);
          rl.resume();
          if (code === 0) {
            console.log(`  ${SUCCESS('\u2713')} Actualize ${isDryRun ? 'dry-run' : 'run'} complete`);
          } else {
            console.log(`  ${ERROR(`Actualize exited with code ${code}`)}`);
          }
          rl.prompt();
        });
        return;
      }

      // ── Nightly Commands ─────────────────────────────────────────────────
      if (line === ':nightly' || line.startsWith(':nightly ')) {
        const nightlyArg = line.slice(':nightly'.length).trim().toLowerCase();

        if (nightlyArg === 'status') {
          const reviewScript = path.join(HYDRA_ROOT, 'lib', 'hydra-nightly-review.mjs');
          const child = spawnHydraNode(reviewScript, ['status'], {
            cwd: config.projectRoot,
            stdio: 'inherit',
            shell: process.platform === 'win32',
          });
          child.on('close', () => { rl.prompt(); });
          return;
        }

        if (nightlyArg === 'review') {
          const cwd = config.projectRoot;
          rl.pause();
          destroyStatusBar();
          const reviewScript = path.join(HYDRA_ROOT, 'lib', 'hydra-nightly-review.mjs');
          const child = spawnHydraNode(reviewScript, ['review'], {
            cwd,
            stdio: 'inherit',
            shell: process.platform === 'win32',
          });
          child.on('close', () => {
            initStatusBar(agents);
            rl.resume();
            rl.prompt();
          });
          return;
        }

        if (nightlyArg === 'clean') {
          const reviewScript = path.join(HYDRA_ROOT, 'lib', 'hydra-nightly-review.mjs');
          const child = spawnHydraNode(reviewScript, ['clean'], {
            cwd: config.projectRoot,
            stdio: 'inherit',
            shell: process.platform === 'win32',
          });
          child.on('close', () => { rl.prompt(); });
          return;
        }

        // ── Launch nightly (with or without dry-run) ───────────────────────
        const isDryRun = nightlyArg === 'dry-run';

        // Interactive setup: mode, limits, discovery
        const cfg = loadHydraConfig();
        const nightlyCfg = cfg.nightly;
        const baseBranch = nightlyCfg.baseBranch || 'dev';
        const cwd = config.projectRoot;

        // Pre-flight: must be on base branch
        const curBranch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim();
        if (curBranch !== baseBranch) {
          const brExists = spawnSync('git', ['rev-parse', '--verify', baseBranch], { cwd, encoding: 'utf8' }).status === 0;
          if (!brExists) {
            console.log(`  ${ACCENT(`Creating '${baseBranch}' branch from '${curBranch}'...`)}`);
            spawnSync('git', ['branch', baseBranch], { cwd });
          }
          console.log(`  ${ACCENT(`Switching from '${curBranch}' to '${baseBranch}'...`)}`);
          const sw = spawnSync('git', ['checkout', baseBranch], { cwd, encoding: 'utf8' });
          if (sw.status !== 0) {
            console.log(`  ${ERROR(`Failed to switch branch: ${(sw.stderr || '').trim()}`)}`);
            rl.prompt();
            return;
          }
        }

        // Pre-flight: clean working tree
        const status = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).stdout.trim();
        if (status) {
          const confirm = await promptChoice(rl, {
            message: 'Working tree is not clean. Auto-commit before nightly?',
            choices: [
              { label: 'Yes \u2014 commit all changes', value: 'yes' },
              { label: 'No \u2014 abort', value: 'no' },
            ],
            defaultIndex: 0,
            timeout: 30_000,
          });
          if (confirm.value !== 'yes') {
            console.log(`  ${WARNING('Aborted \u2014 commit or stash changes first.')}`);
            rl.prompt();
            return;
          }
          const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          spawnSync('git', ['add', '-A'], { cwd });
          spawnSync('git', ['commit', '-m', `chore: auto-commit before nightly run ${ts}`], { cwd });
          console.log(`  ${SUCCESS('\u2713')} Changes committed.`);
        }

        // Interactive setup prompts (skip for dry-run with no extra arg)
        const nightlyArgs = [path.join(HYDRA_ROOT, 'lib', 'hydra-nightly.mjs'), `project=${cwd}`];

        if (isDryRun) {
          nightlyArgs.push('--dry-run');
        }

        if (!isDryRun) {
          // 1. Execution mode
          const modeChoice = await promptChoice(rl, {
            message: 'Execution mode?',
            context: { default: 'balanced' },
            choices: [
              { label: 'Balanced', value: 'balanced', description: 'Default config: moderate budget & time limits' },
              { label: 'Quick / Fast', value: 'quick', description: 'Fewer tasks, shorter timeout, economy models' },
              { label: 'Deep / Thorough', value: 'deep', description: 'More tasks, longer timeout, high reasoning' },
              { label: 'Auto / Intuitive', value: 'auto', description: 'Let agents switch tiers per-task complexity' },
            ],
            defaultIndex: 0,
            timeout: 60_000,
          });

          if (modeChoice.value === 'quick') {
            nightlyArgs.push('max-tasks=3', 'max-hours=1');
          } else if (modeChoice.value === 'deep') {
            nightlyArgs.push('max-tasks=10', 'max-hours=8');
          } else if (modeChoice.value === 'auto') {
            // auto uses config defaults but enables discovery
            nightlyArgs.push('max-tasks=7', 'max-hours=6');
          }
          // balanced = config defaults (no override)

          // 2. Max tasks
          const maxTasksDefault = modeChoice.value === 'quick' ? '3'
            : modeChoice.value === 'deep' ? '10'
            : modeChoice.value === 'auto' ? '7'
            : String(nightlyCfg.maxTasks || 5);

          const tasksChoice = await promptChoice(rl, {
            message: `Max tasks to execute?`,
            context: { default: maxTasksDefault },
            choices: [
              { label: `${maxTasksDefault} (default)`, value: maxTasksDefault },
              { label: '3 (light)', value: '3' },
              { label: '5 (moderate)', value: '5' },
              { label: '10 (heavy)', value: '10' },
            ],
            defaultIndex: 0,
            freeform: true,
            timeout: 30_000,
          });
          const maxTasks = parseInt(tasksChoice.value, 10);
          if (!isNaN(maxTasks) && maxTasks > 0) {
            // Remove any previous max-tasks from mode preset
            const idx = nightlyArgs.findIndex(a => a.startsWith('max-tasks='));
            if (idx !== -1) nightlyArgs.splice(idx, 1);
            nightlyArgs.push(`max-tasks=${maxTasks}`);
          }

          // 3. Max hours
          const maxHoursDefault = modeChoice.value === 'quick' ? '1'
            : modeChoice.value === 'deep' ? '8'
            : modeChoice.value === 'auto' ? '6'
            : String(nightlyCfg.maxHours || 4);

          const hoursChoice = await promptChoice(rl, {
            message: `Max hours?`,
            context: { default: maxHoursDefault },
            choices: [
              { label: `${maxHoursDefault}h (default)`, value: maxHoursDefault },
              { label: '1h (quick)', value: '1' },
              { label: '4h (standard)', value: '4' },
              { label: '8h (overnight)', value: '8' },
            ],
            defaultIndex: 0,
            freeform: true,
            timeout: 30_000,
          });
          const maxHours = parseFloat(hoursChoice.value);
          if (!isNaN(maxHours) && maxHours > 0) {
            const idx = nightlyArgs.findIndex(a => a.startsWith('max-hours='));
            if (idx !== -1) nightlyArgs.splice(idx, 1);
            nightlyArgs.push(`max-hours=${maxHours}`);
          }

          // 4. AI discovery toggle
          const discoveryChoice = await promptChoice(rl, {
            message: 'Enable AI discovery? (agent suggests improvement tasks)',
            context: { default: nightlyCfg.sources?.aiDiscovery !== false ? 'on' : 'off' },
            choices: [
              { label: 'Yes \u2014 discover + scan', value: 'yes' },
              { label: 'No \u2014 scan only', value: 'no' },
            ],
            defaultIndex: nightlyCfg.sources?.aiDiscovery !== false ? 0 : 1,
            timeout: 20_000,
          });
          if (discoveryChoice.value === 'no') {
            nightlyArgs.push('--no-discovery');
          }

          // Enable interactive task selection (nightly child inherits stdio)
          nightlyArgs.push('--interactive');
        }

        // Launch
        const label = isDryRun ? 'nightly dry-run' : 'nightly run';
        console.log(`  ${ACCENT(`Launching ${label}...`)}`);
        rl.pause();
        destroyStatusBar();
        const child = spawnHydraNode(nightlyArgs[0], nightlyArgs.slice(1), {
          cwd,
          stdio: 'inherit',
          shell: process.platform === 'win32',
        });
        child.on('close', (code) => {
          initStatusBar(agents);
          rl.resume();
          if (code === 0) {
            console.log(`  ${SUCCESS('\u2713')} Nightly ${isDryRun ? 'dry-run' : 'run'} complete`);
          } else {
            console.log(`  ${ERROR(`Nightly exited with code ${code}`)}`);
          }
          rl.prompt();
        });
        return;
      }

      // ── Evolve Commands ──────────────────────────────────────────────────
      if (line === ':evolve' || line.startsWith(':evolve ')) {
        const evolveArg = line.slice(':evolve'.length).trim().toLowerCase();

        if (evolveArg === 'status') {
          // Show latest evolve report
          const reviewScript = path.join(HYDRA_ROOT, 'lib', 'hydra-evolve-review.mjs');
          const child = spawnHydraNode(reviewScript, ['status'], {
            cwd: config.projectRoot,
            stdio: 'inherit',
            shell: process.platform === 'win32',
          });
          child.on('close', () => { rl.prompt(); });
        } else if (evolveArg === 'knowledge') {
          const reviewScript = path.join(HYDRA_ROOT, 'lib', 'hydra-evolve-review.mjs');
          const child = spawnHydraNode(reviewScript, ['knowledge'], {
            cwd: config.projectRoot,
            stdio: 'inherit',
            shell: process.platform === 'win32',
          });
          child.on('close', () => { rl.prompt(); });
        } else if (evolveArg === 'resume' || evolveArg.startsWith('resume ')) {
          // Resume incomplete/interrupted evolve session
          const extraArgs = evolveArg.slice('resume'.length).trim();
          const cfg = loadHydraConfig();
          const baseBranch = cfg.evolve?.baseBranch || 'dev';
          const cwd = config.projectRoot;

          // Same pre-flight as regular :evolve
          const curBranch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim();
          if (curBranch !== baseBranch) {
            const branchExists = spawnSync('git', ['rev-parse', '--verify', baseBranch], { cwd, encoding: 'utf8' }).status === 0;
            if (!branchExists) {
              console.log(`  ${ACCENT(`Creating '${baseBranch}' branch from '${curBranch}'...`)}`);
              spawnSync('git', ['branch', baseBranch], { cwd });
            }
            console.log(`  ${ACCENT(`Switching from '${curBranch}' to '${baseBranch}'...`)}`);
            const sw = spawnSync('git', ['checkout', baseBranch], { cwd, encoding: 'utf8' });
            if (sw.status !== 0) {
              console.log(`  ${ERROR(`Failed to switch branch: ${(sw.stderr || '').trim()}`)}`);
              rl.prompt();
              return;
            }
          }

          const status = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).stdout.trim();
          if (status) {
            const confirm = await promptChoice(rl, {
              message: 'Working tree is not clean. Auto-commit before evolve resume?',
              choices: [
                { label: 'Yes \u2014 commit all changes', value: 'yes' },
                { label: 'No \u2014 abort', value: 'no' },
              ],
              defaultIndex: 0,
              timeout: 30_000,
            });
            if (confirm.value !== 'yes') {
              console.log(`  ${WARNING('Aborted \u2014 commit or stash changes first.')}`);
              rl.prompt();
              return;
            }
            const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            spawnSync('git', ['add', '-A'], { cwd });
            spawnSync('git', ['commit', '-m', `chore: auto-commit before evolve session ${ts}`], { cwd });
            console.log(`  ${SUCCESS('\u2713')} Changes committed.`);
          }

          console.log(`  ${ACCENT('Resuming evolve session...')}`);
          rl.pause();
          destroyStatusBar();
          const evolveScript = path.join(HYDRA_ROOT, 'lib', 'hydra-evolve.mjs');
          const evolveArgs = [evolveScript, `project=${cwd}`, 'resume=1'];
          if (extraArgs) {
            evolveArgs.push(...extraArgs.split(/\s+/).filter(Boolean));
          }
          const child = spawnHydraNode(evolveArgs[0], evolveArgs.slice(1), {
            cwd,
            stdio: 'inherit',
            shell: process.platform === 'win32',
          });
          child.on('close', (code) => {
            initStatusBar(agents);
            rl.resume();
            if (code === 0) {
              console.log(`  ${SUCCESS('\u2713')} Evolve session complete`);
            } else {
              console.log(`  ${ERROR(`Evolve exited with code ${code}`)}`);
            }
            rl.prompt();
          });
        } else {
          // Launch evolve session — pre-flight: branch switch + auto-commit
          const cfg = loadHydraConfig();
          const baseBranch = cfg.evolve?.baseBranch || 'dev';
          const cwd = config.projectRoot;

          // Switch to base branch if needed (create it if it doesn't exist)
          const curBranch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim();
          if (curBranch !== baseBranch) {
            // Check if base branch exists
            const branchExists = spawnSync('git', ['rev-parse', '--verify', baseBranch], { cwd, encoding: 'utf8' }).status === 0;
            if (!branchExists) {
              console.log(`  ${ACCENT(`Creating '${baseBranch}' branch from '${curBranch}'...`)}`);
              spawnSync('git', ['branch', baseBranch], { cwd });
            }
            console.log(`  ${ACCENT(`Switching from '${curBranch}' to '${baseBranch}'...`)}`);
            const sw = spawnSync('git', ['checkout', baseBranch], { cwd, encoding: 'utf8' });
            if (sw.status !== 0) {
              console.log(`  ${ERROR(`Failed to switch branch: ${(sw.stderr || '').trim()}`)}`);
              rl.prompt();
              return;
            }
          }

          // Auto-commit dirty working tree
          const status = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).stdout.trim();
          if (status) {
            const confirm = await promptChoice(rl, {
              message: 'Working tree is not clean. Auto-commit before evolve?',
              choices: [
                { label: 'Yes \u2014 commit all changes', value: 'yes' },
                { label: 'No \u2014 abort', value: 'no' },
              ],
              defaultIndex: 0,
              timeout: 30_000,
            });
            if (confirm.value !== 'yes') {
              console.log(`  ${WARNING('Aborted \u2014 commit or stash changes first.')}`);
              rl.prompt();
              return;
            }
            const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            spawnSync('git', ['add', '-A'], { cwd });
            spawnSync('git', ['commit', '-m', `chore: auto-commit before evolve session ${ts}`], { cwd });
            console.log(`  ${SUCCESS('\u2713')} Changes committed.`);
          }

          console.log(`  ${ACCENT('Launching evolve session...')}`);
          rl.pause();
          destroyStatusBar();
          const evolveScript = path.join(HYDRA_ROOT, 'lib', 'hydra-evolve.mjs');
          const evolveArgs = [evolveScript, `project=${cwd}`];
          if (evolveArg) {
            evolveArgs.push(...evolveArg.split(/\s+/).filter(Boolean));
          }
          const child = spawnHydraNode(evolveArgs[0], evolveArgs.slice(1), {
            cwd,
            stdio: 'inherit',
            shell: process.platform === 'win32',
          });
          child.on('close', (code) => {
            initStatusBar(agents);
            rl.resume();
            if (code === 0) {
              console.log(`  ${SUCCESS('\u2713')} Evolve session complete`);
            } else {
              console.log(`  ${ERROR(`Evolve exited with code ${code}`)}`);
            }
            rl.prompt();
          });
        }
        return;
      }

      // Catch unrecognized : commands — fuzzy match locally first, then concierge
      if (line.startsWith(':')) {
        // Try local fuzzy matching first (saves API call)
        const fuzzyMatch = fuzzyMatchCommand(line);
        if (fuzzyMatch) {
          console.log(`  ${DIM('Did you mean')} ${ACCENT(fuzzyMatch)}${DIM('?')}`);
          rl.prompt();
          return;
        }

        if (conciergeActive) {
          const modelLbl = getConciergeModelLabel();
          try {
            const hint = `The user typed "${line}" which is not a recognized command. Suggest the correct command.`;
            const cmdResult = await conciergeTurn(hint, {
              context: { projectName: config.projectName, projectRoot: config.projectRoot, mode },
            });
            const cmdResponse = cmdResult.response || cmdResult.fullResponse || '';
            if (cmdResponse) {
              process.stdout.write(`\n  ${pc.blue('\u2B22')} ${DIM(modelLbl)}\n  `);
              process.stdout.write(pc.blue(cmdResponse));
              process.stdout.write('\n\n');
            }
          } catch {
            console.log(`  ${ERROR('Unknown command:')} ${line}`);
            console.log(`  ${DIM('Type :help for available commands')}`);
          }
        } else {
          console.log(`  ${ERROR('Unknown command:')} ${line}`);
          console.log(`  ${DIM('Type :help for available commands')}`);
        }
        rl.prompt();
        return;
      }

      // ── Sidecar: auto-route to concierge while dispatch/council is running ──
      if (dispatchDepth > 0 && !line.startsWith(':') && !isChoiceActive()) {
        if (sidecaring) {
          process.stdout.write(`\r\x1b[2K  ${DIM(`${pc.blue('\u2B22')} still thinking\u2026`)}\n`);
          rl.prompt(true);
          return;
        }
        if (!isConciergeAvailable()) {
          process.stdout.write(`\r\x1b[2K  ${DIM(`${pc.blue('\u2B22')} no concierge available while agents run`)}\n`);
          rl.prompt(true);
          return;
        }
        const sidecarModel = getConciergeModelLabel();
        const sidecarContext = {
          projectName: config.projectName,
          projectRoot: config.projectRoot,
          mode,
          sidecarNote: 'User is asking this while a dispatch/council is running in the background. Be brief. Ignore any [DISPATCH] intent.',
        };
        try {
          const activeWorkerNames = [];
          for (const [name, w] of workers) {
            if (w.status === 'running') activeWorkerNames.push(name);
          }
          if (activeWorkerNames.length > 0) sidecarContext.activeWorkers = activeWorkerNames;
        } catch { /* non-critical */ }
        try { sidecarContext.codebaseBaseline = getBaselineContext(); } catch { /* non-critical */ }
        sidecaring = true;
        try {
          const sidecarResult = await conciergeTurn(line, { context: sidecarContext });
          const sidecarText = sidecarResult.response || '';
          if (sidecarText) {
            process.stdout.write(`\r\x1b[2K  ${pc.blue('\u2B22')} ${DIM(sidecarModel)}\n  `);
            process.stdout.write(pc.blue(sidecarText));
            process.stdout.write('\n');
          }
        } catch (sidecarErr) {
          process.stdout.write(`\r\x1b[2K  ${DIM(`${pc.blue('\u2B22')} concierge error: ${sidecarErr.message.slice(0, 60)}`)}\n`);
        } finally {
          sidecaring = false;
          rl.prompt(true);
        }
        return;
      }

      // ── Force-dispatch escape hatch (bypass concierge with ! prefix) ────
      let dispatchLine = line;
      if (conciergeActive && line.startsWith('!')) {
        dispatchLine = line.slice(1).trim();
        if (!dispatchLine) {
          rl.prompt();
          return;
        }
        // Fall through to normal dispatch with the cleaned prompt
      }
      // ── Concierge Intercept ────────────────────────────────────────────
      else if (conciergeActive && !line.startsWith(':') && !isChoiceActive()) {
        // Gather enriched context for the system prompt
        let context = { projectName: config.projectName, projectRoot: config.projectRoot, mode };
        try {
          context.knownProjects = getRecentProjects();
        } catch { /* skip */ }
        try {
          const models = getModelSummary();
          const agentModels = {};
          for (const [agent, info] of Object.entries(models)) {
            if (agent === '_mode') continue;
            agentModels[agent] = info.active || 'unknown';
          }
          context.agentModels = agentModels;
        } catch { /* skip */ }
        try {
          const sessionStatus = await request('GET', baseUrl, '/session/status');
          context.openTasks = (sessionStatus.inProgressTasks || []).length + ((sessionStatus.pendingHandoffs || []).length);
        } catch {
          context.openTasks = 0;
        }

        // Phase 4: Enriched awareness context
        try {
          context.gitInfo = getGitInfo();
        } catch { /* skip */ }
        try {
          const events = await request('GET', baseUrl, '/events/replay?category=task&from=0');
          if (Array.isArray(events)) {
            context.recentCompletions = events
              .filter((e) => e.payload?.status === 'done' || e.payload?.event === 'task_result')
              .slice(-3)
              .map((e) => ({
                agent: e.payload?.agent || e.payload?.owner || 'unknown',
                title: e.payload?.title || e.payload?.taskId || '',
                taskId: e.payload?.taskId || '',
              }));
            context.recentErrors = events
              .filter((e) => e.payload?.passed === false || e.payload?.status === 'error')
              .slice(-3)
              .map((e) => ({
                agent: e.payload?.agent || 'system',
                error: e.payload?.snippet || e.payload?.error || 'verification failed',
              }));
          }
        } catch { /* skip */ }
        try {
          const activeWorkerNames = [];
          for (const [name, w] of workers) {
            if (w.status === 'running') activeWorkerNames.push(name);
          }
          if (activeWorkerNames.length > 0) context.activeWorkers = activeWorkerNames;
        } catch { /* skip */ }

        // Inject codebase baseline (always)
        try {
          context.codebaseBaseline = getBaselineContext();
        } catch { /* skip */ }

        // Always-on self-awareness (unless explicitly disabled via :aware/config)
        try {
          const sa = loadHydraConfig().selfAwareness || {};
          const enabled = sa.enabled !== false;
          const inject = sa.injectIntoConcierge !== false;
          if (enabled && inject) {
            const includeSnapshot = sa.includeSnapshot !== false;
            const includeIndex = sa.includeIndex !== false;
            const maxLines = Number.isFinite(sa.snapshotMaxLines) ? sa.snapshotMaxLines : 80;
            const maxChars = Number.isFinite(sa.indexMaxChars) ? sa.indexMaxChars : 7000;
            const refreshMs = Number.isFinite(sa.indexRefreshMs) ? sa.indexRefreshMs : 300_000;

            context.selfAwarenessKey = `on:${includeSnapshot ? 1 : 0}:${includeIndex ? 1 : 0}:${maxChars}`;

            if (includeSnapshot) {
              const snap = buildSelfSnapshot({ projectRoot: config.projectRoot, projectName: config.projectName });
              context.selfSnapshotBlock = formatSelfSnapshotForPrompt(snap, { maxLines });
            }

            if (includeIndex) {
              const now = Date.now();
              const key = `maxChars=${maxChars}`;
              if (!_selfIndexCache.block || _selfIndexCache.key !== key || (now - _selfIndexCache.builtAt) > refreshMs) {
                const idx = buildSelfIndex(HYDRA_ROOT);
                _selfIndexCache = { builtAt: now, key, block: formatSelfIndexForPrompt(idx, { maxChars }) };
              }
              context.selfIndexBlock = _selfIndexCache.block;
            }
          } else {
            context.selfAwarenessKey = 'off';
          }
        } catch { /* skip */ }

        // Detect situational queries and inject rich activity digest
        try {
          const { isSituational, focus } = detectSituationalQuery(line);
          if (isSituational) {
            const digest = await buildActivityDigest({ baseUrl, workers, focus });
            context.activityDigest = formatDigestForPrompt(digest, { focus });
          }
        } catch { /* fall back to sparse context */ }

        // Detect codebase queries and inject topic-specific context
        try {
          const { isCodebaseQuery, topic } = detectCodebaseQuery(line);
          if (isCodebaseQuery && topic) {
            context.codebaseContext = getTopicContext(topic);
            // Also search knowledge base for relevant findings
            const kbFindings = searchKnowledgeBase(topic);
            if (kbFindings) {
              context.codebaseContext += '\n\n' + kbFindings;
            }
          }
        } catch { /* skip */ }

        // Show spinner while waiting for full response (buffered, not streamed)
        const modelLbl = getConciergeModelLabel();
        const spinner = createSpinner(`${pc.blue('\u2B22')} ${DIM(modelLbl)} thinking...`, { style: 'stellar' });
        spinner.start();

        try {
          const result = await conciergeTurn(line, { context });
          spinner.stop();

          // Display complete response at once
          const responseText = result.response || result.fullResponse || '';
          if (responseText) {
            process.stdout.write(`\n  ${pc.blue('\u2B22')} ${DIM(modelLbl)}\n  `);
            process.stdout.write(pc.blue(responseText));
          }

          // Cost display
          const costStr = result.estimatedCost > 0
            ? ` ${DIM(`[~$${result.estimatedCost.toFixed(4)}]`)}`
            : '';
          process.stdout.write(`\n${costStr}\n`);

          // Update prompt in case model changed (fallback)
          rl.setPrompt(buildConciergePrompt());

          if (result.intent === 'dispatch') {
            console.log(`  ${ACCENT('\u2192')} Routing to dispatch: ${DIM(result.dispatchPrompt.slice(0, 80))}${result.dispatchPrompt.length > 80 ? '...' : ''}`);
            console.log('');
            dispatchLine = result.dispatchPrompt;
            // Fall through to normal dispatch below
          } else {
            rl.prompt();
            return;
          }
        } catch (err) {
          spinner.stop();
          console.log(`  ${ERROR('Concierge error:')} ${err.message}`);
          if (err.status === 401 || err.status === 403) {
            conciergeActive = false;
            setActiveMode(mode);
            rl.setPrompt(normalPrompt);
            console.log(`  ${DIM('Concierge auto-disabled due to auth error')}`);
          }
          rl.prompt();
          return;
        }
      }

      if (mode === 'auto' || mode === 'smart') {
        const classification = classifyPrompt(dispatchLine);
        const topic = extractTopic(dispatchLine);

        // Mode-aware agent selection: apply economy/performance multiplier
        const routingMode = loadHydraConfig().routing?.mode || 'balanced';
        let budgetState = null;
        try { budgetState = checkUsage(); } catch { /* skip */ }
        classification.suggestedAgent = bestAgentFor(classification.taskType, { mode: routingMode, budgetState });

        // Pre-dispatch gate: show classification and let user confirm/modify
        const routeDesc = classification.routeStrategy === 'single'
          ? `fast-path → ${classification.suggestedAgent}`
          : classification.routeStrategy === 'tandem' && classification.tandemPair
            ? `tandem: ${classification.tandemPair.lead} → ${classification.tandemPair.follow}`
            : classification.routeStrategy === 'council'
              ? 'council deliberation'
              : `mini-round triage → delegated`;
        const preDispatch = await promptChoice(rl, {
          title: 'Pre-dispatch Review',
          context: {
            Classification: `${classification.tier} (${classification.confidence} confidence)`,
            Route: routeDesc,
            Signals: classification.reason,
            Prompt: `"${short(dispatchLine, 300)}"`,
          },
          choices: [
            { label: 'Proceed', value: 'proceed', hint: `dispatch as ${classification.tier}` },
            { label: 'Proceed (auto-accept)', value: '__auto_accept__', hint: 'skip future confirmations' },
            { label: 'Cancel', value: 'cancel', hint: 'abort this dispatch' },
            { label: 'Respond', value: 'respond', hint: 'type custom instructions', freeform: true },
          ],
          defaultValue: 'proceed',
        });

        if (preDispatch.value === 'cancel') {
          console.log(`  ${DIM('Dispatch cancelled.')}`);
          rl.prompt();
          return;
        }

        // If freeform text was provided, use it as the prompt instead
        if (preDispatch.value !== 'proceed' && preDispatch.value !== 'cancel' && !preDispatch.autoAcceptAll && !preDispatch.timedOut) {
          dispatchLine = preDispatch.value;
          console.log(`  ${DIM('Dispatching with modified prompt:')}`);
          console.log(`  ${ACCENT(short(dispatchLine, 70))}`);
        }

        const COUNCIL_AGENTS = [{ agent: 'claude' }, { agent: 'opus' }, { agent: 'claude' }, { agent: 'codex' }];
        const rs = classification.routeStrategy;
        const estMs = rs === 'single'
          ? estimateFlowDuration([{ agent: classification.suggestedAgent || 'claude' }])
          : rs === 'tandem'
            ? 5_000  // 2 daemon HTTP posts, very fast
            : estimateFlowDuration(COUNCIL_AGENTS, autoCouncilRounds);
        const smartLabel = mode === 'smart' ? `Smart (${classification.tier}→${SMART_TIER_MAP[classification.tier] || 'balanced'}) ` : '';
        const tandemLabel = rs === 'tandem' && classification.tandemPair
          ? `${classification.tandemPair.lead} → ${classification.tandemPair.follow}` : '';
        const spinner = rs === 'single'
          ? createSpinner(`${smartLabel}Fast-path → ${classification.suggestedAgent}`, { estimatedMs: estMs, style: 'solar' }).start()
          : rs === 'tandem'
            ? createSpinner(`${smartLabel}Tandem dispatch: ${tandemLabel}`, { estimatedMs: estMs, style: 'solar' }).start()
            : createSpinner(`${smartLabel}Running council deliberation`, { estimatedMs: estMs, style: 'orbital' }).start();

        // Set dispatch context for status bar
        setDispatchContext({
          promptSummary: topic || short(dispatchLine, 30),
          topic,
          tier: classification.tier,
        });

        const onProgress = (evt) => {
          if (evt.action === 'start') {
            const narrative = phaseNarrative(evt.phase, evt.agent, topic);
            const prefix = classification.tier === 'complex' ? 'Council' : 'Mini-round';
            spinner.update(`${smartLabel}${prefix}: ${narrative} [${evt.step}/${evt.totalSteps}]`);
            setAgentActivity(evt.agent, 'working', narrative, { phase: evt.phase, step: `${evt.step}/${evt.totalSteps}` });
            drawStatusBar();
          }
        };
        let auto;
        if (dispatchDepth === 0 && isConciergeAvailable()) {
          process.stdout.write(`\r\x1b[2K  ${DIM(`${pc.blue('\u2B22')} agents running \u2014 you can ask concierge anything`)}\n`);
          rl.prompt(true);
        }
        dispatchDepth++;
        try {
          const dispatchFn = mode === 'smart' ? runSmartPrompt : runAutoPrompt;
          auto = await dispatchFn({
            baseUrl,
            from,
            agents,
            promptText: dispatchLine,
            miniRounds: autoMiniRounds,
            councilRounds: autoCouncilRounds,
            preview: autoPreview || dryRunMode,
            onProgress,
          });
          const succeedMsg = auto.mode === 'fast-path' ? `Fast-path dispatched to ${classification.suggestedAgent}`
            : auto.mode === 'tandem' ? `Tandem dispatched: ${auto.route}`
            : `${auto.mode} complete`;
          spinner.succeed(succeedMsg);
        } catch (e) {
          spinner.fail(e.message);
          clearDispatchContext();
          throw e;
        } finally {
          dispatchDepth--;
        }

        // Post-dispatch: inject task titles into agent status lines
        if (auto.published?.tasks) {
          for (const task of auto.published.tasks) {
            const owner = String(task?.owner || '').toLowerCase();
            if (owner && agents.includes(owner)) {
              const title = String(task.title || '').slice(0, 40);
              if (title) {
                setAgentActivity(owner, 'idle', title, { taskTitle: title });
              }
            }
          }
        }

        clearDispatchContext();

        // Update status bar with dispatch info
        if (mode !== 'smart') {
          const sbRoute = auto.mode === 'fast-path' ? `single→${classification.suggestedAgent || 'agent'}`
            : auto.mode === 'tandem' ? `tandem→${classification.tandemPair?.lead || '?'}+${classification.tandemPair?.follow || '?'}`
            : auto.mode;
          setLastDispatch({
            route: sbRoute,
            tier: classification.tier,
            agent: auto.mode === 'fast-path' ? (classification.suggestedAgent || '') : '',
            mode,
          });
        }
        const dryLabel = dryRunMode ? ' (DRY RUN)' : '';
        console.log(sectionHeader((mode === 'smart' ? 'Smart Dispatch' : 'Auto Dispatch') + dryLabel));
        // Route summary
        const routeColor = auto.mode === 'fast-path' ? SUCCESS : auto.mode === 'tandem' ? ACCENT : ACCENT;
        console.log(label('Route', routeColor(auto.route || auto.recommended)));
        if (dryRunMode) {
          console.log(label('Mode', pc.yellow('DRY RUN — no tasks created')));
        }
        if (auto.mode === 'tandem') {
          const pair = classification.tandemPair;
          if (pair) console.log(label('Pattern', DIM(`${pair.lead} (analyze) → ${pair.follow} (execute)`)));
          console.log(label('Saved', DIM('skipped mini-round triage (4 agent calls)')));
        }
        console.log(label('Signals', DIM(classification.reason)));
        if (auto.smartTier) {
          console.log(label('Tier', `${ACCENT(auto.smartTier)} → ${DIM(auto.smartMode)} models`));
        }
        if (auto.triage) {
          console.log(label('Rationale', DIM(auto.triage.recommendationRationale || 'n/a')));
        }
        if (auto.escalatedToCouncil) {
          if (auto.councilOutput) {
            console.log(auto.councilOutput);
          }
        } else if (auto.published) {
          console.log(label('Tasks created', pc.white(String(auto.published.tasks.length))));
          console.log(label('Handoffs queued', pc.white(String(auto.published.handoffs.length))));
          const handoffAgents = extractHandoffAgents(auto);
          if (handoffAgents.length > 0) {
            const postDispatch = await promptChoice(rl, {
              title: 'Post-dispatch',
              context: {
                Tasks: `${auto.published.tasks.length} created`,
                Agents: handoffAgents.join(', '),
              },
              choices: [
                { label: 'Start workers', value: 'workers', hint: 'headless background execution (default)' },
                { label: 'Launch terminals', value: 'launch', hint: 'open visible terminal windows' },
                { label: 'Skip', value: 'skip', hint: 'tasks dispatched, no execution' },
              ],
              defaultValue: 'workers',
            });
            if (postDispatch.value === 'workers') {
              startAgentWorkers(handoffAgents, baseUrl, { rl });
            } else if (postDispatch.value === 'launch') {
              for (const a of handoffAgents) setAgentExecMode(a, 'terminal');
              launchAgentTerminals(handoffAgents, baseUrl);
            }
          }
        } else {
          console.log(label('Route', DIM('preview only')));
        }
      } else if (mode === 'council') {
        const councilTopic = extractTopic(dispatchLine);

        // Council gate: check if council is overkill
        const routingCfg = config.routing || {};
        const gateClassification = classifyPrompt(dispatchLine);
        let useCouncil = true;
        if (routingCfg.councilGate !== false && gateClassification.routeStrategy !== 'council' && gateClassification.confidence >= 0.5) {
          const efficientRoute = gateClassification.routeStrategy === 'single'
            ? `fast-path → ${gateClassification.suggestedAgent}`
            : gateClassification.tandemPair
              ? `tandem: ${gateClassification.tandemPair.lead} → ${gateClassification.tandemPair.follow}`
              : `fast-path → ${gateClassification.suggestedAgent}`;
          const gateChoice = await promptChoice(rl, {
            title: 'Council Gate',
            context: {
              Classification: `${gateClassification.tier} (${gateClassification.confidence} confidence)`,
              'Efficient route': efficientRoute,
              'Council cost': `${councilRounds * 4} agent calls across ${councilRounds} round(s)`,
            },
            choices: [
              { label: 'Use efficient route', value: 'efficient', hint: `recommended — ${gateClassification.routeStrategy}` },
              { label: 'Proceed with council', value: 'council', hint: 'full deliberation' },
              { label: 'Cancel', value: 'cancel', hint: 'abort' },
            ],
            defaultValue: 'efficient',
          });
          if (gateChoice.value === 'cancel') {
            console.log(`  ${DIM('Dispatch cancelled.')}`);
            rl.prompt();
            return;
          }
          if (gateChoice.value === 'efficient') {
            useCouncil = false;
            // Route through auto dispatch with the gate classification
            if (dispatchDepth === 0 && isConciergeAvailable()) {
              process.stdout.write(`\r\x1b[2K  ${DIM(`${pc.blue('\u2B22')} agents running \u2014 you can ask concierge anything`)}\n`);
              rl.prompt(true);
            }
            dispatchDepth++;
            let autoResult;
            try {
              autoResult = await runAutoPrompt({
                baseUrl,
                from,
                agents,
                promptText: dispatchLine,
                miniRounds: autoMiniRounds,
                councilRounds: autoCouncilRounds,
                preview: false,
              });
            } finally {
              dispatchDepth--;
            }
            console.log(sectionHeader('Efficient Dispatch (council gate)'));
            console.log(label('Route', SUCCESS(autoResult.route)));
            console.log(label('Signals', DIM(gateClassification.reason)));
            console.log(label('Saved', DIM(`skipped council (${councilRounds * 4} agent calls)`)));
            if (autoResult.published) {
              console.log(label('Tasks created', pc.white(String(autoResult.published.tasks.length))));
              console.log(label('Handoffs queued', pc.white(String(autoResult.published.handoffs.length))));
              const handoffAgents = extractHandoffAgents(autoResult);
              if (handoffAgents.length > 0) {
                startAgentWorkers(handoffAgents, baseUrl, { rl });
              }
            }
            rl.prompt();
            return;
          }
        }

        const COUNCIL_AGENTS_C = [{ agent: 'claude' }, { agent: 'opus' }, { agent: 'claude' }, { agent: 'codex' }];
        const councilSpinner = createSpinner('Running council deliberation', { estimatedMs: estimateFlowDuration(COUNCIL_AGENTS_C, councilRounds), style: 'orbital' }).start();

        setDispatchContext({
          promptSummary: councilTopic || short(dispatchLine, 30),
          topic: councilTopic,
          tier: 'complex',
        });

        if (dispatchDepth === 0 && isConciergeAvailable()) {
          process.stdout.write(`\r\x1b[2K  ${DIM(`${pc.blue('\u2B22')} council running \u2014 you can ask concierge anything`)}\n`);
          rl.prompt(true);
        }
        dispatchDepth++;
        let council;
        try {
          council = await runCouncilPrompt({
            baseUrl,
            promptText: dispatchLine,
            rounds: councilRounds,
            preview: councilPreview,
            onProgress: (evt) => {
              if (evt.action === 'start') {
                const narrative = phaseNarrative(evt.phase, evt.agent, councilTopic);
                councilSpinner.update(`Council: ${narrative} [${evt.step}/${evt.totalSteps}]`);
                setAgentActivity(evt.agent, 'working', narrative, { phase: evt.phase, step: `${evt.step}/${evt.totalSteps}` });
                drawStatusBar();
              }
            },
          });
        } finally {
          dispatchDepth--;
        }

        clearDispatchContext();

        if (!council.ok) {
          councilSpinner.fail('Council failed');
          throw new Error(council.stderr || council.stdout || `Council exited with status ${council.status}`);
        }
        councilSpinner.succeed('Council completed');
        console.log(council.stdout.trim());
      } else if (mode === 'dispatch') {
        console.log('Dispatch mode: run `npm run hydra:go -- mode=dispatch prompt="..."` for headless pipeline.');
      } else {
        const handoffTopic = extractTopic(dispatchLine);
        const handoffSpinner = createSpinner('Dispatching to agents', { estimatedMs: 5_000, style: 'eclipse' }).start();
        const records = await dispatchPrompt({
          baseUrl,
          from,
          agents,
          promptText: dispatchLine,
        });
        handoffSpinner.succeed('Dispatched');

        // Set agent status to prompt topic instead of bare "Handoff from human"
        for (const item of records) {
          const agentName = String(item.agent || '').toLowerCase();
          const title = handoffTopic || short(dispatchLine, 40);
          if (agentName && title) {
            setAgentActivity(agentName, 'idle', title, { taskTitle: title });
          }
        }

        console.log(sectionHeader('Dispatched'));
        for (const item of records) {
          console.log(`  ${agentBadge(item.agent)}  ${DIM('handoff=')}${pc.bold(item.handoffId || '?')}`);
        }
        const handoffAgents = records.map(r => String(r.agent).toLowerCase()).filter(Boolean);
        if (handoffAgents.length > 0) {
          startAgentWorkers(handoffAgents, baseUrl, { rl });
        }
      }
    } catch (error) {
      console.error(`Error: ${error.message}`);
    }

    drawStatusBar();
    rl.prompt();
  });

  rl.on('close', () => {
    if (_ghostCleanup) {
      process.stdin.removeListener('data', _ghostCleanup);
      _ghostCleanup = null;
    }
    resetAutoAccept();
    resetConversation();
    stopAllWorkers();
    stopEventStream();
    destroyStatusBar();
    console.log('Hydra operator console closed.');
    process.exit(0);
  });
}

async function main() {
  const { options, positionals } = parseArgs(process.argv);
  const baseUrl = String(options.url || DEFAULT_URL);
  const from = String(options.from || 'human').toLowerCase();
  const agents = parseList(options.agents || 'gemini,codex,claude');
  const mode = String(options.mode || 'auto').toLowerCase();
  const councilRounds = Math.max(1, Math.min(4, Number.parseInt(String(options.councilRounds || '2'), 10) || 2));
  const councilPreview = boolFlag(options.councilPreview, false);
  const autoMiniRounds = Math.max(1, Math.min(2, Number.parseInt(String(options.autoMiniRounds || '1'), 10) || 1));
  const autoCouncilRounds = Math.max(1, Math.min(4, Number.parseInt(String(options.autoCouncilRounds || String(councilRounds)), 10) || councilRounds));
  const autoPreview = boolFlag(options.autoPreview, false);
  const promptText = getPrompt(options, positionals);
  const interactive = !promptText;
  const showWelcome = boolFlag(options.welcome, interactive);

  // Register built-in virtual sub-agents
  registerBuiltInSubAgents();

  // Pre-load codebase context for concierge knowledge
  try { loadCodebaseContext(); } catch { /* non-critical */ }

  // Auto-start daemon if not running
  const daemonOk = await ensureDaemon(baseUrl, { quiet: !interactive });
  if (!daemonOk) {
    console.error(`Hydra daemon unreachable at ${baseUrl}.`);
    console.error('Start manually: npm run hydra:start');
    process.exit(1);
  }

  if (interactive) {
    await interactiveLoop({
      baseUrl,
      from,
      agents,
      initialMode: mode,
      councilRounds,
      councilPreview,
      autoMiniRounds,
      autoCouncilRounds,
      autoPreview,
      showWelcome,
    });
    return;
  }

  if (mode === 'auto' || mode === 'smart') {
    const dispatchFn = mode === 'smart' ? runSmartPrompt : runAutoPrompt;
    const auto = await dispatchFn({
      baseUrl,
      from,
      agents,
      promptText,
      miniRounds: autoMiniRounds,
      councilRounds: autoCouncilRounds,
      preview: autoPreview,
    });
    console.log(sectionHeader(mode === 'smart' ? 'Smart Dispatch Complete' : 'Auto Dispatch Complete'));
    const oneShotRouteColor = auto.mode === 'fast-path' ? SUCCESS : ACCENT;
    console.log(label('Route', oneShotRouteColor(auto.route || auto.recommended)));
    if (auto.mode === 'tandem') {
      console.log(label('Saved', DIM('skipped mini-round triage (4 agent calls)')));
    }
    if (auto.smartTier) {
      console.log(label('Tier', `${ACCENT(auto.smartTier)} → ${DIM(auto.smartMode)} models`));
    }
    if (auto.triage) {
      console.log(label('Rationale', DIM(auto.triage.recommendationRationale || 'n/a')));
    }
    if (auto.escalatedToCouncil) {
      if (auto.councilOutput) {
        console.log(auto.councilOutput);
      }
    } else if (auto.published) {
      console.log(label('Tasks created', pc.white(String(auto.published.tasks.length))));
      console.log(label('Handoffs queued', pc.white(String(auto.published.handoffs.length))));
      const handoffAgents = extractHandoffAgents(auto);
      if (handoffAgents.length > 0) startAgentWorkers(handoffAgents, baseUrl);
    } else {
      console.log(label('Route', DIM('preview')));
    }
  } else if (mode === 'council') {
    // One-shot council: log routing tip if council seems overkill
    const oneShotClassification = classifyPrompt(promptText);
    if (oneShotClassification.routeStrategy !== 'council' && oneShotClassification.confidence >= 0.5) {
      console.log(DIM(`  Tip: this prompt classified as ${oneShotClassification.tier} (${oneShotClassification.routeStrategy}), consider auto mode for efficiency`));
    }
    const council = await runCouncilPrompt({
      baseUrl,
      promptText,
      rounds: councilRounds,
      preview: councilPreview,
    });
    if (!council.ok) {
      throw new Error(council.stderr || council.stdout || `Council exited with status ${council.status}`);
    }
    console.log(council.stdout.trim());
  } else if (mode === 'dispatch') {
    // Headless dispatch pipeline: spawn hydra-dispatch.mjs
    const dispatchScript = path.join(HYDRA_ROOT, 'lib', 'hydra-dispatch.mjs');
    const args = [dispatchScript, `prompt=${promptText}`, `url=${baseUrl}`];
    if (boolFlag(options.preview, false)) {
      args.push('mode=preview');
    }
    const result = spawnHydraNodeSync(args[0], args.slice(1), {
      cwd: config.projectRoot,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 8,
      windowsHide: true,
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      process.exit(result.status || 1);
    }
  } else {
    const records = await dispatchPrompt({
      baseUrl,
      from,
      agents,
      promptText,
    });

    console.log(sectionHeader('Dispatch Complete'));
    for (const item of records) {
      console.log(`  ${agentBadge(item.agent)}  ${DIM('handoff=')}${pc.bold(item.handoffId || '?')}`);
    }
    const handoffAgents = records.map(r => String(r.agent).toLowerCase()).filter(Boolean);
    if (handoffAgents.length > 0) startAgentWorkers(handoffAgents, baseUrl);
  }
}

// Graceful shutdown: stop all workers before exiting
let isShuttingDown = false;
function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n${DIM(`Shutting down (${signal})...`)}`);
  try {
    stopAllWorkers();
    console.log(SUCCESS('Workers stopped'));
  } catch (err) {
    console.error(ERROR(`Worker cleanup failed: ${err.message}`));
  }
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

main().catch((error) => {
  console.error(`Hydra operator failed: ${error.message}`);
  process.exit(1);
});
