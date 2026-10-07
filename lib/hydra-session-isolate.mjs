/**
 * Move the live coordination queue out of the way before a new objective.
 * Old tasks, handoffs, and decisions stay in the archive. They do not ride
 * into the next prompt.
 */

import fs from 'fs';

const OPEN_STATUS = new Set(['todo', 'in_progress', 'blocked', 'pending', 'open']);
const LIST_KEYS = ['tasks', 'handoffs', 'blockers', 'decisions', 'deadLetter'];

function stampItem(item, reason, stamp) {
  const copy = { ...item, shelvedAt: stamp, shelvedReason: reason };
  if (typeof copy.status === 'string' && OPEN_STATUS.has(copy.status)) {
    copy.status = 'cancelled';
    const line = `Shelved before a new objective: ${reason}`;
    copy.notes = copy.notes ? `${copy.notes}\n${line}` : line;
  }
  return copy;
}

/**
 * Mutates state and archive in place.
 * @returns {number} how many records left the live queue
 */
export function shelvePreviousWork(state, archive, reason = 'new objective') {
  const stamp = new Date().toISOString();
  let moved = 0;

  for (const key of LIST_KEYS) {
    const items = Array.isArray(state[key]) ? state[key] : [];
    if (items.length > 0) {
      if (!Array.isArray(archive[key])) archive[key] = [];
      archive[key].push(...items.map((item) => stampItem(item, reason, stamp)));
      moved += items.length;
    }
    state[key] = [];
  }

  const children = Array.isArray(state.childSessions) ? state.childSessions : [];
  if (children.length > 0) {
    if (!Array.isArray(archive.childSessions)) archive.childSessions = [];
    archive.childSessions.push(...children.map((item) => stampItem(item, reason, stamp)));
    moved += children.length;
  }
  state.childSessions = [];
  state.activeSession = null;
  return moved;
}

/**
 * Shelve whatever is currently stored on disk.
 * Archive is written first, so a crash cannot drop the live copy without a backup.
 */
export function isolateFiles(statePath, archivePath, reason = 'new objective') {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  let archive = { archivedAt: null, tasks: [], handoffs: [], blockers: [], decisions: [] };
  if (fs.existsSync(archivePath)) {
    try {
      archive = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
    } catch {
      archive = { archivedAt: null, tasks: [], handoffs: [], blockers: [], decisions: [] };
    }
  }
  const moved = shelvePreviousWork(state, archive, reason);
  if (moved > 0) {
    const at = new Date().toISOString();
    archive.archivedAt = at;
    state.updatedAt = at;
    fs.writeFileSync(archivePath, `${JSON.stringify(archive, null, 2)}\n`, 'utf8');
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }
  return {
    moved,
    tasks: state.tasks.length,
    handoffs: state.handoffs.length,
    decisions: state.decisions.length,
  };
}
