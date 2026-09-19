/**
 * Hydra Investigator — Self-healing failure diagnosis (shared module).
 *
 * Promoted from hydra-evolve-investigator.mjs to be usable by both
 * the evolve and nightly pipelines.
 *
 * Re-exports everything from the original module.
 */

export {
  initInvestigator,
  isInvestigatorAvailable,
  investigate,
  getInvestigatorStats,
  resetInvestigator,
} from './hydra-evolve-investigator.mjs';
