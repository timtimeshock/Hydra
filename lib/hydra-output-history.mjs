/**
 * Hydra Output History — Ring buffer capturing recent CLI output.
 *
 * Intercepts process.stdout.write / process.stderr.write to store recent
 * terminal output for AI consumption (e.g. doctor enrichment, error context).
 *
 * Filters out status bar redraws (scroll region escapes) and strips ANSI
 * for the clean-text API. Raw output is also available.
 */

import { stripAnsi } from './hydra-ui.mjs';

// ── State ────────────────────────────────────────────────────────────────────

let _initialized = false;
let _maxLines = 200;
const _lines = [];        // ANSI-stripped
const _linesRaw = [];     // With ANSI
let _partial = '';         // Accumulate incomplete lines
let _partialRaw = '';

let _origStdoutWrite = null;
let _origStderrWrite = null;

// ── Scroll-region filter ─────────────────────────────────────────────────────

// Status bar uses CSI sequences for scroll regions — filter those out
const SCROLL_REGION_RE = /\x1b\[\d*;\d*r|\x1b\[\d+[ABCDHJ]|\x1b\[s|\x1b\[u|\x1b\[\?25[lh]/;

function isStatusBarLine(raw) {
  return SCROLL_REGION_RE.test(raw);
}

// ── Core ─────────────────────────────────────────────────────────────────────

function pushLine(clean, raw) {
  _lines.push(clean);
  _linesRaw.push(raw);
  while (_lines.length > _maxLines) {
    _lines.shift();
    _linesRaw.shift();
  }
}

function processChunk(chunk, isRaw) {
  const str = typeof chunk === 'string' ? chunk : chunk?.toString?.('utf8') || '';
  if (!str) return;

  // Filter status bar redraws
  if (isStatusBarLine(str)) return;

  const rawStr = str;
  const cleanStr = stripAnsi(str);

  // Split on newlines, handling partial lines
  const rawParts = (_partialRaw + rawStr).split('\n');
  const cleanParts = (_partial + cleanStr).split('\n');

  // Last element is a partial (no trailing newline) or empty (trailing newline)
  _partialRaw = rawParts.pop() || '';
  _partial = cleanParts.pop() || '';

  for (let i = 0; i < cleanParts.length; i++) {
    const clean = cleanParts[i];
    const raw = rawParts[i] || clean;
    if (clean.trim()) {  // Skip blank lines
      pushLine(clean, raw);
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Start intercepting stdout/stderr writes.
 * Safe to call multiple times — only patches once.
 */
export function initOutputHistory(opts = {}) {
  if (_initialized) return;
  _maxLines = opts.maxLines || 200;
  _initialized = true;

  _origStdoutWrite = process.stdout.write.bind(process.stdout);
  _origStderrWrite = process.stderr.write.bind(process.stderr);

  process.stdout.write = function (chunk, encoding, cb) {
    try { processChunk(chunk); } catch { /* never break output */ }
    return _origStdoutWrite(chunk, encoding, cb);
  };

  process.stderr.write = function (chunk, encoding, cb) {
    try { processChunk(chunk); } catch { /* never break output */ }
    return _origStderrWrite(chunk, encoding, cb);
  };
}

/**
 * Get last n lines of output, ANSI-stripped.
 * @param {number} [n=50]
 * @returns {string[]}
 */
export function getRecentOutput(n = 50) {
  return _lines.slice(-n);
}

/**
 * Get last n lines of output with ANSI intact.
 * @param {number} [n=50]
 * @returns {string[]}
 */
export function getRecentOutputRaw(n = 50) {
  return _linesRaw.slice(-n);
}

/**
 * Clear the output buffer.
 */
export function clearOutputHistory() {
  _lines.length = 0;
  _linesRaw.length = 0;
  _partial = '';
  _partialRaw = '';
}

/**
 * Get recent output formatted as a single string for AI consumption.
 * @param {number} [n=50]
 * @returns {string}
 */
export function getOutputContext(n = 50) {
  const lines = getRecentOutput(n);
  if (lines.length === 0) return '(no recent output)';
  return lines.join('\n');
}
