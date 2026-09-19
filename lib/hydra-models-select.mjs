#!/usr/bin/env node
/**
 * Hydra Interactive Model Selector
 *
 * Arrow-key picker to browse available models per agent and set the active one.
 * Sets global mode to 'custom' on selection.
 *
 * Usage:
 *   node lib/hydra-models-select.mjs           # pick agent first
 *   node lib/hydra-models-select.mjs claude     # straight to claude models
 *   node lib/hydra-models-select.mjs codex
 *   node lib/hydra-models-select.mjs gemini
 *
 * npm scripts:
 *   npm run models:select                       # all
 *   npm run models:select -- claude             # single
 */

import readline from 'readline';
import pc from 'picocolors';
import { loadHydraConfig, saveHydraConfig, invalidateConfigCache } from './hydra-config.mjs';
import {
  getActiveModel, resolveModelId,
  getReasoningEffort, REASONING_EFFORTS,
  getEffortOptionsForModel, formatEffortDisplay,
  AGENTS, AGENT_NAMES, AGENT_DISPLAY_ORDER,
} from './hydra-agents.mjs';
import { fetchModels } from './hydra-models.mjs';
import { formatBenchmarkAnnotation } from './hydra-model-profiles.mjs';

// ── ANSI helpers ────────────────────────────────────────────────────────────

const CSI = '\x1b[';
const CLEAR_LINE = `${CSI}2K`;
const CLEAR_BELOW = `${CSI}0J`;
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;
const up = (n) => n > 0 ? `${CSI}${n}A` : '';

// Ensure cursor is always restored
process.on('exit', () => process.stdout.write(SHOW_CURSOR));

// ── Interactive Picker ─────────────────────────────────────────────────────

class Picker {
  /**
   * @param {Array} items       - Objects to choose from
   * @param {object} opts
   * @param {string}   opts.title      - Header line
   * @param {function} opts.renderItem - (item, isSelected) => display string
   * @param {function} opts.filterKey  - (item) => searchable text
   * @param {number}   opts.pageSize   - Visible rows (default 18)
   * @param {number}   opts.initialIndex
   */
  constructor(items, opts = {}) {
    this.items = items;
    this.filtered = [...items];
    this.cursor = Math.min(opts.initialIndex || 0, Math.max(0, items.length - 1));
    this.search = '';
    this.title = opts.title || '';
    this.renderItem = opts.renderItem || ((item) => String(item));
    this.filterKey = opts.filterKey || ((item) => String(item));
    this.pageSize = opts.pageSize || 18;
    this.scroll = 0;
    this._lines = 0;
    this._handler = null;
    this._resolve = null;
  }

  run() {
    if (!process.stdin.isTTY) return this._fallback();

    return new Promise((resolve) => {
      this._resolve = resolve;
      readline.emitKeypressEvents(process.stdin);
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdout.write(HIDE_CURSOR);

      this._handler = (str, key) => this._onKey(str, key);
      process.stdin.on('keypress', this._handler);
      this._draw();
    });
  }

  // ── Key handling ──────────────────────────────────────────────────────────

  _onKey(str, key) {
    if (!key) {
      if (str && str.length === 1 && str >= ' ') {
        this.search += str;
        this._filter();
      }
      this._draw();
      return;
    }

    if (key.ctrl && key.name === 'c') { this._finish(null); return; }

    switch (key.name) {
      case 'up':       this.cursor = Math.max(0, this.cursor - 1); this._scrollTo(); break;
      case 'down':     this.cursor = Math.min(this.filtered.length - 1, this.cursor + 1); this._scrollTo(); break;
      case 'pageup':   this.cursor = Math.max(0, this.cursor - this.pageSize); this._scrollTo(); break;
      case 'pagedown': this.cursor = Math.min(this.filtered.length - 1, this.cursor + this.pageSize); this._scrollTo(); break;
      case 'home':     this.cursor = 0; this._scrollTo(); break;
      case 'end':      this.cursor = Math.max(0, this.filtered.length - 1); this._scrollTo(); break;
      case 'return':
        if (this.filtered.length > 0) this._finish(this.filtered[this.cursor]);
        return;
      case 'escape':
        this._finish(null);
        return;
      case 'backspace':
        if (this.search.length > 0) { this.search = this.search.slice(0, -1); this._filter(); }
        break;
      default:
        if (str && str.length === 1 && str >= ' ') { this.search += str; this._filter(); }
        break;
    }
    this._draw();
  }

  // ── Filtering ─────────────────────────────────────────────────────────────

  _filter() {
    if (!this.search) {
      this.filtered = [...this.items];
    } else {
      const q = this.search.toLowerCase();
      this.filtered = this.items.filter((item) =>
        this.filterKey(item).toLowerCase().includes(q)
      );
    }
    this.cursor = Math.min(this.cursor, Math.max(0, this.filtered.length - 1));
    this.scroll = 0;
    this._scrollTo();
  }

  _scrollTo() {
    if (this.cursor < this.scroll) this.scroll = this.cursor;
    else if (this.cursor >= this.scroll + this.pageSize) this.scroll = this.cursor - this.pageSize + 1;
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  _draw() {
    if (this._lines > 0) process.stdout.write(up(this._lines));

    const lines = [];

    // Title
    if (this.title) lines.push(`  ${pc.bold(pc.cyan(this.title))}`);

    // Search bar / hint
    if (this.search) {
      const cnt = this.filtered.length < this.items.length
        ? `${this.filtered.length}/${this.items.length}`
        : `${this.items.length}`;
      lines.push(`  ${pc.dim('Filter:')} ${this.search}${pc.dim('│')}  ${pc.dim(`(${cnt})`)}`);
    } else {
      lines.push(`  ${pc.dim(`${this.items.length} items — type to filter`)}`);
    }
    lines.push('');

    // Items
    if (this.filtered.length === 0) {
      lines.push(`    ${pc.yellow('No matches')}`);
    } else {
      const start = this.scroll;
      const end = Math.min(start + this.pageSize, this.filtered.length);

      if (start > 0) lines.push(`  ${pc.dim(`  ↑ ${start} more`)}`);

      for (let i = start; i < end; i++) {
        const sel = i === this.cursor;
        const text = this.renderItem(this.filtered[i], sel);
        lines.push(sel ? `  ${pc.cyan('▸')} ${text}` : `    ${text}`);
      }

      const remaining = this.filtered.length - end;
      if (remaining > 0) lines.push(`  ${pc.dim(`  ↓ ${remaining} more`)}`);
    }

    // Footer
    lines.push('');
    lines.push(`  ${pc.dim('↑↓ navigate  enter select  esc cancel  type to filter')}`);

    // Write — clear each line, then clear any leftovers below
    process.stdout.write(lines.map((l) => `${CLEAR_LINE}${l}`).join('\n') + '\n');
    process.stdout.write(CLEAR_BELOW);
    this._lines = lines.length;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  _finish(result) {
    if (this._handler) process.stdin.removeListener('keypress', this._handler);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(SHOW_CURSOR);

    // Erase picker UI
    if (this._lines > 0) {
      process.stdout.write(up(this._lines));
      process.stdout.write(CLEAR_BELOW);
    }

    if (this._resolve) this._resolve(result);
  }

  // ── Non-TTY fallback ─────────────────────────────────────────────────────

  async _fallback() {
    console.log('');
    if (this.title) console.log(`  ${this.title}\n`);
    this.items.forEach((item, i) => {
      console.log(`  ${pc.dim(`${String(i + 1).padStart(3)})`)} ${this.renderItem(item, false)}`);
    });
    console.log('');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
      rl.question('  Enter number (q to cancel): ', (ans) => {
        rl.close();
        const t = ans.trim();
        if (!t || t === 'q') { resolve(null); return; }
        const idx = parseInt(t, 10) - 1;
        resolve(idx >= 0 && idx < this.items.length ? this.items[idx] : null);
      });
    });
  }
}

// ── Agent picker ────────────────────────────────────────────────────────────

export async function pickAgent() {
  const order = [
    ...AGENT_DISPLAY_ORDER.filter((a) => AGENT_NAMES.includes(a)),
    ...AGENT_NAMES.filter((a) => !AGENT_DISPLAY_ORDER.includes(a)),
  ];

  const items = order.map((name) => ({
    name,
    label: AGENTS[name]?.label || name,
    active: getActiveModel(name) || 'unknown',
    effort: formatEffortDisplay(getActiveModel(name), getReasoningEffort(name)),
  }));

  const picked = await new Picker(items, {
    title: 'Select Agent',
    filterKey: (item) => `${item.name} ${item.label} ${item.active}`,
    renderItem: (item, sel) => {
      const pad = ' '.repeat(Math.max(1, 30 - item.label.length));
      const label = sel ? pc.white(item.label) : item.label;
      const eff = item.effort ? pc.yellow(` [${item.effort}]`) : '';
      return `${label}${pad}${pc.dim(item.active)}${eff}`;
    },
  }).run();

  return picked?.name || null;
}

// ── Model picker ────────────────────────────────────────────────────────────

export async function pickModel(agentName) {
  const agentInfo = AGENTS[agentName];
  const currentModel = getActiveModel(agentName);
  const cfg = loadHydraConfig();
  const agentModels = cfg.models?.[agentName] || {};
  const aliases = cfg.aliases?.[agentName] || {};

  // Loading indicator
  process.stdout.write(`  ${pc.dim(`Fetching ${agentInfo?.label || agentName} models...`)}`);
  const { models, source } = await fetchModels(agentName);
  process.stdout.write(`\r${CLEAR_LINE}`);

  // Preset + alias maps
  const presetOf = new Map();
  for (const key of ['default', 'fast', 'cheap']) {
    if (agentModels[key]) presetOf.set(agentModels[key], key);
  }
  const aliasOf = new Map();
  for (const [alias, id] of Object.entries(aliases)) {
    if (!aliasOf.has(id)) aliasOf.set(id, []);
    aliasOf.get(id).push(alias);
  }

  // Build item list: presets first (deduped), then discovered models
  const seen = new Set();
  const items = [];

  for (const key of ['default', 'fast', 'cheap']) {
    const id = agentModels[key];
    if (id && !seen.has(id)) {
      seen.add(id);
      items.push({ id, preset: key, active: id === currentModel });
    }
  }
  for (const id of models) {
    if (!seen.has(id)) {
      seen.add(id);
      items.push({ id, preset: null, active: id === currentModel });
    }
  }

  if (items.length === 0) {
    console.log(pc.yellow(`\n  No models found for ${agentName}.`));
    console.log(pc.dim('  Set API key: ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY\n'));
    return null;
  }

  const sourceLabel = source === 'api' ? 'REST API' : source === 'cli' ? 'CLI' : 'config only';
  const currentEffort = getReasoningEffort(agentName);
  const effortTag = currentEffort ? ` effort:${currentEffort}` : '';
  const initialIdx = Math.max(0, items.findIndex((i) => i.active));

  const picked = await new Picker(items, {
    title: `${agentInfo?.label || agentName} — ${items.length} models [${sourceLabel}]${effortTag}`,
    initialIndex: initialIdx,
    pageSize: 18,
    filterKey: (item) => {
      const parts = [item.id];
      if (item.preset) parts.push(item.preset);
      const als = aliasOf.get(item.id);
      if (als) parts.push(...als);
      return parts.join(' ');
    },
    renderItem: (item, sel) => {
      const tags = [];
      if (item.preset) tags.push(pc.magenta(item.preset));
      if (item.active) tags.push(pc.green('◀ active'));
      const als = aliasOf.get(item.id);
      if (als && !item.preset) tags.push(pc.dim(`(${als.join(', ')})`));
      const annotation = formatBenchmarkAnnotation(item.id);
      if (annotation) tags.push(pc.dim(annotation));
      const suffix = tags.length > 0 ? '  ' + tags.join(' ') : '';
      const name = item.active ? pc.green(item.id) : sel ? pc.white(item.id) : item.id;
      return `${name}${suffix}`;
    },
  }).run();

  return picked?.id || null;
}

// ── Reasoning effort picker ─────────────────────────────────────────────────

export async function pickEffort(agentName, modelId) {
  const current = getReasoningEffort(agentName);
  const effectiveModel = modelId || getActiveModel(agentName);
  const options = getEffortOptionsForModel(effectiveModel);

  // Model doesn't support reasoning controls — skip picker
  if (options.length === 0) {
    return { id: null, _skipped: true };
  }

  // Determine picker title based on model type
  const { getModelReasoningCaps } = await import('./hydra-agents.mjs');
  const caps = getModelReasoningCaps(effectiveModel);
  const TITLES = {
    effort: 'Reasoning Effort',
    thinking: 'Thinking Budget',
    'model-swap': 'Thinking Mode',
  };
  const title = TITLES[caps.type] || 'Reasoning Effort';

  const items = options.map((opt) => ({
    id: opt.id,
    label: opt.label,
    desc: opt.hint || null,
  }));

  const initialIdx = current
    ? Math.max(0, items.findIndex((i) => i.id === current))
    : 0;

  const picked = await new Picker(items, {
    title,
    initialIndex: initialIdx,
    filterKey: (item) => item.label,
    renderItem: (item, sel) => {
      const active = item.id === current || (!item.id && !current);
      const name = active ? pc.green(item.label) : sel ? pc.white(item.label) : item.label;
      const tags = [];
      if (active) tags.push(pc.green('◀ current'));
      if (item.desc) tags.push(pc.dim(item.desc));
      const suffix = tags.length > 0 ? '  ' + tags.join(' ') : '';
      return `${name}${suffix}`;
    },
  }).run();

  return picked === undefined ? undefined : picked;  // null = cancel, object = selection
}

// ── Apply selection ─────────────────────────────────────────────────────────

export function applySelection(agentName, modelId, effortLevel) {
  invalidateConfigCache();
  const cfg = loadHydraConfig();

  // Set mode to custom
  cfg.mode = 'custom';

  // Set active model
  if (!cfg.models[agentName]) cfg.models[agentName] = {};
  const resolved = resolveModelId(agentName, modelId) || modelId;
  cfg.models[agentName].active = resolved;

  // Set reasoning effort (null clears it)
  cfg.models[agentName].reasoningEffort = effortLevel || null;

  saveHydraConfig(cfg);
  return resolved;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const arg = process.argv[2]?.toLowerCase();

  // Agent selection
  let agentName;
  if (arg && AGENT_NAMES.includes(arg)) {
    agentName = arg;
  } else if (arg) {
    console.error(pc.red(`Unknown agent: ${arg}`));
    console.error(`Available: ${AGENT_NAMES.join(', ')}`);
    process.exit(1);
  } else {
    console.log('');
    agentName = await pickAgent();
    if (!agentName) {
      console.log(pc.dim('  Cancelled.\n'));
      process.exit(0);
    }
  }

  // Model selection
  console.log('');
  const modelId = await pickModel(agentName);
  if (!modelId) {
    console.log(pc.dim('  Cancelled.\n'));
    process.exit(0);
  }

  // Reasoning effort selection
  console.log('');
  const effortPick = await pickEffort(agentName, modelId);
  if (effortPick === null) {
    console.log(pc.dim('  Cancelled.\n'));
    process.exit(0);
  }
  if (effortPick?._skipped) {
    console.log(pc.dim(`  (No reasoning controls for this model — skipped)\n`));
  }
  const effortLevel = effortPick?.id ?? null;  // null = "default" (clear override)

  // Check if nothing changed
  const currentModel = getActiveModel(agentName);
  const currentEffort = getReasoningEffort(agentName);
  if (modelId === currentModel && effortLevel === currentEffort) {
    console.log(`\n  ${pc.dim('No changes — already set.')}\n`);
    process.exit(0);
  }

  // Apply
  const resolved = applySelection(agentName, modelId, effortLevel);
  const effortDisplay = formatEffortDisplay(resolved, effortLevel);
  const effortTag = effortDisplay ? pc.yellow(effortDisplay) : effortLevel ? pc.yellow(effortLevel) : pc.dim('default');
  console.log(`\n  ${pc.green('✓')} ${pc.bold(agentName)} → ${pc.white(resolved)} ${effortTag}  ${pc.dim('(mode → custom)')}\n`);
}

// Only run when invoked directly
import path from 'path';
const __self = new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
if (path.resolve(process.argv[1] || '') === path.resolve(__self)) {
  main().catch((err) => {
    process.stdout.write(SHOW_CURSOR);
    console.error(pc.red(`\nError: ${err.message}`));
    process.exit(1);
  });
}
