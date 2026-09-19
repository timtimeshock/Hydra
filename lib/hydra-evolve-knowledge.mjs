#!/usr/bin/env node
/**
 * Hydra Evolve Knowledge Base — Persistent learning across evolve sessions.
 *
 * Stores research findings, improvement attempts, outcomes, and learnings
 * in a JSON file that accumulates across sessions. Provides search, dedup,
 * and stats for feeding context into future evolve rounds.
 *
 * Storage: docs/coordination/evolve/KNOWLEDGE_BASE.json
 */

import fs from 'fs';
import path from 'path';
import { ensureDir } from './hydra-utils.mjs';

// ── Constants ───────────────────────────────────────────────────────────────

const KNOWLEDGE_FILENAME = 'KNOWLEDGE_BASE.json';

function knowledgePath(evolveDir) {
  return path.join(evolveDir, KNOWLEDGE_FILENAME);
}

const EMPTY_KB = {
  version: 1,
  entries: [],
  stats: {
    totalResearched: 0,
    totalAttempted: 0,
    totalApproved: 0,
    totalRejected: 0,
    totalRevised: 0,
    topAreas: [],
  },
};

// ── Load / Save ─────────────────────────────────────────────────────────────

/**
 * Load the knowledge base from disk.
 * Returns a fresh empty KB if the file doesn't exist or is invalid.
 *
 * @param {string} evolveDir - Path to docs/coordination/evolve/
 * @returns {object} Knowledge base object
 */
export function loadKnowledgeBase(evolveDir) {
  const filePath = knowledgePath(evolveDir);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed.entries || !Array.isArray(parsed.entries)) {
      return { ...EMPTY_KB };
    }
    return parsed;
  } catch {
    return { ...EMPTY_KB, entries: [], stats: { ...EMPTY_KB.stats, topAreas: [] } };
  }
}

/**
 * Save the knowledge base to disk. Recalculates stats before writing.
 *
 * @param {string} evolveDir - Path to docs/coordination/evolve/
 * @param {object} kb - Knowledge base object
 */
export function saveKnowledgeBase(evolveDir, kb) {
  ensureDir(evolveDir);
  kb.stats = computeStats(kb.entries);
  const filePath = knowledgePath(evolveDir);
  fs.writeFileSync(filePath, JSON.stringify(kb, null, 2) + '\n', 'utf8');
}

// ── Entry Management ────────────────────────────────────────────────────────

/**
 * Generate the next entry ID based on existing entries.
 */
function nextId(entries) {
  if (entries.length === 0) return 'KB_001';
  const maxNum = entries.reduce((max, e) => {
    const m = (e.id || '').match(/^KB_(\d+)$/);
    return m ? Math.max(max, parseInt(m[1], 10)) : max;
  }, 0);
  return `KB_${String(maxNum + 1).padStart(3, '0')}`;
}

/**
 * Check if a finding is too similar to an existing entry (simple dedup).
 * Uses Jaccard similarity on word sets.
 */
function isTooSimilar(existingEntries, newFinding, threshold = 0.7) {
  const newWords = new Set(newFinding.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  if (newWords.size === 0) return false;

  for (const entry of existingEntries) {
    const existingWords = new Set(
      (entry.finding || '').toLowerCase().split(/\s+/).filter(w => w.length > 3)
    );
    if (existingWords.size === 0) continue;

    const intersection = new Set([...newWords].filter(w => existingWords.has(w)));
    const union = new Set([...newWords, ...existingWords]);
    const similarity = intersection.size / union.size;

    if (similarity >= threshold) return true;
  }
  return false;
}

/**
 * Add an entry to the knowledge base with dedup.
 * Returns the added entry (with generated ID) or null if deduplicated.
 *
 * @param {object} kb - Knowledge base object
 * @param {object} entry - Entry data (without id)
 * @param {number} entry.round - Round number
 * @param {string} entry.date - ISO date string
 * @param {string} entry.area - Focus area
 * @param {string} entry.finding - Description of the finding
 * @param {string} entry.applicability - 'high' | 'medium' | 'low'
 * @param {boolean} [entry.attempted] - Whether implementation was attempted
 * @param {string|null} [entry.outcome] - 'approve' | 'reject' | 'revise' | null
 * @param {number|null} [entry.score] - Aggregate score (1-10)
 * @param {string} [entry.learnings] - What was learned
 * @param {string[]} [entry.relatedEntries] - IDs of related entries
 * @param {string[]} [entry.tags] - Searchable tags
 * @returns {object|null} The added entry or null if deduped
 */
export function addEntry(kb, entry) {
  // Dedup check
  if (entry.finding && isTooSimilar(kb.entries, entry.finding)) {
    return null;
  }

  const id = nextId(kb.entries);
  const fullEntry = {
    id,
    round: entry.round || 0,
    date: entry.date || new Date().toISOString().split('T')[0],
    area: entry.area || 'unknown',
    finding: entry.finding || '',
    applicability: entry.applicability || 'medium',
    attempted: entry.attempted || false,
    outcome: entry.outcome || null,
    score: entry.score || null,
    learnings: entry.learnings || '',
    relatedEntries: entry.relatedEntries || [],
    tags: entry.tags || [],
  };

  kb.entries.push(fullEntry);
  return fullEntry;
}

/**
 * Update an existing entry by ID.
 *
 * @param {object} kb - Knowledge base object
 * @param {string} id - Entry ID (e.g., 'KB_001')
 * @param {object} updates - Fields to merge
 * @returns {object|null} Updated entry or null if not found
 */
export function updateEntry(kb, id, updates) {
  const entry = kb.entries.find(e => e.id === id);
  if (!entry) return null;
  Object.assign(entry, updates);
  return entry;
}

// ── Search ──────────────────────────────────────────────────────────────────

/**
 * Search entries by query text and/or tags.
 *
 * @param {object} kb - Knowledge base object
 * @param {string} [query] - Text to search in finding, area, learnings
 * @param {string[]} [tags] - Tags to match (OR logic)
 * @returns {object[]} Matching entries sorted by relevance
 */
export function searchEntries(kb, query, tags) {
  let results = [...kb.entries];

  if (tags && tags.length > 0) {
    const tagSet = new Set(tags.map(t => t.toLowerCase()));
    results = results.filter(e =>
      (e.tags || []).some(t => tagSet.has(t.toLowerCase()))
    );
  }

  if (query) {
    const q = query.toLowerCase();
    results = results.filter(e =>
      (e.finding || '').toLowerCase().includes(q) ||
      (e.area || '').toLowerCase().includes(q) ||
      (e.learnings || '').toLowerCase().includes(q) ||
      (e.tags || []).some(t => t.toLowerCase().includes(q))
    );
  }

  // Sort: attempted+outcome entries first, then by date descending
  results.sort((a, b) => {
    if (a.attempted && !b.attempted) return -1;
    if (!a.attempted && b.attempted) return 1;
    return (b.date || '').localeCompare(a.date || '');
  });

  return results;
}

/**
 * Get prior learnings for a specific focus area.
 * Used to inject context into Phase 3 (PLAN) to avoid repeating mistakes.
 *
 * @param {object} kb - Knowledge base object
 * @param {string} area - Focus area name
 * @returns {object[]} Entries for this area with learnings, sorted by date
 */
export function getPriorLearnings(kb, area) {
  return kb.entries
    .filter(e =>
      e.area === area ||
      (e.tags || []).some(t => t.toLowerCase() === area.toLowerCase())
    )
    .filter(e => e.learnings || e.outcome)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

// ── Stats ───────────────────────────────────────────────────────────────────

/**
 * Compute stats from entries.
 */
function computeStats(entries) {
  const totalResearched = entries.length;
  const totalAttempted = entries.filter(e => e.attempted).length;
  const totalApproved = entries.filter(e => e.outcome === 'approve').length;
  const totalRejected = entries.filter(e => e.outcome === 'reject').length;
  const totalRevised = entries.filter(e => e.outcome === 'revise').length;

  // Top areas by entry count
  const areaCounts = {};
  for (const e of entries) {
    const area = e.area || 'unknown';
    areaCounts[area] = (areaCounts[area] || 0) + 1;
  }
  const topAreas = Object.entries(areaCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([area, count]) => ({ area, count }));

  return {
    totalResearched,
    totalAttempted,
    totalApproved,
    totalRejected,
    totalRevised,
    topAreas,
  };
}

/**
 * Get knowledge base stats.
 *
 * @param {object} kb - Knowledge base object
 * @returns {object} Stats summary
 */
export function getStats(kb) {
  return computeStats(kb.entries);
}

/**
 * Format stats as a concise text block for injection into agent prompts.
 *
 * @param {object} kb - Knowledge base object
 * @returns {string} Formatted stats
 */
export function formatStatsForPrompt(kb) {
  const stats = computeStats(kb.entries);
  const lines = [
    `Knowledge Base: ${stats.totalResearched} findings, ${stats.totalAttempted} attempted, ${stats.totalApproved} approved, ${stats.totalRejected} rejected`,
  ];
  if (stats.topAreas.length > 0) {
    lines.push(`Top areas: ${stats.topAreas.map(a => `${a.area}(${a.count})`).join(', ')}`);
  }
  return lines.join('\n');
}
