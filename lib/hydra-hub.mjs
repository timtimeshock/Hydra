#!/usr/bin/env node
/**
 * Hydra Hub — Universal multi-agent coordination hub.
 *
 * Reads and writes the shared session hub at ~/.claude/projects/<slug>/memory/sessions/.
 * Every agent (Claude Code CLIs, forge agents, daemon tasks) registers here at startup
 * and deregisters on exit. Enables cross-agent visibility and file conflict detection.
 *
 * Set HYDRA_HUB_OVERRIDE env var to use a custom hub path (tests only).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const STALE_MS = 3 * 60 * 60 * 1000; // 3 hours

// ── Hub Path ──────────────────────────────────────────────────────────────────

function deriveHubPath() {
  if (process.env.HYDRA_HUB_OVERRIDE) {
    return process.env.HYDRA_HUB_OVERRIDE;
  }
  const home = os.homedir(); // e.g. C:\Users\Chili
  // Convert to Claude project slug: C:\Users\Chili → C--Users-Chili
  const slug = home
    .replace(/^([A-Za-z]):/, '$1-')  // C: → C-
    .replace(/[\\/]/g, '-')           // separators → -
    .replace(/^-/, '');               // strip leading dash
  return path.join(home, '.claude', 'projects', slug, 'memory', 'sessions');
}

const HUB_DIR = deriveHubPath();

/** Returns the absolute path to the hub sessions directory. */
export function hubPath() {
  return HUB_DIR;
}

// ── Internal Helpers ──────────────────────────────────────────────────────────

/**
 * Normalize a cwd for cross-platform comparison.
 * /e/Dev/PepperScale and E:\Dev\PepperScale both become e:/dev/pepperscale
 */
function normalizeCwd(cwd) {
  if (!cwd || typeof cwd !== 'string') return '';
  return cwd
    .replace(/\\/g, '/')                    // backslashes → forward slashes
    .replace(/^\/([a-z])\//i, '$1:/')      // /e/ → e:/
    .toLowerCase();
}

function ensureHubDir() {
  fs.mkdirSync(HUB_DIR, { recursive: true });
}

function sessionFilePath(id) {
  return path.join(HUB_DIR, `sess_${id}.json`);
}

function activityFilePath() {
  return path.join(HUB_DIR, 'activity.ndjson');
}

function nowIso() {
  return new Date().toISOString();
}

function makeId() {
  const d = new Date();
  const ts = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
    String(d.getHours()).padStart(2, '0'),
    String(d.getMinutes()).padStart(2, '0'),
    String(d.getSeconds()).padStart(2, '0'),
  ].join('');
  return `${ts}_${crypto.randomBytes(3).toString('hex')}`;
}

/** Atomic write: temp file + rename to avoid partial reads from concurrent agents. */
function atomicWrite(filePath, data) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.tmp.${crypto.randomBytes(4).toString('hex')}`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
    throw err;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Register a new agent session in the hub.
 *
 * @param {object} opts
 * @param {string} opts.agent       - Agent type ('claude-code', 'gemini-forge', 'codex-forge', 'hydra-tasks', etc.)
 * @param {string} opts.cwd         - Working directory (normalized for cross-platform comparison)
 * @param {string} opts.project     - Human-readable project name
 * @param {string} opts.focus       - Brief description of current work
 * @param {string[]} [opts.files=[]] - Files currently claimed by this agent
 * @param {string} [opts.taskId]    - Hydra daemon task ID (if linked)
 * @param {string} [opts.status='working'] - Initial status
 * @param {string} [opts.id]        - Override the generated session ID (for daemon use)
 * @returns {string} Session ID
 */
export function registerSession({ agent, cwd, project, focus, files = [], taskId, status = 'working', id } = {}) {
  ensureHubDir();
  const sessionId = id || makeId();
  const session = {
    id: sessionId,
    agent,
    cwd: normalizeCwd(cwd),
    project,
    focus: String(focus).slice(0, 120),
    status,
    files: Array.isArray(files) ? files : [],
    startedAt: nowIso(),
    lastUpdate: nowIso(),
    ...(taskId ? { taskId } : {}),
  };
  atomicWrite(sessionFilePath(sessionId), session);
  logActivity({ event: 'register', session: sessionId, agent, project, cwd: normalizeCwd(cwd), focus: session.focus });
  return sessionId;
}

/**
 * Update an active session's fields (files, status, focus).
 * No-op if the session file doesn't exist.
 *
 * @param {string} id       - Session ID returned by registerSession
 * @param {object} updates  - Fields to merge: { files?, status?, focus? }
 */
export function updateSession(id, updates) {
  const p = sessionFilePath(id);
  if (!fs.existsSync(p)) return;
  let session;
  try {
    session = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return;
  }
  Object.assign(session, updates, { lastUpdate: nowIso() });
  atomicWrite(p, session);
}

/**
 * Remove a session from the hub and log the event.
 * No-op if the session file doesn't exist.
 *
 * @param {string} id - Session ID
 */
export function deregisterSession(id) {
  const p = sessionFilePath(id);
  if (!fs.existsSync(p)) return;
  let agent = 'unknown';
  let project = 'unknown';
  try {
    const s = JSON.parse(fs.readFileSync(p, 'utf8'));
    agent = s.agent;
    project = s.project;
  } catch { /* best-effort */ }
  try {
    fs.unlinkSync(p);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  logActivity({ event: 'deregister', session: id, agent, project });
}

/**
 * List active sessions, auto-cleaning stale files (>3 hours without update).
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd] - If provided, only return sessions for this project
 * @returns {object[]} Array of session objects
 */
export function listSessions({ cwd } = {}) {
  ensureHubDir();
  const now = Date.now();
  const sessions = [];

  let entries;
  try {
    entries = fs.readdirSync(HUB_DIR);
  } catch {
    return [];
  }

  for (const file of entries) {
    if (!file.startsWith('sess_') || !file.endsWith('.json')) continue;
    const p = path.join(HUB_DIR, file);
    try {
      const session = JSON.parse(fs.readFileSync(p, 'utf8'));
      const lastUpdate = new Date(session.lastUpdate || session.startedAt).getTime();
      if (now - lastUpdate > STALE_MS) {
        try {
          fs.unlinkSync(p);
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
          // ENOENT = concurrently deleted, safe to skip
        }
        continue;
      }
      sessions.push(session);
    } catch {
      // Corrupt file — skip
    }
  }

  if (!cwd) return sessions;
  const normalizedCwd = normalizeCwd(cwd);
  return sessions.filter(s => (s.cwd || '') === normalizedCwd);
}

/**
 * Check if any planned files are already claimed by another active session in the same project.
 *
 * @param {string[]} plannedFiles - Files this agent plans to edit
 * @param {object} opts
 * @param {string} opts.cwd       - Current working directory (project filter)
 * @param {string} [opts.excludeId] - Session ID to exclude (your own session)
 * @returns {Array<{file: string, claimedBy: object}>} Conflicts found
 */
export function checkConflicts(plannedFiles, { cwd, excludeId } = {}) {
  const sessions = listSessions({ cwd });
  const conflicts = [];
  for (const session of sessions) {
    if (excludeId && session.id === excludeId) continue;
    if (!Array.isArray(session.files)) continue;
    for (const file of plannedFiles) {
      if (session.files.includes(file)) {
        conflicts.push({ file, claimedBy: session });
      }
    }
  }
  return conflicts;
}

/**
 * Append a structured event to the activity log (activity.ndjson).
 * Non-throwing — hub should never break callers.
 *
 * @param {object} event - Event fields (merged with { at: ISO timestamp })
 */
export function logActivity(event) {
  try {
    ensureHubDir();
    const line = JSON.stringify({ at: nowIso(), ...event }) + '\n';
    fs.appendFileSync(activityFilePath(), line, 'utf8');
  } catch { /* non-critical */ }
}
