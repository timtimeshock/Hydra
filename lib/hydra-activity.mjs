/**
 * Household list of what Hydra did.
 * Stored in the local Hydra data folder, not in the program tree.
 * Entries older than a month drop themselves.
 */

import fs from 'fs';
import path from 'path';
import { localDataFile } from './hydra-local.mjs';
import { getAgentActivity, getAgentExecMode } from './hydra-statusbar.mjs';
import { getSessionUsage, getAgentMetrics } from './hydra-metrics.mjs';
import { request } from './hydra-utils.mjs';
import { detectAvailableProviders, streamWithFallback } from './hydra-concierge-providers.mjs';
import { isPersonaEnabled, getPersonaConfig } from './hydra-persona.mjs';
import { HYDRA_ROOT } from './hydra-config.mjs';

const KEEP_DAYS = 31;

export function defaultActivityFile() {
  localDataFile('activity.md');
  return localDataFile('activity.json');
}

export function oneLine(value, max = 700) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function formatWhen(iso) {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return '';
  return new Intl.DateTimeFormat('cs-CZ', {
    timeZone: 'Europe/Prague',
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(when);
}

function readEntries(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(data.entries) ? data.entries : [];
  } catch {
    return [];
  }
}

export function renderActivity(entries) {
  const lines = [
    '# Co Hydra dělala',
    '',
    'Seznam je v místních datech počítače, ne ve složce programu.',
    'Záznam starší než měsíc se smaže sám.',
    '',
  ];
  if (!entries.length) {
    lines.push('Zatím tu nic není.');
    lines.push('');
    return lines.join('\n');
  }
  for (const entry of entries) {
    lines.push(`- ${formatWhen(entry.at)} — ${entry.state}`);
    lines.push(`  Úkol: ${entry.task}`);
    if (entry.outcome) lines.push(`  Výsledek: ${entry.outcome}`);
  }
  lines.push('');
  return lines.join('\n');
}

function writeActivity(filePath, entries) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = {
    keepDays: KEEP_DAYS,
    entries,
  };
  fs.writeFileSync(filePath, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  const mdPath = filePath.replace(/\.json$/i, '.md');
  fs.writeFileSync(mdPath, renderActivity(entries), 'utf8');
}

export function recordActivity(entry, opts = {}) {
  const filePath = opts.filePath || defaultActivityFile();
  const now = opts.now ? new Date(opts.now) : new Date();
  const keepDays = opts.keepDays ?? KEEP_DAYS;
  const cutoff = now.getTime() - keepDays * 24 * 60 * 60 * 1000;
  let entries = readEntries(filePath).filter((item) => Date.parse(item.at) >= cutoff);
  if (entry.replacesId) {
    entries = entries.filter((item) => item.id !== entry.replacesId);
  }
  const next = {
    id: String(entry.id || ''),
    at: entry.at || now.toISOString(),
    task: oneLine(entry.task),
    outcome: oneLine(entry.outcome),
    state: oneLine(entry.state, 40) || 'hotovo',
  };
  if (!next.id || !next.task || Number.isNaN(Date.parse(next.at))) return entries;
  if (Date.parse(next.at) < cutoff) return entries;
  const index = entries.findIndex((item) => item.id === next.id);
  if (index >= 0) entries[index] = next;
  else entries.push(next);
  entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  writeActivity(filePath, entries);
  return entries;
}

export function entryFromSavedRun(data, fileName = '') {
  if (!data || typeof data !== 'object' || !data.prompt) return null;
  const checkpoint = fileName.startsWith('COUNCIL_CHECKPOINT_');
  const hash = data.promptHash || fileName.replace(/^COUNCIL_CHECKPOINT_|\.json$/g, '');
  const id = checkpoint ? `cp-${hash}` : (data.id || fileName.replace(/\.json$/, ''));
  const at = data.finishedAt || data.updatedAt || data.startedAt;
  if (!id || !at) return null;
  const last = Array.isArray(data.transcript) ? data.transcript.at(-1) : null;
  let state = 'hotovo';
  if (checkpoint) state = 'rozpracováno';
  else if (data.mode === 'preview') state = 'náhled';
  let outcome = '';
  if (!checkpoint) outcome = data.finalDecision?.summary || data.consensus || '';
  if (!outcome && last) outcome = `${last.agent || ''} ${last.phase || ''}`.trim();
  if (last && last.ok === false && !checkpoint) state = 'selhalo';
  return { id, at, task: data.prompt, outcome, state };
}

export function entryFromDecision(decision) {
  if (!decision || typeof decision !== 'object') return null;
  const title = oneLine(String(decision.title || '').replace(/^Hydra Council:\s*/i, ''));
  const why = oneLine(decision.rationale || '');
  if (!decision.id || !decision.createdAt || !title) return null;
  const flow = String(decision.impact || '').match(/Flow=([^;]+)/);
  const who = flow ? flow[1].replace(/→/g, ', ').trim() : '';
  const outcome = [why, who ? `Pracovali: ${who}.` : ''].filter(Boolean).join(' ');
  return {
    id: String(decision.id),
    at: decision.createdAt,
    task: title,
    outcome,
    state: 'hotovo',
  };
}

export function replaceActivity(entries, opts = {}) {
  const filePath = opts.filePath || defaultActivityFile();
  const now = opts.now ? new Date(opts.now) : new Date();
  const keepDays = opts.keepDays ?? KEEP_DAYS;
  const cutoff = now.getTime() - keepDays * 24 * 60 * 60 * 1000;
  const kept = [];
  for (const entry of entries) {
    if (!entry?.id || !entry?.task || Number.isNaN(Date.parse(entry.at))) continue;
    if (Date.parse(entry.at) < cutoff) continue;
    kept.push({
      id: String(entry.id),
      at: entry.at,
      task: oneLine(entry.task),
      outcome: oneLine(entry.outcome),
      state: oneLine(entry.state, 40) || 'hotovo',
    });
  }
  kept.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  writeActivity(filePath, kept);
  return kept;
}

export function backfillRuns(runsDir, opts = {}) {
  if (!fs.existsSync(runsDir)) return [];
  let entries = [];
  for (const name of fs.readdirSync(runsDir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(runsDir, name), 'utf8'));
      const entry = entryFromSavedRun(data, name);
      if (!entry) continue;
      entries = recordActivity(entry, opts);
    } catch {
      /* skip a broken run file */
    }
  }
  return entries;
}

// Session digest used by the GUI concierge. Kept beside the household journal.

const SITUATIONAL_PATTERNS = [
  { pattern: /what(?:'s| is) (?:going on|happening|the status|the state|up)\b/i, focus: 'all' },
  { pattern: /(?:status|progress) update/i, focus: 'all' },
  { pattern: /give me (?:a )?(?:status|update|summary|overview|sitrep|digest|report)\b/i, focus: 'all' },
  { pattern: /what(?:'s| is|'re| are) (?:the )?agents? (?:doing|working|up to)/i, focus: 'all' },
  { pattern: /how(?:'s| is) (?:it|everything|things?) going/i, focus: 'all' },
  { pattern: /any (?:progress|updates?|news|activity)\b/i, focus: 'all' },
  { pattern: /(?:^|\s)sitrep\b/i, focus: 'all' },
  { pattern: /what(?:'s| is) (claude|gemini|codex) (?:doing|working on|up to)/i, focus: '$1' },
  { pattern: /how(?:'s| is) (claude|gemini|codex) (?:doing|going|progressing)/i, focus: '$1' },
  { pattern: /(?:^|\s)(claude|gemini|codex) status\b/i, focus: '$1' },
  { pattern: /what(?:'s| is) (claude|gemini|codex) (?:current|active)/i, focus: '$1' },
  { pattern: /where(?:'s| is) (claude|gemini|codex)\b/i, focus: '$1' },
  { pattern: /what tasks? (?:are|is) (?:open|pending|active|running)/i, focus: 'tasks' },
  { pattern: /what(?:'s| is) (?:being worked on|in progress|pending)\b/i, focus: 'tasks' },
  { pattern: /(?:open|active|pending|running) tasks/i, focus: 'tasks' },
  { pattern: /what(?:'s| is) (?:the|that) handoff/i, focus: 'handoffs' },
  { pattern: /(?:pending|recent|last) handoffs?/i, focus: 'handoffs' },
  { pattern: /what (?:was|got) handed off/i, focus: 'handoffs' },
  { pattern: /context (?:of|for) (?:the|that) handoff/i, focus: 'handoffs' },
  { pattern: /handoff (?:details?|context|summary)/i, focus: 'handoffs' },
  { pattern: /what (?:was|did) (?:I|we) (?:just )?(?:dispatch|send|kick off)/i, focus: 'dispatch' },
  { pattern: /what(?:'s| is) (?:the )?last dispatch/i, focus: 'dispatch' },
  { pattern: /what(?:'s| was) dispatched/i, focus: 'dispatch' },
];

export function detectSituationalQuery(message) {
  if (!message || typeof message !== 'string') {
    return { isSituational: false, focus: null };
  }
  const trimmed = message.trim();
  for (const { pattern, focus } of SITUATIONAL_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      let resolved = focus;
      if (focus === '$1' && match[1]) resolved = match[1].toLowerCase();
      return { isSituational: true, focus: resolved };
    }
  }
  return { isSituational: false, focus: null };
}

export function annotateDispatch({ prompt, classification, mode, route, agent }) {
  const shortPrompt = (prompt || '').slice(0, 120);
  const tier = classification?.tier || 'unknown';
  const taskType = classification?.taskType || '';
  const conf = classification?.confidence != null ? ` (${Math.round(classification.confidence * 100)}%)` : '';
  const agentStr = agent ? ` to ${agent}` : '';
  const routeStr = route ? ` via ${route}` : '';
  return `Dispatched "${shortPrompt}" - ${tier}/${taskType}${conf}${routeStr}${agentStr} [${mode || 'auto'}]`;
}

export function annotateHandoff({ from, to, summary, taskTitle }) {
  const shortSummary = (summary || '').slice(0, 100);
  const task = taskTitle ? ` (task: "${taskTitle}")` : '';
  return `${from || '?'} handed off to ${to || '?'}: "${shortSummary}"${task}`;
}

export function annotateCompletion({ agent, taskId, title, durationMs, outputSummary, status }) {
  const elapsed = durationMs ? `${Math.round(durationMs / 1000)}s` : '';
  const statusStr = status === 'error' ? 'FAILED' : 'completed';
  const summary = outputSummary ? `: "${(outputSummary || '').slice(0, 80)}"` : '';
  const taskStr = title ? ` "${title}"` : '';
  return `${agent || '?'} ${statusStr} ${taskId || '?'}${taskStr}${elapsed ? ` in ${elapsed}` : ''}${summary}`;
}

const MAX_ACTIVITY_LOG = 50;
const activityLog = [];

export function pushActivity(type, narrative, meta) {
  activityLog.push({
    at: new Date().toISOString(),
    type,
    narrative,
    meta: meta || null,
  });
  if (activityLog.length > MAX_ACTIVITY_LOG) {
    activityLog.splice(0, activityLog.length - MAX_ACTIVITY_LOG);
  }
}

export function getRecentActivity(n = 20) {
  return activityLog.slice(-n);
}

export function clearActivityLog() {
  activityLog.length = 0;
}

export async function buildActivityDigest({ baseUrl, workers, focus }) {
  let daemonActivity = null;
  try {
    const focusParam = focus && focus !== 'all' ? `?focus=${encodeURIComponent(focus)}` : '';
    const res = await request('GET', baseUrl, `/activity${focusParam}`);
    daemonActivity = res?.activity || null;
  } catch {
    try {
      const res = await request('GET', baseUrl, '/summary');
      daemonActivity = { _fromSummary: true, summary: res?.summary || null };
    } catch { /* daemon unreachable */ }
  }

  const agents = ['claude', 'gemini', 'codex'].map((name) => {
    const activity = getAgentActivity(name);
    const metrics = getAgentMetrics(name);
    const execMode = getAgentExecMode(name);
    const worker = workers?.get(name);
    const daemonAgent = daemonActivity?.agents?.[name] || {};

    return {
      name,
      status: activity.status,
      action: activity.action,
      taskTitle: activity.taskTitle || daemonAgent.currentTask?.title || null,
      model: activity.model,
      phase: activity.phase,
      step: activity.step,
      execMode,
      elapsedMs: activity.updatedAt ? Date.now() - activity.updatedAt : 0,
      currentTask: daemonAgent.currentTask || null,
      pendingHandoffs: daemonAgent.pendingHandoffs || [],
      worker: worker ? {
        status: worker._state || worker.status || 'unknown',
        currentTaskId: worker._currentTask?.taskId || null,
        currentTaskTitle: worker._currentTask?.title || null,
        permissionMode: worker._permissionMode || null,
      } : null,
      metrics: metrics ? {
        callsToday: metrics.callsToday || 0,
        successRate: metrics.callsTotal > 0 ? Math.round((metrics.callsSuccess / metrics.callsTotal) * 100) : 100,
        avgDurationMs: metrics.avgDurationMs || 0,
        lastModel: metrics.lastModel || null,
      } : null,
    };
  });

  const tasks = daemonActivity?.tasks || daemonActivity?.summary?.openTasks || [];
  const activeTasks = Array.isArray(tasks)
    ? tasks
    : [
      ...(tasks.inProgress || []),
      ...(tasks.todo || []),
      ...(tasks.blocked || []),
    ];
  const recentCompletions = Array.isArray(tasks?.recentlyCompleted) ? tasks.recentlyCompleted : [];
  const handoffs = daemonActivity?.handoffs || {};
  const pendingHandoffs = handoffs.pending || [];
  const recentHandoffs = handoffs.recent || [];
  const sessionUsage = getSessionUsage();

  return {
    generatedAt: new Date().toISOString(),
    session: daemonActivity?.session || null,
    agents,
    activeTasks,
    recentCompletions: recentCompletions.slice(0, 5),
    pendingHandoffs,
    recentHandoffs: recentHandoffs.slice(0, 5),
    recentDecisions: daemonActivity?.decisions?.recent || [],
    lastDispatch: getLastDispatchFromLog(),
    activityLog: getRecentActivity(10),
    counts: daemonActivity?.counts || null,
    metrics: {
      totalCalls: sessionUsage.callCount || 0,
      totalTokens: sessionUsage.totalTokens || 0,
      totalCost: sessionUsage.costUsd || 0,
    },
  };
}

function getLastDispatchFromLog() {
  for (let i = activityLog.length - 1; i >= 0; i--) {
    if (activityLog[i].type === 'dispatch') return activityLog[i];
  }
  return null;
}

export function formatDigestForPrompt(digest, opts = {}) {
  const maxChars = opts.maxChars || 6000;
  const focus = opts.focus || 'all';
  const lines = ['=== ACTIVITY DIGEST ==='];

  if (digest.session) {
    const s = digest.session;
    const since = s.startedAt ? new Date(s.startedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : '?';
    lines.push(`Session: ${s.status || 'active'} since ${since} | Focus: "${(s.focus || 'general').slice(0, 60)}"`);
  }

  if (focus === 'all' || ['claude', 'gemini', 'codex'].includes(focus)) {
    lines.push('');
    lines.push('AGENTS:');
    const agentsToShow = focus === 'all' ? digest.agents : digest.agents.filter((a) => a.name === focus);
    for (const a of agentsToShow) {
      const execTag = a.execMode === 'worker' ? ' [W]' : a.execMode === 'terminal' ? ' [T]' : '';
      const elapsed = a.elapsedMs > 5000 ? ` ${formatElapsedCompact(a.elapsedMs)}` : '';
      const model = a.model ? ` (${a.model})` : '';
      const taskStr = a.taskTitle ? ` "${a.taskTitle.slice(0, 50)}"` : '';
      const phase = a.phase ? ` [${a.phase}${a.step ? ` ${a.step}` : ''}]` : '';
      lines.push(`- ${a.name} [${a.status}]${taskStr}${phase}${model}${execTag}${elapsed}`);
      if (a.pendingHandoffs.length > 0) {
        for (const h of a.pendingHandoffs.slice(0, 2)) {
          lines.push(`  ^ pending handoff from ${h.from}: "${(h.summary || '').slice(0, 60)}"`);
        }
      }
    }
  }

  if (focus === 'all' || focus === 'tasks' || ['claude', 'gemini', 'codex'].includes(focus)) {
    const tasksToShow = focus === 'all' || focus === 'tasks'
      ? digest.activeTasks
      : digest.activeTasks.filter((t) => t.owner === focus);

    if (tasksToShow.length > 0) {
      lines.push('');
      lines.push(`TASKS (${tasksToShow.length} active):`);
      for (const t of tasksToShow.slice(0, 8)) {
        const blocked = t.blockedBy?.length > 0 ? ` (blocked by ${t.blockedBy.join(', ')})` : '';
        lines.push(`- ${t.id} [${t.status}] ${t.owner || 'unassigned'} - "${(t.title || '').slice(0, 60)}"${blocked}`);
      }
      if (tasksToShow.length > 8) lines.push(`  ... and ${tasksToShow.length - 8} more`);
    }
  }

  if (focus === 'all' || focus === 'handoffs') {
    if (digest.pendingHandoffs.length > 0 || digest.recentHandoffs.length > 0) {
      lines.push('');
      lines.push('HANDOFFS:');
      if (digest.pendingHandoffs.length > 0) {
        lines.push('  Pending:');
        for (const h of digest.pendingHandoffs.slice(0, 3)) {
          lines.push(`  - ${h.id}: ${h.from} -> ${h.to} "${(h.summary || '').slice(0, 80)}"`);
          if (h.nextStep) lines.push(`    Next: ${h.nextStep.slice(0, 80)}`);
        }
      }
      if (digest.recentHandoffs.length > 0) {
        lines.push('  Recent:');
        for (const h of digest.recentHandoffs.slice(0, 3)) {
          const acked = h.acknowledged ? ' (ack)' : '';
          lines.push(`  - ${h.id}: ${h.from} -> ${h.to} "${(h.summary || '').slice(0, 80)}"${acked}`);
        }
      }
    }
  }

  if (focus === 'all' || focus === 'tasks') {
    if (digest.recentCompletions.length > 0) {
      lines.push('');
      lines.push('RECENT COMPLETIONS:');
      for (const c of digest.recentCompletions.slice(0, 3)) {
        const elapsed = c.durationMs ? ` in ${Math.round(c.durationMs / 1000)}s` : '';
        lines.push(`- ${c.id || c.taskId}: ${c.owner || c.agent || '?'} done${elapsed} - "${(c.title || '').slice(0, 60)}"`);
      }
    }
  }

  if (focus === 'all' || focus === 'dispatch') {
    const lastDispatch = digest.lastDispatch;
    if (lastDispatch) {
      lines.push('');
      lines.push('LAST DISPATCH:');
      lines.push(`- ${lastDispatch.narrative || 'unknown'}`);
    }
  }

  if (focus === 'all') {
    const recentLog = digest.activityLog || [];
    if (recentLog.length > 0) {
      lines.push('');
      lines.push('ACTIVITY LOG (recent):');
      for (const entry of recentLog.slice(-5)) {
        const time = new Date(entry.at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
        lines.push(`- ${time} [${entry.type}] ${entry.narrative.slice(0, 100)}`);
      }
    }
  }

  if (digest.metrics && (digest.metrics.totalCalls > 0 || digest.metrics.totalTokens > 0)) {
    lines.push('');
    const cost = digest.metrics.totalCost > 0 ? ` | ~$${digest.metrics.totalCost.toFixed(2)}` : '';
    const tokens = digest.metrics.totalTokens > 0 ? ` | ${Math.round(digest.metrics.totalTokens / 1000)}K tokens` : '';
    lines.push(`Session: ${digest.metrics.totalCalls} calls${cost}${tokens}`);
  }

  lines.push('=== END DIGEST ===');

  let result = lines.join('\n');
  if (result.length > maxChars) {
    result = result.slice(0, maxChars - 20) + '\n... (truncated)\n=== END DIGEST ===';
  }
  return result;
}

function formatElapsedCompact(ms) {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function getSitrepSystemPrompt() {
  const personaName = isPersonaEnabled() ? (getPersonaConfig().name || 'Hydra') : 'Hydra';
  const narrator = isPersonaEnabled()
    ? `You are ${personaName}'s situation awareness perspective, narrating the current state of the system.`
    : 'You are a situation report narrator for Hydra, a multi-agent AI coding orchestration system.';
  return `${narrator} A developer is returning after a break and needs orientation. Given structured data about system state, git history, and task progress, produce a concise big-picture summary.

Structure your response with these three labeled sections (skip a section only if truly empty):

GOAL: Infer the project objective from session focus, branch name, and commit message themes. One or two sentences.

PROGRESS: What has been accomplished — completed tasks, commit highlights, current agent activity. Reference specific commits or task IDs when available.

REMAINING: Open/blocked tasks, pending handoffs, and 1-2 concrete next steps if resuming work now.

End with a single closing line that folds in resource status (budget level, token usage) if available, e.g. "Budget is healthy at 15% used." or "Approaching daily budget limit."

Rules:
- 200-300 words total
- Reference task IDs, agent names, commit messages when available
- If idle with no recent activity, say so briefly and suggest what to do next
- Synthesize, don't repeat raw data
- No markdown headers — use GOAL:, PROGRESS:, REMAINING: as plain text labels
- Write for a developer who just sat down and needs to get oriented fast`;
}

export async function generateSitrep(opts = {}) {
  const { baseUrl, workers, budgetStatus, gitBranch, gitLog, statsData } = opts;
  const digest = await buildActivityDigest({ baseUrl, workers, focus: 'all' });
  const formattedDigest = formatDigestForPrompt(digest, { maxChars: 4000 });
  const sessionFocus = digest.session?.focus || null;
  const supplemental = [];
  if (sessionFocus) supplemental.push(`Session focus: ${sessionFocus}`);
  if (gitBranch) supplemental.push(`Git branch: ${gitBranch}`);
  if (gitLog) supplemental.push(`Recent commits:\n${gitLog}`);
  if (digest.counts) {
    const c = digest.counts;
    const parts = [];
    if (c.completed != null) parts.push(`${c.completed} completed`);
    if (c.open != null) parts.push(`${c.open} open`);
    if (c.blocked != null) parts.push(`${c.blocked} blocked`);
    if (parts.length > 0) supplemental.push(`Task progress: ${parts.join(', ')}`);
  }
  if (budgetStatus) {
    const lvl = budgetStatus.level || budgetStatus.weekly?.level || 'unknown';
    const pct = budgetStatus.weekly?.percentUsed != null
      ? `${Math.round(budgetStatus.weekly.percentUsed)}%`
      : '';
    const msg = budgetStatus.message || budgetStatus.weekly?.message || '';
    supplemental.push(`Budget: ${lvl}${pct ? ` (${pct} used)` : ''}${msg ? ` — ${msg}` : ''}`);
  }
  if (statsData) {
    const parts = [];
    if (statsData.uptime) parts.push(`uptime ${statsData.uptime}`);
    if (statsData.totalCalls != null) parts.push(`${statsData.totalCalls} total calls`);
    if (statsData.totalTokens != null) parts.push(`${Math.round(statsData.totalTokens / 1000)}K tokens`);
    if (parts.length > 0) supplemental.push(`Daemon: ${parts.join(', ')}`);
  }

  const userContent = supplemental.length > 0
    ? `${formattedDigest}\n\nSUPPLEMENTAL:\n${supplemental.join('\n')}`
    : formattedDigest;

  const providers = detectAvailableProviders();
  if (providers.length === 0) {
    const headerParts = [];
    if (sessionFocus) headerParts.push(`Focus: ${sessionFocus}`);
    if (gitBranch) headerParts.push(`Branch: ${gitBranch}`);
    const header = headerParts.length > 0 ? headerParts.join(' | ') + '\n\n' : '';
    return { narrative: header + formattedDigest, fallback: true, reason: 'no_provider' };
  }

  const messages = [
    { role: 'system', content: getSitrepSystemPrompt() },
    { role: 'user', content: userContent },
  ];

  try {
    const result = await streamWithFallback(
      messages,
      { maxTokens: 2000, reasoningEffort: 'low' },
      () => {},
    );
    const narrative = (result.fullResponse || '').trim();
    if (!narrative) return { narrative: formattedDigest, fallback: true, reason: 'empty_response' };
    return {
      narrative,
      provider: result.provider,
      model: result.model,
      usage: result.usage,
      fallback: false,
    };
  } catch (err) {
    return { narrative: formattedDigest, fallback: true, reason: 'api_error', error: err.message };
  }
}

const SESSION_SUMMARIES_FILE = path.join(HYDRA_ROOT, 'docs', 'coordination', 'session-summaries.json');
const MAX_SESSION_SUMMARIES = 10;

function loadSessionSummaries() {
  try {
    const raw = fs.readFileSync(SESSION_SUMMARIES_FILE, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data.summaries) ? data.summaries : [];
  } catch {
    return [];
  }
}

export function saveSessionSummary(summary) {
  if (!summary || typeof summary !== 'string') return;
  const summaries = loadSessionSummaries();
  summaries.push({
    timestamp: new Date().toISOString(),
    summary: summary.slice(0, 2000),
    activityCount: activityLog.length,
  });
  while (summaries.length > MAX_SESSION_SUMMARIES) summaries.shift();
  const dir = path.dirname(SESSION_SUMMARIES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SESSION_SUMMARIES_FILE, JSON.stringify({ summaries }, null, 2) + '\n');
}

export function getSessionContext() {
  const priorSessions = loadSessionSummaries().slice(-3);
  return {
    recentActivity: getRecentActivity(10),
    priorSessions,
  };
}
