/**
 * Hydra Action Pipeline — Unified SCAN → ENRICH → SELECT → CONFIRM → EXECUTE → REPORT.
 *
 * Any scan→select→act workflow should use this pipeline. Provides consistent UX,
 * multi-select, confirmation, per-item execution with spinners, and summary reports.
 *
 * @typedef {Object} ActionItem
 * @prop {string} id          - Unique identifier
 * @prop {string} title       - Short description
 * @prop {string} description - Detail text
 * @prop {string} category    - 'fix' | 'cleanup' | 'archive' | 'requeue' | 'delete'
 * @prop {'critical'|'high'|'medium'|'low'} severity
 * @prop {string} source      - Where it came from
 * @prop {string} [agent]     - Suggested agent
 * @prop {string} [actionPrompt] - Prompt for execution
 * @prop {object} [meta]      - Source-specific metadata
 *
 * @typedef {Object} PipelineResult
 * @prop {ActionItem} item
 * @prop {boolean} ok
 * @prop {string} [output]
 * @prop {string} [error]
 * @prop {number} durationMs
 */

import {
  sectionHeader,
  DIM,
  ACCENT,
  ERROR,
  SUCCESS,
  WARNING,
  createSpinner,
  formatElapsed,
} from './hydra-ui.mjs';
import { promptChoice, confirmActionPlan } from './hydra-prompt-choice.mjs';
import pc from 'picocolors';

/**
 * Run the full action pipeline.
 *
 * @param {readline.Interface} rl
 * @param {object} opts
 * @param {string} opts.title - Pipeline title for UI
 * @param {Array<() => Promise<ActionItem[]>>} opts.scanners - Parallel scan functions
 * @param {Function} [opts.enrich] - (items, context) => Promise<ActionItem[]>
 * @param {Function} [opts.preSelectFilter] - (item) => boolean
 * @param {Function} opts.executeFn - (item, opts) => Promise<PipelineResult>
 * @param {Function} [opts.onComplete] - (results) => void
 * @param {string} [opts.projectRoot]
 * @param {string} [opts.baseUrl]
 * @returns {Promise<PipelineResult[]>}
 */
export async function runActionPipeline(rl, opts = {}) {
  const {
    title = 'Action Pipeline',
    scanners = [],
    enrich,
    preSelectFilter,
    executeFn,
    onComplete,
  } = opts;

  console.log('');
  console.log(sectionHeader(title));

  // ── SCAN ─────────────────────────────────────────────────────────────────
  const scanSpinner = createSpinner('Scanning...', { style: 'orbital' });
  let allItems = [];

  try {
    const results = await Promise.allSettled(scanners.map((fn) => fn()));
    for (const r of results) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        allItems.push(...r.value);
      }
    }
  } finally {
    scanSpinner.stop();
  }

  // Deduplicate by id
  const seen = new Set();
  allItems = allItems.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });

  if (allItems.length === 0) {
    console.log(`  ${DIM('Nothing found.')}`);
    console.log('');
    return [];
  }

  console.log(`  ${SUCCESS(`Found ${allItems.length} item${allItems.length !== 1 ? 's' : ''}`)}`);

  // ── ENRICH ───────────────────────────────────────────────────────────────
  if (enrich) {
    const enrichSpinner = createSpinner('Analyzing...', { style: 'stellar' });
    try {
      allItems = await enrich(allItems);
    } catch {
      // Non-fatal: continue with un-enriched items
    } finally {
      enrichSpinner.stop();
    }
  }

  // ── SELECT ───────────────────────────────────────────────────────────────
  // Build choices from items
  const choices = allItems.map((item) => ({
    label: item.title,
    value: item.id,
    hint: `${item.severity} | ${item.category} | ${item.source}`,
  }));

  const preSelectedIds = preSelectFilter
    ? allItems.filter(preSelectFilter).map((i) => i.id)
    : [];

  const selectResult = await promptChoice(rl, {
    title: `${title} — Select`,
    choices,
    multiSelect: true,
    preSelected: preSelectedIds,
  });

  const selectedIds = new Set(selectResult.values || []);
  if (selectedIds.size === 0) {
    console.log(`  ${DIM('Nothing selected.')}`);
    console.log('');
    return [];
  }

  const selectedItems = allItems.filter((i) => selectedIds.has(i.id));

  // ── CONFIRM ──────────────────────────────────────────────────────────────
  const actions = selectedItems.map((item) => ({
    label: item.title,
    description: item.description,
    agent: item.agent,
    severity: item.severity,
  }));

  const confirmed = await confirmActionPlan(rl, {
    title: `${title} — Confirm`,
    summary: `${selectedItems.length} action${selectedItems.length !== 1 ? 's' : ''} to execute`,
    actions,
  });

  if (!confirmed) {
    console.log(`  ${DIM('Cancelled.')}`);
    console.log('');
    return [];
  }

  // ── EXECUTE ──────────────────────────────────────────────────────────────
  console.log('');
  console.log(sectionHeader(`${title} — Executing`));

  const results = [];
  for (let i = 0; i < selectedItems.length; i++) {
    const item = selectedItems[i];
    const progress = DIM(`[${i + 1}/${selectedItems.length}]`);
    const spinner = createSpinner(`${progress} ${item.title}`, { style: 'solar' });

    const startMs = Date.now();
    let pipelineResult;

    try {
      pipelineResult = await executeFn(item, opts);
    } catch (err) {
      pipelineResult = {
        item,
        ok: false,
        error: err.message || String(err),
        durationMs: Date.now() - startMs,
      };
    } finally {
      spinner.stop();
    }

    // Ensure result has required fields
    pipelineResult.item = pipelineResult.item || item;
    pipelineResult.durationMs = pipelineResult.durationMs || (Date.now() - startMs);

    const statusIcon = pipelineResult.ok ? SUCCESS('\u2713') : ERROR('\u2718');
    const elapsed = formatElapsed(pipelineResult.durationMs);
    console.log(`  ${statusIcon} ${item.title} ${DIM(elapsed)}`);
    if (!pipelineResult.ok && pipelineResult.error) {
      console.log(`    ${ERROR(pipelineResult.error.slice(0, 120))}`);
    }

    results.push(pipelineResult);
  }

  // ── REPORT ───────────────────────────────────────────────────────────────
  console.log('');
  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;
  const totalMs = results.reduce((sum, r) => sum + (r.durationMs || 0), 0);

  const summaryParts = [
    `${succeeded} succeeded`,
    failed > 0 ? `${failed} failed` : null,
    formatElapsed(totalMs),
  ].filter(Boolean);

  const summaryColor = failed === 0 ? SUCCESS : failed === results.length ? ERROR : WARNING;
  console.log(`  ${summaryColor(`${title} complete:`)} ${summaryParts.join(' | ')}`);
  console.log('');

  if (onComplete) {
    try { onComplete(results); } catch { /* best effort */ }
  }

  return results;
}
