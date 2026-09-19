#!/usr/bin/env node
/**
 * Hydra shared utilities.
 *
 * Consolidates duplicated helpers from hydra-council, hydra-operator, hydra-dispatch,
 * orchestrator-daemon, and orchestrator-client into one importable module.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { KNOWN_OWNERS, classifyTask, bestAgentFor, AGENT_NAMES } from './hydra-agents.mjs';
import { executeAgent } from './hydra-shared/agent-executor.mjs';
import { spawnSyncCapture } from './hydra-proc.mjs';

const ORCH_TOKEN = process.env.AI_ORCH_TOKEN || '';
const NETWORK_RETRY_COUNT = 4;
const NETWORK_RETRY_DELAY_MS = 300;
const DEFAULT_TIMEOUT_MS = 1000 * 60 * 7;
/** Default HTTP timeout for daemon calls — never hang forever (offline proxy / DNS). */
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.HYDRA_REQUEST_TIMEOUT_MS || '15000', 10) || 15_000;

// --- Timestamp ---

export function nowIso() {
  return new Date().toISOString();
}

export function runId(prefix = 'HYDRA') {
  const d = new Date();
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${prefix}_${yyyy}${mm}${dd}_${hh}${min}${ss}`;
}

// --- CLI Argument Parsing ---

export function parseArgs(argv) {
  const options = {};
  const positionals = [];
  for (const token of argv.slice(2)) {
    if (token.startsWith('--')) {
      options[token.slice(2)] = true;
    } else if (token.includes('=')) {
      const [rawKey, ...rawValue] = token.split('=');
      const key = rawKey.trim();
      if (key) {
        options[key] = rawValue.join('=').trim();
      }
    } else {
      positionals.push(token);
    }
  }
  return { options, positionals };
}

export function parseArgsWithCommand(argv) {
  const [command = 'help', ...rest] = argv.slice(2);
  const options = {};
  const positionals = [];
  for (const token of rest) {
    if (token.startsWith('--')) {
      options[token.slice(2)] = true;
    } else if (token.includes('=')) {
      const [rawKey, ...rawValue] = token.split('=');
      const key = rawKey.trim();
      if (key) {
        options[key] = rawValue.join('=').trim();
      }
    } else {
      positionals.push(token);
    }
  }
  return { command, options, positionals };
}

export function getOption(options, key, fallback = '') {
  if (options[key] !== undefined) {
    return String(options[key]);
  }
  return fallback;
}

export function requireOption(options, key, help = '') {
  const value = getOption(options, key, '');
  if (!value) {
    const suffix = help ? `\n${help}` : '';
    throw new Error(`Missing required option "${key}".${suffix}`);
  }
  return value;
}

export function getPrompt(options, positionals) {
  if (options.promptFile) {
    const filePath = String(options.promptFile).trim();
    if (!filePath) return '';
    return fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '').trim();
  }
  if (options.prompt) {
    return String(options.prompt);
  }
  if (positionals.length > 0) {
    return positionals.join(' ');
  }
  return '';
}

export function boolFlag(value, fallback = false) {
  if (value === undefined || value === '') {
    return fallback;
  }
  const normalized = String(value).toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(normalized);
}

/**
 * Split a value into a trimmed string array. Splits on commas only.
 * @param {string | string[] | null | undefined} value
 * @returns {string[]}
 */
export function parseList(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((x) => String(x).trim()).filter(Boolean);
  }
  return String(value)
    .split(/,\s*/)
    .map((x) => x.trim())
    .filter(Boolean);
}

// --- Text Helpers ---

export function short(text, max = 300) {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= max) {
    return cleaned;
  }
  return `${cleaned.slice(0, max - 3)}...`;
}

// --- JSON Parsing ---

export function parseJsonLoose(text) {
  if (!text || !String(text).trim()) {
    return null;
  }
  const raw = String(text).trim();

  try {
    return JSON.parse(raw);
  } catch {
    // continue
  }

  const blockMatch = raw.match(/```json\s*([\s\S]*?)\s*```/i);
  if (blockMatch) {
    try {
      return JSON.parse(blockMatch[1]);
    } catch {
      // continue
    }
  }

  const objMatch = raw.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      return JSON.parse(objMatch[0]);
    } catch {
      // continue
    }
  }

  return null;
}

// --- Process Execution ---

/**
 * Run a command synchronously and return structured results.
 * @param {string} command - The command to execute
 * @param {string[]} args - Arguments for the command
 * @param {number} [timeoutMs=420000] - Timeout in ms
 * @param {object} [extraOpts] - Additional options
 * @param {string} [extraOpts.cwd] - Working directory
 * @param {string} [extraOpts.input] - Data to pipe to stdin
 * @returns {{ ok: boolean, exitCode: number|null, stdout: string, stderr: string, error: string, timedOut: boolean }}
 */
export function runProcess(command, args, timeoutMs = DEFAULT_TIMEOUT_MS, extraOpts = {}) {
  const spawnOpts = {
    cwd: extraOpts.cwd || process.cwd(),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxOutputBytes: 1024 * 1024 * 8,
    windowsHide: true,
    shell: false,
    input: extraOpts.input,
  };

  const result = spawnSyncCapture(command, args, spawnOpts);
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';

  if (result.error) {
    return {
      ok: false,
      exitCode: result.status,
      stdout,
      stderr,
      error: result.error.message,
      timedOut: Boolean(result.signal === 'SIGTERM'),
    };
  }

  return {
    ok: result.status === 0,
    exitCode: result.status,
    stdout,
    stderr,
    error: '',
    timedOut: Boolean(result.signal === 'SIGTERM'),
  };
}

// --- Test Output Parsing ---

/**
 * Parse Node.js test runner output (TAP / spec reporter) into structured results.
 * Gracefully returns zeros when output can't be parsed.
 *
 * @param {string} stdout - stdout from `node --test`
 * @param {string} stderr - stderr from `node --test`
 * @returns {{ total: number, passed: number, failed: number, durationMs: number, failures: Array<{name: string, error: string}>, summary: string }}
 */
export function parseTestOutput(stdout = '', stderr = '') {
  const combined = `${stdout}\n${stderr}`;
  let total = 0, passed = 0, failed = 0, durationMs = 0;
  const failures = [];

  // TAP summary counters: # tests N, # pass N, # fail N, # duration_ms N
  const totalMatch = combined.match(/^# tests\s+(\d+)/m);
  const passMatch = combined.match(/^# pass\s+(\d+)/m);
  const failMatch = combined.match(/^# fail\s+(\d+)/m);
  const durationMatch = combined.match(/^# duration_ms\s+([\d.]+)/m);

  if (totalMatch) total = parseInt(totalMatch[1], 10);
  if (passMatch) passed = parseInt(passMatch[1], 10);
  if (failMatch) failed = parseInt(failMatch[1], 10);
  if (durationMatch) durationMs = parseFloat(durationMatch[1]);

  // If we got fail count but not total, derive total from pass+fail
  if (!totalMatch && (passMatch || failMatch)) {
    total = passed + failed;
  }

  // Extract failed test names from TAP: "not ok N - description"
  const tapFailures = combined.matchAll(/^not ok \d+[\s-]+(.+)/gm);
  for (const m of tapFailures) {
    const name = m[1].trim();
    // Look for indented error line after the failure marker
    const idx = combined.indexOf(m[0]);
    const afterFailure = combined.slice(idx + m[0].length, idx + m[0].length + 500);
    const errorMatch = afterFailure.match(/\n\s{2,}(.+)/);
    failures.push({ name, error: errorMatch ? errorMatch[1].trim() : '' });
  }

  // Spec reporter: "✗ description" or "✖ description" (× also)
  const specFailures = combined.matchAll(/^[ \t]*(?:✗|✖|×)\s+(.+)/gm);
  for (const m of specFailures) {
    const name = m[1].trim();
    // Avoid duplicates if TAP already captured it
    if (failures.some(f => f.name === name)) continue;
    const idx = combined.indexOf(m[0]);
    const afterFailure = combined.slice(idx + m[0].length, idx + m[0].length + 500);
    const errorMatch = afterFailure.match(/\n\s{2,}(.+)/);
    failures.push({ name, error: errorMatch ? errorMatch[1].trim() : '' });
  }

  // If we found failures but no fail count from counters, use failures length
  if (failed === 0 && failures.length > 0) {
    failed = failures.length;
    if (total === 0) total = passed + failed;
  }

  // Build summary string
  let summary = '';
  if (total > 0 || failed > 0) {
    if (failed > 0) {
      const names = failures.slice(0, 5).map(f => f.name.length > 40 ? f.name.slice(0, 37) + '...' : f.name);
      summary = `${failed}/${total} failed${names.length > 0 ? ': ' + names.join(', ') : ''}`;
    } else {
      summary = `${passed}/${total} passed`;
    }
  }

  return { total, passed, failed, durationMs, failures, summary };
}

// --- HTTP Client (with retry) ---

export async function request(method, baseUrl, route, body = null, opts = {}) {
  const headers = {
    Accept: 'application/json',
  };
  if (ORCH_TOKEN) {
    headers['x-ai-orch-token'] = ORCH_TOKEN;
  }
  if (body !== null) {
    headers['Content-Type'] = 'application/json';
  }

  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : REQUEST_TIMEOUT_MS;
  let response;
  let lastNetworkError = null;

  for (let attempt = 1; attempt <= NETWORK_RETRY_COUNT; attempt += 1) {
    try {
      response = await fetch(`${baseUrl}${route}`, {
        method,
        headers,
        body: body === null ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      lastNetworkError = null;
      break;
    } catch (error) {
      lastNetworkError = error;
      if (attempt >= NETWORK_RETRY_COUNT) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, NETWORK_RETRY_DELAY_MS * attempt));
    }
  }

  if (lastNetworkError) {
    throw new Error(
      `Unable to reach Hydra daemon at ${baseUrl}. Start it with "npm run hydra:start" or set url=http://127.0.0.1:4173.`
    );
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }

  return payload;
}

// --- Filesystem ---

export function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// --- Task Normalization ---

export function sanitizeOwner(owner) {
  const candidate = String(owner || '').toLowerCase();
  if (KNOWN_OWNERS.has(candidate)) {
    return candidate;
  }
  return 'unassigned';
}

export function normalizeTask(item, fallbackOwner = 'unassigned') {
  if (!item || typeof item !== 'object') {
    return null;
  }
  const title = String(item.title || item.task || '').trim();
  if (!title) {
    return null;
  }
  const owner = sanitizeOwner(item.owner || fallbackOwner);
  const done = String(item.definition_of_done || item.done || item.acceptance || '').trim();
  const rationale = String(item.rationale || item.why || '').trim();
  return { owner, title, done, rationale };
}

export function dedupeTasks(tasks) {
  const out = [];
  const seen = new Set();
  for (const task of tasks) {
    if (!task) {
      continue;
    }
    const key = `${task.owner}::${String(task.title || '').toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(task);
  }
  return out;
}

// --- Prompt Classification (Fast-Path Dispatch) ---

const COMPLEX_MARKERS = /\b(should we|trade.?off|design|decide|compare|investigate|explore|evaluate|pros?\s+(?:and|&)\s+cons?|which approach|what strategy)\b/i;
const STRATEGIC_MARKERS = /\b(deep dive|make sure|ensure|effectively|efficient|productive|professional|maximize|optimize|improve|best (?:practice|approach|way)|let'?s (?:make|take|think|figure))\b/i;
const MULTI_OBJECTIVE = /\b(?:and|also|plus|additionally)\b/i;
const TANDEM_INDICATORS = /\b(?:first\s+\w+(?:\s+\w+){0,5}\s+then\b|review\s+and\s+fix|analyze\s+and\s+implement|plan\s+(?:and\s+|then\s+)?build|assess\s+(?:and|then)\s+(?:fix|implement|refactor)|research\s+(?:and|then)\s+(?:implement|build|write)|check\s+(?:and|then)\s+(?:fix|update|refactor))/i;

// Task-type → tandem pair mapping
const TANDEM_PAIRS = {
  planning:       { lead: 'claude', follow: 'codex' },
  architecture:   { lead: 'claude', follow: 'gemini' },
  review:         { lead: 'gemini', follow: 'claude' },
  refactor:       { lead: 'claude', follow: 'codex' },
  implementation: { lead: 'claude', follow: 'codex' },
  analysis:       { lead: 'gemini', follow: 'claude' },
  testing:        { lead: 'codex',  follow: 'gemini' },
  security:       { lead: 'gemini', follow: 'claude' },
  research:       { lead: 'gemini', follow: 'claude' },
  documentation:  { lead: 'claude', follow: 'codex' },
};

/**
 * Select optimal tandem pair (lead + follow agent) for a task type.
 * Respects agent filter — if one is excluded, swaps with best available.
 * If only 1 agent available, returns null (degrade to single).
 */
export function selectTandemPair(taskType, suggestedAgent, agents = null) {
  const pair = TANDEM_PAIRS[taskType] || TANDEM_PAIRS.implementation;
  let { lead, follow } = pair;

  if (!agents || agents.length === 0) return { lead, follow };

  // Only 1 agent available → can't do tandem
  if (agents.length < 2) return null;

  const leadOk = agents.includes(lead);
  const followOk = agents.includes(follow);

  if (leadOk && followOk) return { lead, follow };

  // Swap out missing member with best available alternative
  if (!leadOk) {
    lead = agents.find(a => a !== follow) || agents[0];
  }
  if (!followOk) {
    follow = agents.find(a => a !== lead) || agents[0];
  }

  // Still same agent after substitution → can't tandem
  if (lead === follow) return null;

  return { lead, follow };
}

/**
 * Local heuristic classifier for prompt complexity.
 * Returns { tier, taskType, suggestedAgent, confidence, reason }.
 *
 * Tiers:
 *   - simple:   skip triage, dispatch directly (confidence >= 0.7)
 *   - moderate: run mini-round triage (default)
 *   - complex:  full council deliberation
 */
export function classifyPrompt(promptText) {
  const text = String(promptText || '').trim();
  if (!text) {
    return { tier: 'moderate', taskType: 'implementation', suggestedAgent: 'claude', confidence: 0.3, reason: 'Empty prompt' };
  }

  const words = text.split(/\s+/);
  const wordCount = words.length;
  const lowerText = text.toLowerCase();

  let simpleScore = 0;
  let complexScore = 0;
  const signals = [];

  // Word count signals
  if (wordCount <= 12) {
    simpleScore += 0.3;
    signals.push('short prompt');
  } else if (wordCount <= 20) {
    simpleScore += 0.1;
    signals.push('medium prompt');
  } else if (wordCount >= 40) {
    complexScore += 0.15;
    signals.push('long prompt');
  }

  // Single clear action verb (imperative) → strong simple signal
  const actionVerbs = /^(fix|add|create|implement|update|refactor|remove|delete|write|build|change|move|rename|test|run|check|set|get|make|clean|bump|install|deploy|format|lint)\b/i;
  if (actionVerbs.test(lowerText)) {
    simpleScore += 0.1;
    signals.push('imperative action');
  }

  // File path detection (.mjs, .ts, .js, .json, path separators in context)
  if (/(?:\/[\w.-]+\.[\w]+|\\[\w.-]+\.[\w]+|\.\w{1,5}\b)/.test(text) && /\.(mjs|js|ts|tsx|jsx|json|css|html|py|md|yml|yaml)/.test(lowerText)) {
    simpleScore += 0.2;
    signals.push('contains file paths');
  }

  // Task type classification via existing classifyTask
  const taskType = classifyTask(text, '');

  // Strong single-task-type match
  if (taskType !== 'implementation') {
    simpleScore += 0.1;
    signals.push(`clear task type: ${taskType}`);
  }

  // Agent name mention → user targeting specific agent
  const mentionedAgent = AGENT_NAMES.find((a) => lowerText.includes(a));
  if (mentionedAgent) {
    simpleScore += 0.2;
    signals.push(`mentions agent: ${mentionedAgent}`);
  }

  // Complexity markers
  if (COMPLEX_MARKERS.test(lowerText)) {
    complexScore += 0.35;
    signals.push('ambiguity/decision markers');
  }

  // Strategic/design-level intent
  if (STRATEGIC_MARKERS.test(lowerText)) {
    complexScore += 0.25;
    signals.push('strategic/design intent');
  }

  // Multi-sentence prompts (3+ sentences) suggest complex thinking
  const sentenceCount = text.split(/[.!?]+/).filter((s) => s.trim().length > 5).length;
  if (sentenceCount >= 3) {
    complexScore += 0.2;
    signals.push(`${sentenceCount} sentences`);
  }

  // Question marks suggest uncertainty
  if (text.includes('?')) {
    complexScore += 0.15;
    signals.push('contains question');
  }

  // Multiple verb phrases joined by "and" → multi-objective
  const verbPhrasePattern = /\b(fix|add|create|implement|update|refactor|remove|delete|write|build|change|move|rename)\b/gi;
  const verbMatches = lowerText.match(verbPhrasePattern) || [];
  if (verbMatches.length >= 2 && MULTI_OBJECTIVE.test(lowerText)) {
    complexScore += 0.2;
    signals.push('multiple objectives');
  }

  // Determine tier
  const netScore = simpleScore - complexScore;
  let tier;
  let confidence;

  if (netScore >= 0.3) {
    tier = 'simple';
    confidence = Math.min(0.95, 0.7 + netScore * 0.4);
  } else if (complexScore >= 0.4) {
    tier = 'complex';
    confidence = Math.min(0.95, 0.5 + complexScore * 0.5);
  } else {
    tier = 'moderate';
    confidence = 0.5 + Math.abs(netScore) * 0.2;
  }

  // Tandem-indicator detection: two-phase language upgrades simple→tandem route
  const hasTandemIndicator = TANDEM_INDICATORS.test(lowerText);
  if (hasTandemIndicator) {
    signals.push('two-phase language');
  }

  // Suggested agent
  const suggestedAgent = mentionedAgent || bestAgentFor(taskType);

  // Route strategy: single / tandem / council
  let routeStrategy;
  if (tier === 'simple' && !hasTandemIndicator) {
    routeStrategy = 'single';
  } else if (tier === 'complex' && complexScore >= 0.6) {
    routeStrategy = 'council';
  } else {
    routeStrategy = 'tandem';
  }

  // Resolve tandem pair (null for single/council)
  const tandemPair = routeStrategy === 'tandem'
    ? selectTandemPair(taskType, suggestedAgent)
    : null;

  return {
    tier,
    taskType,
    suggestedAgent,
    confidence: Math.round(confidence * 100) / 100,
    reason: signals.join(', ') || 'default classification',
    routeStrategy,
    tandemPair,
  };
}

// --- Spec Generation (Task Anchoring) ---

const SPEC_PROMPT_TEMPLATE = `You are generating a concise specification document to anchor multi-agent work.

Given this objective, produce a focused spec in Markdown with these sections:
1. **Objectives** — What must be achieved (bullet points)
2. **Constraints** — What must NOT change, technical limits, compatibility requirements
3. **Acceptance Criteria** — How to verify the work is done correctly
4. **Files Involved** — List of files likely to be modified or read
5. **Risks** — What could go wrong

Keep it to 1 page. Be specific and actionable. Do NOT include implementation details — just the "what", not the "how".

Objective: `;

/**
 * Generate a spec document for a complex prompt using a fast model call.
 * Returns { specId, specPath, specContent } or null if generation fails.
 */
export async function generateSpec(promptText, taskId, opts = {}) {
  const specsDir = opts.specsDir || path.join(process.cwd(), 'docs', 'coordination', 'specs');
  ensureDir(specsDir);

  const specId = `SPEC_${taskId || runId('TASK')}`;
  const specPath = path.join(specsDir, `${specId}.md`);

  try {
    const result = await executeAgent('claude', `${SPEC_PROMPT_TEMPLATE}${promptText}`, {
      timeoutMs: 120_000,
      modelOverride: opts.fastModel || undefined,
      cwd: opts.cwd || process.cwd(),
      permissionMode: 'plan',
    });

    if (!result.ok || !result.stdout) {
      return null;
    }

    // Extract text content from JSON response if needed
    let content = result.stdout;
    try {
      const parsed = JSON.parse(content);
      if (parsed.result) content = parsed.result;
      else if (parsed.content) content = parsed.content;
      else if (typeof parsed === 'string') content = parsed;
    } catch { /* use raw output */ }

    const specContent = `# ${specId}\n\n**Objective:** ${short(promptText, 200)}\n\n${content}`;
    fs.writeFileSync(specPath, specContent, 'utf8');

    return { specId, specPath, specContent };
  } catch {
    return null;
  }
}
