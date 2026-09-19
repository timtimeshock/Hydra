/**
 * Shared Budget Tracker — Base class with configurable thresholds and actions.
 *
 * Both nightly and evolve use this base class with their own threshold configs.
 *
 * Thresholds are evaluated in priority order (highest pct first):
 *   hard_stop → soft_stop → (pipeline-specific action) → warn → continue
 */

import { checkUsage } from '../hydra-usage.mjs';
import { getSessionUsage } from '../hydra-metrics.mjs';

/**
 * @typedef {object} Threshold
 * @property {number} pct - Percentage trigger (0–1)
 * @property {string} action - Action name (e.g., 'hard_stop', 'warn', 'handoff_codex')
 * @property {string} reason - Template string with {pct} and {consumed} placeholders
 * @property {boolean} [once=false] - Only fire once per session
 */

/**
 * Base budget tracker. Subclass or configure with pipeline-specific thresholds.
 */
export class BudgetTracker {
  /**
   * @param {object} opts
   * @param {number} opts.softLimit
   * @param {number} opts.hardLimit
   * @param {number} opts.unitEstimate - Estimated tokens per unit (task/round)
   * @param {string} [opts.unitLabel='task'] - Label for units ('task' or 'round')
   * @param {Threshold[]} [opts.thresholds] - Custom threshold tiers (ordered high→low)
   */
  constructor({
    softLimit,
    hardLimit,
    unitEstimate,
    unitLabel = 'task',
    thresholds = [],
  }) {
    this.softLimit = softLimit;
    this.hardLimit = hardLimit;
    this.unitEstimate = unitEstimate;
    this.unitLabel = unitLabel;
    this.thresholds = thresholds;

    this.startTokens = 0;
    this.currentTokens = 0;
    this.unitDeltas = [];  // [{ label, tokens, durationMs }]
    this._startedAt = Date.now();
    this._firedOnce = new Set();
  }

  /** Record initial token state at start of run. */
  recordStart() {
    const session = getSessionUsage();
    this.startTokens = session.totalTokens || 0;
    this.currentTokens = this.startTokens;
  }

  /**
   * Snapshot current tokens after a unit completes.
   * @param {string} label - Unit identifier (slug, round number, etc.)
   * @param {number} durationMs
   * @param {object} [extra] - Additional fields to store (e.g., { area })
   * @returns {{ tokens: number }}
   */
  recordUnitEnd(label, durationMs, extra = {}) {
    const session = getSessionUsage();
    const now = session.totalTokens || 0;
    const delta = now - this.currentTokens;
    this.currentTokens = now;
    this.unitDeltas.push({ label, tokens: delta, durationMs, ...extra });
    return { tokens: delta };
  }

  /** Total tokens consumed in this session. */
  get consumed() {
    return this.currentTokens - this.startTokens;
  }

  /** Budget usage as a fraction (0–1). */
  get percentUsed() {
    return this.hardLimit > 0 ? this.consumed / this.hardLimit : 0;
  }

  /** Rolling average tokens per unit. */
  get avgTokensPerUnit() {
    if (this.unitDeltas.length === 0) return this.unitEstimate;
    const sum = this.unitDeltas.reduce((s, d) => s + d.tokens, 0);
    return Math.round(sum / this.unitDeltas.length);
  }

  /**
   * Check budget state and return an action recommendation.
   * Evaluates thresholds in priority order (highest pct first),
   * then falls back to soft limit check using external usage.
   */
  check() {
    let externalCritical = false;
    try {
      const usage = checkUsage();
      if (usage.level === 'critical') externalCritical = true;
    } catch { /* usage monitor may not have data */ }

    const consumed = this.consumed;
    const pct = this.percentUsed;
    const remaining = this.hardLimit - consumed;
    const avg = this.avgTokensPerUnit;
    const canFitNext = remaining > avg * 1.2;

    const base = {
      consumed,
      percentUsed: pct,
      remaining,
      [`canFitNext${this.unitLabel.charAt(0).toUpperCase() + this.unitLabel.slice(1)}`]: canFitNext,
      [`avgPer${this.unitLabel.charAt(0).toUpperCase() + this.unitLabel.slice(1)}`]: avg,
    };

    // External critical override
    if (externalCritical) {
      return { ...base, action: 'hard_stop',
        reason: 'External usage monitor reports critical level' };
    }

    // Evaluate thresholds in order
    for (const threshold of this.thresholds) {
      if (pct >= threshold.pct) {
        if (threshold.once && this._firedOnce.has(threshold.action)) {
          continue;
        }
        if (threshold.once) {
          this._firedOnce.add(threshold.action);
        }
        const reason = threshold.reason
          .replace('{pct}', String(Math.round(pct * 100)))
          .replace('{consumed}', consumed.toLocaleString());
        return { ...base, action: threshold.action, reason };
      }
    }

    return { ...base, action: 'continue', reason: 'Budget OK' };
  }

  /** Summary for reports. */
  getSummary() {
    return {
      startTokens: this.startTokens,
      endTokens: this.currentTokens,
      consumed: this.consumed,
      hardLimit: this.hardLimit,
      softLimit: this.softLimit,
      percentUsed: this.percentUsed,
      [`${this.unitLabel}Deltas`]: [...this.unitDeltas],
      [`avgPer${this.unitLabel.charAt(0).toUpperCase() + this.unitLabel.slice(1)}`]: this.avgTokensPerUnit,
      durationMs: Date.now() - this._startedAt,
    };
  }

  /** Serialize tracker state for checkpoint persistence. */
  serialize() {
    return {
      startTokens: this.startTokens,
      currentTokens: this.currentTokens,
      unitDeltas: this.unitDeltas,
      softLimit: this.softLimit,
      hardLimit: this.hardLimit,
      unitEstimate: this.unitEstimate,
      unitLabel: this.unitLabel,
      _startedAt: this._startedAt,
      _firedOnce: [...this._firedOnce],
    };
  }

  /** Restore a tracker from serialized checkpoint data. */
  static deserialize(data, thresholds = []) {
    const tracker = new BudgetTracker({
      softLimit: data.softLimit,
      hardLimit: data.hardLimit,
      unitEstimate: data.unitEstimate,
      unitLabel: data.unitLabel || 'task',
      thresholds,
    });
    tracker.startTokens = data.startTokens;
    tracker.currentTokens = data.currentTokens;
    tracker.unitDeltas = data.unitDeltas || [];
    tracker._startedAt = data._startedAt;
    tracker._firedOnce = new Set(data._firedOnce || []);
    return tracker;
  }
}
