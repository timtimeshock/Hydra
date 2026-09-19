/**
 * Hydra Knowledge Base — Persistent learning across sessions (shared module).
 *
 * Promoted from hydra-evolve-knowledge.mjs to be usable by both
 * the evolve and nightly pipelines.
 *
 * Re-exports everything from the original module.
 */

export {
  loadKnowledgeBase,
  saveKnowledgeBase,
  addEntry,
  updateEntry,
  searchEntries,
  getPriorLearnings,
  getStats,
  formatStatsForPrompt,
} from './hydra-evolve-knowledge.mjs';
