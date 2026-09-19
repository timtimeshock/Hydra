/**
 * Hydra Evolve Investigator — Self-healing failure diagnosis for the evolve pipeline.
 *
 * When an evolve phase fails (test doesn't compile, implementation breaks tests,
 * agent returns garbage), this module calls a high-reasoning OpenAI model to
 * diagnose the root cause and recommend corrective action.
 *
 * Diagnosis buckets:
 *   transient    — Retry as-is (network flake, rate limit, temporary API issue)
 *   fixable      — Retry with modified prompt/preamble (bad instructions, missing context)
 *   fundamental  — Don't retry (impossible task, missing dependency, wrong approach)
 */

import fs from 'fs';
import path from 'path';
import { streamCompletion } from './hydra-openai.mjs';
import { loadHydraConfig } from './hydra-config.mjs';

// ── State ────────────────────────────────────────────────────────────────────

let investigatorReady = false;
let stats = { investigations: 0, healed: 0, promptTokens: 0, completionTokens: 0 };
let tokenBudgetUsed = 0;
let config = null;

// ── Config ───────────────────────────────────────────────────────────────────

function getInvestigatorConfig() {
  if (config) return config;
  const cfg = loadHydraConfig();
  const inv = cfg.evolve?.investigator || {};
  config = {
    enabled: inv.enabled !== false,
    model: inv.model || 'gpt-5.2',
    reasoningEffort: inv.reasoningEffort || 'high',
    maxAttemptsPerPhase: inv.maxAttemptsPerPhase || 2,
    phases: inv.phases || ['test', 'implement', 'analyze', 'agent'],
    maxTokensBudget: inv.maxTokensBudget || 50_000,
    tryAlternativeAgent: inv.tryAlternativeAgent !== false,
    logToFile: inv.logToFile !== false,
  };
  return config;
}

// ── Init ─────────────────────────────────────────────────────────────────────

/**
 * Initialize the investigator. Validates API key and loads config.
 * @param {object} [overrides] - Optional config overrides
 */
export function initInvestigator(overrides = {}) {
  config = null; // Force reload
  const cfg = getInvestigatorConfig();

  // Apply overrides
  if (overrides.model) cfg.model = overrides.model;
  if (overrides.reasoningEffort) cfg.reasoningEffort = overrides.reasoningEffort;
  if (overrides.maxTokensBudget) cfg.maxTokensBudget = overrides.maxTokensBudget;

  config = cfg;
  stats = { investigations: 0, healed: 0, promptTokens: 0, completionTokens: 0 };
  tokenBudgetUsed = 0;
  investigatorReady = true;
}

/**
 * Check if the investigator is available (enabled + API key present).
 */
export function isInvestigatorAvailable() {
  const cfg = getInvestigatorConfig();
  if (!cfg.enabled) return false;
  return Boolean(process.env.OPENAI_API_KEY);
}

/**
 * Get session stats for the investigator.
 */
export function getInvestigatorStats() {
  return { ...stats, tokenBudgetUsed, tokenBudgetMax: getInvestigatorConfig().maxTokensBudget };
}

/**
 * Reset investigator state for a new session.
 */
export function resetInvestigator() {
  stats = { investigations: 0, healed: 0, promptTokens: 0, completionTokens: 0 };
  tokenBudgetUsed = 0;
  config = null;
  investigatorReady = false;
}

// ── System Prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt() {
  return `You are the Hydra Evolve Investigator — a failure diagnostician for the Hydra multi-agent orchestration system's autonomous self-improvement pipeline.

Your job: When an evolve phase fails, you analyze the error context and classify the failure so the pipeline can self-heal or gracefully give up.

## Hydra Context
Hydra orchestrates Claude, Gemini, and Codex agents. The evolve pipeline runs 7 phases per round:
1. RESEARCH — agents search the web for patterns/tools
2. DELIBERATE — council discusses findings
3. PLAN — create improvement spec + test plan
4. TEST — write comprehensive tests (TDD, using Codex)
5. IMPLEMENT — make changes on isolated branch (using Codex)
6. ANALYZE — multi-agent review of results
7. DECIDE — consensus: keep/reject/revise

Each agent runs as a headless CLI process (claude, gemini, codex) that receives a prompt via stdin and writes output to stdout.

## Diagnosis Buckets

**transient** — The failure is temporary. Retry the same operation as-is.
Examples: rate limit hit, network timeout, API 500/503, agent process crash, temporary file lock

**fixable** — The failure has a specific cause that can be corrected by modifying the prompt or approach.
Examples: test file has syntax error, missing import, wrong test framework used, agent misunderstood the task, wrong file path in prompt, context too large

**fundamental** — The failure cannot be fixed by retrying. The task itself is problematic.
Examples: feature requires dependency not available, task is architecturally impossible, circular dependency, spec is contradictory

## Response Format
Respond with ONLY a JSON object (no markdown, no explanation outside JSON):
{
  "diagnosis": "transient" | "fixable" | "fundamental",
  "explanation": "Brief human-readable explanation of what went wrong",
  "rootCause": "Technical root cause",
  "corrective": "Specific corrective action (for fixable) or null",
  "retryRecommendation": {
    "retryPhase": true | false,
    "modifiedPrompt": "Additional context/instructions to prepend to the retry prompt, or null",
    "preamble": "Short preamble to add before the original prompt, or null",
    "retryAgent": "alternative agent name if tryAlternativeAgent applies, or null"
  }
}`;
}

// ── Core Investigation ───────────────────────────────────────────────────────

/**
 * Investigate a phase failure and return a diagnosis.
 *
 * @param {object} failure
 * @param {string} failure.phase - Phase name (test, implement, analyze, agent, etc.)
 * @param {string} [failure.agent] - Agent that failed (claude, gemini, codex)
 * @param {string} [failure.error] - Error message
 * @param {string} [failure.stderr] - Agent stderr output (last ~2KB)
 * @param {string} [failure.stdout] - Agent stdout output (last ~2KB)
 * @param {boolean} [failure.timedOut] - Whether the failure was a timeout
 * @param {string} [failure.context] - Additional context (plan excerpt, test code, etc.)
 * @param {number} [failure.attemptNumber] - Which attempt this is (1-based)
 * @returns {Promise<object>} Diagnosis object
 */
export async function investigate(failure) {
  const cfg = getInvestigatorConfig();

  // Budget guard — don't spend more than our token budget
  if (tokenBudgetUsed >= cfg.maxTokensBudget) {
    return {
      diagnosis: 'fundamental',
      explanation: 'Investigator token budget exhausted',
      rootCause: `Used ${tokenBudgetUsed}/${cfg.maxTokensBudget} tokens`,
      corrective: null,
      retryRecommendation: { retryPhase: false, modifiedPrompt: null, preamble: null, retryAgent: null },
      tokens: { prompt: 0, completion: 0 },
    };
  }

  // Phase guard — only investigate configured phases
  if (!cfg.phases.includes(failure.phase)) {
    return {
      diagnosis: 'fundamental',
      explanation: `Phase '${failure.phase}' not configured for investigation`,
      rootCause: 'Phase not in investigator.phases config',
      corrective: null,
      retryRecommendation: { retryPhase: false, modifiedPrompt: null, preamble: null, retryAgent: null },
      tokens: { prompt: 0, completion: 0 },
    };
  }

  // Quick classification for obvious transients
  if (failure.timedOut) {
    const result = {
      diagnosis: 'transient',
      explanation: `${failure.agent || failure.phase} timed out`,
      rootCause: 'Operation exceeded timeout limit',
      corrective: null,
      retryRecommendation: { retryPhase: true, modifiedPrompt: null, preamble: null, retryAgent: null },
      tokens: { prompt: 0, completion: 0 },
    };
    logInvestigation(failure, result);
    stats.investigations++;
    return result;
  }

  // Build the user message with failure context
  const stderrSnippet = (failure.stderr || '').slice(-2000);
  const stdoutSnippet = (failure.stdout || '').slice(-2000);
  const contextSnippet = (failure.context || '').slice(-3000);

  const userMessage = `## Failed Phase: ${failure.phase}
Agent: ${failure.agent || 'N/A'}
Attempt: ${failure.attemptNumber || 1}
Exit Code: ${failure.exitCode ?? 'N/A'}
Signal: ${failure.signal ?? 'N/A'}
Error: ${failure.error || 'Unknown'}
${failure.errorCategory ? `Error Category: ${failure.errorCategory}` : ''}
${failure.errorDetail ? `Error Detail: ${failure.errorDetail}` : ''}
${failure.errorContext ? `Error Context: ${failure.errorContext}` : ''}
Timed Out: ${failure.timedOut ? 'yes' : 'no'}
${failure.command ? `Command: ${failure.command} ${failure.args?.join(' ') || ''}` : ''}
${failure.promptSnippet ? `Prompt Snippet: ${failure.promptSnippet}...` : ''}

${stderrSnippet ? `## stderr (last 2KB)\n\`\`\`\n${stderrSnippet}\n\`\`\`\n` : ''}
${stdoutSnippet ? `## stdout (last 2KB)\n\`\`\`\n${stdoutSnippet}\n\`\`\`\n` : ''}
${contextSnippet ? `## Additional Context\n${contextSnippet}\n` : ''}

Diagnose this failure and provide a structured recommendation.`;

  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: userMessage },
  ];

  try {
    const { fullResponse, usage } = await streamCompletion(messages, {
      model: cfg.model,
      reasoningEffort: cfg.reasoningEffort,
    }, null); // No streaming callback — we just want the final result

    // Track token usage
    const promptTokens = usage?.prompt_tokens || 0;
    const completionTokens = usage?.completion_tokens || 0;
    stats.promptTokens += promptTokens;
    stats.completionTokens += completionTokens;
    tokenBudgetUsed += promptTokens + completionTokens;
    stats.investigations++;

    // Parse the JSON response
    const diagnosis = parseInvestigatorResponse(fullResponse);
    diagnosis.tokens = { prompt: promptTokens, completion: completionTokens };

    // Track heals
    if (diagnosis.diagnosis === 'fixable' || diagnosis.diagnosis === 'transient') {
      if (diagnosis.retryRecommendation?.retryPhase) {
        stats.healed++;
      }
    }

    logInvestigation(failure, diagnosis);
    return diagnosis;
  } catch (err) {
    // Investigator itself failed — don't recurse, just return fundamental
    stats.investigations++;
    const fallback = {
      diagnosis: 'fundamental',
      explanation: `Investigator call failed: ${err.message}`,
      rootCause: err.message,
      corrective: null,
      retryRecommendation: { retryPhase: false, modifiedPrompt: null, preamble: null, retryAgent: null },
      tokens: { prompt: 0, completion: 0 },
    };
    logInvestigation(failure, fallback);
    return fallback;
  }
}

// ── Response Parsing ─────────────────────────────────────────────────────────

function parseInvestigatorResponse(raw) {
  // Try to extract JSON from the response (may have markdown fencing)
  let text = raw.trim();

  // Strip markdown code fences if present
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    text = jsonMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(text);
    return {
      diagnosis: parsed.diagnosis || 'fundamental',
      explanation: parsed.explanation || 'No explanation provided',
      rootCause: parsed.rootCause || 'Unknown',
      corrective: parsed.corrective || null,
      retryRecommendation: {
        retryPhase: parsed.retryRecommendation?.retryPhase ?? false,
        modifiedPrompt: parsed.retryRecommendation?.modifiedPrompt || null,
        preamble: parsed.retryRecommendation?.preamble || null,
        retryAgent: parsed.retryRecommendation?.retryAgent || null,
      },
    };
  } catch {
    // Couldn't parse — treat as fundamental
    return {
      diagnosis: 'fundamental',
      explanation: 'Investigator returned unparseable response',
      rootCause: raw.slice(0, 200),
      corrective: null,
      retryRecommendation: { retryPhase: false, modifiedPrompt: null, preamble: null, retryAgent: null },
    };
  }
}

// ── Logging ──────────────────────────────────────────────────────────────────

function logInvestigation(failure, diagnosis) {
  const cfg = getInvestigatorConfig();
  if (!cfg.logToFile) return;

  try {
    // Find the evolve dir — look for docs/coordination/evolve relative to this module
    const hydraRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..');
    const logDir = path.join(hydraRoot, 'docs', 'coordination', 'evolve');

    // Ensure dir exists
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    const logPath = path.join(logDir, 'INVESTIGATION_LOG.ndjson');
    const entry = {
      ts: new Date().toISOString(),
      phase: failure.phase,
      agent: failure.agent || null,
      error: (failure.error || '').slice(0, 500),
      timedOut: failure.timedOut || false,
      attempt: failure.attemptNumber || 1,
      diagnosis: diagnosis.diagnosis,
      explanation: diagnosis.explanation,
      rootCause: diagnosis.rootCause,
      corrective: diagnosis.corrective,
      retryPhase: diagnosis.retryRecommendation?.retryPhase || false,
      tokens: diagnosis.tokens || { prompt: 0, completion: 0 },
    };

    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // Best effort — don't let logging failures break the pipeline
  }
}
