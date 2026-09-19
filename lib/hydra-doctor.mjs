/**
 * Hydra Doctor — Higher-level failure diagnostic and triage layer.
 *
 * Fires when evolve/nightly/tasks encounters a non-trivial failure. It:
 * - Calls the existing investigator for diagnosis (reuses investigate())
 * - Triages the result into an actionable follow-up: daemon task, suggestion, or KB entry
 * - Tracks error patterns across sessions via append-only NDJSON log
 *
 * Diagnosis actions:
 *   ticket  — Fundamental issue → create suggestion for future investigation
 *   fix     — Fixable issue → create daemon task (fallback: suggestion)
 *   ignore  — Transient issue → log only
 *
 * All operations are best-effort and never block the calling pipeline.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadHydraConfig } from './hydra-config.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HYDRA_ROOT = path.resolve(__dirname, '..');

const LOG_DIR = path.join(HYDRA_ROOT, 'docs', 'coordination', 'doctor');
const LOG_PATH = path.join(LOG_DIR, 'DOCTOR_LOG.ndjson');

// ── Session State ───────────────────────────────────────────────────────────

let _initialized = false;
let _history = [];          // Loaded from log on init
let _sessionEntries = [];   // Timestamps of entries written in this session (for cleanup on reset)
let _sessionStats = { total: 0, fixes: 0, tickets: 0, investigations: 0, ignored: 0 };

// ── Config ──────────────────────────────────────────────────────────────────

function getDoctorConfig() {
  const cfg = loadHydraConfig();
  const doc = cfg.doctor || {};
  return {
    enabled: doc.enabled !== false,
    autoCreateTasks: doc.autoCreateTasks !== false,
    autoCreateSuggestions: doc.autoCreateSuggestions !== false,
    addToKnowledgeBase: doc.addToKnowledgeBase !== false,
    recurringThreshold: doc.recurringThreshold || 3,
    recurringWindowDays: doc.recurringWindowDays || 7,
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Initialize the doctor. Loads diagnostic history from the log file.
 */
export function initDoctor() {
  if (_initialized) return;
  _history = loadHistory();
  _initialized = true;
}

/**
 * Check if the doctor is enabled in config.
 */
export function isDoctorEnabled() {
  return getDoctorConfig().enabled;
}

/**
 * Get session statistics.
 */
export function getDoctorStats() {
  return { ..._sessionStats };
}

/**
 * Get recent diagnostic log entries.
 * @param {number} [limit=25] - Max entries to return
 * @returns {object[]} Most recent log entries (newest first)
 */
export function getDoctorLog(limit = 25) {
  if (!_initialized) initDoctor();
  return _history.slice(-limit).reverse();
}

/**
 * Reset session state (for testing or between sessions).
 * Also removes any entries written during this session from the persistent log file.
 */
export function resetDoctor() {
  // Remove entries written in this session from the persistent log
  if (_sessionEntries.length > 0) {
    try {
      if (fs.existsSync(LOG_PATH)) {
        const sessionTs = new Set(_sessionEntries);
        const lines = fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean);
        const kept = lines.filter((l) => {
          try { return !sessionTs.has(JSON.parse(l).ts); } catch { return true; }
        });
        fs.writeFileSync(LOG_PATH, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
      }
    } catch { /* best effort — don't break if file is locked */ }
  }
  _initialized = false;
  _history = [];
  _sessionEntries = [];
  _sessionStats = { total: 0, fixes: 0, tickets: 0, investigations: 0, ignored: 0 };
}

/**
 * Diagnose a pipeline failure and create appropriate follow-ups.
 *
 * @param {object} failure
 * @param {string} failure.pipeline - Source pipeline ('evolve', 'nightly', 'tasks')
 * @param {string} [failure.phase] - Phase where failure occurred
 * @param {string} [failure.agent] - Agent that failed
 * @param {string} [failure.error] - Error message
 * @param {number|null} [failure.exitCode] - Numeric exit code from agent process
 * @param {string|null} [failure.signal] - Termination signal (e.g. SIGKILL)
 * @param {string} [failure.stderr] - Agent stderr output
 * @param {string} [failure.stdout] - Agent stdout output
 * @param {boolean} [failure.timedOut] - Whether this was a timeout
 * @param {string} [failure.taskTitle] - Title of the task being worked on
 * @param {string} [failure.branchName] - Branch where failure occurred
 * @param {string} [failure.context] - Additional context
 * @param {object} [failure.execution] - Safe process metadata (no environment values or prompt content)
 * @returns {Promise<DoctorDiagnosis>}
 */
export async function diagnose(failure) {
  if (!_initialized) initDoctor();

  const cfg = getDoctorConfig();
  _sessionStats.total++;

  // Build error signature for dedup / recurring detection
  const signature = buildSignature(failure);

  // Check for recurring pattern
  const recurring = isRecurring(signature, cfg);

  // Skip rate limits and simple timeouts (already handled by retry logic)
  if (isRateLimitError(failure)) {
    const result = {
      severity: 'low',
      action: 'ignore',
      explanation: 'Rate limit — already handled by retry logic',
      rootCause: 'rate_limit',
      followUp: null,
      investigatorDiagnosis: null,
      recurring: false,
    };
    appendLog(failure, result, signature);
    _sessionStats.ignored++;
    return result;
  }

  // Try investigator for non-trivial failures
  let investigatorDiagnosis = null;
  try {
    const inv = await lazyLoadInvestigator();
    if (inv && inv.isInvestigatorAvailable()) {
      _sessionStats.investigations++;
      investigatorDiagnosis = await inv.investigate({
        phase: failure.phase || 'agent',
        agent: failure.agent,
        error: (failure.error || '').slice(0, 2000),
        exitCode: failure.exitCode ?? null,
        signal: failure.signal ?? null,
        stderr: (failure.stderr || '').slice(-2000),
        stdout: (failure.stdout || '').slice(-2000),
        timedOut: failure.timedOut || false,
        command: failure.command,
        args: failure.args,
        promptSnippet: failure.promptSnippet,
        context: failure.context || `Pipeline: ${failure.pipeline}`,
        attemptNumber: 1,
      });
    }
  } catch {
    // Investigator unavailable — proceed with heuristic triage
  }

  // Triage based on investigator result (or heuristic fallback)
  const diagnosis = triage(failure, investigatorDiagnosis, recurring, cfg);

  // Create follow-ups (fire-and-forget)
  if (diagnosis.action === 'ticket' && cfg.autoCreateSuggestions) {
    diagnosis.followUp = await createFollowUp(failure, diagnosis, 'suggestion');
  } else if (diagnosis.action === 'fix' && cfg.autoCreateTasks) {
    diagnosis.followUp = await createFollowUp(failure, diagnosis, 'task');
  }

  // Add KB entry for non-transient findings
  if (diagnosis.action !== 'ignore' && cfg.addToKnowledgeBase) {
    await addKBEntry(failure, diagnosis);
  }

  // Log and return
  appendLog(failure, diagnosis, signature);

  return diagnosis;
}

// ── Triage Logic ────────────────────────────────────────────────────────────

function triage(failure, investigatorDiagnosis, recurring, cfg) {
  const invDiag = investigatorDiagnosis?.diagnosis;
  let severity, action, explanation, rootCause;

  if (invDiag === 'fundamental') {
    severity = recurring ? 'critical' : 'high';
    action = 'ticket';
    explanation = investigatorDiagnosis.explanation || 'Fundamental failure requiring investigation';
    rootCause = investigatorDiagnosis.rootCause || 'unknown';
  } else if (invDiag === 'fixable') {
    severity = recurring ? 'high' : 'medium';
    action = 'fix';
    explanation = investigatorDiagnosis.explanation || 'Fixable issue detected';
    rootCause = investigatorDiagnosis.rootCause || 'unknown';
  } else if (invDiag === 'transient') {
    // Transient but recurring → escalate
    if (recurring) {
      severity = 'medium';
      action = 'ticket';
      explanation = `Recurring transient failure (${cfg.recurringThreshold}+ occurrences): ${investigatorDiagnosis?.explanation || failure.error || 'unknown'}`;
      rootCause = investigatorDiagnosis?.rootCause || 'recurring_transient';
    } else {
      severity = 'low';
      action = 'ignore';
      explanation = investigatorDiagnosis?.explanation || 'Transient failure';
      rootCause = investigatorDiagnosis?.rootCause || 'transient';
    }
  } else {
    // No investigator available — heuristic fallback using structured error data
    if (failure.timedOut) {
      severity = recurring ? 'medium' : 'low';
      action = recurring ? 'ticket' : 'ignore';
      explanation = `Agent timed out${recurring ? ' (recurring)' : ''}`;
      rootCause = 'timeout';
    } else if (failure.errorCategory && failure.errorCategory !== 'unclassified') {
      // Use structured diagnosis from diagnoseAgentError — much more specific than raw error
      severity = recurring ? 'high' : 'medium';
      action = recurring ? 'ticket' : 'fix';
      const exitInfo = failure.exitCode != null ? ` (exit ${failure.exitCode})` : '';
      const signalInfo = failure.signal ? ` (signal ${failure.signal})` : '';
      explanation = `[${failure.errorCategory}] ${failure.errorDetail || failure.error || 'unknown'}${exitInfo}${signalInfo}`;
      rootCause = failure.errorCategory;
    } else {
      severity = 'medium';
      action = 'ticket';
      const exitInfo = failure.exitCode != null ? ` (exit ${failure.exitCode})` : '';
      const signalInfo = failure.signal ? ` (signal ${failure.signal})` : '';
      const stderrHint = !failure.error && failure.stderr
        ? failure.stderr.replace(/\[Hydra Telemetry\].*?\n/g, '').trim().split('\n')[0]?.slice(0, 150) || ''
        : '';
      explanation = (failure.error?.slice(0, 200) || stderrHint || 'Unknown failure without investigator') + exitInfo + signalInfo;
      rootCause = 'unknown';
    }
  }

  // Escalate recurring failures
  if (recurring && action === 'ignore') {
    action = 'ticket';
    severity = 'medium';
  }

  // Track stats
  if (action === 'fix') _sessionStats.fixes++;
  else if (action === 'ticket') _sessionStats.tickets++;
  else _sessionStats.ignored++;

  return {
    severity,
    action,
    explanation,
    rootCause,
    followUp: null,
    investigatorDiagnosis: investigatorDiagnosis || null,
    recurring,
  };
}

// ── Signature & Recurrence ──────────────────────────────────────────────────

function buildSignature(failure) {
  const agent = failure.agent || 'unknown';
  const phase = failure.phase || 'unknown';
  let errorText = failure.error || '';

  // Use errorCategory if available for a more stable signature
  if (failure.errorCategory && failure.errorCategory !== 'unclassified') {
    errorText = `[${failure.errorCategory}] ${failure.errorDetail || errorText}`;
  }
  // Include signal for better differentiation
  else if (failure.signal) {
    errorText = `Signal ${failure.signal}${errorText ? ` (${errorText})` : ''}`;
  }
  // If error is generic (exit code only), enrich from stderr
  const isGeneric = errorText.includes('Exit code') ||
                    errorText === 'Process terminated abnormally' ||
                    errorText.startsWith('[unclassified]');

  if (isGeneric && failure.stderr) {
    const stderrClean = failure.stderr.replace(/\[Hydra Telemetry\].*?\n/g, '').trim();
    if (stderrClean) {
      // If it's many lines, take the first non-telemetry line
      const lines = stderrClean.split('\n').filter(l => !l.startsWith('[Hydra Telemetry]'));
      if (lines.length > 0) {
        const firstLine = lines[0].trim();
        errorText = `${errorText} (${firstLine})`;
      }
    }
  }

  const errorSnippet = errorText.slice(0, 100).replace(/\s+/g, ' ').trim();
  return `${agent}:${phase}:${errorSnippet}`;
}

function isRecurring(signature, cfg) {
  const windowMs = cfg.recurringWindowDays * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - windowMs;
  const matches = _history.filter(
    (h) => h.signature === signature && new Date(h.ts).getTime() > cutoff
  );
  return matches.length >= cfg.recurringThreshold;
}

// ── Rate Limit Detection (quick filter) ─────────────────────────────────────

function isRateLimitError(failure) {
  const text = `${failure.error || ''} ${failure.stderr || ''}`.toLowerCase();
  return /rate.?limit|429|resource.?exhausted|quota.?exhausted|too many requests/i.test(text);
}

// ── Follow-up Creation ──────────────────────────────────────────────────────

async function createFollowUp(failure, diagnosis, type) {
  // Prefer structured error info for the title when available
  const titleDetail = failure.errorCategory && failure.errorCategory !== 'unclassified'
    ? `[${failure.errorCategory}] ${(failure.errorDetail || diagnosis.explanation).slice(0, 70)}`
    : diagnosis.explanation.slice(0, 80);
  const title = `[doctor] ${failure.pipeline}: ${titleDetail}`;
  const notes = [
    `Pipeline: ${failure.pipeline}`,
    `Phase: ${failure.phase || 'unknown'}`,
    `Agent: ${failure.agent || 'unknown'}`,
    `Root cause: ${diagnosis.rootCause}`,
    failure.errorCategory ? `Error category: ${failure.errorCategory}` : '',
    failure.errorDetail ? `Error detail: ${failure.errorDetail}` : '',
    failure.errorContext ? `Error context: ${failure.errorContext}` : '',
    failure.exitCode != null ? `Exit code: ${failure.exitCode}` : '',
    failure.signal ? `Signal: ${failure.signal}` : '',
    diagnosis.recurring ? 'Status: RECURRING' : '',
    failure.branchName ? `Branch: ${failure.branchName}` : '',
    failure.taskTitle ? `Task: ${failure.taskTitle}` : '',
  ].filter(Boolean).join('\n');

  const preferredAgent = diagnosis.action === 'fix' ? 'codex' : 'gemini';

  if (type === 'task') {
    // Try daemon first, fall back to suggestion
    const created = await tryCreateDaemonTask(title, notes, preferredAgent);
    if (created) return { type: 'daemon_task', title };
    // Fallback to suggestion
    return await createSuggestionFollowUp(failure, diagnosis, title, notes);
  }

  return await createSuggestionFollowUp(failure, diagnosis, title, notes);
}

async function tryCreateDaemonTask(title, notes, preferredAgent) {
  try {
    const { request } = await import('./hydra-utils.mjs');
    const result = await request('POST', 'http://localhost:4173', '/task/add', {
      title,
      notes,
      preferredAgent,
      source: 'doctor',
    });
    return result && !result.error;
  } catch {
    return false;
  }
}

async function createSuggestionFollowUp(failure, diagnosis, title, notes) {
  try {
    const { loadSuggestions, saveSuggestions, addSuggestion } = await import('./hydra-evolve-suggestions.mjs');
    const sg = loadSuggestions();
    const entry = addSuggestion(sg, {
      title,
      description: notes,
      source: `doctor:${diagnosis.action}`,
      area: failure.pipeline || 'general',
    });
    if (entry) {
      saveSuggestions(sg);
      return { type: 'suggestion', id: entry.id, title };
    }
    return { type: 'suggestion_dedup', title };
  } catch {
    return null;
  }
}

// ── Knowledge Base ──────────────────────────────────────────────────────────

async function addKBEntry(failure, diagnosis) {
  try {
    const { loadKnowledgeBase, saveKnowledgeBase, addEntry } = await import('./hydra-knowledge.mjs');
    const kb = loadKnowledgeBase();
    const entry = addEntry(kb, {
      area: failure.pipeline || 'unknown',
      finding: `[Doctor] ${diagnosis.explanation} (root cause: ${diagnosis.rootCause})`,
      applicability: diagnosis.recurring ? 'high' : 'medium',
      attempted: false,
      outcome: null,
    });
    if (entry) saveKnowledgeBase(kb);
  } catch {
    // Best effort
  }
}

// ── Lazy Loaders ────────────────────────────────────────────────────────────

async function lazyLoadInvestigator() {
  try {
    return await import('./hydra-investigator.mjs');
  } catch {
    return null;
  }
}

// ── History / Logging ───────────────────────────────────────────────────────

function loadHistory() {
  try {
    if (!fs.existsSync(LOG_PATH)) return [];
    const lines = fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean);
    return lines.map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function appendLog(failure, diagnosis, signature) {
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }

    const entry = {
      ts: new Date().toISOString(),
      pipeline: failure.pipeline,
      phase: failure.phase || null,
      agent: failure.agent || null,
      error: (failure.error || '').slice(0, 500),
      exitCode: failure.exitCode ?? null,
      signal: failure.signal || null,
      command: failure.command || null,
      args: failure.args || null,
      promptSnippet: failure.promptSnippet || null,
      execution: failure.execution || null,
      stderrTail: (failure.stderr || '').slice(-500) || null,
      stdoutTail: (failure.stdout || '').slice(-500) || null,
      timedOut: failure.timedOut || false,
      taskTitle: failure.taskTitle || null,
      branchName: failure.branchName || null,
      errorCategory: failure.errorCategory || null,
      errorDetail: failure.errorDetail || null,
      errorContext: (failure.errorContext || '').slice(0, 300) || null,
      signature,
      severity: diagnosis.severity,
      action: diagnosis.action,
      explanation: diagnosis.explanation,
      rootCause: diagnosis.rootCause,
      recurring: diagnosis.recurring,
      followUp: diagnosis.followUp,
    };

    fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');

    // Keep in-memory history in sync; track for cleanup on reset
    _history.push(entry);
    _sessionEntries.push(entry.ts);
  } catch {
    // Best effort — don't let logging failures break the pipeline
  }
}

// ── Action Pipeline Scanners ─────────────────────────────────────────────────

/**
 * Scan doctor log for pending fix/ticket entries that haven't been addressed.
 * Deduplicates by signature — only the most recent entry per unique issue is shown,
 * with an occurrence count. Excludes doctor-fix feedback entries.
 * @returns {Promise<import('./hydra-action-pipeline.mjs').ActionItem[]>}
 */
export async function scanDoctorLog() {
  if (!_initialized) initDoctor();
  const items = [];

  // Group by signature, keep most recent, count occurrences
  const bySignature = new Map();
  for (const entry of _history) {
    if (entry.action !== 'fix' && entry.action !== 'ticket') continue;
    // Exclude doctor-fix feedback loop entries
    if (entry.pipeline === 'doctor-fix') continue;

    const sig = entry.signature || `${entry.agent}:${entry.phase}:${(entry.error || '').slice(0, 80)}`;
    const existing = bySignature.get(sig);
    if (!existing || new Date(entry.ts) > new Date(existing.entry.ts)) {
      bySignature.set(sig, { entry, count: (existing?.count || 0) + 1 });
    } else {
      existing.count++;
    }
  }

  for (const [sig, { entry, count }] of bySignature) {
    const countLabel = count > 1 ? ` (${count}x)` : '';
    const isTransient = classifyIssueType(entry) === 'transient';

    items.push({
      id: `doctor-${sig.slice(0, 40)}`,
      title: `${(entry.explanation || 'Unknown issue').slice(0, 90)}${countLabel}`,
      description: [
        `Pipeline: ${entry.pipeline || 'unknown'}`,
        `Phase: ${entry.phase || 'unknown'}`,
        `Agent: ${entry.agent || 'unknown'}`,
        `Root cause: ${entry.rootCause || 'unknown'}`,
        entry.errorCategory ? `Category: ${entry.errorCategory}` : null,
        entry.errorDetail ? `Detail: ${entry.errorDetail}` : null,
        entry.exitCode != null ? `Exit: ${entry.exitCode}` : null,
        entry.signal ? `Signal: ${entry.signal}` : null,
        count > 1 ? `Occurrences: ${count}` : null,
        entry.recurring ? 'RECURRING' : null,
        entry.error ? `Error: ${entry.error.slice(0, 200)}` : null,
      ].filter(Boolean).join(' | '),
      category: isTransient ? 'acknowledge' : 'fix',
      severity: entry.severity || 'medium',
      source: 'doctor-log',
      agent: selectFixAgent(entry),
      actionPrompt: isTransient ? null : buildFixPrompt(entry),
      meta: { entry, count, issueType: classifyIssueType(entry) },
    });
  }

  return items;
}

/**
 * Classify an issue as transient, config, invocation, auth, or code.
 * Uses structured errorCategory from diagnoseAgentError when available.
 * Also checks the log entry fields that may have been persisted.
 */
function classifyIssueType(entry) {
  const error = (entry.error || '').toLowerCase();
  const rootCause = (entry.rootCause || '').toLowerCase();

  // Structured errorCategory from diagnoseAgentError (preferred — skip heuristics)
  // Check both the entry directly and the nested meta.entry (for scanDoctorLog items)
  const cat = (entry.errorCategory || entry.meta?.entry?.errorCategory || '').toLowerCase();
  if (cat === 'auth') return 'config';       // needs API key fix
  if (cat === 'invocation') return 'config';  // wrong flags, missing binary
  if (cat === 'sandbox') return 'config';     // sandbox permissions need config change
  if (cat === 'permission') return 'config';
  if (cat === 'network') return 'transient';
  if (cat === 'server') return 'transient';
  if (cat === 'oom') return 'transient';
  if (cat === 'crash') return 'transient';
  if (cat === 'signal') return 'transient';
  if (cat === 'internal') return 'transient';
  if (cat === 'codex-jsonl-error') return 'transient'; // agent-reported errors, often transient
  if (cat === 'parse') return 'code';
  if (cat === 'silent-crash') return 'config'; // usually env/binary issue

  // Transient: timeouts, segfaults, rate limits, signals
  if (entry.timedOut || entry.signal) return 'transient';
  if (/timeout|timed.?out/i.test(error) || /timeout/i.test(rootCause)) return 'transient';
  if (/segfault|sigsegv|segmentation/i.test(error + rootCause)) return 'transient';
  if (/rate.?limit|429|resource.?exhausted|quota/i.test(error)) return 'transient';

  // Auth / invocation patterns (fallback if errorCategory wasn't set)
  if (/\[auth\]|api.?key|unauthorized|401|403|credentials?.*(?:missing|invalid|expired)/i.test(error)) return 'config';
  if (/\[invocation\]|unknown\s+flag|command not found|ENOENT/i.test(error)) return 'config';
  if (/\[sandbox\]|sandbox.*(?:violation|error|denied)|execution.*denied/i.test(error)) return 'config';
  if (/silent.?crash|no output produced/i.test(error)) return 'config';

  // Generic/mystery errors — still transient but now less likely to reach here
  if (/something went wrong|mystery error/i.test(error)) return 'transient';
  if (/generic error|non-specific|opaque|placeholder/i.test(rootCause)) return 'transient';

  // Config: phase not configured, missing config
  if (/not configured|not in.*config|missing.*config/i.test(rootCause + error)) return 'config';

  return 'code';
}

/**
 * Select the best agent to fix an issue — avoid using the agent that failed.
 */
function selectFixAgent(entry) {
  const failedAgent = entry.agent || 'codex';
  // Prefer claude for code fixes (architect), fall back to gemini if claude failed
  if (failedAgent === 'claude') return 'gemini';
  return 'claude';
}

/**
 * Scan daemon for failed/blocked tasks.
 * @param {string} baseUrl
 * @returns {Promise<import('./hydra-action-pipeline.mjs').ActionItem[]>}
 */
export async function scanDaemonIssues(baseUrl) {
  const items = [];
  try {
    const { request } = await import('./hydra-utils.mjs');
    const status = await request('GET', baseUrl, '/status');
    if (!status?.tasks) return items;

    for (const task of status.tasks) {
      if (task.status === 'blocked' || task.status === 'failed') {
        items.push({
          id: `daemon-task-${task.id}`,
          title: `${task.status === 'blocked' ? 'Blocked' : 'Failed'} task: ${task.title || task.id}`,
          description: task.notes || task.title || '',
          category: 'fix',
          severity: task.status === 'failed' ? 'high' : 'medium',
          source: 'daemon',
          agent: task.assignedTo || task.preferredAgent || 'codex',
          actionPrompt: task.status === 'failed'
            ? `Investigate and fix the failed task: ${task.title}\n\nNotes: ${task.notes || 'none'}`
            : `Unblock the task: ${task.title}\n\nNotes: ${task.notes || 'none'}`,
          meta: { taskId: task.id, daemonTask: task },
        });
      }
    }
  } catch {
    // Daemon unavailable
  }
  return items;
}

/**
 * Scan recent activity for error patterns.
 * @returns {Promise<import('./hydra-action-pipeline.mjs').ActionItem[]>}
 */
export async function scanErrorActivity() {
  const items = [];
  try {
    const { getRecentActivity } = await import('./hydra-activity.mjs');
    const activities = getRecentActivity(50);

    for (const act of activities) {
      if (act.type?.includes('error') || act.type?.includes('failure')) {
        items.push({
          id: `activity-${act.ts || Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          title: `Error: ${(act.summary || act.message || 'Unknown error').slice(0, 100)}`,
          description: act.detail || act.summary || '',
          category: 'fix',
          severity: 'medium',
          source: 'activity',
          agent: act.agent || 'codex',
          actionPrompt: `Investigate and fix: ${act.summary || act.message || 'Unknown error'}\n\nContext: ${act.detail || 'none'}`,
          meta: { activity: act },
        });
      }
    }
  } catch {
    // Activity module unavailable
  }
  return items;
}

/**
 * AI enrichment: use concierge providers to analyze items + CLI context.
 * @param {import('./hydra-action-pipeline.mjs').ActionItem[]} items
 * @param {string} cliContext - Recent CLI output
 * @returns {Promise<import('./hydra-action-pipeline.mjs').ActionItem[]>}
 */
export async function enrichWithDiagnosis(items, cliContext) {
  try {
    const { streamWithFallback } = await import('./hydra-concierge-providers.mjs');

    const itemSummary = items.map((item, i) =>
      `${i + 1}. [${item.severity}] ${item.title} (source: ${item.source})`
    ).join('\n');

    const prompt = `You are a DevOps diagnostic assistant. Analyze these issues found in the Hydra orchestration system and the recent CLI output.

ISSUES:
${itemSummary}

RECENT CLI OUTPUT:
${(cliContext || '').slice(-3000)}

For each issue, suggest a brief actionPrompt (what an AI coding agent should do to fix it). Also identify any NEW issues visible in the CLI output that aren't in the list above.

Respond as JSON:
{
  "enriched": [{"index": 0, "actionPrompt": "...", "severity": "high|medium|low"}],
  "discovered": [{"title": "...", "description": "...", "severity": "...", "actionPrompt": "..."}]
}`;

    let response = '';
    await streamWithFallback(
      [{ role: 'user', content: prompt }],
      { model: 'gpt-4.1-mini', maxTokens: 1500 },
      (chunk) => { response += chunk; },
    );

    // Parse JSON from response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);

      // Enrich existing items
      if (Array.isArray(parsed.enriched)) {
        for (const enrichment of parsed.enriched) {
          const idx = enrichment.index;
          if (idx >= 0 && idx < items.length) {
            if (enrichment.actionPrompt) items[idx].actionPrompt = enrichment.actionPrompt;
            if (enrichment.severity) items[idx].severity = enrichment.severity;
          }
        }
      }

      // Add discovered items
      if (Array.isArray(parsed.discovered)) {
        for (const disc of parsed.discovered) {
          items.push({
            id: `discovered-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            title: (disc.title || 'Discovered issue').slice(0, 100),
            description: disc.description || '',
            category: 'fix',
            severity: disc.severity || 'medium',
            source: 'cli-output',
            agent: 'codex',
            actionPrompt: disc.actionPrompt || `Fix: ${disc.title}`,
          });
        }
      }
    }
  } catch {
    // Non-fatal: return items with template-based prompts
    for (const item of items) {
      if (!item.actionPrompt) {
        item.actionPrompt = `Investigate and fix: ${item.title}\n\n${item.description}`;
      }
    }
  }

  return items;
}

/**
 * Execute a single fix action.
 *
 * Handles three issue types:
 *   - transient: acknowledges and clears from log (no agent dispatch)
 *   - config: shows suggested config change (no agent dispatch)
 *   - code: dispatches a DIFFERENT agent than the one that failed
 *
 * Does NOT log failures back to doctor to prevent feedback loops.
 *
 * @param {import('./hydra-action-pipeline.mjs').ActionItem} item
 * @param {object} opts
 * @returns {Promise<import('./hydra-action-pipeline.mjs').PipelineResult>}
 */
export async function executeFixAction(item, opts = {}) {
  const startMs = Date.now();
  const issueType = item.meta?.issueType || 'code';

  // ── Transient issues: acknowledge and clear ──
  if (issueType === 'transient' || item.category === 'acknowledge') {
    const count = item.meta?.count || 1;
    clearLogEntriesBySignature(item.meta?.entry?.signature);
    return {
      item,
      ok: true,
      output: `Acknowledged ${count} transient occurrence(s) and cleared from log`,
      durationMs: Date.now() - startMs,
    };
  }

  // ── Config issues: show suggestion (don't spawn agent) ──
  if (issueType === 'config') {
    const entry = item.meta?.entry || {};
    const suggestion = buildConfigSuggestion(entry);
    return {
      item,
      ok: true,
      output: suggestion,
      durationMs: Date.now() - startMs,
    };
  }

  // ── Code issues: dispatch agent (never the failing one) ──
  const agent = item.agent || 'claude';
  const prompt = item.actionPrompt || `Fix: ${item.title}`;

  try {
    const { executeAgentWithRecovery } = await import('./hydra-shared/agent-executor.mjs');

    const result = await executeAgentWithRecovery(agent, prompt, {
      cwd: opts.projectRoot || process.cwd(),
      timeoutMs: 5 * 60 * 1000,
    });

    const ok = result.ok !== false && !result.error;

    // Do NOT call diagnose() here — prevents feedback loop

    return {
      item,
      ok,
      output: result.stdout || result.output || '',
      error: result.error || (ok ? null : 'Agent returned error'),
      durationMs: Date.now() - startMs,
    };
  } catch (err) {
    return {
      item,
      ok: false,
      error: err.message || String(err),
      durationMs: Date.now() - startMs,
    };
  }
}

/**
 * Remove log entries matching a signature (used when acknowledging transient issues).
 */
function clearLogEntriesBySignature(signature) {
  if (!signature) return;
  try {
    if (!fs.existsSync(LOG_PATH)) return;
    const lines = fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean);
    const kept = lines.filter((line) => {
      try {
        const entry = JSON.parse(line);
        return entry.signature !== signature;
      } catch { return true; }
    });
    fs.writeFileSync(LOG_PATH, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
    // Update in-memory history
    _history = _history.filter((h) => h.signature !== signature);
  } catch { /* best effort */ }
}

/**
 * Build a human-readable config suggestion for config-type issues.
 */
function buildConfigSuggestion(entry) {
  const rootCause = entry.rootCause || '';
  const parts = [`Config issue detected: ${entry.explanation || rootCause}`];

  if (/phase.*not configured|not in.*phases/i.test(rootCause + (entry.error || ''))) {
    const phase = entry.phase || 'unknown';
    parts.push(`Suggestion: Add "${phase}" to investigator.phases in hydra.config.json`);
    parts.push(`Or disable investigation for this phase to suppress the warning.`);
  } else {
    parts.push(`Review hydra.config.json for the relevant section.`);
  }

  return parts.join('\n');
}

// ── Fix Prompt Builder ──────────────────────────────────────────────────────

function buildFixPrompt(entry) {
  const parts = [
    `Fix the following issue in the Hydra orchestration system:`,
    '',
    `Issue: ${entry.explanation || 'Unknown'}`,
    `Root cause: ${entry.rootCause || 'unknown'}`,
  ];

  if (entry.pipeline) parts.push(`Pipeline: ${entry.pipeline}`);
  if (entry.phase) parts.push(`Phase: ${entry.phase}`);
  if (entry.errorCategory) parts.push(`Error category: ${entry.errorCategory}`);
  if (entry.errorDetail) parts.push(`Error detail: ${entry.errorDetail}`);
  if (entry.errorContext) parts.push(`Error context: ${entry.errorContext}`);
  if (entry.exitCode != null) parts.push(`Exit code: ${entry.exitCode}`);
  if (entry.signal) parts.push(`Signal: ${entry.signal}`);
  if (entry.error) parts.push(`Error: ${entry.error.slice(0, 500)}`);
  if (entry.stderrTail) parts.push(`Stderr: ${entry.stderrTail.slice(-500)}`);

  parts.push('');
  parts.push('Investigate the root cause and apply a minimal, targeted fix.');

  return parts.join('\n');
}
