#!/usr/bin/env node
/**
 * Hydra Council Mode
 *
 * Agent-aware multi-round deliberation:
 * Claude Sonnet (propose) -> Claude Opus (critique) -> Claude Sonnet (refine) -> Codex (implement)
 * Opus runs on the same `claude` CLI (any working login). Gemini CLI is optional for Council.
 * Then optionally publishes decisions/tasks/handoffs into Hydra daemon.
 *
 * Usage:
 *   node hydra-council.mjs prompt="Investigate auth race"
 *   node hydra-council.mjs prompt="Investigate auth race" mode=preview
 */

import './hydra-env.mjs';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { getProjectContext } from './hydra-context.mjs';
import { getAgent, AGENT_NAMES, getMode, setMode } from './hydra-agents.mjs';
import { resolveProject, loadHydraConfig } from './hydra-config.mjs';
import { checkUsage } from './hydra-usage.mjs';
import {
  nowIso,
  runId,
  parseArgs,
  getPrompt,
  boolFlag,
  short,
  parseJsonLoose,
  request,
  ensureDir,
  sanitizeOwner,
  normalizeTask,
  dedupeTasks,
  classifyPrompt,
  generateSpec,
} from './hydra-utils.mjs';
import {
  sectionHeader,
  label,
  colorAgent,
  createSpinner,
  divider,
  SUCCESS,
  ERROR,
  WARNING,
  DIM,
  ACCENT,
  HIGHLIGHT,
  formatElapsed,
} from './hydra-ui.mjs';
import { executeAgentWithRecovery } from './hydra-shared/agent-executor.mjs';
import { detectRateLimitError, calculateBackoff } from './hydra-model-recovery.mjs';
import { diagnose as notifyDoctor, isDoctorEnabled } from './hydra-doctor.mjs';
import { isPersonaEnabled, getAgentFraming } from './hydra-persona.mjs';
import pc from 'picocolors';

const config = resolveProject();
const RUNS_DIR = config.runsDir;

/**
 * Simple deterministic hash of a string, returns first 12 hex chars.
 */
function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  // Convert to unsigned 32-bit then hex, pad, and use first 12 chars
  const hex = (h >>> 0).toString(16).padStart(8, '0');
  // Mix in length for more entropy
  const h2 = ((h >>> 0) ^ (str.length * 2654435761)) >>> 0;
  return (hex + h2.toString(16).padStart(8, '0')).slice(0, 12);
}

/**
 * Capture project files that an implement phase is allowed to change. Council
 * checkpoints are deliberately excluded so Hydra's own bookkeeping cannot be
 * mistaken for an implementation.
 */
export function snapshotProjectFiles(projectRoot, ignoredDirectories = ['node_modules', '.git', 'docs/coordination/runs']) {
  const snapshot = new Map();
  const ignored = new Set(ignoredDirectories.map((entry) => entry.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')));
  const visit = (directory, relative = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!ignored.has(childRelative)) visit(path.join(directory, entry.name), childRelative);
      } else if (entry.isFile()) {
        const content = fs.readFileSync(path.join(directory, entry.name));
        snapshot.set(childRelative, crypto.createHash('sha256').update(content).digest('hex'));
      }
    }
  };
  visit(projectRoot);
  return snapshot;
}

export function changedProjectFiles(before, after) {
  const changed = new Set();
  for (const [file, fingerprint] of after) {
    if (before.get(file) !== fingerprint) changed.add(file);
  }
  for (const file of before.keys()) {
    if (!after.has(file)) changed.add(file);
  }
  return [...changed].sort();
}

function checkpointPath(promptHash) {
  return path.join(RUNS_DIR, `COUNCIL_CHECKPOINT_${promptHash}.json`);
}

function loadCheckpoint(promptHash, prompt) {
  const cpPath = checkpointPath(promptHash);
  if (!fs.existsSync(cpPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(cpPath, 'utf8'));
    if (data.prompt !== prompt) return null; // prompt mismatch
    return data;
  } catch {
    return null;
  }
}

function saveCheckpoint(promptHash, prompt, round, stepIdx, transcript, specContent) {
  ensureDir(RUNS_DIR);
  const data = {
    promptHash,
    prompt,
    round,
    stepIdx,
    transcript,
    specContent: specContent || null,
    startedAt: transcript[0]?.startedAt || nowIso(),
    updatedAt: nowIso(),
  };
  fs.writeFileSync(checkpointPath(promptHash), JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function deleteCheckpoint(promptHash) {
  const cpPath = checkpointPath(promptHash);
  try { fs.unlinkSync(cpPath); } catch { /* ignore */ }
}

const DEFAULT_URL = process.env.AI_ORCH_URL || 'http://127.0.0.1:4173';
const DEFAULT_TIMEOUT_MS = 1000 * 60 * 7;

/**
 * Council flow: Claude→Opus critique→Claude→Codex implement
 * Each step has a specific phase and agent-aware prompt.
 */
const COUNCIL_FLOW = [
  { agent: 'claude', phase: 'propose', promptLabel: 'Analyze this objective and propose a detailed plan with task breakdown.' },
  { agent: 'opus', phase: 'critique', promptLabel: 'Review this plan critically. Identify risks, edge cases, missed files, and regressions. Cite specific code. Do not implement.' },
  { agent: 'claude', phase: 'refine', promptLabel: 'Incorporate the critique. Produce the final plan with concrete task specs for implementation.' },
  { agent: 'codex', phase: 'implement', promptLabel: 'Execute the finalized plan now. Use your tools to edit the named files on disk. After the writes exist, return JSON listing the changed paths. A JSON plan without file writes is a failure.' },
];

const MODE_DOWNSHIFT = { performance: 'balanced', balanced: 'economy' };
export const COUNCIL_DECISION_CRITERIA = [
  { key: 'correctness', label: 'Correctness' },
  { key: 'complexity', label: 'Complexity' },
  { key: 'reversibility', label: 'Reversibility' },
  { key: 'user_impact', label: 'User impact' },
];

const HUMAN_OWNERS = new Set(['human', 'unassigned']);
export const COUNCIL_HANDOFF_AGENTS = Object.freeze(['claude', 'opus', 'codex']);

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeConfidence(value) {
  const normalized = cleanText(value).toLowerCase();
  return ['low', 'medium', 'high'].includes(normalized) ? normalized : '';
}

function normalizeNextAction(value) {
  const normalized = cleanText(value).toLowerCase().replace(/\s+/g, '_');
  if (!normalized) {
    return '';
  }
  if (['handoff', 'delegate', 'ship'].includes(normalized)) {
    return 'handoff';
  }
  if (['council', 'deeper_council', 'open_council', 'continue_council'].includes(normalized)) {
    return 'council';
  }
  if (['human', 'human_decision', 'ask_human', 'needs_human'].includes(normalized)) {
    return 'human_decision';
  }
  return '';
}

function normalizeTradeoffs(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const entries = {};
  for (const { key } of COUNCIL_DECISION_CRITERIA) {
    const camelKey = key.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
    const value = cleanText(raw[key] ?? raw[camelKey]);
    if (value) {
      entries[key] = value;
    }
  }
  return Object.keys(entries).length > 0 ? entries : null;
}

function normalizeDecisionOption(item, index) {
  if (!item || typeof item !== 'object') {
    return null;
  }
  const option = cleanText(item.option || item.name || item.title);
  const summary = cleanText(item.summary || item.description || item.view);
  const tradeoffs = normalizeTradeoffs(item.tradeoffs || item.criteria || item.decision_criteria);
  const preferred = item.preferred === true;
  if (!option && !summary && !tradeoffs) {
    return null;
  }
  return {
    option: option || `option_${index + 1}`,
    summary,
    preferred,
    tradeoffs,
  };
}

function mergeTruthy(base, update) {
  const out = { ...(base || {}) };
  for (const [key, value] of Object.entries(update || {})) {
    if (value === null || value === undefined) {
      continue;
    }
    if (typeof value === 'string' && !value.trim()) {
      continue;
    }
    if (Array.isArray(value) && value.length === 0) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

function dedupeBy(items, keySelector) {
  const seen = new Map();
  for (const item of items) {
    if (!item) {
      continue;
    }
    const key = cleanText(keySelector(item)).toLowerCase();
    if (!key) {
      continue;
    }
    const existing = seen.get(key);
    seen.set(key, mergeTruthy(existing, item));
  }
  return [...seen.values()];
}

function usageGuard(agent) {
  try {
    const usage = checkUsage();
    if (usage.level === 'critical') {
      const currentMode = getMode();
      const nextMode = MODE_DOWNSHIFT[currentMode];
      if (nextMode) {
        process.stderr.write(`  ${WARNING('\u26A0')} Token usage CRITICAL (${usage.percent.toFixed(1)}%) \u2014 downshifting mode: ${currentMode} \u2192 ${nextMode}\n`);
        setMode(nextMode);
      } else {
        process.stderr.write(`  ${WARNING('\u26A0')} Token usage CRITICAL (${usage.percent.toFixed(1)}%) \u2014 already in economy mode\n`);
      }
    } else if (usage.level === 'warning') {
      process.stderr.write(`  ${DIM('\u26A0')} Token usage at ${usage.percent.toFixed(1)}%\n`);
    }
  } catch { /* non-critical */ }
}

/**
 * Async agent call with self-healing (model recovery + rate limit retry).
 * Replaces the old sync callAgent → modelCall path, fixing stdin issues
 * and adding defense-in-depth on par with evolve.
 */
async function callAgentAsync(agent, prompt, timeoutMs) {
  usageGuard(agent);
  const geminiCap = Number.parseInt(process.env.HYDRA_GEMINI_TIMEOUT_MS || '180000', 10);
  const waitMs = agent === 'gemini' && Number.isFinite(geminiCap) && geminiCap > 0
    ? Math.min(timeoutMs, geminiCap)
    : timeoutMs;
  const result = await executeAgentWithRecovery(agent, prompt, {
    timeoutMs: waitMs,
    useStdin: true,
    cwd: config.projectRoot,
    progressIntervalMs: 15_000,
    onProgress: (elapsed, outputKB) => {
      process.stderr.write(`${JSON.stringify({
        type: 'council_heartbeat',
        agent,
        elapsedMs: elapsed,
        outputKB,
      })}\n`);
    },
  });
  return {
    ok: result.ok,
    stdout: result.output || result.stdout || '',
    stderr: result.stderr || '',
    error: result.error || '',
    exitCode: result.exitCode,
    command: result.command,
    args: result.args,
    promptSnippet: result.promptSnippet,
    recovered: result.recovered || false,
    originalModel: result.originalModel,
    newModel: result.newModel,
  };
}

function extractTasksFromOutput(parsed, fallbackOwner = 'unassigned') {
  if (!parsed || typeof parsed !== 'object') {
    return [];
  }
  const buckets = [
    parsed.task_allocations,
    parsed.recommended_tasks,
    parsed.tasks,
    parsed.delegation?.task_splits,
  ];
  const out = [];
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) {
      continue;
    }
    for (const item of bucket) {
      const normalized = normalizeTask(item, fallbackOwner);
      if (normalized) {
        out.push(normalized);
      }
    }
  }
  return out;
}

function extractQuestions(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return [];
  }
  const questions = [];
  const buckets = [parsed.questions, parsed.final_questions, parsed.open_questions];
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) {
      continue;
    }
    for (const q of bucket) {
      if (typeof q === 'string' && q.trim()) {
        questions.push({ to: 'human', question: q.trim() });
      } else if (q && typeof q === 'object') {
        const question = String(q.question || q.text || '').trim();
        if (!question) {
          continue;
        }
        questions.push({
          to: sanitizeOwner(q.to || 'human'),
          question,
        });
      }
    }
  }
  return questions;
}

function extractRisks(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return [];
  }
  const risks = [];
  const buckets = [parsed.risks, parsed.sanity_checks, parsed.edge_cases];
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) {
      continue;
    }
    for (const item of bucket) {
      if (typeof item === 'string' && item.trim()) {
        risks.push(item.trim());
      }
    }
  }
  return risks;
}

function extractCouncilSignal(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  const boolCandidates = [parsed.should_open_council, parsed.needs_council, parsed.council_needed];
  let vote = null;
  for (const candidate of boolCandidates) {
    if (typeof candidate === 'boolean') {
      vote = candidate;
      break;
    }
  }
  if (vote === null) {
    return null;
  }
  const reason = String(parsed.council_reason || parsed.reason || '').trim();
  return { vote, reason };
}

export function extractDecisionOptions(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return [];
  }
  const buckets = [parsed.decision_options, parsed.options, parsed.candidate_options];
  const out = [];
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) {
      continue;
    }
    for (const [index, item] of bucket.entries()) {
      const normalized = normalizeDecisionOption(item, index);
      if (normalized) {
        out.push(normalized);
      }
    }
  }
  return dedupeBy(out, (item) => `${item.option}|${item.summary}`);
}

export function extractAssumptions(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return [];
  }
  const buckets = [parsed.assumptions, parsed.open_assumptions, parsed.key_assumptions];
  const out = [];
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) {
      continue;
    }
    for (const item of bucket) {
      if (typeof item === 'string' && item.trim()) {
        out.push({
          assumption: item.trim(),
          status: 'open',
          evidence: '',
          impact: '',
          owner: 'unassigned',
        });
        continue;
      }
      if (!item || typeof item !== 'object') {
        continue;
      }
      const assumption = cleanText(item.assumption || item.name || item.summary || item.question);
      if (!assumption) {
        continue;
      }
      const status = cleanText(item.status).toLowerCase();
      out.push({
        assumption,
        status: ['validated', 'open', 'rejected'].includes(status) ? status : 'open',
        evidence: cleanText(item.evidence || item.basis),
        impact: cleanText(item.impact || item.risk),
        owner: sanitizeOwner(item.owner || item.to || 'unassigned'),
      });
    }
  }
  return dedupeBy(out, (item) => item.assumption);
}

export function extractAssumptionAttacks(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return [];
  }
  const buckets = [parsed.assumption_attacks, parsed.assumption_challenges, parsed.counterarguments];
  const out = [];
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) {
      continue;
    }
    for (const item of bucket) {
      if (typeof item === 'string' && item.trim()) {
        out.push({
          assumption: '',
          challenge: item.trim(),
          impact: '',
          by: 'unassigned',
        });
        continue;
      }
      if (!item || typeof item !== 'object') {
        continue;
      }
      const challenge = cleanText(item.attack_vector ?? item.challenge ?? item.critique ?? item.text);
      const assumption = cleanText(item.target_agent ?? item.assumption ?? item.target);
      if (!challenge && !assumption) {
        continue;
      }
      out.push({
        assumption,
        challenge,
        impact: cleanText(item.impact || item.risk),
        by: sanitizeOwner(item.by || item.owner || 'unassigned'),
      });
    }
  }
  return dedupeBy(out, (item) => `${item.assumption}|${item.challenge}`);
}

function extractDisagreements(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return [];
  }
  const buckets = [parsed.disagreements, parsed.unresolved_tensions, parsed.conflicts];
  const out = [];
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) {
      continue;
    }
    for (const item of bucket) {
      if (typeof item === 'string' && item.trim()) {
        out.push(item.trim());
      }
    }
  }
  return [...new Set(out)];
}

export function extractFinalDecision(parsed, fallback = {}) {
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  const decision = parsed.decision && typeof parsed.decision === 'object' ? parsed.decision : {};
  const summary = cleanText(
    decision.summary ||
    decision.choice ||
    decision.recommendation ||
    parsed.consensus ||
    parsed.view
  );
  const why = cleanText(decision.why || decision.rationale || decision.reason || parsed.decision_rationale);
  const owner = sanitizeOwner(decision.owner || decision.decider || fallback.agent || 'unassigned');
  const confidence = normalizeConfidence(decision.confidence || parsed.confidence);
  const nextAction = normalizeNextAction(decision.next_action || decision.nextAction || parsed.next_action);
  const reversibleFirstStep = cleanText(
    decision.reversible_first_step ||
    decision.reversibleFirstStep ||
    parsed.reversible_first_step
  );
  const tradeoffs = normalizeTradeoffs(
    decision.tradeoffs ||
    decision.criteria ||
    parsed.tradeoffs ||
    parsed.decision_criteria
  );

  if (!summary && !why && !confidence && !nextAction && !reversibleFirstStep && !tradeoffs) {
    return null;
  }

  return {
    summary,
    why,
    owner,
    confidence,
    nextAction,
    reversibleFirstStep,
    tradeoffs,
    sourceAgent: fallback.agent || 'unassigned',
    sourcePhase: fallback.phase || '',
  };
}

function countOpenAssumptions(assumptions) {
  return assumptions.filter((item) => item.status !== 'validated').length;
}

export function deriveCouncilRecommendation({
  finalDecision,
  assumptions = [],
  questions = [],
  risks = [],
  disagreements = [],
  councilVotes = [],
}) {
  const openAssumptions = countOpenAssumptions(assumptions);
  const humanQuestions = questions.filter((q) => q.to === 'human').length;
  const crossAgentQuestions = questions.filter((q) => ['gemini', 'codex', 'claude'].includes(q.to)).length;
  const riskItems = risks.length;
  const disagreementItems = disagreements.length;
  const positiveCouncilSignals = councilVotes.filter((item) => item.vote).length;

  let recommendedMode = 'handoff';
  const explicitNextAction = finalDecision?.nextAction || '';

  if (explicitNextAction === 'handoff') {
    const confidence = finalDecision?.confidence || '';
    const synthesisLooksWeak = confidence === 'low' || disagreementItems > 1 || riskItems >= 6;
    recommendedMode = synthesisLooksWeak ? 'council' : 'handoff';
  } else if (explicitNextAction === 'council' || explicitNextAction === 'human_decision') {
    recommendedMode = 'council';
  } else if ((finalDecision?.confidence || '') === 'low' && (openAssumptions > 0 || humanQuestions > 0 || riskItems > 0)) {
    recommendedMode = 'council';
  } else if (riskItems >= 4 || disagreementItems > 0 || crossAgentQuestions > 1) {
    recommendedMode = 'council';
  } else if (positiveCouncilSignals > 0 && (openAssumptions > 0 || riskItems > 0)) {
    recommendedMode = 'council';
  }

  const nextAction = explicitNextAction || (recommendedMode === 'council' ? 'council' : 'handoff');
  const rationale = [
    `decision_owner=${finalDecision?.owner || 'n/a'}`,
    `decision_confidence=${finalDecision?.confidence || 'n/a'}`,
    `decision_next_action=${nextAction}`,
    `open_assumptions=${openAssumptions}`,
    `human_questions=${humanQuestions}`,
    `cross_agent_questions=${crossAgentQuestions}`,
    `disagreement_items=${disagreementItems}`,
    `risk_items=${riskItems}`,
    `positive_council_signals=${positiveCouncilSignals}`,
  ].join('; ');

  return { recommendedMode, nextAction, rationale };
}

export function synthesizeCouncilTranscript(prompt, transcript) {
  const parsedEntries = transcript.filter((entry) => entry.parsed && typeof entry.parsed === 'object');
  const codexEntries = parsedEntries.filter((entry) => entry.agent === 'codex');
  const lastCodex = codexEntries.at(-1);
  const lastClaudeRefine = parsedEntries.filter((entry) => entry.agent === 'claude' && entry.phase === 'refine').at(-1);
  const lastClaude = parsedEntries.filter((entry) => entry.agent === 'claude').at(-1);

  const taskCandidates = [];
  const questions = [];
  const risks = [];
  const councilVotes = [];
  const decisionOptions = [];
  const assumptions = [];
  const assumptionAttacks = [];
  const disagreements = [];
  const decisions = [];

  for (const entry of parsedEntries) {
    taskCandidates.push(...extractTasksFromOutput(entry.parsed, entry.agent));
    questions.push(...extractQuestions(entry.parsed));
    risks.push(...extractRisks(entry.parsed));
    decisionOptions.push(...extractDecisionOptions(entry.parsed));
    assumptions.push(...extractAssumptions(entry.parsed));
    assumptionAttacks.push(...extractAssumptionAttacks(entry.parsed));
    disagreements.push(...extractDisagreements(entry.parsed));

    const signal = extractCouncilSignal(entry.parsed);
    if (signal) {
      councilVotes.push({
        agent: entry.agent,
        phase: entry.phase,
        vote: signal.vote,
        reason: signal.reason,
      });
    }

    const decision = extractFinalDecision(entry.parsed, { agent: entry.agent, phase: entry.phase });
    if (decision) {
      decisions.push(decision);
    }
  }

  const dedupedQuestions = dedupeBy(questions, (item) => `${item.to}|${item.question}`);
  const dedupedRisks = [...new Set(risks.map((item) => cleanText(item)).filter(Boolean))];
  const dedupedDecisionOptions = dedupeBy(decisionOptions, (item) => `${item.option}|${item.summary}`);
  const dedupedAssumptions = dedupeBy(assumptions, (item) => item.assumption);
  const dedupedAssumptionAttacks = dedupeBy(assumptionAttacks, (item) => `${item.assumption}|${item.challenge}`);
  const dedupedDisagreements = [...new Set(disagreements.map((item) => cleanText(item)).filter(Boolean))];
  const finalDecision = decisions.at(-1) || null;
  const consensus = cleanText(
    finalDecision?.summary ||
    lastCodex?.parsed?.consensus ||
    lastClaudeRefine?.parsed?.view ||
    lastClaude?.parsed?.view
  );
  const recommendation = deriveCouncilRecommendation({
    finalDecision,
    assumptions: dedupedAssumptions,
    questions: dedupedQuestions,
    risks: dedupedRisks,
    disagreements: dedupedDisagreements,
    councilVotes,
  });

  let tasks;
  if (taskCandidates.length > 0) {
    tasks = dedupeTasks(taskCandidates);
  } else if (councilSaysNoFurtherWork(finalDecision, consensus)) {
    // Smoke / verify-only runs: don't invent Coordinate/Stress-test/Prepare todos.
    tasks = [];
  } else {
    tasks = defaultTasks(prompt);
  }

  return {
    prompt,
    consensus,
    tasks,
    questions: dedupedQuestions,
    risks: dedupedRisks,
    councilVotes,
    decisionOptions: dedupedDecisionOptions,
    assumptions: dedupedAssumptions,
    assumptionAttacks: dedupedAssumptionAttacks,
    disagreements: dedupedDisagreements,
    finalDecision,
    recommendedMode: recommendation.recommendedMode,
    recommendedNextAction: recommendation.nextAction,
    recommendationRationale: recommendation.rationale,
  };
}

function buildContextSummary(transcript) {
  return transcript
    .slice(-6)
    .map((entry) => {
      const content = entry.parsed ? JSON.stringify(entry.parsed) : entry.rawText;
      return `${entry.agent.toUpperCase()} (${entry.phase || `R${entry.round}`}): ${short(content, 500)}`;
    })
    .join('\n');
}

function formatCriteriaInstruction() {
  return COUNCIL_DECISION_CRITERIA
    .map((item) => `${item.key}: ${item.label}`)
    .join('; ');
}

export function buildStepPrompt(step, userPrompt, transcript, round, totalRounds, specContent = null) {
  const { agent, phase, promptLabel } = step;
  const agentConfig = getAgent(agent);
  const context = getProjectContext(agent, {}, config);
  const tradeoffsSchema = '{"correctness":"string","complexity":"string","reversibility":"string","user_impact":"string"}';
  const decisionSchema = `"decision":{"summary":"string","why":"string","owner":"gemini|codex|claude|human","confidence":"low|medium|high","next_action":"handoff|deeper_council|human_decision","reversible_first_step":"string","tradeoffs":${tradeoffsSchema}}`;
  const optionSchema = `"decision_options":[{"option":"string","summary":"string","preferred":true|false,"tradeoffs":${tradeoffsSchema}}],`;
  const assumptionSchema = '"assumptions":[{"assumption":"string","status":"open|validated|rejected","evidence":"string","impact":"string","owner":"gemini|codex|claude|human"}],';
  const assumptionAttackSchema = '"assumption_attacks":[{"assumption":"string","challenge":"string","impact":"string","by":"gemini|codex|claude|human"}],';

  const jsonSchemas = {
    propose: [
      '{',
      '  "view": "string",',
      '  "should_open_council": true|false,',
      '  "council_reason": "string",',
      `  ${optionSchema}`,
      `  ${assumptionSchema}`,
      '  "recommended_tasks": [{"owner":"gemini|codex|claude|human","title":"string","rationale":"string","definition_of_done":"string"}],',
      '  "questions": [{"to":"gemini|codex|claude|human","question":"string"}],',
      '  "sanity_checks": ["string"],',
      '  "risks": ["string"]',
      '}',
    ].join('\n'),
    critique: [
      '{',
      '  "critique": "string",',
      '  "should_open_council": true|false,',
      '  "council_reason": "string",',
      `  ${optionSchema}`,
      `  ${assumptionSchema}`,
      `  ${assumptionAttackSchema}`,
      '  "recommended_tasks": [{"owner":"gemini|codex|claude|human","title":"string","rationale":"string","definition_of_done":"string"}],',
      '  "questions": [{"to":"gemini|codex|claude|human","question":"string"}],',
      '  "edge_cases": ["string"],',
      '  "sanity_checks": ["string"],',
      '  "risks": ["string"]',
      '}',
    ].join('\n'),
    refine: [
      '{',
      '  "view": "string",',
      '  "should_open_council": true|false,',
      '  "council_reason": "string",',
      `  ${decisionSchema},`,
      `  ${optionSchema}`,
      `  ${assumptionSchema}`,
      '  "recommended_tasks": [{"owner":"gemini|codex|claude|human","title":"string","rationale":"string","definition_of_done":"string"}],',
      '  "questions": [{"to":"gemini|codex|claude|human","question":"string"}],',
      '  "sanity_checks": ["string"],',
      '  "risks": ["string"]',
      '}',
    ].join('\n'),
    implement: [
      '{',
      '  "consensus": "string",',
      '  "changed_paths": ["relative/path/to/changed-file"],',
      '  "should_open_council": true|false,',
      '  "council_reason": "string",',
      `  ${decisionSchema},`,
      `  ${assumptionSchema}`,
      '  "disagreements": ["string"],',
      '  "task_allocations": [{"owner":"gemini|codex|claude|human","title":"string","rationale":"string","definition_of_done":"string"}],',
      '  "review_chain": [{"from":"gemini|codex|claude","to":"gemini|codex|claude","purpose":"string"}],',
      '  "questions": [{"to":"gemini|codex|claude|human","question":"string"}],',
      '  "risks": ["string"],',
      '  "next_round_focus": "string"',
      '}',
    ].join('\n'),
  };

  const framing = isPersonaEnabled() ? getAgentFraming(agent) : `You are ${agentConfig.label}`;

  return [
    `${framing} Council round ${round}/${totalRounds}, phase: ${phase}.`,
    '',
    agentConfig.rolePrompt,
    '',
    context,
    '',
    'Return JSON only with keys:',
    jsonSchemas[phase],
    '',
    `Objective: ${userPrompt}`,
    '',
    specContent ? `Anchoring Specification — do not deviate from these requirements:\n${specContent}\n` : '',
    `Phase instruction: ${promptLabel}`,
    '',
    `Decision criteria for convergence: ${formatCriteriaInstruction()}.`,
    'Do not use majority vote. Compare options explicitly, challenge assumptions directly, and prefer the most reversible path that still satisfies correctness.',
    '',
    'Recent council context:',
    buildContextSummary(transcript) || '(none)',
    '',
    phase === 'critique'
      ? 'Focus: attack the strongest assumption in the current leading option before listing smaller issues. Cite specific file paths and line numbers.'
      : phase === 'implement'
        ? 'Focus: write the files now. Do not stop at a plan, handoff, or reversible_first_step. After the files are on disk, return JSON with consensus plus the changed paths. JSON-only without writes is a failure.'
        : phase === 'refine'
          ? 'Focus: resolve critique into a single decision using the criteria above, then produce concrete task specs for Codex (file paths, signatures, DoD).'
          : 'Focus: surface distinct options, state tradeoffs across the decision criteria, and identify assumptions that need to be challenged.',
    'Set should_open_council=true only if deeper multi-round deliberation is necessary.',
  ].join('\n');
}

function defaultTasks(userPrompt) {
  return [
    {
      owner: 'claude',
      title: `Coordinate approach for: ${short(userPrompt, 80)}`,
      rationale: 'Establish scope and risk controls.',
      done: 'Clear sequencing and open questions documented.',
    },
    {
      owner: 'opus',
      title: `Stress-test plan assumptions for: ${short(userPrompt, 80)}`,
      rationale: 'Catch regressions and edge cases.',
      done: 'Critical edge-case list and critiques documented.',
    },
    {
      owner: 'codex',
      title: `Prepare implementation packet for: ${short(userPrompt, 80)}`,
      rationale: 'Produce actionable engineering steps.',
      done: 'Concrete tasks and verification plan ready.',
    },
  ];
}

/** True when council concluded verification-only / no follow-up work. */
export function councilSaysNoFurtherWork(finalDecision, consensus = '') {
  const blob = [
    finalDecision?.summary,
    finalDecision?.why,
    finalDecision?.reversibleFirstStep,
    consensus,
  ].map((v) => cleanText(v)).filter(Boolean).join('\n').toLowerCase();
  if (!blob) return false;
  return /bez\s+(dalš(ích|í)\s+)?změn|bez\s+změny\s+soubor|žádn[áé]\s+(další\s+)?(změn|úkol|zápis)|žádná\s+změna\s+není\s+potřeb|no\s+(further\s+|additional\s+)?(changes?|tasks?)|no\s+(write|change)\s+(is\s+)?needed|nothing\s+to\s+(change|do)|no\s+project\s+files\s+were\s+changed/.test(blob);
}

function formatTradeoffs(tradeoffs, bulletPrefix = '- ') {
  if (!tradeoffs || typeof tradeoffs !== 'object') {
    return [];
  }
  return COUNCIL_DECISION_CRITERIA
    .filter((item) => cleanText(tradeoffs[item.key]))
    .map((item) => `${bulletPrefix}${item.label}: ${tradeoffs[item.key]}`);
}

function colorOwner(owner) {
  return HUMAN_OWNERS.has(owner) ? pc.white(owner) : colorAgent(owner);
}

function buildAgentBrief(agent, objective, report) {
  const agentConfig = getAgent(agent);
  const tasks = Array.isArray(report?.tasks) ? report.tasks : [];
  const questions = Array.isArray(report?.questions) ? report.questions : [];
  const transcript = Array.isArray(report?.transcript) ? report.transcript : [];
  const consensus = cleanText(report?.consensus);
  const finalDecision = report?.finalDecision || null;
  const myTasks = tasks.filter((t) => t.owner === agent || t.owner === 'unassigned');
  const myQuestions = questions.filter((q) => q.to === agent || q.to === 'human');
  const unresolvedAssumptions = Array.isArray(report?.assumptions)
    ? report.assumptions.filter((item) => item.status !== 'validated')
    : [];

  const taskText =
    myTasks.length === 0
      ? '- No explicit task assigned; review consensus and propose next actions.'
      : myTasks
          .map((t) => `- ${t.title}${t.done ? ` (DoD: ${t.done})` : ''}${t.rationale ? ` [${t.rationale}]` : ''}`)
          .join('\n');

  const questionText =
    myQuestions.length === 0 ? '- none' : myQuestions.map((q) => `- to ${q.to}: ${q.question}`).join('\n');

  const decisionLines = finalDecision
    ? [
        `Decision owner: ${finalDecision.owner}`,
        `Decision confidence: ${finalDecision.confidence || 'n/a'}`,
        `Next action: ${report?.recommendedNextAction || finalDecision.nextAction || report?.recommendedMode || 'handoff'}`,
        `Reversible first step: ${finalDecision.reversibleFirstStep || 'not specified'}`,
        ...formatTradeoffs(finalDecision.tradeoffs),
      ]
    : ['- No explicit final decision captured; use transcript summary.'];

  const unresolvedText =
    unresolvedAssumptions.length === 0
      ? '- none'
      : unresolvedAssumptions
          .slice(0, 5)
          .map((item) => `- ${item.assumption}${item.owner && item.owner !== 'unassigned' ? ` [owner: ${item.owner}]` : ''}`)
          .join('\n');

  return [
    `Hydra Council assignment for ${agentConfig ? agentConfig.label : agent.toUpperCase()}.`,
    agentConfig ? agentConfig.rolePrompt : '',
    '',
    `Objective: ${objective}`,
    `Consensus: ${consensus || 'No consensus text generated; use transcript summary.'}`,
    'Decision synthesis:',
    decisionLines.join('\n'),
    'Assigned tasks:',
    taskText,
    'Unresolved assumptions:',
    unresolvedText,
    'Open questions:',
    questionText,
    'Latest council excerpts:',
    buildContextSummary(transcript),
    'Next step: Start with top task and handoff milestone or blocker via Hydra.',
  ].filter(Boolean).join('\n');
}

// ─────────────────────────────────────────────────────────────
// Adversarial Council Mode
// Flow: DIVERGE (parallel, no shared context) → ATTACK (parallel,
// assumption targeting) → SYNTHESIZE (Claude as decider) → IMPLEMENT (Codex)
// ─────────────────────────────────────────────────────────────

function buildDivergePrompt(agent, userPrompt, specContent) {
  const agentConfig = getAgent(agent);
  const context = getProjectContext(agent, {}, config);
  const framing = isPersonaEnabled() ? getAgentFraming(agent) : `You are ${agentConfig.label}`;
  const tradeoffsSchema = '{"correctness":"string","complexity":"string","reversibility":"string","user_impact":"string"}';
  return [
    `${framing} You are in the DIVERGE phase of an adversarial council.`,
    '',
    agentConfig.rolePrompt,
    '',
    context,
    '',
    'IMPORTANT: Answer completely independently. You will not see other agents\' answers at this stage. Produce your own genuine view — do not anchor to any shared framing.',
    '',
    'Return JSON only with keys:',
    '{',
    '  "view": "string — your independent analysis and approach",',
    '  "decision_options": [{"option":"string","summary":"string","preferred":true|false,"tradeoffs":' + tradeoffsSchema + '}],',
    '  "assumptions": [{"assumption":"string","status":"open","evidence":"string","impact":"string","owner":"' + agent + '"}],',
    '  "recommended_tasks": [{"owner":"gemini|codex|claude|human","title":"string","rationale":"string","definition_of_done":"string"}],',
    '  "questions": [{"to":"gemini|codex|claude|human","question":"string"}],',
    '  "risks": ["string"],',
    '  "sanity_checks": ["string"]',
    '}',
    '',
    `Objective: ${userPrompt}`,
    '',
    specContent ? `Anchoring Specification:\n${specContent}\n` : '',
    `Decision criteria: ${formatCriteriaInstruction()}.`,
    'Focus: surface distinct options, state tradeoffs across the criteria, and identify your strongest assumptions.',
  ].filter(Boolean).join('\n');
}

function buildAttackPrompt(agent, userPrompt, divergeEntries, specContent) {
  const agentConfig = getAgent(agent);
  const context = getProjectContext(agent, {}, config);
  const framing = isPersonaEnabled() ? getAgentFraming(agent) : `You are ${agentConfig.label}`;
  const othersOutput = divergeEntries
    .filter((e) => e.agent !== agent)
    .map((e) => {
      const content = e.parsed ? JSON.stringify(e.parsed) : e.rawText;
      return `${e.agent.toUpperCase()} independent view:\n${short(content, 1200)}`;
    })
    .join('\n\n');
  return [
    `${framing} You are in the ATTACK phase of an adversarial council.`,
    '',
    agentConfig.rolePrompt,
    '',
    context,
    '',
    `Objective: ${userPrompt}`,
    '',
    specContent ? `Anchoring Specification:\n${specContent}\n` : '',
    'Other agents submitted independent views (you did not see these before now):',
    '',
    othersOutput,
    '',
    'For each other agent\'s view, identify their single strongest (most load-bearing) assumption and provide a concrete attack vector — a scenario or counterexample that would break that assumption.',
    '',
    'Return JSON only with keys:',
    '{',
    '  "assumption_attacks": [',
    '    {"target_agent":"gemini|codex|claude","assumption":"string","attack_vector":"string","severity":"low|medium|high","suggested_fix":"string"}',
    '  ],',
    '  "strongest_own_assumption": "string — the most load-bearing assumption in your own diverge answer",',
    '  "questions": [{"to":"gemini|codex|claude|human","question":"string"}]',
    '}',
    '',
    'Be precise and adversarial. Target load-bearing assumptions only — if the assumption is wrong, the whole approach fails.',
  ].filter(Boolean).join('\n');
}

function buildSynthesizePrompt(userPrompt, divergeEntries, attackEntries, specContent) {
  const agentConfig = getAgent('claude');
  const context = getProjectContext('claude', {}, config);
  const framing = isPersonaEnabled() ? getAgentFraming('claude') : `You are ${agentConfig.label}`;
  const tradeoffsSchema = '{"correctness":"string","complexity":"string","reversibility":"string","user_impact":"string"}';
  const allDiverge = divergeEntries
    .map((e) => `${e.agent.toUpperCase()} independent view:\n${short(e.parsed ? JSON.stringify(e.parsed) : e.rawText, 1000)}`)
    .join('\n\n');
  const allAttacks = attackEntries
    .map((e) => `${e.agent.toUpperCase()} attacks:\n${short(e.parsed ? JSON.stringify(e.parsed) : e.rawText, 800)}`)
    .join('\n\n');
  return [
    `${framing} You are in the SYNTHESIZE phase of an adversarial council. You are the designated decision owner.`,
    '',
    agentConfig.rolePrompt,
    '',
    context,
    '',
    `Objective: ${userPrompt}`,
    '',
    specContent ? `Anchoring Specification:\n${specContent}\n` : '',
    '== Independent Views (Diverge Phase) ==',
    allDiverge,
    '',
    '== Assumption Attacks (Attack Phase) ==',
    allAttacks,
    '',
    'Synthesize this into a single decision. Do NOT use majority vote. Compare options explicitly using the decision criteria.',
    'When agents disagree, prefer the most reversible option unless there is clear evidence for a less reversible one.',
    '',
    `Decision criteria: ${formatCriteriaInstruction()}.`,
    '',
    'Return JSON only with keys:',
    '{',
    '  "view": "string — synthesis narrative: what you decided and why",',
    '  "decision": {',
    '    "summary": "string",',
    '    "why": "string — which tradeoffs you prioritized and why",',
    '    "owner": "claude",',
    '    "confidence": "low|medium|high",',
    '    "next_action": "handoff|deeper_council|human_decision",',
    '    "reversible_first_step": "string — the most reversible concrete first action",',
    '    "tradeoffs": ' + tradeoffsSchema,
    '  },',
    '  "criteria_scores": {',
    '    "claude_view": {"correctness":0-10,"complexity":0-10,"reversibility":0-10,"user_impact":0-10},',
    '    "gemini_view": {"correctness":0-10,"complexity":0-10,"reversibility":0-10,"user_impact":0-10},',
    '    "codex_view": {"correctness":0-10,"complexity":0-10,"reversibility":0-10,"user_impact":0-10}',
    '  },',
    '  "surviving_assumptions": [{"assumption":"string","owner":"gemini|codex|claude","evidence":"string"}],',
    '  "killed_assumptions": [{"assumption":"string","killed_by":"string","why":"string"}],',
    '  "recommended_tasks": [{"owner":"gemini|codex|claude|human","title":"string","rationale":"string","definition_of_done":"string"}],',
    '  "risks": ["string"]',
    '}',
  ].filter(Boolean).join('\n');
}

/**
 * Resolve the ordered list of active agents for adversarial council.
 * Preserves default ordering ['claude','opus','codex'] and filters to the allowlist.
 */
export function resolveActiveAgents(agentsFilter, defaults = ['claude', 'opus', 'codex']) {
  if (!agentsFilter || !agentsFilter.length) return [...defaults];
  return defaults.filter((a) => agentsFilter.includes(a));
}

/** Ordered adversarial phase names (excluding implement which runs once after all rounds). */
const ADV_PHASE_ORDER = Object.freeze(['diverge', 'attack', 'synthesize']);

/**
 * Compute the resume point for an adversarial run from existing transcript entries.
 * Returns { startRound, startPhaseIdx } where startPhaseIdx indexes ADV_PHASE_ORDER.
 * Returns { startRound: Infinity } when implement was already completed.
 */
export function computeAdversarialResumePoint(transcript) {
  if (!transcript.length) return { startRound: 1, startPhaseIdx: 0 };
  const last = transcript.at(-1);
  if (last.phase === 'implement') return { startRound: Infinity, startPhaseIdx: 0 };
  const lastPhaseIdx = ADV_PHASE_ORDER.indexOf(last.phase);
  const lastRound = last.round || 1;
  // After synthesize (last phase in a round), advance to next round
  if (lastPhaseIdx < 0 || lastPhaseIdx >= ADV_PHASE_ORDER.length - 1) {
    return { startRound: lastRound + 1, startPhaseIdx: 0 };
  }
  return { startRound: lastRound, startPhaseIdx: lastPhaseIdx + 1 };
}

async function runAdversarialCouncil(prompt, report, { preview, timeoutMs, specContent, promptHash, agentsFilter, rounds }) {
  const activeAgents = resolveActiveAgents(agentsFilter);
  // Synthesize phase: prefer claude; fall back to first active agent
  const synthesizeAgent = activeAgents.includes('claude') ? 'claude' : (activeAgents[0] || 'claude');

  // Update councilFlow to reflect active participants
  report.councilFlow = [
    ...activeAgents.map((a) => `${a}:diverge`),
    ...activeAgents.map((a) => `${a}:attack`),
    `${synthesizeAgent}:synthesize`,
    ...(activeAgents.includes('codex') ? ['codex:implement'] : []),
  ];

  process.stderr.write(JSON.stringify({ type: 'council_mode', mode: 'adversarial', participants: activeAgents, rounds }) + '\n');

  // Compute resume point from existing transcript (populated from checkpoint before this call)
  let startRound = 1;
  let startPhaseIdx = 0;
  let implementAlreadyDone = false;

  if (report.transcript.length > 0) {
    const resume = computeAdversarialResumePoint(report.transcript);
    if (resume.startRound === Infinity) {
      implementAlreadyDone = true;
      startRound = rounds + 1; // skip all round loops
    } else {
      startRound = resume.startRound;
      startPhaseIdx = resume.startPhaseIdx;
    }
    const cached = report.transcript.length;
    const resumePhase = ADV_PHASE_ORDER[startPhaseIdx] || 'implement';
    process.stderr.write(`  Resuming adversarial council from round ${Math.min(startRound, rounds + 1)}, phase ${resumePhase} (${cached} phases cached)\n`);
  }

  // ── Rounds loop ──
  for (let round = 1; round <= rounds; round++) {
    const skipDiverge = round < startRound || (round === startRound && startPhaseIdx > 0);
    const skipAttack  = round < startRound || (round === startRound && startPhaseIdx > 1);
    const skipSynth   = round < startRound || (round === startRound && startPhaseIdx > 2);

    // ── Phase 0: DIVERGE (parallel, no shared context) ──
    if (!skipDiverge) {
      process.stderr.write(JSON.stringify({ type: 'council_phase', action: 'start', phase: 'diverge', round, agents: activeAgents }) + '\n');
      const divergeSpinner = createSpinner(
        `${DIM('diverge')} ${activeAgents.map(colorAgent).join(' ')} ${DIM(`(round ${round}/${rounds}, parallel)`)}`,
        { style: 'orbital' }
      );
      divergeSpinner.start();

      if (preview) {
        for (const agent of activeAgents) {
          const entry = { round, agent, phase: 'diverge', ok: true, rawText: '{}', parsed: { view: `${agent} diverge preview` }, error: '' };
          report.transcript.push(entry);
        }
        divergeSpinner.succeed(`${DIM('diverge')} complete (preview, round ${round})`);
      } else {
        const divergeStart = Date.now();
        const divergeResults = await Promise.allSettled(
          activeAgents.map(async (agent) => {
            const p = buildDivergePrompt(agent, prompt, specContent);
            const result = await callAgentAsync(agent, p, timeoutMs);
            return { agent, result };
          })
        );
        divergeSpinner.succeed(`${DIM('diverge')} complete ${DIM(`(round ${round}, ${formatElapsed(Date.now() - divergeStart)})`)}`);
        for (const settled of divergeResults) {
          if (settled.status === 'rejected') continue;
          const { agent, result } = settled.value;
          const parsed = parseJsonLoose(result.stdout);
          const entry = { round, agent, phase: 'diverge', ok: result.ok, rawText: result.stdout, parsed, error: result.error || result.stderr || '', recovered: result.recovered || false, recoveredFrom: result.originalModel, recoveredTo: result.newModel };
          report.transcript.push(entry);
        }
        saveCheckpoint(promptHash, prompt, round, 0, report.transcript, specContent);
      }
      process.stderr.write(JSON.stringify({ type: 'council_phase', action: 'complete', phase: 'diverge', round }) + '\n');
    }

    // Collect diverge entries for this round (context for attack phase)
    const divergeEntries = report.transcript.filter((e) => e.phase === 'diverge' && e.round === round);

    // ── Phase 1: ATTACK (parallel, each sees all diverge outputs) ──
    if (!skipAttack) {
      process.stderr.write(JSON.stringify({ type: 'council_phase', action: 'start', phase: 'attack', round, agents: activeAgents }) + '\n');
      const attackSpinner = createSpinner(
        `${DIM('attack')} ${activeAgents.map(colorAgent).join(' ')} ${DIM(`(round ${round}/${rounds}, parallel)`)}`,
        { style: 'orbital' }
      );
      attackSpinner.start();

      if (preview) {
        for (const agent of activeAgents) {
          const entry = { round, agent, phase: 'attack', ok: true, rawText: '{}', parsed: { assumption_attacks: [] }, error: '' };
          report.transcript.push(entry);
        }
        attackSpinner.succeed(`${DIM('attack')} complete (preview, round ${round})`);
      } else {
        const attackStart = Date.now();
        const attackResults = await Promise.allSettled(
          activeAgents.map(async (agent) => {
            const p = buildAttackPrompt(agent, prompt, divergeEntries, specContent);
            const result = await callAgentAsync(agent, p, timeoutMs);
            return { agent, result };
          })
        );
        attackSpinner.succeed(`${DIM('attack')} complete ${DIM(`(round ${round}, ${formatElapsed(Date.now() - attackStart)})`)}`);
        for (const settled of attackResults) {
          if (settled.status === 'rejected') continue;
          const { agent, result } = settled.value;
          const parsed = parseJsonLoose(result.stdout);
          const entry = { round, agent, phase: 'attack', ok: result.ok, rawText: result.stdout, parsed, error: result.error || result.stderr || '', recovered: result.recovered || false, recoveredFrom: result.originalModel, recoveredTo: result.newModel };
          report.transcript.push(entry);
        }
        saveCheckpoint(promptHash, prompt, round, 1, report.transcript, specContent);
      }
      process.stderr.write(JSON.stringify({ type: 'council_phase', action: 'complete', phase: 'attack', round }) + '\n');
    }

    // Collect attack entries for this round (context for synthesize phase)
    const attackEntries = report.transcript.filter((e) => e.phase === 'attack' && e.round === round);

    // ── Phase 2: SYNTHESIZE (designated decider) ──
    if (!skipSynth) {
      process.stderr.write(JSON.stringify({ type: 'council_phase', action: 'start', phase: 'synthesize', round, agent: synthesizeAgent }) + '\n');
      const synthesizeSpinner = createSpinner(
        `${colorAgent(synthesizeAgent)} ${DIM(`synthesize (round ${round}/${rounds})`)}`,
        { style: 'orbital' }
      );
      synthesizeSpinner.start();

      if (preview) {
        report.transcript.push({ round, agent: synthesizeAgent, phase: 'synthesize', ok: true, rawText: '{}', parsed: { view: 'synthesize preview', decision: { summary: 'preview', confidence: 'high', next_action: 'handoff', reversible_first_step: 'preview step', tradeoffs: {} } }, error: '' });
        synthesizeSpinner.succeed(`${colorAgent(synthesizeAgent)} ${DIM('synthesize')} complete (preview, round ${round})`);
      } else {
        const synthesizeStart = Date.now();
        const synthesizeResult = await callAgentAsync(synthesizeAgent, buildSynthesizePrompt(prompt, divergeEntries, attackEntries, specContent), timeoutMs);
        synthesizeSpinner.succeed(`${colorAgent(synthesizeAgent)} ${DIM('synthesize')} complete ${DIM(`(round ${round}, ${formatElapsed(Date.now() - synthesizeStart)})`)}`);
        report.transcript.push({ round, agent: synthesizeAgent, phase: 'synthesize', ok: synthesizeResult.ok, rawText: synthesizeResult.stdout, parsed: parseJsonLoose(synthesizeResult.stdout), error: synthesizeResult.error || synthesizeResult.stderr || '', recovered: synthesizeResult.recovered || false, recoveredFrom: synthesizeResult.originalModel, recoveredTo: synthesizeResult.newModel });
        saveCheckpoint(promptHash, prompt, round, 2, report.transcript, specContent);
      }
      process.stderr.write(JSON.stringify({ type: 'council_phase', action: 'complete', phase: 'synthesize', round, agent: synthesizeAgent }) + '\n');
    }
  }

  // ── Phase 3: IMPLEMENT (once, after all rounds; only if codex is active and not preview) ──
  if (!implementAlreadyDone && activeAgents.includes('codex') && !preview) {
    const implementStep = COUNCIL_FLOW.find((s) => s.phase === 'implement');
    process.stderr.write(JSON.stringify({ type: 'council_phase', action: 'start', phase: 'implement', agent: 'codex' }) + '\n');
    const implementSpinner = createSpinner(`${colorAgent('codex')} ${DIM('implement')}`, { style: 'orbital' });
    implementSpinner.start();
    const implementStart = Date.now();
    const implementResult = await callAgentAsync('codex', buildStepPrompt(implementStep, prompt, report.transcript, 1, 1, specContent), timeoutMs);
    implementSpinner.succeed(`${colorAgent('codex')} ${DIM('implement')} complete ${DIM(`(${formatElapsed(Date.now() - implementStart)})`)}`);
    report.transcript.push({ round: rounds, agent: 'codex', phase: 'implement', ok: implementResult.ok, rawText: implementResult.stdout, parsed: parseJsonLoose(implementResult.stdout), error: implementResult.error || implementResult.stderr || '', recovered: implementResult.recovered || false, recoveredFrom: implementResult.originalModel, recoveredTo: implementResult.newModel });
    saveCheckpoint(promptHash, prompt, rounds, 3, report.transcript, specContent);
    process.stderr.write(JSON.stringify({ type: 'council_phase', action: 'complete', phase: 'implement', agent: 'codex' }) + '\n');
  }
}

async function main() {
  const { options, positionals } = parseArgs(process.argv);
  const prompt = getPrompt(options, positionals);

  if (!prompt) {
    console.error('Missing prompt. Example: node hydra-council.mjs prompt="Investigate startup regressions"');
    process.exit(1);
  }

  const mode = String(options.mode || 'live').toLowerCase();
  const preview = mode === 'preview' || boolFlag(options.preview, false);
  const publish = boolFlag(options.publish, !preview);
  const rounds = Math.max(1, Math.min(4, Number.parseInt(String(options.rounds || '2'), 10) || 2));
  const timeoutMs = Number.parseInt(String(options.timeoutMs || DEFAULT_TIMEOUT_MS), 10);
  const url = String(options.url || DEFAULT_URL);
  const emit = String(options.emit || 'summary').toLowerCase();
  const save = boolFlag(options.save, emit === 'json' ? false : true);
  const agentsFilter = options.agents ? options.agents.split(',').map((a) => a.trim().toLowerCase()).filter(Boolean) : null;

  const report = {
    id: runId('HYDRA_COUNCIL'),
    startedAt: nowIso(),
    finishedAt: null,
    prompt,
    mode: preview ? 'preview' : 'live',
    publish,
    rounds,
    councilFlow: (agentsFilter ? COUNCIL_FLOW.filter((s) => agentsFilter.includes(s.agent)) : COUNCIL_FLOW).map((s) => `${s.agent}:${s.phase}`),
    url,
    project: config.projectName,
    daemonSummary: null,
    transcript: [],
    consensus: '',
    tasks: [],
    questions: [],
    risks: [],
    decisionOptions: [],
    assumptions: [],
    assumptionAttacks: [],
    disagreements: [],
    finalDecision: null,
    councilVotes: [],
    recommendedMode: 'handoff',
    recommendedNextAction: 'handoff',
    recommendationRationale: '',
    published: null,
  };

  try {
    const summaryResponse = await request('GET', url, '/summary');
    report.daemonSummary = summaryResponse.summary;
  } catch {
    report.daemonSummary = null;
  }

  // Generate spec for complex prompts to anchor council work
  let specContent = null;
  const classification = classifyPrompt(prompt);
  if (classification.tier === 'complex' && !preview) {
    try {
      const spec = await generateSpec(prompt, report.id, { cwd: config.projectRoot });
      if (spec) {
        specContent = spec.specContent;
        report.specId = spec.specId;
      }
    } catch { /* non-critical */ }
  }

  // Filter council flow to only include agents in the filter (if provided)
  const activeFlow = agentsFilter
    ? COUNCIL_FLOW.filter((step) => agentsFilter.includes(step.agent))
    : COUNCIL_FLOW;

  // Checkpoint resume: check for existing checkpoint and restore state
  const promptHash = simpleHash(prompt);
  const fresh = boolFlag(options.fresh, false);
  let startRound = 1;
  let startStepIdx = 0;

  if (!preview && !fresh) {
    const checkpoint = loadCheckpoint(promptHash, prompt);
    if (checkpoint && Array.isArray(checkpoint.transcript) && checkpoint.transcript.length > 0) {
      report.transcript = checkpoint.transcript;
      if (checkpoint.specContent && !specContent) {
        specContent = checkpoint.specContent;
      }
      // Determine resume point from last completed entry
      const last = checkpoint.transcript.at(-1);
      startRound = last.round;
      startStepIdx = activeFlow.findIndex(
        (s) => s.agent === last.agent && s.phase === last.phase
      );
      if (startStepIdx >= 0) {
        startStepIdx += 1; // Start after the last completed step
        if (startStepIdx >= activeFlow.length) {
          startStepIdx = 0;
          startRound += 1;
        }
      } else {
        startStepIdx = 0;
      }
      const cached = checkpoint.transcript.length;
      process.stderr.write(`  Resuming council from round ${startRound}, step ${startStepIdx + 1} (${cached} phases cached)\n`);
    }
  }

  // Select council execution mode
  const councilMode = loadHydraConfig().routing?.councilMode || 'sequential';
  if (councilMode === 'adversarial') {
    await runAdversarialCouncil(prompt, report, { preview, timeoutMs, specContent, promptHash, agentsFilter, rounds });
  } else {
  for (let round = 1; round <= rounds; round += 1) {
    for (let stepIdx = 0; stepIdx < activeFlow.length; stepIdx++) {
      // Skip phases already completed from checkpoint
      if (round < startRound || (round === startRound && stepIdx < startStepIdx)) {
        continue;
      }
      const step = activeFlow[stepIdx];
      const stepNum = stepIdx + 1;
      const totalSteps = activeFlow.length;
      const promptText = buildStepPrompt(step, prompt, report.transcript, round, rounds, specContent);

      if (preview) {
        const parsed = {
          view: `${step.agent} ${step.phase} preview response`,
          consensus: `${step.agent} ${step.phase} preview consensus`,
          decision_options: [
            {
              option: 'reversible_probe',
              summary: `Preview option from ${step.agent}`,
              preferred: step.phase !== 'critique',
              tradeoffs: {
                correctness: 'Safe preview choice',
                complexity: 'Low',
                reversibility: 'High',
                user_impact: 'Low risk',
              },
            },
          ],
          assumptions: [
            {
              assumption: `Preview assumption from ${step.agent}`,
              status: step.phase === 'implement' ? 'validated' : 'open',
              evidence: 'Preview evidence',
              impact: 'Preview impact',
              owner: step.agent,
            },
          ],
          decision: {
            summary: `${step.agent} ${step.phase} preview synthesis`,
            why: 'Preview rationale',
            owner: step.agent,
            confidence: step.phase === 'implement' ? 'high' : 'medium',
            next_action: step.phase === 'implement' ? 'handoff' : 'deeper_council',
            reversible_first_step: `Preview reversible first step from ${step.agent}`,
            tradeoffs: {
              correctness: 'Preview correctness note',
              complexity: 'Preview complexity note',
              reversibility: 'Preview reversibility note',
              user_impact: 'Preview impact note',
            },
          },
          recommended_tasks: defaultTasks(prompt).map((t) => ({
            owner: t.owner,
            title: t.title,
            rationale: t.rationale,
            definition_of_done: t.done,
          })),
          questions: [{ to: 'human', question: `Preview question from ${step.agent} (${step.phase})` }],
        };

        report.transcript.push({
          round,
          agent: step.agent,
          phase: step.phase,
          ok: true,
          rawText: JSON.stringify(parsed),
          parsed,
          error: '',
        });
        continue;
      }

      // Emit progress marker: phase starting
      const progressStart = JSON.stringify({
        type: 'council_phase',
        action: 'start',
        round,
        step: stepNum,
        totalSteps,
        agent: step.agent,
        phase: step.phase,
      });
      process.stderr.write(progressStart + '\n');

      const spinner = createSpinner(`${colorAgent(step.agent)} ${DIM(step.phase)} (round ${round}/${rounds})`, { style: 'orbital' });
      spinner.start();
      const phaseStartMs = Date.now();
      const implementBeforeFiles = step.phase === 'implement'
        ? snapshotProjectFiles(config.projectRoot)
        : null;
      let result = await callAgentAsync(step.agent, promptText, timeoutMs);

      // Rate limit retry (1 attempt with backoff)
      if (!result.ok) {
        const rlCheck = detectRateLimitError(step.agent, result);
        if (rlCheck.isRateLimited) {
          const delay = calculateBackoff(0, { retryAfterMs: rlCheck.retryAfterMs });
          spinner.text = `${colorAgent(step.agent)} ${DIM(step.phase)} rate limited, retrying in ${(delay / 1000).toFixed(0)}s...`;
          await new Promise(r => globalThis.setTimeout(r, delay));
          result = await callAgentAsync(step.agent, promptText, timeoutMs);
        }
      }

      // Timeout retry: strip transcript context and retry once with bare prompt
      if (!result.ok && result.timedOut) {
        const compactedPrompt = buildStepPrompt(step, prompt, [], round, rounds, specContent);
        spinner.text = `${colorAgent(step.agent)} ${DIM(step.phase)} timed out — retrying with compacted context...`;
        result = await callAgentAsync(step.agent, compactedPrompt, timeoutMs);
        if (result.ok) {
          result._compactedRetry = true;
        }
      }

      let parsed = parseJsonLoose(result.stdout);
      if (result.ok && implementBeforeFiles) {
        const changedPaths = changedProjectFiles(implementBeforeFiles, snapshotProjectFiles(config.projectRoot));
        if (changedPaths.length === 0) {
          const decision = extractFinalDecision(parsed, { agent: step.agent, phase: step.phase });
          const consensusText = cleanText(decision?.summary || parsed?.consensus);
          const signal = extractCouncilSignal(parsed);
          // Verify-only / already-correct: don't force a dummy file write just to pass the gate.
          if (signal?.vote === false || councilSaysNoFurtherWork(decision, consensusText)) {
            parsed = parsed && typeof parsed === 'object' ? parsed : {};
            parsed.changed_paths = [];
          } else {
            result = {
              ...result,
              ok: false,
              error: 'Implement phase completed without changing a project file.',
            };
          }
        } else {
          parsed = parsed && typeof parsed === 'object' ? parsed : {};
          // Trust the observed filesystem over a possibly incomplete agent claim.
          parsed.changed_paths = changedPaths;
        }
      }
      const durationMs = Date.now() - phaseStartMs;
      if (result.ok) {
        const suffix = result.recovered
          ? ` ${DIM(`(recovered: ${result.newModel})`)}`
          : result._compactedRetry
            ? ` ${DIM('(compacted retry)')}`
            : '';
        spinner.succeed(`${colorAgent(step.agent)} ${DIM(step.phase)} complete${suffix}`);
      } else {
        spinner.fail(`${colorAgent(step.agent)} ${DIM(step.phase)} failed`);
        // Log full error details
        const errorMsg = result.errorDetail || result.error || result.stderr || 'Unknown error';
        console.error(`  ${ERROR('Error:')} ${errorMsg.slice(0, 200)}`);
        if (result.errorCategory) {
          console.error(`  ${DIM(`[${result.errorCategory}]`)}`);
        }
        if (result.errorContext && result.errorContext.length > 50) {
          console.error(`  ${DIM(result.errorContext.slice(0, 300))}`);
        }
      }

      // Doctor notification on phase failure
      if (!result.ok && isDoctorEnabled()) {
        try {
          await notifyDoctor({
            pipeline: 'council',
            phase: step.phase,
            agent: step.agent,
            round,
            error: result.error || result.stderr || 'unknown failure',
            exitCode: result.exitCode ?? null,
            signal: result.signal || null,
            command: result.command,
            args: result.args,
            promptSnippet: result.promptSnippet,
            stderr: result.stderr,
            stdout: result.output || result.stdout,
            errorCategory: result.errorCategory || null,
            errorDetail: result.errorDetail || null,
            errorContext: result.errorContext || null,
            context: `Council phase ${step.phase} failed in round ${round}`,
          });
        } catch { /* doctor notification non-critical */ }
      }

      // Emit progress marker: phase complete
      const progressComplete = JSON.stringify({
        type: 'council_phase',
        action: 'complete',
        round,
        step: stepNum,
        totalSteps,
        agent: step.agent,
        phase: step.phase,
        ok: result.ok,
        durationMs,
        recovered: result.recovered || false,
        ...(result.ok ? {} : {
          error: result.error || result.stderr || 'Unknown error',
          errorCategory: result.errorCategory || null,
          errorDetail: result.errorDetail || null,
        }),
      });
      process.stderr.write(progressComplete + '\n');

      report.transcript.push({
        round,
        agent: step.agent,
        phase: step.phase,
        ok: result.ok,
        rawText: result.stdout,
        parsed,
        error: result.error || result.stderr || '',
        recovered: result.recovered || false,
        recoveredFrom: result.originalModel,
        recoveredTo: result.newModel,
        compactedRetry: result._compactedRetry || false,
      });

      // Save checkpoint after each completed phase
      if (!preview) {
        saveCheckpoint(promptHash, prompt, round, stepIdx, report.transcript, specContent);
      }

      // Stop after a successful implement when agents say no further deliberation.
      // Default is 2 rounds — without this, smoke/verify runs burn a full second pass.
      if (step.phase === 'implement' && result.ok && round < rounds) {
        const signal = extractCouncilSignal(parsed);
        const decision = extractFinalDecision(parsed, { agent: step.agent, phase: step.phase });
        const consensusText = cleanText(decision?.summary || parsed?.consensus);
        if (signal?.vote === false || councilSaysNoFurtherWork(decision, consensusText)) {
          process.stderr.write(`${JSON.stringify({
            type: 'council_phase',
            action: 'early_stop',
            round,
            reason: 'converged_no_further_council',
          })}\n`);
          round = rounds;
          break;
        }
      }
    }
  }
  } // end sequential council

  const failedImplementation = report.transcript.find((entry) => entry.phase === 'implement' && !entry.ok);
  if (!preview && failedImplementation) {
    // A successful-looking council report without a real implementation is
    // misleading and would let publish/UI present a plan as completed work.
    throw new Error(`Council implement phase failed: ${failedImplementation.error || 'no project files were changed'}`);
  }

  // Council completed successfully — clean up checkpoint
  if (!preview) {
    deleteCheckpoint(promptHash);
  }

  Object.assign(report, synthesizeCouncilTranscript(prompt, report.transcript));

  if (publish) {
    try {
      const health = await request('GET', url, '/health');
      if (!health.ok) {
        throw new Error('Hydra daemon is not healthy.');
      }

      const createdTasks = [];
      for (const task of report.tasks) {
        const created = await request('POST', url, '/task/add', {
          title: task.title,
          owner: task.owner,
          status: 'todo',
          notes: task.rationale ? `Council rationale: ${task.rationale}` : '',
        });
        createdTasks.push(created.task);
      }

      const decisionTitle = `Hydra Council: ${short(prompt, 90)}`;
      const flowLabel = COUNCIL_FLOW
        .map((step) => ({ claude: 'Claude', opus: 'Opus', gemini: 'Gemini', codex: 'Codex' }[step.agent] || step.agent))
        .join('\u2192');
      const decision = await request('POST', url, '/decision', {
        title: decisionTitle,
        owner: 'human',
        rationale: report.finalDecision?.why || report.consensus || 'Council completed without explicit consensus.',
        impact: `Rounds=${rounds}; Tasks=${createdTasks.length}; Flow=${flowLabel}; next=${report.recommendedNextAction || report.recommendedMode}`,
      });

      const handoffs = [];
      // The daemon accepts handoffs only for the three CLI agents.  AGENT_NAMES
      // also includes local, which is not configured on this installation.
      const requestedPublishAgents = agentsFilter || AGENT_NAMES;
      const publishAgents = COUNCIL_HANDOFF_AGENTS.filter((agent) => requestedPublishAgents.includes(agent));
      for (const agent of publishAgents) {
        const agentTaskIds = createdTasks.filter((t) => t.owner === agent || t.owner === 'unassigned').map((t) => t.id);
        const summary = buildAgentBrief(agent, prompt, report);
        const handoff = await request('POST', url, '/handoff', {
          from: 'human',
          to: agent,
          summary,
          nextStep: agentTaskIds.length > 0
            ? 'Acknowledge this council handoff and start highest-priority task.'
            : 'No open tasks — verification/smoke complete; nothing further to start.',
          tasks: agentTaskIds,
        });
        handoffs.push(handoff.handoff);
      }

      report.published = {
        ok: true,
        decision: decision.decision,
        tasks: createdTasks,
        handoffs,
      };
    } catch (error) {
      report.published = {
        ok: false,
        error: error.message,
      };
    }
  } else {
    report.published = {
      ok: true,
      skipped: true,
      reason: 'publish=false',
    };
  }

  report.finishedAt = nowIso();

  if (emit === 'json') {
    console.log(
      JSON.stringify(
        {
          ok: true,
          report,
        },
        null,
        2
      )
    );
    return;
  }

  if (save) {
    ensureDir(RUNS_DIR);
    const outPath = path.join(RUNS_DIR, `${report.id}.json`);
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`Hydra council report saved: ${path.relative(config.projectRoot, outPath)}`);
  }

  // ── A. Compact Metadata ──
  console.log(sectionHeader('Hydra Council Summary'));
  console.log(label('ID', DIM(report.id)));
  console.log(label('Project', pc.white(config.projectName)));
  console.log(label('Mode', ACCENT(report.mode)));
  console.log(label('Rounds', pc.white(String(rounds))));
  if (report.startedAt && report.finishedAt) {
    const durationMs = new Date(report.finishedAt) - new Date(report.startedAt);
    if (durationMs > 0) console.log(label('Duration', pc.white(formatElapsed(durationMs))));
  }

  // ── B. Phase Health ──
  if (report.transcript.length > 0) {
    console.log('');
    console.log(sectionHeader('Phase Health'));
    for (const entry of report.transcript) {
      if (entry.ok) {
        console.log(`  ${SUCCESS('\u2713')} ${colorAgent(entry.agent)} ${DIM(entry.phase)} ${DIM(`(round ${entry.round})`)}`);
      } else {
        const failLabel = entry.error?.includes('ETIMEDOUT') ? 'TIMEOUT' : 'FAILED';
        console.log(`  ${ERROR('\u2717')} ${colorAgent(entry.agent)} ${DIM(entry.phase)} ${DIM(`(round ${entry.round})`)} ${ERROR(failLabel)}`);
        if (entry.error) {
          console.log(`    ${DIM('\u2192')} ${DIM(short(entry.error.split('\n')[0], 72))}`);
        }
      }
    }
  }

  // ── C. Convergence ──
  console.log('');
  console.log(sectionHeader('Convergence'));
  if (report.finalDecision) {
    const decision = report.finalDecision;
    console.log(label('Decision owner', colorOwner(decision.owner)));
    console.log(label('Confidence', pc.white(decision.confidence || 'n/a')));
    console.log(label('Next action', pc.white(report.recommendedNextAction || decision.nextAction || report.recommendedMode)));
    if (decision.reversibleFirstStep) {
      console.log(label('Reversible step', pc.white(short(decision.reversibleFirstStep, 72))));
    }
    const unresolvedAssumptions = Array.isArray(report.assumptions)
      ? report.assumptions.filter((item) => item.status !== 'validated').length
      : 0;
    console.log(label('Open assumptions', pc.white(String(unresolvedAssumptions))));
    const tradeoffLines = formatTradeoffs(decision.tradeoffs, '  - ');
    if (tradeoffLines.length > 0) {
      console.log('');
      console.log(DIM('  Criteria tradeoffs:'));
      for (const line of tradeoffLines) {
        console.log(pc.white(line));
      }
    }
  } else {
    console.log(`  ${DIM('No explicit final decision captured.')}`);
  }

  // ── D. Consensus ──
  console.log('');
  console.log(sectionHeader('Consensus'));
  if (report.consensus) {
    // Word-wrap to ~76 chars per line
    const words = report.consensus.split(/\s+/);
    let line = '';
    for (const word of words) {
      if (line.length + word.length + 1 > 76) {
        console.log(`  ${pc.white(line)}`);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) console.log(`  ${pc.white(line)}`);
  } else {
    const failedCount = report.transcript.filter((t) => !t.ok).length;
    if (failedCount > 0) {
      console.log(`  ${WARNING(`No consensus reached (${failedCount} phase(s) failed)`)}`);
    } else {
      console.log(`  ${DIM('(none)')}`);
    }
  }

  // ── E. Tasks List ──
  if (report.tasks.length > 0) {
    console.log('');
    console.log(sectionHeader(`Tasks (${report.tasks.length})`));
    report.tasks.forEach((task, i) => {
      const owner = task.owner || 'unassigned';
      const title = short(task.title || task.description || '', 55);
      console.log(`  ${DIM(`${i + 1}.`)} ${colorOwner(owner)}  ${pc.white(title)}`);
    });
  }

  // ── F. Risks ──
  if (report.risks && report.risks.length > 0) {
    console.log('');
    console.log(sectionHeader('Risks'));
    for (const risk of report.risks) {
      const text = typeof risk === 'string' ? risk : risk.risk || risk.description || JSON.stringify(risk);
      console.log(`  ${WARNING('\u26A0')} ${pc.white(short(text, 72))}`);
    }
  }

  if (report.disagreements?.length > 0) {
    console.log('');
    console.log(sectionHeader('Disagreements'));
    for (const item of report.disagreements) {
      console.log(`  ${WARNING('\u26A0')} ${pc.white(short(item, 72))}`);
    }
  }

  if (report.assumptionAttacks?.length > 0) {
    console.log('');
    console.log(sectionHeader('Assumption Challenges'));
    for (const item of report.assumptionAttacks) {
      const challenge = cleanText(item.challenge || item.assumption);
      if (!challenge) {
        continue;
      }
      console.log(`  ${ACCENT('!')} ${pc.white(short(challenge, 72))}`);
    }
  }

  // ── G. Questions ──
  if (report.questions.length > 0) {
    console.log('');
    console.log(sectionHeader('Questions'));
    for (const q of report.questions) {
      const to = q.to || 'human';
      console.log(`  ${ACCENT('?')} ${DIM('\u2192')} ${colorOwner(to)}${DIM(':')} ${pc.white(short(q.question || '', 65))}`);
    }
  }

  // ── H. Footer ──
  console.log('');
  console.log(divider());
  const recColor = report.recommendedMode === 'council' ? WARNING : SUCCESS;
  console.log(label('Recommended', recColor(report.recommendedMode)));
  console.log(label('Rationale', DIM(short(report.recommendationRationale || 'n/a', 120))));
  let publishedLabel = DIM('no');
  if (report.published?.ok && report.published?.skipped) {
    publishedLabel = DIM('skipped');
  } else if (report.published?.ok) {
    publishedLabel = SUCCESS('yes');
  }
  console.log(label('Published', publishedLabel));
  if (report.published?.ok && !report.published?.skipped) {
    console.log('');
    console.log(DIM('  Pull commands:'));
    console.log(DIM('    npm run hydra:next -- agent=claude'));
    console.log(DIM('    npm run hydra:next -- agent=gemini'));
    console.log(DIM('    npm run hydra:next -- agent=codex'));
  }
  if (report.published?.ok === false) {
    console.log(label('Publish error', ERROR(report.published.error)));
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch((error) => {
    console.error(`Hydra council failed: ${error.message}`);
    process.exit(1);
  });
}
