/**
 * Hydra Resume Scanner — Unified resumable state detection.
 *
 * Scans all sources in parallel and returns a flat array of resumable items
 * for the operator's :resume command. Each scanner is independently try/catch
 * wrapped so one failure never blocks others.
 *
 * Designed as a standalone module so any flow (operator, concierge, nightly)
 * can query "what can be resumed?" without coupling to the operator REPL.
 */

import fs from 'fs';
import path from 'path';

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * @typedef {object} ResumableItem
 * @property {string} source   - Origin scanner (daemon, evolve, council, branches, suggestions)
 * @property {string} label    - Human-readable short label for picker
 * @property {string} hint     - Additional context line
 * @property {string} value    - Machine-readable dispatch key
 * @property {string} [detail] - Optional extra info
 */

// ── Main Export ─────────────────────────────────────────────────────────────

/**
 * Scan all resumable state sources in parallel.
 *
 * @param {object} opts
 * @param {string} opts.baseUrl      - Daemon base URL (e.g. 'http://localhost:4173')
 * @param {string} opts.projectRoot  - Project root directory
 * @returns {Promise<ResumableItem[]>}
 */
export async function scanResumableState({ baseUrl, projectRoot }) {
  const evolveDir = path.join(projectRoot, 'docs', 'coordination', 'evolve');
  const coordDir = path.join(projectRoot, 'docs', 'coordination');

  const results = await Promise.allSettled([
    scanDaemon(baseUrl),
    scanEvolveSession(evolveDir),
    scanCouncilCheckpoints(coordDir),
    scanUnmergedBranches(projectRoot),
    scanSuggestions(evolveDir),
  ]);

  const items = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) {
      if (Array.isArray(r.value)) {
        items.push(...r.value);
      } else {
        items.push(r.value);
      }
    }
  }
  return items;
}

// ── Individual Scanners ─────────────────────────────────────────────────────

async function scanDaemon(baseUrl) {
  if (!baseUrl) return null;
  try {
    const { request } = await import('./hydra-utils.mjs');
    const status = await request('GET', baseUrl, '/session/status');
    const items = [];

    // Paused session
    if (status.activeSession?.status === 'paused') {
      const reason = status.activeSession.pauseReason;
      items.push({
        source: 'daemon',
        label: 'Unpause session',
        hint: reason ? `Paused: "${reason}"` : 'Session is paused',
        value: 'daemon:unpause',
      });
    }

    // Stale tasks
    const stale = status.staleTasks || [];
    if (stale.length > 0) {
      items.push({
        source: 'daemon',
        label: `Reset ${stale.length} stale task${stale.length > 1 ? 's' : ''}`,
        hint: stale.map(t => `${t.id} (${t.owner})`).join(', '),
        value: 'daemon:stale',
      });
    }

    // Pending handoffs
    const handoffs = status.pendingHandoffs || [];
    if (handoffs.length > 0) {
      items.push({
        source: 'daemon',
        label: `Ack ${handoffs.length} pending handoff${handoffs.length > 1 ? 's' : ''}`,
        hint: handoffs.map(h => `${h.from}→${h.to}`).join(', '),
        value: 'daemon:handoffs',
      });
    }

    // In-progress tasks (agents may need relaunching)
    const inProgress = status.inProgressTasks || [];
    if (inProgress.length > 0 && stale.length === 0 && handoffs.length === 0) {
      items.push({
        source: 'daemon',
        label: `Resume ${inProgress.length} in-progress task${inProgress.length > 1 ? 's' : ''}`,
        hint: inProgress.map(t => `${t.id} (${t.owner})`).join(', '),
        value: 'daemon:resume',
      });
    }

    return items.length > 0 ? items : null;
  } catch {
    return null;
  }
}

async function scanEvolveSession(evolveDir) {
  try {
    const statePath = path.join(evolveDir, 'EVOLVE_SESSION_STATE.json');
    if (!fs.existsSync(statePath)) return null;
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));

    if (!state.resumable) return null;
    const status = state.status;
    if (status !== 'partial' && status !== 'failed' && status !== 'interrupted') return null;

    const completed = (state.completedRounds || []).length;
    const max = state.maxRounds || '?';
    const action = state.actionNeeded || `${status} — can resume`;

    return {
      source: 'evolve',
      label: `Resume evolve session (${completed}/${max} rounds)`,
      hint: action,
      value: 'evolve',
      detail: state.sessionId,
    };
  } catch {
    return null;
  }
}

async function scanCouncilCheckpoints(coordDir) {
  try {
    const councilDir = coordDir;
    if (!fs.existsSync(councilDir)) return null;

    const files = fs.readdirSync(councilDir).filter(f => /^COUNCIL_CHECKPOINT_.*\.json$/i.test(f));
    if (files.length === 0) return null;

    const items = [];
    for (const file of files.slice(0, 3)) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(councilDir, file), 'utf8'));
        const hash = file.replace(/^COUNCIL_CHECKPOINT_/, '').replace(/\.json$/, '');
        items.push({
          source: 'council',
          label: `Council checkpoint: ${(data.prompt || hash).slice(0, 50)}`,
          hint: `Phase: ${data.phase || 'unknown'}`,
          value: `council:${hash}`,
          detail: file,
        });
      } catch { /* skip malformed */ }
    }
    return items.length > 0 ? items : null;
  } catch {
    return null;
  }
}

async function scanUnmergedBranches(projectRoot) {
  try {
    const { listBranches } = await import('./hydra-shared/git-ops.mjs');
    const items = [];

    for (const prefix of ['evolve', 'nightly', 'tasks']) {
      const branches = listBranches(projectRoot, prefix);
      if (branches.length > 0) {
        items.push({
          source: 'branches',
          label: `${branches.length} unmerged ${prefix}/* branch${branches.length > 1 ? 'es' : ''}`,
          hint: branches.slice(0, 3).join(', ') + (branches.length > 3 ? ` +${branches.length - 3} more` : ''),
          value: `branches:${prefix}`,
        });
      }
    }

    return items.length > 0 ? items : null;
  } catch {
    return null;
  }
}

async function scanSuggestions(evolveDir) {
  try {
    const { loadSuggestions, getPendingSuggestions } = await import('./hydra-evolve-suggestions.mjs');
    const sg = loadSuggestions(evolveDir);
    const pending = getPendingSuggestions(sg);
    if (pending.length === 0) return null;

    const topTitles = pending.slice(0, 3).map(s => s.title).join('; ');
    return {
      source: 'suggestions',
      label: `${pending.length} pending evolve suggestion${pending.length > 1 ? 's' : ''}`,
      hint: topTitles,
      value: 'suggestions',
    };
  } catch {
    return null;
  }
}
