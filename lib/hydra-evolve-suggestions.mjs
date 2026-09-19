#!/usr/bin/env node
/**
 * Hydra Evolve Suggestions — Persistent backlog of improvement ideas.
 *
 * Stores improvement suggestions from failed/deferred evolve rounds, user input,
 * and review sessions. Presents pending suggestions at the start of each new
 * evolve session so the user can pick one to explore, enter their own, or let
 * agents discover something new.
 *
 * Storage: docs/coordination/evolve/SUGGESTIONS.json
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { ensureDir } from './hydra-utils.mjs';
import pc from 'picocolors';

// ── Constants ───────────────────────────────────────────────────────────────

const SUGGESTIONS_FILENAME = 'SUGGESTIONS.json';

function suggestionsPath(evolveDir) {
  return path.join(evolveDir, SUGGESTIONS_FILENAME);
}

const EMPTY_SUGGESTIONS = {
  version: 1,
  entries: [],
  stats: {
    totalPending: 0,
    totalCompleted: 0,
    totalRejected: 0,
    totalAbandoned: 0,
  },
};

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };

// ── Load / Save ─────────────────────────────────────────────────────────────

/**
 * Load the suggestions backlog from disk.
 * Returns a fresh empty object if the file doesn't exist or is invalid.
 *
 * @param {string} evolveDir - Path to docs/coordination/evolve/
 * @returns {object} Suggestions object
 */
export function loadSuggestions(evolveDir) {
  const filePath = suggestionsPath(evolveDir);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed.entries || !Array.isArray(parsed.entries)) {
      return { ...EMPTY_SUGGESTIONS, entries: [], stats: { ...EMPTY_SUGGESTIONS.stats } };
    }
    return parsed;
  } catch {
    return { ...EMPTY_SUGGESTIONS, entries: [], stats: { ...EMPTY_SUGGESTIONS.stats } };
  }
}

/**
 * Save the suggestions backlog to disk. Recalculates stats before writing.
 *
 * @param {string} evolveDir - Path to docs/coordination/evolve/
 * @param {object} sg - Suggestions object
 */
export function saveSuggestions(evolveDir, sg) {
  ensureDir(evolveDir);
  sg.stats = computeStats(sg.entries);
  const filePath = suggestionsPath(evolveDir);
  fs.writeFileSync(filePath, JSON.stringify(sg, null, 2) + '\n', 'utf8');
}

// ── Entry Management ────────────────────────────────────────────────────────

/**
 * Generate the next suggestion ID based on existing entries.
 */
function nextId(entries) {
  if (entries.length === 0) return 'SUG_001';
  const maxNum = entries.reduce((max, e) => {
    const m = (e.id || '').match(/^SUG_(\d+)$/);
    return m ? Math.max(max, parseInt(m[1], 10)) : max;
  }, 0);
  return `SUG_${String(maxNum + 1).padStart(3, '0')}`;
}

/**
 * Check if a title+description is too similar to an existing suggestion.
 * Uses Jaccard similarity on word sets.
 */
function isTooSimilar(existingEntries, newText, threshold = 0.7) {
  const newWords = new Set(newText.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  if (newWords.size === 0) return false;

  for (const entry of existingEntries) {
    // Only dedup against non-terminal entries
    if (entry.status === 'abandoned') continue;

    const existingText = `${entry.title || ''} ${entry.description || ''}`;
    const existingWords = new Set(existingText.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    if (existingWords.size === 0) continue;

    const intersection = new Set([...newWords].filter(w => existingWords.has(w)));
    const union = new Set([...newWords, ...existingWords]);
    const similarity = intersection.size / union.size;

    if (similarity >= threshold) return true;
  }
  return false;
}

/**
 * Add a suggestion to the backlog with dedup.
 * Returns the added entry (with generated ID) or null if deduplicated.
 *
 * @param {object} sg - Suggestions object
 * @param {object} entry - Suggestion data (without id)
 * @returns {object|null} The added entry or null if deduped
 */
export function addSuggestion(sg, entry) {
  const dedupText = `${entry.title || ''} ${entry.description || ''}`;
  if (dedupText.trim() && isTooSimilar(sg.entries, dedupText)) {
    return null;
  }

  const id = nextId(sg.entries);
  const fullEntry = {
    id,
    createdAt: entry.createdAt || new Date().toISOString().split('T')[0],
    source: entry.source || 'user:manual',
    sourceRef: entry.sourceRef || null,
    area: entry.area || 'general',
    title: entry.title || '',
    description: entry.description || '',
    specPath: entry.specPath || null,
    priority: entry.priority || 'medium',
    status: 'pending',
    attempts: entry.attempts || 0,
    maxAttempts: entry.maxAttempts || 3,
    lastAttemptDate: entry.lastAttemptDate || null,
    lastAttemptVerdict: entry.lastAttemptVerdict || null,
    lastAttemptScore: entry.lastAttemptScore || null,
    lastAttemptLearnings: entry.lastAttemptLearnings || null,
    tags: entry.tags || [],
    notes: entry.notes || '',
  };

  sg.entries.push(fullEntry);
  return fullEntry;
}

/**
 * Update an existing suggestion by ID.
 *
 * @param {object} sg - Suggestions object
 * @param {string} id - Suggestion ID (e.g., 'SUG_001')
 * @param {object} updates - Fields to merge
 * @returns {object|null} Updated entry or null if not found
 */
export function updateSuggestion(sg, id, updates) {
  const entry = sg.entries.find(e => e.id === id);
  if (!entry) return null;
  Object.assign(entry, updates);
  return entry;
}

/**
 * Set a suggestion's status to 'abandoned'.
 *
 * @param {object} sg - Suggestions object
 * @param {string} id - Suggestion ID
 * @returns {object|null} Updated entry or null if not found
 */
export function removeSuggestion(sg, id) {
  return updateSuggestion(sg, id, { status: 'abandoned' });
}

// ── Query ───────────────────────────────────────────────────────────────────

/**
 * Get all pending suggestions, sorted by priority then date.
 *
 * @param {object} sg - Suggestions object
 * @returns {object[]} Pending entries
 */
export function getPendingSuggestions(sg) {
  return sg.entries
    .filter(e => e.status === 'pending')
    .sort((a, b) => {
      const pa = PRIORITY_ORDER[a.priority] ?? 1;
      const pb = PRIORITY_ORDER[b.priority] ?? 1;
      if (pa !== pb) return pa - pb;
      return (a.createdAt || '').localeCompare(b.createdAt || '');
    });
}

/**
 * Lookup a suggestion by ID.
 *
 * @param {object} sg - Suggestions object
 * @param {string} id - Suggestion ID
 * @returns {object|null} Entry or null
 */
export function getSuggestionById(sg, id) {
  return sg.entries.find(e => e.id === id) || null;
}

/**
 * Search suggestions by query text and optional filters.
 *
 * @param {object} sg - Suggestions object
 * @param {string} [query] - Text to search in title, description, area, tags
 * @param {object} [opts] - Filters: { status, area }
 * @returns {object[]} Matching entries
 */
export function searchSuggestions(sg, query, opts = {}) {
  let results = [...sg.entries];

  if (opts.status) {
    results = results.filter(e => e.status === opts.status);
  }

  if (opts.area) {
    results = results.filter(e => e.area === opts.area);
  }

  if (query) {
    const q = query.toLowerCase();
    results = results.filter(e =>
      (e.title || '').toLowerCase().includes(q) ||
      (e.description || '').toLowerCase().includes(q) ||
      (e.area || '').toLowerCase().includes(q) ||
      (e.tags || []).some(t => t.toLowerCase().includes(q))
    );
  }

  return results.sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority] ?? 1;
    const pb = PRIORITY_ORDER[b.priority] ?? 1;
    if (pa !== pb) return pa - pb;
    return (b.createdAt || '').localeCompare(a.createdAt || '');
  });
}

// ── Auto-Population ─────────────────────────────────────────────────────────

/**
 * Create a suggestion from a rejected/deferred evolve round.
 * Only creates if the round had a valid improvement and no similar suggestion exists.
 *
 * @param {object} sg - Suggestions object
 * @param {object} roundResult - The round result object from evolve
 * @param {object} deliberation - The deliberation object (has selectedImprovement)
 * @param {object} [opts] - { sessionId, specPath, notes, source }
 * @returns {object|null} The created suggestion or null if deduped/invalid
 */
export function createSuggestionFromRound(sg, roundResult, deliberation, opts = {}) {
  const improvement = deliberation?.selectedImprovement;
  if (!improvement || improvement === 'No improvement selected' || improvement.length < 10) {
    return null;
  }

  // Build a short title from the improvement text
  const title = improvement.length > 100 ? improvement.slice(0, 97) + '...' : improvement;

  // Determine source
  const source = opts.source || (
    roundResult.verdict === 'reject' ? 'auto:rejected-round' :
    roundResult.verdict === 'skipped' ? 'auto:deferred' :
    'auto:rejected-round'
  );

  // Determine priority based on score
  let priority = 'medium';
  if (roundResult.score >= 5) priority = 'high';
  if (roundResult.score <= 1 && roundResult.investigations?.diagnoses?.every(d => d.diagnosis === 'transient')) {
    // Low score due to transient failures (timeouts etc.) — likely worth retrying
    priority = 'high';
  }

  return addSuggestion(sg, {
    source,
    sourceRef: opts.sessionId ? `${opts.sessionId}/round-${roundResult.round}` : null,
    area: roundResult.area,
    title,
    description: improvement,
    specPath: opts.specPath || null,
    priority,
    tags: [roundResult.area, source.split(':')[1] || source, ...(roundResult.verdict ? [roundResult.verdict] : [])],
    notes: opts.notes || '',
  });
}

// ── Interactive Picker ──────────────────────────────────────────────────────

/**
 * Create a readline interface for the picker (same pattern as review-common).
 */
function createRL() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
}

/**
 * Ask a question and return the trimmed answer.
 */
function askRaw(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

/**
 * Present pending suggestions to the user and let them pick one,
 * skip, enter freeform text, or let agents discover.
 *
 * @param {object[]} pending - Array of pending suggestion entries
 * @param {object} [opts] - { maxDisplay: 5 }
 * @returns {Promise<{ action: string, suggestion?: object, text?: string }>}
 */
export async function promptSuggestionPicker(pending, opts = {}) {
  const maxDisplay = opts.maxDisplay || 5;
  const displayed = pending.slice(0, maxDisplay);

  const rl = createRL();

  try {
    console.error('');
    console.error(pc.bold(pc.cyan(`  Pending Suggestions (${pending.length}):`)));
    console.error('');

    for (let i = 0; i < displayed.length; i++) {
      const s = displayed[i];
      const num = pc.bold(pc.white(`  ${i + 1}.`));
      const idTag = pc.dim(`[${s.id}]`);
      const areaTag = pc.yellow(s.area);
      const titleText = s.title.length > 60 ? s.title.slice(0, 57) + '...' : s.title;

      console.error(`${num} ${idTag} ${areaTag}: ${titleText} ${pc.dim(`(${s.priority})`)}`);

      // Second line with attempt info
      const parts = [];
      if (s.attempts > 0) {
        parts.push(`Last: ${s.lastAttemptVerdict || '?'} (${s.lastAttemptScore ?? '?'}/10)`);
        parts.push(`Attempts: ${s.attempts}/${s.maxAttempts}`);
      }
      if (s.specPath) {
        parts.push('has spec');
      }
      if (parts.length > 0) {
        console.error(`     ${pc.dim(parts.join(' | '))}`);
      }
      console.error('');
    }

    if (pending.length > maxDisplay) {
      console.error(pc.dim(`     ... and ${pending.length - maxDisplay} more`));
      console.error('');
    }

    const prompt = pc.cyan(`  [1-${displayed.length}]`) +
      ` pick, ${pc.dim('[s]')}kip, ${pc.dim('[f]')}reeform, ${pc.dim('[d]')}iscover: `;

    const answer = await askRaw(rl, prompt);
    const lower = answer.toLowerCase();

    // Number selection
    const num = parseInt(answer, 10);
    if (num >= 1 && num <= displayed.length) {
      return { action: 'pick', suggestion: displayed[num - 1] };
    }

    // Freeform
    if (lower === 'f' || lower === 'freeform') {
      const text = await askRaw(rl, pc.cyan('  Describe your improvement idea: '));
      if (text.length > 0) {
        return { action: 'freeform', text };
      }
      return { action: 'discover' };
    }

    // Discover
    if (lower === 'd' || lower === 'discover') {
      return { action: 'discover' };
    }

    // Skip (default)
    return { action: 'skip' };

  } finally {
    rl.close();
  }
}

// ── Stats ───────────────────────────────────────────────────────────────────

/**
 * Compute stats from entries.
 */
function computeStats(entries) {
  return {
    totalPending: entries.filter(e => e.status === 'pending').length,
    totalExploring: entries.filter(e => e.status === 'exploring').length,
    totalCompleted: entries.filter(e => e.status === 'completed').length,
    totalRejected: entries.filter(e => e.status === 'rejected').length,
    totalAbandoned: entries.filter(e => e.status === 'abandoned').length,
  };
}

/**
 * Get suggestion stats.
 *
 * @param {object} sg - Suggestions object
 * @returns {object} Stats summary
 */
export function getSuggestionStats(sg) {
  return computeStats(sg.entries);
}

/**
 * Format stats as a concise text block for agent prompts.
 *
 * @param {object} sg - Suggestions object
 * @returns {string} Formatted one-liner
 */
export function formatSuggestionsForPrompt(sg) {
  const stats = computeStats(sg.entries);
  return `Suggestions Backlog: ${stats.totalPending} pending, ${stats.totalCompleted} completed, ${stats.totalRejected} rejected`;
}
