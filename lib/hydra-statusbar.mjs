/**
 * Hydra Status Bar - Persistent agent status footer pinned to the terminal bottom.
 *
 * Uses ANSI scroll regions to confine normal output to the upper portion of the
 * terminal, keeping a 5-line status bar fixed at the bottom showing context/gauge,
 * each agent's current activity with rich metadata, and a rolling activity ticker.
 *
 * Supports two data sources:
 *   - SSE event stream from daemon (/events/stream) — preferred, real-time
 *   - Fallback polling (/next?agent=...) — used when SSE unavailable
 *
 * Gracefully degrades to no-op when !process.stdout.isTTY or terminal < 10 rows.
 */

import http from 'http';
import pc from 'picocolors';
import { metricsEmitter, getSessionUsage, checkSLOs } from './hydra-metrics.mjs';
import { loadHydraConfig } from './hydra-config.mjs';
import {
  AGENT_ICONS,
  AGENT_COLORS,
  HEALTH_ICONS,
  formatAgentStatus,
  formatElapsed,
  stripAnsi,
  compactProgressBar,
  shortModelName,
  DIM,
  ACCENT,
} from './hydra-ui.mjs';
import { checkUsage } from './hydra-usage.mjs';

// ── Agent Activity State ────────────────────────────────────────────────────

const agentState = new Map();
const agentExecMode = new Map(); // agent -> 'worker' | 'terminal' | null

/**
 * Set an agent's activity state.
 * @param {string} agent - Agent name (gemini, codex, claude)
 * @param {'inactive'|'idle'|'working'|'error'} status
 * @param {string} [action] - Current action description
 * @param {object} [meta] - Optional metadata
 * @param {string} [meta.model] - Compact model name
 * @param {string} [meta.taskTitle] - What they're working on
 * @param {string} [meta.phase] - Council phase name
 * @param {string} [meta.step] - Progress like "2/4"
 */
export function setAgentActivity(agent, status, action, meta = {}) {
  agentState.set(agent.toLowerCase(), {
    status: status || 'inactive',
    action: action || '',
    model: meta.model || null,
    taskTitle: meta.taskTitle || null,
    phase: meta.phase || null,
    step: meta.step || null,
    updatedAt: Date.now(),
  });
}

/**
 * Set the execution mode indicator for an agent.
 * @param {string} agent
 * @param {'worker'|'terminal'|null} mode
 */
export function setAgentExecMode(agent, mode) {
  agentExecMode.set(agent.toLowerCase(), mode || null);
}

/**
 * Get the execution mode for an agent.
 * @param {string} agent
 * @returns {'worker'|'terminal'|null}
 */
export function getAgentExecMode(agent) {
  return agentExecMode.get(agent?.toLowerCase()) || null;
}

/**
 * Get an agent's current activity state.
 */
export function getAgentActivity(agent) {
  return agentState.get(agent.toLowerCase()) || { status: 'inactive', action: '', model: null, taskTitle: null, phase: null, step: null, updatedAt: 0 };
}

// ── Activity Event Buffer ───────────────────────────────────────────────────

const MAX_TICKER_EVENTS = 3;
const tickerEvents = [];
const activityCallbacks = [];

// Event type icons for visual scanning
const TICKER_ICONS = {
  claim: '\u26A1',       // ⚡
  handoff: '\u2192',     // →
  done: '\u2713',        // ✓
  error: '\u2717',       // ✗
  verify_pass: '\u{1F50D}',  // 🔍
  verify_fail: '\u2717', // ✗
  decision: '\u{1F4CB}', // 📋
  stale: '\u{1F552}',    // 🕒
  add: '\u002B',         // +
  blocked: '\u26D4',     // ⛔
};

function pushTickerEvent(text, eventType = null) {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
  const icon = eventType && TICKER_ICONS[eventType] ? TICKER_ICONS[eventType] + ' ' : '';
  tickerEvents.push({ time, text: icon + text });
  if (tickerEvents.length > MAX_TICKER_EVENTS) {
    tickerEvents.shift();
  }
}

/**
 * Register a callback for significant activity events.
 * Callback receives { time, event, agent, detail }.
 */
export function onActivityEvent(callback) {
  if (typeof callback === 'function') {
    activityCallbacks.push(callback);
  }
}

function emitActivityEvent(event) {
  for (const cb of activityCallbacks) {
    try { cb(event); } catch { /* ignore */ }
  }
}

// ── Scroll Region & Rendering ───────────────────────────────────────────────

const ESC = '\x1b[';
const STATUS_BAR_HEIGHT = 5; // divider + context/gauge + agents + ticker + spacer
let statusBarActive = false;
let registeredAgents = [];
let refreshInterval = null;
const REFRESH_INTERVAL_MS = 2000; // periodic redraw to recover from scroll region corruption

// ── Context Line State ──────────────────────────────────────────────────────

let lastDispatch = { route: '', tier: '', agent: '', mode: '' };
let openTaskCount = 0;
let activeMode = 'auto';

// ── Dispatch Context State ───────────────────────────────────────────────

let dispatchContext = null;

/**
 * Set active dispatch context for status bar narrative display.
 * @param {{ promptSummary: string, topic: string, tier: string, startedAt: number }} ctx
 */
export function setDispatchContext(ctx) {
  dispatchContext = ctx ? { ...ctx, startedAt: ctx.startedAt || Date.now() } : null;
}

/**
 * Clear active dispatch context (call after dispatch completes).
 */
export function clearDispatchContext() {
  dispatchContext = null;
}

// Token gauge (cached to avoid expensive disk reads)
let cachedUsage = null;
let cachedUsageAt = 0;
const USAGE_CACHE_TTL_MS = 30_000;

/**
 * Record the last dispatch routing decision for the context line.
 */
export function setLastDispatch(info) {
  lastDispatch = { ...lastDispatch, ...info };
}

/**
 * Set the active operator mode for the context line.
 */
export function setActiveMode(mode) {
  activeMode = String(mode || 'auto');
}

/**
 * Update the open task count displayed in the context line.
 */
export function updateTaskCount(count) {
  openTaskCount = Math.max(0, Number(count) || 0);
}

function isTTYCapable() {
  return Boolean(process.stdout.isTTY) && (process.stdout.rows || 0) >= 10;
}

function getTermSize() {
  return {
    rows: process.stdout.rows || 24,
    cols: process.stdout.columns || 80,
  };
}

/**
 * Set the terminal scroll region to exclude the bottom status bar lines.
 */
function setScrollRegion() {
  if (!isTTYCapable()) return;
  const { rows } = getTermSize();
  const scrollBottom = rows - STATUS_BAR_HEIGHT;
  // Set scroll region: rows 1 through (rows - STATUS_BAR_HEIGHT)
  process.stdout.write(`${ESC}1;${scrollBottom}r`);
  // Move cursor back into the scroll region
  process.stdout.write(`${ESC}${scrollBottom};1H`);
}

/**
 * Reset scroll region to full terminal.
 */
function resetScrollRegion() {
  const { rows } = getTermSize();
  process.stdout.write(`${ESC}1;${rows}r`);
  process.stdout.write(`${ESC}${rows};1H`);
}

/**
 * Build the context + token gauge line (line 2 of status bar).
 */
function buildContextLine(cols) {
  // Left: mode + tasks + last dispatch
  const MODE_ICONS = {
    smart: '\u26A1',     // ⚡
    auto: '\u21BB',      // ↻
    handoff: '\u2192',   // →
    council: '\u2694',   // ⚔
    dispatch: '\u2699',  // ⚙
    chat: '\u2B22'       // ⬢
  };
  const modeIcon = MODE_ICONS[activeMode] || '\u2022';
  const modePart = ACCENT(`${modeIcon} ${activeMode}`);
  const taskPart = `${openTaskCount} task${openTaskCount !== 1 ? 's' : ''}`;
  const lastPart = lastDispatch.route ? `last: ${lastDispatch.route}` : '';
  const leftParts = [modePart, DIM(taskPart)];
  if (dispatchContext && dispatchContext.promptSummary) {
    const tierBadge = dispatchContext.tier ? `[${dispatchContext.tier}]` : '';
    leftParts.push(ACCENT(`${tierBadge} ${dispatchContext.promptSummary}`));
  } else if (lastPart) {
    leftParts.push(DIM(lastPart));
  }
  // Routing mode chip (non-default modes only)
  const routingMode = loadHydraConfig().routing?.mode || 'balanced';
  const modeChip = routingMode === 'economy'     ? pc.yellow('\u25C6ECO')
                 : routingMode === 'performance' ? pc.cyan('\u25C6PERF')
                 : '';
  if (modeChip) leftParts.push(modeChip);

  const leftText = ` ${leftParts.join(DIM('  \u2502  '))}`;

  // SLO check (cached alongside usage)
  let sloIndicator = '';
  try {
    const cfg = loadHydraConfig();
    if (cfg.metrics?.slo && cfg.metrics?.alerts?.enabled !== false) {
      const violations = checkSLOs(cfg.metrics.slo);
      if (violations.length > 0) {
        const hasCritical = violations.some(v => v.metric === 'error_rate');
        sloIndicator = hasCritical
          ? ` ${pc.red('\u26A0 SLO')}`
          : ` ${pc.yellow('\u26A0 SLO')}`;
      }
    }
  } catch { /* skip */ }

  // Right: session cost + today's tokens
  let rightText = '';
  try {
    const now = Date.now();
    if (!cachedUsage || (now - cachedUsageAt) > USAGE_CACHE_TTL_MS) {
      cachedUsage = checkUsage();
      cachedUsageAt = now;
    }
    const usage = cachedUsage;

    // Session cost from metrics
    let costStr = '';
    try {
      const session = getSessionUsage();
      if (session.costUsd > 0) {
        costStr = `$${session.costUsd < 1 ? session.costUsd.toFixed(3) : session.costUsd.toFixed(2)}`;
      }
    } catch { /* skip */ }

    // Show today's actual token count from stats-cache
    const todayTokens = usage?.todayTokens || 0;
    if (todayTokens > 0) {
      const tokenStr = todayTokens >= 1_000_000
        ? `${(todayTokens / 1_000_000).toFixed(1)}M`
        : todayTokens >= 1_000
          ? `${(todayTokens / 1_000).toFixed(0)}K`
          : String(todayTokens);
      const parts = [];
      if (costStr) parts.push(DIM(costStr));
      parts.push(DIM(`${tokenStr} today`));
      rightText = parts.join('  ');
    } else if (costStr) {
      rightText = DIM(costStr);
    }
  } catch {
    rightText = DIM('n/a');
  }

  // Compose: left-align left, right-align right
  const leftStripped = stripAnsi(leftText);
  const fullRight = sloIndicator ? rightText + sloIndicator : rightText;
  const rightStripped = stripAnsi(fullRight);
  const gap = Math.max(1, cols - leftStripped.length - rightStripped.length);
  return leftText + ' '.repeat(gap) + fullRight;
}

/**
 * Build the 5-line status bar content.
 */
function buildStatusBar() {
  const { cols } = getTermSize();

  // Line 1: divider
  const dividerLine = DIM('\u2500'.repeat(cols));

  // Line 2: context + token gauge
  const contextLine = buildContextLine(cols);

  // Line 3: agent segments joined by │
  const segments = [];
  const agentSep = '  \u2502  '; // "  │  " = 5 visible chars
  const separatorChars = Math.max(0, registeredAgents.length - 1) * 5;
  const maxPerAgent = Math.max(16, Math.floor((cols - separatorChars) / registeredAgents.length));
  for (const agent of registeredAgents) {
    const state = getAgentActivity(agent);
    const elapsed = state.updatedAt && state.status === 'working'
      ? ` ${formatElapsed(Date.now() - state.updatedAt)}`
      : '';

    // Build compact action text — prioritize readability over detail
    let actionText = state.action || state.status || 'Inactive';
    if (state.status === 'working') {
      // Pick the most useful label: taskTitle > action > fallback
      let label = '';
      if (state.taskTitle) {
        label = state.taskTitle;
      } else if (state.action && !state.action.startsWith('Calling ')) {
        label = state.action;
      } else if (state.action) {
        label = state.action;
      }
      // Append step count inline (compact)
      const stepSuffix = state.step ? ` [${state.step}]` : '';
      actionText = label ? `${label}${stepSuffix}` : `Working${stepSuffix}`;
    }

    // Execution mode indicator
    const execMode = agentExecMode.get(agent);
    const modeSuffix = execMode === 'worker' ? DIM('[W]') : execMode === 'terminal' ? DIM('[T]') : '';
    const actionWithElapsed = `${actionText}${elapsed}${modeSuffix ? ' ' + modeSuffix : ''}`;
    segments.push(formatAgentStatus(agent, state.status, actionWithElapsed, maxPerAgent));
  }
  const agentLine = segments.join(DIM(agentSep));

  // Line 4: activity ticker
  let tickerLine = '';
  if (tickerEvents.length > 0) {
    const parts = tickerEvents.map((e) => `${DIM(e.time)} ${e.text}`);
    tickerLine = `  \u21B3 ${parts.join(DIM('  \u00B7  '))}`;
    const stripped = stripAnsi(tickerLine);
    if (stripped.length > cols) {
      tickerLine = `  \u21B3 ${parts.slice(-2).join(DIM('  \u00B7  '))}`;
    }
  } else {
    tickerLine = DIM('  \u21B3 awaiting events...');
  }

  // Line 5: empty spacer
  const spacerLine = '';

  return { dividerLine, contextLine, agentLine, tickerLine, spacerLine };
}

/**
 * Paint the status bar at the bottom of the terminal.
 */
export function drawStatusBar({ skipCursorSaveRestore = false } = {}) {
  if (!statusBarActive || !isTTYCapable()) return;
  const { rows } = getTermSize();
  const { dividerLine, contextLine, agentLine, tickerLine, spacerLine } = buildStatusBar();

  // Save cursor position (caller may handle this externally)
  if (!skipCursorSaveRestore) process.stdout.write(`${ESC}s`);

  // Line 1: divider (row = rows - 4)
  process.stdout.write(`${ESC}${rows - 4};1H`);
  process.stdout.write(`${ESC}2K`);
  process.stdout.write(dividerLine);

  // Line 2: context + gauge (row = rows - 3)
  process.stdout.write(`${ESC}${rows - 3};1H`);
  process.stdout.write(`${ESC}2K`);
  process.stdout.write(contextLine);

  // Line 3: agent status (row = rows - 2)
  process.stdout.write(`${ESC}${rows - 2};1H`);
  process.stdout.write(`${ESC}2K`);
  process.stdout.write(agentLine);

  // Line 4: activity ticker (row = rows - 1)
  process.stdout.write(`${ESC}${rows - 1};1H`);
  process.stdout.write(`${ESC}2K`);
  process.stdout.write(tickerLine);

  // Line 5: spacer (row = rows)
  process.stdout.write(`${ESC}${rows};1H`);
  process.stdout.write(`${ESC}2K`);
  process.stdout.write(spacerLine);

  // Restore cursor position (caller may handle this externally)
  if (!skipCursorSaveRestore) process.stdout.write(`${ESC}u`);
}

/**
 * Initialize the status bar: set scroll region, register agents, paint initial state.
 * @param {string[]} agents - Agent names to display
 */
export function initStatusBar(agents) {
  if (!isTTYCapable()) return;

  registeredAgents = (agents || []).map((a) => a.toLowerCase());

  // Initialize all agents as inactive
  for (const agent of registeredAgents) {
    if (!agentState.has(agent)) {
      setAgentActivity(agent, 'inactive', 'Inactive');
    }
  }

  statusBarActive = true;
  setScrollRegion();
  drawStatusBar();

  // Handle terminal resize
  process.stdout.on('resize', onResize);

  // Periodic refresh to recover from scroll region corruption
  // (agent child processes, escape sequences, etc. can disrupt the region)
  // Re-establish scroll region here (not in drawStatusBar) to avoid confusing readline
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = setInterval(() => {
    if (statusBarActive) {
      // Save cursor before re-establishing scroll region (which moves cursor)
      // so readline's cursor position is preserved after redraw
      process.stdout.write(`${ESC}s`);
      setScrollRegion();
      drawStatusBar({ skipCursorSaveRestore: true });
      process.stdout.write(`${ESC}u`);
    }
  }, REFRESH_INTERVAL_MS);
  if (refreshInterval.unref) refreshInterval.unref();
}

/**
 * Destroy the status bar: reset scroll region, clear footer lines.
 */
export function destroyStatusBar() {
  if (!statusBarActive) return;
  statusBarActive = false;

  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
  process.stdout.removeListener('resize', onResize);

  if (isTTYCapable()) {
    const { rows } = getTermSize();

    // Clear the status bar lines
    for (let i = STATUS_BAR_HEIGHT - 1; i >= 0; i--) {
      process.stdout.write(`${ESC}${rows - i};1H`);
      process.stdout.write(`${ESC}2K`);
    }

    // Reset scroll region to full terminal
    resetScrollRegion();
  }
}

function onResize() {
  if (!statusBarActive) return;
  process.stdout.write(`${ESC}s`);
  setScrollRegion();
  drawStatusBar({ skipCursorSaveRestore: true });
  process.stdout.write(`${ESC}u`);
}

// ── Metrics Event Listener ──────────────────────────────────────────────────

function setupMetricsListener() {
  metricsEmitter.on('call:start', ({ agent, model }) => {
    const modelShort = shortModelName(model);
    setAgentActivity(agent, 'working', `Calling ${modelShort}...`, { model: modelShort });
    drawStatusBar();
  });

  metricsEmitter.on('call:complete', ({ agent }) => {
    setAgentActivity(agent, 'idle', 'Idle');
    drawStatusBar();
  });

  metricsEmitter.on('call:error', ({ agent, error }) => {
    const errorShort = String(error || 'Error').slice(0, 30);
    setAgentActivity(agent, 'error', errorShort);
    drawStatusBar();
  });
}

// Set up listeners immediately on import
setupMetricsListener();

// ── SSE Event Stream ────────────────────────────────────────────────────────

let sseRequest = null;
let sseReconnectTimer = null;
const SSE_RECONNECT_DELAY_MS = 3000;

function handleSSEEvent(data, agents) {
  let event;
  try {
    event = JSON.parse(data);
  } catch {
    return;
  }

  const payload = event?.payload;
  if (!payload?.event) return;

  const agentList = new Set(agents.map((a) => a.toLowerCase()));

  switch (payload.event) {
    case 'handoff_ack': {
      const agent = String(payload.agent || '').toLowerCase();
      if (agentList.has(agent)) {
        const hSummary = payload.summary ? ` (${String(payload.summary).slice(0, 30)})` : '';
        setAgentActivity(agent, 'working', `Ack'd ${payload.handoffId || '?'}`);
        pushTickerEvent(`${agent} ack'd ${payload.handoffId || '?'}${hSummary}`, 'handoff');
        emitActivityEvent({ event: 'handoff_ack', agent, detail: `${payload.handoffId}${hSummary}` });
      }
      break;
    }
    case 'handoff': {
      const to = String(payload.to || '').toLowerCase();
      const from = String(payload.from || '').toLowerCase();
      const hSummary = payload.summary ? ` (${String(payload.summary).slice(0, 30)})` : '';
      if (agentList.has(to)) {
        // Don't clobber rich task-title status set within the last 5 seconds
        const current = getAgentActivity(to);
        const recentlySet = current.updatedAt && (Date.now() - current.updatedAt) < 5000;
        const hasTaskTitle = current.taskTitle && current.taskTitle.length > 0;
        if (!(recentlySet && hasTaskTitle)) {
          setAgentActivity(to, 'idle', `Handoff from ${from}`);
        }
        pushTickerEvent(`${from}\u2192${to}${hSummary}`, 'handoff');
        emitActivityEvent({ event: 'handoff', agent: to, detail: `from ${from}${hSummary}` });
      }
      break;
    }
    case 'task_claim': {
      const agent = String(payload.agent || '').toLowerCase();
      if (agentList.has(agent)) {
        const title = String(payload.title || '').slice(0, 40);
        setAgentActivity(agent, 'working', title || 'Working', { taskTitle: title || null });
        pushTickerEvent(`${agent} claimed ${title || 'task'}`, 'claim');
        emitActivityEvent({ event: 'task_claim', agent, detail: title });
      }
      break;
    }
    case 'task_add': {
      const owner = String(payload.owner || '').toLowerCase();
      const title = String(payload.title || '').slice(0, 40);
      openTaskCount++;
      pushTickerEvent(`${title}`, 'add');
      if (agentList.has(owner)) {
        emitActivityEvent({ event: 'task_add', agent: owner, detail: title });
      }
      break;
    }
    case 'task_update': {
      const status = String(payload.status || '').toLowerCase();
      const owner = String(payload.owner || '').toLowerCase();
      const tTitle = payload.title ? ` (${String(payload.title).slice(0, 30)})` : '';
      if (status === 'done') {
        openTaskCount = Math.max(0, openTaskCount - 1);
        if (agentList.has(owner)) {
          setAgentActivity(owner, 'idle', 'Done');
        }
        pushTickerEvent(`${payload.taskId || '?'}${tTitle} done`, 'done');
        emitActivityEvent({ event: 'task_done', agent: owner, detail: `${payload.taskId}${tTitle}` });
      } else if (status === 'blocked') {
        if (agentList.has(owner)) {
          setAgentActivity(owner, 'error', `Blocked \u2014 ${payload.taskId || '?'}`);
        }
        pushTickerEvent(`${payload.taskId || '?'}${tTitle} blocked`, 'blocked');
      }
      break;
    }
    case 'verify': {
      const passed = payload.passed;
      const taskId = payload.taskId || '?';
      pushTickerEvent(`verify ${taskId}: ${passed ? 'PASS' : 'FAIL'}`, passed ? 'verify_pass' : 'verify_fail');
      emitActivityEvent({ event: 'verify', agent: '', detail: `${taskId} ${passed ? 'passed' : 'failed'}` });
      break;
    }
    case 'decision': {
      const title = String(payload.title || '').slice(0, 40);
      pushTickerEvent(`${title}`, 'decision');
      break;
    }
    case 'task_stale': {
      const owner = String(payload.owner || '').toLowerCase();
      const sTitle = payload.title ? ` (${String(payload.title).slice(0, 30)})` : '';
      if (agentList.has(owner)) {
        setAgentActivity(owner, 'error', `${payload.taskId} stale`);
      }
      pushTickerEvent(`${payload.taskId || '?'}${sTitle} stale (${owner})`, 'stale');
      break;
    }
    default:
      break;
  }

  drawStatusBar();
}

/**
 * Connect to the daemon's SSE event stream.
 * Falls back to polling if SSE connection fails.
 * @param {string} baseUrl - Daemon base URL (e.g. http://127.0.0.1:4173)
 * @param {string[]} agents - Agent names to track
 */
export function startEventStream(baseUrl, agents) {
  if (!isTTYCapable()) return;

  const agentList = (agents || []).map((a) => a.toLowerCase());
  const url = new URL('/events/stream', baseUrl);

  function connect() {
    if (sseReconnectTimer) {
      clearTimeout(sseReconnectTimer);
      sseReconnectTimer = null;
    }

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: { Accept: 'text/event-stream' },
    };

    sseRequest = http.get(options, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        fallbackToPolling(baseUrl, agentList);
        return;
      }

      res.setEncoding('utf8');
      let buffer = '';

      res.on('data', (chunk) => {
        buffer += chunk;
        // Process complete SSE messages (terminated by \n\n)
        const messages = buffer.split('\n\n');
        // Keep the last incomplete chunk
        buffer = messages.pop() || '';

        for (const msg of messages) {
          const lines = msg.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              handleSSEEvent(line.slice(6), agentList);
            }
            // Ignore comment lines (:ok, :keepalive)
          }
        }
      });

      res.on('end', () => {
        // Connection closed — reconnect after delay
        sseReconnectTimer = setTimeout(() => connect(), SSE_RECONNECT_DELAY_MS);
        if (sseReconnectTimer.unref) sseReconnectTimer.unref();
      });

      res.on('error', () => {
        sseReconnectTimer = setTimeout(() => connect(), SSE_RECONNECT_DELAY_MS);
        if (sseReconnectTimer.unref) sseReconnectTimer.unref();
      });
    });

    sseRequest.on('error', () => {
      // Initial connection failed — fall back to polling
      fallbackToPolling(baseUrl, agentList);
    });

    // Don't keep process alive
    if (sseRequest.socket) {
      sseRequest.socket.unref();
    }
    sseRequest.on('socket', (socket) => {
      if (socket.unref) socket.unref();
    });
  }

  connect();
}

/**
 * Stop the SSE event stream and any reconnect timers.
 */
export function stopEventStream() {
  if (sseRequest) {
    try { sseRequest.destroy(); } catch { /* ignore */ }
    sseRequest = null;
  }
  if (sseReconnectTimer) {
    clearTimeout(sseReconnectTimer);
    sseReconnectTimer = null;
  }
  stopFallbackPolling();
}

// ── Fallback Polling ────────────────────────────────────────────────────────

let pollInterval = null;
const POLL_INTERVAL_MS = 2000;

function fallbackToPolling(baseUrl, agents) {
  if (pollInterval) return; // already polling
  startFallbackPolling(baseUrl, agents);
}

/**
 * Start polling the daemon for agent activity updates (fallback when SSE unavailable).
 * @param {string} baseUrl - Daemon base URL
 * @param {string[]} agents - Agent names to poll
 */
function startFallbackPolling(baseUrl, agents) {
  if (pollInterval) return;
  if (!isTTYCapable()) return;

  const agentList = (agents || []).map((a) => a.toLowerCase());

  pollInterval = setInterval(async () => {
    for (const agent of agentList) {
      const current = getAgentActivity(agent);
      // Don't overwrite real-time working state from metrics events
      if (current.status === 'working') continue;

      try {
        const url = new URL(`/next?agent=${encodeURIComponent(agent)}`, baseUrl);
        const res = await fetch(url.href, { signal: AbortSignal.timeout(1500) });
        if (!res.ok) continue;
        const data = await res.json();
        const action = data?.next?.action;

        if (action === 'continue_task' || action === 'pickup_handoff') {
          setAgentActivity(agent, 'idle', `Pending: ${action.replace(/_/g, ' ')}`);
        } else if (action === 'idle') {
          setAgentActivity(agent, 'idle', 'Idle');
        } else if (action === 'resolve_blocker') {
          setAgentActivity(agent, 'error', 'Blocked');
        } else if (action && action !== 'unknown') {
          setAgentActivity(agent, 'idle', action.replace(/_/g, ' '));
        } else if (current.status === 'inactive') {
          setAgentActivity(agent, 'idle', 'Idle');
        }
      } catch {
        // Network error - don't change state, just skip
      }
    }
    drawStatusBar();
  }, POLL_INTERVAL_MS);

  // Don't let the poll interval keep the process alive
  if (pollInterval.unref) {
    pollInterval.unref();
  }
}

function stopFallbackPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

// ── Legacy Exports (backward compat) ────────────────────────────────────────

/**
 * @deprecated Use startEventStream() instead. Kept for backward compatibility.
 */
export function startPolling(baseUrl, agents) {
  // Try SSE first, fall back to polling automatically
  startEventStream(baseUrl, agents);
}

/**
 * @deprecated Use stopEventStream() instead. Kept for backward compatibility.
 */
export function stopPolling() {
  stopEventStream();
}
